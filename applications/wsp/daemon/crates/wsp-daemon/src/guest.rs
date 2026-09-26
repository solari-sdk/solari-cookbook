// SPDX-License-Identifier: AGPL-3.0-only
//! The guest relay: a process inside this machine opens a session on its own daemon, and the daemon carries that
//! session up the socket the host already holds to it. Nothing here reads the token a session carries or the
//! messages that ride it; the host is what reads both. The whole of the daemon's part is routing frames between one
//! guest socket and the socket that asked to watch.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use wsp_frames::{numbers, words, DaemonErrorCode, DaemonEvent, GuestOpen};

use crate::ops::Conn;
use crate::paths::OpError;
use crate::{Outbound, Outgoing};

/// One open session: the guest socket it belongs to, and the frames it holds while no watcher is attached.
struct Session {
    key: u64,
    out: Outbound,
    /// The workspace the socket that opened it is inside, on a daemon that runs workspaces; none on a daemon
    /// inside a machine. Every frame of this session carries it, so the host reads a session's workspace off the
    /// listener it arrived on and never off anything the guest said.
    machine: Option<String>,
    /// The order sessions were opened in, so a flush hands a watcher the sessions as they came.
    at: u64,
    /// The frame this session opened with, kept rather than queued: every watcher that arrives is told the sessions
    /// this machine holds, and a host that restarted holds no row for one its machine still carries.
    opened: DaemonEvent,
    /// The frames held for the watcher that arrives next, each carrying the bytes it holds against its workspace:
    /// a session dropped with frames still in it gives those bytes back with them.
    queued: Vec<Outgoing>,
    /// The guest's end is gone and its close is the last thing queued: the row stands only until a watcher has been
    /// handed that frame, so a host arriving after the fact still hears the session end rather than holding its own
    /// row and its socket for the life of the machine.
    ended: bool,
    /// Since when nobody has watched this session; none while a watcher is attached. Past the span it ends to its
    /// guest, so a process inside the machine waiting on an answer is told rather than left waiting.
    unwatched_since: Option<Instant>,
}

#[derive(Default)]
struct State {
    /// Every socket that asked to watch, most recent last: frames go to the last, and a socket that has watched at
    /// all may answer. A short-lived link of the host's takes the pushes while it is up and hands them back when it
    /// goes, so a reach opened for one question does not leave the sessions of a longer one with no reader.
    watchers: Vec<(u64, Outbound)>,
    sessions: HashMap<String, Session>,
    /// A sweep is already waiting on the nearest session to fall past the span; one of them serves them all.
    sweeping: bool,
}

pub(crate) struct Guests {
    state: Mutex<State>,
    /// What every session on this daemon has waiting, by the workspace it belongs to.
    in_flight: Arc<InFlight>,
    ids: AtomicU64,
    /// What every session this run of the daemon opens is named by, beside its own name. Session names count from
    /// the start on every run, so a machine rebuilt under a host hands it names that host may still hold; the
    /// marker is what tells the two apart, and it travels in the opened frame the host picks its sessions up by.
    life: String,
    /// How long a session stands with nobody watching it before it ends to its guest.
    unwatched: Duration,
}

/// A marker for one run of this daemon. Random rather than counted or clocked: a machine rebuilt in the same
/// second is a different life and must read as one.
fn fresh_life() -> String {
    let mut bytes = [0u8; 8];
    // Without the system's randomness there is no marker, and the sessions of two runs would read as one.
    getrandom::fill(&mut bytes).expect("the system gives random bytes");
    format!("{:016x}", u64::from_le_bytes(bytes))
}

/// A holder that panicked leaves its state behind, which the next caller reads rather than panicking on in turn.
fn lock<T>(held: &Mutex<T>) -> MutexGuard<'_, T> {
    held.lock().unwrap_or_else(|e| e.into_inner())
}

fn no_such_session(session: &str) -> OpError {
    OpError::coded(DaemonErrorCode::NotFound, format!("no such guest session: {session}"))
}

