// SPDX-License-Identifier: AGPL-3.0-only
//! The binary as a process: the flags, the listening line, the port file, the ready line, and a wrong flag.

use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const BIN: &str = env!("CARGO_BIN_EXE_wsp-daemon");

/// What the daemon says about its two kernel knobs before the ready line, per platform: a platform that has
/// neither says nothing at all about them, and on Linux each knob a run may not set says so with the reason,
/// which root, the user a joined computer runs the daemon as, sets both of.
fn knob_lines(said: &[String]) {
    #[cfg(not(target_os = "linux"))]
    assert!(said.is_empty(), "a platform with neither knob said {said:?}");
    #[cfg(target_os = "linux")]
    {
        // SAFETY: geteuid reads one integer of this process and touches no memory of ours.
        let root = unsafe { libc::geteuid() } == 0;
        let want: &[&str] = if root { &[] } else { &["oom_score_adj not set: ", "priority not set: "] };
        assert_eq!(said.len(), want.len(), "{said:?}");
        for (line, starts) in said.iter().zip(want) {
            assert!(line.starts_with(starts) && line.len() > starts.len(), "no reason on {line}");
        }
    }
}

#[tokio::test]
async fn binds_prints_the_listening_line_writes_the_port_file_and_serves_the_door() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::File::create(&token).unwrap().write_all(b"bin-token\n").unwrap();
    let port_file = dir.path().join("daemon.port");
    let mut child = Command::new(BIN)
        .args(["--host", "127.0.0.1", "--port", "0", "--token-path"])
        .arg(&token)
        .arg("--port-file")
        .arg(&port_file)
        .arg("--root")
        .arg(dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
    let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
    assert_eq!(std::fs::read_to_string(&port_file).unwrap(), format!("{port}\n"));
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut before = Vec::new();
    let ready = loop {
        let line = tokio::time::timeout(Duration::from_secs(5), stderr.next_line()).await.unwrap().unwrap().unwrap();
        if line.starts_with("ready in ") {
            break line;
        }
        before.push(line);
    };
    assert!(ready.ends_with(" ms"), "{ready}");
    knob_lines(&before);

    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
    ws.send(Message::text(json!({ "id": 1, "op": "auth", "token": "bin-token" }).to_string())).await.unwrap();
    let mut frames = Vec::new();
    for _ in 0..2 {
        if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
            frames.push(serde_json::from_str::<Value>(&t).unwrap());
        }
    }
    assert_eq!(frames[0], json!({ "id": 1, "ok": true }));
    assert_eq!(frames[1]["type"], "daemon.hello");
    assert_eq!(frames[1]["root"], dir.path().to_str().unwrap());
    ws.send(Message::text(json!({ "id": 2, "op": "ping" }).to_string())).await.unwrap();
    if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
        assert_eq!(serde_json::from_str::<Value>(&t).unwrap(), json!({ "id": 2, "ok": true }));
    }
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_wrong_flag_prints_the_usage_line_and_exits_2() {
    let out = Command::new(BIN).arg("--wat").output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--wat"), "{stderr}");
    assert!(stderr.contains("usage: wsp-daemon [--host <addr>] [--port <n>] [--token-path <file>] [--root <dir>]"), "{stderr}");
    let out = Command::new(BIN).args(["--port", "abc"]).output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--port"));
}

#[tokio::test]
async fn runtime_ask_names_its_root_on_purpose_or_not_at_all() {
    // A frame that is not JSON, so nothing past the flags could run whatever the root: the refusal is the flag's.
    let out = Command::new(BIN).args(["runtime", "ask", "not a frame"]).output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--root"), "{stderr}");
}

