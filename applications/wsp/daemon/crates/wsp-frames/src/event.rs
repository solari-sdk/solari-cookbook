// SPDX-License-Identifier: AGPL-3.0-only
use serde::{Deserialize, Serialize, Serializer};
use ts_rs::TS;

use crate::validate::http_url;
use crate::{GuestKind, PtyMode, RelayPort};

/// A reading is a number on the wire or nothing: serde_json writes a NaN or an infinity as null, which the
/// protocol's number schema refuses, so a reading that is not finite travels as zero.
fn finite<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(if value.is_finite() { *value } else { 0.0 })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Usage {
    pub used: u64,
    pub total: u64,
}

/// One process as /proc/[pid] shows it. cpu is its busy share of one core over the interval; rss in bytes;
/// startedAt epoch milliseconds; pty names the daemon pty whose shell this is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub state: String,
    pub comm: String,
    pub cmdline: String,
    #[serde(serialize_with = "finite")]
    pub cpu: f64,
    pub rss: u64,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pty: Option<String>,
}

/// Every frame the daemon pushes without being asked, keyed on `type` as the zod union is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type")]
pub enum DaemonEvent {
    /// The first frame after the auth reply: root is the directory every fs and git path resolves inside.
    #[serde(rename = "daemon.hello")]
    DaemonHello {
        root: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        version: Option<u32>,
    },
    #[serde(rename = "pty.data", rename_all = "camelCase")]
    PtyData { pty_id: String, data: String },
    #[serde(rename = "pty.exit", rename_all = "camelCase")]
    PtyExit {
        pty_id: String,
        exit_code: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        signal: Option<i32>,
    },
    #[serde(rename = "port.open")]
    PortOpen {
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pid: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        process: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        loopback: Option<bool>,
    },
    #[serde(rename = "port.close")]
    PortClose {
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pid: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        process: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        command: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        exited: Option<bool>,
        /// When the close was seen, as the node daemon stamps it: an ISO date, never a number.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        at: Option<String>,
    },
    #[serde(rename = "inbox.file")]
    InboxFile { path: String, bytes: u64 },
    #[serde(rename = "pty.mode", rename_all = "camelCase")]
    PtyMode { pty_id: String, mode: PtyMode, echo: bool, foreground: String },
    #[serde(rename = "browser.open")]
    BrowserOpen {
        #[serde(deserialize_with = "http_url")]
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        port: Option<RelayPort>,
    },
    #[serde(rename = "callback.port")]
    CallbackPort { port: RelayPort },
    #[serde(rename = "tunnel.data", rename_all = "camelCase")]
    TunnelData { tunnel_id: String, data: String },
    #[serde(rename = "tunnel.end", rename_all = "camelCase")]
    TunnelEnd { tunnel_id: String },
    #[serde(rename = "localhost.url")]
    LocalhostUrl { port: RelayPort },
    #[serde(rename = "sys.sample")]
    SysSample {
        #[serde(serialize_with = "finite")]
        cpu: f64,
        #[serde(serialize_with = "finite")]
        load1: f64,
        mem: Usage,
        disk: Usage,
        at: i64,
    },
    #[serde(rename = "proc.snapshot")]
    ProcSnapshot { at: i64, daemon: u32, total: u64, procs: Vec<ProcEntry> },
    /// A process inside the machine opened a session; this one goes up to the watcher alone.
    #[serde(rename = "guest.opened", rename_all = "camelCase")]
    GuestOpened {
        session: String,
        /// The workspace the session was opened inside, on a daemon that runs workspaces: the listener the frame
        /// arrived on is what names it, never anything the guest said. Absent on a daemon inside a machine, where
        /// the machine is the one the host dialled.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
        /// The run of the daemon that named this session. Session names start from the beginning on every run, so
        /// this and the name together are what a host tells a session it already holds from a session of the same
        /// name on a machine that was rebuilt under it.
        life: String,
        kind: GuestKind,
        token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        turn_token: Option<String>,
        argv: Vec<String>,
        cwd: String,
    },
    /// One message on a session, travelling either way: a guest's up to the watcher, the host's answer back down.
    /// The workspace is the opened frame's, as on every frame a place daemon relays for a session.
    #[serde(rename = "guest.message", rename_all = "camelCase")]
    GuestMessage {
        session: String,
        #[ts(type = "unknown")]
        message: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// The session ended; this goes to whichever side did not end it.
    #[serde(rename = "guest.closed", rename_all = "camelCase")]
    GuestClosed {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn a_reading_that_is_not_finite_travels_as_zero_never_as_null() {
        assert_eq!(serde_json::to_value(f64::NAN).unwrap(), Value::Null);
        let sample = DaemonEvent::SysSample {
            cpu: f64::NAN,
            load1: f64::INFINITY,
            mem: Usage { used: 1, total: 2 },
            disk: Usage { used: 3, total: 4 },
            at: 5,
        };
        let wire = serde_json::to_value(&sample).unwrap();
        assert_eq!(wire["cpu"], json!(0.0));
        assert_eq!(wire["load1"], json!(0.0));
        let proc_entry = ProcEntry {
            pid: 1,
            ppid: 0,
            user: "root".into(),
            state: "S".into(),
            comm: "init".into(),
            cmdline: String::new(),
            cpu: f64::NEG_INFINITY,
            rss: 0,
            started_at: 0,
            pty: None,
        };
        assert_eq!(serde_json::to_value(&proc_entry).unwrap()["cpu"], json!(0.0));
        let fine =
            DaemonEvent::SysSample { cpu: 12.5, load1: 0.42, mem: Usage { used: 1, total: 2 }, disk: Usage { used: 3, total: 4 }, at: 5 };
        assert_eq!(serde_json::to_value(&fine).unwrap()["cpu"], json!(12.5));
    }
}
