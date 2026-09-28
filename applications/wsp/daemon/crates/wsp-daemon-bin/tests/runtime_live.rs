// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops against the kernel, through this binary as the helper and the init: root and cgroup v2, so
//! every case here is marked ignored and a box runs them with `--ignored`, and a run anywhere else reads them
//! ignored rather than ok. The root is one directory under /tmp per checkout; every workspace a case makes is
//! killed at its end, and its mount and its cgroup are checked gone. Nothing here touches a workspace it did not
//! make. The cases are the Docker backend's, the fake engine replaced by the kernel, then the network's: the box
//! reaches a workspace at a published port, a workspace reaches its box, a registry and nothing of its
//! neighbours; then this computer's own: a workspace made of the box's directories, the project it was given as
//! a copy, and the pause that stops it and the wake that boots it over what it wrote.
//!
//! What a case writes inside a workspace goes under one of the workspace's own overlays, `/var/tmp` by habit,
//! and never under `/root`: that home is the box's own, shared by every workspace on it, so a file written there
//! is a file the box carries after the run. What a case pulls onto the box's engine it removes at its end, and
//! what it leaves running there wears `LIVE_LABEL`, so a run that died can be swept by one filter. A box this
//! suite ran on reads as it did before, which is the one thing a computer somebody is using asks of it.
#![cfg(target_os = "linux")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wsp_frames::{numbers, probe_path, RequestId};
use wsp_runtime::net::{self, Network, Route};
use wsp_runtime::nft;
use wsp_runtime::ops::Ops;

const CGROUPS: &str = "/sys/fs/cgroup/wsp";

static ONE_AT_A_TIME: Mutex<()> = Mutex::const_new(());

/// A short word for this checkout, off the path of the crate: the root and the owner label carry it, so two
/// builders on one box never share a root or a label.
fn checkout_key() -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in env!("CARGO_MANIFEST_DIR").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")[..8].to_owned()
}

fn root() -> PathBuf {
    PathBuf::from(format!("/tmp/wsp-runtime-live-{}", checkout_key()))
}

fn live_owner() -> String {
    format!("live-665-{}", checkout_key())
}

/// The runtime crate's own `LIVE_REASON`, kept equal to it, since a test file cannot read that one: its doc
/// says why a case carries this sentence twice.
const LIVE_REASON: &str = "drives the kernel as root: run the live executable on a box with --ignored";

struct World {
    ops: Ops,
    made: Vec<String>,
    _turn: MutexGuard<'static, ()>,
}

/// The binary under test, or the one WSP_RUNTIME_BIN names, so the release build's numbers can be read here.
fn bin() -> PathBuf {
    std::env::var("WSP_RUNTIME_BIN").map_or_else(|_| PathBuf::from(env!("CARGO_BIN_EXE_wsp-daemon")), PathBuf::from)
}

/// The label every container this suite makes on the box's engine wears, whatever workspace made it: the fence
/// stamps its own workspace label on each, and this one is what a person sweeping the box after a run that died
/// looks for, since a compose stack's containers are named after a project and not after this suite.
const LIVE_LABEL: &str = "wsp.live";

/// Where a case lands the box's own compose plugin inside a workspace: one of the directories the docker command
/// line reads plugins from, under the overlay of the box's /usr, so it is the workspace's own upper and not a
/// write into the box's home. Under /root it would land in the home every workspace on the box shares, and the
/// box would carry it after the run.
const COMPOSE_PLUGIN_INSIDE: &str = "/usr/local/lib/docker/cli-plugins/docker-compose";

/// The address every case that wants a listener on every address the workspace has asks for, and the one a dev
/// server started with no address of its own binds: from the box the workspace's own address answers nothing at
/// that one, and its published port answers all the same, since the listener out here dials from inside the
/// workspace's own namespace.
const EVERY_ADDRESS: &str = "0.0.0.0";
const LOOPBACK_INSIDE: &str = "127.0.0.1";

/// What a workspace here runs to answer a line on a port, bound to the address given, written once because three
/// cases want it at two addresses and two ports.
fn answer_on(address: &str, port: u16) -> String {
    format!(
        "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"{address}\", LocalPort => {port}, Listen => 5, ReuseAddr => 1) or die $!; while ($c = $s->accept) {{ print $c \"hello from inside\\n\"; close $c }}' > /dev/null 2> /tmp/listen-{port}.err & sleep 0.5; cat /tmp/listen-{port}.err"
    )
}

impl World {
    /// Opens the ops on the fixed root and kills whatever an earlier case left under the live label, every one
    /// of them named after this checkout.
    async fn open() -> World {
        let turn = ONE_AT_A_TIME.lock().await;
        let ops = Ops::open(&root(), bin(), numbers::DEFAULT_PORT).unwrap();
        let world = World { ops, made: Vec::new(), _turn: turn };
        world.ops.restore().await.unwrap();
        let rows = world.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
        for row in rows["machines"].as_array().unwrap() {
            world.ask("machine.kill", json!({ "machineId": row["id"] })).await;
        }
        world
    }

    /// The same root opened again, as a daemon that restarted opens it: nothing killed, the forwards restored.
    async fn reopen(&mut self) {
        let fresh = Ops::open(&root(), bin(), numbers::DEFAULT_PORT).unwrap();
        drop(std::mem::replace(&mut self.ops, fresh));
        // The old listeners' tasks end at the next turn of this runtime; a daemon that died holds no port.
        tokio::task::yield_now().await;
        self.ops.restore().await.unwrap();
    }

    fn network(&self, id: &str) -> Network {
        serde_json::from_slice(&fs::read(root().join("run").join(id).join("net.json")).unwrap()).unwrap()
    }

    /// The port on the box's loopback that machine.previewUrl answers for the workspace's port.
    async fn publish(&self, id: &str, port: u16) -> u16 {
        let reply = self.ok("machine.previewUrl", json!({ "machineId": id, "port": port })).await;
        let url = reply["reach"]["url"].as_str().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        assert_eq!(reply["reach"]["token"], "");
        assert_eq!(reply["reach"]["expiresAt"], 9_007_199_254_740_991u64);
        url.rsplit(':').next().unwrap().parse().unwrap()
    }

    /// The workspace answers on 7070 from inside, checked from the box at its own address.
    async fn listen_inside(&self, id: &str) -> Ipv4Addr {
        let (code, _, err) = self.exec(id, &answer_on(EVERY_ADDRESS, 7070)).await;
        assert_eq!((code, err.as_str()), (0, ""));
        let address = self.network(id).address;
        assert_eq!(read_line(SocketAddrV4::new(address, 7070)).await.unwrap(), "hello from inside");
        address
    }

    async fn ask(&self, op: &str, fields: Value) -> Value {
        let mut frame = json!({ "id": 1, "op": op });
        for (k, v) in fields.as_object().unwrap() {
            frame[k] = v.clone();
        }
        serde_json::from_str(&self.ops.answer(Some(RequestId::from(1)), &frame).await).unwrap()
    }

    async fn ok(&self, op: &str, fields: Value) -> Value {
        let reply = self.ask(op, fields).await;
        assert_eq!(reply["ok"], true, "{op}: {reply}");
        reply
    }

    async fn create(&mut self, spec: Value) -> String {
        self.created(spec).await["id"].as_str().unwrap().to_owned()
    }

    /// The whole handle the create answered with, for the cases that read what it says beside the id.
    async fn created(&mut self, spec: Value) -> Value {
        let reply = self.ok("machine.create", json!({ "spec": spec })).await;
        let machine = reply["machine"].clone();
        self.made.push(machine["id"].as_str().unwrap().to_owned());
        machine
    }

    async fn exec(&self, id: &str, cmd: &str) -> (i64, String, String) {
        let reply = self.ok("machine.exec", json!({ "machineId": id, "cmd": cmd, "timeoutMs": 60_000 })).await;
        let r = &reply["result"];
        (r["exitCode"].as_i64().unwrap(), r["stdout"].as_str().unwrap().to_owned(), r["stderr"].as_str().unwrap().to_owned())
    }

    /// The quiet figure off the workspace's reading: how long this computer has seen it do nothing on its own.
    async fn quiet_ms(&self, id: &str) -> u64 {
        let reading = self.ok("machine.metrics", json!({ "machineId": id })).await["reading"].clone();
        reading["quietForMs"].as_u64().unwrap_or_else(|| panic!("no quiet figure in {reading}"))
    }

    async fn state(&self, id: &str) -> String {
        self.ok("machine.state", json!({ "machineId": id })).await["state"].as_str().unwrap().to_owned()
    }

    /// Kills what this case made and checks the box carries nothing of it.
    async fn close(mut self) {
        for id in std::mem::take(&mut self.made) {
            let reply = self.ask("machine.kill", json!({ "machineId": &id })).await;
            assert!(reply["ok"] == true || reply["kind"] == "missing", "kill {id}: {reply}");
            assert!(!Path::new(CGROUPS).join(&id).exists(), "cgroup of {id} stays");
            assert!(!root().join("run").join(&id).exists(), "run dir of {id} stays");
            let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
            assert!(!mounts.contains(&format!("/run/{id}/rootfs")), "the rootfs of {id} is still mounted");
        }
    }
}

/// A case that panics before its close still kills what it made, so a red run leaves no mount and no cgroup on the
/// box; the kills run on a thread of their own, since a runtime cannot be started inside the test's.
impl Drop for World {
    fn drop(&mut self) {
        let ids = std::mem::take(&mut self.made);
        if ids.is_empty() {
            return;
        }
        let ops = &self.ops;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                runtime.block_on(async {
                    for id in ids {
                        let _ = ops.answer(Some(RequestId::from(1)), &json!({ "id": 1, "op": "machine.kill", "machineId": id })).await;
                    }
                });
            });
        });
    }
}

/// The spec every case here creates from: no image name at all, since this computer keeps none and a workspace
/// is made of the computer's own directories.
fn spec(extra: Value) -> Value {
    let mut spec = json!({ "kind": "sandbox", "labels": { "wsp-owner": live_owner() } });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    spec
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn builds_the_container_from_the_spec_limits_labels_envs_and_the_boot_command() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let started = Instant::now();
    // Two cores of a box that keeps one, so this reads the box rather than a number: a runner with two cores gives
    // one and the assertions below follow it.
    let cores = w.ok("machine.capacity", json!({})).await["cores"].as_f64().unwrap();
    let given_cpu = 2.0f64.min((cores - 1.0).max(1.0));
    let id = w.create(spec(json!({ "cpu": 2, "memMb": 1024, "envs": { "WSP_TOKEN": "t" }, "idempotencyKey": format!("live-665-build-{}", checkout_key()) }))).await;
    let ready = started.elapsed();
    eprintln!("create to ready: {} ms", ready.as_millis());
    assert_eq!(id, format!("wsp-live-665-build-{}", checkout_key()));
    assert_eq!(w.state(&id).await, "running");
    let (code, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.swap.max; echo $WSP_TOKEN; hostname; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done").await;
    assert_eq!(code, 0);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "1073741824", "{out}");
    assert_eq!(lines[1], format!("{} 100000", (given_cpu * 100_000.0) as i64), "{out}");
    assert_eq!(lines[2], "0", "{out}");
    assert_eq!(lines[3], "t");
    assert_eq!(lines[4], format!("wsp-live-665-build-{}", checkout_key()));
    // One process under the init, and no shell between them: nothing inside a workspace here looks for a daemon
    // supervisor, since the daemon that serves it is this computer's own.
    assert!(out.contains("/sbin/wsp-init runtime init -- sleep infinity"), "the init runs the boot command: {out}");
    assert!(!out.contains("supervise.sh"), "something inside still looks for a daemon supervisor: {out}");
    // The same key again answers the workspace that exists, replayed.
    let again =
        w.ok("machine.create", json!({ "spec": spec(json!({ "idempotencyKey": format!("live-665-build-{}", checkout_key()) })) })).await;
    assert_eq!(again["machine"]["id"], id);
    assert_eq!(again["machine"]["replayed"], true);
    assert_eq!(
        again["machine"]["roads"],
        json!({ "previewUrl": true, "daemonAnswers": true, "putBytes": true, "describe": true, "facts": false, "metrics": true })
    );
    let got = w.ok("machine.get", json!({ "machineId": id })).await;
    assert_eq!(got["machine"]["labels"], json!({ "wsp": "1", "wsp-owner": live_owner() }));
    assert_eq!(got["machine"]["seen"]["state"], "running");
    // No supervisor: nothing keeps a daemon up inside a workspace here and no deploy puts one there.
    assert!(got["machine"].get("daemonSupervisor").is_none(), "{got}");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn holds_a_machines_size_to_what_the_box_has() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let capacity = w.ok("machine.capacity", json!({})).await;
    let cores = capacity["cores"].as_f64().unwrap();
    let made = w.created(spec(json!({ "cpu": 512, "memMb": 9_000_000 }))).await;
    let id = made["id"].as_str().unwrap().to_owned();
    // The box keeps a core and a gigabyte of its own, and the answer says what it gave instead.
    let shape = w.ok("machine.describe", json!({ "machineId": id })).await["shape"].clone();
    assert_eq!(shape["cpu"].as_f64(), Some((cores - 1.0).max(1.0)));
    assert_eq!(shape["memMb"], capacity["machineMemMb"]);
    let notice = made["notice"].as_str().unwrap_or_default().to_owned();
    assert!(notice.contains("cpu clamped to") && notice.contains("memory clamped to"), "{notice}");
    let (_, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max").await;
    assert_eq!(out.trim(), (capacity["machineMemMb"].as_u64().unwrap() * 1024 * 1024).to_string());
    // The room the doctor reads counts this fork at the size the box gave it, beside whatever else is here.
    let after = w.ok("machine.capacity", json!({})).await;
    let taken_cpu = after["cpuTaken"].as_f64().unwrap() - capacity["cpuTaken"].as_f64().unwrap();
    let taken_mem = after["memTakenMb"].as_u64().unwrap() - capacity["memTakenMb"].as_u64().unwrap();
    assert_eq!(taken_cpu, (cores - 1.0).max(1.0));
    assert_eq!(taken_mem, capacity["machineMemMb"].as_u64().unwrap());
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn answers_exec_with_stdout_stderr_and_the_exit_code() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, out, err) = w.exec(&id, "echo out; echo err >&2; echo $HOME $USER; exit 7").await;
    assert_eq!((code, out.as_str(), err.as_str()), (7, "out\n/root root\n", "err\n"));
    let started = Instant::now();
    let rounds = 20;
    for _ in 0..rounds {
        w.exec(&id, "true").await;
    }
    eprintln!("exec round trip: {} ms", started.elapsed().as_millis() / rounds);
    let (code, _, _) = w.exec(&id, "sleep 5").await;
    assert_eq!(code, 0);
    let cut = w.ok("machine.exec", json!({ "machineId": id, "cmd": "sleep 30; echo late", "timeoutMs": 300 })).await;
    assert_eq!(cut["result"]["exitCode"], 124);
    assert_eq!(cut["result"]["stdout"], "");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn an_exec_runs_behind_the_workspaces_seccomp_filter_with_the_inits_capabilities() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    const FENCE_LINES: &str = "grep -E '^(Seccomp|Seccomp_filters|CapBnd|CapEff|CapPrm|CapInh|CapAmb):'";
    let (code, out, err) = w.exec(&id, &format!("{FENCE_LINES} /proc/1/status; echo --; {FENCE_LINES} /proc/$$/status")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    let (init, shell) = out.split_once("--\n").unwrap();
    eprintln!("the init's status:\n{init}the exec'd shell's status:\n{shell}");
    assert!(shell.contains("Seccomp:\t2\n"), "the exec'd shell runs unfenced: {shell}");
    assert!(shell.contains("Seccomp_filters:\t1\n"), "{shell}");
    assert!(!shell.contains("CapEff:\t000001ffffffffff\n"), "the exec'd shell kept the box's capabilities: {shell}");
    assert_eq!(shell, init, "an exec'd process runs as the init does");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn an_exec_against_a_filter_with_a_notify_action_is_refused_and_the_workspace_still_answers() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The bundle's config.json is what every exec reads its filter from; a rule with the notify action is added to
    // it while the workspace runs, and the original is put back before the next exec.
    let config = root().join("run").join(&id).join("config.json");
    let kept = fs::read_to_string(&config).unwrap();
    let mut bundle: Value = serde_json::from_str(&kept).unwrap();
    bundle["linux"]["seccomp"]["syscalls"].as_array_mut().unwrap().push(json!({ "names": ["getcwd"], "action": "SCMP_ACT_NOTIFY" }));
    fs::write(&config, bundle.to_string()).unwrap();
    let refused = w.ask("machine.exec", json!({ "machineId": id, "cmd": "echo unfenced", "timeoutMs": 10_000 })).await;
    fs::write(&config, &kept).unwrap();
    assert_eq!(
        refused,
        json!({ "id": 1, "ok": false, "error": "runtime exec: the workspace's seccomp filter has a rule whose action is notify, and an exec serves no listener for it, so the command did not run" })
    );
    let (code, out, _) = w.exec(&id, "echo fenced; grep Seccomp: /proc/$$/status").await;
    assert_eq!((code, out.as_str()), (0, "fenced\nSeccomp:\t2\n"));
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_pause_asks_the_processes_to_end_before_it_kills_them() {
    assert!(root_here(), "{LIVE_REASON}");
    let patience = wsp_runtime::runtime::STOP_PATIENCE;
    // What a stop that asked and was answered costs: the processes end themselves and the wait ends with them,
    // so the figure is the workspace's own shutdown and not the deadline. Read against a fifth of the patience,
    // since a stop that runs anywhere near the deadline is the fault this bounds, whatever ran inside.
    let prompt = patience / 5;
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "memMb": 1024 }))).await;

    // What the create answered ready with, read before anything else runs: the workspace's first process and the
    // one child it started. The create waits for that child, so a pause asked in the same breath as the create,
    // which is what the next line does, meets a cgroup the stop can act on. On a box the child appeared about a
    // sixth of a second after the first process, and a create that answered inside that window handed back a
    // workspace whose every pause ran the whole patience.
    let cgroup = Path::new(CGROUPS).join(&id);
    let pids = wsp_runtime::freeze::pids_under(&cgroup).unwrap();
    let init = init_pid(&id);
    assert!(pids.contains(&init), "the workspace's own first process is not in its cgroup: {pids:?}");
    assert!(
        wsp_runtime::runtime::boot_child(&pids, init).is_some(),
        "the create answered before the first process had started the boot command: {pids:?}"
    );

    // First with nothing inside but the boot, and with no pause between the create and this: the shape a
    // workspace nobody has run anything in has, and the one the box measured at the whole patience twice, once
    // because the boot command could not take a signal and once because the create answered before it existed.
    let started = Instant::now();
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let bare = started.elapsed();
    eprintln!("stop with nothing inside but the boot: {} ms, patience {} s", bare.as_millis(), patience.as_secs());
    assert_eq!(w.state(&id).await, "paused");
    assert!(bare < prompt, "the boot command did not take the signal: {} ms of a {} s patience", bare.as_millis(), patience.as_secs());
    w.ok("machine.resume", json!({ "machineId": id })).await;

    // A process that traps the signal and writes what it holds where the saved layer keeps it: /var is one of the
    // workspace's own overlays, and the box's /root, which every workspace on it shares, is not.
    //
    // What it writes is the state of the workspace's own first process, read at the moment its trap runs, so the
    // line says the order and not only that a line was written: a trap running after the init had gone could not
    // have run at all, since the kernel kills every process in a pid namespace whose first process is gone.
    let trapping = "nohup sh -c 'trap \"grep -m1 ^State /proc/1/status > /var/tmp/stopped 2>/dev/null || echo the-init-was-gone > /var/tmp/stopped; exit 0\" TERM; while :; do sleep 1; done' > /dev/null 2>&1 & sleep 0.5; echo started";
    let (code, out, err) = w.exec(&id, trapping).await;
    assert_eq!((code, out.as_str(), err.as_str()), (0, "started\n", ""));
    let saved = root().join("run").join(&id).join("upper/var/tmp/stopped");
    assert!(!saved.exists(), "the trap wrote before the stop");

    let started = Instant::now();
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let took = started.elapsed();
    eprintln!("stop with a process that traps SIGTERM: {} ms, patience {} s", took.as_millis(), patience.as_secs());
    assert_eq!(w.state(&id).await, "paused");
    // Under a fifth of it, not merely under it: the trap's own loop sleeps a second at a time, and everything
    // else here is the kernel's.
    assert!(took < prompt, "the stop took {} ms of a {} s patience", took.as_millis(), patience.as_secs());
    // The line is in the saved layer, so the process was asked to end and had the time to write: an init
    // signalled first, or a boot command whose end takes the init with it, would have had the kernel kill this
    // process before its trap could run.
    let said = fs::read_to_string(&saved).unwrap();
    let state = said.split_whitespace().nth(1).unwrap_or_default().to_owned();
    assert!(matches!(state.as_str(), "S" | "R"), "the workspace's first process was {state} when the trap ran: {said}");
    assert!(!Path::new(CGROUPS).join(&id).exists(), "the cgroup of a stopped workspace stays");
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")), "the rootfs stays mounted");

    // And a stop always stops: a process that ignores the signal holds its cgroup for the patience and the kill
    // road takes it from there.
    w.ok("machine.resume", json!({ "machineId": id })).await;
    let deaf = "nohup sh -c 'trap \"\" TERM; while :; do sleep 1; done' > /dev/null 2>&1 & sleep 0.5; echo started";
    let (code, _, _) = w.exec(&id, deaf).await;
    assert_eq!(code, 0);
    let started = Instant::now();
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let deaf_took = started.elapsed();
    eprintln!("stop with a process that ignores SIGTERM: {} ms", deaf_took.as_millis());
    assert_eq!(w.state(&id).await, "paused");
    // The whole patience, and only here: what ended this one is the kill road, which is the difference between a
    // workspace that answered the signal and one that would not.
    assert!(deaf_took >= patience, "the kill road was not what ended it: {} ms", deaf_took.as_millis());
    assert!(!Path::new(CGROUPS).join(&id).exists(), "a workspace that ignored the signal kept its cgroup");
    // Nothing here is ever frozen: a pause on a stopped workspace is what a second pause meets.
    let twice = w.ask("machine.pause", json!({ "machineId": id })).await;
    assert!(twice["error"].as_str().unwrap().contains("is already paused"), "{twice}");
    w.close().await;
}

