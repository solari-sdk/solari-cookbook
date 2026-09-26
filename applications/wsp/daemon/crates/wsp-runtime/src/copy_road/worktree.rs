// SPDX-License-Identifier: AGPL-3.0-only
//! The road every computer has: a git worktree of the folder at the copy's path, with the config files git ignores
//! carried in beside it. It writes one registration inside the folder's own `.git`, which is the one thing wsp puts
//! inside somebody's project folder and the reason it is the fallback rather than the first road: a worktree costs
//! the files git tracks and nothing else, so the dependencies a checkout holds are not there and the copy installs
//! them itself.

use std::fs;
use std::io;
use std::path::Path;

use wsp_frames::{Carried, CopyRoadName};

use super::rules::{config_files, git, Walked, READ_MS, WRITE_MS};
use super::{Availability, CopyRoad, Settling};

pub struct Worktree;

impl CopyRoad for Worktree {
    fn name(&self) -> CopyRoadName {
        CopyRoadName::Worktree
    }

    /// Whether git here keeps worktrees and the copy's parent can be written in. The size line says nothing about
    /// this road: it writes the files git tracks, which is the checkout without its dependencies.
    fn available(&self, from: &Path, to: &Path, _walked: &Walked, _size_line_bytes: u64) -> Availability {
        let Ok(listed) = git(from, &["worktree", "list", "--porcelain"], READ_MS) else {
            return Availability::No(format!("{}: git here does not keep worktrees", from.display()));
        };
        if !listed.ok() {
            return Availability::No(format!("{}: git here does not keep worktrees", from.display()));
        }
        let Some(parent) = to.parent() else {
            return Availability::No(format!("{} has no folder to sit in", to.display()));
        };
        if !parent.is_dir() {
            return Availability::No(format!("{} is not a folder on this computer", parent.display()));
        }
        Availability::Yes
    }

    /// The worktree detached at the base, then the config files carried in. Detached and not on a branch of its
    /// own: a branch would be the folder's too, since the two share one git directory, and a copy must not move
    /// what the person has checked out.
    fn make(&self, from: &Path, to: &Path, base: &str) -> io::Result<()> {
        let added = git(from, &["worktree", "add", "--detach", &to.to_string_lossy(), base], WRITE_MS)?;
        if !added.ok() {
            return Err(io::Error::other(added.why()));
        }
        for path in config_files(from) {
            let source = from.join(&path);
            let target = to.join(&path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source, &target)?;
        }
        Ok(())
    }

    /// The worktree taken away and its registration with it, so the folder's own `.git` is left as it was found.
    fn remove(&self, from: &Path, to: &Path) -> io::Result<()> {
        let removed = git(from, &["worktree", "remove", "--force", &to.to_string_lossy()], WRITE_MS)?;
        if !removed.ok() && to.exists() {
            return Err(io::Error::other(removed.why()));
        }
        let _ = git(from, &["worktree", "prune"], READ_MS);
        Ok(())
    }

    fn carried(&self) -> Carried {
        Carried::ConfigOnly
    }

    /// A worktree shares the folder's own git directory, so the copy is the checkout it will be the moment git
    /// writes it: nothing to fetch, since a fetch here would move the person's own refs, nothing to reset, and no
    /// branch of its own to report.
    fn settling(&self) -> Settling {
        Settling::Made
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::copy_road::rules::{repo, sha_of};

    #[test]
    fn the_worktree_stands_at_the_base_and_carries_the_config_files_and_not_the_dependencies() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        fs::write(from.join(".gitignore"), b"node_modules/\n*.local\n").unwrap();
        assert!(git(&from, &["add", ".gitignore"], READ_MS).unwrap().ok());
        assert!(git(&from, &["commit", "--quiet", "-m", "ignore"], WRITE_MS).unwrap().ok());
        fs::create_dir_all(from.join("node_modules/pkg")).unwrap();
        fs::write(from.join("node_modules/pkg/index.js"), b"x\n").unwrap();
        fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
        let base = sha_of(&from, "HEAD").unwrap();
        let to = dir.path().join("work-other");
        let road = Worktree;
        assert!(matches!(road.available(&from, &to, &Walked { bytes: 0, files: 0 }, u64::MAX), Availability::Yes));
        road.make(&from, &to, &base).unwrap();
        assert_eq!(fs::read_to_string(to.join(".env.local")).unwrap(), "KEY=1\n");
        assert!(!to.join("node_modules").exists(), "a worktree carries no ignored directory");
        assert_eq!(sha_of(&to, "HEAD").unwrap(), base);
        assert_eq!(git(&to, &["rev-parse", "--abbrev-ref", "HEAD"], READ_MS).unwrap().out(), "HEAD", "detached");
        // The registration is there and goes with the remove, and nothing of the copy is left behind.
        let listed = git(&from, &["worktree", "list", "--porcelain"], READ_MS).unwrap();
        assert!(listed.stdout.contains(&to.canonicalize().unwrap().display().to_string()), "{}", listed.stdout);
        road.remove(&from, &to).unwrap();
        assert!(!to.exists());
        let after = git(&from, &["worktree", "list", "--porcelain"], READ_MS).unwrap();
        assert!(!after.stdout.contains("work-other"), "{}", after.stdout);
    }

    #[test]
    fn a_copy_path_whose_folder_is_not_there_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("no-such-folder/copy");
        let refused = match Worktree.available(&from, &to, &Walked { bytes: 0, files: 0 }, u64::MAX) {
            Availability::No(why) => why,
            Availability::Yes => panic!("a folder that is not there is not a place to copy to"),
        };
        assert!(refused.contains("no-such-folder"), "{refused}");
    }
}
