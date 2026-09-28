// SPDX-License-Identifier: AGPL-3.0-only
//! The files pane's two reads: one directory level, and one file under a byte cap. Disk work runs on the blocking
//! pool so a slow volume never holds the runtime thread that answers every other socket.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use wsp_frames::{
    numbers, words, DaemonErrorCode, FsEntry, FsEntryType, FsListReply, FsReadEncoding, FsReadReply, HostFolder, HostFolderListing,
};

use crate::git::{run_git, Runs};
use crate::paths::{absolute, is_inside, OpError};

/// Runs blocking work off the runtime thread and folds a lost worker into the op's failure.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, OpError> + Send + 'static) -> Result<T, OpError> {
    tokio::task::spawn_blocking(work).await.unwrap_or_else(|e| Err(OpError::plain(e.to_string())))
}

/// One directory's direct children, directories first, the cap spent on this directory alone; only the kept
/// entries are stat'ed. Symlinks are reported, never followed.
///
/// `dir` is where this daemon reads the names and `at` is that same directory as the way of running git sees it:
/// the two are one path on this computer, and for a workspace on a computer somebody owns the names are read
/// through its rootfs while the ignore rules are read by a git inside the workspace, where a checkout's own config
/// belongs.
pub(crate) async fn list_dir<R: Runs>(dir: PathBuf, at: &Path, gitignore: bool, cap: usize, runner: &R) -> Result<FsListReply, OpError> {
    let scanned = dir.clone();
    let mut names = blocking(move || read_names(&scanned)).await?;
    if gitignore {
        names.retain(|(name, _)| name != ".git");
        let ignored = ignored_among(runner, at, names.iter().map(|(name, _)| name.as_str()).collect()).await?;
        names.retain(|(name, _)| !ignored.contains(name.as_bytes()));
    }
    // Directories first, then by name with case folded, the nearest plain rule to node's localeCompare.
    names.sort_by_cached_key(|(name, is_dir)| (!*is_dir, name.to_lowercase(), name.clone()));
    let total = names.len();
    let truncated = total > cap;
    names.truncate(cap);
    let entries = blocking(move || stat_entries(&dir, names)).await?;
    Ok(FsListReply { entries, truncated, total: total as u64 })
}

/// Every name in the directory with whether it is itself a directory (a symlink to one is not).
fn read_names(dir: &Path) -> Result<Vec<(String, bool)>, OpError> {
    if !std::fs::metadata(dir)?.is_dir() {
        return Err(OpError::coded(DaemonErrorCode::NotADirectory, format!("{} is not a directory", dir.display())));
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        names.push((entry.file_name().to_string_lossy().into_owned(), entry.file_type()?.is_dir()));
    }
    Ok(names)
}

/// git check-ignore over the whole level in one call; exit 1 means nothing matched and 128 means no repo here, both
/// leave the level as it is. Inside an ignored directory every child reports ignored, so a directory that is itself
/// ignored lists in full: someone asked to look in there.
async fn ignored_among<R: Runs>(runner: &R, dir: &Path, names: Vec<&str>) -> Result<HashSet<Vec<u8>>, OpError> {
    if names.is_empty() {
        return Ok(HashSet::new());
    }
    let this_dir = run_git(runner, dir, &["check-ignore", "-q", "."], None, None).await?;
    if this_dir.code != Some(1) {
        return Ok(HashSet::new());
    }
    let mut input = names.join("\0").into_bytes();
    input.push(0);
    let res = run_git(runner, dir, &["check-ignore", "-z", "--stdin"], Some(&input), None).await?;
    if res.code != Some(0) {
        return Ok(HashSet::new());
    }
    Ok(res.stdout.split(|b| *b == 0).filter(|name| !name.is_empty()).map(<[u8]>::to_vec).collect())
}

fn stat_entries(dir: &Path, names: Vec<(String, bool)>) -> Result<Vec<FsEntry>, OpError> {
    names
        .into_iter()
        .map(|(name, _)| {
            let meta = std::fs::symlink_metadata(dir.join(&name))?;
            let kind = if meta.file_type().is_symlink() {
                FsEntryType::Symlink
            } else if meta.is_dir() {
                FsEntryType::Dir
            } else {
                FsEntryType::File
            };
            let size = if kind == FsEntryType::File { meta.len() } else { 0 };
            Ok(FsEntry { name, kind, size, mtime: epoch_ms(meta.modified()?) })
        })
        .collect()
}

