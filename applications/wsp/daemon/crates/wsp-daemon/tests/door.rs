// SPDX-License-Identifier: AGPL-3.0-only
//! The door on a real socket: every auth and hello case the node daemon's suite pins, driven the way its clients
//! drive it, with a WebSocket client for the frames and a raw TCP stream where the case is about wire bytes; then
//! the exec, pty, ports, manifest, inbox, tunnel and open socket cases of the suite the same way.

use std::io::Write;
use std::net::SocketAddr;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_daemon::{Daemon, Options};
use wsp_frames::{numbers, words, DaemonEvent};

const TOKEN: &str = "test-token-123";

struct Running {
    addr: SocketAddr,
    token: tempfile::NamedTempFile,
    root: tempfile::TempDir,
}

async fn start(auth_deadline_ms: Option<u64>) -> Running {
    start_with(|options| options.auth_deadline_ms = auth_deadline_ms).await
}

/// A daemon on the loopback with its root and manifest under a fresh directory, and whatever else a case tunes.
async fn start_with(tune: impl FnOnce(&mut Options)) -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root.path().to_path_buf());
    options.manifest_path = Some(root.path().join("manifest.json"));
    tune(&mut options);
    let daemon = Daemon::bind(options).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    Running { addr, token, root }
}

/// A /proc lookalike the daemon reads its listening ports off: net/tcp as the kernel prints it and each holder's
/// fd table naming its socket, as the node suite's fake tree does.
struct FakeProc {
    root: tempfile::TempDir,
}

impl FakeProc {
    fn new() -> FakeProc {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("net")).unwrap();
        std::fs::write(root.path().join("net/tcp"), "").unwrap();
        std::fs::write(root.path().join("net/tcp6"), "").unwrap();
        FakeProc { root }
    }

    fn path(&self) -> PathBuf {
        self.root.path().to_path_buf()
    }

    /// What is listening on the fake machine: (port, pid, loopback); the holder's comm is written when it has none.
    fn set_listeners(&self, rows: &[(u16, u32, bool)]) {
        let mut lines = vec!["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode".to_owned()];
        for (i, (port, pid, loopback)) in rows.iter().enumerate() {
            let inode = 100_000 + u64::from(*port);
            let addr = if *loopback { "0100007F" } else { "00000000" };
            lines.push(format!(
                "   {i}: {addr}:{port:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 {inode} 1 0000000000000000 100 0 0 10 0"
            ));
            let dir = self.root.path().join(pid.to_string());
            std::fs::create_dir_all(dir.join("fd")).unwrap();
            if !dir.join("comm").exists() {
                self.comm(*pid, &format!("p{pid}"));
            }
            let link = dir.join("fd").join(inode.to_string());
            let _ = std::fs::remove_file(&link);
            symlink(format!("socket:[{inode}]"), link).unwrap();
        }
        // Written beside and renamed over, so a daemon reading on its own clock sees the old text or the new.
        let next = self.root.path().join("net/tcp.next");
        std::fs::write(&next, format!("{}\n", lines.join("\n"))).unwrap();
        std::fs::rename(next, self.root.path().join("net/tcp")).unwrap();
    }

    fn comm(&self, pid: u32, comm: &str) {
        let dir = self.root.path().join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("comm"), format!("{comm}\n")).unwrap();
        std::fs::write(dir.join("cmdline"), format!("{comm}\0")).unwrap();
    }
}

/// What the browser shim does: one POST /open on the unix socket with the URL as the body, as curl sends it.
async fn shim(sock: &Path, url: &str) -> String {
    let mut s = UnixStream::connect(sock).await.unwrap();
    let request = format!("POST /open HTTP/1.1\r\nHost: wsp\r\nContent-Length: {}\r\n\r\n{url}", url.len());
    s.write_all(request.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out.lines().next().unwrap_or("").to_owned()
}

/// A port nothing listens on, on either loopback address the daemon dials.
async fn refused_port() -> u16 {
    loop {
        let v4 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = v4.local_addr().unwrap().port();
        drop(v4);
        if TcpListener::bind(("::1", port)).await.is_ok() {
            return port;
        }
    }
}

/// [::1] only, at a port free on 127.0.0.1: the daemon dials v4 first and must be refused there.
async fn listen_v6_only() -> TcpListener {
    loop {
        let v6 = TcpListener::bind("[::1]:0").await.unwrap();
        let port = v6.local_addr().unwrap().port();
        if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            return v6;
        }
    }
}

/// An echo server: every byte in comes back behind "echo:", and the connection ends when the peer's does. The
/// count is how many connections the guest side still holds open.
fn echo(listener: TcpListener) -> Arc<AtomicUsize> {
    let live = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&live);
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            let live = Arc::clone(&counted);
            live.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&[b"echo:", &buf[..n]].concat()).await.is_err() {
                        break;
                    }
                }
                live.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    live
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

// URLs as the tools build them (measurement 2026-09-03); state and challenge values are placeholders.
const WRANGLER: &str = "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256";
const GH_DEVICE: &str = "https://github.com/login/device";

fn rotate(token: &Path, to: &str) {
    std::fs::write(token, format!("{to}\n")).unwrap();
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What one client saw: every frame in arrival order, and the close if the daemon closed it.
struct Client {
    ws: Ws,
    frames: Vec<Value>,
    next_id: u64,
}

#[derive(Debug, PartialEq)]
struct Closed {
    code: u16,
    reason: String,
}

impl Client {
    async fn open(addr: SocketAddr, path: &str) -> Client {
        let (ws, _) = connect_async(format!("ws://{addr}{path}")).await.unwrap();
        Client { ws, frames: Vec::new(), next_id: 1 }
    }

    /// Dials and sends the auth frame first, as every real client does, then waits for its answer or the close.
    async fn connect(addr: SocketAddr, token: &str, scope: Option<u32>) -> (Client, Option<Closed>) {
        let mut c = Client::open(addr, "/").await;
        let mut auth = json!({ "id": 1, "op": "auth", "token": token });
        if let Some(port) = scope {
            auth["port"] = json!(port);
        }
        c.next_id = 2;
        c.ws.send(Message::text(auth.to_string())).await.unwrap();
        let closed = c.read_until_reply(1).await;
        (c, closed)
    }

    async fn send_raw(&mut self, frame: Value) {
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
    }

    /// Reads frames until the reply to id arrives (Ok(reply)) or the socket closes.
    async fn read_until_reply(&mut self, id: u64) -> Option<Closed> {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.expect("the daemon answers within five seconds") {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    let done = v.get("id") == Some(&json!(id));
                    self.frames.push(v);
                    if done {
                        return None;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let frame = frame.expect("a close with a code");
                    return Some(Closed { code: frame.code.into(), reason: frame.reason.to_string() });
                }
                Some(Ok(_)) => continue,
                None | Some(Err(_)) => return Some(Closed { code: 1006, reason: String::new() }),
            }
        }
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.send_raw(frame).await;
        assert_eq!(self.read_until_reply(id).await, None, "the socket closed while {op} was pending");
        self.frames.last().unwrap().clone()
    }

    async fn wait_closed(&mut self) -> Closed {
        self.read_until_reply(u64::MAX).await.expect("the daemon closes the socket")
    }

    async fn close_ws(&mut self) {
        let _ = self.ws.close(None).await;
        while let Some(Ok(_)) = self.ws.next().await {}
    }

    /// Reads whatever arrives for the given time, so events pushed without a request are seen.
    async fn listen(&mut self, for_: Duration) {
        let deadline = tokio::time::Instant::now() + for_;
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            self.frames.push(serde_json::from_str(&t).unwrap());
        }
    }

    /// Reads until an event of the type arrives that the test accepts, or the wait runs out.
    async fn wait_event(&mut self, ty: &str, within: Duration, accept: impl Fn(&Value) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        if self.events(ty).iter().any(&accept) {
            return true;
        }
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                let hit = v["type"] == ty && accept(&v);
                self.frames.push(v);
                if hit {
                    return true;
                }
            }
        }
        false
    }

    /// Reads until the pty text seen so far contains the marker, or the wait runs out.
    async fn wait_text(&mut self, marker: &str, within: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        while !self.pty_text().contains(marker) {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => self.frames.push(serde_json::from_str(&t).unwrap()),
                Ok(Some(Ok(_))) => continue,
                _ => return false,
            }
        }
        true
    }

    fn events(&self, ty: &str) -> Vec<Value> {
        self.frames.iter().filter(|f| f["type"] == ty).cloned().collect()
    }

    /// The text every pty.data event carried, in order.
    fn pty_text(&self) -> String {
        self.events("pty.data").iter().map(|e| e["data"].as_str().unwrap_or("")).collect()
    }

    /// Every event this client saw is one the protocol parses: the zod half of the contract, on live traffic.
    fn every_event_parses(&self) {
        for frame in self.frames.iter().filter(|f| f.get("type").is_some()) {
            serde_json::from_value::<DaemonEvent>(frame.clone()).unwrap_or_else(|e| panic!("{frame}: {e}"));
        }
    }
}

