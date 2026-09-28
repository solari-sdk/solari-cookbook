// SPDX-License-Identifier: AGPL-3.0-only
//! The ptys, opened through portable-pty and never a forkpty of our own. Each shell runs behind the work-score line
//! and is exec'd into, so the pid the pty reports is the shell's; each pty has a thread reading its master, a thread
//! writing to it and a thread waiting on the child, so nothing a shell does can stall the one runtime thread.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, oneshot};
use wsp_frames::{numbers, DaemonEvent, PtyListEntry, RelayPort};

use crate::urls::{settled_callback_ports, settled_local_ports, TerminalUrlScanner};
use crate::{frame_text, Ctx, Listener};

pub(crate) type Env = BTreeMap<String, String>;

/// A pty thread holds a read buffer on the heap and a channel end; it needs little stack.
const PTY_THREAD_STACK: usize = 128 * 1024;
const READ_BUF_BYTES: usize = 8 * 1024;
/// Chunks the reader may queue ahead of the pump; past it the reader blocks, the pty's buffer fills and the next
/// read returns more bytes at once. Unbounded, a shell running yes grew the daemon 4.5 MB a second and a 2 MB burst
/// took 80 s to reach the socket (measured); at sixteen the daemon stays flat and the frames coalesce as node's do.
const PTY_QUEUE_CHUNKS: usize = 16;
/// How long the exit waits for the master's last bytes once the child is reaped: node-pty's own grace, since a
/// data event sometimes lands after the wait returns.
const EXIT_DRAIN: Duration = Duration::from_millis(200);

/// The passwd row of the daemon's own uid; nothing for a uid without one (an arbitrary uid in a container).
pub(crate) struct PasswdRow {
    pub(crate) homedir: String,
    pub(crate) username: String,
    pub(crate) shell: Option<String>,
}

pub(crate) fn passwd_row() -> Option<PasswdRow> {
    let user = nix::unistd::User::from_uid(nix::unistd::getuid()).ok().flatten()?;
    let shell = user.shell.to_string_lossy().into_owned();
    Some(PasswdRow { homedir: user.dir.to_string_lossy().into_owned(), username: user.name, shell: (!shell.is_empty()).then_some(shell) })
}

/// The daemon's own environment, which every pty starts from.
pub(crate) fn process_env() -> Env {
    std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}