/// One level of folders for the folder picker of a computer somebody owns, by the rule the host lists its own
/// computer's with: only inside the roots, which are `home` and each project folder it does not hold, checked
/// lexically before anything is read and by realpath after, so neither a typed path nor a link reaches the rest of
/// the disk. Folders only, sorted by name, each marked when git tracks it; the dot-named ones are counted and listed
/// only when `hidden`, which is the host's hidden rule on a computer that is not a Mac. No file is opened.
pub(crate) async fn list_folders(
    home: PathBuf,
    projects: Vec<String>,
    dir: Option<String>,
    hidden: bool,
) -> Result<HostFolderListing, OpError> {
    blocking(move || {
        let roots = folder_roots(&home, &projects);
        let real_roots: Vec<PathBuf> = roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).collect();
        let inside_real = |path: &Path| std::fs::canonicalize(path).is_ok_and(|real| real_roots.iter().any(|root| is_inside(root, &real)));
        let listed = folder_to_list(dir.as_deref(), &roots, &inside_real)?;
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&listed)? {
            let entry = entry?;
            let path = listed.join(entry.file_name());
            if path.is_dir() && (!entry.file_type()?.is_symlink() || inside_real(&path)) {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort();
        let dotted = names.iter().filter(|name| name.starts_with('.')).count();
        let folders = names
            .iter()
            .filter(|name| hidden || !name.starts_with('.'))
            .map(|name| listed.join(name))
            .map(|path| HostFolder {
                repo: path.join(".git").exists(),
                path: path.to_string_lossy().into_owned(),
                branch: None,
                touched_at: None,
            })
            .collect();
        Ok(HostFolderListing {
            dir: listed.to_string_lossy().into_owned(),
            roots: roots.iter().map(|root| root.to_string_lossy().into_owned()).collect(),
            folders,
            hidden: dotted as u64,
        })
    })
    .await
}

/// Every repo under `home` and each project folder it does not hold, most recently written first, by the rule this
/// computer's own repos listing walks with: REPO_DEPTH folders deep and REPO_CAP repos at most, never into a repo, a
/// link, a dot-named folder or a folder CACHE_DIRS names. A linked worktree, whose .git is a file, is its repo's and
/// no row of its own. Nothing is read but a repo's HEAD and the times git wrote there.
pub(crate) async fn list_repos(home: PathBuf, projects: Vec<String>) -> Result<HostFolderListing, OpError> {
    blocking(move || {
        let roots = folder_roots(&home, &projects);
        let mut found = Vec::new();
        for root in &roots {
            walk_repos(root, 0, &mut found);
        }
        found.sort_by_key(|folder| std::cmp::Reverse(folder.touched_at));
        let named = |path: &PathBuf| path.to_string_lossy().into_owned();
        Ok(HostFolderListing { dir: named(&roots[0]), roots: roots.iter().map(named).collect(), folders: found, hidden: 0 })
    })
    .await
}

fn walk_repos(dir: &Path, depth: u32, found: &mut Vec<HostFolder>) {
    if found.len() >= numbers::REPO_CAP {
        return;
    }
    let git = dir.join(".git");
    if git.exists() {
        if git.is_dir() {
            found.push(HostFolder {
                path: dir.to_string_lossy().into_owned(),
                repo: true,
                branch: head_branch(&git),
                touched_at: Some(git_touched(&git)),
            });
        }
        return;
    }
    if depth >= numbers::REPO_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) && !name.starts_with('.') && !numbers::CACHE_DIRS.contains(&name.as_str()) {
            walk_repos(&entry.path(), depth + 1, found);
        }
    }
}

/// The branch a checkout is on, off its HEAD file; none on a detached head.
fn head_branch(git: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    head.lines().find_map(|line| line.strip_prefix("ref: refs/heads/")).filter(|branch| !branch.is_empty()).map(str::to_owned)
}

