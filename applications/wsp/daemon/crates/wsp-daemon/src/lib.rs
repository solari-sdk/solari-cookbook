// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon server. Every socket, inbound or the link a place opened, passes one door: the auth frame first,
//! checked against the token file as it is at that moment, then the op switch. Nothing is served before the door
//! passes a socket and nothing here binds anything but the address it was told.

mod auth;
mod bring_back;
mod clock;
mod door;
mod exec;
mod fs;
mod git;
mod guest;
mod hosts;
mod inbox;
mod link;
mod manifest;
mod mode;
mod ops;
mod paths;
mod place;
mod ports;
mod proc;
mod proc_local;
mod pty;
mod readings;
mod relay;
/// The seal a place link agrees in its handshake. Public so the suite that drives both ends of a link can
/// stand on the host's side of it, which in the product is node's own.
pub mod seal;
mod sys;
mod sys_local;
mod tunnel;
mod urls;

pub use link::place_backoff_ms;

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::{TcpListener, UnixListener};
use tokio::sync::mpsc;
use wsp_frames::{numbers, DaemonEvent};

use crate::paths::OpError;

/// What a daemon is started with: one field per flag the binary takes, so the harness and the deploy scripts spell
/// one thing. Fields the door does not read yet are held for the modules that will.
#[derive(Debug, Clone)]
pub struct Options {
    pub host: String,
    pub port: u16,
    /// The token file, read at every auth frame so the host can rotate it while the daemon runs.
    pub token_path: PathBuf,
    /// The directory every fs and git path resolves inside; HOME when absent.
    pub root: Option<PathBuf>,
    pub roots_path: Option<PathBuf>,
    /// Which kind of machine this daemon serves, which picks the modules its readings come from. A word rather than
    /// the enum: a kind the registry lacks is refused at the watch, in the words the pane prints, not at start.
    pub kind: String,
    pub work_folder: Option<PathBuf>,
    pub inbox_dir: Option<PathBuf>,
    pub inbox_quiet_ms: Option<u64>,
    pub inbox_poll_ms: Option<u64>,
    pub manifest_path: Option<PathBuf>,
    pub run_dir: Option<PathBuf>,
    pub log_dir: Option<PathBuf>,
    pub open_socket_path: Option<PathBuf>,
    pub proc_root: Option<PathBuf>,
    pub passwd_path: Option<PathBuf>,
    pub ports_interval_ms: Option<u64>,
    pub sys_interval_ms: Option<u64>,
    pub proc_interval_ms: Option<u64>,
    pub mode_interval_ms: Option<u64>,
    pub auth_deadline_ms: Option<u64>,
    /// How long a guest session stands with nobody watching it before it ends to its guest.
    pub guest_unwatched_ms: Option<u64>,
    /// How often the token watcher reads the file; the rule's own second unless a case shortens it.
    pub token_watch_ms: Option<u64>,
    pub place_file: Option<PathBuf>,
    /// The PATH this daemon's unit handed it, read once at start before the probe list took its place. A place
    /// daemon runs nothing on it; the report carries it as what the person's login shell gives, and the presence
    /// read looks along it, since reading that a tool stands somewhere runs nothing.
    pub unit_path: Option<String>,
    pub home: Option<PathBuf>,
    pub wsp_argv: Vec<String>,
    pub agents: Vec<String>,
    pub link_connect_ms: Option<u64>,
    pub link_quiet_ms: Option<u64>,
    pub link_refused_retry_ms: Option<u64>,
    pub link_backoff_ms: Option<u64>,
    /// Where a place's daemon keeps the layers and the workspaces it runs.
    pub runtime_root: Option<PathBuf>,
    /// The binary the workspace runtime runs as its helper and as every workspace's init: this process's own where
    /// nothing names one, which is the daemon binary in every place a daemon runs. A test opens a daemon inside its
    /// own process, whose executable is the test and not a daemon, so it names the daemon binary it was built
    /// beside; nothing on a machine names it, so nothing on a machine behaves differently for it being here.
    pub runtime_helper: Option<PathBuf>,
}

