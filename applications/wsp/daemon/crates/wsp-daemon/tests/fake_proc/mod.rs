// SPDX-License-Identifier: AGPL-3.0-only
//! A fake /proc tree, hand-written in the proc(5) layouts and built per test, so a daemon pointed at it with the
//! proc root reads its ports, load and processes off it; the uid comes from the directories' owner, which is
//! whoever runs the test. The same file serves the crate's own unit tests and the wire cases.
#![allow(dead_code)]

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

pub const BTIME: i64 = 1_757_000_000;
const AT_PAGESZ: u64 = 6;

#[derive(Debug, Clone, Default)]
pub struct FakeProc {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub comm: Option<String>,
    pub state: Option<String>,
    /// utime and stime in clock ticks.
    pub ticks: Option<(u64, u64)>,
    pub threads: Option<u32>,
    /// Clock ticks after boot.
    pub starttime: Option<u64>,
    /// Resident pages.
    pub rss: Option<u64>,
    pub cmdline: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub socket_inodes: Option<Vec<u64>>,
    /// The foreground process group on the controlling terminal.
    pub tpgid: Option<i64>,
    /// What fd 0 points at.
    pub stdin: Option<String>,
}

pub fn auxv(page_size: u64) -> Vec<u8> {
    let mut b = Vec::with_capacity(48);
    for word in [33u64, 0x7fff, AT_PAGESZ, page_size, 0, 0] {
        b.extend_from_slice(&word.to_le_bytes());
    }
    b
}

fn comm_of(p: &FakeProc) -> String {
    p.comm.clone().unwrap_or_else(|| format!("p{}", p.pid))
}

fn stat_line(p: &FakeProc) -> String {
    let (utime, stime) = p.ticks.unwrap_or((0, 0));
    let head: Vec<String> = vec![
        p.state.clone().unwrap_or_else(|| "S".to_owned()),
        p.ppid.unwrap_or(0).to_string(),
        "1".into(),
        "1".into(),
        "0".into(),
        p.tpgid.unwrap_or(-1).to_string(),
        "4194560".into(),
        "10".into(),
        "0".into(),
        "0".into(),
        "0".into(),
        utime.to_string(),
        stime.to_string(),
        "0".into(),
        "0".into(),
        "20".into(),
        "0".into(),
        p.threads.unwrap_or(1).to_string(),
        "0".into(),
        p.starttime.unwrap_or(100).to_string(),
        "1000000".into(),
        p.rss.unwrap_or(10).to_string(),
    ];
    let tail = vec!["0"; 28].join(" ");
    format!("{} ({}) {} {tail}\n", p.pid, comm_of(p), head.join(" "))
}

/// Written beside and renamed over, so a daemon reading on its own clock sees the old text or the new, never half.
pub fn write_whole(path: &Path, text: &str) {
    let next = PathBuf::from(format!("{}.next", path.display()));
    std::fs::write(&next, text).unwrap();
    std::fs::rename(&next, path).unwrap();
}

/// Replaces a symlink whatever it pointed at before.
fn relink(target: &str, path: &Path) {
    let _ = std::fs::remove_file(path);
    symlink(target, path).unwrap();
}

