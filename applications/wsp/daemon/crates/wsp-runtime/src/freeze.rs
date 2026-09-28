// SPDX-License-Identifier: AGPL-3.0-only
//! What the daemon reads and writes at a workspace's cgroup: the processes in it, what it holds of its caps, and
//! the two limits the kernel takes from us rather than from the spec. The path is the plain manager's, which the
//! layout spells; nothing here reads a cgroup off a pid, since a pid can belong to another process by the time it
//! is read.
//!
//! Nothing here freezes. A workspace on a computer somebody owns is awake or stopped and nothing else, so the
//! freezer that used to serve the pause has no reader left: the pause kills, and the wake boots over what the
//! stop left on disk.

use std::fs;
use std::io;
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Where cgroup v2 is mounted.
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// Waits until cgroup.events says no process is left, or the cgroup is gone; killed processes take a moment to
/// leave, and the cgroup cannot be removed before they have.
pub fn wait_unpopulated(cgroup: &Path, patience: Duration) -> io::Result<()> {
    let started = Instant::now();
    loop {
        match fs::read_to_string(cgroup.join("cgroup.events")) {
            Ok(events) if events.lines().any(|line| line.trim() == "populated 0") => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        if started.elapsed() > patience {
            return Err(io::Error::other(format!("{} still holds processes after {} s", cgroup.display(), patience.as_secs())));
        }
        sleep(Duration::from_millis(2));
    }
}

/// No swap for a workspace: the memory cap is the cap, so a hog is killed instead of slowing the box. A box with
/// swap accounting off has no memory.swap.max to write and no swap to forbid.
pub fn forbid_swap(cgroup: &Path) -> io::Result<()> {
    match fs::write(cgroup.join("memory.swap.max"), "0") {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// The cap as a throttle, written beside the cap itself: above this the kernel puts the workspace's own processes
/// into reclaim and slows their allocations rather than ending one, so a workspace whose build has filled the
/// cap with page cache gives it back and runs on. The kill stays behind it as memory.max, which youki writes from
/// the spec: with no swap to fall back on, a workspace allocating memory nothing can reclaim would otherwise
/// stall in reclaim for the life of the box, holding its cores and its cgroup and answering nothing.
///
/// A cgroup whose controller keeps no memory.high refuses the write with no such file, since nothing creates a
/// file in cgroupfs: such a box has the cap and the kill alone, which is what it had before.
pub fn throttle_at(cgroup: &Path, mem_mb: u64) -> io::Result<()> {
    match fs::write(cgroup.join("memory.high"), (mem_mb * 1024 * 1024).to_string()) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// memory.current in bytes.
pub fn memory_current(cgroup: &Path) -> io::Result<u64> {
    let text = fs::read_to_string(cgroup.join("memory.current"))?;
    text.trim().parse().map_err(|e| io::Error::other(format!("memory.current: {e}")))
}

/// Every process in the cgroup and in the cgroups under it. The subtree because a workspace running a container
/// engine holds its containers' processes in cgroups of their own, and pids.current is not read: the pids
/// controller is not one a workspace needs, so a box that delegates only memory and cpu has no such file.
pub fn pids_under(cgroup: &Path) -> io::Result<Vec<i32>> {
    let mut pids: Vec<i32> = fs::read_to_string(cgroup.join("cgroup.procs"))?.lines().filter_map(|line| line.trim().parse().ok()).collect();
    for entry in fs::read_dir(cgroup)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            pids.extend(pids_under(&entry.path())?);
        }
    }
    Ok(pids)
}

/// How many of them there are, off the same walk: a reading counts what the stop signals.
pub fn pids_in(cgroup: &Path) -> io::Result<u64> {
    Ok(pids_under(cgroup)?.len() as u64)
}

/// cpu.stat's usage_usec.
pub fn cpu_usage_usec(cgroup: &Path) -> io::Result<u64> {
    let text = fs::read_to_string(cgroup.join("cpu.stat"))?;
    text.lines()
        .find_map(|line| line.strip_prefix("usage_usec ").and_then(|v| v.trim().parse().ok()))
        .ok_or_else(|| io::Error::other("cpu.stat carries no usage_usec"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_box_without_swap_accounting_has_no_swap_to_forbid() {
        let dir = tempfile::tempdir().unwrap();
        forbid_swap(dir.path()).unwrap();
        fs::write(dir.path().join("memory.swap.max"), "max").unwrap();
        forbid_swap(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("memory.swap.max")).unwrap(), "0");
        assert!(forbid_swap(Path::new("/proc/no-such-cgroup-here/x")).is_ok());
    }

    #[test]
    fn the_cap_is_written_as_a_throttle_beside_the_kill_and_a_cgroup_without_one_is_no_failure() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("memory.high"), "max").unwrap();
        throttle_at(dir.path(), 512).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("memory.high")).unwrap(), (512 * 1024 * 1024).to_string());
        // Written again by every wake, over whatever the last boot left at it.
        throttle_at(dir.path(), 1024).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("memory.high")).unwrap(), (1024 * 1024 * 1024).to_string());
        // A cgroup whose controller keeps no such file answers no such file, since cgroupfs creates none: the
        // boot goes on with the cap and the kill alone rather than failing.
        assert!(throttle_at(Path::new("/proc/no-such-cgroup-here/x"), 512).is_ok());
    }

    #[test]
    fn the_processes_of_a_workspace_are_its_cgroup_and_the_cgroups_under_it() {
        let dir = tempfile::tempdir().unwrap();
        let engine = dir.path().join("docker/one");
        fs::create_dir_all(&engine).unwrap();
        fs::write(dir.path().join("cgroup.procs"), "41\n42\n\n").unwrap();
        fs::write(engine.join("cgroup.procs"), "77\n").unwrap();
        fs::write(dir.path().join("docker/cgroup.procs"), "").unwrap();
        let mut pids = pids_under(dir.path()).unwrap();
        pids.sort_unstable();
        // The containers a workspace's own engine runs are its processes too, and an empty line is no process.
        assert_eq!(pids, [41, 42, 77]);
        assert_eq!(pids_in(dir.path()).unwrap(), 3);
        assert!(pids_under(&dir.path().join("gone")).is_err());
        fs::write(dir.path().join("cpu.stat"), "usage_usec 4200\nuser_usec 1\n").unwrap();
        assert_eq!(cpu_usage_usec(dir.path()).unwrap(), 4200);
    }
}
