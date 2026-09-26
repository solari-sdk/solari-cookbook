// SPDX-License-Identifier: AGPL-3.0-only
//! Every process on the machine as proc.snapshot events. The sampler holds the clock, the subscribers and the last
//! scan; what a machine of one kind is read with is its own module behind ProcSource, registered in readings.rs.
//! The module here is the guest's: straight from /proc, one stat file per pid per tick, cmdline only when a pid is
//! new or exec'd, the uid from the pid directory's owner. One sampler per daemon; the first subscriber starts it
//! and the last one leaving stops it. Inspecting one pid is the only path that touches /proc/net.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;
use wsp_frames::{numbers, words, DaemonErrorCode, DaemonEvent, ProcEntry, ProcInspectReply, ProcSignal};

use crate::paths::OpError;
use crate::sys::{finite, read_named};
use crate::{frame_text, Outbound, SharedLog};

/// /proc reports times in USER_HZ ticks, 100 a second on every Linux.
const USER_HZ: f64 = 100.0;
const AT_PAGESZ: u64 = 6;
/// The listening state in /proc/net/tcp's st column.
const TCP_LISTEN: &str = "0A";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcStat {
    pub(crate) pid: u32,
    pub(crate) comm: String,
    pub(crate) state: String,
    pub(crate) ppid: u32,
    /// utime plus stime, in ticks.
    pub(crate) ticks: u64,
    pub(crate) threads: u32,
    /// Ticks after boot.
    pub(crate) starttime: u64,
    pub(crate) rss_pages: u64,
}

/// The comm sits in parens and may hold anything, so the split runs from the last one.
pub(crate) fn parse_proc_pid_stat(text: &str) -> Result<ProcStat, String> {
    let malformed = || "/proc/[pid]/stat is malformed".to_owned();
    let open = text.find('(').ok_or_else(malformed)?;
    let close = text.rfind(')').filter(|close| *close > open).ok_or_else(malformed)?;
    let pid: u32 = text[..open].trim().parse().map_err(|_| malformed())?;
    let f: Vec<&str> = text[close + 1..].split_whitespace().collect();
    let n = |i: usize| -> Result<u64, String> { f.get(i).and_then(|v| v.parse::<u64>().ok()).ok_or_else(malformed) };
    Ok(ProcStat {
        pid,
        comm: text[open + 1..close].to_owned(),
        state: f.first().map_or("?", |s| *s).to_owned(),
        ppid: u32::try_from(n(1)?).map_err(|_| malformed())?,
        ticks: n(11)? + n(12)?,
        threads: u32::try_from(n(17)?).map_err(|_| malformed())?,
        starttime: n(19)?,
        rss_pages: n(21)?,
    })
}

pub(crate) fn parse_btime(proc_stat: &str) -> Result<i64, String> {
    proc_stat
        .lines()
        .find_map(|l| l.strip_prefix("btime").filter(|rest| rest.starts_with(char::is_whitespace)))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| "/proc/stat has no btime".to_owned())
}

/// auxv is an array of (type, value) native words; AT_PAGESZ carries the page size.
pub(crate) fn parse_auxv_page_size(buf: &[u8]) -> Option<u64> {
    let word = |at: usize| u64::from_le_bytes(buf[at..at + 8].try_into().ok()?).into();
    let mut i = 0;
    while i + 16 <= buf.len() {
        let kind: Option<u64> = word(i);
        match kind {
            Some(0) => return None,
            Some(AT_PAGESZ) => return word(i + 8),
            _ => i += 16,
        }
    }
    None
}

pub(crate) fn parse_passwd_users(text: &str) -> HashMap<u32, String> {
    let mut users = HashMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() >= 3 && !f[0].is_empty() {
            if let Ok(uid) = f[2].parse::<u32>() {
                users.insert(uid, f[0].to_owned());
            }
        }
    }
    users
}

/// The listening rows of one /proc/net/tcp text as (port, inode). The ports module carries the whole row; the
/// inspect here needs the two columns that tie a socket inode to its port.
pub(crate) fn listening_rows(text: &str) -> Vec<(u16, u64)> {
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 || f[3] != TCP_LISTEN {
            continue;
        }
        let port = f[1].rsplit(':').next().and_then(|hex| u16::from_str_radix(hex, 16).ok());
        let inode = f[9].parse::<u64>().ok();
        if let (Some(port), Some(inode)) = (port, inode) {
            rows.push((port, inode));
        }
    }
    rows
}