impl Options {
    /// The in-guest shape: 0.0.0.0:7070, the guest token file, a cloud machine.
    pub fn new(token_path: impl Into<PathBuf>) -> Options {
        Options {
            host: numbers::DEFAULT_HOST.to_owned(),
            port: numbers::DEFAULT_PORT,
            token_path: token_path.into(),
            root: None,
            roots_path: None,
            kind: "cloud".to_owned(),
            work_folder: None,
            inbox_dir: None,
            inbox_quiet_ms: None,
            inbox_poll_ms: None,
            manifest_path: None,
            run_dir: None,
            log_dir: None,
            open_socket_path: None,
            proc_root: None,
            passwd_path: None,
            ports_interval_ms: None,
            sys_interval_ms: None,
            proc_interval_ms: None,
            mode_interval_ms: None,
            auth_deadline_ms: None,
            guest_unwatched_ms: None,
            token_watch_ms: None,
            place_file: None,
            unit_path: None,
            home: None,
            wsp_argv: Vec::new(),
            agents: Vec::new(),
            link_connect_ms: None,
            link_quiet_ms: None,
            link_refused_retry_ms: None,
            link_backoff_ms: None,
            runtime_root: None,
            runtime_helper: None,
        }
    }
}

/// Every frame the daemon writes is one JSON object; serialising the wire types cannot fail.
pub(crate) fn frame_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("a frame serialises")
}

/// One item on a socket's outbound channel: a frame to write, or the last reply of an op that ends this daemon,
/// after which the loop stops. A leave ends it for good; an update ends it so whatever supervises it starts the
/// binary the host just sent.
pub(crate) enum Outgoing {
    Text(String),
    /// A guest frame and the bytes it holds against its workspace: the count goes back once the frame is written,
    /// and with the frame if the channel it waits on is dropped, so what the cap counts is what is really waiting.
    Guest(String, guest::GuestBytes),
    Leave(String),
    Restart(String),
    /// The token this socket authed with is no longer the file's: it is closed 4401 with one sentence and nothing
    /// else of this daemon's ends.
    Rotated,
}

impl Outgoing {
    #[cfg(test)]
    pub(crate) fn text(&self) -> &str {
        match self {
            Outgoing::Text(t) | Outgoing::Guest(t, _) | Outgoing::Leave(t) | Outgoing::Restart(t) => t,
            Outgoing::Rotated => wsp_frames::words::AUTH_TOKEN_ROTATED,
        }
    }
}

/// The way frames reach one socket from anywhere in the daemon: its serve loop writes what arrives here, in order,
/// so a handler's events and its reply cannot cross.
#[derive(Clone)]
pub(crate) struct Outbound(pub(crate) mpsc::UnboundedSender<Outgoing>);

impl Outbound {
    /// False once the socket is gone, which is how a listener learns it may be dropped.
    pub(crate) fn send_text(&self, text: &str) -> bool {
        self.0.send(Outgoing::Text(text.to_owned())).is_ok()
    }

    pub(crate) fn send(&self, out: Outgoing) -> bool {
        self.0.send(out).is_ok()
    }

    pub(crate) fn send_event(&self, event: &DaemonEvent) -> bool {
        self.send_text(&frame_text(event))
    }
}

/// One line of the daemon's log, as the binary prints it on stderr and the suite reads it.
pub type Log = Box<dyn Fn(&str) + Send + Sync>;
/// The same log where more than one holder writes to it: the samplers log their start and stop.
pub(crate) type SharedLog = Arc<dyn Fn(&str) + Send + Sync>;

/// One socket's interest in a pty's data, its exit or its mode; the key is what detaches it when the socket closes.
pub(crate) struct Listener {
    pub(crate) key: u64,
    pub(crate) out: Outbound,
}

