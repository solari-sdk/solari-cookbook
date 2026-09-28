// SPDX-License-Identifier: AGPL-3.0-only
//! youki's library, driven two ways. Create and exec clone a new process, and libcontainer clones with a raw
//! clone3 that skips the bookkeeping a threaded libc needs, so each runs in a fresh process of this same binary
//! (`runtime create`, `runtime exec`) that the daemon spawns and waits for; that process also carries the exec's
//! stdio, which a tenant inherits. Start, kill, delete and the status are reads and writes on the state directory
//! and the cgroup and run in this process. The tenant notify sockets youki leaves behind are removed after each
//! exec. A tenant runs behind the workspace's seccomp filter as the init does: youki hands a tenant the init's
//! namespaces and cgroup and none of the linux section the filter lives in, so the exec loads it itself, through
//! the executor that runs the command.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use libcontainer::container::builder::ContainerBuilder;
use libcontainer::container::{Container, ContainerStatus, State};
use libcontainer::oci_spec::runtime::{LinuxSeccomp, Spec};
use libcontainer::seccomp;
use libcontainer::syscall::syscall::SyscallType;
use libcontainer::workload::default::DefaultExecutor;
use libcontainer::workload::{Executor, ExecutorError, ExecutorValidationError};
use nix::sys::signal::{kill, killpg, Signal};
use nix::sys::wait::{waitpid, WaitStatus};
use nix::unistd::Pid;
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use wsp_frames::numbers;

use crate::bundle::{Init, Layout};
use crate::profile;

/// How long the daemon waits for the tenant to hand its pty master back over the console socket. The tenant is
/// cloned, pivots and opens the pty from the workspace's own /dev/pts, which is milliseconds; past this the
/// workspace could not give a terminal and the pane is told rather than left waiting.
const CONSOLE_WAIT: Duration = Duration::from_secs(30);
/// How often the file the library writes the broker's pid into is read while the terminal is opening.
const PID_POLL: Duration = Duration::from_millis(5);
/// How long a helper that gave no terminal is read for once it is ended: what it printed is already written, so
/// this is the pipe draining and nothing more.
const HELPER_LAST_WORDS: Duration = Duration::from_secs(2);

/// The exit code a helper answers for a failure of its own, apart from the command it ran; its stderr says why,
/// behind `HELPER_PREFIX`.
pub const HELPER_FAILED: i32 = 125;
const HELPER_PREFIX: &str = "wsp-runtime: ";
/// How much longer than an exec's own deadline the daemon waits for its helper before killing the group.
const HELPER_MARGIN: Duration = Duration::from_secs(5);
const CREATE_TIMEOUT: Duration = Duration::from_secs(60);
/// A tenant notify socket older than this belongs to no exec still starting.
const STALE_NOTIFY: Duration = Duration::from_secs(30);
const TENANT_NOTIFY: &str = "tenant-notify-";
/// How long killed processes get to leave their cgroup before the kill is called failed.
const KILL_PATIENCE: Duration = Duration::from_secs(10);
/// How long the processes of a workspace get to end themselves after SIGTERM before the kill road takes whatever
/// stayed. A turn writing its files out and a dev server closing its sockets are both done well inside it, and a
/// person who asked for a stop does not wait longer than this on a process that ignores the signal.
pub const STOP_PATIENCE: Duration = Duration::from_secs(15);
/// How long the boot command gets to appear in the workspace's cgroup after the start before the boot is called
/// failed. Measured on a box: the first process is in the cgroup 133 to 162 ms after a create is asked for and
/// its own child 297 to 319 ms after, so this is a wide multiple of what it takes and not a figure a healthy
/// boot ever reaches.
pub const BOOT_CHILD_PATIENCE: Duration = Duration::from_secs(10);
/// The one sentence an exec is refused with when the workspace's filter has a rule whose action is notify: loading
/// such a filter hands back a notify fd, and nothing on the exec road serves it.
const NOTIFY_REFUSAL: &str =
    "the workspace's seccomp filter has a rule whose action is notify, and an exec serves no listener for it, so the command did not run";

#[derive(Debug)]
pub enum Error {
    /// youki refused, in its own words.
    Container(String),
    /// A helper process ended without doing its work.
    Helper {
        verb: &'static str,
        detail: String,
    },
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Container(detail) => write!(f, "{detail}"),
            Error::Helper { verb, detail } => write!(f, "runtime {verb}: {detail}"),
            Error::Io { path, source } => write!(f, "{}: {source}", path.display()),
        }
    }
}

impl std::error::Error for Error {}

/// The error and every source under it, joined, since youki's top line alone rarely says what failed.
fn described(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(inner) = source {
        let line = inner.to_string();
        if !text.contains(&line) {
            text.push_str(": ");
            text.push_str(&line);
        }
        source = inner.source();
    }
    text
}

fn container(e: impl std::error::Error) -> Error {
    Error::Container(described(&e))
}

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> Error + '_ {
    move |source| Error::Io { path: path.to_owned(), source }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Creating,
    Created,
    Running,
    Paused,
    Stopped,
    /// No state directory: nothing was created, or it was deleted.
    Gone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exec {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    /// One of the two streams filled the output cap and what came after it is gone. Read by whoever asked, since
    /// a diff cut here and a diff cut by a pane's own budget are the same thing to the person reading it.
    pub truncated: bool,
}

/// What one pty inside a workspace is opened with: the size the pane holds, the folder the shell starts in,
/// which is absolute and the caller's to name, the command it runs, and what its environment carries beyond the
/// workspace's own.
#[derive(Debug, Clone)]
pub struct PtyInside {
    pub cols: u16,
    pub rows: u16,
    pub cwd: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// A shell running inside a workspace on a pty of that workspace's own: the two ends of the road into it, the
/// helper that holds the exec, which is waited on for the exit as an exec's is, and what resizes the terminal.
/// The pipes are taken once, by whoever pumps them.
pub struct PtyInsideRunning {
    pipes: Option<(tokio::process::ChildStdin, tokio::process::ChildStdout)>,
    pub helper: tokio::process::Child,
    size: PtyInsideSize,
}

/// What resizes one pty inside a workspace, and nothing else: the broker's pid on this computer and the file it
/// reads a size from. Its own thing, so one task may wait on the helper for the exit while another resizes.
pub struct PtyInsideSize {
    pid: u32,
    file: PathBuf,
}

impl PtyInsideSize {
    /// The broker's pid on this computer: what the window-change signal goes to, what the mode probe reads and
    /// what the proc sampler labels a row of this computer's own process list with.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The size the pane holds now: written where the broker inside reads it, then the window-change signal that
    /// tells it to, which is the one thing that reaches a process whose pipes carry a person's keystrokes.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), Error> {
        fs::write(&self.file, crate::pty::size_line(cols, rows)).map_err(io_at(&self.file))?;
        kill(Pid::from_raw(self.pid as i32), Signal::SIGWINCH).map_err(|e| Error::Container(format!("the pty was not resized: {e}")))
    }
}