/// The exec verb on a bundle whose filter has a rule with the notify action: the refusal is the helper's own, before
/// youki is asked, so no state directory is needed and no root.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn runtime_exec_refuses_a_filter_with_a_notify_action_and_exits_125() {
    let dir = tempfile::tempdir().unwrap();
    let layout = wsp_runtime::bundle::Layout::new(dir.path());
    std::fs::create_dir_all(layout.workspace("wsp-n")).unwrap();
    let args = vec!["/sbin/wsp-init".to_owned()];
    let mut spec = wsp_runtime::bundle::config_json(&wsp_runtime::bundle::Config {
        hostname: "wsp-n",
        args: &args,
        envs: &std::collections::BTreeMap::new(),
        cpu: None,
        mem_mb: None,
        cgroup: &layout.cgroup_name("wsp-n"),
        init: std::path::Path::new(BIN),
        etc: &layout.etc("wsp-n"),
        engine: None,
        shares: &[],
        binds: &[],
        tool_roots: &[],
        compose_project: None,
    });
    spec["linux"]["seccomp"]["syscalls"].as_array_mut().unwrap().push(json!({ "names": ["getcwd"], "action": "SCMP_ACT_NOTIFY" }));
    wsp_runtime::bundle::write_json(&layout.config("wsp-n"), &spec).unwrap();
    let out = Command::new(BIN)
        .args(["runtime", "exec", "--root"])
        .arg(dir.path())
        .args(["--id", "wsp-n", "--timeout-ms", "1000", "--", "true"])
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(125));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        stderr.lines().last().unwrap(),
        "wsp-runtime: the workspace's seccomp filter has a rule whose action is notify, and an exec serves no listener for it, so the command did not run",
        "{stderr}"
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
}

#[tokio::test]
async fn refuses_to_start_without_a_token_file_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    // Spawned and bounded rather than awaited outright: a daemon that wrongly started would run for good.
    let child = Command::new(BIN)
        .args(["--host", "127.0.0.1", "--port", "0", "--token-path"])
        .arg(dir.path().join("missing"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await.expect("the binary exits at once").unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("wsp-daemon failed to start: daemon refuses to start without an auth token"), "{stderr}");
    assert!(out.stdout.is_empty());
}

/// A daemon spawned with a fake stty first on its PATH and a fake /proc: the mode probe reads both, so a test
/// can flip what the slave says without a real terminal changing state.
struct FakeModes {
    dir: tempfile::TempDir,
    child: tokio::process::Child,
    port: u16,
}

impl FakeModes {
    async fn start() -> FakeModes {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "modes-token\n").unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(dir.path().join("modes"), "icanon echo\n").unwrap();
        let script = format!("#!/bin/sh\necho run >> {d}/count\ncat {d}/modes\n", d = dir.path().display());
        let stty = bin.join("stty");
        std::fs::write(&stty, script).unwrap();
        std::fs::set_permissions(&stty, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let mut child = Command::new(BIN)
            .args(["--host", "127.0.0.1", "--port", "0", "--mode-interval-ms", "50", "--token-path"])
            .arg(&token)
            .arg("--proc-root")
            .arg(dir.path().join("proc"))
            .arg("--root")
            .arg(dir.path())
            .env("PATH", path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
        let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
        FakeModes { dir, child, port }
    }

    /// The fake tree for one shell pid: its stdin a tty, its stat naming a foreground group, that group's comm.
    fn tree(&self, pid: u64, tpgid: u64, comm: &str) {
        let proc_root = self.dir.path().join("proc");
        let me = proc_root.join(pid.to_string());
        std::fs::create_dir_all(me.join("fd")).unwrap();
        std::os::unix::fs::symlink("/dev/pts/9", me.join("fd/0")).unwrap();
        std::fs::write(me.join("stat"), format!("{pid} (bash) S 1 {pid} {pid} 34816 {tpgid} 4194304 0 0 0 0")).unwrap();
        std::fs::create_dir_all(proc_root.join(tpgid.to_string())).unwrap();
        self.comm(tpgid, comm);
    }

    fn comm(&self, tpgid: u64, comm: &str) {
        std::fs::write(self.dir.path().join("proc").join(tpgid.to_string()).join("comm"), format!("{comm}\n")).unwrap();
    }

    fn modes(&self, text: &str) {
        std::fs::write(self.dir.path().join("modes"), format!("{text}\n")).unwrap();
    }

    fn probes(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("count")).map(|s| s.lines().count()).unwrap_or(0)
    }
}

struct Peer {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    frames: Vec<Value>,
    next: u64,
}

