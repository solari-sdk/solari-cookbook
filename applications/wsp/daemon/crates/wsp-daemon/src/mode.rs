// SPDX-License-Identifier: AGPL-3.0-only
//! The slave termios and foreground process of each pty, polled only while a socket is attached: the app reads
//! whether the shell is at a prompt or inside a full-screen program. On Linux the probe runs stty on the slave
//! named by the shell's own stdin, since the daemon holds only the master.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::process::Command;
use wsp_frames::{DaemonEvent, PtyMode};

use crate::pty::work_argv;
use crate::{frame_text, Listener};

/// How long one stty run may take before the probe counts as failed.
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const DEFAULT_INTERVAL: Duration = Duration::from_millis(200);

pub(crate) struct ProbeResult {
    pub(crate) icanon: bool,
    pub(crate) echo: bool,
    pub(crate) foreground: String,
}

pub(crate) type ProbeFuture = Pin<Box<dyn Future<Output = Option<ProbeResult>> + Send>>;
/// Reads the slave termios and the foreground comm for a shell pid; nothing when any read fails.
pub(crate) type Probe = Arc<dyn Fn(u32) -> ProbeFuture + Send + Sync>;

/// Termios flags from `stty -a` output. Flags are exact tokens ("-icanon" against "icanon"); a substring match
/// would trip over echoe, echok and echoctl.
pub(crate) fn parse_stty_modes(text: &str) -> (bool, bool) {
    let mut icanon = false;
    let mut echo = false;
    for token in text.split(|c: char| c == ';' || c.is_whitespace()) {
        icanon |= token == "icanon";
        echo |= token == "echo";
    }
    (icanon, echo)
}

/// tpgid is field 8 of /proc/<pid>/stat, counted after the ")" that closes comm; comm itself may contain spaces
/// and parens, so the split starts there.
pub(crate) fn parse_stat_tpgid(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    let tpgid: u32 = stat[close + 1..].split_whitespace().nth(5)?.parse().ok()?;
    (tpgid > 0).then_some(tpgid)
}

