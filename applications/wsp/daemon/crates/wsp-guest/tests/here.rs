// SPDX-License-Identifier: AGPL-3.0-only
//! The forwarder on the host's own computer against a fake host on loopback and a fake wsp that answers the ask
//! with a script: which lines it serves and which it leaves to the wsp, what the socket carries, the host's bytes
//! as they were written, and a host that goes and comes back.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use wsp_frames::words;
use wsp_guest::{forward, Forwarded, Streams};

const TOKEN: &str = "host-token-abc";
const WAIT: Duration = Duration::from_secs(5);

/// A wsp that answers the forwarder's ask with the door when `door` is set, and writes down every time it ran.
struct FakeWsp {
    _dir: tempfile::TempDir,
    script: PathBuf,
    log: PathBuf,
}

impl FakeWsp {
    fn new(door: Option<&str>) -> FakeWsp {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("wsp.sh");
        let log = dir.path().join("ran.log");
        let answer = door.map(|d| format!("[ -n \"$WSP_FORWARD\" ] && printf '%s\\n' '{d}'\n")).unwrap_or_default();
        std::fs::write(&script, format!("echo \"${{WSP_FORWARD:-run}} $*\" >> '{}'\n{answer}exit 0\n", log.display())).unwrap();
        FakeWsp { _dir: dir, script, log }
    }

    fn argv(&self) -> Vec<String> {
        vec!["/bin/sh".to_owned(), self.script.to_string_lossy().into_owned()]
    }

    fn ran(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines().map(str::to_owned).collect()
    }
}

fn door(at: std::net::SocketAddr) -> String {
    json!({ "url": format!("ws://{at}/"), "token": TOKEN }).to_string()
}

/// The host's side of one socket: the auth frame is checked and answered, then the open.
async fn accepted(listener: &TcpListener) -> (WebSocketStream<TcpStream>, Value) {
    let (stream, _) = tokio::time::timeout(WAIT, listener.accept()).await.expect("the forwarder dials").unwrap();
    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
    let auth = frame(&mut ws).await;
    assert_eq!(auth, json!({ "id": 1, "op": "auth", "token": TOKEN }));
    ws.send(Message::text(json!({ "id": 1, "ok": true }).to_string())).await.unwrap();
    let open = frame(&mut ws).await;
    assert_eq!(open["op"], "guest.open");
    ws.send(Message::text(json!({ "id": open["id"], "ok": true, "session": "here" }).to_string())).await.unwrap();
    (ws, open)
}

async fn frame(ws: &mut WebSocketStream<TcpStream>) -> Value {
    match tokio::time::timeout(WAIT, ws.next()).await.expect("a frame within five seconds") {
        Some(Ok(Message::Text(t))) => serde_json::from_str(&t).unwrap(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// The next message the forwarder sent on the session.
async fn sent(ws: &mut WebSocketStream<TcpStream>) -> Value {
    let read = frame(ws).await;
    assert_eq!(read["op"], "guest.send", "{read}");
    ws.send(Message::text(json!({ "id": read["id"], "ok": true }).to_string())).await.unwrap();
    read["message"].clone()
}

async fn answer(ws: &mut WebSocketStream<TcpStream>, raw: &str) {
    ws.send(Message::text(format!("{{\"type\":\"guest.message\",\"message\":{raw}}}"))).await.unwrap();
}

/// The harness's end: what it writes into the forwarder's stdin and reads off its stdout, line by line.
struct Harness {
    to: DuplexStream,
    from: tokio::io::Lines<BufReader<DuplexStream>>,
}

impl Harness {
    async fn say(&mut self, line: &str) {
        self.to.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }

    async fn read(&mut self) -> String {
        tokio::time::timeout(WAIT, self.from.next_line()).await.expect("a line within five seconds").unwrap().expect("a line")
    }
}

/// Runs the forwarder on one line beside a driver that plays the harness, and answers what it came to.
async fn forwarded<F, Fut>(line: &[&str], wsp: &FakeWsp, vars: &[(&str, &str)], drive: F) -> Forwarded
where
    F: FnOnce(Harness) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let words: Vec<String> = line.iter().map(|w| (*w).to_owned()).collect();
    let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    let (to, stdin) = duplex(1 << 16);
    let (stdout, from) = duplex(1 << 16);
    let (mut input, mut out, mut err) = (BufReader::new(stdin), stdout, tokio::io::sink());
    let mut streams = Streams { input: &mut input, out: &mut out, err: &mut err };
    let harness = Harness { to, from: BufReader::new(from).lines() };
    let argv = wsp.argv();
    let (done, ()) = tokio::time::timeout(WAIT * 3, async { tokio::join!(forward(&words, &argv, &vars, &mut streams), drive(harness)) })
        .await
        .expect("the forwarder answers");
    done
}

#[tokio::test]
async fn a_line_that_is_not_the_tool_server_is_the_wsps_own_and_nothing_is_asked() {
    let wsp = FakeWsp::new(None);
    assert_eq!(forwarded(&["threads", "--json"], &wsp, &[], |_| async {}).await, Forwarded::Run);
    assert_eq!(forwarded(&["--json", "mcp"], &wsp, &[], |_| async {}).await, Forwarded::Run);
    assert!(wsp.ran().is_empty(), "{:?}", wsp.ran());
}

#[tokio::test]
async fn a_tool_server_line_with_no_host_serving_it_is_left_to_the_wsp_after_one_ask() {
    let wsp = FakeWsp::new(None);
    assert_eq!(forwarded(&["mcp", "--state", "/s/state.json"], &wsp, &[], |_| async {}).await, Forwarded::Run);
    assert_eq!(wsp.ran(), ["door mcp --state /s/state.json"]);

    // A door nothing answers at is the same: the wsp serves the line itself and says what it finds.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap()
    };
    let wsp = FakeWsp::new(Some(&door(closed)));
    assert_eq!(forwarded(&["mcp"], &wsp, &[], |_| async {}).await, Forwarded::Run);
}

#[tokio::test]
async fn the_tool_server_rides_the_hosts_own_socket_and_its_answers_come_out_in_the_hosts_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let wsp = FakeWsp::new(Some(&door(listener.local_addr().unwrap())));
    let here = std::env::current_dir().unwrap().to_string_lossy().into_owned();
    let host = tokio::spawn(async move {
        let (mut ws, open) = accepted(&listener).await;
        assert_eq!(open["kind"], "mcp");
        assert_eq!(open["argv"], json!(["mcp", "--state", "/s/state.json"]));
        assert_eq!(open["cwd"], here);
        assert_eq!(open["turnToken"], "turn-9");
        assert_eq!(open["env"], json!({ "API_KEY": "sk-ant-x", "WSP_TURN": "turn-9" }));
        assert_eq!(sent(&mut ws).await, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        // Keys in the order the host wrote them, which a reader that parsed and wrote again would sort.
        answer(&mut ws, r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[],"_meta":{"z":1.50,"a":"é"}}}"#).await;
        ws
    });
    let run =
        forwarded(&["mcp", "--state", "/s/state.json"], &wsp, &[("API_KEY", "sk-ant-x"), ("WSP_TURN", "turn-9")], |mut h| async move {
            h.say(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await;
            assert_eq!(h.read().await, r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[],"_meta":{"z":1.50,"a":"é"}}}"#);
            drop(h);
        })
        .await;
    // The harness closing its end is the session's end, as it is for the stdio server.
    assert_eq!(run, Forwarded::Exit(0));
    assert_eq!(wsp.ran(), ["door mcp --state /s/state.json"]);
    drop(host.await.unwrap());
}