impl Peer {
    async fn connect(port: u16) -> Peer {
        let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
        let mut peer = Peer { ws, frames: Vec::new(), next: 1 };
        assert_eq!(peer.request("auth", json!({ "token": "modes-token" })).await["ok"], true);
        peer
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.expect("answered in time").unwrap().unwrap() {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    let done = v["id"] == json!(id);
                    self.frames.push(v);
                    if done {
                        return self.frames.last().unwrap().clone();
                    }
                }
                _ => continue,
            }
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

    async fn listen(&mut self, for_: Duration) {
        let deadline = tokio::time::Instant::now() + for_;
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            self.frames.push(serde_json::from_str(&t).unwrap());
        }
    }

    fn events(&self, ty: &str) -> Vec<Value> {
        self.frames.iter().filter(|f| f["type"] == ty).cloned().collect()
    }
}

fn mode(pty_id: &str, mode: &str, echo: bool, foreground: &str) -> Value {
    json!({ "type": "pty.mode", "ptyId": pty_id, "mode": mode, "echo": echo, "foreground": foreground })
}

#[tokio::test]
async fn pushes_pty_mode_on_attach_and_again_when_the_probed_state_changes() {
    let mut d = FakeModes::start().await;
    let mut c = Peer::connect(d.port).await;
    let created = c.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let pid = created["pid"].as_u64().unwrap();
    d.tree(pid, 4567, "bash");
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |_| true).await, "{:?}", c.frames);
    assert_eq!(c.events("pty.mode"), [mode(&pty_id, "line", true, "bash")]);

    // One change at a time: the slave's modes first, then the foreground process.
    d.modes("-icanon -echo");
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |e| e["mode"] == "raw").await, "{:?}", c.frames);
    assert_eq!(c.events("pty.mode").len(), 2);
    assert_eq!(c.events("pty.mode")[1], mode(&pty_id, "raw", false, "bash"));
    d.comm(4567, "vim");
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |e| e["foreground"] == "vim").await, "{:?}", c.frames);
    c.listen(Duration::from_millis(200)).await;
    assert_eq!(c.events("pty.mode").len(), 3);
    assert_eq!(c.events("pty.mode")[2], mode(&pty_id, "raw", false, "vim"));
    d.child.kill().await.unwrap();
}

#[tokio::test]
async fn stops_probing_once_the_pty_exits_even_with_the_client_still_attached() {
    let mut d = FakeModes::start().await;
    let mut c = Peer::connect(d.port).await;
    let created = c.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    d.tree(created["pid"].as_u64().unwrap(), 4567, "bash");
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |_| true).await, "{:?}", c.frames);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "exit\n" })).await["ok"], true);
    assert!(c.wait_event("pty.exit", Duration::from_secs(3), |_| true).await, "{:?}", c.frames);
    // A probe already running when the exit came finishes; the count settles over a few intervals and then holds.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let at_exit = d.probes();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(d.probes(), at_exit);

    // A late attach to the dead pty must not restart the loop either.
    let mut c2 = Peer::connect(d.port).await;
    assert_eq!(c2.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    c2.listen(Duration::from_millis(300)).await;
    assert_eq!(d.probes(), at_exit);
    assert_eq!(c2.events("pty.exit").len(), 1, "{:?}", c2.frames);
    d.child.kill().await.unwrap();
}

/// A daemon spawned plain, its process a thing the test can count threads and fds of.
async fn plain_daemon(env_without: Option<&str>) -> (tempfile::TempDir, tokio::process::Child, u16) {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::write(&token, "modes-token\n").unwrap();
    let mut command = Command::new(BIN);
    command.args(["--host", "127.0.0.1", "--port", "0", "--token-path"]).arg(&token).arg("--root").arg(dir.path());
    if let Some(name) = env_without {
        command.env_remove(name);
    }
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
    let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
    (dir, child, port)
}

fn count(pid: u32, what: &str) -> usize {
    std::fs::read_dir(format!("/proc/{pid}/{what}")).unwrap().count()
}

