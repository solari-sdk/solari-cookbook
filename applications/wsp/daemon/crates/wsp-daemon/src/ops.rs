// SPDX-License-Identifier: AGPL-3.0-only
//! The op switch behind the door: one request text in, one reply text out, with the events an op raises going out
//! through the socket's own channel.

use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use wsp_frames::{
    numbers, words, DaemonErrorCode, DaemonErrorResponse, DaemonOp, Empty, FsReadEncoding, GitPrStateReply, GuestOpen, GuestOpenReply,
    InboxRescanReply, ManifestGetReply, ManifestRecordReply, ManifestRestartScriptReply, PlaceLeaveReply, PlaceUpdateReply,
    PortsWatchReply, PtyAttachReply, PtyCreateReply, PtyListReply, Reply, RequestId, DAEMON_OPS, GUEST_OPS, MACHINE_OPS,
    MACHINE_OPS_ON_ANY_ROAD,
};

use crate::exec::{run_exec, ExecOptions};
use crate::git::Asked::{Read as Reads, Work as Works};
use crate::guest::SESSION_TAKEN;
use crate::manifest::RecordInput;
use crate::paths::OpError;
use crate::proc::{kill_process, ProcSampler, ProtectedPids};
use crate::pty::{passwd_row, process_env, pump, PtyCreateOpts};
use crate::tunnel::Tunnels;
use crate::{bring_back, frame_text as text, fs, git, hosts, paths, Ctx, Listener, Outbound, Outgoing};

type Detach = Box<dyn FnOnce() + Send>;

/// Which road a socket came in on: dialled by a client of this machine, opened outward by this place to its host,
/// or opened inside one workspace this computer runs, on that workspace's own socket. The leave op and every
/// machine op but the two read-only ones are the link's alone, and a socket inside a workspace reaches nothing of
/// the computer that workspace sits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Road {
    Inbound,
    Link,
    Workspace(String),
}

/// Which of the guest road's five ops a socket on this road serves. A guest process lives inside a machine wsp
/// forked and inside a workspace on a computer somebody owns, so its two ops are served on the inbound socket of
/// a daemon inside a machine and on a workspace's own socket, and nowhere else. The host is on the inbound socket
/// of a daemon inside a machine and on the other end of the link of a place's daemon, so its three are served
/// there: a client holding the token of a computer somebody owns cannot take the sessions its host watches.
fn guest_road_serves(road: &Road, place: bool, op: &str) -> bool {
    let guests = matches!(op, "guest.open" | "guest.send");
    match road {
        Road::Workspace(_) => guests,
        Road::Inbound => !place,
        Road::Link => place && !guests,
    }
}

/// What one authed socket holds between frames.
pub(crate) struct Conn {
    /// The number no other socket in this daemon has, which is what the guest table and the broadcast list key on.
    pub(crate) key: u64,
    /// Set when the auth frame named a port: only tunnel ops on it and ping are answered.
    pub(crate) scope: Option<NonZeroU16>,
    pub(crate) out: Outbound,
    pub(crate) road: Road,
    /// The token this socket came through the door with, held so a rotation can tell the sockets the old one
    /// opened from the ones the new one did. None on the link and inside a workspace, which take no token.
    pub(crate) token: Option<String>,
    pub(crate) tunnels: Tunnels,
    /// What the socket's close undoes: every pty, mode and watcher listener an op on it made. None once closed, so an
    /// op still being answered when the socket went undoes itself at once instead of outliving it.
    detaches: Mutex<Option<Vec<Detach>>>,
    /// This socket's proc.watch, so proc.unwatch can end it before the socket does and a second watch on the same
    /// socket is not a second subscription.
    proc_watch: Mutex<Option<(u64, Arc<ProcSampler>)>>,
    /// The one guest session this socket opened, which ends with it.
    guest: Mutex<Option<String>>,
}

impl Conn {
    pub(crate) fn new(key: u64, scope: Option<NonZeroU16>, out: Outbound, road: Road, token: Option<String>) -> Conn {
        Conn {
            key,
            scope,
            out,
            road,
            token,
            tunnels: Tunnels::default(),
            detaches: Mutex::new(Some(Vec::new())),
            proc_watch: Mutex::new(None),
            guest: Mutex::new(None),
        }
    }

    /// The workspace this socket was opened inside; none for every other road.
    pub(crate) fn workspace(&self) -> Option<String> {
        match &self.road {
            Road::Workspace(id) => Some(id.clone()),
            Road::Inbound | Road::Link => None,
        }
    }

