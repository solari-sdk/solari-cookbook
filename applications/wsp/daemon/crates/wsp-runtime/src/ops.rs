// SPDX-License-Identifier: AGPL-3.0-only
//! Every machine op on the link, answered as the Docker backend on a place answers them, so the host's link
//! backend needs no change: the same handles, rows and results, and every refusal as `{ ok: false, error, kind,
//! status }` with `kind: missing` for a workspace nothing here knows. A workspace is a record under the run
//! directory, a container youki made from this computer's own directories and one copy of a checkout on it, its
//! cgroup, and its network. This computer keeps no image: a create that names a template or a snapshot is
//! refused in one sentence, and nothing here pulls, builds, saves or lists one.
//!
//! Idle means stopped, and a pause always stops: SIGTERM to the workspace's processes, its init last, then the
//! kill road for whatever stayed, the network down, and every mount under the rootfs detached. The upper
//! directories stay with the copy, and the wake mounts the computer again and boots from them with the same id,
//! address and forwards. There is no other state: nothing here freezes a workspace, and no label asks for it.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use wsp_frames::{
    words, BackendFacts, BackendPricing, Bind, Capabilities, CopyWord, DaemonErrorResponse, ExecResult, Lifecycle, LifecycleBudgets,
    MachineAnswersReply, MachineCounts, MachineErrorKind, MachineExecReply, MachineHandle, MachineHandleReply, MachineKind,
    MachineLinkRequest, MachineListReply, MachineListRow, MachineOp, MachineReachReply, MachineReading, MachineReadingReply, MachineRoads,
    MachineSeen, MachineShape, MachineShapeReply, MachineSizeOffer, MachineSpec, MachineState, MachineStateReply, PauseMode, PlaceCapacity,
    PreviewReach, Reply, RequestId, Share, SnapshotStoragePricing, WorkspaceCopy, WorkspaceSize,
};

use crate::bundle::{self, Config, CopyMade, Init, Layout, Workspace};
use crate::copy;
use crate::engine::{self, Fence, Ports};
use crate::freeze;
use crate::net::{self, Net};
use crate::profile;
use crate::runtime::{self, Runtime, Status};
use crate::size::{size_on_box, BoxFacts, SizeOnBox};
use crate::{answer_machine_op, no_backend_refusal};

/// The id of the offer this computer serves, which the host stamps on every fork made here.
pub const OFFER: &str = "runtime";
/// The kernel takes 64 bytes of host name and refuses the boot above it.
pub const HOSTNAME_MAX: usize = 63;
/// The environment every exec carries ahead of its command, as every wsp guest exec does.
pub const EXEC_ENV: &str = "export HOME=/root USER=root";
/// What a terminal inside a workspace says it is, the one the daemon's own ptys name.
const TERM: &str = "xterm-256color";
/// The shell a pane opens inside a workspace where the frame names none: the workspace's own bash, by name and
/// not by path, since the PATH inside is what says which bash that is.
const SHELL_INSIDE: &str = "bash";
/// The label every workspace wears, so a listing is only ours.
pub const WSP_LABEL: &str = "wsp";
/// The label a workspace's own name rides on, which the host stamps at the create: what the refusal of a create
/// with no room names the workspace to stop by, since an id is not a thing a person recognises.
pub const NAME_LABEL: &str = "wsp-name";
const SIZES: [(f64, u64); 2] = [(2.0, 4096), (4.0, 8192)];
const WAKE_ATTEMPTS: u32 = 1;
const DAEMON_ANSWERS_MS: u64 = 30_000;
/// The Docker backend's default exec deadline.
const EXEC_DEFAULT: Duration = Duration::from_millis(20_000);

/// What every workspace boots: one process that holds it up so execs can reach it. Nothing supervises a daemon
/// inside a workspace here, since the daemon that serves it is this computer's own: it answers that workspace's
/// files and git off its rootfs and inside its namespaces, and nothing is deployed in.
pub fn boot_cmd() -> Vec<String> {
    vec!["sleep".to_owned(), "infinity".to_owned()]
}

/// What every exec carries ahead of its command: the home and the user every wsp guest exec sets, and the
/// compose project of a workspace that asked for an engine. A tenant starts from the workspace's own boot
/// environment, which the container crate takes off the spec and the builder's own entries override by name, so
/// the PATH and the recipe's knobs are there already; this line is what holds for a workspace booted by an older
/// daemon and taken over by this one, whose spec carries neither.
pub fn exec_env(record: &Workspace) -> String {
    match record.engine {
        true => format!("{EXEC_ENV} COMPOSE_PROJECT_NAME={}", compose_project(&record.id)),
        false => EXEC_ENV.to_owned(),
    }
}

/// The compose project one workspace's containers, networks and volumes belong to: its own id, held to what
/// compose takes as a project name. Two pieces of work on one project on one box are two workspaces, and without
/// a name each the second one's compose finds the first one's network under the name it wants and fails at the
/// network step (measured through the fence on a box).
pub fn compose_project(id: &str) -> String {
    let word: String =
        id.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' { c } else { '-' }).collect();
    word.trim_start_matches(['-', '_']).to_owned()
}

/// The name a person knows a workspace by, which the host stamps at the create; its id where a create of its own
/// carried no name.
fn workspace_name(record: &Workspace) -> String {
    record.labels.get(NAME_LABEL).filter(|name| !name.is_empty()).cloned().unwrap_or_else(|| record.id.clone())
}

/// What a create is refused with on a box with no room for another workspace: what the kernel says is free, what
/// the workspace would have been capped at, and the one to stop to make room, which is whichever of the awake
/// ones has gone longest without anybody asking it for anything. A box whose own work filled it has none of ours
/// to name, and says so rather than naming nothing.
pub fn box_full_refusal(need_mb: u64, free_mb: u64, quietest: Option<(String, u64)>) -> String {
    match quietest {
        Some((name, quiet_min)) => format!(
            "this computer has {free_mb} MB free and a workspace needs {need_mb} MB; stop {name}, quiet for {quiet_min} min, to make room"
        ),
        None => format!(
            "this computer has {free_mb} MB free and a workspace needs {need_mb} MB, and no workspace of yours is awake to stop: what is holding it is the computer's own work"
        ),
    }
}

/// What a computer whose kernel opens no watch on a workspace's init reads on the daemon's own log: the
/// workspace runs as it did, and its door stands until the next stop.
fn init_not_watched(id: &str, reason: &str) -> String {
    format!("wsp-runtime: the init of {id} is not watched, so its death is read at the next listing: {reason}")
}

/// A destination that is one of the trees the rootfs takes from the computer, or sits under one, refused: its
/// mount point would be made through the computer's own directory and left on it once the workspace is gone. The
/// one place the reading is turned into a refusal, read by the create's copy and folder roads and by every boot.
fn no_computer_tree(at: &str) -> Result<(), OpError> {
    match bundle::under_computer_tree(at) {
        Some(tree) => Err(OpError::plain(bundle::computer_tree_refusal(at, tree))),
        None => Ok(()),
    }
}

/// A refusal on the wire: the sentence, and the engine's kind and status where a client branches on them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError {
    pub message: String,
    pub kind: Option<MachineErrorKind>,
    pub status: Option<u16>,
}

impl OpError {
    fn plain(message: impl Into<String>) -> OpError {
        OpError { message: message.into(), kind: None, status: None }
    }

    fn missing(message: impl Into<String>) -> OpError {
        OpError { message: message.into(), kind: Some(MachineErrorKind::Missing), status: Some(404) }
    }

