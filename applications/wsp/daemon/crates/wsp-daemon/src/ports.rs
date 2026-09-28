// SPDX-License-Identifier: AGPL-3.0-only
//! This machine's listening TCP ports, one road per platform: Linux reads /proc/net/tcp and finds each socket's
//! holder through the /proc/[pid]/fd tables (pgrep is not on every guest); macOS asks lsof. The watcher diffs one
//! snapshot against the next and says what opened and what closed.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use wsp_frames::{numbers, DaemonEvent, ListeningPort, RelayPort};

use crate::{clock, Ctx, Listener};

const TCP_LISTEN: &str = "0A";
pub(crate) const DEFAULT_INTERVAL: Duration = Duration::from_secs(1);

/// One reading of what listens now, from whichever road the platform has.
pub(crate) type PortSource = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Vec<ListeningPort>> + Send>> + Send + Sync>;

/// Whether a listening address reaches only this computer: 127.0.0.0/8 or ::1, the IPv4-mapped form of either
/// included. The one rule, over the address bytes in network order; each road parses its own encoding down to them.
fn is_loopback_bytes(bytes: &[u8]) -> bool {
    match bytes.len() {
        4 => bytes[0] == 127,
        16 => {
            if bytes[..10].iter().any(|b| *b != 0) {
                return false;
            }
            if bytes[10] == 0xff && bytes[11] == 0xff {
                return is_loopback_bytes(&bytes[12..]);
            }
            bytes[10..] == [0, 0, 0, 0, 0, 1]
        }
        _ => false,
    }
}

/// The address bytes behind /proc/net/tcp's address column: each 32-bit word is printed little-endian in hex, so
/// 0100007F is 127.0.0.1 and a tcp6 row carries four such words. Empty for a column of any other width.
fn hex_address_bytes(addr: &str) -> Vec<u8> {
    if addr.len() != 8 && addr.len() != 32 || !addr.is_ascii() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity(addr.len() / 2);
    for word in addr.as_bytes().chunks(8) {
        for byte in word.chunks(2).rev() {
            match u8::from_str_radix(std::str::from_utf8(byte).unwrap_or("zz"), 16) {
                Ok(b) => bytes.push(b),
                Err(_) => return Vec::new(),
            }
        }
    }
    bytes
}

pub(crate) fn is_loopback_hex(addr: &str) -> bool {
    is_loopback_bytes(&hex_address_bytes(addr))
}

/// The address bytes behind a numeric host as lsof prints it: a dotted quad, an IPv6 address with its brackets
/// already off, or an IPv4-mapped one. Empty for a wildcard and for anything that does not parse.
fn host_address_bytes(host: &str) -> Vec<u8> {
    if host.contains(':') {
        host.parse::<std::net::Ipv6Addr>().map(|a| a.octets().to_vec()).unwrap_or_default()
    } else {
        host.parse::<std::net::Ipv4Addr>().map(|a| a.octets().to_vec()).unwrap_or_default()
    }
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    is_loopback_bytes(&host_address_bytes(host))
}

/// /proc/net/tcp (or tcp6; same layout, wider address) as LISTEN rows. The file carries socket inodes, not pids;
/// the inode-to-pid map built from a /proc/[pid]/fd scan names the owners.
pub(crate) fn parse_proc_net_tcp(text: &str, inode_to_pid: Option<&HashMap<u64, u32>>) -> Vec<ListeningPort> {
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 || f[3] != TCP_LISTEN {
            continue;
        }
        let (addr, port_hex) = f[1].rsplit_once(':').unwrap_or(("", f[1]));
        let Ok(port) = u16::from_str_radix(port_hex, 16) else { continue };
        let Ok(inode) = f[9].parse::<u64>() else { continue };
        rows.push(ListeningPort {
            port,
            pid: inode_to_pid.and_then(|m| m.get(&inode).copied()),
            inode: Some(inode),
            uid: f[7].parse().unwrap_or(0),
            process: None,
            command: None,
            loopback: is_loopback_hex(addr),
        });
    }
    rows
}