/// The TCP ports one pid listens on: its socket inodes out of its fd table against the listening rows of both
/// address families, sorted, each once.
pub(crate) fn listening_ports_of(proc_root: &Path, pid: u32) -> Vec<u16> {
    let dir = proc_root.join(pid.to_string());
    let mut inodes = HashSet::new();
    if let Ok(fds) = std::fs::read_dir(dir.join("fd")) {
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            let target = target.to_string_lossy();
            if let Some(inode) = target.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')).and_then(|s| s.parse::<u64>().ok()) {
                inodes.insert(inode);
            }
        }
    }
    let mut ports = Vec::new();
    for file in ["tcp", "tcp6"] {
        let text = std::fs::read_to_string(proc_root.join("net").join(file)).unwrap_or_default();
        ports.extend(listening_rows(&text).into_iter().filter(|(_, inode)| inodes.contains(inode)).map(|(port, _)| port));
    }
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// What one scan read: every process the module shows, and how many there are before the cap.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProcScan {
    pub(crate) total: u64,
    pub(crate) procs: Vec<ProcEntry>,
}

pub(crate) struct ProcScanInput {
    /// The clock this scan is stamped with, epoch milliseconds.
    pub(crate) at: i64,
    /// Wall milliseconds since the last scan, 0 on the first, where a cpu delta has nothing to run from.
    pub(crate) elapsed_ms: i64,
    /// The daemon pty a pid's shell belongs to, for the rows that carry one.
    pub(crate) pty: HashMap<u32, String>,
}

/// One kind's road to the processes on its machine, and to one of them in depth, run off the runtime thread. A
/// machine wsp forks reads its own /proc (ProcFsSource); this computer reads its own host with ps. Adding a kind is
/// its module and the row in readings.rs, nothing here.
pub(crate) trait ProcSource: Send + Sync {
    fn scan(&self, input: &ProcScanInput) -> Result<ProcScan, String>;
    /// One process in depth. `procs` is the newest scan, which is where the children column comes from.
    fn inspect(&self, pid: u32, procs: &[ProcEntry]) -> Result<ProcInspectReply, OpError>;
}

pub(crate) fn no_process(pid: u32) -> OpError {
    OpError::coded(DaemonErrorCode::NotFound, format!("no process {pid}"))
}

pub(crate) fn children_of(pid: u32, procs: &[ProcEntry]) -> Vec<u32> {
    procs.iter().filter(|p| p.ppid == pid).map(|p| p.pid).collect()
}

struct Known {
    starttime: u64,
    comm: String,
    ticks: u64,
    cmdline: String,
    user: String,
}

#[derive(Default)]
struct FsState {
    /// Per pid across scans: the ticks the cpu delta runs from, and what is only re-read after an exec.
    known: HashMap<u32, Known>,
    btime: Option<i64>,
    page_size: u64,
    users: HashMap<u32, String>,
}

/// The guest's own processes, read straight from /proc: the module every machine wsp forks is served by.
pub(crate) struct ProcFsSource {
    proc_root: PathBuf,
    passwd_path: PathBuf,
    cap: usize,
    state: Mutex<FsState>,
}

impl ProcFsSource {
    pub(crate) fn new(proc_root: PathBuf, passwd_path: PathBuf, cap: usize) -> ProcFsSource {
        ProcFsSource { proc_root, passwd_path, cap, state: Mutex::new(FsState::default()) }
    }

    fn prime(&self, state: &mut FsState) -> Result<(), String> {
        state.btime = Some(parse_btime(&read_named(&self.proc_root.join("stat"))?)?);
        let auxv = std::fs::read(self.proc_root.join("self/auxv")).unwrap_or_default();
        state.page_size = parse_auxv_page_size(&auxv).filter(|n| *n > 0).unwrap_or(4096);
        state.users = parse_passwd_users(&std::fs::read_to_string(&self.passwd_path).unwrap_or_default());
        Ok(())
    }

    fn read_one(&self, state: &mut FsState, pid: u32, elapsed_ticks: f64, pty: Option<&String>) -> Option<ProcEntry> {
        let dir = self.proc_root.join(pid.to_string());
        let st = parse_proc_pid_stat(&std::fs::read_to_string(dir.join("stat")).ok()?).ok()?;
        let mut cpu = 0.0;
        let same_image = state.known.get(&pid).is_some_and(|k| k.starttime == st.starttime && k.comm == st.comm);
        if let Some(k) = state.known.get(&pid) {
            if k.starttime == st.starttime && elapsed_ticks > 0.0 {
                cpu = finite((st.ticks as f64 - k.ticks as f64) / elapsed_ticks * 100.0).max(0.0);
            }
        }
        if same_image {
            if let Some(k) = state.known.get_mut(&pid) {
                k.ticks = st.ticks;
            }
        } else {
            // A new pid, or the same pid after an exec (the comm moved): the image changed, so cmdline and owner are read again.
            let uid = std::fs::metadata(&dir).ok().map(|m| m.uid());
            let user = uid.and_then(|uid| state.users.get(&uid).cloned()).unwrap_or_else(|| uid.map_or("-1".to_owned(), |u| u.to_string()));
            let cmdline = read_cmdline(&dir);
            state.known.insert(pid, Known { starttime: st.starttime, comm: st.comm.clone(), ticks: st.ticks, cmdline, user });
        }
        let k = state.known.get(&pid)?;
        Some(ProcEntry {
            pid,
            ppid: st.ppid,
            user: k.user.clone(),
            state: st.state,
            comm: st.comm,
            cmdline: k.cmdline.clone(),
            cpu,
            rss: st.rss_pages * state.page_size,
            started_at: state.btime.unwrap_or(0) * 1000 + st.starttime as i64 * numbers::STAT_TICK_MS as i64,
            pty: pty.cloned(),
        })
    }
}