/// When git last wrote to a checkout: the newest of its index, HEAD and FETCH_HEAD, and 0 where none is there.
fn git_touched(git: &Path) -> i64 {
    ["index", "HEAD", "FETCH_HEAD"]
        .iter()
        .filter_map(|name| std::fs::metadata(git.join(name)).and_then(|m| m.modified()).ok())
        .map(epoch_ms)
        .max()
        .unwrap_or(0)
}

/// The home, then each project folder that is a folder here and that the home does not already hold.
fn folder_roots(home: &Path, projects: &[String]) -> Vec<PathBuf> {
    let home = absolute(home);
    let mut roots = vec![home.clone()];
    for project in projects.iter().map(|p| absolute(Path::new(p))) {
        if !is_inside(&home, &project) && project.is_dir() && !roots.contains(&project) {
            roots.push(project);
        }
    }
    roots
}

/// Which folder a listing is for: none gives the home, and so does one inside the roots that is gone; anything
/// outside them, relative or through a link that leaves them, is refused.
fn folder_to_list(dir: Option<&str>, roots: &[PathBuf], inside_real: &dyn Fn(&Path) -> bool) -> Result<PathBuf, OpError> {
    let Some(dir) = dir.filter(|dir| !dir.is_empty()) else { return Ok(roots[0].clone()) };
    let outside = || {
        let named = roots.iter().map(|root| root.to_string_lossy().into_owned()).collect::<Vec<_>>().join(", ");
        OpError::coded(DaemonErrorCode::OutsideRoot, words::folders_outside(dir, named))
    };
    if !Path::new(dir).is_absolute() {
        return Err(outside());
    }
    let asked = absolute(Path::new(dir));
    if !roots.iter().any(|root| is_inside(root, &asked)) {
        return Err(outside());
    }
    if !asked.is_dir() {
        return Ok(roots[0].clone());
    }
    if !inside_real(&asked) {
        return Err(outside());
    }
    Ok(asked)
}

/// Milliseconds since the epoch, rounded as node's Math.round(mtimeMs) rounds.
fn epoch_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_millis() as i64) + i64::from(d.subsec_nanos() % 1_000_000 >= 500_000),
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Reads at most cap bytes; a truncated utf8 read drops a split trailing character rather than emitting a
/// replacement character for it.
pub(crate) async fn read_file_bounded(file: PathBuf, encoding: FsReadEncoding, cap: u64) -> Result<FsReadReply, OpError> {
    blocking(move || {
        let meta = std::fs::metadata(&file)?;
        if !meta.is_file() {
            return Err(OpError::coded(DaemonErrorCode::NotAFile, format!("{} is not a regular file", file.display())));
        }
        let size = meta.len();
        let truncated = size > cap;
        let mut bytes = Vec::with_capacity(size.min(cap) as usize);
        std::fs::File::open(&file)?.take(size.min(cap)).read_to_end(&mut bytes)?;
        let content = match encoding {
            FsReadEncoding::Base64 => base64::engine::general_purpose::STANDARD.encode(&bytes),
            FsReadEncoding::Utf8 => utf8_text(&bytes, truncated),
        };
        Ok(FsReadReply { content, size, truncated })
    })
    .await
}

