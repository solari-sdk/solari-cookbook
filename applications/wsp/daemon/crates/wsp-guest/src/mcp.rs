// SPDX-License-Identifier: AGPL-3.0-only
//! The tool server kind: this process is the stdio a harness speaks JSON-RPC over, and every line either way is one
//! message on the session. Nothing here gives a message meaning: the harness on one end and the host's own server on
//! the other do. What is read is only what a session opened again needs, which requests are still waiting and how
//! the harness greeted the server, and the host's messages are written out as the host wrote them.

use std::collections::BTreeMap;

use futures_util::SinkExt;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

use crate::{closed, next_text, Socket, Streams, OPEN_ID};

/// The method a harness greets a server with, and the notice it sends once that is answered.
const INITIALIZE: &str = "initialize";
const INITIALIZED: &str = "notifications/initialized";

/// What a tool server session keeps whichever socket carries it: the bytes of a line not yet whole, the harness's
/// requests still waiting on an answer, the messages a socket that went never took, and the greeting, which a
/// session opened again is given first so the server there has met the harness this one already met.
#[derive(Default)]
pub(crate) struct Carry {
    held: Vec<u8>,
    next_id: u64,
    pending: Vec<Value>,
    unsent: Vec<Value>,
    greeting: Vec<Value>,
    /// The id of a greeting said again, whose answer the harness already had and is not given twice.
    swallow: Option<Value>,
}

impl Carry {
    /// The next whole line the harness wrote, parsed; lines that are not JSON are dropped as a stdio transport drops
    /// them. None once the harness has closed its end.
    pub(crate) async fn next_line(&mut self, streams: &mut Streams<'_>) -> Option<Value> {
        loop {
            if let Some(at) = self.held.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.held.drain(..=at).collect();
                match serde_json::from_slice::<Value>(&line) {
                    Ok(read) => return Some(read),
                    Err(_) => continue,
                }
            }
            let taken = match streams.input.fill_buf().await {
                Ok(chunk) if !chunk.is_empty() => {
                    self.held.extend_from_slice(chunk);
                    chunk.len()
                }
                _ => return None,
            };
            streams.input.consume(taken);
        }
    }

    /// Sends one of the harness's messages, noting what a session opened again would need of it; false where the
    /// socket would not take it, which the caller keeps it for.
    pub(crate) async fn send<S: AsyncRead + AsyncWrite + Unpin>(&mut self, ws: &mut Socket<S>, sent: &Value) -> bool {
        self.next_id += 1;
        let frame = json!({ "id": self.next_id + OPEN_ID, "op": "guest.send", "message": sent });
        if ws.send(Message::text(frame.to_string())).await.is_err() {
            return false;
        }
        match sent.get("method").and_then(Value::as_str) {
            Some(INITIALIZE) => self.greeting = vec![sent.clone()],
            Some(INITIALIZED) => self.greeting.push(sent.clone()),
            _ => {}
        }
        if let (Some(_), Some(id)) = (sent.get("method"), sent.get("id")) {
            self.pending.push(id.clone());
        }
        true
    }

    /// Gives up on what no socket took: each request among it waits for the answer a host that went leaves.
    pub(crate) fn fail_unsent(&mut self) {
        for message in std::mem::take(&mut self.unsent) {
            if let (Some(_), Some(id)) = (message.get("method"), message.get("id")) {
                self.pending.push(id.clone());
            }
        }
    }

    /// Keeps a message no socket took, to go after the greeting on the next session.
    pub(crate) fn keep(&mut self, message: Value) {
        self.unsent.push(message);
    }

    /// The requests still waiting, taken off the list, less a greeting said again that the harness had answered
    /// long ago.
    pub(crate) fn take_pending(&mut self) -> Vec<Value> {
        let again = self.swallow.take();
        std::mem::take(&mut self.pending).into_iter().filter(|id| Some(id) != again.as_ref()).collect()
    }

    /// Says the greeting again on a session just opened, then whatever the last socket never took; false where
    /// this socket went too, with what it did not take still kept.
    pub(crate) async fn greet<S: AsyncRead + AsyncWrite + Unpin>(&mut self, ws: &mut Socket<S>) -> bool {
        self.swallow = self.greeting.first().and_then(|g| g.get("id")).cloned();
        for message in self.greeting.clone() {
            if !self.send(ws, &message).await {
                return false;
            }
        }
        let mut unsent = std::mem::take(&mut self.unsent).into_iter();
        while let Some(message) = unsent.next() {
            if !self.send(ws, &message).await {
                self.unsent = std::iter::once(message).chain(unsent).collect();
                return false;
            }
        }
        true
    }

    /// Whether a message from the server goes on to the harness: every one does but the answer to a greeting said
    /// again. An answer takes its request off the waiting list either way.
    fn passes(&mut self, message: &Value) -> bool {
        if message.get("method").is_some() {
            return true;
        }
        let Some(id) = message.get("id") else { return true };
        self.pending.retain(|waiting| waiting != id);
        if self.swallow.as_ref() == Some(id) {
            self.swallow = None;
            return false;
        }
        true
    }
}

/// How a pump ended: with the code this process exits with, or with the socket gone and the harness still there.
pub(crate) enum End {
    Code(i32),
    Lost,
}

pub(crate) async fn pump<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut Socket<S>, streams: &mut Streams<'_>, carry: &mut Carry) -> End {
    loop {
        tokio::select! {
            // A pending read is cancelled when a frame wins; the half line it took stays in the carry.
            read = carry.next_line(streams) => {
                let Some(sent) = read else { return End::Code(0) };
                if !carry.send(ws, &sent).await {
                    carry.keep(sent);
                    return End::Lost;
                }
            }
            text = next_text(ws) => {
                let Some(text) = text else { return End::Lost };
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(code) = closed(&frame, streams).await {
                    return End::Code(code);
                }
                // A send the wire refused (a message past the cap) is a reply and not an event: the harness gets no
                // answer to that one request, and the person reading the thread gets the reason.
                if frame.get("ok") == Some(&Value::Bool(false)) {
                    let said = frame.get("error").and_then(Value::as_str).unwrap_or("the message was refused").to_owned();
                    let _ = streams.err.write_all(format!("{said}\n").as_bytes()).await;
                    let _ = streams.err.flush().await;
                    continue;
                }
                if frame.get("type").and_then(Value::as_str) != Some("guest.message") {
                    continue;
                }
                let Some(raw) = serde_json::from_str::<BTreeMap<String, Box<RawValue>>>(&text).ok().and_then(|mut f| f.remove("message")) else { continue };
                if let Some(message) = frame.get("message") {
                    if !carry.passes(message) {
                        continue;
                    }
                }
                // One message, one line, as a stdio transport reads them, in the bytes the server wrote it in.
                let written = format!("{}\n", raw.get());
                if streams.out.write_all(written.as_bytes()).await.is_err() || streams.out.flush().await.is_err() {
                    return End::Code(1);
                }
            }
        }
    }
}
