// SPDX-License-Identifier: AGPL-3.0-only
//! This computer's own processes, the processes module of the local kind: ps for the columns the pane already
//! shows, filtered to the person's own processes, since this machine is theirs and another account's work is not
//! the workspace's. Two reads per tick, because both the accounting name and the argv can hold spaces and one row
//! cannot carry both unambiguously: the name read is pid then the rest of the line, and the column read ends in
//! the argv. The C locale is forced because the columns are printed words, and -ww because ps formats to a window:
//! with no terminal on any of its streams a Mac's ps falls back to 79 columns and cuts every row there, and a
//! daemon has pipes for streams.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use wsp_frames::{numbers, ProcEntry, ProcInspectReply};

use crate::paths::OpError;
use crate::proc::{children_of, listening_ports_of, no_process, ProcScan, ProcScanInput, ProcSource};
use crate::sys::finite;
use crate::sys_local::host_command;

/// ps prints resident memory in kibibytes.
const RSS_UNIT: u64 = 1024;

/// The columns the pane reads, in one order both platforms print: the identity, the state, the memory the table
/// sorts on, the cpu the machine has spent, the time it has run, and the argv last, which is the only column
/// allowed to hold spaces here. The start time is the elapsed time taken off the scan's clock: ps prints it as a
/// local date otherwise, which nothing here can turn back into an instant without the C library's calendar.
const PS_COLUMNS: &str = "pid=,ppid=,state=,user=,rss=,time=,etime=,args=";
/// The accounting name on its own, where everything after the pid is the name however many spaces it holds.
const PS_NAMES: &str = "pid=,ucomm=";
/// How far a start time read off two scans may drift before the pid counts as a new process: the elapsed column
/// is whole seconds, so the same process reads up to a second apart from one tick to the next.
const SAME_START_MS: i64 = 2_000;

/// One process as ps read it, before the sampler's own clock turns its cpu time into a share of the window.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PsRow {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) user: String,
    pub(crate) state: String,
    pub(crate) cmdline: String,
    /// Seconds of cpu this process has spent since it started.
    pub(crate) cpu_seconds: f64,
    pub(crate) rss: u64,
    pub(crate) started_at: i64,
}

/// Seconds behind a ps time column, `[dd-][hh:]mm:ss[.cc]`: a Mac's ps carries hundredths and Linux's whole
/// seconds, so the same field is read to whatever precision the machine printed. Anything else reads as none,
/// since a row that cannot be read must not look like a busy or a young one.
pub(crate) fn ps_seconds(time: &str) -> f64 {
    let (days, clock) = match time.split_once('-') {
        Some((d, rest)) => (d.parse::<f64>().unwrap_or(f64::NAN), rest),
        None => (0.0, time),
    };
    let mut seconds = 0.0;
    for part in clock.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().unwrap_or(f64::NAN);
    }
    let total = days * 86_400.0 + seconds;
    if total.is_finite() && total >= 0.0 {
        total
    } else {
        0.0
    }
}

/// The accounting names by pid. A name may hold spaces (Google Chrome Helper) and is the OS's own truncation of
/// the command, which is what the guest's road reads out of /proc too, so a label rule matches the same word on
/// either kind.
pub(crate) fn parse_ps_names(text: &str) -> HashMap<u32, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((pid, name)) = line.split_once(char::is_whitespace) else { continue };
        let name = name.trim();
        if let (Ok(pid), false) = (pid.parse::<u32>(), name.is_empty()) {
            names.insert(pid, name.to_owned());
        }
    }
    names
}

/// The first seven columns as words and the rest of the line as the argv.
fn columns(line: &str) -> Option<([&str; 7], &str)> {
    let mut rest = line.trim_start();
    let mut words = [""; 7];
    for word in &mut words {
        let end = rest.find(char::is_whitespace)?;
        *word = &rest[..end];
        rest = rest[end..].trim_start();
    }
    Some((words, rest))
}