/// The first CMDLINE_BYTES only, the NULs as spaces; nothing for a pid whose cmdline cannot be read.
fn read_cmdline(dir: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(dir.join("cmdline")) else { return String::new() };
    let mut buf = [0u8; numbers::CMDLINE_BYTES];
    let mut end = 0;
    while end < buf.len() {
        match file.read(&mut buf[end..]) {
            Ok(0) => break,
            Ok(n) => end += n,
            Err(_) => return String::new(),
        }
    }
    while end > 0 && buf[end - 1] == 0 {
        end -= 1;
    }
    String::from_utf8_lossy(&buf[..end]).replace('\0', " ")
}

impl ProcSource for ProcFsSource {
    /// Reads every pid once; cpu is the tick delta against the last scan over the wall time between them.
    fn scan(&self, input: &ProcScanInput) -> Result<ProcScan, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.btime.is_none() {
            self.prime(&mut state)?;
        }
        let elapsed_ticks = input.elapsed_ms as f64 / 1000.0 * USER_HZ;
        let listed = std::fs::read_dir(&self.proc_root).map_err(|e| format!("{}: {e}", self.proc_root.display()))?;
        let mut pids: Vec<u32> = listed.flatten().filter_map(|d| d.file_name().to_str().and_then(|n| n.parse().ok())).collect();
        pids.sort_unstable();
        let mut procs = Vec::new();
        let mut seen = HashSet::new();
        for pid in pids.iter().take(self.cap) {
            if let Some(entry) = self.read_one(&mut state, *pid, elapsed_ticks, input.pty.get(pid)) {
                seen.insert(*pid);
                procs.push(entry);
            }
        }
        state.known.retain(|pid, _| seen.contains(pid));
        Ok(ProcScan { total: pids.len() as u64, procs })
    }

    fn inspect(&self, pid: u32, procs: &[ProcEntry]) -> Result<ProcInspectReply, OpError> {
        let dir = self.proc_root.join(pid.to_string());
        let st =
            std::fs::read_to_string(dir.join("stat")).ok().and_then(|t| parse_proc_pid_stat(&t).ok()).ok_or_else(|| no_process(pid))?;
        let cwd = std::fs::read_link(dir.join("cwd")).ok().map(|p| p.to_string_lossy().into_owned());
        Ok(ProcInspectReply {
            pid,
            cwd,
            ports: listening_ports_of(&self.proc_root, pid),
            threads: Some(st.threads),
            children: children_of(pid, procs),
        })
    }
}

/// The daemon's live ptys as (shell pid, pty id), rebuilt per scan: an exited pty's pid can be reused by a stranger.
pub(crate) type PtyPids = Arc<dyn Fn() -> Vec<(u32, String)> + Send + Sync>;
pub(crate) type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub(crate) struct ProcSamplerOptions {
    /// The daemon's own pid, named in every snapshot.
    pub(crate) self_pid: u32,
    pub(crate) ptys: PtyPids,
    pub(crate) interval: Duration,
    pub(crate) now: Clock,
    pub(crate) log: SharedLog,
}

#[derive(Default)]
struct Inner {
    subscribers: HashMap<u64, Outbound>,
    running: Option<AbortHandle>,
    last_at: Option<i64>,
    last_procs: Vec<ProcEntry>,
    /// What the last tick said, so a watch that arrives mid-stream inherits it; None until one has finished.
    last: Option<Result<(), String>>,
}

pub(crate) struct ProcSampler {
    source: Arc<dyn ProcSource>,
    opts: ProcSamplerOptions,
    inner: Mutex<Inner>,
}

