// SPDX-License-Identifier: AGPL-3.0-only
//! The copy a disk that shares no blocks makes: every byte written, through the standard library's own copy,
//! which asks the kernel to move the bytes and falls back to a read and a write where it will not. It costs the
//! checkout's bytes and the checkout's time, so the create says how long it took and the place's row says the
//! word, and neither pretends otherwise. A copies directory with less room left than the checkout holds is
//! refused before a byte moves, naming both numbers.

use std::fs::File;
use std::io;
use std::path::Path;

use wsp_frames::CopyWord;

use crate::copy::{copy_tree, remove_tree, Copier};

pub struct Plain;

impl Copier for Plain {
    fn word(&self) -> CopyWord {
        CopyWord::Plain
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        let parent = to.parent().unwrap_or(to);
        let wanted = crate::copy::tree_bytes(from)?;
        let free = free_bytes(parent)?;
        if free < wanted {
            return Err(io::Error::new(io::ErrorKind::StorageFull, no_room(parent, wanted, free)));
        }
        copy_tree(from, to, write_file)
    }

    fn remove(&self, to: &Path) -> io::Result<()> {
        remove_tree(to)
    }
}

/// The one sentence a copy nobody has room for is refused with: both numbers, so the person reads what is needed
/// and what is there rather than a full disk.
pub fn no_room(at: &Path, wanted: u64, free: u64) -> String {
    format!("{} has {free} bytes free and this project's copy takes {wanted}", at.display())
}

/// What the volume this directory sits on has left.
fn free_bytes(at: &Path) -> io::Result<u64> {
    let stat = nix::sys::statvfs::statvfs(at).map_err(|e| io::Error::new(io::Error::from(e).kind(), format!("{}: {e}", at.display())))?;
    Ok(stat.blocks_available() as u64 * stat.fragment_size() as u64)
}

/// One file's bytes into a target that does not exist yet, through the standard library's own copy: on Linux it
/// asks the kernel to move the bytes itself and falls back to a read and a write where the kernel refuses, and
/// it reaches that call the way the rest of this binary does. This module calls no C function of its own: a
/// direct call to copy_file_range in a static musl build with fat link time optimisation linked to address zero
/// and took the daemon's process down at the first file of every plain copy, since the standard library
/// declares that name weakly and an undefined weak reference pulls no member out of the C archive.
fn write_file(source: &Path, target: &Path) -> io::Result<()> {
    let mut read = File::open(source)?;
    let mut write = File::create_new(target)?;
    io::copy(&mut read, &mut write).map(|_| ()).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", target.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refusal_for_a_copy_there_is_no_room_for_names_both_numbers() {
        let said = no_room(Path::new("/wsp/copies"), 5_284_823_040, 1_520_442_115);
        assert!(said.contains("5284823040") && said.contains("1520442115") && said.contains("/wsp/copies"), "{said}");
    }

    /// The walk both copying variants share, read through the one that needs nothing of the disk: what a
    /// checkout is made of comes across as it was, and the two trees are each other's business no more.
    #[test]
    fn a_checkout_copies_byte_for_byte_with_its_modes_its_times_its_links_and_its_attributes() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("checkout"), dir.path().join("copies/wsp-a"));
        std::fs::create_dir_all(from.join("src")).unwrap();
        std::fs::write(from.join("README.md"), b"the checkout\n").unwrap();
        std::fs::write(from.join("src/index.js"), b"module.exports = 1\n").unwrap();
        std::fs::hard_link(from.join("src/index.js"), from.join("src/again.js")).unwrap();
        std::os::unix::fs::symlink("index.js", from.join("src/link.js")).unwrap();
        std::fs::set_permissions(from.join("README.md"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        // A read-only folder, which a copy that set the modes before writing the children could not fill.
        std::fs::create_dir(from.join("locked")).unwrap();
        std::fs::write(from.join("locked/pinned"), b"pinned\n").unwrap();
        std::fs::set_permissions(from.join("locked"), std::os::unix::fs::PermissionsExt::from_mode(0o500)).unwrap();
        xattr::set(from.join("README.md"), "user.wsp", b"kept").unwrap();
        let was = std::fs::symlink_metadata(from.join("src/index.js")).unwrap();

        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        Plain.copy(&from, &to).unwrap();

        assert_eq!(std::fs::read(to.join("README.md")).unwrap(), b"the checkout\n");
        assert_eq!(std::fs::read(to.join("locked/pinned")).unwrap(), b"pinned\n");
        assert_eq!(std::fs::symlink_metadata(&to).unwrap().mode() & 0o7777, std::fs::symlink_metadata(&from).unwrap().mode() & 0o7777);
        for name in ["README.md", "locked"] {
            let (there, here) = (std::fs::symlink_metadata(from.join(name)).unwrap(), std::fs::symlink_metadata(to.join(name)).unwrap());
            assert_eq!(here.mode() & 0o7777, there.mode() & 0o7777, "{name}");
        }
        // The checkout's own dates, to the nanosecond: a build system reads them to decide what it need not do.
        let now = std::fs::symlink_metadata(to.join("src/index.js")).unwrap();
        assert_eq!((now.mtime(), now.mtime_nsec()), (was.mtime(), was.mtime_nsec()));
        assert_eq!(xattr::get(to.join("README.md"), "user.wsp").unwrap().as_deref(), Some(&b"kept"[..]));
        assert_eq!(std::fs::read_link(to.join("src/link.js")).unwrap(), Path::new("index.js"));
        // The pair of names is one file in the copy too, and it is not the checkout's file.
        let (first, second) = (std::fs::metadata(to.join("src/index.js")).unwrap(), std::fs::metadata(to.join("src/again.js")).unwrap());
        assert_eq!((first.ino(), first.nlink()), (second.ino(), 2));
        assert_ne!(first.ino(), was.ino());
        // Each tree is its own from here: a write on one side is not a write on the other.
        std::fs::write(to.join("README.md"), b"written inside\n").unwrap();
        assert_eq!(std::fs::read(from.join("README.md")).unwrap(), b"the checkout\n");
        std::fs::write(from.join("src/index.js"), b"moved on\n").unwrap();
        assert_eq!(std::fs::read(to.join("src/index.js")).unwrap(), b"module.exports = 1\n");
        // And the copy goes as a whole, read-only folder and all.
        Plain.remove(&to).unwrap();
        assert!(!to.exists());
        Plain.remove(&to).unwrap();
    }

    #[test]
    fn a_copy_nobody_has_room_for_is_refused_before_a_byte_moves() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("checkout");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("big"), vec![7u8; 4096]).unwrap();
        // A copies directory whose volume is smaller than the checkout: /proc holds no bytes at all.
        let refused = Plain.copy(&from, Path::new("/proc/copies-of-nothing")).unwrap_err().to_string();
        assert!(refused.contains("4096") && refused.contains("bytes free"), "{refused}");
        assert!(!Path::new("/proc/copies-of-nothing").exists());
    }
}