/// ps rows into the columns the pane shows, stamped against the scan's clock. A row whose columns do not parse is
/// dropped rather than failing the scan: one unreadable process must not empty the table. The state word carries
/// flags on both platforms (Ss, R+), and /proc's is one letter, so both kinds show the letter. A kernel thread has
/// no argv and Linux ps prints its name in brackets instead; the pane draws that from the accounting name, as it
/// does for a guest's, so the command of such a row is empty on both kinds.
pub(crate) fn parse_ps(text: &str, at: i64) -> Vec<PsRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let Some(([pid, ppid, state, user, rss, time, etime], args)) = columns(line) else { continue };
        let (Ok(pid), Ok(ppid), Ok(rss)) = (pid.parse::<u32>(), ppid.parse::<u32>(), rss.parse::<u64>()) else { continue };
        let Some(letter) = state.chars().next() else { continue };
        if etime.is_empty() || !etime.bytes().all(|b| b.is_ascii_digit() || b == b':' || b == b'-') {
            continue;
        }
        let bracketed = args.starts_with('[') && args.ends_with(']');
        let bytes = args.as_bytes();
        let cmdline =
            if bracketed { String::new() } else { String::from_utf8_lossy(&bytes[..bytes.len().min(numbers::CMDLINE_BYTES)]).into_owned() };
        rows.push(PsRow {
            pid,
            ppid,
            user: user.to_owned(),
            state: letter.to_string(),
            cmdline,
            cpu_seconds: ps_seconds(time),
            rss: rss * RSS_UNIT,
            started_at: at - (ps_seconds(etime) * 1000.0) as i64,
        });
    }
    rows.sort_by_key(|r| r.pid);
    rows
}

/// The TCP ports one pid listens on, by the road this computer reads them: /proc on Linux, lsof on a Mac. The
/// scan itself never reads ports; only an inspect does.
pub(crate) type PortsOfPid = Arc<dyn Fn(u32) -> Result<Vec<u16>, String> + Send + Sync>;

pub(crate) fn ports_of_pid_road(platform: &str) -> PortsOfPid {
    if platform == "linux" {
        return Arc::new(|pid| Ok(listening_ports_of(Path::new("/proc"), pid)));
    }
    Arc::new(|pid| {
        let output = host_command("lsof", &["-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"])
            .output()
            .map_err(|e| format!("lsof: {e}"))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut ports: Vec<u16> = text.lines().filter_map(|l| l.strip_prefix('n')?.rsplit(':').next()?.parse().ok()).collect();
        ports.sort_unstable();
        ports.dedup();
        Ok(ports)
    })
}

/// What a pid was doing at the last scan, so the next one has a window to divide by.
struct Spent {
    started_at: i64,
    cpu_seconds: f64,
}

/// This computer's processes as the person's own ps shows them.
pub(crate) struct LocalProcSource {
    /// Whose processes the pane lists: the person running the host by default, which is whose machine this is.
    user: String,
    ports: PortsOfPid,
    cap: usize,
    /// Per pid across scans, the cpu time the next delta runs from; a pid whose start time moved is a new process.
    spent: Mutex<HashMap<u32, Spent>>,
}

/// The login name of the user this process runs as, or the uid as a word where the passwd database has no row.
pub(crate) fn current_user() -> String {
    let uid = nix::unistd::getuid();
    nix::unistd::User::from_uid(uid).ok().flatten().map_or_else(|| uid.to_string(), |u| u.name)
}

impl LocalProcSource {
    pub(crate) fn new(user: Option<String>, ports: PortsOfPid, cap: usize) -> LocalProcSource {
        LocalProcSource { user: user.unwrap_or_else(current_user), ports, cap, spent: Mutex::new(HashMap::new()) }
    }