impl ProcSampler {
    pub(crate) fn new(source: Arc<dyn ProcSource>, opts: ProcSamplerOptions) -> Arc<ProcSampler> {
        let opts = ProcSamplerOptions { interval: crate::sys::tick_of(opts.interval), ..opts };
        Arc::new(ProcSampler { source, opts, inner: Mutex::new(Inner::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn running(&self) -> bool {
        self.lock().running.is_some()
    }

    pub(crate) fn subscribe(self: &Arc<Self>, key: u64, out: Outbound) {
        let mut inner = self.lock();
        inner.subscribers.insert(key, out);
        if inner.subscribers.len() == 1 {
            self.start(&mut inner);
        }
    }

    pub(crate) fn unsubscribe(&self, key: u64) {
        let mut inner = self.lock();
        if inner.subscribers.remove(&key).is_some() && inner.subscribers.is_empty() {
            self.stop(&mut inner);
        }
    }

    /// One scan before a watch is taken, so a module that cannot read this machine refuses the op instead of leaving
    /// the pane at pending for a stream that never comes. Its reading is thrown away: cpu is a delta, so the first
    /// snapshot still lands one interval after the reply. A sampler already polling scans every interval anyway, so a
    /// second watcher inherits what the last tick said rather than paying for a scan of its own, which would also run
    /// beside that tick and leave the module's per pid state read from two clocks.
    pub(crate) async fn probe(&self) -> Result<(), OpError> {
        let inherited = {
            let inner = self.lock();
            if inner.running.is_some() {
                inner.last.clone()
            } else {
                None
            }
        };
        match inherited {
            Some(said) => said.map_err(OpError::plain),
            None => self.scan(0, (self.opts.now)()).await.map(|_| ()).map_err(OpError::plain),
        }
    }

    async fn scan(&self, elapsed_ms: i64, at: i64) -> Result<ProcScan, String> {
        let source = Arc::clone(&self.source);
        let pty: HashMap<u32, String> = (self.opts.ptys)().into_iter().collect();
        tokio::task::spawn_blocking(move || source.scan(&ProcScanInput { at, elapsed_ms, pty }))
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
    }

    /// The first poll after a start is the cpu baseline and emits nothing; a failed read of one pid drops that pid for the tick.
    pub(crate) async fn poll(&self) {
        let at = (self.opts.now)();
        let elapsed = self.lock().last_at.map_or(0, |last| at - last);
        let scanned = self.scan(elapsed, at).await;
        let mut inner = self.lock();
        let scan = match scanned {
            Ok(scan) => scan,
            Err(e) => {
                inner.last = Some(Err(e));
                return;
            }
        };
        inner.last = Some(Ok(()));
        let first = inner.last_at.is_none();
        inner.last_at = Some(at);
        inner.last_procs.clone_from(&scan.procs);
        if first {
            return;
        }
        let snapshot = DaemonEvent::ProcSnapshot { at, daemon: self.opts.self_pid, total: scan.total, procs: scan.procs };
        let text = frame_text(&snapshot);
        for out in inner.subscribers.values() {
            out.send_text(&text);
        }
    }

    pub(crate) async fn inspect(&self, pid: u32) -> Result<ProcInspectReply, OpError> {
        let held = {
            let inner = self.lock();
            inner.last_at.map(|_| inner.last_procs.clone())
        };
        let procs = match held {
            Some(procs) => procs,
            None => self.scan(0, (self.opts.now)()).await.map_err(OpError::plain)?.procs,
        };
        let source = Arc::clone(&self.source);
        tokio::task::spawn_blocking(move || source.inspect(pid, &procs)).await.unwrap_or_else(|e| Err(OpError::plain(e.to_string())))
    }

    fn start(self: &Arc<Self>, inner: &mut Inner) {
        if inner.running.is_some() {
            return;
        }
        inner.last_at = None;
        let me = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(me.opts.interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                me.poll().await;
            }
        });
        inner.running = Some(task.abort_handle());
        (self.opts.log)(words::PROC_SAMPLER_STARTED);
    }

    fn stop(&self, inner: &mut Inner) {
        if let Some(task) = inner.running.take() {
            task.abort();
            (self.opts.log)(words::PROC_SAMPLER_STOPPED);
        }
        inner.last_at = None;
        inner.last = None;
    }
}

/// init, the daemon and whatever started the daemon: never signalled, the workspace would go with them.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProtectedPids {
    pub(crate) this: u32,
    pub(crate) parent: u32,
}

/// Signals one process.
pub(crate) fn kill_process(pid: u32, signal: ProcSignal, protected: ProtectedPids) -> Result<(), OpError> {
    if pid == 1 || pid == protected.this || pid == protected.parent {
        return Err(OpError::coded(
            DaemonErrorCode::Forbidden,
            format!("refusing to signal pid {pid}: it is init, the daemon or the daemon's parent"),
        ));
    }
    let signal = match signal {
        ProcSignal::Kill => Signal::SIGKILL,
        ProcSignal::Term => Signal::SIGTERM,
    };
    match kill(Pid::from_raw(pid as i32), signal) {
        Ok(()) => Ok(()),
        Err(nix::errno::Errno::ESRCH) => Err(no_process(pid)),
        Err(nix::errno::Errno::EPERM) => Err(OpError::coded(DaemonErrorCode::Forbidden, format!("no permission to signal pid {pid}"))),
        Err(e) => Err(OpError::plain(e.to_string())),
    }
}

#[cfg(test)]
#[path = "../tests/fake_proc/mod.rs"]
pub(crate) mod fake_proc;

#[cfg(test)]
mod tests {
    use super::fake_proc::{auxv, fake_passwd, fake_proc_tree, write_proc, FakeProc, BTIME};
    use super::*;
    use crate::sys::now_ms;
    use crate::Outgoing;
    use serde_json::{json, Value};
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::sync::mpsc;