impl State {
    fn watching(&self) -> Option<&Outbound> {
        self.watchers.last().map(|(_, out)| out)
    }

    /// The workspace a session belongs to, for the frames raised about it after it was opened.
    fn machine_of(&self, session: &str) -> Option<String> {
        self.sessions.get(session).and_then(|held| held.machine.clone())
    }

    /// Up to whoever is watching, or into the session's own queue; a queue past its cap ends the session, which is
    /// what a guest reads when the host has been away too long.
    fn upward(&mut self, session: &str, frame: Outgoing) -> Option<Outbound> {
        if let Some(out) = self.watching() {
            out.send(frame);
            return None;
        }
        let held = self.sessions.get_mut(session)?;
        if held.queued.len() >= numbers::GUEST_QUEUE_CAP_FRAMES {
            let gone = self.sessions.remove(session)?;
            return Some(gone.out);
        }
        held.queued.push(frame);
        None
    }
}

impl Guests {
    pub(crate) fn new(unwatched: Duration) -> Guests {
        Guests { state: Mutex::default(), in_flight: Arc::default(), ids: AtomicU64::new(0), life: fresh_life(), unwatched }
    }

    /// One session per socket: a second open on the same socket is the client's own mistake, not a second session.
    /// Past its workspace's cap no session is opened at all: the cap is read on the rows this daemon is holding
    /// for that workspace, before a name is taken or the socket is bound to one.
    pub(crate) fn open(self: &Arc<Self>, conn: &Conn, open: GuestOpen) -> Result<String, OpError> {
        let machine = conn.workspace();
        let mut state = lock(&self.state);
        // A session whose socket went and whose close is waiting for a watcher is still a row this daemon holds,
        // so it counts: what a workspace may fill is what the daemon carries for it.
        if state.sessions.values().filter(|held| held.machine == machine).count() >= numbers::GUEST_SESSIONS_PER_WORKSPACE_CAP {
            return Err(OpError::coded(DaemonErrorCode::BadRequest, words::GUEST_WORKSPACE_FULL));
        }
        let at = self.ids.fetch_add(1, Ordering::Relaxed);
        let session = format!("g{at}");
        conn.take_guest(session.clone())?;
        let opened = DaemonEvent::GuestOpened {
            session: session.clone(),
            machine_id: machine.clone(),
            life: self.life.clone(),
            kind: open.kind,
            token: open.token,
            turn_token: open.turn_token,
            argv: open.argv,
            cwd: open.cwd,
        };
        let unwatched_since = state.watching().is_none().then(Instant::now);
        let row = Session {
            key: conn.key,
            out: conn.out.clone(),
            machine,
            at,
            opened: opened.clone(),
            queued: Vec::new(),
            ended: false,
            unwatched_since,
        };
        state.sessions.insert(session.clone(), row);
        if let Some(out) = state.watching() {
            out.send_event(&opened);
        }
        drop(state);
        self.sweep();
        Ok(session)
    }

    /// One message up, where the session stands, the message is under the frame cap and its workspace has room
    /// under the bytes cap; every one of the three is read before a byte is taken or queued.
    pub(crate) fn send(&self, conn: &Conn, message: Value) -> Result<(), OpError> {
        let session = conn.guest_session().ok_or_else(|| OpError::coded(DaemonErrorCode::BadRequest, NO_SESSION))?;
        if message.to_string().len() > numbers::GUEST_MESSAGE_CAP_BYTES {
            return Err(OpError::coded(DaemonErrorCode::BadRequest, over_the_cap()));
        }
        let mut state = lock(&self.state);
        if !state.sessions.contains_key(&session) {
            return Err(no_such_session(&session));
        }
        let machine = state.machine_of(&session);
        let text = crate::frame_text(&DaemonEvent::GuestMessage { session: session.clone(), message, machine_id: machine.clone() });
        let Some(held) = self.in_flight.take(&machine, text.len()) else {
            return Err(OpError::coded(DaemonErrorCode::BadRequest, words::GUEST_IN_FLIGHT_FULL));
        };
        let full = state.upward(&session, Outgoing::Guest(text, held));
        drop(state);
        if let Some(out) = full {
            out.send_event(&DaemonEvent::GuestClosed { session, error: Some(words::GUEST_QUEUE_FULL.to_owned()), machine_id: machine });
        }
        Ok(())
    }