/// Polls a check on /proc until it holds or five seconds pass, since a pty's threads end after its exit event.
async fn settles(mut holds: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !holds() {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// The daemon's threads less tokio's blocking pool, whose threads come for any file read and idle out after ten seconds.
fn own_threads(pid: u32) -> usize {
    thread_names(pid).iter().filter(|n| *n != "tokio-rt-worker").count()
}

fn thread_names(pid: u32) -> Vec<String> {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .filter_map(|t| std::fs::read_to_string(t.unwrap().path().join("comm")).ok())
        .map(|n| n.trim().to_owned())
        .collect()
}

#[tokio::test]
async fn an_exited_pty_holds_its_scrollback_and_no_thread_or_fd_until_it_is_killed() {
    let (_dir, mut child, port) = plain_daemon(None).await;
    let pid = child.id().unwrap();
    let mut c = Peer::connect(port).await;
    // The startup sweep of copies a stop cut short runs on an unnamed thread beside main, holding fds while it lasts.
    assert!(settles(|| own_threads(pid) == 1).await, "a resting daemon runs its main thread alone: {:?}", thread_names(pid));
    let (threads, fds) = (own_threads(pid), count(pid, "fd"));
    let mut ids = Vec::new();
    for _ in 0..10 {
        let created = c.request("pty.create", json!({ "shell": "bash" })).await;
        ids.push(created["ptyId"].as_str().unwrap().to_owned());
    }
    assert!(settles(|| own_threads(pid) >= threads + 30).await, "each live pty has its three threads: {:?}", thread_names(pid));
    assert!(settles(|| thread_names(pid).iter().any(|n| n.starts_with("pty-w-"))).await, "{:?}", thread_names(pid));
    for id in &ids {
        assert_eq!(c.request("pty.write", json!({ "ptyId": id, "data": "exit\n" })).await["ok"], true);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let listed = c.request("pty.list", json!({})).await;
        let entries = listed["ptys"].as_array().unwrap();
        if entries.len() == 10 && entries.iter().all(|p| p["exited"] == true) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "every shell exits: {listed}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(settles(|| own_threads(pid) == threads).await, "threads after ten exits: {:?}", thread_names(pid));
    assert!(settles(|| count(pid, "fd") == fds).await, "fds after ten exits: {} of {fds}", count(pid, "fd"));
    assert!(!thread_names(pid).iter().any(|n| n.starts_with("pty-")), "{:?}", thread_names(pid));
    // The scrollback is still there for a late attach; the ten entries stay listed until pty.kill.
    assert_eq!(c.request("pty.attach", json!({ "ptyId": ids[0] })).await["ok"], true);
    assert!(c.events("pty.data").iter().any(|e| e["data"].as_str().unwrap_or("").contains("exit")));
    assert_eq!(c.events("pty.exit").len(), 1);
    let r = c.request("pty.resize", json!({ "ptyId": ids[0], "cols": 100, "rows": 30 })).await;
    assert_eq!((r["ok"].as_bool(), r["error"].as_str()), (Some(false), Some(format!("{} has exited", ids[0]).as_str())));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_shell_it_spawns_sees_home_and_user_even_when_the_daemon_has_none() {
    let (_dir, mut child, port) = plain_daemon(Some("HOME")).await;
    let row = std::process::Command::new("sh").args(["-c", "getent passwd \"$(id -u)\""]).output().unwrap();
    let row = String::from_utf8_lossy(&row.stdout);
    let fields: Vec<&str> = row.trim().split(':').collect();
    let (user, home) = (fields[0], fields[5]);
    let mut c = Peer::connect(port).await;
    let created = c.request("pty.create", json!({ "shell": "bash", "cwd": "/" })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo HOME=$HOME USER=$USER\n" })).await["ok"], true);
    let want = format!("HOME={home} USER={user}\r");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !c.events("pty.data").iter().map(|e| e["data"].as_str().unwrap_or("")).collect::<String>().contains(&want) {
        assert!(tokio::time::Instant::now() < deadline, "{:?}", c.events("pty.data"));
        c.listen(Duration::from_millis(100)).await;
    }
    child.kill().await.unwrap();
}

/// The copy verb as the host runs it: a child with argv, one JSON line on stdout, exit 0. The line is the whole
/// of stdout, since the host parses it rather than searching it.
#[tokio::test]
async fn the_copy_verb_prints_one_json_line_and_takes_the_copy_away_again() {
    let dir = tempfile::tempdir().unwrap();
    let from = dir.path().join("work");
    std::fs::create_dir_all(&from).unwrap();
    for args in [
        vec!["init", "--quiet", "--initial-branch", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
    ] {
        assert!(std::process::Command::new("git").args(&args).current_dir(&from).status().unwrap().success(), "{args:?}");
    }
    std::fs::write(from.join("README.md"), b"one\n").unwrap();
    assert!(std::process::Command::new("git").args(["add", "README.md"]).current_dir(&from).status().unwrap().success());
    assert!(std::process::Command::new("git").args(["commit", "--quiet", "-m", "first"]).current_dir(&from).status().unwrap().success());
    std::fs::create_dir_all(from.join(".next")).unwrap();
    let to = dir.path().join("work-other");

    let made = std::process::Command::new(BIN)
        .args(["copy", "make", "--from"])
        .arg(&from)
        .arg("--to")
        .arg(&to)
        .args(["--exclude", ".next", "--size-line-bytes", "21474836480"])
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&made.stderr).into_owned();
    if cfg!(target_os = "macos") {
        assert!(made.status.success(), "{said}");
        let out = String::from_utf8_lossy(&made.stdout);
        assert_eq!(out.lines().count(), 1, "{out}");
        let report: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("{out}: {e}"));
        assert_eq!(report["road"], "clonefile");
        assert_eq!(report["path"], to.display().to_string());
        assert_eq!(report["branch"], "main");
        assert_eq!(report["carried"], "deps-and-config");
        assert_eq!(report["excluded"], json!([".next"]));
        assert!(to.join("README.md").exists() && !to.join(".next").exists());

        let removed = std::process::Command::new(BIN)
            .args(["copy", "remove", "--from"])
            .arg(&from)
            .arg("--to")
            .arg(&to)
            .args(["--road", "clonefile"])
            .output()
            .unwrap();
        assert!(removed.status.success(), "{}", String::from_utf8_lossy(&removed.stderr));
        assert!(!to.exists());
    } else {
        // A computer that runs workspaces of its own answers the one sentence and makes nothing.
        assert_eq!(made.status.code(), Some(1), "{said}");
        assert_eq!(said.trim(), "this computer copies through its workspace runtime; wsp-daemon copy serves a Mac");
        assert!(String::from_utf8_lossy(&made.stdout).is_empty());
        assert!(!to.exists());
        let removed = std::process::Command::new(BIN)
            .args(["copy", "remove", "--from"])
            .arg(&from)
            .arg("--to")
            .arg(&to)
            .args(["--road", "worktree"])
            .output()
            .unwrap();
        assert_eq!(removed.status.code(), Some(1));
        assert_eq!(
            String::from_utf8_lossy(&removed.stderr).trim(),
            "this computer copies through its workspace runtime; wsp-daemon copy serves a Mac"
        );
    }
}

/// A repo named `work` with one commit on main, inside `dir`.
#[cfg(target_os = "macos")]
fn repo_in(dir: &std::path::Path) -> std::path::PathBuf {
    let from = dir.join("work");
    std::fs::create_dir_all(&from).unwrap();
    for args in [
        vec!["init", "--quiet", "--initial-branch", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
    ] {
        assert!(std::process::Command::new("git").args(&args).current_dir(&from).status().unwrap().success(), "{args:?}");
    }
    std::fs::write(from.join("README.md"), b"one\n").unwrap();
    assert!(std::process::Command::new("git").args(["add", "README.md"]).current_dir(&from).status().unwrap().success());
    assert!(std::process::Command::new("git").args(["commit", "--quiet", "-m", "first"]).current_dir(&from).status().unwrap().success());
    from
}

#[cfg(target_os = "macos")]
fn copy_remove(from: &std::path::Path, to: &std::path::Path) -> std::process::Output {
    std::process::Command::new(BIN)
        .args(["copy", "remove", "--from"])
        .arg(from)
        .arg("--to")
        .arg(to)
        .args(["--road", "clonefile"])
        .output()
        .unwrap()
}

/// A remove takes only what a make put down: a sibling of the project named after it. The project itself, a
/// folder elsewhere and a sibling of another name stay, and the refusal says why and what to name.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn the_copy_verb_removes_nothing_that_is_not_a_copy_of_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let from = repo_in(dir.path());
    let elsewhere = tempfile::tempdir().unwrap();
    let far = elsewhere.path().join("work-feature");
    let other = dir.path().join("other");
    let bare = dir.path().join("work-");
    for folder in [&far, &other, &bare] {
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join("kept"), b"mine\n").unwrap();
    }
    for to in [&from, &far, &other, &bare] {
        let refused = copy_remove(&from, to);
        assert_eq!(refused.status.code(), Some(1), "{} was taken", to.display());
        assert_eq!(
            String::from_utf8_lossy(&refused.stderr).trim(),
            format!(
                "{} is not a copy of {}, so nothing was removed; a copy sits beside its project as {}/work-<work>, and --to names that path",
                to.display(),
                from.display(),
                dir.path().display()
            )
        );
    }
    assert!(from.join("README.md").is_file() && far.join("kept").is_file() && other.join("kept").is_file() && bare.join("kept").is_file());
}

/// A removal cut short leaves a hidden sibling beside the project, and the next make or remove beside that project
/// takes it, so it never waits for the daemon's next start.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn the_copy_verb_takes_a_removal_left_beside_the_project_on_make_and_on_remove() {
    let dir = tempfile::tempdir().unwrap();
    let from = repo_in(dir.path());
    let kept = dir.path().join(".cache");
    std::fs::create_dir_all(&kept).unwrap();
    let to = dir.path().join("work-other");
    let leftover = |n: u32| {
        let left = dir.path().join(format!(".wsp-removing-work-old-{n}-1"));
        std::fs::create_dir_all(left.join("node_modules/pkg")).unwrap();
        std::fs::write(left.join("node_modules/pkg/index.js"), b"dep\n").unwrap();
        left
    };
    let gone = |left: &std::path::Path| {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while left.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        !left.exists()
    };
    let left = leftover(1);
    let made = std::process::Command::new(BIN).args(["copy", "make", "--from"]).arg(&from).arg("--to").arg(&to).output().unwrap();
    assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
    assert!(gone(&left), "a make left the leftover beside the project");
    let left = leftover(2);
    let removed = copy_remove(&from, &to);
    assert!(removed.status.success(), "{}", String::from_utf8_lossy(&removed.stderr));
    assert!(gone(&left), "a remove left the leftover beside the project");
    assert!(kept.is_dir() && from.join("README.md").is_file());
}

/// A copy is a folder of its own: a link with a copy's name, typed with a trailing slash so a rename would follow it,
/// and a plain file with a copy's name are refused, and neither the link, the file nor what a link points at goes.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn the_copy_verb_removes_no_link_and_no_file_that_carries_a_copy_name() {
    let dir = tempfile::tempdir().unwrap();
    let from = repo_in(dir.path());
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::write(elsewhere.path().join("kept"), b"mine\n").unwrap();
    let to_project = dir.path().join("work-link");
    std::os::unix::fs::symlink(&from, &to_project).unwrap();
    let to_outside = dir.path().join("work-out");
    std::os::unix::fs::symlink(elsewhere.path(), &to_outside).unwrap();
    let file = dir.path().join("work-file");
    std::fs::write(&file, b"notes\n").unwrap();
    let typed = [format!("{}/", to_project.display()), format!("{}//", to_outside.display()), file.display().to_string()];
    for to in &typed {
        let refused = copy_remove(&from, std::path::Path::new(to));
        assert_eq!(refused.status.code(), Some(1), "{to} was taken");
        assert_eq!(
            String::from_utf8_lossy(&refused.stderr).trim(),
            format!("{to} is not a folder of its own, so nothing was removed; a copy is a folder beside its project, never a link or a file, and --to names that folder")
        );
    }
    std::thread::sleep(Duration::from_millis(500));
    assert!(from.join("README.md").is_file(), "the project a link pointed at went");
    assert!(elsewhere.path().join("kept").is_file(), "the folder a link pointed at went");
    assert!(to_project.is_symlink() && to_outside.is_symlink() && file.is_file());
}
