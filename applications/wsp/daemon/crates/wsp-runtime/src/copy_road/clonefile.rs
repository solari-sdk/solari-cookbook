// SPDX-License-Identifier: AGPL-3.0-only
//! The road a Mac has: one `clonefile(2)` call on the folder, which gives the copy every file the folder holds
//! sharing its blocks, dependencies and config files and all, in the time one directory takes rather than the time
//! a hundred and sixty thousand files take. `man 2 clonefile` discourages cloning a directory and warns that a
//! later write can return ENOSPC because the clone allocated nothing, which is why the free space is read before
//! the call and why anything that goes wrong takes the destination with it.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use wsp_frames::{Carried, CopyRoadName};

use super::aside;
use super::rules::{bytes_word, Walked};
use super::{Availability, CopyRoad, Settling};

pub struct Clonefile;

impl CopyRoad for Clonefile {
    fn name(&self) -> CopyRoadName {
        CopyRoadName::Clonefile
    }

    /// The four readings that decide whether this road can be taken: the same volume, because a clone shares
    /// blocks and blocks do not cross volumes; the volume saying it clones directories at all; the folder under
    /// the size line; and the volume holding enough free space for every byte the clone could grow into, which is
    /// the answer to the ENOSPC warning.
    fn available(&self, from: &Path, to: &Path, walked: &Walked, size_line_bytes: u64) -> Availability {
        let Some(parent) = to.parent() else {
            return Availability::No(format!("{} has no folder to sit in", to.display()));
        };
        let (here, there) = match (volume(from), volume(parent)) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => return Availability::No(format!("{}: {e}", to.display())),
        };
        clonable(to, &here, &there, clones_directories(from), walked, size_line_bytes)
    }

    /// One call, and nothing of the destination left where it fails: a clone that stopped part way is a folder
    /// that looks like a checkout and is not one.
    fn make(&self, from: &Path, to: &Path, _base: &str) -> io::Result<()> {
        let source = c_path(from)?;
        let target = c_path(to)?;
        // SAFETY: both paths are nul-terminated and the flags are none; the call writes nothing this process owns.
        let cloned = unsafe { libc::clonefile(source.as_ptr(), target.as_ptr(), 0) };
        if cloned != 0 {
            let e = io::Error::last_os_error();
            let _ = std::fs::remove_dir_all(to);
            return Err(io::Error::new(e.kind(), format!("{}: {e}", to.display())));
        }
        Ok(())
    }

    fn remove(&self, _from: &Path, to: &Path) -> io::Result<()> {
        aside::set_aside_then(to, aside::remove_later)
    }

    fn carried(&self) -> Carried {
        Carried::DepsAndConfig
    }

    /// The clone carries the folder's own git directory, so the copy is a repository in its own right: the rules
    /// fetch it and reset it to the base, and it stands on a branch of its own.
    fn settling(&self) -> Settling {
        Settling::OwnRepo
    }

    /// The two errnos that say this volume does not clone directories after all, whatever it answered when it was
    /// asked: `man 2 clonefile` returns ENOTSUP where the filesystem has no clone and EXDEV where the two paths
    /// turn out to be on different volumes. Either means the reading above was wrong rather than the copy having
    /// failed, so the picker moves to the next road; every other errno is a copy that failed and is said out loud.
    fn misread(&self, failed: &io::Error) -> bool {
        matches!(failed.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EXDEV))
    }
}

/// The four readings that decide whether this road can be taken, once the disk has been asked: the same volume,
/// because a clone shares blocks and blocks do not cross volumes; the volume saying it clones directories at all;
/// the folder under the size line; and enough free space for every byte the clone could grow into, which is the
/// answer to the ENOSPC the man page warns a later write can return. Pure, so each refusal has a test of its own
/// without a second volume having to be mounted.
pub(crate) fn clonable(to: &Path, here: &Volume, there: &Volume, clones: bool, walked: &Walked, size_line_bytes: u64) -> Availability {
    if here.device != there.device {
        return Availability::No(format!("{} is on another volume; a directory clone needs the same one", to.display()));
    }
    if !clones {
        return Availability::No(format!("{} cannot clone directories", here.mounted_on));
    }
    if walked.bytes > size_line_bytes {
        return Availability::No(format!(
            "the folder is {} and a clone above {} is not taken",
            bytes_word(walked.bytes),
            bytes_word(size_line_bytes)
        ));
    }
    if there.free_bytes < walked.bytes {
        return Availability::No(format!(
            "the volume has {} free and the copy could grow to {}",
            bytes_word(there.free_bytes),
            bytes_word(walked.bytes)
        ));
    }
    Availability::Yes
}

/// What one volume answers about itself: which volume it is, where it is mounted and how much of it is free. The
/// volume's identity is the device the kernel puts on every file of it, since `statfs`'s own filesystem id keeps
/// its two words private to libc and a clone that crosses volumes is exactly a clone across two devices.
pub(crate) struct Volume {
    pub(crate) device: u64,
    pub(crate) mounted_on: String,
    pub(crate) free_bytes: u64,
}

pub(crate) fn volume(at: &Path) -> io::Result<Volume> {
    let path = c_path(at)?;
    let mut read = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    // SAFETY: the path is nul-terminated and the struct is ours to fill.
    let asked = unsafe { libc::statfs(path.as_ptr(), read.as_mut_ptr()) };
    if asked != 0 {
        let e = io::Error::last_os_error();
        return Err(io::Error::new(e.kind(), format!("{}: {e}", at.display())));
    }
    // SAFETY: statfs answered 0, so the struct is filled.
    let read = unsafe { read.assume_init() };
    // SAFETY: f_mntonname is the nul-terminated mount point the call filled in.
    let mounted_on = unsafe { std::ffi::CStr::from_ptr(read.f_mntonname.as_ptr()) }.to_string_lossy().into_owned();
    let device = std::fs::metadata(at).map(|m| std::os::unix::fs::MetadataExt::dev(&m))?;
    Ok(Volume { device, mounted_on, free_bytes: read.f_bavail.saturating_mul(u64::from(read.f_bsize)) })
}

