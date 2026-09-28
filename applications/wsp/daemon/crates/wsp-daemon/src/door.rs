// SPDX-License-Identifier: AGPL-3.0-only
//! The door: with the server on 0.0.0.0 the first frame is the only gate, so no handler exists until it passes.
//! Bytes are counted on the TCP stream under the WebSocket framing, because a frame is assembled whole before it is
//! a message and a peer that never finishes one would otherwise be buffered up to the framing's own cap.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;
use wsp_frames::{numbers, words, DaemonAuthRequest, DaemonEvent, Empty, Reply};

use crate::ops::{self, Conn, Road};
use crate::seal::Seal;
use crate::{auth, Ctx, Outbound, Outgoing};

/// The most one message may be; node's ws holds the same ceiling, and the pre-auth cap sits far under it.
const MESSAGE_MAX_BYTES: usize = 100 * 1024 * 1024;
/// How long a refused peer gets to answer the close frame before the stream is dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(5);
/// A socket with no quiet cut: the sleep it never reaches.
const FOREVER: Duration = Duration::from_secs(60 * 60 * 24 * 365);
/// The most of a request head that is read ahead of the framing before the rest is left to it.
const HEAD_MAX_BYTES: usize = 16 * 1024;
/// What a plain HTTP request is answered with: the one status the host's probe reads as a daemon, since nothing
/// else on a machine answers it, as node's ws server answered it before.
const UPGRADE_REQUIRED: &[u8] = b"HTTP/1.1 426 Upgrade Required\r\nUpgrade: websocket\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// The bytes a peer sends before its auth frame, the upgrade request excluded, and whether they crossed the cap,
/// shared by the stream that counts inside its read and the task that acts on the trip.
#[derive(Default)]
struct PreAuth {
    read: AtomicU64,
    baseline: AtomicU64,
    armed: AtomicBool,
    tripped: AtomicBool,
}

impl PreAuth {
    fn arm(&self) {
        self.baseline.store(self.read.load(Ordering::Relaxed), Ordering::Relaxed);
        self.armed.store(true, Ordering::Relaxed);
    }

    fn disarm(&self) {
        self.armed.store(false, Ordering::Relaxed);
    }

    /// What the peer's bytes cost it: the count, and the refusal the moment they pass the cap.
    fn charge(&self, n: u64) -> io::Result<()> {
        let total = self.read.fetch_add(n, Ordering::Relaxed) + n;
        if self.armed.load(Ordering::Relaxed) && total - self.baseline.load(Ordering::Relaxed) > numbers::PRE_AUTH_MAX_BYTES {
            self.tripped.store(true, Ordering::Relaxed);
            self.disarm();
            return Err(io::Error::other(words::AUTH_TOO_MANY_BYTES));
        }
        Ok(())
    }

    fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Relaxed)
    }
}

/// The TCP stream with its read side counted, handing back first the request head read ahead of the framing.
struct Counted {
    inner: TcpStream,
    pre: Arc<PreAuth>,
    ahead: Vec<u8>,
    ahead_at: usize,
    /// How much of `ahead` is the upgrade request itself; whatever the peer wrote behind its blank line is the
    /// peer's own bytes and costs it the same budget as the bytes the framing reads off the socket.
    uncounted: usize,
}

impl AsyncRead for Counted {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.ahead_at < this.ahead.len() {
            let n = buf.remaining().min(this.ahead.len() - this.ahead_at);
            buf.put_slice(&this.ahead[this.ahead_at..this.ahead_at + n]);
            let charged = (this.ahead_at + n).saturating_sub(this.ahead_at.max(this.uncounted)) as u64;
            this.ahead_at += n;
            return Poll::Ready(this.pre.charge(charged));
        }
        let before = buf.filled().len();
        let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &polled {
            return Poll::Ready(this.pre.charge((buf.filled().len() - before) as u64));
        }
        polled
    }
}