#[tokio::test]
async fn a_host_that_goes_answers_what_it_held_and_the_next_message_opens_a_session_greeted_as_the_first() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let wsp = FakeWsp::new(Some(&door(listener.local_addr().unwrap())));
    let host = tokio::spawn(async move {
        let (mut first, _) = accepted(&listener).await;
        let greeting = sent(&mut first).await;
        assert_eq!(greeting["method"], "initialize");
        answer(&mut first, r#"{"jsonrpc":"2.0","id":0,"result":{"serverInfo":{"name":"wsp"}}}"#).await;
        assert_eq!(sent(&mut first).await["method"], "notifications/initialized");
        assert_eq!(sent(&mut first).await["id"], 1);
        // The host goes with that call unanswered.
        drop(first);

        let (mut second, _) = accepted(&listener).await;
        assert_eq!(sent(&mut second).await, greeting, "the greeting is said again first");
        answer(&mut second, r#"{"jsonrpc":"2.0","id":0,"result":{"serverInfo":{"name":"wsp"}}}"#).await;
        assert_eq!(sent(&mut second).await["method"], "notifications/initialized");
        assert_eq!(sent(&mut second).await["id"], 2);
        answer(&mut second, r#"{"jsonrpc":"2.0","id":2,"result":{"content":[]}}"#).await;
        second
    });
    let run = forwarded(&["mcp"], &wsp, &[], |mut h| async move {
        h.say(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#).await;
        assert_eq!(h.read().await, r#"{"jsonrpc":"2.0","id":0,"result":{"serverInfo":{"name":"wsp"}}}"#);
        h.say(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        h.say(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"threads"}}"#).await;
        let lost: Value = serde_json::from_str(&h.read().await).unwrap();
        assert_eq!(lost, json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32603, "message": words::HOST_CLOSED } }));
        h.say(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"threads"}}"#).await;
        // The answer to the greeting said again is the forwarder's to read; the harness gets the one it asked for.
        assert_eq!(h.read().await, r#"{"jsonrpc":"2.0","id":2,"result":{"content":[]}}"#);
        drop(h);
    })
    .await;
    assert_eq!(run, Forwarded::Exit(0));
    // Asked twice: where the host was at the start, and to bring one up if need be at the next message.
    assert_eq!(wsp.ran(), ["door mcp", "start mcp"]);
    drop(host.await.unwrap());
}

#[tokio::test]
async fn a_host_that_is_not_back_answers_the_message_as_one_it_went_on_and_the_next_asks_again() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let at = listener.local_addr().unwrap();
    let wsp = FakeWsp::new(Some(&door(at)));
    let host = tokio::spawn(async move {
        let (mut first, _) = accepted(&listener).await;
        // The host goes holding a request, so the loss is read with that request waiting, whatever the timing.
        assert_eq!(sent(&mut first).await["id"], 6);
        drop(first);
        drop(listener);
    });
    let run = forwarded(&["mcp"], &wsp, &[], |mut h| async move {
        h.say(r#"{"jsonrpc":"2.0","id":6,"method":"tools/list"}"#).await;
        let held: Value = serde_json::from_str(&h.read().await).unwrap();
        assert_eq!((held["id"].clone(), held["error"]["message"].clone()), (json!(6), json!(words::HOST_CLOSED)));
        host.await.unwrap();
        h.say(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).await;
        let lost: Value = serde_json::from_str(&h.read().await).unwrap();
        assert_eq!(lost["id"], 7);
        assert_eq!(lost["error"]["message"], words::HOST_CLOSED);
        h.say(r#"{"jsonrpc":"2.0","method":"notifications/cancelled"}"#).await;
        drop(h);
    })
    .await;
    assert_eq!(run, Forwarded::Exit(0));
    assert_eq!(wsp.ran(), ["door mcp", "start mcp", "start mcp"]);
}
