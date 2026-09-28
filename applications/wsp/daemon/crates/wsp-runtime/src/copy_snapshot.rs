// SPDX-License-Identifier: AGPL-3.0-only
//! The copy btrfs makes of a checkout that is a subvolume of its own: a snapshot, which is one ioctl and no walk
//! at all, however many files the checkout holds. The snapshot is a subvolume too, so it is taken away by the
//! kernel rather than by removing a directory tree, and the picker only reaches here where the checkout really is
//! a subvolume, which is inode 256 on a btrfs.

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use wsp_frames::CopyWord;

use crate::copy::Copier;

/// The inode every subvolume's own root carries; the kernel's word for a btrfs is nix's own constant.
const SUBVOLUME_INODE: u64 = 256;
/// The longest name the ioctl's argument carries, and the argument itself, which the kernel reads as 4096 bytes.
const NAME_MAX: usize = 4040;

#[repr(C)]
struct VolArgsV2 {
    fd: i64,
    transid: u64,
    flags: u64,
    unused: [u64; 4],
    name: [u8; NAME_MAX],
}

impl VolArgsV2 {
    /// The argument for a snapshot of `fd` under `name`, or nothing where the name will not fit.
    fn new(fd: i64, name: &[u8]) -> Option<VolArgsV2> {
        if name.is_empty() || name.len() >= NAME_MAX || name.contains(&0) {
            return None;
        }
        let mut args = VolArgsV2 { fd, transid: 0, flags: 0, unused: [0; 4], name: [0; NAME_MAX] };
        args.name[..name.len()].copy_from_slice(name);
        Some(args)
    }
}

nix::ioctl_write_ptr!(snap_create_v2, 0x94, 23, VolArgsV2);
nix::ioctl_write_ptr!(snap_destroy_v2, 0x94, 63, VolArgsV2);

pub struct BtrfsSnapshot;

impl Copier for BtrfsSnapshot {
    fn word(&self) -> CopyWord {
        CopyWord::Snapshot
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        let (parent, name) = parent_and_name(to)?;
        let source = std::fs::File::open(from)?;
        let under = std::fs::File::open(parent)?;
        let args = VolArgsV2::new(i64::from(source.as_raw_fd()), name).ok_or_else(|| named(to, "is not a name a snapshot takes"))?;
        // SAFETY: both descriptors are open for the whole call and the argument is the 4096 bytes the ioctl reads.
        unsafe { snap_create_v2(under.as_raw_fd(), &args) }.map(|_| ()).map_err(|e| fault(to, e))
    }

    fn remove(&self, to: &Path) -> io::Result<()> {
        if !to.exists() {
            return Ok(());
        }
        let (parent, name) = parent_and_name(to)?;
        let under = std::fs::File::open(parent)?;
        let args = VolArgsV2::new(0, name).ok_or_else(|| named(to, "is not a name a snapshot takes"))?;
        // SAFETY: as above; the destroy reads the same argument and names the subvolume by its name under the fd.
        unsafe { snap_destroy_v2(under.as_raw_fd(), &args) }.map(|_| ()).map_err(|e| fault(to, e))
    }
}

/// Whether this checkout can be snapshotted into that directory, asked by taking one and taking it away again
/// rather than by comparing any id: btrfs gives every subvolume a device and a filesystem id of its own, so the
/// only honest question is the one the kernel answers. A subvolume on another filesystem answers EXDEV and
/// anything that is not btrfs answers ENOTTY; every refusal falls through to the next road, since a copy that
/// writes every byte is always there. A probe whose own removal fails stays under the copies directory as a
/// hidden subvolume; nothing names it, so the open's sweep of every copy no record names takes it away.
pub fn snapshots_into(from: &Path, copies: &Path) -> bool {
    let probe = crate::copy::probe_path(copies, "snapshot-probe");
    if BtrfsSnapshot.copy(from, &probe).is_err() {
        return false;
    }
    let _ = BtrfsSnapshot.remove(&probe);
    true
}

/// Whether this directory is a btrfs subvolume of its own, which is the one thing a snapshot can be taken of:
/// the kernel says btrfs for it and its inode is the number every subvolume root carries.
pub fn is_subvolume(path: &Path) -> bool {
    let Ok(stat) = nix::sys::statfs::statfs(path) else { return false };
    let Ok(meta) = std::fs::metadata(path) else { return false };
    stat.filesystem_type() == nix::sys::statfs::BTRFS_SUPER_MAGIC && meta.ino() == SUBVOLUME_INODE
}

fn parent_and_name(to: &Path) -> io::Result<(&Path, &[u8])> {
    let parent = to.parent().ok_or_else(|| named(to, "has no folder to sit in"))?;
    let name = to.file_name().ok_or_else(|| named(to, "has no name"))?;
    Ok((parent, name.as_bytes()))
}

fn named(to: &Path, said: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, format!("{} {said}", to.display()))
}

fn fault(to: &Path, e: nix::Error) -> io::Error {
    io::Error::new(io::Error::from(e).kind(), format!("{}: {e}", to.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ioctl_argument_is_the_four_kilobytes_the_kernel_reads_and_the_numbers_are_its_own() {
        assert_eq!(std::mem::size_of::<VolArgsV2>(), 4096);
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        {
            assert_eq!(nix::request_code_write!(0x94, 23, std::mem::size_of::<VolArgsV2>()) as u64, 0x5000_9417);
            assert_eq!(nix::request_code_write!(0x94, 63, std::mem::size_of::<VolArgsV2>()) as u64, 0x5000_943f);
        }
        assert!(VolArgsV2::new(0, b"").is_none() && VolArgsV2::new(0, b"a\0b").is_none());
        assert!(VolArgsV2::new(0, &vec![b'a'; NAME_MAX]).is_none());
        assert!(VolArgsV2::new(0, b"wsp-one").is_some());
    }

    #[test]
    fn a_directory_that_is_not_a_subvolume_is_not_one() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_subvolume(dir.path()));
        assert!(!is_subvolume(&dir.path().join("nothing here")));
    }
}
