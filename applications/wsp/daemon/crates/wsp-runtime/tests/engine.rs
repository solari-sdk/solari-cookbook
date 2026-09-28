// SPDX-License-Identifier: AGPL-3.0-only
//! The fenced engine socket against a fake engine in this process: a Unix socket that records every request it is
//! handed and answers what the route asks for. One case per allowed route, so what reaches the engine is read off
//! the record, and one per refusal, so nothing reaches it.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use wsp_runtime::engine::{self, Bridges, Fence, Hooks, Ports, LABEL, PORTS_LABEL};

const WORKSPACE: &str = "wsp-a";

/// One request the fake engine was handed, whole.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

type Record = Arc<Mutex<Vec<Seen>>>;

/// The request as the engine reads it: the head, then the body by whichever framing the head named, and
/// whatever came in behind that body left in `held` for the request after it, as a keep-alive engine leaves it.
/// Where a head names both framings the chunks win and the length is dropped, which is what Go's own server
/// does and so what the box engine does; that reading is the whole of the smuggling this fence refuses.
/// `None` where the connection ended with nothing held.
async fn read_request(stream: &mut UnixStream, held: &mut Vec<u8>) -> Option<Seen> {
    let mut buf = [0u8; 4096];
    let split = loop {
        if let Some(at) = held.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        let n = stream.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        held.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8(held[..split].to_vec()).unwrap();
    held.drain(..split);
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap().split(' ');
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let headers: Vec<(String, String)> =
        lines.filter(|l| !l.is_empty()).filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))).collect();
    let chunked = headers.iter().any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"));
    let body = if chunked {
        let through = loop {
            match held.windows(5).position(|w| w == b"0\r\n\r\n") {
                Some(at) => break at + 5,
                None => {
                    let n = stream.read(&mut buf).await.unwrap();
                    assert!(n > 0, "the chunked body ended before its terminator");
                    held.extend_from_slice(&buf[..n]);
                }
            }
        };
        let framed: Vec<u8> = held.drain(..through).collect();
        dechunk(&framed)
    } else {
        let wanted: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        while held.len() < wanted {
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0);
            held.extend_from_slice(&buf[..n]);
        }
        held.drain(..wanted).collect()
    };
    Some(Seen { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

/// A chunked body without its framing, as the engine would read it.
fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < body.len() {
        let Some(end) = body[at..].windows(2).position(|w| w == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&body[at..at + end]).trim(), 16).unwrap_or(0);
        at += end + 2;
        if size == 0 {
            break;
        }
        out.extend_from_slice(&body[at..(at + size).min(body.len())]);
        at += size + 2;
    }
    out
}

/// How long a closing answer looks for a request behind it, and how long the cancelling route waits for the
/// client's half close. Short on purpose: bytes the fence let through arrive with the request they rode behind,
/// so a look that finds nothing in this moment finds nothing at all.
const A_MOMENT: std::time::Duration = std::time::Duration::from_millis(100);

/// The bodiless 499 the engine's server writes where the request's context was cancelled under the handler.
const CANCELLED: &[u8] = b"HTTP/1.1 499 status code 499\r\nContent-Length: 0\r\n\r\n";

/// One answer, the close, and then a bounded look for a request the fence let through behind the one it judged:
/// a keep-alive engine would read that as the next request on this connection, so the fake reads it too and the
/// record carries it. Without the look a leak reaches no case's read. The look sits after the close of this
/// side's writing, which is what ends the fence's copy back, so no case waits on it.
async fn answer_then_close(stream: &mut UnixStream, head: &[u8], held: &mut Vec<u8>, record: &Record) {
    stream.write_all(head).await.unwrap();
    let _ = stream.shutdown().await;
    if let Ok(Some(behind)) = tokio::time::timeout(A_MOMENT, read_request(stream, held)).await {
        record.lock().unwrap().push(behind);
    }
}

/// Everything the socket answered, up to the close. Bounded, since a socket this fence leaves open is a socket
/// a client waits on for ever: a case reading one says so rather than holding the whole suite.
async fn read_to_close(stream: &mut UnixStream) -> Vec<u8> {
    let mut all = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(10), stream.read_to_end(&mut all))
        .await
        .expect("the socket was never closed, so the answer never ended")
        .unwrap();
    all
}

fn json_response(status: u16, body: &Value) -> Vec<u8> {
    let text = body.to_string();
    format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len()).into_bytes()
}