/// The size file is the workspace's own and goes with the pty it was written for.
impl Drop for PtyInsideSize {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
    }
}

impl PtyInsideRunning {
    /// What a person types goes in the first and what the shell prints comes out of the second; nothing after
    /// the first caller, since two readers of one pipe would each get half the bytes.
    pub fn pipes(&mut self) -> Option<(tokio::process::ChildStdin, tokio::process::ChildStdout)> {
        self.pipes.take()
    }

    pub fn pid(&self) -> u32 {
        self.size.pid()
    }

    /// The helper to wait on for the exit and the size road, taken apart: one task waits on that child for the
    /// life of the shell, and a resize cannot wait behind it.
    pub fn apart(self) -> (tokio::process::Child, PtyInsideSize) {
        (self.helper, self.size)
    }

    /// What the helper and the broker inside printed, with the helper ended so its stderr reads to the end: the
    /// sentence a terminal that gave nothing is explained by, since the library writes the broker's pid the
    /// moment the tenant is made and the kernel may still refuse that tenant's filter after it. Ends the pty, so
    /// it is asked once something has already gone wrong.
    pub async fn said(&mut self) -> String {
        helper_said(&mut self.helper).await
    }

    /// The size the pane holds now, on the road above.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), Error> {
        self.size.resize(cols, rows)
    }
}

pub struct Runtime {
    layout: Layout,
    exe: PathBuf,
    /// A number no other pty of this run has, so two panes on one workspace never name one console socket.
    ptys: AtomicU64,
}

impl Runtime {
    /// `exe` is this binary, which the helpers run and the workspaces boot as their init.
    pub fn new(root: &Path, exe: PathBuf) -> Runtime {
        Runtime { layout: Layout::new(root), exe, ptys: AtomicU64::new(1) }
    }

    pub fn exe(&self) -> &Path {
        &self.exe
    }

