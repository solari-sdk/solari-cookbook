// SPDX-License-Identifier: AGPL-3.0-only
//! The client against a real daemon and a fake watcher standing for the host: what the open frame carries, what
//! each kind writes to which stream, and what it exits with. Nothing here is a fake socket: the frames travel the
//! wire the guest road is.

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{duplex, AsyncWriteExt, BufReader, DuplexStream};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_daemon::{Daemon, Options};
use wsp_frames::{numbers, words};
use wsp_guest::{session, Streams};

const TOKEN: &str = "guest-token-123";
const WAIT: Duration = Duration::from_secs(5);

struct Running {
    addr: SocketAddr,
    token: tempfile::NamedTempFile,
    _root: tempfile::TempDir,
}

async fn start() -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root.path().to_path_buf());
    options.manifest_path = Some(root.path().join("manifest.json"));
    let daemon = Daemon::bind(options).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    Running { addr, token, _root: root }
}

/// The host's side: one socket that watches, answers each session as the case says, and records what it was told.
struct Watcher {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Watcher {
    async fn open(addr: SocketAddr) -> Watcher {
        let (mut ws, _) = connect_async(format!("ws://{addr}/")).await.unwrap();
        ws.send(Message::text(json!({ "id": 1, "op": "auth", "token": TOKEN }).to_string())).await.unwrap();
        let mut w = Watcher { ws, next_id: 2 };
        assert_eq!(w.next_frame().await["ok"], json!(true));
        assert_eq!(w.next_frame().await["type"], "daemon.hello");
        w.request("guest.watch", json!({})).await;
        w
    }

    async fn next_frame(&mut self) -> Value {
        match tokio::time::timeout(WAIT, self.ws.next()).await.expect("a frame within five seconds") {
            Some(Ok(Message::Text(t))) => serde_json::from_str(&t).unwrap(),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    async fn next_event(&mut self) -> Value {
        loop {
            let frame = self.next_frame().await;
            if frame.get("type").is_some() {
                return frame;
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
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
        loop {
            let read = self.next_frame().await;
            if read.get("id") == Some(&json!(id)) {
                return read;
            }
        }
    }

    async fn reply(&mut self, session: &str, message: Value) {
        assert_eq!(self.request("guest.reply", json!({ "session": session, "message": message })).await["ok"], json!(true));
    }

    async fn close(&mut self, session: &str, error: Option<&str>) {
        let mut params = json!({ "session": session });
        if let Some(error) = error {
            params["error"] = json!(error);
        }
        assert_eq!(self.request("guest.close", params).await["ok"], json!(true));
    }
}

/// What a run wrote, as the two streams it wrote on.
#[derive(Clone, Default)]
struct Wrote(Arc<Mutex<Vec<u8>>>);

impl Wrote {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl tokio::io::AsyncWrite for Wrote {
    fn poll_write(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        self.0.lock().unwrap().extend_from_slice(buf);
        std::task::Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

/// One run of the client, with its stdin as a pipe the case writes into.
struct Ran {
    code: i32,
    out: String,
    err: String,
}

async fn ran(
    line: &[&str],
    env: &[(&str, &str)],
    addr: SocketAddr,
    token_path: &Path,
    drive: impl FnOnce(DuplexStream) -> tokio::task::JoinHandle<()>,
) -> Ran {
    ran_at(line, env, addr, token_path, NO_SOCKET.as_ref(), drive).await
}

/// The socket path of a machine wsp forked, which has none: the file is not there, so the dial is the port's.
static NO_SOCKET: std::sync::LazyLock<PathBuf> =
    std::sync::LazyLock::new(|| std::env::temp_dir().join("wsp-guest-no-workspace-socket/daemon.sock"));

/// The same, with the workspace socket the dial rule reads named.
async fn ran_at(
    line: &[&str],
    env: &[(&str, &str)],
    addr: SocketAddr,
    token_path: &Path,
    socket_path: &Path,
    drive: impl FnOnce(DuplexStream) -> tokio::task::JoinHandle<()>,
) -> Ran {
    let words: Vec<String> = line.iter().map(|w| (*w).to_owned()).collect();
    let held: Vec<(String, String)> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    let read = move |name: &str| held.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    let (theirs, mine) = duplex(4096);
    let driver = drive(theirs);
    let (out, err) = (Wrote::default(), Wrote::default());
    let (mut input, mut out_sink, mut err_sink) = (BufReader::new(mine), out.clone(), err.clone());
    let mut streams = Streams { input: &mut input, out: &mut out_sink, err: &mut err_sink };
    let code =
        tokio::time::timeout(WAIT, session(&words, &read, addr, token_path, socket_path, &mut streams)).await.expect("the client answers");
    driver.abort();
    Ran { code, out: out.text(), err: err.text() }
}

/// A stdin nothing ever writes to and nothing closes, for the lines that read none.
fn silent(held: DuplexStream) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _held = held;
        std::future::pending::<()>().await;
    })
}

#[tokio::test]
async fn the_tool_server_carries_lines_each_way_and_ends_on_the_hosts_close() {
    let d = start().await;
    let mut host = Watcher::open(d.addr).await;
    let answering = tokio::spawn(async move {
        let opened = host.next_event().await;
        let session = opened["session"].as_str().unwrap().to_owned();
        assert_eq!(opened["kind"], "mcp");
        assert_eq!(opened["argv"], json!(["mcp"]));
        let asked = host.next_event().await;
        assert_eq!(asked["message"], json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        host.reply(&session, json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } })).await;
        host.close(&session, None).await;
    });
    let run = ran(&["mcp"], &[("WSP_HOST_TOKEN", "dev-1.tok")], d.addr, d.token.path(), |mut theirs| {
        tokio::spawn(async move {
            theirs.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n").await.unwrap();
            std::future::pending::<()>().await;
        })
    })
    .await;
    answering.await.unwrap();
    assert_eq!(run.code, 0);
    // One message, one line; the keys come back in the order a JSON object is written in, which no reader of
    // JSON-RPC depends on.
    let printed: Vec<&str> = run.out.lines().collect();
    assert_eq!(printed.len(), 1, "{:?}", run.out);
    assert_eq!(serde_json::from_str::<Value>(printed[0]).unwrap(), json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } }));
    assert_eq!(run.err, "");
}