/// The image ships DISPLAY=:0 with no X server behind it, which gcloud, gemini and railway read as "a browser
/// exists" and skip their paste-code paths; the shim as BROWSER is what makes a sign-in land in the laptop's
/// browser. A caller that names a DISPLAY keeps the one it named. HOME and USER come off the passwd row of the
/// daemon's own uid when the daemon was started without them (a guest daemon inherited PATH and nothing else,
/// measured 2026-09-05): git, Go and every rc file read them.
pub(crate) fn pty_env(base: &Env, extra: Option<&Env>, me: Option<&PasswdRow>) -> Env {
    let mut env = base.clone();
    if let Some(extra) = extra {
        env.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    if extra.is_none_or(|e| !e.contains_key("DISPLAY")) {
        env.remove("DISPLAY");
    }
    env.entry("BROWSER".to_owned()).or_insert_with(|| numbers::OPEN_SHIM_PATH.to_owned());
    // A uid with no passwd row has no home to give; the shell still opens, without the blank ones.
    for (name, value) in [("HOME", me.map(|m| m.homedir.as_str())), ("USER", me.map(|m| m.username.as_str()))] {
        if env.get(name).is_some_and(|v| !v.is_empty()) {
            continue;
        }
        match value {
            Some(v) => {
                env.insert(name.to_owned(), v.to_owned());
            }
            None => {
                env.remove(name);
            }
        }
    }
    env
}

/// A command as the daemon launches it: behind the work-score line and exec'd into, so the pid stays the command's
/// own and its argv passes through sh untouched.
pub(crate) fn work_argv(file: &str, args: &[&str]) -> (String, Vec<String>) {
    let mut argv = vec!["-c".to_owned(), format!("{}; exec \"$0\" \"$@\"", numbers::work_score_line()), file.to_owned()];
    argv.extend(args.iter().map(|a| (*a).to_owned()));
    ("/bin/sh".to_owned(), argv)
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct PtyCreateOpts {
    pub(crate) cols: Option<u16>,
    pub(crate) rows: Option<u16>,
    pub(crate) shell: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) env: Option<Env>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct PtyLaunch {
    pub(crate) file: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Env,
}

/// A shell the request names runs as asked. With none named, the pty is the person's terminal: it runs the passwd
/// row's shell as a login shell, so profile.d applies, and SHELL names that shell for what it spawns, as login(1)
/// would set it. The daemon's own SHELL never decides: a guest daemon is started without one so a chsh on the
/// machine is what the next terminal runs. A row without a shell, or no row, gets bash.
pub(crate) fn pty_launch(opts: &PtyCreateOpts, base: &Env, me: Option<&PasswdRow>) -> PtyLaunch {
    let mut env = pty_env(base, opts.env.as_ref(), me);
    if let Some(shell) = &opts.shell {
        let (file, args) = work_argv(shell, &[]);
        return PtyLaunch { file, args, env };
    }
    let shell = me.and_then(|m| m.shell.as_deref());
    if let Some(shell) = shell {
        if opts.env.as_ref().is_none_or(|e| !e.contains_key("SHELL")) {
            env.insert("SHELL".to_owned(), shell.to_owned());
        }
    }
    let (file, args) = work_argv(shell.unwrap_or("bash"), &["-l"]);
    PtyLaunch { file, args, env }
}

/// HOME as the daemon has it, else the passwd row's: where a pty opens when the request names no cwd.
fn home_dir(base: &Env, me: Option<&PasswdRow>) -> io::Result<String> {
    base.get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .or_else(|| me.map(|m| m.homedir.clone()))
        .ok_or_else(|| io::Error::other("no home directory for this uid"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Exit {
    pub(crate) code: i32,
    pub(crate) signal: Option<i32>,
}

/// As node-pty reads a wait status: the code of a process that exited, the signal of one that was killed.
fn exit_of(status: std::process::ExitStatus) -> Exit {
    match status.code() {
        Some(code) => Exit { code, signal: None },
        None => Exit { code: 0, signal: status.signal() },
    }
}

/// What the pump drives for one pty: bytes off the master and the exit off the wait thread.
pub(crate) struct Spawned {
    pub(crate) id: String,
    pub(crate) pid: u32,
    data: mpsc::Receiver<Vec<u8>>,
    exit: oneshot::Receiver<Exit>,
}

/// What a late attach replays: the last chunks under the cap, oldest dropped whole, a lone chunk cut to its tail.
#[derive(Default)]
struct Scrollback {
    chunks: VecDeque<String>,
    bytes: usize,
}

impl Scrollback {
    fn push(&mut self, data: &str) {
        self.chunks.push_back(data.to_owned());
        self.bytes += data.len();
        while self.bytes > numbers::SCROLLBACK_CAP_BYTES && self.chunks.len() > 1 {
            if let Some(dropped) = self.chunks.pop_front() {
                self.bytes -= dropped.len();
            }
        }
        if self.bytes > numbers::SCROLLBACK_CAP_BYTES {
            if let Some(head) = self.chunks.front_mut() {
                let mut start = head.len() - numbers::SCROLLBACK_CAP_BYTES;
                while !head.is_char_boundary(start) {
                    start += 1;
                }
                *head = head[start..].to_owned();
                self.bytes = head.len();
            }
        }
    }

    fn replay(&self) -> Option<String> {
        (self.bytes > 0).then(|| self.chunks.iter().map(String::as_str).collect())
    }
}

/// What holds one pty open, and so how it is resized and ended. A pty of this computer's own is a master this
/// process holds, with a child to kill; one inside a workspace this computer runs is a broker behind an exec's
/// pipes, resized by the size road the runtime hands back and ended by ending that broker. The two differ in
/// nothing else: the same scrollback, the same listeners, the same frames.
enum Held {
    Here {
        master: Box<dyn MasterPty + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
    },
    #[cfg(target_os = "linux")]
    Inside(wsp_runtime::runtime::PtyInsideSize),
}

/// What a person types, on its way to the pty: a thread's feed for a master this process holds, a task's for a
/// broker inside a workspace. Both take a chunk from whichever socket wrote it, without waiting.
enum Typed {
    Here(std_mpsc::Sender<Vec<u8>>),
    Inside(mpsc::UnboundedSender<Vec<u8>>),
}

impl Typed {
    fn send(&self, bytes: Vec<u8>) {
        match self {
            Typed::Here(feed) => {
                let _ = feed.send(bytes);
            }
            Typed::Inside(feed) => {
                let _ = feed.send(bytes);
            }
        }
    }
}

pub(crate) struct Session {
    pub(crate) id: String,
    pub(crate) pid: u32,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) exited: Option<Exit>,
    /// The workspace this pty was opened inside, on a daemon that runs workspaces; none for this computer's own.
    /// Every op on it names the same workspace, and one that names another is told there is no such pty.
    pub(crate) machine: Option<String>,
    scrollback: Scrollback,
    listeners: Vec<Listener>,
    exit_listeners: Vec<Listener>,
    /// The way in and the way it is held: both go with the exit, so an exited pty holds its scrollback and
    /// nothing else until pty.kill, as node-pty closes its master 200 ms after the exit.
    input: Option<Typed>,
    held: Option<Held>,
}

fn pty_thread<F: FnOnce() + Send + 'static>(name: &str, f: F) -> io::Result<()> {
    thread::Builder::new().name(name.to_owned()).stack_size(PTY_THREAD_STACK).spawn(f).map(|_| ())
}

impl Session {
    fn spawn(id: String, opts: &PtyCreateOpts, base: &Env, me: Option<&PasswdRow>) -> io::Result<(Session, Spawned)> {
        let cols = opts.cols.unwrap_or(80);
        let rows = opts.rows.unwrap_or(24);
        let launch = pty_launch(opts, base, me);
        let cwd = match &opts.cwd {
            Some(cwd) => cwd.clone(),
            None => home_dir(base, me)?,
        };
        // portable-pty would fall back to HOME without a word; node's shell exits 1 on the chdir instead.
        if !Path::new(&cwd).is_dir() {
            return Err(io::Error::other(format!("cwd is not a directory: {cwd}")));
        }
        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(io::Error::other)?;
        let mut cmd = CommandBuilder::new(&launch.file);
        cmd.args(&launch.args);
        cmd.env_clear();
        for (k, v) in &launch.env {
            cmd.env(k, v);
        }
        // node-pty names the terminal and the directory in every shell's environment; the same two here.
        cmd.env("TERM", "xterm-256color");
        cmd.env("PWD", &cwd);
        cmd.cwd(&cwd);
        let child = pair.slave.spawn_command(cmd).map_err(io::Error::other)?;
        // The parent's slave goes at once, so the child's exit is the master's end of file.
        drop(pair.slave);
        let killer = child.clone_killer();
        let pid = child.process_id().unwrap_or(0);
        let mut reader = pair.master.try_clone_reader().map_err(io::Error::other)?;
        let mut writer = pair.master.take_writer().map_err(io::Error::other)?;

        let (data_tx, data) = mpsc::channel::<Vec<u8>>(PTY_QUEUE_CHUNKS);
        pty_thread(&format!("pty-r-{pid}"), move || {
            let mut buf = vec![0u8; READ_BUF_BYTES];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if data_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })?;
        let (input, input_rx) = std_mpsc::channel::<Vec<u8>>();
        pty_thread(&format!("pty-w-{pid}"), move || {
            for bytes in input_rx {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
            }
        })?;
        let (exit_tx, exit) = oneshot::channel::<Exit>();
        let child: Box<dyn portable_pty::Child> = child;
        pty_thread(&format!("pty-e-{pid}"), move || {
            let exit = match child.downcast::<std::process::Child>() {
                Ok(mut child) => child.wait().map(exit_of),
                Err(mut other) => other.wait().map(|s| Exit { code: s.exit_code() as i32, signal: None }),
            };
            let _ = exit_tx.send(exit.unwrap_or(Exit { code: 1, signal: None }));
        })?;

        let session = Session {
            id: id.clone(),
            pid,
            cols,
            rows,
            exited: None,
            machine: None,
            scrollback: Scrollback::default(),
            listeners: Vec::new(),
            exit_listeners: Vec::new(),
            input: Some(Typed::Here(input)),
            held: Some(Held::Here { master: pair.master, killer }),
        };
        Ok((session, Spawned { id, pid, data, exit }))
    }

    /// Replays the scrollback held so far as one frame, then streams what comes next. A socket already listening
    /// to this pty is replaced rather than added to: on a road where every pane of a computer rides one socket, a
    /// reload of the app or a second window attaching the same pty would otherwise print every byte twice.
    pub(crate) fn attach(&mut self, listener: Listener) {
        if let Some(data) = self.scrollback.replay() {
            listener.out.send_event(&DaemonEvent::PtyData { pty_id: self.id.clone(), data });
        }
        self.listeners.retain(|l| l.key != listener.key);
        self.listeners.push(listener);
    }

    /// Tells the listener at once when the pty is already gone, and again is never needed.
    pub(crate) fn on_exit(&mut self, listener: Listener) {
        if let Some(exit) = self.exited {
            listener.out.send_event(&exit_event(&self.id, exit));
        }
        self.exit_listeners.retain(|l| l.key != listener.key);
        self.exit_listeners.push(listener);
    }

    pub(crate) fn detach(&mut self, key: u64) {
        self.listeners.retain(|l| l.key != key);
        self.exit_listeners.retain(|l| l.key != key);
    }

    pub(crate) fn write(&self, data: &str) {
        if let Some(input) = &self.input {
            input.send(data.as_bytes().to_vec());
        }
    }

    pub(crate) fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        let held = self.held.as_ref().ok_or_else(|| io::Error::other(format!("{} has exited", self.id)))?;
        match held {
            Held::Here { master, .. } => {
                master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(io::Error::other)?
            }
            #[cfg(target_os = "linux")]
            Held::Inside(size) => size.resize(cols, rows).map_err(io::Error::other)?,
        }
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    fn kill(&mut self) {
        self.listeners.clear();
        match &mut self.held {
            Some(Held::Here { killer, .. }) => {
                let _ = killer.kill();
            }
            // The broker inside holds the master, so ending it closes that terminal and the kernel hangs the
            // shell on it up, as it does for a person's terminal that goes.
            #[cfg(target_os = "linux")]
            Some(Held::Inside(size)) => {
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(size.pid() as i32), nix::sys::signal::Signal::SIGKILL);
            }
            None => {}
        }
    }

    fn deliver(&mut self, data: &str) {
        self.scrollback.push(data);
        let frame = frame_text(&DaemonEvent::PtyData { pty_id: self.id.clone(), data: data.to_owned() });
        self.listeners.retain(|l| l.out.send_text(&frame));
    }
}

/// One pty inside a workspace this computer runs, held beside the daemon's own: the broker's pipes become the
/// same two channels a master's threads feed, so everything past this point, the scrollback, the listeners, the
/// mode watcher and the frames, is the one road for both kinds of pty.
#[cfg(target_os = "linux")]
fn spawn_inside(
    id: String,
    machine: &str,
    cols: u16,
    rows: u16,
    mut running: wsp_runtime::runtime::PtyInsideRunning,
) -> (Session, Spawned) {
    let pid = running.pid();
    let pipes = running.pipes();
    let (helper, size) = running.apart();
    let (data_tx, data) = mpsc::channel::<Vec<u8>>(PTY_QUEUE_CHUNKS);
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if let Some((mut to_shell, mut from_shell)) = pipes {
        tokio::spawn(async move {
            let mut buf = vec![0u8; READ_BUF_BYTES];
            while let Ok(n) = tokio::io::AsyncReadExt::read(&mut from_shell, &mut buf).await {
                if n == 0 || data_tx.send(buf[..n].to_vec()).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(bytes) = input_rx.recv().await {
                if tokio::io::AsyncWriteExt::write_all(&mut to_shell, &bytes).await.is_err() {
                    break;
                }
                let _ = tokio::io::AsyncWriteExt::flush(&mut to_shell).await;
            }
        });
    }
    let (exit_tx, exit) = oneshot::channel::<Exit>();
    let mut helper = helper;
    tokio::spawn(async move {
        let ended = helper.wait().await;
        let exit = match ended {
            Ok(status) => Exit { code: status.code().unwrap_or(1), signal: None },
            Err(_) => Exit { code: 1, signal: None },
        };
        let _ = exit_tx.send(exit);
    });
    let session = Session {
        id: id.clone(),
        pid,
        cols,
        rows,
        exited: None,
        machine: Some(machine.to_owned()),
        scrollback: Scrollback::default(),
        listeners: Vec::new(),
        exit_listeners: Vec::new(),
        input: Some(Typed::Inside(input_tx)),
        held: Some(Held::Inside(size)),
    };
    (session, Spawned { id, pid, data, exit })
}

fn exit_event(pty_id: &str, exit: Exit) -> DaemonEvent {
    DaemonEvent::PtyExit { pty_id: pty_id.to_owned(), exit_code: exit.code, signal: exit.signal }
}

#[derive(Default)]
pub(crate) struct PtyManager {
    sessions: HashMap<String, Session>,
    next_id: u64,
}

impl PtyManager {
    pub(crate) fn create(&mut self, opts: &PtyCreateOpts, base: &Env, me: Option<&PasswdRow>) -> io::Result<Spawned> {
        self.next_id += 1;
        let id = format!("pty_{}", self.next_id);
        let (session, spawned) = Session::spawn(id.clone(), opts, base, me)?;
        self.sessions.insert(id, session);
        Ok(spawned)
    }

    /// One pty inside a workspace this computer runs, taken over from the runtime and held beside the rest.
    #[cfg(target_os = "linux")]
    pub(crate) fn take_inside(&mut self, machine: &str, cols: u16, rows: u16, running: wsp_runtime::runtime::PtyInsideRunning) -> Spawned {
        self.next_id += 1;
        let id = format!("pty_{}", self.next_id);
        let (session, spawned) = spawn_inside(id.clone(), machine, cols, rows, running);
        self.sessions.insert(id, session);
        spawned
    }

    pub(crate) fn get_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.get_mut(id)
    }

    /// The pty by that name where it belongs to the machine the frame named: this computer's own where the frame
    /// named none, and one workspace's where it named that workspace. A pty of another is no pty to this caller,
    /// so no pane reaches a shell of a workspace it is not looking at, or of the computer itself.
    pub(crate) fn of(&mut self, id: &str, machine: Option<&str>) -> Option<&mut Session> {
        self.sessions.get_mut(id).filter(|held| held.machine.as_deref() == machine)
    }

    /// The ptys of the machine the frame named, and no other's: with a workspace named, that workspace's alone;
    /// without one, this daemon's own alone.
    pub(crate) fn list(&self, machine: Option<&str>) -> Vec<PtyListEntry> {
        let mut entries: Vec<&Session> = self.sessions.values().filter(|s| s.machine.as_deref() == machine).collect();
        entries.sort_by_key(|s| s.id.trim_start_matches("pty_").parse::<u64>().unwrap_or(0));
        entries
            .into_iter()
            .map(|s| PtyListEntry { id: s.id.clone(), pid: s.pid, cols: s.cols, rows: s.rows, exited: s.exited.is_some() })
            .collect()
    }

    /// The pid and the name of every pty still running, whichever machine it belongs to: what labels a row of
    /// this computer's own process list, since a pty inside a workspace is held here by a process on this
    /// computer too, the broker that opened it.
    pub(crate) fn labels(&self) -> Vec<(u32, String)> {
        self.sessions.values().filter(|s| s.exited.is_none()).map(|s| (s.pid, s.id.clone())).collect()
    }

    pub(crate) fn destroy(&mut self, id: &str) {
        if let Some(mut session) = self.sessions.remove(id) {
            session.kill();
        }
    }
}

/// Bytes off the master as text: a multibyte character cut by a read waits for the rest.
fn decode(carry: &mut Vec<u8>, bytes: Vec<u8>) -> String {
    let all = if carry.is_empty() {
        bytes
    } else {
        let mut all = std::mem::take(carry);
        all.extend(bytes);
        all
    };
    match std::str::from_utf8(&all) {
        Ok(s) => s.to_owned(),
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            *carry = all[valid..].to_vec();
            String::from_utf8_lossy(&all[..valid]).into_owned()
        }
        Err(_) => String::from_utf8_lossy(&all).into_owned(),
    }
}

/// One task per pty: the bytes to the scrollback, the attached sockets and the two URL scanners; then the exit,
/// after the master's last bytes or node-pty's grace, whichever is first. The queue is bounded, so what the grace
/// has to drain is at most the bound plus what the pty's own buffer still holds.
pub(crate) async fn pump(ctx: Arc<Ctx>, spawned: Spawned) {
    let Spawned { id, mut data, mut exit, .. } = spawned;
    let mut carry = Vec::new();
    let mut callback = TerminalUrlScanner::new(settled_callback_ports);
    let mut local = TerminalUrlScanner::new(settled_local_ports);
    let mut deliver = |bytes: Vec<u8>| {
        let text = decode(&mut carry, bytes);
        if text.is_empty() {
            return;
        }
        let (cols, machine) = {
            let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
            let Some(session) = ptys.get_mut(&id) else { return };
            session.deliver(&text);
            (usize::from(session.cols), session.machine.clone())
        };
        // A shell printing inside a workspace is that workspace working, as bytes through a published port are:
        // a person with a pane open and a build running in it is using it, and what is left printing with nobody
        // reading is theirs to close.
        if let Some(machine) = &machine {
            ctx.workspace_touched(machine);
        }
        for port in callback.feed(&text, Some(cols)).into_iter().filter_map(RelayPort::new) {
            ctx.broadcast(&DaemonEvent::CallbackPort { port });
        }
        for port in local.feed(&text, Some(cols)).into_iter().filter_map(RelayPort::new) {
            ctx.broadcast(&DaemonEvent::LocalhostUrl { port });
        }
    };
    let exit = loop {
        tokio::select! {
            chunk = data.recv() => match chunk {
                Some(bytes) => deliver(bytes),
                None => break (&mut exit).await.unwrap_or(Exit { code: 1, signal: None }),
            },
            status = &mut exit => {
                let drain = async {
                    while let Some(bytes) = data.recv().await {
                        deliver(bytes);
                    }
                };
                let _ = tokio::time::timeout(EXIT_DRAIN, drain).await;
                break status.unwrap_or(Exit { code: 1, signal: None });
            }
        }
    };
    ctx.modes.remove(&id);
    let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = ptys.get_mut(&id) {
        session.exited = Some(exit);
        session.input = None;
        session.held = None;
        let frame = frame_text(&exit_event(&id, exit));
        session.exit_listeners.retain(|l| l.out.send_text(&frame));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    fn me() -> PasswdRow {
        PasswdRow { homedir: "/root".to_owned(), username: "root".to_owned(), shell: Some("/usr/bin/zsh".to_owned()) }
    }

    fn wrap() -> String {
        format!("{}; exec \"$0\" \"$@\"", numbers::work_score_line())
    }

    #[test]
    fn fills_home_and_user_from_the_passwd_row_when_the_daemon_was_started_without_them() {
        let out = pty_env(&env(&[("USER", ""), ("DISPLAY", ":0")]), None, Some(&me()));
        assert_eq!(out.get("HOME").map(String::as_str), Some("/root"));
        assert_eq!(out.get("USER").map(String::as_str), Some("root"));
        assert!(!out.contains_key("DISPLAY"));
    }

    #[test]
    fn keeps_the_home_and_user_it_inherited_and_lets_a_callers_env_win_over_both() {
        let base = env(&[("HOME", "/srv/elsewhere"), ("USER", "someone")]);
        let out = pty_env(&base, None, Some(&me()));
        assert_eq!((out["HOME"].as_str(), out["USER"].as_str()), ("/srv/elsewhere", "someone"));
        let out = pty_env(&base, Some(&env(&[("HOME", "/tmp/h"), ("USER", "u")])), Some(&me()));
        assert_eq!((out["HOME"].as_str(), out["USER"].as_str()), ("/tmp/h", "u"));
    }

    #[test]
    fn what_the_daemon_was_started_with_reaches_every_pty() {
        let out = pty_env(&env(&[("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", ".preview.example.com")]), None, Some(&me()));
        assert_eq!(out["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"], ".preview.example.com");
    }

    #[test]
    fn drops_the_images_display_and_points_browser_at_the_shim_unless_the_caller_set_one() {
        let base = env(&[("DISPLAY", ":0")]);
        let out = pty_env(&base, Some(&env(&[("TERM", "xterm")])), Some(&me()));
        assert!(!out.contains_key("DISPLAY"));
        assert_eq!(out["BROWSER"], numbers::OPEN_SHIM_PATH);
        assert_eq!(out["TERM"], "xterm");
        assert_eq!(pty_env(&base, Some(&env(&[("BROWSER", "true")])), Some(&me()))["BROWSER"], "true");
        // A caller that names a DISPLAY keeps it: a sign-in whose page must return to this machine wants the browser road.
        assert_eq!(pty_env(&base, Some(&env(&[("DISPLAY", ":0")])), Some(&me()))["DISPLAY"], ":0");
    }

    #[test]
    fn on_a_uid_without_a_passwd_row_home_and_user_stay_unset_instead_of_failing_the_pty() {
        let out = pty_env(&env(&[("USER", "")]), None, None);
        assert!(!out.contains_key("HOME"));
        assert!(!out.contains_key("USER"));
        assert_eq!(out["BROWSER"], "/usr/local/bin/wsp-open");
    }

    #[test]
    fn on_a_uid_without_a_passwd_row_what_the_daemon_inherited_is_kept_since_the_lookup_only_runs_for_a_blank() {
        let out = pty_env(&env(&[("HOME", "/srv/elsewhere"), ("USER", "someone")]), None, None);
        assert_eq!((out["HOME"].as_str(), out["USER"].as_str()), ("/srv/elsewhere", "someone"));
    }

    #[test]
    fn on_a_uid_without_a_passwd_row_the_pty_falls_back_to_bash_still_a_login_shell() {
        let launch = pty_launch(&PtyCreateOpts::default(), &env(&[]), None);
        assert_eq!(&launch.args[launch.args.len() - 2..], ["bash", "-l"]);
        assert!(!launch.env.contains_key("SHELL"));
    }

    #[test]
    fn on_a_uid_without_a_passwd_row_with_home_inherited_and_user_blank_the_failed_lookup_drops_only_user() {
        let out = pty_env(&env(&[("HOME", "/root")]), None, None);
        assert_eq!(out["HOME"], "/root");
        assert!(!out.contains_key("USER"));
        let out = pty_env(&env(&[("HOME", "/root"), ("USER", "")]), None, None);
        assert_eq!(out["HOME"], "/root");
        assert!(!out.contains_key("USER"));
    }

    #[test]
    fn with_no_shell_named_runs_the_passwd_rows_shell_as_a_login_shell_and_shell_names_it() {
        let launch = pty_launch(&PtyCreateOpts::default(), &env(&[("SHELL", "/bin/bash")]), Some(&me()));
        assert_eq!(launch.file, "/bin/sh");
        assert_eq!(launch.args, ["-c", &wrap(), "/usr/bin/zsh", "-l"]);
        assert_eq!(launch.env["SHELL"], "/usr/bin/zsh");
    }

    #[test]
    fn a_row_that_names_no_shell_falls_back_to_bash_as_a_login_shell_and_leaves_shell_alone() {
        let row = PasswdRow { shell: None, ..me() };
        let launch = pty_launch(&PtyCreateOpts::default(), &env(&[]), Some(&row));
        assert_eq!(launch.args, ["-c", &wrap(), "bash", "-l"]);
        assert!(!launch.env.contains_key("SHELL"));
    }

    #[test]
    fn a_shell_the_request_names_runs_as_asked_not_as_a_login_shell_with_shell_as_inherited() {
        let opts = PtyCreateOpts { shell: Some("/bin/dash".to_owned()), env: Some(env(&[("PS1", "")])), ..Default::default() };
        let launch = pty_launch(&opts, &env(&[("SHELL", "/inherited/sh")]), Some(&me()));
        assert_eq!(launch.args, ["-c", &wrap(), "/bin/dash"]);
        assert_eq!((launch.env["SHELL"].as_str(), launch.env["PS1"].as_str()), ("/inherited/sh", ""));
    }

    #[test]
    fn a_shell_the_requests_own_env_names_wins_over_the_passwd_row() {
        let opts = PtyCreateOpts { env: Some(env(&[("SHELL", "/opt/fish")])), ..Default::default() };
        assert_eq!(pty_launch(&opts, &env(&[]), Some(&me())).env["SHELL"], "/opt/fish");
    }

    #[test]
    fn the_scrollback_drops_whole_old_chunks_past_the_cap_and_cuts_a_lone_chunk_to_its_tail() {
        let cap = numbers::SCROLLBACK_CAP_BYTES;
        let mut sb = Scrollback::default();
        assert_eq!(sb.replay(), None);
        sb.push(&"x".repeat(cap - 10));
        sb.push(&"y".repeat(20));
        sb.push(&"z".repeat(5));
        assert_eq!(sb.replay().unwrap(), format!("{}{}", "y".repeat(20), "z".repeat(5)));
        let mut lone = Scrollback::default();
        lone.push(&format!("é{}", "a".repeat(cap)));
        assert_eq!(lone.replay().unwrap(), "a".repeat(cap));
    }

    #[test]
    fn a_multibyte_character_cut_by_a_read_waits_for_the_rest() {
        let mut carry = Vec::new();
        let bytes = "héllo".as_bytes();
        assert_eq!(decode(&mut carry, bytes[..2].to_vec()), "h");
        assert_eq!(carry, &bytes[1..2]);
        assert_eq!(decode(&mut carry, bytes[2..].to_vec()), "éllo");
        assert!(carry.is_empty());
    }
}