/// What every socket's handler reads: the options as given, the root the hello announces, the ptys and their mode
/// watcher, and every authed unscoped socket for the events the daemon pushes without being asked.
pub(crate) struct Ctx {
    pub(crate) options: Options,
    pub(crate) root: String,
    pub(crate) auth_deadline: Duration,
    pub(crate) ptys: Mutex<pty::PtyManager>,
    pub(crate) modes: Arc<mode::ModeWatcher>,
    pub(crate) manifest: Mutex<manifest::ProcessManifest>,
    pub(crate) spotter: Mutex<relay::CallbackSpotter>,
    pub(crate) ports: ports::PortWatch,
    pub(crate) inbox: inbox::InboxWatch,
    /// The guest sessions open on this machine, and the socket the host watches them from.
    pub(crate) guests: Arc<guest::Guests>,
    /// Where the daemon's lines go: stderr in the binary, a test's own list otherwise.
    log: SharedLog,
    /// The two samplers, built on the first watch so a daemon nobody asks reads nothing; one each for the daemon.
    sys: Mutex<Option<Arc<sys::SysSampler>>>,
    procs: Mutex<Option<Arc<proc::ProcSampler>>>,
    /// Told once a leave has been answered, which is what ends the daemon.
    pub(crate) stop: tokio::sync::Notify,
    /// The workspaces a place's daemon runs and answers the machine ops on its link with; none where no place file
    /// turned the link on or the runtime root could not be opened.
    #[cfg(target_os = "linux")]
    pub(crate) runtime: Option<Arc<wsp_runtime::ops::Ops>>,
    /// Why there is no runtime, where the root it was given is the reason: the doctor's reading of that root,
    /// which every machine op answers instead of the line that names the op alone. None for every other reason,
    /// where the log carries it and the ops name the op, as they always have.
    #[cfg(target_os = "linux")]
    pub(crate) runtime_refusal: Option<String>,
    authed: Mutex<HashMap<u64, Outbound>>,
    /// Every socket that came through the door on a token, by its key: what it authed with and how to reach it.
    /// The broadcast list above is not this one, since a port-scoped socket hears no events and still holds a
    /// token a rotation has to take away.
    tokened: Mutex<HashMap<u64, (String, Outbound)>>,
    /// The door this daemon holds inside each workspace it runs, by workspace: the accept loop and the socket
    /// file it binds, which sits in that workspace's own wsp folder and so inside that workspace alone.
    workspace_doors: Mutex<HashMap<String, WorkspaceDoor>>,
    keys: AtomicU64,
}

/// One workspace's door: the task accepting on the socket inside that workspace, which a stop ends, and the
/// sockets that door is serving right now, which is what the cap on it is read against.
pub(crate) struct WorkspaceDoor {
    task: tokio::task::JoinHandle<()>,
    sockets: Arc<AtomicUsize>,
}

impl Ctx {
    /// Reads the manifest file once; a manifest that is there but cannot be read refuses the start, as it does for
    /// the node daemon.
    /// The port is the runtime's, and no workspace runs where there is no runtime.
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
    pub(crate) fn new(options: Options, log: Log, daemon_port: u16) -> io::Result<Ctx> {
        let root = resolved_root(options.root.as_deref());
        let auth_deadline = Duration::from_millis(options.auth_deadline_ms.unwrap_or(numbers::AUTH_DEADLINE_MS));
        let proc_root = options.proc_root.clone().unwrap_or_else(|| PathBuf::from("/proc"));
        let interval = options.mode_interval_ms.map_or(mode::DEFAULT_INTERVAL, Duration::from_millis);
        let modes = Arc::new(mode::ModeWatcher::new(mode::linux_mode_probe(&proc_root), interval));
        let manifest_path = options.manifest_path.clone().unwrap_or_else(|| PathBuf::from(numbers::DEFAULT_MANIFEST_PATH));
        let manifest = manifest::ProcessManifest::load(Some(manifest_path), options.run_dir.as_deref(), options.log_dir.as_deref())?;
        let interval = options.ports_interval_ms.map_or(ports::DEFAULT_INTERVAL, Duration::from_millis);
        let ports = ports::PortWatch::new(ports::source_for(options.proc_root.as_deref()), interval);
        let guest_unwatched = Duration::from_millis(options.guest_unwatched_ms.unwrap_or(numbers::GUEST_UNWATCHED_MS));
        #[cfg(target_os = "linux")]
        let (runtime, runtime_refusal) = open_runtime(&options, &log, daemon_port);
        Ok(Ctx {
            options,
            root,
            auth_deadline,
            ptys: Mutex::new(pty::PtyManager::default()),
            modes,
            manifest: Mutex::new(manifest),
            spotter: Mutex::new(relay::CallbackSpotter::new()),
            ports,
            inbox: inbox::InboxWatch::default(),
            guests: Arc::new(guest::Guests::new(guest_unwatched)),
            log: Arc::from(log),
            sys: Mutex::new(None),
            procs: Mutex::new(None),
            stop: tokio::sync::Notify::new(),
            #[cfg(target_os = "linux")]
            runtime,
            #[cfg(target_os = "linux")]
            runtime_refusal,
            authed: Mutex::new(HashMap::new()),
            tokened: Mutex::new(HashMap::new()),
            workspace_doors: Mutex::new(HashMap::new()),
            keys: AtomicU64::new(1),
        })
    }