fn inspect(id: &str, workspace: &str) -> Value {
    json!({
        "Id": id,
        "Config": { "Labels": { LABEL: workspace, PORTS_LABEL: "80/tcp=18080" } },
        "NetworkSettings": { "Ports": { "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "40001" }] } }
    })
}

/// The bridge the fake engine says it made for a network of the workspace's, which the fence reads off the
/// inspect when the network goes.
const FAKE_BRIDGE: &str = "wsp-e0000002a";

/// The fake engine's answer to one request, by its path: containers, execs, networks and volumes whose id starts
/// with `ours` wear the workspace's label, `theirs` wear another's, anything else is not there.
fn answer(method: &str, path: &str) -> Vec<u8> {
    let bare = path.split('?').next().unwrap();
    let segments: Vec<&str> = bare.trim_start_matches("/v1.55").split('/').filter(|s| !s.is_empty()).collect();
    let owner = |id: &str| {
        if id.starts_with("ours") {
            Some(WORKSPACE)
        } else if id.starts_with("theirs") {
            Some("wsp-other")
        } else {
            None
        }
    };
    match segments.as_slice() {
        ["containers", id, "json"] => match owner(id) {
            Some(w) => json_response(200, &inspect(id, w)),
            None => json_response(404, &json!({ "message": format!("No such container: {id}") })),
        },
        ["exec", id, "json"] => match owner(id.trim_start_matches("exec")) {
            Some(_) => json_response(200, &json!({ "ID": id, "ContainerID": id.trim_start_matches("exec") })),
            None => json_response(404, &json!({ "message": "no such exec" })),
        },
        ["networks", "create"] if method == "POST" => json_response(201, &json!({ "Id": "netours-made", "Warning": "" })),
        ["networks", _] if method == "DELETE" => b"HTTP/1.1 204 No Content\r\n\r\n".to_vec(),
        // An inspect the engine did not answer: a status that is neither 200 nor 404 says nothing about whose
        // the name is, and a fence that read it as nothing would make one over it.
        ["volumes", name] if method == "GET" && name.starts_with("volbroken") => {
            json_response(500, &json!({ "message": "the engine is unwell" }))
        }
        ["networks", id] if method == "GET" => match owner(id.trim_start_matches("net")) {
            Some(w) => json_response(
                200,
                &json!({ "Id": id, "Labels": { LABEL: w }, "Options": { "com.docker.network.bridge.name": FAKE_BRIDGE } }),
            ),
            None => json_response(404, &json!({ "message": "no such network" })),
        },
        ["volumes", name] if method == "GET" => match owner(name.trim_start_matches("vol")) {
            Some(w) => json_response(200, &json!({ "Name": name, "Labels": { LABEL: w } })),
            None => json_response(404, &json!({ "message": "no such volume" })),
        },
        ["containers", _, "start"] | ["containers", _, "stop"] => b"HTTP/1.1 204 No Content\r\n\r\n".to_vec(),
        ["containers", _] if method == "DELETE" => b"HTTP/1.1 204 No Content\r\n\r\n".to_vec(),
        ["containers", _, "logs"] => b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n".to_vec(),
        ["containers", _, "archive"] if method == "PUT" => b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
        ["_ping"] => b"HTTP/1.1 200 OK\r\nApi-Version: 1.55\r\nContent-Length: 2\r\n\r\nOK".to_vec(),
        _ => json_response(200, &json!({ "ok": true, "path": bare })),
    }
}

/// What the fake engine does with one request.
enum Answered {
    /// The connection is handed over: a 101 to a client that asked to upgrade, and the raw stream under a 200
    /// the engine answers an exec start that asked for nothing.
    HandsOver(&'static [u8]),
    /// One answer, and the connection left open as a keep-alive engine leaves it: what a detached exec start
    /// gets, and the shape a fence that never ends its side would wait on for ever.
    KeepsAlive(Vec<u8>),
    /// One answer and the connection closed.
    Closes(Vec<u8>),
    /// The answer of a route whose handler works on the request's own context: where the client half closes its
    /// write side first, the engine's server takes the client as gone, cancels that context under the handler
    /// and writes a bodiless 499 in place of the answer.
    CancelsOnAHalfClose(Vec<u8>),
}

fn answered(seen: &Seen) -> Answered {
    if seen.header("upgrade") == Some("tcp") {
        return Answered::HandsOver(
            b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
        );
    }
    let bare = seen.path.split('?').next().unwrap();
    let segments: Vec<&str> = bare.trim_start_matches("/v1.55").split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["version"] => Answered::CancelsOnAHalfClose(answer(&seen.method, &seen.path)),
        ["exec", _, "start"] if seen.body.contains("\"Detach\":true") => Answered::KeepsAlive(json_response(200, &json!({ "ok": true }))),
        ["exec", _, "start"] => Answered::HandsOver(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\n\r\n"),
        _ => Answered::Closes(answer(&seen.method, &seen.path)),
    }
}

/// The fake engine on a socket under the directory, recording what it is handed.
fn fake_engine(dir: &Path) -> (PathBuf, Record) {
    let path = dir.join("engine.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let seen: Record = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let record = Arc::clone(&record);
            tokio::spawn(async move {
                let mut held = Vec::new();
                // One request after another on the one connection, as a keep-alive engine serves them: what a
                // client left behind a body is the next request here, which is what the fence must never let
                // reach this far.
                while let Some(request) = read_request(&mut stream, &mut held).await {
                    record.lock().unwrap().push(request.clone());
                    match answered(&request) {
                        Answered::HandsOver(head) => {
                            stream.write_all(head).await.unwrap();
                            let mut buf = [0u8; 1024];
                            while let Ok(n) = stream.read(&mut buf).await {
                                if n == 0 {
                                    break;
                                }
                                let echoed = format!("echo:{}", String::from_utf8_lossy(&buf[..n]));
                                stream.write_all(echoed.as_bytes()).await.unwrap();
                            }
                            return;
                        }
                        Answered::KeepsAlive(head) => stream.write_all(&head).await.unwrap(),
                        Answered::Closes(head) => {
                            answer_then_close(&mut stream, &head, &mut held, &record).await;
                            return;
                        }
                        Answered::CancelsOnAHalfClose(head) => {
                            match tokio::time::timeout(A_MOMENT, read_request(&mut stream, &mut held)).await {
                                // The end of the stream with the handler still running, which is the half close
                                // the engine's server takes as the client gone.
                                Ok(None) => {
                                    stream.write_all(CANCELLED).await.unwrap();
                                    let _ = stream.shutdown().await;
                                }
                                Ok(Some(behind)) => {
                                    record.lock().unwrap().push(behind);
                                    answer_then_close(&mut stream, &head, &mut held, &record).await;
                                }
                                Err(_) => answer_then_close(&mut stream, &head, &mut held, &record).await,
                            }
                            return;
                        }
                    }
                }
                let _ = stream.shutdown().await;
            });
        }
    });
    (path, seen)
}

struct Joined(Mutex<Vec<(String, u16, u16)>>);

impl Ports for Joined {
    fn published(&self, workspace: &str, inside: u16, box_port: u16) {
        self.0.lock().unwrap().push((workspace.to_owned(), inside, box_port));
    }
}

/// The daemon's side of a network the fence makes, with the box standing in: every bridge the engine was told
/// to make reads as made, and each one written and taken off is recorded.
struct Bridged(Mutex<Vec<(String, String, bool)>>);

impl Bridges for Bridged {
    fn made(&self, workspace: &str, bridge: &str) -> bool {
        self.0.lock().unwrap().push((workspace.to_owned(), bridge.to_owned(), true));
        true
    }

    fn gone(&self, workspace: &str, bridge: &str) {
        self.0.lock().unwrap().push((workspace.to_owned(), bridge.to_owned(), false));
    }
}

struct World {
    socket: PathBuf,
    seen: Record,
    joined: Arc<Joined>,
    bridged: Arc<Bridged>,
    _dir: tempfile::TempDir,
}

/// The proxy over the fake engine, its record naming one project folder `/root/demo`, the copy behind it on the
/// box side, and the staging directory the fence binds a source into.
fn world() -> World {
    world_of(WORKSPACE)
}

/// The same for a workspace of another id, which the cases that read what the fence makes of an id need.
fn world_of(workspace: &str) -> World {
    let dir = tempfile::tempdir().unwrap();
    let (engine, seen) = fake_engine(dir.path());
    let rootfs = dir.path().join("rootfs");
    let on_box = dir.path().join("copies").join(workspace);
    let binds = dir.path().join("binds");
    for made in [rootfs.join("root/demo/html"), rootfs.join("root/.wsp"), rootfs.join("etc"), on_box.join("html"), binds.clone()] {
        std::fs::create_dir_all(made).unwrap();
    }
    // What a workspace writes where the allowlist used to live, which nothing reads now.
    std::fs::write(rootfs.join("root/.wsp/roots"), "/\n").unwrap();
    let joined = Arc::new(Joined(Mutex::new(Vec::new())));
    let bridged = Arc::new(Bridged(Mutex::new(Vec::new())));
    let listener = engine::bind(&dir.path().join("ws")).unwrap();
    let fence = Fence::new(
        workspace.to_owned(),
        rootfs.clone(),
        vec![("/root/demo".to_owned(), on_box)],
        binds,
        engine,
        Hooks { ports: Arc::clone(&joined) as Arc<dyn Ports>, bridges: Arc::clone(&bridged) as Arc<dyn Bridges> },
        "life".into(),
    );
    tokio::spawn(engine::serve(listener, Arc::new(fence)));
    World { socket: dir.path().join("ws").join(engine::SOCKET_NAME), seen, joined, bridged, _dir: dir }
}

impl World {
    /// One request through the workspace's socket, as a Docker client sends it: the status, the head and the body.
    async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> (u16, String, Vec<u8>) {
        let mut stream = UnixStream::connect(&self.socket).await.unwrap();
        let text = body.map(Value::to_string).unwrap_or_default();
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: docker\r\nUser-Agent: Docker-Client/29.7.0\r\n");
        if body.is_some() {
            request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", text.len()));
        }
        request.push_str("\r\n");
        request.push_str(&text);
        stream.write_all(request.as_bytes()).await.unwrap();
        let all = read_to_close(&mut stream).await;
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").expect("a response head") + 4;
        let head = String::from_utf8(all[..split].to_vec()).unwrap();
        let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
        (status, head, all[split..].to_vec())
    }

    fn reached(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn engine_saw(&self, method: &str, path_starts: &str) -> Option<Seen> {
        self.reached().into_iter().find(|r| r.method == method && r.path.starts_with(path_starts))
    }

    /// One request written on the socket byte for byte, and everything the socket answered before it closed.
    async fn raw(&self, request: &[u8]) -> Vec<u8> {
        let mut stream = UnixStream::connect(&self.socket).await.unwrap();
        stream.write_all(request).await.unwrap();
        read_to_close(&mut stream).await
    }

    fn message(body: &[u8]) -> String {
        serde_json::from_slice::<Value>(body).ok().and_then(|v| v["message"].as_str().map(str::to_owned)).unwrap_or_default()
    }
}

#[tokio::test]
async fn ping_and_version_pass_and_the_answer_closes_the_connection() {
    let w = world();
    let (status, head, body) = w.call("HEAD", "/_ping", None).await;
    assert_eq!((status, body.as_slice()), (200, &b"OK"[..]));
    assert!(head.contains("Api-Version: 1.55") && head.contains("Connection: close"), "{head}");
    let (status, _, body) = w.call("GET", "/v1.55/version", None).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["path"], "/v1.55/version");
    assert_eq!(w.engine_saw("GET", "/v1.55/version").unwrap().path, "/v1.55/version");
}

/// A route the engine answers off the request's own context: nothing is closed toward it before it has answered,
/// so the handler runs to its end and the client reads the engine's own answer rather than the bodiless 499 a
/// cancelled handler leaves. What ends the engine's answer instead is the close forced on the forwarded head.
#[tokio::test]
async fn a_route_the_engine_cancels_under_a_half_close_answers_its_own_words() {
    let w = world();
    let (status, head, body) = w.call("GET", "/v1.55/version", None).await;
    assert_eq!(status, 200, "{head}");
    assert!(head.starts_with("HTTP/1.1 200 X\r\n"), "the engine's own status words ride back: {head}");
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["path"], "/v1.55/version");
    let reached = w.reached();
    assert_eq!(reached.len(), 1, "one request reached the engine: {reached:?}");
    assert_eq!(reached[0].header("connection"), Some("close"));
}