const WAIT: Duration = Duration::from_secs(5);
const MCP_REMOTE: &str = "https://mcp.linear.app/authorize?response_type=code&client_id=X&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A22227%2Foauth%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";

async fn authed(d: &Running) -> Client {
    let (c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    c
}

/// A bash pty with no profile of its own, attached; the id it got.
async fn bash_pty(c: &mut Client) -> String {
    let created = c.request("pty.create", json!({ "cols": 80, "rows": 24, "shell": "bash" })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert!(created["pid"].as_u64().unwrap() > 0);
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    pty_id
}

/// A TCP stream past a hand-written upgrade, for the cases about bytes rather than frames.
async fn upgraded(addr: SocketAddr) -> TcpStream {
    let mut raw = TcpStream::connect(addr).await.unwrap();
    raw.write_all(&upgrade_request(addr, 0)).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let n = raw.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 101"), "the upgrade is answered");
    raw
}

/// The upgrade request as a client writes it, grown to `len` bytes with a header the framing ignores where a
/// case is about what the request itself costs a peer.
fn upgrade_request(addr: SocketAddr, len: usize) -> Vec<u8> {
    let request = |pad: usize| {
        format!(
            "GET / HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Pad: {}\r\n\r\n",
            "p".repeat(pad)
        )
    };
    let bare = request(0).len();
    request(len.saturating_sub(bare)).into_bytes()
}

/// A masked text frame as a client sends one.
fn masked_text(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x81u8, 0x80 | u8::try_from(payload.len()).unwrap()];
    frame.extend_from_slice(&[0, 0, 0, 0]);
    frame.extend_from_slice(payload);
    frame
}

/// The upgrade answer read to its blank line, leaving the frames behind it on the stream.
async fn upgrade_answer(raw: &mut TcpStream) -> String {
    let mut answer = Vec::new();
    while !answer.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        raw.read_exact(&mut byte).await.unwrap();
        answer.push(byte[0]);
    }
    String::from_utf8(answer).unwrap()
}

/// The next text frame off a raw stream, unmasked as the daemon sends it.
async fn server_text(raw: &mut TcpStream) -> Value {
    let mut head = [0u8; 2];
    raw.read_exact(&mut head).await.unwrap();
    assert_eq!(head[0], 0x81, "a text frame");
    let len = match head[1] {
        126 => {
            let mut l = [0u8; 2];
            raw.read_exact(&mut l).await.unwrap();
            usize::from(u16::from_be_bytes(l))
        }
        127 => {
            let mut l = [0u8; 8];
            raw.read_exact(&mut l).await.unwrap();
            usize::try_from(u64::from_be_bytes(l)).unwrap()
        }
        n => usize::from(n),
    };
    let mut payload = vec![0u8; len];
    raw.read_exact(&mut payload).await.unwrap();
    serde_json::from_slice(&payload).unwrap()
}

/// Reads until the peer ends the connection (EOF or a reset), within five seconds.
async fn ends(raw: &mut TcpStream) -> bool {
    let mut buf = [0u8; 1024];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, raw.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return true,
            Ok(Ok(_)) => continue,
            Err(_) => return false,
        }
    }
}

#[tokio::test]
async fn closes_4401_with_one_sentence_when_the_auth_frame_carries_the_wrong_token() {
    let d = start(None).await;
    let (c, closed) = Client::connect(d.addr, "wrong", None).await;
    assert_eq!(closed, Some(Closed { code: 4401, reason: words::AUTH_TOKEN_REFUSED.to_owned() }));
    assert!(c.frames.is_empty());
}

#[tokio::test]
async fn a_query_token_does_not_authenticate() {
    let d = start(None).await;
    let mut c = Client::open(d.addr, &format!("/?token={TOKEN}")).await;
    c.send_raw(json!({ "id": 1, "op": "ping" })).await;
    let closed = c.read_until_reply(1).await.unwrap();
    assert_eq!(closed.code, 4401);
    assert!(c.frames.is_empty());
}

#[tokio::test]
async fn closes_a_socket_whose_first_frame_is_not_auth_before_any_handler_runs() {
    let d = start(None).await;
    let mut c = Client::open(d.addr, "/").await;
    c.send_raw(json!({ "id": 1, "op": "pty.create", "shell": "bash" })).await;
    c.send_raw(json!({ "id": 2, "op": "auth", "token": TOKEN })).await;
    c.send_raw(json!({ "id": 3, "op": "pty.create", "shell": "bash" })).await;
    let closed = c.wait_closed().await;
    assert_eq!(closed, Closed { code: 4401, reason: words::AUTH_FIRST_FRAME.to_owned() });
    assert!(c.frames.is_empty(), "no reply reached the peer: {:?}", c.frames);
}

