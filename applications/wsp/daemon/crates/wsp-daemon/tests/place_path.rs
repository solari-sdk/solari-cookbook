// SPDX-License-Identifier: AGPL-3.0-only
//! What a place daemon resolves a command through. A computer that runs workspaces binds their home in read-write,
//! so a directory under it is a directory a process inside a workspace writes: the daemon sets its own PATH to the
//! probe list before anything of it exists, and every child it starts inherits that and no other list. One case in
//! a binary of its own, since the PATH it reads is the process's and another daemon binding beside it would be
//! writing the same variable.

use std::io::Write;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use wsp_daemon::{Daemon, Options};
use wsp_frames::{place_daemon_paths, probe_path};

const TOKEN: &str = "probe-path-token";

/// A daemon on the loopback under a fresh home, a place where a place file is written for it.
async fn start(home: &std::path::Path, place: bool) -> (u16, tempfile::NamedTempFile) {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(home.to_path_buf());
    options.home = Some(home.to_path_buf());
    options.manifest_path = Some(home.join("manifest.json"));
    if place {
        let at = place_daemon_paths(home);
        std::fs::create_dir_all(&at.wsp).unwrap();
        // No address it can reach: the link dials, finds nothing and waits, which is all this case needs of it.
        let file = json!({
            "placeId": "p_ab12cd34", "name": "old-macbook", "hostName": "h", "hostUrls": ["http://127.0.0.1:1"],
            "hostPublicKey": "k", "keyPath": at.place_key, "joinedAt": "1970-01-01T00:00:00.000Z",
        });
        std::fs::write(&at.place_file, format!("{file}\n")).unwrap();
        options.place_file = Some(at.place_file);
        options.runtime_root = Some(home.join("runtime"));
    }
    let daemon = Daemon::bind_with(options, Box::new(|_| {})).await.unwrap();
    let port = daemon.local_addr().port();
    tokio::spawn(daemon.run());
    (port, token)
}

/// One exec through the daemon's own door, with the auth frame first as every socket sends it.
async fn exec(port: u16, cmd: &str) -> Value {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
    ws.send(Message::text(json!({"id": 1, "op": "auth", "token": TOKEN}).to_string())).await.unwrap();
    ws.send(Message::text(json!({"id": 2, "op": "exec", "cmd": cmd, "timeoutMs": 10_000}).to_string())).await.unwrap();
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(until, ws.next()).await {
        let Message::Text(text) = msg else { continue };
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["id"] == json!(2) {
            return frame;
        }
    }
    panic!("the daemon answered no exec in ten seconds")
}

#[tokio::test]
async fn a_place_daemon_runs_every_command_it_starts_through_the_probe_list() {
    let was = std::env::var("PATH").unwrap_or_default();
    // A daemon inside a machine shares its home with nobody, so nothing of its PATH moves.
    let cloud = tempfile::tempdir().unwrap();
    let (cloud_port, _cloud_token) = start(cloud.path(), false).await;
    assert_eq!(std::env::var("PATH").unwrap_or_default(), was);
    assert_eq!(exec(cloud_port, r#"printf %s "$PATH""#).await["stdout"], json!(was));

    // A place shares its home with every workspace it boots, so its own PATH becomes the probe list before a
    // single child of it could exist, and the exec handler's bash, the git reads and every pty inherit it.
    let home = tempfile::tempdir().unwrap();
    let (port, _token) = start(home.path(), true).await;
    let probe = probe_path(home.path());
    assert_ne!(probe, was, "the case says nothing where the two lists are already one");
    assert_eq!(std::env::var("PATH").unwrap_or_default(), probe);
    assert_eq!(exec(port, r#"printf %s "$PATH""#).await["stdout"], json!(probe));
}