    pub(crate) fn log(&self, line: &str) {
        (self.log)(line);
    }

    /// One workspace of this computer's is working, so its quiet clock starts over: what a pty inside it says on
    /// every keystroke and every chunk it prints. Nothing on a daemon that runs no workspace.
    pub(crate) fn workspace_touched(&self, machine: &str) {
        #[cfg(target_os = "linux")]
        if let Some(runtime) = &self.runtime {
            runtime.touched(machine);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = machine;
    }

    /// Whether this daemon is a computer's own rather than one inside a machine, which is what the guest roads
    /// table reads: the same fact the workspace runtime is opened on.
    pub(crate) fn is_place(&self) -> bool {
        self.options.place_file.is_some()
    }

    /// The door inside one workspace, on the path the runtime names for it: a file in the folder of that
    /// workspace's own that is mounted over the wsp folder inside it. The file itself is the gate, since it is in
    /// that workspace's mount namespace and in no other's, and a process inside reaches the two guest ops through
    /// it and no more. A door already held for this workspace is replaced, which is what a boot after a daemon
    /// restart finds.
    pub(crate) fn open_workspace_door(self: &Arc<Self>, id: &str, at: &Path) {
        let at = at.to_path_buf();
        let listener = match relay::listen_open_socket(&at) {
            Ok(listener) => listener,
            Err(e) => return self.log(&format!("workspace {id} has no door inside it: {}: {e}", at.display())),
        };
        // Root on this computer owns it and nothing else here may open it; inside, the workspace's own root is
        // the only one that can see it at all.
        if let Err(e) = std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o600)) {
            return self.log(&format!("workspace {id} has no door inside it: {}: {e}", at.display()));
        }
        let ctx = Arc::clone(self);
        let workspace = id.to_owned();
        let mut doors = self.workspace_doors.lock().unwrap_or_else(|e| e.into_inner());
        // The count is the workspace's own and not one door's: a door replaced after this daemon restarted takes
        // the count on, since the sockets the one before it is serving are still that workspace's sockets.
        let sockets = doors.get(id).map_or_else(|| Arc::new(AtomicUsize::new(0)), |held| Arc::clone(&held.sockets));
        let task = tokio::spawn(door::serve_workspace(listener, ctx, workspace, Arc::clone(&sockets)));
        if let Some(old) = doors.insert(id.to_owned(), WorkspaceDoor { task, sockets }) {
            old.task.abort();
        }
    }

    /// The door goes with the workspace it was inside: this ends the loop, and the file it was bound on is the
    /// runtime's to take off, since the folder it sits in is the workspace's own and a workspace may be stopped
    /// by something other than the daemon that bound it.
    pub(crate) fn close_workspace_door(&self, id: &str) {
        let held = self.workspace_doors.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        if let Some(door) = held {
            door.task.abort();
        }
    }

    /// The file naming the folders beyond the root that ops may reach, which are the project folders.
    pub(crate) fn roots_path(&self) -> PathBuf {
        self.options.roots_path.clone().unwrap_or_else(|| PathBuf::from(numbers::DAEMON_ROOTS_PATH))
    }

    /// What this machine's own two modules are built from; the kind picks which modules those are.
    fn readings_options(&self) -> readings::ReadingsOptions {
        readings::ReadingsOptions {
            root: PathBuf::from(&self.root),
            work_folder: self.options.work_folder.clone().unwrap_or_else(|| PathBuf::from(&self.root)),
            proc_root: self.options.proc_root.clone().unwrap_or_else(|| PathBuf::from("/proc")),
            passwd_path: self.options.passwd_path.clone().unwrap_or_else(|| PathBuf::from("/etc/passwd")),
            platform: std::env::consts::OS,
        }
    }

    /// The load sampler, or the refusal for a kind that reads neither of its readings.
    pub(crate) fn sys_sampler(&self) -> Result<Arc<sys::SysSampler>, OpError> {
        let mut held = self.sys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sampler) = held.as_ref() {
            return Ok(Arc::clone(sampler));
        }
        let kind = readings::readings_for(&self.options.kind, std::env::consts::OS)?;
        let interval = Duration::from_millis(self.options.sys_interval_ms.unwrap_or(numbers::SAMPLER_INTERVAL_MS));
        let sampler = sys::SysSampler::new((kind.metrics)(&self.readings_options()), interval, Arc::clone(&self.log));
        *held = Some(Arc::clone(&sampler));
        Ok(sampler)
    }

    /// The processes sampler, or the same refusal.
    pub(crate) fn proc_sampler(self: &Arc<Self>) -> Result<Arc<proc::ProcSampler>, OpError> {
        let mut held = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sampler) = held.as_ref() {
            return Ok(Arc::clone(sampler));
        }
        let kind = readings::readings_for(&self.options.kind, std::env::consts::OS)?;
        // An exited pty's pid can be reused by a stranger; only live shells carry the label. Weak, since the sampler
        // lives inside the context it reads.
        let ctx = Arc::downgrade(self);
        let ptys: proc::PtyPids =
            Arc::new(move || ctx.upgrade().map_or_else(Vec::new, |ctx| ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).labels()));
        let opts = proc::ProcSamplerOptions {
            self_pid: std::process::id(),
            ptys,
            interval: Duration::from_millis(self.options.proc_interval_ms.unwrap_or(numbers::SAMPLER_INTERVAL_MS)),
            now: Arc::new(sys::now_ms),
            log: Arc::clone(&self.log),
        };
        let sampler = proc::ProcSampler::new((kind.processes)(&self.readings_options()), opts);
        *held = Some(Arc::clone(&sampler));
        Ok(sampler)
    }

    /// A number no other socket or listener in this daemon has.
    pub(crate) fn next_key(&self) -> u64 {
        self.keys.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn add_authed(&self, key: u64, out: Outbound) {
        self.authed.lock().unwrap_or_else(|e| e.into_inner()).insert(key, out);
    }

    pub(crate) fn remove_authed(&self, key: u64) {
        self.authed.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        self.tokened.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    }

    /// Remembers what one socket came through the door with, so a rotation can find it again.
    pub(crate) fn add_tokened(&self, key: u64, token: String, out: Outbound) {
        self.tokened.lock().unwrap_or_else(|e| e.into_inner()).insert(key, (token, out));
    }

    /// Cuts every socket whose token is not the bytes the file holds now, compared in constant time. A socket
    /// that authed on the new token in the same breath as the rotation, which is how the host rotates and dials,
    /// holds those bytes and stays; the link and the sockets inside a workspace hold no token and are not here.
    pub(crate) fn cut_stale_tokens(&self, held: &str) {
        self.tokened.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, (token, out)| {
            if auth::same(token, held) {
                return true;
            }
            out.send(Outgoing::Rotated);
            false
        });
    }

    /// Pushed to every authed unscoped socket, not to subscribers: the host's link reconnects through the edge and
    /// would lose a subscription with it. A port-scoped socket is there to tunnel one port and hears none of it.
    pub(crate) fn broadcast(&self, event: &DaemonEvent) {
        let text = frame_text(event);
        self.authed.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, out| out.send_text(&text));
    }
}