impl AsyncWrite for Counted {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

type Socket = WebSocketStream<Counted>;

fn text(value: &impl serde::Serialize) -> Message {
    Message::text(serde_json::to_string(value).expect("a frame serialises"))
}

/// The request head up to its blank line, or as much of it as the cap allows; nothing when the peer went first.
/// Beside it, where the request ends inside it, which is the head's own length when no blank line came.
async fn read_head(tcp: &mut TcpStream) -> io::Result<(Vec<u8>, usize)> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(at) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok((head, at + 4));
        }
        if head.len() >= HEAD_MAX_BYTES {
            let end = head.len();
            return Ok((head, end));
        }
        let n = tcp.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.extend_from_slice(&chunk[..n]);
    }
}

/// Whether a request head asks for the WebSocket upgrade: the one header the framing insists on, read the way it
/// reads it, so a request that would fail the handshake is answered instead of dropped.
fn asks_for_upgrade(head: &[u8]) -> bool {
    String::from_utf8_lossy(head).lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else { return false };
        name.trim().eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
    })
}

/// One socket, start to end: the handshake and the auth frame under the deadline, then the op loop. A plain HTTP
/// request, which the host's status probe sends, is answered 426 and closed: that answer is how a probe tells a
/// daemon from an edge speaking for a machine that has none.
pub(crate) async fn serve(mut tcp: TcpStream, ctx: Arc<Ctx>) {
    let deadline = Instant::now() + ctx.auth_deadline;
    let Ok(Ok((head, uncounted))) = timeout_at(deadline, read_head(&mut tcp)).await else {
        return;
    };
    if !asks_for_upgrade(&head) {
        let _ = tcp.write_all(UPGRADE_REQUIRED).await;
        let _ = tcp.shutdown().await;
        return;
    }
    let pre = Arc::new(PreAuth::default());
    let stream = Counted { inner: tcp, pre: Arc::clone(&pre), ahead: head, ahead_at: 0, uncounted };
    let config = WebSocketConfig::default().max_message_size(Some(MESSAGE_MAX_BYTES)).max_frame_size(Some(MESSAGE_MAX_BYTES));
    pre.arm();
    let Ok(Ok(mut ws)) = timeout_at(deadline, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await else {
        return;
    };
    let first = loop {
        match timeout_at(deadline, ws.next()).await {
            Err(_) => return refuse(ws, words::AUTH_NO_FRAME_IN_TIME, &pre).await,
            Ok(Some(Ok(Message::Text(t)))) => break t.to_string(),
            Ok(Some(Ok(Message::Binary(b)))) => break String::from_utf8_lossy(&b).into_owned(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)))) => continue,
            // A frame announcing more than the message cap is the same peer as one that streams past the byte cap.
            Ok(Some(Err(WsError::Capacity(_)))) => {
                pre.tripped.store(true, Ordering::Relaxed);
                return refuse(ws, words::AUTH_TOO_MANY_BYTES, &pre).await;
            }
            Ok(Some(Err(_))) if pre.tripped() => return refuse(ws, words::AUTH_TOO_MANY_BYTES, &pre).await,
            // The peer closed, or sent a frame the framing refuses: that socket ends and nothing else.
            Ok(_) => return,
        }
    };
    let Ok(auth) = serde_json::from_str::<DaemonAuthRequest>(&first) else {
        return refuse(ws, words::AUTH_FIRST_FRAME, &pre).await;
    };
    if !auth::token_matches(&auth.token, &ctx.options.token_path) {
        return refuse(ws, words::AUTH_TOKEN_REFUSED, &pre).await;
    }
    pre.disarm();
    if ws.send(text(&Reply::new(Some(auth.id), Empty {}))).await.is_err() {
        return;
    }
    let (tx, rx) = mpsc::unbounded_channel();
    // The token this socket came in on is held: a rotation takes the sockets the old one opened, and one let in
    // on the new token in the same breath as the write stays.
    let conn = Arc::new(Conn::new(ctx.next_key(), auth.port, Outbound(tx), Road::Inbound, Some(auth.token)));
    serve_authed(ws, &ctx, conn, rx, None, None).await;
}