    #[test]
    fn reads_proc_pid_stat_around_a_comm_that_holds_spaces_and_parens() {
        let zeros = vec!["0"; 28].join(" ");
        let st = parse_proc_pid_stat(&format!(
            "42 (my (odd) proc) R 7 42 42 0 -1 4194560 10 0 0 0 150 50 0 0 20 0 3 0 12345 1000000 256 {zeros}\n"
        ))
        .unwrap();
        assert_eq!(
            st,
            ProcStat {
                pid: 42,
                comm: "my (odd) proc".into(),
                state: "R".into(),
                ppid: 7,
                ticks: 200,
                threads: 3,
                starttime: 12345,
                rss_pages: 256
            }
        );
    }

    #[test]
    fn rejects_a_stat_line_without_the_comm_parens() {
        assert!(parse_proc_pid_stat("42 broken\n").is_err());
        assert!(parse_proc_pid_stat("42 (short) R 7\n").is_err());
    }

    #[test]
    fn btime_the_page_size_from_auxv_and_users_from_passwd() {
        assert_eq!(parse_btime(&format!("cpu 1 2 3\nbtime {BTIME}\n")).unwrap(), BTIME);
        assert!(parse_btime("cpu 1 2 3\n").is_err());
        assert_eq!(parse_auxv_page_size(&auxv(16384)), Some(16384));
        assert_eq!(parse_auxv_page_size(&[0u8; 16]), None);
        let users = parse_passwd_users("root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534::/:/bin/false\nbad line\n");
        assert_eq!(users, HashMap::from([(0, "root".to_owned()), (65534, "nobody".to_owned())]));
    }

    #[test]
    fn listening_rows_keep_the_listen_state_only() {
        let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/proc-net-tcp.txt")).unwrap();
        assert_eq!(listening_rows(&text), vec![(8080, 45678), (3000, 45700)]);
        assert_eq!(listening_rows(""), vec![]);
    }

    fn quiet() -> SharedLog {
        Arc::new(|_| {})
    }

    struct Clock(Mutex<i64>);

    struct Bench {
        sampler: Arc<ProcSampler>,
        rx: mpsc::UnboundedReceiver<Outgoing>,
        root: tempfile::TempDir,
        _passwd: tempfile::TempDir,
        clock: Arc<Clock>,
    }

    impl Bench {
        fn got(&mut self) -> Vec<Value> {
            let mut out = Vec::new();
            while let Ok(text) = self.rx.try_recv() {
                let v: Value = serde_json::from_str(text.text()).unwrap();
                assert!(serde_json::from_value::<DaemonEvent>(v.clone()).is_ok(), "the protocol parses {v}");
                out.push(v);
            }
            out
        }

        fn advance(&self, ms: i64) {
            *self.clock.0.lock().unwrap() += ms;
        }
    }

    fn sampler(procs: &[FakeProc], ptys: Vec<(u32, String)>, cap: Option<usize>, page_size: u64) -> Bench {
        let root = fake_proc_tree(procs, page_size);
        let (passwd_dir, passwd) = fake_passwd();
        let clock = Arc::new(Clock(Mutex::new(1_000_000)));
        let now = Arc::clone(&clock);
        let source = Arc::new(ProcFsSource::new(root.path().to_path_buf(), passwd, cap.unwrap_or(numbers::PROC_CAP)));
        let sampler = ProcSampler::new(
            source,
            ProcSamplerOptions {
                self_pid: 4242,
                ptys: Arc::new(move || ptys.clone()),
                interval: Duration::from_secs(60),
                now: Arc::new(move || *now.0.lock().unwrap()),
                log: quiet(),
            },
        );
        let (tx, rx) = mpsc::unbounded_channel();
        sampler.lock().subscribers.insert(1, Outbound(tx));
        Bench { sampler, rx, root, _passwd: passwd_dir, clock }
    }

    struct Fake {
        scans: AtomicUsize,
        broken: AtomicBool,
    }

    impl ProcSource for Fake {
        fn scan(&self, _: &ProcScanInput) -> Result<ProcScan, String> {
            self.scans.fetch_add(1, Ordering::SeqCst);
            if self.broken.load(Ordering::SeqCst) {
                return Err("this machine cannot be read".to_owned());
            }
            Ok(ProcScan { total: 0, procs: vec![] })
        }
        fn inspect(&self, pid: u32, _: &[ProcEntry]) -> Result<ProcInspectReply, OpError> {
            Ok(ProcInspectReply { pid, cwd: None, ports: vec![], threads: None, children: vec![] })
        }
    }