#[tokio::test]
async fn a_command_line_opens_as_cli_with_its_words_and_exits_with_the_code_the_host_gave() {
    let d = start().await;
    let mut host = Watcher::open(d.addr).await;
    let here = std::env::current_dir().unwrap().to_string_lossy().into_owned();
    let answering = tokio::spawn(async move {
        let opened = host.next_event().await;
        let session = opened["session"].as_str().unwrap().to_owned();
        assert_eq!(opened["kind"], "cli");
        assert_eq!(opened["argv"], json!(["threads", "--json"]));
        assert_eq!(opened["token"], "dev-1.tok");
        assert_eq!(opened["turnToken"], "9f");
        assert_eq!(opened["cwd"], here);
        host.reply(&session, json!({ "stream": "out", "text": "one\n" })).await;
        host.reply(&session, json!({ "stream": "err", "text": "a note\n" })).await;
        host.reply(&session, json!({ "stream": "out", "text": "two\n" })).await;
        host.reply(&session, json!({ "exit": 3 })).await;
    });
    let run = ran(&["threads", "--json"], &[("WSP_HOST_TOKEN", "dev-1.tok"), ("WSP_TURN", "9f")], d.addr, d.token.path(), silent).await;
    answering.await.unwrap();
    assert_eq!(run.code, 3);
    assert_eq!(run.out, "one\ntwo\n");
    assert_eq!(run.err, "a note\n");
}

#[tokio::test]
async fn a_launch_with_no_token_opens_with_none_and_prints_what_the_host_closed_it_with() {
    let d = start().await;
    let mut host = Watcher::open(d.addr).await;
    let answering = tokio::spawn(async move {
        let opened = host.next_event().await;
        assert_eq!(opened["token"], "");
        assert_eq!(opened.get("turnToken"), None);
        host.close(opened["session"].as_str().unwrap(), Some("agents on t1 may not open a thread")).await;
    });
    let run = ran(&["threads"], &[("WSP_HOST_TOKEN", "")], d.addr, d.token.path(), silent).await;
    answering.await.unwrap();
    assert_eq!(run.code, 1);
    assert_eq!(run.err, "agents on t1 may not open a thread\n");
    assert_eq!(run.out, "");
}

#[tokio::test]
async fn nothing_answering_on_the_port_is_one_line_and_a_refusal() {
    let d = start().await;
    let dead = TcpStream::connect(d.addr).await.map(|_| ()).err();
    assert!(dead.is_none(), "the daemon under test is up, so the closed port below is the only one that is not");
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        drop(listener);
        at
    };
    let run = ran(&["threads"], &[], closed, d.token.path(), silent).await;
    assert_eq!(run.code, 1);
    assert_eq!(run.err, format!("{}\n", words::guest_no_daemon_line(closed.port())));

    // A token file that is not there reads the same way: this process cannot reach its own machine's daemon.
    let run = ran(&["threads"], &[], d.addr, Path::new("/nowhere/.wsp-daemon-token"), silent).await;
    assert_eq!(run.code, 1);
    assert_eq!(run.err, format!("{}\n", words::guest_no_daemon_line(d.addr.port())));
}