#[tokio::test]
async fn image_routes_pass_unchanged() {
    let w = world();
    for (method, path) in [
        ("POST", "/v1.55/images/create?fromImage=postgres&tag=16-alpine"),
        ("GET", "/v1.55/images/json"),
        ("GET", "/v1.55/images/nginx:alpine/json"),
        ("DELETE", "/v1.55/images/nginx:alpine"),
    ] {
        let (status, _, _) = w.call(method, path, None).await;
        assert_eq!(status, 200, "{path}");
        assert_eq!(w.engine_saw(method, path).unwrap().path, path);
    }
}

#[tokio::test]
async fn a_container_create_reaches_the_engine_labelled_with_its_ports_on_the_loopback_and_its_binds_mapped() {
    let w = world();
    let body = json!({
        "Image": "nginx:alpine",
        "HostConfig": { "PortBindings": { "80/tcp": [{ "HostIp": "", "HostPort": "18080" }] }, "NetworkMode": "netours1" },
        "NetworkingConfig": { "EndpointsConfig": { "netours1": {} } }
    });
    let (status, _, _) = w.call("POST", "/v1.55/containers/create?name=web", Some(&body)).await;
    assert_eq!(status, 200);
    let sent = w.engine_saw("POST", "/v1.55/containers/create").unwrap();
    assert_eq!(sent.path, "/v1.55/containers/create?name=web");
    let reached: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!(reached["Labels"][LABEL], WORKSPACE);
    assert_eq!(reached["Labels"][PORTS_LABEL], "80/tcp=18080");
    assert_eq!(reached["HostConfig"]["PortBindings"]["80/tcp"], json!([{ "HostIp": "127.0.0.1", "HostPort": "" }]));
    // The network it joins was checked for the label first, once, though the create names it twice.
    assert_eq!(w.reached().iter().filter(|r| r.method == "GET" && r.path == "/networks/netours1").count(), 1);
}

#[tokio::test]
async fn a_create_naming_another_workspaces_network_or_container_is_not_found_and_never_reaches_the_engine() {
    let w = world();
    let (status, _, body) = w
        .call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "nettheirs1" } })))
        .await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such network: nettheirs1"));
    let (status, _, body) = w
        .call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": { "PidMode": "container:theirs1" } })))
        .await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"));
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_none());
}

