// SPDX-License-Identifier: AGPL-3.0-only
//! Where an fs or git path may point: inside the daemon's root or a folder the roots file names. The lexical check
//! runs first so nothing outside every root is ever stat'ed; the realpath check then refuses symlinks that leave.

use std::io;
use std::path::{Component, Path, PathBuf};

use wsp_frames::DaemonErrorCode;

/// A refusal a client can branch on when it carries a code; without one it is a plain failure sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpError {
    pub(crate) code: Option<DaemonErrorCode>,
    pub(crate) message: String,
}

impl OpError {
    pub(crate) fn coded(code: DaemonErrorCode, message: impl Into<String>) -> OpError {
        OpError { code: Some(code), message: message.into() }
    }

    pub(crate) fn plain(message: impl Into<String>) -> OpError {
        OpError { code: None, message: message.into() }
    }
}

impl From<io::Error> for OpError {
    fn from(e: io::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

pub(crate) fn outside_root(requested: &str) -> OpError {
    OpError::coded(DaemonErrorCode::OutsideRoot, format!("{requested} resolves outside the workspace root"))
}

pub(crate) fn not_found(requested: &str) -> OpError {
    OpError::coded(DaemonErrorCode::NotFound, format!("{requested} does not exist"))
}

/// The roots as they are now: the daemon's root, then each absolute line of the roots file, no repeats. Read per
/// op, not once: the host writes the file when a project lands and the daemon keeps running.
pub(crate) fn roots_now(root: &Path, roots_path: &Path) -> io::Result<Vec<PathBuf>> {
    let named = match std::fs::read_to_string(roots_path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let mut roots = vec![root.to_path_buf()];
    for line in named.lines().map(str::trim).filter(|line| line.starts_with('/')) {
        let named = PathBuf::from(line);
        if !roots.contains(&named) {
            roots.push(named);
        }
    }
    Ok(roots)
}

/// Absolute against the working directory and normalised lexically, as node's path.resolve does.
pub(crate) fn absolute(path: &Path) -> PathBuf {
    let from_cwd =
        if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(path) };
    let mut out = PathBuf::from("/");
    for part in from_cwd.components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// requested against base as node's path.resolve reads them: an absolute request stands alone.
fn lexical_resolve(base: &Path, requested: &str) -> PathBuf {
    let requested = Path::new(requested);
    if requested.is_absolute() {
        absolute(requested)
    } else {
        absolute(&base.join(requested))
    }
}

/// Both absolute and normalised, so a component-wise prefix is the whole question.
pub(crate) fn is_inside(root: &Path, target: &Path) -> bool {
    target.strip_prefix(root).is_ok()
}

fn is_missing(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

fn realpath_or_missing(path: &Path) -> io::Result<Option<PathBuf>> {
    match std::fs::canonicalize(path) {
        Ok(real) => Ok(Some(real)),
        Err(e) if is_missing(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

fn nearest_existing(path: &Path) -> io::Result<PathBuf> {
    let mut cur = path;
    loop {
        match std::fs::canonicalize(cur) {
            Ok(real) => return Ok(real),
            Err(e) if is_missing(&e) => match cur.parent() {
                Some(parent) => cur = parent,
                None => return Err(e),
            },
            Err(e) => return Err(e),
        }
    }
}

/// Resolves requested (relative to the first root, or absolute) to a real path inside one of the roots. A
/// symlinked parent of a missing leaf stays outside-root rather than not-found, so the refusal never confirms what
/// exists there.
pub(crate) fn resolve_inside(roots: &[PathBuf], requested: &str) -> Result<PathBuf, OpError> {
    resolve_inside_named(roots, requested, requested)
}

/// The same, with the path a refusal names given apart from the path being resolved: a workspace's own path is
/// resolved under that workspace's rootfs on this computer, and the person who asked for it knows it by the path
/// they gave, not by where this computer keeps the workspace's files.
pub(crate) fn resolve_inside_named(roots: &[PathBuf], resolving: &str, named: &str) -> Result<PathBuf, OpError> {
    let requested = resolving;
    let lexical_roots: Vec<PathBuf> = roots.iter().map(|root| absolute(root)).collect();
    let first = lexical_roots.first().cloned().unwrap_or_else(|| PathBuf::from("/"));
    let lexical = lexical_resolve(&first, requested);
    if !lexical_roots.iter().any(|root| is_inside(root, &lexical)) {
        return Err(outside_root(named));
    }
    let real_roots = lexical_roots.iter().map(|root| realpath_or_missing(root)).collect::<io::Result<Vec<_>>>()?;
    let (real, exists) = match realpath_or_missing(&lexical)? {
        Some(real) => (real, true),
        None => (nearest_existing(lexical.parent().unwrap_or(Path::new("/")))?, false),
    };
    if !real_roots.iter().flatten().any(|root| is_inside(root, &real)) {
        // A root that is gone (an imported folder since removed) hides nothing, so a leaf under it is missing, not outside.
        let under_gone_root = lexical_roots.iter().zip(&real_roots).any(|(root, real)| real.is_none() && is_inside(root, &lexical));
        if !exists && under_gone_root {
            return Err(not_found(named));
        }
        return Err(outside_root(named));
    }
    if !exists {
        return Err(not_found(named));
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    struct Tree {
        root: tempfile::TempDir,
        outside: tempfile::TempDir,
        project: tempfile::TempDir,
    }

    fn tree() -> Tree {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("a/b")).unwrap();
        fs::write(root.path().join("a/file.txt"), "in").unwrap();
        fs::write(outside.path().join("secret.txt"), "out").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        symlink(outside.path().join("secret.txt"), root.path().join("a/leak.txt")).unwrap();
        symlink(root.path().join("a/file.txt"), root.path().join("a/inner.txt")).unwrap();
        fs::write(project.path().join("package.json"), "{}").unwrap();
        symlink(project.path(), root.path().join("into-project")).unwrap();
        Tree { root, outside, project }
    }

    fn roots(paths: &[&Path]) -> Vec<PathBuf> {
        paths.iter().map(|p| p.to_path_buf()).collect()
    }

    fn code(result: Result<PathBuf, OpError>) -> Option<DaemonErrorCode> {
        match result {
            Ok(_) => None,
            Err(e) => Some(e.code.unwrap_or_else(|| panic!("a coded refusal, not {}", e.message))),
        }
    }

    fn inside(root: &Path, requested: &str) -> PathBuf {
        resolve_inside(&roots(&[root]), requested).unwrap()
    }

    #[test]
    fn resolves_relative_and_absolute_paths_that_stay_inside_the_root() {
        let t = tree();
        let root = t.root.path();
        assert!(inside(root, "a/file.txt").ends_with("a/file.txt"));
        assert_eq!(inside(root, root.join("a/b").to_str().unwrap()), inside(root, "a/b"));
        assert_eq!(inside(root, "."), inside(root, ""));
        assert_eq!(inside(root, "a/../a/b"), inside(root, "a/b"));
    }

    #[test]
    fn refuses_dot_dot_escapes_and_absolute_paths_outside_the_root_before_touching_the_disk() {
        let t = tree();
        let r = roots(&[t.root.path()]);
        assert_eq!(code(resolve_inside(&r, "..")), Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(code(resolve_inside(&r, "a/../../x")), Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(code(resolve_inside(&r, t.outside.path().to_str().unwrap())), Some(DaemonErrorCode::OutsideRoot));
        let sibling = format!("{}-sibling/x", t.root.path().display());
        assert_eq!(code(resolve_inside(&r, &sibling)), Some(DaemonErrorCode::OutsideRoot));
        // On disk too: a sibling that shares the root's name as a string prefix is still outside.
        fs::create_dir_all(&sibling).unwrap();
        let on_disk = code(resolve_inside(&r, &sibling));
        fs::remove_dir_all(format!("{}-sibling", t.root.path().display())).unwrap();
        assert_eq!(on_disk, Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(code(resolve_inside(&r, "/etc/passwd")), Some(DaemonErrorCode::OutsideRoot));
    }

    #[test]
    fn refuses_symlinks_that_leave_the_root_directly_or_through_a_parent() {
        let t = tree();
        let r = roots(&[t.root.path()]);
        assert_eq!(code(resolve_inside(&r, "escape")), Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(code(resolve_inside(&r, "escape/secret.txt")), Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(code(resolve_inside(&r, "a/leak.txt")), Some(DaemonErrorCode::OutsideRoot));
    }

    /// A workspace's own path is resolved under that workspace's rootfs on this computer, and the refusal names
    /// the path the frame gave: a person asked about a folder inside a workspace, and where this computer keeps
    /// that workspace's files is no part of the answer.
    #[test]
    fn a_refusal_names_the_path_it_was_asked_about_and_not_the_one_it_resolved() {
        let t = tree();
        let r = roots(&[t.root.path()]);
        let inside_the_workspace = "/root/repo/escape";
        let resolving = t.root.path().join("escape").to_string_lossy().into_owned();
        let refused = resolve_inside_named(&r, &resolving, inside_the_workspace).unwrap_err();
        assert_eq!(refused.code, Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(refused.message, format!("{inside_the_workspace} resolves outside the workspace root"));
        assert!(!refused.message.contains(&t.root.path().display().to_string()), "{}", refused.message);
        // A path that is not there reads the same way, and the two sentences are the ones a path under this
        // daemon's own root is refused with: the name is what differs, never the words.
        let missing = resolve_inside_named(&r, &t.root.path().join("nowhere").to_string_lossy(), "/root/repo/nowhere").unwrap_err();
        assert_eq!((missing.code, missing.message.as_str()), (Some(DaemonErrorCode::NotFound), "/root/repo/nowhere does not exist"));
        assert_eq!(resolve_inside(&r, "..").unwrap_err().message, ".. resolves outside the workspace root");
    }

    #[test]
    fn follows_symlinks_that_stay_inside() {
        let t = tree();
        assert_eq!(inside(t.root.path(), "a/inner.txt"), inside(t.root.path(), "a/file.txt"));
    }

    #[test]
    fn reports_a_missing_path_as_not_found_only_when_its_parent_is_inside() {
        let t = tree();
        let r = roots(&[t.root.path()]);
        assert_eq!(code(resolve_inside(&r, "a/missing.txt")), Some(DaemonErrorCode::NotFound));
        assert_eq!(code(resolve_inside(&r, "escape/missing.txt")), Some(DaemonErrorCode::OutsideRoot));
    }

    #[test]
    fn works_when_the_root_itself_is_given_through_a_symlinked_prefix() {
        let t = tree();
        let linked = t.outside.path().join("root-link");
        symlink(t.root.path(), &linked).unwrap();
        assert_eq!(inside(&linked, "a/file.txt"), inside(t.root.path(), "a/file.txt"));
        assert_eq!(code(resolve_inside(&roots(&[&linked]), "escape/secret.txt")), Some(DaemonErrorCode::OutsideRoot));
    }

    #[test]
    fn a_second_root_resolves_an_absolute_path_under_the_project_as_it_does_one_under_home() {
        let t = tree();
        let both = roots(&[t.root.path(), t.project.path()]);
        let pkg = t.project.path().join("package.json");
        assert_eq!(resolve_inside(&both, pkg.to_str().unwrap()).unwrap(), inside(t.project.path(), "package.json"));
        assert_eq!(resolve_inside(&both, t.project.path().to_str().unwrap()).unwrap(), inside(t.project.path(), "."));
        let file = t.root.path().join("a/file.txt");
        assert_eq!(resolve_inside(&both, file.to_str().unwrap()).unwrap(), inside(t.root.path(), "a/file.txt"));
    }

    #[test]
    fn a_second_root_resolves_a_relative_path_against_home_the_first_root() {
        let t = tree();
        let both = roots(&[t.root.path(), t.project.path()]);
        assert_eq!(resolve_inside(&both, "a/file.txt").unwrap(), inside(t.root.path(), "a/file.txt"));
        assert_eq!(code(resolve_inside(&both, "package.json")), Some(DaemonErrorCode::NotFound));
    }

    #[test]
    fn a_second_root_refuses_a_path_outside_both_roots_with_the_same_sentence() {
        let t = tree();
        let both = roots(&[t.root.path(), t.project.path()]);
        let secret = t.outside.path().join("secret.txt");
        let err = resolve_inside(&both, secret.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(err.message, format!("{} resolves outside the workspace root", secret.display()));
        let sibling = format!("{}-sibling/x", t.project.path().display());
        assert_eq!(code(resolve_inside(&both, &sibling)), Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(code(resolve_inside(&both, "escape/secret.txt")), Some(DaemonErrorCode::OutsideRoot));
    }

    #[test]
    fn says_a_path_under_a_root_that_is_gone_does_not_exist_rather_than_that_it_is_outside() {
        let t = tree();
        let gone = PathBuf::from(format!("{}-gone", t.project.path().display()));
        let r = vec![t.root.path().to_path_buf(), gone.clone()];
        assert_eq!(code(resolve_inside(&r, gone.join("src").to_str().unwrap())), Some(DaemonErrorCode::NotFound));
        assert_eq!(code(resolve_inside(&r, t.outside.path().join("x").to_str().unwrap())), Some(DaemonErrorCode::OutsideRoot));
        assert_eq!(resolve_inside(&r, "a/file.txt").unwrap(), inside(t.root.path(), "a/file.txt"));
    }

    #[test]
    fn follows_a_symlink_from_home_into_the_project_since_both_are_browsable() {
        let t = tree();
        let both = roots(&[t.root.path(), t.project.path()]);
        assert_eq!(resolve_inside(&both, "into-project/package.json").unwrap(), inside(t.project.path(), "package.json"));
        assert_eq!(code(resolve_inside(&roots(&[t.root.path()]), "into-project/package.json")), Some(DaemonErrorCode::OutsideRoot));
    }

    #[test]
    fn the_roots_file_is_read_as_it_is_now_absolute_lines_only_no_repeats_and_absent_means_home_alone() {
        let t = tree();
        let file = t.root.path().join("roots");
        assert_eq!(roots_now(t.root.path(), &file).unwrap(), vec![t.root.path().to_path_buf()]);
        let project = t.project.path().display();
        fs::write(&file, format!("  {project} \nrelative/one\n\n{project}\n{}\n", t.root.path().display())).unwrap();
        assert_eq!(roots_now(t.root.path(), &file).unwrap(), vec![t.root.path().to_path_buf(), t.project.path().to_path_buf()]);
        fs::write(&file, format!("{project}\n{}\n", t.outside.path().display())).unwrap();
        assert_eq!(roots_now(t.root.path(), &file).unwrap().len(), 3);
    }

    #[test]
    fn absolute_is_nodes_path_resolve() {
        assert_eq!(absolute(Path::new("/srv/work/../work/./here")), PathBuf::from("/srv/work/here"));
        assert_eq!(absolute(Path::new("/a/b/../../../c")), PathBuf::from("/c"));
        assert_eq!(absolute(Path::new("/a/b/")), PathBuf::from("/a/b"));
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(absolute(Path::new("sub")), cwd.join("sub"));
    }
}