    fn no_workspace(id: &str) -> OpError {
        OpError::missing(crate::no_such_workspace(id))
    }
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OpError {}

impl From<runtime::Error> for OpError {
    fn from(e: runtime::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

impl From<bundle::Error> for OpError {
    fn from(e: bundle::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

impl From<io::Error> for OpError {
    fn from(e: io::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

impl From<net::Error> for OpError {
    fn from(e: net::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

/// The handle a create answers with, carrying what the create has to say about what it gave.
fn noticed(mut handle: MachineHandle, notice: Option<String>) -> MachineHandle {
    handle.notice = notice;
    handle
}

/// Everything one create has to say, as one sentence a person reads: the size the box gave where it gave
/// another, the copy's minutes where it wrote every byte, nothing where there is nothing to say.
fn notices<const N: usize>(said: [Option<String>; N]) -> Option<String> {
    let all: Vec<String> = said.into_iter().flatten().collect();
    (!all.is_empty()).then(|| all.join("; "))
}

/// How long a plain copy took and why it took it, in the words a person can act on: the root's own filesystem,
/// which is the thing that decides whether a copy shares blocks. A box that will not say what it is on says the
/// time alone.
pub fn plain_copy_line(root: &Path, filesystem: Option<&str>, ms: u64) -> String {
    let seconds = (ms as f64 / 1000.0).round().max(1.0) as u64;
    let why = match filesystem {
        Some(kind) => format!("{} is on {kind}, which shares no blocks between copies", root.display()),
        None => format!("{} shares no blocks between copies", root.display()),
    };
    format!("copied plainly in {seconds} s: {why}")
}

/// What the daemon serving this computer is told as its workspaces come and go: one that has booted, with the
/// path inside it to bind its door on, and one that has stopped. The daemon binds that door on the first and
/// takes the listener away on the second; the file itself goes with the stop here, whichever daemon bound it,
/// since the folder it sits in is the workspace's own. Nothing here knows what is on the other end of this.
pub trait Watches: Send + Sync {
    fn booted(&self, id: &str, socket: &Path);
    fn stopped(&self, id: &str);
}

pub struct Ops {
    layout: Layout,
    runtime: Runtime,
    net: Arc<Net>,
    /// The fenced engine socket's accept loop of every running workspace that asked for one.
    engines: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
    /// The shares section of a boot, which every create and every wake runs on a task of its own: held from the
    /// read of the points this computer already holds to the last one made, since a neighbour's claim is written
    /// inside that section, so two boots sharing one login that both read before either wrote would each find
    /// the point missing, each make it, and neither own it.
    points: std::sync::Mutex<()>,
    facts: BoxFacts,
    stopped: Vec<String>,
    net_swept: net::Swept,
    unfinished: Unfinished,
    /// Who is told as workspaces boot and stop, and the way back here the watch of a dead init takes; none until
    /// the daemon that serves this computer says so.
    watcher: std::sync::Mutex<Option<Watching>>,
    /// The watch on every running workspace's init, by workspace: one task each, ended by its stop.
    deaths: std::sync::Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
}

/// What the daemon left here when it took the workspaces over: who to tell, and these ops as the task watching a
/// dead init reaches them. Weak, since that daemon holds both and a task must not hold the ops up past it.
struct Watching {
    told: Arc<dyn Watches>,
    ops: std::sync::Weak<Ops>,
}

/// What the open took away of creates that never finished: a copy still being made and a claimed run directory
/// with no record in it are both what a daemon that died in the middle of a create leaves, and neither is a
/// workspace anything can name.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Unfinished {
    pub copies: Vec<String>,
    pub claims: Vec<String>,
}

impl Unfinished {
    pub fn is_empty(&self) -> bool {
        self.copies.is_empty() && self.claims.is_empty()
    }
}

/// What one create mounts into the workspace, kept together from the create to the record: the computer's logins
/// and the folders of its own it binds.
struct Mounted {
    shares: Vec<Share>,
    binds: Vec<Bind>,
}

impl Ops {
    /// Opens the root, sweeps the creates that never finished, reads the box, marks every workspace whose init is
    /// gone as stopped (a reboot, or a daemon that was not there when the init died, leaves its record, its upper
    /// directories and youki's state behind, and youki reads any process on the old pid as the container), and
    /// sweeps the network of every workspace that is not running. `exe` is this binary and `daemon_port` the port
    /// this computer's own daemon bound, which no workspace reaches at its gateway. The forwards of the workspaces
    /// still running come back with `restore`, which wants the runtime the listeners live on.
    pub fn open(root: &Path, exe: PathBuf, daemon_port: u16) -> Result<Ops, OpError> {
        // Where the root was put, before a directory is made under it: every workspace here reads the computer's
        // own system directories through an overlay whose upper sits under this root, so a root inside one of
        // them gives every workspace its own upper, and its neighbours', to read inside the tree it overlays.
        // Refused whole rather than served: a daemon that made its folders and then failed every create left a
        // person reading `ready` and nothing else.
        if let Some(reason) = crate::doctor::root_under_a_lower(root) {
            return Err(OpError::plain(reason));
        }
        let layout = Layout::new(root);
        for dir in [layout.run(), layout.state(), layout.copies()] {
            fs::create_dir_all(&dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        // The logins directory is made before any sign-in on this computer asks for it, and only this login may
        // read it: what lands under it is the person's own sign-in for every workspace here. The projects
        // directory is made the same way and for the same reason: a project's checkout and its agent's memory are
        // the person's, and an add binds a project's own folder under it into the workspace that clones into it.
        for dir in [layout.logins(), layout.projects()] {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&dir)
                .map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        // Before anything reads the run directory as a list of workspaces: what a create that died left is not
        // one, and a copy that was still being made is not a copy.
        let unfinished = sweep_unfinished(&layout)?;
        let runtime = Runtime::new(root, exe);
        let stopped = mark_stopped(&layout)?;
        let running = running_ids(&layout)?;
        let (net, net_swept) =
            Net::open(Layout::new(root), &running, daemon_port).map_err(|e| OpError::plain(format!("{}: {e}", root.display())))?;
        Ok(Ops {
            layout,
            runtime,
            net: Arc::new(net),
            engines: Mutex::new(BTreeMap::new()),
            points: std::sync::Mutex::new(()),
            facts: BoxFacts::read(),
            stopped,
            net_swept,
            unfinished,
            watcher: std::sync::Mutex::new(None),
            deaths: std::sync::Mutex::new(BTreeMap::new()),
        })
    }

    /// The published ports of every running workspace, listening again where their records say, and the engine
    /// socket of every running workspace that asked for one served again, its containers' ports joined. An engine
    /// that left the box since leaves that workspace's socket unserved and the rest untouched.
    pub async fn restore(&self) -> Result<(), OpError> {
        let running = running_ids(&self.layout)?;
        self.net.restore(&running).await?;
        for record in self.records()? {
            if record.engine && running.contains(&record.id) && self.serve_engine(&record).await.is_ok() {
                self.join_ports(&record).await;
            }
        }
        Ok(())
    }

    /// The workspace's socket bound in its directory and its accept loop started over the box's engine; one already
    /// served is replaced. What the fence may bind for a container comes from this record and from no file inside
    /// the workspace. Every entry an earlier life of this fence staged stands: this runs at every boot and again
    /// for every running workspace at a daemon restart, and the engine still holds the containers that mount
    /// them, each naming the entry the life that made it was given. This life's entries take their names from
    /// this life's own init and sit beside them, and the remove is what takes them all.
    async fn serve_engine(&self, record: &Workspace) -> Result<(), OpError> {
        let id = record.id.as_str();
        let socket = engine::socket_of(&crate::doctor::read_facts()).map_err(OpError::plain)?;
        let listener = engine::bind(&self.layout.engine(id))?;
        let binds = self.layout.binds(id);
        ready_binds(&binds)?;
        let fence = Fence::new(
            id.to_owned(),
            self.layout.rootfs(id),
            bind_roots(&self.layout, record),
            binds,
            socket,
            engine::Hooks {
                ports: Arc::new(Inward { net: Arc::clone(&self.net), root: self.layout.root().to_path_buf() }),
                bridges: Arc::new(Bridged { net: Arc::clone(&self.net) }),
            },
            life_of(&record.init),
        );
        let task = tokio::spawn(engine::serve(listener, Arc::new(fence)));
        if let Some(old) = self.engines.lock().await.insert(id.to_owned(), task) {
            old.abort();
        }
        Ok(())
    }

    /// The published ports of the workspace's running containers joined to its loopback, as after a wake or a
    /// daemon restart; a container whose port cannot be joined is left for the next start to try again.
    async fn join_ports(&self, record: &Workspace) {
        let Ok(socket) = engine::socket_of(&crate::doctor::read_facts()) else { return };
        let Ok(pairs) = engine::published(&socket, &record.id).await else { return };
        for (inside, box_port) in pairs {
            let _ = self.net.forward_inward(&record.id, record.init.pid, inside, box_port).await;
        }
    }

    /// The accept loop ended and the socket file gone; the socket's directory stays with the bundle, and so do
    /// the staged binds, since the containers that mount them outlive a stop and their next start resolves the
    /// entry each was given. The remove is what takes them.
    async fn stop_engine(&self, id: &str) {
        if let Some(task) = self.engines.lock().await.remove(id) {
            task.abort();
        }
        let _ = fs::remove_file(self.layout.engine(id).join(engine::SOCKET_NAME));
    }

    /// The daemon takes the workspaces over from here: every boot and every stop after this is told as it
    /// happens, and every workspace already running is named booted now, so a daemon that restarted under them
    /// stands where one that booted them would.
    pub fn watch(self: &Arc<Self>, watcher: Arc<dyn Watches>) -> Result<(), OpError> {
        *self.watcher.lock().unwrap_or_else(|held| held.into_inner()) =
            Some(Watching { told: Arc::clone(&watcher), ops: Arc::downgrade(self) });
        for record in records_under(&self.layout)? {
            if !runtime::alive(&record.init) {
                continue;
            }
            watcher.booted(&record.id, &self.layout.guest_socket(&record.id));
            self.arm(&record.id, &record.init);
        }
        Ok(())
    }

    /// One word to whoever is watching; nothing where nobody is.
    fn told(&self, say: impl FnOnce(&dyn Watches)) {
        let held = self.watcher.lock().unwrap_or_else(|held| held.into_inner()).as_ref().map(|w| Arc::clone(&w.told));
        if let Some(watcher) = held {
            say(watcher.as_ref());
        }
    }

    /// The workspace's init watched from here to its stop, on a task of its own: a workspace whose init ends any
    /// other way ends the same way a stop does, so its door, its socket file, its network and its mounts go with
    /// it rather than standing until the next stop or the daemon's restart. Armed only under a daemon that took
    /// the workspaces over, since the way back here is that daemon's; a kernel that opens no such descriptor
    /// leaves the workspace as it was before this and says which one.
    fn arm(&self, id: &str, init: &Init) {
        let held = self.watcher.lock().unwrap_or_else(|held| held.into_inner()).as_ref().map(|w| w.ops.clone());
        let Some(ops) = held else { return };
        let dying = match runtime::death_of(init) {
            Ok(dying) => dying,
            Err(e) => {
                eprintln!("{}", init_not_watched(id, &e.to_string()));
                return;
            }
        };
        let watched = id.to_owned();
        let died = init.clone();
        let task = tokio::spawn(async move {
            if dying.readable().await.is_err() {
                return;
            }
            let Some(ops) = ops.upgrade() else { return };
            // Off the map before the stop road runs: the stop takes the watch off, and a task that aborted
            // itself in the middle of one would leave the workspace half torn down.
            ops.deaths.lock().unwrap_or_else(|held| held.into_inner()).remove(&watched);
            let Ok(Some(record)) = bundle::read_record(&ops.layout.record(&watched)) else { return };
            // A record naming another init is a workspace a wake booted again since, and not the one that died.
            // Read as the init this watch was armed on rather than as a pid still in /proc: a process that just
            // died is a zombie until its parent reaps it, and a zombie reads alive.
            if record.init != died {
                return;
            }
            let _ = ops.stop(&record).await;
        });
        if let Some(old) = self.deaths.lock().unwrap_or_else(|held| held.into_inner()).insert(id.to_owned(), task) {
            old.abort();
        }
    }

    /// The watch off, before a stop of this workspace runs: the init a stop kills is a death this computer asked
    /// for, and the stop road is not run twice for it.
    fn disarm(&self, id: &str) {
        if let Some(task) = self.deaths.lock().unwrap_or_else(|held| held.into_inner()).remove(id) {
            task.abort();
        }
    }

    /// The workspaces found stopped at open, their init gone.
    pub fn stopped_at_open(&self) -> &[String] {
        &self.stopped
    }

    /// What the network sweep at open removed.
    pub fn net_swept_at_open(&self) -> &net::Swept {
        &self.net_swept
    }

    /// What the open took away of creates that never finished.
    pub fn unfinished_at_open(&self) -> &Unfinished {
        &self.unfinished
    }

    pub fn facts(&self) -> BoxFacts {
        self.facts
    }

    /// One frame in, one reply text out, under the request's id.
    pub async fn answer(&self, id: Option<RequestId>, frame: &Value) -> String {
        let request: MachineLinkRequest = match serde_json::from_value(frame.clone()) {
            Ok(request) => request,
            Err(e) => return text(&DaemonErrorResponse::new(id, e.to_string())),
        };
        match self.serve(request.op).await {
            Ok(body) => text(&Reply::new(id, body)),
            Err(OpError { message, kind, status }) => {
                let mut reply = DaemonErrorResponse::new(id, message);
                reply.kind = kind;
                reply.status = status;
                text(&reply)
            }
        }
    }

    async fn serve(&self, op: MachineOp) -> Result<Value, OpError> {
        match op {
            MachineOp::Backend => {
                self.self_check().await.map_err(OpError::plain)?;
                body(self.backend_facts())
            }
            MachineOp::Capacity => body(self.capacity()?),
            MachineOp::CheckKey => {
                self.self_check().await.map_err(OpError::plain)?;
                body(Empty {})
            }
            MachineOp::Create { spec } => body(MachineHandleReply { machine: self.create(spec).await? }),
            MachineOp::Get { machine_id } => {
                let record = self.record(&machine_id)?;
                let seen = MachineSeen { state: self.state_of(&record), created_at: Some(record.created_at.clone()) };
                body(MachineHandleReply { machine: self.handle(&record, None, Some(seen)) })
            }
            MachineOp::List { labels } => body(MachineListReply { machines: self.list(labels.as_ref())? }),
            MachineOp::Exec { machine_id, cmd, timeout_ms } => {
                let record = self.running(&machine_id)?;
                body(MachineExecReply { result: self.exec(&record, &cmd, None, deadline(timeout_ms)).await? })
            }
            MachineOp::Pause { machine_id } => {
                let record = self.record(&machine_id)?;
                if !runtime::alive(&record.init) {
                    return Err(OpError::plain(format!("workspace {} is already paused", record.id)));
                }
                self.stop(&record).await?;
                body(Empty {})
            }
            MachineOp::Resume { machine_id } => {
                let record = self.record(&machine_id)?;
                if runtime::alive(&record.init) {
                    return Err(OpError::plain(format!("workspace {} is not paused", record.id)));
                }
                self.wake(record).await?;
                body(Empty {})
            }
            MachineOp::Kill { machine_id } => {
                let record = self.record(&machine_id)?;
                self.remove(&record.id, Some(&record.init)).await?;
                body(Empty {})
            }
            MachineOp::State { machine_id } => body(MachineStateReply { state: self.state_of(&self.record(&machine_id)?) }),
            MachineOp::Describe { machine_id } => {
                let record = self.record(&machine_id)?;
                // Every overlay's upper under one directory, so this is the whole of what the workspace has
                // written since it booted, the box's own directories not counted.
                let upper = self.layout.upper(&record.id);
                // Off the runtime thread: a workspace after a build holds hundreds of thousands of files.
                let used_bytes = tokio::task::spawn_blocking(move || copy::tree_bytes(&upper).ok()).await.ok().flatten();
                body(MachineShapeReply {
                    shape: MachineShape {
                        cpu: record.cpu,
                        mem_mb: record.mem_mb,
                        disk_gb: None,
                        created_at: Some(record.created_at),
                        used_bytes,
                    },
                })
            }
            MachineOp::Metrics { machine_id } => body(MachineReadingReply { reading: self.reading(&self.record(&machine_id)?) }),
            // The daemon that serves this workspace is this one, so what it answers is whether the workspace runs.
            // Nothing is asked inside: a port inside is nobody's road to it, and a probe run in the workspace would
            // be this computer asking itself.
            MachineOp::DaemonAnswers { machine_id, timeout_ms: _ } => {
                let record = self.record(&machine_id)?;
                body(MachineAnswersReply { answers: runtime::alive(&record.init) })
            }
            MachineOp::PutBytes { machine_id, path, upload_id, seq, last, data, timeout_ms } => {
                let record = self.running(&machine_id)?;
                self.put_bytes(&record, &path, &upload_id, seq, last, &data, deadline(timeout_ms)).await?;
                body(Empty {})
            }
            MachineOp::Facts { machine_id } => {
                self.record(&machine_id)?;
                Err(OpError::plain(no_backend_refusal("facts")))
            }
            MachineOp::PreviewUrl { machine_id, port } => {
                let record = self.record(&machine_id)?;
                let box_port = self.net.publish(&record.id, port.get()).await?;
                body(MachineReachReply {
                    reach: PreviewReach {
                        url: format!("http://127.0.0.1:{box_port}"),
                        token: String::new(),
                        expires_at: PreviewReach::NEVER,
                    },
                })
            }
            MachineOp::DownloadUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain("a workspace serves no signed download URL; its files come out through exec"))
            }
            MachineOp::UploadUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain("a workspace serves no signed upload URL; its files go in through the byte road"))
            }
        }
    }

    /// The flags, prices and budgets this backend declares, as the plan fixes them.
    pub fn backend_facts(&self) -> BackendFacts {
        let sizes = SIZES.iter().map(|&(cpu, mem_mb)| MachineSizeOffer { cpu, mem_mb, rate_usd_per_hour: 0.0 }).collect();
        BackendFacts {
            offer: OFFER.to_owned(),
            capabilities: Capabilities {
                live_clone_forks: false,
                pause_mode: Some(PauseMode::Disk),
                replaces_machine: true,
                preview_urls: false,
                signed_urls: false,
                callback_relay: true,
                // This computer keeps no image: a workspace here is a copy of the computer itself, so there is
                // nothing to save a machine's disk into, nothing to name and nothing to list.
                disk_snapshots: false,
                images: false,
                snapshots_any_life: false,
                snapshot_listing: false,
                templates: false,
                sizes,
                kept: false,
                copies: true,
                own_network: true,
            },
            pricing: BackendPricing {
                default_size: WorkspaceSize { cpu: SIZES[0].0, mem_mb: SIZES[0].1 },
                snapshot_storage: SnapshotStoragePricing { free_gb: 0.0, usd_per_gb_month: 0.0, billed_from: String::new() },
                builder_disk_gb: None,
            },
            lifecycle: Some(Lifecycle {
                budgets: LifecycleBudgets { wake_attempts: WAKE_ATTEMPTS, daemon_answers_ms: DAEMON_ANSWERS_MS, resume_asks: None },
            }),
            // Nothing boots from a name here, so there is no name to offer for a kind.
            base_templates: None,
            logins: Some(self.layout.logins().to_string_lossy().into_owned()),
            projects: Some(self.layout.projects().to_string_lossy().into_owned()),
        }
    }

    /// Whether this computer can run a workspace at all: cgroup v2 with the controllers a cap needs, an overlay
    /// mount, a cgroup of our own, and the kernel's nftables and veth for its network. Each refusal is one
    /// sentence for the doctor. Off the runtime thread, since it mounts and speaks netlink.
    pub async fn self_check(&self) -> Result<(), String> {
        let root = self.layout.root().to_path_buf();
        tokio::task::spawn_blocking(move || Self::self_check_on(&Layout::new(&root))).await.map_err(|e| e.to_string())?
    }

    fn self_check_on(layout: &Layout) -> Result<(), String> {
        // The read-only facts the doctor reads for the report, in one place, then the live proof below: a mount and
        // a cgroup this can make, which the read alone cannot promise. The two answer in the same words because
        // they are the same words.
        if let Some(reason) = crate::doctor::assess(&crate::doctor::read_facts()).blocked {
            return Err(reason);
        }
        // Where the root was put, in the same words the open refuses it with: every workspace here reads the
        // computer's own system directories through an overlay whose upper is under this root, so a root inside
        // one of them gives a workspace its own upper to read. The open makes nothing under such a root, and
        // this is the sentence the host reads when it asks.
        if let Some(reason) = crate::doctor::root_under_a_lower(layout.root()) {
            return Err(reason);
        }
        // And whether this computer's own directories can be a workspace at all: /usr is where every tool a
        // workspace runs comes from, so a root that keeps /bin of its own is named here and not at a create.
        if let Some(reason) = bundle::unmerged_root().map_err(|e| e.to_string())? {
            return Err(reason);
        }
        let check = layout.check();
        let (upper, work, merged) = (check.join("upper"), check.join("work"), check.join("merged"));
        // One of the overlays a workspace is made of, over the box's own directory rather than over an empty
        // one: what a create does, done once here, so a box that refuses it says so at the dial.
        let lower = Path::new(crate::doctor::OVERLAID[0]);
        let overlay = (|| -> Result<(), String> {
            for dir in [&upper, &work, &merged] {
                fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            bundle::mount_overlay(lower, &upper, &work, &merged).map_err(|e| e.to_string())?;
            bundle::unmount(&merged).map_err(|e| e.to_string())
        })();
        let _ = fs::remove_dir_all(&check);
        overlay.map_err(|e| format!("this computer refuses an overlay mount of {}: {e}", lower.display()))?;
        let cgroup = Path::new(freeze::CGROUP_ROOT).join("wsp").join(format!("check-{}", std::process::id()));
        fs::create_dir_all(&cgroup).map_err(|e| format!("this computer refuses a cgroup under {}/wsp: {e}", freeze::CGROUP_ROOT))?;
        let _ = fs::remove_dir(&cgroup);
        net::check()
    }

    pub fn capacity(&self) -> Result<PlaceCapacity, OpError> {
        let mut counts = MachineCounts { running: 0, paused: 0 };
        let (mut taken_mb, mut taken_cpu) = (0, 0.0);
        // A frozen workspace keeps every byte it holds and every core it was given and counts at its cap; a
        // stopped one holds nothing.
        for record in self.records()? {
            match self.state_of(&record) {
                MachineState::Gone => continue,
                MachineState::Paused => counts.paused += 1,
                MachineState::Running | MachineState::Starting => counts.running += 1,
            }
            if runtime::alive(&record.init) {
                taken_mb += record.mem_mb.unwrap_or(0);
                taken_cpu += record.cpu.unwrap_or(0.0);
            }
        }
        let machine_mem_mb = self.facts.machine_mem_mb();
        let stat =
            nix::sys::statvfs::statvfs(self.layout.root()).map_err(|e| OpError::plain(format!("{}: {e}", self.layout.root().display())))?;
        let disk_free_bytes = stat.blocks_available() as u64 * stat.fragment_size() as u64;
        Ok(PlaceCapacity {
            cores: self.facts.cores,
            mem_mb: self.facts.mem_mb,
            mem_room_mb: machine_mem_mb.saturating_sub(taken_mb),
            machine_mem_mb,
            cpu_taken: Some(taken_cpu),
            mem_taken_mb: Some(taken_mb),
            disk_free_bytes,
            // No image is kept here, so the room for one more workspace is the memory rule alone.
            images: Vec::new(),
            machines: counts,
        })
    }

    async fn create(&self, spec: MachineSpec) -> Result<MachineHandle, OpError> {
        self.create_with_room(spec, crate::size::free_mem_mb()).await
    }

    /// `free_mb` is what the box says it has free, read by the create above and handed in, so the room rule is
    /// read against a figure the caller holds rather than against the moment the check runs.
    async fn create_with_room(&self, spec: MachineSpec, free_mb: Option<u64>) -> Result<MachineHandle, OpError> {
        // A workspace here is made of this computer's own directories, so a name for an image to boot from is
        // not something to fall back from: it is a create meant for another kind of place.
        if spec.template.is_some() || spec.from_snapshot.is_some() {
            return Err(OpError::plain(words::NO_IMAGES_HERE));
        }
        // Read before the claim below, so the answer to a create the first one already made carries the same
        // sentence about the same size rather than going quiet on the second ask.
        let size = size_on_box(&self.facts, spec.cpu, spec.mem_mb);
        // Before the claim and before anything is mounted: a source this daemon does not share out is refused,
        // and a refusal here costs nothing to take back.
        let shares = self.shares_of(&spec)?;
        let binds = self.binds_of(&spec)?;
        let id = match &spec.idempotency_key {
            Some(key) => format!("wsp-{}", workspace_word(key)),
            None => format!("wsp-{}", random_word()),
        };
        let dir = self.layout.workspace(&id);
        // The directory is the claim: a second create under the same key answers the workspace the first one made.
        if let Err(e) = fs::create_dir_all(self.layout.run()).and_then(|()| fs::create_dir(&dir)) {
            if e.kind() != io::ErrorKind::AlreadyExists {
                return Err(OpError::plain(format!("{}: {e}", dir.display())));
            }
            return match bundle::read_record(&self.layout.record(&id))? {
                Some(record) => Ok(noticed(self.handle(&record, Some(true), None), size.clamped)),
                None => Err(OpError::plain(format!("workspace {id} is being created"))),
            };
        }
        // After the claim, and before a byte is copied or anything is mounted: a box with no room for another
        // workspace says so in one sentence naming the one to stop, rather than booting a workspace that pushes
        // the computer somebody is using into reclaim. After the claim because a create under a key this box
        // already holds a workspace for is that workspace's handle and needs no room at all: the client's retry
        // of a create whose answer the link dropped must not be refused for the room its own workspace holds.
        // The claim is given back with the refusal, so the next create under that key is not wedged by it.
        if let Some(refusal) = self.no_room_for(size.mem_mb, free_mb)? {
            let _ = fs::remove_dir_all(&dir);
            return Err(OpError::plain(refusal));
        }
        // Before anything is mounted and before youki: a copy of the checkout is the slowest thing a create does
        // and the one thing a person waits on, and a refusal here costs nothing else.
        let copy = match &spec.copy {
            Some(want) => match self.make_copy(&id, want).await {
                Ok(made) => Some(made),
                Err(e) => {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(e);
                }
            },
            None => None,
        };
        let notice = notices([size.clamped.clone(), copy.as_ref().and_then(|made| self.plain_copy_notice(made))]);
        match self.build(&id, &spec, &size, copy.clone(), Mounted { shares, binds }).await {
            Ok(record) => Ok(noticed(self.handle(&record, None, None), notice)),
            Err(e) => {
                // A workspace that would not come up is ours and nobody else's: nothing of it stays behind, the
                // copy it was given included, which the record does not carry yet where the boot failed early.
                let _ = self.remove(&id, None).await;
                if let Some(made) = &copy {
                    let _ = copy::copier_of(made.made).remove(&self.layout.copy_of(&id));
                }
                Err(e)
            }
        }
    }

    /// Whether this box has room for one more workspace of that size, and the sentence to refuse the create with
    /// where it has not: what the kernel says is free right now against what the workspace would be capped at.
    ///
    /// What is free and not the sum of the caps: a cap is what a workspace may take, not what it holds, so five
    /// awake workspaces whose processes are all small leave the box its room and a sixth is made. The other way
    /// round, a workspace that later grows into its cap can still push the box into swap before another create
    /// is refused; the cap is what bounds each of them, and this is what keeps a create from being the thing
    /// that does it.
    ///
    /// A box whose kernel says nothing free refuses nothing, which is every computer that is not a box: the size
    /// rule above is what holds a create there.
    fn no_room_for(&self, need_mb: u64, free_mb: Option<u64>) -> Result<Option<String>, OpError> {
        let Some(free_mb) = free_mb else { return Ok(None) };
        if free_mb >= need_mb {
            return Ok(None);
        }
        Ok(Some(box_full_refusal(need_mb, free_mb, self.quietest_awake()?)))
    }

    /// The awake workspace that has gone longest without a byte through a published port or a command run in it,
    /// as the name a person knows it by and the minutes it has been quiet: the one to stop to make room. Nothing
    /// where nothing of ours is awake, which is a box whose own work is what filled it.
    ///
    /// Compared by the millisecond and told in minutes, since two workspaces quiet for different lengths of the
    /// same minute are not the same answer. One this daemon has no clock for reads as busy rather than as quiet:
    /// a workspace nothing is known about is not the one to tell somebody to stop.
    fn quietest_awake(&self) -> Result<Option<(String, u64)>, OpError> {
        let mut quietest: Option<(String, u64)> = None;
        for record in self.records()? {
            if !runtime::alive(&record.init) {
                continue;
            }
            let quiet_ms = self.net.quiet_for_ms(&record.id).unwrap_or(0);
            if quietest.as_ref().is_none_or(|(_, held)| quiet_ms > *held) {
                quietest = Some((workspace_name(&record), quiet_ms));
            }
        }
        Ok(quietest.map(|(name, quiet_ms)| (name, quiet_ms / 60_000)))
    }

    /// The logins a create asks for, held to one rule: a file under the directory this daemon shares them out of.
    /// (The two lists a create carries travel together from here to the record, so the boot mounts what the
    /// create was given and a wake mounts what the record kept.)
    /// A source anywhere else on the box is refused, since a bind mount lands on the workspace's own files and is
    /// the one thing a slip cannot be taken back; so is one that is there and is not a file, which the boot would
    /// otherwise pass over without a word. A source that is not there yet is a login nobody has signed in on this
    /// computer: the boot passes that over and the wake after the sign-in binds it. The wire has already read both
    /// paths as paths; this is what reads where the source is and what it is.
    fn shares_of(&self, spec: &MachineSpec) -> Result<Vec<Share>, OpError> {
        let logins = self.layout.logins();
        let asked = spec.shares.clone().unwrap_or_default();
        for share in &asked {
            // Held to the wire's own rule rather than to a copy of it, as the bind under a rootfs is: a source
            // that walks up out of the logins directory resolves to a path on the box like any other.
            let at = Path::new(&share.source);
            let under = wsp_frames::is_plain_path(&share.source) && at.strip_prefix(&logins).is_ok_and(|rest| rest.iter().next().is_some());
            if !under || (at.exists() && !at.is_file()) {
                return Err(OpError::plain(format!(
                    "a login shared into a workspace is a file under {}, and {} is not one",
                    logins.display(),
                    share.source
                )));
            }
        }
        Ok(asked)
    }

    /// The folders a create asks to have mounted into the workspace, held to one rule: a directory under the
    /// projects directory this daemon keeps the checkouts and their memory in. A bind mount lands on the
    /// workspace's own files and is the one thing a slip cannot be taken back, so nothing else on the box is bound,
    /// and a source that is there and is not a directory is refused rather than passed over without a word. A
    /// source that is not there yet is made: an add binds a project's own folder before it has cloned into it.
    fn binds_of(&self, spec: &MachineSpec) -> Result<Vec<Bind>, OpError> {
        let projects = self.layout.projects();
        let asked = spec.binds.clone().unwrap_or_default();
        for bind in &asked {
            // Read before the source folder is made, so a refused create leaves nothing of itself anywhere.
            no_computer_tree(&bind.target)?;
            let at = Path::new(&bind.source);
            let under =
                wsp_frames::is_plain_path(&bind.source) && at.strip_prefix(&projects).is_ok_and(|rest| rest.iter().next().is_some());
            if !under || (at.exists() && !at.is_dir()) {
                return Err(OpError::plain(format!(
                    "a folder bound into a workspace is a directory under {}, and {} is not one",
                    projects.display(),
                    bind.source
                )));
            }
            fs::create_dir_all(at).map_err(|e| OpError::plain(format!("{}: {e}", at.display())))?;
        }
        Ok(asked)
    }

    /// The workspace's own copy of a checkout this computer holds, made the way this disk makes one and timed.
    /// Off the runtime thread: a plain copy of a package tree is minutes of a core, and nothing else this daemon
    /// serves may wait behind it.
    async fn make_copy(&self, id: &str, want: &WorkspaceCopy) -> Result<CopyMade, OpError> {
        // The path the project takes inside, read through the same wall the boot's bind is built with and
        // before a byte is copied or anything is mounted: a refusal here costs nothing to take back, and the
        // create gives the claim back with it.
        no_computer_tree(&want.at)?;
        bundle::inside(&self.layout.rootfs(id), &want.at)?;
        // Made under a name that says it is not finished and renamed into place by one directory entry once it
        // is: a create that dies in the middle of a copy, which a kernel or a disk can always make happen,
        // leaves something the open sweeps rather than a copy of half a checkout that reads as whole.
        let (from, being_made, to) = (PathBuf::from(&want.from), self.layout.copy_being_made(id), self.layout.copy_of(id));
        let copies = self.layout.copies();
        let started = std::time::Instant::now();
        let made = tokio::task::spawn_blocking(move || -> io::Result<CopyWord> {
            let copier = copy::copier_for(&from, &copies)?;
            let _ = copier.remove(&being_made);
            copier.copy(&from, &being_made)?;
            match fs::rename(&being_made, &to) {
                Ok(()) => Ok(copier.word()),
                Err(e) => {
                    let _ = copier.remove(&being_made);
                    Err(io::Error::new(e.kind(), format!("{}: {e}", to.display())))
                }
            }
        })
        .await
        .map_err(|e| OpError::plain(e.to_string()))??;
        Ok(CopyMade { from: want.from.clone(), at: want.at.clone(), made, ms: started.elapsed().as_millis() as u64 })
    }

    /// What a create says where the copy cost every byte of the checkout; a reflink and a snapshot say nothing,
    /// since the place's row already carries the word and neither took a minute.
    fn plain_copy_notice(&self, made: &CopyMade) -> Option<String> {
        (made.made == CopyWord::Plain)
            .then(|| plain_copy_line(self.layout.root(), bundle::filesystem_at(self.layout.root()).as_deref(), made.ms))
    }

    async fn build(
        &self,
        id: &str,
        spec: &MachineSpec,
        size: &SizeOnBox,
        copy: Option<CopyMade>,
        mounted: Mounted,
    ) -> Result<Workspace, OpError> {
        let engine = spec.engine == Some(true);
        if engine {
            engine::socket_of(&crate::doctor::read_facts()).map_err(OpError::plain)?;
        }
        let hostname: String = id.chars().take(HOSTNAME_MAX).collect();
        let mut labels = BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]);
        labels.extend(spec.labels.clone().unwrap_or_default());
        let record = Workspace {
            id: id.to_owned(),
            hostname,
            labels,
            envs: spec.envs.clone().unwrap_or_default(),
            cpu: Some(size.cpu),
            mem_mb: Some(size.mem_mb),
            created_at: now_iso(),
            init: Init { pid: 0, started: 0, boot_id: String::new() },
            engine,
            copy,
            shares: mounted.shares,
            binds: mounted.binds,
            made_points: Vec::new(),
        };
        self.boot(record).await
    }

    /// The workspace's processes from its record: the computer's own directories under the workspace's upper
    /// directories, the bundle, youki's create, the network, the start, and the forwards its record names. A
    /// first boot and a wake are the same road; a wake finds the upper directories as the stop left them, with
    /// everything the workspace wrote, over the box's directories as they are now.
    async fn boot(&self, mut record: Workspace) -> Result<Workspace, OpError> {
        let id = record.id.clone();
        // Before the first directory of this boot is made: a record written before this rule, or one whose
        // destination fell under a tool root the computer has installed since, is refused at its wake rather
        // than mounted through the computer's own home.
        for at in record.copy.iter().map(|made| made.at.as_str()).chain(record.binds.iter().map(|bind| bind.target.as_str())) {
            no_computer_tree(at)?;
        }
        bundle::write_etc(&self.layout.etc(&id), &record.hostname, None)?;
        // Every destination under this workspace's rootfs is opened through this, beneath the rootfs and with no
        // link of the workspace's followed, before a mount or a create lands on it.
        let place = self.layout.inside_of(&id);
        // Read at every boot and written on no record: a Homebrew installed on this computer after the create is
        // inside the workspace at its next wake, and one taken off it is gone from the next boot.
        let tool_roots = bundle::tool_roots_present(&wsp_frames::numbers::SHARED_TOOL_ROOTS);
        bundle::mount_computer(&self.layout, &id, &tool_roots)?;
        // The copy into the rootfs before youki takes it: youki rebinds the rootfs as it pivots, so the project
        // travels inside with it, and the daemon goes on seeing it at the same path out here. A wake binds the
        // copy the stop left on disk, so everything the workspace wrote in the project is still there.
        if let Some(made) = &record.copy {
            bundle::bind_inside(&place, &self.layout.copy_of(&id), &made.at)?;
        }
        // The computer's own logins, each mounted at the path its tool reads inside. A file bind needs the file
        // to be there inside, so the runtime makes an empty one where the image carries none; a login this
        // computer does not hold yet is no mount at all, and the wake after the sign-in is what brings it.
        let (shares, made_points) = {
            // A boot that panicked holding this leaves the lock poisoned and the next boot takes it all the
            // same: what it holds is a read and a file on disk, not an invariant a panic could leave half true.
            let _points = self.points.lock().unwrap_or_else(|held| held.into_inner());
            // The points already known to be wsp's, read once before the first one is made. Two workspaces
            // sharing one login share the one mount point under the computer's home, so a point this boot finds
            // standing and another workspace here has named is this workspace's to take off as well, and the
            // last one holding it takes it off. This workspace's own are in the list too: a stop that could not
            // take a point off, and a box that went down with the workspace running, both leave one standing,
            // and the wake that finds it there is still the boot that made it.
            let held = if record.shares.is_empty() {
                Vec::new()
            } else {
                let mut held = self.points_of_others(&id)?;
                held.extend(points_of(&self.layout, &id)?);
                held
            };
            make_points(&place, &self.layout, &id, &record.shares, &held)?
        };
        record.made_points = made_points;
        // The folders of the computer's own this workspace was made with, bound where it reads them: made here
        // rather than left to the container runtime, and made the way every bind under a rootfs is, so what the
        // workspace mounts under one of them never reaches the computer.
        for bind in &record.binds {
            bundle::bind_inside(&place, Path::new(&bind.source), &bind.target)?;
        }
        let engine_dir = record.engine.then(|| self.layout.engine(&id));
        if let Some(dir) = &engine_dir {
            fs::create_dir_all(dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
            engine::link_client_path(&place)?;
        }
        let mut args = vec![profile::INIT_PATH.to_owned(), "runtime".to_owned(), "init".to_owned(), "--".to_owned()];
        args.extend(boot_cmd());
        // The compose project of a workspace with an engine, in the environment its daemon and every thread
        // under it inherits; the exec road sets the same name, which is what holds for a workspace booted by an
        // older daemon and taken over by this one.
        let compose_name = record.engine.then(|| compose_project(&id));
        let cgroup = self.layout.cgroup_name(&id);
        let config = Config {
            hostname: &record.hostname,
            args: &args,
            envs: &record.envs,
            cpu: record.cpu,
            mem_mb: record.mem_mb,
            cgroup: &cgroup,
            init: self.runtime.exe(),
            etc: &self.layout.etc(&id),
            engine: engine_dir.as_deref(),
            shares: &shares,
            binds: &record.binds,
            tool_roots: &tool_roots,
            compose_project: compose_name.as_deref(),
        };
        bundle::write_json(&self.layout.config(&id), &bundle::config_json(&config))?;
        self.runtime.create(&id).await?;
        let pid = self.runtime.init_pid(&id)?.ok_or_else(|| OpError::plain(format!("workspace {id} was created without an init")))?;
        record.init = runtime::identity_of(pid)?;
        bundle::write_json(&self.layout.record(&id), &record)?;
        // The record carries the points now, so the claim's own file has nothing left to answer for.
        let points = self.layout.points(&id);
        match fs::remove_file(&points) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(OpError::plain(format!("{}: {e}", points.display()))),
        }
        let network = self.net.up(&id, pid).await?;
        // The same inode the container has bound, so the line lands inside.
        bundle::write_etc(&self.layout.etc(&id), &record.hostname, Some(network.gateway))?;
        let cgroup = self.layout.cgroup_dir(&id);
        freeze::forbid_swap(&cgroup)?;
        // The cap as a throttle as well as a kill: youki wrote memory.max off the spec, and this is the same
        // figure at memory.high, so the kernel reclaims what it can from the workspace before it ends anything.
        if let Some(mem_mb) = record.mem_mb {
            freeze::throttle_at(&cgroup, mem_mb)?;
        }
        if record.engine {
            self.serve_engine(&record).await?;
        }
        self.runtime.start(&id).await?;
        // Ready is the boot command running, not the start returning: the start execs the workspace's first
        // process and that process spawns the boot command a moment later, so a create that answered in between
        // handed back a workspace whose cgroup held one pid, which a stop asked right then could not stop.
        self.runtime.boot_child_up(&id, &record.init).await?;
        self.net.restore(std::slice::from_ref(&id)).await?;
        if record.engine {
            self.join_ports(&record).await;
        }
        // The wsp a process inside runs, written into the workspace's own upper onto the init already bound in
        // read-only: the computer's own wsp is under a folder this workspace covers, so without this the word is
        // missing inside. Written at every boot, as the workspace's resolv.conf is.
        bundle::write_wsp_shim_inside(&place)?;
        self.told(|watcher| watcher.booted(&id, &self.layout.guest_socket(&id)));
        self.arm(&id, &record.init);
        Ok(record)
    }

    /// Idle means stopped: the workspace's processes are asked to end and killed if they will not, youki's state
    /// and the cgroup go, the network's link and listeners go, and every mount under the rootfs is detached,
    /// deepest first, so a stopped workspace holds none of the box's directories and the box may upgrade them
    /// while it sleeps. The upper directories, the copy, the record and the network record stay: they are what
    /// the wake boots it with.
    async fn stop(&self, record: &Workspace) -> Result<(), OpError> {
        self.disarm(&record.id);
        self.told(|watcher| watcher.stopped(&record.id));
        // The door inside goes with the workspace: the listener is the daemon's to drop and the file is this
        // folder's, so a workspace that is stopped holds no socket even where the daemon that bound it is gone.
        let _ = fs::remove_file(self.layout.guest_socket(&record.id));
        self.stop_engine(&record.id).await;
        self.runtime.stop(&record.id, Some(&record.init)).await?;
        self.net.stop(&record.id).await?;
        bundle::unmount_under(&self.layout.rootfs(&record.id))?;
        // After the unmount, so what goes is the empty file on the computer's own disk and never a mount: a
        // workspace asleep is one nothing holds a login open for, and the wake makes its points again.
        take_off_points(&self.layout, &record.id, &points_of(&self.layout, &record.id)?)?;
        Ok(())
    }

    /// A stopped workspace booted again over what it wrote before it stopped.
    async fn wake(&self, record: Workspace) -> Result<Workspace, OpError> {
        if !self.layout.upper(&record.id).is_dir() {
            return Err(OpError::plain(format!("workspace {} has nothing saved to boot from", record.id)));
        }
        self.boot(record).await
    }

    /// Every command run inside was asked for by somebody, so every one of them is the workspace working and keeps
    /// its quiet clock at zero: this computer asks a workspace nothing of its own any more, since the daemon that
    /// serves it is this one and a workspace that runs is a workspace that answers.
    async fn exec(&self, record: &Workspace, cmd: &str, stdin: Option<Vec<u8>>, timeout: Duration) -> Result<ExecResult, OpError> {
        self.net.touched(&record.id);
        let done = self.inside(record, cmd, stdin, timeout).await?;
        Ok(ExecResult { exit_code: done.exit_code, stdout: done.stdout, stderr: done.stderr })
    }

    /// The parts of one upload appended under its id; the last one lands the whole file through an exec that reads
    /// it on stdin, inside the workspace, so a link in the rootfs can never point the write at the box.
    #[allow(clippy::too_many_arguments)]
    async fn put_bytes(
        &self,
        record: &Workspace,
        path: &str,
        upload_id: &str,
        seq: u64,
        last: bool,
        data: &str,
        timeout: Duration,
    ) -> Result<(), OpError> {
        if upload_id.is_empty() || !upload_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return Err(OpError::plain(format!("{upload_id} is not an upload id")));
        }
        let part = self.layout.put(upload_id);
        let held = fs::metadata(&part).ok().map(|m| m.len());
        if (seq == 0) != held.is_none() {
            let _ = fs::remove_file(&part);
            return Err(OpError::plain(format!("part {seq} of {upload_id} is out of order; the upload is dropped and starts again")));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| OpError::plain(format!("part {seq} of {upload_id}: {e}")))?;
        if let Some(parent) = part.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new().append(true).create(true).open(&part)?;
        io::Write::write_all(&mut file, &bytes)?;
        drop(file);
        if !last {
            return Ok(());
        }
        let whole = fs::read(&part)?;
        let _ = fs::remove_file(&part);
        let script = land_script(path, whole.len());
        let done = self.exec(record, &script, Some(whole), timeout).await?;
        if done.exit_code != 0 {
            return Err(OpError::plain(format!("landing {path} on {} exited {}: {}", record.id, done.exit_code, done.stderr.trim())));
        }
        Ok(())
    }

    /// Kills, deletes, takes the network down, unmounts and removes every trace of the workspace under the root,
    /// and every container, network and volume it made on the engine, before its rootfs those containers may bind
    /// goes. An engine that does not answer leaves them, and the workspace goes all the same.
    async fn remove(&self, id: &str, init: Option<&Init>) -> Result<(), OpError> {
        self.disarm(id);
        self.told(|watcher| watcher.stopped(id));
        let _ = fs::remove_file(self.layout.guest_socket(id));
        self.stop_engine(id).await;
        let record = bundle::read_record(&self.layout.record(id))?;
        if record.as_ref().is_some_and(|record| record.engine) {
            if let Ok(socket) = engine::socket_of(&crate::doctor::read_facts()) {
                let _ = engine::remove_all(&socket, id).await;
            }
            // The networks went with them, and so do the rules their bridges carried.
            let _ = self.net.bridges_down(id);
        }
        self.runtime.kill(id, init).await?;
        self.net.down(id).await?;
        bundle::unmount_under(&self.layout.rootfs(id))?;
        // Every bind every life of this workspace staged for the engine, detached and gone with the containers
        // that mounted them.
        clear_binds(&self.layout.binds(id))?;
        take_off_points(&self.layout, id, &points_of(&self.layout, id)?)?;
        // After the unmount, and the way it was made: a snapshot is a subvolume the kernel takes away, a copied
        // tree is a tree. The copy is the workspace's own, so it goes with it.
        if let Some(made) = record.and_then(|record| record.copy) {
            copy::copier_of(made.made).remove(&self.layout.copy_of(id))?;
        }
        let dir = self.layout.workspace(id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        Ok(())
    }

    fn handle(&self, record: &Workspace, replayed: Option<bool>, seen: Option<MachineSeen>) -> MachineHandle {
        MachineHandle {
            id: record.id.clone(),
            kind: MachineKind::Sandbox,
            stream_url: None,
            labels: Some(record.labels.clone()),
            seen,
            replayed,
            // None: no daemon runs inside a workspace here, so nothing supervises one and no deploy reads this.
            daemon_supervisor: None,
            notice: None,
            roads: MachineRoads { preview_url: true, daemon_answers: true, put_bytes: true, describe: true, facts: false, metrics: true },
        }
    }

    /// One workspace as this computer reads it now: the sizes its cgroup was written with, what it holds of them
    /// this moment, and where its processes, its files and its address are. Every live figure is read where the
    /// kernel keeps it and dropped where it cannot be had, since a workspace may stop between the listing and this
    /// and a reading that refused for it would take the whole row with it; the sizes and the paths always answer.
    fn reading(&self, record: &Workspace) -> MachineReading {
        let cgroup = self.layout.cgroup_dir(&record.id);
        let live = runtime::alive(&record.init);
        MachineReading {
            state: self.state_of(record),
            cpu: record.cpu,
            mem_mb: record.mem_mb,
            mem_bytes: live.then(|| freeze::memory_current(&cgroup).ok()).flatten(),
            cpu_usage_usec: live.then(|| freeze::cpu_usage_usec(&cgroup).ok()).flatten(),
            uptime_ms: live.then(|| runtime::uptime_ms(&record.init).ok()).flatten(),
            procs: live.then(|| freeze::pids_in(&cgroup).ok()).flatten(),
            quiet_for_ms: live.then(|| self.net.quiet_for_ms(&record.id)).flatten(),
            address: self.net.record(&record.id).ok().flatten().map(|network| network.address.to_string()),
            cgroup: cgroup.display().to_string(),
            upper: self.layout.upper(&record.id).display().to_string(),
        }
    }

    /// Where one running workspace's files are on this computer: its rootfs under the run directory, which is the
    /// workspace's own view of / and the one place a path inside it resolves against. A stopped workspace has no
    /// rootfs mounted, so it is refused in the same sentence an exec into one is.
    pub fn rootfs_of_running(&self, id: &str) -> Result<PathBuf, OpError> {
        let record = self.running(id)?;
        Ok(self.layout.rootfs(&record.id))
    }

    /// A shell inside a running workspace, on a pty of that workspace's own, for the terminal pane of a machine
    /// this computer holds. The folder is the caller's and absolute, which is the one refusal the daemon's own
    /// switch answers before it reaches this; the environment is the workspace's own with the terminal named, as
    /// a thread's is.
    pub async fn pty_in(
        &self,
        id: &str,
        cols: u16,
        rows: u16,
        cwd: &str,
        shell: Option<&str>,
    ) -> Result<runtime::PtyInsideRunning, OpError> {
        let record = self.running(id)?;
        // Over the workspace's own boot environment, which the broker starts from as every tenant does: the
        // PATH the workspace booted with and the recipe's knobs are there and none of them is spelled here.
        let mut env = BTreeMap::from([
            ("HOME".to_owned(), "/root".to_owned()),
            ("USER".to_owned(), "root".to_owned()),
            ("TERM".to_owned(), TERM.to_owned()),
        ]);
        if record.engine {
            env.insert("COMPOSE_PROJECT_NAME".to_owned(), compose_project(&record.id));
        }
        // A login shell, as a person's terminal on any other machine opens: the workspace's own profile and the
        // person's own rc file, which are the computer's home bound inside.
        let args = match shell {
            Some(shell) => vec![shell.to_owned()],
            None => vec![SHELL_INSIDE.to_owned(), "-l".to_owned()],
        };
        let opts = runtime::PtyInside { cols, rows, cwd: cwd.to_owned(), args, env };
        self.runtime.pty(id, &opts).await.map_err(|e| OpError::plain(e.to_string()))
    }

    /// One command inside a running workspace, for the halves of this daemon that serve a workspace's own work:
    /// the git road runs here rather than on the computer, since a checkout's hooks and config are agent-written
    /// and belong inside the workspace's namespaces, its cgroup and its covers. Work, so the workspace's quiet
    /// clock starts over: somebody asked for this.
    pub async fn exec_in(&self, id: &str, cmd: &str, stdin: Option<Vec<u8>>, timeout: Duration) -> Result<runtime::Exec, OpError> {
        let record = self.running(id)?;
        self.net.touched(&record.id);
        self.inside(&record, cmd, stdin, timeout).await
    }

    /// The same command, read rather than run: a pane asking a workspace what its files and its checkout hold
    /// leaves the quiet clock where it was, however often it asks. A workspace nobody is working in is one this
    /// computer may stop, and a person with a pane open is not working in it.
    pub async fn read_in(&self, id: &str, cmd: &str, stdin: Option<Vec<u8>>, timeout: Duration) -> Result<runtime::Exec, OpError> {
        let record = self.running(id)?;
        self.inside(&record, cmd, stdin, timeout).await
    }

    /// The workspace is working: its quiet clock starts over. The one road the halves of this daemon that are
    /// not an exec take to say so, the pty's keystrokes and its output among them.
    pub fn touched(&self, id: &str) {
        self.net.touched(id);
    }

    /// One command inside, with neither the clock nor the machine op's shape: what both roads above share.
    async fn inside(&self, record: &Workspace, cmd: &str, stdin: Option<Vec<u8>>, timeout: Duration) -> Result<runtime::Exec, OpError> {
        let args = vec!["bash".to_owned(), "-c".to_owned(), format!("{}\n{cmd}", exec_env(record))];
        Ok(self.runtime.exec(&record.id, &args, stdin, timeout).await?)
    }

    fn record(&self, id: &str) -> Result<Workspace, OpError> {
        bundle::read_record(&self.layout.record(id))?.ok_or_else(|| OpError::no_workspace(id))
    }

    /// The record of a workspace whose init is the process it named; a stopped one has nothing to exec into.
    fn running(&self, id: &str) -> Result<Workspace, OpError> {
        let record = self.record(id)?;
        if !runtime::alive(&record.init) {
            return Err(OpError::plain(format!("workspace {} is stopped", record.id)));
        }
        Ok(record)
    }

    fn records(&self) -> Result<Vec<Workspace>, OpError> {
        records_under(&self.layout)
    }

    /// The mount points the other workspaces on this computer have put on its disk: what tells a point of wsp's
    /// own from a file the person had at that path, since only the first of the two is ever taken off. Read off
    /// every claim under the run directory through the one reader, records and claim files together, because a
    /// create still inside its boot has written its claim's file and no record yet, and a boot that read the
    /// records alone would take its neighbour's point for the person's own.
    fn points_of_others(&self, id: &str) -> Result<Vec<String>, OpError> {
        let mut points = Vec::new();
        for entry in read_dir_or_none(&self.layout.run())?.unwrap_or_default() {
            let other = entry.file_name().to_string_lossy().into_owned();
            if other == id {
                continue;
            }
            points.extend(points_of(&self.layout, &other)?);
        }
        Ok(points)
    }
}

/// The mount points one workspace put on the computer's own disk, wherever they are written down: the record's
/// list where a record stands, the claim's own file where a boot wrote one and no record has taken it over yet,
/// and both together where both stand, which is a wake that failed after making a point its standing record does
/// not name. One reader, so the boot, the remove and the open's sweep of claims nobody finished all answer for
/// the same points; a name in it that answers nothing costs the take-off below nothing.
fn points_of(layout: &Layout, id: &str) -> Result<Vec<String>, OpError> {
    let mut points = bundle::read_record(&layout.record(id))?.map(|record| record.made_points).unwrap_or_default();
    for point in bundle::read_points(&layout.points(id))? {
        if !points.contains(&point) {
            points.push(point);
        }
    }
    Ok(points)
}

/// The empty files a workspace's boot made on the computer's own disk, taken off now that its mounts are down: a
/// file share lands at the agent's own path inside, and under the computer's own home that path is the computer's,
/// where the tool running on the computer itself would read the empty file as its login.
///
/// Two rules hold it to that workspace's own leavings. A point another workspace here still has bound stays, read
/// off the records as the sweep reads them, since one workspace's stop may not unlink a mount point another is
/// holding. And only an empty file goes: a sign-in made on the computer itself since the boot wrote the person's
/// own login into that file, and it is theirs. The folder the point sits in stays, as the leave leaves ~/.codex
/// and ~/.claude-cfg: those are the agents' own to make and to keep.
///
/// Over the layout and not over the ops, since the open's sweep of unfinished claims runs before there are any.
fn take_off_points(layout: &Layout, id: &str, points: &[String]) -> Result<(), OpError> {
    if points.is_empty() {
        return Ok(());
    }
    let running = running_ids(layout)?;
    let bound: Vec<String> = records_under(layout)?
        .into_iter()
        .filter(|record| record.id != id && running.contains(&record.id))
        .flat_map(|record| record.shares.into_iter().map(|share| share.target))
        .collect();
    for point in points {
        if bound.iter().any(|target| target == point) {
            continue;
        }
        // Walked from the tree it sits under with no link followed and unlinked through its folder's own
        // descriptor: a link one of these paths now runs through is somebody's, and the point stays standing.
        if let Some(why) = bundle::take_off_point(point).map_err(|e| OpError::plain(e.to_string()))? {
            eprintln!("{why}");
        }
    }
    Ok(())
}

/// The mount point each of a workspace's file shares needs inside, made where nothing carries one, and the ones
/// of wsp's own among them named under the claim as they are made: the shares to write into the config, and the
/// points to write into the record.
///
/// A name goes into the claim's file the moment the file it names exists, and the file is rewritten at every
/// name. A boot that refuses partway through this loop, on a target that is no path inside a workspace or a disk
/// with nothing left, has already put the earlier points on the computer's own home, and until the record is
/// written the claim's file is the only thing that can name them for the remove and the open's sweep. One the
/// walk refused made no file, so there is nothing of it to take off.
///
/// The point recorded is where the file landed and not where the share asked for it: under the home every
/// workspace here shares, a link the box root keeps is followed once, so the empty file sits at the link's target
/// and that is the path the take-off has to find it by, which is also why the name is known only once the walk
/// has run.
fn make_points(
    place: &bundle::Inside,
    layout: &Layout,
    id: &str,
    wanted: &[Share],
    held: &[String],
) -> Result<(Vec<Share>, Vec<String>), OpError> {
    let mut shares = Vec::new();
    let mut made_points = Vec::new();
    for share in wanted {
        if !Path::new(&share.source).is_file() {
            continue;
        }
        let opened = bundle::open_inside(place, &share.target, bundle::Want::File, bundle::BoxLink::FollowedOnce)?;
        if point_is_ours(&opened.landed, !opened.made, held) {
            made_points.push(opened.landed.clone());
            bundle::write_json(&layout.points(id), &made_points)?;
        }
        shares.push(share.clone());
    }
    Ok((shares, made_points))
}

/// Whether a mount point a boot has just made for a file share is that workspace's to take off when it goes: one
/// under a tree the rootfs takes from the computer, since anywhere else it is the workspace's own upper and goes
/// with it, and either made by this boot or already named by another workspace here as a point of wsp's. A file
/// that was there before any workspace asked for it is the person's and is never recorded.
fn point_is_ours(target: &str, stood: bool, held: &[String]) -> bool {
    bundle::under_computer_tree(target).is_some() && (!stood || held.iter().any(|point| point == target))
}

/// Where this workspace's containers may bind from, off its own record: the copy of a checkout at the path it is
/// mounted inside, and every folder of this computer's the create bound in, each paired with the directory on the
/// box behind it. Nothing a workspace writes is read here, which is what makes the allowlist an authority.
fn bind_roots(layout: &Layout, record: &Workspace) -> Vec<(String, PathBuf)> {
    let mut roots: Vec<(String, PathBuf)> = record.copy.iter().map(|made| (made.at.clone(), layout.copy_of(&record.id))).collect();
    roots.extend(record.binds.iter().map(|bind| (bind.target.clone(), PathBuf::from(&bind.source))));
    roots
}

/// What tells one life of a workspace from the next, which is the first half of every staging entry's name that
/// life makes: the init's own boot id, start and pid, which together are what tell its process from any other
/// the kernel hands the same number to.
fn life_of(init: &Init) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in init.boot_id.bytes().chain(init.started.to_string().bytes()).chain(init.pid.to_string().bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The staging directory ready for the fence about to serve: made where it is not there, and left exactly as it
/// is where it is. Nothing is detached and nothing removed here, since a container the engine still holds mounts
/// the entry its own life was given and its next start resolves that entry again.
fn ready_binds(binds: &Path) -> Result<(), OpError> {
    fs::create_dir_all(binds).map_err(|e| OpError::plain(format!("{}: {e}", binds.display())))
}

/// Every bind the fence staged detached and the directory holding them gone.
fn clear_binds(binds: &Path) -> Result<(), OpError> {
    bundle::unmount_inside(binds).map_err(|e| OpError::plain(format!("{}: {e}", binds.display())))?;
    match fs::remove_dir_all(binds) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(OpError::plain(format!("{}: {e}", binds.display()))),
    }
}

/// The rule one engine bridge of a workspace gets on the box, written the moment the engine has made the link
/// and taken off with the network it was written for. Read on the fence's own task, since the create waits on
/// the answer: a link dump and one rule are one netlink turn each.
struct Bridged {
    net: Arc<Net>,
}

impl engine::Bridges for Bridged {
    fn made(&self, workspace: &str, bridge: &str) -> bool {
        self.net.bridge_up(workspace, bridge).unwrap_or(false)
    }

    fn gone(&self, workspace: &str, bridge: &str) {
        let _ = self.net.bridge_down(workspace, bridge);
    }
}

/// The join of a container's published port to the workspace's loopback, made off the proxy's own task once the
/// engine has taken the start; a workspace whose init is gone gets none.
struct Inward {
    net: Arc<Net>,
    root: PathBuf,
}

impl Ports for Inward {
    fn published(&self, workspace: &str, inside: u16, box_port: u16) {
        let Ok(Some(record)) = bundle::read_record(&Layout::new(&self.root).record(workspace)) else { return };
        if !runtime::alive(&record.init) {
            return;
        }
        let net = Arc::clone(&self.net);
        let id = workspace.to_owned();
        let pid = record.init.pid;
        tokio::spawn(async move {
            let _ = net.forward_inward(&id, pid, inside, box_port).await;
        });
    }
}

fn records_under(layout: &Layout) -> Result<Vec<Workspace>, OpError> {
    {
        let run = layout.run();
        let mut out = Vec::new();
        let entries = match fs::read_dir(&run) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(OpError::plain(format!("{}: {e}", run.display()))),
        };
        for entry in entries {
            let entry = entry.map_err(|e| OpError::plain(format!("{}: {e}", run.display())))?;
            if let Some(record) = bundle::read_record(&entry.path().join("workspace.json"))? {
                out.push(record);
            }
        }
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }
}

/// Every record whose init is not the process it named any more and whose stop nobody asked for: its overlay is
/// detached and youki's state removed, so no read goes through the stale pid; the run directory with its upper
/// stays, and the wake boots from it. A workspace stopped on purpose left no state behind and is not named.
fn mark_stopped(layout: &Layout) -> Result<Vec<String>, OpError> {
    let mut stopped = Vec::new();
    for record in records_under(layout)? {
        if runtime::alive(&record.init) {
            continue;
        }
        bundle::unmount_under(&layout.rootfs(&record.id))?;
        let state = layout.state_of(&record.id);
        if state.exists() {
            fs::remove_dir_all(&state).map_err(|e| OpError::plain(format!("{}: {e}", state.display())))?;
            stopped.push(record.id);
        }
    }
    Ok(stopped)
}

/// Every claimed run directory and every copy that no record names, taken away. A create claims its run
/// directory first and writes its record last, so a daemon that died anywhere between the two leaves a
/// directory naming no workspace and, where the create had got that far, a copy of a checkout or of part of
/// one. None of it is anything a machine op can reach, and all of it wedges the key it was claimed under until
/// somebody removes it by hand, so the open is where it goes.
///
/// The claims go first, and their mounts with them: a dead create may have left the whole rootfs standing with
/// the copy bound into it, and a copy removed at its source while that bind is up would be deleted through the
/// bind before anything took the mount down.
fn sweep_unfinished(layout: &Layout) -> Result<Unfinished, OpError> {
    let mut swept = Unfinished::default();
    if let Some(entries) = read_dir_or_none(&layout.run())? {
        for entry in entries {
            let id = entry.file_name().to_string_lossy().into_owned();
            if bundle::read_record(&layout.record(&id))?.is_some() {
                continue;
            }
            // Everything under the rootfs first, as the stop and the sweep of a stopped workspace both do: a
            // daemon that died between the mounts and the record left the box's directories standing under
            // there with the copy bound into them, and a remove that walked in would delete the copy's files
            // through that bind and then answer EBUSY on the mount point itself, which refuses the open rather
            // than clearing it.
            bundle::unmount_under(&layout.rootfs(&id))?;
            // After the unmount and before the claim goes, since the claim's own file is the only thing naming
            // what that create put on the computer's own home and it goes with the directory below.
            take_off_points(layout, &id, &points_of(layout, &id)?)?;
            let path = entry.path();
            fs::remove_dir_all(&path).map_err(|e| OpError::plain(format!("{}: {e}", path.display())))?;
            swept.claims.push(id);
        }
    }
    if let Some(entries) = read_dir_or_none(&layout.copies())? {
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            // A copy belongs to one workspace and to nothing else, so at open a copy whose workspace has no
            // record is a create that died, whether it died before the rename that takes the mark off or
            // after it. Both wedge the same key the same way: the next create under it claims the run
            // directory again and then cannot put its own copy where that one sits.
            if bundle::read_record(&layout.record(&Layout::copy_belongs_to(&name)))?.is_some() {
                continue;
            }
            let path = entry.path();
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                // A probe file a daemon died beside, which is a file and not a copy.
                fs::remove_file(&path).map_err(|e| OpError::plain(format!("{}: {e}", path.display())))?;
                swept.copies.push(name);
                continue;
            }
            // However it was made: a snapshot is a subvolume the kernel takes away, and a tree is a tree.
            if copy::copier_of(CopyWord::Snapshot).remove(&path).is_err() {
                copy::copier_of(CopyWord::Plain).remove(&path).map_err(|e| OpError::plain(format!("{}: {e}", path.display())))?;
            }
            swept.copies.push(name);
        }
    }
    // A directory hands its entries back in whatever order it keeps them, and this is read by a person in a
    // log line and by a test.
    swept.copies.sort();
    swept.claims.sort();
    Ok(swept)
}

/// The entries of a directory, or nothing where there is no such directory.
fn read_dir_or_none(dir: &Path) -> Result<Option<Vec<fs::DirEntry>>, OpError> {
    match fs::read_dir(dir) {
        Ok(entries) => entries.collect::<io::Result<Vec<_>>>().map(Some).map_err(|e| OpError::plain(format!("{}: {e}", dir.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(OpError::plain(format!("{}: {e}", dir.display()))),
    }
}

/// The workspaces whose init is still the process their record names: created, running or frozen.
fn running_ids(layout: &Layout) -> Result<Vec<String>, OpError> {
    Ok(records_under(layout)?.into_iter().filter(|record| runtime::alive(&record.init)).map(|record| record.id).collect())
}

impl Ops {
    fn list(&self, labels: Option<&BTreeMap<String, String>>) -> Result<Vec<MachineListRow>, OpError> {
        Ok(self
            .records()?
            .into_iter()
            .filter(|record| labels.is_none_or(|wanted| wanted.iter().all(|(k, v)| record.labels.get(k) == Some(v))))
            .map(|record| MachineListRow {
                id: record.id.clone(),
                state: self.state_of(&record),
                size: match (record.cpu, record.mem_mb) {
                    (Some(cpu), Some(mem_mb)) => Some(WorkspaceSize { cpu, mem_mb }),
                    _ => None,
                },
                labels: record.labels,
            })
            .collect())
    }

    /// created reads starting and a stopped workspace reads paused: under a disk pause a stop is a nap, as the
    /// Docker backend reads an exited container, and its upper directory is what the wake boots. A record whose
    /// init is not the process it named is stopped before youki is asked, since youki reads any process on that
    /// pid as the container; one whose upper directory is gone too is gone. A live init whose youki state reads
    /// stopped, is missing or does not load is a workspace this daemon can neither nap nor wake, and reads gone
    /// rather than a nap the resume could not do.
    pub fn state_of(&self, record: &Workspace) -> MachineState {
        if !runtime::alive(&record.init) {
            return if self.layout.upper(&record.id).is_dir() { MachineState::Paused } else { MachineState::Gone };
        }
        match self.runtime.status(&record.id) {
            Ok(Status::Creating | Status::Created) => MachineState::Starting,
            Ok(Status::Paused) => MachineState::Paused,
            Ok(Status::Running) => MachineState::Running,
            Ok(Status::Stopped | Status::Gone) | Err(_) => MachineState::Gone,
        }
    }
}

#[derive(Serialize)]
struct Empty {}

fn body<T: Serialize>(value: T) -> Result<Value, OpError> {
    serde_json::to_value(value).map_err(|e| OpError::plain(e.to_string()))
}

fn text(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("a frame serialises")
}

fn deadline(timeout_ms: Option<u32>) -> Duration {
    timeout_ms.map_or(EXEC_DEFAULT, |ms| Duration::from_millis(u64::from(ms)))
}

/// An idempotency key as a workspace id: lower case letters, digits, dot, underscore and hyphen, as youki takes
/// an id and Docker takes a name, anything else a hyphen, nothing leading with a dot or a hyphen, 128 at most.
pub fn workspace_word(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let trimmed = cleaned.trim_start_matches(['.', '-']);
    let word = if trimmed.is_empty() { "snapshot" } else { trimmed };
    word.chars().take(128).collect()
}

/// The moment as the wire carries it, ISO 8601 in UTC to the millisecond.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Sixteen hex digits nothing else on the box is writing under, for the id of a workspace no key names.
fn random_word() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    let read = fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if read.is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        bytes.copy_from_slice(&(nanos as u64 ^ u64::from(std::process::id())).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A word in single quotes for sh.
fn quoted(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// The script that lands stdin at the path: the parent made, the bytes counted before the file moves into place.
pub fn land_script(path: &str, count: usize) -> String {
    let dir =
        Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()).filter(|p| !p.is_empty()).unwrap_or_else(|| "/".to_owned());
    let tmp = format!("{path}.in");
    [
        "set -e".to_owned(),
        "umask 022".to_owned(),
        format!("mkdir -p {}", quoted(&dir)),
        format!("cat > {}", quoted(&tmp)),
        format!("[ \"$(wc -c < {} | tr -d ' ')\" = {count} ] || {{ rm -f {}; echo short >&2; exit 1; }}", quoted(&tmp), quoted(&tmp)),
        format!("mv -f {} {}", quoted(&tmp), quoted(path)),
    ]
    .join("\n")
}

/// The refusal for an op nothing here serves, as the stub before this crate answered every op.
pub fn stub(id: Option<RequestId>, op: &str) -> String {
    text(&answer_machine_op(id, op))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::size::LEAST_MEM_MB;

    #[test]
    fn the_id_word_is_what_youki_and_docker_both_take() {
        assert_eq!(workspace_word("smoke-default-A1"), "smoke-default-a1");
        assert_eq!(workspace_word("ws:one/two three"), "ws-one-two-three");
        assert_eq!(workspace_word("..--x"), "x");
        assert_eq!(workspace_word("!!!"), "snapshot");
        assert_eq!(workspace_word(&"a".repeat(200)).len(), 128);
    }

    #[test]
    fn the_land_script_quotes_the_path_and_counts_the_bytes() {
        let script = land_script("/root/it's here/x.bin", 13);
        assert!(script.contains("mkdir -p '/root/it'\\''s here'"));
        assert!(script.contains("cat > '/root/it'\\''s here/x.bin.in'"));
        assert!(script.contains("= 13 ]"));
        assert!(script.ends_with("mv -f '/root/it'\\''s here/x.bin.in' '/root/it'\\''s here/x.bin'"));
        assert!(land_script("top", 1).contains("mkdir -p '/'"));
    }

    /// The box the size rule is read against here, as the size module's own tests read it: two cores and four
    /// gigabytes, the shape of the box a fork took whole.
    fn small_box() -> BoxFacts {
        BoxFacts { cores: 2, mem_mb: 4096 }
    }

    #[test]
    fn the_clamped_size_is_what_the_cgroup_is_written_with() {
        let given = size_on_box(&small_box(), Some(2.0), Some(4096));
        let spec = bundle::config_json(&Config {
            hostname: "wsp-x",
            args: &["/bin/true".to_owned()],
            envs: &BTreeMap::new(),
            cpu: Some(given.cpu),
            mem_mb: Some(given.mem_mb),
            cgroup: "/wsp/wsp-x",
            init: Path::new("/bin/true"),
            etc: Path::new("/tmp"),
            engine: None,
            shares: &[],
            binds: &[],
            tool_roots: &[],
            compose_project: None,
        });
        // One core of every period, and a third of the box's four gigabytes.
        assert_eq!(spec["linux"]["resources"]["cpu"], serde_json::json!({ "quota": 100_000, "period": 100_000 }));
        assert_eq!(spec["linux"]["resources"]["memory"], serde_json::json!({ "limit": 1365u64 * 1024 * 1024 }));
    }

    /// A container the engine still holds from an earlier life names the staging entry that life gave it, so a
    /// stop leaves every entry standing and the remove is what takes them; and two lives of one workspace never
    /// name one entry.
    #[tokio::test]
    async fn the_staged_binds_outlive_a_stop_and_go_at_the_remove() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let binds = ops.layout.binds("wsp-a");
        fs::create_dir_all(binds.join("earlier-0")).unwrap();
        // What a wake and a daemon restart run before the fence serves again: the directory is made where it is
        // not there and every entry of the life before stands, since the engine still holds what mounts them.
        ready_binds(&binds).unwrap();
        assert!(binds.join("earlier-0").is_dir(), "the road a restore takes emptied the entries of the life before");
        ops.stop_engine("wsp-a").await;
        assert!(binds.join("earlier-0").is_dir(), "a stop took the entry a container made in an earlier life mounts");
        clear_binds(&binds).unwrap();
        assert!(!binds.exists(), "the remove left the staging directory standing");
        // One life, one name; and a name of its own at every boot, since the entries of two lives sit side by side.
        let life = |pid, started, boot: &str| life_of(&Init { pid, started, boot_id: boot.to_owned() });
        assert_eq!(life(7, 1200, "b"), life(7, 1200, "b"));
        assert_ne!(life(7, 1200, "b"), life(7, 1201, "b"));
        assert_ne!(life(7, 1200, "b"), life(8, 1200, "b"));
        assert_ne!(life(7, 1200, "b"), life(7, 1200, "c"));
    }

    /// The workspace a refusal names, and the one every exec carries the compose project of.
    fn awake(id: &str, name: Option<&str>) -> Workspace {
        let mut labels = BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]);
        if let Some(name) = name {
            labels.insert(NAME_LABEL.to_owned(), name.to_owned());
        }
        Workspace {
            id: id.to_owned(),
            hostname: id.to_owned(),
            labels,
            envs: BTreeMap::new(),
            cpu: Some(1.0),
            mem_mb: Some(1024),
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
            init: Init { pid: 1, started: 0, boot_id: String::new() },
            engine: false,
            copy: None,
            shares: Vec::new(),
            binds: Vec::new(),
            made_points: Vec::new(),
        }
    }

    /// What the daemon serving this computer is told, as a case can read it back.
    #[derive(Default)]
    struct Heard(std::sync::Mutex<Vec<String>>);

    impl Heard {
        fn said(&self) -> Vec<String> {
            self.0.lock().unwrap_or_else(|held| held.into_inner()).clone()
        }
    }

    impl Watches for Heard {
        fn booted(&self, id: &str, socket: &Path) {
            self.0.lock().unwrap_or_else(|held| held.into_inner()).push(format!("booted {id} {}", socket.display()));
        }

        fn stopped(&self, id: &str) {
            self.0.lock().unwrap_or_else(|held| held.into_inner()).push(format!("stopped {id}"));
        }
    }

    /// A daemon that restarted under running workspaces stands where one that booted them would: every workspace
    /// still running is named as it takes them over, with the folder of its own that is mounted over the wsp
    /// folder inside it, and one that is stopped is not. What a boot and a stop say after that is the live
    /// case's, since neither runs without the kernel.
    #[tokio::test]
    async fn taking_the_workspaces_over_names_every_one_of_them_that_is_running() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Arc::new(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap());
        let layout = Layout::new(dir.path());
        let running = runtime::identity_of(std::process::id() as i32).unwrap();
        for (id, init) in [("wsp-awake", running), ("wsp-asleep", Init { pid: i32::MAX, started: 0, boot_id: String::new() })] {
            let mut record = awake(id, None);
            record.init = init;
            fs::create_dir_all(layout.workspace(id)).unwrap();
            bundle::write_json(&layout.record(id), &record).unwrap();
        }
        let heard = Arc::new(Heard::default());
        ops.watch(Arc::clone(&heard) as Arc<dyn Watches>).unwrap();
        assert_eq!(heard.said(), [format!("booted wsp-awake {}", layout.guest_socket("wsp-awake").display())]);
    }

    /// The death of an init is heard as the death of the workspace it runs, even where the kernel still holds the
    /// pid: a process that was killed is a zombie until its parent reaps it, and a watch that read that as a
    /// workspace still running left the door standing inside a workspace with nothing behind it. What the rest of
    /// the stop road does without the kernel is the live case's; the door going is what this one reads.
    #[tokio::test]
    async fn an_init_killed_and_not_yet_reaped_is_the_death_its_watch_was_armed_for() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Arc::new(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap());
        let layout = Layout::new(dir.path());
        let id = "wsp-watched";
        // A child of this case, so nobody else reaps it: after the kill it stays a zombie until the line at the
        // end of this case, which is the state the watch has to read as a death.
        let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut record = awake(id, None);
        record.init = runtime::identity_of(child.id() as i32).unwrap();
        fs::create_dir_all(layout.wsp_home(id)).unwrap();
        bundle::write_json(&layout.record(id), &record).unwrap();
        let door = layout.guest_socket(id);
        fs::write(&door, b"").unwrap();

        ops.watch(Arc::new(Heard::default()) as Arc<dyn Watches>).unwrap();
        assert!(ops.deaths.lock().unwrap().contains_key(id), "the running workspace's init is watched by nothing");
        child.kill().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while door.exists() {
            assert!(std::time::Instant::now() < deadline, "the door stands on a workspace whose init is gone");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.wait().unwrap();
    }

    /// A workspace record whose init is a process of the case's own, running, with the door's socket file in the
    /// folder a stop takes it out of and the upper a wake would boot from.
    fn record_on(layout: &Layout, id: &str, pid: i32) -> Workspace {
        let mut record = awake(id, None);
        record.init = runtime::identity_of(pid).unwrap();
        fs::create_dir_all(layout.wsp_home(id)).unwrap();
        fs::create_dir_all(layout.upper(id)).unwrap();
        fs::write(layout.guest_socket(id), b"").unwrap();
        bundle::write_json(&layout.record(id), &record).unwrap();
        record
    }

    /// Something to watch that ends when the case says so, and nothing else: the init of a workspace here holds
    /// the workspace up and does no work of its own either.
    fn a_process_that_waits() -> std::process::Child {
        std::process::Command::new("sleep").arg("30").spawn().unwrap()
    }

    /// Waits for the words the daemon was told, or gives up and prints what it was told instead.
    async fn heard_within(heard: &Heard, want: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !heard.said().iter().any(|line| line == want) {
            assert!(std::time::Instant::now() < deadline, "{want} was never said; {:?}", heard.said());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// An init that ends on its own ends its workspace the way a stop does: the daemon is told the same word, the
    /// socket the door was bound on goes with it, and the workspace reads as a nap the wake boots from. The rest
    /// of the stop road wants the kernel and is the live case's.
    #[tokio::test]
    async fn a_workspace_whose_init_dies_on_its_own_is_stopped_the_way_a_stop_stops_it() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Arc::new(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap());
        let layout = Layout::new(dir.path());
        let mut init = a_process_that_waits();
        let record = record_on(&layout, "wsp-dies", init.id() as i32);
        let heard = Arc::new(Heard::default());
        ops.watch(Arc::clone(&heard) as Arc<dyn Watches>).unwrap();
        assert_eq!(heard.said(), [format!("booted wsp-dies {}", layout.guest_socket("wsp-dies").display())]);

        init.kill().unwrap();
        init.wait().unwrap();
        heard_within(&heard, "stopped wsp-dies").await;
        assert!(!layout.guest_socket("wsp-dies").exists(), "the socket stands on a workspace whose init is gone");
        assert_eq!(ops.state_of(&record), MachineState::Paused);
    }

    /// A stop takes the watch off before it runs, so the init it kills is a death this computer asked for: the
    /// daemon hears one word and the stop road runs once.
    #[tokio::test]
    async fn a_stop_under_way_is_not_stopped_a_second_time_by_its_own_watch() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Arc::new(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap());
        let layout = Layout::new(dir.path());
        let mut init = a_process_that_waits();
        let record = record_on(&layout, "wsp-stops", init.id() as i32);
        let heard = Arc::new(Heard::default());
        ops.watch(Arc::clone(&heard) as Arc<dyn Watches>).unwrap();

        let _ = ops.stop(&record).await;
        init.kill().unwrap();
        init.wait().unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(heard.said().iter().filter(|line| *line == "stopped wsp-stops").count(), 1, "{:?}", heard.said());
    }

    /// A workspace here runs no daemon of its own: it boots one process that holds it up, nothing supervises a
    /// daemon inside it, and the daemon that answers for it is this one, which answers whether the workspace runs.
    #[tokio::test]
    async fn a_workspace_here_boots_one_process_and_this_daemon_answers_for_it() {
        // No shell, no supervisor script, nothing to look for: the boot is the one process execs reach it through.
        assert_eq!(boot_cmd(), vec!["sleep".to_owned(), "infinity".to_owned()]);
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let layout = Layout::new(dir.path());
        let running = runtime::identity_of(std::process::id() as i32).unwrap();
        for (id, init) in [("wsp-awake", running), ("wsp-asleep", Init { pid: i32::MAX, started: 0, boot_id: String::new() })] {
            let mut record = awake(id, None);
            record.init = init;
            fs::create_dir_all(layout.upper(id)).unwrap();
            bundle::write_json(&layout.record(id), &record).unwrap();
        }
        let answers = async |id: &str| -> Value {
            let frame = serde_json::json!({ "id": 1, "op": "machine.daemonAnswers", "machineId": id, "timeoutMs": 1000 });
            serde_json::from_str(&ops.answer(Some(RequestId::from(1)), &frame).await).unwrap()
        };
        // Read off the record and nothing else: this workspace's init is a live process, so its daemon answers.
        // Nothing was execed inside it, which a workspace with no container would have failed at.
        assert_eq!(answers("wsp-awake").await, serde_json::json!({ "id": 1, "ok": true, "answers": true }));
        // A stopped workspace answers no rather than refusing: the poll reads it as napping off its state.
        assert_eq!(answers("wsp-asleep").await, serde_json::json!({ "id": 1, "ok": true, "answers": false }));
        // And a workspace this computer does not know is the missing refusal, as every other op answers it.
        let unknown = answers("wsp-x").await;
        assert_eq!(
            (unknown["ok"].as_bool(), unknown["error"].as_str(), unknown["kind"].as_str()),
            (Some(false), Some("no such workspace: wsp-x"), Some("missing"))
        );
        // The handle names no supervisor: nothing keeps a daemon up inside a workspace here, and no deploy reads it.
        let handle = serde_json::from_str::<Value>(
            &ops.answer(Some(RequestId::from(1)), &serde_json::json!({ "id": 1, "op": "machine.get", "machineId": "wsp-awake" })).await,
        )
        .unwrap();
        assert_eq!(handle["ok"], true, "{handle}");
        assert!(handle["machine"].get("daemonSupervisor").is_none(), "{handle}");
        // The two roads the daemon's own halves take into a running workspace: its rootfs, and a command inside.
        assert_eq!(ops.rootfs_of_running("wsp-awake").unwrap(), layout.rootfs("wsp-awake"));
        assert_eq!(ops.rootfs_of_running("wsp-asleep").unwrap_err().message, "workspace wsp-asleep is stopped");
        assert_eq!(ops.rootfs_of_running("wsp-x").unwrap_err().message, "no such workspace: wsp-x");
        assert_eq!(
            ops.exec_in("wsp-asleep", "true", None, Duration::from_secs(1)).await.unwrap_err().message,
            "workspace wsp-asleep is stopped"
        );
        assert_eq!(ops.exec_in("wsp-x", "true", None, Duration::from_secs(1)).await.unwrap_err().message, "no such workspace: wsp-x");
    }

    /// A create a box has no room for is refused in one sentence, and the sentence names the workspace to stop:
    /// the awake one nobody has asked anything of for the longest, by the name the person gave it.
    #[test]
    fn a_box_with_no_room_names_the_quietest_awake_workspace_to_stop() {
        assert_eq!(
            box_full_refusal(2582, 900, Some(("landing-a".to_owned(), 34))),
            "this computer has 900 MB free and a workspace needs 2582 MB; stop landing-a, quiet for 34 min, to make room"
        );
        // A workspace created without a name of its own is named by its id, which is what a person sees in the
        // listing for it.
        let no_name = workspace_name(&awake("wsp-8fef733ad777", None));
        assert!(box_full_refusal(2582, 900, Some((no_name, 0))).contains("stop wsp-8fef733ad777, quiet for 0 min"));
        assert_eq!(workspace_name(&awake("wsp-a", Some("landing-b"))), "landing-b");
        // An empty name label is no name: the id says more than nothing does.
        assert_eq!(workspace_name(&awake("wsp-a", Some(""))), "wsp-a");
        // And a box whose own work filled it has nothing of ours to name, and says that rather than naming
        // nothing.
        let none = box_full_refusal(2582, 120, None);
        assert!(none.starts_with("this computer has 120 MB free and a workspace needs 2582 MB, and no"), "{none}");
        assert!(none.ends_with("the computer's own work"), "{none}");
    }

    /// The room check end to end, on records this process is the init of, so they read awake without a container:
    /// what the kernel says is free against what the workspace would be capped at, and the sentence naming the
    /// one to stop.
    #[test]
    fn a_create_with_no_room_on_the_box_is_refused_and_a_box_with_room_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let layout = Layout::new(dir.path());
        // Two workspaces of ours, awake because their records name this process as their init.
        let mine = runtime::identity_of(std::process::id() as i32).unwrap();
        for (id, name) in [("wsp-one", "landing-a"), ("wsp-two", "landing-b")] {
            fs::create_dir_all(layout.upper(id)).unwrap();
            let mut record = awake(id, Some(name));
            record.init = mine.clone();
            bundle::write_json(&layout.record(id), &record).unwrap();
        }
        // A box that says nothing about what is free holds a create to the size rule alone, which is every
        // computer that is not a box.
        assert_eq!(ops.no_room_for(2582, None).unwrap(), None);
        // Room for it: nothing is said and nothing is refused.
        assert_eq!(ops.no_room_for(2582, Some(4096)).unwrap(), None);
        assert_eq!(ops.no_room_for(2582, Some(2582)).unwrap(), None);
        // No room: one sentence, naming the awake workspace nobody has asked anything of for longest. The second
        // one's clock started first and the first one was touched since, so the second is the one to stop.
        ops.net.quiet_of("wsp-two");
        std::thread::sleep(Duration::from_millis(60));
        ops.net.touched("wsp-one");
        let refused = ops.no_room_for(2582, Some(900)).unwrap().unwrap();
        assert_eq!(refused, box_full_refusal(2582, 900, Some(("landing-b".to_owned(), 0))));
        assert!(refused.contains("stop landing-b"), "{refused}");
        // And a workspace that is not awake is not a workspace to stop: with neither of them running, the box's
        // own work is what is holding it.
        for id in ["wsp-one", "wsp-two"] {
            let mut record = bundle::read_record(&layout.record(id)).unwrap().unwrap();
            record.init = Init { pid: i32::MAX, started: 0, boot_id: String::new() };
            bundle::write_json(&layout.record(id), &record).unwrap();
        }
        assert_eq!(ops.no_room_for(2582, Some(900)).unwrap().unwrap(), box_full_refusal(2582, 900, None));
    }