#[tokio::test]
async fn a_malformed_frame_from_a_peer_that_never_authed_ends_that_socket_and_nothing_else() {
    let d = start(None).await;
    let mut raw = upgraded(d.addr).await;
    // RSV1 set with no extension negotiated: the framing refuses the frame.
    raw.write_all(&[0xc1, 0x80, 0, 0, 0, 0]).await.unwrap();
    assert!(ends(&mut raw).await, "the daemon ends the malformed peer's connection");
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn closes_4401_a_socket_that_sends_more_than_a_few_kib_before_its_auth_frame_and_keeps_serving() {
    let d = start(None).await;
    let mut c = Client::open(d.addr, "/").await;
    c.send_raw(json!({ "id": 1, "op": "auth", "token": TOKEN, "pad": "x".repeat(16 * 1024) })).await;
    let closed = c.wait_closed().await;
    assert_eq!(closed, Closed { code: 4401, reason: words::AUTH_TOO_MANY_BYTES.to_owned() });
    assert!(c.frames.is_empty());
    // The cap is for the pre-auth window only: an authed socket sends the same bytes and is answered.
    let (mut authed, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(authed.request("ping", json!({ "pad": "x".repeat(16 * 1024) })).await["ok"], true);
}

#[tokio::test]
async fn counts_wire_bytes_not_assembled_messages_a_peer_that_never_finishes_a_huge_frame_is_cut_at_the_cap() {
    let d = start(None).await;
    let mut raw = upgraded(d.addr).await;
    // One masked text frame announcing 50 MiB, then only 8 KiB of it: under the message cap, so the framing would buffer.
    let mut header = vec![0x81u8, 0x80 | 127];
    header.extend_from_slice(&(50u64 * 1024 * 1024).to_be_bytes());
    header.extend_from_slice(&[0, 0, 0, 0]);
    header.extend(std::iter::repeat_n(0x20u8, 8 * 1024));
    raw.write_all(&header).await.unwrap();
    let mut close = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), raw.read(&mut close)).await.unwrap().unwrap();
    assert!(n >= 4, "a close frame came back");
    assert_eq!(close[0], 0x88, "the first frame back is a close");
    assert_eq!(u16::from_be_bytes([close[2], close[3]]), 4401);
    let reason = String::from_utf8_lossy(&close[4..n]).into_owned();
    assert_eq!(reason, words::AUTH_TOO_MANY_BYTES);
    // Anything more from that peer ends the connection outright.
    raw.write_all(&vec![0x20u8; 8 * 1024]).await.unwrap();
    assert!(ends(&mut raw).await);
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn counts_the_bytes_the_upgrade_reads_for_a_head_that_never_ends_against_the_pre_auth_cap() {
    // A deadline long enough that what cuts this peer is the cap and not the clock.
    let d = start(Some(30_000)).await;
    let mut raw = TcpStream::connect(d.addr).await.unwrap();
    // A request head with no blank line: the door reads its own ceiling of it and leaves the rest to the
    // framing, whose reads off the socket are the peer's own bytes.
    let mut head = upgrade_request(d.addr, 16 * 1024);
    head.truncate(head.len() - 4);
    raw.write_all(&head).await.unwrap();
    raw.write_all(&vec![b'p'; 8 * 1024]).await.unwrap();
    assert!(ends(&mut raw).await, "the peer is cut at the pre-auth cap, not at the framing's own ceiling");
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn an_upgrade_request_of_its_own_costs_a_client_nothing_of_the_pre_auth_cap() {
    let d = start(None).await;
    let mut raw = TcpStream::connect(d.addr).await.unwrap();
    // A head twice the cap and well under the door's ceiling: it is the upgrade request, not the peer's frame.
    raw.write_all(&upgrade_request(d.addr, 8 * 1024)).await.unwrap();
    assert!(upgrade_answer(&mut raw).await.starts_with("HTTP/1.1 101"), "the upgrade is answered");
    raw.write_all(&masked_text(json!({ "id": 1, "op": "auth", "token": TOKEN }).to_string().as_bytes())).await.unwrap();
    let reply = server_text(&mut raw).await;
    assert_eq!(reply["id"], json!(1));
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(server_text(&mut raw).await["type"], "daemon.hello");
}

#[tokio::test]
async fn a_socket_authed_for_one_port_is_answered_ping_and_tunnel_ops_on_that_port_alone() {
    let d = start(None).await;
    // Answers only once asked, so the tunnel is still open when the write arrives.
    let guest = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let guest_port = guest.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = guest.accept().await {
            let mut buf = [0u8; 64];
            let _ = s.read(&mut buf).await;
            let _ = s.write_all(b"hello from the guest").await;
        }
    });
    let (mut c, closed) = Client::connect(d.addr, TOKEN, Some(u32::from(guest_port))).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    let refused = json!({ "ok": false, "code": "forbidden", "error": words::port_scope_refusal(guest_port) });
    for (op, params) in [
        ("pty.create", json!({ "shell": "bash" })),
        ("pty.list", json!({})),
        ("fs.list", json!({ "path": "." })),
        ("git.status", json!({ "cwd": "." })),
        ("ports.watch", json!({})),
        ("sys.watch", json!({})),
        ("proc.watch", json!({})),
        ("proc.inspect", json!({ "pid": 1 })),
        ("proc.kill", json!({ "pid": 1, "signal": "TERM" })),
        ("manifest.get", json!({})),
        ("tunnel.open", json!({ "tunnelId": "other", "port": guest_port + 1 })),
    ] {
        let mut r = c.request(op, params).await;
        r.as_object_mut().unwrap().remove("id");
        assert_eq!(r, refused, "{op}");
    }
    assert_eq!(c.request("tunnel.open", json!({ "tunnelId": "t1", "port": guest_port })).await["ok"], true);
    assert_eq!(c.request("tunnel.write", json!({ "tunnelId": "t1", "data": b64(b"GET") })).await["ok"], true);
    assert!(c.wait_event("tunnel.end", WAIT, |_| true).await, "the guest ends the connection after its answer");
    let data: Vec<u8> = c.events("tunnel.data").iter().flat_map(|e| unb64(e["data"].as_str().unwrap())).collect();
    assert_eq!(data, b"hello from the guest");
    assert_eq!(c.request("tunnel.close", json!({ "tunnelId": "t1" })).await["ok"], true);
    c.every_event_parses();
    // An unscoped socket on the same token gets past the scope check on every op.
    let mut full = authed(&d).await;
    assert_ne!(full.request("manifest.get", json!({})).await["code"], "forbidden");
}

#[tokio::test]
async fn refuses_an_auth_frame_whose_port_is_not_a_port() {
    let d = start(None).await;
    let (_, closed) = Client::connect(d.addr, TOKEN, Some(70000)).await;
    assert_eq!(closed, Some(Closed { code: 4401, reason: words::AUTH_FIRST_FRAME.to_owned() }));
    let (_, closed) = Client::connect(d.addr, TOKEN, Some(0)).await;
    assert_eq!(closed, Some(Closed { code: 4401, reason: words::AUTH_FIRST_FRAME.to_owned() }));
}

