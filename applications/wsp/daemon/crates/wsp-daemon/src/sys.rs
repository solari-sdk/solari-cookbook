// SPDX-License-Identifier: AGPL-3.0-only
//! The machine's utilisation as sys.sample events. The sampler holds the clock and the subscribers; what one
//! kind's machine is read with is its own module behind SysSource, registered in readings.rs. The module here is
//! the guest's: cpu from two /proc/stat readings, load from /proc/loadavg, memory from /proc/meminfo, disk from
//! statfs on the workspace root. One sampler per daemon; the first subscriber starts it and the last one leaving
//! stops it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;
use wsp_frames::{words, DaemonEvent, Usage};

use crate::paths::OpError;
use crate::{frame_text, Outbound, SharedLog};

/// Busy and idle counters in one unit, whatever the machine counts in: jiffies out of /proc/stat, mach ticks on a
/// Mac. idle includes iowait; total the eight time columns (guest time is already inside user and nice).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CpuTimes {
    pub(crate) idle: f64,
    pub(crate) total: f64,
}

/// A reading is a number or nothing: the serializer writes a NaN as null, which the protocol refuses, and under
/// panic abort nothing may reach it that is not finite. Every float a module hands the sampler passes here first.
pub(crate) fn finite(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

pub(crate) fn parse_proc_stat(text: &str) -> Result<CpuTimes, String> {
    let line = text
        .lines()
        .find(|l| l.strip_prefix("cpu").is_some_and(|rest| rest.starts_with(char::is_whitespace)))
        .ok_or("/proc/stat has no cpu line")?;
    let cols: Vec<f64> = line.split_whitespace().skip(1).take(8).map(|c| c.parse::<f64>().unwrap_or(f64::NAN)).collect();
    if cols.len() < 4 || cols.iter().any(|n| !n.is_finite()) {
        return Err("/proc/stat cpu line is malformed".to_owned());
    }
    let idle = cols[3] + cols.get(4).copied().unwrap_or(0.0);
    Ok(CpuTimes { idle, total: cols.iter().sum() })
}

/// Busy share of the interval between two readings, 0 to 100; no interval, or counters that went backwards, read as 0.
pub(crate) fn cpu_percent(prev: CpuTimes, next: CpuTimes) -> f64 {
    let total = next.total - prev.total;
    let idle = next.idle - prev.idle;
    if total.is_nan() || total <= 0.0 {
        return 0.0;
    }
    finite((total - idle) / total * 100.0).clamp(0.0, 100.0)
}

/// MemTotal and MemAvailable in bytes.
pub(crate) fn parse_meminfo(text: &str) -> Result<(u64, u64), String> {
    let kb = |key: &str| -> Result<u64, String> {
        let missing = || format!("/proc/meminfo has no {key}");
        let line = text.lines().find(|l| l.starts_with(key) && l[key.len()..].starts_with(':')).ok_or_else(missing)?;
        let mut fields = line[key.len() + 1..].split_whitespace();
        let n: u64 = fields.next().and_then(|n| n.parse().ok()).ok_or_else(missing)?;
        if fields.next() != Some("kB") {
            return Err(missing());
        }
        Ok(n * 1024)
    };
    Ok((kb("MemTotal")?, kb("MemAvailable")?))
}

pub(crate) fn parse_loadavg(text: &str) -> Result<f64, String> {
    text.split_whitespace()
        .next()
        .and_then(|n| n.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .ok_or_else(|| "/proc/loadavg is malformed".to_owned())
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SysReadings {
    pub(crate) cpu: CpuTimes,
    pub(crate) load1: f64,
    pub(crate) mem: Usage,
    pub(crate) disk: Usage,
}

/// One kind's road to its machine's load, run off the runtime thread: a read may open files or run a command.
pub(crate) trait SysSource: Send + Sync {
    fn read(&self) -> Result<SysReadings, String>;
}

/// A file read whose failure names the file, since the refusal a pane prints is this sentence.
pub(crate) fn read_named(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The filesystem under a folder as statfs reads it, in bytes.
pub(crate) fn disk_under(path: &Path) -> Result<Usage, String> {
    let fs = nix::sys::statfs::statfs(path).map_err(|e| format!("statfs {}: {e}", path.display()))?;
    let bsize = u64::try_from(fs.block_size()).unwrap_or(0);
    Ok(Usage { used: fs.blocks().saturating_sub(fs.blocks_free()) * bsize, total: fs.blocks() * bsize })
}

/// The guest's own readings, from /proc and a statfs: the module every machine wsp forks is served by.
pub(crate) struct ProcSysSource {
    root: PathBuf,
    proc_root: PathBuf,
}

impl ProcSysSource {
    pub(crate) fn new(root: PathBuf, proc_root: PathBuf) -> ProcSysSource {
        ProcSysSource { root, proc_root }
    }
}

impl SysSource for ProcSysSource {
    fn read(&self) -> Result<SysReadings, String> {
        let stat = read_named(&self.proc_root.join("stat"))?;
        let meminfo = read_named(&self.proc_root.join("meminfo"))?;
        let loadavg = read_named(&self.proc_root.join("loadavg"))?;
        let (total, available) = parse_meminfo(&meminfo)?;
        Ok(SysReadings {
            cpu: parse_proc_stat(&stat)?,
            load1: parse_loadavg(&loadavg)?,
            mem: Usage { used: total.saturating_sub(available), total },
            disk: disk_under(&self.root)?,
        })
    }
}

/// One sample as it goes on the wire: every float finite, whatever the module read.
fn sample_of(prev: CpuTimes, readings: SysReadings, at: i64) -> DaemonEvent {
    DaemonEvent::SysSample {
        cpu: cpu_percent(prev, readings.cpu),
        load1: finite(readings.load1),
        mem: readings.mem,
        disk: readings.disk,
        at,
    }
}

/// The shortest tick a sampler runs on. tokio's interval refuses a zero period, and the release profile aborts on
/// panic, so a flag that says 0 reads as this rather than ending the daemon at the first watch.
pub(crate) fn tick_of(interval: Duration) -> Duration {
    interval.max(Duration::from_millis(1))
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Default)]
struct Inner {
    subscribers: HashMap<u64, Outbound>,
    running: Option<AbortHandle>,
    prev: Option<CpuTimes>,
    /// What the last poll said, so a watch that arrives mid-stream inherits it; None until one has finished.
    last: Option<Result<(), String>>,
}

pub(crate) struct SysSampler {
    source: Arc<dyn SysSource>,
    interval: Duration,
    log: SharedLog,
    inner: Mutex<Inner>,
}

impl SysSampler {
    pub(crate) fn new(source: Arc<dyn SysSource>, interval: Duration, log: SharedLog) -> Arc<SysSampler> {
        Arc::new(SysSampler { source, interval: tick_of(interval), log, inner: Mutex::new(Inner::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn running(&self) -> bool {
        self.lock().running.is_some()
    }

    /// Starts sampling with the first subscriber; the last one leaving stops it.
    pub(crate) fn subscribe(self: &Arc<Self>, key: u64, out: Outbound) {
        let mut inner = self.lock();
        inner.subscribers.insert(key, out);
        if inner.subscribers.len() == 1 {
            self.start(&mut inner);
        }
    }

    /// A key that was never subscribed, or already left, changes nothing.
    pub(crate) fn unsubscribe(&self, key: u64) {
        let mut inner = self.lock();
        if inner.subscribers.remove(&key).is_some() && inner.subscribers.is_empty() {
            self.stop(&mut inner);
        }
    }

    /// One read before a watch is taken, so a module that cannot read this machine refuses the op instead of leaving
    /// the pane at pending for a stream that never comes. Its reading is thrown away: cpu is a delta, so the first
    /// sample still lands one interval after the reply. A sampler already polling reads the machine every interval
    /// anyway, so a second watcher inherits what the last poll said rather than paying for a read of its own; that way
    /// a machine that stopped answering refuses the new watch too, instead of leaving it at pending.
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
            None => self.read().await.map(|_| ()).map_err(OpError::plain),
        }
    }

    async fn read(&self) -> Result<SysReadings, String> {
        let source = Arc::clone(&self.source);
        tokio::task::spawn_blocking(move || source.read()).await.unwrap_or_else(|e| Err(e.to_string()))
    }

    /// The first poll after a start is the cpu baseline and emits nothing; a failed read is skipped and the baseline kept.
    pub(crate) async fn poll(&self) {
        let read = self.read().await;
        let mut inner = self.lock();
        let readings = match read {
            Ok(readings) => readings,
            Err(e) => {
                inner.last = Some(Err(e));
                return;
            }
        };
        inner.last = Some(Ok(()));
        let Some(prev) = inner.prev.replace(readings.cpu) else { return };
        let text = frame_text(&sample_of(prev, readings, now_ms()));
        for out in inner.subscribers.values() {
            out.send_text(&text);
        }
    }

    fn start(self: &Arc<Self>, inner: &mut Inner) {
        if inner.running.is_some() {
            return;
        }
        inner.prev = None;
        let me = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(me.interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                me.poll().await;
            }
        });
        inner.running = Some(task.abort_handle());
        (self.log)(words::SYS_SAMPLER_STARTED);
    }

    fn stop(&self, inner: &mut Inner) {
        if let Some(task) = inner.running.take() {
            task.abort();
            (self.log)(words::SYS_SAMPLER_STOPPED);
        }
        inner.prev = None;
        inner.last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Outgoing;
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::mpsc;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(name)).unwrap()
    }

    // Fixture provenance: hand-written in the proc(5) /proc/stat and /proc/meminfo layouts. The two stat snapshots
    // differ by 900 jiffies in total, 600 of them idle or iowait, so the interval is one third busy.
    #[test]
    fn reads_the_aggregate_cpu_line_idle_counts_iowait_total_counts_the_eight_time_columns() {
        assert_eq!(parse_proc_stat(&fixture("proc-stat-a.txt")).unwrap(), CpuTimes { idle: 8200.0, total: 9800.0 });
        assert_eq!(parse_proc_stat(&fixture("proc-stat-b.txt")).unwrap(), CpuTimes { idle: 8800.0, total: 10700.0 });
        assert_eq!(parse_proc_stat("intr 1 2 3\n").unwrap_err(), "/proc/stat has no cpu line");
        assert_eq!(parse_proc_stat("cpu  1 2 x 4\n").unwrap_err(), "/proc/stat cpu line is malformed");
        assert!(parse_proc_stat("cpu0 1 2 3 4\n").is_err());
    }

    #[test]
    fn cpu_percent_is_busy_jiffies_over_the_interval_all_cores_0_to_100() {
        let a = parse_proc_stat(&fixture("proc-stat-a.txt")).unwrap();
        let b = parse_proc_stat(&fixture("proc-stat-b.txt")).unwrap();
        assert!((cpu_percent(a, b) - 33.333).abs() < 0.01);
        assert_eq!(cpu_percent(CpuTimes { idle: 10.0, total: 10.0 }, CpuTimes { idle: 10.0, total: 10.0 }), 0.0);
        assert_eq!(cpu_percent(CpuTimes { idle: 0.0, total: 0.0 }, CpuTimes { idle: 0.0, total: 100.0 }), 100.0);
        // A counter that wrapped or a reboot reads as no information, never a negative.
        assert_eq!(cpu_percent(CpuTimes { idle: 50.0, total: 100.0 }, CpuTimes { idle: 10.0, total: 20.0 }), 0.0);
    }

    #[test]
    fn a_reading_that_is_not_finite_is_zero_at_the_module_boundary() {
        assert_eq!(cpu_percent(CpuTimes { idle: f64::NAN, total: 1.0 }, CpuTimes { idle: f64::NAN, total: 2.0 }), 0.0);
        assert_eq!(cpu_percent(CpuTimes { idle: 0.0, total: 0.0 }, CpuTimes { idle: 0.0, total: f64::INFINITY }), 0.0);
        assert_eq!(finite(f64::NAN), 0.0);
        assert_eq!(finite(f64::NEG_INFINITY), 0.0);
        assert_eq!(finite(12.5), 12.5);
    }

    #[test]
    fn meminfo_gives_total_and_available_in_bytes() {
        assert_eq!(parse_meminfo(&fixture("proc-meminfo.txt")).unwrap(), (4_030_000 * 1024, 2_015_000 * 1024));
        assert_eq!(parse_meminfo("MemTotal: 10 kB\n").unwrap_err(), "/proc/meminfo has no MemAvailable");
        assert_eq!(parse_meminfo("MemTotalx: 10 kB\nMemAvailable: 1 kB\n").unwrap_err(), "/proc/meminfo has no MemTotal");
    }

    #[test]
    fn loadavg_gives_the_one_minute_figure() {
        assert_eq!(parse_loadavg("0.52 0.58 0.59 1/389 12345\n").unwrap(), 0.52);
        assert!(parse_loadavg("nan 1 2\n").is_err());
        assert!(parse_loadavg("").is_err());
    }

    fn readings(cpu: CpuTimes) -> SysReadings {
        SysReadings { cpu, load1: 0.5, mem: Usage { used: 1_000, total: 4_000 }, disk: Usage { used: 20_000, total: 100_000 } }
    }

    struct Seq {
        readings: Vec<SysReadings>,
        reads: AtomicUsize,
    }

    impl SysSource for Seq {
        fn read(&self) -> Result<SysReadings, String> {
            let i = self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.readings[i.min(self.readings.len() - 1)].clone())
        }
    }

    struct Counted {
        reads: AtomicUsize,
        broken: AtomicBool,
    }

    impl SysSource for Counted {
        fn read(&self) -> Result<SysReadings, String> {
            let n = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            if self.broken.load(Ordering::SeqCst) {
                return Err("/proc/stat: ENOENT".to_owned());
            }
            Ok(readings(CpuTimes { idle: (n * 10) as f64, total: (n * 20) as f64 }))
        }
    }

    fn quiet() -> SharedLog {
        Arc::new(|_| {})
    }

    fn subscriber() -> (Outbound, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Outbound(tx), rx)
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<Outgoing>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(item) = rx.try_recv() {
            out.push(serde_json::from_str(item.text()).unwrap());
        }
        out
    }

    #[tokio::test]
    async fn emits_nothing_on_the_first_poll_and_a_sample_with_the_cpu_delta_on_the_next() {
        let a = parse_proc_stat(&fixture("proc-stat-a.txt")).unwrap();
        let b = parse_proc_stat(&fixture("proc-stat-b.txt")).unwrap();
        let sampler = SysSampler::new(
            Arc::new(Seq { readings: vec![readings(a), readings(b)], reads: AtomicUsize::new(0) }),
            Duration::from_secs(60),
            quiet(),
        );
        let (out, mut rx) = subscriber();
        sampler.lock().subscribers.insert(1, out);
        sampler.poll().await;
        assert!(drain(&mut rx).is_empty());
        let before = now_ms();
        sampler.poll().await;
        let got = drain(&mut rx);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["type"], "sys.sample");
        assert_eq!(got[0]["load1"], 0.5);
        assert_eq!(got[0]["mem"], serde_json::json!({"used": 1000, "total": 4000}));
        assert_eq!(got[0]["disk"], serde_json::json!({"used": 20000, "total": 100000}));
        assert!((got[0]["cpu"].as_f64().unwrap() - 33.333).abs() < 0.01);
        assert!(got[0]["at"].as_i64().unwrap() >= before);
    }

    #[tokio::test]
    async fn a_probe_reads_once_for_the_first_watcher_and_rides_the_running_stream_for_the_next_refusal_and_all() {
        let source = Arc::new(Counted { reads: AtomicUsize::new(0), broken: AtomicBool::new(false) });
        let reads = || source.reads.load(Ordering::SeqCst);
        let sampler = SysSampler::new(source.clone(), Duration::from_secs(60), quiet());
        // Nothing is running yet, so the first watcher pays for its own read and a machine that cannot be read refuses.
        sampler.probe().await.unwrap();
        assert_eq!(reads(), 1);
        let (out, _rx) = subscriber();
        sampler.subscribe(1, out);
        // The subscribe's own poll is in flight; a watcher landing inside it has nothing to inherit and reads for
        // itself, which is the honest answer before any poll has finished.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(reads(), 2);
        // A second watcher on a stream that has polled takes what that poll said instead of reading again.
        sampler.probe().await.unwrap();
        assert_eq!(reads(), 2);
        // The machine stops answering: the next poll records it and the watch after that is refused.
        source.broken.store(true, Ordering::SeqCst);
        sampler.poll().await;
        assert_eq!(reads(), 3);
        assert_eq!(sampler.probe().await.unwrap_err().message, "/proc/stat: ENOENT");
        assert_eq!(reads(), 3);
        sampler.unsubscribe(1);
        // A stopped sampler proves nothing, so the next watcher reads for itself again.
        source.broken.store(false, Ordering::SeqCst);
        sampler.probe().await.unwrap();
        assert_eq!(reads(), 4);
    }

    #[tokio::test]
    async fn one_sampler_serves_every_subscriber_from_the_first_to_the_last_and_a_stale_unsubscribe_is_a_no_op() {
        let source = Arc::new(Counted { reads: AtomicUsize::new(0), broken: AtomicBool::new(false) });
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&lines);
        let log: SharedLog = Arc::new(move |line| sink.lock().unwrap().push(line.to_owned()));
        let sampler = SysSampler::new(source.clone(), Duration::from_millis(10), log);
        let (a, mut a_rx) = subscriber();
        let (b, mut b_rx) = subscriber();
        assert!(!sampler.running());
        sampler.subscribe(1, a);
        assert!(sampler.running());
        sampler.subscribe(2, b);
        tokio::time::sleep(Duration::from_millis(120)).await;
        let (got_a, got_b) = (drain(&mut a_rx), drain(&mut b_rx));
        assert!(got_a.len() > 1 && got_b.len() > 1, "{} {}", got_a.len(), got_b.len());
        // Two subscribers, one stream: each sample reached both.
        let shared = got_a.len().min(got_b.len());
        assert_eq!(got_a[..shared], got_b[..shared]);
        sampler.unsubscribe(1);
        sampler.unsubscribe(1);
        sampler.unsubscribe(9);
        assert!(sampler.running());
        sampler.unsubscribe(2);
        assert!(!sampler.running());
        assert_eq!(*lines.lock().unwrap(), vec![words::SYS_SAMPLER_STARTED, words::SYS_SAMPLER_STOPPED]);
        let at_stop = source.reads.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(source.reads.load(Ordering::SeqCst), at_stop);
        // A restart begins with a fresh baseline: the first poll after it is not measured against the old counters.
        // Driven by hand, with the subscriber put in place and no ticker running, so nothing here races a tick.
        let (c, mut c_rx) = subscriber();
        sampler.lock().subscribers.insert(3, c);
        sampler.poll().await;
        assert!(drain(&mut c_rx).is_empty());
        sampler.poll().await;
        assert_eq!(drain(&mut c_rx).len(), 1);
    }

    #[tokio::test]
    async fn a_zero_interval_reads_as_the_shortest_tick_and_never_ends_the_daemon() {
        assert_eq!(tick_of(Duration::ZERO), Duration::from_millis(1));
        assert_eq!(tick_of(Duration::from_millis(20)), Duration::from_millis(20));
        let source = Arc::new(Counted { reads: AtomicUsize::new(0), broken: AtomicBool::new(false) });
        let sampler = SysSampler::new(source, Duration::ZERO, quiet());
        let (out, mut rx) = subscriber();
        sampler.subscribe(1, out);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sampler.running());
        assert!(!drain(&mut rx).is_empty());
        sampler.unsubscribe(1);
    }

    #[tokio::test]
    async fn a_failed_read_drops_that_tick_and_the_next_one_still_samples() {
        struct Flaky(AtomicUsize);
        impl SysSource for Flaky {
            fn read(&self) -> Result<SysReadings, String> {
                let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
                if n == 2 {
                    return Err("no /proc here".to_owned());
                }
                Ok(readings(CpuTimes { idle: (n * 10) as f64, total: (n * 20) as f64 }))
            }
        }
        let sampler = SysSampler::new(Arc::new(Flaky(AtomicUsize::new(0))), Duration::from_secs(60), quiet());
        let (out, mut rx) = subscriber();
        sampler.lock().subscribers.insert(1, out);
        sampler.poll().await;
        sampler.poll().await;
        assert!(drain(&mut rx).is_empty());
        sampler.poll().await;
        let got = drain(&mut rx);
        assert_eq!(got.len(), 1);
        assert!((got[0]["cpu"].as_f64().unwrap() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn a_module_that_hands_the_sampler_a_nan_reads_as_zero_before_the_sample_is_built() {
        let broken = SysReadings {
            cpu: CpuTimes { idle: f64::NAN, total: f64::INFINITY },
            load1: f64::NAN,
            mem: Usage { used: 0, total: 0 },
            disk: Usage { used: 0, total: 0 },
        };
        let DaemonEvent::SysSample { cpu, load1, at, .. } = sample_of(CpuTimes { idle: 0.0, total: 0.0 }, broken, 7) else {
            unreachable!()
        };
        assert_eq!((cpu, load1, at), (0.0, 0.0, 7));
    }

    #[tokio::test]
    async fn a_module_that_hands_the_sampler_a_nan_never_puts_one_on_the_wire() {
        struct Broken(AtomicUsize);
        impl SysSource for Broken {
            fn read(&self) -> Result<SysReadings, String> {
                let n = self.0.fetch_add(1, Ordering::SeqCst);
                let cpu = if n == 0 { CpuTimes { idle: 0.0, total: 0.0 } } else { CpuTimes { idle: f64::NAN, total: f64::INFINITY } };
                Ok(SysReadings { cpu, load1: f64::NAN, mem: Usage { used: 0, total: 0 }, disk: Usage { used: 0, total: 0 } })
            }
        }
        let sampler = SysSampler::new(Arc::new(Broken(AtomicUsize::new(0))), Duration::from_secs(60), quiet());
        let (out, mut rx) = subscriber();
        sampler.lock().subscribers.insert(1, out);
        sampler.poll().await;
        sampler.poll().await;
        let got = drain(&mut rx);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0]["cpu"].as_f64(), got[0]["load1"].as_f64()), (Some(0.0), Some(0.0)));
    }

    #[test]
    fn the_guest_module_names_the_file_it_could_not_read() {
        let empty = tempfile::tempdir().unwrap();
        let source = ProcSysSource::new(empty.path().to_path_buf(), empty.path().to_path_buf());
        let err = source.read().unwrap_err();
        assert!(err.starts_with(&format!("{}/stat: ", empty.path().display())), "{err}");
        std::fs::write(empty.path().join("stat"), "cpu  1 2 3 4 5 6 7 8 0 0\n").unwrap();
        std::fs::write(empty.path().join("meminfo"), "MemTotal: 8000 kB\nMemAvailable: 6000 kB\n").unwrap();
        std::fs::write(empty.path().join("loadavg"), "1.25 0.40 0.30 1/100 200\n").unwrap();
        let read = source.read().unwrap();
        assert_eq!(read.load1, 1.25);
        assert_eq!(read.mem, Usage { used: 2000 * 1024, total: 8000 * 1024 });
        assert!(read.disk.total > 0 && read.disk.used <= read.disk.total);
    }
}
