// SPDX-License-Identifier: AGPL-3.0-only
//! The two readings over the wire: the sys and proc cases the node daemon's suite pins, driven the way its clients
//! drive them against a fake /proc tree, and the block where nothing a pane asks for stays pending.

mod fake_proc;

use std::io::Write;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fake_proc::{fake_passwd, fake_proc_tree, write_proc, write_sys, FakeProc, FakeSys, BTIME};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_daemon::{Daemon, Options};
use wsp_frames::{words, DaemonEvent};

const TOKEN: &str = "ops-token";

struct Running {
    addr: SocketAddr,
    lines: Arc<Mutex<Vec<String>>>,
    _token: tempfile::NamedTempFile,
    /// The daemon's own pid and its parent's, the two proc.kill protects beside init.
    pid: u32,
    parent_pid: u32,
}

impl Running {
    fn log(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }

    /// How many times the daemon logged one line.
    fn logged(&self, line: &str) -> usize {
        self.log().iter().filter(|l| *l == line).count()
    }
}

async fn start(tune: impl FnOnce(&mut Options)) -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    tune(&mut options);
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);
    let daemon = Daemon::bind_with(options, Box::new(move |line| sink.lock().unwrap().push(line.to_owned()))).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    Running { addr, lines, _token: token, pid: std::process::id(), parent_pid: std::os::unix::process::parent_id() }
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Every event frame any client in this file received, checked against the protocol at the end of each case.
struct Client {
    ws: Ws,
    events: Vec<Value>,
    next_id: u64,
}

impl Client {
    async fn connect(addr: SocketAddr) -> Client {
        let (ws, _) = connect_async(format!("ws://{addr}/")).await.unwrap();
        let mut c = Client { ws, events: Vec::new(), next_id: 1 };
        c.ws.send(Message::text(json!({ "id": 0, "op": "auth", "token": TOKEN }).to_string())).await.unwrap();
        let reply = c.read_until_reply(0).await;
        assert_eq!(reply["ok"], true);
        c
    }

    async fn read_until_reply(&mut self, id: u64) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), self.ws.next()).await.expect("the daemon answers within ten seconds");
            match msg {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v.get("id") == Some(&json!(id)) {
                        return v;
                    }
                    if v.get("type").is_some() {
                        self.events.push(v);
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("the socket closed while {id} was pending: {other:?}"),
            }
        }
    }

    /// Sends a request and does not wait for its answer.
    async fn send_frame(&mut self, op: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
        id
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        let id = self.send_frame(op, params).await;
        self.read_until_reply(id).await
    }

    /// Reads whatever arrives for the given time, so events pushed without a request are seen.
    async fn listen(&mut self, for_: Duration) {
        let deadline = tokio::time::Instant::now() + for_;
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v.get("type").is_some() {
                self.events.push(v);
            }
        }
    }

    /// Reads until an event of the type arrives that the test accepts, or the wait runs out.
    async fn wait_event(&mut self, ty: &str, within: Duration, accept: impl Fn(&Value) -> bool) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + within;
        if let Some(found) = self.of(ty).into_iter().find(|e| accept(e)) {
            return Some(found);
        }
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v.get("type").is_none() {
                    continue;
                }
                let hit = v["type"] == ty && accept(&v);
                self.events.push(v.clone());
                if hit {
                    return Some(v);
                }
            }
        }
        None
    }

    fn of(&self, ty: &str) -> Vec<Value> {
        self.events.iter().filter(|e| e["type"] == ty).cloned().collect()
    }

    /// Every event this client saw is one the protocol parses.
    fn wire_clean(&self) {
        for e in &self.events {
            assert!(serde_json::from_value::<DaemonEvent>(e.clone()).is_ok(), "the protocol refuses {e}");
        }
    }

    async fn close(mut self) {
        self.wire_clean();
        let _ = self.ws.close(None).await;
    }
}

struct Tree {
    root: tempfile::TempDir,
    passwd: (tempfile::TempDir, std::path::PathBuf),
}

fn tree() -> Tree {
    let root = fake_proc_tree(
        &[
            FakeProc { pid: 1, comm: Some("init".into()), ..FakeProc::default() },
            FakeProc {
                pid: 50,
                ppid: Some(1),
                comm: Some("node".into()),
                ticks: Some((0, 0)),
                cwd: Some("/root/app".into()),
                ..FakeProc::default()
            },
            FakeProc { pid: 51, ppid: Some(50), comm: Some("sh".into()), ..FakeProc::default() },
        ],
        4096,
    );
    // The load the fake machine reports: 8000 kB with 6000 kB available reads as 2000 kB used.
    write_sys(root.path(), &FakeSys { load1: Some(1.25), mem_total_kb: Some(8000), mem_available_kb: Some(6000) });
    Tree { root, passwd: fake_passwd() }
}