    /// youki's create for the bundle under the run directory, in a helper process; the container is created and
    /// waits for start.
    pub async fn create(&self, id: &str) -> Result<(), Error> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["runtime", "create", "--root"]).arg(self.layout.root()).args(["--id", id]).stdin(Stdio::null()).kill_on_drop(true);
        let output = match tokio::time::timeout(CREATE_TIMEOUT, cmd.output()).await {
            Err(_) => return Err(Error::Helper { verb: "create", detail: format!("did not finish in {} s", CREATE_TIMEOUT.as_secs()) }),
            Ok(Err(e)) => return Err(Error::Helper { verb: "create", detail: e.to_string() }),
            Ok(Ok(output)) => output,
        };
        if output.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&output.stderr);
        Err(Error::Helper { verb: "create", detail: said.trim().strip_prefix(HELPER_PREFIX).unwrap_or(said.trim()).to_owned() })
    }

    pub async fn start(&self, id: &str) -> Result<(), Error> {
        let dir = self.layout.state_of(id);
        tokio::task::spawn_blocking(move || Container::load(dir).map_err(container)?.start().map_err(container)).await.map_err(joined)?
    }

    /// A command inside the workspace as a tenant, through a helper: both streams captured under the output cap,
    /// the exit code as the command's, 124 once the deadline passed.
    pub async fn exec(&self, id: &str, args: &[String], stdin: Option<Vec<u8>>, timeout: Duration) -> Result<Exec, Error> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["runtime", "exec", "--root"])
            .arg(self.layout.root())
            .args(["--id", id, "--timeout-ms", &timeout.as_millis().to_string(), "--"])
            .args(args);
        cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Its own group, so the daemon's own deadline reaches the helper and whatever it left in the group.
        cmd.process_group(0).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| Error::Helper { verb: "exec", detail: e.to_string() })?;
        let pid = child.id();
        let mut feed = child.stdin.take();
        let out = child.stdout.take();
        let err = child.stderr.take();
        let stdout = Mutex::new(Vec::new());
        let stderr = Mutex::new(Vec::new());
        let run = async {
            let write = async {
                if let (Some(pipe), Some(bytes)) = (feed.as_mut(), stdin) {
                    let _ = pipe.write_all(&bytes).await;
                }
                drop(feed);
            };
            let ((), cut_out, cut_err, status) = tokio::join!(write, read_into(out, &stdout), read_into(err, &stderr), child.wait());
            (status, cut_out || cut_err)
        };
        let (status, truncated) = match tokio::time::timeout(timeout + HELPER_MARGIN, run).await {
            Ok((status, truncated)) => (status.map_err(|e| Error::Helper { verb: "exec", detail: e.to_string() })?.code(), truncated),
            Err(_) => {
                if let Some(group) = pid.and_then(|p| i32::try_from(p).ok()) {
                    let _ = killpg(Pid::from_raw(group), Signal::SIGKILL);
                }
                let _ = child.start_kill();
                (None, false)
            }
        };
        let stdout = String::from_utf8_lossy(&stdout.into_inner().unwrap_or_else(|e| e.into_inner())).into_owned();
        let stderr = String::from_utf8_lossy(&stderr.into_inner().unwrap_or_else(|e| e.into_inner())).into_owned();
        if status == Some(HELPER_FAILED) {
            if let Some(detail) = stderr.trim().strip_prefix(HELPER_PREFIX) {
                return Err(Error::Helper { verb: "exec", detail: detail.to_owned() });
            }
        }
        Ok(Exec { exit_code: status.unwrap_or(numbers::EXEC_DEADLINE_EXIT), stdout, stderr, truncated })
    }

    /// A shell inside the workspace, on a pty the workspace itself opens. The exec is a plain exec in every way
    /// the library sees: a tenant with no terminal and no console socket, running this binary's own pty broker
    /// inside, which opens the pair from the workspace's own /dev/ptmx and is the wire between that master and
    /// this exec's pipes. What comes back is those pipes, this computer's own pid for the process that runs the
    /// broker, which a resize is signalled to, and the helper to wait on for the exit.
    pub async fn pty(&self, id: &str, opts: &PtyInside) -> Result<PtyInsideRunning, Error> {
        let at = self.ptys.fetch_add(1, Ordering::Relaxed);
        // The size is read inside, so the file is written in the folder of the workspace's own that is mounted
        // over the wsp home inside it: one name, spelled on this side as a path on the computer's disk and on
        // that side as the path the workspace sees.
        let name = format!("pty-{at}.size");
        let size_file = self.layout.wsp_home(id).join(&name);
        let ask = crate::pty::Ask {
            cols: opts.cols,
            rows: opts.rows,
            cwd: PathBuf::from(&opts.cwd),
            size_file: PathBuf::from(format!("{}/{name}", numbers::GUEST_WSP_HOME)),
            env: opts.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            argv: opts.args.clone(),
        };
        if let Some(dir) = size_file.parent() {
            fs::create_dir_all(dir).map_err(io_at(dir))?;
        }
        fs::write(&size_file, crate::pty::size_line(opts.cols, opts.rows)).map_err(io_at(&size_file))?;
        let pid_file = self.layout.workspace(id).join(format!("pty-{at}.pid"));
        let _ = fs::remove_file(&pid_file);
        let line = crate::pty::helper_argv(self.layout.root(), id, &pid_file, &crate::pty::broker_line(profile::INIT_PATH, &ask));
        let started = crate::pty::start(&self.exe, &line).map_err(|e| Error::Helper { verb: "pty", detail: e.to_string() });
        let (mut helper, input, output) = match started {
            Ok(started) => started,
            Err(e) => {
                let _ = fs::remove_file(&size_file);
                return Err(e);
            }
        };
        let named = self.broker_pid(&pid_file, &mut helper).await;
        let _ = fs::remove_file(&pid_file);
        match named {
            Ok(pid) => Ok(PtyInsideRunning { pipes: Some((input, output)), helper, size: PtyInsideSize { pid, file: size_file } }),
            Err(e) => {
                let _ = fs::remove_file(&size_file);
                let _ = helper.start_kill();
                Err(e)
            }
        }
    }

    /// The pid the broker runs under on this computer, off the file the library writes the moment the tenant is
    /// made. That is before the process has exec'd the broker, so what /proc says of its environment until then
    /// is the one it was forked with, this daemon's own, and not the workspace's. Three things are raced: that
    /// file, the helper's own end, and the wait. A helper that ended before a terminal stood is the whole of the
    /// answer, since an exec the kernel or the library refuses is refused before the command runs, and the
    /// refusal names what the helper said.
    async fn broker_pid(&self, pid_file: &Path, helper: &mut tokio::process::Child) -> Result<u32, Error> {
        let named = async {
            loop {
                if let Some(pid) = fs::read_to_string(pid_file).ok().and_then(|held| held.trim().parse::<u32>().ok()) {
                    return pid;
                }
                tokio::time::sleep(PID_POLL).await;
            }
        };
        let why = tokio::select! {
            pid = named => return Ok(pid),
            ended = helper.wait() => match ended {
                Ok(status) => format!("the helper ended {status} before the workspace opened a terminal"),
                Err(e) => format!("the helper could not be waited for: {e}"),
            },
            () = tokio::time::sleep(CONSOLE_WAIT) => format!("the workspace opened no terminal in {} s", CONSOLE_WAIT.as_secs()),
        };
        Err(Error::Helper { verb: "pty", detail: format!("{why}; {}", helper_said(helper).await) })
    }

    /// SIGKILL to every process in the cgroup, then youki's delete once they have left and the init is reaped: the
    /// cgroup and the state directory go. `init` is the record's; a workspace whose init is not that process any
    /// more has nothing of ours running, so nothing is killed and the delete takes the rest. None is a workspace
    /// still being created, whose init is the one youki just made.
    pub async fn kill(&self, id: &str, init: Option<&Init>) -> Result<(), Error> {
        let dir = self.layout.state_of(id);
        let cgroup = self.layout.cgroup_dir(id);
        let init = init.cloned();
        tokio::task::spawn_blocking(move || {
            // No state of youki's: a create that never got that far, or one whose init the open found gone. The
            // cgroup is empty then, and ours to remove.
            if !dir.join("state.json").is_file() {
                let _ = fs::remove_dir_all(&dir);
                if cgroup.exists() {
                    crate::freeze::wait_unpopulated(&cgroup, KILL_PATIENCE).map_err(io_at(&cgroup))?;
                    fs::remove_dir(&cgroup).map_err(io_at(&cgroup))?;
                }
                return Ok(());
            }
            let ours = init.as_ref().is_none_or(alive);
            // A state file youki cannot read any more is still a workspace of ours to end: the cgroup kills what it
            // holds, and the state directory and the cgroup go by hand, since youki's delete would refuse them.
            let Ok(state) = State::load(&dir) else {
                if cgroup.exists() {
                    fs::write(cgroup.join("cgroup.kill"), "1").map_err(io_at(&cgroup))?;
                    crate::freeze::wait_unpopulated(&cgroup, KILL_PATIENCE).map_err(io_at(&cgroup))?;
                }
                if let (true, Some(init)) = (ours, init.as_ref()) {
                    wait_reaped(init.pid, KILL_PATIENCE)?;
                }
                fs::remove_dir_all(&dir).map_err(io_at(&dir))?;
                if cgroup.exists() {
                    fs::remove_dir(&cgroup).map_err(io_at(&cgroup))?;
                }
                return Ok(());
            };
            let pid = state.pid;
            // A load that fails is an init that left between two reads of /proc: nothing is left to kill, and the
            // delete below takes the rest, as it does for a stopped or half-created container.
            if ours {
                if let Ok(mut c) = Container::load(dir.clone()) {
                    match c.kill(sigkill(), true) {
                        Ok(()) | Err(libcontainer::error::LibcontainerError::IncorrectStatus(_)) => {}
                        Err(e) if c.status() == ContainerStatus::Stopped => {
                            let _ = e;
                        }
                        Err(e) => return Err(container(e)),
                    }
                }
            }
            // youki's delete reads the init's /proc entry and waits well under a second for the cgroup to empty; a
            // wait for the processes to leave and for the init to be reaped first, so the delete finds a stopped
            // container and an empty cgroup.
            crate::freeze::wait_unpopulated(&cgroup, KILL_PATIENCE).map_err(io_at(&cgroup))?;
            if let (true, Some(pid)) = (ours, pid) {
                wait_reaped(pid, KILL_PATIENCE)?;
            }
            let deleted = Container::load(dir.clone()).map_err(container).and_then(|mut c| c.delete(true).map_err(container));
            if let Err(e) = deleted {
                if cgroup.exists() {
                    return Err(e);
                }
                // A cgroup the kernel already dropped (the box rebooted) fails youki's delete; the directory is ours.
                if dir.exists() {
                    fs::remove_dir_all(&dir).map_err(io_at(&dir))?;
                }
            }
            Ok(())
        })
        .await
        .map_err(joined)?
    }

    /// youki's status for the workspace, refreshed against /proc; Gone where it has no state directory.
    pub fn status(&self, id: &str) -> Result<Status, Error> {
        let dir = self.layout.state_of(id);
        if !dir.join("state.json").is_file() {
            return Ok(Status::Gone);
        }
        let c = Container::load(dir).map_err(container)?;
        Ok(match c.status() {
            ContainerStatus::Creating => Status::Creating,
            ContainerStatus::Created => Status::Created,
            ContainerStatus::Running => Status::Running,
            ContainerStatus::Paused => Status::Paused,
            ContainerStatus::Stopped => Status::Stopped,
        })
    }

    /// The init process's pid, while the container has one.
    pub fn init_pid(&self, id: &str) -> Result<Option<i32>, Error> {
        let dir = self.layout.state_of(id);
        if !dir.join("state.json").is_file() {
            return Ok(None);
        }
        Ok(Container::load(dir).map_err(container)?.pid().map(|pid| pid.as_raw()))
    }

    /// Waits until the workspace's first process has started the boot command, which is the one child it starts
    /// itself, and answers that child's pid.
    ///
    /// The start is what execs the init, and the init spawns the boot command a moment later, so for about a
    /// sixth of a second a workspace's cgroup holds its first process and nothing else. A create that answered
    /// ready inside that window handed back a workspace a stop could not stop: the stop read a cgroup of one
    /// pid, had nothing to ask, and then watched the boot command appear and waited on it for the whole patience
    /// (measured on a box, every pause fifteen seconds). So the boot does not answer until the child is there.
    pub async fn boot_child_up(&self, id: &str, init: &Init) -> Result<i32, Error> {
        let cgroup = self.layout.cgroup_dir(id);
        let init = init.clone();
        tokio::task::spawn_blocking(move || boot_child_in(&cgroup, &init, BOOT_CHILD_PATIENCE)).await.map_err(joined)?
    }

    /// The stop a nap is, which always stops: SIGTERM to the workspace's own processes, its init and the boot
    /// command last of all, a wait for them to leave, then the kill road for whatever stayed.
    ///
    /// The init is signalled last because it is the first process of a pid namespace: the kernel kills every
    /// other process in one the moment that process is gone, so an init signalled first would take the turn and
    /// the dev server down with it before either could write out what it held. The boot command waits with it,
    /// and for the same reason at one remove: this init exits as soon as the one child it started is reaped, so
    /// a boot command asked to end first ends the init, and the init's end kills everything the wait was for.
    /// The init forwards what it is sent to that child, so signalling the init is what ends both.
    ///
    /// `init` is the record's, so a workspace whose init is some other process by now signals nothing and goes
    /// straight to the kill road.
    pub async fn stop(&self, id: &str, init: Option<&Init>) -> Result<(), Error> {
        let cgroup = self.layout.cgroup_dir(id);
        let init_pid = init.filter(|init| alive(init)).map(|init| init.pid);
        tokio::task::spawn_blocking(move || term_under(&cgroup, init_pid, STOP_PATIENCE)).await.map_err(joined)??;
        self.kill(id, init).await
    }
}