/// One socket's place on a workspace's door, given back the moment that socket's task ends however it ends. The
/// count it is taken from is that workspace's own, so a process flooding inside one workspace never takes a place
/// from the workspace beside it.
struct DoorSlot(Arc<AtomicUsize>);

impl DoorSlot {
    /// A place where the cap leaves one; none past it, where nothing is taken.
    fn take(door: &Arc<AtomicUsize>) -> Option<DoorSlot> {
        let taken = door.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
            (held < numbers::GUEST_SESSIONS_PER_WORKSPACE_CAP).then_some(held + 1)
        });
        taken.ok().map(|_| DoorSlot(Arc::clone(door)))
    }
}

impl Drop for DoorSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The door inside one workspace: every socket accepted on that workspace's own unix socket, each served with no
/// auth frame and no token. The file is the gate, and what the socket may ask for is the roads table's, which
/// answers a process inside its own two guest ops and refuses it everything else. The count is the other half of
/// the gate: this door takes no token, so a socket accepted past the cap is dropped here, closed with no hello and
/// no task of its own, and the daemon every co-tenant workspace shares stands.
pub(crate) async fn serve_workspace(listener: tokio::net::UnixListener, ctx: Arc<Ctx>, workspace: String, door: Arc<AtomicUsize>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let Some(slot) = DoorSlot::take(&door) else { continue };
        let (ctx, workspace) = (Arc::clone(&ctx), workspace.clone());
        tokio::spawn(serve_inside(stream, ctx, workspace, slot));
    }
}

/// One socket inside a workspace: the handshake, then the same loop every authed socket runs. Nothing is checked
/// at this door, since nothing but that workspace can see the file it was opened on; the socket is never added to
/// the authed list, so what the daemon pushes to every authed socket, the URLs it reads off this computer's own
/// ptys among it, reaches nothing inside a workspace. The framing here is opened at the guest frame cap rather
/// than the ceiling every other socket gets, so a frame larger than a guest message may be is refused by the
/// framing before the daemon holds it or reads it as a message. The place on the door is held for the life of
/// this task.
async fn serve_inside(stream: tokio::net::UnixStream, ctx: Arc<Ctx>, workspace: String, _slot: DoorSlot) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(numbers::GUEST_FRAME_CAP_BYTES))
        .max_frame_size(Some(numbers::GUEST_FRAME_CAP_BYTES));
    let deadline = Instant::now() + ctx.auth_deadline;
    let Ok(Ok(ws)) = timeout_at(deadline, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await else {
        return;
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let conn = Arc::new(Conn::new(ctx.next_key(), None, Outbound(tx), Road::Workspace(workspace), None));
    serve_authed(ws, &ctx, conn, rx, None, None).await;
}

/// How a served socket ended: the peer went, the link carried nothing for the quiet span, or a leave was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ended {
    Peer,
    Quiet,
    Leave,
    Restart,
    /// The token this socket authed with is no longer the file's.
    Rotated,
}