    /// ps exits non-zero with what it printed when a selection matches nothing, so a run that printed rows is read
    /// whatever its status; one that printed nothing is a machine this module cannot read, and the refusal travels so
    /// the pane says so instead of showing an empty table as a fact.
    fn read(&self, columns: &str) -> Result<String, String> {
        let output = host_command("ps", &["-ww", "-U", &self.user, "-o", columns]).output().map_err(|e| format!("ps: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if stdout.trim().is_empty() {
            return Err(format!("ps -U {} printed nothing: {}", self.user, String::from_utf8_lossy(&output.stderr).trim()));
        }
        Ok(stdout)
    }

    /// The busy share of one core over the window just passed, the same column the guest's road reads out of its own
    /// tick counters, and the start time the pid keeps while it is the same process. ps's own %cpu is not that: on
    /// Linux it is the average over the whole life of the process, so a process that burned a second an hour ago
    /// still reads busy. Linux ps prints whole seconds of cpu, so this quantises there; macOS prints hundredths.
    fn share(&self, spent: &mut HashMap<u32, Spent>, row: &PsRow, elapsed_ms: i64) -> (f64, i64) {
        let before =
            spent.get(&row.pid).filter(|b| (b.started_at - row.started_at).abs() <= SAME_START_MS).map(|b| (b.started_at, b.cpu_seconds));
        let started_at = before.map_or(row.started_at, |(started, _)| started);
        spent.insert(row.pid, Spent { started_at, cpu_seconds: row.cpu_seconds });
        let cpu = match before {
            Some((_, cpu_before)) if elapsed_ms > 0 => {
                finite((row.cpu_seconds - cpu_before) / (elapsed_ms as f64 / 1000.0) * 100.0).max(0.0)
            }
            _ => 0.0,
        };
        (cpu, started_at)
    }
}

impl ProcSource for LocalProcSource {
    fn scan(&self, input: &ProcScanInput) -> Result<ProcScan, String> {
        let printed = self.read(PS_COLUMNS)?;
        let named = self.read(PS_NAMES)?;
        let names = parse_ps_names(&named);
        let rows = parse_ps(&printed, input.at);
        let mut spent = self.spent.lock().unwrap_or_else(|e| e.into_inner());
        let mut seen = HashSet::new();
        let mut procs = Vec::with_capacity(rows.len().min(self.cap));
        for row in rows.iter().take(self.cap) {
            seen.insert(row.pid);
            let (cpu, started_at) = self.share(&mut spent, row, input.elapsed_ms);
            procs.push(ProcEntry {
                pid: row.pid,
                ppid: row.ppid,
                user: row.user.clone(),
                state: row.state.clone(),
                // A pid ps named between the two reads carries no name until the next tick rather than a guessed one.
                comm: names.get(&row.pid).cloned().unwrap_or_default(),
                cmdline: row.cmdline.clone(),
                cpu,
                rss: row.rss,
                started_at,
                pty: input.pty.get(&row.pid).cloned(),
            });
        }
        spent.retain(|pid, _| seen.contains(pid));
        Ok(ProcScan { total: rows.len() as u64, procs })
    }