    #[tokio::test]
    async fn a_probe_scans_once_for_the_first_watcher_and_rides_the_running_stream_for_the_next_refusal_and_all() {
        let source = Arc::new(Fake { scans: AtomicUsize::new(0), broken: AtomicBool::new(false) });
        let scans = || source.scans.load(Ordering::SeqCst);
        let opts = ProcSamplerOptions {
            self_pid: 1,
            ptys: Arc::new(Vec::new),
            interval: Duration::from_secs(60),
            now: Arc::new(now_ms),
            log: quiet(),
        };
        let s = ProcSampler::new(source.clone(), opts);
        s.probe().await.unwrap();
        assert_eq!(scans(), 1);
        let (tx, _rx) = mpsc::unbounded_channel();
        s.subscribe(1, Outbound(tx));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(scans(), 2);
        // Already polling, so the next watcher inherits that tick rather than scanning beside it.
        s.probe().await.unwrap();
        assert_eq!(scans(), 2);
        source.broken.store(true, Ordering::SeqCst);
        s.poll().await;
        assert_eq!(s.probe().await.unwrap_err().message, "this machine cannot be read");
        assert_eq!(scans(), 3);
        s.unsubscribe(1);
        source.broken.store(false, Ordering::SeqCst);
        s.probe().await.unwrap();
        assert_eq!(scans(), 4);
    }

    #[tokio::test]
    async fn a_zero_interval_reads_as_the_shortest_tick_and_never_ends_the_daemon() {
        let source = Arc::new(Fake { scans: AtomicUsize::new(0), broken: AtomicBool::new(false) });
        let opts =
            ProcSamplerOptions { self_pid: 1, ptys: Arc::new(Vec::new), interval: Duration::ZERO, now: Arc::new(now_ms), log: quiet() };
        let s = ProcSampler::new(source.clone(), opts);
        let (tx, mut rx) = mpsc::unbounded_channel();
        s.subscribe(1, Outbound(tx));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(s.running());
        assert!(source.scans.load(Ordering::SeqCst) >= 2);
        assert!(rx.try_recv().is_ok());
        s.unsubscribe(1);
    }

