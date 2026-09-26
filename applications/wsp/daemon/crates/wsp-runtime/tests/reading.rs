// SPDX-License-Identifier: AGPL-3.0-only
//! One workspace's reading: what the frame carries about a workspace on this computer, and the two readings under
//! it that are taken from the kernel rather than from the record. Nothing here makes a container, so it runs
//! wherever the crate builds: the cgroup figures of a workspace that is actually running are the live suite's.
#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::fs;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use wsp_frames::RequestId;
use wsp_runtime::bundle::{self, Init, Layout, Workspace};
use wsp_runtime::freeze;
use wsp_runtime::net::Network;
use wsp_runtime::ops::{Ops, WSP_LABEL};
use wsp_runtime::runtime;

/// A record on disk under the layout, with the init a caller names: the ops read what is written there, so a
/// reading can be driven without a container.
fn recorded(layout: &Layout, id: &str, init: Init) {
    let record = Workspace {
        id: id.to_owned(),
        hostname: id.to_owned(),
        labels: BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]),
        envs: BTreeMap::new(),
        cpu: Some(1.0),
        mem_mb: Some(2048),
        created_at: "2026-09-14T00:00:00.000Z".to_owned(),
        init,
        engine: false,
        copy: None,
        shares: Vec::new(),
        binds: Vec::new(),
        made_points: Vec::new(),
    };
    fs::create_dir_all(layout.upper(id)).unwrap();
    bundle::write_json(&layout.record(id), &record).unwrap();
}

async fn metrics(ops: &Ops, id: &str) -> Value {
    let frame = json!({ "id": 1, "op": "machine.metrics", "machineId": id });
    serde_json::from_str(&ops.answer(Some(RequestId::from(1)), &frame).await).unwrap()
}

#[tokio::test]
async fn a_reading_carries_the_sizes_and_the_paths_always_and_the_live_figures_only_where_they_can_be_read() {
    let dir = tempfile::tempdir().unwrap();
    let ops = Ops::open(dir.path(), PathBuf::from("/bin/true"), 0).unwrap();
    let layout = Layout::new(dir.path());
    // A workspace whose init is not the process its record names: stopped, with its saved layer still there.
    recorded(&layout, "wsp-stopped", Init { pid: 1, started: 1, boot_id: "not-this-boot".to_owned() });
    let network = Network {
        link: "wsp-1".to_owned(),
        address: Ipv4Addr::new(10, 65, 0, 6),
        gateway: Ipv4Addr::new(10, 65, 0, 5),
        prefix: 30,
        forwards: BTreeMap::new(),
    };
    bundle::write_json(&layout.net("wsp-stopped"), &network).unwrap();
    assert_eq!(
        metrics(&ops, "wsp-stopped").await,
        json!({
            "id": 1,
            "ok": true,
            "reading": {
                "state": "paused",
                "cpu": 1.0,
                "memMb": 2048,
                "address": "10.65.0.6",
                "cgroup": "/sys/fs/cgroup/wsp/wsp-stopped",
                "upper": dir.path().join("run/wsp-stopped/upper").to_string_lossy(),
            }
        })
    );

    // A workspace whose init is a live process, with no cgroup of its own on this box: the uptime is read off the
    // same clock the record's start time counts on, and every figure the cgroup would give is left out rather than
    // taking the whole reading down with it.
    let own = runtime::identity_of(std::process::id() as i32).unwrap();
    recorded(&layout, "wsp-live", own);
    let live = metrics(&ops, "wsp-live").await;
    let reading = &live["reading"];
    assert_eq!(reading["state"], "gone", "a live init youki has no state for reads gone: {reading}");
    assert!(reading["uptimeMs"].as_u64().unwrap() < 24 * 60 * 60 * 1000, "{reading}");
    for figure in ["memBytes", "cpuUsageUsec", "procs", "address"] {
        assert!(reading.get(figure).is_none(), "{figure} in {reading}");
    }
    assert_eq!(reading["cgroup"], "/sys/fs/cgroup/wsp/wsp-live");

    // A workspace this computer does not hold is missing, on this op as on every other that names one.
    let gone = metrics(&ops, "wsp-nowhere").await;
    assert_eq!(gone, json!({ "id": 1, "ok": false, "error": "no such workspace: wsp-nowhere", "kind": "missing", "status": 404 }));
}

#[test]
fn the_process_count_is_the_cgroup_and_every_cgroup_under_it() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("cgroup.procs"), "101\n102\n").unwrap();
    assert_eq!(freeze::pids_in(dir.path()).unwrap(), 2);
    // What a container engine inside a workspace makes: its containers hold their processes in cgroups of their
    // own, and a count of the top one alone would read a busy workspace as holding two processes.
    let nested = dir.path().join("engine").join("container");
    fs::create_dir_all(&nested).unwrap();
    fs::write(dir.path().join("engine").join("cgroup.procs"), "").unwrap();
    fs::write(nested.join("cgroup.procs"), "201\n202\n203\n").unwrap();
    assert_eq!(freeze::pids_in(dir.path()).unwrap(), 5);
    assert!(freeze::pids_in(&dir.path().join("no-such-cgroup")).is_err());
}

#[test]
fn an_uptime_is_the_boxs_own_clock_less_the_start_time_the_record_holds() {
    let own = runtime::identity_of(std::process::id() as i32).unwrap();
    let booted: f64 = fs::read_to_string(Path::new("/proc/uptime")).unwrap().split_whitespace().next().unwrap().parse().unwrap();
    // This process started after the box did and is still running, so its uptime is inside the box's own.
    assert!(runtime::uptime_ms(&own).unwrap() <= (booted * 1000.0) as u64);
    // A record whose start time is later than the box has been up reads zero rather than a number that wrapped.
    assert_eq!(runtime::uptime_ms(&Init { started: own.started + 100_000_000, ..own }).unwrap(), 0);
}