    /// This socket takes the sessions from here on: each is named to it again, oldest first, and everything held
    /// while nobody was reading follows the session it belongs to. A host that restarted holds no rows at all, so
    /// the open frame is what it picks its sessions back up by; one it still holds knows the session already and
    /// lets the second open go. A session whose guest went while nobody watched hands over its open and its close
    /// and is then dropped, so the row it left is two frames long. Whoever watches takes every session off the
    /// unwatched clock: a host is here again.
    pub(crate) fn watch(&self, conn: &Conn) {
        let mut state = lock(&self.state);
        state.watchers.retain(|(key, _)| *key != conn.key);
        state.watchers.push((conn.key, conn.out.clone()));
        let mut held: Vec<(u64, Vec<Outgoing>)> = state
            .sessions
            .values_mut()
            .map(|s| {
                s.unwatched_since = None;
                let mut frames = vec![Outgoing::Text(crate::frame_text(&s.opened))];
                frames.append(&mut std::mem::take(&mut s.queued));
                (s.at, frames)
            })
            .collect();
        held.sort_by_key(|(at, _)| *at);
        for frame in held.into_iter().flat_map(|(_, frames)| frames) {
            conn.out.send(frame);
        }
        state.sessions.retain(|_, s| !s.ended);
    }

    pub(crate) fn reply(&self, conn: &Conn, session: &str, message: Value) -> Result<(), OpError> {
        let state = lock(&self.state);
        Guests::watcher(&state, conn)?;
        let held = state.sessions.get(session).ok_or_else(|| no_such_session(session))?;
        held.out.send_event(&DaemonEvent::GuestMessage { session: session.to_owned(), message, machine_id: held.machine.clone() });
        Ok(())
    }

    pub(crate) fn close(&self, conn: &Conn, session: &str, error: Option<String>) -> Result<(), OpError> {
        let mut state = lock(&self.state);
        Guests::watcher(&state, conn)?;
        let gone = state.sessions.remove(session).ok_or_else(|| no_such_session(session))?;
        drop(state);
        gone.out.send_event(&DaemonEvent::GuestClosed { session: session.to_owned(), error, machine_id: gone.machine });
        Ok(())
    }

    /// A socket is gone: it stops watching, and any session it opened ends upward. With nobody watching the close is
    /// queued like any other frame and the row stands for it alone, so the next watcher hears the end. The sessions
    /// of a watcher that left stand whole, since the host holds them by id and its next socket asks to watch again.
    pub(crate) fn socket_closed(self: &Arc<Self>, key: u64) {
        let mut state = lock(&self.state);
        state.watchers.retain(|(held, _)| *held != key);
        if state.watching().is_none() {
            let since = Instant::now();
            for held in state.sessions.values_mut() {
                held.unwatched_since.get_or_insert(since);
            }
        }
        let ended: Vec<String> = state.sessions.iter().filter(|(_, s)| s.key == key).map(|(id, _)| id.clone()).collect();
        for session in ended {
            let closed = DaemonEvent::GuestClosed { session: session.clone(), error: None, machine_id: state.machine_of(&session) };
            match state.watching() {
                Some(out) => {
                    out.send_event(&closed);
                    state.sessions.remove(&session);
                }
                None => {
                    if let Some(held) = state.sessions.get_mut(&session) {
                        held.ended = true;
                        held.queued.push(Outgoing::Text(crate::frame_text(&closed)));
                    }
                }
            }
        }
        drop(state);
        self.sweep();
    }