/// A login this computer shares into a workspace is bound at the agent's own path inside, and under the box's own
/// /root that path is the box's: the empty file the bind lands on is made on the box's home, where a tool run on
/// the box itself reads it as its login. So the boot records what it made, the stop takes it off, the wake makes
/// it again, and the workspace takes it with it when it goes.
///
/// The one case here whose point is a file on the box's own home, which is what the rule is about: it asks for a
/// path of this checkout's own under that home and never an agent's real login, and takes the folder it made off
/// the box at its end.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_mount_point_a_shared_login_needs_leaves_nothing_on_the_boxs_own_home() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    // The login as this daemon shares them out: a file under its own logins directory and nowhere else.
    let logins = root().join("logins/live-share");
    fs::create_dir_all(&logins).unwrap();
    let source = logins.join("auth.json");
    fs::write(&source, b"{\"live\":\"a login\"}\n").unwrap();
    // A path of this case's own under the box's home, so the mount point is never a real agent's login on the box.
    let point = PathBuf::from(format!("/root/.wsp-live-share-{}/auth.json", checkout_key()));
    let _ = fs::remove_file(&point);
    let id = w
        .create(spec(json!({
            "shares": [{ "source": source.display().to_string(), "target": point.display().to_string() }],
            "idempotencyKey": format!("live-share-{}", checkout_key()),
        })))
        .await;
    // The login reads inside at the path its tool looks at, and what the box holds at that path is the empty file
    // the bind landed on, which is the thing this rule is about.
    let said = "{\"live\":\"a login\"}\n";
    let (code, out, _) = w.exec(&id, &format!("cat {}", point.display())).await;
    assert_eq!((code, out.as_str()), (0, said));
    assert_eq!(fs::metadata(&point).unwrap().len(), 0, "the box's own file under the mount is not an empty point");

    // Asleep: nothing holds the login open, so the empty file is off the box's home. The wake makes it again and
    // the login reads inside as before.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    assert!(!point.exists(), "a napping workspace left its mount point on the box's own home");
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    assert_eq!(fs::metadata(&point).unwrap().len(), 0);
    let (code, out, _) = w.exec(&id, &format!("cat {}", point.display())).await;
    assert_eq!((code, out.as_str()), (0, said));

    // And gone with the workspace: the file the boot made is off the box, and the folder under the home stays,
    // as the leave leaves the agents' own folders.
    w.ok("machine.kill", json!({ "machineId": &id })).await;
    assert!(!point.exists(), "the workspace went and the mount point it made stayed on the box's home");
    assert!(point.parent().unwrap().is_dir());
    let _ = fs::remove_dir(point.parent().unwrap());
    let _ = fs::remove_dir_all(&logins);
    w.close().await;
}

/// What this computer can see of a workspace working, which is the figure the host's idle firing reads before it
/// stops one: a byte through a published port and a command run in it start it over, and nothing else does.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_quiet_figure_is_what_this_computer_can_see_of_a_workspace_working() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let port = w.publish(&id, 7070).await;
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    let before = w.quiet_ms(&id).await;
    assert!(before > 2_000, "the figure did not grow while nothing happened: {before} ms");

    // Somebody asking the workspace for something, through the port the box published for it.
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    let after_get = w.quiet_ms(&id).await;
    assert!(after_get < 1_000, "a GET through the published port left the figure at {after_get} ms");

    // The host's own probe of the daemon inside is not the workspace working: it is asked of every running
    // workspace every few seconds for as long as the host is up, and a figure it started over would never reach
    // the end of a window.
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    w.ok("machine.daemonAnswers", json!({ "machineId": id, "timeoutMs": 20_000 })).await;
    let after_probe = w.quiet_ms(&id).await;
    assert!(after_probe > 2_000, "the daemon probe started the figure over: {after_probe} ms");

    // A command run in it is.
    w.exec(&id, "echo working").await;
    let after_exec = w.quiet_ms(&id).await;
    assert!(after_exec < 1_000, "a command left the figure at {after_exec} ms");
    eprintln!("quiet_for_ms: {before} quiet, {after_get} after a GET, {after_probe} after the daemon probe, {after_exec} after a command");

    // A stopped workspace has no figure at all, and the wake starts one over: a workspace idle across a stop
    // lives one more window.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let napping = w.ok("machine.metrics", json!({ "machineId": id })).await["reading"].clone();
    assert!(napping.get("quietForMs").is_none(), "{napping}");
    w.ok("machine.resume", json!({ "machineId": id })).await;
    let woken = w.quiet_ms(&id).await;
    assert!(woken < 1_000, "the wake left the figure at {woken} ms");
    w.close().await;
}

/// A service bound to the loopback inside and nowhere else, which is what a dev server started with no address
/// binds, answers at the box's published port: the listener out here dials from inside the workspace's own
/// network namespace, where that loopback is the workspace's.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_service_bound_to_the_loopback_inside_answers_at_the_published_port() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, err) = w.exec(&id, &answer_on(LOOPBACK_INSIDE, 7070)).await;
    assert_eq!((code, err.as_str()), (0, ""));
    // Not at the workspace's own address: nothing is listening there, which is the whole difference.
    let address = w.network(&id).address;
    let refused = read_line(SocketAddrV4::new(address, 7070)).await;
    assert!(refused.is_err(), "the loopback bind answered at the workspace's own address: {refused:?}");
    let port = w.publish(&id, 7070).await;
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    // And the same port after a stop and a wake, where the listener is bound again on the new namespace.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    // A port published while it is stopped, which is a road the reach op leaves open: the box port is held and
    // answers nothing, and the wake is what gives it the namespace to dial. Two ports now, so the wake has one
    // held from before it and one published under it.
    let while_stopped = w.publish(&id, 7071).await;
    assert_ne!(while_stopped, port);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, while_stopped)).await.unwrap(), "", "a stopped workspace answered");
    assert_eq!(w.network(&id).forwards, [(7070, port), (7071, while_stopped)].into());

    w.ok("machine.resume", json!({ "machineId": id })).await;
    for port_inside in [7070, 7071] {
        let (code, _, err) = w.exec(&id, &answer_on(LOOPBACK_INSIDE, port_inside)).await;
        assert_eq!((code, err.as_str()), (0, ""), "{port_inside}");
    }
    // Both box ports are the ones the record already carried, and both reach the service inside now: the one
    // held across the stop and the one published while there was nothing to dial.
    assert_eq!(w.publish(&id, 7070).await, port);
    assert_eq!(w.publish(&id, 7071).await, while_stopped);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    assert_eq!(
        read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, while_stopped)).await.unwrap(),
        "hello from inside",
        "the port published while it was stopped dials nothing after the wake"
    );
    w.close().await;
}

/// What the box keeps of its own that a turn inside a workspace may not read: the password hashes, the keys it
/// answers ssh on and the keys that open other computers. Each of them is the workspace's own empty file or
/// directory, and what the box holds is untouched.
///
/// /home reads empty here for a second reason as well as the cover: today's rootfs overlays /usr, /etc, /opt,
/// /var and /srv, so the box's own /home is not inside one at all. The case reads it all the same, since what
/// it asks is that no other person's home on the box shows through, however the rootfs comes to be made. The
/// password files are read for their presence rather than their size: the /etc a workspace holds is built from
/// the names the allowlist carries, which does not name them, so they are not in it at all.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_boxs_own_logins_keys_and_other_homes_show_nothing_inside() {
    assert!(root_here(), "{LIVE_REASON}");
    // What the box holds, read before any workspace is made: the length of one file and the count of one
    // directory, neither of which is a thing this reads the content of.
    let box_shadow = fs::metadata("/etc/shadow").map(|m| m.len()).unwrap_or(0);
    let box_keys = fs::read_dir("/root/.ssh").map(|d| d.count()).unwrap_or(0);
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, out, err) = w
        .exec(
            &id,
            "test -e /etc/shadow && echo present || echo absent; test -e /etc/gshadow && echo present || echo absent; ls -A /home | wc -l; ls -A /root/.ssh | wc -l; cat /etc/ssh/ssh_host_* 2>/dev/null | wc -c",
        )
        .await;
    show("what the box keeps of its own, from inside a workspace", code, &out, &err);
    assert_eq!(code, 0);
    // /home holds the install roots this box has of the ones outside the overlaid trees and nothing else: the
    // Homebrew prefix on a box the recipe's formula rows ran on, nothing on a box with none, and no other home
    // on the box either way.
    let roots = wsp_runtime::bundle::tool_roots_present(&wsp_frames::numbers::SHARED_TOOL_ROOTS).len().to_string();
    assert_eq!(out.split_whitespace().collect::<Vec<_>>(), ["absent", "absent", roots.as_str(), "0", "0"], "{out}");
    // And what is not covered: the box's sudo rules are read as they are, so a script inside that types sudo
    // gets what root gets rather than a refusal from a file granting nobody anything.
    let (code, sudo, err) = w.exec(&id, "sudo -n true && echo sudo works").await;
    show("sudo inside the workspace", code, &sudo, &err);
    if code == 0 {
        assert_eq!(sudo.trim(), "sudo works");
    } else {
        eprintln!("this image carries no sudo; the rules case is the read below");
        assert!(w.exec(&id, "grep -c ALL /etc/sudoers").await.1.trim() != "0", "the box's sudo rules were covered");
    }
    // A write where the box's own keys live is the workspace's own and reaches nothing of the box's: a workspace
    // that could write here would let itself back into the box as root.
    let (code, _, err) = w.exec(&id, "echo 'a key of this workspace alone' > /root/.ssh/authorized_keys").await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(fs::metadata("/etc/shadow").map(|m| m.len()).unwrap_or(0), box_shadow, "the box's own logins changed");
    assert_eq!(fs::read_dir("/root/.ssh").map(|d| d.count()).unwrap_or(0), box_keys, "the box's own keys changed");
    // And the capabilities no workspace holds are in no set a turn inside carries.
    let (code, caps, err) = w.exec(&id, "grep -E 'CapBnd|CapEff|CapPrm' /proc/self/status").await;
    show("the capabilities of a turn inside", code, &caps, &err);
    assert_eq!(code, 0);
    let bits = [("CAP_SYS_ADMIN", 21u32), ("CAP_SYS_MODULE", 16), ("CAP_SYS_BOOT", 22), ("CAP_MKNOD", 27)];
    for line in caps.lines() {
        let Some((set, mask)) = line.split_once(':') else { continue };
        let mask = u64::from_str_radix(mask.trim(), 16).unwrap_or_else(|e| panic!("{line}: {e}"));
        for dropped in wsp_runtime::hardening::DROPPED_CAPS {
            let (_, bit) = bits.iter().find(|(name, _)| *name == dropped).unwrap_or_else(|| panic!("{dropped} has no bit here"));
            assert_eq!(mask & (1 << bit), 0, "{set} carries {dropped}");
        }
    }
    w.close().await;
}

/// The tools a road installed outside the trees a workspace overlays answer inside it: the box's install roots are
/// bound in read-only at their own paths, the PATH every process inside starts with names their bin directories,
/// and nothing inside can write the prefix. A box with no such root reads the PATH and no mount, which is the
/// other half of the case.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_recipes_tools_outside_the_overlaid_trees_answer_inside_and_cannot_be_written() {
    assert!(root_here(), "{LIVE_REASON}");
    let roots = wsp_runtime::bundle::tool_roots_present(&wsp_frames::numbers::SHARED_TOOL_ROOTS);
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The PATH the boot hands its first process, read off that process's own environment rather than off a shell
    // this case started: it is the one every process in the workspace inherits, and the one order of directories
    // a person's thread on this workspace carries too. This spec carries no PATH of its own, so what stands here
    // is the daemon's own line; a create that carries one is the host's word and is read in the case below.
    let (code, path, err) = w.exec(&id, "tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^PATH=//p'").await;
    show("the PATH the workspace booted with", code, &path, &err);
    assert_eq!((code, path.trim()), (0, wsp_frames::numbers::PLACE_WORKSPACE_PATH));
    for root in &roots {
        // What the box keeps under the root, read from the box before the workspace is asked: the case says
        // afterwards that nothing inside changed it.
        let own: u64 = fs::read_dir(root).map(|d| d.count() as u64).unwrap_or(0);
        let (code, held, err) = w.exec(&id, &format!("ls -A {root} | wc -l; findmnt -no OPTIONS {root}")).await;
        show(&format!("{root} inside a workspace"), code, &held, &err);
        assert_eq!(code, 0);
        let lines: Vec<&str> = held.lines().collect();
        assert_eq!(lines.first().map(|n| n.trim()), Some(own.to_string().as_str()), "{root} reads differently inside: {held}");
        // Two mounts stack at the root inside: the boot's own bind, and the read-only one the container runtime
        // makes over it off the config. findmnt prints them oldest first, and the one a process inside reads is
        // the last, so the read-only word is read there and not on the bind under it.
        assert!(lines.last().is_some_and(|options| options.contains("ro")), "{root} is not read-only inside: {held}");
        // A write into the prefix is refused: an install happens on the computer, through the recipe, and what a
        // tool writes while it runs goes under /root, which is the computer's own and read-write.
        let (code, _, refused) = w.exec(&id, &format!("touch {root}/wsp-probe")).await;
        assert_ne!(code, 0, "a write into {root} was taken inside");
        assert!(refused.to_ascii_lowercase().contains("read-only"), "{root}: {refused}");
        assert!(!Path::new(root).join("wsp-probe").exists(), "a write inside reached {root} on the box");
        assert_eq!(fs::read_dir(root).map(|d| d.count() as u64).unwrap_or(0), own, "{root} on the box changed");
    }
    // And the command the bring back's pull request half needs, where this box has it: gh answers on the PATH the
    // workspace booted with, at the path the box has it. Asked for as the boot set it, since a shell this case
    // starts may be handed another.
    let (code, found, err) = w.exec(&id, &format!("PATH={} command -v gh || true", wsp_frames::numbers::TOOLS_PATH)).await;
    show("gh inside a workspace, on the PATH the boot set", code, &found, &err);
    assert_eq!(code, 0);
    let on_the_box = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("PATH={} command -v gh || true", wsp_frames::numbers::TOOLS_PATH))
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default();
    assert_eq!(found.trim(), on_the_box, "gh answers differently inside a workspace than on the box");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn kills_by_the_id_it_was_given_and_maps_every_state() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    assert_eq!(w.state(&id).await, "running");
    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "paused");
    w.ok("machine.resume", json!({ "machineId": id })).await;
    // A workspace that was stopped and booted again runs its init as before; one that is killed is missing.
    let (_, out, _) = w.exec(&id, "cat /proc/1/cmdline | tr '\\0' ' '").await;
    assert!(out.contains("wsp-init"), "{out}");
    w.ok("machine.kill", json!({ "machineId": id })).await;
    let gone = w.ask("machine.state", json!({ "machineId": id })).await;
    assert_eq!((gone["ok"].as_bool(), gone["kind"].as_str(), gone["status"].as_u64()), (Some(false), Some("missing"), Some(404)));
    assert!(!Path::new(CGROUPS).join(&id).exists());
    assert!(!root().join("run").join(&id).exists());
    assert!(!root().join("state").join(&id).exists());
    w.made.clear();
    let lost = w.ask("machine.get", json!({ "machineId": "wsp-nobody" })).await;
    assert_eq!(lost, json!({ "id": 1, "ok": false, "error": "no such workspace: wsp-nobody", "kind": "missing", "status": 404 }));
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn lists_by_our_labels_and_answers_the_size_the_listing_carries() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    // The size this box gives, read off the box rather than written down: it keeps a core and two thirds of its
    // memory for itself, so a workspace asking for two cores on a two core box is listed at one, and one asking
    // for nothing is listed at the box's own ceiling.
    let capacity = w.ok("machine.capacity", json!({})).await;
    let cores = capacity["cores"].as_f64().unwrap();
    let ceiling_cpu = (cores - 1.0).max(1.0);
    let ceiling_mb = capacity["machineMemMb"].as_u64().unwrap();
    let asked_mb = ceiling_mb.min(1024);
    let id = w.create(spec(json!({ "cpu": 2, "memMb": asked_mb, "labels": { "wsp-owner": live_owner(), "row": "yes" } }))).await;
    let other = w.create(spec(json!({ "labels": { "wsp-owner": live_owner(), "row": "no" } }))).await;
    let rows = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner(), "row": "yes" } })).await;
    assert_eq!(
        rows["machines"],
        json!([{
            "id": id,
            "state": "running",
            "labels": { "wsp": "1", "wsp-owner": live_owner(), "row": "yes" },
            "size": { "cpu": ceiling_cpu.min(2.0), "memMb": asked_mb },
        }])
    );
    let all = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    assert_eq!(all["machines"].as_array().unwrap().len(), 2);
    let listed = all["machines"].as_array().unwrap().iter().find(|m| m["id"] == other).unwrap();
    // Never absent: a workspace with no cap of its own could hold the box, so the create writes the ceiling into
    // the record and every later reader sees the size the box gave.
    assert_eq!(listed["size"], json!({ "cpu": ceiling_cpu, "memMb": ceiling_mb }), "{listed}");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_reading_of_a_workspace_is_what_its_cgroup_its_record_and_its_network_say() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let capacity = w.ok("machine.capacity", json!({})).await;
    let id = w.create(spec(json!({ "cpu": 1, "memMb": 1024 }))).await;
    // Something for the cgroup to have counted: a second of a core, and a process that stays.
    w.exec(&id, "nohup sleep 300 > /dev/null 2>&1 & timeout 1 sh -c 'while :; do :; done'; true").await;
    let reading = w.ok("machine.metrics", json!({ "machineId": id })).await["reading"].clone();
    assert_eq!(reading["state"], "running");
    // One core is under the clamp on any box that runs workspaces at all, which keeps one for itself.
    assert_eq!(reading["cpu"].as_f64(), Some(1.0));
    assert_eq!(reading["memMb"], 1024.min(capacity["machineMemMb"].as_u64().unwrap()));
    let mem = reading["memBytes"].as_u64().unwrap();
    assert!(mem > 0 && mem <= reading["memMb"].as_u64().unwrap() * 1024 * 1024, "{reading}");
    // The busy second is a second of processor time, give or take the scheduler.
    assert!(reading["cpuUsageUsec"].as_u64().unwrap() > 500_000, "{reading}");
    assert!(reading["uptimeMs"].as_u64().unwrap() > 0, "{reading}");
    // The init, the sleep, and whatever the shell left behind it.
    assert!(reading["procs"].as_u64().unwrap() >= 2, "{reading}");
    assert_eq!(reading["address"], w.network(&id).address.to_string());
    assert_eq!(reading["cgroup"], format!("{CGROUPS}/{id}"));
    assert_eq!(reading["upper"], root().join("run").join(&id).join("upper").to_string_lossy().as_ref());
    // A workspace that is stopped keeps its sizes and its paths and has no live figures to give.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let napping = w.ok("machine.metrics", json!({ "machineId": id })).await["reading"].clone();
    assert_eq!(napping["state"], "paused");
    assert_eq!(napping["memMb"], reading["memMb"]);
    assert_eq!(napping["cgroup"], reading["cgroup"]);
    for figure in ["memBytes", "cpuUsageUsec", "uptimeMs", "procs"] {
        assert!(napping.get(figure).is_none(), "{figure} in {napping}");
    }
    w.ok("machine.resume", json!({ "machineId": id })).await;
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn puts_bytes_where_they_belong_and_serves_no_signed_url() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let half = bytes.len() / 2;
    let b64 = |part: &[u8]| base64_of(part);
    w.ok("machine.putBytes", json!({ "machineId": id, "path": "/var/tmp/wsp daemon/bundle.tgz", "uploadId": "u665", "seq": 0, "last": false, "data": b64(&bytes[..half]) })).await;
    w.ok("machine.putBytes", json!({ "machineId": id, "path": "/var/tmp/wsp daemon/bundle.tgz", "uploadId": "u665", "seq": 1, "last": true, "data": b64(&bytes[half..]) })).await;
    let (code, out, _) = w.exec(&id, "sha256sum '/var/tmp/wsp daemon/bundle.tgz'; stat -c %s '/var/tmp/wsp daemon/bundle.tgz'").await;
    assert_eq!(code, 0);
    assert!(out.starts_with(&sha256_hex(&bytes)), "{out}");
    assert!(out.trim().ends_with("300000"));
    assert!(!root().join("put").join("u665").exists());
    let wrong = w
        .ask("machine.putBytes", json!({ "machineId": id, "path": "/root/x", "uploadId": "u666", "seq": 3, "last": true, "data": "AAAA" }))
        .await;
    assert!(wrong["error"].as_str().unwrap().contains("out of order"));
    let down = w.ask("machine.downloadUrl", json!({ "machineId": id, "path": "/root/x" })).await;
    assert!(down["error"].as_str().unwrap().contains("no signed download URL"), "{down}");
    let up = w.ask("machine.uploadUrl", json!({ "machineId": id, "path": "/root/x" })).await;
    assert!(up["error"].as_str().unwrap().contains("no signed upload URL"), "{up}");
    w.close().await;
}

/// What this computer's daemon answers about one workspace of its own: whether that workspace runs.
async fn daemon_answers(w: &World, id: &str) -> bool {
    w.ok("machine.daemonAnswers", json!({ "machineId": id, "timeoutMs": 5000 })).await["answers"].as_bool().unwrap()
}