#[tokio::test]
async fn every_refused_field_answers_one_sentence_and_nothing_reaches_the_engine() {
    let w = world();
    let cases: [(Value, &str); 10] = [
        (json!({ "Privileged": true }), "a privileged container is root on this computer, so a workspace cannot ask for one"),
        (json!({ "CapAdd": ["SYS_ADMIN"] }), "a workspace's container runs with the engine's default capabilities; CapAdd is refused"),
        (
            json!({ "Devices": [{ "PathOnHost": "/dev/sda" }] }),
            "a workspace's container gets no device of this computer; Devices is refused",
        ),
        (
            json!({ "SecurityOpt": ["seccomp=unconfined"] }),
            "a workspace's container keeps the engine's seccomp and AppArmor defaults; SecurityOpt is refused",
        ),
        (json!({ "PidMode": "host" }), "a workspace's container cannot share this computer's pid namespace; PidMode host is refused"),
        (json!({ "NetworkMode": "host" }), "a workspace's container cannot join this computer's network; NetworkMode host is refused"),
        (json!({ "IpcMode": "host" }), "a workspace's container cannot share this computer's ipc namespace; IpcMode host is refused"),
        (
            json!({ "Binds": ["/:/host"] }),
            "a bind mount's source must sit under a project folder of this workspace (/root/demo), and / does not",
        ),
        (
            json!({ "Binds": ["/etc:/host"] }),
            "a bind mount's source must sit under a project folder of this workspace (/root/demo), and /etc does not",
        ),
        (
            json!({ "PublishAllPorts": true }),
            "a workspace publishes ports one by one on this computer's loopback; PublishAllPorts is refused",
        ),
    ];
    for (host_config, sentence) in cases {
        let (status, head, body) =
            w.call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": host_config }))).await;
        assert_eq!((status, World::message(&body).as_str()), (403, sentence));
        assert!(head.contains("Content-Type: application/json"), "{head}");
    }
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_none(), "{:?}", w.reached());
}

#[tokio::test]
async fn listings_reach_the_engine_with_the_workspaces_label_filter() {
    let w = world();
    for (path, prefix) in [
        ("/v1.55/containers/json?all=1", "/v1.55/containers/json?all=1&filters="),
        ("/v1.55/networks", "/v1.55/networks?filters="),
        ("/v1.55/volumes", "/v1.55/volumes?filters="),
        ("/v1.55/events?since=1", "/v1.55/events?since=1&filters="),
    ] {
        let (status, _, _) = w.call("GET", path, None).await;
        assert_eq!(status, 200, "{path}");
        let sent = w.engine_saw("GET", prefix).unwrap_or_else(|| panic!("{path}: {:?}", w.reached()));
        let filters = percent_encoding::percent_decode_str(sent.path.split("filters=").nth(1).unwrap()).decode_utf8().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&filters).unwrap()["label"], json!([format!("{LABEL}={WORKSPACE}")]), "{path}");
    }
    let compose = format!(
        "/v1.55/containers/json?all=1&filters={}",
        percent_encoding::utf8_percent_encode(r#"{"label":["com.docker.compose.project=demo"]}"#, percent_encoding::NON_ALPHANUMERIC)
    );
    w.call("GET", &compose, None).await;
    let sent = w.reached().into_iter().rfind(|r| r.path.starts_with("/v1.55/containers/json")).unwrap();
    let filters = percent_encoding::percent_decode_str(sent.path.split("filters=").nth(1).unwrap()).decode_utf8().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&filters).unwrap()["label"],
        json!(["com.docker.compose.project=demo", format!("{LABEL}={WORKSPACE}")])
    );
}

#[tokio::test]
async fn a_network_or_volume_create_reaches_the_engine_labelled() {
    let w = world();
    let (status, _, _) = w
        .call(
            "POST",
            "/v1.55/networks/create",
            Some(&json!({ "Name": "demo_default", "Labels": { "com.docker.compose.network": "default" } })),
        )
        .await;
    assert_eq!(status, 201, "the fence makes a network itself and answers what the engine answered");
    let sent = w.engine_saw("POST", "/v1.55/networks/create").unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap()["Labels"],
        json!({ "com.docker.compose.network": "default", LABEL: WORKSPACE })
    );
    let (status, _, _) = w.call("POST", "/v1.55/volumes/create", Some(&json!({ "Name": "data" }))).await;
    assert_eq!(status, 200);
    let sent = w.engine_saw("POST", "/v1.55/volumes/create").unwrap();
    assert_eq!(serde_json::from_str::<Value>(&sent.body).unwrap()["Labels"][LABEL], WORKSPACE);
}