/// The one loop every authed socket runs, inbound or the link a place opened: the hello first, then each frame
/// answered on its own task, as the node daemon answers them, so a heartbeat is not held behind an exec that runs
/// for a minute. Replies and events share one channel, so what a handler sends stays in order. `quiet` is the
/// link's cut: a socket that carries no frame for that long ends here and the caller redials.
pub(crate) async fn serve_authed<S>(
    mut ws: WebSocketStream<S>,
    ctx: &Arc<Ctx>,
    conn: Arc<Conn>,
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
    quiet: Option<Duration>,
    mut seal: Option<Seal>,
) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let key = conn.key;
    if conn.scope.is_none() && !matches!(conn.road, Road::Workspace(_)) {
        ctx.add_authed(key, conn.out.clone());
    }
    if let Some(token) = conn.token.clone() {
        ctx.add_tokened(key, token, conn.out.clone());
    }
    let hello = DaemonEvent::DaemonHello { root: ctx.root.clone(), version: Some(numbers::DAEMON_VERSION) };
    let mut ended = Ended::Peer;
    if emit(&mut ws, &mut seal, crate::frame_text(&hello)).await {
        let idle = tokio::time::sleep(quiet.unwrap_or(FOREVER));
        tokio::pin!(idle);
        ended = loop {
            tokio::select! {
                incoming = ws.next() => {
                    let raw = match incoming {
                        // On a sealed link nothing arrives in the clear: a text frame after the prove is a
                        // carrier writing into the link, and the socket ends rather than reading it.
                        Some(Ok(Message::Text(t))) if seal.is_none() => t.to_string(),
                        Some(Ok(Message::Binary(b))) => match seal.as_mut() {
                            Some(seal) => match seal.unseal(&b) {
                                Some(text) => text,
                                None => break Ended::Peer,
                            },
                            None => String::from_utf8_lossy(&b).into_owned(),
                        },
                        Some(Ok(Message::Text(_))) => break Ended::Peer,
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break Ended::Peer,
                        Some(Ok(_)) => continue,
                    };
                    if let Some(span) = quiet {
                        idle.as_mut().reset(Instant::now() + span);
                    }
                    let (conn, ctx) = (Arc::clone(&conn), Arc::clone(ctx));
                    tokio::spawn(async move {
                        let reply = ops::handle(&conn, &ctx, &raw).await;
                        conn.out.send(reply);
                    });
                }
                outgoing = rx.recv() => {
                    match outgoing {
                        None => break Ended::Peer,
                        Some(Outgoing::Text(t)) => {
                            if !emit(&mut ws, &mut seal, t).await {
                                break Ended::Peer;
                            }
                        }
                        // A guest frame gives its workspace's bytes back once it is out of this socket: until then
                        // it is waiting here, and what waits is what the cap counts.
                        Some(Outgoing::Guest(t, held)) => {
                            let wrote = emit(&mut ws, &mut seal, t).await;
                            drop(held);
                            if !wrote {
                                break Ended::Peer;
                            }
                        }
                        // The reply goes out whole before the daemon stops: the host reads what was swept, or where
                        // the binary it sent landed.
                        Some(Outgoing::Leave(t)) => {
                            emit(&mut ws, &mut seal, t).await;
                            let _ = ws.flush().await;
                            break Ended::Leave;
                        }
                        Some(Outgoing::Restart(t)) => {
                            emit(&mut ws, &mut seal, t).await;
                            let _ = ws.flush().await;
                            break Ended::Restart;
                        }
                        // Nothing is written to a socket whose token the file no longer holds: it is closed with
                        // the sentence and no frame, as every socket the door itself turns away is.
                        Some(Outgoing::Rotated) => break Ended::Rotated,
                    }
                }
                _ = &mut idle, if quiet.is_some() => break Ended::Quiet,
            }
        };
    }
    // The client is gone; the ptys and the watchers keep running. Only this socket's subscriptions and tunnels die
    // with it.
    ctx.remove_authed(key);
    ctx.guests.socket_closed(key);
    conn.close();
    let closing = match ended {
        Ended::Peer => None,
        Ended::Quiet => Some((CloseCode::Normal, words::LINK_CLOSE_QUIET)),
        Ended::Leave => Some((CloseCode::Normal, words::LINK_CLOSE_STOPPING)),
        Ended::Restart => Some((CloseCode::Normal, words::LINK_CLOSE_UPDATING)),
        // Under the code every socket this daemon turns away for its token travels with, so a client reads a
        // rotation the way it reads a token refused at the door.
        Ended::Rotated => Some((CloseCode::from(words::AUTH_CLOSE_CODE), words::AUTH_TOKEN_ROTATED)),
    };
    let frame = closing.map(|(code, reason)| CloseFrame { code, reason: reason.into() });
    let _ = timeout(CLOSE_WAIT, ws.close(frame)).await;
    // Both endings stop this process. What differs is what happens next on that computer: after a leave nothing
    // brings it back, and after an update its supervisor starts the binary that landed.
    if ended == Ended::Leave || ended == Ended::Restart {
        ctx.stop.notify_one();
    }
    ended
}