fn with_tree(t: &Tree) -> impl FnOnce(&mut Options) + '_ {
    move |o| {
        o.proc_root = Some(t.root.path().to_path_buf());
        o.passwd_path = Some(t.passwd.1.clone());
        o.sys_interval_ms = Some(20);
        o.proc_interval_ms = Some(20);
        o.root = Some(t.root.path().to_path_buf());
    }
}

#[tokio::test]
async fn sys_watch_streams_one_samplers_samples_to_every_subscriber_and_stops_it_when_the_last_socket_closes() {
    let t = tree();
    let d = start(with_tree(&t)).await;
    assert_eq!(d.logged(words::SYS_SAMPLER_STARTED), 0);
    let mut a = Client::connect(d.addr).await;
    let mut b = Client::connect(d.addr).await;
    assert_eq!(a.request("sys.watch", json!({})).await["ok"], true);
    assert_eq!(b.request("sys.watch", json!({})).await["ok"], true);
    // Both sockets saw the same stream, so the daemon ran one sampler, not one per socket. The second subscriber can
    // miss the sample the first was already sent, so the wait is for a sample both hold and not for a count each.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let shared = loop {
        a.listen(Duration::from_millis(30)).await;
        b.listen(Duration::from_millis(30)).await;
        let held_by_b = b.of("sys.sample");
        if let Some(s) = a.of("sys.sample").into_iter().find(|s| held_by_b.iter().any(|t| t["at"] == s["at"])) {
            break s;
        }
        assert!(tokio::time::Instant::now() < deadline, "no sample reached both sockets");
    };
    // The load and the memory are the fake tree's; the cpu is a delta between two reads of one stat file, and the
    // disk is the real volume under the daemon's root, so those two are numbers and not the tree's.
    assert_eq!(shared["type"], "sys.sample");
    assert_eq!(shared["load1"], json!(1.25));
    assert_eq!(shared["mem"], json!({ "used": 2000 * 1024, "total": 8000 * 1024 }));
    assert!(shared["cpu"].is_number());
    assert!(shared["disk"]["total"].as_u64().unwrap() > 0);
    assert!(shared["at"].is_number());
    assert!(b.of("sys.sample").contains(&shared));
    // Two watchers, one sampler: it started once and has not stopped.
    assert_eq!(d.logged(words::SYS_SAMPLER_STARTED), 1);
    assert_eq!(d.logged(words::SYS_SAMPLER_STOPPED), 0);

    a.close().await;
    // The close is a round trip the daemon has to read; the sampler the other socket holds keeps sampling for it.
    tokio::time::sleep(Duration::from_millis(60)).await;
    let with_one_left = b.of("sys.sample").len();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while b.of("sys.sample").len() <= with_one_left {
        assert!(tokio::time::Instant::now() < deadline, "the sampler stopped with a socket still watching");
        b.listen(Duration::from_millis(30)).await;
    }
    assert_eq!(d.logged(words::SYS_SAMPLER_STOPPED), 0);

    b.close().await;
    // The last close stops the sampler: the stop is the line the daemon logs, and once it is there nothing starts it again.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while d.logged(words::SYS_SAMPLER_STOPPED) == 0 {
        assert!(tokio::time::Instant::now() < deadline, "the sampler never stopped: {:?}", d.log());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!((d.logged(words::SYS_SAMPLER_STARTED), d.logged(words::SYS_SAMPLER_STOPPED)), (1, 1));
}

