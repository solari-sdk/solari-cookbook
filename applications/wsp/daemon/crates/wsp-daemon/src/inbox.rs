// SPDX-License-Identifier: AGPL-3.0-only
//! The inbox: files the host drops for the machine, announced once each has stopped growing. The platform's file
//! notifications only speed up noticing a file; the sweep on the poll interval is the guarantee, since inotify can
//! overflow and FSEvents has a startup window.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tokio::sync::mpsc;
use wsp_frames::DaemonEvent;

use crate::{Ctx, Listener};

pub(crate) const DEFAULT_QUIET: Duration = Duration::from_millis(2000);
pub(crate) const DEFAULT_POLL: Duration = Duration::from_millis(250);

struct Pending {
    size: Option<u64>,
    stable_since: Instant,
}

/// What the watcher knows between sweeps.
pub(crate) struct InboxWatcher {
    dir: PathBuf,
    quiet: Duration,
    pending: HashMap<PathBuf, Pending>,
    seen: HashSet<PathBuf>,
}

fn file_event(path: &Path, bytes: u64) -> DaemonEvent {
    DaemonEvent::InboxFile { path: path.to_string_lossy().into_owned(), bytes }
}

impl InboxWatcher {
    /// Files present at start are rescan's to report; seeded before the notifications begin so every later drop is
    /// unseen. A directory that cannot be read is a refusal, as it is for the node daemon.
    pub(crate) fn seeded(dir: &Path, quiet: Duration) -> io::Result<InboxWatcher> {
        let mut seen = HashSet::new();
        for entry in std::fs::read_dir(dir)? {
            seen.insert(entry?.path());
        }
        Ok(InboxWatcher { dir: dir.to_path_buf(), quiet, pending: HashMap::new(), seen })
    }

    pub(crate) fn track(&mut self, path: PathBuf) {
        self.seen.insert(path.clone());
        self.pending.entry(path).or_insert(Pending { size: None, stable_since: Instant::now() });
    }

    fn track_unseen(&mut self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        let present: HashSet<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        self.seen.retain(|p| present.contains(p));
        for path in present {
            if !self.seen.contains(&path) {
                self.track(path);
            }
        }
    }

    /// One sweep: whatever the notifications missed is tracked, and every tracked file whose size has held still for
    /// the quiet time is announced once.
    pub(crate) fn settle(&mut self) -> Vec<DaemonEvent> {
        self.track_unseen();
        let now = Instant::now();
        let mut settled = Vec::new();
        let paths: Vec<PathBuf> = self.pending.keys().cloned().collect();
        for path in paths {
            let size = match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => meta.len(),
                _ => {
                    self.pending.remove(&path);
                    continue;
                }
            };
            let pending = self.pending.get_mut(&path).expect("a key just listed");
            if pending.size != Some(size) {
                *pending = Pending { size: Some(size), stable_since: now };
                continue;
            }
            if now.duration_since(pending.stable_since) >= self.quiet {
                self.pending.remove(&path);
                settled.push(file_event(&path, size));
            }
        }
        settled
    }

    /// The settled files in the inbox now, for a client recovering missed events; a file still mid-upload is left
    /// to the sweep to announce.
    pub(crate) fn rescan(&self) -> io::Result<Vec<DaemonEvent>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if self.pending.contains_key(&path) {
                continue;
            }
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => out.push(file_event(&path, meta.len())),
                _ => continue,
            }
        }
        Ok(out)
    }
}

/// The platform's notifications for one directory, feeding the paths they name into a channel the sweep task reads.
/// None where the platform refuses a watcher: the sweep alone still announces every file, later.
fn notifications(dir: &Path) -> (Option<notify::RecommendedWatcher>, mpsc::UnboundedReceiver<PathBuf>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let mut watcher = match notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    }) {
        Ok(w) => w,
        Err(_) => return (None, rx),
    };
    match watcher.watch(dir, RecursiveMode::NonRecursive) {
        Ok(()) => (Some(watcher), rx),
        Err(_) => (None, rx),
    }
}

