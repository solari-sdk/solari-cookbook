// SPDX-License-Identifier: AGPL-3.0-only
//! The wsp command on the computer the host runs on. A `wsp mcp` line is served by the host that is already
//! running rather than by a process of its own: the wsp this forwarder was handed says where that host is and what
//! its token is, and the session opens on the host's own socket, one hop shorter than a machine's. Every other
//! line, and a `wsp mcp` line with no host serving it, is that wsp run as it was typed, which is what answers it
//! in every word. Nothing here reads a verb, a flag or a state file: the host's command line does all of that.

use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::Command;
use wsp_frames::{words, GuestKind};

use crate::mcp::{self, Carry, End};
use crate::{authed, open, Streams, MCP_WORD, REFUSED};

/// The variable the one wsp asked where the host is carries, with the two asks: a host already serving, and one
/// brought up first as a verb would. The host's command line reads the same name.
const FORWARD_ENV: &str = "WSP_FORWARD";
const ASK_DOOR: &str = "door";
const ASK_START: &str = "start";

/// The JSON-RPC code a request is answered with when the host went before answering it: an internal error, since
/// nothing the harness sent was wrong.
const HOST_WENT_CODE: i64 = -32603;

/// What a forwarded line comes to: the code this process exits with, or the line run as the wsp it was handed.
#[derive(Debug, PartialEq, Eq)]
pub enum Forwarded {
    Exit(i32),
    Run,
}

/// Where the host is, as the wsp that was asked answered.
struct Door {
    url: String,
    token: String,
}

/// Runs one line on this process's own streams; a line it does not serve replaces this process with the wsp it
/// was handed, so what the person reads and the code they get are that wsp's own.
pub fn run_here(line: &[String], wsp: &[String]) -> i32 {
    let Some((program, args)) = wsp.split_first() else {
        eprintln!("wsp: no command to run");
        return REFUSED;
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("{e}");
            return REFUSED;
        }
    };
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let mut input = BufReader::new(tokio::io::stdin());
    let mut out = tokio::io::stdout();
    let mut err = tokio::io::stderr();
    let mut streams = Streams { input: &mut input, out: &mut out, err: &mut err };
    match runtime.block_on(forward(line, wsp, &vars, &mut streams)) {
        Forwarded::Exit(code) => code,
        Forwarded::Run => {
            drop(runtime);
            use std::os::unix::process::CommandExt;
            let e = std::process::Command::new(program).args(args).args(line).exec();
            eprintln!("wsp: {program}: {e}");
            REFUSED
        }
    }
}

/// One line start to end. `vars` is the environment the line was typed in, handed in rather than read so a case
/// says what the host is told; the cwd is this process's, which is the folder the line was typed in.
pub async fn forward(line: &[String], wsp: &[String], vars: &[(String, String)], streams: &mut Streams<'_>) -> Forwarded {
    if line.first().map(String::as_str) != Some(MCP_WORD) {
        return Forwarded::Run;
    }
    let Some(door) = asked(line, wsp, ASK_DOOR).await else { return Forwarded::Run };
    let env = |name: &str| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    let Some(mut ws) = authed(&door.url, &door.token).await else { return Forwarded::Run };
    if open(&mut ws, GuestKind::Mcp, line, &env, Some(vars)).await.is_err() {
        return Forwarded::Run;
    }
    let mut carry = Carry::default();
    loop {
        if let End::Code(code) = mcp::pump(&mut ws, streams, &mut carry).await {
            return Forwarded::Exit(code);
        }
        // The host went: every request it was answering is told so, and the next message the harness sends is
        // what dials again, as the command line's own tool server dials again at the next call. Asked with start,
        // so a host that is gone for good is brought up exactly as that call would bring it up.
        answer_pending(&mut carry, streams).await;
        loop {
            let Some(sent) = carry.next_line(streams).await else { return Forwarded::Exit(0) };
            carry.keep(sent);
            if let Some(again) = reopened(line, wsp, vars, &env, &mut carry).await {
                ws = again;
                break;
            }
            // Nobody took it: a request among what is kept is answered as one the host went on, and a notice is
            // dropped, as it would have been by a server that was not there.
            carry.fail_unsent();
            answer_pending(&mut carry, streams).await;
        }
    }
}

/// A session on the host again, greeted as the last one was, with whatever the last socket never took sent after.
async fn reopened(
    line: &[String],
    wsp: &[String],
    vars: &[(String, String)],
    env: &dyn Fn(&str) -> Option<String>,
    carry: &mut Carry,
) -> Option<crate::Socket<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>> {
    let door = asked(line, wsp, ASK_START).await?;
    let mut ws = authed(&door.url, &door.token).await?;
    open(&mut ws, GuestKind::Mcp, line, env, Some(vars)).await.ok()?;
    carry.greet(&mut ws).await.then_some(ws)
}

/// Every request still waiting, answered with the error a host that went leaves it.
async fn answer_pending(carry: &mut Carry, streams: &mut Streams<'_>) {
    for id in carry.take_pending() {
        let answer = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": HOST_WENT_CODE, "message": words::HOST_CLOSED } });
        let _ = streams.out.write_all(format!("{answer}\n").as_bytes()).await;
    }
    let _ = streams.out.flush().await;
}

/// The wsp this forwarder was handed, asked where the host serving this line is. Its stderr is this process's, so
/// a line it says there (the host it brought up) reaches the person; its stdout is the answer and nothing else.
async fn asked(line: &[String], wsp: &[String], ask: &str) -> Option<Door> {
    let (program, args) = wsp.split_first()?;
    let ran = Command::new(program)
        .args(args)
        .args(line)
        .env(FORWARD_ENV, ask)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .output()
        .await
        .ok()?;
    let said: Value = serde_json::from_slice(&ran.stdout).ok()?;
    Some(Door { url: said.get("url")?.as_str()?.to_owned(), token: said.get("token")?.as_str()?.to_owned() })
}