    pub(crate) fn guest_session(&self) -> Option<String> {
        self.guest.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Binds this socket to the session it just opened; a socket that already holds one opens no second.
    pub(crate) fn take_guest(&self, session: String) -> Result<(), OpError> {
        let mut held = self.guest.lock().unwrap_or_else(|e| e.into_inner());
        if held.is_some() {
            return Err(OpError::coded(DaemonErrorCode::BadRequest, SESSION_TAKEN));
        }
        *held = Some(session);
        Ok(())
    }

    fn on_close(&self, detach: Detach) {
        match &mut *self.detaches.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(pending) => pending.push(detach),
            None => detach(),
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.detaches.lock().unwrap_or_else(|e| e.into_inner()).is_none()
    }

    /// Takes a subscription on only while the socket is still open, and keeps what undoes it: an op that awaited
    /// something takes nothing on for a client that has left, since the close drains what this socket holds once and
    /// a subscription made after that drain is one nothing removes.
    fn while_open(&self, take: impl FnOnce() -> Option<Detach>) {
        if let Some(pending) = &mut *self.detaches.lock().unwrap_or_else(|e| e.into_inner()) {
            pending.extend(take());
        }
    }

    pub(crate) fn close(&self) {
        let detaches = self.detaches.lock().unwrap_or_else(|e| e.into_inner()).take();
        for detach in detaches.into_iter().flatten() {
            detach();
        }
        self.tunnels.close_all();
    }
}

fn ok(id: Option<RequestId>) -> String {
    text(&Reply::new(id, Empty {}))
}

fn fail(id: Option<RequestId>, error: impl Into<String>) -> String {
    text(&DaemonErrorResponse::new(id, error))
}

fn refuse(id: Option<RequestId>, code: DaemonErrorCode, error: impl Into<String>) -> String {
    text(&DaemonErrorResponse::new(id, error).with_code(code))
}

/// The id as the reply echoes it: the string or number the frame carried, null for anything else.
fn id_of(frame: &Value) -> Option<RequestId> {
    frame.get("id").and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// The op as the unknown-op sentence names it: the string itself, or the JSON of whatever else was there.
fn op_word(frame: &Value) -> String {
    match frame.get("op") {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// A port-scoped socket is there to tunnel one port; ping keeps it alive and nothing else is its business.
fn in_port_scope(port: NonZeroU16, frame: &Value) -> bool {
    match frame.get("op").and_then(Value::as_str) {
        Some("ping" | "tunnel.write" | "tunnel.close") => true,
        Some("tunnel.open") => frame.get("port").and_then(Value::as_u64) == Some(u64::from(port.get())),
        _ => false,
    }
}

/// Base64 as node's Buffer reads it: padding optional, characters outside the alphabet skipped.
fn lenient_base64(text: &str) -> Vec<u8> {
    let clean: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let config = GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent);
    GeneralPurpose::new(&base64::alphabet::STANDARD, config).decode(&clean).unwrap_or_default()
}

/// An op's outcome on the wire: the body under the ok envelope, or the failure with its code when it carries one.
fn answer<T: Serialize>(id: Option<RequestId>, result: Result<T, OpError>) -> String {
    match result {
        Ok(body) => text(&Reply::new(id, body)),
        Err(OpError { code: Some(code), message }) => refuse(id, code, message),
        Err(OpError { code: None, message }) => fail(id, message),
    }
}

/// One frame in, one reply out. The reply is the text to write, or the leave's, which the loop writes and then
/// stops on.
pub(crate) async fn handle(conn: &Arc<Conn>, ctx: &Arc<Ctx>, raw: &str) -> Outgoing {
    // Any JSON value is a frame, as the node daemon reads it; a non-object simply carries no op and no id.
    let Ok(frame) = serde_json::from_str::<Value>(raw) else {
        return Outgoing::Text(text(&DaemonErrorResponse::new(None, words::INVALID_JSON)));
    };
    let id = id_of(&frame);
    if let Some(port) = conn.scope {
        if !in_port_scope(port, &frame) {
            return Outgoing::Text(refuse(id, DaemonErrorCode::Forbidden, words::port_scope_refusal(port.get())));
        }
    }
    let op = frame.get("op").and_then(Value::as_str);
    if matches!(conn.road, Road::Workspace(_)) {
        // A socket inside a workspace answers ping and the guest's own two ops and refuses every other op this
        // daemon knows, the machine ops and the two place ops among them: nothing inside a workspace reads the
        // computer it sits on, lists its neighbours or drives anything there.
        let served = op == Some("ping") || op.is_some_and(|name| guest_road_serves(&conn.road, ctx.is_place(), name));
        let known = op.is_some_and(|name| DAEMON_OPS.contains(&name) || MACHINE_OPS.contains(&name));
        if known && !served {
            return Outgoing::Text(refuse(id, DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD));
        }
    }
    if conn.road == Road::Link {
        // The road that opened this socket answers its own ops before the daemon's switch sees them.
        match op {
            Some("place.leave") => {
                let home = crate::place::place_home(ctx.options.home.as_deref());
                let swept = fs::blocking(move || {
                    let mut swept = crate::place::sweep_place_home(&home, &crate::place::sh_stdout);
                    // Only root's install loaded the profile, and only root can take it off.
                    if nix::unistd::geteuid().is_root() {
                        let profile = std::path::Path::new(wsp_frames::numbers::WORKSPACE_APPARMOR_PATH);
                        swept.extend(crate::place::sweep_workspace_profile(profile, &crate::place::sh_stdout));
                    }
                    Ok(swept)
                })
                .await
                .unwrap_or_default();
                return Outgoing::Leave(text(&Reply::new(id, PlaceLeaveReply { swept })));
            }
            Some("place.update") => return place_update(ctx, id, &frame).await,
            Some(name) if MACHINE_OPS.contains(&name) => return Outgoing::Text(machine_answer(ctx, id, name, &frame).await),
            _ => {}
        }
    } else if let Some(name) = op.filter(|name| conn.road == Road::Inbound && MACHINE_OPS_ON_ANY_ROAD.contains(name)) {
        // A socket that dialled in holds this daemon's token, so a person at this computer may ask it what it is
        // running and how one workspace is doing. Both only read; the rest of the machine ops stay the link's.
        return Outgoing::Text(machine_answer(ctx, id, name, &frame).await);
    }
    Outgoing::Text(handle_op(conn, ctx, &frame, id, op).await)
}

async fn handle_op(conn: &Arc<Conn>, ctx: &Arc<Ctx>, frame: &Value, id: Option<RequestId>, op: Option<&str>) -> String {
    match op {
        Some("ping") => ok(id),
        // The two place ops and every machine op that does anything are the link's; one sentence for the one rule,
        // as the node daemon says it. The two machine ops that only read were answered above, on whichever road
        // they came in on.
        Some(name) if name == "place.leave" || name == "place.update" || MACHINE_OPS.contains(&name) => {
            refuse(id, DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD)
        }
        // The guest ops are the roads table's: a guest's two where a guest process lives, the host's three where
        // the host is, and every other socket refused each of them.
        Some(name) if GUEST_OPS.contains(&name) && !guest_road_serves(&conn.road, ctx.is_place(), name) => {
            refuse(id, DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD)
        }
        Some(
            name @ ("pty.create"
            | "pty.attach"
            | "pty.detach"
            | "pty.write"
            | "pty.resize"
            | "pty.kill"
            | "pty.list"
            | "exec"
            | "fs.list"
            | "fs.read"
            | "fs.folders"
            | "git.status"
            | "git.diff"
            | "git.push"
            | "git.pr"
            | "git.prState"
            | "ports.watch"
            | "manifest.get"
            | "manifest.record"
            | "manifest.restartScript"
            | "inbox.watch"
            | "inbox.rescan"
            | "tunnel.open"
            | "tunnel.write"
            | "tunnel.close"
            | "sys.watch"
            | "proc.watch"
            | "proc.unwatch"
            | "proc.inspect"
            | "proc.kill"
            | "guest.open"
            | "guest.send"
            | "guest.watch"
            | "guest.reply"
            | "guest.close"),
        ) => {
            // The typed frame: what the protocol's schema refuses, this refuses as a bad request.
            match serde_json::from_value::<DaemonOp>(frame.clone()) {
                Ok(typed) => serve(conn, ctx, id, name, typed).await,
                Err(e) => refuse(id, DaemonErrorCode::BadRequest, e.to_string()),
            }
        }
        Some(name) if DAEMON_OPS.contains(&name) => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
        _ => fail(id, words::unknown_op(&op_word(frame))),
    }
}

/// The daemon the host sent, landed part by part and started in place of this one. Every part but the last is a
/// plain reply; the last checks the bytes against the sha256 the host named, moves them over the binary this
/// process runs from and answers where they went, and the loop then ends this daemon so its supervisor starts the
/// one that landed. Nothing here sweeps: the workspaces' records stay on the box and the daemon that comes up
/// reads them again.
async fn place_update(ctx: &Arc<Ctx>, id: Option<RequestId>, frame: &Value) -> Outgoing {
    let typed = match serde_json::from_value::<DaemonOp>(frame.clone()) {
        Ok(typed) => typed,
        Err(e) => return Outgoing::Text(refuse(id, DaemonErrorCode::BadRequest, e.to_string())),
    };
    let DaemonOp::PlaceUpdate { upload_id, seq, last, data, sha256 } = typed else {
        return Outgoing::Text(fail(id, words::unknown_op("place.update")));
    };
    let home = crate::place::place_home(ctx.options.home.as_deref());
    let bytes = lenient_base64(&data);
    let part = crate::place::update_part(&home, &upload_id);
    // An upload beginning is the other moment nothing is arriving, so what an earlier try left goes here too.
    if seq == 0 {
        let (home, upload) = (home.clone(), upload_id.clone());
        let _ = fs::blocking(move || Ok(crate::place::sweep_updates(&home, Some(&upload)))).await;
    }
    let taking = {
        let (part, upload) = (part.clone(), upload_id.clone());
        fs::blocking(move || crate::place::take_update_part(&part, seq, &bytes, &upload).map_err(OpError::plain)).await
    };
    if let Err(e) = taking {
        return Outgoing::Text(fail(id, e.message));
    }
    if !last {
        return Outgoing::Text(ok(id));
    }
    // Its own path rather than the unit's: the binary a unit starts is the file this process was execed from, and
    // reading it here needs neither the unit's name nor the manager that holds it.
    let exe = match crate::place::running_daemon(std::env::current_exe()) {
        Ok(exe) => exe,
        Err(e) => return Outgoing::Text(fail(id, e)),
    };
    let landed = fs::blocking(move || crate::place::install_daemon(&exe, &part, &sha256, &upload_id).map_err(OpError::plain)).await;
    match landed {
        Err(e) => Outgoing::Text(fail(id, e.message)),
        Ok((at, kept)) => {
            ctx.log(&words::update_landed(&at));
            Outgoing::Restart(text(&Reply::new(id, PlaceUpdateReply { at, kept })))
        }
    }
}

/// A machine op on the link: the workspace runtime answers where this daemon opened one; where the root it was
/// given is the reason it opened none, the reading of that root is the answer, so somebody asking what this
/// computer can do reads why rather than a line that names the op; and for every other reason, that line.
#[cfg(target_os = "linux")]
async fn machine_answer(ctx: &Ctx, id: Option<RequestId>, name: &str, frame: &Value) -> String {
    match (&ctx.runtime, &ctx.runtime_refusal) {
        (Some(ops), _) => ops.answer(id, frame).await,
        (None, Some(reason)) => text(&DaemonErrorResponse::new(id, reason.clone())),
        (None, None) => text(&wsp_runtime::answer_machine_op(id, name)),
    }
}

#[cfg(not(target_os = "linux"))]
async fn machine_answer(_ctx: &Ctx, id: Option<RequestId>, name: &str, _frame: &Value) -> String {
    text(&wsp_runtime::answer_machine_op(id, name))
}

/// An op the protocol names that this daemon does not serve yet.
pub(crate) fn not_built(op: &str) -> String {
    format!("{op} is not served by this daemon yet")
}

fn no_such_pty(pty_id: &str) -> String {
    format!("no such pty: {pty_id}")
}

/// Both proc ops refuse a pid above the Linux pid_max ceiling as a bad request, as the node daemon does.
fn pid_in_range(pid: std::num::NonZeroU32) -> Result<u32, OpError> {
    if pid.get() > numbers::PID_MAX {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, format!("pid must be an integer between 1 and {}", numbers::PID_MAX)));
    }
    Ok(pid.get())
}

/// The real path a request names, inside the daemon's root or a folder the roots file names as of this op.
async fn locate(ctx: &Ctx, requested: &str) -> Result<PathBuf, OpError> {
    let root = PathBuf::from(&ctx.root);
    let roots_path = ctx.roots_path();
    let requested = requested.to_owned();
    fs::blocking(move || paths::resolve_inside(&paths::roots_now(&root, &roots_path)?, &requested)).await
}

/// Which way an op runs a program, and so which machine it is answered for: this computer, or one workspace this
/// computer holds. One enum rather than a generic on every arm, and one module behind each way.
enum Runner {
    Here(git::here::Here),
    #[cfg(target_os = "linux")]
    Inside(git::inside::Inside),
}

impl git::Runs for Runner {
    async fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        max_bytes: Option<usize>,
    ) -> Result<git::GitResult, OpError> {
        match self {
            Runner::Here(here) => here.run(cwd, program, args, input, max_bytes).await,
            #[cfg(target_os = "linux")]
            Runner::Inside(inside) => inside.run(cwd, program, args, input, max_bytes).await,
        }
    }

    async fn on_path(&self, program: &str) -> Result<bool, OpError> {
        match self {
            Runner::Here(here) => here.on_path(program).await,
            #[cfg(target_os = "linux")]
            Runner::Inside(inside) => inside.on_path(program).await,
        }
    }
}

/// The workspace a frame names, on the daemon of the computer holding it: a workspace on a computer somebody owns
/// runs no daemon of its own, so this daemon answers for it. A daemon that runs no workspace, and one that runs
/// none by this name, answer the same missing refusal every other op answers for a machine it does not know.
#[cfg(target_os = "linux")]
fn workspaces_of(ctx: &Ctx, machine: &str) -> Result<std::sync::Arc<wsp_runtime::ops::Ops>, OpError> {
    match &ctx.runtime {
        Some(ops) => Ok(std::sync::Arc::clone(ops)),
        None => Err(no_such_workspace(machine)),
    }
}

/// The refusal for a workspace this daemon does not run, in the runtime's own words and with its own code, so the
/// host reads one sentence whether the workspace is gone or the computer runs none at all.
fn no_such_workspace(machine: &str) -> OpError {
    OpError::coded(DaemonErrorCode::NotFound, wsp_runtime::no_such_workspace(machine))
}