/// SIGTERM to the workspace's own processes and then to its init, waiting for each to leave inside the patience
/// they share. Whatever is still there when it runs out is the kill road's; nothing here fails for that, since a
/// stop that refused would leave a workspace neither awake nor stopped.
///
/// Two pids are held back to the end, which `held_back` reads: the init, and the one process the init started
/// itself. Everything else in the cgroup is a turn's, and those are what the wait is for.
///
/// Every pass signals what it has not signalled yet, rather than only the listing the first pass read. A pid
/// appears in a cgroup after a stop has begun more often than it looks: a process forked by one that is shutting
/// down, one reparented onto the init when its parent left, or the workspace's own boot command where a create
/// answered before it existed. One nothing ever signalled is one the wait then holds to the deadline, which is
/// what a box measured as every pause costing the whole patience.
fn term_under(cgroup: &Path, init: Option<i32>, patience: Duration) -> Result<(), Error> {
    if !cgroup.exists() {
        return Ok(());
    }
    let deadline = Instant::now() + patience;
    let mut signalled: Vec<i32> = Vec::new();
    // The first read is the one that can say why a stop asked nothing; every read after it is a poll, and a
    // cgroup that went while the wait ran is a workspace that ended itself.
    let mut listing = crate::freeze::pids_under(cgroup).map_err(io_at(cgroup))?;
    loop {
        let last = held_back(&listing, init);
        let asking: Vec<i32> = listing.iter().copied().filter(|pid| !last.contains(pid) && !signalled.contains(pid)).collect();
        for pid in asking {
            let _ = kill(Pid::from_raw(pid), Signal::SIGTERM);
            signalled.push(pid);
        }
        // Nothing left but the pair the init's own signal ends, or the patience is up: the init's turn either way.
        if !listing.iter().any(|pid| !last.contains(pid)) || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
        listing = crate::freeze::pids_under(cgroup).unwrap_or_default();
    }
    let Some(init) = init else { return Ok(()) };
    // The init alone, which forwards it to the boot command: one signal ends the pair, and the kernel takes
    // whatever is left of the namespace with them.
    let _ = kill(Pid::from_raw(init), Signal::SIGTERM);
    while !crate::freeze::pids_under(cgroup).unwrap_or_default().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

/// The pids a stop holds back to the end: the workspace's first process and the one process it started itself.
/// Read off every listing rather than once, since which pid is the boot command is a fact about the cgroup as it
/// is now, and a workspace still coming up has not put it there yet.
fn held_back(pids: &[i32], init: Option<i32>) -> Vec<i32> {
    init.into_iter().flat_map(|init| [Some(init), boot_child(pids, init)]).flatten().collect()
}

/// Waits for the init to have started the boot command, and answers its pid. An init that went while this waited
/// started nothing and never will, which is said in its own sentence rather than waited out; so is a boot that
/// ran nothing inside the patience, since a workspace whose first process starts nothing is a workspace with
/// nothing in it.
fn boot_child_in(cgroup: &Path, init: &Init, patience: Duration) -> Result<i32, Error> {
    let deadline = Instant::now() + patience;
    loop {
        if let Some(child) = boot_child(&crate::freeze::pids_under(cgroup).unwrap_or_default(), init.pid) {
            return Ok(child);
        }
        if !alive(init) {
            return Err(Error::Container("the workspace's first process ended before it started anything".to_owned()));
        }
        if Instant::now() >= deadline {
            return Err(Error::Container(format!(
                "the workspace's first process started nothing in {} s, so there is nothing running inside it",
                patience.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The one process the init started itself, which is the boot command: the oldest of the cgroup's processes whose
/// parent is the init.
///
/// The oldest and not simply a child of the init: a process a turn started and lost is reparented onto the init
/// too, which is what this init is there for, and those are the very processes the stop asks to end first. The
/// boot command is the only child the init has had since the workspace came up, and every turn's is younger than
/// the boot, so age is what tells them apart. Nothing where the init has no child, which is a workspace whose
/// boot command has already gone and whose init is on its way out with it.
pub fn boot_child(pids: &[i32], init: i32) -> Option<i32> {
    pids.iter()
        .copied()
        .filter(|pid| *pid != init)
        .filter_map(|pid| parent_and_start(pid).filter(|(parent, _)| *parent == init).map(|(_, started)| (started, pid)))
        .min()
        .map(|(_, pid)| pid)
}

/// The parent's pid and the start time of a process, off the one stat line: the start time through the reader
/// above, which is where that field's place is spelled.
fn parent_and_start(pid: i32) -> Option<(i32, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let parent = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()?;
    Some((parent, start_ticks(&stat).ok()?))
}

/// The identity of a live process: its pid with its start time and the box's boot id, which is what tells the
/// init a record names apart from a process the kernel handed the same pid to later, or after a reboot.
pub fn identity_of(pid: i32) -> io::Result<Init> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    Ok(Init { pid, started: start_ticks(&stat)?, boot_id: boot_id()? })
}

/// Whether the process the record names is still that process.
pub fn alive(init: &Init) -> bool {
    identity_of(init.pid).is_ok_and(|now| now == *init)
}

/// A descriptor that reads ready the moment the process a record names ends, so a workspace whose init died on
/// its own is heard rather than read on the next listing. `pidfd_open` wants Linux 5.3, which every computer the
/// map takes as a box runs; an older kernel or a pid already gone answers the error and nothing is watched.
pub fn death_of(init: &Init) -> io::Result<AsyncFd<OwnedFd>> {
    // SAFETY: pidfd_open takes two plain integers and answers a descriptor or -1.
    let opened = unsafe { libc::syscall(libc::SYS_pidfd_open, init.pid, 0) };
    if opened < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel answered this descriptor just now and nothing else holds it.
    let fd = unsafe { OwnedFd::from_raw_fd(opened as RawFd) };
    // The identity again, under the descriptor: a pid the kernel had already handed on would be watched in the
    // init's place, and the watch would fire on a stranger's exit. A pid that reads as the init here read as the
    // init at the open too, since the kernel never gives one process's number back to it.
    if !alive(init) {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    AsyncFd::new(fd)
}

/// How long the process a record names has been running. Both figures count from the same boot, so the box's own
/// clock never enters it and a computer whose wall clock was set while a workspace ran still reads its uptime right.
pub fn uptime_ms(init: &Init) -> io::Result<u64> {
    let text = fs::read_to_string("/proc/uptime")?;
    let seconds: f64 = text
        .split_whitespace()
        .next()
        .and_then(|field| field.parse().ok())
        .ok_or_else(|| io::Error::other("/proc/uptime carries no seconds"))?;
    let booted_ms = (seconds * 1000.0).max(0.0) as u64;
    Ok(booted_ms.saturating_sub(init.started.saturating_mul(numbers::STAT_TICK_MS)))
}

/// Field 22 of a stat line: the fields after the command name, which the parentheses close, start at the state.
fn start_ticks(stat: &str) -> io::Result<u64> {
    let after_comm = stat.rsplit_once(')').map(|(_, rest)| rest).ok_or_else(|| io::Error::other("a stat line without a command name"))?;
    after_comm
        .split_whitespace()
        .nth(19)
        .and_then(|field| field.parse().ok())
        .ok_or_else(|| io::Error::other("a stat line without a start time"))
}

fn boot_id() -> io::Result<String> {
    Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned())
}

/// Waits until the process's /proc entry is gone: exited and reaped by whoever holds it.
fn wait_reaped(pid: i32, patience: Duration) -> Result<(), Error> {
    let entry = PathBuf::from(format!("/proc/{pid}"));
    let started = std::time::Instant::now();
    while entry.exists() {
        if started.elapsed() > patience {
            return Err(Error::Container(format!("process {pid} is still there {} s after its kill", patience.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

/// SIGKILL as youki's own signal type, which wraps another nix than this crate's.
fn sigkill() -> libcontainer::signal::Signal {
    libcontainer::signal::Signal::try_from(Signal::SIGKILL as i32).expect("SIGKILL is a signal")
}

fn joined(e: tokio::task::JoinError) -> Error {
    Error::Helper { verb: "blocking", detail: e.to_string() }
}

/// One reader per stream, into a buffer capped at the protocol's exec output cap; true where the cap was reached
/// and bytes were dropped, which is what the caller answers `truncated` off.
async fn read_into<R: AsyncRead + Unpin>(pipe: Option<R>, out: &Mutex<Vec<u8>>) -> bool {
    let Some(mut pipe) = pipe else { return false };
    let mut buf = vec![0u8; 16 * 1024];
    let mut cut = false;
    while let Ok(n) = pipe.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut held = out.lock().unwrap_or_else(|e| e.into_inner());
        let room = numbers::EXEC_OUTPUT_MAX.saturating_sub(held.len());
        cut = cut || n > room;
        held.extend_from_slice(&buf[..n.min(room)]);
    }
    cut
}

/// In the helper process: youki's create for the bundle, detached, on the plain cgroup manager. The network
/// namespace it made is empty but for a downed loopback; the daemon fills it once the init's pid is known.
pub fn helper_create(root: &Path, id: &str) -> Result<(), Error> {
    let layout = Layout::new(root);
    let state = layout.state();
    fs::create_dir_all(&state).map_err(io_at(&state))?;
    // The init's stdio is its own, never this process's pipes: an init holding them would keep the daemon waiting
    // for the helper's output after the helper exited.
    let null = fs::File::open("/dev/null").map_err(io_at(Path::new("/dev/null")))?;
    let log_path = layout.boot_log(id);
    let log = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(io_at(&log_path))?;
    let log_err = log.try_clone().map_err(io_at(&log_path))?;
    let c = ContainerBuilder::new(id.to_owned(), SyscallType::default())
        .with_root_path(&state)
        .map_err(container)?
        .validate_id()
        .map_err(container)?
        .with_stdin(null)
        .with_stdout(log)
        .with_stderr(log_err)
        .as_init(layout.workspace(id))
        .with_systemd(false)
        .with_detach(true)
        .build()
        .map_err(container)?;
    c.pid().ok_or_else(|| Error::Container("youki created the container without a pid".into()))?;
    Ok(())
}

/// In the helper process: the command as a tenant of the workspace behind its seccomp filter, its stdio inherited
/// from this process, waited for; past the deadline its group is killed and the answer is 124. Answers the exit
/// code to exit with.
pub fn helper_exec(root: &Path, id: &str, args: Vec<String>, timeout: Option<Duration>, pid_file: Option<PathBuf>) -> Result<i32, Error> {
    let layout = Layout::new(root);
    let fence = Fenced::read(&layout.config(id))?;
    let tenant = ContainerBuilder::new(id.to_owned(), SyscallType::default())
        .with_root_path(layout.state())
        .map_err(container)?
        .with_executor(fence)
        .with_pid_file(pid_file)
        .map_err(container)?
        .as_tenant()
        .with_container_args(args)
        .with_detach(false)
        .build()
        .map_err(container)?;
    let pid = Pid::from_raw(tenant.as_raw());
    // A person's shell has no deadline; every other command inside carries the exec road's own.
    let deadline = timeout.map(|timeout| {
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            // The tenant is its own session, so its group is what its children share.
            let _ = killpg(pid, Signal::SIGKILL);
            let _ = kill(pid, Signal::SIGKILL);
        })
    });
    let code = loop {
        match waitpid(pid, None) {
            Ok(WaitStatus::Exited(_, code)) => break code,
            Ok(WaitStatus::Signaled(_, signal, _)) => {
                break match deadline.as_ref().is_some_and(std::thread::JoinHandle::is_finished) {
                    true => numbers::EXEC_DEADLINE_EXIT,
                    false => 128 + signal as i32,
                };
            }
            Ok(_) | Err(nix::Error::EINTR) => continue,
            Err(e) => return Err(Error::Container(format!("waiting for the tenant: {e}"))),
        }
    };
    remove_stale_notify_sockets(&layout.state_of(id));
    Ok(code)
}

/// How the helper stands and what it said, for the sentence a pane is given when no terminal came back: whether
/// it ended and with what, and whatever it printed on the pipe a refusal of the workspace's own lands on. One
/// still running is ended here, since its stderr reads to the end only once it is gone.
async fn helper_said(helper: &mut tokio::process::Child) -> String {
    let ended = match helper.try_wait() {
        Ok(Some(status)) => format!("the helper ended {status}"),
        Ok(None) => {
            let _ = helper.start_kill();
            "the helper was still running".to_owned()
        }
        Err(e) => format!("the helper's state is unreadable: {e}"),
    };
    let mut said = String::new();
    if let Some(mut pipe) = helper.stderr.take() {
        let _ = tokio::time::timeout(HELPER_LAST_WORDS, pipe.read_to_string(&mut said)).await;
    }
    match said.trim() {
        "" => format!("{ended} and printed nothing"),
        printed => format!("{ended} and printed: {printed}"),
    }
}

/// The workspace's seccomp filter, read off its config.json and carried into the tenant process, where it is loaded
/// right before the command runs, once the tenant holds the workspace's capabilities and the no-new-privileges bit
/// youki sets on every tenant, which is what lets the load go through without a privilege. A kernel that refuses
/// the filter refuses the exec: the command never runs unfenced. A filter with a rule whose action is notify is
/// refused before any tenant is cloned: its load hands back a notify fd that only a listener could answer, no exec
/// serves one, and the first notified call would hold the command for good.
#[derive(Clone, Debug)]
struct Fenced {
    seccomp: LinuxSeccomp,
}

impl Fenced {
    fn read(config: &Path) -> Result<Fenced, Error> {
        let spec = Spec::load(config).map_err(container)?;
        let Some(seccomp) = spec.linux().as_ref().and_then(|l| l.seccomp().clone()) else {
            return Err(Error::Container(format!("{} names no seccomp filter", config.display())));
        };
        if seccomp::is_notify(&seccomp) {
            return Err(Error::Container(NOTIFY_REFUSAL.to_owned()));
        }
        Ok(Fenced { seccomp })
    }
}

impl Executor for Fenced {
    fn validate(&self, spec: &Spec) -> Result<(), ExecutorValidationError> {
        DefaultExecutor {}.validate(spec)
    }

    fn exec(&self, spec: &Spec) -> Result<(), ExecutorError> {
        seccomp::initialize_seccomp(&self.seccomp).map_err(|e| ExecutorError::Other(filter_refusal(&described(&e))))?;
        DefaultExecutor {}.exec(spec)
    }
}

/// The one sentence an exec is refused with when the kernel will not take the workspace's filter.
fn filter_refusal(detail: &str) -> String {
    format!("this computer's kernel refused the workspace's seccomp filter for the exec, so the command did not run: {detail}")
}

/// youki leaves each tenant's notify socket in the state directory; the ones older than any exec still starting go.
fn remove_stale_notify_sockets(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(TENANT_NOTIFY) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE_NOTIFY);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// What a helper's failure prints before it exits `HELPER_FAILED`.
pub fn helper_failure_line(e: &Error) -> String {
    format!("{HELPER_PREFIX}{e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The flag `Exec.truncated` rides on, read where it is set: true only where bytes were dropped. At the cap
    /// less one byte nothing was, at the cap itself nothing was either, and one byte past it something was.
    #[tokio::test]
    async fn a_read_says_it_cut_only_where_bytes_were_dropped() {
        let read = async |bytes: usize| -> (bool, usize) {
            let held = vec![b'a'; bytes];
            let out = Mutex::new(Vec::new());
            let cut = read_into(Some(&held[..]), &out).await;
            (cut, out.into_inner().unwrap_or_else(|e| e.into_inner()).len())
        };
        assert_eq!(read(numbers::EXEC_OUTPUT_MAX - 1).await, (false, numbers::EXEC_OUTPUT_MAX - 1));
        assert_eq!(read(numbers::EXEC_OUTPUT_MAX).await, (false, numbers::EXEC_OUTPUT_MAX));
        assert_eq!(read(numbers::EXEC_OUTPUT_MAX + 1).await, (true, numbers::EXEC_OUTPUT_MAX));
        // A stream that says nothing at all is nothing cut.
        assert_eq!(read(0).await, (false, 0));
    }

    /// What an exec past the output cap does to the command that printed it: nothing. The reader keeps the cap's
    /// worth and goes on reading to the end, so the command is never handed a closed pipe, prints no complaint of
    /// its own and exits as it meant to. A diff inside past the cap is this: cut in the answer, quiet at the far
    /// end, and said to be cut by the flag rather than by a broken pipe in somebody's stderr.
    #[tokio::test]
    async fn a_read_past_the_cap_keeps_draining_so_the_command_ends_quietly() {
        let line = "a line of a file that is about to be large";
        let lines = numbers::EXEC_OUTPUT_MAX / line.len() + 1000;
        let mut cmd = Command::new("awk");
        cmd.arg(format!("BEGIN {{ for (i = 0; i < {lines}; i++) print \"{line}\" }}"));
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("awk is on this computer");
        let (out, err) = (Mutex::new(Vec::new()), Mutex::new(Vec::new()));
        let (cut_out, cut_err, ended) =
            tokio::join!(read_into(child.stdout.take(), &out), read_into(child.stderr.take(), &err), child.wait());
        assert!(cut_out, "the cap was not reached");
        assert!(!cut_err);
        assert_eq!(out.into_inner().unwrap_or_else(|e| e.into_inner()).len(), numbers::EXEC_OUTPUT_MAX);
        assert!(err.into_inner().unwrap_or_else(|e| e.into_inner()).is_empty(), "the command printed a complaint of its own");
        assert!(ended.unwrap().success(), "the command was cut off rather than left to finish");
    }

    #[test]
    fn a_workspace_with_no_state_directory_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path(), PathBuf::from("/bin/true"));
        assert_eq!(runtime.status("wsp-none").unwrap(), Status::Gone);
        assert_eq!(runtime.init_pid("wsp-none").unwrap(), None);
    }

    #[test]
    fn a_process_is_known_by_its_pid_start_time_and_boot_and_a_stat_line_is_read_past_the_command_name() {
        assert_eq!(
            start_ticks("7 (sleep) S 1 7 7 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 424242 8000 200 18446744073709551615").unwrap(),
            424242
        );
        assert_eq!(start_ticks("8 (a (weird) name) S 1 8 8 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 99 8000 200 1").unwrap(), 99);
        assert!(start_ticks("no parentheses here").is_err());
        let own = identity_of(std::process::id() as i32).unwrap();
        assert!(alive(&own));
        assert!(!alive(&Init { started: own.started + 1, ..own.clone() }));
        assert!(!alive(&Init { boot_id: "another boot".into(), ..own.clone() }));
        assert!(!alive(&Init { pid: 4_194_303, ..own }));
    }

    /// Which pid the stop holds back to the end with the init, on this process standing in for one: the oldest
    /// child and not any child, since a process a turn backgrounded and lost is reparented onto the init too and
    /// those are the ones the stop asks to end first.
    #[test]
    fn the_boot_command_is_the_oldest_child_the_init_has_and_not_a_turns_own() {
        let me = std::process::id() as i32;
        // The stand-in for the boot command, started first, and one for a process a turn left behind, started
        // after it. Two clock ticks apart at the coarsest tick a kernel counts in, since the rule reads age.
        let mut boot = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        std::thread::sleep(Duration::from_millis(80));
        let mut of_a_turn = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let (booted, turned) = (boot.id() as i32, of_a_turn.id() as i32);
        // In whatever order the cgroup hands them over, and with the init among them.
        assert_eq!(boot_child(&[turned, me, booted], me), Some(booted));
        assert_eq!(boot_child(&[booted, turned], me), Some(booted));
        // The parent is what makes one a candidate: a pid of nobody's child here is not the init's boot command.
        assert_eq!(boot_child(&[me, 1], me), None);
        assert_eq!(boot_child(&[me], me), None);
        assert_eq!(boot_child(&[], me), None);
        // And what the two reads answer for a live process of ours: the parent is this process and the start
        // time is the one the identity is read from.
        let (parent, started) = parent_and_start(booted).unwrap();
        assert_eq!(parent, me);
        assert_eq!(started, identity_of(booted).unwrap().started);
        for child in [&mut boot, &mut of_a_turn] {
            let _ = child.kill();
            let _ = child.wait();
        }
        // A pid nothing holds answers nothing rather than failing the stop that reads it.
        assert_eq!(parent_and_start(4_194_303), None);
    }

    /// A process's one child, waited for: what a shell that backgrounds a sleep and waits for it leaves behind,
    /// which is the shape of an init and its boot command. Read off /proc by the parent link, as the rule does.
    fn child_of(parent: i32, patience: Duration) -> Option<i32> {
        let deadline = Instant::now() + patience;
        loop {
            let found = fs::read_dir("/proc")
                .ok()?
                .flatten()
                .filter_map(|e| e.file_name().to_string_lossy().parse::<i32>().ok())
                .find(|pid| parent_and_start(*pid).is_some_and(|(held, _)| held == parent));
            if found.is_some() || Instant::now() >= deadline {
                return found;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Waits for what a poll can see, and says where it gave up.
    fn wait_until(what: &str, patience: Duration, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + patience;
        while !done() {
            assert!(Instant::now() < deadline, "{what} did not happen in {} ms", patience.as_millis());
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The wait signals what appears while it runs, not only the listing its first pass read, and it never
    /// signals the init or the one child the init started: a workspace still coming up puts its own boot command
    /// in the cgroup after a stop that arrived early has read it, and a process nobody signalled is one the wait
    /// holds to the deadline, which a box measured as every pause costing the whole patience.
    ///
    /// The cgroup here is a directory this case writes as the kernel would, and the pids in it are real
    /// processes of its own, so what the stop sends them is what ends them.
    #[test]
    fn the_wait_signals_what_appears_while_it_runs_and_holds_back_the_init_and_its_child() {
        let dir = tempfile::tempdir().unwrap();
        let procs = dir.path().join("cgroup.procs");
        // The init and the one child it started, which are the two the stop leaves for last.
        let mut init = std::process::Command::new("sh").args(["-c", "sleep 30 & wait"]).spawn().unwrap();
        let init_pid = init.id() as i32;
        let boot = child_of(init_pid, Duration::from_secs(2)).expect("the stand-in init started no child");
        // Two processes of a turn's, neither of them a child of the init: one in the first listing, one that
        // appears while the wait runs.
        let mut first = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let mut second = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let (turn_one, turn_two) = (first.id() as i32, second.id() as i32);
        let listing = |pids: &[i32]| fs::write(&procs, pids.iter().map(|pid| format!("{pid}\n")).collect::<String>()).unwrap();
        listing(&[init_pid, boot, turn_one]);

        let cgroup = dir.path().to_path_buf();
        let stopping = std::thread::spawn(move || term_under(&cgroup, Some(init_pid), Duration::from_secs(5)));
        // The first pass asks the turn's process to end, and asks neither of the other two.
        wait_until("the first pass signalled the turn's process", Duration::from_secs(2), || first.try_wait().unwrap().is_some());
        assert!(Path::new(&format!("/proc/{boot}")).exists(), "the boot command was signalled with the turn's processes");
        assert!(init.try_wait().unwrap().is_none(), "the init was signalled before the wait was done");

        // One that appears after that listing: nothing signalled it before this fix, and the wait then held to
        // the deadline for it.
        listing(&[init_pid, boot, turn_two]);
        wait_until("the wait signalled the process that appeared", Duration::from_secs(2), || second.try_wait().unwrap().is_some());
        assert!(init.try_wait().unwrap().is_none(), "the init was signalled while a turn's process was still there");

        // Nothing left but the pair: the wait ends and the init takes the signal it forwards to its child.
        listing(&[init_pid, boot]);
        wait_until("the init was signalled last", Duration::from_secs(2), || init.try_wait().unwrap().is_some());
        // And the cgroup empty, which is what the second wait reads.
        listing(&[]);
        assert!(stopping.join().unwrap().is_ok());
        // The child of a shell that has gone is nobody's to wait for, so it is ended by the pid this case
        // started it under.
        let _ = kill(Pid::from_raw(boot), Signal::SIGKILL);
    }

    /// What a create waits for before it answers ready: the boot command in the cgroup, the sentence where the
    /// first process ends without starting anything, and the sentence where it starts nothing at all.
    #[test]
    fn the_boot_is_not_ready_until_the_first_process_has_started_the_boot_command() {
        let dir = tempfile::tempdir().unwrap();
        let procs = dir.path().join("cgroup.procs");
        let mut init = std::process::Command::new("sh").args(["-c", "sleep 30 & wait"]).spawn().unwrap();
        let init_pid = init.id() as i32;
        let boot = child_of(init_pid, Duration::from_secs(2)).expect("the stand-in init started no child");
        let identity = identity_of(init_pid).unwrap();

        // The window a box measured: for a sixth of a second the cgroup holds the first process alone. The wait
        // answers the child once it is there rather than the moment the start returned.
        fs::write(&procs, format!("{init_pid}\n")).unwrap();
        let writing = procs.clone();
        let appears = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            fs::write(&writing, format!("{init_pid}\n{boot}\n")).unwrap();
        });
        assert_eq!(boot_child_in(dir.path(), &identity, Duration::from_secs(5)).unwrap(), boot);
        appears.join().unwrap();

        // A first process that ended without starting anything says so at once rather than waiting out the
        // patience, since nothing is coming.
        let gone = Init { pid: i32::MAX, started: 0, boot_id: String::new() };
        let said = boot_child_in(dir.path(), &gone, Duration::from_secs(30)).unwrap_err().to_string();
        assert_eq!(said, "the workspace's first process ended before it started anything");

        // And one that is there and starts nothing is the patience and then its own sentence.
        fs::write(&procs, format!("{init_pid}\n")).unwrap();
        let waited = Instant::now();
        let said = boot_child_in(dir.path(), &identity, Duration::from_secs(1)).unwrap_err().to_string();
        assert!(waited.elapsed() >= Duration::from_secs(1), "{} ms", waited.elapsed().as_millis());
        assert_eq!(said, "the workspace's first process started nothing in 1 s, so there is nothing running inside it");

        let _ = init.kill();
        let _ = init.wait();
        let _ = kill(Pid::from_raw(boot), Signal::SIGKILL);
    }

    #[test]
    fn stale_notify_sockets_go_and_fresh_ones_stay() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("tenant-notify-old");
        let fresh = dir.path().join("tenant-notify-fresh");
        let other = dir.path().join("state.json");
        for p in [&old, &fresh, &other] {
            fs::write(p, "").unwrap();
        }
        let long_ago = SystemTime::now() - Duration::from_secs(120);
        fs::File::open(&old).unwrap().set_modified(long_ago).unwrap();
        fs::File::open(&other).unwrap().set_modified(long_ago).unwrap();
        remove_stale_notify_sockets(dir.path());
        assert!(!old.exists() && fresh.exists() && other.exists());
    }

    /// A workspace's config.json under a runtime root, as the ops write it, with the profile's filter.
    fn write_config(root: &Path, id: &str) -> serde_json::Value {
        let layout = Layout::new(root);
        fs::create_dir_all(layout.workspace(id)).unwrap();
        let args = vec!["/sbin/wsp-init".to_owned()];
        let spec = crate::bundle::config_json(&crate::bundle::Config {
            hostname: id,
            args: &args,
            envs: &std::collections::BTreeMap::new(),
            cpu: None,
            mem_mb: None,
            cgroup: &layout.cgroup_name(id),
            init: Path::new("/usr/local/bin/wsp-daemon"),
            etc: &layout.etc(id),
            engine: None,
            shares: &[],
            binds: &[],
            tool_roots: &[],
            compose_project: None,
        });
        crate::bundle::write_json(&layout.config(id), &spec).unwrap();
        spec
    }

    #[test]
    fn the_fence_is_read_off_the_workspaces_config_and_a_config_without_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let config = Layout::new(dir.path()).config("wsp-a");
        let spec = write_config(dir.path(), "wsp-a");
        let fence = Fenced::read(&config).unwrap();
        assert_eq!(fence.seccomp.syscalls().as_ref().unwrap().len(), 15);
        assert_eq!(fence.seccomp.architectures().as_ref().unwrap().len(), 3);
        let mut bare = spec.clone();
        bare["linux"].as_object_mut().unwrap().remove("seccomp");
        crate::bundle::write_json(&config, &bare).unwrap();
        let refused = Fenced::read(&config).unwrap_err().to_string();
        assert!(refused.ends_with("config.json names no seccomp filter"), "{refused}");
        assert_eq!(
            filter_refusal("failed to load seccomp context"),
            "this computer's kernel refused the workspace's seccomp filter for the exec, so the command did not run: failed to load seccomp context"
        );
    }

    #[test]
    fn a_filter_with_a_notify_action_refuses_the_exec_before_any_tenant_is_cloned() {
        let dir = tempfile::tempdir().unwrap();
        let mut spec = write_config(dir.path(), "wsp-n");
        let rules = spec["linux"]["seccomp"]["syscalls"].as_array_mut().unwrap();
        rules.push(serde_json::json!({ "names": ["getcwd"], "action": "SCMP_ACT_NOTIFY" }));
        let config = Layout::new(dir.path()).config("wsp-n");
        crate::bundle::write_json(&config, &spec).unwrap();
        // The predicate the read refuses on is the one the load hands a notify fd back for.
        assert!(seccomp::is_notify(Spec::load(&config).unwrap().linux().as_ref().unwrap().seccomp().as_ref().unwrap()));
        assert_eq!(Fenced::read(&config).unwrap_err().to_string(), NOTIFY_REFUSAL);
        // The helper road: no youki state exists under this root, so a refusal that reads as anything but the
        // notify sentence would be youki's, asked after the read.
        let refused = helper_exec(dir.path(), "wsp-n", vec!["true".to_owned()], Some(Duration::from_secs(1)), None).unwrap_err();
        assert_eq!(helper_failure_line(&refused), format!("wsp-runtime: {NOTIFY_REFUSAL}"));
    }

    #[test]
    fn a_helper_failure_line_carries_the_prefix_the_daemon_reads() {
        let line = helper_failure_line(&Error::Container("no such container".into()));
        assert_eq!(line, "wsp-runtime: no such container");
        assert_eq!(line.strip_prefix(HELPER_PREFIX), Some("no such container"));
    }
}