/// A running watcher: its state, and every socket that asked to hear its files.
pub(crate) struct Running {
    pub(crate) state: Mutex<InboxWatcher>,
    subscribers: Mutex<Vec<Listener>>,
}

impl Running {
    pub(crate) fn subscribe(&self, listener: Listener) {
        self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).push(listener);
    }

    pub(crate) fn unsubscribe(&self, key: u64) {
        self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).retain(|l| l.key != key);
    }

    fn emit(&self, events: &[DaemonEvent]) {
        for event in events {
            let text = crate::frame_text(event);
            self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).retain(|l| l.out.send_text(&text));
        }
    }
}

/// Starts the watcher over a directory: the notifications and the sweep on the poll interval, both on one task.
pub(crate) fn start(dir: &Path, quiet: Duration, poll: Duration) -> io::Result<Arc<Running>> {
    let state = InboxWatcher::seeded(dir, quiet)?;
    let (watcher, paths) = notifications(dir);
    let running = Arc::new(Running { state: Mutex::new(state), subscribers: Mutex::new(Vec::new()) });
    let task = Arc::clone(&running);
    let paths = watcher.is_some().then_some(paths);
    tokio::spawn(async move {
        let _watcher = watcher;
        run(task, paths, poll).await;
    });
    Ok(running)
}

/// The watcher's one task: a path the notifications name is tracked as it comes, and every tick sweeps. Once the
/// notifications are gone, refused by the platform or ended, only the tick drives the loop, so a channel with
/// nothing behind it never turns it.
async fn run(running: Arc<Running>, mut paths: Option<mpsc::UnboundedReceiver<PathBuf>>, poll: Duration) {
    let mut tick = tokio::time::interval(poll);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            path = next_path(&mut paths) => match path {
                Some(path) => running.state.lock().unwrap_or_else(|e| e.into_inner()).track(path),
                None => paths = None,
            },
            _ = tick.tick() => {
                let settled = running.state.lock().unwrap_or_else(|e| e.into_inner()).settle();
                running.emit(&settled);
            }
        }
    }
}