/// A refusal the workspace runtime gave, as this switch answers it: the workspace it does not know carries the
/// same code a daemon running no workspaces answers with, and every other sentence is the runtime's own.
#[cfg(target_os = "linux")]
pub(crate) fn from_runtime(e: wsp_runtime::ops::OpError) -> OpError {
    match e.kind {
        Some(wsp_frames::MachineErrorKind::Missing) => OpError::coded(DaemonErrorCode::NotFound, e.message),
        _ => OpError::plain(e.message),
    }
}

/// Where a path a frame names is read, and how a program for it is run: on this computer as ever, or under one
/// workspace's rootfs with git run inside that workspace. A path for a workspace is absolute, since the daemon
/// reading it has no working directory inside that workspace and a git run there starts in the folder the frame
/// names; then it is held to the wire's own plain-path rule and resolved against the rootfs, so `..` and a symlink
/// that leaves the workspace are refused exactly as a path that leaves a root is.
async fn road(ctx: &Ctx, machine: Option<&str>, requested: &str, asked: git::Asked) -> Result<(Runner, PathBuf, PathBuf), OpError> {
    let Some(machine) = machine else {
        let at = locate(ctx, requested).await?;
        return Ok((Runner::Here(git::here::Here::new()), at.clone(), at));
    };
    if !Path::new(requested).is_absolute() {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, not_absolute(requested, machine)));
    }
    workspace_road(ctx, machine, requested, asked).await
}

/// The same for one workspace this computer runs: the path under its rootfs, read on this side, and the runner
/// that runs a program inside it.
#[cfg(target_os = "linux")]
async fn workspace_road(ctx: &Ctx, machine: &str, requested: &str, asked: git::Asked) -> Result<(Runner, PathBuf, PathBuf), OpError> {
    let ops = workspaces_of(ctx, machine)?;
    let rootfs = ops.rootfs_of_running(machine).map_err(from_runtime)?;
    // The refusals name the path as the frame gave it: a person reads the folder as the workspace sees it, and
    // where this computer keeps that workspace's files is no part of the answer.
    let joined = wsp_runtime::bundle::inside(&rootfs, requested).map_err(|_| paths::outside_root(requested))?;
    let named = requested.to_owned();
    let under = fs::blocking(move || paths::resolve_inside_named(&[rootfs], &joined.to_string_lossy(), &named)).await?;
    Ok((Runner::Inside(git::inside::Inside::new(ops, machine, asked)), under, PathBuf::from(requested)))
}

/// A pty inside one workspace this computer runs: the shell opens in the folder the frame names, which is
/// absolute and is asked for, since this daemon has no working directory inside a workspace and a pty without one
/// would open a shell in the computer's own home, which every workspace has bound in. The pty is held beside this
/// daemon's own and every op on it names the same workspace.
#[cfg(target_os = "linux")]
async fn pty_inside(
    ctx: &Arc<Ctx>,
    id: Option<RequestId>,
    machine: &str,
    cols: Option<NonZeroU16>,
    rows: Option<NonZeroU16>,
    shell: Option<String>,
    cwd: String,
) -> String {
    let opened = async {
        let ops = workspaces_of(ctx, machine)?;
        let (cols, rows) = (cols.map_or(80, NonZeroU16::get), rows.map_or(24, NonZeroU16::get));
        let running = ops.pty_in(machine, cols, rows, &cwd, shell.as_deref()).await.map_err(from_runtime)?;
        let spawned = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).take_inside(machine, cols, rows, running);
        let reply = PtyCreateReply { pty_id: spawned.id.clone(), pid: spawned.pid };
        tokio::spawn(pump(Arc::clone(ctx), spawned));
        Ok(reply)
    };
    answer(id, opened.await)
}

/// And on a computer whose daemon runs no workspace at all, which is every machine this daemon is inside: the
/// missing refusal, the same one a workspace that is gone answers.
#[cfg(not(target_os = "linux"))]
async fn pty_inside(
    _ctx: &Arc<Ctx>,
    id: Option<RequestId>,
    machine: &str,
    _cols: Option<NonZeroU16>,
    _rows: Option<NonZeroU16>,
    _shell: Option<String>,
    _cwd: String,
) -> String {
    answer::<Empty>(id, Err(no_such_workspace(machine)))
}

/// What a path for a workspace that is not absolute is refused with, wherever a frame names one: this daemon has
/// no working directory inside a workspace, so a folder there is the frame's to give whole. One sentence, read by
/// the files and git road and by the pane's.
fn not_absolute(at: &str, machine: &str) -> String {
    format!("{at} is not an absolute path inside {machine}")
}

/// What a pty for a workspace with no folder named is refused with: the frame says which workspace, and the host
/// fills the folder in from the workspace's own checkout before it sends one.
fn no_folder(machine: &str) -> String {
    format!("a pty inside {machine} needs the folder it opens in")
}

/// And on a computer whose daemon runs no workspace at all, which is every machine this daemon is inside: the
/// missing refusal, the same one a workspace that is gone answers.
#[cfg(not(target_os = "linux"))]
async fn workspace_road(_ctx: &Ctx, machine: &str, _requested: &str, _asked: git::Asked) -> Result<(Runner, PathBuf, PathBuf), OpError> {
    Err(no_such_workspace(machine))
}

