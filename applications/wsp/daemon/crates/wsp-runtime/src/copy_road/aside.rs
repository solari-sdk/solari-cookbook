// SPDX-License-Identifier: AGPL-3.0-only
//! A copy taken away without the wait: a directory clone costs one call to make, but removing it walks every file
//! the folder held, which for a checkout with its dependencies and build output is minutes. So the copy is renamed
//! to a hidden sibling in its own folder, one rename on one volume, and a process of its own removes it from there
//! while the delete answers at once. A computer that stopped part way through leaves the sibling, which the
//! daemon's start sweeps, and so does the next copy made or removed beside the same project.

use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What every copy on its way out is renamed to start with, and the only names the sweep takes.
pub const ASIDE_PREFIX: &str = ".wsp-removing-";

/// The copy renamed out of its own path and handed to `later` to remove, so the path is free the moment this
/// answers. A copy that is not there is already gone. Where `later` cannot take it, it is removed here and now.
#[cfg(target_os = "macos")]
pub(crate) fn set_aside_then(to: &Path, later: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    let (Some(parent), Some(name)) = (to.parent(), to.file_name()) else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} has no folder to sit in", to.display())));
    };
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let aside = parent.join(format!("{ASIDE_PREFIX}{}-{}-{nanos}", name.to_string_lossy(), std::process::id()));
    // The name and not the path as typed: rename(2) follows a link written with a trailing slash.
    match fs::rename(parent.join(name), &aside) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", to.display()))),
    }
    if later(&aside).is_err() {
        fs::remove_dir_all(&aside).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", aside.display())))?;
    }
    Ok(())
}

/// Removes a folder in a process that outlives this one: the copy verb exits the moment it answers, and a thread
/// of its own would die with it. No stdio is shared, since the host reads the verb's answer at the close of its
/// pipes, and a group of its own keeps a signal meant for the verb off it.
pub(crate) fn remove_later(aside: &Path) -> io::Result<()> {
    Command::new("/bin/rm")
        .arg("-rf")
        .arg("--")
        .arg(aside)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(drop)
}

/// Every copy left on its way out in these folders handed to `remove`, and what could not be removed, each naming
/// its folder. A link carrying the name is not followed.
pub fn sweep<'a>(folders: impl IntoIterator<Item = &'a Path>, remove: impl Fn(&Path) -> io::Result<()>) -> Vec<io::Error> {
    let mut failed = Vec::new();
    for folder in folders {
        let Ok(entries) = fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && entry.file_name().to_string_lossy().starts_with(ASIDE_PREFIX) {
                let path = entry.path();
                if let Err(e) = remove(&path) {
                    failed.push(io::Error::new(e.kind(), format!("{} not removed: {e}", path.display())));
                }
            }
        }
    }
    failed
}

/// The folders a copy of any of these project folders sits in: each one's parent, once.
pub fn beside(projects: &[PathBuf]) -> Vec<&Path> {
    let mut folders: Vec<&Path> = Vec::new();
    for parent in projects.iter().filter_map(|p| p.parent()) {
        if !folders.contains(&parent) {
            folders.push(parent);
        }
    }
    folders
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asides(folder: &Path) -> Vec<PathBuf> {
        fs::read_dir(folder)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(ASIDE_PREFIX))
            .map(|e| e.path())
            .collect()
    }

    fn copy_at(to: &Path) {
        fs::create_dir_all(to.join("node_modules/pkg")).unwrap();
        fs::write(to.join("node_modules/pkg/index.js"), b"dep\n").unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_removal_answers_with_the_path_free_while_the_files_are_still_on_their_way_out() {
        let dir = tempfile::tempdir().unwrap();
        let to = dir.path().join("work-feature");
        copy_at(&to);
        let mut handed = None;
        set_aside_then(&to, |aside| {
            handed = Some(aside.to_path_buf());
            Ok(())
        })
        .unwrap();
        let aside = handed.unwrap();
        assert!(!to.exists(), "the copy's path is free the moment the removal answers");
        assert!(aside.join("node_modules/pkg/index.js").is_file(), "the files were removed before the answer");
        assert_eq!(aside.parent(), Some(dir.path()), "the copy is set aside in its own folder, so the rename stays on one volume");
        remove_later(&aside).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while aside.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!aside.exists(), "the set-aside copy is still there");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_copy_that_is_not_there_is_already_gone_and_one_the_background_cannot_take_goes_now() {
        let dir = tempfile::tempdir().unwrap();
        set_aside_then(&dir.path().join("never-made"), |_| panic!("nothing to hand on")).unwrap();
        let to = dir.path().join("work-feature");
        copy_at(&to);
        set_aside_then(&to, |_| Err(io::Error::other("no process"))).unwrap();
        assert!(!to.exists() && asides(dir.path()).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_path_written_with_a_trailing_slash_sets_aside_the_link_it_names_and_not_the_folder_behind_it() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        copy_at(&elsewhere);
        let link = dir.path().join("work-feature");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let mut handed = None;
        set_aside_then(&PathBuf::from(format!("{}/", link.display())), |aside| {
            handed = Some(aside.to_path_buf());
            Ok(())
        })
        .unwrap();
        let aside = handed.unwrap();
        assert!(fs::symlink_metadata(&aside).unwrap().file_type().is_symlink(), "the folder behind the link was set aside");
        assert!(elsewhere.join("node_modules/pkg/index.js").is_file(), "the folder behind the link moved");
    }

    #[test]
    fn the_sweep_takes_only_leftover_copies_and_follows_no_link() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("work");
        fs::create_dir_all(&project).unwrap();
        let left = dir.path().join(format!("{ASIDE_PREFIX}work-feature-1-2"));
        copy_at(&left);
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(elsewhere.path().join("held"), b"mine\n").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), dir.path().join(format!("{ASIDE_PREFIX}link"))).unwrap();
        fs::create_dir_all(dir.path().join(".cache")).unwrap();
        let failed = sweep(beside(&[project.clone(), dir.path().join("work-other")]), |p| fs::remove_dir_all(p));
        assert!(failed.is_empty(), "{failed:?}");
        assert!(!left.exists());
        assert!(project.is_dir() && dir.path().join(".cache").is_dir());
        assert!(elsewhere.path().join("held").is_file(), "the sweep followed a link");
    }

    #[test]
    fn a_leftover_the_sweep_cannot_remove_stays_and_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("work");
        fs::create_dir_all(&project).unwrap();
        let left = dir.path().join(format!("{ASIDE_PREFIX}work-feature-1-2"));
        copy_at(&left);
        let failed = sweep(beside(&[project]), |_| Err(io::Error::from(io::ErrorKind::PermissionDenied)));
        assert_eq!(failed.len(), 1);
        assert!(failed[0].to_string().starts_with(&format!("{} not removed: ", left.display())), "{}", failed[0]);
        assert_eq!(asides(dir.path()), [left]);
    }
}