    /// A create retried under a key this box already holds a workspace for is that workspace's handle, whatever
    /// the room: the client retries a create whose answer the link dropped, and the workspace it is asking about
    /// is already holding the memory the room check would refuse it for. The refusal is for a create that would
    /// make a new one, and it gives the claim back so the key is not wedged.
    #[tokio::test]
    async fn a_retry_under_a_key_the_box_already_holds_a_workspace_for_is_answered_and_not_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let layout = Layout::new(dir.path());
        let key = "landing-a";
        let id = format!("wsp-{}", workspace_word(key));
        let asking = MachineSpec { idempotency_key: Some(key.to_owned()), ..bare_spec() };

        // No room at all, and no workspace under the key yet: one sentence, and the claim it took is given back.
        let refused = ops.create_with_room(asking.clone(), Some(1)).await.unwrap_err().message;
        assert_eq!(refused, box_full_refusal(ops.facts().machine_mem_mb(), 1, None));
        assert!(!layout.workspace(&id).exists(), "the refusal kept the claim");

        // The same create once its workspace stands: the handle of the workspace the first one made, marked as
        // the answer to a create that was already served, and no refusal though the box is just as full.
        fs::create_dir_all(layout.upper(&id)).unwrap();
        let mut record = awake(&id, Some(key));
        record.init = Init { pid: i32::MAX, started: 0, boot_id: String::new() };
        bundle::write_json(&layout.record(&id), &record).unwrap();
        let handle = ops.create_with_room(asking, Some(1)).await.unwrap();
        assert_eq!((handle.id.as_str(), handle.replayed), (id.as_str(), Some(true)));
        // And the create that would make a new one is still refused, key or no key.
        assert!(ops.create_with_room(bare_spec(), Some(1)).await.is_err());
    }