/// The next notified path, or a wait that never ends once there are no notifications to wait for.
async fn next_path(paths: &mut Option<mpsc::UnboundedReceiver<PathBuf>>) -> Option<PathBuf> {
    match paths {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// The one inbox watcher a daemon runs, started by the first inbox op.
#[derive(Default)]
pub(crate) struct InboxWatch {
    running: Mutex<Option<Arc<Running>>>,
}

impl InboxWatch {
    pub(crate) fn get_or_start(&self, ctx: &Ctx) -> io::Result<Arc<Running>> {
        let mut slot = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(running) = &*slot {
            return Ok(Arc::clone(running));
        }
        let dir = ctx.options.inbox_dir.clone().unwrap_or_else(|| PathBuf::from(wsp_frames::numbers::DEFAULT_INBOX_DIR));
        let quiet = ctx.options.inbox_quiet_ms.map_or(DEFAULT_QUIET, Duration::from_millis);
        let poll = ctx.options.inbox_poll_ms.map_or(DEFAULT_POLL, Duration::from_millis);
        let running = start(&dir, quiet, poll)?;
        *slot = Some(Arc::clone(&running));
        Ok(running)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Outbound;
    use std::fs;

    async fn sleep(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    /// A watcher over a fresh directory, with every event it emits landing on one channel.
    async fn watch(dir: &Path, quiet_ms: u64, poll_ms: u64) -> (Arc<Running>, mpsc::UnboundedReceiver<crate::Outgoing>) {
        let running = start(dir, Duration::from_millis(quiet_ms), Duration::from_millis(poll_ms)).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        running.subscribe(Listener { key: 1, out: Outbound(tx) });
        (running, rx)
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<crate::Outgoing>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(item) = rx.try_recv() {
            out.push(serde_json::from_str(item.text()).unwrap());
        }
        out
    }

    fn event(path: &Path, bytes: u64) -> serde_json::Value {
        serde_json::json!({ "type": "inbox.file", "path": path.to_str().unwrap(), "bytes": bytes })
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
    }

    #[tokio::test]
    async fn emits_inbox_file_only_after_a_file_stops_growing() {
        let dir = tempfile::tempdir().unwrap();
        let (_w, mut rx) = watch(dir.path(), 200, 40).await;
        let file = dir.path().join("drop.tar");
        fs::write(&file, "x".repeat(100)).unwrap();
        sleep(100).await;
        // Still growing: the quiet window must reset.
        append(&file, &"y".repeat(50));
        sleep(100).await;
        assert!(drain(&mut rx).is_empty(), "half-uploaded files never fire");
        sleep(500).await;
        assert_eq!(drain(&mut rx), [event(&file, 150)]);
        sleep(300).await;
        assert!(drain(&mut rx).is_empty(), "a settled file does not re-fire");
    }

    #[tokio::test]
    async fn rescan_lists_settled_files_but_skips_ones_still_uploading() {
        let dir = tempfile::tempdir().unwrap();
        let settled = dir.path().join("old.png");
        let part = dir.path().join("new.part");
        fs::write(&settled, "o".repeat(10)).unwrap();
        let (w, _rx) = watch(dir.path(), 200, 40).await;
        // Keep new.part growing until the watcher has it pending and old.png has settled out.
        fs::write(&part, "n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let paths = loop {
            append(&part, "n");
            sleep(50).await;
            let paths: Vec<String> = w
                .state
                .lock()
                .unwrap()
                .rescan()
                .unwrap()
                .iter()
                .map(|e| serde_json::to_value(e).unwrap()["path"].as_str().unwrap().to_owned())
                .collect();
            let part_listed = paths.iter().any(|p| Path::new(p) == part);
            let settled_listed = paths.iter().any(|p| Path::new(p) == settled);
            if (!part_listed && settled_listed) || Instant::now() > deadline {
                break paths;
            }
        };
        assert_eq!(paths, [settled.to_str().unwrap()]);
    }

    #[tokio::test]
    async fn the_sweep_announces_a_file_the_notifications_never_reported_once_it_settles() {
        let dir = tempfile::tempdir().unwrap();
        // Seeded and swept with no notifications at all: every event comes from the sweep.
        let mut state = InboxWatcher::seeded(dir.path(), Duration::from_millis(120)).unwrap();
        let file = dir.path().join("lost.bin");
        fs::write(&file, "x".repeat(40)).unwrap();
        assert!(state.settle().is_empty());
        sleep(60).await;
        append(&file, &"y".repeat(24));
        assert!(state.settle().is_empty());
        sleep(60).await;
        assert!(state.settle().is_empty(), "still inside the quiet window after the growth");
        sleep(150).await;
        assert_eq!(state.settle(), [file_event(&file, 64)]);
        assert!(state.settle().is_empty(), "not announced again on later sweeps");
    }

    #[tokio::test]
    async fn reports_a_file_once_when_the_notifications_see_it_and_then_the_sweep_does() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = InboxWatcher::seeded(dir.path(), Duration::from_millis(0)).unwrap();
        let file = dir.path().join("both.bin");
        fs::write(&file, "z".repeat(8)).unwrap();
        state.track(file.clone());
        state.track(file.clone());
        assert!(state.settle().is_empty(), "the first sweep learns the size");
        assert_eq!(state.settle(), [file_event(&file, 8)]);
        assert!(state.settle().is_empty());
    }

    #[tokio::test]
    async fn leaves_files_already_present_at_start_to_rescan() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.png");
        fs::write(&old, "o".repeat(10)).unwrap();
        let (w, mut rx) = watch(dir.path(), 120, 30).await;
        sleep(400).await;
        assert!(drain(&mut rx).is_empty());
        assert_eq!(w.state.lock().unwrap().rescan().unwrap(), [file_event(&old, 10)]);
    }

    #[tokio::test]
    async fn announces_a_file_again_if_it_is_removed_and_dropped_again() {
        let dir = tempfile::tempdir().unwrap();
        let (_w, mut rx) = watch(dir.path(), 120, 30).await;
        let file = dir.path().join("again.bin");
        fs::write(&file, "1").unwrap();
        sleep(300).await;
        assert_eq!(drain(&mut rx), [event(&file, 1)]);
        fs::remove_file(&file).unwrap();
        sleep(100).await;
        fs::write(&file, "22").unwrap();
        sleep(300).await;
        assert_eq!(drain(&mut rx), [event(&file, 2)]);
    }

    #[tokio::test]
    async fn the_sweep_alone_announces_a_file_again_once_it_is_removed_and_dropped_again() {
        let dir = tempfile::tempdir().unwrap();
        // No notifications: what the sweep remembers is all it has, so a name it forgot to forget is never tracked.
        let mut state = InboxWatcher::seeded(dir.path(), Duration::from_millis(0)).unwrap();
        let file = dir.path().join("again.bin");
        fs::write(&file, "1").unwrap();
        assert!(state.settle().is_empty());
        assert_eq!(state.settle(), [file_event(&file, 1)]);
        fs::remove_file(&file).unwrap();
        assert!(state.settle().is_empty());
        fs::write(&file, "22").unwrap();
        assert!(state.settle().is_empty(), "the first sweep after the drop learns the size");
        assert_eq!(state.settle(), [file_event(&file, 2)]);
    }

    #[tokio::test]
    async fn announces_a_file_once_even_when_sweeps_come_faster_than_a_file_settles() {
        let dir = tempfile::tempdir().unwrap();
        let (_w, mut rx) = watch(dir.path(), 0, 10).await;
        let file = dir.path().join("slow.bin");
        fs::write(&file, "s".repeat(5)).unwrap();
        sleep(600).await;
        assert_eq!(drain(&mut rx), [event(&file, 5)]);
    }

    /// CPU time of this thread in clock ticks, off /proc, so a loop that waits can be told from one that turns.
    #[cfg(target_os = "linux")]
    fn thread_cpu_ticks() -> u64 {
        let stat = fs::read_to_string("/proc/thread-self/stat").unwrap();
        let tail: Vec<&str> = stat.rsplit_once(')').unwrap().1.split_whitespace().collect();
        tail[11].parse::<u64>().unwrap() + tail[12].parse::<u64>().unwrap()
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn without_notifications_the_task_waits_between_ticks_instead_of_turning_on_the_closed_channel() {
        let dir = tempfile::tempdir().unwrap();
        let state = InboxWatcher::seeded(dir.path(), Duration::from_millis(0)).unwrap();
        let running = Arc::new(Running { state: Mutex::new(state), subscribers: Mutex::new(Vec::new()) });
        // The sender already gone, as it is when the platform refused a watcher.
        let (gone, rx) = mpsc::unbounded_channel();
        drop(gone);
        let task = tokio::spawn(run(Arc::clone(&running), Some(rx), Duration::from_millis(20)));
        let (tx, mut events) = mpsc::unbounded_channel();
        running.subscribe(Listener { key: 1, out: Outbound(tx) });
        let before = thread_cpu_ticks();
        sleep(500).await;
        let spent = thread_cpu_ticks() - before;
        let file = dir.path().join("late.bin");
        fs::write(&file, "late").unwrap();
        sleep(200).await;
        task.abort();
        assert!(spent < 10, "the task turned on the closed channel: {spent} clock ticks of CPU in 500 ms");
        assert_eq!(drain(&mut events), [event(&file, 4)], "the sweep alone still announces a file");
    }

    #[tokio::test]
    async fn a_directory_that_is_not_there_is_a_refusal_not_a_watcher() {
        let dir = tempfile::tempdir().unwrap();
        let err = start(&dir.path().join("none"), DEFAULT_QUIET, DEFAULT_POLL).err().expect("no watcher over a missing directory");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