/// Every socket inode a process holds, to the pid holding it. pgrep does not exist in the guests; walking
/// /proc/[pid]/fd is the portable way.
fn scan_socket_inodes(proc_root: &Path) -> HashMap<u64, u32> {
    let mut map = HashMap::new();
    let Ok(dirs) = std::fs::read_dir(proc_root) else { return map };
    for dir in dirs.flatten() {
        let Some(pid) = dir.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(fds) = std::fs::read_dir(dir.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            let target = target.to_string_lossy();
            if let Some(inode) = target.strip_prefix("socket:[").and_then(|t| t.strip_suffix(']')).and_then(|n| n.parse::<u64>().ok()) {
                map.insert(inode, pid);
            }
        }
    }
    map
}

fn read_comm(proc_root: &Path, pid: u32) -> Option<String> {
    let comm = std::fs::read_to_string(proc_root.join(pid.to_string()).join("comm")).ok()?;
    let comm = comm.trim();
    (!comm.is_empty()).then(|| comm.to_owned())
}

/// The holder's argv joined by spaces, at most PORT_CMDLINE_CAP_BYTES of it; a cut argv ends with an ellipsis.
/// cmdline separates argv with NUL bytes and ends with one.
fn read_cmdline(proc_root: &Path, pid: u32) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(proc_root.join(pid.to_string()).join("cmdline")).ok()?;
    let mut buf = vec![0u8; numbers::PORT_CMDLINE_CAP_BYTES + 1];
    let mut read = 0;
    while read < buf.len() {
        match file.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return None,
        }
    }
    let kept = String::from_utf8_lossy(&buf[..read.min(numbers::PORT_CMDLINE_CAP_BYTES)]).into_owned();
    let command: Vec<&str> = kept.split('\0').filter(|a| !a.is_empty()).collect();
    if command.is_empty() {
        return None;
    }
    let command = command.join(" ");
    Some(if read > numbers::PORT_CMDLINE_CAP_BYTES { format!("{command}\u{2026}") } else { command })
}

/// The Linux road, as one reading: tcp then tcp6, one row per port (the first wins), each owner named by comm and
/// cmdline where the fd scan found one.
pub(crate) fn proc_snapshot(proc_root: &Path) -> Vec<ListeningPort> {
    let texts = ["tcp", "tcp6"].map(|name| std::fs::read_to_string(proc_root.join("net").join(name)).unwrap_or_default());
    let inode_to_pid = scan_socket_inodes(proc_root);
    let mut rows: Vec<ListeningPort> = Vec::new();
    for text in &texts {
        for row in parse_proc_net_tcp(text, Some(&inode_to_pid)) {
            if !rows.iter().any(|r| r.port == row.port) {
                rows.push(row);
            }
        }
    }
    for row in &mut rows {
        if let Some(pid) = row.pid {
            row.process = read_comm(proc_root, pid);
            row.command = read_cmdline(proc_root, pid);
        }
    }
    rows
}

pub(crate) fn proc_net_tcp_source(proc_root: PathBuf) -> PortSource {
    Arc::new(move || {
        let root = proc_root.clone();
        Box::pin(async move { tokio::task::spawn_blocking(move || proc_snapshot(&root)).await.unwrap_or_default() })
    })
}

/// lsof's field output for the listening TCP sockets this user can see: numeric hosts and ports, untruncated
/// command names, and one field per line. A process set opens with its pid and carries its command and uid; each
/// socket under it opens with its fd and carries its address.
const LSOF_ARGS: [&str; 8] = ["-nP", "-w", "+c", "0", "-F", "pcfnu", "-iTCP", "-sTCP:LISTEN"];

/// lsof field output into LISTEN rows. The fd lines only separate one socket from the next; a row is the process
/// set's pid, command and uid with that socket's address. lsof names neither an argv nor a socket inode.
pub(crate) fn parse_lsof_listeners(text: &str) -> Vec<ListeningPort> {
    let mut rows = Vec::new();
    let (mut pid, mut uid, mut process): (Option<u32>, u32, Option<String>) = (None, 0, None);
    for line in text.lines() {
        let Some(field) = line.chars().next() else { continue };
        let value = &line[field.len_utf8()..];
        match field {
            'p' => {
                pid = value.parse().ok();
                uid = 0;
                process = None;
            }
            'c' => {
                if !value.is_empty() {
                    process = Some(value.to_owned());
                }
            }
            'u' => uid = value.parse().unwrap_or(0),
            'n' => {
                let Some((host, port)) = value.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let host = host.strip_prefix('[').unwrap_or(host);
                let host = host.strip_suffix(']').unwrap_or(host);
                rows.push(ListeningPort {
                    port,
                    pid,
                    inode: None,
                    uid,
                    process: process.clone(),
                    command: None,
                    loopback: is_loopback_host(host),
                });
            }
            _ => {}
        }
    }
    rows
}