#[tokio::test]
async fn proc_watch_streams_snapshots_until_proc_unwatch_proc_inspect_reads_one_pid_proc_kill_refuses_the_protected_ones() {
    let t = tree();
    let d = start(with_tree(&t)).await;
    let mut a = Client::connect(d.addr).await;
    assert_eq!(a.request("proc.watch", json!({})).await["ok"], true);
    // A second watch on the same socket is not a second subscription.
    assert_eq!(a.request("proc.watch", json!({})).await["ok"], true);
    write_proc(
        t.root.path(),
        &FakeProc {
            pid: 50,
            ppid: Some(1),
            comm: Some("node".into()),
            ticks: Some((4, 0)),
            cwd: Some("/root/app".into()),
            ..FakeProc::default()
        },
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while a.of("proc.snapshot").len() < 2 && tokio::time::Instant::now() < deadline {
        a.listen(Duration::from_millis(10)).await;
    }
    let snaps = a.of("proc.snapshot");
    assert!(snaps.len() >= 2, "{}", snaps.len());
    assert_eq!((&snaps[0]["daemon"], &snaps[0]["total"]), (&json!(d.pid), &json!(3)));
    let pids: Vec<u64> = snaps[0]["procs"].as_array().unwrap().iter().map(|p| p["pid"].as_u64().unwrap()).collect();
    assert_eq!(pids, vec![1, 50, 51]);
    assert_eq!((&snaps[0]["procs"][2]["ppid"], &snaps[0]["procs"][2]["cmdline"]), (&json!(50), &json!("sh")));
    assert_eq!(d.logged(words::PROC_SAMPLER_STARTED), 1);

    let inspected = a.request("proc.inspect", json!({ "pid": 50 })).await;
    assert_eq!(
        inspected,
        json!({ "id": inspected["id"], "ok": true, "pid": 50, "cwd": "/root/app", "ports": [], "threads": 1, "children": [51] })
    );
    assert_eq!(a.request("proc.inspect", json!({ "pid": "x" })).await["code"], "bad-request");
    assert_eq!(a.request("proc.inspect", json!({ "pid": 999_999 })).await["code"], "not-found");
    // Above pid_max both ops refuse as bad-request.
    assert_eq!(a.request("proc.inspect", json!({ "pid": 1u64 << 40 })).await["code"], "bad-request");
    assert_eq!(a.request("proc.kill", json!({ "pid": 1u64 << 40, "signal": "TERM" })).await["code"], "bad-request");
    let above = a.request("proc.kill", json!({ "pid": 4_194_305, "signal": "TERM" })).await;
    assert_eq!((&above["code"], &above["error"]), (&json!("bad-request"), &json!("pid must be an integer between 1 and 4194304")));

    for pid in [1, d.pid, d.parent_pid] {
        assert_eq!(a.request("proc.kill", json!({ "pid": pid, "signal": "TERM" })).await["code"], "forbidden", "{pid}");
    }
    assert_eq!(a.request("proc.kill", json!({ "pid": 4_194_303, "signal": "HUP" })).await["code"], "bad-request");
    assert_eq!(a.request("proc.kill", json!({ "pid": 4_194_303, "signal": "KILL" })).await["code"], "not-found");
    assert_eq!(a.request("proc.kill", json!({ "pid": 4_194_303 })).await["code"], "bad-request");

    assert_eq!(a.request("proc.unwatch", json!({})).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(60)).await;
    a.listen(Duration::from_millis(10)).await;
    let after = a.of("proc.snapshot").len();
    a.listen(Duration::from_millis(100)).await;
    assert_eq!(a.of("proc.snapshot").len(), after);
    assert_eq!(d.logged(words::PROC_SAMPLER_STOPPED), 1);
    // An unwatch with no watch on the socket is still ok, and the close after it undoes nothing twice.
    assert_eq!(a.request("proc.unwatch", json!({})).await["ok"], true);
    a.close().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!((d.logged(words::PROC_SAMPLER_STARTED), d.logged(words::PROC_SAMPLER_STOPPED)), (1, 1));
}

#[tokio::test]
async fn an_exited_pty_stops_labelling_its_pid_so_a_stranger_who_reuses_it_carries_no_pty_id() {
    let t = tree();
    let d = start(with_tree(&t)).await;
    let mut a = Client::connect(d.addr).await;
    let created = a.request("pty.create", json!({ "shell": "bash", "cols": 40, "rows": 10 })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let pid = created["pid"].as_u64().unwrap() as u32;
    // The fake tree stands in for /proc: this entry is whatever process holds the pid, alive or reused.
    write_proc(t.root.path(), &FakeProc { pid, ppid: Some(1), comm: Some("bash".into()), ..FakeProc::default() });
    assert_eq!(a.request("proc.watch", json!({})).await["ok"], true);
    let row_of = |snap: &Value| snap["procs"].as_array().unwrap().iter().find(|p| p["pid"] == json!(pid)).cloned();
    let labelled = a.wait_event("proc.snapshot", Duration::from_secs(5), |s| row_of(s).is_some()).await.expect("the pid shows up");
    assert_eq!(row_of(&labelled).unwrap()["pty"], json!(pty_id));

    assert_eq!(a.request("pty.write", json!({ "ptyId": pty_id, "data": "exit\n" })).await["ok"], true);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let listed = a.request("pty.list", json!({})).await;
        let exited = listed["ptys"].as_array().unwrap().iter().any(|p| p["id"] == json!(pty_id) && p["exited"] == true);
        if exited {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "the shell never exited: {listed}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The snapshot after the exit can be one the sampler had already built, so the wait is on a snapshot that dropped
    // the label rather than on the next one to arrive.
    let after = a
        .wait_event("proc.snapshot", Duration::from_secs(10), |s| row_of(s).is_some_and(|row| row.get("pty").is_none()))
        .await
        .expect("a snapshot without the label");
    assert_eq!(row_of(&after).unwrap()["pid"], json!(pid));
    assert_eq!(a.request("proc.unwatch", json!({})).await["ok"], true);
    assert_eq!(a.request("pty.kill", json!({ "ptyId": pty_id })).await["ok"], true);
    a.close().await;
}

#[tokio::test]
async fn an_interval_flag_of_zero_still_streams_both_readings_instead_of_ending_the_daemon() {
    let t = tree();
    let d = start(|o| {
        with_tree(&t)(o);
        o.sys_interval_ms = Some(0);
        o.proc_interval_ms = Some(0);
    })
    .await;
    let mut c = Client::connect(d.addr).await;
    assert_eq!(c.request("sys.watch", json!({})).await["ok"], true);
    assert_eq!(c.request("proc.watch", json!({})).await["ok"], true);
    assert!(c.wait_event("sys.sample", Duration::from_secs(10), |_| true).await.is_some());
    assert!(c.wait_event("proc.snapshot", Duration::from_secs(10), |_| true).await.is_some());
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    c.close().await;
}

#[tokio::test]
async fn a_kind_with_no_modules_refuses_both_watches_in_the_words_the_pane_prints() {
    // Every kind in the enum has a module today, so the guard is proved against a kind that is not one.
    let d = start(|o| o.kind = "plan9".to_owned()).await;
    let mut c = Client::connect(d.addr).await;
    for op in ["sys.watch", "proc.watch", "proc.inspect"] {
        let res = c.request(op, json!({ "pid": 1 })).await;
        assert_eq!((&res["ok"], &res["code"]), (&json!(false), &json!("unsupported")), "{op}");
        assert!(res["error"].as_str().unwrap().starts_with("not on this kind"), "{res}");
    }
    assert!(d.log().is_empty());
    c.close().await;
}

#[tokio::test]
async fn a_machine_reached_over_ssh_reads_its_own_machine_since_the_daemon_on_it_is_the_one_a_fork_runs() {
    let t = tree();
    let d = start(|o| {
        with_tree(&t)(o);
        o.kind = "ssh".to_owned();
    })
    .await;
    let mut c = Client::connect(d.addr).await;
    assert_eq!(c.request("proc.watch", json!({})).await["ok"], true);
    assert_eq!(c.request("sys.watch", json!({})).await["ok"], true);
    c.close().await;
}

#[tokio::test]
async fn a_metrics_module_that_cannot_read_this_machine_refuses_the_watch_with_its_own_words_so_no_row_sits_at_pending() {
    // A /proc with nothing in it: the module names the file it could not read, and the pane prints that.
    let empty = tempfile::tempdir().unwrap();
    let d = start(|o| o.proc_root = Some(empty.path().to_path_buf())).await;
    let mut c = Client::connect(d.addr).await;
    let res = c.request("sys.watch", json!({})).await;
    assert_eq!(res["ok"], false);
    assert!(res["error"].as_str().unwrap().contains(empty.path().to_str().unwrap()), "{res}");
    assert!(res.get("code").is_none());
    assert_eq!(d.logged(words::SYS_SAMPLER_STARTED), 0);
    c.close().await;
}

#[tokio::test]
async fn a_processes_module_that_cannot_read_this_machine_refuses_the_watch_the_same_way() {
    let missing = tempfile::tempdir().unwrap().path().join("no-such-proc");
    let d = start(|o| o.proc_root = Some(missing.clone())).await;
    let mut c = Client::connect(d.addr).await;
    let res = c.request("proc.watch", json!({})).await;
    assert_eq!(res["ok"], false);
    assert!(res["error"].as_str().unwrap().contains("no-such-proc"), "{res}");
    let res = c.request("proc.inspect", json!({ "pid": 1 })).await;
    assert!(res["error"].as_str().unwrap().contains("no-such-proc"), "{res}");
    assert_eq!(d.logged(words::PROC_SAMPLER_STARTED), 0);
    c.close().await;
}

#[tokio::test]
async fn a_socket_that_goes_while_the_probe_is_still_reading_takes_no_stream_on_so_nothing_is_left_polling_for_it() {
    // A FIFO where the tree's stat is: both probes block on it until the test feeds it, which is after the socket
    // went, so the read that was in flight when the client left is the one that lands on a closed socket.
    let root = fake_proc_tree(&[FakeProc { pid: 1, ..FakeProc::default() }], 4096);
    let stat = root.path().join("stat");
    std::fs::remove_file(&stat).unwrap();
    nix::unistd::mkfifo(&stat, nix::sys::stat::Mode::from_bits_truncate(0o644)).unwrap();
    let d = start(|o| {
        o.proc_root = Some(root.path().to_path_buf());
        o.sys_interval_ms = Some(30);
        o.proc_interval_ms = Some(30);
    })
    .await;
    let mut c = Client::connect(d.addr).await;
    c.send_frame("sys.watch", json!({})).await;
    c.send_frame("proc.watch", json!({})).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(c);
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The write blocks until a reader holds the FIFO; a daemon that refused both watches before its probe would
    // never open it, and that is a failure with a cause, not a case held to its timeout.
    let feed =
        tokio::task::spawn_blocking(move || std::fs::write(&stat, format!("cpu  1 2 3 4 5 6 7 8 0 0\nbtime {BTIME}\nprocesses 100\n")));
    tokio::time::timeout(Duration::from_secs(5), feed)
        .await
        .expect("no probe opened the FIFO: the daemon refused the watches before reading")
        .unwrap()
        .unwrap();
    // Well past several of the samplers' intervals: a sampler left running would have logged its start.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        d.log().iter().filter(|l| *l == words::SYS_SAMPLER_STARTED || *l == words::PROC_SAMPLER_STARTED).count(),
        0,
        "{:?}",
        d.log()
    );
}

#[tokio::test]
async fn this_computers_own_kind_answers_both_watches_off_its_own_host_with_no_proc_anywhere() {
    // The /proc named here does not exist, which is what a Mac has: a daemon serving this computer must answer
    // without it, so a reading that arrives proves the host's own modules read it and not the guest's.
    let work = tempfile::tempdir().unwrap();
    let d = start(|o| {
        o.kind = "local".to_owned();
        o.work_folder = Some(work.path().to_path_buf());
        o.proc_root = Some(work.path().join("no-such-proc"));
        o.sys_interval_ms = Some(20);
        o.proc_interval_ms = Some(20);
    })
    .await;
    let mut c = Client::connect(d.addr).await;
    assert_eq!(c.request("sys.watch", json!({})).await["ok"], true);
    assert_eq!(c.request("proc.watch", json!({})).await["ok"], true);
    let sample = c.wait_event("sys.sample", Duration::from_secs(10), |_| true).await.expect("a sample");
    assert!(sample["load1"].is_number());
    assert!(sample["mem"]["total"].as_u64().unwrap() > 0);
    assert!(sample["disk"]["total"].as_u64().unwrap() > 0);
    let snap = c.wait_event("proc.snapshot", Duration::from_secs(10), |_| true).await.expect("a snapshot");
    let me = std::process::id();
    assert!(snap["procs"].as_array().unwrap().iter().any(|p| p["pid"] == json!(me)));
    assert_eq!(snap["daemon"], json!(d.pid));
    let inspected = c.request("proc.inspect", json!({ "pid": me })).await;
    assert_eq!((&inspected["ok"], &inspected["pid"]), (&json!(true), &json!(me)));
    assert!(inspected.get("threads").is_none(), "{inspected}");
    assert!(inspected["ports"].is_array());
    c.close().await;
}

#[tokio::test]
async fn a_watch_on_a_port_scoped_socket_is_refused_before_any_probe_runs() {
    let t = tree();
    let d = start(with_tree(&t)).await;
    let (mut ws, _) = connect_async(format!("ws://{}/", d.addr)).await.unwrap();
    ws.send(Message::text(json!({ "id": 0, "op": "auth", "token": TOKEN, "port": 8123 }).to_string())).await.unwrap();
    let mut frames = Vec::new();
    // The auth reply and the hello, then the refusal.
    ws.send(Message::text(json!({ "id": 1, "op": "sys.watch" }).to_string())).await.unwrap();
    while frames.len() < 3 {
        if let Some(Ok(Message::Text(t))) = ws.next().await {
            frames.push(serde_json::from_str::<Value>(&t).unwrap());
        }
    }
    assert_eq!(frames[2]["code"], "forbidden");
    assert!(d.log().is_empty());
}