/// Bytes as text the way node's StringDecoder writes them: invalid sequences become U+FFFD, and a character cut
/// off at the end is dropped when the read was cut, or stands as one U+FFFD when the bytes really end there.
pub(crate) fn utf8_text(bytes: &[u8], cut: bool) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                return out;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(good).unwrap_or_default());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &bad[n..];
                    }
                    None => {
                        if !cut {
                            out.push('\u{FFFD}');
                        }
                        return out;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::here::Here;
    use std::fs;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn names(reply: &FsListReply) -> Vec<&str> {
        reply.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[tokio::test]
    async fn the_entry_cap_is_spent_per_directory_a_wide_sibling_never_cuts_the_top_level() {
        let deep = tempfile::tempdir().unwrap();
        fs::create_dir_all(deep.path().join("wide")).unwrap();
        fs::create_dir(deep.path().join("src")).unwrap();
        fs::write(deep.path().join("package.json"), "{}\n").unwrap();
        fs::write(deep.path().join("src/index.ts"), "export {};\n").unwrap();
        for i in 0..12 {
            fs::write(deep.path().join(format!("wide/f{i:02}.txt")), "x\n").unwrap();
        }
        let top = list_dir(deep.path().to_path_buf(), deep.path(), false, 5, &Here::new()).await.unwrap();
        assert_eq!(names(&top), ["src", "wide", "package.json"]);
        assert_eq!((top.truncated, top.total), (false, 3));
        let wide = list_dir(deep.path().join("wide"), &deep.path().join("wide"), false, 5, &Here::new()).await.unwrap();
        assert_eq!(names(&wide), ["f00.txt", "f01.txt", "f02.txt", "f03.txt", "f04.txt"]);
        assert_eq!((wide.truncated, wide.total), (true, 12));
        let full =
            list_dir(deep.path().join("wide"), &deep.path().join("wide"), false, wsp_frames::numbers::FS_LIST_CAP_ENTRIES, &Here::new())
                .await
                .unwrap();
        assert_eq!((full.truncated, full.total, full.entries.len()), (false, 12, 12));
    }

    #[tokio::test]
    async fn the_entry_cap_counts_entries_after_the_gitignore_filter() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        git(r, &["init", "-q", "-b", "main"]);
        fs::write(r.join(".gitignore"), "ignored.log\nbuild/\n").unwrap();
        fs::write(r.join("ignored.log"), "log\n").unwrap();
        fs::create_dir(r.join("build")).unwrap();
        fs::write(r.join("build/out.js"), "out\n").unwrap();
        for name in ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt", "six.txt", "seven.txt"] {
            fs::write(r.join(name), "x\n").unwrap();
        }
        let listed = list_dir(r.to_path_buf(), r, true, 2, &Here::new()).await.unwrap();
        assert_eq!(listed.entries.len(), 2);
        assert_eq!((listed.total, listed.truncated), (8, true));
        let plain = list_dir(r.to_path_buf(), r, false, 2, &Here::new()).await.unwrap();
        assert_eq!((plain.total, plain.truncated), (11, true));
    }

    #[tokio::test]
    async fn a_target_that_is_not_a_directory_or_not_a_file_is_typed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f"), "x").unwrap();
        let err = list_dir(dir.path().join("f"), &dir.path().join("f"), false, 10, &Here::new()).await.unwrap_err();
        assert_eq!(err.code, Some(wsp_frames::DaemonErrorCode::NotADirectory));
        assert_eq!(err.message, format!("{} is not a directory", dir.path().join("f").display()));
        let err = read_file_bounded(dir.path().to_path_buf(), FsReadEncoding::Utf8, 10).await.unwrap_err();
        assert_eq!(err.code, Some(wsp_frames::DaemonErrorCode::NotAFile));
        assert_eq!(err.message, format!("{} is not a regular file", dir.path().display()));
    }

    #[tokio::test]
    async fn a_read_cut_inside_a_multibyte_character_drops_that_character_and_an_uncut_one_marks_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.txt");
        fs::write(&file, "héllo wörld\n").unwrap();
        let whole = read_file_bounded(file.clone(), FsReadEncoding::Utf8, 1024).await.unwrap();
        assert_eq!((whole.content.as_str(), whole.size, whole.truncated), ("héllo wörld\n", 14, false));
        let cut = read_file_bounded(file.clone(), FsReadEncoding::Utf8, 2).await.unwrap();
        assert_eq!((cut.content.as_str(), cut.size, cut.truncated), ("h", 14, true));
        let b64 = read_file_bounded(file, FsReadEncoding::Base64, 2).await.unwrap();
        assert_eq!((b64.content.as_str(), b64.truncated), ("aMM=", true));
    }

    #[test]
    fn utf8_text_follows_nodes_string_decoder() {
        assert_eq!(utf8_text("héllo".as_bytes(), false), "héllo");
        assert_eq!(utf8_text(&"héllo".as_bytes()[..2], true), "h");
        assert_eq!(utf8_text(&"héllo".as_bytes()[..2], false), "h\u{FFFD}");
        assert_eq!(utf8_text(b"a\xffb", false), "a\u{FFFD}b");
        assert_eq!(utf8_text(b"", true), "");
    }
}