    #[tokio::test]
    async fn emits_nothing_on_the_first_poll_and_a_snapshot_of_every_process_with_cpu_over_the_interval_on_the_next() {
        let mut b = sampler(
            &[
                FakeProc {
                    pid: 1,
                    comm: Some("init".into()),
                    cmdline: Some(vec!["/sbin/init".into(), "splash".into()]),
                    starttime: Some(100),
                    rss: Some(300),
                    ..FakeProc::default()
                },
                FakeProc {
                    pid: 4242,
                    ppid: Some(1),
                    comm: Some("node".into()),
                    cmdline: Some(vec!["node".into(), "/opt/wsp/daemon.js".into()]),
                    ticks: Some((100, 50)),
                    starttime: Some(500),
                    rss: Some(12_000),
                    ..FakeProc::default()
                },
                FakeProc {
                    pid: 77,
                    ppid: Some(4242),
                    comm: Some("bash".into()),
                    cmdline: Some(vec!["bash".into(), "-l".into()]),
                    state: Some("R".into()),
                    threads: Some(2),
                    ..FakeProc::default()
                },
                FakeProc { pid: 2, comm: Some("kthreadd".into()), cmdline: Some(vec![]), ..FakeProc::default() },
            ],
            vec![(77, "pty_1".to_owned())],
            None,
            4096,
        );
        b.sampler.poll().await;
        assert!(b.got().is_empty());
        // Two seconds later the daemon used 100 more ticks: one core's worth at 100 ticks a second is 50 percent.
        write_proc(
            b.root.path(),
            &FakeProc {
                pid: 4242,
                ppid: Some(1),
                comm: Some("node".into()),
                cmdline: Some(vec!["node".into(), "/opt/wsp/daemon.js".into()]),
                ticks: Some((180, 70)),
                starttime: Some(500),
                rss: Some(12_500),
                ..FakeProc::default()
            },
        );
        b.advance(2_000);
        b.sampler.poll().await;
        let got = b.got();
        assert_eq!(got.len(), 1);
        let snap = &got[0];
        assert_eq!(
            (&snap["type"], &snap["at"], &snap["daemon"], &snap["total"]),
            (&json!("proc.snapshot"), &json!(1_002_000), &json!(4242), &json!(4))
        );
        let procs = snap["procs"].as_array().unwrap();
        assert_eq!(procs.iter().map(|p| p["pid"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 77, 4242]);
        let by_pid = |pid: u64| procs.iter().find(|p| p["pid"] == json!(pid)).unwrap().clone();
        assert_eq!(
            by_pid(4242),
            json!({"pid": 4242, "ppid": 1, "user": "tester", "state": "S", "comm": "node", "cmdline": "node /opt/wsp/daemon.js", "cpu": 50.0, "rss": 12_500 * 4096, "startedAt": (BTIME + 5) * 1000})
        );
        let p77 = by_pid(77);
        assert_eq!(
            (&p77["ppid"], &p77["state"], &p77["cmdline"], &p77["cpu"], &p77["pty"]),
            (&json!(4242), &json!("R"), &json!("bash -l"), &json!(0.0), &json!("pty_1"))
        );
        assert_eq!((&by_pid(2)["comm"], &by_pid(2)["cmdline"]), (&json!("kthreadd"), &json!("")));
        assert_eq!(
            (&by_pid(1)["cmdline"], &by_pid(1)["startedAt"], &by_pid(1)["rss"]),
            (&json!("/sbin/init splash"), &json!((BTIME + 1) * 1000), &json!(300 * 4096))
        );
        assert!(by_pid(1).get("pty").is_none());
    }

    #[tokio::test]
    async fn caps_cmdline_at_200_bytes_reads_it_again_only_after_an_exec_changed_the_comm_and_takes_the_page_size_from_auxv() {
        let long = "x".repeat(500);
        let mut b = sampler(
            &[FakeProc { pid: 9, comm: Some("sh".into()), cmdline: Some(vec!["sh".into(), "-c".into(), long]), ..FakeProc::default() }],
            vec![],
            None,
            16384,
        );
        b.sampler.poll().await;
        b.advance(2_000);
        b.sampler.poll().await;
        let first = b.got().remove(0);
        assert_eq!(first["procs"][0]["cmdline"].as_str().unwrap().len(), 200);
        assert!(first["procs"][0]["cmdline"].as_str().unwrap().starts_with("sh -c xxx"));
        assert_eq!(first["procs"][0]["rss"], json!(10 * 16384));
        // The same pid, comm and start time: the cached cmdline stands even though the file changed underneath.
        std::fs::write(b.root.path().join("9/cmdline"), b"ignored\0").unwrap();
        b.advance(2_000);
        b.sampler.poll().await;
        assert!(b.got().remove(0)["procs"][0]["cmdline"].as_str().unwrap().starts_with("sh -c"));
        // An exec changes the comm; the cmdline is read afresh.
        write_proc(
            b.root.path(),
            &FakeProc { pid: 9, comm: Some("node".into()), cmdline: Some(vec!["node".into(), "app.js".into()]), ..FakeProc::default() },
        );
        b.advance(2_000);
        b.sampler.poll().await;
        let third = b.got().remove(0);
        assert_eq!((&third["procs"][0]["comm"], &third["procs"][0]["cmdline"]), (&json!("node"), &json!("node app.js")));
    }

    #[tokio::test]
    async fn drops_a_process_that_went_away_reads_a_new_one_with_cpu_0_and_never_counts_a_returned_pid_against_the_old_ticks() {
        let mut b = sampler(
            &[
                FakeProc { pid: 5, ticks: Some((100, 0)), starttime: Some(10), ..FakeProc::default() },
                FakeProc { pid: 6, ticks: Some((0, 0)), ..FakeProc::default() },
            ],
            vec![],
            None,
            4096,
        );
        b.sampler.poll().await;
        std::fs::remove_dir_all(b.root.path().join("6")).unwrap();
        write_proc(b.root.path(), &FakeProc { pid: 7, ticks: Some((900, 900)), ..FakeProc::default() });
        write_proc(b.root.path(), &FakeProc { pid: 5, ticks: Some((10, 0)), starttime: Some(900), ..FakeProc::default() });
        b.advance(2_000);
        b.sampler.poll().await;
        let snap = b.got().remove(0);
        let rows: Vec<(u64, f64)> =
            snap["procs"].as_array().unwrap().iter().map(|p| (p["pid"].as_u64().unwrap(), p["cpu"].as_f64().unwrap())).collect();
        assert_eq!(rows, vec![(5, 0.0), (7, 0.0)]);
    }

    #[tokio::test]
    async fn stops_at_the_cap_and_says_how_many_there_were() {
        let procs: Vec<FakeProc> = (1..=12).map(|pid| FakeProc { pid, ..FakeProc::default() }).collect();
        let mut b = sampler(&procs, vec![], Some(5), 4096);
        b.sampler.poll().await;
        b.advance(2_000);
        b.sampler.poll().await;
        let snap = b.got().remove(0);
        assert_eq!(snap["total"], json!(12));
        assert_eq!(snap["procs"].as_array().unwrap().iter().map(|p| p["pid"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
    }

    #[tokio::test]
    async fn runs_from_the_first_subscriber_to_the_last_and_reads_nothing_in_between_polls() {
        let b = sampler(&[FakeProc { pid: 1, ..FakeProc::default() }], vec![], None, 4096);
        b.sampler.lock().subscribers.clear();
        let (tx, _rx) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        assert!(!b.sampler.running());
        b.sampler.subscribe(1, Outbound(tx));
        assert!(b.sampler.running());
        b.sampler.subscribe(2, Outbound(tx2));
        b.sampler.unsubscribe(1);
        b.sampler.unsubscribe(1);
        assert!(b.sampler.running());
        b.sampler.unsubscribe(2);
        assert!(!b.sampler.running());
    }

    #[tokio::test]
    async fn inspect_reads_cwd_listening_ports_by_socket_inode_threads_and_children_for_one_pid() {
        let b = sampler(
            &[
                FakeProc { pid: 1, comm: Some("init".into()), ..FakeProc::default() },
                FakeProc {
                    pid: 30,
                    ppid: Some(1),
                    comm: Some("node".into()),
                    threads: Some(7),
                    cwd: Some("/root/app".into()),
                    socket_inodes: Some(vec![111_111, 222_222]),
                    ..FakeProc::default()
                },
                FakeProc { pid: 31, ppid: Some(30), comm: Some("sh".into()), ..FakeProc::default() },
                FakeProc { pid: 32, ppid: Some(30), comm: Some("sh".into()), ..FakeProc::default() },
                FakeProc { pid: 40, ppid: Some(1), comm: Some("nginx".into()), socket_inodes: Some(vec![333_333]), ..FakeProc::default() },
            ],
            vec![],
            None,
            4096,
        );
        std::fs::write(
            b.root.path().join("net/tcp"),
            [
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
                "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111111 1 0000000000000000 100 0 0 10 0",
                "   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333333 1 0000000000000000 100 0 0 10 0",
                "   2: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 222222 1 0000000000000000 100 0 0 10 0",
                "",
            ]
            .join("\n"),
        )
        .unwrap();
        b.sampler.poll().await;
        b.advance(2_000);
        b.sampler.poll().await;
        assert_eq!(
            b.sampler.inspect(30).await.unwrap(),
            ProcInspectReply { pid: 30, cwd: Some("/root/app".into()), ports: vec![8080], threads: Some(7), children: vec![31, 32] }
        );
        assert_eq!(
            b.sampler.inspect(40).await.unwrap(),
            ProcInspectReply { pid: 40, cwd: None, ports: vec![3000], threads: Some(1), children: vec![] }
        );
        assert_eq!(b.sampler.inspect(999).await.unwrap_err().code, Some(DaemonErrorCode::NotFound));
    }

    #[tokio::test]
    async fn inspect_without_a_running_watch_scans_once_for_the_children() {
        let b = sampler(
            &[FakeProc { pid: 1, ..FakeProc::default() }, FakeProc { pid: 2, ppid: Some(1), ..FakeProc::default() }],
            vec![],
            None,
            4096,
        );
        assert_eq!(b.sampler.inspect(1).await.unwrap().children, vec![2]);
    }

    const PROTECTED: ProtectedPids = ProtectedPids { this: 5000, parent: 4000 };

    #[test]
    fn refuses_init_the_daemon_and_the_daemons_parent_with_code_forbidden() {
        for pid in [1, 5000, 4000] {
            assert_eq!(kill_process(pid, ProcSignal::Term, PROTECTED).unwrap_err().code, Some(DaemonErrorCode::Forbidden));
        }
    }

    #[test]
    fn a_pid_that_is_gone_answers_not_found() {
        // 2^22 - 1 is above every Linux pid_max default and no macOS pid.
        let err = kill_process(4_194_303, ProcSignal::Term, PROTECTED).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NotFound), "no process 4194303"));
    }

    /// Waits for one line on a child's stdout; a child that ends first fails the wait by name.
    async fn line(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>, want: &str) {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap();
            match next {
                Some(l) if l == want => return,
                Some(_) => continue,
                None => panic!("the child ended without printing {want}"),
            }
        }
    }