/// A bound daemon: the listener is open and the address is known, nothing is accepted until run.
pub struct Daemon {
    listener: TcpListener,
    open_socket: Option<UnixListener>,
    ctx: Arc<Ctx>,
}

impl Daemon {
    /// Binds the address and reads the token file once, so a daemon with no token to check against never starts;
    /// binds the open socket too when one is named, so a shim that cannot be heard is a start that failed. Lines go
    /// to stderr.
    pub async fn bind(options: Options) -> io::Result<Daemon> {
        Daemon::bind_with(options, Box::new(|line| eprintln!("{line}"))).await
    }

    /// The same, with the log going where the caller says.
    pub async fn bind_with(mut options: Options, log: Log) -> io::Result<Daemon> {
        // Before the listener, before any task and before a single child of this process could exist: a daemon on
        // a computer that runs workspaces resolves every command it runs through the probe list and no other, since
        // the home it shares with its workspaces is written from inside them. Every child inherits it from here:
        // the exec handler's bash, the git and gh reads, each pty, the leave's sh, and every script the recipe job
        // sends. The unit's own PATH is kept for the report and the presence read, which run nothing.
        if options.place_file.is_some() {
            options.unit_path = Some(std::env::var("PATH").unwrap_or_default());
            std::env::set_var("PATH", wsp_frames::probe_path(&place::place_home(options.home.as_deref())));
        }
        if auth::current_token(&options.token_path).is_none() {
            return Err(io::Error::other(wsp_frames::words::NO_TOKEN_AT_START));
        }
        let listener = TcpListener::bind((options.host.as_str(), options.port)).await?;
        let open_socket = match &options.open_socket_path {
            Some(path) => Some(relay::listen_open_socket(path)?),
            None => None,
        };
        // The port the listener above actually bound, which is the one a workspace must not reach at its
        // gateway: the option may name zero and let the kernel pick.
        let daemon_port = listener.local_addr()?.port();
        let ctx = Arc::new(Ctx::new(options, log, daemon_port)?);
        #[cfg(target_os = "linux")]
        if let Some(runtime) = &ctx.runtime {
            if let Err(e) = runtime.restore().await {
                ctx.log(&format!("workspace forwards not restored: {e}"));
            }
            // From here the runtime names every boot and every stop, and every workspace already running is named
            // now, so a daemon that restarted under them holds a door inside each.
            if let Err(e) = runtime.watch(Arc::new(WorkspaceDoors(Arc::downgrade(&ctx)))) {
                ctx.log(&format!("workspaces have no doors inside them: {e}"));
            }
        }
        Ok(Daemon { listener, open_socket, ctx })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.listener.local_addr().expect("a bound listener has an address")
    }