pub fn write_proc(root: &Path, p: &FakeProc) {
    let dir = root.join(p.pid.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    write_whole(&dir.join("stat"), &stat_line(p));
    write_whole(&dir.join("comm"), &format!("{}\n", comm_of(p)));
    let argv = p.cmdline.clone().unwrap_or_else(|| vec![comm_of(p)]);
    let mut cmdline: Vec<u8> = argv.join("\0").into_bytes();
    cmdline.push(0);
    std::fs::write(dir.join("cmdline"), cmdline).unwrap();
    if let Some(cwd) = &p.cwd {
        relink(cwd, &dir.join("cwd"));
    }
    if let Some(inodes) = &p.socket_inodes {
        let _ = std::fs::remove_dir_all(dir.join("fd"));
        std::fs::create_dir_all(dir.join("fd")).unwrap();
        for (i, inode) in inodes.iter().enumerate() {
            symlink(format!("socket:[{inode}]"), dir.join("fd").join((3 + i).to_string())).unwrap();
        }
    }
    if let Some(stdin) = &p.stdin {
        std::fs::create_dir_all(dir.join("fd")).unwrap();
        relink(stdin, &dir.join("fd/0"));
    }
}

#[derive(Debug, Clone, Default)]
pub struct FakeSys {
    pub load1: Option<f64>,
    pub mem_total_kb: Option<u64>,
    pub mem_available_kb: Option<u64>,
}

/// The three files the load module reads, in the proc(5) layouts, written whole so a read never sees half.
pub fn write_sys(root: &Path, sys: &FakeSys) {
    std::fs::write(root.join("stat"), format!("cpu  1 2 3 4 5 6 7 8 0 0\nbtime {BTIME}\nprocesses 100\n")).unwrap();
    std::fs::write(root.join("loadavg"), format!("{:.2} 0.40 0.30 1/100 200\n", sys.load1.unwrap_or(0.5))).unwrap();
    std::fs::write(
        root.join("meminfo"),
        format!(
            "MemTotal:       {} kB\nMemFree:         100000 kB\nMemAvailable:   {} kB\n",
            sys.mem_total_kb.unwrap_or(4_000_000),
            sys.mem_available_kb.unwrap_or(2_000_000)
        ),
    )
    .unwrap();
}

pub fn fake_proc_tree(procs: &[FakeProc], page_size: u64) -> tempfile::TempDir {
    let root = tempfile::Builder::new().prefix("wsp-fake-proc-").tempdir().unwrap();
    write_sys(root.path(), &FakeSys::default());
    std::fs::create_dir(root.path().join("self")).unwrap();
    std::fs::write(root.path().join("self/auxv"), auxv(page_size)).unwrap();
    std::fs::create_dir(root.path().join("net")).unwrap();
    std::fs::write(root.path().join("net/tcp"), "").unwrap();
    std::fs::write(root.path().join("net/tcp6"), "").unwrap();
    for p in procs {
        write_proc(root.path(), p);
    }
    root
}

pub struct FakeListener {
    pub port: u16,
    /// The process holding the socket; its fake entry is made when the tree has none.
    pub pid: u32,
    pub loopback: bool,
}

/// What is listening on the fake machine, as /proc/net/tcp shows it and as each holder's fd table names it.
pub fn set_listeners(root: &Path, rows: &[FakeListener]) {
    let mut lines = vec!["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode".to_owned()];
    for (i, row) in rows.iter().enumerate() {
        let inode = 100_000 + u64::from(row.port);
        let address = if row.loopback { "0100007F" } else { "00000000" };
        lines.push(format!(
            "   {i}: {address}:{:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 {inode} 1 0000000000000000 100 0 0 10 0",
            row.port
        ));
        let dir = root.join(row.pid.to_string());
        if !dir.join("stat").exists() {
            write_proc(root, &FakeProc { pid: row.pid, ..FakeProc::default() });
        }
        std::fs::create_dir_all(dir.join("fd")).unwrap();
        relink(&format!("socket:[{inode}]"), &dir.join("fd").join(inode.to_string()));
    }
    write_whole(&root.join("net/tcp"), &format!("{}\n", lines.join("\n")));
}

/// A passwd file naming root and whoever runs the test as tester; the directory it lives in, so it lives as long.
pub fn fake_passwd() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new().prefix("wsp-fake-passwd-").tempdir().unwrap();
    let uid = nix::unistd::getuid().as_raw();
    let path = dir.path().join("passwd");
    std::fs::write(&path, format!("root:x:0:0:root:/root:/bin/bash\ntester:x:{uid}:{uid}::/home/tester:/bin/sh\n")).unwrap();
    (dir, path)
}