    /// The clock on the sessions nobody watches. One task waits on the nearest of them to fall past the span, ends
    /// every session that has, and waits again on what is left; with nothing unwatched it stops, and the next
    /// session left alone starts it. Ending is the whole point: the process inside the machine is waiting on a reply
    /// that is not coming, and the sentence is what it prints before it exits.
    fn sweep(self: &Arc<Self>) {
        {
            let mut state = lock(&self.state);
            if state.sweeping || self.due_at(&state).is_none() {
                return;
            }
            state.sweeping = true;
        }
        let guests = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let due = {
                    let mut state = lock(&guests.state);
                    match guests.due_at(&state) {
                        Some(at) => at,
                        None => {
                            state.sweeping = false;
                            return;
                        }
                    }
                };
                tokio::time::sleep(due.saturating_duration_since(Instant::now())).await;
                guests.end_unwatched();
            }
        });
    }

    /// When the session that has been alone longest falls past the span; none while every session has a watcher.
    fn due_at(&self, state: &State) -> Option<Instant> {
        state.sessions.values().filter_map(|s| s.unwatched_since).min().map(|since| since + self.unwatched)
    }

    /// Every session past the span goes, and its guest is told why. One whose guest is already gone is dropped
    /// without a word: the row was standing for a watcher that never came.
    fn end_unwatched(&self) {
        let now = Instant::now();
        let mut state = lock(&self.state);
        let due: Vec<String> = state
            .sessions
            .iter()
            .filter(|(_, s)| s.unwatched_since.is_some_and(|since| now.duration_since(since) >= self.unwatched))
            .map(|(id, _)| id.clone())
            .collect();
        let told: Vec<(String, Outbound, Option<String>)> =
            due.into_iter().filter_map(|id| state.sessions.remove(&id).filter(|s| !s.ended).map(|s| (id, s.out, s.machine))).collect();
        drop(state);
        for (session, out, machine) in told {
            out.send_event(&DaemonEvent::GuestClosed { session, error: Some(words::GUEST_UNWATCHED.to_owned()), machine_id: machine });
        }
    }

    /// Only a socket that has asked to watch may answer or end a session; every other one is told so by name.
    fn watcher(state: &State, conn: &Conn) -> Result<(), OpError> {
        if state.watchers.iter().any(|(key, _)| *key == conn.key) {
            return Ok(());
        }
        Err(OpError::coded(DaemonErrorCode::Forbidden, words::GUEST_NOT_WATCHER))
    }
}

/// The guest bytes a workspace has waiting: frames queued in its sessions and frames written onto a watcher's
/// channel that its socket has not carried out yet. One count per workspace on a computer that runs them, and one
/// for the daemon itself inside a machine, where a session names no workspace, so no road of the two is left
/// growing without a bound.
#[derive(Default)]
pub(crate) struct InFlight(Mutex<HashMap<Option<String>, usize>>);

impl InFlight {
    /// One frame's bytes, taken where the cap leaves room for them; none past it, where nothing is taken.
    fn take(self: &Arc<Self>, at: &Option<String>, bytes: usize) -> Option<GuestBytes> {
        let mut held = lock(&self.0);
        let waiting = held.get(at).copied().unwrap_or(0);
        if waiting + bytes > numbers::GUEST_IN_FLIGHT_CAP_BYTES {
            return None;
        }
        held.insert(at.clone(), waiting + bytes);
        Some(GuestBytes { of: Arc::clone(self), at: at.clone(), bytes })
    }

    fn give_back(&self, at: &Option<String>, bytes: usize) {
        let mut held = lock(&self.0);
        let Some(waiting) = held.get_mut(at) else { return };
        *waiting = waiting.saturating_sub(bytes);
        if *waiting == 0 {
            held.remove(at);
        }
    }
}