    /// What this computer can say about one process beyond its row: the ports it listens on, its folder from lsof,
    /// and its children out of the scan. ps carries no thread count on macOS, so no kind reads one here and the
    /// field is left off.
    fn inspect(&self, pid: u32, procs: &[ProcEntry]) -> Result<ProcInspectReply, OpError> {
        if !procs.iter().any(|p| p.pid == pid) {
            return Err(no_process(pid));
        }
        let ports = (self.ports)(pid).map_err(OpError::plain)?;
        Ok(ProcInspectReply { pid, cwd: working_folder(pid), ports, threads: None, children: children_of(pid, procs) })
    }
}

/// The folder a process is in, as lsof names it: the one road to another process's cwd that answers on both
/// platforms, since /proc has it on Linux only. None where lsof is absent or the process is out of reach, which is
/// what the pane already prints as unreadable.
fn working_folder(pid: u32) -> Option<String> {
    let output = host_command("lsof", &["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|l| l.strip_prefix('n').filter(|rest| !rest.is_empty())).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sys::now_ms;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    // Fixture provenance: the Linux rows were captured from ps in the column order this module asks for, the
    // macOS rows hand-written in the same documented order; the elapsed column replaces the printed date the node
    // daemon's fixtures carry, since this module reads etime.
    const LINUX_PS: &str = "      1       0 S root      7040 00:00:03 5-02:07:19 /sbin/init
      2       0 S root         0 00:00:00 5-02:07:19 [kthreadd]
    904      1 Ssl root    151204 00:02:17   01:05:37 claude -p do the thing
";
    const MAC_PS: &str = "  4212      1 Ss   zingzy   41232 0:04.31 02:44 claude --print hello
  4213   4212 R+   zingzy  900000 12:31.07 02:43 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer
";
    /// The name pass, where everything after the pid is the name however many spaces it holds.
    const MAC_PS_NAMES: &str = "  4212 claude\n  4213 Google Chrome Helper\n";
    const AT: i64 = 1_757_000_000_000;

    fn no_ports() -> PortsOfPid {
        Arc::new(|_| Ok(vec![]))
    }

    fn scan_at(source: &LocalProcSource, at: i64, elapsed_ms: i64, pty: HashMap<u32, String>) -> ProcScan {
        source.scan(&ProcScanInput { at, elapsed_ms, pty }).unwrap()
    }

    /// Scans until a reading answers, since what a scan reports is what the test is waiting for. Each scan is handed
    /// the wall time since the last, which is the window the module divides its cpu by.
    fn scan_until(source: &LocalProcSource, pid: u32, what: &str, ready: impl Fn(Option<&ProcEntry>) -> bool) -> ProcEntry {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut at = now_ms();
        loop {
            let now = now_ms();
            let scan = scan_at(source, now, now - at, HashMap::new());
            at = now;
            let last = scan.procs.iter().find(|p| p.pid == pid);
            if ready(last) {
                return last.unwrap().clone();
            }
            assert!(Instant::now() < deadline, "pid {pid} never read as {what} in 30 s; last cpu {:?}", last.map(|p| p.cpu));
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn reads_ps_time_columns_to_whatever_precision_the_machine_printed() {
        assert_eq!(ps_seconds("00:00:03"), 3.0);
        assert_eq!(ps_seconds("0:04.31"), 4.31);
        assert_eq!(ps_seconds("12:31.07"), 751.07);
        assert_eq!(ps_seconds("5-02:07:19"), 5.0 * 86_400.0 + 2.0 * 3600.0 + 7.0 * 60.0 + 19.0);
        assert_eq!(ps_seconds("nonsense"), 0.0);
        assert_eq!(ps_seconds(""), 0.0);
    }

    #[test]
    fn reads_ps_rows_into_the_columns_the_pane_shows_on_either_platforms_spelling() {
        let rows = parse_ps(LINUX_PS, AT);
        assert_eq!(rows.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![1, 2, 904]);
        assert_eq!(
            rows[0],
            PsRow {
                pid: 1,
                ppid: 0,
                user: "root".into(),
                state: "S".into(),
                cmdline: "/sbin/init".into(),
                cpu_seconds: 3.0,
                rss: 7040 * 1024,
                started_at: AT - (5 * 86_400 + 2 * 3600 + 7 * 60 + 19) * 1000
            }
        );
        // A kernel thread has no argv; ps prints its name in brackets, and the pane draws that from the name itself.
        assert_eq!(rows[1].cmdline, "");
        // The state carries flags on this road and one letter on the guest's, so both kinds show the letter.
        assert_eq!(
            (rows[2].pid, rows[2].state.as_str(), rows[2].cmdline.as_str(), rows[2].cpu_seconds, rows[2].rss),
            (904, "S", "claude -p do the thing", 137.0, 151_204 * 1024)
        );
        assert_eq!(rows[2].started_at, AT - (3600 + 5 * 60 + 37) * 1000);

        let mac = parse_ps(MAC_PS, AT);
        assert_eq!(mac.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![4212, 4213]);
        assert_eq!(
            (mac[0].ppid, mac[0].user.as_str(), mac[0].state.as_str(), mac[0].cmdline.as_str(), mac[0].cpu_seconds),
            (1, "zingzy", "S", "claude --print hello", 4.31)
        );
        // The argv is the only column allowed spaces here, so a Mac's own path with two of them arrives whole.
        assert_eq!(mac[1].cmdline, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer");
        assert_eq!((mac[1].ppid, mac[1].state.as_str(), mac[1].cpu_seconds, mac[1].rss), (4212, "R", 751.07, 900_000 * 1024));
        assert_eq!(parse_ps("ps: nothing to see\n", AT), vec![]);
    }

    #[test]
    fn takes_the_accounting_name_from_its_own_read_so_a_name_with_spaces_in_it_is_one_name_and_not_two_columns() {
        let names = parse_ps_names(MAC_PS_NAMES);
        assert_eq!(names.get(&4213).map(String::as_str), Some("Google Chrome Helper"));
        assert_eq!(names.get(&4212).map(String::as_str), Some("claude"));
        assert_eq!(names.get(&9999), None);
        assert_eq!(parse_ps_names("  4213 \n"), HashMap::new());
    }

    #[test]
    fn truncates_a_command_line_by_bytes_the_same_budget_the_guests_road_reads_out_of_proc() {
        let row = |args: &str| parse_ps(&format!("      7       1 S root      100 00:00:01 01:00 {args}\n"), AT).remove(0);
        assert_eq!(row(&"x".repeat(300)).cmdline.len(), numbers::CMDLINE_BYTES);
        // Two bytes to the character, so the same budget holds half as many of them: the cut is by bytes, not letters.
        // A character the cut lands inside decodes to one replacement, as it does on the guest's road.
        let wide = row(&format!("node {}", "\u{e9}".repeat(300))).cmdline;
        assert!(wide.chars().count() < numbers::CMDLINE_BYTES);
        assert!(wide.len() <= numbers::CMDLINE_BYTES + 2);
    }

    #[test]
    fn lists_this_computers_own_processes_this_test_among_them_named_and_with_the_daemons_ptys_marked() {
        let source = LocalProcSource::new(None, no_ports(), numbers::PROC_CAP);
        let me = std::process::id();
        let scan = scan_at(&source, now_ms(), 0, HashMap::from([(me, "pty_1".to_owned())]));
        let this = scan.procs.iter().find(|p| p.pid == me).expect("this process is listed");
        assert_eq!(this.user, current_user());
        assert_ne!(this.cmdline, "");
        assert_ne!(this.comm, "");
        assert_eq!(this.pty.as_deref(), Some("pty_1"));
        assert!(this.started_at <= now_ms());
        assert!(scan.total >= scan.procs.len() as u64);
        assert!(scan.procs.iter().all(|p| p.cpu >= 0.0));
    }

    #[test]
    fn asks_ps_for_the_whole_line_whatever_window_it_thinks_it_is_printing_into() {
        // ps formats to a window: a Mac's, with no terminal on any of its streams, falls back to 79 columns and cuts
        // every row there, and a daemon has pipes for streams. procps cuts the same way when COLUMNS says so, which is
        // how this box can hold the rule at all.
        let tail = "wsp-whole-line-marker";
        // A loop, not a simple command: bash execs itself away for the latter, and it is bash's own long argv this reads.
        let mut long = std::process::Command::new("bash")
            .args(["-c", &format!("while :; do sleep 5; done # {} {tail}", "x".repeat(100))])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let source = LocalProcSource::new(None, no_ports(), numbers::PROC_CAP);
        let before = std::env::var_os("COLUMNS");
        std::env::set_var("COLUMNS", "79");
        let row = scan_until(&source, long.id(), "a row at all", |r| r.is_some());
        match before {
            Some(v) => std::env::set_var("COLUMNS", v),
            None => std::env::remove_var("COLUMNS"),
        }
        long.kill().unwrap();
        long.wait().unwrap();
        assert!(row.cmdline.contains(tail), "{}", row.cmdline);
        assert!(row.cmdline.len() > 120);
    }

    #[test]
    fn a_machine_whose_ps_says_nothing_at_all_is_refused_so_no_pane_reads_an_empty_table_as_a_fact() {
        let source = LocalProcSource::new(Some("no-such-person-here".into()), no_ports(), numbers::PROC_CAP);
        let err = source.scan(&ProcScanInput { at: now_ms(), elapsed_ms: 0, pty: HashMap::new() }).unwrap_err();
        assert!(err.starts_with("ps -U no-such-person-here printed nothing"), "{err}");
    }

    #[test]
    fn the_cpu_column_is_the_window_just_passed_not_the_whole_life_of_the_process() {
        let source = LocalProcSource::new(None, no_ports(), numbers::PROC_CAP);
        // This test's own process has burned cpu since it started; ps's own %cpu would report that average for
        // ever. The first scan has no window to divide by, so every row reads zero.
        let first = scan_at(&source, now_ms(), 0, HashMap::new());
        assert_eq!(first.procs.iter().find(|p| p.pid == std::process::id()).unwrap().cpu, 0.0);

        // A child that burns a core until this test stops it, so the burn lasts exactly as long as it takes to show up
        // in a reading, however much of this box the rest of it is using.
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("stop");
        let mut burn = std::process::Command::new("bash")
            .args(["-c", &format!("while [ ! -f {} ]; do :; done; sleep 300", stop.display())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = burn.id();
        // Busy in the window it burned in.
        let spent = scan_until(&source, pid, "busy in a window", |r| r.is_some_and(|p| p.cpu > 0.0));
        assert!(spent.cpu > 0.0);
        // And nothing in a window it did not: the delta is zero once it stops, whatever it burned before.
        std::fs::write(&stop, "").unwrap();
        let idle = scan_until(&source, pid, "idle in a window", |r| r.is_some_and(|p| p.cpu == 0.0));
        assert_eq!(idle.cpu, 0.0);
        // Still zero in the window after that, where a whole-life average would still be reporting the burn.
        let after = scan_until(&source, pid, "a row at all", |r| r.is_some());
        assert_eq!(after.cpu, 0.0);
        // The start time held still across every scan, though the elapsed column moved a second at a time.
        assert_eq!(spent.started_at, after.started_at);
        burn.kill().unwrap();
        burn.wait().unwrap();
    }

    #[test]
    fn inspects_one_of_them_its_ports_off_the_ports_road_its_children_out_of_the_scan_and_nothing_for_a_pid_that_is_gone() {
        let me = std::process::id();
        let ports: PortsOfPid = Arc::new(move |pid| Ok(if pid == me { vec![8080, 8080] } else { vec![22] }));
        let source = LocalProcSource::new(None, ports, numbers::PROC_CAP);
        let scan = scan_at(&source, now_ms(), 0, HashMap::new());
        let kid = scan.procs.iter().find(|p| p.ppid == me).map(|p| p.pid);
        let reply = source.inspect(me, &scan.procs).unwrap();
        assert_eq!(reply.pid, me);
        assert_eq!(reply.ports, vec![8080, 8080]);
        // ps carries no thread count on macOS, so no kind reads one here and the field is left off rather than guessed.
        assert_eq!(reply.threads, None);
        if let Some(kid) = kid {
            assert!(reply.children.contains(&kid));
        }
        assert_eq!(source.inspect(1 << 22 | 1, &scan.procs).unwrap_err().code, Some(wsp_frames::DaemonErrorCode::NotFound));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_the_ports_road_reads_a_pids_sockets_out_of_proc() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let ports = ports_of_pid_road("linux")(std::process::id()).unwrap();
        assert!(ports.contains(&port), "{ports:?} lacks {port}");
        drop(listener);
    }
}
