// SPDX-License-Identifier: AGPL-3.0-only
//! Tunnels: a laptop connection carried over the socket to a port on this machine's loopback, one TCP stream per
//! tunnel id, its bytes as base64 frames each way.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use wsp_frames::{numbers, DaemonErrorCode, DaemonEvent};

use crate::ops::Conn;
use crate::paths::OpError;

type Writes = mpsc::UnboundedSender<Vec<u8>>;

/// The tunnels one socket holds open; they die with it.
#[derive(Default)]
pub(crate) struct Tunnels {
    open: Mutex<HashMap<String, (u64, Writes)>>,
    generation: std::sync::atomic::AtomicU64,
}

fn lock(map: &Mutex<HashMap<String, (u64, Writes)>>) -> std::sync::MutexGuard<'_, HashMap<String, (u64, Writes)>> {
    map.lock().unwrap_or_else(|e| e.into_inner())
}

/// 127.0.0.1 first, then ::1: a Node 22 tool listening on "localhost" binds [::1] only (measured, wrangler).
async fn connect_loopback(port: u16) -> Result<TcpStream, String> {
    if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)).await {
        return Ok(stream);
    }
    TcpStream::connect(("::1", port)).await.map_err(|e| dial_error("::1", port, &e))
}

/// The sentence node's net module gives a failed dial, so a client that matched on it reads the same words.
fn dial_error(host: &str, port: u16, e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::ConnectionRefused => format!("connect ECONNREFUSED {host}:{port}"),
        io::ErrorKind::TimedOut => format!("connect ETIMEDOUT {host}:{port}"),
        _ => format!("connect {host}:{port}: {e}"),
    }
}

/// The id is taken, or the socket holds the cap: checked before the dial, so nothing is dialled for nothing, and
/// again where the entry is made, so the rule holds whatever ran while the dial was out.
fn room_for(map: &HashMap<String, (u64, Writes)>, tunnel_id: &str) -> Result<(), OpError> {
    if map.contains_key(tunnel_id) {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, format!("tunnel {tunnel_id} is already open")));
    }
    if map.len() >= numbers::TUNNEL_CAP {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, format!("too many tunnels open ({})", numbers::TUNNEL_CAP)));
    }
    Ok(())
}

impl Tunnels {
    /// Dials the port and starts the pump; refused by name when the id is taken or the socket holds the cap.
    pub(crate) async fn open(conn: &Arc<Conn>, tunnel_id: String, port: u16) -> Result<(), OpError> {
        room_for(&lock(&conn.tunnels.open), &tunnel_id)?;
        let stream = connect_loopback(port).await.map_err(OpError::plain)?;
        if conn.is_closed() {
            return Err(OpError::plain("client went away while the guest port was dialled"));
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let generation = conn.tunnels.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut map = lock(&conn.tunnels.open);
            room_for(&map, &tunnel_id)?;
            map.insert(tunnel_id.clone(), (generation, tx));
        }
        tokio::spawn(pump(Arc::clone(conn), tunnel_id, generation, stream, rx));
        Ok(())
    }

    pub(crate) fn write(&self, tunnel_id: &str, bytes: Vec<u8>) -> Result<(), OpError> {
        let map = lock(&self.open);
        let Some((_, writes)) = map.get(tunnel_id) else {
            return Err(OpError::coded(DaemonErrorCode::NotFound, format!("no such tunnel: {tunnel_id}")));
        };
        // Two writes on one socket keep their order because each frame's task reaches this send with no await before
        // it and the runtime runs on one thread; an await on that road, or a multi-thread runtime, would reorder bytes.
        // A pump that already ended drops the bytes, as a write to a closed socket did under node.
        let _ = writes.send(bytes);
        Ok(())
    }

    /// Ends the tunnel; the pump says tunnel.end once the stream is down, as node's close event did.
    pub(crate) fn close(&self, tunnel_id: &str) {
        lock(&self.open).remove(tunnel_id);
    }

    pub(crate) fn close_all(&self) {
        lock(&self.open).clear();
    }
}

/// Bytes from the port to the socket as tunnel.data, bytes from the socket to the port, until either side ends or
/// the tunnel is closed; then the entry goes, if it is still this pump's, and tunnel.end is said.
async fn pump(conn: Arc<Conn>, tunnel_id: String, generation: u64, stream: TcpStream, mut writes: mpsc::UnboundedReceiver<Vec<u8>>) {
    let (mut reader, mut writer) = stream.into_split();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if !conn.out.send_event(&DaemonEvent::TunnelData { tunnel_id: tunnel_id.clone(), data }) {
                        break;
                    }
                }
            },
            bytes = writes.recv() => match bytes {
                Some(bytes) => {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
        }
    }
    {
        let mut map = lock(&conn.tunnels.open);
        if map.get(&tunnel_id).is_some_and(|(g, _)| *g == generation) {
            map.remove(&tunnel_id);
        }
    }
    conn.out.send_event(&DaemonEvent::TunnelEnd { tunnel_id });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_refused_dial_is_named_as_node_names_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let err = connect_loopback(port).await.expect_err("nothing listens there");
        assert_eq!(err, format!("connect ECONNREFUSED ::1:{port}"));
    }

    #[tokio::test]
    async fn the_dial_tries_127_0_0_1_then_1() {
        let v6 = tokio::net::TcpListener::bind("[::1]:0").await.unwrap();
        let port = v6.local_addr().unwrap().port();
        let stream = connect_loopback(port).await.unwrap();
        assert!(stream.peer_addr().unwrap().ip().is_ipv6());
    }
}