#[tokio::test]
async fn container_routes_reach_the_engine_for_the_workspaces_own_and_are_not_found_for_the_boxs() {
    let w = world();
    for (method, path) in [
        ("GET", "/v1.55/containers/ours1/json"),
        ("POST", "/v1.55/containers/ours1/stop?t=10"),
        ("GET", "/v1.55/containers/ours1/logs?stdout=1"),
        ("POST", "/v1.55/containers/ours1/wait"),
        ("GET", "/v1.55/containers/ours1/archive?path=/etc"),
        ("DELETE", "/v1.55/containers/ours1?force=1&v=1"),
    ] {
        let (status, _, body) = w.call(method, path, None).await;
        assert!(status == 200 || status == 204, "{path}: {status}");
        assert!(w.engine_saw(method, path).is_some(), "{path} did not reach the engine: {:?}", w.reached());
        if path.contains("logs") {
            assert_eq!(body, b"5\r\nhello\r\n0\r\n\r\n", "the chunked stream is copied as it came");
        }
    }
    // The box's own container, by name: not found, and nothing but the inspect that read its label reached the engine.
    let before = w.reached().len();
    for (method, path) in
        [("GET", "/v1.55/containers/theirs1/json"), ("POST", "/v1.55/containers/theirs1/stop"), ("DELETE", "/v1.55/containers/theirs1")]
    {
        let (status, _, body) = w.call(method, path, None).await;
        assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"), "{path}");
    }
    let after: Vec<_> = w.reached()[before..].to_vec();
    assert!(after.iter().all(|r| r.method == "GET" && r.path == "/containers/theirs1/json"), "{after:?}");
    let (status, _, body) = w.call("GET", "/v1.55/containers/nobody/json", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: nobody"));
}

#[tokio::test]
async fn a_start_the_engine_took_joins_the_containers_published_ports() {
    let w = world();
    let (status, _, _) = w.call("POST", "/v1.55/containers/ours1/start", None).await;
    assert_eq!(status, 204);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(w.joined.0.lock().unwrap().clone(), vec![(WORKSPACE.to_owned(), 18080, 40001)]);
    let (status, _, _) = w.call("POST", "/v1.55/containers/theirs1/start", None).await;
    assert_eq!(status, 404);
    assert_eq!(w.joined.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_exec_is_fenced_at_its_create_and_its_start_is_copied_raw_after_the_upgrade() {
    let w = world();
    let (status, _, body) = w.call("POST", "/v1.55/containers/ours1/exec", Some(&json!({ "Cmd": ["sh"], "Privileged": true }))).await;
    assert_eq!(
        (status, World::message(&body).as_str()),
        (403, "a privileged exec is root on this computer, so a workspace cannot ask for one")
    );
    assert!(w.engine_saw("POST", "/v1.55/containers/ours1/exec").is_none());
    let (status, _, _) = w.call("POST", "/v1.55/containers/ours1/exec", Some(&json!({ "Cmd": ["sh"], "AttachStdout": true }))).await;
    assert_eq!(status, 200);
    assert!(w.engine_saw("POST", "/v1.55/containers/ours1/exec").is_some());
    let (status, _, body) = w.call("POST", "/v1.55/containers/theirs1/exec", Some(&json!({ "Cmd": ["sh"] }))).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"));
    let (status, _, _) = w.call("GET", "/v1.55/exec/execours1/json", None).await;
    assert_eq!(status, 200);
    let (status, _, body) = w.call("GET", "/v1.55/exec/exectheirs1/json", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such exec instance: exectheirs1"));
    // The hijacked start: the head passes, then bytes flow both ways until the client closes.
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    let body = r#"{"Detach":false,"Tty":false}"#;
    stream
        .write_all(format!("POST /v1.55/exec/execours1/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap();
    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(head.starts_with("HTTP/1.1 101 UPGRADED\r\n"), "{head}");
    assert!(head.contains("Connection: Upgrade") && !head.contains("Connection: close"), "{head}");
    let mut echoed = String::new();
    if let Some(after) = head.split("\r\n\r\n").nth(1) {
        echoed.push_str(after);
    }
    stream.write_all(b"stdin bytes").await.unwrap();
    while !echoed.contains("echo:stdin bytes") {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "the stream ended before the echo: {echoed}");
        echoed.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    let start = w.engine_saw("POST", "/v1.55/exec/execours1/start").unwrap();
    assert_eq!(start.body, body, "the body after the head reached the engine");
}

#[tokio::test]
async fn an_attach_passes_for_the_workspaces_own_container() {
    let w = world();
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    stream
        .write_all(b"POST /v1.55/containers/ours1/attach?stream=1&stdout=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 101 UPGRADED"));
    assert!(w.engine_saw("POST", "/v1.55/containers/ours1/attach").is_some());
}

#[tokio::test]
async fn network_and_volume_routes_are_the_workspaces_own_alone() {
    let w = world();
    let (status, _, _) = w.call("GET", "/v1.55/networks/netours1", None).await;
    assert_eq!(status, 200);
    let (status, _, _) = w.call("DELETE", "/v1.55/networks/netours1", None).await;
    assert_eq!(status, 204);
    assert!(w.engine_saw("DELETE", "/v1.55/networks/netours1").is_some());
    let (status, _, body) = w.call("DELETE", "/v1.55/networks/nettheirs1", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such network: nettheirs1"));
    assert!(w.engine_saw("DELETE", "/v1.55/networks/nettheirs1").is_none());
    // A connect names a container too, and it is checked.
    let (status, _, body) = w.call("POST", "/v1.55/networks/netours1/connect", Some(&json!({ "Container": "theirs1" }))).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"));
    let (status, _, _) = w.call("POST", "/v1.55/networks/netours1/connect", Some(&json!({ "Container": "ours1" }))).await;
    assert_eq!(status, 200);
    let (status, _, _) = w.call("GET", "/v1.55/volumes/volours1", None).await;
    assert_eq!(status, 200);
    let (status, _, body) = w.call("DELETE", "/v1.55/volumes/voltheirs1", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such volume: voltheirs1"));
    assert!(w.engine_saw("DELETE", "/v1.55/volumes/voltheirs1").is_none());
}

#[tokio::test]
async fn the_boxs_routes_are_refused_before_the_engine_hears_of_them() {
    let w = world();
    for path in [
        "/v1.55/info",
        "/v1.55/system/df",
        "/v1.55/swarm",
        "/v1.55/plugins",
        "/v1.55/services",
        "/v1.55/nodes",
        "/v1.55/secrets",
        "/v1.55/configs",
        "/v1.55/auth",
        "/v1.55/distribution/nginx/json",
    ] {
        let (status, _, body) = w.call("GET", path, None).await;
        assert_eq!(status, 403, "{path}");
        assert!(World::message(&body).contains("is not served on a workspace's socket"), "{path}: {}", World::message(&body));
    }
    let (status, _, body) = w.call("POST", "/v1.55/build?t=x", None).await;
    assert_eq!(status, 403);
    assert!(World::message(&body).starts_with("image builds are not served"));
    let (status, _, _) = w.call("POST", "/v1.55/containers/prune", None).await;
    assert_eq!(status, 403);
    assert!(w.reached().is_empty(), "{:?}", w.reached());
}

#[tokio::test]
async fn the_removal_takes_every_container_network_and_volume_of_the_workspace_and_the_ports_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, seen) = fake_engine(dir.path());
    // The fake answers a plain listing with an object, which is no array: nothing to remove, and no error.
    assert_eq!(engine::remove_all(&engine, WORKSPACE).await.unwrap(), (0, 0, 0));
    let listed: Vec<String> = seen.lock().unwrap().iter().map(|r| r.path.clone()).collect();
    assert_eq!(listed.len(), 3);
    for (path, prefix) in listed.iter().zip(["/containers/json?all=1&filters=", "/networks?all=1&filters=", "/volumes?all=1&filters="]) {
        assert!(path.starts_with(prefix), "{path}");
    }
    assert_eq!(engine::published(&engine, WORKSPACE).await.unwrap(), Vec::<(u16, u16)>::new());
    let (status, value) = engine::ask(&engine, "GET", "/containers/ours1/json", None).await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(engine::published_ports(&value), vec![(18080, 40001)]);
}

/// An upgrade header on a route the engine never hands a connection over on: the two connection headers are
/// dropped before the head goes, the connection is told to close, and a second request the client pipelined in
/// the same segment behind it is not a body, so it reaches nothing.
#[tokio::test]
async fn an_upgrade_on_an_allowed_route_opens_no_pipe_and_what_follows_it_reaches_nothing() {
    let w = world();
    let answered = w
        .raw(
            concat!(
                "HEAD /_ping HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
                "GET /v1.55/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
    let answered = String::from_utf8(answered).unwrap();
    assert!(answered.starts_with("HTTP/1.1 200 OK\r\n"), "{answered}");
    assert!(answered.contains("Connection: close"), "{answered}");
    assert_eq!(answered.matches("HTTP/1.1 ").count(), 1, "one request, one answer: {answered}");
    let ping = w.engine_saw("HEAD", "/_ping").unwrap();
    assert_eq!(ping.header("connection"), Some("close"));
    assert_eq!(ping.header("upgrade"), None);
    assert_eq!(ping.body, "");
    assert!(w.engine_saw("GET", "/v1.55/containers/json").is_none(), "{:?}", w.reached());
}

/// A body the client streams after the head, which is what an image load, an image import and an archive put
/// are: it rides on inside the request's own framing, and the bytes behind that framing do not.
#[tokio::test]
async fn a_body_that_arrives_after_the_head_reaches_the_engine_whole_and_nothing_behind_it_does() {
    let w = world();
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    stream
        .write_all(b"POST /v1.55/images/load HTTP/1.1\r\nHost: docker\r\nContent-Type: application/x-tar\r\nContent-Length: 12\r\n\r\n")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    stream.write_all(b"twelve bytes").await.unwrap();
    stream.write_all(b"GET /v1.55/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n").await.unwrap();
    let mut all = Vec::new();
    stream.read_to_end(&mut all).await.unwrap();
    let load = w.engine_saw("POST", "/v1.55/images/load").unwrap();
    assert_eq!(load.body, "twelve bytes");
    assert_eq!(load.header("content-length"), Some("12"));
    assert!(w.engine_saw("GET", "/v1.55/containers/json").is_none(), "{:?}", w.reached());

    // The same for a chunked body, sent in two segments, which is how the client puts an archive into a container.
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    stream
        .write_all(b"PUT /v1.55/containers/ours1/archive?path=/ HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    stream.write_all(b"\r\n2\r\n!!\r\n0\r\n\r\nGET /v1.55/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n").await.unwrap();
    let mut all = Vec::new();
    stream.read_to_end(&mut all).await.unwrap();
    let put = w.engine_saw("PUT", "/v1.55/containers/ours1/archive").unwrap();
    assert_eq!(put.body, "hello!!", "the chunks reached the engine whole through their terminator");
    assert!(w.engine_saw("GET", "/v1.55/containers/json").is_none(), "{:?}", w.reached());
}

/// The exec start the engine answers with a raw stream under a 200 rather than a 101, which is what it sends a
/// client that asked for no upgrade: the connection is handed over all the same.
#[tokio::test]
async fn an_exec_start_the_engine_answers_a_raw_stream_to_is_copied_raw() {
    let w = world();
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    let body = r#"{"Detach":false,"Tty":false}"#;
    stream
        .write_all(
            format!(
                "POST /v1.55/exec/execours1/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap();
    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(head.starts_with("HTTP/1.1 200 OK\r\n") && head.contains("multiplexed-stream"), "{head}");
    let mut echoed = head.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
    stream.write_all(b"stdin bytes").await.unwrap();
    while !echoed.contains("echo:stdin bytes") {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "the stream ended before the echo: {echoed}");
        echoed.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert_eq!(w.engine_saw("POST", "/v1.55/exec/execours1/start").unwrap().body, body);
}

/// A followed log stream: the engine's bytes are copied to the client until the engine closes, and nothing the
/// client sends behind the head goes the other way.
#[tokio::test]
async fn a_followed_log_is_copied_back_and_nothing_behind_the_head_goes_to_the_engine() {
    let w = world();
    let answered = w
        .raw(
            concat!(
                "GET /v1.55/containers/ours1/logs?follow=1&stdout=1 HTTP/1.1\r\nHost: docker\r\n\r\n",
                "GET /v1.55/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
    let answered = String::from_utf8(answered).unwrap();
    assert!(answered.ends_with("5\r\nhello\r\n0\r\n\r\n"), "{answered}");
    let logs = w.engine_saw("GET", "/v1.55/containers/ours1/logs").unwrap();
    assert_eq!(logs.body, "");
    assert!(w.engine_saw("GET", "/v1.55/containers/json").is_none(), "{:?}", w.reached());
}

/// The volume create the box's own /etc is mounted through: refused before the engine hears of it, and the
/// plain create beside it still reaching the engine labelled.
#[tokio::test]
async fn a_volume_create_naming_a_driver_option_is_refused_and_never_reaches_the_engine() {
    let w = world();
    let evil = json!({ "Name": "evil", "Driver": "local", "DriverOpts": { "type": "none", "device": "/etc", "o": "bind" } });
    let (status, _, body) = w.call("POST", "/v1.55/volumes/create", Some(&evil)).await;
    assert_eq!(
        (status, World::message(&body).as_str()),
        (403, "a workspace's volume is a plain local volume, and this one asks for driver options (device, o, type)")
    );
    let (status, _, body) = w.call("POST", "/v1.55/volumes/create", Some(&json!({ "Name": "elsewhere", "Driver": "nfs" }))).await;
    assert_eq!(status, 403, "{}", World::message(&body));
    assert!(w.engine_saw("POST", "/v1.55/volumes/create").is_none(), "{:?}", w.reached());
    let (status, _, _) = w.call("POST", "/v1.55/volumes/create", Some(&json!({ "Name": "data" }))).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&w.engine_saw("POST", "/v1.55/volumes/create").unwrap().body).unwrap()["Labels"][LABEL],
        WORKSPACE
    );
}

/// A named volume is the workspace's own or it is not there: a sibling's, named in a create, answers the same
/// sentence the engine answers for a volume nobody made, and a name nothing holds yet is made here labelled
/// before the create goes on.
#[tokio::test]
async fn a_create_attaches_the_workspaces_own_volumes_alone() {
    let w = world();
    let attaching = |name: &str| json!({ "Image": "alpine", "HostConfig": { "Binds": [format!("{name}:/var/lib/postgresql/data")] } });
    let (status, _, body) = w.call("POST", "/v1.55/containers/create", Some(&attaching("voltheirs1"))).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such volume: voltheirs1"));
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_none(), "{:?}", w.reached());
    // A volume of the workspace's own reaches the create, and nothing is made for it.
    let (status, _, _) = w.call("POST", "/v1.55/containers/create", Some(&attaching("volours1"))).await;
    assert_eq!(status, 200);
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_some());
    assert!(w.engine_saw("POST", "/volumes/create").is_none(), "{:?}", w.reached());
    // A name the engine holds nothing under: made first, wearing the label the next attach reads it by.
    let (status, _, _) = w.call("POST", "/v1.55/containers/create", Some(&attaching("dbdata"))).await;
    assert_eq!(status, 200);
    let made = w.engine_saw("POST", "/volumes/create").expect("the volume was made before the create");
    assert_eq!(serde_json::from_str::<Value>(&made.body).unwrap(), json!({ "Name": "dbdata", "Labels": { LABEL: WORKSPACE } }));
    // A mount names one the same way, and an anonymous one names none.
    let mounted = json!({
        "Image": "alpine",
        "HostConfig": { "Mounts": [
            { "Type": "volume", "Source": "voltheirs1", "Target": "/data" },
            { "Type": "volume", "Target": "/anon" }
        ] }
    });
    let (status, _, body) = w.call("POST", "/v1.55/containers/create", Some(&mounted)).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such volume: voltheirs1"));
}

/// A workspace's network is a bridge of its own, named by this computer so the table's rules read a container
/// on it as they read the workspace; the daemon is told the moment the engine has made the link.
#[tokio::test]
async fn a_network_create_is_a_bridge_of_the_workspaces_own_and_the_daemon_is_told() {
    let w = world();
    for (body, says) in [
        (json!({ "Name": "n", "Driver": "macvlan" }), "the driver macvlan is refused"),
        (json!({ "Name": "n", "EnableIPv6": true }), "EnableIPv6 is refused"),
        (json!({ "Name": "n", "IPAM": { "Config": [{ "Subnet": "10.65.4.0/24" }] } }), "overlaps 10.65.0.0/16"),
        (json!({ "Name": "n", "Options": { "com.docker.network.bridge.name": "docker0" } }), "is named by this computer"),
    ] {
        let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&body)).await;
        assert_eq!(status, 403, "{}", World::message(&answered));
        assert!(World::message(&answered).contains(says), "{}", World::message(&answered));
    }
    assert!(w.engine_saw("POST", "/v1.55/networks/create").is_none(), "{:?}", w.reached());
    let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&json!({ "Name": "demo_default" }))).await;
    assert_eq!(status, 201, "{}", World::message(&answered));
    let sent: Value = serde_json::from_str(&w.engine_saw("POST", "/v1.55/networks/create").unwrap().body).unwrap();
    let bridge = sent["Options"]["com.docker.network.bridge.name"].as_str().unwrap().to_owned();
    assert!(bridge.starts_with("wsp-e") && bridge.len() == 13, "{bridge}");
    assert_eq!(sent["Labels"][LABEL], WORKSPACE);
    assert_eq!(w.bridged.0.lock().unwrap().clone(), vec![(WORKSPACE.to_owned(), bridge, true)]);
    // And the rule goes with the network at its delete, off the bridge name the engine's own inspect carries.
    let (status, _, _) = w.call("DELETE", "/v1.55/networks/netours1", None).await;
    assert_eq!(status, 204);
    assert_eq!(w.bridged.0.lock().unwrap().last().unwrap().clone(), (WORKSPACE.to_owned(), FAKE_BRIDGE.to_owned(), false));
}

/// A container that asked for no network of its own: the engine's default bridge is the box's, so the create is
/// rewritten to the workspace's own network, which the fence makes the first time it is needed.
#[tokio::test]
async fn a_container_on_no_named_network_joins_the_workspaces_own() {
    let w = world();
    let own = format!("wsp-{WORKSPACE}");
    for plain in ["", "default", "bridge"] {
        let body = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": plain } });
        let (status, _, answered) = w.call("POST", "/v1.55/containers/create", Some(&body)).await;
        assert_eq!(status, 200, "{plain}: {}", World::message(&answered));
        let sent = w.reached().into_iter().rfind(|r| r.path.starts_with("/v1.55/containers/create")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&sent.body).unwrap()["HostConfig"]["NetworkMode"], own, "{plain}");
    }
    // The workspace's own network was made once for each create, since this fake engine holds none afterwards.
    let made: Vec<Value> = w
        .reached()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path == "/networks/create")
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect();
    assert_eq!(made.len(), 3, "{made:?}");
    assert_eq!(made[0]["Name"], own);
    assert_eq!(made[0]["Labels"][LABEL], WORKSPACE);
    assert!(made[0]["Options"]["com.docker.network.bridge.name"].as_str().unwrap().starts_with("wsp-e"));
    // A create this fence refuses leaves the engine as it found it: every name a create carries is read before
    // anything is made for it, so the refusal of a network the workspace does not own makes no network first.
    let before = w.reached().iter().filter(|r| r.path == "/networks/create").count();
    let both = json!({
        "Image": "alpine",
        "HostConfig": { "NetworkMode": "bridge" },
        "NetworkingConfig": { "EndpointsConfig": { "ztheirs1": {} } }
    });
    let (status, _, answered) = w.call("POST", "/v1.55/containers/create", Some(&both)).await;
    assert_eq!((status, World::message(&answered).as_str()), (404, "No such network: ztheirs1"));
    assert_eq!(w.reached().iter().filter(|r| r.path == "/networks/create").count(), before, "a refused create made a network");
    // A container asking for no network at all still gets none.
    let (status, _, _) =
        w.call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "none" } }))).await;
    assert_eq!(status, 200);
    let sent = w.reached().into_iter().rfind(|r| r.path.starts_with("/v1.55/containers/create")).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&sent.body).unwrap()["HostConfig"]["NetworkMode"], "none");
}