async fn probe_linux(proc_root: PathBuf, pid: u32) -> Option<ProbeResult> {
    let me = proc_root.join(pid.to_string());
    let tty = tokio::fs::read_link(me.join("fd/0")).await.ok()?;
    let (file, args) = work_argv("stty", &["-a", "-F", &tty.to_string_lossy()]);
    let output = tokio::time::timeout(PROBE_TIMEOUT, Command::new(file).args(args).stdin(Stdio::null()).kill_on_drop(true).output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let (icanon, echo) = parse_stty_modes(&String::from_utf8_lossy(&output.stdout));
    let stat = tokio::fs::read_to_string(me.join("stat")).await.ok()?;
    let foreground = match parse_stat_tpgid(&stat) {
        Some(tpgid) => {
            tokio::fs::read_to_string(proc_root.join(tpgid.to_string()).join("comm")).await.unwrap_or_default().trim().to_owned()
        }
        None => String::new(),
    };
    Some(ProbeResult { icanon, echo, foreground })
}

pub(crate) fn linux_mode_probe(proc_root: &Path) -> Probe {
    let proc_root = proc_root.to_path_buf();
    Arc::new(move |pid| Box::pin(probe_linux(proc_root.clone(), pid)))
}

#[derive(Clone, PartialEq)]
struct State {
    mode: PtyMode,
    echo: bool,
    foreground: String,
}

struct Entry {
    pid: u32,
    listeners: Vec<Listener>,
    last: Option<State>,
    polling: bool,
}

/// Polls each pty's slave termios only while it has attached clients: the poll starts on the first attach, stops at
/// zero, and an idle pty is never probed. State is delivered to a newcomer on attach and broadcast on change.
pub(crate) struct ModeWatcher {
    probe: Probe,
    interval: Duration,
    entries: Mutex<HashMap<String, Entry>>,
}

fn event(pty_id: &str, state: &State) -> DaemonEvent {
    DaemonEvent::PtyMode { pty_id: pty_id.to_owned(), mode: state.mode, echo: state.echo, foreground: state.foreground.clone() }
}

impl ModeWatcher {
    pub(crate) fn new(probe: Probe, interval: Duration) -> ModeWatcher {
        ModeWatcher { probe, interval, entries: Mutex::new(HashMap::new()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn attach(self: &Arc<Self>, pty_id: &str, pid: u32, listener: Listener) {
        let mut entries = self.lock();
        let entry = entries.entry(pty_id.to_owned()).or_insert_with(|| Entry { pid, listeners: Vec::new(), last: None, polling: false });
        // Known state goes to the newcomer at once; the first probe's result reaches it as a change like everyone.
        if let Some(last) = &entry.last {
            listener.out.send_event(&event(pty_id, last));
        }
        entry.listeners.retain(|l| l.key != listener.key);
        entry.listeners.push(listener);
        if !entry.polling {
            entry.polling = true;
            tokio::spawn(Arc::clone(self).poll(pty_id.to_owned()));
        }
    }

    pub(crate) fn detach(&self, pty_id: &str, key: u64) {
        if let Some(entry) = self.lock().get_mut(pty_id) {
            entry.listeners.retain(|l| l.key != key);
        }
    }

    /// Drops a pty whose process is gone; attached sockets would otherwise keep probing a dead pid until they close.
    pub(crate) fn remove(&self, pty_id: &str) {
        self.lock().remove(pty_id);
    }

    async fn poll(self: Arc<Self>, pty_id: String) {
        loop {
            let pid = {
                let mut entries = self.lock();
                match entries.get_mut(&pty_id) {
                    None => return,
                    Some(entry) if entry.listeners.is_empty() => {
                        entry.polling = false;
                        return;
                    }
                    Some(entry) => entry.pid,
                }
            };
            let read = (self.probe)(pid).await;
            {
                let mut entries = self.lock();
                let Some(entry) = entries.get_mut(&pty_id) else { return };
                // Failure keeps the last known termios state; only the foreground is unreadable.
                let next = match read {
                    Some(r) => State { mode: if r.icanon { PtyMode::Line } else { PtyMode::Raw }, echo: r.echo, foreground: r.foreground },
                    None => State {
                        mode: entry.last.as_ref().map_or(PtyMode::Line, |l| l.mode),
                        echo: entry.last.as_ref().is_none_or(|l| l.echo),
                        foreground: String::new(),
                    },
                };
                if entry.last.as_ref() != Some(&next) {
                    let frame = frame_text(&event(&pty_id, &next));
                    entry.listeners.retain(|l| l.out.send_text(&frame));
                    entry.last = Some(next);
                }
            }
            tokio::time::sleep(self.interval).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Outbound;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;

    const LINE: (bool, bool, &str) = (true, true, "bash");
    const RAW: (bool, bool, &str) = (false, false, "vim");

    fn result((icanon, echo, foreground): (bool, bool, &str)) -> Option<ProbeResult> {
        Some(ProbeResult { icanon, echo, foreground: foreground.to_owned() })
    }

    fn counting(calls: Arc<AtomicUsize>, f: impl Fn() -> Option<ProbeResult> + Send + Sync + 'static) -> Probe {
        Arc::new(move |_pid| {
            calls.fetch_add(1, Ordering::SeqCst);
            let r = f();
            Box::pin(async move { r })
        })
    }

    fn client() -> (Listener, mpsc::UnboundedReceiver<crate::Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Listener { key: 1, out: Outbound(tx) }, rx)
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<crate::Outgoing>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(t) = rx.try_recv() {
            out.push(serde_json::from_str(t.text()).unwrap());
        }
        out
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    #[test]
    fn reads_icanon_and_echo_as_exact_tokens_not_substrings() {
        let raw = "speed 38400 baud; rows 24; columns 80; line = 0;\n-icanon -echo echoe echok echoctl echoke\n";
        assert_eq!(parse_stty_modes(raw), (false, false));
        assert_eq!(parse_stty_modes("speed 38400 baud;\nicanon echo echoe echok\n"), (true, true));
    }

    #[test]
    fn extracts_tpgid_from_stat_past_a_comm_with_spaces_and_parens() {
        assert_eq!(parse_stat_tpgid("123 (tmux: server) S 1 123 123 34816 4567 4194304 0 0 0 0"), Some(4567));
        assert_eq!(parse_stat_tpgid("garbage"), None);
    }

    #[tokio::test]
    async fn emits_the_current_state_to_a_client_on_attach() {
        let w = Arc::new(ModeWatcher::new(counting(Arc::default(), || result(RAW)), Duration::from_millis(10)));
        let (l, mut rx) = client();
        w.attach("p1", 42, l);
        settle().await;
        assert_eq!(drain(&mut rx), [json!({"type": "pty.mode", "ptyId": "p1", "mode": "raw", "echo": false, "foreground": "vim"})]);
    }

    #[tokio::test]
    async fn delivers_current_state_to_a_second_client_without_rebroadcasting_to_the_first() {
        let w = Arc::new(ModeWatcher::new(counting(Arc::default(), || result(LINE)), Duration::from_millis(10)));
        let (a, mut ra) = client();
        w.attach("p1", 42, a);
        settle().await;
        let (b, mut rb) = client();
        w.attach("p1", 42, b);
        settle().await;
        assert_eq!(drain(&mut ra).len(), 1);
        assert_eq!(drain(&mut rb), [json!({"type": "pty.mode", "ptyId": "p1", "mode": "line", "echo": true, "foreground": "bash"})]);
    }

    #[tokio::test]
    async fn emits_only_on_change_across_a_probe_sequence() {
        let seq = [LINE, LINE, RAW, RAW, LINE];
        let i = Arc::new(AtomicUsize::new(0));
        let at = Arc::clone(&i);
        let probe: Probe = Arc::new(move |_| {
            let n = at.fetch_add(1, Ordering::SeqCst).min(seq.len() - 1);
            Box::pin(async move { result(seq[n]) })
        });
        let w = Arc::new(ModeWatcher::new(probe, Duration::from_millis(10)));
        let (l, mut rx) = client();
        w.attach("p1", 42, l);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let seen: Vec<(String, bool, String)> = drain(&mut rx)
            .iter()
            .map(|e| (e["mode"].as_str().unwrap().to_owned(), e["echo"].as_bool().unwrap(), e["foreground"].as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(
            seen,
            [
                ("line".to_owned(), true, "bash".to_owned()),
                ("raw".to_owned(), false, "vim".to_owned()),
                ("line".to_owned(), true, "bash".to_owned())
            ]
        );
    }

    #[tokio::test]
    async fn never_probes_an_idle_pty_and_stops_polling_at_zero_attachments() {
        let calls = Arc::new(AtomicUsize::new(0));
        let w = Arc::new(ModeWatcher::new(counting(Arc::clone(&calls), || result(LINE)), Duration::from_millis(10)));
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let (l, _rx) = client();
        w.attach("p1", 42, l);
        settle().await;
        assert!(calls.load(Ordering::SeqCst) > 0);
        w.detach("p1", 1);
        settle().await;
        let at_detach = calls.load(Ordering::SeqCst);
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), at_detach);
    }

    #[tokio::test]
    async fn stops_probing_a_removed_pty_even_while_clients_stay_attached() {
        let calls = Arc::new(AtomicUsize::new(0));
        let w = Arc::new(ModeWatcher::new(counting(Arc::clone(&calls), || result(LINE)), Duration::from_millis(10)));
        let (l, _rx) = client();
        w.attach("p1", 42, l);
        settle().await;
        assert!(calls.load(Ordering::SeqCst) > 0);
        w.remove("p1");
        settle().await;
        let at_remove = calls.load(Ordering::SeqCst);
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), at_remove);
        // A late socket close after the pty died is nothing.
        w.detach("p1", 1);
    }

    #[tokio::test]
    async fn keeps_the_last_known_mode_and_blanks_foreground_on_probe_failure_silently() {
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failing = Arc::clone(&fail);
        let probe: Probe = Arc::new(move |_| {
            let r = if failing.load(Ordering::SeqCst) { None } else { result(RAW) };
            Box::pin(async move { r })
        });
        let w = Arc::new(ModeWatcher::new(probe, Duration::from_millis(10)));
        let (l, mut rx) = client();
        w.attach("p1", 42, l);
        settle().await;
        assert_eq!(drain(&mut rx).len(), 1);
        fail.store(true, Ordering::SeqCst);
        settle().await;
        assert_eq!(drain(&mut rx), [json!({"type": "pty.mode", "ptyId": "p1", "mode": "raw", "echo": false, "foreground": ""})]);
        // Repeated failures are not a change; the loop keeps ticking without emitting.
        settle().await;
        assert!(drain(&mut rx).is_empty());
        fail.store(false, Ordering::SeqCst);
        settle().await;
        assert_eq!(drain(&mut rx), [json!({"type": "pty.mode", "ptyId": "p1", "mode": "raw", "echo": false, "foreground": "vim"})]);
    }
}