    /// The wall between a workspace's own mounts and the computer's directories: a copy or a folder whose
    /// destination is one of the trees the rootfs takes from the computer, or sits under one, is refused at the
    /// create and at every boot, and a destination of the workspace's own is taken.
    #[tokio::test]
    async fn a_destination_under_the_computers_own_trees_is_refused_at_the_create_and_at_the_boot() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let layout = Layout::new(dir.path());
        let checkout = layout.projects().join("a-checkout");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("README.md"), "the checkout\n").unwrap();

        // A copy whose destination is the person's own home: one sentence, and the claim the create took is
        // given back with it, so nothing of a refused create is left anywhere.
        let key = "copy-under-root";
        let id = format!("wsp-{}", workspace_word(key));
        let asking = MachineSpec {
            idempotency_key: Some(key.to_owned()),
            copy: Some(WorkspaceCopy { from: checkout.display().to_string(), at: "/root/x".to_owned() }),
            ..bare_spec()
        };
        let refused = ops.create_with_room(asking, None).await.unwrap_err().message;
        assert_eq!(refused, bundle::computer_tree_refusal("/root/x", "/root"));
        assert!(!layout.workspace(&id).exists(), "the refused create kept its claim");
        assert!(!layout.copy_of(&id).exists(), "the refused create left a copy");

        // A folder bound where the agent keeps its own state on the computer, which is what a box project's
        // memory asked for before this rule: refused before the source folder is made.
        let memory = layout.projects().join("pr_1").join("memory");
        let bound = |target: &str| MachineSpec {
            binds: Some(vec![Bind { source: memory.display().to_string(), target: target.to_owned(), read_only: false }]),
            ..bare_spec()
        };
        let under = "/root/.claude-cfg/projects/k/memory";
        assert_eq!(ops.binds_of(&bound(under)).unwrap_err().message, bundle::computer_tree_refusal(under, "/root"));
        assert!(!memory.exists(), "the refused create made the folder it was refused for");

        // The destinations a workspace's own mounts land at are taken: a folder under the projects directory
        // inside, and a copy at the path its checkout has on the computer it came from.
        let own = "/wsp/projects/p/memory";
        assert_eq!(ops.binds_of(&bound(own)).unwrap().first().map(|bind| bind.target.clone()), Some(own.to_owned()));
        let taken = WorkspaceCopy { from: checkout.display().to_string(), at: "/private/tmp/repo".to_owned() };
        assert_eq!(ops.make_copy("wsp-taken", &taken).await.unwrap().at, taken.at);

        // A record written before this rule keeps its bind: its wake is refused with the same sentence, and the
        // boot reads it before it makes the first directory of the workspace.
        let mut record = awake("wsp-old", Some("vault proof"));
        record.binds = vec![Bind { source: memory.display().to_string(), target: under.to_owned(), read_only: false }];
        assert_eq!(ops.boot(record).await.unwrap_err().message, bundle::computer_tree_refusal(under, "/root"));
        assert!(!layout.etc("wsp-old").exists(), "the refused boot wrote the workspace's own /etc");
    }

    /// A spec asking for nothing at all: the kind, and no image, size, copy, login or folder of the computer's.
    fn bare_spec() -> MachineSpec {
        MachineSpec {
            kind: MachineKind::Sandbox,
            template: None,
            from_snapshot: None,
            cpu: None,
            mem_mb: None,
            disk_gb: None,
            envs: None,
            labels: None,
            on_idle: None,
            idle_timeout_ms: None,
            idempotency_key: None,
            engine: None,
            copy: None,
            shares: None,
            binds: None,
        }
    }

    /// The compose project of a workspace is its own id, so two pieces of work on one project are two stacks; and
    /// it is a name compose takes, whatever a person's idempotency key made of the id.
    #[test]
    fn the_compose_project_is_the_workspace_and_a_name_compose_takes() {
        assert_eq!(compose_project("wsp-8fef733ad77786dc"), "wsp-8fef733ad77786dc");
        assert_ne!(compose_project("wsp-landing-a"), compose_project("wsp-landing-b"));
        // A key with a dot in it is a workspace id and not a compose project: compose takes letters, digits,
        // underscores and hyphens, and nothing leading with a hyphen.
        assert_eq!(compose_project("wsp-spoo.landing"), "wsp-spoo-landing");
        assert_eq!(compose_project("-wsp-a"), "wsp-a");
        assert_eq!(compose_project("wsp-A_1"), "wsp--_1");
        // Every character it answers is one compose takes.
        for word in ["wsp-spoo.landing", "wsp-A_1", "-_-wsp-b"] {
            let project = compose_project(word);
            assert!(project.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'), "{project}");
            assert!(!project.starts_with(['-', '_']), "{project}");
        }
    }

    /// Every exec carries the home and the user; one in a workspace with an engine carries its compose project
    /// too, beside what the tenant already reads off the workspace's own boot environment.
    #[test]
    fn an_exec_in_a_workspace_with_an_engine_carries_its_compose_project() {
        assert_eq!(exec_env(&awake("wsp-a", None)), "export HOME=/root USER=root");
        let engined = Workspace { engine: true, ..awake("wsp-spoo.landing", None) };
        assert_eq!(exec_env(&engined), "export HOME=/root USER=root COMPOSE_PROJECT_NAME=wsp-spoo-landing");
    }

    #[test]
    fn the_backend_facts_are_the_plans() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let facts = ops.backend_facts();
        assert_eq!(facts.offer, "runtime");
        assert_eq!(facts.capabilities.pause_mode, Some(PauseMode::Disk));
        assert!(!facts.capabilities.live_clone_forks && !facts.capabilities.preview_urls);
        assert!(!facts.capabilities.signed_urls && !facts.capabilities.kept);
        assert!(facts.capabilities.replaces_machine && facts.capabilities.callback_relay);
        // This computer keeps no image, so every flag that would promise one is false and no kind names a
        // template to boot from.
        assert!(!facts.capabilities.images && !facts.capabilities.disk_snapshots);
        assert!(!facts.capabilities.snapshots_any_life && !facts.capabilities.snapshot_listing && !facts.capabilities.templates);
        assert_eq!(facts.base_templates, None);
        assert!(serde_json::to_value(&facts).unwrap()["capabilities"]["images"] == serde_json::json!(false));
        assert_eq!(facts.capabilities.sizes.len(), 2);
        assert_eq!(
            (facts.capabilities.sizes[1].cpu, facts.capabilities.sizes[1].mem_mb, facts.capabilities.sizes[1].rate_usd_per_hour),
            (4.0, 8192, 0.0)
        );
        assert_eq!(facts.pricing.default_size, WorkspaceSize { cpu: 2.0, mem_mb: 4096 });
        assert_eq!(
            facts.lifecycle.as_ref().unwrap().budgets,
            LifecycleBudgets { wake_attempts: 1, daemon_answers_ms: 30_000, resume_asks: None }
        );
        let json = serde_json::to_value(&facts).unwrap();
        assert_eq!(json["pricing"]["snapshotStorage"], serde_json::json!({ "freeGb": 0.0, "usdPerGbMonth": 0.0, "billedFrom": "" }));
        assert!(json["pricing"].get("builderDiskGb").is_none());
        let given = size_on_box(&ops.facts(), Some(9999.0), Some(u64::MAX));
        assert_eq!((given.cpu, given.mem_mb), (ops.facts().machine_cpu(), ops.facts().machine_mem_mb()));
        assert!(given.clamped.is_some());
        let room = size_on_box(&ops.facts(), Some(1.0), Some(LEAST_MEM_MB));
        assert_eq!((room.cpu, room.mem_mb, room.clamped), (1.0, LEAST_MEM_MB, None));
    }

    #[tokio::test]
    async fn an_unknown_workspace_is_missing_on_every_op_that_names_one_and_a_bad_frame_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        for op in [
            "machine.get",
            "machine.exec",
            "machine.pause",
            "machine.resume",
            "machine.kill",
            "machine.state",
            "machine.describe",
            "machine.metrics",
            "machine.daemonAnswers",
            "machine.facts",
            "machine.previewUrl",
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(
                    Some(RequestId::from(1)),
                    &serde_json::json!({ "id": 1, "op": op, "machineId": "gone", "cmd": "true", "port": 7070 }),
                )
                .await,
            )
            .unwrap();
            assert_eq!(
                reply,
                serde_json::json!({ "id": 1, "ok": false, "error": "no such workspace: gone", "kind": "missing", "status": 404 }),
                "{op}"
            );
        }
        let reply: Value = serde_json::from_str(
            &ops.answer(Some(RequestId::from(2)), &serde_json::json!({ "id": 2, "op": "machine.state", "machineId": 7 })).await,
        )
        .unwrap();
        assert_eq!((reply["ok"].as_bool(), reply.get("kind")), (Some(false), None));
        let listed: Value =
            serde_json::from_str(&ops.answer(Some(RequestId::from(3)), &serde_json::json!({ "id": 3, "op": "machine.list" })).await)
                .unwrap();
        assert_eq!(listed, serde_json::json!({ "id": 3, "ok": true, "machines": [] }));
        // The eight a layer store answered are not ops here at all: nothing of them is in the frame the runtime
        // reads, so the frame itself does not read and the reply names the op it carried. The daemon in front of
        // this never sends one down, since it answers `unknown op` for a name that is not a machine op.
        for op in [
            "machine.snapshot",
            "machine.snapshotJob",
            "machine.deleteSnapshot",
            "machine.listSnapshots",
            "machine.promoteSnapshot",
            "machine.getTemplate",
            "machine.listTemplates",
            "machine.deleteTemplate",
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(
                    Some(RequestId::from(4)),
                    &serde_json::json!({ "id": 4, "op": op, "machineId": "gone", "name": "v1", "snapshotId": "sha256:aa", "templateId": "wsp/dev:template", "job": "j" }),
                )
                .await,
            )
            .unwrap();
            assert_eq!((reply["ok"].as_bool(), reply.get("kind")), (Some(false), None), "{op}: {reply}");
            assert!(reply["error"].as_str().unwrap().contains(op), "{op}: {reply}");
        }
    }

    /// What the room for one more workspace is read from here: the memory rule alone, since no image is kept on
    /// this computer and there is nothing to measure a disk against.
    #[test]
    fn the_capacity_names_no_image() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let capacity = ops.capacity().unwrap();
        assert!(capacity.images.is_empty(), "{:?}", capacity.images);
        assert_eq!(capacity.machines, MachineCounts { running: 0, paused: 0 });
        assert!(capacity.disk_free_bytes > 0);
        // The disk is still read and answered: what the host divides by an image's bytes where a place holds
        // one, and what a person reads either way.
        assert_eq!(capacity.mem_room_mb, ops.facts().machine_mem_mb());
    }

    /// A create meant for a provider, sent to a computer somebody joined: one sentence, and nothing claimed,
    /// copied or mounted for it. The same sentence a road above answers for a saved image here.
    #[tokio::test]
    async fn a_create_that_names_an_image_is_refused_in_one_sentence_and_claims_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        for named in [
            serde_json::json!({ "kind": "sandbox", "template": "ubuntu:24.04" }),
            serde_json::json!({ "kind": "sandbox", "fromSnapshot": "sha256:aa" }),
            serde_json::json!({ "kind": "sandbox", "template": "wsp/dev:template", "idempotencyKey": "k" }),
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(Some(RequestId::from(1)), &serde_json::json!({ "id": 1, "op": "machine.create", "spec": named })).await,
            )
            .unwrap();
            assert_eq!(
                reply,
                serde_json::json!({ "id": 1, "ok": false, "error": "this computer keeps no images: a workspace here is a copy of the computer itself" }),
                "{named}"
            );
        }
        assert_eq!(fs::read_dir(Layout::new(dir.path()).run()).unwrap().count(), 0);
        assert_eq!(fs::read_dir(Layout::new(dir.path()).copies()).unwrap().count(), 0);
    }

    #[test]
    fn what_a_create_says_is_the_size_it_gave_and_the_minutes_a_plain_copy_took() {
        assert_eq!(notices([None, None]), None);
        assert_eq!(notices([Some("cpu clamped to 1".to_owned()), None]), Some("cpu clamped to 1".to_owned()));
        assert_eq!(
            notices([Some("cpu clamped to 1".to_owned()), Some("copied plainly in 38 s".to_owned())]),
            Some("cpu clamped to 1; copied plainly in 38 s".to_owned())
        );
        // The filesystem is what decides whether a copy shares blocks, so the sentence names it and the root.
        assert_eq!(
            plain_copy_line(Path::new("/wsp"), Some("ext4"), 38_400),
            "copied plainly in 38 s: /wsp is on ext4, which shares no blocks between copies"
        );
        // A box that will not say what it is on still says how long it took, and a copy under a second is a
        // second rather than none.
        assert_eq!(plain_copy_line(Path::new("/wsp"), None, 120), "copied plainly in 1 s: /wsp shares no blocks between copies");
    }

    /// One workspace on disk as a daemon that stopped left it: its record under the run directory, its upper
    /// directory (what a nap boots from), and the chain it mounts.
    ///
    /// No rootfs directory, and that is the whole of what makes this runnable by anyone: the open unmounts the
    /// rootfs of every record whose init is gone, and umount2 resolves the path before it checks the capability,
    /// so a path that is not there answers ENOENT to any login while one that is answers EPERM to a login that is
    /// not root. A mounted rootfs is a thing a boot makes, not a thing a record carries, and none of what this
    /// proves reads it.
    fn left_on_disk(root: &Path, id: &str) {
        let layout = Layout::new(root);
        fs::create_dir_all(layout.upper(id)).unwrap();
        let record = Workspace {
            id: id.to_owned(),
            hostname: id.to_owned(),
            labels: BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]),
            envs: BTreeMap::new(),
            cpu: Some(1.0),
            mem_mb: Some(1024),
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
            // A pid nothing holds: the daemon came up after the box did, so the workspace reads stopped, which
            // under a disk pause is a nap its upper directory is waiting to be woken from.
            init: Init { pid: i32::MAX, started: 0, boot_id: String::new() },
            engine: false,
            copy: None,
            shares: Vec::new(),
            binds: Vec::new(),
            made_points: Vec::new(),
        };
        fs::write(layout.record(id), serde_json::to_vec(&record).unwrap()).unwrap();
    }

    #[test]
    fn a_daemon_that_comes_up_finds_the_workspaces_it_left_and_what_each_of_them_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        left_on_disk(root, "wsp-one");
        left_on_disk(root, "wsp-two");

        let again = Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap();
        // The records are there and the listing names both, with the size each was created at.
        let listed = again.list(None).unwrap();
        assert_eq!(listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["wsp-one", "wsp-two"]);
        assert!(listed.iter().all(|row| row.state == MachineState::Paused && row.size == Some(WorkspaceSize { cpu: 1.0, mem_mb: 1024 })));
        // Nothing of either was swept: a record names them both.
        assert!(again.unfinished_at_open().is_empty(), "{:?}", again.unfinished_at_open());

        // And what each nap is waiting to be woken over is where the record left it.
        for id in ["wsp-one", "wsp-two"] {
            assert!(Layout::new(root).upper(id).is_dir(), "{id} lost what it wrote");
        }
    }

    /// A spec asking for one shared login, with the source spelled as given.
    fn asking_for(source: &Path) -> MachineSpec {
        MachineSpec {
            kind: MachineKind::Sandbox,
            template: None,
            from_snapshot: None,
            cpu: None,
            mem_mb: None,
            disk_gb: None,
            envs: None,
            labels: None,
            on_idle: None,
            idle_timeout_ms: None,
            idempotency_key: None,
            engine: None,
            copy: None,
            binds: None,
            shares: Some(vec![Share { source: source.display().to_string(), target: "/root/.codex/auth.json".to_owned() }]),
        }
    }

    #[test]
    fn a_login_shared_into_a_workspace_is_a_file_under_this_daemons_logins_directory_and_nowhere_else() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let logins = ops.layout.logins();
        // The open made it, and only this login reads what lands under it: the sign-in writes the person's own
        // login there before any workspace asks for it.
        assert!(logins.is_dir());
        assert_eq!(fs::metadata(&logins).unwrap().permissions().mode() & 0o777, 0o700);
        // A login nobody has signed in here yet is taken: the boot passes it over and the wake after the sign-in
        // binds it, which is what lets a workspace be made on a box before its owner has signed anything in.
        let asked = ops.shares_of(&asking_for(&logins.join("codex/auth.json"))).unwrap();
        assert_eq!(asked.iter().map(|s| s.target.as_str()).collect::<Vec<_>>(), ["/root/.codex/auth.json"]);
        // And the file itself once it is there.
        fs::create_dir_all(logins.join("codex")).unwrap();
        fs::write(logins.join("codex/auth.json"), b"{}\n").unwrap();
        assert_eq!(ops.shares_of(&asking_for(&logins.join("codex/auth.json"))).unwrap().len(), 1);
        // Anywhere else on the box, the directory this daemon shares them out of, and a directory under it: each
        // refused in one sentence naming where a shared login does live. A directory is refused rather than
        // passed over, since a boot reading it as no file would skip it without a word.
        for outside in [dir.path().join("root/.ssh/id_ed25519"), logins.clone(), logins.join("codex"), logins.join("../copies/wsp-a")] {
            let refused = ops.shares_of(&asking_for(&outside)).unwrap_err().message;
            assert!(refused.contains(&logins.display().to_string()) && refused.ends_with("is not one"), "{outside:?}: {refused}");
        }
        // And a create that asks for none shares none.
        assert!(ops.shares_of(&MachineSpec { shares: None, ..asking_for(&logins) }).unwrap().is_empty());
        // What this computer says about itself names the same directory, which is what the host fills a create from.
        assert_eq!(ops.backend_facts().logins, Some(logins.display().to_string()));
    }

    /// A spec asking for one folder of the computer's own to be bound in, with the source spelled as given. The
    /// destination is where the add's own worker reads a project's checkout inside, since a destination under one
    /// of the computer's own trees is refused before the source is read at all.
    fn binding(source: &Path) -> MachineSpec {
        MachineSpec {
            binds: Some(vec![Bind { source: source.display().to_string(), target: "/srv/spoo-landing".to_owned(), read_only: false }]),
            shares: None,
            ..asking_for(source)
        }
    }

    #[test]
    fn a_folder_bound_into_a_workspace_is_a_directory_under_this_daemons_root_and_nowhere_else() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let projects = ops.layout.projects();
        // The open made the projects directory, and only this login reads what lands under it: a project's
        // checkout and its agent's memory are the person's.
        assert!(projects.is_dir());
        assert_eq!(fs::metadata(&projects).unwrap().permissions().mode() & 0o777, 0o700);
        // A folder the add has not written yet is made, since the add binds this directory before it has cloned
        // anything into it.
        let memory = projects.join("pr_1/memory");
        assert_eq!(ops.binds_of(&binding(&memory)).unwrap().len(), 1);
        assert!(memory.is_dir());
        // Anywhere else on the box, the projects directory itself and a directory beside it: each refused in one
        // sentence naming where a bound folder lives. A file is refused rather than passed over, since a boot
        // mounting a directory over it would fail without a word here.
        let file = projects.join("pr_1/a-file");
        fs::write(&file, b"x").unwrap();
        for outside in [dir.path().join("root/.ssh"), ops.layout.logins(), projects.clone(), projects.join("../copies"), file] {
            let refused = ops.binds_of(&binding(&outside)).unwrap_err().message;
            assert!(refused.contains(&projects.display().to_string()) && refused.ends_with("is not one"), "{outside:?}: {refused}");
        }
        // A create that asks for none binds none, and what this computer says about itself names the directory a
        // host fills one from.
        assert!(ops.binds_of(&MachineSpec { binds: None, ..binding(&memory) }).unwrap().is_empty());
        assert_eq!(ops.backend_facts().projects, Some(projects.display().to_string()));
    }

    /// A login shared into a workspace is bound at the agent's own path inside, and under the computer's own home
    /// that path is the computer's: the empty file the bind lands on is made on its disk, where a tool run on the
    /// computer itself reads it as its login. So the boot records the computer's own path of a point it made, and
    /// records nothing for a file that was already there, which is the person's or the first workspace's.
    #[test]
    fn the_boot_records_the_computers_own_path_of_a_mount_point_it_made_and_no_file_it_found() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        let target = "/root/.codex/auth.json";
        // The point is made under the rootfs, which reaches the computer's home through the bind of its /root;
        // what is recorded is the computer's own path, since the one under the rootfs names nothing once the
        // unmount has run.
        let at = bundle::inside(&rootfs, target).unwrap();
        assert!(!at.exists());
        bundle::empty_file(&at).unwrap();
        assert!(at.is_file() && at.ends_with("root/.codex/auth.json"));
        assert!(point_is_ours(target, false, &[]));
        // One that stood there is recorded only where another workspace here says wsp made it: that is the two
        // of them sharing one login, and the last to go takes it off.
        assert!(!point_is_ours(target, true, &[]));
        assert!(point_is_ours(target, true, &[target.to_owned()]));
        assert!(!point_is_ours(target, true, &["/root/.claude.json".to_owned()]));
        // A destination the rootfs owns is the workspace's own upper and goes with the workspace, so there is
        // nothing on the computer to record.
        assert!(!point_is_ours("/etc/wsp-login.json", false, &[]));
        assert!(!point_is_ours("/srv/logins/auth.json", true, &["/srv/logins/auth.json".to_owned()]));
    }

    /// A share whose folder inside is a link the box root keeps under the home every workspace here shares: the
    /// empty file lands where the link leads, beneath the rootfs, and the point recorded is that path, since the
    /// take-off has to find the file the boot made and nothing else.
    #[test]
    fn a_point_is_recorded_where_it_landed_and_never_where_the_share_asked_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        let id = "wsp-landed";
        let place = layout.inside_of(id);
        fs::create_dir_all(place.rootfs().join("root")).unwrap();
        let source = layout.logins().join("codex/auth.json");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"{}").unwrap();
        // The box root's own dotfiles folder, kept as a link: the boot follows it once and lands beneath the
        // rootfs, which here is a folder of the workspace's own /var and nothing of the computer's.
        std::os::unix::fs::symlink("/var/tmp/dotfiles/codex", place.rootfs().join("root/.codex")).unwrap();
        let share = Share { source: source.display().to_string(), target: "/root/.codex/auth.json".to_owned() };
        let (shares, made) = make_points(&place, &layout, id, std::slice::from_ref(&share), &[]).unwrap();
        assert_eq!(shares, std::slice::from_ref(&share));
        assert!(place.rootfs().join("var/tmp/dotfiles/codex/auth.json").is_file());
        // Nothing on the computer: the landed path is the workspace's own upper, so it is no point to take off.
        assert!(made.is_empty(), "a point inside the workspace was recorded as one on the computer: {made:?}");
        assert!(!Path::new("/var/tmp/dotfiles").exists(), "the boot made a folder on the computer itself");
        // And one that does land under the home the workspaces share is recorded at the path it landed at.
        let under = format!("/root/.wsp-landed-proof-{}", std::process::id());
        std::os::unix::fs::symlink(&under, place.rootfs().join("root/.claude-cfg")).unwrap();
        let share = Share { source: source.display().to_string(), target: "/root/.claude-cfg/auth.json".to_owned() };
        let (_, made) = make_points(&place, &layout, id, std::slice::from_ref(&share), &[]).unwrap();
        assert_eq!(made, [format!("{under}/auth.json")]);
    }

    /// Two workspaces sharing one login share the one mount point under the computer's home: the first to stop may
    /// not unlink what the second still has bound, and the last one to go is what takes it off.
    #[test]
    fn a_shared_mount_point_stands_while_another_workspace_holds_it_and_goes_with_the_last() {
        let dir = tempfile::tempdir().unwrap();
        drop(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap());
        let layout = Layout::new(dir.path());
        // The point as a boot leaves it on the computer's own disk: empty, with the login bound over it inside.
        let point = dir.path().join("home/.codex/auth.json");
        fs::create_dir_all(point.parent().unwrap()).unwrap();
        fs::write(&point, b"").unwrap();
        let target = point.display().to_string();
        let share = Share { source: layout.logins().join("codex/auth.json").display().to_string(), target: target.clone() };
        let mut one = awake("wsp-one", None);
        one.init = runtime::identity_of(std::process::id() as i32).unwrap();
        one.shares = vec![share];
        one.made_points = vec![target.clone()];
        let mut two = one.clone();
        two.id = "wsp-two".to_owned();
        for record in [&one, &two] {
            fs::create_dir_all(layout.upper(&record.id)).unwrap();
            bundle::write_json(&layout.record(&record.id), record).unwrap();
        }
        // The first stops: the second runs with the same login bound, so the point stands.
        take_off_points(&layout, "wsp-one", &one.made_points).unwrap();
        assert!(point.is_file(), "a stop unlinked a mount point another workspace still had bound");
        // The second goes while the first is asleep: nothing here holds it any more, so the empty file goes.
        one.init = Init { pid: i32::MAX, started: 0, boot_id: String::new() };
        bundle::write_json(&layout.record("wsp-one"), &one).unwrap();
        take_off_points(&layout, "wsp-two", &two.made_points).unwrap();
        assert!(!point.exists(), "the last workspace holding the mount point left it on the computer's home");
        // The folder stays: ~/.codex is the agent's own to make and to keep, whatever wsp put inside it.
        assert!(point.parent().unwrap().is_dir());
    }

    /// Two workspaces sharing one login that boot at the same moment: the second reads the first's point off the
    /// first's claim, since a create still inside its boot has written its claim's file and no record yet, finds
    /// the file standing and names the point as its own too. Both own it, and the take-off's own two rules,
    /// pinned by `a_shared_mount_point_stands_while_another_workspace_holds_it_and_goes_with_the_last`, leave
    /// the file standing until the last of them goes.
    ///
    /// What the lock over that section adds is the order of the two reads against the two writes, which no case
    /// here drives: this one drives the reader over claims and `make_points` with a list of what is held.
    #[test]
    fn two_boots_sharing_one_login_at_the_same_moment_both_own_its_point_and_the_last_takes_it_off() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wsp");
        let ops = Ops::open(&root, PathBuf::from("/bin/true"), 0).unwrap();
        let layout = Layout::new(&root);
        // The first boot as it stands in the middle of its create: the claim's own file names the point it has
        // just made on the computer's home, and there is no record of that workspace anywhere yet. The path is
        // under the computer's own tree, which is what makes a point one to take off, and under a name nothing
        // on any computer holds: what is made here is made under the second workspace's rootfs alone.
        let target = "/root/.wsp-shared-login-proof/auth.json".to_owned();
        fs::create_dir_all(layout.workspace("wsp-one")).unwrap();
        bundle::write_json(&layout.points("wsp-one"), &vec![target.clone()]).unwrap();

        let held = ops.points_of_others("wsp-two").unwrap();
        assert_eq!(held, [target.as_str()], "a boot read its neighbours' records alone and missed the point one had claimed");

        // The second boot, with the point standing where the first left it: it is named under this workspace's
        // claim as well, so whichever of the two goes last is the one that takes the empty file off.
        let source = layout.logins().join("codex/auth.json");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"{}").unwrap();
        let share = Share { source: source.display().to_string(), target: target.clone() };
        bundle::empty_file(&bundle::inside(&layout.rootfs("wsp-two"), &target).unwrap()).unwrap();
        let (shares, made) = make_points(&layout.inside_of("wsp-two"), &layout, "wsp-two", std::slice::from_ref(&share), &held).unwrap();
        assert_eq!(made, [target.as_str()], "the boot that came second owns nothing of the point it shares");
        assert_eq!(shares, std::slice::from_ref(&share));
        assert_eq!(points_of(&layout, "wsp-two").unwrap(), [target.as_str()]);
        // And the same point standing with nothing here naming it is the person's own file, which no boot
        // records and no stop takes off.
        assert!(make_points(&layout.inside_of("wsp-two"), &layout, "wsp-two", std::slice::from_ref(&share), &[]).unwrap().1.is_empty());
    }

    /// A sign-in made on the computer itself since the boot writes the person's own login into the file the boot
    /// left: what a stop takes off is an empty mount point, never a file with a login in it.
    #[test]
    fn a_login_written_on_the_computer_since_the_boot_stays_when_the_workspace_goes() {
        let dir = tempfile::tempdir().unwrap();
        drop(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap());
        let layout = Layout::new(dir.path());
        let point = dir.path().join("home/.codex/auth.json");
        fs::create_dir_all(point.parent().unwrap()).unwrap();
        fs::write(&point, b"{\"tokens\":\"the person's own\"}\n").unwrap();
        take_off_points(&layout, "wsp-one", &[point.display().to_string()]).unwrap();
        assert!(point.is_file(), "a stop took off a login the person had written");
        // A record that made no point of its own asks the disk nothing, which is every workspace before this rule
        // and every one whose shares land in its own upper.
        take_off_points(&layout, "wsp-one", &[]).unwrap();
        // And a point that is already gone, which is a remove after the stop that took it off, is no refusal.
        fs::remove_file(&point).unwrap();
        take_off_points(&layout, "wsp-one", &[point.display().to_string()]).unwrap();
    }

    /// One reader over both the places a point is written down, so the boot, the remove and the open's sweep all
    /// answer for the same points however far the create that made them got.
    #[test]
    fn the_points_are_the_records_and_the_claims_together() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        // Neither: a claim under which no boot has written a point yet names none.
        fs::create_dir_all(layout.workspace("wsp-one")).unwrap();
        assert!(points_of(&layout, "wsp-one").unwrap().is_empty());
        // The claim's own file alone: the boot made the point and the create died before the record.
        let claimed = "/home/one/.codex/auth.json".to_owned();
        bundle::write_json(&layout.points("wsp-one"), &vec![claimed.clone()]).unwrap();
        assert_eq!(points_of(&layout, "wsp-one").unwrap(), [claimed.as_str()]);
        // The record alone: the boot finished, which is what takes the claim's file away.
        let recorded = "/home/two/.codex/auth.json".to_owned();
        let mut record = awake("wsp-two", None);
        record.made_points = vec![recorded.clone()];
        fs::create_dir_all(layout.workspace("wsp-two")).unwrap();
        bundle::write_json(&layout.record("wsp-two"), &record).unwrap();
        assert_eq!(points_of(&layout, "wsp-two").unwrap(), [recorded.as_str()]);
        // Both: a wake that made a point its standing record does not name and failed before writing it down.
        let woken = "/home/two/.claude/.credentials.json".to_owned();
        bundle::write_json(&layout.points("wsp-two"), &vec![woken.clone()]).unwrap();
        assert_eq!(points_of(&layout, "wsp-two").unwrap(), [recorded.as_str(), woken.as_str()]);
        // And a point both places name is one point: the take-off is asked for it once.
        bundle::write_json(&layout.points("wsp-two"), &vec![recorded.clone()]).unwrap();
        assert_eq!(points_of(&layout, "wsp-two").unwrap(), [recorded.as_str()]);
    }

    /// A boot that refuses partway through its shares has put the earlier points on the computer's own home
    /// already, so each point is named under the claim the moment the file it names exists. The second share here
    /// cannot have its mount point made, a file standing where its folder would go, so no claim names it and
    /// there is nothing of it to take off. What the remove and the open's sweep take off is what the reader
    /// answers, which the case below drives all the way to the unlink.
    #[test]
    fn a_boot_that_refuses_inside_the_shares_loop_leaves_the_points_it_made_named() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        let id = "wsp-halfway";
        fs::create_dir_all(layout.workspace(id)).unwrap();
        let login = |name: &str| {
            let source = layout.logins().join(name);
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::write(&source, b"{}").unwrap();
            source.display().to_string()
        };
        // Paths under the computer's own home, which is what makes a point one to take off, and under a name no
        // computer holds anything at: the take-off reads the computer's path, never the one under the rootfs.
        let first = "/root/.wsp-share-proof/one.json".to_owned();
        let second = "/root/.wsp-share-proof/two/two.json".to_owned();
        let shares =
            vec![Share { source: login("one.json"), target: first.clone() }, Share { source: login("two.json"), target: second.clone() }];
        let under = bundle::inside(&layout.rootfs(id), "/root/.wsp-share-proof").unwrap();
        fs::create_dir_all(&under).unwrap();
        fs::write(under.join("two"), b"a file where the second share's folder would go").unwrap();

        let refused = make_points(&layout.inside_of(id), &layout, id, &shares, &[]).unwrap_err();
        assert!(refused.message.contains("two"), "{refused:?}");
        // The first share's point was made before the refusal, and the claim names it: that is what the remove
        // and the open's sweep take off. The second was never made, so no claim names it and nothing stands on
        // the computer's home under that name.
        assert!(under.join("one.json").is_file());
        assert!(!under.join("two/two.json").exists());
        assert_eq!(bundle::read_points(&layout.points(id)).unwrap(), [first.as_str()]);
        assert_eq!(points_of(&layout, id).unwrap(), [first.as_str()]);
    }

    /// The create that fails between the mount point and its record: the claim names the point, so the open's
    /// sweep of claims nobody finished takes the point off the computer's own home with the claim.
    #[test]
    fn the_open_takes_off_the_points_a_create_claimed_and_never_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wsp");
        let layout = Layout::new(&root);
        drop(Ops::open(&root, PathBuf::from("/bin/true"), 0).unwrap());
        // The empty file the boot left on the computer's own home for the login to be bound over.
        let point = dir.path().join("home/.codex/auth.json");
        fs::create_dir_all(point.parent().unwrap()).unwrap();
        fs::write(&point, b"").unwrap();
        // The claim as the create left it: the directory it took first, the points its boot made, no record.
        fs::create_dir_all(layout.workspace("wsp-halfway")).unwrap();
        bundle::write_json(&layout.points("wsp-halfway"), &vec![point.display().to_string()]).unwrap();

        let again = Ops::open(&root, PathBuf::from("/bin/true"), 0).unwrap();
        assert!(!point.exists(), "the open left the mount point of a create that never finished on the computer's home");
        // The folder stays, as it does for a workspace that went the whole way: it is the agent's own.
        assert!(point.parent().unwrap().is_dir());
        assert_eq!(again.unfinished_at_open().claims, vec!["wsp-halfway".to_owned()]);
        assert!(!layout.workspace("wsp-halfway").exists());
    }

    /// The same create answered before the next open: its own remove, which is what the create runs when the boot
    /// it was in the middle of refuses, reads the claim's points as a record's and takes them off.
    ///
    /// Root, as every case here that drives the kernel is: a remove takes the workspace's network down on its way,
    /// and the nftables read that ends with is refused to anything without the capability a box's daemon runs
    /// with. The open's sweep above is the road this create's leavings are answered by wherever the remove is
    /// refused, and the create drops the remove's own refusal already.
    #[tokio::test]
    #[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
    async fn a_remove_of_a_claim_with_no_record_takes_its_points_off() {
        assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wsp");
        let ops = Ops::open(&root, PathBuf::from("/bin/true"), 0).unwrap();
        let layout = Layout::new(&root);
        let point = dir.path().join("home/.codex/auth.json");
        fs::create_dir_all(point.parent().unwrap()).unwrap();
        fs::write(&point, b"").unwrap();
        fs::create_dir_all(layout.workspace("wsp-halfway")).unwrap();
        bundle::write_json(&layout.points("wsp-halfway"), &vec![point.display().to_string()]).unwrap();

        ops.remove("wsp-halfway", None).await.unwrap();
        assert!(!point.exists(), "the remove of a create that never wrote a record left its mount point on the computer's home");
        assert!(point.parent().unwrap().is_dir());
        assert!(!layout.workspace("wsp-halfway").exists());
    }

    #[test]
    fn the_open_sweeps_a_copy_still_being_made_and_a_claim_with_no_workspace_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let layout = Layout::new(root);
        drop(Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap());
        // What a daemon that died in the middle of a create leaves: the claim it took first, and the copy it
        // was writing under the name a copy is made under.
        let half = layout.copy_being_made("wsp-half");
        fs::create_dir_all(half.join("src")).unwrap();
        fs::write(half.join("src/index.js"), b"half of a checkout\n").unwrap();
        fs::create_dir_all(layout.workspace("wsp-half")).unwrap();
        // And what a workspace looks like, which the sweep may not touch: a record, its upper, its copy.
        left_on_disk(root, "wsp-whole");
        fs::create_dir_all(layout.copy_of("wsp-whole")).unwrap();

        // And a copy that finished but whose create died before the record: it lost the mark at the rename,
        // so only the missing record tells it apart from a workspace's own copy.
        let finished = layout.copy_of("wsp-done");
        fs::create_dir_all(finished.join("src")).unwrap();
        fs::write(finished.join("src/index.js"), b"a whole checkout\n").unwrap();
        fs::create_dir_all(layout.workspace("wsp-done")).unwrap();
        // A probe file a daemon died beside is a file rather than a copy, and the open may not trip on it.
        fs::write(layout.copies().join(".clone-probe-4242-0"), b"w").unwrap();

        let again = Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap();
        let swept = again.unfinished_at_open();
        assert_eq!(swept.copies.iter().filter(|name| name.contains("wsp-half")).count(), 1, "{swept:?}");
        assert!(swept.copies.contains(&"wsp-done".to_owned()) && swept.copies.contains(&".clone-probe-4242-0".to_owned()), "{swept:?}");
        assert_eq!(swept.claims, vec!["wsp-done".to_owned(), "wsp-half".to_owned()]);
        assert!(!half.exists() && !layout.workspace("wsp-half").exists());
        assert!(!finished.exists() && !layout.workspace("wsp-done").exists());
        assert!(layout.copy_of("wsp-whole").is_dir() && layout.workspace("wsp-whole").is_dir());
        assert_eq!(again.list(None).unwrap().len(), 1);
        // The key the dead create held is free again: a copy under it is made rather than refused.
        let from = dir.path().join("checkout");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("index.js"), b"module.exports = 1\n").unwrap();
        let want = WorkspaceCopy { from: from.display().to_string(), at: "/Users/zingzy/wsp".to_owned() };
        let made = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(again.make_copy("wsp-done", &want))
            .unwrap();
        assert_eq!(made.at, "/Users/zingzy/wsp");
        assert_eq!(fs::read(layout.copy_of("wsp-done").join("index.js")).unwrap(), b"module.exports = 1\n");
        // And an open of a root nothing died under says nothing; the copy just made has no record yet, so it
        // is swept in its turn, which is what a create that died right there left.
        let third = Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap();
        assert_eq!(third.unfinished_at_open().copies, vec!["wsp-done".to_owned()]);
        let fourth = Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap();
        assert!(fourth.unfinished_at_open().is_empty());
    }

    /// The claim of a create that died with its mounts up: the open takes the mounts down before it takes the
    /// directory, or the remove walks into the copy through the bind and then answers EBUSY on the mount point
    /// and the daemon does not come up at all. Root, as every case here that drives the kernel is.
    #[test]
    #[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
    fn the_open_unmounts_what_a_dead_create_left_under_a_claim_before_it_takes_the_claim() {
        assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let layout = Layout::new(root);
        drop(Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap());
        // A copy of a checkout, and the claim of the create that was binding it in when the daemon died.
        let copy = layout.copy_of("wsp-mounted");
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("README.md"), b"the copy\n").unwrap();
        let rootfs = layout.rootfs("wsp-mounted");
        bundle::bind_into(&copy, &bundle::inside(&rootfs, "/Users/zingzy/wsp").unwrap()).unwrap();
        let mounted = || fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&rootfs.display().to_string());
        assert!(mounted());

        let again = Ops::open(root, PathBuf::from("/bin/true"), 0).unwrap();
        assert!(!mounted(), "the open left the bind of a claim it removed");
        assert!(!layout.workspace("wsp-mounted").exists());
        assert!(!copy.exists(), "the copy of a create that never finished stayed");
        assert_eq!(again.unfinished_at_open().claims, vec!["wsp-mounted".to_owned()]);
    }

    /// A copy that fails partway leaves nothing under the name a workspace's copy has, so the next create under
    /// the same key is not handed half a checkout. The walk refuses a named pipe, which is a checkout a person
    /// can make by accident and the cheapest failure to write here.
    #[tokio::test]
    async fn a_copy_that_fails_partway_leaves_no_copy_and_nothing_half_made() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
        let from = dir.path().join("checkout");
        fs::create_dir_all(from.join("src")).unwrap();
        fs::write(from.join("src/index.js"), b"module.exports = 1\n").unwrap();
        nix::unistd::mkfifo(&from.join("pipe"), nix::sys::stat::Mode::S_IRUSR).unwrap();
        let want = WorkspaceCopy { from: from.display().to_string(), at: "/Users/zingzy/wsp".to_owned() };
        let refused = ops.make_copy("wsp-x", &want).await.unwrap_err().message;
        assert!(refused.contains("pipe") && refused.contains("is a device"), "{refused}");
        let layout = Layout::new(dir.path());
        assert!(!layout.copy_of("wsp-x").exists(), "a failed copy left a copy");
        assert!(!layout.copy_being_made("wsp-x").exists(), "a failed copy left what it was making");
        let left: Vec<_> = fs::read_dir(layout.copies()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "{left:?}");
    }

    /// A root under one of the five directories every workspace overlays: the open refuses it in the doctor's
    /// own sentence and makes nothing under it, since a workspace there would read its own upper inside the tree
    /// it overlays. No root and no disk needed: the reading is of the path, and the refusal comes before the
    /// first directory.
    #[test]
    fn a_root_under_a_directory_every_workspace_overlays_is_refused_by_the_open_and_nothing_is_made() {
        let under = Path::new("/var/lib/wsp-under-a-lower");
        let refused = match Ops::open(under, PathBuf::from("/bin/true"), 0) {
            Ok(_) => panic!("a root under /var opened"),
            Err(e) => e.message,
        };
        assert_eq!(refused, crate::doctor::root_under_a_lower(under).unwrap());
        assert!(refused.contains("/var/lib/wsp-under-a-lower") && refused.contains("/var"), "{refused}");
        assert!(!under.exists(), "the open made a folder under a root it refused");
        // And the same root a directory deeper, since the reading is of the whole path.
        assert!(Ops::open(Path::new("/etc/wsp/one"), PathBuf::from("/bin/true"), 0).is_err());
        // A root clear of all five opens as ever.
        let dir = tempfile::tempdir().unwrap();
        assert!(Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).is_ok());
    }

    /// An older daemon that died inside the write of a claim's points file left a torn one behind: the open
    /// reads it as the leaving of a create that never finished and takes the claim away with it, where before
    /// it refused, and went on refusing every open after that until somebody deleted the file on the box.
    #[test]
    fn the_open_takes_a_claim_whose_points_file_is_torn_as_a_dead_creates_leaving() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wsp");
        let layout = Layout::new(&root);
        drop(Ops::open(&root, PathBuf::from("/bin/true"), 0).unwrap());
        fs::create_dir_all(layout.workspace("wsp-torn")).unwrap();
        fs::write(layout.points("wsp-torn"), "[\"/root/.codex/auth.json\"").unwrap();

        let again = Ops::open(&root, PathBuf::from("/bin/true"), 0).unwrap();
        assert_eq!(again.unfinished_at_open().claims, vec!["wsp-torn".to_owned()]);
        assert!(!layout.workspace("wsp-torn").exists());
    }

    #[test]
    fn a_record_that_does_not_read_refuses_the_open_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("run").join("wsp-broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("workspace.json"), "{ not json").unwrap();
        let refused = match Ops::open(dir.path(), PathBuf::from("/bin/true"), 0) {
            Ok(_) => panic!("a record that does not read opened"),
            Err(e) => e.to_string(),
        };
        assert!(refused.contains("wsp-broken"), "{refused}");
    }
}