    /// Accepts until a leave answered on the link ends the daemon; each socket gets its own task and its own door.
    /// A place file turns the outbound link on beside the listener.
    pub async fn run(self) -> io::Result<()> {
        if self.ctx.options.place_file.is_some() {
            let port = self.local_addr().port();
            tokio::spawn(link::run(Arc::clone(&self.ctx), port));
        }
        if let Some(open_socket) = self.open_socket {
            tokio::spawn(relay::serve_open_socket(open_socket, Arc::clone(&self.ctx)));
        }
        tokio::spawn(auth::watch(Arc::clone(&self.ctx)));
        let ctx = Arc::clone(&self.ctx);
        // A copy sits beside its project folder, so a removal a stop cut short is left in the folder a root sits in.
        std::thread::spawn(move || {
            if let Ok(roots) = paths::roots_now(Path::new(&ctx.root), &ctx.roots_path()) {
                let beside = wsp_runtime::copy_road::aside::beside(&roots[1..]);
                for failed in wsp_runtime::copy_road::aside::sweep(beside, |p| std::fs::remove_dir_all(p)) {
                    ctx.log(&failed.to_string());
                }
            }
        });
        loop {
            let accepted = tokio::select! {
                accepted = self.listener.accept() => accepted,
                _ = self.ctx.stop.notified() => return Ok(()),
            };
            let (stream, _) = accepted?;
            // As node's ws does: without it a pty's small frames sit behind the peer's delayed ACK, 40 ms measured.
            let _ = stream.set_nodelay(true);
            let ctx = Arc::clone(&self.ctx);
            tokio::spawn(door::serve(stream, ctx));
        }
    }
}