/// The darwin road: /proc does not exist there, so lsof names the listeners. lsof exits non-zero when nothing is
/// listening, and whatever it printed before that is still read; a lsof that cannot run reads as no ports.
pub(crate) async fn lsof_snapshot(program: &Path) -> Vec<ListeningPort> {
    let printed = match tokio::process::Command::new(program).args(LSOF_ARGS).output().await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(_) => String::new(),
    };
    let mut rows: Vec<ListeningPort> = Vec::new();
    for row in parse_lsof_listeners(&printed) {
        if !rows.iter().any(|r| r.port == row.port) {
            rows.push(row);
        }
    }
    rows
}

pub(crate) fn lsof_source() -> PortSource {
    Arc::new(|| Box::pin(lsof_snapshot(Path::new("lsof"))))
}

/// A platform with no road here reads empty rather than failing the daemon that asked, so a pane on it shows no
/// ports instead of no daemon.
pub(crate) fn empty_source() -> PortSource {
    Arc::new(|| Box::pin(async { Vec::new() }))
}

/// The road for this daemon: a fake /proc stands in for the whole machine, ports included, when one is given, so a
/// test on darwin drives the Linux road; the platform's own road otherwise.
pub(crate) fn source_for(proc_root: Option<&Path>) -> PortSource {
    match proc_root {
        Some(root) => proc_net_tcp_source(root.to_path_buf()),
        None if cfg!(target_os = "linux") => proc_net_tcp_source(PathBuf::from("/proc")),
        None if cfg!(target_os = "macos") => lsof_source(),
        None => empty_source(),
    }
}

/// Signal 0 delivers nothing and reports whether the pid exists; EPERM means it does, under another user.
fn pid_alive(pid: u32) -> bool {
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(errno) => errno == nix::errno::Errno::EPERM,
    }
}

pub(crate) struct PortWatcher {
    source: PortSource,
    alive: Box<dyn Fn(u32) -> bool + Send + Sync>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    known: Vec<ListeningPort>,
    /// The first poll seeds what is already listening without events: a listener that predates the watcher is not
    /// a change.
    primed: bool,
}

impl PortWatcher {
    pub(crate) fn new(source: PortSource) -> PortWatcher {
        PortWatcher::with(source, Box::new(pid_alive), Box::new(clock::now_ms))
    }

    pub(crate) fn with(
        source: PortSource,
        alive: Box<dyn Fn(u32) -> bool + Send + Sync>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> PortWatcher {
        PortWatcher { source, alive, now, known: Vec::new(), primed: false }
    }

    pub(crate) fn current(&self) -> Vec<ListeningPort> {
        self.known.clone()
    }

    /// One reading against the last: what opened and what closed since, as the events to push.
    pub(crate) async fn poll(&mut self) -> Vec<DaemonEvent> {
        let next = (self.source)().await;
        if !self.primed {
            self.primed = true;
            self.known = next;
            return Vec::new();
        }
        let mut events = Vec::new();
        for row in &next {
            if !self.known.iter().any(|k| k.port == row.port) {
                // The wire has no null pid: an owner the fd scan could not name is left out, like its comm.
                events.push(DaemonEvent::PortOpen {
                    port: row.port,
                    pid: row.pid,
                    process: row.process.clone(),
                    loopback: Some(row.loopback),
                });
            }
        }
        for row in &self.known {
            if !next.iter().any(|n| n.port == row.port) {
                events.push(self.close_event(row));
            }
        }
        self.known = next;
        events
    }

    /// The close names the last row's holder, since /proc no longer has the socket to ask.
    fn close_event(&self, row: &ListeningPort) -> DaemonEvent {
        let at = Some(clock::iso_millis((self.now)()));
        match row.pid {
            None => DaemonEvent::PortClose { port: row.port, pid: None, process: None, command: None, exited: None, at },
            Some(pid) => DaemonEvent::PortClose {
                port: row.port,
                pid: Some(pid),
                process: row.process.clone(),
                command: row.command.clone(),
                exited: Some(!(self.alive)(pid)),
                at,
            },
        }
    }
}

/// The one watcher a daemon runs, started by the first ports.watch and polling on its interval from then on; every
/// subscriber hears every change, and the spotter hears every open.
pub(crate) struct PortWatch {
    pub(crate) watcher: tokio::sync::Mutex<PortWatcher>,
    interval: Duration,
    subscribers: Mutex<Vec<Listener>>,
    started: AtomicBool,
}

impl PortWatch {
    pub(crate) fn new(source: PortSource, interval: Duration) -> PortWatch {
        PortWatch {
            watcher: tokio::sync::Mutex::new(PortWatcher::new(source)),
            interval,
            subscribers: Mutex::new(Vec::new()),
            started: AtomicBool::new(false),
        }
    }