/// The smuggling shape the cold review named: a request framed by a length and by chunks at once is read one
/// way here and the other way by the engine, and what lies between the two readings is a request the engine
/// answers on its own. Refused at the head, so neither the request nor what rides behind it crosses.
#[tokio::test]
async fn a_request_framed_both_ways_is_refused_before_a_byte_crosses() {
    let w = world();
    let smuggled = "GET /v1.55/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n";
    let body = format!("0\r\n\r\n{smuggled}");
    let request = format!(
        "POST /v1.55/exec/execours1/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: {}\r\nTransfer-Encoding: chunked\r\n\r\n{body}",
        body.len()
    );
    let answered = String::from_utf8(w.raw(request.as_bytes()).await).unwrap();
    assert!(answered.starts_with("HTTP/1.1 400 Bad Request\r\n"), "{answered}");
    assert!(answered.contains("with a length or with chunks and not both"), "{answered}");
    // Neither the request nor the one riding behind it: this fake engine reads the chunks and drops the length,
    // as the box engine does, so the bytes past the terminator would be its next request.
    assert!(w.engine_saw("POST", "/v1.55/exec/execours1/start").is_none(), "{:?}", w.reached());
    assert!(w.engine_saw("GET", "/v1.55/containers/json").is_none(), "{:?}", w.reached());
    assert!(w.reached().is_empty(), "{:?}", w.reached());
}