/// The workspace runtime a place's daemon serves on its link, under the runtime root, and where the root itself
/// is the reason there is none, the sentence that says so. A daemon that is not a place serves no runtime and
/// says nothing of the sort; a root this process cannot open says why once in the log, and every machine op
/// there answers the line that names the op, as it always has. The one exception is where the root was put: that
/// is the person's own choice and the reason every create under it would fail, so the reading travels to the
/// ops, since somebody asking what this computer can do reads the host's answer and not this log.
#[cfg(target_os = "linux")]
fn open_runtime(options: &Options, log: &Log, daemon_port: u16) -> (Option<Arc<wsp_runtime::ops::Ops>>, Option<String>) {
    if options.place_file.is_none() {
        return (None, None);
    }
    let root = options.runtime_root.clone().unwrap_or_else(|| PathBuf::from(wsp_runtime::DEFAULT_ROOT));
    // Read before the open, which refuses the same root itself: nothing is made under it either way, and the
    // sentence is the one the host reads when it asks what this computer can do.
    if let Some(said) = wsp_runtime::doctor::root_under_a_lower(&root) {
        log(&format!("workspace runtime not served: {said}"));
        return (None, Some(said));
    }
    let exe = match options.runtime_helper.clone().map(Ok).unwrap_or_else(std::env::current_exe) {
        Ok(exe) => exe,
        Err(e) => {
            log(&format!("workspace runtime not served: this binary's own path is unknown: {e}"));
            return (None, None);
        }
    };
    match wsp_runtime::ops::Ops::open(&root, exe, daemon_port) {
        Ok(ops) => {
            for id in ops.stopped_at_open() {
                log(&format!("workspace {id} found stopped at start: its init is gone"));
            }
            let unfinished = ops.unfinished_at_open();
            if !unfinished.is_empty() {
                log(&format!(
                    "creates that never finished swept: {} half made copies, {} claimed folders with no workspace in them",
                    unfinished.copies.len(),
                    unfinished.claims.len()
                ));
            }
            let net_swept = ops.net_swept_at_open();
            if !net_swept.links.is_empty() || net_swept.rules {
                log(&format!(
                    "workspace network swept: {} links{}",
                    net_swept.links.len(),
                    if net_swept.rules { ", the rules" } else { "" }
                ));
            }
            (Some(Arc::new(ops)), None)
        }
        Err(e) => {
            log(&format!("workspace runtime not served: {}: {e}", root.display()));
            (None, None)
        }
    }
}

/// The daemon's own hook on the workspaces this computer runs: a door inside each one as it boots, and the door
/// away as it stops. Weak, since the runtime it is handed to lives on the context that holds it.
#[cfg(target_os = "linux")]
struct WorkspaceDoors(std::sync::Weak<Ctx>);

#[cfg(target_os = "linux")]
impl wsp_runtime::ops::Watches for WorkspaceDoors {
    fn booted(&self, id: &str, socket: &Path) {
        if let Some(ctx) = self.0.upgrade() {
            ctx.open_workspace_door(id, socket);
        }
    }

    fn stopped(&self, id: &str) {
        if let Some(ctx) = self.0.upgrade() {
            ctx.close_workspace_door(id);
        }
    }
}

/// The root the hello announces: the --root given, else HOME, made absolute and normalised as node's path.resolve
/// does.
fn resolved_root(root: Option<&Path>) -> String {
    let given = root.map(Path::to_path_buf).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"));
    paths::absolute(&given).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_absolute_and_normalised() {
        assert_eq!(resolved_root(Some(Path::new("/srv/work/../work/./here"))), "/srv/work/here");
        assert_eq!(resolved_root(Some(Path::new("/a/b/../../../c"))), "/c");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(resolved_root(Some(Path::new("sub"))), cwd.join("sub").to_string_lossy());
    }
}