#[tokio::test]
async fn ignores_an_exported_token_the_file_is_the_only_source() {
    std::env::set_var("WSP_DAEMON_TOKEN", "fromenv");
    let d = start(None).await;
    rotate(d.token.path(), "fromfile");
    let (_, closed) = Client::connect(d.addr, "fromenv", None).await;
    assert_eq!(closed.map(|c| c.code), Some(4401));
    let (mut file, closed) = Client::connect(d.addr, "fromfile", None).await;
    assert_eq!(closed, None);
    assert_eq!(file.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn closes_a_socket_that_sends_nothing_before_the_auth_deadline() {
    let d = start(Some(60)).await;
    let mut c = Client::open(d.addr, "/").await;
    let closed = c.wait_closed().await;
    assert_eq!(closed, Closed { code: 4401, reason: words::AUTH_NO_FRAME_IN_TIME.to_owned() });
}

#[tokio::test]
async fn checks_each_auth_frame_against_the_token_file_as_it_is_now() {
    let d = start(None).await;
    rotate(d.token.path(), "first");
    let (mut c1, closed) = Client::connect(d.addr, "first", None).await;
    assert_eq!(closed, None);
    assert_eq!(c1.request("ping", json!({})).await["ok"], true);
    rotate(d.token.path(), "second");
    let (_, stale) = Client::connect(d.addr, "first", None).await;
    assert_eq!(stale.map(|c| c.code), Some(4401));
    let (mut fresh, closed) = Client::connect(d.addr, "second", None).await;
    assert_eq!(closed, None);
    assert_eq!(fresh.request("ping", json!({})).await["ok"], true);
    // An authed socket stays authed through the rotation; only new dials are checked.
    assert_eq!(c1.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn answers_the_auth_frame_then_greets_with_its_root_and_version_before_anything_else() {
    let d = start(None).await;
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    assert_eq!(
        c.frames[..2],
        [
            json!({ "id": 1, "ok": true }),
            json!({ "type": "daemon.hello", "root": d.root.path().to_str().unwrap(), "version": numbers::DAEMON_VERSION })
        ]
    );
    assert_eq!(c.frames[2], json!({ "id": 2, "ok": true }));
}

#[tokio::test]
async fn answers_an_op_it_does_not_know_with_an_error_naming_it_never_with_silence() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(c.request("sys.explode", json!({})).await, json!({ "id": 2, "ok": false, "error": "unknown op: sys.explode" }));
}

#[tokio::test]
async fn answers_invalid_json_under_a_null_id_and_keeps_the_socket() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    c.ws.send(Message::text("{not json")).await.unwrap();
    // The hello is still in the stream; the answer to the bad frame is the first reply after it.
    let answer = loop {
        match c.ws.next().await.unwrap().unwrap() {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v.get("type").is_none() {
                    break v;
                }
            }
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(answer, json!({ "id": null, "ok": false, "error": "invalid json" }));
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn answers_a_json_value_that_is_not_an_object_as_an_unknown_op_as_the_node_daemon_does() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    for raw in ["[1,2,3]", "42", "\"x\""] {
        c.ws.send(Message::text(raw)).await.unwrap();
        match c.ws.next().await.unwrap().unwrap() {
            Message::Text(t) => assert_eq!(
                serde_json::from_str::<Value>(&t).unwrap(),
                json!({ "id": null, "ok": false, "error": "unknown op: undefined" }),
                "{raw}"
            ),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn refuses_the_link_only_ops_on_an_inbound_socket_with_the_road_sentence() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    let r = c.request("machine.create", json!({})).await;
    assert_eq!(r, json!({ "id": 2, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD }));
    let r = c.request("place.leave", json!({})).await;
    assert_eq!(r, json!({ "id": 3, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD }));
}

#[tokio::test]
async fn answers_the_listing_and_a_workspace_reading_on_an_inbound_socket_holding_the_token() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    // A socket that dialled in with the token, which is the only client this daemon has on the box itself. Neither
    // op is refused the road; this daemon runs no workspaces, so both answer for the backend it has not got.
    for (n, op) in [(2, "machine.list"), (3, "machine.metrics")] {
        let r = c.request(op, json!({ "machineId": "wsp-x" })).await;
        assert_eq!(r, json!({ "id": n, "ok": false, "error": format!("this computer's backend has no {op}") }), "{op}");
    }
    // And the socket carries on: a refused road is not a socket the daemon gave up on.
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn refuses_to_start_without_a_token_to_check_against() {
    let missing = Options::new("/nonexistent/wsp-daemon-token");
    let err = Daemon::bind(missing).await.err().expect("no daemon without a token");
    assert_eq!(err.to_string(), words::NO_TOKEN_AT_START);
    let blank = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(blank.path(), "  \n").unwrap();
    let mut options = Options::new(blank.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    assert_eq!(Daemon::bind(options).await.err().map(|e| e.to_string()), Some(words::NO_TOKEN_AT_START.to_owned()));
}

#[tokio::test]
async fn exec_answers_a_command_on_an_authed_socket() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let res = c.request("exec", json!({ "cmd": "echo hello; pwd", "timeoutMs": 5000 })).await;
    assert_eq!((res["ok"].as_bool(), res["exitCode"].as_i64(), res["truncated"].as_bool()), (Some(true), Some(0), Some(false)));
    let stdout = res["stdout"].as_str().unwrap();
    assert!(stdout.contains("hello"), "{stdout}");
    // The daemon's root, not its working directory: a place's daemon is rooted at the person's home.
    assert!(stdout.contains(d.root.path().to_str().unwrap()), "{stdout}");
    assert_eq!(res["stderr"], "");
}

#[tokio::test]
async fn exec_refuses_a_frame_whose_cmd_is_not_a_string_and_one_whose_timeout_is_not_a_positive_integer() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    assert_eq!(c.request("exec", json!({ "cmd": 3 })).await["ok"], false);
    assert_eq!(c.request("exec", json!({ "cmd": "echo x", "timeoutMs": -1 })).await["ok"], false);
    assert_eq!(c.request("exec", json!({ "cmd": "echo x", "stdin": 3 })).await["ok"], false);
    // stdin is base64 bytes and the deadline is the request's own.
    let res = c.request("exec", json!({ "cmd": "cat", "stdin": "aGVsbG8=", "timeoutMs": 5000 })).await;
    assert_eq!(res["stdout"], "hello");
    let late = c.request("exec", json!({ "cmd": "sleep 5; echo late", "timeoutMs": 200 })).await;
    assert_eq!(late["exitCode"], numbers::EXEC_DEADLINE_EXIT);
    assert_eq!(late["stdout"], "");
}

#[tokio::test]
async fn serves_ptys_that_survive_a_client_disconnect_replaying_to_the_next_client() {
    let d = start(None).await;
    let mut c1 = authed(&d).await;
    let pty_id = bash_pty(&mut c1).await;
    assert_eq!(c1.request("pty.write", json!({ "ptyId": pty_id, "data": "echo WIRE-$((20+3))\n" })).await["ok"], true);
    assert!(c1.wait_text("WIRE-23", WAIT).await, "{:?}", c1.pty_text());
    c1.every_event_parses();
    drop(c1);

    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut c2 = authed(&d).await;
    let listed = c2.request("pty.list", json!({})).await;
    let entry = listed["ptys"].as_array().unwrap().iter().find(|p| p["id"] == pty_id).cloned().expect("the pty is still held");
    assert_eq!((entry["exited"].as_bool(), entry["cols"].as_u64(), entry["rows"].as_u64()), (Some(false), Some(80), Some(24)));

    assert_eq!(c2.request("pty.write", json!({ "ptyId": pty_id, "data": "echo SECOND-CLIENT\n" })).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c2.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c2.wait_text("SECOND-CLIENT", WAIT).await, "{:?}", c2.pty_text());
    let seen = c2.pty_text();
    assert!(seen.contains("WIRE-23"), "{seen:?}");
    assert!(seen.contains("SECOND-CLIENT"), "{seen:?}");
    assert_eq!(c2.request("nonsense.op", json!({})).await["ok"], false);
    c2.every_event_parses();
    assert_eq!(c2.request("pty.kill", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c2.request("pty.list", json!({})).await["ptys"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn pty_exit_carries_the_shells_code_and_a_late_attach_hears_it_at_once() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let pty_id = bash_pty(&mut c).await;
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "exit 7\n" })).await["ok"], true);
    assert!(c.wait_event("pty.exit", WAIT, |_| true).await, "the pty exits");
    let exit = &c.events("pty.exit")[0];
    assert_eq!((exit["ptyId"].as_str(), exit["exitCode"].as_i64()), (Some(pty_id.as_str()), Some(7)));
    assert!(exit.get("signal").is_none(), "{exit}");
    let listed = c.request("pty.list", json!({})).await;
    assert_eq!(listed["ptys"].as_array().unwrap().iter().find(|p| p["id"] == pty_id).unwrap()["exited"], true);
    // A late attach to the dead pty still replays what it printed and says it exited, before the reply.
    let mut c2 = authed(&d).await;
    assert_eq!(c2.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c2.events("pty.exit").len(), 1, "{:?}", c2.frames);
    assert!(c2.pty_text().contains("exit 7"), "{:?}", c2.pty_text());
    assert!(c2.events("pty.mode").is_empty());
    c.every_event_parses();
    c2.every_event_parses();
}

#[tokio::test]
async fn a_printed_url_in_a_pty_names_the_callback_port_even_when_no_shim_ran() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let created = c.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let line = format!("printf '%s\\n' 'Visit: {MCP_REMOTE}'\n");
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": line })).await["ok"], true);
    assert!(c.wait_event("callback.port", WAIT, |_| true).await, "{:?}", c.frames);
    c.listen(Duration::from_millis(300)).await;
    assert_eq!(c.events("callback.port"), [json!({ "type": "callback.port", "port": 22227 })]);
    assert!(c.events("browser.open").is_empty());
    c.every_event_parses();
}

#[tokio::test]
async fn a_local_url_printed_in_a_pty_becomes_one_localhost_url_with_its_port_on_every_authed_socket() {
    let d = start(None).await;
    let mut a = authed(&d).await;
    let mut b = authed(&d).await;
    let created = a.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    // The typed command echoes with the URL in it and the output prints it again: one event.
    let line = "printf '%s\\n' 'Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...'\n";
    assert_eq!(a.request("pty.write", json!({ "ptyId": pty_id, "data": line })).await["ok"], true);
    assert!(a.wait_event("localhost.url", WAIT, |_| true).await, "{:?}", a.frames);
    assert!(b.wait_event("localhost.url", WAIT, |_| true).await, "{:?}", b.frames);
    a.listen(Duration::from_millis(300)).await;
    b.listen(Duration::from_millis(300)).await;
    assert_eq!(a.events("localhost.url"), [json!({ "type": "localhost.url", "port": 8123 })]);
    assert_eq!(b.events("localhost.url"), [json!({ "type": "localhost.url", "port": 8123 })]);
    assert!(a.events("callback.port").is_empty() && a.events("browser.open").is_empty());
    a.every_event_parses();
    b.every_event_parses();
}

#[tokio::test]
async fn a_port_scoped_socket_hears_nothing_a_pty_prints() {
    let d = start(None).await;
    let mut a = authed(&d).await;
    let (mut scoped, closed) = Client::connect(d.addr, TOKEN, Some(8123)).await;
    assert_eq!(closed, None);
    let created = a.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let line = "printf '%s\\n' 'Local: http://localhost:5173/'\n";
    assert_eq!(a.request("pty.write", json!({ "ptyId": pty_id, "data": line })).await["ok"], true);
    assert!(a.wait_event("localhost.url", WAIT, |_| true).await);
    scoped.listen(Duration::from_millis(300)).await;
    assert!(scoped.events("localhost.url").is_empty(), "{:?}", scoped.frames);
}

#[tokio::test]
async fn the_shell_it_spawns_is_a_login_shell_that_reads_the_profile_of_the_home_it_is_given() {
    let d = start(None).await;
    let home = tempfile::tempdir().unwrap();
    for rc in [".profile", ".bash_profile", ".zprofile"] {
        std::fs::write(home.path().join(rc), "echo WSP-LOGIN-PROFILE\n").unwrap();
    }
    let mut c = authed(&d).await;
    let home_str = home.path().to_str().unwrap();
    let env = json!({ "HOME": home_str, "ZDOTDIR": home_str });
    let created = c.request("pty.create", json!({ "cols": 80, "rows": 24, "cwd": home_str, "env": env })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c.wait_text("WSP-LOGIN-PROFILE", WAIT).await, "{:?}", c.pty_text());
    // The pty starts where the request said, with the environment it named.
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo CWD=$PWD HOME=$HOME\n" })).await["ok"], true);
    let want = format!("CWD={home_str} HOME={home_str}\r");
    assert!(c.wait_text(&want, WAIT).await, "{:?}", c.pty_text());
    c.every_event_parses();
}

#[tokio::test]
async fn pty_mode_on_attach_reads_the_real_slave_and_a_resize_reaches_the_shell() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let pty_id = bash_pty(&mut c).await;
    assert!(c.wait_event("pty.mode", WAIT, |e| e["foreground"] == "bash").await, "{:?}", c.frames);
    assert_eq!(c.request("pty.resize", json!({ "ptyId": pty_id, "cols": 120, "rows": 40 })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "stty size\n" })).await["ok"], true);
    assert!(c.wait_text("40 120", WAIT).await, "{:?}", c.pty_text());
    let listed = c.request("pty.list", json!({})).await;
    let entry = listed["ptys"].as_array().unwrap().iter().find(|p| p["id"] == pty_id).cloned().unwrap();
    assert_eq!((entry["cols"].as_u64(), entry["rows"].as_u64()), (Some(120), Some(40)));
    // At its prompt bash holds the slave in whichever mode readline left it; cat in the foreground is cooked, echo on.
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "cat\n" })).await["ok"], true);
    assert!(c.wait_event("pty.mode", WAIT, |e| e["foreground"] == "cat").await, "{:?}", c.events("pty.mode"));
    let mode = c.events("pty.mode").into_iter().find(|e| e["foreground"] == "cat").unwrap();
    assert_eq!(mode, json!({ "type": "pty.mode", "ptyId": pty_id, "mode": "line", "echo": true, "foreground": "cat" }));
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "\x03" })).await["ok"], true);
    assert!(c.wait_event("pty.mode", WAIT, |e| e["foreground"] == "bash").await, "{:?}", c.events("pty.mode"));
    c.every_event_parses();
}