    pub(crate) fn subscribe(&self, listener: Listener) {
        self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).push(listener);
    }

    pub(crate) fn unsubscribe(&self, key: u64) {
        self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).retain(|l| l.key != key);
    }

    /// Polls on the interval from the first call on; a poll awaited by an op runs under the same lock, so the reply
    /// after it carries the seed rather than racing it.
    pub(crate) fn start(&self, ctx: &Arc<Ctx>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let ctx = Arc::clone(ctx);
        tokio::spawn(async move {
            loop {
                let events = ctx.ports.watcher.lock().await.poll().await;
                ctx.ports.deliver(&ctx, events);
                tokio::time::sleep(ctx.ports.interval).await;
            }
        });
    }

    /// Every change to every subscriber; an open that a browser.open with no port is waiting for becomes the
    /// callback.port every authed socket hears.
    pub(crate) fn deliver(&self, ctx: &Ctx, events: Vec<DaemonEvent>) {
        for event in events {
            let text = crate::frame_text(&event);
            self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).retain(|l| l.out.send_text(&text));
            if let DaemonEvent::PortOpen { port, loopback, .. } = event {
                let spotted = ctx.spotter.lock().unwrap_or_else(|e| e.into_inner()).note_open(port, loopback == Some(true));
                if let Some(port) = spotted.and_then(RelayPort::new) {
                    ctx.broadcast(&DaemonEvent::CallbackPort { port });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(name)).unwrap()
    }

    fn fixed(rows: Arc<Mutex<Vec<ListeningPort>>>) -> PortSource {
        Arc::new(move || {
            let rows = rows.lock().unwrap().clone();
            Box::pin(async move { rows })
        })
    }

    fn row(port: u16, pid: Option<u32>, inode: u64, uid: u32, loopback: bool) -> ListeningPort {
        ListeningPort { port, pid, inode: Some(inode), uid, process: None, command: None, loopback }
    }

    fn watcher_with(source: PortSource, alive: bool, at: u64) -> PortWatcher {
        PortWatcher::with(source, Box::new(move |_| alive), Box::new(move || at))
    }

    const AT: u64 = 1_788_609_840_000;
    const AT_ISO: &str = "2026-09-05T12:04:00.000Z";

    #[test]
    fn parse_proc_net_tcp_returns_listen_ports_with_pids_resolved_through_the_inode_map() {
        let map = HashMap::from([(45678, 123), (45700, 456)]);
        let rows = parse_proc_net_tcp(&fixture("proc-net-tcp.txt"), Some(&map));
        assert_eq!(rows.iter().map(|r| (r.port, r.pid)).collect::<Vec<_>>(), [(8080, Some(123)), (3000, Some(456))]);
    }

    #[test]
    fn parse_proc_net_tcp_filters_non_listen_rows_and_survives_a_missing_inode_map() {
        let rows = parse_proc_net_tcp(&fixture("proc-net-tcp.txt"), None);
        assert_eq!(rows.iter().map(|r| r.port).collect::<Vec<_>>(), [8080, 3000]);
        assert_eq!((rows[0].pid, rows[0].inode, rows[0].uid), (None, Some(45678), 0));
        assert_eq!((rows[1].pid, rows[1].inode, rows[1].uid), (None, Some(45700), 1000));
    }

    #[tokio::test]
    async fn the_watcher_emits_port_open_and_port_close_on_diffs_between_polls() {
        let snapshot = Arc::new(Mutex::new(vec![row(8080, Some(123), 45678, 0, false)]));
        let mut w = PortWatcher::new(fixed(Arc::clone(&snapshot)));
        // The first poll seeds what is already there without events; only changes after it are events.
        assert!(w.poll().await.is_empty());
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [8080]);
        *snapshot.lock().unwrap() = vec![row(8080, Some(123), 45678, 0, false), row(3000, Some(456), 45700, 1000, true)];
        let opened = w.poll().await;
        *snapshot.lock().unwrap() = vec![row(3000, Some(456), 45700, 1000, true)];
        let closed = w.poll().await;
        let steady = w.poll().await;
        assert_eq!(opened, [DaemonEvent::PortOpen { port: 3000, pid: Some(456), process: None, loopback: Some(true) }]);
        assert!(matches!(closed.as_slice(), [DaemonEvent::PortClose { port: 8080, .. }]));
        assert!(steady.is_empty());
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [3000]);
    }

    /// A /proc lookalike: net/tcp from the fixture, pid 123 owning inode 45678 with comm "node" and a cmdline, pid
    /// 456 owning inode 45700 with no comm file at all.
    fn fake_proc_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("net")).unwrap();
        std::fs::write(root.path().join("net/tcp"), fixture("proc-net-tcp.txt")).unwrap();
        std::fs::create_dir_all(root.path().join("123/fd")).unwrap();
        symlink("socket:[45678]", root.path().join("123/fd/3")).unwrap();
        std::fs::write(root.path().join("123/comm"), "node\n").unwrap();
        std::fs::write(root.path().join("123/cmdline"), "node\0server.js\0--port\08080\0").unwrap();
        std::fs::create_dir_all(root.path().join("456/fd")).unwrap();
        symlink("socket:[45700]", root.path().join("456/fd/5")).unwrap();
        root
    }

    #[tokio::test]
    async fn the_proc_road_names_the_listener_from_comm_and_its_argv_from_cmdline_leaving_both_unset_when_unreadable() {
        let root = fake_proc_root();
        let rows = proc_net_tcp_source(root.path().to_path_buf())().await;
        assert_eq!(
            rows,
            [
                ListeningPort {
                    port: 8080,
                    pid: Some(123),
                    inode: Some(45678),
                    uid: 0,
                    process: Some("node".into()),
                    command: Some("node server.js --port 8080".into()),
                    loopback: false
                },
                row(3000, Some(456), 45700, 1000, true),
            ]
        );
    }

    #[tokio::test]
    async fn reads_at_most_512_bytes_of_cmdline_and_ends_a_cut_argv_with_an_ellipsis() {
        let root = fake_proc_root();
        std::fs::write(root.path().join("456/cmdline"), format!("node\0-e\0{}\0", "x".repeat(4096))).unwrap();
        let rows = proc_snapshot(root.path());
        assert_eq!(rows[1].command.as_deref(), Some(format!("node -e {}\u{2026}", "x".repeat(504)).as_str()));
        assert_eq!(rows[1].command.as_ref().unwrap().chars().count(), 513);
        assert_eq!(rows[1].process, None);
    }

    #[tokio::test]
    async fn port_open_carries_process_when_the_row_has_one() {
        let root = fake_proc_root();
        let empty = Arc::new(Mutex::new(Vec::new()));
        let mut w = PortWatcher::new(fixed(empty));
        assert!(w.poll().await.is_empty());
        w.source = proc_net_tcp_source(root.path().to_path_buf());
        assert_eq!(
            w.poll().await,
            [
                DaemonEvent::PortOpen { port: 8080, pid: Some(123), process: Some("node".into()), loopback: Some(false) },
                DaemonEvent::PortOpen { port: 3000, pid: Some(456), process: None, loopback: Some(true) },
            ]
        );
    }

    #[tokio::test]
    async fn across_a_listener_restart_on_one_port_it_emits_close_then_open_whether_or_not_the_new_owner_can_be_read() {
        let root = fake_proc_root();
        let tcp = fixture("proc-net-tcp.txt");
        let restarted_row = tcp.lines().find(|l| l.contains("45678")).unwrap().to_owned();
        let without = tcp.replace(&format!("{restarted_row}\n"), "");
        let unowned = tcp.replace(&restarted_row, &restarted_row.replace("45678", "45999"));
        let mut w = watcher_with(proc_net_tcp_source(root.path().to_path_buf()), false, AT);
        assert!(w.poll().await.is_empty());

        std::fs::write(root.path().join("net/tcp"), &without).unwrap();
        std::fs::remove_dir_all(root.path().join("123")).unwrap();
        let closed = w.poll().await;
        assert_eq!(
            closed,
            [DaemonEvent::PortClose {
                port: 8080,
                pid: Some(123),
                process: Some("node".into()),
                command: Some("node server.js --port 8080".into()),
                exited: Some(true),
                at: Some(AT_ISO.into()),
            }]
        );
        assert_eq!(
            serde_json::to_value(&closed[0]).unwrap(),
            serde_json::json!({ "type": "port.close", "port": 8080, "pid": 123, "process": "node", "command": "node server.js --port 8080", "exited": true, "at": AT_ISO })
        );

        std::fs::write(root.path().join("net/tcp"), &unowned).unwrap();
        let opened = w.poll().await;
        assert_eq!(serde_json::to_value(&opened).unwrap(), serde_json::json!([{ "type": "port.open", "port": 8080, "loopback": false }]));
    }

    async fn close_after(rows: Vec<ListeningPort>, alive: bool) -> Vec<serde_json::Value> {
        let snapshot = Arc::new(Mutex::new(rows));
        let mut w = watcher_with(fixed(Arc::clone(&snapshot)), alive, AT);
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().clear();
        w.poll().await.iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    fn held() -> ListeningPort {
        ListeningPort {
            port: 8412,
            pid: Some(53479),
            inode: Some(9),
            uid: 0,
            process: Some("python3".into()),
            command: Some("python3 -m http.server 8412".into()),
            loopback: false,
        }
    }

    #[tokio::test]
    async fn a_port_seen_with_a_pid_closes_with_its_holder_whether_the_pid_exited_and_the_time() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        let snapshot = Arc::new(Mutex::new(vec![held()]));
        let mut w = PortWatcher::with(
            fixed(Arc::clone(&snapshot)),
            Box::new(move |pid| {
                seen.lock().unwrap().push(pid);
                false
            }),
            Box::new(|| AT),
        );
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().clear();
        let closed: Vec<serde_json::Value> = w.poll().await.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
        assert_eq!(
            closed,
            [
                serde_json::json!({ "type": "port.close", "port": 8412, "pid": 53479, "process": "python3", "command": "python3 -m http.server 8412", "exited": true, "at": AT_ISO })
            ]
        );
        assert_eq!(*asked.lock().unwrap(), [53479]);
    }

    #[tokio::test]
    async fn a_holder_still_alive_when_its_port_closes_is_said_to_be_running() {
        let closed = close_after(vec![held()], true).await;
        assert_eq!((closed[0]["pid"].as_u64(), closed[0]["exited"].as_bool()), (Some(53479), Some(false)));
    }

    #[tokio::test]
    async fn a_port_whose_owner_was_never_resolved_closes_plain_with_only_the_time() {
        let unowned = ListeningPort { port: 3000, pid: None, inode: Some(10), uid: 0, process: None, command: None, loopback: false };
        let snapshot = Arc::new(Mutex::new(vec![unowned]));
        let mut w = PortWatcher::with(fixed(Arc::clone(&snapshot)), Box::new(|_| panic!("never asked without a pid")), Box::new(|| AT));
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().clear();
        let closed: Vec<serde_json::Value> = w.poll().await.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
        assert_eq!(closed, [serde_json::json!({ "type": "port.close", "port": 3000, "at": AT_ISO })]);
    }

    #[test]
    fn loopback_listeners_in_proc_net_tcp_and_tcp6() {
        for (hex, loopback) in [
            ("0100007F", true),
            ("0200007F", true),
            ("00000000", false),
            ("0101A8C0", false),
            ("00000000000000000000000001000000", true),
            ("0000000000000000FFFF00000100007F", true),
            ("00000000000000000000000000000000", false),
            ("00000000000000000000000002000000", false),
            ("FE800000000000000000000000000001", false),
            ("0100", false),
            ("zz00007F", false),
        ] {
            assert_eq!(is_loopback_hex(hex), loopback, "{hex}");
        }
    }

    #[test]
    fn flags_the_fixture_rows_loopback_as_the_node_daemon_does() {
        let rows6 = parse_proc_net_tcp(&fixture("proc-net-tcp6.txt"), None);
        assert_eq!(rows6.iter().map(|r| (r.port, r.loopback)).collect::<Vec<_>>(), [(8976, true), (7070, false), (3001, true)]);
        let rows = parse_proc_net_tcp(&fixture("proc-net-tcp.txt"), None);
        assert_eq!(rows.iter().map(|r| (r.port, r.loopback)).collect::<Vec<_>>(), [(8080, false), (3000, true)]);
    }

    #[test]
    fn loopback_in_a_text_address_as_lsof_prints_it() {
        for (host, loopback) in [
            ("127.0.0.1", true),
            ("127.0.0.2", true),
            ("::1", true),
            ("::ffff:127.0.0.1", true),
            ("0.0.0.0", false),
            ("192.168.1.1", false),
            ("::", false),
            ("fe80::1", false),
            ("::ffff:192.168.1.1", false),
            ("*", false),
            ("", false),
            ("not-an-address", false),
        ] {
            assert_eq!(is_loopback_host(host), loopback, "{host}");
        }
    }

    fn lsof_row(port: u16, pid: u32, uid: u32, process: &str, loopback: bool) -> ListeningPort {
        ListeningPort { port, pid: Some(pid), inode: None, uid, process: Some(process.into()), command: None, loopback }
    }

    #[test]
    fn parse_lsof_listeners_gives_one_row_per_listening_socket_with_its_process_sets_pid_command_and_uid() {
        assert_eq!(
            parse_lsof_listeners(&fixture("lsof-listen.txt")),
            [
                lsof_row(7000, 712, 501, "ControlCenter", false),
                lsof_row(5000, 712, 501, "ControlCenter", true),
                lsof_row(3000, 1042, 501, "node", true),
                lsof_row(3000, 1042, 501, "node", true),
                lsof_row(49152, 88, 0, "rapportd", false),
            ]
        );
    }

    #[test]
    fn a_line_that_is_not_a_field_and_a_name_with_no_port_are_skipped() {
        assert_eq!(
            parse_lsof_listeners("lsof: WARNING: can't stat()\np9\ncsh\nu0\nf3\nnpipe\nf4\nn127.0.0.1:8080\n"),
            [lsof_row(8080, 9, 0, "sh", true)]
        );
    }

    fn fake_lsof(script: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lsof");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, path)
    }

    #[tokio::test]
    async fn the_darwin_road_asks_lsof_and_folds_its_rows_to_one_per_port() {
        let (_dir, lsof) = fake_lsof(&format!("#!/bin/sh\ncat <<'OUT'\n{}OUT\n", fixture("lsof-listen.txt")));
        assert_eq!(
            lsof_snapshot(&lsof).await,
            [
                lsof_row(7000, 712, 501, "ControlCenter", false),
                lsof_row(5000, 712, 501, "ControlCenter", true),
                lsof_row(3000, 1042, 501, "node", true),
                lsof_row(49152, 88, 0, "rapportd", false),
            ]
        );
    }

    #[tokio::test]
    async fn lsof_exiting_non_zero_with_nothing_listening_reads_as_no_ports_not_as_a_failed_poll() {
        let (_dir, lsof) = fake_lsof("#!/bin/sh\nexit 1\n");
        assert!(lsof_snapshot(&lsof).await.is_empty());
        assert!(lsof_snapshot(Path::new("/nonexistent/lsof")).await.is_empty());
    }

    #[tokio::test]
    async fn a_platform_with_no_road_reads_empty_rather_than_failing_the_pane() {
        assert!(empty_source()().await.is_empty());
        let root = fake_proc_root();
        assert_eq!(source_for(Some(root.path()))().await.len(), 2);
    }
}