async fn serve(conn: &Arc<Conn>, ctx: &Arc<Ctx>, id: Option<RequestId>, name: &str, op: DaemonOp) -> String {
    match op {
        DaemonOp::PtyCreate { cols, rows, shell, cwd, env, machine_id } => {
            if let Some(machine) = machine_id {
                // The folder is the frame's and absolute, whatever workspace it named and whether this computer
                // runs one: a pty for a workspace with no folder would open a shell in the computer's own home,
                // which every workspace here has bound in, so it is a bad request before anything is looked up.
                let Some(cwd) = cwd else { return refuse(id, DaemonErrorCode::BadRequest, no_folder(&machine)) };
                if !Path::new(&cwd).is_absolute() {
                    return refuse(id, DaemonErrorCode::BadRequest, not_absolute(&cwd, &machine));
                }
                return pty_inside(ctx, id, &machine, cols, rows, shell, cwd).await;
            }
            let opts = PtyCreateOpts { cols: cols.map(NonZeroU16::get), rows: rows.map(NonZeroU16::get), shell, cwd, env };
            let spawned = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).create(&opts, &process_env(), passwd_row().as_ref());
            match spawned {
                Ok(spawned) => {
                    let reply = PtyCreateReply { pty_id: spawned.id.clone(), pid: spawned.pid };
                    tokio::spawn(pump(Arc::clone(ctx), spawned));
                    text(&Reply::new(id, reply))
                }
                Err(e) => fail(id, e.to_string()),
            }
        }
        DaemonOp::PtyAttach { pty_id, machine_id } => {
            // Keyed by the socket rather than by the attach, so a second attach on the same socket replaces the
            // first and the detach below takes off what this socket holds.
            let key = conn.key;
            let listener = || Listener { key, out: conn.out.clone() };
            let live = {
                let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
                let Some(session) = ptys.of(&pty_id, machine_id.as_deref()) else { return fail(id, no_such_pty(&pty_id)) };
                session.attach(listener());
                session.on_exit(listener());
                session.exited.is_none().then_some(session.pid)
            };
            // An exited pty tells the newcomer so at once and is never probed again.
            if let Some(pid) = live {
                ctx.modes.attach(&pty_id, pid, listener());
            }
            let (ctx2, pty) = (Arc::clone(ctx), pty_id.clone());
            conn.on_close(Box::new(move || {
                if let Some(session) = ctx2.ptys.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&pty) {
                    session.detach(key);
                }
                ctx2.modes.detach(&pty, key);
            }));
            text(&Reply::new(id, PtyAttachReply { pty_id }))
        }
        DaemonOp::PtyDetach { pty_id, machine_id } => {
            let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
            let Some(session) = ptys.of(&pty_id, machine_id.as_deref()) else { return fail(id, no_such_pty(&pty_id)) };
            session.detach(conn.key);
            drop(ptys);
            ctx.modes.detach(&pty_id, conn.key);
            ok(id)
        }
        DaemonOp::PtyWrite { pty_id, data, machine_id } => {
            let written = match ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).of(&pty_id, machine_id.as_deref()) {
                Some(session) => {
                    session.write(&data);
                    true
                }
                None => false,
            };
            if !written {
                return fail(id, no_such_pty(&pty_id));
            }
            // A person typing into a workspace is that workspace working, whatever the shell does with it.
            if let Some(machine) = &machine_id {
                ctx.workspace_touched(machine);
            }
            ok(id)
        }
        DaemonOp::PtyResize { pty_id, cols, rows, machine_id } => {
            match ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).of(&pty_id, machine_id.as_deref()) {
                Some(session) => match session.resize(cols.get(), rows.get()) {
                    Ok(()) => ok(id),
                    Err(e) => fail(id, e.to_string()),
                },
                None => fail(id, no_such_pty(&pty_id)),
            }
        }
        DaemonOp::PtyKill { pty_id, machine_id } => {
            let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
            if ptys.of(&pty_id, machine_id.as_deref()).is_none() {
                return fail(id, no_such_pty(&pty_id));
            }
            ctx.modes.remove(&pty_id);
            ptys.destroy(&pty_id);
            ok(id)
        }
        DaemonOp::PtyList { machine_id } => {
            let ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).list(machine_id.as_deref());
            text(&Reply::new(id, PtyListReply { ptys }))
        }
        DaemonOp::Exec { cmd, timeout_ms, stdin } => {
            let env: Vec<_> = std::env::vars_os().collect();
            let opts = ExecOptions {
                timeout: Duration::from_millis(u64::from(timeout_ms.unwrap_or(numbers::EXEC_TIMEOUT_DEFAULT_MS))),
                stdin: stdin.as_deref().map(lenient_base64),
                output_max: numbers::EXEC_OUTPUT_MAX,
            };
            text(&Reply::new(id, run_exec(Path::new(&ctx.root), &env, &cmd, opts).await))
        }
        DaemonOp::FsList { path, gitignore, machine_id } => {
            let listed = async {
                let (runner, under, at) = road(ctx, machine_id.as_deref(), &path, Reads).await?;
                fs::list_dir(under, &at, gitignore == Some(true), numbers::FS_LIST_CAP_ENTRIES, &runner).await
            };
            answer(id, listed.await)
        }
        DaemonOp::FsRead { path, encoding, machine_id } => {
            let read = async {
                let (_, under, _) = road(ctx, machine_id.as_deref(), &path, Reads).await?;
                fs::read_file_bounded(under, encoding.unwrap_or(FsReadEncoding::Utf8), numbers::FS_READ_CAP_BYTES).await
            };
            answer(id, read.await)
        }
        DaemonOp::FsFolders { dir, hidden, repos, projects } => {
            let (home, projects) = (PathBuf::from(&ctx.root), projects.unwrap_or_default());
            if repos == Some(true) {
                return answer(id, fs::list_repos(home, projects).await);
            }
            answer(id, fs::list_folders(home, projects, dir, hidden == Some(true)).await)
        }
        DaemonOp::GitStatus { cwd, machine_id } => {
            let read = async {
                let (runner, _, at) = road(ctx, machine_id.as_deref(), &cwd, Reads).await?;
                git::git_status(&runner, &at).await
            };
            answer(id, read.await)
        }
        DaemonOp::GitDiff { cwd, scope, path, machine_id } => {
            let diff = async {
                let (runner, _, at) = road(ctx, machine_id.as_deref(), &cwd, Reads).await?;
                git::git_diff(&runner, &at, scope, path.as_deref(), numbers::GIT_DIFF_CAP_BYTES).await
            };
            answer(id, diff.await)
        }
        DaemonOp::GitPush { cwd, base, machine_id } => {
            let pushed = async {
                let (runner, _, at) = road(ctx, machine_id.as_deref(), &cwd, Works).await?;
                bring_back::push(&runner, &at, base.as_deref()).await
            };
            answer(id, pushed.await)
        }
        DaemonOp::GitPr { cwd, base, title, body, machine_id } => {
            let opened = async {
                let (runner, _, at) = road(ctx, machine_id.as_deref(), &cwd, Works).await?;
                let (remote, remote_url) = bring_back::remote_url(&runner, &at).await?;
                let base = bring_back::base_of(&runner, &at, &remote, base.as_deref()).await?;
                let branch = bring_back::head_for(&runner, &at, &base).await?;
                let ask = hosts::Ask { cwd: &at, remote_url: &remote_url, branch: &branch };
                hosts::open(&runner, &ask, &base, title.as_deref(), body.as_deref()).await
            };
            answer(id, opened.await)
        }
        DaemonOp::GitPrState { cwd, machine_id } => {
            let read = async {
                let (runner, _, at) = road(ctx, machine_id.as_deref(), &cwd, Works).await?;
                let branch = bring_back::branch_at(&runner, &at).await?;
                let (_, remote_url) = bring_back::remote_url(&runner, &at).await?;
                let ask = hosts::Ask { cwd: &at, remote_url: &remote_url, branch: &branch };
                Ok(GitPrStateReply { pr: hosts::find(&runner, &ask).await? })
            };
            answer(id, read.await)
        }
        DaemonOp::PortsWatch => {
            let key = ctx.next_key();
            ctx.ports.subscribe(Listener { key, out: conn.out.clone() });
            let ctx2 = Arc::clone(ctx);
            conn.on_close(Box::new(move || ctx2.ports.unsubscribe(key)));
            ctx.ports.start(ctx);
            // The poll and the reading of what it left are one held lock, so the reply carries the seed and not a
            // state a later poll has already moved on from.
            let (events, ports) = {
                let mut watcher = ctx.ports.watcher.lock().await;
                let events = watcher.poll().await;
                (events, watcher.current())
            };
            ctx.ports.deliver(ctx, events);
            text(&Reply::new(id, PortsWatchReply { ports }))
        }
        DaemonOp::ManifestGet => {
            text(&Reply::new(id, ManifestGetReply { entries: ctx.manifest.lock().unwrap_or_else(|e| e.into_inner()).entries() }))
        }
        DaemonOp::ManifestRecord { cmd, cwd, port } => {
            let recorded = ctx.manifest.lock().unwrap_or_else(|e| e.into_inner()).record(RecordInput { cmd, cwd, port });
            match recorded {
                Ok(entry) => text(&Reply::new(id, ManifestRecordReply { entry })),
                Err(e) => fail(id, e.to_string()),
            }
        }
        DaemonOp::ManifestRestartScript => text(&Reply::new(
            id,
            ManifestRestartScriptReply { script: ctx.manifest.lock().unwrap_or_else(|e| e.into_inner()).restart_script() },
        )),
        DaemonOp::InboxWatch => match ctx.inbox.get_or_start(ctx) {
            Ok(running) => {
                let key = ctx.next_key();
                running.subscribe(Listener { key, out: conn.out.clone() });
                conn.on_close(Box::new(move || running.unsubscribe(key)));
                ok(id)
            }
            Err(e) => fail(id, e.to_string()),
        },
        DaemonOp::InboxRescan => {
            let files = ctx.inbox.get_or_start(ctx).and_then(|running| running.state.lock().unwrap_or_else(|e| e.into_inner()).rescan());
            match files {
                Ok(files) => {
                    // The events land before the reply does, on the socket's one channel.
                    for event in &files {
                        conn.out.send_event(event);
                    }
                    text(&Reply::new(id, InboxRescanReply { count: files.len() as u64 }))
                }
                Err(e) => fail(id, e.to_string()),
            }
        }
        DaemonOp::GuestOpen { kind, token, turn_token, argv, cwd } => {
            answer(id, ctx.guests.open(conn, GuestOpen { kind, token, turn_token, argv, cwd }).map(|session| GuestOpenReply { session }))
        }
        DaemonOp::GuestSend { message } => answer(id, ctx.guests.send(conn, message).map(|()| Empty {})),
        DaemonOp::GuestWatch => {
            ctx.guests.watch(conn);
            ok(id)
        }
        DaemonOp::GuestReply { session, message } => answer(id, ctx.guests.reply(conn, &session, message).map(|()| Empty {})),
        DaemonOp::GuestClose { session, error } => answer(id, ctx.guests.close(conn, &session, error).map(|()| Empty {})),
        DaemonOp::TunnelOpen { tunnel_id, port } => answer(id, Tunnels::open(conn, tunnel_id, port.get()).await.map(|()| Empty {})),
        DaemonOp::TunnelWrite { tunnel_id, data } => answer(id, conn.tunnels.write(&tunnel_id, lenient_base64(&data)).map(|()| Empty {})),
        DaemonOp::TunnelClose { tunnel_id } => {
            conn.tunnels.close(&tunnel_id);
            ok(id)
        }
        DaemonOp::SysWatch => {
            // One read before the watch is taken: a machine whose module cannot read it refuses here, where the pane
            // can say so, rather than accepting a stream it will never send and leaving the rows at pending.
            let watched = async {
                let sampler = ctx.sys_sampler()?;
                sampler.probe().await?;
                let key = ctx.next_key();
                conn.while_open(|| {
                    sampler.subscribe(key, conn.out.clone());
                    Some(Box::new(move || sampler.unsubscribe(key)) as Detach)
                });
                Ok(Empty {})
            };
            answer(id, watched.await)
        }
        DaemonOp::ProcWatch => {
            let watched = async {
                let sampler = ctx.proc_sampler()?;
                sampler.probe().await?;
                let key = ctx.next_key();
                conn.while_open(|| {
                    let mut watch = conn.proc_watch.lock().unwrap_or_else(|e| e.into_inner());
                    if watch.is_some() {
                        return None;
                    }
                    sampler.subscribe(key, conn.out.clone());
                    *watch = Some((key, Arc::clone(&sampler)));
                    Some(Box::new(move || sampler.unsubscribe(key)) as Detach)
                });
                Ok(Empty {})
            };
            answer(id, watched.await)
        }
        DaemonOp::ProcUnwatch => {
            let watch = conn.proc_watch.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some((key, sampler)) = watch {
                sampler.unsubscribe(key);
            }
            ok(id)
        }
        DaemonOp::ProcInspect { pid } => {
            let inspected = async { ctx.proc_sampler()?.inspect(pid_in_range(pid)?).await };
            answer(id, inspected.await)
        }
        DaemonOp::ProcKill { pid, signal } => {
            let protected = ProtectedPids { this: std::process::id(), parent: std::os::unix::process::parent_id() };
            answer(id, pid_in_range(pid).and_then(|pid| kill_process(pid, signal, protected)).map(|()| Empty {}))
        }
        _ => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Options;
    use serde_json::json;
    use std::io::Write;
    use tokio::sync::mpsc;

    struct Bench {
        ctx: Arc<Ctx>,
        _token: tempfile::NamedTempFile,
        root: tempfile::TempDir,
    }

    fn bench() -> Bench {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.root = Some(root.path().to_path_buf());
        options.roots_path = Some(root.path().join("roots"));
        options.manifest_path = Some(root.path().join("manifest.json"));
        Bench { ctx: Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap()), _token: token, root }
    }

    fn conn(scope: Option<u16>) -> (Arc<Conn>, mpsc::UnboundedReceiver<Outgoing>) {
        conn_on(scope, Road::Inbound)
    }

    /// A daemon of a computer somebody owns: the place file is what the roads table reads, and on this platform
    /// it turns no runtime on, so the bench is the switch alone.
    fn place_bench() -> Bench {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.root = Some(root.path().to_path_buf());
        options.roots_path = Some(root.path().join("roots"));
        options.manifest_path = Some(root.path().join("manifest.json"));
        options.place_file = Some(root.path().join("place.json"));
        Bench { ctx: Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap()), _token: token, root }
    }

    fn conn_on(scope: Option<u16>, road: Road) -> (Arc<Conn>, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(Conn::new(1, scope.and_then(NonZeroU16::new), Outbound(tx), road, None)), rx)
    }

    async fn reply(bench: &Bench, conn: &Arc<Conn>, frame: Value) -> Value {
        serde_json::from_str(handle(conn, &bench.ctx, &frame.to_string()).await.text()).unwrap()
    }

    async fn reply_raw(bench: &Bench, conn: &Arc<Conn>, raw: &str) -> Value {
        serde_json::from_str(handle(conn, &bench.ctx, raw).await.text()).unwrap()
    }

    #[tokio::test]
    async fn ping_answers_the_bare_ok_envelope() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(reply(&b, &c, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        assert_eq!(reply(&b, &c, json!({"id": "a", "op": "ping", "pad": "x"})).await, json!({"id": "a", "ok": true}));
        assert_eq!(reply(&b, &c, json!({"op": "ping"})).await, json!({"id": null, "ok": true}));
    }

    #[tokio::test]
    async fn invalid_json_is_answered_under_a_null_id() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(reply_raw(&b, &c, "{nope").await, json!({"id": null, "ok": false, "error": "invalid json"}));
        assert_eq!(reply_raw(&b, &c, "{\"id\": 1, \"op\": ").await, json!({"id": null, "ok": false, "error": "invalid json"}));
    }

    #[tokio::test]
    async fn a_json_value_that_is_not_an_object_is_an_unknown_op_as_the_node_daemon_reads_it() {
        let b = bench();
        let (c, _rx) = conn(None);
        for raw in ["[1,2,3]", "42", "\"x\"", "null", "true"] {
            assert_eq!(reply_raw(&b, &c, raw).await, json!({"id": null, "ok": false, "error": "unknown op: undefined"}), "{raw}");
        }
        let (scoped, _rx) = conn(Some(8123));
        assert_eq!(reply_raw(&b, &scoped, "[1,2,3]").await["code"], "forbidden");
    }

    #[tokio::test]
    async fn an_unknown_op_is_named_never_silent() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(
            reply(&b, &c, json!({"id": 3, "op": "sys.explode"})).await,
            json!({"id": 3, "ok": false, "error": "unknown op: sys.explode"})
        );
        assert_eq!(reply(&b, &c, json!({"id": 4})).await, json!({"id": 4, "ok": false, "error": "unknown op: undefined"}));
        assert_eq!(reply(&b, &c, json!({"id": 5, "op": 7})).await, json!({"id": 5, "ok": false, "error": "unknown op: 7"}));
    }

    #[tokio::test]
    async fn every_op_the_protocol_names_is_served_so_the_not_built_refusal_has_nothing_left_to_name() {
        let b = bench();
        let (c, _rx) = conn(None);
        let built = [
            "ping",
            "place.leave",
            "place.update",
            "pty.create",
            "pty.attach",
            "pty.detach",
            "pty.write",
            "pty.resize",
            "pty.kill",
            "pty.list",
            "exec",
            "fs.list",
            "fs.read",
            "git.status",
            "git.diff",
            "git.push",
            "git.pr",
            "git.prState",
            "fs.folders",
            "ports.watch",
            "manifest.get",
            "manifest.record",
            "manifest.restartScript",
            "inbox.watch",
            "inbox.rescan",
            "tunnel.open",
            "tunnel.write",
            "tunnel.close",
            "sys.watch",
            "proc.watch",
            "proc.unwatch",
            "proc.inspect",
            "proc.kill",
            "guest.open",
            "guest.send",
            "guest.watch",
            "guest.reply",
            "guest.close",
        ];
        let unserved: Vec<&&str> = DAEMON_OPS.iter().filter(|op| !built.contains(op)).collect();
        assert!(unserved.is_empty(), "{unserved:?}");
        for op in built {
            assert_ne!(reply(&b, &c, json!({"id": 1, "op": op})).await["code"], "unsupported", "{op}");
        }
    }

    #[tokio::test]
    async fn link_only_ops_are_forbidden_on_an_inbound_socket_but_the_two_that_only_read() {
        let b = bench();
        let (c, _rx) = conn(None);
        for op in ["place.leave", "place.update"] {
            assert_eq!(
                reply(&b, &c, json!({"id": 1, "op": op})).await,
                json!({"id": 1, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD}),
                "{op}"
            );
        }
        for op in MACHINE_OPS {
            if MACHINE_OPS_ON_ANY_ROAD.contains(&op) {
                continue;
            }
            assert_eq!(
                reply(&b, &c, json!({"id": 2, "op": op})).await,
                json!({"id": 2, "ok": false, "code": "forbidden", "error": "not on this road"}),
                "{op}"
            );
        }
        // The listing and one workspace's reading are answered on this road: a client here holds the daemon's own
        // token and neither op drives anything. This bench holds no runtime, so the answer is the backend's.
        for op in MACHINE_OPS_ON_ANY_ROAD {
            assert_eq!(
                reply(&b, &c, json!({"id": 3, "op": op, "machineId": "wsp-x"})).await,
                json!({"id": 3, "ok": false, "error": format!("this computer's backend has no {op}")}),
                "{op}"
            );
        }
    }

    /// The eight ops a layer store answered: they are on no road now, on the link least of all, so the daemon
    /// names them the way it names any op it does not serve. A workspace on a computer somebody joined is a copy
    /// of that computer, so there is no snapshot to save, no template to name and nothing to list.
    #[tokio::test]
    async fn the_snapshot_and_template_ops_are_no_longer_ops_this_daemon_serves() {
        let b = bench();
        let (link, _rx) = conn_on(None, Road::Link);
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
            assert!(!MACHINE_OPS.contains(&op), "{op} is still a machine op");
            assert_eq!(
                reply(&b, &link, json!({"id": 9, "op": op, "machineId": "wsp-x", "name": "v1", "snapshotId": "sha256:aa", "templateId": "wsp/dev:template", "job": "j"})).await,
                json!({"id": 9, "ok": false, "error": words::unknown_op(op)}),
                "{op}"
            );
        }
    }

    #[tokio::test]
    async fn on_the_link_every_machine_op_is_answered_by_the_runtime_stub_and_the_leave_sweeps_then_stops() {
        let b = bench();
        let (link, _rx) = conn_on(None, Road::Link);
        for op in MACHINE_OPS {
            assert_eq!(
                reply(&b, &link, json!({"id": 3, "op": op})).await,
                json!({"id": 3, "ok": false, "error": format!("this computer's backend has no {op}")}),
                "{op}"
            );
        }
        // An inbound socket on the same daemon is answered the two that read and refused the rest.
        let (inbound, _rx2) = conn(None);
        assert_eq!(
            reply(&b, &inbound, json!({"id": 4, "op": "machine.list"})).await["error"],
            "this computer's backend has no machine.list"
        );
        assert_eq!(reply(&b, &inbound, json!({"id": 4, "op": "machine.kill"})).await["error"], words::NOT_ON_THIS_ROAD);
        let home = tempfile::tempdir().unwrap();
        let at = wsp_frames::place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.wsp).unwrap();
        std::fs::write(&at.place_file, "{}").unwrap();
        std::fs::write(&at.token_path, "t\n").unwrap();
        let mut options = Options::new(b._token.path());
        options.home = Some(home.path().to_path_buf());
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        let out = handle(&link, &ctx, &json!({"id": 21, "op": "place.leave"}).to_string()).await;
        let Outgoing::Leave(text) = &out else { panic!("a leave stops the daemon after its reply") };
        // Each part of wsp's own folder is named for the line it puts in front of a person, and the folder itself
        // goes last, so nothing under it is left on a computer the person joined.
        let swept = json!([at.place_file.to_string_lossy(), at.token_path.to_string_lossy(), at.wsp.to_string_lossy()]);
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), json!({"id": 21, "ok": true, "swept": swept}));
        assert!(!at.place_file.exists() && !at.token_path.exists() && !at.wsp.exists());
    }

    #[tokio::test]
    async fn an_update_takes_its_parts_on_the_link_and_refuses_a_gap_and_bytes_the_host_did_not_name() {
        let b = bench();
        let (link, _rx) = conn_on(None, Road::Link);
        let home = tempfile::tempdir().unwrap();
        let mut options = Options::new(b._token.path());
        options.home = Some(home.path().to_path_buf());
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        // Never the sha of what this sends: the exe a landing moves over is this test binary's own, so a part that
        // matched would replace the runner under itself. The landing is proved in place.rs against a temp file.
        let sha = "0".repeat(64);
        let part = |seq: u64, last: bool, data: &str| json!({"id": 9, "op": "place.update", "uploadId": "u1", "seq": seq, "last": last, "data": data, "sha256": sha});
        let said = |out: &Outgoing| serde_json::from_str::<Value>(out.text()).unwrap();

        // A part that is not the first with nothing landed drops the upload and says which part.
        let gap = handle(&link, &ctx, &part(1, false, "AAAA").to_string()).await;
        assert!(matches!(gap, Outgoing::Text(_)), "a refused part ended the daemon");
        assert_eq!(said(&gap), json!({"id": 9, "ok": false, "error": words::update_out_of_order(1, 0, "u1")}));

        // Every part but the last is a plain ok and lands nothing.
        let first = handle(&link, &ctx, &part(0, false, "AAAA").to_string()).await;
        assert_eq!(said(&first), json!({"id": 9, "ok": true}));
        assert_eq!(std::fs::read(crate::place::update_part(home.path(), "u1")).unwrap(), vec![0, 0, 0]);

        // The last part is checked against the sha256 the host named before anything is moved, and the daemon
        // stays up when the bytes are not the ones it was promised.
        let wrong = handle(&link, &ctx, &part(1, true, "AAAA").to_string()).await;
        assert!(matches!(wrong, Outgoing::Text(_)), "a binary the host did not name ended the daemon");
        assert_eq!(said(&wrong)["ok"], json!(false));
        assert!(said(&wrong)["error"].as_str().unwrap().starts_with("the update u1 landed as sha256 "), "{}", said(&wrong));
        assert!(!crate::place::update_part(home.path(), "u1").exists(), "the dropped upload stays on disk");

        // A frame the schema refuses is a bad request, never a landing.
        let bad = handle(
            &link,
            &ctx,
            &json!({"id": 9, "op": "place.update", "uploadId": "../x", "seq": 0, "last": true, "data": "", "sha256": sha}).to_string(),
        )
        .await;
        assert_eq!(said(&bad)["code"], json!("bad-request"));
    }

    /// A root the open refuses: nothing is made under it and every machine op answers the open's own sentence,
    /// so the person asking what this computer can do reads why rather than a line that names the op. The root
    /// here is a path under one of the directories every workspace overlays; it is never created, since the
    /// refusal comes before the first directory.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_root_the_open_refuses_leaves_its_reason_on_every_machine_op() {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let home = tempfile::tempdir().unwrap();
        let under = std::path::Path::new("/var/lib/wsp-under-a-lower");
        let mut options = Options::new(token.path());
        options.place_file = Some(home.path().join("place.json"));
        options.runtime_root = Some(under.to_path_buf());
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        let (link, _rx) = conn_on(None, Road::Link);
        let said = wsp_runtime::doctor::root_under_a_lower(under).expect("a root under /var read as clear of it");
        for op in ["machine.backend", "machine.checkKey", "machine.create", "machine.list"] {
            let reply: Value = serde_json::from_str(
                handle(&link, &ctx, &json!({"id": 6, "op": op, "spec": {"kind": "sandbox"}}).to_string()).await.text(),
            )
            .unwrap();
            assert_eq!(reply, json!({"id": 6, "ok": false, "error": said}), "{op}");
        }
        assert!(!under.exists(), "the open made a folder under a root it refused");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_place_daemon_answers_the_machine_ops_on_its_link_from_the_workspace_runtime() {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let home = tempfile::tempdir().unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.place_file = Some(home.path().join("place.json"));
        options.runtime_root = Some(runtime_root.path().to_path_buf());
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        let (link, _rx) = conn_on(None, Road::Link);
        let listed: Value =
            serde_json::from_str(handle(&link, &ctx, &json!({"id": 1, "op": "machine.list"}).to_string()).await.text()).unwrap();
        assert_eq!(listed, json!({"id": 1, "ok": true, "machines": []}));
        let lost: Value = serde_json::from_str(
            handle(&link, &ctx, &json!({"id": 2, "op": "machine.get", "machineId": "wsp-x"}).to_string()).await.text(),
        )
        .unwrap();
        assert_eq!(lost, json!({"id": 2, "ok": false, "error": "no such workspace: wsp-x", "kind": "missing", "status": 404}));
        // What the open makes under the root it was given, and nothing of a layer store: the workspaces, the
        // runtime's own state and the copies a workspace's project is made as.
        for dir in ["run", "state", "copies"] {
            assert!(runtime_root.path().join(dir).is_dir(), "the open made no {dir} under the runtime root");
        }
        assert!(!runtime_root.path().join("layers").exists(), "the open made a layer store under the runtime root");
        // The same op inbound is answered by the same runtime, and the reading of a workspace it has not got is
        // that workspace missing rather than the road refusal; an op that drives something is still refused.
        let (inbound, _rx2) = conn(None);
        let listed: Value =
            serde_json::from_str(handle(&inbound, &ctx, &json!({"id": 3, "op": "machine.list"}).to_string()).await.text()).unwrap();
        assert_eq!(listed, json!({"id": 3, "ok": true, "machines": []}));
        let read: Value = serde_json::from_str(
            handle(&inbound, &ctx, &json!({"id": 4, "op": "machine.metrics", "machineId": "wsp-x"}).to_string()).await.text(),
        )
        .unwrap();
        assert_eq!(read, json!({"id": 4, "ok": false, "error": "no such workspace: wsp-x", "kind": "missing", "status": 404}));
        let refused: Value = serde_json::from_str(
            handle(&inbound, &ctx, &json!({"id": 5, "op": "machine.pause", "machineId": "wsp-x"}).to_string()).await.text(),
        )
        .unwrap();
        assert_eq!(refused["error"], words::NOT_ON_THIS_ROAD);
    }

    /// A files or git frame that names a workspace is answered for that workspace by the daemon of the computer
    /// holding it. This bench runs no workspaces at all, which is every computer that is not a place: each of the
    /// seven answers the one missing refusal, and the same frame without a workspace named resolves under this
    /// daemon's own roots as it always has.
    #[tokio::test]
    async fn a_frame_that_names_a_workspace_this_daemon_does_not_run_is_refused_as_missing() {
        let b = bench();
        let (sock, _rx) = conn(None);
        for op in ["fs.list", "fs.read"] {
            let reply = reply(&b, &sock, json!({"id": 1, "op": op, "path": "/root/repo", "machineId": "wsp-x"})).await;
            assert_eq!(reply, json!({"id": 1, "ok": false, "code": "not-found", "error": "no such workspace: wsp-x"}), "{op}");
        }
        for op in ["git.status", "git.push", "git.pr", "git.prState"] {
            let reply = reply(&b, &sock, json!({"id": 1, "op": op, "cwd": "/root/repo", "machineId": "wsp-x"})).await;
            assert_eq!(reply, json!({"id": 1, "ok": false, "code": "not-found", "error": "no such workspace: wsp-x"}), "{op}");
        }
        let diff = reply(&b, &sock, json!({"id": 1, "op": "git.diff", "cwd": "/root/repo", "scope": "branch", "machineId": "wsp-x"})).await;
        assert_eq!(diff, json!({"id": 1, "ok": false, "code": "not-found", "error": "no such workspace: wsp-x"}));
        // The same refusal a machine op on the link answers for a workspace this computer does not run, so a
        // workspace that is gone and a computer that runs none read as one thing.
        assert_eq!(wsp_runtime::no_such_workspace("wsp-x"), "no such workspace: wsp-x");
        // A relative path for a workspace is refused before anything is read: this daemon has no working directory
        // inside that workspace, and a git run there starts in the folder the frame names. The host sends the
        // checkout's own absolute path.
        for (op, key) in [("fs.list", "path"), ("git.status", "cwd")] {
            let reply = reply(&b, &sock, json!({"id": 1, "op": op, key: "repo", "machineId": "wsp-x"})).await;
            assert_eq!(
                reply,
                json!({"id": 1, "ok": false, "code": "bad-request", "error": "repo is not an absolute path inside wsp-x"}),
                "{op}"
            );
        }
        // And with no workspace named, the path is this daemon's own: a folder outside every root is refused as it
        // always was, and nothing here reads a workspace at all.
        let outside = reply(&b, &sock, json!({"id": 2, "op": "git.status", "cwd": "/etc"})).await;
        assert_eq!(outside["code"], "outside-root");
    }

    #[tokio::test]
    async fn the_guest_ops_are_the_inbound_roads_and_the_link_is_refused_every_one() {
        let b = bench();
        let (link, _rx) = conn_on(None, Road::Link);
        for op in GUEST_OPS {
            assert_eq!(
                reply(&b, &link, json!({"id": 1, "op": op, "session": "g0", "message": {}})).await,
                json!({"id": 1, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD}),
                "{op}"
            );
        }
        // The same socket still answers the ops that are not the guest road's.
        assert_eq!(reply(&b, &link, json!({"id": 2, "op": "ping"})).await, json!({"id": 2, "ok": true}));
        // And an inbound socket opens a session, which is what the link was refused.
        let (inbound, _rx2) = conn(None);
        let opened =
            reply(&b, &inbound, json!({"id": 3, "op": "guest.open", "kind": "cli", "token": "", "argv": [], "cwd": "/root"})).await;
        assert_eq!(opened["ok"], json!(true));
        assert!(opened["session"].is_string(), "{opened}");
    }

    /// The roads table, read on every road a socket of this daemon can come in on. A process inside a workspace
    /// opens a session and speaks on it and reaches nothing else of the computer that workspace sits on: not the
    /// listing of its neighbours, not one of their readings, not a pty, not an exec, not the guest sessions the
    /// host watches.
    #[tokio::test]
    async fn a_socket_inside_a_workspace_serves_the_guests_two_ops_and_ping_and_refuses_every_other() {
        let b = place_bench();
        let (inside, _rx) = conn_on(None, Road::Workspace("wsp-a".to_owned()));
        assert_eq!(reply(&b, &inside, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        let opened = reply(&b, &inside, json!({"id": 2, "op": "guest.open", "kind": "cli", "token": "", "argv": [], "cwd": "/root"})).await;
        assert_eq!(opened["ok"], json!(true), "{opened}");
        // The second of the guest's two: this socket holds a session now, so the send is answered rather than
        // turned away at the road.
        assert_eq!(reply(&b, &inside, json!({"id": 3, "op": "guest.send", "message": {}})).await, json!({"id": 3, "ok": true}));
        let refused = |id: i64| json!({"id": id, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD});
        for op in DAEMON_OPS.iter().filter(|op| !matches!(**op, "ping" | "guest.open" | "guest.send")) {
            assert_eq!(reply(&b, &inside, json!({"id": 4, "op": op, "session": "g0", "message": {}})).await, refused(4), "{op}");
        }
        for op in MACHINE_OPS {
            assert_eq!(reply(&b, &inside, json!({"id": 5, "op": op, "machineId": "wsp-b"})).await, refused(5), "{op}");
        }
        // The two the daemon answers on every other road, named: a process inside a workspace lists no workspace
        // of this computer and reads no neighbour's metrics.
        for op in ["machine.list", "machine.metrics", "place.leave", "place.update"] {
            assert_eq!(reply(&b, &inside, json!({"id": 6, "op": op, "machineId": "wsp-b"})).await, refused(6), "{op}");
        }
    }

    /// The other three rows of the same table: the host's three ops belong to the link of a computer's own daemon
    /// and to the inbound socket of a daemon inside a machine, and a place daemon's own inbound socket, which a
    /// person at that computer holds its token for, serves none of the five.
    #[tokio::test]
    async fn the_guest_roads_are_where_a_guest_lives_and_where_the_host_is() {
        let b = place_bench();
        let (link, _rx) = conn_on(None, Road::Link);
        for op in ["guest.watch", "guest.reply", "guest.close"] {
            let said = reply(&b, &link, json!({"id": 1, "op": op, "session": "g0", "message": {}})).await;
            assert_ne!(said["code"], json!("forbidden"), "{op}: {said}");
        }
        for op in ["guest.open", "guest.send"] {
            assert_eq!(
                reply(&b, &link, json!({"id": 2, "op": op, "kind": "cli", "token": "", "argv": [], "cwd": "/root", "message": {}})).await,
                json!({"id": 2, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD}),
                "{op}"
            );
        }
        let (inbound, _rx2) = conn_on(None, Road::Inbound);
        for op in GUEST_OPS {
            assert_eq!(
                reply(
                    &b,
                    &inbound,
                    json!({"id": 3, "op": op, "kind": "cli", "token": "", "argv": [], "cwd": "/root", "session": "g0", "message": {}})
                )
                .await,
                json!({"id": 3, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD}),
                "{op}"
            );
        }
    }

    /// The workspace a session belongs to is the daemon's own reading of which socket it arrived on, and it rides
    /// every frame of that session up to the host. A reply reaches the socket that opened the session and no
    /// other, so a session of one workspace can never be read or answered as another's.
    #[tokio::test]
    async fn a_session_carries_the_workspace_its_socket_was_inside_and_reaches_that_socket_alone() {
        let b = place_bench();
        let (host, mut watching) = conn_on(None, Road::Link);
        assert_eq!(reply(&b, &host, json!({"id": 1, "op": "guest.watch"})).await["ok"], json!(true));
        let open = json!({"id": 2, "op": "guest.open", "kind": "cli", "token": "dev-1.tok", "argv": ["threads"], "cwd": "/root"});
        let (a_side, mut a_events) = conn_on(None, Road::Workspace("wsp-a".to_owned()));
        let (b_side, mut b_events) = conn_on(None, Road::Workspace("wsp-b".to_owned()));
        let a = reply(&b, &a_side, open.clone()).await["session"].as_str().unwrap().to_owned();
        let other = reply(&b, &b_side, open).await["session"].as_str().unwrap().to_owned();
        let mut opened = Vec::new();
        for _ in 0..2 {
            let frame: Value = serde_json::from_str(watching.recv().await.unwrap().text()).unwrap();
            opened.push((frame["session"].clone(), frame["machineId"].clone()));
        }
        opened.sort_by_key(|(session, _)| session.to_string());
        assert_eq!(opened, [(json!(a), json!("wsp-a")), (json!(other), json!("wsp-b"))]);
        // The message a guest sends rides up with the same name on it.
        assert_eq!(reply(&b, &a_side, json!({"id": 3, "op": "guest.send", "message": {"hello": 1}})).await["ok"], json!(true));
        let said: Value = serde_json::from_str(watching.recv().await.unwrap().text()).unwrap();
        assert_eq!(said, json!({"type": "guest.message", "session": a, "message": {"hello": 1}, "machineId": "wsp-a"}));
        // And the host's answer goes to the socket that opened that session: the other workspace hears nothing.
        let answered = json!({"id": 4, "op": "guest.reply", "session": a, "message": {"exit": 3}});
        assert_eq!(reply(&b, &host, answered).await["ok"], json!(true));
        let down: Value = serde_json::from_str(a_events.recv().await.unwrap().text()).unwrap();
        assert_eq!(down, json!({"type": "guest.message", "session": a, "message": {"exit": 3}, "machineId": "wsp-a"}));
        assert!(b_events.try_recv().is_err(), "a session of one workspace reached another's socket");
        // A session opened on a daemon inside a machine names no workspace at all: that machine is the one the
        // host dialled.
        let b2 = bench();
        let (fork_host, mut fork_watching) = conn(None);
        reply(&b2, &fork_host, json!({"id": 1, "op": "guest.watch"})).await;
        let (inbound, _rx) = conn(None);
        reply(&b2, &inbound, json!({"id": 2, "op": "guest.open", "kind": "cli", "token": "", "argv": [], "cwd": "/root"})).await;
        let frame: Value = serde_json::from_str(fork_watching.recv().await.unwrap().text()).unwrap();
        assert_eq!(frame["type"], "guest.opened");
        assert_eq!(frame.get("machineId"), None, "{frame}");
    }

    /// The pty ops for a workspace, on a daemon that runs none, which is every machine wsp forked and this bench.
    /// What the frame has to carry is read before the workspace is looked up, since a pty with no folder would
    /// open a shell in the computer's own home, which every workspace here has bound in; and a workspace this
    /// daemon does not run is the one missing refusal every other op answers for one.
    #[tokio::test]
    async fn a_pty_for_a_workspace_names_its_folder_and_a_workspace_this_daemon_runs() {
        let b = bench();
        let (c, _rx) = conn(None);
        // No folder at all, and one that is not absolute: a bad request before anything is looked up.
        let none = reply(&b, &c, json!({"id": 1, "op": "pty.create", "machineId": "wsp-x"})).await;
        assert_eq!(none, json!({"id": 1, "ok": false, "code": "bad-request", "error": "a pty inside wsp-x needs the folder it opens in"}));
        let relative = reply(&b, &c, json!({"id": 2, "op": "pty.create", "machineId": "wsp-x", "cwd": "project"})).await;
        assert_eq!(relative, json!({"id": 2, "ok": false, "code": "bad-request", "error": "project is not an absolute path inside wsp-x"}));
        // And with both: the workspace, which this daemon does not run.
        let gone = reply(&b, &c, json!({"id": 3, "op": "pty.create", "machineId": "wsp-x", "cwd": "/root/project"})).await;
        assert_eq!(gone, json!({"id": 3, "ok": false, "code": "not-found", "error": "no such workspace: wsp-x"}));
        // Every other pty op naming a workspace answers for a pty of that workspace, and this daemon holds none:
        // a pane of one workspace never reaches a pty of another or of the computer itself.
        for op in ["pty.attach", "pty.write", "pty.resize", "pty.detach", "pty.kill"] {
            let said =
                reply(&b, &c, json!({"id": 4, "op": op, "ptyId": "pty_1", "machineId": "wsp-x", "data": "x", "cols": 80, "rows": 24}))
                    .await;
            assert_eq!(said, json!({"id": 4, "ok": false, "error": "no such pty: pty_1"}), "{op}");
        }
        // And the listing is the machine's the frame named: this daemon's own where it named none, and a
        // workspace's where it did, which here is empty either way.
        assert_eq!(reply(&b, &c, json!({"id": 5, "op": "pty.list"})).await, json!({"id": 5, "ok": true, "ptys": []}));
        assert_eq!(reply(&b, &c, json!({"id": 6, "op": "pty.list", "machineId": "wsp-x"})).await, json!({"id": 6, "ok": true, "ptys": []}));
    }

    /// A pty of this computer's own is not reachable by naming a workspace, and the shell the daemon opened for
    /// itself is listed for this computer and for no workspace.
    #[tokio::test]
    async fn a_pty_of_this_computer_is_no_workspaces_pty() {
        let b = bench();
        let (c, _rx) = conn(None);
        let made = reply(&b, &c, json!({"id": 1, "op": "pty.create", "shell": "bash"})).await;
        assert_eq!(made["ok"], json!(true), "{made}");
        let pty_id = made["ptyId"].as_str().unwrap().to_owned();
        for op in ["pty.attach", "pty.write", "pty.resize", "pty.detach", "pty.kill"] {
            let said =
                reply(&b, &c, json!({"id": 2, "op": op, "ptyId": &pty_id, "machineId": "wsp-a", "data": "x", "cols": 80, "rows": 24}))
                    .await;
            assert_eq!(said["error"], json!(format!("no such pty: {pty_id}")), "{op}");
        }
        let listed = reply(&b, &c, json!({"id": 3, "op": "pty.list"})).await;
        assert_eq!(listed["ptys"].as_array().unwrap().len(), 1, "{listed}");
        assert_eq!(listed["ptys"][0]["id"], json!(pty_id));
        let inside = reply(&b, &c, json!({"id": 4, "op": "pty.list", "machineId": "wsp-a"})).await;
        assert_eq!(inside, json!({"id": 4, "ok": true, "ptys": []}));
        assert_eq!(reply(&b, &c, json!({"id": 5, "op": "pty.kill", "ptyId": &pty_id})).await, json!({"id": 5, "ok": true}));
    }

    #[tokio::test]
    async fn a_port_scoped_socket_answers_ping_and_tunnel_ops_on_its_port_alone() {
        let b = bench();
        // A guest listening on the loopback, so the one in-scope tunnel really opens.
        let guest = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let guest_port = guest.local_addr().unwrap().port();
        let (scoped, mut rx) = conn(Some(guest_port));
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        let refused = json!({"id": 1, "ok": false, "code": "forbidden", "error": words::port_scope_refusal(guest_port)});
        for op in [
            "pty.create",
            "pty.list",
            "fs.list",
            "git.status",
            "ports.watch",
            "sys.watch",
            "proc.watch",
            "proc.inspect",
            "proc.kill",
            "manifest.get",
            "inbox.watch",
            "machine.create",
            "place.leave",
            "exec",
            "nonsense",
        ] {
            assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": op, "path": ".", "cwd": ".", "scope": "staged"})).await, refused, "{op}");
        }
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": guest_port + 1})).await, refused);
        assert_eq!(
            reply(&b, &scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": guest_port})).await,
            json!({"id": 1, "ok": true})
        );
        let (mut guest_side, _) = guest.accept().await.unwrap();
        assert_eq!(
            reply(&b, &scoped, json!({"id": 2, "op": "tunnel.write", "tunnelId": "t", "data": "R0VU"})).await,
            json!({"id": 2, "ok": true})
        );
        let mut got = [0u8; 3];
        let read = tokio::io::AsyncReadExt::read_exact(&mut guest_side, &mut got);
        tokio::time::timeout(std::time::Duration::from_secs(5), read).await.expect("the bytes reach the guest").unwrap();
        assert_eq!(&got, b"GET");
        assert_eq!(reply(&b, &scoped, json!({"id": 3, "op": "tunnel.close", "tunnelId": "t"})).await, json!({"id": 3, "ok": true}));
        let end = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(end.text()).unwrap(), json!({"type": "tunnel.end", "tunnelId": "t"}));
        assert_eq!(reply(&b, &scoped, json!({"id": 4, "op": "tunnel.write", "tunnelId": "t", "data": ""})).await["code"], "not-found");
    }

    #[tokio::test]
    async fn a_frame_the_protocol_refuses_is_a_bad_request_and_a_pty_nobody_opened_is_named() {
        let b = bench();
        let (c, _rx) = conn(None);
        for frame in [
            json!({"id": 1, "op": "exec", "cmd": 3}),
            json!({"id": 1, "op": "exec", "cmd": "echo x", "timeoutMs": -1}),
            json!({"id": 1, "op": "exec", "cmd": "echo x", "stdin": 3}),
            json!({"id": 1, "op": "pty.resize", "ptyId": "pty_1", "cols": "wide"}),
            json!({"id": 1, "op": "pty.resize", "ptyId": "pty_1", "cols": 0, "rows": 24}),
            json!({"id": 1, "op": "pty.create", "cols": 80, "rows": 0}),
        ] {
            let out = reply(&b, &c, frame.clone()).await;
            assert_eq!((out["ok"].as_bool(), out["code"].as_str()), (Some(false), Some("bad-request")), "{frame}");
        }
        assert_eq!(
            reply(&b, &c, json!({"id": 2, "op": "pty.write", "ptyId": "pty_9", "data": "x"})).await,
            json!({"id": 2, "ok": false, "error": "no such pty: pty_9"})
        );
        assert_eq!(reply(&b, &c, json!({"id": 3, "op": "pty.attach", "ptyId": "pty_9"})).await["error"], "no such pty: pty_9");
        assert_eq!(reply(&b, &c, json!({"id": 4, "op": "pty.kill", "ptyId": "pty_9"})).await["error"], "no such pty: pty_9");
        assert_eq!(reply(&b, &c, json!({"id": 5, "op": "pty.list"})).await, json!({"id": 5, "ok": true, "ptys": []}));
    }

    #[tokio::test]
    async fn a_frame_the_protocol_refuses_is_a_bad_request_and_a_coded_refusal_carries_its_code() {
        let b = bench();
        let (c, _rx) = conn(None);
        for frame in [
            json!({"id": 1, "op": "fs.list", "path": 7}),
            json!({"id": 1, "op": "fs.list"}),
            json!({"id": 1, "op": "fs.read", "path": "x", "encoding": "hex"}),
            json!({"id": 1, "op": "git.status"}),
            json!({"id": 1, "op": "git.diff", "cwd": ".", "scope": "all"}),
            json!({"id": 1, "op": "git.diff", "cwd": "."}),
            json!({"id": 1, "op": "git.diff", "cwd": ".", "scope": "staged", "path": 3}),
            json!({"id": 1, "op": "tunnel.open", "tunnelId": "x", "port": 0}),
            json!({"id": 1, "op": "tunnel.open", "tunnelId": "x", "port": 70000}),
            json!({"id": 1, "op": "tunnel.open", "port": 8080}),
            json!({"id": 1, "op": "tunnel.write", "tunnelId": "x"}),
            json!({"id": 1, "op": "manifest.record", "cwd": "/root"}),
            json!({"id": 1, "op": "manifest.record", "cmd": "x", "cwd": "/root", "port": "80"}),
        ] {
            let out = reply(&b, &c, frame.clone()).await;
            assert_eq!((out["ok"].as_bool(), out["code"].as_str()), (Some(false), Some("bad-request")), "{frame}");
        }
        let missing = b.root.path().join("none.txt");
        assert_eq!(
            reply(&b, &c, json!({"id": 2, "op": "fs.read", "path": "none.txt"})).await,
            json!({"id": 2, "ok": false, "code": "not-found", "error": "none.txt does not exist"})
        );
        assert_eq!(reply(&b, &c, json!({"id": 3, "op": "fs.list", "path": missing})).await["code"], "not-found");
        assert_eq!(
            reply(&b, &c, json!({"id": 4, "op": "git.status", "cwd": "/etc"})).await,
            json!({"id": 4, "ok": false, "code": "outside-root", "error": "/etc resolves outside the workspace root"})
        );
        let listed = reply(&b, &c, json!({"id": 5, "op": "fs.list", "path": "."})).await;
        assert_eq!(listed, json!({"id": 5, "ok": true, "entries": [], "truncated": false, "total": 0}));
        assert_eq!(
            reply(&b, &c, json!({"id": 6, "op": "tunnel.write", "tunnelId": "nobody", "data": ""})).await,
            json!({"id": 6, "ok": false, "code": "not-found", "error": "no such tunnel: nobody"})
        );
    }

    #[tokio::test]
    async fn the_manifest_round_trips_and_the_inbox_names_a_directory_it_cannot_read() {
        let b = bench();
        let (c, _rx) = conn(None);
        let recorded = reply(&b, &c, json!({"id": 1, "op": "manifest.record", "cmd": "pnpm dev", "cwd": "/root/app", "port": 5173})).await;
        assert_eq!(recorded["ok"], true);
        assert_eq!(recorded["entry"]["id"], "proc_1");
        assert_eq!((recorded["entry"]["cmd"].as_str(), recorded["entry"]["port"].as_u64()), (Some("pnpm dev"), Some(5173)));
        let listed = reply(&b, &c, json!({"id": 2, "op": "manifest.get"})).await;
        assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
        let script = reply(&b, &c, json!({"id": 3, "op": "manifest.restartScript"})).await;
        assert!(script["script"].as_str().unwrap().contains("port_listening '1435'"));
        assert!(b.root.path().join("manifest.json").exists());

        let mut options = Options::new(b._token.path());
        options.inbox_dir = Some(b.root.path().join("no-inbox"));
        options.manifest_path = Some(b.root.path().join("m2.json"));
        let without = Bench {
            ctx: Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap()),
            _token: tempfile::NamedTempFile::new().unwrap(),
            root: tempfile::tempdir().unwrap(),
        };
        let refused = reply(&without, &c, json!({"id": 4, "op": "inbox.watch"})).await;
        assert_eq!(refused["ok"], false);
        assert!(refused["error"].as_str().unwrap().contains("No such file"), "{refused}");
    }

    #[test]
    fn what_an_op_registers_after_its_socket_closed_is_undone_at_once() {
        let (c, _rx) = conn(None);
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!c.is_closed());
        c.close();
        assert!(c.is_closed());
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
        let late = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&late);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(late.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn tunnel_bytes_are_read_as_nodes_buffer_reads_base64() {
        assert_eq!(lenient_base64("aGVsbG8="), b"hello");
        assert_eq!(lenient_base64("aGVsbG8"), b"hello");
        assert_eq!(lenient_base64("aGVs\nbG8="), b"hello");
        assert_eq!(lenient_base64(""), b"");
    }

    #[test]
    fn what_an_attach_registers_after_its_socket_closed_is_undone_at_once() {
        let (c, _rx) = conn(None);
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        c.close();
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
        let late = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&late);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(late.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn stdin_is_read_as_nodes_buffer_reads_base64() {
        assert_eq!(lenient_base64("aGVsbG8="), b"hello");
        assert_eq!(lenient_base64("aGVsbG8"), b"hello");
        assert_eq!(lenient_base64("aGVs\nbG8="), b"hello");
        assert_eq!(lenient_base64(""), b"");
    }
}