#[tokio::test]
async fn a_heartbeat_is_not_held_behind_a_long_exec_on_the_same_socket() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    c.send_raw(json!({ "id": 100, "op": "exec", "cmd": "sleep 1", "timeoutMs": 5000 })).await;
    c.send_raw(json!({ "id": 101, "op": "ping" })).await;
    assert_eq!(c.read_until_reply(101).await, None);
    assert!(c.frames.iter().all(|f| f["id"] != 100), "the ping was answered before the exec finished: {:?}", c.frames);
    assert_eq!(c.read_until_reply(100).await, None);
    assert_eq!(c.frames.last().unwrap()["exitCode"], 0);
}

#[tokio::test]
async fn a_flood_through_a_pty_arrives_whole_and_the_exit_comes_after_its_last_byte() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let pty_id = bash_pty(&mut c).await;
    // Two million bytes of yes: with ONLCR each y is three bytes on the wire, then a marker, then the exit.
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "yes | head -c 2000000; echo TAIL; exit 3\n" })).await["ok"], true);
    assert!(c.wait_event("pty.exit", Duration::from_secs(30), |_| true).await, "the flood and the exit land within the wait");
    let text = c.pty_text();
    assert!(text.len() >= 3_000_000, "{} bytes reached the socket", text.len());
    assert!(text.contains("TAIL"), "the marker after the flood reached the socket before the exit");
    assert_eq!(c.events("pty.exit")[0]["exitCode"], 3);
    let last = c.frames.last().unwrap();
    assert_eq!(last["type"], "pty.exit", "the exit is the last frame, after every byte");
    c.every_event_parses();
}