    #[tokio::test]
    async fn sends_term_then_kill_to_a_child_this_test_started() {
        let mut child =
            tokio::process::Command::new("sleep").arg("30").stdin(Stdio::null()).stdout(Stdio::null()).kill_on_drop(true).spawn().unwrap();
        kill_process(child.id().unwrap(), ProcSignal::Term, PROTECTED).unwrap();
        let status = child.wait().await.unwrap();
        assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(15));

        // One process that ignores TERM, so nothing is left behind when KILL takes it. It speaks once its handlers are
        // in place, again when the TERM lands and again when asked: the case waits for those lines, since kill_process
        // sends one signal and returns and there is no grace anywhere in the kill road to read.
        let script = "trap 'echo termed' TERM; trap 'echo alive' USR1; echo ready; while :; do sleep 0.05; done";
        let mut stubborn = tokio::process::Command::new("bash")
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = stubborn.id().unwrap();
        let mut lines = BufReader::new(stubborn.stdout.take().unwrap()).lines();
        line(&mut lines, "ready").await;
        kill_process(pid, ProcSignal::Term, PROTECTED).unwrap();
        line(&mut lines, "termed").await;
        // A process that exited but has not been reaped answers signal 0 too, so the child is also asked to speak again.
        kill(Pid::from_raw(pid as i32), Signal::SIGUSR1).unwrap();
        line(&mut lines, "alive").await;
        assert!(stubborn.try_wait().unwrap().is_none());
        kill_process(pid, ProcSignal::Kill, PROTECTED).unwrap();
        let status = stubborn.wait().await.unwrap();
        assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(9));
    }
}