#[tokio::test]
async fn a_line_past_the_wires_cap_is_the_refusal_in_one_line_and_not_a_wait() {
    let d = start().await;
    let mut host = Watcher::open(d.addr).await;
    let many: Vec<String> = (0..=numbers::GUEST_ARGV_MAX).map(|n| n.to_string()).collect();
    let words: Vec<&str> = many.iter().map(String::as_str).collect();
    // The daemon refuses the open with a reply and no event. A client that waited on events alone would wait for
    // the life of the machine, which is what a person typing this at a fork's shell would see.
    let run = ran(&words, &[], d.addr, d.token.path(), silent).await;
    assert_eq!(run.code, 1);
    assert!(run.err.contains("256"), "{:?}", run.err);
    assert_eq!(run.out, "");
    // Nothing reached the host: the wire turned the line away before the session existed.
    assert!(tokio::time::timeout(Duration::from_millis(200), host.next_event()).await.is_err());
}

#[tokio::test]
async fn a_line_longer_than_the_cap_is_the_folders_end_and_the_word_mcp_alone_opens_the_tool_server() {
    // The two readings the client makes of the line it was given, held here so a change to either is seen.
    assert_eq!(numbers::GUEST_ARGV_MAX, 256);
    let d = start().await;
    let mut host = Watcher::open(d.addr).await;
    let answering = tokio::spawn(async move {
        let opened = host.next_event().await;
        assert_eq!(opened["kind"], "cli", "a line that only starts with mcp is still a command line");
        assert_eq!(opened["argv"], json!(["mcp", "install"]));
        host.close(opened["session"].as_str().unwrap(), None).await;
    });
    let run = ran(&["mcp", "install"], &[], d.addr, d.token.path(), silent).await;
    answering.await.unwrap();
    assert_eq!(run.code, 0);
}

/// The dial rule, both ways. Inside a workspace on a computer somebody owns the daemon serving that computer has
/// put a socket of this workspace's own at the path the contract names, and the file is the whole of the gate: the
/// session goes over it and sends no auth frame and reads no token file. On a machine wsp forked there is no such
/// file, and the road is that machine's own loopback port with its token, as it has always been.
#[tokio::test]
async fn the_workspace_socket_is_dialled_where_it_is_there_and_the_port_where_it_is_not() {
    let d = start().await;
    let dir = tempfile::tempdir().unwrap();
    let at = dir.path().join("daemon.sock");
    let listener = tokio::net::UnixListener::bind(&at).unwrap();
    let first = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.send(Message::text(json!({ "type": "daemon.hello", "root": "/root" }).to_string())).await.unwrap();
        let Some(Ok(Message::Text(frame))) = ws.next().await else { panic!("the guest sent nothing") };
        let read: Value = serde_json::from_str(&frame).unwrap();
        ws.send(Message::text(json!({ "id": read["id"], "ok": true, "session": "g1" }).to_string())).await.unwrap();
        ws.send(Message::text(json!({ "type": "guest.closed", "session": "g1", "machineId": "wsp-a" }).to_string())).await.unwrap();
        read
    });
    // A token file that is not there: nothing on this road reads one.
    let run = ran_at(&["threads"], &[("WSP_HOST_TOKEN", "dev-1.tok")], d.addr, Path::new("/nowhere/daemon-token"), &at, silent).await;
    let opened = first.await.unwrap();
    assert_eq!(opened["op"], "guest.open", "the first frame on the workspace socket is the open, never an auth");
    assert_eq!(opened["token"], "dev-1.tok");
    assert_eq!((run.code, run.err.as_str()), (0, ""));

    // And with no file at that path the same line takes the port, where the token file is read and the auth frame
    // is the first thing on the wire.
    let mut host = Watcher::open(d.addr).await;
    let answering = tokio::spawn(async move {
        let opened = host.next_event().await;
        assert_eq!(opened["argv"], json!(["threads"]));
        assert_eq!(opened.get("machineId"), None, "a session on a machine wsp forked names no workspace");
        host.reply(opened["session"].as_str().unwrap(), json!({ "exit": 4 })).await;
    });
    let run = ran_at(&["threads"], &[], d.addr, d.token.path(), &dir.path().join("gone.sock"), silent).await;
    answering.await.unwrap();
    assert_eq!(run.code, 4);
}