#[tokio::test]
async fn a_cwd_that_is_not_a_directory_refuses_the_create_and_names_it() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let r = c.request("pty.create", json!({ "shell": "bash", "cwd": "/nonexistent/dir" })).await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"], "cwd is not a directory: /nonexistent/dir");
    assert!(c.request("pty.list", json!({})).await["ptys"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn starts_in_the_cwd_the_request_names() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let asked = d.root.path().join("elsewhere");
    std::fs::create_dir(&asked).unwrap();
    // Wide, so a long temporary path is one line on the wire rather than a wrapped one.
    let created = c.request("pty.create", json!({ "cols": 200, "rows": 24, "shell": "bash", "cwd": asked.to_str().unwrap() })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo CWD=$(pwd -P)\n" })).await["ok"], true);
    // The physical path: a temporary folder sits under a symlink on darwin, and the name the request gave is the other one.
    let want = format!("CWD={}\r", std::fs::canonicalize(&asked).unwrap().display());
    assert!(c.wait_text(&want, WAIT).await, "{:?}", c.pty_text());
}

#[tokio::test]
async fn starts_in_the_home_directory_not_wherever_the_daemon_runs() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let home = std::env::var("HOME").expect("the test process has a HOME");
    let created = c.request("pty.create", json!({ "cols": 80, "rows": 24, "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo CWD=$PWD\n" })).await["ok"], true);
    let want = format!("CWD={home}\r");
    assert!(c.wait_text(&want, WAIT).await, "{:?}", c.pty_text());
}

#[tokio::test]
async fn an_unscoped_socket_tunnels_a_laptop_connection_to_a_guest_loopback_port_open_write_data_end_close() {
    let d = start(None).await;
    let server = listen_v6_only().await;
    let port = server.local_addr().unwrap().port();
    let _live = echo(server);
    let mut c = authed(&d).await;
    assert_eq!(c.request("tunnel.open", json!({ "tunnelId": "t1", "port": port })).await["ok"], true);
    let line = b"GET /oauth/callback?code=x HTTP/1.1\r\n";
    assert_eq!(c.request("tunnel.write", json!({ "tunnelId": "t1", "data": b64(line) })).await["ok"], true);
    assert!(c.wait_event("tunnel.data", WAIT, |_| true).await);
    let data = unb64(c.events("tunnel.data")[0]["data"].as_str().unwrap());
    assert_eq!(data, [b"echo:", &line[..]].concat());
    assert_eq!(c.request("tunnel.close", json!({ "tunnelId": "t1" })).await["ok"], true);
    assert!(c.wait_event("tunnel.end", WAIT, |e| e["tunnelId"] == "t1").await, "the close ends the stream and says so");
    let late = c.request("tunnel.write", json!({ "tunnelId": "t1", "data": "" })).await;
    assert_eq!((late["ok"].as_bool(), late["code"].as_str()), (Some(false), Some("not-found")));
    assert_eq!(late["error"], "no such tunnel: t1");
    c.every_event_parses();
}

#[tokio::test]
async fn an_unscoped_socket_holds_at_most_the_cap_of_tunnels_at_once_and_a_second_open_under_one_id_is_refused() {
    let d = start(None).await;
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = server.local_addr().unwrap().port();
    let live = echo(server);
    let mut c = authed(&d).await;
    for i in 0..numbers::TUNNEL_CAP {
        assert_eq!(c.request("tunnel.open", json!({ "tunnelId": format!("t{i}"), "port": port })).await["ok"], true, "tunnel {i}");
    }
    let over = c.request("tunnel.open", json!({ "tunnelId": "one-more", "port": port })).await;
    assert_eq!(
        over,
        json!({ "id": over["id"], "ok": false, "code": "bad-request", "error": format!("too many tunnels open ({})", numbers::TUNNEL_CAP) })
    );
    let dup = c.request("tunnel.open", json!({ "tunnelId": "t0", "port": port })).await;
    assert_eq!((dup["code"].as_str(), dup["error"].as_str()), (Some("bad-request"), Some("tunnel t0 is already open")));
    // Every one of them carries bytes both ways, and closing one frees its place.
    assert_eq!(c.request("tunnel.write", json!({ "tunnelId": "t63", "data": b64(b"x") })).await["ok"], true);
    assert!(c.wait_event("tunnel.data", WAIT, |e| e["tunnelId"] == "t63").await);
    assert_eq!(c.request("tunnel.close", json!({ "tunnelId": "t63" })).await["ok"], true);
    assert!(c.wait_event("tunnel.end", WAIT, |e| e["tunnelId"] == "t63").await);
    assert_eq!(c.request("tunnel.open", json!({ "tunnelId": "one-more", "port": port })).await["ok"], true);
    assert_eq!(live.load(Ordering::SeqCst), numbers::TUNNEL_CAP);
    // The tunnels die with the socket: the guest sees every connection end, and the next client starts from nothing.
    c.close_ws().await;
    let deadline = tokio::time::Instant::now() + WAIT;
    while live.load(Ordering::SeqCst) > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(live.load(Ordering::SeqCst), 0, "the guest side still holds connections after the socket went");
    let mut again = authed(&d).await;
    for i in 0..numbers::TUNNEL_CAP {
        assert_eq!(again.request("tunnel.open", json!({ "tunnelId": format!("t{i}"), "port": port })).await["ok"], true, "tunnel {i}");
    }
}

#[tokio::test]
async fn refuses_a_bad_port_a_duplicate_id_and_a_port_nothing_listens_on() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let zero = c.request("tunnel.open", json!({ "tunnelId": "x", "port": 0 })).await;
    assert_eq!((zero["ok"].as_bool(), zero["code"].as_str()), (Some(false), Some("bad-request")));
    let port = refused_port().await;
    let refused = c.request("tunnel.open", json!({ "tunnelId": "x", "port": port })).await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"], format!("connect ECONNREFUSED ::1:{port}"));
    assert!(refused.get("code").is_none(), "a failed dial is a plain failure, as under node: {refused}");
    let ending = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = ending.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((s, _)) = ending.accept().await {
            drop(s);
        }
    });
    assert_eq!(c.request("tunnel.open", json!({ "tunnelId": "dup", "port": port })).await["ok"], true);
    assert!(c.wait_event("tunnel.end", WAIT, |e| e["tunnelId"] == "dup").await);
    // The guest ended it, so the id is free again and a plain open under it is not a duplicate.
    assert_eq!(c.request("tunnel.open", json!({ "tunnelId": "dup", "port": port })).await["ok"], true);
    c.every_event_parses();
}