/// Whether the volume this path sits on says it clones directories, asked of the volume rather than read off a
/// filesystem's name: an APFS volume in a disk image and a network volume both answer for themselves.
pub(crate) fn clones_directories(at: &Path) -> bool {
    let Ok(path) = c_path(at) else { return false };
    let mut asking = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    #[repr(C)]
    struct Answer {
        length: u32,
        capabilities: libc::vol_capabilities_attr_t,
    }
    let mut answer = std::mem::MaybeUninit::<Answer>::zeroed();
    // SAFETY: the request names the two volume attributes, and the buffer is the length-prefixed struct they fill.
    let asked = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            std::ptr::from_mut(&mut asking).cast(),
            answer.as_mut_ptr().cast(),
            std::mem::size_of::<Answer>(),
            0,
        )
    };
    if asked != 0 {
        return false;
    }
    // SAFETY: getattrlist answered 0, so the buffer is filled.
    let answer = unsafe { answer.assume_init() };
    let interfaces = libc::VOL_CAPABILITIES_INTERFACES;
    let valid = answer.capabilities.valid[interfaces] & libc::VOL_CAP_INT_CLONE != 0;
    valid && answer.capabilities.capabilities[interfaces] & libc::VOL_CAP_INT_CLONE != 0
}

fn c_path(at: &Path) -> io::Result<CString> {
    CString::new(at.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("{}: {e}", at.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::copy_road::rules::{git, repo, sha_of, READ_MS};
    use std::fs;

    #[test]
    fn the_folder_this_suite_runs_in_is_on_a_volume_that_clones_directories() {
        let dir = tempfile::tempdir().unwrap();
        assert!(clones_directories(dir.path()), "{} does not clone directories", dir.path().display());
        let volume = volume(dir.path()).unwrap();
        assert!(volume.free_bytes > 0 && !volume.mounted_on.is_empty());
    }

    #[test]
    fn the_clone_carries_every_file_and_leaves_the_folder_it_came_from_alone() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        fs::write(from.join(".gitignore"), b"node_modules/\n*.local\n").unwrap();
        assert!(git(&from, &["add", ".gitignore"], READ_MS).unwrap().ok());
        assert!(git(&from, &["commit", "--quiet", "-m", "ignore"], crate::copy_road::rules::WRITE_MS).unwrap().ok());
        fs::create_dir_all(from.join("node_modules/pkg")).unwrap();
        fs::write(from.join("node_modules/pkg/index.js"), b"dep\n").unwrap();
        fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
        fs::write(from.join("README.md"), b"half edited\n").unwrap();
        let base = sha_of(&from, "HEAD").unwrap();
        let to = dir.path().join("work-other");
        Clonefile.make(&from, &to, &base).unwrap();
        assert_eq!(fs::read_to_string(to.join("node_modules/pkg/index.js")).unwrap(), "dep\n");
        assert_eq!(fs::read_to_string(to.join(".env.local")).unwrap(), "KEY=1\n");
        assert!(to.join(".git").is_dir(), "the clone carries the git directory, so it is a repo of its own");
        // The folder it came from still holds the edit that was in flight.
        assert_eq!(fs::read_to_string(from.join("README.md")).unwrap(), "half edited\n");
        Clonefile.remove(&from, &to).unwrap();
        assert!(!to.exists());
        assert!(from.join("README.md").exists());
    }

    #[test]
    fn a_path_that_is_already_there_is_refused_by_the_call_and_nothing_of_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("taken");
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join("mine.txt"), b"mine\n").unwrap();
        let refused = Clonefile.make(&from, &to, "HEAD").unwrap_err().to_string();
        assert!(refused.contains("taken"), "{refused}");
    }

    /// The four refusals in their own words, with the readings handed in: a second volume would have to be
    /// mounted to say any of this off a real disk, and what is worth holding is which sentence each reading gets.
    #[test]
    fn each_reading_that_rules_the_clone_out_has_its_own_sentence() {
        let apfs = Volume { device: 1, mounted_on: "/".to_owned(), free_bytes: 500 * 1024 * 1024 * 1024 };
        let elsewhere = Volume { device: 2, mounted_on: "/Volumes/stick".to_owned(), free_bytes: 500 * 1024 * 1024 * 1024 };
        let full = Volume { device: 1, mounted_on: "/".to_owned(), free_bytes: 1024 };
        let to = Path::new("/Volumes/stick/work-other");
        let small = Walked { bytes: 4096, files: 1 };
        let said = |a: Availability| match a {
            Availability::No(why) => why,
            Availability::Yes => panic!("this reading rules the clone out"),
        };
        assert_eq!(
            said(clonable(to, &apfs, &elsewhere, true, &small, u64::MAX)),
            "/Volumes/stick/work-other is on another volume; a directory clone needs the same one"
        );
        assert_eq!(said(clonable(to, &apfs, &apfs, false, &small, u64::MAX)), "/ cannot clone directories");
        assert_eq!(
            said(clonable(to, &apfs, &apfs, true, &small, 1024)),
            "the folder is 4096 bytes and a clone above 1024 bytes is not taken"
        );
        assert_eq!(
            said(clonable(to, &full, &full, true, &small, u64::MAX)),
            "the volume has 1024 bytes free and the copy could grow to 4096 bytes"
        );
        assert!(matches!(clonable(to, &apfs, &apfs, true, &small, u64::MAX), Availability::Yes));
    }
}
