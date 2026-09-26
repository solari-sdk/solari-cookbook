// SPDX-License-Identifier: AGPL-3.0-only
//! The copy a disk that shares blocks makes: every file cloned with FICLONE, which writes metadata and no bytes,
//! so a checkout of a gigabyte costs its directory entries and nothing else until one side is written to. The
//! two trees are separate from the moment the clone is taken: a write on either copies the blocks it touches and
//! leaves the other as it was, which is what lets a box fetch a checkout while the workspaces already made from
//! it keep the tree they booted on.

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use wsp_frames::CopyWord;

use crate::copy::{copy_tree, remove_tree, Copier};

// FICLONE, _IOW(0x94, 9, int): the source's fd as the argument, the target's as the file the ioctl is on. The
// number is built by the kernel's own rule rather than written down, so it is right on every architecture.
nix::ioctl_write_int_bad!(ficlone, nix::request_code_write!(0x94, 9, std::mem::size_of::<nix::libc::c_int>()));

pub struct Reflink;

impl Copier for Reflink {
    fn word(&self) -> CopyWord {
        CopyWord::Reflink
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        copy_tree(from, to, clone_file)
    }

    fn remove(&self, to: &Path) -> io::Result<()> {
        remove_tree(to)
    }
}

/// One file cloned into a target that does not exist yet: the kernel shares the source's blocks with it, and the
/// walk gives it its mode, owner, times and attributes after. A kernel or a disk that refuses the clone refuses
/// it here, which is what the picker's probe reads before a copy is ever started.
pub fn clone_file(source: &Path, target: &Path) -> io::Result<()> {
    let read = File::open(source)?;
    let write = File::create_new(target)?;
    // SAFETY: both descriptors are open for the whole call, and FICLONE reads an int argument, which is what the
    // macro passes.
    unsafe { ficlone(write.as_raw_fd(), read.as_raw_fd()) }
        .map(|_| ())
        .map_err(|e| io::Error::new(io::Error::from(e).kind(), format!("{}: {e}", target.display())))
}

/// Whether the kernel clones a file of this checkout into that directory, asked with one of the checkout's own
/// files rather than with a file written beside itself: a clone inside the copies directory proves what that
/// volume can do and nothing about a clone from the checkout, which is the copy about to be made. FICLONE
/// across two filesystems answers EXDEV, a filesystem that shares no blocks answers EOPNOTSUPP, and a checkout
/// holding no file with bytes in it answers nothing at all, which reads as the plain copy that tree costs
/// anyway. A probe whose own removal fails stays under the copies directory as a hidden file; nothing names it, so
/// the open's sweep of every copy no record names takes it away.
pub fn clones_into(from: &Path, copies: &Path) -> bool {
    let Some(file) = first_file(from, &mut 0) else { return false };
    let probe = crate::copy::probe_path(copies, "clone-of-checkout");
    let took = clone_file(&file, &probe).is_ok();
    let _ = std::fs::remove_file(&probe);
    took
}

/// The first regular file with bytes in it, depth first, following no link. `looked` bounds the search, since a
/// checkout whose first thousands of entries are empty directories is still a create somebody is waiting on.
fn first_file(dir: &Path, looked: &mut u32) -> Option<PathBuf> {
    const LOOK_AT_MOST: u32 = 4096;
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        *looked += 1;
        if *looked > LOOK_AT_MOST {
            return None;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() && meta.len() > 0 {
            return Some(entry.path());
        }
        // A directory entry's own metadata is the link itself where it is one, so a link to a folder is not
        // walked into and a checkout that points at the whole disk costs nothing here.
        if meta.is_dir() {
            folders.push(entry.path());
        }
    }
    folders.into_iter().find_map(|folder| first_file(&folder, looked))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clone_number_is_the_kernels_own_for_this_architecture() {
        // The one number written down anywhere, and only here, against the kernel's rule as x86_64 and aarch64
        // both encode it: _IOW(0x94, 9, int).
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        assert_eq!(nix::request_code_write!(0x94, 9, std::mem::size_of::<nix::libc::c_int>()) as u64, 0x4004_9409);
    }
}