#[tokio::test]
async fn ports_watch_replies_with_current_ports_and_pushes_open_and_close_events() {
    let proc_root = FakeProc::new();
    proc_root.comm(50, "node");
    let d = start_with(|o| {
        o.proc_root = Some(proc_root.path());
        o.ports_interval_ms = Some(25);
    })
    .await;
    let mut c = authed(&d).await;
    let res = c.request("ports.watch", json!({})).await;
    assert_eq!(res["ok"], true);
    assert_eq!(res["ports"], json!([]));

    // The fake machine's node holds 8080 for a while: the daemon reads it off the tree's net/tcp and its fd table.
    proc_root.set_listeners(&[(8080, 50, false)]);
    assert!(c.wait_event("port.open", WAIT, |e| e["port"] == 8080).await);
    assert_eq!(c.events("port.open"), [json!({ "type": "port.open", "port": 8080, "pid": 50, "process": "node", "loopback": false })]);
    proc_root.set_listeners(&[]);
    assert!(c.wait_event("port.close", WAIT, |e| e["port"] == 8080).await);
    let closed = &c.events("port.close")[0];
    assert_eq!((closed["pid"].as_u64(), closed["process"].as_str(), closed["command"].as_str()), (Some(50), Some("node"), Some("node")));
    assert!(closed["at"].as_str().unwrap().ends_with('Z'));
    assert!(closed["exited"].is_boolean());

    // A second watcher on the same daemon is seeded with what is listening now, off the one poller.
    proc_root.set_listeners(&[(3000, 51, true)]);
    tokio::time::sleep(Duration::from_millis(120)).await;
    let mut second = authed(&d).await;
    let seeded = second.request("ports.watch", json!({})).await;
    assert_eq!(
        seeded["ports"],
        json!([{ "port": 3000, "pid": 51, "inode": 103000, "uid": 0, "process": "p51", "command": "p51", "loopback": true }])
    );
    c.every_event_parses();
}

#[tokio::test]
async fn manifest_record_get_and_restart_script_round_trip_over_the_wire() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let rec = c.request("manifest.record", json!({ "cmd": "pnpm dev", "cwd": "/root/app", "port": 5173 })).await;
    assert_eq!(rec["ok"], true);
    assert_eq!(
        (rec["entry"]["cmd"].as_str(), rec["entry"]["cwd"].as_str(), rec["entry"]["port"].as_u64()),
        (Some("pnpm dev"), Some("/root/app"), Some(5173))
    );
    let got = c.request("manifest.get", json!({})).await;
    assert_eq!(got["entries"].as_array().unwrap().len(), 1);
    let script = c.request("manifest.restartScript", json!({})).await;
    let script = script["script"].as_str().unwrap();
    assert!(script.contains("pnpm dev"));
    assert!(script.contains("port_listening '1435'"), "5173 in hex");
    // Persisted where the daemon was told, so a daemon started later over the same file knows the entry.
    let saved = std::fs::read_to_string(d.root.path().join("manifest.json")).unwrap();
    assert!(saved.contains("pnpm dev"));
}

#[tokio::test]
async fn inbox_watch_pushes_inbox_file_once_a_dropped_file_settles() {
    let inbox = tempfile::tempdir().unwrap();
    let d = start_with(|o| {
        o.inbox_dir = Some(inbox.path().to_path_buf());
        o.inbox_quiet_ms = Some(150);
        o.inbox_poll_ms = Some(30);
    })
    .await;
    let mut c = authed(&d).await;
    assert_eq!(c.request("inbox.watch", json!({})).await["ok"], true);
    let file = inbox.path().join("upload.bin");
    std::fs::write(&file, "z".repeat(64)).unwrap();
    let path = file.to_str().unwrap();
    assert!(c.wait_event("inbox.file", WAIT, |e| e["path"] == path).await);
    assert_eq!(c.events("inbox.file"), [json!({ "type": "inbox.file", "path": path, "bytes": 64 })]);
    // Settled once: nothing more for the same file.
    c.listen(Duration::from_millis(300)).await;
    assert_eq!(c.events("inbox.file").len(), 1);
    c.every_event_parses();
}

#[tokio::test]
async fn inbox_rescan_replays_every_existing_file_as_an_inbox_file_event_before_the_reply() {
    let inbox = tempfile::tempdir().unwrap();
    std::fs::write(inbox.path().join("a.png"), "a".repeat(10)).unwrap();
    std::fs::write(inbox.path().join("b.bin"), "b".repeat(20)).unwrap();
    let d = start_with(|o| {
        o.inbox_dir = Some(inbox.path().to_path_buf());
        o.inbox_quiet_ms = Some(50);
        o.inbox_poll_ms = Some(25);
    })
    .await;
    let mut c = authed(&d).await;
    let res = c.request("inbox.rescan", json!({})).await;
    assert_eq!(res["ok"], true);
    assert_eq!(res["count"], 2);
    // Both events land before the reply does, on the one socket.
    let reply_at = c.frames.iter().position(|f| f == &res).unwrap();
    let before: Vec<&Value> = c.frames[..reply_at].iter().filter(|f| f["type"] == "inbox.file").collect();
    assert_eq!(before.len(), 2);
    let a = json!({ "type": "inbox.file", "path": inbox.path().join("a.png").to_str().unwrap(), "bytes": 10 });
    let b = json!({ "type": "inbox.file", "path": inbox.path().join("b.bin").to_str().unwrap(), "bytes": 20 });
    assert!(before.contains(&&a) && before.contains(&&b), "{before:?}");
    c.every_event_parses();
}

#[tokio::test]
async fn a_shim_post_becomes_browser_open_on_every_authed_unscoped_socket_with_the_port_when_the_url_names_one() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("open.sock");
    let d = start_with(|o| o.open_socket_path = Some(sock.clone())).await;
    let mut a = authed(&d).await;
    let mut b = authed(&d).await;
    let (mut scoped, closed) = Client::connect(d.addr, TOKEN, Some(8123)).await;
    assert_eq!(closed, None);
    assert_eq!(shim(&sock, WRANGLER).await, "HTTP/1.1 204 No Content");
    assert!(a.wait_event("browser.open", WAIT, |_| true).await);
    assert!(b.wait_event("browser.open", WAIT, |_| true).await);
    let expected = json!({ "type": "browser.open", "url": WRANGLER, "port": 8976 });
    assert_eq!(a.events("browser.open"), std::slice::from_ref(&expected));
    assert_eq!(b.events("browser.open"), [expected]);
    // A port-scoped socket is there to tunnel one port and hears none of it.
    scoped.listen(Duration::from_millis(200)).await;
    assert!(scoped.events("browser.open").is_empty(), "{:?}", scoped.frames);
    // What the socket refuses never reaches a client.
    assert_eq!(shim(&sock, "file:///etc/passwd").await, "HTTP/1.1 400 Bad Request");
    let mut s = UnixStream::connect(&sock).await.unwrap();
    s.write_all(b"POST /other HTTP/1.1\r\nContent-Length: 0\r\n\r\n").await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 404 "), "{out}");
    a.listen(Duration::from_millis(150)).await;
    assert_eq!(a.events("browser.open").len(), 1);
    a.every_event_parses();
}

#[tokio::test]
async fn a_url_without_a_port_is_followed_by_callback_port_once_a_loopback_listener_appears() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("open.sock");
    let proc_root = FakeProc::new();
    let d = start_with(|o| {
        o.open_socket_path = Some(sock.clone());
        o.proc_root = Some(proc_root.path());
        o.ports_interval_ms = Some(20);
    })
    .await;
    let mut c = authed(&d).await;
    assert_eq!(c.request("ports.watch", json!({})).await["ok"], true);
    assert_eq!(shim(&sock, GH_DEVICE).await, "HTTP/1.1 204 No Content");
    assert!(c.wait_event("browser.open", WAIT, |_| true).await);
    assert_eq!(c.events("browser.open"), [json!({ "type": "browser.open", "url": GH_DEVICE })]);
    proc_root.set_listeners(&[(3000, 1, false), (45543, 2, true)]);
    assert!(c.wait_event("callback.port", WAIT, |_| true).await);
    assert_eq!(c.events("callback.port"), [json!({ "type": "callback.port", "port": 45543 })]);
    assert!(c.wait_event("port.open", WAIT, |e| e["port"] == 45543).await);
    assert_eq!(c.events("port.open").iter().find(|e| e["port"] == 45543).unwrap()["loopback"], true);
    c.every_event_parses();
}