/// What one guest frame holds against its workspace while it waits. The bytes go back when the frame is written,
/// and when it is dropped instead: a watcher's socket that goes with frames still on its channel drops them, and
/// a session that ends drops whatever it had queued.
pub(crate) struct GuestBytes {
    of: Arc<InFlight>,
    at: Option<String>,
    bytes: usize,
}

impl Drop for GuestBytes {
    fn drop(&mut self) {
        self.of.give_back(&self.at, self.bytes);
    }
}

pub(crate) const NO_SESSION: &str = "this socket has opened no guest session";
pub(crate) const SESSION_TAKEN: &str = "this socket already holds a guest session";

fn over_the_cap() -> String {
    format!("a guest message is at most {} bytes of JSON", numbers::GUEST_MESSAGE_CAP_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::Road;
    use tokio::sync::mpsc;
    use wsp_frames::GuestKind;

    /// A socket opened inside one workspace, and the channel its frames would leave on.
    fn inside(workspace: &str, key: u64) -> (Conn, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Conn::new(key, None, Outbound(tx), Road::Workspace(workspace.to_owned()), None), rx)
    }

    fn opening() -> GuestOpen {
        GuestOpen {
            kind: GuestKind::Cli,
            token: "dev-1.tok".to_owned(),
            turn_token: None,
            argv: vec!["threads".to_owned()],
            cwd: "/root".to_owned(),
        }
    }

    /// A message big enough that a handful of them fill the cap, and small enough to ride one frame.
    fn fat() -> Value {
        Value::from("x".repeat(1024 * 1024))
    }

    /// The cap is one workspace's own: a computer runs many, and a process flooding inside one must not stop the
    /// guest road of the workspace beside it.
    #[tokio::test]
    async fn the_bytes_one_workspace_holds_leave_the_workspace_beside_it_sending() {
        let guests = Arc::new(Guests::new(Duration::from_secs(600)));
        let (a, _a_rx) = inside("wsp-a", 1);
        let (b, _b_rx) = inside("wsp-b", 2);
        guests.open(&a, opening()).unwrap();
        guests.open(&b, opening()).unwrap();

        let mut refusal = None;
        for _ in 0..64 {
            if let Err(e) = guests.send(&a, fat()) {
                refusal = Some(e.message);
                break;
            }
        }
        assert_eq!(refusal.as_deref(), Some(words::GUEST_IN_FLIGHT_FULL), "wsp-a filled its own cap");
        assert!(guests.send(&b, fat()).is_ok(), "wsp-b has its own count");
    }

    /// The sessions are counted the same way and for the same reason: a process inside a workspace opens them on
    /// a door that takes no token, and the rows collect in the daemon every co-tenant workspace shares.
    #[tokio::test]
    async fn a_workspace_opens_as_many_sessions_as_the_cap_and_the_one_beside_it_opens_its_own() {
        let guests = Arc::new(Guests::new(Duration::from_secs(600)));
        let mut held = Vec::new();
        for key in 0..numbers::GUEST_SESSIONS_PER_WORKSPACE_CAP {
            let (conn, rx) = inside("wsp-a", key as u64);
            guests.open(&conn, opening()).expect("a session under the cap is opened");
            held.push((conn, rx));
        }
        let (over, _over_rx) = inside("wsp-a", 900);
        let refused = guests.open(&over, opening()).expect_err("the session past the cap was opened");
        assert_eq!(refused.message, words::GUEST_WORKSPACE_FULL);
        let (beside, _beside_rx) = inside("wsp-b", 901);
        assert!(guests.open(&beside, opening()).is_ok(), "wsp-b has its own count");

        // A session whose socket went with nobody watching stands until a watcher has been handed its close, and
        // what the daemon is still holding is what the cap reads.
        let (gone, _gone_rx) = held.remove(0);
        guests.socket_closed(gone.key);
        let (again, _again_rx) = inside("wsp-a", 902);
        assert_eq!(
            guests.open(&again, opening()).expect_err("the row left behind counted for nothing").message,
            words::GUEST_WORKSPACE_FULL
        );
    }
}