/// Every frame this socket sends leaves through here: sealed where the link agreed a key, text where it did not.
/// One door for the hello, the replies off the sink and the leave and the restart alike, so no frame of this
/// daemon's ever leaves a sealed link in the clear. False once the peer is gone.
async fn emit<S>(ws: &mut WebSocketStream<S>, seal: &mut Option<Seal>, text: String) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let message = match seal.as_mut() {
        Some(seal) => Message::Binary(seal.seal(&text).into()),
        None => Message::text(text),
    };
    ws.send(message).await.is_ok()
}

/// Closes 4401 with one sentence, then waits for the peer's close as node's ws does. A peer cut for streaming past
/// the cap is mid-frame, so its next bytes, or its silence past the wait, end the connection outright.
async fn refuse(mut ws: Socket, reason: &str, pre: &PreAuth) {
    pre.disarm();
    let frame = CloseFrame { code: CloseCode::from(words::AUTH_CLOSE_CODE), reason: reason.into() };
    if ws.send(Message::Close(Some(frame))).await.is_err() {
        return;
    }
    let drain = async {
        if pre.tripped() {
            let mut buf = [0u8; 1024];
            let _ = ws.get_mut().inner.read(&mut buf).await;
        } else {
            while let Some(Ok(_)) = ws.next().await {}
        }
    };
    let _ = timeout(CLOSE_WAIT, drain).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Options;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixStream;

    const WAIT: Duration = Duration::from_secs(5);
    const TOKEN: &str = "test-token-123";

    /// The next text frame, or nothing within the wait.
    async fn frame<S>(ws: &mut WebSocketStream<S>) -> Option<Value>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        match timeout(WAIT, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str(&t).ok(),
            _ => None,
        }
    }

    /// One ping and its reply: the op every road answers, so what a case reads is the door and not the switch.
    async fn ping<S>(ws: &mut WebSocketStream<S>, id: u64) -> Option<Value>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        ws.send(Message::text(json!({ "id": id, "op": "ping" }).to_string())).await.ok()?;
        frame(ws).await
    }

    /// A daemon's own state with its token, root and manifest under fresh directories; the two handles come back
    /// with it, since dropping either takes the file the ctx was built on.
    fn running() -> (Arc<Ctx>, tempfile::NamedTempFile, tempfile::TempDir) {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "{TOKEN}").unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.root = Some(home.path().to_path_buf());
        options.manifest_path = Some(home.path().join("manifest.json"));
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        (ctx, token, home)
    }

    /// One socket on a workspace's door, through the handshake and past the hello, or nothing where the door
    /// closed it instead.
    async fn inside(at: &std::path::Path) -> Option<WebSocketStream<UnixStream>> {
        let stream = UnixStream::connect(at).await.ok()?;
        let (mut ws, _) = timeout(WAIT, tokio_tungstenite::client_async("ws://workspace/", stream)).await.ok()?.ok()?;
        let hello = frame(&mut ws).await?;
        assert_eq!(hello["type"], "daemon.hello");
        Some(ws)
    }

    /// The daemon's own inbound door on the loopback, serving the same state: a socket there is inside no
    /// workspace, so neither of the two caps is read for it.
    async fn inbound(ctx: &Arc<Ctx>) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ctx = Arc::clone(ctx);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, Arc::clone(&ctx)));
            }
        });
        addr
    }

    /// One socket on that door, through the auth frame and past the hello.
    async fn authed(addr: std::net::SocketAddr) -> WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>> {
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/")).await.unwrap();
        ws.send(Message::text(json!({"id": 1, "op": "auth", "token": TOKEN}).to_string())).await.unwrap();
        for _ in 0..2 {
            let read = timeout(WAIT, ws.next()).await.expect("the door answers the auth frame");
            if let Some(Ok(Message::Text(t))) = read {
                let frame: Value = serde_json::from_str(&t).unwrap();
                if frame["type"] == "daemon.hello" {
                    return ws;
                }
                assert_eq!(frame["ok"], json!(true), "{frame}");
            }
        }
        panic!("no hello arrived on the inbound door");
    }

    /// A ping frame with as much padding as the caller asks for: the bytes are the point, and the op is one every
    /// road answers, so what differs between two doors is the framing and nothing else.
    fn padded_ping(id: u64, bytes: usize) -> String {
        json!({ "id": id, "op": "ping", "pad": "x".repeat(bytes) }).to_string()
    }

    /// The door inside a workspace takes no token and no auth frame, so the count is the whole of the gate on it:
    /// a process inside opens as many sockets as the cap and no more, the workspace beside it and this computer's
    /// own door answer through the flood, and a socket that ends gives its place straight back.
    #[tokio::test]
    async fn a_workspace_door_serves_the_cap_and_closes_what_comes_past_it_with_no_hello() {
        let (ctx, _token, home) = running();
        let a = home.path().join("a.sock");
        let b = home.path().join("b.sock");
        ctx.open_workspace_door("wsp-a", &a);
        ctx.open_workspace_door("wsp-b", &b);
        let addr = inbound(&ctx).await;

        let mut held = Vec::new();
        for _ in 0..numbers::GUEST_SESSIONS_PER_WORKSPACE_CAP {
            held.push(inside(&a).await.expect("a socket under the cap is served"));
        }
        assert!(inside(&a).await.is_none(), "a socket past the cap was served");

        // What the flood must not reach: the workspace beside it, which counts its own, and this computer's own
        // door, which the host's link and every client of the person's come through.
        let mut beside = inside(&b).await.expect("the workspace beside it has a count of its own");
        assert_eq!(ping(&mut beside, 7).await.expect("the door beside it answers")["ok"], json!(true));
        let mut own = authed(addr).await;
        assert_eq!(ping(&mut own, 8).await.expect("the daemon's own door answers")["ok"], json!(true));

        // And a socket that ends gives its place back at once, so a workspace working inside the cap never meets it.
        drop(held.pop().unwrap());
        let room = async {
            loop {
                if let Some(ws) = inside(&a).await {
                    break ws;
                }
                tokio::task::yield_now().await;
            }
        };
        assert!(timeout(WAIT, room).await.is_ok(), "the place a closed socket held never came back");
    }

    /// A frame larger than a guest message may be is refused by the framing on a workspace's door, before the
    /// daemon holds it or reads it as a message; the same bytes on this computer's own door are read as they
    /// always were, since the cap is the workspace door's alone.
    #[tokio::test]
    async fn a_frame_past_the_guest_cap_ends_a_workspace_socket_and_still_rides_the_daemons_own_door() {
        let (ctx, _token, home) = running();
        let at = home.path().join("a.sock");
        ctx.open_workspace_door("wsp-a", &at);
        let addr = inbound(&ctx).await;
        let over = padded_ping(2, numbers::GUEST_FRAME_CAP_BYTES + 1);
        assert!(over.len() > numbers::GUEST_FRAME_CAP_BYTES);

        let mut ws = inside(&at).await.expect("the door serves the socket");
        // The write itself may not finish: the framing reads the length and closes while the rest is still
        // arriving, which the sender meets as a broken pipe. Either way nothing comes back and the socket is done.
        let _ = ws.send(Message::text(over.clone())).await;
        assert_eq!(frame(&mut ws).await, None, "a frame past the cap was read and answered");

        let mut own = authed(addr).await;
        own.send(Message::text(over)).await.unwrap();
        let answered = frame(&mut own).await.expect("the daemon's own door reads it under the ceiling every socket gets");
        assert_eq!(answered["id"], json!(2));
        assert_eq!(answered["ok"], json!(true), "{answered}");

        // One socket's frame ended one socket: the door is still there for the next process inside that workspace.
        let mut next = inside(&at).await.expect("the door answers after a frame past the cap");
        assert_eq!(ping(&mut next, 3).await.expect("the door still answers")["ok"], json!(true));
    }

    /// The budget before auth is one: the upgrade request costs the peer nothing, and what it wrote behind the
    /// blank line is its own bytes, counted as the framing takes them, wherever the door happened to read them.
    #[tokio::test]
    async fn the_bytes_read_ahead_behind_the_blank_line_are_counted_and_the_request_head_is_not() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dialer = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (inner, _) = listener.accept().await.unwrap();
        let request = b"GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";
        let mut ahead = request.to_vec();
        ahead.extend(std::iter::repeat_n(b'x', 100));
        let pre = Arc::new(PreAuth::default());
        let mut counted = Counted { inner, pre: Arc::clone(&pre), ahead, ahead_at: 0, uncounted: request.len() };
        pre.arm();

        // Eight bytes at a time, so the read that spans the blank line is one of them.
        let mut buf = [0u8; 8];
        let mut read = 0;
        while read < request.len() + 100 {
            read += counted.read(&mut buf).await.unwrap();
        }
        assert_eq!(pre.read.load(Ordering::Relaxed), 100);
        assert!(!pre.tripped(), "a hundred bytes are under the cap");
        drop(dialer);
    }

    /// A socket inside a workspace: the door takes it with no auth frame, answers the hello, serves the guest's
    /// own ops, and is not one of the sockets the daemon pushes to. What the roads table refuses there is proved
    /// in the switch's own cases; what is proved here is the door.
    #[tokio::test]
    async fn a_workspace_door_serves_a_socket_that_sent_no_auth_frame_and_hears_nothing_broadcast() {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.root = Some(home.path().to_path_buf());
        options.manifest_path = Some(home.path().join("manifest.json"));
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        let at = home.path().join("daemon.sock");
        ctx.open_workspace_door("wsp-a", &at);
        assert_eq!(std::fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o600);

        let (mut ws, _) = tokio_tungstenite::client_async("ws://workspace/", UnixStream::connect(&at).await.unwrap()).await.unwrap();
        let hello = frame(&mut ws).await.expect("the door says hello with no auth frame");
        assert_eq!(hello["type"], "daemon.hello");
        ws.send(Message::text(json!({"id": 1, "op": "guest.open", "kind": "cli", "token": "t", "argv": [], "cwd": "/root"}).to_string()))
            .await
            .unwrap();
        let opened = frame(&mut ws).await.unwrap();
        assert_eq!(opened["ok"], json!(true), "{opened}");

        // A socket of the computer's own hears what the daemon pushes to every authed socket; the one inside a
        // workspace hears none of it, since the URLs read off this computer's ptys are not that workspace's.
        let (tx, mut authed) = mpsc::unbounded_channel();
        ctx.add_authed(ctx.next_key(), crate::Outbound(tx));
        ctx.broadcast(&DaemonEvent::LocalhostUrl { port: wsp_frames::RelayPort::new(8123).unwrap() });
        let heard = timeout(WAIT, authed.recv()).await.unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(heard.text()).unwrap()["type"], "localhost.url");
        assert!(timeout(Duration::from_millis(200), ws.next()).await.is_err(), "a socket inside a workspace was pushed to");

        // And the door goes with the workspace: the loop ends, so a dial finds nothing to answer it. The file it
        // was bound on is the workspace's own folder's and the runtime takes it off with the workspace, since a
        // workspace may be stopped by something other than the daemon that bound this.
        ctx.close_workspace_door("wsp-a");
        let refused = async {
            while UnixStream::connect(&at).await.is_ok() {
                tokio::task::yield_now().await;
            }
        };
        assert!(timeout(WAIT, refused).await.is_ok(), "the door still answers after the workspace stopped");
    }
}