/// The daemon that serves a workspace here is this one, so what it answers about that workspace is whether it
/// runs: nothing listens inside, nothing is asked inside, and a stopped workspace answers no.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn answers_for_a_workspace_itself_rather_than_asking_a_port_inside_it() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;

    // Nothing listens on 7070 inside and the answer is still yes: the workspace runs, and this daemon is the one
    // that serves its files and its git.
    let (code, listening, err) = w.exec(&id, "(exec 3<>/dev/tcp/127.0.0.1/7070) 2>/dev/null; echo inside $?").await;
    show("what listens on the daemon port inside a workspace", code, &listening, &err);
    assert_eq!(listening.trim(), "inside 1", "something listens on 7070 inside: {listening}");
    assert!(daemon_answers(&w, &id).await, "the workspace runs and its daemon answered no");
    // And a stopped workspace answers no, which is what the row reads as napping.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert!(!daemon_answers(&w, &id).await);
    w.ok("machine.resume", json!({ "machineId": id })).await;
    assert!(daemon_answers(&w, &id).await);
    let got = w.ok("machine.get", json!({ "machineId": id })).await;
    assert!(got["machine"].get("daemonSupervisor").is_none(), "{got}");
    let facts = w.ask("machine.facts", json!({ "machineId": id })).await;
    assert_eq!(facts["error"], "this computer's backend has no facts");
    w.ok("machine.metrics", json!({ "machineId": id })).await;
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn describes_the_workspace_from_its_record() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "cpu": 1, "memMb": 768 }))).await;
    let shape = w.ok("machine.describe", json!({ "machineId": id })).await["shape"].clone();
    assert_eq!((shape["cpu"].as_f64(), shape["memMb"].as_u64()), (Some(1.0), Some(768)));
    let created = shape["createdAt"].as_str().unwrap();
    assert!(created.ends_with('Z') && created.contains('T'), "{created}");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_memory_cap_holds_seven_hundred_megabytes_touched_under_five_hundred_twelve_exit_137() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "memMb": 512 }))).await;
    let (code, _, _) = w.exec(&id, "perl -e '$x = \"x\" x (700 * 1024 * 1024); print length($x)'").await;
    assert_eq!(code, 137);
    assert_eq!(w.state(&id).await, "running", "the hog is the kill, never the workspace's init");
    let (_, peak, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events").await;
    eprintln!("after the cap: {peak}");
    assert!(peak.contains("oom_kill 1"), "{peak}");
    let (code, out, _) = w.exec(&id, "echo alive").await;
    assert_eq!((code, out.as_str()), (0, "alive\n"));
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_world_dropped_without_its_close_leaves_nothing_on_the_box() {
    assert!(root_here(), "{LIVE_REASON}");
    let id = {
        let mut w = World::open().await;
        let id = w.create(spec(json!({}))).await;
        assert!(Path::new(CGROUPS).join(&id).exists());
        id
    };
    assert!(!Path::new(CGROUPS).join(&id).exists(), "cgroup of {id} stays after the drop");
    assert!(!root().join("run").join(&id).exists());
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")));
}

/// The init's pid is only the init while the process behind it is the one the record named: after the init died
/// with no daemon there to delete it, the kernel hands that pid to whatever comes next.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_pid_the_kernel_reused_after_the_init_died_is_not_the_workspace() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let record: Value = serde_json::from_str(&fs::read_to_string(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let pid = record["init"]["pid"].as_i64().unwrap();
    assert!(std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap().success());
    let gone_by = Instant::now() + std::time::Duration::from_secs(10);
    while Path::new(&format!("/proc/{pid}")).exists() {
        assert!(Instant::now() < gone_by, "init {pid} still there");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(w.state(&id).await, "paused", "a dead init is a stopped workspace, and stopped reads paused");
    // Now a process of this test's own lands on the dead init's pid, through the kernel's next-pid knob.
    let mut landed = None;
    for _ in 0..300 {
        fs::write("/proc/sys/kernel/ns_last_pid", (pid - 1).to_string()).unwrap();
        let child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        if i64::from(child.id()) == pid {
            landed = Some(child);
            break;
        }
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut squatter = landed.expect("a process of ours on the old pid");
    let own_cgroup = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    // The daemon that never restarted reads the record's init, not whatever the pid names now.
    assert_eq!(w.state(&id).await, "paused", "a live process on the old pid is not the workspace");
    let paused = w.ask("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(paused["ok"], false, "{paused}");
    assert!(paused["error"].as_str().unwrap().contains("is already paused"), "{paused}");
    // A reading of a workspace whose init is gone is its record's own: the state it reads as, the sizes its
    // cgroup was written with and its paths, and none of the live figures, the quiet clock included. The op takes
    // the record rather than a running workspace, which is what lets a row be drawn for a stopped one at all.
    let metrics = w.ask("machine.metrics", json!({ "machineId": id })).await;
    assert_eq!(metrics["ok"], true, "{metrics}");
    assert_eq!(metrics["reading"]["state"], "paused", "{metrics}");
    for figure in ["memBytes", "cpuUsageUsec", "uptimeMs", "procs", "quietForMs"] {
        assert!(metrics["reading"].get(figure).is_none(), "{figure} in {metrics}");
    }
    // What answers `is stopped` is the op that needs a workspace running: a command has nowhere to run.
    let exec = w.ask("machine.exec", json!({ "machineId": id, "cmd": "true" })).await;
    assert_eq!(exec["ok"], false, "{exec}");
    assert!(exec["error"].as_str().unwrap().contains("is stopped"), "{exec}");
    // A fresh open of the same root finds the workspace stopped by the same reading, takes its mount and youki's
    // state, and says which.
    let again = Ops::open(&root(), PathBuf::from(env!("CARGO_BIN_EXE_wsp-daemon")), numbers::DEFAULT_PORT).unwrap();
    assert!(again.stopped_at_open().contains(&id), "{:?}", again.stopped_at_open());
    assert!(!root().join("state").join(&id).exists());
    drop(again);
    w.ok("machine.kill", json!({ "machineId": id })).await;
    w.made.clear();
    // Our process is untouched: alive, in its own cgroup, not frozen.
    assert!(squatter.try_wait().unwrap().is_none(), "the kill took the process on the reused pid");
    assert_eq!(fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap(), own_cgroup);
    let own_events = Path::new("/sys/fs/cgroup").join(own_cgroup.trim().trim_start_matches("0::/")).join("cgroup.events");
    assert!(fs::read_to_string(&own_events).map(|e| e.contains("frozen 0")).unwrap_or(true), "{}", own_events.display());
    let _ = squatter.kill();
    let _ = squatter.wait();
    assert!(!root().join("run").join(&id).exists());
    assert!(!Path::new(CGROUPS).join(&id).exists(), "cgroup of {id} stays");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_backend_and_the_self_check_answer_on_this_box() {
    assert!(root_here(), "{LIVE_REASON}");
    let w = World::open().await;
    assert_eq!(w.ok("machine.checkKey", json!({})).await, json!({ "id": 1, "ok": true }));
    let facts = w.ok("machine.backend", json!({})).await;
    assert_eq!(facts["offer"], "runtime");
    assert_eq!(facts["capabilities"]["pauseMode"], "disk");
    // This computer keeps no image: no flag promises one and no kind names one to boot from.
    assert_eq!(facts["capabilities"]["images"], false);
    assert_eq!(facts["capabilities"]["diskSnapshots"], false);
    assert_eq!(facts["capabilities"]["templates"], false);
    assert!(facts.get("baseTemplates").is_none(), "{facts}");
    let capacity = w.ok("machine.capacity", json!({})).await;
    assert!(capacity["cores"].as_u64().unwrap() >= 1);
    assert!(capacity["diskFreeBytes"].as_u64().unwrap() > 0);
    assert_eq!(capacity["images"].as_array().unwrap().len(), 0);
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn answers_the_daemon_road_at_the_published_port_on_the_boxs_loopback() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let started = Instant::now();
    let port = w.publish(&id, 7070).await;
    eprintln!("publish: {} ms", started.elapsed().as_millis());
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    assert_eq!(w.publish(&id, 7070).await, port, "the same port every time");
    assert_eq!(w.network(&id).forwards, [(7070, port)].into());
    let got = w.ok("machine.get", json!({ "machineId": id })).await;
    assert_eq!(got["machine"]["roads"]["previewUrl"], true);
    // A port nothing inside listens on is published all the same: the dial inside is refused, so the connection on
    // the box closes without a byte.
    let idle = w.publish(&id, 7071).await;
    assert_ne!(idle, port);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, idle)).await.unwrap(), "");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_address_a_turn_inside_dials_the_box_at_resolves_and_connects() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let network = w.network(&id);
    let (_, hosts, _) = w.exec(&id, "getent hosts host.wsp.internal; cat /etc/resolv.conf").await;
    assert!(hosts.starts_with(&format!("{} ", network.gateway)), "{hosts}");
    assert!(hosts.contains("host.wsp.internal\n"), "{hosts}");
    assert!(!hosts.contains("nameserver 127."), "the box's stub is not handed in: {hosts}");
    let on_gateway = TcpListener::bind(SocketAddrV4::new(network.gateway, 0)).unwrap();
    let port = on_gateway.local_addr().unwrap().port();
    let heard = std::thread::spawn(move || accept_line(&on_gateway));
    let (code, _, err) = w.exec(&id, &format!("exec 3<>/dev/tcp/host.wsp.internal/{port} && echo hi from $(hostname) >&3")).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(heard.join().unwrap().unwrap(), format!("hi from {id}"));
    // The box's other addresses stay behind its firewall: the same listener on every address is not reached there.
    let everywhere = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let other = everywhere.local_addr().unwrap().port();
    let (code, _, _) = w.exec(&id, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{}/{other}'", box_address())).await;
    assert_ne!(code, 0, "the box's address {} answered a workspace", box_address());
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn outbound_reaches_a_registry_the_tests_own_and_then_the_real_one() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let network = w.network(&id);
    let registry = TcpListener::bind(SocketAddrV4::new(network.gateway, 0)).unwrap();
    let port = registry.local_addr().unwrap().port();
    let challenge = format!(
        "HTTP/1.1 401 Unauthorized\r\nWww-Authenticate: Bearer realm=\"http://host.wsp.internal:{port}/token\",service=\"wsp\"\r\nContent-Length: 0\r\n\r\n"
    );
    let asked = std::thread::spawn(move || answer_once(&registry, &challenge));
    let get = |host: &str, port: u16| {
        format!("exec 3<>/dev/tcp/{host}/{port} && printf 'GET /v2/ HTTP/1.0\\r\\nHost: {host}\\r\\n\\r\\n' >&3 && head -c 400 <&3 | tr -d '\\r'")
    };
    let (code, out, err) = w.exec(&id, &get("host.wsp.internal", port)).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert!(out.starts_with("HTTP/1.1 401 Unauthorized\n"), "{out}");
    assert!(out.contains("Www-Authenticate: Bearer realm="), "{out}");
    assert_eq!(asked.join().unwrap().unwrap(), "GET /v2/ HTTP/1.0");
    // The real one, once: Docker Hub over plain http answers a redirect to its https door, and that answer coming
    // back is the round trip through the resolvers handed in and the NAT.
    let (code, out, err) = w.exec(&id, &format!("getent hosts registry-1.docker.io | head -1; {}", get("registry-1.docker.io", 80))).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    let mut lines = out.lines();
    assert!(lines.next().unwrap().contains("registry-1.docker.io"), "{out}");
    assert!(lines.next().unwrap().starts_with("HTTP/1.1 301"), "{out}");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn two_workspaces_cannot_reach_each_other() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let a = w.create(spec(json!({ "idempotencyKey": format!("live-665-apart-a-{}", checkout_key()) }))).await;
    let b = w.create(spec(json!({ "idempotencyKey": format!("live-665-apart-b-{}", checkout_key()) }))).await;
    let address_a = w.listen_inside(&a).await;
    let address_b = w.network(&b).address;
    assert_ne!(address_a, address_b);
    assert_ne!(w.network(&a).link, w.network(&b).link);
    // b reaches its own box, so a silence toward a is the rule and not a dead network.
    let (code, _, _) =
        w.exec(&b, "exec 3<>/dev/tcp/host.wsp.internal/22 && read -t 5 banner <&3 && case $banner in SSH-*) exit 0;; esac; exit 9").await;
    assert_eq!(code, 0);
    let (code, out, err) = w.exec(&b, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{address_a}/7070 && head -1 <&3'")).await;
    assert_ne!(code, 0, "workspace b reached a: {out}{err}");
    assert_eq!(out, "");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn delete_leaves_no_interface_no_rule_and_no_listener() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    assert!(Path::new("/sys/class/net").join(&network.link).exists());
    assert!(net::rules_present().unwrap());
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    w.ok("machine.kill", json!({ "machineId": id })).await;
    w.made.clear();
    assert!(!Path::new("/sys/class/net").join(&network.link).exists(), "{} stays", network.link);
    assert!(!Route::open().unwrap().links().unwrap().iter().any(|l| l.name.starts_with("wsp-")), "a workspace link stays");
    assert!(!net::rules_present().unwrap(), "the rules stay after the last workspace");
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
    assert!(!root().join("run").join(&id).exists());
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_daemon_restart_keeps_a_running_workspaces_network_and_its_forward() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    w.reopen().await;
    assert_eq!(w.state(&id).await, "running");
    assert_eq!(w.network(&id), network, "the record is untouched");
    assert!(Path::new("/sys/class/net").join(&network.link).exists(), "the sweep took a running workspace's link");
    assert!(net::rules_present().unwrap());
    assert_eq!(
        read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(),
        "hello from inside",
        "the forward is back on its port"
    );
    assert_eq!(w.publish(&id, 7070).await, port);
    let (code, _, _) = w.exec(&id, "exec 3<>/dev/tcp/host.wsp.internal/22").await;
    assert_eq!(code, 0);
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_sweep_at_start_takes_the_network_of_a_workspace_that_is_gone() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    // A pair the daemon made and lost before its workspace came up, its alias naming a workspace dir under this root.
    let mut route = Route::open().unwrap();
    route.add_veth("wsp-9000", "wspx-peer", None).unwrap();
    let orphan = route.index_of("wsp-9000").unwrap();
    route.set_alias(orphan, &root().join("run").join("wsp-nobody").display().to_string()).unwrap();
    // The workspace's init killed behind the daemon's back: its namespace and its pair go with it, its record stays.
    let state: Value = serde_json::from_slice(&fs::read(root().join("state").join(&id).join("state.json")).unwrap()).unwrap();
    let init = state["pid"].as_i64().unwrap();
    assert!(std::process::Command::new("kill").args(["-9", &init.to_string()]).status().unwrap().success());
    wait_until(|| !Path::new("/sys/class/net").join(&network.link).exists(), Duration::from_secs(5));
    w.reopen().await;
    assert_eq!(w.ops.net_swept_at_open(), &net::Swept { links: vec!["wsp-9000".into()], rules: true });
    assert!(!Path::new("/sys/class/net/wsp-9000").exists() && !Path::new("/sys/class/net/wspx-peer").exists());
    assert!(!net::rules_present().unwrap(), "the rules stay with no workspace running");
    assert_eq!(
        read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap_err().kind(),
        std::io::ErrorKind::ConnectionRefused,
        "a dead workspace's forward came back"
    );
    assert_eq!(w.state(&id).await, "paused");
    w.close().await;
}

/// The metadata service every cloud answers its instance's own facts at.
const METADATA: Ipv4Addr = Ipv4Addr::new(169, 254, 169, 254);
/// A plain GET from inside with bash alone: the status line comes back, or nothing inside three seconds.
fn get_from_inside(host: &str, port: u16, path: &str) -> String {
    format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{host}/{port} && printf \"GET {path} HTTP/1.0\\r\\nHost: {host}\\r\\n\\r\\n\" >&3 && head -1 <&3'")
}

/// The init's pid of a workspace, off youki's state file, which is where its network namespace is reached.
fn init_pid(id: &str) -> i32 {
    let state: Value = serde_json::from_slice(&fs::read(root().join("state").join(id).join("state.json")).unwrap()).unwrap();
    state["pid"].as_i64().unwrap() as i32
}

/// A firewall shaped like firewalld's: an inet table whose input and forward chains carry policy accept and end in
/// `reject with icmpx admin-prohibited`, with one accept before it sparing everything that is not a workspace's, so
/// the box stays reachable while the test runs. Goes when dropped.
struct LabFirewall;

const LAB_FIREWALL: &str = "wsplabfw";

impl LabFirewall {
    fn build() -> LabFirewall {
        let chain = |name, hook| nft::BaseChain {
            family: nft::NFPROTO_INET,
            table: LAB_FIREWALL,
            name,
            kind: "filter",
            hook,
            priority: 10,
            policy: nft::NF_ACCEPT,
        };
        let mut msgs = vec![
            nft::new_table(nft::NFPROTO_INET, LAB_FIREWALL),
            nft::new_chain(&chain("filter_INPUT", nft::NF_INET_LOCAL_IN)),
            nft::new_chain(&chain("filter_FORWARD", nft::NF_INET_FORWARD)),
        ];
        for name in ["filter_INPUT", "filter_FORWARD"] {
            let mut spare: Vec<nft::Expr> = nft::iifname_not_starts(net::LINK_PREFIX).into();
            spare.push(nft::verdict(nft::NF_ACCEPT));
            msgs.push(nft::new_rule(nft::NFPROTO_INET, LAB_FIREWALL, name, &spare, "lab: not a workspace's", false));
            msgs.push(nft::new_rule(nft::NFPROTO_INET, LAB_FIREWALL, name, &[nft::reject()], "lab: the final reject", false));
        }
        nft::Conn::open().unwrap().batch(&msgs, "building the lab firewall").unwrap();
        LabFirewall
    }

    /// The comments of the chain's rules, head first.
    fn comments(&self, chain: &str) -> Vec<String> {
        nft::Conn::open()
            .unwrap()
            .rules(nft::NFPROTO_INET, LAB_FIREWALL, chain)
            .unwrap()
            .into_iter()
            .map(|r| r.comment.unwrap_or_default())
            .collect()
    }
}

impl Drop for LabFirewall {
    fn drop(&mut self) {
        let _ =
            nft::Conn::open().and_then(|mut c| c.batch(&[nft::del_table(nft::NFPROTO_INET, LAB_FIREWALL)], "removing the lab firewall"));
    }
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_cannot_reach_the_boxs_cloud_metadata() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let box_reaches = TcpStream::connect_timeout(&SocketAddrV4::new(METADATA, 80).into(), Duration::from_secs(2)).is_ok();
    eprintln!("the box itself reaches {METADATA}:80: {box_reaches}");
    let (code, out, err) = w.exec(&id, &get_from_inside(&METADATA.to_string(), 80, "/hetzner/v1/metadata/hostname")).await;
    assert_ne!(code, 0, "the metadata service answered a workspace: {out}{err}");
    assert_eq!(out, "");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_forwards_through_the_default_route_alone() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let a = w.create(spec(json!({}))).await;
    let b = w.create(spec(json!({}))).await;
    // A second road into b, its box end named outside the workspace prefix, as a LAN or a tunnel interface is.
    let ns = fs::File::open(format!("/proc/{}/ns/net", init_pid(&b))).unwrap();
    let mut route = Route::open().unwrap();
    route.add_veth("wsplab0", "lab0", Some(ns.as_raw_fd())).unwrap();
    let lab = route.index_of("wsplab0").unwrap();
    route.add_address(lab, Ipv4Addr::new(192, 0, 2, 1), 24).unwrap();
    route.set_up(lab).unwrap();
    net::inside(ns, |r| {
        let lab0 = r.index_of("lab0")?;
        r.add_address(lab0, Ipv4Addr::new(192, 0, 2, 2), 24)?;
        r.set_up(lab0)
    })
    .unwrap();
    w.listen_inside(&b).await;
    let behind_lab = SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 2), 7070);
    assert_eq!(read_line(behind_lab).await.unwrap(), "hello from inside", "the box reaches b down the lab road");
    let (code, out, err) =
        w.exec(&a, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{}/{} && head -1 <&3'", behind_lab.ip(), behind_lab.port())).await;
    assert_ne!(code, 0, "workspace a reached the lab road: {out}{err}");
    assert_eq!(out, "");
    let (code, out, _) = w.exec(&a, &get_from_inside("registry-1.docker.io", 80, "/v2/")).await;
    assert_eq!(code, 0, "the world through the default route stays open: {out}");
    assert!(out.starts_with("HTTP/1.1 301"), "{out}");
    assert_eq!(fs::read_to_string(format!("/proc/sys/net/ipv4/conf/{}/forwarding", w.network(&a).link)).unwrap().trim(), "1");
    route.delete_named("wsplab0").unwrap();
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_firewall_that_ends_its_chains_in_a_reject_gets_the_accepts_at_its_head() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let lab = LabFirewall::build();
    let id = w.create(spec(json!({}))).await;
    let forward = lab.comments("filter_FORWARD");
    let input = lab.comments("filter_INPUT");
    assert_eq!(&forward[..2], [net::RULE_COMMENT, net::RULE_COMMENT], "{forward:?}");
    assert_eq!(forward[2..], ["lab: not a workspace's", "lab: the final reject"], "{forward:?}");
    assert_eq!(&input[..2], [net::RULE_COMMENT, net::RULE_COMMENT], "{input:?}");
    assert_eq!(input[2..], ["lab: not a workspace's", "lab: the final reject"], "{input:?}");
    let (code, out, err) = w.exec(&id, &get_from_inside("registry-1.docker.io", 80, "/v2/")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert!(out.starts_with("HTTP/1.1 301"), "{out}");
    let (code, _, _) =
        w.exec(&id, "exec 3<>/dev/tcp/host.wsp.internal/22 && read -t 5 banner <&3 && case $banner in SSH-*) exit 0;; esac; exit 9").await;
    assert_eq!(code, 0);
    w.close().await;
    assert_eq!(
        lab.comments("filter_FORWARD"),
        ["lab: not a workspace's", "lab: the final reject"],
        "the accepts go with the last workspace"
    );
    assert_eq!(lab.comments("filter_INPUT"), ["lab: not a workspace's", "lab: the final reject"]);
    drop(lab);
    assert!(!nft::Conn::open().unwrap().tables().unwrap().contains(&(nft::NFPROTO_INET, LAB_FIREWALL.to_owned())));
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_link_alias_longer_than_the_kernel_takes_is_refused_by_name() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut route = Route::open().unwrap();
    let lo = route.index_of("lo").unwrap();
    let refused = route.set_alias(lo, &"a".repeat(300)).unwrap_err();
    assert!(refused.to_string().ends_with("is 300 bytes, and a link alias holds 255"), "{refused}");
}

/// youki reads any process on the init's pid as the container, and a state file that does not read is a workspace
/// this daemon can neither nap nor wake: it reads gone, not a nap the resume would refuse, and the kill still takes
/// it whole, since a workspace that cannot be killed would stay on the box for good.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_live_init_whose_state_does_not_read_is_gone_not_a_nap_and_still_dies() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let init = init_pid(&id);
    let state = root().join("state").join(&id).join("state.json");
    fs::write(&state, b"{ not youki's").unwrap();
    assert_eq!(w.state(&id).await, "gone");
    let listed = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    assert!(listed["machines"].as_array().unwrap().iter().any(|m| m["id"] == id && m["state"] == "gone"), "{listed}");
    w.ok("machine.kill", json!({ "machineId": id })).await;
    w.made.clear();
    assert!(!Path::new(&format!("/proc/{init}")).exists(), "the init is gone");
    assert!(!Path::new(CGROUPS).join(&id).exists(), "the cgroup is gone");
    assert!(!root().join("state").join(&id).exists(), "youki's state is gone");
    assert!(!root().join("run").join(&id).exists(), "the run directory is gone");
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn pause_then_resume_boots_the_saved_layer_with_the_same_address_and_forward_under_200_ms() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "memMb": 512 }))).await;
    // A second workspace beside it, to be stopped and woken first: its block is then not the lowest free one. At
    // a size of its own and not the box's ceiling, which on a box whose share is a third is the whole cap: two
    // workspaces at that size leave the room figure below this one's 512 MB and it could not be read.
    let other = w.create(spec(json!({ "memMb": 512 }))).await;
    let other_address = w.network(&other).address;
    let address = w.listen_inside(&id).await;
    assert_ne!(other_address, address);
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    // Written where the saved layer keeps it: /var is one of the workspace's own overlays, and the box's /root,
    // which every workspace on it shares, is the box's own file if a workspace writes there.
    let (code, _, _) = w.exec(&id, "echo kept > /var/tmp/saved").await;
    assert_eq!(code, 0);
    let record: Value = serde_json::from_str(&fs::read_to_string(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let init = record["init"]["pid"].as_i64().unwrap();
    let room_before = w.ok("machine.capacity", json!({})).await["memRoomMb"].as_u64().unwrap();

    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "paused");
    // Stopped, not frozen: no process, no cgroup, no link, no listener, no mount; the upper and the records stay.
    assert!(!Path::new(&format!("/proc/{init}")).exists(), "the init is gone");
    assert!(!Path::new(CGROUPS).join(&id).exists(), "the cgroup is gone");
    assert!(!Path::new("/sys/class/net").join(&network.link).exists(), "the link is gone");
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")), "the overlay is detached");
    assert!(root().join("run").join(&id).join("upper/var/tmp/saved").is_file(), "the upper directory is the saved layer");
    assert_eq!(w.network(&id).forwards, network.forwards, "the network record keeps the forwards");
    let capacity = w.ok("machine.capacity", json!({})).await;
    assert_eq!(capacity["machines"]["paused"], 1);
    assert_eq!(capacity["memRoomMb"].as_u64().unwrap(), room_before + 512, "a stopped workspace holds no memory");
    let stopped = w.ask("machine.exec", json!({ "machineId": id, "cmd": "true" })).await;
    assert!(stopped["error"].as_str().unwrap().contains("is stopped"), "{stopped}");
    let twice = w.ask("machine.pause", json!({ "machineId": id })).await;
    assert!(twice["error"].as_str().unwrap().contains("is already paused"), "{twice}");
    let listed = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    assert!(listed["machines"].as_array().unwrap().iter().any(|m| m["id"] == id && m["state"] == "paused"), "{listed}");
    // The second workspace, stopped and woken while the first's block is the lowest free one, gets its own back.
    w.ok("machine.pause", json!({ "machineId": other })).await;
    w.ok("machine.resume", json!({ "machineId": other })).await;
    assert_eq!(w.network(&other).address, other_address, "the second workspace keeps its own block");
    let (_, out, _) = w.exec(&other, "hostname -I").await;
    assert_eq!(out.trim(), other_address.to_string());

    let started = Instant::now();
    w.ok("machine.resume", json!({ "machineId": id })).await;
    let wake = started.elapsed();
    eprintln!("wake from the saved layer: {} ms", wake.as_millis());
    assert_eq!(w.state(&id).await, "running");
    assert!(wake < Duration::from_millis(200), "the wake took {} ms", wake.as_millis());
    let woken = w.network(&id);
    assert_eq!((woken.address, woken.link, woken.gateway), (address, network.link.clone(), network.gateway), "the same address");
    assert_eq!(woken.forwards, network.forwards, "the same forward");
    let (code, out, _) = w.exec(&id, "cat /var/tmp/saved; hostname").await;
    assert_eq!((code, out.as_str()), (0, format!("kept\n{id}\n").as_str()));
    // The processes are gone with the stop, so the listener inside is started again; the box port is the same one.
    assert_eq!(w.listen_inside(&id).await, address);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    assert_eq!(w.publish(&id, 7070).await, port);
    let (_, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.high").await;
    // The cap as a kill and as a throttle, both back with the boot: the kernel reclaims what it can from the
    // workspace at the figure before it ends anything at it.
    assert_eq!(out.split_whitespace().collect::<Vec<_>>(), ["536870912", "536870912"], "{out}");
    // A second nap and wake, since the first is not special.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "paused");
    let started = Instant::now();
    w.ok("machine.resume", json!({ "machineId": id })).await;
    eprintln!("second wake: {} ms", started.elapsed().as_millis());
    assert_eq!(w.state(&id).await, "running");
    assert_eq!(w.network(&id).address, address);
    w.close().await;
}

/// One line read off a fresh connection to the address, inside two seconds, off the runtime thread: the forwards
/// under test are tasks of this very runtime and need it free to answer.
async fn read_line(addr: SocketAddrV4) -> std::io::Result<String> {
    tokio::task::spawn_blocking(move || {
        let stream = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        Ok(line.trim_end().to_owned())
    })
    .await
    .unwrap()
}

/// One connection accepted and its first line read, inside ten seconds.
fn accept_line(listener: &TcpListener) -> std::io::Result<String> {
    listener.set_nonblocking(false)?;
    let (stream, _) = listener.accept()?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    Ok(line.trim_end().to_owned())
}

/// One connection answered with the response once the request's headers have all arrived; answers the request's
/// first line. bash writes a request line by line, so a read that stops at the first segment and a close with the
/// rest unread would answer with a reset.
fn answer_once(listener: &TcpListener, response: &str) -> std::io::Result<String> {
    let (mut stream, _) = listener.accept()?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut request = Vec::new();
    let mut buf = [0u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        request.extend_from_slice(&buf[..n]);
    }
    let first = String::from_utf8_lossy(&request).lines().next().unwrap_or_default().to_owned();
    stream.write_all(response.as_bytes())?;
    Ok(first)
}

/// The address the box talks to the world from, off a UDP socket's own view; nothing is sent.
fn box_address() -> Ipv4Addr {
    let socket = UdpSocket::bind("0.0.0.0:0").unwrap();
    socket.connect("1.1.1.1:53").unwrap();
    match socket.local_addr().unwrap().ip() {
        std::net::IpAddr::V4(v4) => v4,
        other => panic!("{other} is no IPv4 address"),
    }
}

fn wait_until(done: impl Fn() -> bool, patience: Duration) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < patience, "not done in {} s", patience.as_secs());
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn base64_of(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut n = [0u8; 3];
        n[..chunk.len()].copy_from_slice(chunk);
        let v = (u32::from(n[0]) << 16) | (u32::from(n[1]) << 8) | u32::from(n[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((v >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The sha256 of what the byte road was handed, to read against what the file inside holds.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A file of the box's landed in the workspace through the byte road, in parts, and made executable.
async fn put_file(w: &World, id: &str, from: &Path, to: &str) {
    let bytes = fs::read(from).unwrap();
    let part_size = 4 * 1024 * 1024;
    let parts = bytes.chunks(part_size).collect::<Vec<_>>();
    let upload = format!("u{}", to.bytes().map(u64::from).sum::<u64>());
    for (seq, part) in parts.iter().enumerate() {
        w.ok(
            "machine.putBytes",
            json!({ "machineId": id, "path": to, "uploadId": upload, "seq": seq, "last": seq + 1 == parts.len(), "data": base64_of(part), "timeoutMs": 120_000 }),
        )
        .await;
    }
    let (code, _, err) = w.exec(id, &format!("chmod +x '{to}'")).await;
    assert_eq!((code, err.as_str()), (0, ""));
}

/// The box's own docker client and its compose plugin, where the box has them.
fn box_docker() -> Option<(PathBuf, PathBuf)> {
    let docker = ["/usr/bin/docker", "/usr/local/bin/docker"].into_iter().map(PathBuf::from).find(|p| p.exists())?;
    let compose = [
        "/usr/libexec/docker/cli-plugins/docker-compose",
        "/usr/lib/docker/cli-plugins/docker-compose",
        "/usr/local/lib/docker/cli-plugins/docker-compose",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())?;
    Some((docker, compose))
}

/// The box's own docker client: the exit code, stdout and stderr, apart, since a pull's progress lands on stderr
/// around the one line stdout carries.
fn on_box(args: &[&str]) -> (i32, String, String) {
    let out = std::process::Command::new("docker").args(args).output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// The id `docker run -d` prints: the one line of stdout that is a 64 hex digit id, whatever else the run said.
fn container_id(stdout: &str) -> Option<String> {
    stdout.lines().map(str::trim).find(|l| l.len() == 64 && l.bytes().all(|b| b.is_ascii_hexdigit())).map(str::to_owned)
}

/// The images a case is about to pull onto the box's engine through the fence, removed when the case ends however
/// it ends. An image the box already holds is left alone: it is the box's, not the case's, and a box serving
/// something is not a box whose images a test may take away.
///
/// The removal goes by the id each pull turned out to be, read off the engine once the pull has happened and
/// never by the name it was asked for: a name is a label the box's own work may move to another image between
/// this case's start and its end, and what this case may take away is the bytes it brought.
struct PulledImages {
    /// The names the box did not hold when the case started, in the order they were named.
    wanted: Vec<String>,
    /// The id each of those turned out to be, once `pulled` has read them.
    ids: Vec<String>,
}

impl PulledImages {
    fn of(refs: &[&str]) -> PulledImages {
        let wanted: Vec<String> = refs.iter().filter(|image| image_id(image).is_none()).map(|image| (*image).to_owned()).collect();
        eprintln!("== images this case will pull and remove: {wanted:?}");
        PulledImages { wanted, ids: Vec::new() }
    }

    /// The id every name this case pulled now has, read after the pull: called once the stack is up, so a case
    /// that died before its pull removes nothing rather than removing by a name.
    fn pulled(&mut self) {
        self.ids = self.wanted.iter().filter_map(|image| image_id(image)).collect();
        eprintln!("== the ids this case pulled: {:?}", self.ids);
    }
}

impl Drop for PulledImages {
    fn drop(&mut self) {
        for id in std::mem::take(&mut self.ids) {
            let (code, _, said) = on_box(&["image", "rm", &id]);
            if code != 0 {
                eprintln!("== the image {id} stayed on the box: {}", said.trim());
            }
        }
    }
}

/// What the box's engine holds an image name as, or nothing where it holds none.
fn image_id(image: &str) -> Option<String> {
    let (code, id, _) = on_box(&["image", "inspect", "--format", "{{.Id}}", image]);
    (code == 0).then(|| id.trim().to_owned()).filter(|id| !id.is_empty())
}

/// A container of the box's own, outside any workspace, removed when the case ends however it ends.
struct OutsideContainer {
    name: String,
}

impl Drop for OutsideContainer {
    fn drop(&mut self) {
        on_box(&["rm", "-f", &self.name]);
    }
}

#[test]
fn the_container_id_is_read_off_stdout_whatever_a_pull_printed_around_it() {
    let id = "08f2f4299c2a612c6f95ae0f5586eb975e67849e25e057837d309b451db61629";
    assert_eq!(container_id(&format!("{id}\n")), Some(id.to_owned()));
    assert_eq!(
        container_id(&format!("Unable to find image 'alpine:latest' locally\n{id}\nStatus: Downloaded newer image\n")),
        Some(id.to_owned())
    );
    assert_eq!(container_id("Status: Downloaded newer image for alpine:latest\n"), None);
    assert_eq!(container_id(""), None);
}

/// How long a case gives a service in a compose stack to start listening after its engine has returned: the
/// entrypoints of the two images take one to two seconds on a box, and a busier box is slower still.
const SERVICE_READY: Duration = Duration::from_secs(10);

fn show(title: &str, code: i64, out: &str, err: &str) {
    eprintln!("== {title} (exit {code})\n{}{}", out, if err.is_empty() { String::new() } else { format!("[stderr] {err}") });
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_with_an_engine_runs_a_projects_compose_and_sees_its_own_containers_alone() {
    assert!(root_here(), "{LIVE_REASON}");
    let Ok(_engine) = wsp_runtime::engine::socket_of(&wsp_runtime::doctor::read_facts()) else {
        eprintln!("this box has no container engine with a socket; the engine case is skipped");
        return;
    };
    let Some((docker, compose)) = box_docker() else {
        eprintln!("this box has no docker client with a compose plugin to land inside; the engine case is skipped");
        return;
    };
    // Declared before the world, so it is dropped after it: the workspace's own containers go with the kill, and
    // an image cannot be removed while a container of it is still there.
    let mut images = PulledImages::of(&["postgres:16-alpine", "nginx:alpine", "alpine"]);
    let mut w = World::open().await;
    let key = checkout_key();
    // A container of the box's own, outside any workspace: the one the workspace must not see. Removed when the case
    // ends, a panic included.
    let outside = format!("wsp-live-outside-{key}");
    on_box(&["rm", "-f", &outside]);
    let _outside_guard = OutsideContainer { name: outside.clone() };
    let (code, started, said) = on_box(&["run", "-d", "--name", &outside, "alpine", "sleep", "600"]);
    assert_eq!(code, 0, "{started}{said}");
    if !said.is_empty() {
        eprintln!("== the box pulled the image first:\n{said}");
    }
    let outside_id = container_id(&started).unwrap_or_else(|| panic!("no container id on stdout: {started:?}"));
    // The project the compose stack is run from: a checkout on the box, copied into the workspace by the create.
    // What a container of this workspace may bind is that copy and nothing else, off the record the create wrote,
    // so nothing the workspace writes inside decides it.
    let from = root().join("projects").join(format!("live-compose-{key}"));
    let _ = fs::remove_dir_all(&from);
    fs::create_dir_all(from.join("html")).unwrap();
    fs::write(from.join("html/index.html"), b"hello-from-workspace\n").unwrap();
    // Both services wear this suite's own label, so a person sweeping the box after a run that died finds them
    // by one filter: a compose stack's containers are named after its project and not after this suite.
    let compose_file = format!(
        "services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: wsp\n    labels:\n      {LIVE_LABEL}: \"1\"\n  web:\n    image: nginx:alpine\n    ports:\n      - \"18080:80\"\n    volumes:\n      - ./html:/usr/share/nginx/html:ro\n    labels:\n      {LIVE_LABEL}: \"1\"\n    depends_on: [db]\n"
    );
    fs::write(from.join("compose.yaml"), compose_file.as_bytes()).unwrap();
    let project = "/live-compose";
    let id = w
        .create(spec(json!({
            "engine": true,
            "copy": { "from": from.display().to_string(), "at": project },
            "idempotencyKey": format!("live-engine-{key}")
        })))
        .await;
    put_file(&w, &id, &docker, "/usr/local/bin/docker").await;
    put_file(&w, &id, &compose, COMPOSE_PLUGIN_INSIDE).await;
    let (code, out, err) = w.exec(&id, "ls -la /var/run/docker.sock /run/wsp; readlink -f /var/run/docker.sock").await;
    show("the socket inside the workspace made with --engine", code, &out, &err);
    assert_eq!(code, 0);
    // The staging directory the fence binds a source into is beside the socket's on the box and inside nowhere.
    assert!(!out.contains("binds"), "the staging directory shows inside the workspace: {out}");
    // The file the allowlist used to live in, written by the workspace to say it may bind the whole box.
    let (code, _, err) = w
        .exec(
            &id,
            "mkdir -p /root/.wsp && echo / > /root/.wsp/roots && docker version --format 'client {{.Client.Version}} server {{.Server.Version}}'",
        )
        .await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    let (code, out, err) = w.exec(&id, "docker run --rm -v /etc:/x alpine ls /x 2>&1").await;
    show("docker run -v /etc:/x after writing / into the roots file, from inside", code, &out, &err);
    assert_ne!(code, 0);
    assert!(out.contains(&format!("({project}), and /etc does not")), "{out}");
    // A link the workspace plants under its own project, which the engine would resolve at the container's start.
    let (code, _, err) = w.exec(&id, &format!("ln -sfn /etc {project}/html2")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    let (code, out, err) = w.exec(&id, &format!("docker run --rm -v {project}/html2:/x alpine ls /x 2>&1")).await;
    show("docker run -v <project>/html2:/x where html2 is a link, from inside", code, &out, &err);
    assert_ne!(code, 0);
    assert!(out.contains("is reached through a link inside the workspace"), "{out}");
    let started = Instant::now();
    let (code, out, err) = w.exec(&id, &format!("cd {project} && docker compose -p wspdemo up -d 2>&1")).await;
    show("docker compose up -d, from inside", code, &out, &err);
    // The pull has happened, so the ids this case brought are the ids it removes at its end.
    images.pulled();
    eprintln!("compose up took {} ms", started.elapsed().as_millis());
    assert_eq!(code, 0);
    let (code, out, err) =
        w.exec(&id, "docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}'; echo; docker ps -a --format '{{.Names}}  {{.Status}}'").await;
    show("docker ps, then docker ps -a, from inside", code, &out, &err);
    assert_eq!(code, 0);
    assert!(out.contains("wspdemo-db-1") && out.contains("wspdemo-web-1"), "{out}");
    assert!(!out.contains(&outside), "the box's own container shows inside: {out}");
    let (_, on_the_box, _) = on_box(&["ps", "--format", "{{.Names}}  {{.Ports}}"]);
    eprintln!("== docker ps, on the box\n{on_the_box}");
    assert!(on_the_box.contains(&outside) && on_the_box.contains("wspdemo-web-1"), "{on_the_box}");
    assert!(on_the_box.contains("127.0.0.1:"), "the published port sits on the box's loopback: {on_the_box}");
    let (code, out, err) = w.exec(&id, "docker run --rm -v /:/host alpine ls /host 2>&1").await;
    show("docker run -v /:/host, from inside", code, &out, &err);
    assert_ne!(code, 0);
    assert!(
        out.contains(&format!("a bind mount's source must sit under a project folder of this workspace ({project}), and / does not")),
        "{out}"
    );
    // The bind the stack's own service asked for: staged under the workspace's own run folder on the box, which
    // is where the engine read it from, and nothing of the copy's own path handed over.
    let staged = root().join("run").join(&id).join("binds");
    let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
    assert!(mounts.contains(staged.to_str().unwrap()), "no staged bind under {}", staged.display());
    // A stop and a wake leave every entry of the life before standing and still mounted: the engine's record
    // of a container made then names the entry that life gave it, and its next start resolves that entry.
    let entries: Vec<String> =
        fs::read_dir(&staged).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(!entries.is_empty(), "nothing staged under {}", staged.display());
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    let after: Vec<String> =
        fs::read_dir(&staged).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    for entry in &entries {
        assert!(after.contains(entry), "the wake took the staged entry {entry}: {after:?}");
    }
    let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
    assert!(mounts.contains(staged.to_str().unwrap()), "the wake left no staged bind under {}", staged.display());
    let (code, out, err) = w.exec(&id, &format!("cd {project} && docker compose -p wspdemo start 2>&1")).await;
    show("docker compose start after a wake, from inside", code, &out, &err);
    assert_eq!(code, 0, "{out}");
    // The page is asked for once the service listens, not once `up -d` has returned. Measured on a box: nginx
    // answers 1.2 to 2.0 s after its container starts, and until it does the engine's published port on the
    // box's loopback accepts the connection and closes it with no byte, which reads exactly like a forward that
    // dialled nothing. So this waits for a byte, and says what it waited for where none comes.
    let get = "exec 3<>/dev/tcp/127.0.0.1/18080; printf 'GET / HTTP/1.0\\r\\nHost: x\\r\\n\\r\\n' >&3; timeout 5 cat <&3";
    let waited = Instant::now();
    let mut answer = w.exec(&id, get).await;
    while answer.1.is_empty() && waited.elapsed() < SERVICE_READY {
        tokio::time::sleep(Duration::from_millis(250)).await;
        answer = w.exec(&id, get).await;
    }
    let (code, out, err) = answer;
    show("GET 127.0.0.1:18080 from inside (the published port)", code, &out, &err);
    eprintln!("the service answered its first byte {} ms after compose up returned", waited.elapsed().as_millis());
    assert!(
        out.contains("hello-from-workspace"),
        "the published port sent no page in the {} s this case waits for the service inside to start listening: {out:?}",
        SERVICE_READY.as_secs()
    );
    let (code, out, err) = w
        .exec(&id, &format!("docker inspect --type container --format '{{{{.Name}}}}' {outside_id} 2>&1; docker stop {outside} 2>&1"))
        .await;
    show("the box's own container, named from inside", code, &out, &err);
    assert!(out.contains(&format!("No such container: {outside_id}")), "{out}");
    let (_, still, _) = on_box(&["inspect", "--format", "{{.State.Status}}", &outside]);
    assert_eq!(still.trim(), "running", "the box's container was touched from inside");
    let (code, out, err) = w.exec(&id, "docker run -d --name wsp-live-left alpine sleep 600 2>&1").await;
    show("a container left running when the workspace goes", code, &out, &err);
    assert_eq!(code, 0);
    // Cost: one docker ps through the fence against one straight at the engine, from the box, twenty each. Off the
    // runtime thread, since the fence is served on it and the client waits on the fence.
    let socket = root().join("run").join(&id).join("engine").join("docker.sock");
    let time = |args: Vec<String>| {
        tokio::task::spawn_blocking(move || {
            let words: Vec<&str> = args.iter().map(String::as_str).collect();
            let started = Instant::now();
            for _ in 0..20 {
                assert_eq!(on_box(&words).0, 0, "{words:?}");
            }
            started.elapsed().as_millis() / 20
        })
    };
    let fenced = time(vec!["-H".into(), format!("unix://{}", socket.display()), "ps".into(), "-q".into()]).await.unwrap();
    let straight = time(vec!["ps".into(), "-q".into()]).await.unwrap();
    eprintln!("== cost: docker ps through the fence {fenced} ms, straight at the engine {straight} ms (mean of 20, from the box)");
    let status = fs::read_to_string("/proc/self/status").unwrap();
    eprintln!("== this process VmRSS with the proxy and forwards up: {}", status.lines().find(|l| l.starts_with("VmRSS")).unwrap_or(""));
    let (code, out, err) = w.exec(&id, &format!("cd {project} && docker compose -p wspdemo down -v 2>&1")).await;
    show("docker compose down -v, from inside", code, &out, &err);
    assert_eq!(code, 0);
    // A workspace made without the engine: no socket, and the client says so.
    let plain = w.create(spec(json!({ "idempotencyKey": format!("live-noengine-{key}") }))).await;
    put_file(&w, &plain, &docker, "/usr/local/bin/docker").await;
    let (code, out, err) = w.exec(&plain, "ls -la /var/run/docker.sock /run/wsp 2>&1; docker ps 2>&1").await;
    show("a workspace made without --engine: the socket and docker ps", code, &out, &err);
    assert_ne!(code, 0);
    assert!(out.contains("unix:///var/run/docker.sock") && out.contains("no such file or directory"), "{out}");
    assert!(!root().join("run").join(&plain).join("engine").exists());
    w.close().await;
    let (_, left, _) = on_box(&["ps", "-a", "--filter", &format!("label={}={id}", wsp_runtime::engine::LABEL), "--format", "{{.Names}}"]);
    let (_, networks, _) =
        on_box(&["network", "ls", "--filter", &format!("label={}={id}", wsp_runtime::engine::LABEL), "--format", "{{.Name}}"]);
    eprintln!("== after the kill, on the box: containers [{}] networks [{}]", left.trim(), networks.trim());
    assert_eq!((left.trim(), networks.trim()), ("", ""), "the killed workspace left containers on the engine");
    assert!(!socket.exists(), "the socket stays after the kill");
    let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
    assert!(!mounts.contains(staged.to_str().unwrap()), "a staged bind stays mounted after the kill");
    assert!(!staged.exists(), "the staging directory stays after the kill");
    let (_, outside_still, _) = on_box(&["inspect", "--format", "{{.State.Status}}", &outside]);
    assert_eq!(outside_still.trim(), "running", "the box's own container went with the workspace");
}

/// Two pieces of work on one project are two compose projects: the workspace's own id is the name compose reads
/// out of the environment, so the second one's stack does not find the first one's network under the name it
/// wants and fail at the network step. The name rides on the boot and on every exec, since a tenant inherits
/// neither the init's environment nor the daemon's.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_with_an_engine_runs_compose_under_a_project_of_its_own() {
    assert!(root_here(), "{LIVE_REASON}");
    let Ok(_engine) = wsp_runtime::engine::socket_of(&wsp_runtime::doctor::read_facts()) else {
        eprintln!("this box has no container engine with a socket; the compose project case is skipped");
        return;
    };
    let Some((docker, compose)) = box_docker() else {
        eprintln!("this box has no docker client with a compose plugin to land inside; the compose project case is skipped");
        return;
    };
    // Declared before the world, so it is dropped after it: the workspace's own containers go with the kill, and
    // an image cannot be removed while a container of it is still there.
    let mut images = PulledImages::of(&["alpine"]);
    let mut w = World::open().await;
    let key = checkout_key();
    let id = w.create(spec(json!({ "engine": true, "idempotencyKey": format!("live-compose-{key}") }))).await;
    let project = wsp_runtime::ops::compose_project(&id);
    // The environment of a command run in it, which is where compose reads the project name.
    let (code, out, err) = w.exec(&id, "echo $COMPOSE_PROJECT_NAME").await;
    show("the compose project of a command run inside", code, &out, &err);
    assert_eq!((code, out.trim()), (0, project.as_str()));
    // And of the workspace's first process, which every thread under it inherits.
    let (code, boot_env, err) = w.exec(&id, "tr '\\0' '\\n' < /proc/1/environ | grep COMPOSE_PROJECT_NAME").await;
    show("the compose project of the workspace's own init", code, &boot_env, &err);
    assert_eq!((code, boot_env.trim()), (0, format!("COMPOSE_PROJECT_NAME={project}").as_str()));

    put_file(&w, &id, &docker, "/usr/local/bin/docker").await;
    put_file(&w, &id, &compose, COMPOSE_PLUGIN_INSIDE).await;
    // The label every container this suite makes on the box wears, so a person sweeping the box after a run that
    // died can find them by one filter rather than by name.
    let stack = format!("services:\n  quiet:\n    image: alpine\n    command: sleep 600\n    labels:\n      {LIVE_LABEL}: \"1\"\n");
    let (code, _, err) = w.exec(&id, &format!("mkdir -p /var/tmp/stack && printf '%s' '{stack}' > /var/tmp/stack/compose.yaml")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    // No project named on the command line: what compose uses is the name in the environment, and without one it
    // would be the directory's, which every workspace of one project shares.
    let (code, out, err) = w.exec(&id, "cd /var/tmp/stack && docker compose up -d 2>&1").await;
    show("docker compose up -d with no project named, from inside", code, &out, &err);
    // The pull has happened, so the ids this case brought are the ids it removes at its end.
    images.pulled();
    assert_eq!(code, 0);
    let (code, named, err) = w.exec(&id, "docker ps --format '{{.Names}}'").await;
    show("what the stack's container is called", code, &named, &err);
    assert_eq!(code, 0);
    assert!(named.lines().any(|line| line.trim() == format!("{project}-quiet-1")), "{named}");
    // The box sees it under the same name, which is what makes two workspaces two stacks on one engine, and
    // wearing this suite's own label, which is how a person finds what a run that died left.
    let (_, on_the_box, _) = on_box(&["ps", "--filter", &format!("label={LIVE_LABEL}"), "--format", "{{.Names}}"]);
    assert!(on_the_box.lines().any(|line| line.trim() == format!("{project}-quiet-1")), "{on_the_box}");
    let (code, out, err) = w.exec(&id, "cd /var/tmp/stack && docker compose down -v 2>&1").await;
    show("docker compose down -v, from inside", code, &out, &err);
    assert_eq!(code, 0);
    w.close().await;
    let (_, left, _) = on_box(&["ps", "-a", "--filter", &format!("label={}={id}", wsp_runtime::engine::LABEL), "--format", "{{.Names}}"]);
    assert_eq!(left.trim(), "", "the killed workspace left containers on the engine");
}

/// A checkout on the box, as a project a person keeps there: a file, a folder, a symlink, a mode and a pair of
/// hard links, which is what a package tree is made of.
fn checkout(at: &Path) {
    fs::create_dir_all(at.join("src")).unwrap();
    fs::write(at.join("README.md"), b"the checkout\n").unwrap();
    fs::write(at.join("src/index.js"), b"module.exports = 1\n").unwrap();
    fs::hard_link(at.join("src/index.js"), at.join("src/again.js")).unwrap();
    std::os::unix::fs::symlink("index.js", at.join("src/link.js")).unwrap();
    fs::set_permissions(at.join("README.md"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
}

/// A workspace of this computer and nothing else: no image named, no project handed in. What it holds is what
/// the box holds, read through an overlay of its own; what the box keeps to itself, its own engine's state
/// included, is not in that view at all rather than empty inside it.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_is_the_computer_it_runs_on_with_a_wsp_folder_of_its_own() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The box's own tools and the box's own /etc, through the overlays; the box's /root, through the bind. The
    // wsp folder under that home is the workspace's own, bound over the box's, so what the computer's own daemon
    // keeps there is not a name a workspace can read.
    let (code, out, err) = w
        .exec(
            &id,
            "command -v sh; command -v git || echo no-git-on-this-box; head -1 /etc/os-release; ls -A /root/.wsp; test -e /var/lib/docker && echo present || echo absent; test -e /var/lib/containerd && echo present || echo absent",
        )
        .await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    eprintln!("== what a workspace of this computer reads: {out}");
    let inside: Vec<&str> = out.lines().collect();
    let on_the_box = fs::read_to_string("/etc/os-release").unwrap().lines().next().unwrap().to_owned();
    assert!(inside.contains(&on_the_box.as_str()), "the box's /etc/os-release did not come in: {out}");
    for name in fs::read_dir("/root/.wsp").into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()) {
        assert!(!inside.contains(&name.as_str()), "the daemon's own {name} is readable inside: {out}");
    }
    assert!(inside.len() >= 2, "the reads inside answered fewer lines than the case asked of them: {out}");
    assert_eq!(inside[inside.len() - 2..], ["absent", "absent"], "the box's own engine folders are inside: {out}");
    // The resolvers a workspace reads: a regular file the boot wrote, never the box's link into a /run the
    // workspace does not share, and never the box's own stub address, which inside this network namespace is
    // the workspace's own loopback. A name resolved from inside is the proof the file is usable.
    let (code, out, err) = w.exec(&id, "test -L /etc/resolv.conf && echo a-link || echo a-file; grep '^nameserver' /etc/resolv.conf").await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    assert!(out.starts_with("a-file\n") && out.contains("nameserver ") && !out.contains("127.0.0.53"), "{out}");
    eprintln!("== the resolvers a workspace of this computer reads: {out}");
    // What the box keeps out of a workspace: the daemon's own root, where every other workspace's copy lives,
    // and the box's own engine socket, since /run is the workspace's own directory and not the box's.
    let (code, out, _) = w.exec(&id, &format!("ls -A / | tr '\n' ' '; echo; test -e {} && echo root-inside || echo root-outside; test -e /run/docker.sock && echo socket-inside || echo socket-outside", root().display())).await;
    assert_eq!(code, 0);
    assert!(out.contains("root-outside") && out.contains("socket-outside"), "{out}");
    eprintln!("== what a workspace of this computer holds at its top level: {}", out.lines().next().unwrap_or(""));
    // /root is the person's own home on this computer, shared by every workspace on it: what the box holds there
    // is what a workspace reads, and what a workspace writes there the box has.
    let mark = format!("/root/.wsp-live-{}", checkout_key());
    let (code, _, err) = w.exec(&id, &format!("echo from-inside > {mark}")).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(fs::read_to_string(&mark).unwrap(), "from-inside\n", "the box's /root is not the workspace's own");
    fs::remove_file(&mark).unwrap();
    // The daemon's own folder inside is the workspace's own, not the computer's: two workspaces each write a
    // token at the path the daemon reads by default, each reads its own back, and the computer's own token file
    // is the same bytes after as before. The box's names were read as invisible inside above, which is what
    // makes this write safe to make.
    let token = wsp_frames::numbers::DEFAULT_TOKEN_PATH;
    let box_token = fs::read(token).ok();
    let second = w.create(spec(json!({}))).await;
    for (workspace, word) in [(&id, "first"), (&second, "second")] {
        let (code, _, err) = w.exec(workspace, &format!("printf '%s' token-of-the-{word} > {token}")).await;
        assert_eq!((code, err.as_str()), (0, ""), "{err}");
    }
    for (workspace, word) in [(&id, "first"), (&second, "second")] {
        let (code, out, _) = w.exec(workspace, &format!("cat {token}")).await;
        assert_eq!((code, out.as_str()), (0, format!("token-of-the-{word}").as_str()), "a workspace read another's token");
        assert_eq!(
            fs::read(root().join("run").join(workspace).join("wsp-home/daemon-token")).unwrap(),
            format!("token-of-the-{word}").into_bytes()
        );
    }
    assert_eq!(fs::read(token).ok(), box_token, "a workspace's write reached the computer's own daemon token");
    // And no workspace's folder is mounted at the computer's own path while both are up: a bind left in the
    // computer's peer group would put one there, where every process on the box reads it instead of its own.
    let table = fs::read_to_string("/proc/self/mountinfo").unwrap();
    let at_the_computers_own = table.lines().filter(|line| line.contains(&format!(" {} ", wsp_frames::numbers::GUEST_WSP_HOME))).count();
    assert_eq!(at_the_computers_own, 0, "a workspace's wsp folder is mounted at {}", wsp_frames::numbers::GUEST_WSP_HOME);
    // A package installed inside is the workspace's alone: the overlay's upper takes it and the box has nothing.
    let (code, out, err) =
        w.exec(&id, "mkdir -p /usr/local/lib/wsp-probe && echo mine > /usr/local/lib/wsp-probe/x && cat /usr/local/lib/wsp-probe/x").await;
    assert_eq!((code, out.as_str(), err.as_str()), (0, "mine\n", ""));
    assert!(!Path::new("/usr/local/lib/wsp-probe").exists(), "a workspace's write reached the box's /usr");
    assert!(root().join("run").join(&id).join("upper/usr/local/lib/wsp-probe/x").is_file(), "the write is not in the workspace's upper");
    // The mounts a workspace holds are under its rootfs and nowhere else, and the nap takes every one of them.
    let rootfs = format!("{}/run/{id}/rootfs", root().display());
    let under = |table: &str| table.lines().filter(|line| line.contains(&rootfs)).count();
    assert!(under(&fs::read_to_string("/proc/self/mountinfo").unwrap()) >= 9, "the overlays and the binds are not all there");
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    assert_eq!(under(&fs::read_to_string("/proc/self/mountinfo").unwrap()), 0, "the nap left a mount of the box's directories");
    // And the wake mounts the computer again over what the workspace wrote, its own wsp folder included.
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    let (code, out, _) = w.exec(&id, &format!("cat /usr/local/lib/wsp-probe/x; cat {token}; head -1 /etc/os-release")).await;
    assert_eq!(code, 0);
    assert!(out.starts_with("mine\ntoken-of-the-first"), "{out}");
    w.close().await;
}

/// A create meant for a provider, sent here: one sentence, and nothing of a workspace left behind. The eight ops
/// a layer store answered are not ops at all any more, so the frame itself is refused and names itself.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_create_that_names_an_image_is_refused_and_the_snapshot_ops_are_gone() {
    assert!(root_here(), "{LIVE_REASON}");
    let w = World::open().await;
    let key = checkout_key();
    let refused = w
        .ask(
            "machine.create",
            json!({ "spec": spec(json!({ "template": "ubuntu:24.04", "idempotencyKey": format!("live-image-{key}") })) }),
        )
        .await;
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"], wsp_frames::words::NO_IMAGES_HERE, "{refused}");
    assert!(!root().join("run").join(format!("wsp-live-image-{key}")).exists(), "the refused create claimed a folder");
    for (op, fields) in [
        ("machine.snapshot", json!({ "machineId": "wsp-x", "name": "v1", "life": { "firstLife": true } })),
        ("machine.listSnapshots", json!({})),
        ("machine.listTemplates", json!({})),
        ("machine.promoteSnapshot", json!({ "snapshotId": "sha256:aa", "name": "v1" })),
    ] {
        let reply = w.ask(op, fields).await;
        assert_eq!(reply["ok"], false, "{op}: {reply}");
        assert!(reply["error"].as_str().unwrap().contains(op), "{op}: {reply}");
    }
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_made_with_a_project_holds_a_copy_of_the_checkout_at_its_own_path() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let key = checkout_key();
    let from = root().join("projects").join(format!("live-copy-{key}"));
    let _ = fs::remove_dir_all(&from);
    checkout(&from);
    let at = "/Users/zingzy/wsp";
    let started = Instant::now();
    let made = w
        .created(spec(json!({
            "copy": { "from": from.display().to_string(), "at": at },
            "idempotencyKey": format!("live-copy-made-{key}"),
        })))
        .await;
    let id = made["id"].as_str().unwrap().to_owned();
    eprintln!("create with a copy to ready: {} ms", started.elapsed().as_millis());
    // The project is inside at the path it has on the computer, with the checkout's own bytes and its mode.
    let (code, out, err) = w.exec(&id, &format!("cat {at}/README.md; stat -c %a {at}/README.md; readlink {at}/src/link.js")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    assert_eq!(out.lines().collect::<Vec<_>>(), ["the checkout", "600", "index.js"], "{out}");
    // The two names of one file are one file in the copy too, which is what keeps a package tree's bytes down.
    let (code, out, _) = w.exec(&id, &format!("stat -c %i {at}/src/index.js {at}/src/again.js")).await;
    assert_eq!(code, 0);
    let inodes: Vec<&str> = out.lines().collect();
    assert_eq!(inodes.len(), 2);
    assert_eq!(inodes[0], inodes[1], "the hard linked pair became two files: {out}");
    // A write inside stays inside: the checkout on the box is not the workspace's to change.
    let (code, _, err) = w.exec(&id, &format!("echo written-inside >> {at}/README.md")).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(fs::read_to_string(from.join("README.md")).unwrap(), "the checkout\n");
    // And the checkout moving on does not reach a copy already made.
    fs::write(from.join("README.md"), "moved\n").unwrap();
    let (_, out, _) = w.exec(&id, &format!("cat {at}/README.md")).await;
    assert_eq!(out, "the checkout\nwritten-inside\n", "{out}");
    // The record carries how the copy was made and how long it took, and the copy is under the root's own folder.
    let record: Value = serde_json::from_slice(&fs::read(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let copy = &record["copy"];
    eprintln!("== the copy as the record carries it: {copy}");
    assert_eq!((copy["from"].as_str(), copy["at"].as_str()), (Some(from.display().to_string().as_str()), Some(at)));
    assert!(["reflink", "snapshot", "plain"].contains(&copy["made"].as_str().unwrap()), "{copy}");
    assert!(copy["ms"].as_u64().is_some(), "{copy}");
    assert!(root().join("copies").join(&id).is_dir());
    // What a boot leaves at /run and /tmp is not what a nap keeps: the project's copy comes back with the line
    // the workspace wrote in it, and the pid file a process inside left at /run is gone, as it is on any boot.
    let (code, _, err) = w.exec(&id, "echo 4242 > /run/inside.pid; echo scratch > /tmp/inside.tmp").await;
    assert_eq!((code, err.as_str()), (0, ""));
    // A nap keeps the copy and the file the workspace wrote in it, and the wake binds it back at the same path.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    assert!(root().join("copies").join(&id).is_dir(), "the nap took the copy");
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")), "the nap left a mount");
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    let (code, out, _) = w.exec(&id, &format!("cat {at}/README.md")).await;
    assert_eq!((code, out.as_str()), (0, "the checkout\nwritten-inside\n"));
    let (code, out, _) = w.exec(&id, "find /run /tmp -mindepth 1 | wc -l").await;
    assert_eq!((code, out.trim()), (0, "0"), "the wake carried the last boot's /run or /tmp");
    // The kill takes the copy with the workspace, and leaves the checkout on the box where it was.
    w.ok("machine.kill", json!({ "machineId": &id })).await;
    assert!(!root().join("copies").join(&id).exists(), "the copy stayed after the kill");
    assert!(from.join("README.md").exists(), "the kill took the checkout");
    let _ = fs::remove_dir_all(&from);
    w.close().await;
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_create_whose_project_is_not_there_is_refused_by_name_and_leaves_nothing() {
    assert!(root_here(), "{LIVE_REASON}");
    let w = World::open().await;
    let key = checkout_key();
    let gone = root().join("projects").join(format!("live-copy-no-such-{key}"));
    let id = format!("wsp-live-copy-missing-{key}");
    let reply = w
        .ask(
            "machine.create",
            json!({ "spec": spec(json!({
                "copy": { "from": gone.display().to_string(), "at": "/Users/zingzy/wsp" },
                "idempotencyKey": format!("live-copy-missing-{key}"),
            })) }),
        )
        .await;
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].as_str().unwrap().contains(&gone.display().to_string()), "{reply}");
    // Nothing of a workspace that never came up: no run directory, no copy, no cgroup.
    assert!(!root().join("run").join(&id).exists() && !root().join("copies").join(&id).exists());
    assert!(!Path::new(CGROUPS).join(&id).exists());
}

/// The computer's own directories are not a place for a workspace's mounts: a workspace whose copy lands at a
/// path of its own leaves the box's home exactly as it found it, and a copy asking for a path under that home is
/// refused before anything is made at it.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_copy_at_a_path_of_the_workspaces_own_leaves_the_boxs_home_alone_and_one_under_it_is_refused() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let key = checkout_key();
    let from = root().join("projects").join(format!("live-trees-{key}"));
    let _ = fs::remove_dir_all(&from);
    checkout(&from);
    let home = Path::new("/root");
    let listing = |at: &Path| -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(at).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };
    let before = listing(home);
    // A path of the workspace's own: its mount point is made under the rootfs the daemon holds, so the box's
    // home never sees it.
    let at = "/live-trees";
    let id = w
        .create(spec(json!({
            "copy": { "from": from.display().to_string(), "at": at },
            "idempotencyKey": format!("live-trees-{key}"),
        })))
        .await;
    let (code, out, err) = w.exec(&id, &format!("cat {at}/README.md")).await;
    assert_eq!((code, out.as_str(), err.as_str()), (0, "the checkout\n", ""));
    w.ok("machine.kill", json!({ "machineId": &id })).await;
    assert_eq!(listing(home), before, "a workspace's copy left something on the box's own home");

    // And a copy under that home: one sentence, and no mount point of a workspace's made on the computer.
    let under = "/root/live-trees";
    let reply = w
        .ask(
            "machine.create",
            json!({ "spec": spec(json!({
                "copy": { "from": from.display().to_string(), "at": under },
                "idempotencyKey": format!("live-trees-under-{key}"),
            })) }),
        )
        .await;
    assert_eq!(reply["ok"], false, "{reply}");
    assert_eq!(reply["error"], wsp_runtime::bundle::computer_tree_refusal(under, "/root"), "{reply}");
    assert!(!Path::new(under).exists(), "the refused create made a folder on the box's own home");
    assert_eq!(listing(home), before);
    let _ = fs::remove_dir_all(&from);
    w.close().await;
}

/// A throwaway volume of its own filesystem, made as a file and mounted on a loop device, so a box whose root
/// shares no blocks can still be asked what it does when a disk shares them. Unmounted and removed when the case
/// ends, a panic included.
struct Volume {
    image: PathBuf,
    at: PathBuf,
}

impl Drop for Volume {
    fn drop(&mut self) {
        let _ = std::process::Command::new("umount").arg(&self.at).status();
        let _ = fs::remove_dir_all(&self.at);
        let _ = fs::remove_file(&self.image);
    }
}

/// `mkfs` run over a sparse file of `gb` gigabytes and mounted, or nothing where this box has no such mkfs.
fn volume(word: &str, mkfs: &[&str], gb: u64) -> Option<Volume> {
    let key = checkout_key();
    let volume = Volume {
        image: PathBuf::from(format!("/tmp/wsp-copy-{word}-{key}.img")),
        at: PathBuf::from(format!("/tmp/wsp-copy-{word}-{key}")),
    };
    let _ = std::process::Command::new("umount").arg(&volume.at).status();
    let _ = fs::remove_file(&volume.image);
    fs::create_dir_all(&volume.at).unwrap();
    let file = fs::File::create(&volume.image).unwrap();
    file.set_len(gb * 1024 * 1024 * 1024).unwrap();
    drop(file);
    let made = std::process::Command::new(mkfs[0]).args(&mkfs[1..]).arg(&volume.image).output();
    match made {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            eprintln!("this box will not make a {word}: {}", String::from_utf8_lossy(&out.stderr).trim());
            return None;
        }
        Err(e) => {
            eprintln!("this box has no {}: {e}", mkfs[0]);
            return None;
        }
    }
    let mounted = std::process::Command::new("mount").args(["-o", "loop"]).arg(&volume.image).arg(&volume.at).output().ok()?;
    if !mounted.status.success() {
        eprintln!("this box will not mount a {word} on a loop device: {}", String::from_utf8_lossy(&mounted.stderr).trim());
        return None;
    }
    Some(volume)
}

/// What the volume this path sits on holds right now.
fn used_bytes(at: &Path) -> u64 {
    let name = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(at.as_os_str())).unwrap();
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: the name is a nul-terminated path and the struct is the one the call fills.
    assert_eq!(unsafe { libc::statvfs(name.as_ptr(), &mut stat) }, 0, "{}", at.display());
    (stat.f_blocks - stat.f_bfree) * u64::from(stat.f_frsize as u32)
}

/// Whether this run is root, which every case here asserts before its first line and the loop volumes and
/// their mounts need.
fn root_here() -> bool {
    // SAFETY: geteuid reads this process and touches nothing.
    unsafe { libc::geteuid() == 0 }
}

/// A checkout of `mb` megabytes in files of a megabyte each, with the odds and ends a real one carries.
fn big_checkout(at: &Path, mb: u64) {
    fs::create_dir_all(at.join("node_modules")).unwrap();
    let megabyte = vec![7u8; 1024 * 1024];
    for i in 0..mb {
        fs::write(at.join("node_modules").join(format!("pkg-{i}.js")), &megabyte).unwrap();
    }
    fs::write(at.join("README.md"), b"the checkout\n").unwrap();
    fs::hard_link(at.join("node_modules/pkg-0.js"), at.join("node_modules/linked.js")).unwrap();
    std::os::unix::fs::symlink("pkg-0.js", at.join("node_modules/link.js")).unwrap();
    fs::set_permissions(at.join("README.md"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    xattr::set(at.join("README.md"), "user.wsp", b"kept").unwrap();
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_disk_that_shares_blocks_copies_a_two_hundred_megabyte_checkout_for_its_metadata_alone() {
    assert!(root_here(), "{LIVE_REASON}");
    let Some(volume) = volume("xfs", &["mkfs.xfs", "-q", "-m", "reflink=1"], 2) else { return };
    let (from, copies) = (volume.at.join("projects/checkout"), volume.at.join("copies"));
    big_checkout(&from, 200);
    fs::create_dir_all(&copies).unwrap();
    let copier = wsp_runtime::copy::copier_for(&from, &copies).unwrap();
    assert_eq!(copier.word(), wsp_frames::CopyWord::Reflink, "a reflink xfs did not pick the reflink copy");
    let before = used_bytes(&volume.at);
    let started = Instant::now();
    copier.copy(&from, &copies.join("wsp-a")).unwrap();
    let took = started.elapsed();
    let grew = used_bytes(&volume.at).saturating_sub(before);
    eprintln!("== a 200 MB checkout copied by reflink in {} ms, and the volume grew by {grew} bytes", took.as_millis());
    assert!(grew < 1024 * 1024, "the copy cost {grew} bytes, which is a copy of the bytes rather than of the metadata");
    let to = copies.join("wsp-a");
    // What the checkout is made of came across.
    assert_eq!(fs::read(to.join("README.md")).unwrap(), b"the checkout\n");
    assert_eq!(fs::symlink_metadata(to.join("README.md")).unwrap().mode() & 0o7777, 0o600);
    assert_eq!(xattr::get(to.join("README.md"), "user.wsp").unwrap().as_deref(), Some(&b"kept"[..]));
    assert_eq!(fs::read_link(to.join("node_modules/link.js")).unwrap(), Path::new("pkg-0.js"));
    let (first, second) =
        (fs::metadata(to.join("node_modules/pkg-0.js")).unwrap(), fs::metadata(to.join("node_modules/linked.js")).unwrap());
    assert_eq!((first.ino(), first.nlink()), (second.ino(), 2), "the hard linked pair became two files");
    // Each tree is its own from the moment the clone is taken, whichever side is written.
    fs::write(to.join("README.md"), b"written in the copy\n").unwrap();
    assert_eq!(fs::read(from.join("README.md")).unwrap(), b"the checkout\n");
    fs::write(from.join("node_modules/pkg-1.js"), b"the checkout moved on\n").unwrap();
    assert_eq!(fs::metadata(to.join("node_modules/pkg-1.js")).unwrap().len(), 1024 * 1024);
    copier.remove(&to).unwrap();
    assert!(!to.exists());
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_btrfs_subvolume_is_snapshotted_rather_than_walked_at_all() {
    assert!(root_here(), "{LIVE_REASON}");
    let Some(volume) = volume("btrfs", &["mkfs.btrfs", "-q", "-f"], 2) else { return };
    let (from, copies) = (volume.at.join("checkout"), volume.at.join("copies"));
    let made = std::process::Command::new("btrfs").args(["subvolume", "create"]).arg(&from).output();
    match made {
        Ok(out) if out.status.success() => {}
        _ => {
            eprintln!("this box has no btrfs command to make a subvolume with; the snapshot case is skipped");
            return;
        }
    }
    big_checkout(&from, 50);
    fs::create_dir_all(&copies).unwrap();
    let copier = wsp_runtime::copy::copier_for(&from, &copies).unwrap();
    assert_eq!(copier.word(), wsp_frames::CopyWord::Snapshot, "a subvolume did not pick the snapshot");
    let to = copies.join("wsp-a");
    let started = Instant::now();
    copier.copy(&from, &to).unwrap();
    let took = started.elapsed();
    eprintln!("== a 50 MB subvolume snapshotted in {} ms", took.as_millis());
    assert!(took < Duration::from_millis(100), "the snapshot took {} ms, which is a walk rather than a snapshot", took.as_millis());
    assert_eq!(fs::read(to.join("README.md")).unwrap(), b"the checkout\n");
    fs::write(to.join("README.md"), b"written in the copy\n").unwrap();
    assert_eq!(fs::read(from.join("README.md")).unwrap(), b"the checkout\n");
    copier.remove(&to).unwrap();
    assert!(!to.exists(), "the snapshot's own directory stayed after the remove");
}

/// The bare repository a checkout of these cases pushes to, inside the checkout itself: the copy a workspace is
/// made with carries it in, so a push run inside the workspace has a remote it can reach. Nothing of the runtime
/// root is inside a workspace, and /tmp there is the skeleton's own emptied directory.
const BARE_ORIGIN: &str = ".origin.git";

/// git on the box for the cases that build a repo there: the identity every commit here carries, since a box may
/// have none of its own.
fn git_at(cwd: impl AsRef<Path>, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd.as_ref())
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@x")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A daemon of this computer's on the same runtime root the cases drive, for the frames a workspace's files and
/// git ride: what a host holding this computer's link sends, sent here over a socket of its own.
struct FramesDaemon {
    addr: std::net::SocketAddr,
    _token: tempfile::NamedTempFile,
}

const FRAMES_TOKEN: &str = "runtime-live-token";

async fn frames_daemon() -> FramesDaemon {
    frames_daemon_at(root().join("frames-home")).await
}

/// The same under a home the caller names, for the one case that asks what a daemon whose home is the box's own
/// resolves a command through.
async fn frames_daemon_at(home: PathBuf) -> FramesDaemon {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    std::io::Write::write_all(&mut token, format!("{FRAMES_TOKEN}\n").as_bytes()).unwrap();
    let mut options = wsp_daemon::Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root());
    options.roots_path = Some(root().join("roots"));
    options.runtime_root = Some(root());
    // A daemon serves workspaces only where a place file names one, which is what a computer somebody joined has
    // and what the product's own daemon on a box is started with. The file itself need not be there: a daemon
    // whose file is missing logs that it has no host to dial and dials nothing, and the workspaces it runs are
    // still its own to answer for.
    options.place_file = Some(home.join("place.json"));
    options.home = Some(home);
    // The helper every create and exec inside a workspace runs: the daemon binary this suite drives the ops
    // through. A daemon opened inside this process would otherwise run this test executable as its helper, and a
    // test binary answers an exec line by refusing its first flag.
    options.runtime_helper = Some(bin());
    // A guest session with nobody watching it stands for ten minutes on a machine; a case cannot sit through
    // that, and what it reads is the sentence the guest prints when the span runs out.
    options.guest_unwatched_ms = Some(2_000);
    let daemon = wsp_daemon::Daemon::bind(options).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    FramesDaemon { addr, _token: token }
}

/// One authed socket on that daemon, one frame at a time, keeping every event that arrived while a reply was
/// waited for: the daemon writes a handler's events ahead of its reply on the one channel, and a pane's bytes are
/// exactly those events.
struct FrameClient {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next_id: u64,
    seen: Vec<Value>,
}

impl FrameClient {
    async fn connect(addr: std::net::SocketAddr) -> FrameClient {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/")).await.unwrap();
        let mut c = FrameClient { ws, next_id: 0, seen: Vec::new() };
        assert_eq!(c.request("auth", json!({ "token": FRAMES_TOKEN })).await["ok"], true);
        c
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        use futures_util::{SinkExt, StreamExt};
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.ws.send(tokio_tungstenite::tungstenite::Message::text(frame.to_string())).await.unwrap();
        loop {
            let next = tokio::time::timeout(Duration::from_secs(120), self.ws.next()).await.expect("the daemon answers");
            match next {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                    let value: Value = serde_json::from_str(&t).unwrap();
                    if value.get("id") == Some(&json!(id)) {
                        return value;
                    }
                    self.seen.push(value);
                }
                Some(Ok(_)) => continue,
                other => panic!("the socket ended while {frame} was pending: {other:?}"),
            }
        }
    }

    /// The same, asserting the daemon took it.
    async fn ok(&mut self, op: &str, params: Value) -> Value {
        let said = self.request(op, params.clone()).await;
        assert_eq!(said["ok"], json!(true), "{op} {params}: {said}");
        said
    }

    /// Everything this socket has been pushed, up to now.
    async fn listen(&mut self, span: Duration) {
        use futures_util::StreamExt;
        let deadline = tokio::time::Instant::now() + span;
        while let Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            self.seen.push(serde_json::from_str(&t).unwrap());
        }
    }

    /// What every pty.data event of one pty carried, in order.
    fn pty_text(&self, pty_id: &str) -> String {
        self.seen.iter().filter(|f| f["type"] == "pty.data" && f["ptyId"] == pty_id).filter_map(|f| f["data"].as_str()).collect()
    }

    /// Reads until that pty's text holds the word, or the wait runs out.
    async fn printed_within(&mut self, pty_id: &str, word: &str, patience: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + patience;
        while !self.pty_text(pty_id).contains(word) {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            self.listen(Duration::from_millis(100)).await;
        }
        true
    }
}

/// The files and the git of a workspace on a computer somebody owns, answered by that computer's daemon for the
/// workspace the frame names: a workspace here runs no daemon of its own, so the daemon this case starts on the
/// same root serves them. Files are read on the box side through the workspace's rootfs, since a read runs no code;
/// git runs inside the workspace, which is what the hook this case writes proves.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_computers_daemon_answers_a_workspaces_files_and_git_for_the_workspace_named() {
    assert!(root_here(), "{LIVE_REASON}");
    let key = checkout_key();
    // A checkout with its own bare origin inside it, at a relative remote url, so the copy carries the origin into
    // the workspace and the push inside has somewhere to land with no network and no credential. The runtime root
    // itself is no road: inside a workspace /tmp is the skeleton's own directory, emptied at every boot, and the
    // only thing of this computer's the workspace reads at the project's path is the copy.
    //
    // The pre-push hook is what says where git ran: it writes a file, and that file may exist in the workspace's
    // own upper and nowhere on the box.
    let from = root().join("projects").join(format!("live-frames-{key}"));
    let _ = fs::remove_dir_all(&from);
    fs::create_dir_all(&from).unwrap();
    let origin = from.join(BARE_ORIGIN);
    git_at(&from, &["init", "-q", "-b", "main"]);
    fs::write(from.join("README.md"), b"the checkout\n").unwrap();
    git_at(&from, &["add", "README.md"]);
    git_at(&from, &["commit", "-q", "-m", "first"]);
    // The bare repository is made after that commit and excluded by the checkout's own exclude file, which travels
    // with the copy: a bare repository is not told from a folder of files by anything git reads, so a status or an
    // add that took it in would carry its objects as the checkout's own.
    fs::write(from.join(".git/info/exclude"), format!("/{BARE_ORIGIN}/\n")).unwrap();
    git_at(&from, &["init", "-q", "--bare", "-b", "main", BARE_ORIGIN]);
    // Relative, so the one url is the origin beside the checkout on the box and the origin beside the copy inside.
    git_at(&from, &["remote", "add", "origin", &format!("./{BARE_ORIGIN}")]);
    git_at(&from, &["push", "-q", "-u", "origin", "main"]);
    git_at(&from, &["switch", "-q", "-c", "work"]);
    fs::write(from.join("one.txt"), b"one\n").unwrap();
    git_at(&from, &["add", "one.txt"]);
    git_at(&from, &["commit", "-q", "-m", "one"]);
    // Nothing of the bare repository is in the checkout's own history or its status, which is what the exclude is for.
    assert_eq!(git_at(&from, &["status", "--porcelain"]).trim(), "");
    assert!(!git_at(&from, &["ls-files"]).contains(BARE_ORIGIN));
    let pushing = git_at(&from, &["rev-parse", "work"]).trim().to_owned();
    let hook = from.join(".git/hooks/pre-push");
    fs::write(&hook, "#!/bin/sh\nhostname > /var/tmp/wsp-pre-push-ran\n").unwrap();
    fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let marker = "/var/tmp/wsp-pre-push-ran";
    let _ = fs::remove_file(marker);

    let mut w = World::open().await;
    // Outside /root and outside every overlaid tree: the mount point a copy's bind makes is made through the
    // rootfs, and under a tree the boot bound in that means a directory on the computer's own shared home, left
    // there after the workspace is gone. A path of the workspace's own leaves the mount point in its run folder,
    // which the kill takes with everything else.
    let at = "/live-frames";
    let id = w.create(spec(json!({ "copy": { "from": from.display().to_string(), "at": at } }))).await;
    // A symlink inside the checkout that leads out of the workspace: read through the frame road it is refused,
    // since the path is resolved against the workspace's own rootfs and nowhere else.
    let (code, _, err) = w.exec(&id, &format!("ln -sfn /etc/shadow {at}/escape")).await;
    assert_eq!((code, err.as_str()), (0, ""));

    let daemon = frames_daemon().await;
    let mut client = FrameClient::connect(daemon.addr).await;
    // The checkout as the workspace sees it: one directory read on the box side through the rootfs.
    let listed = client.request("fs.list", json!({ "path": at, "machineId": &id })).await;
    assert_eq!(listed["ok"], true, "{listed}");
    let names: Vec<&str> = listed["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"README.md") && names.contains(&"one.txt"), "{listed}");
    // The branch the agent made, read by a git that ran inside the workspace.
    let status = client.request("git.status", json!({ "cwd": at, "machineId": &id })).await;
    assert_eq!((status["ok"].as_bool(), status["branch"]["head"].as_str()), (Some(true), Some("work")), "{status}");
    assert_eq!(status["root"].as_str(), Some(at));
    // A path that leaves the workspace is refused, and so is a workspace this computer does not run.
    let escaped = client.request("fs.read", json!({ "path": format!("{at}/escape"), "machineId": &id })).await;
    assert_eq!((escaped["ok"].as_bool(), escaped["code"].as_str()), (Some(false), Some("outside-root")), "{escaped}");
    // The refusal names the path the frame gave, as the workspace sees it, and not where this computer keeps that
    // workspace's files: the person who asked knows the folder by the one and never by the other.
    assert_eq!(escaped["error"].as_str(), Some(format!("{at}/escape resolves outside the workspace root").as_str()), "{escaped}");
    assert!(!escaped["error"].as_str().unwrap_or_default().contains(&root().display().to_string()), "{escaped}");
    let nowhere = client.request("git.status", json!({ "cwd": at, "machineId": "wsp-nobody" })).await;
    assert_eq!((nowhere["ok"].as_bool(), nowhere["error"].as_str()), (Some(false), Some("no such workspace: wsp-nobody")), "{nowhere}");

    // The push: the branch lands on the origin the workspace carries, and the hook ran inside the workspace, which
    // is the whole reason git runs there. Its marker is in the workspace's own upper and on no path of the box's.
    let pushed = client.request("git.push", json!({ "cwd": at, "base": "main", "machineId": &id })).await;
    assert_eq!(pushed["ok"], true, "{pushed}");
    assert_eq!((pushed["branch"].as_str(), pushed["base"].as_str(), pushed["ahead"].as_u64()), (Some("work"), Some("main"), Some(1)));
    // The copy's own origin, which the box reads under the copies folder: the branch is there at the commit the
    // checkout made. And the checkout's own origin on the box has main alone, so nothing of this push ran there.
    let copy_origin = root().join("copies").join(&id).join(BARE_ORIGIN);
    assert_eq!(git_at(&copy_origin, &["rev-parse", "work"]).trim(), pushing, "the push did not land in the copy's own origin");
    let on_the_box = git_at(&origin, &["for-each-ref", "--format=%(refname)"]);
    assert!(on_the_box.contains("refs/heads/main"), "{on_the_box}");
    assert!(!on_the_box.contains("refs/heads/work"), "the push reached the checkout's own origin on the box: {on_the_box}");
    let (code, ran, _) = w.exec(&id, &format!("cat {marker}")).await;
    assert_eq!(code, 0, "the pre-push hook did not run inside the workspace");
    assert!(!ran.trim().is_empty(), "the hook wrote nothing inside");
    assert!(!Path::new(marker).exists(), "the hook ran on the box rather than inside the workspace");

    // A stopped workspace has no rootfs mounted and no process to run git in, and says so in the runtime's words.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    let asleep = client.request("git.status", json!({ "cwd": at, "machineId": &id })).await;
    assert_eq!(
        (asleep["ok"].as_bool(), asleep["error"].as_str()),
        (Some(false), Some(format!("workspace {id} is stopped").as_str())),
        "{asleep}"
    );
    w.close().await;
}

/// A pty inside a workspace as a case drives it: what is typed into it, and everything it has printed, read on a
/// task of its own so a wait here is on a word and never on a read that may not return.
struct Pane {
    input: tokio::process::ChildStdin,
    printed: std::sync::Arc<std::sync::Mutex<String>>,
}

impl Pane {
    fn open(input: tokio::process::ChildStdin, mut output: tokio::process::ChildStdout) -> Pane {
        let printed = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let held = std::sync::Arc::clone(&printed);
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = tokio::io::AsyncReadExt::read(&mut output, &mut buf).await {
                if n == 0 {
                    break;
                }
                held.lock().unwrap_or_else(|held| held.into_inner()).push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
        Pane { input, printed }
    }

    async fn typed(&mut self, line: &str) {
        self.sent(format!("{line}\n").as_bytes()).await;
    }

    /// A write that fails is the road into the pty going, which is the shell or the broker gone: said here rather
    /// than left as a torn pipe, since every read after it would give out for that one reason.
    async fn sent(&mut self, bytes: &[u8]) {
        let typed = tokio::io::AsyncWriteExt::write_all(&mut self.input, bytes).await;
        let flushed = match typed {
            Ok(()) => tokio::io::AsyncWriteExt::flush(&mut self.input).await,
            Err(e) => Err(e),
        };
        if let Err(e) = flushed {
            panic!("the pane could not be typed into: {e}; it had read {:?}", self.text());
        }
    }

    /// Whether the word is among what the pane has printed, within the wait.
    async fn printed_within(&self, word: &str, patience: Duration) -> bool {
        let deadline = Instant::now() + patience;
        loop {
            if self.text().contains(word) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn text(&self) -> String {
        self.printed.lock().unwrap_or_else(|held| held.into_inner()).clone()
    }
}

/// The terminal pane's road into a workspace on this computer, at its own end. The pty is opened inside the
/// workspace by this binary's own broker, run as the command of a plain exec: the library's terminal road is not
/// taken at all, since its detached tenant's seccomp load is refused by the kernel before any shell runs. What is
/// proved here is that the pty is the workspace's and not the computer's, that a resize reaches the shell, that
/// job control works, and that the exit comes back.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_pane_opens_a_shell_inside_the_workspace_on_a_pty_of_the_workspaces_own() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // What the workspace's own /dev holds, read through an exec, which is the road the pty is opened on: the
    // terminal is made from these devices, so a run that got none says here whether the workspace had a devpts of
    // its own to make it from and what may reach it.
    let (code, reading, said) = w
        .exec(
            &id,
            "ls -la /dev/pts /dev/ptmx; echo ---; (mount 2>/dev/null || cat /proc/self/mountinfo) | grep -E 'pts|devtmpfs'; echo ---; id; echo ---; grep -E '^(Seccomp|Seccomp_filters|CapEff|NoNewPrivs):' /proc/self/status",
        )
        .await;
    eprintln!("what the workspace's own /dev reads:\n{reading}{said}");
    assert_eq!(code, 0, "the reading of the workspace's /dev failed: {said}");

    let opened = Instant::now();
    let mut running = match w.ops.pty_in(&id, 100, 40, "/root", None).await {
        Ok(running) => running,
        // On its own line and whole: the sentence names which step gave out, how the helper ended and what it
        // printed, which is what says whether this is a mount, a filter or the road itself.
        Err(e) => panic!("no terminal after {} ms:\n{}", opened.elapsed().as_millis(), e.message),
    };
    eprintln!("pty inside: {} ms", opened.elapsed().as_millis());
    let pid = running.pid();
    let Some((input, output)) = running.pipes() else {
        panic!("the pty handed no pipes over; {}", running.said().await);
    };
    let mut pane = Pane::open(input, output);

    // Every word waited for below is one the shell has to print: a terminal echoes what is typed into it, so a
    // marker that stood in the line as typed would be read back before the shell had run anything at all.
    // The shell is inside: its host name is the workspace's, which is its id, and the computer's is not that. A
    // pane that printed nothing is asked of the helper: the library writes the broker's pid the moment the tenant
    // is made, so a tenant the kernel refuses after that is a pty that stands for a moment and says nothing.
    pane.typed("hostname; echo mark-$((20+3))").await;
    if !pane.printed_within("mark-23", Duration::from_secs(20)).await {
        panic!("{}", gave_out("the shell's first line", &pane, &mut running, &id).await);
    }
    assert!(pane.text().contains(&id), "the shell is not inside the workspace: {:?}", pane.text());

    // Its terminal is a device of the workspace's own devpts, which exists inside; the broker is a process of the
    // workspace's cgroup, which is what says the pty is not the computer's. The name is read where it stands in
    // the bytes: a pane carries the prompt and whatever the line editor writes around an answer, so the device is
    // on a line of its own on no terminal worth the name.
    pane.typed("tty; echo said-$((20+3))").await;
    if !pane.printed_within("said-23", Duration::from_secs(20)).await {
        panic!("{}", gave_out("the terminal's own name", &pane, &mut running, &id).await);
    }
    let Some(device) = device_of(&pane.text()) else {
        panic!("{}", gave_out("a /dev/pts device in what the shell printed", &pane, &mut running, &id).await);
    };
    let (code, _, said) = w.exec(&id, &format!("test -c {device}")).await;
    assert_eq!(code, 0, "{device} is no character device inside the workspace: {said}");
    let at = format!("/proc/{pid}/cgroup");
    let cgroup = match fs::read_to_string(&at) {
        Ok(cgroup) => cgroup,
        Err(e) => {
            panic!("the broker's own cgroup could not be read at {at}: {e}; {}", gave_out("a cgroup", &pane, &mut running, &id).await)
        }
    };
    assert!(cgroup.contains(&id), "the pty is held outside the workspace's cgroup: {cgroup}");

    // The size the pane holds is the size the shell reads, before and after a resize, which travels as the size
    // in the workspace's own file and a window-change signal to the broker.
    pane.typed("stty size").await;
    if !pane.printed_within("40 100", Duration::from_secs(20)).await {
        panic!("{}", gave_out("the size the pane opened with", &pane, &mut running, &id).await);
    }
    if let Err(e) = running.resize(80, 24) {
        panic!("the resize was not sent: {e}; {}", gave_out("a resize", &pane, &mut running, &id).await);
    }
    pane.typed("stty size; echo sized-$((20+3))").await;
    if !pane.printed_within("sized-23", Duration::from_secs(20)).await {
        panic!("{}", gave_out("the size after a resize", &pane, &mut running, &id).await);
    }
    assert!(pane.text().contains("24 80"), "the resize did not reach the shell: {:?}", pane.text());

    // Job control: a background job brought to the foreground and interrupted from the pane leaves the shell
    // answering, well inside the sleep it was given.
    pane.typed("sleep 30 &").await;
    pane.typed("fg").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    pane.sent(&[0x03]).await;
    pane.typed("echo back-$((20+3))").await;
    if !pane.printed_within("back-23", Duration::from_secs(10)).await {
        panic!("{}", gave_out("the shell after an interrupt", &pane, &mut running, &id).await);
    }

    // And the exit comes back: the shell ends, the broker and the helper end with it, and nothing of either is
    // left on the computer.
    pane.typed("exit").await;
    let waited = tokio::time::timeout(Duration::from_secs(20), running.helper.wait()).await;
    let ended = match waited {
        Ok(Ok(ended)) => ended,
        Ok(Err(e)) => panic!("the helper could not be waited for: {e}; the pane read {:?}", pane.text()),
        Err(_) => panic!("the helper did not end with the shell; the pane read {:?}", pane.text()),
    };
    eprintln!("the pane's shell exited: {ended}");
    assert!(!Path::new(&format!("/proc/{pid}")).exists(), "the broker is still on the computer");
    // Nothing of the pty is left: the pid file went when the pid was read, and the size file with the pty it was
    // written for.
    assert!(pty_files(&id).is_empty(), "the pty left {:?} behind", pty_files(&id));
    w.close().await;
}

/// The terminal device a shell named, read where it stands in the bytes rather than as a line of its own: a pane
/// carries the prompt before an answer and whatever the line editor writes around it.
fn device_of(printed: &str) -> Option<String> {
    let at = printed.find(DEV_PTS)?;
    let digits: String = printed[at + DEV_PTS.len()..].chars().take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then(|| format!("{DEV_PTS}{digits}"))
}

const DEV_PTS: &str = "/dev/pts/";

/// What the pty left in the workspace's own folders: the pid file the library writes and the size file the
/// resize is read from, both of which go with the pty they were made for.
fn pty_files(id: &str) -> Vec<String> {
    let mut held = Vec::new();
    for dir in [root().join("run").join(id), root().join("run").join(id).join("wsp-home")] {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        held.extend(
            entries
                .filter_map(|entry| entry.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                .filter(|name| name.starts_with("pty-"))
                .map(|name| format!("{}/{name}", dir.display())),
        );
    }
    held.sort();
    held
}

/// The three things a read that gave out is explained by: what the pane has read so far, what the helper and the
/// broker inside printed, and what the pty left in the workspace's folders. Ends the pty, since it is asked once
/// the case has already failed.
async fn gave_out(what: &str, pane: &Pane, running: &mut wsp_runtime::runtime::PtyInsideRunning, id: &str) -> String {
    format!("{what} never came. the pane read {:?}; {}; the workspace holds {:?}", pane.text(), running.said().await, pty_files(id))
}

/// The device read against the bytes a terminal really carries: a prompt before the answer, the line editor's own
/// escape sequences around it, and the answer arriving in pieces.
#[test]
fn the_terminal_device_is_read_wherever_it_stands_in_what_the_shell_printed() {
    assert_eq!(device_of("/dev/pts/0\r\n").as_deref(), Some("/dev/pts/0"));
    // A prompt and the echo of the line before it, which is every interactive shell.
    assert_eq!(device_of("root@wsp-a:~# tty\r\n/dev/pts/3\r\nroot@wsp-a:~# ").as_deref(), Some("/dev/pts/3"));
    // What bash with its line editor writes around an answer, which is not a line this could split on.
    assert_eq!(device_of("\u{1b}[?2004l\r/dev/pts/12\r\n\u{1b}[?2004h").as_deref(), Some("/dev/pts/12"));
    // Nothing of the sort, and a name cut by a read that has not landed whole.
    assert_eq!(device_of("bash: tty: command not found\r\n"), None);
    assert_eq!(device_of("/dev/pts/"), None);
}

/// The Terminal pane's own frames, answered by this computer's daemon for the workspace they name: a pane opens a
/// shell inside that workspace, reads its bytes, resizes it, stops reading it and ends it, and no frame of one
/// machine reaches a pty of another. What a pane does never keeps a workspace awake, and what a person types into
/// it does.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_computers_daemon_answers_a_workspaces_pane_and_leaves_its_quiet_clock_alone() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let d = frames_daemon().await;
    let mut pane = FrameClient::connect(d.addr).await;

    // A pty for a workspace names the folder it opens in, and the pane's own first tab is given the workspace's
    // checkout path by the host before the frame goes.
    let none = pane.request("pty.create", json!({ "machineId": &id, "cols": 100, "rows": 40 })).await;
    assert_eq!(none["code"], "bad-request", "{none}");
    assert_eq!(none["error"], format!("a pty inside {id} needs the folder it opens in"));
    let made = pane.ok("pty.create", json!({ "machineId": &id, "cols": 100, "rows": 40, "cwd": "/root" })).await;
    let pty = made["ptyId"].as_str().unwrap().to_owned();
    let pid = made["pid"].as_u64().unwrap();
    assert!(pid > 0, "{made}");
    pane.ok("pty.attach", json!({ "ptyId": &pty, "machineId": &id })).await;

    // The shell is inside the workspace, on a terminal of that workspace's own devpts, and the size it reads is
    // the one the pane opened with.
    pane.ok("pty.write", json!({ "ptyId": &pty, "machineId": &id, "data": "hostname; tty; stty size; echo mark-$((20+3))\n" })).await;
    assert!(pane.printed_within(&pty, "mark-23", Duration::from_secs(30)).await, "{:?}", pane.pty_text(&pty));
    let said = pane.pty_text(&pty);
    assert!(said.contains(&id), "the shell is not inside the workspace: {said}");
    assert!(said.contains("/dev/pts/"), "{said}");
    assert!(said.contains("40 100"), "the shell read another size: {said}");

    // The listing is the machine's the frame names: this workspace's pty for the workspace, and nothing for the
    // computer itself, which opened none of its own.
    let inside = pane.ok("pty.list", json!({ "machineId": &id })).await;
    assert_eq!(inside["ptys"].as_array().unwrap().len(), 1, "{inside}");
    assert_eq!(inside["ptys"][0]["id"], json!(pty));
    assert_eq!(inside["ptys"][0]["cols"], json!(100));
    let here = pane.ok("pty.list", json!({})).await;
    assert_eq!(here["ptys"], json!([]), "a workspace's pty was listed as this computer's own");
    // And a frame that names no workspace, or another, reaches no pty of this one.
    for named in [json!({ "ptyId": &pty }), json!({ "ptyId": &pty, "machineId": "wsp-other" })] {
        let said = pane
            .request("pty.write", {
                let mut frame = named.clone();
                frame["data"] = json!("echo nowhere\n");
                frame
            })
            .await;
        assert_eq!(said["error"], json!(format!("no such pty: {pty}")), "{named}");
    }

    // A resize reaches the shell through the size file and the signal the broker reads it on.
    pane.ok("pty.resize", json!({ "ptyId": &pty, "machineId": &id, "cols": 80, "rows": 24 })).await;
    pane.ok("pty.write", json!({ "ptyId": &pty, "machineId": &id, "data": "stty size; echo sized-$((20+3))\n" })).await;
    assert!(pane.printed_within(&pty, "sized-23", Duration::from_secs(30)).await, "{:?}", pane.pty_text(&pty));
    assert!(pane.pty_text(&pty).contains("24 80"), "the resize did not reach the shell: {:?}", pane.pty_text(&pty));

    // A second pane on a socket of its own reads the same shell; the first stops reading it and the second does
    // not, which is what a closed tab does on a computer whose panes share one link.
    let mut second = FrameClient::connect(d.addr).await;
    second.ok("pty.attach", json!({ "ptyId": &pty, "machineId": &id })).await;
    pane.ok("pty.detach", json!({ "ptyId": &pty, "machineId": &id })).await;
    let before = pane.pty_text(&pty);
    second.ok("pty.write", json!({ "ptyId": &pty, "machineId": &id, "data": "echo after-$((20+3))\n" })).await;
    assert!(second.printed_within(&pty, "after-23", Duration::from_secs(30)).await, "{:?}", second.pty_text(&pty));
    pane.listen(Duration::from_millis(500)).await;
    assert_eq!(pane.pty_text(&pty), before, "a pane that stopped reading was still sent the pty's bytes");

    // The quiet clock: a pane reading this workspace's checkout leaves it where it was, and a person typing into
    // the pane starts it over. Read off the daemon that serves the workspace, since the clock is that daemon's
    // own reading of what the workspace is doing and the frames above rode the same socket.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let quiet = quiet_ms(&mut second, &id).await;
    assert!(quiet >= 1_000, "the clock did not run while nothing happened: {quiet}");
    let read = second.request("git.status", json!({ "cwd": "/root", "machineId": &id })).await;
    assert_eq!(read["ok"], json!(false), "the workspace's home is no checkout: {read}");
    let after_read = quiet_ms(&mut second, &id).await;
    assert!(after_read >= quiet, "a pane reading the workspace started its clock over: {quiet} then {after_read}");
    // The write, then the shell's answer to it, then the reading: the keystroke touches the clock as it is
    // served and the chunk the shell prints touches it again, so the figure is read behind both.
    second.ok("pty.write", json!({ "ptyId": &pty, "machineId": &id, "data": "echo typed-$((20+3))\n" })).await;
    assert!(second.printed_within(&pty, "typed-23", Duration::from_secs(30)).await, "{:?}", second.pty_text(&pty));
    let typed_at = quiet_ms(&mut second, &id).await;
    assert!(typed_at < 1_000, "typing into the pane left the workspace reading quiet: {typed_at}");

    // And the pty ends: the shell is gone, the broker with it, and nothing of either is left in the workspace's
    // own folders.
    second.ok("pty.kill", json!({ "ptyId": &pty, "machineId": &id })).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!Path::new(&format!("/proc/{pid}")).exists(), "the broker is still on the computer");
    let gone = second.ok("pty.list", json!({ "machineId": &id })).await;
    assert_eq!(gone["ptys"], json!([]), "the pty stands after its kill");
    let held: Vec<String> = ["", "wsp-home"]
        .iter()
        .flat_map(|under| {
            let dir = root().join("run").join(&id).join(under);
            fs::read_dir(dir).into_iter().flatten().filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        })
        .filter(|name| name.starts_with("pty-"))
        .collect();
    assert!(held.is_empty(), "the pty left {held:?} behind");
    w.close().await;
}

/// A guest inside a workspace reaches this computer's daemon over the socket that workspace alone can see, and
/// reaches nothing else of the computer through it. The word it runs is the shim the boot wrote into the
/// workspace's own upper, onto the init already bound inside.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_guest_inside_a_workspace_reaches_the_daemon_over_the_socket_of_its_own() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The daemon is started after the workspace, as one that restarted under a running workspace is: it names
    // every workspace already running as it takes them over, and binds the door inside each.
    let d = frames_daemon().await;
    let mut here = FrameClient::connect(d.addr).await;

    // What the workspace's own wsp folder holds: the socket this computer bound in it, and none of the
    // computer's own daemon files, since that folder is the workspace's and not the box's.
    let (code, listed, said) = w.exec(&id, "ls -1 /root/.wsp; echo ---; command -v wsp; echo ---; cat /usr/local/bin/wsp").await;
    assert_eq!((code, said.as_str()), (0, ""), "{listed}");
    let (folder, rest) = listed.split_once("---\n").unwrap();
    assert!(folder.lines().any(|name| name.trim() == "daemon.sock"), "no socket inside the workspace: {folder}");
    assert!(!folder.contains("daemon-token"), "the computer's own daemon token is inside the workspace: {folder}");
    let (word, shim) = rest.split_once("---\n").unwrap();
    assert_eq!(word.trim(), wsp_frames::numbers::GUEST_WSP_PATH);
    assert_eq!(shim, wsp_frames::guest_wsp_shim(wsp_runtime::profile::INIT_PATH));

    // The word inside opens a session on that socket and nothing answers it, since this daemon's host is not
    // there: the daemon ends it after the span it was started with and the guest prints why and exits 1.
    let (code, out, said) = w.exec(&id, "wsp threads; echo exited-$?").await;
    assert_eq!(code, 0, "{said}");
    assert!(said.contains(wsp_frames::words::GUEST_UNWATCHED), "the session ended another way: {said:?} {out:?}");
    assert!(out.contains("exited-1"), "the guest exited another way: {out:?}");

    // The socket itself, dialled from this computer as a process inside would: no auth frame, and the guest's own
    // two ops and ping answered. Everything else of this computer is refused, the listing of its workspaces and
    // the sessions its host watches among them.
    let at = root().join("run").join(&id).join("wsp-home").join("daemon.sock");
    let mut inside = InsideSocket::open(&at).await;
    assert_eq!(inside.hello().await["type"], "daemon.hello");
    assert_eq!(inside.request("ping", json!({})).await, json!({ "id": 1, "ok": true }));
    let opened = inside.request("guest.open", json!({ "kind": "cli", "token": "", "argv": ["threads"], "cwd": "/root" })).await;
    assert_eq!(opened["ok"], json!(true), "{opened}");
    for op in ["machine.list", "machine.metrics", "guest.watch", "exec", "pty.list", "fs.list", "place.leave"] {
        let said = inside.request(op, json!({ "machineId": &id, "cmd": "id", "path": "/root" })).await;
        assert_eq!(said["code"], json!("forbidden"), "{op}: {said}");
        assert_eq!(said["error"], json!(wsp_frames::words::NOT_ON_THIS_ROAD), "{op}");
    }

    // And the computer's own socket, which holds its token, is refused the host's three: a client here may read
    // what this computer runs and may not take the sessions its host watches.
    let watched = here.request("guest.watch", json!({})).await;
    assert_eq!(watched["error"], json!(wsp_frames::words::NOT_ON_THIS_ROAD), "{watched}");
    assert_eq!(here.ok("machine.list", json!({})).await["machines"].as_array().unwrap().len(), 1);

    // The door goes with the workspace: a stopped workspace holds no socket, and nothing can be dialled there.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!at.exists(), "the socket stands after the workspace stopped");
    assert!(tokio::net::UnixStream::connect(&at).await.is_err());
    w.close().await;
}

/// What a workspace on this computer carries into a thread, a command and a pane: the order the host asked for
/// and the recipe's knobs beside it, one environment for all three. The boot's is the spec's, an exec and the
/// pty broker are tenants that start from it, and the login shell in a pane holds that order too, whether its
/// /etc/profile leaves PATH alone or resets it and the file the boot wrote under /etc/profile.d puts it back.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_carries_the_hosts_order_and_its_knobs_into_an_exec_a_pty_and_a_pane() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    // One knob of the case's own beside the PATH the host sends: the daemon spells no manager's name, so a name
    // nothing here knows is what proves the record's own envs reach every road inside.
    let knob = "/opt/wsp/uv/tools";
    let id = w.create(spec(json!({ "envs": { "WSP_KNOB": knob, "PATH": wsp_frames::numbers::PLACE_WORKSPACE_PATH } }))).await;

    // An exec, which runs as a tenant of the workspace: the crate reads the spec's environment as the tenant's
    // baseline, so what the create carried is there with nothing exported by hand.
    let (code, out, err) = w.exec(&id, "printf '%s\\n' \"$WSP_KNOB\" \"$PATH\"").await;
    show("the environment one exec inside carries", code, &out, &err);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!((code, lines.first().copied()), (0, Some(knob)), "{out}");
    assert_eq!(lines.get(1).copied(), Some(wsp_frames::numbers::PLACE_WORKSPACE_PATH), "{out}");

    let d = frames_daemon().await;
    let mut pane = FrameClient::connect(d.addr).await;
    let made = pane.ok("pty.create", json!({ "machineId": &id, "cols": 100, "rows": 40, "cwd": "/root" })).await;
    let pty = made["ptyId"].as_str().unwrap().to_owned();
    let pid = made["pid"].as_u64().unwrap();

    // What a person's pane reads, printed by the pane's own shell, which is the only reading of this road that
    // is a person's: the knob, which nothing on the daemon's side of a pty names, so it can only have come from
    // the workspace's own environment through the broker, and the order, whole. It reaches a pane by one of two
    // roads, the broker's own environment where the box's /etc/profile leaves PATH alone and the file the boot
    // wrote under /etc/profile.d where it resets it, and the line is matched whole because the first folders of
    // this order are the first of a distribution's own reset list too, so a line cut short reads the same on a
    // pane that got neither.
    pane.ok("pty.attach", json!({ "ptyId": &pty, "machineId": &id })).await;
    pane.ok("pty.write", json!({ "ptyId": &pty, "machineId": &id, "data": "printf 'pane %s %s\\n' \"$WSP_KNOB\" \"$PATH\"\n" })).await;
    let whole = format!("pane {knob} {}", wsp_frames::numbers::PLACE_WORKSPACE_PATH);
    assert!(pane.printed_within(&pty, &whole, Duration::from_secs(30)).await, "{:?}", pane.pty_text(&pty));

    // And which process the reply's number names, read now the pane has answered and the exec is certainly
    // done: the broker, as the box numbers it, told from the helper that started it by the line it runs.
    let cmdline = fs::read(format!("/proc/{pid}/cmdline")).unwrap();
    let args: Vec<&str> = std::str::from_utf8(&cmdline).unwrap().split('\0').filter(|a| !a.is_empty()).collect();
    assert_eq!(args.first().copied(), Some(wsp_runtime::profile::INIT_PATH), "the pid is not the pane's broker: {args:?}");
    assert_eq!(args.get(1..3), Some(["runtime", "pty"].as_slice()), "{args:?}");

    pane.ok("pty.kill", json!({ "ptyId": &pty, "machineId": &id })).await;
    w.close().await;
}

/// The word a process inside a workspace runs for wsp is the shim the boot wrote, not a copy planted under the
/// home every workspace on this computer shares. The copy is read with `command -v` and never run: what it would
/// do is what the order is here to prevent.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_runs_wsps_own_word_and_not_a_copy_planted_under_the_shared_home() {
    assert!(root_here(), "{LIVE_REASON}");
    let before = listing(Path::new(PLANTED_DIR));
    // Planted before the workspace is made, as a sibling's thread would have left it, and swept whatever ends
    // this case. The lock World takes is not taken here: opening it is what takes it.
    let planted = Planted::named("wsp");
    let planted_at = planted.binary.to_string_lossy().into_owned();
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;

    let (code, found, err) = w.exec(&id, "command -v wsp").await;
    show("the wsp a process inside resolves", code, &found, &err);
    assert_eq!((code, found.trim()), (0, wsp_frames::numbers::GUEST_WSP_PATH), "{err}");

    // The case's own red, driven inside on the order a workspace here booted with before this round: the same
    // read there answers the planted copy, so the green above is the order holding and not a copy nothing would
    // have found either way.
    let (code, old, err) = w.exec(&id, &format!("export PATH={}\ncommand -v wsp", wsp_frames::numbers::TOOLS_PATH)).await;
    show("the same read on the old order", code, &old, &err);
    assert_eq!(old.trim(), planted_at, "{err}");
    assert!(!planted.ran(), "the planted copy was run inside the workspace");

    planted.sweep();
    assert_eq!(listing(Path::new(PLANTED_DIR)), before, "this case left something under the shared home");
    w.close().await;
}

/// A workspace whose init ends on its own ends the way a stop ends it: the daemon that took the workspaces over
/// hears the same word, so the door inside goes, its socket file goes with it, and the workspace reads as a nap
/// the wake boots from.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_whose_init_is_killed_loses_its_door_and_reads_as_a_nap() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The daemon is started after the workspace, as one that restarted under a running workspace is: it names
    // every workspace already running as it takes them over, binds the door inside each and watches each init.
    let _d = frames_daemon().await;
    let at = root().join("run").join(&id).join("wsp-home").join("daemon.sock");
    assert!(at.exists(), "no door inside a running workspace");

    let record: Value = serde_json::from_slice(&fs::read(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let pid = record["init"]["pid"].as_i64().unwrap() as i32;
    // SAFETY: kill takes two plain integers and touches no memory of ours.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0, "the init of {id} could not be killed");

    let deadline = Instant::now() + Duration::from_secs(20);
    while at.exists() {
        assert!(Instant::now() < deadline, "the socket stands on a workspace whose init is gone");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(tokio::net::UnixStream::connect(&at).await.is_err());
    assert_eq!(w.state(&id).await, "paused");
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    assert_eq!(w.state(&id).await, "running");
    w.close().await;
}

/// How long this computer's daemon has seen that workspace do nothing, off the reading it answers for one
/// workspace: the clock is the daemon's own, so it is read through the socket the frames ride and not through
/// another opening of the same root.
async fn quiet_ms(client: &mut FrameClient, id: &str) -> u64 {
    let read = client.ok("machine.metrics", json!({ "machineId": id })).await;
    read["reading"]["quietForMs"].as_u64().unwrap_or_else(|| panic!("no quiet figure in {read}"))
}

/// One socket inside a workspace, dialled from this computer the way a process inside dials it: the file is the
/// whole of the gate, so nothing is sent before the frames themselves.
struct InsideSocket {
    ws: tokio_tungstenite::WebSocketStream<tokio::net::UnixStream>,
    next_id: u64,
}

impl InsideSocket {
    async fn open(at: &Path) -> InsideSocket {
        let stream = tokio::net::UnixStream::connect(at).await.unwrap_or_else(|e| panic!("{}: {e}", at.display()));
        let (ws, _) = tokio_tungstenite::client_async("ws://workspace/", stream).await.unwrap();
        InsideSocket { ws, next_id: 1 }
    }

    async fn next_frame(&mut self) -> Value {
        use futures_util::StreamExt;
        let next = tokio::time::timeout(Duration::from_secs(20), self.ws.next()).await.expect("the door answers");
        match next {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => serde_json::from_str(&t).unwrap(),
            other => panic!("the socket inside ended: {other:?}"),
        }
    }

    async fn hello(&mut self) -> Value {
        self.next_frame().await
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        use futures_util::SinkExt;
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.ws.send(tokio_tungstenite::tungstenite::Message::text(frame.to_string())).await.unwrap();
        loop {
            let read = self.next_frame().await;
            if read.get("id") == Some(&json!(id)) {
                return read;
            }
        }
    }
}

/// A diff inside a workspace past the byte budget says so, whichever cap it met: the exec road inside has one of
/// its own under the diff's, and a person reading a cut diff is told either way.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_diff_inside_past_the_cap_reads_cut() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let d = frames_daemon().await;
    let mut client = FrameClient::connect(d.addr).await;
    // A checkout of the workspace's own, under one of its overlays rather than the computer's home, with one
    // small change and one past every cap the road has.
    let repo = "/var/tmp/live-diff";
    let (code, _, said) = w
        .exec(
            &id,
            &format!(
                "set -e; rm -rf {repo}; mkdir -p {repo}; cd {repo}; git init -q -b main; git config user.email a@b; git config user.name a; printf 'one\\n' > small.txt; git add -A; git commit -q -m first; printf 'two\\n' > small.txt; git add -A"
            ),
        )
        .await;
    assert_eq!((code, said.as_str()), (0, ""));
    let small = client.ok("git.diff", json!({ "cwd": repo, "scope": "staged", "machineId": &id })).await;
    assert_eq!(small["truncated"], json!(false), "{small}");
    // Three megabytes of it, past the diff's own two and past the exec road's under it. Written by one process
    // with nothing reading behind it: a producer whose reader closes early would print a broken pipe of its own,
    // which is the shell's own complaint and no part of what the cut reads.
    let (code, _, said) = w
        .exec(&id, &format!("set -e; cd {repo}; awk 'BEGIN{{ for (i = 0; i < 70000; i++) print \"a line of a file that is about to be large\" }}' > big.txt; git add -A"))
        .await;
    assert_eq!((code, said.as_str()), (0, ""));
    let cut = client.ok("git.diff", json!({ "cwd": repo, "scope": "staged", "machineId": &id })).await;
    assert_eq!(cut["truncated"], json!(true), "a diff past every cap read whole");
    w.close().await;
}

/// The one directory the case writes on the box: the first entry of the tools PATH under the home every
/// workspace here shares, which is the directory the finding is about. Nothing of the box's own `/usr` is
/// touched, since the tool the case reads back is one every Linux box already has there.
const PLANTED_DIR: &str = "/root/.local/bin";
/// The tool the case shadows: on the probe list it is the box's own under /usr, and what it prints cannot be
/// mistaken for the planted copy's word.
const SHADOWED: &str = "uname";
const ITS_ANSWER: &str = "Linux";
/// What the planted copy prints when it runs, which the box's own never prints.
const PLANTED_ANSWER: &str = "planted";

/// The copy the case plants under the home, and the marker that copy writes when it runs. The marker is written
/// by the planted script itself and by nothing else, so a marker standing means this daemon ran that file. Both
/// come off the box when this value is dropped, which is every way the case can end, a panic among them.
struct Planted {
    binary: PathBuf,
    marker: PathBuf,
    /// Whether the case made the directory itself, so a box that had none is left with none.
    made_dir: bool,
}

impl Planted {
    fn new() -> Planted {
        Planted::named(SHADOWED)
    }

    /// The same under another name, for a case that shadows a word of wsp's own rather than a tool of the box's.
    fn named(name: &str) -> Planted {
        let dir = PathBuf::from(PLANTED_DIR);
        let made_dir = !dir.exists();
        fs::create_dir_all(&dir).unwrap();
        let planted = Planted { binary: dir.join(name), marker: PathBuf::from("/root/wsp-live-planted-ran"), made_dir };
        // A file already standing under that name is the box's own, whoever put it there: this case shadows a
        // tool and sweeps what it shadowed, and it will not delete a file it did not write.
        assert!(!planted.binary.exists(), "{} already stands; remove it and run again", planted.binary.display());
        let _ = fs::remove_file(&planted.marker);
        // Every value the script prints is quoted: a script whose own line will not parse writes its marker and
        // prints nothing, which is a case that reads as the rule failing when it was the case that broke.
        fs::write(&planted.binary, format!("#!/bin/sh\ntouch '{}'\nprintf '%s\\n' '{PLANTED_ANSWER}'\n", planted.marker.display()))
            .unwrap();
        fs::set_permissions(&planted.binary, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        planted
    }

    /// Whether the planted copy has run: it writes this file and nothing else does.
    fn ran(&self) -> bool {
        self.marker.exists()
    }

    fn sweep(&self) {
        let _ = fs::remove_file(&self.binary);
        let _ = fs::remove_file(&self.marker);
    }
}

impl Drop for Planted {
    fn drop(&mut self) {
        self.sweep();
        if self.made_dir {
            let _ = fs::remove_dir(PLANTED_DIR);
        }
    }
}

/// What stands in a directory now, by name, sorted: read before the case plants and after it sweeps.
fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(dir).map(|read| read.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

/// The stdout of one exec on the link, line by line, with what it said on the way for a case that fails.
async fn exec_lines(client: &mut FrameClient, cmd: &str) -> (Vec<String>, String) {
    let said = client.ok("exec", json!({ "cmd": cmd })).await;
    let out = said["stdout"].as_str().unwrap_or_default().to_owned();
    let lines = out.lines().map(str::to_owned).collect();
    (lines, said.to_string())
}

#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_daemon_of_this_computers_runs_nothing_it_found_under_the_home_the_workspaces_here_share() {
    assert!(root_here(), "{LIVE_REASON}");
    let _turn = ONE_AT_A_TIME.lock().await;
    let home = PathBuf::from("/root");
    let before = listing(Path::new(PLANTED_DIR));
    let planted = Planted::new();
    let planted_at = planted.binary.to_string_lossy().into_owned();

    let d = frames_daemon_at(home.clone()).await;
    let mut client = FrameClient::connect(d.addr).await;
    // What this daemon resolves a command through, set before a child of it could exist: the box's own system
    // directories, with every directory under the home it shares with its workspaces left out. Every road out of
    // this daemon runs on it, the exec below, the git and gh reads, each pty and the version probe.
    let asked = format!("printf '%s\\n' \"$PATH\"; command -v {SHADOWED}; {SHADOWED}");
    let (lines, said) = exec_lines(&mut client, &asked).await;
    assert_eq!(lines.first().map(String::as_str), Some(probe_path(&home).as_str()), "{said}");
    // The box's own copy under /usr, which every Linux box has, and never the one planted under the home.
    let found = lines.get(1).cloned().unwrap_or_default();
    assert_ne!(found, planted_at, "the daemon resolved the command through the home its workspaces write: {said}");
    assert!(found.starts_with("/usr/") || found.starts_with("/bin/"), "{found}: {said}");
    assert_eq!(lines.get(2).map(String::as_str), Some(ITS_ANSWER), "{said}");
    assert!(!planted.ran(), "the binary planted under the home was run as root outside every workspace");

    // The case's own red, driven on this box: the list this daemon ran on before the rule, the home's own
    // directory first. The same read there answers the planted copy and runs it, so the green above is the rule
    // holding and not a planted copy nothing would have found either way.
    let on_the_old = format!("export PATH={}\ncommand -v {SHADOWED}\n{SHADOWED}", numbers::TOOLS_PATH);
    let (old, said) = exec_lines(&mut client, &on_the_old).await;
    assert_eq!(old.first().map(String::as_str), Some(planted_at.as_str()), "{said}");
    assert_eq!(old.get(1).map(String::as_str), Some(PLANTED_ANSWER), "{said}");
    assert!(planted.ran(), "the case could not drive the road it is here to close: {said}");

    planted.sweep();
    assert!(!planted.binary.exists() && !planted.marker.exists());
    assert_eq!(listing(Path::new(PLANTED_DIR)), before, "this case left something under the home");
}

/// A container a workspace starts sits on a bridge of the workspace's own, under the same rules the workspace is
/// under: the box's cloud metadata is out of its reach, a sibling container of the same workspace answers it by
/// name, and a container of the box's own on the engine's default bridge does not. The bridge's rule stands on
/// the box while the network does and goes with the workspace.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspaces_container_sits_on_a_bridge_of_its_own_and_reaches_no_metadata_and_no_neighbour() {
    assert!(root_here(), "{LIVE_REASON}");
    let Ok(_engine) = wsp_runtime::engine::socket_of(&wsp_runtime::doctor::read_facts()) else {
        eprintln!("this box has no container engine with a socket; the bridge case is skipped");
        return;
    };
    let Some((docker, _)) = box_docker() else {
        eprintln!("this box has no docker client to land inside; the bridge case is skipped");
        return;
    };
    let mut images = PulledImages::of(&["alpine"]);
    let mut w = World::open().await;
    let key = checkout_key();
    // A container of the box's own on the engine's default bridge: the neighbour the workspace must not reach.
    let outside = format!("wsp-live-bridge-outside-{key}");
    on_box(&["rm", "-f", &outside]);
    let _outside_guard = OutsideContainer { name: outside.clone() };
    let (code, started, said) = on_box(&["run", "-d", "--name", &outside, "alpine", "sleep", "600"]);
    assert_eq!(code, 0, "{started}{said}");
    let (_, neighbour, _) = on_box(&["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", &outside]);
    let neighbour = neighbour.trim().to_owned();
    assert!(!neighbour.is_empty(), "the box's own container has no address");

    let id = w.create(spec(json!({ "engine": true, "idempotencyKey": format!("live-bridge-{key}") }))).await;
    put_file(&w, &id, &docker, "/usr/local/bin/docker").await;
    let (code, out, err) = w.exec(&id, &format!("docker run -d --name wsp-live-net-a --label {LIVE_LABEL}=1 alpine sleep 600 2>&1")).await;
    show("a container started on no named network, from inside", code, &out, &err);
    images.pulled();
    assert_eq!(code, 0, "{out}");
    let (code, bridge, err) =
        w.exec(&id, "docker inspect --format '{{range $n, $c := .NetworkSettings.Networks}}{{$n}}{{end}}' wsp-live-net-a").await;
    show("the network the container joined", code, &bridge, &err);
    assert_eq!(code, 0);
    assert_eq!(bridge.trim(), format!("wsp-{id}"), "the container sits on the engine's default bridge");
    // The link the engine made for it wears the prefix every rule of the workspace table matches.
    let (_, named, _) =
        on_box(&["network", "inspect", "--format", "{{index .Options \"com.docker.network.bridge.name\"}}", &format!("wsp-{id}")]);
    let named = named.trim().to_owned();
    assert!(named.starts_with("wsp-e"), "the bridge is not under the prefix: {named}");
    let links: Vec<String> =
        fs::read_dir("/sys/class/net").unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(links.contains(&named), "the box holds no link {named}: {links:?}");
    // The rule that lets two containers of this workspace reach each other across it.
    let (_, ruleset, _) = nft_ruleset();
    assert!(ruleset.contains(&format!("engine bridge {named} of {id}")), "no rule for {named}:\n{ruleset}");

    // The box's cloud metadata, which is the box's.
    let (code, out, err) = w.exec(&id, "docker run --rm alpine wget -T 3 -q -O- http://169.254.169.254/ 2>&1").await;
    show("the metadata address from a container of the workspace", code, &out, &err);
    assert_ne!(code, 0, "a container of the workspace reached the box's metadata: {out}");
    // The box's own container on the engine's default bridge, which is a neighbour.
    let (code, out, err) = w.exec(&id, &format!("docker run --rm alpine ping -c 1 -W 3 {neighbour} 2>&1")).await;
    show("the box's own container from a container of the workspace", code, &out, &err);
    assert_ne!(code, 0, "a container of the workspace reached the box's own: {out}");
    // A sibling of the same workspace, by name on their own network.
    let (code, out, err) = w
        .exec(
            &id,
            &format!("docker run -d --name wsp-live-net-b --label {LIVE_LABEL}=1 alpine sh -c 'while true; do echo hello-from-sibling | nc -l -p 9000; done' 2>&1"),
        )
        .await;
    show("a second container of the same workspace", code, &out, &err);
    assert_eq!(code, 0, "{out}");
    let (code, out, err) = w.exec(&id, "sleep 1; docker run --rm alpine sh -c 'nc -w 3 wsp-live-net-b 9000' 2>&1").await;
    show("the sibling answered by name on the workspace's own network", code, &out, &err);
    assert!(out.contains("hello-from-sibling"), "{out}");

    w.close().await;
    let (_, ruleset, _) = nft_ruleset();
    assert!(!ruleset.contains(&format!("of {id}")), "an engine bridge rule stays after the workspace went:\n{ruleset}");
    let (_, outside_still, _) = on_box(&["inspect", "--format", "{{.State.Status}}", &outside]);
    assert_eq!(outside_still.trim(), "running", "the box's own container went with the workspace");
}

/// The box's whole ruleset as nft renders it, for the cases that read what this daemon wrote; empty where the
/// box carries no nft binary, which reads as a case that proves nothing rather than one that fails.
fn nft_ruleset() -> (i32, String, String) {
    match std::process::Command::new("nft").args(["list", "ruleset"]).output() {
        Ok(out) => (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ),
        Err(e) => panic!("this box has no nft to read its ruleset with: {e}"),
    }
}

/// The box at host.wsp.internal stays the reach the threat model names, less the ports its own daemon and its own
/// engine serve: a service the box binds on every address answers a workspace on a high port and on neither of
/// those. The drops are in our own chain at a lower priority, so they end the packet whatever accept a refusing
/// chain of the box's own carries at its head.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_daemons_own_port_and_the_engines_close_at_the_gateway() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let network = w.network(&id);
    // A high port on every address, which is the designed reach and stays one.
    let open = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let open_port = open.local_addr().unwrap().port();
    let heard = std::thread::spawn(move || accept_line(&open));
    let (code, _, err) = w.exec(&id, &format!("exec 3<>/dev/tcp/host.wsp.internal/{open_port} && echo hi from $(hostname) >&3")).await;
    assert_eq!((code, err.as_str()), (0, ""), "the gateway stopped answering a port nothing closes");
    assert_eq!(heard.join().unwrap().unwrap(), format!("hi from {id}"));
    // The ports this daemon and the box's engine serve, bound on every address as a service of the box's would
    // be: both closed at the gateway, whatever the box's own firewall says. The listener accepts nothing, since
    // the kernel completes the handshake by itself and a connect that returns is the packet having got through.
    for port in net::gateway_drops(numbers::DEFAULT_PORT) {
        let Ok(listener) = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)) else {
            eprintln!("this box already holds port {port}; that one is not read here");
            continue;
        };
        let (code, out, err) = w.exec(&id, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/host.wsp.internal/{port}'")).await;
        show(&format!("host.wsp.internal:{port} from inside"), code, &out, &err);
        assert_ne!(code, 0, "the gateway answered port {port}");
        drop(listener);
    }
    // The rules the box carries for this, read as a person reads them.
    let (_, ruleset, _) = nft_ruleset();
    for port in net::gateway_drops(numbers::DEFAULT_PORT) {
        assert!(ruleset.contains(&format!("gateway port {port}")), "no drop for {port}:\n{ruleset}");
    }
    // Every rule of ours matches the workspace interfaces by the prefix they all carry rather than one link by
    // its name, so what the ruleset names is that prefix and this workspace's own link is one of what it takes.
    assert!(ruleset.contains(&format!("iifname \"{}", net::LINK_PREFIX)), "no rule matches the workspace links:\n{ruleset}");
    assert!(network.link.starts_with(net::LINK_PREFIX), "the link {} sits outside the prefix the rules match", network.link);
    w.close().await;
}

/// A link the workspace planted in its own upper at the parent of a destination the next boot mounts: the wake is
/// refused in one sentence naming the path, and the folder the link pointed at on the box holds nothing and
/// carries no mount. The copy's destination stands for every destination here, since the boot opens each of them
/// through the one walk.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_link_planted_in_a_workspaces_own_upper_refuses_its_wake_and_lands_nothing_outside() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let key = checkout_key();
    let from = root().join("projects").join(format!("live-planted-{key}"));
    let _ = fs::remove_dir_all(&from);
    checkout(&from);
    // The folder the planted link points at: the case's own, under this suite's root and outside every rootfs.
    let outside = root().join(format!("live-outside-{key}"));
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir_all(&outside).unwrap();
    // A destination under /srv, so its parent is the workspace's own upper and a link there is the workspace's.
    let at = format!("/srv/planted-{key}/checkout");
    let id = w
        .create(spec(json!({
            "copy": { "from": from.display().to_string(), "at": &at },
            "idempotencyKey": format!("live-planted-{key}"),
        })))
        .await;
    let (code, out, _) = w.exec(&id, &format!("cat {at}/README.md")).await;
    assert_eq!((code, out.as_str()), (0, "the checkout\n"));

    // Asleep, its mounts down and its upper on the box's disk: the parent of the destination replaced by a link
    // out of the workspace, which is what a process inside can write there.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    let parent = root().join("run").join(&id).join("upper/srv").join(format!("planted-{key}"));
    fs::remove_dir_all(&parent).unwrap();
    std::os::unix::fs::symlink(&outside, &parent).unwrap();

    let refused = w.ask("machine.resume", json!({ "machineId": &id })).await;
    assert_eq!(refused["ok"], false, "the wake mounted through a link the workspace planted: {refused}");
    let said = refused["error"].as_str().unwrap_or_default();
    assert!(said.contains(&format!("/srv/planted-{key}")), "{said}");
    assert!(said.contains("replace the link with a folder and wake the workspace"), "{said}");
    // And nothing of the boot reached where the link pointed: no directory made, no copy, no mount.
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0, "the wake wrote where the link pointed");
    let table = fs::read_to_string("/proc/self/mountinfo").unwrap();
    assert!(!table.contains(&outside.display().to_string()), "the wake landed a mount where the link pointed");

    w.ok("machine.kill", json!({ "machineId": &id })).await;
    let _ = fs::remove_dir_all(&outside);
    let _ = fs::remove_dir_all(&from);
    w.close().await;
}

/// A link the box root keeps under the home every workspace here shares, which is a dotfiles checkout on a box
/// somebody works on: the boot follows it once, the share lands where it leads beneath the rootfs, and the box's
/// own disk carries nothing of it. The one case here that writes under the box's home, and it writes inside one
/// folder of this checkout's own that it removes at its end, never a bare name beside the person's own files.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_link_the_box_root_keeps_under_the_shared_home_lands_a_share_inside_the_workspace() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let key = checkout_key();
    let logins = root().join("logins/live-follow");
    fs::create_dir_all(&logins).unwrap();
    let source = logins.join("auth.json");
    fs::write(&source, b"{\"live\":\"a login\"}\n").unwrap();
    // The box root's own link, inside one folder of this checkout's own under that home, leading to a path the
    // workspace's own /var holds. The folder is what this case removes at its end, so the person's own home reads
    // as it did before the run.
    let proof = PathBuf::from(format!("/root/.wsp-live-follow-{key}"));
    let link = proof.join("dotfiles");
    let led = format!("/var/tmp/wsp-landed-{key}");
    let _ = fs::remove_dir_all(&proof);
    fs::create_dir_all(&proof).unwrap();
    std::os::unix::fs::symlink(&led, &link).unwrap();
    let id = w
        .create(spec(json!({
            "shares": [{ "source": source.display().to_string(), "target": format!("{}/auth.json", link.display()) }],
            "idempotencyKey": format!("live-follow-{key}"),
        })))
        .await;

    // Inside, the login reads at the path the tool looks at and at the path the link leads to, which are one file.
    let said = "{\"live\":\"a login\"}\n";
    let (code, out, err) = w.exec(&id, &format!("cat {}/auth.json; cat {led}/auth.json", link.display())).await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    assert_eq!(out, format!("{said}{said}"), "{out}");
    // And the box carries nothing of it: the follow landed beneath the rootfs, so the path the link leads to is
    // the workspace's own and the record names no mount point on the computer.
    assert!(!Path::new(&led).exists(), "the boot made the link's target on the box itself");
    let record: Value = serde_json::from_slice(&fs::read(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    assert_eq!(record["madePoints"].as_array().map(Vec::len).unwrap_or(0), 0, "{record}");

    w.ok("machine.kill", json!({ "machineId": &id })).await;
    assert!(!Path::new(&led).exists(), "the kill left the link's target on the box");
    fs::remove_dir_all(&proof).unwrap();
    let _ = fs::remove_dir_all(&logins);
    w.close().await;
}

/// What the box root's own login runs by name is the workspace's own copy of it: a line a workspace writes into
/// its `/root/.bashrc` is in that copy, the box's own file is byte for byte as it was, and a wake reads the line
/// still. The one write under the box's home is into the workspace's own copy, which is the rule this reads.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn the_rc_files_the_box_root_runs_are_the_workspaces_own_copies() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    let rc = Path::new("/root/.bashrc");
    let before = fs::read(rc).ok();
    let id = w.create(spec(json!({ "idempotencyKey": format!("live-rc-{}", checkout_key()) }))).await;

    // The copy the boot took reads inside as the box's file read out here at the first boot.
    let (code, out, err) = w.exec(&id, "cat /root/.bashrc").await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    assert_eq!(out.as_bytes(), before.clone().unwrap_or_default().as_slice(), "the copy inside is not the box's file");

    // A line written inside goes into that copy and nowhere else.
    let line = format!("# wsp-live-{}", checkout_key());
    let (code, _, err) = w.exec(&id, &format!("echo '{line}' >> /root/.bashrc")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    let (_, out, _) = w.exec(&id, "tail -1 /root/.bashrc").await;
    assert_eq!(out.trim(), line, "the workspace's own copy did not take the line");
    match &before {
        Some(held) => assert_eq!(fs::read(rc).ok().as_ref(), Some(held), "the write inside reached the box root's own rc file"),
        // A box that keeps no such file gains the empty file the cover lands on, and nothing is written into it.
        None => assert_eq!(fs::metadata(rc).unwrap().len(), 0, "the cover's mount point on the box is not empty"),
    }

    // And the copy is kept as the uppers are: the wake reads the line back and the box's file is still its own.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    let (_, out, _) = w.exec(&id, "tail -1 /root/.bashrc").await;
    assert_eq!(out.trim(), line, "the wake lost the workspace's own copy");
    if before.is_some() {
        assert_eq!(fs::read(rc).ok(), before, "the wake reached the box root's own rc file");
    }

    w.ok("machine.kill", json!({ "machineId": &id })).await;
    w.close().await;
}

/// What a workspace reads under /etc, /var and /srv is the list of what it needs: the accounts, the mounts, the
/// certificates and the package database read inside, apt installs to a cache of its own, and the box's own
/// service credentials are not there to read at all.
#[tokio::test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
async fn a_workspace_reads_the_etc_the_list_allows_and_none_of_the_boxs_own_credentials() {
    assert!(root_here(), "{LIVE_REASON}");
    let mut w = World::open().await;
    // A credential of the box's own, planted under a folder of this case's own and taken off at its end: a
    // workspace that could read it could answer as the box.
    let planted = PathBuf::from(format!("/srv/wsp-live-secret-{}", checkout_key()));
    let _ = fs::remove_dir_all(&planted);
    fs::create_dir_all(&planted).unwrap();
    fs::write(planted.join("key.pem"), b"the box's own key\n").unwrap();
    let id = w.create(spec(json!({ "idempotencyKey": format!("live-etc-{}", checkout_key()) }))).await;

    // What a tool inside reads is inside: the accounts, the mounts df reads through the link, the certificates
    // the boot's own list allows, and the names a shell resolves through.
    let (code, out, err) = w.exec(&id, "cat /etc/passwd > /dev/null; df > /dev/null; ls /etc/ssl/certs | wc -l; ls /etc/alternatives | wc -l; cat /etc/nsswitch.conf > /dev/null; echo read").await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    assert_eq!(out.lines().last(), Some("read"), "{out}");
    assert!(out.lines().next().unwrap().parse::<u32>().unwrap_or(0) > 0, "no certificate reads inside: {out}");

    // The package database the box lends, and a download written to a cache of the workspace's own: apt's own
    // exit is what says the cache took it, and the box's cache is not the one it wrote.
    let (code, out, err) = w.exec(&id, "dpkg -l | wc -l").await;
    assert_eq!(code, 0, "{err}");
    assert!(out.lines().next().unwrap().parse::<u32>().unwrap_or(0) > 10, "the package database does not read inside: {out}");
    let boxs_cache = fs::read_dir("/var/cache/apt/archives").map(|d| d.count()).unwrap_or(0);
    let (code, out, err) = w.exec(&id, "apt-get update -qq > /dev/null 2>&1; apt-get install -y --download-only hello; echo apt-$?").await;
    assert_eq!(code, 0, "{err}");
    assert_eq!(out.lines().last(), Some("apt-0"), "apt could not write its own cache: {out}");
    assert_eq!(
        fs::read_dir("/var/cache/apt/archives").map(|d| d.count()).unwrap_or(0),
        boxs_cache,
        "the download landed in the box's cache"
    );

    // And the box's own service credentials are not inside, whether the list left them out or the tree they sat
    // in is the workspace's own now.
    let kept = format!(
        "/etc/shadow /etc/gshadow /etc/ssl/private /etc/apt/auth.conf /etc/apt/auth.conf.d /var/lib/private /var/www {}",
        planted.display()
    );
    let (_, out, _) = w.exec(&id, &format!("for p in {kept}; do if [ -e \"$p\" ]; then echo \"reads $p\"; fi; done; echo done")).await;
    assert_eq!(out.trim(), "done", "the workspace reads what the box keeps for itself: {out}");
    // The one on the box is still there, so the case read the fence and not a folder that was never made.
    assert!(planted.join("key.pem").is_file());
    // The tools a workspace runs still answer, which is the read that says the list broke nothing.
    let (code, out, err) = w.exec(&id, "git --version && python3 --version && node --version").await;
    assert_eq!((code, err.as_str()), (0, ""), "a tool inside stopped answering: {err}");
    assert_eq!(out.lines().count(), 3, "{out}");

    w.ok("machine.kill", json!({ "machineId": &id })).await;
    let _ = fs::remove_dir_all(&planted);
    w.close().await;
}