/// A hijack route the engine answered without handing the connection over, which is what a detached exec start
/// gets: the answer is one answer, this side of the engine's connection ends with it, and nothing waits on a
/// close the engine was never told to make.
#[tokio::test]
async fn a_hijack_route_the_engine_did_not_hand_over_ends_the_engines_connection() {
    let w = world();
    // Detached, and so asking for no upgrade: the engine answers and keeps its connection, handing nothing
    // over, and the route being a hijack route is what left this side of it open.
    let body = r#"{"Detach":true,"Tty":false}"#;
    let request = format!(
        "POST /v1.55/exec/execours1/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let answered = String::from_utf8(w.raw(request.as_bytes()).await).unwrap();
    assert!(answered.starts_with("HTTP/1.1 200 "), "{answered}");
    assert!(answered.contains("Connection: close"), "{answered}");
    assert_eq!(w.engine_saw("POST", "/v1.55/exec/execours1/start").unwrap().body, body);
    // One request on that connection and no other: the engine's side ended with its answer.
    assert_eq!(w.reached().iter().filter(|r| r.path.starts_with("/v1.55/exec/execours1/start")).count(), 1, "{:?}", w.reached());
}

/// An inspect the engine answered neither 200 nor 404 to says nothing about whose a name is: the create fails
/// rather than reading it as a name nothing holds and making one over it.
#[tokio::test]
async fn a_volume_the_engine_would_not_answer_for_fails_the_create() {
    let w = world();
    let body = json!({ "Image": "alpine", "HostConfig": { "Binds": ["volbroken1:/var/lib/data"] } });
    let (status, _, answered) = w.call("POST", "/v1.55/containers/create", Some(&body)).await;
    assert_eq!(status, 502, "{}", World::message(&answered));
    assert!(World::message(&answered).contains("the engine answered 500"), "{}", World::message(&answered));
    assert!(w.engine_saw("POST", "/volumes/create").is_none(), "a volume was made over a name the engine would not answer for");
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_none(), "{:?}", w.reached());
}

