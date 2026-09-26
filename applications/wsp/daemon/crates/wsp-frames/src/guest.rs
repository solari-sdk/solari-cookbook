// SPDX-License-Identifier: AGPL-3.0-only
//! The guest road: a process inside a machine runs the wsp command line or the wsp tool server by opening a
//! session on its own daemon, which carries the session up the socket the host already holds to it. The daemon
//! relays and reads nothing of what rides here; the token is the thread's and only the host reads it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a guest session carries: the tool server's JSON-RPC messages, or one command line and its streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum GuestKind {
    Mcp,
    Cli,
}

/// The reply to guest.open: the id both sides name the session by. Every other guest op answers the empty ok.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GuestOpenReply {
    pub session: String,
}

/// What a guest process asks for when it opens a session, as the daemon hands it to its own table.
#[derive(Debug, Clone, PartialEq)]
pub struct GuestOpen {
    pub kind: GuestKind,
    pub token: String,
    pub turn_token: Option<String>,
    pub argv: Vec<String>,
    pub cwd: String,
}

/// Which of the two streams a command line's text belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum GuestStream {
    Out,
    Err,
}

/// What a cli session's messages carry: text for one of the two streams, then the code the line ended with. The
/// tool server's messages are the harness's own JSON-RPC and have no shape of ours.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(untagged)]
pub enum GuestCliMessage {
    Text { stream: GuestStream, text: String },
    Exit { exit: i32 },
}