#[tokio::test]
async fn a_listener_already_on_the_machine_when_the_watcher_first_polls_is_never_the_flows_even_for_an_open_that_came_first() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("open.sock");
    let proc_root = FakeProc::new();
    // Listening before anyone asked for ports, so the watcher's first poll finds it there.
    proc_root.set_listeners(&[(3000, 1, true)]);
    let d = start_with(|o| {
        o.open_socket_path = Some(sock.clone());
        o.proc_root = Some(proc_root.path());
        o.ports_interval_ms = Some(20);
    })
    .await;
    let mut c = authed(&d).await;
    // The open arrives before anyone has asked for ports; the watcher's first poll must not answer it with 3000.
    assert_eq!(shim(&sock, GH_DEVICE).await, "HTTP/1.1 204 No Content");
    assert!(c.wait_event("browser.open", WAIT, |_| true).await);
    // The reply still seeds the subscriber with what was already listening.
    let watched = c.request("ports.watch", json!({})).await;
    let ports: Vec<u64> = watched["ports"].as_array().unwrap().iter().map(|p| p["port"].as_u64().unwrap()).collect();
    assert_eq!(ports, [3000]);
    c.listen(Duration::from_millis(150)).await;
    assert!(c.events("callback.port").is_empty());
    proc_root.set_listeners(&[(3000, 1, true), (45543, 2, true)]);
    assert!(c.wait_event("callback.port", WAIT, |_| true).await);
    assert_eq!(c.events("callback.port"), [json!({ "type": "callback.port", "port": 45543 })]);
    c.every_event_parses();
}

#[tokio::test]
async fn a_local_url_posted_to_the_shim_is_a_localhost_url_to_every_authed_socket_and_no_page() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("open.sock");
    let d = start_with(|o| o.open_socket_path = Some(sock.clone())).await;
    let mut c = authed(&d).await;
    assert_eq!(shim(&sock, "http://localhost:8123/").await, "HTTP/1.1 204 No Content");
    assert!(c.wait_event("localhost.url", WAIT, |_| true).await);
    assert_eq!(c.events("localhost.url"), [json!({ "type": "localhost.url", "port": 8123 })]);
    // A local authorize page whose redirect names a port is both: the page to click and a local URL.
    let local_authorize = "http://localhost:54321/auth/v1/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb";
    assert_eq!(shim(&sock, local_authorize).await, "HTTP/1.1 204 No Content");
    assert!(c.wait_event("browser.open", WAIT, |_| true).await);
    assert!(c.wait_event("localhost.url", WAIT, |e| e["port"] == 54321).await);
    assert_eq!(c.events("browser.open"), [json!({ "type": "browser.open", "url": local_authorize, "port": 8976 })]);
    c.every_event_parses();
}

#[tokio::test]
async fn answers_a_plain_http_request_426_upgrade_required_which_is_what_the_status_probe_reads_as_a_daemon() {
    let d = start(None).await;
    let mut raw = TcpStream::connect(d.addr).await.unwrap();
    raw.write_all(format!("GET / HTTP/1.1\r\nHost: {}\r\nAccept: */*\r\n\r\n", d.addr).as_bytes()).await.unwrap();
    let mut answer = String::new();
    raw.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 426 Upgrade Required\r\n"), "{answer:?}");
    assert!(answer.contains("\r\nContent-Length: 0\r\n"), "{answer:?}");
    // The door still serves: the same daemon takes an upgrade and its auth frame after.
    let mut c = authed(&d).await;
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

/// A second attach on one socket replaces the first, and a detach takes that socket's listeners off while every
/// other socket keeps reading. On the road a workspace's pane takes, every pane of a computer rides one socket to
/// its daemon, so an attach that added a second listener would print every byte twice and a closed tab would keep
/// its pty's bytes riding that socket for the pty's life.
#[tokio::test]
async fn a_second_attach_on_one_socket_prints_each_byte_once_and_a_detach_stops_that_socket_alone() {
    let d = start(None).await;
    let mut a = authed(&d).await;
    let pty_id = bash_pty(&mut a).await;
    let mut b = authed(&d).await;
    assert_eq!(b.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    // The same socket attaches again, as a reload of the app does over a link it shares with its other panes.
    assert_eq!(a.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(a.request("pty.write", json!({ "ptyId": pty_id, "data": "echo ONCE-$((20+3))\n" })).await["ok"], true);
    assert!(a.wait_text("ONCE-23", WAIT).await, "{:?}", a.pty_text());
    a.listen(Duration::from_millis(300)).await;
    assert_eq!(a.pty_text().matches("ONCE-23").count(), 1, "the shell's answer reached this socket twice: {:?}", a.pty_text());

    // Detached, this socket hears no more of that pty; the other socket hears every byte.
    assert_eq!(a.request("pty.detach", json!({ "ptyId": pty_id })).await["ok"], true);
    let before = a.pty_text();
    assert_eq!(b.request("pty.write", json!({ "ptyId": pty_id, "data": "echo AFTER-DETACH\n" })).await["ok"], true);
    assert!(b.wait_text("AFTER-DETACH", WAIT).await, "{:?}", b.pty_text());
    a.listen(Duration::from_millis(300)).await;
    assert_eq!(a.pty_text(), before, "a detached socket was still sent the pty's bytes");
    // A pty nobody opened is named, as every other pty op names one.
    assert_eq!(a.request("pty.detach", json!({ "ptyId": "pty_9" })).await["error"], "no such pty: pty_9");
    a.every_event_parses();
    b.every_event_parses();
}

/// The token file is the gate on the port, and a rotation only means something if it takes the sockets the old
/// token opened with it. Reading the file at the auth frame alone left a box that held the old token every socket
/// it had already opened, for as long as it cared to hold them.
#[tokio::test]
async fn a_rotation_cuts_the_sockets_the_old_token_opened_and_leaves_the_ones_the_new_one_did() {
    let d = start_with(|options| options.token_watch_ms = Some(50)).await;
    let mut old = authed(&d).await;
    let mut scoped = Client::connect(d.addr, TOKEN, Some(4000)).await.0;
    // The host writes the file and dials on the new token in one breath, which is what the second socket here is.
    std::fs::write(
        d.token.path(),
        "second-token
",
    )
    .unwrap();
    let (mut fresh, closed) = Client::connect(d.addr, "second-token", None).await;
    assert_eq!(closed, None);

    // Both sockets the old token opened go, the port-scoped one among them: it hears no events and still holds a
    // token the rotation took away.
    let cut = Closed { code: words::AUTH_CLOSE_CODE, reason: words::AUTH_TOKEN_ROTATED.to_owned() };
    assert_eq!(old.wait_closed().await, cut);
    assert_eq!(scoped.wait_closed().await, cut);
    // The one let in on the new token stays open through the tick and answers as it did.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fresh.request("ping", json!({})).await["ok"], true);
}

/// A socket whose token is still the file's is not cut by a tick, however many go by: the watcher takes the
/// sockets a rotation left behind and no others.
#[tokio::test]
async fn a_socket_on_the_token_the_file_holds_stands_through_every_tick() {
    let d = start_with(|options| options.token_watch_ms = Some(20)).await;
    let mut c = authed(&d).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    // The same file written with the same bytes is no rotation: nothing of what it opened goes.
    std::fs::write(d.token.path(), format!("{TOKEN}\n")).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}