/// A network named the way this computer names a workspace's own default network is a name a sibling's network
/// holds or will hold, and taking it would refuse every plain container that sibling starts. The name compose
/// derives from the project, which is the workspace's own id, is not that name and passes: a workspace brings a
/// stack up without naming a project, and its default network is the one it wants.
#[tokio::test]
async fn a_network_named_as_this_computer_names_its_own_is_refused_and_a_projects_default_is_not() {
    let w = world();
    let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&json!({ "Name": "wsp-wsp-other" }))).await;
    assert_eq!(status, 403, "{}", World::message(&answered));
    assert!(World::message(&answered).contains("this computer makes for a workspace of its own"), "{}", World::message(&answered));
    assert!(w.engine_saw("POST", "/v1.55/networks/create").is_none(), "{:?}", w.reached());
    let named = format!("{WORKSPACE}_default");
    let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&json!({ "Name": &named }))).await;
    assert_eq!(status, 201, "{}", World::message(&answered));
    let sent: Value = serde_json::from_str(&w.engine_saw("POST", "/v1.55/networks/create").unwrap().body).unwrap();
    assert_eq!(sent["Name"], named);
    assert_eq!(sent["Labels"][LABEL], WORKSPACE);
    assert!(sent["Options"]["com.docker.network.bridge.name"].as_str().unwrap().starts_with("wsp-e"), "{sent}");
}

/// The network a sibling's own stack will derive: its project is that sibling's id and compose adds the suffix,
/// so a workspace holding the name first would refuse that sibling's stack the network it asks for at its first
/// step. The name is the stem's, whoever asks for it.
#[tokio::test]
async fn a_network_named_for_a_siblings_own_stack_is_refused() {
    let w = world();
    let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&json!({ "Name": "wsp-b_default" }))).await;
    assert_eq!(status, 403, "{}", World::message(&answered));
    assert_eq!(
        World::message(&answered),
        "a network named wsp-b_default is the one the workspace whose compose project is wsp-b brings its own stack up on, so it is refused here"
    );
    assert!(w.engine_saw("POST", "/v1.55/networks/create").is_none(), "{:?}", w.reached());
}

/// A workspace whose id carries a character compose does not take: the project compose is handed is that id
/// rewritten, so the network its own stack derives is named after the project and never after the id. The fence
/// reads the stem the same way, so this workspace gets its own network and a sibling's is still refused.
#[tokio::test]
async fn a_workspace_whose_id_compose_rewrites_still_gets_the_network_its_stack_derives() {
    let w = world_of("wsp-spoo.landing");
    let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&json!({ "Name": "wsp-spoo-landing_default" }))).await;
    assert_eq!(status, 201, "{}", World::message(&answered));
    let sent: Value = serde_json::from_str(&w.engine_saw("POST", "/v1.55/networks/create").unwrap().body).unwrap();
    assert_eq!(sent["Labels"][LABEL], "wsp-spoo.landing");
    assert!(sent["Options"]["com.docker.network.bridge.name"].as_str().unwrap().starts_with("wsp-e"), "{sent}");
    let (status, _, answered) = w.call("POST", "/v1.55/networks/create", Some(&json!({ "Name": "wsp-b_default" }))).await;
    assert_eq!(status, 403, "{}", World::message(&answered));
}
