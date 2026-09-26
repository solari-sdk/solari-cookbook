// SPDX-License-Identifier: AGPL-3.0-only
//! The outbound half of a place: this computer dials its host instead of listening for it, proves who it is with
//! the ed25519 key the host learned at join, and then hands that one socket to the same loop an inbound one gets.
//! Nothing here opens a port. The bytes both sides sign come from the protocol's transcript, so this file holds
//! the place's half of the handshake and no rule of its own about how it is spelled.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout_at, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_frames::{
    is_http_url, numbers, place_link_transcript, place_refusal_transcript, words, Base64Bytes, LinkEphemerals, LinkRole, PlaceAuthRefusal,
    PlaceAuthReply, PlaceAuthRequest, PlaceEphemeral, PlaceFile, PlaceNonce, PlaceProveRequest, PlacePublicKey, PlaceSignature, RequestId,
};

use crate::door::{self, Ended};
use crate::ops::{Conn, Road};
use crate::place::{self, AgentBin, AgentVersions, ReportInput};
use crate::seal::{self, Seal};
use crate::{Ctx, Outbound};

/// How long each address gets to answer the connect and each frame of the handshake.
const CONNECT_MS: u64 = 10_000;
/// How long a link may carry no frame before it is cut: the host pings every ten seconds, so three missed beats.
const QUIET_MS: u64 = 30_000;
/// How long a refused link waits. The host holds no such place, so nothing changes until a person acts.
const REFUSED_RETRY_MS: u64 = 10 * 60_000;
/// A link that stood this long was a working link, so the next redial starts from the bottom of the backoff.
const SETTLED: Duration = Duration::from_secs(60);
/// How long the peer gets to answer a close frame this side sent before the socket is dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// The wait before attempt n: two seconds doubling to thirty.
pub fn place_backoff_ms(attempt: u32) -> u64 {
    (2_000u64 << attempt.saturating_sub(1).min(4)).min(30_000)
}

/// Four fifths to six fifths of the wait, so a hundred places that lost one host do not all come back at once.
fn jittered(ms: u64, draw: f64) -> u64 {
    (ms as f64 * (0.8 + 0.4 * draw)).round() as u64
}

/// A draw in [0, 1) from the system's randomness.
fn draw() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.5;
    }
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

fn fresh_nonce() -> PlaceNonce {
    let mut bytes = [0u8; numbers::PLACE_LINK_NONCE_BYTES];
    // The system's randomness is the one source; without it there is no nonce and no handshake worth sending.
    getrandom::fill(&mut bytes).expect("the system gives random bytes");
    Base64Bytes::from_bytes(&bytes)
}

/// The protocol's wsUrlOf: the scheme turned to its socket form, the host kept, trailing slashes cut, the socket
/// path appended. An https address is a relay's or a tunnel's, which is the one road to a host behind a home
/// router, so it becomes wss and the connect wraps the socket in TLS against the roots baked into this binary.
pub(crate) fn ws_url_of(url: &str) -> Result<String, &'static str> {
    if !is_http_url(url) {
        return Err("not an http address");
    }
    let (scheme, rest) = url.split_once("://").ok_or("not an http address")?;
    let socket = if scheme.eq_ignore_ascii_case("https") { "wss" } else { "ws" };
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (host, path) = match rest.find('/') {
        Some(at) => (&rest[..at], rest[at..].trim_end_matches('/')),
        None => (rest, ""),
    };
    if host.is_empty() {
        return Err("not an http address");
    }
    Ok(format!("{socket}://{host}{path}/ws"))
}

/// The sentence a refusing frame carries, or this side's word for one that carries none.
fn refusal_line(frame: &Value) -> &str {
    frame.get("error").and_then(Value::as_str).unwrap_or(words::HOST_REFUSED_PLACE)
}

/// Whether a frame is the host's own word: the key it carries is the one this computer pinned at join, and the
/// signature on it stands over the bytes the caller built. The one reading of a host's proof, for the challenge
/// it answers a dial with and for the refusal it gives in place of one; each caller brings its own transcript.
fn stands_for_the_host(file: &PlaceFile, key: &PlacePublicKey, bytes: &[u8], signature: &PlaceSignature) -> bool {
    key.as_str() == file.host_public_key && place::verify_place_bytes(key, bytes, signature)
}

/// Whether a refusal of the first frame is the host's own word, over this attempt's own refusal transcript, which
/// carries the nonce this dial challenged with and the sentence itself. Read before any wait is spent on it, so a
/// peer that proved nothing cannot buy ten minutes with a frame, and a refusal of an earlier dial cannot be
/// played back at this one.
fn is_the_hosts_word(file: &PlaceFile, nonce: &str, sentence: &str, frame: &Value) -> bool {
    let Ok(signed) = serde_json::from_value::<PlaceAuthRefusal>(frame.clone()) else { return false };
    let bytes = place_refusal_transcript(&file.place_id, nonce, sentence);
    stands_for_the_host(file, &signed.host_public_key, &bytes, &signed.signature)
}

/// Whole seconds as node's Math.round gives them for the two sentences that name a wait.
fn seconds(ms: u64) -> u64 {
    (ms as f64 / 1000.0).round() as u64
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What one address gave: a proved socket to hold, the word of a host that proved its key and then said this place
/// is not one it knows, an answer this attempt could not go on with, or nothing at all. Only a host that proved
/// itself can refuse: an `ok: false` from anyone else is a frame anybody who answers at the address can send.
enum Outcome {
    Linked(Box<Socket>, Box<Seal>),
    Refused,
    Answered,
    Silent,
}

/// Where the handshake stands on one socket. The id a frame carries says nothing about who sent it, so the order is
/// what a place holds a peer to until the pinned key is proved: an answer that does not fit the state ends the
/// attempt with nothing served on that socket.
enum Step {
    SentAuth,
    HostProved,
}

struct Link {
    ctx: Arc<Ctx>,
    daemon_port: u16,
    file: std::path::PathBuf,
    home: std::path::PathBuf,
    agents: Vec<AgentBin>,
    /// Each agent's version line, held across dials and read again only where its binary moved.
    versions: Arc<Mutex<AgentVersions>>,
    connect: Duration,
    quiet: Duration,
    refused_retry: u64,
    fixed_backoff: Option<u64>,
}

/// The link this daemon holds outward while it runs; returns only once a leave has been answered, which is what
/// ends the daemon.
pub(crate) async fn run(ctx: Arc<Ctx>, daemon_port: u16) {
    let o = &ctx.options;
    let Some(file) = o.place_file.clone() else { return };
    let link = Link {
        home: place::place_home(o.home.as_deref()),
        agents: place::parse_agents(&o.agents),
        versions: Arc::new(Mutex::new(AgentVersions::default())),
        connect: Duration::from_millis(o.link_connect_ms.unwrap_or(CONNECT_MS)),
        quiet: Duration::from_millis(o.link_quiet_ms.unwrap_or(QUIET_MS)),
        refused_retry: o.link_refused_retry_ms.unwrap_or(REFUSED_RETRY_MS),
        fixed_backoff: o.link_backoff_ms,
        file,
        daemon_port,
        ctx: Arc::clone(&ctx),
    };
    // Parts of an upload a dropped link left behind: the host picks a fresh id for every try, so nothing else will
    // ever name them again.
    let swept = place::sweep_updates(&link.home, None);
    if swept > 0 {
        link.log(&words::update_swept(swept));
    }
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let Some(file) = place::read_place_file(&link.file) else {
            link.log(words::NO_PLACE_FILE);
            link.wait(link.refused_retry).await;
            continue;
        };
        let (mut answers, mut refusals, mut held) = (0usize, 0usize, false);
        for url in &file.host_urls {
            match link.handshake(&file, url).await {
                Outcome::Silent => continue,
                Outcome::Answered => answers += 1,
                Outcome::Refused => {
                    answers += 1;
                    refusals += 1;
                }
                Outcome::Linked(ws, seal) => {
                    let linked_at = Instant::now();
                    match link.hold(*ws, url, *seal).await {
                        Ended::Leave | Ended::Restart => return,
                        Ended::Quiet => link.log(&words::link_quiet(url, seconds(link.quiet.as_millis() as u64))),
                        // The link carries no token, so the watcher never reaches it; a socket that ended any
                        // other way is one to dial again.
                        Ended::Peer | Ended::Rotated => {}
                    }
                    // A link that stood a minute was a working link: the next one starts from the bottom of the
                    // backoff rather than from wherever a laptop that slept for an hour left it.
                    if linked_at.elapsed() > SETTLED {
                        attempt = 0;
                    }
                    held = true;
                    break;
                }
            }
        }
        // The long wait is the answer to a host's own word and to nothing else: it is taken where every address
        // that proved itself and answered refused, so an address nobody answered at costs nothing and a stranger
        // that answers ahead of the real host cannot hold this computer off it.
        let ms = if held {
            link.backoff(attempt + 1)
        } else if refusals > 0 && refusals == answers {
            link.refused_retry
        } else {
            link.backoff(attempt)
        };
        link.wait(ms).await;
    }
}

impl Link {
    fn log(&self, line: &str) {
        self.ctx.log(line);
    }

    fn backoff(&self, attempt: u32) -> u64 {
        self.fixed_backoff.unwrap_or_else(|| place_backoff_ms(attempt))
    }

    async fn wait(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(jittered(ms, draw()))).await;
    }

    /// One address: open, auth, verify the host, prove, and take the prove's reply, in that order and no other.
    /// The deadline covers the connect and every frame of the handshake.
    async fn handshake(&self, file: &PlaceFile, url: &str) -> Outcome {
        let target = match ws_url_of(url) {
            Ok(target) => target,
            Err(why) => {
                self.log(&words::link_could_not_dial(url, why));
                return Outcome::Silent;
            }
        };
        let deadline = Instant::now() + self.connect;
        let mut ws = match timeout_at(deadline, connect_async(&target)).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(_)) => {
                self.log(&words::link_no_answer_to_dial(url));
                return Outcome::Silent;
            }
            Err(_) => {
                self.log(&words::link_no_answer_in(url, seconds(self.connect.as_millis() as u64)));
                return Outcome::Silent;
            }
        };
        let nonce = fresh_nonce();
        // One key agreement per attempt, thrown away with the socket: a key that leaks later opens nothing that
        // was said on a link before it.
        let Some((private, public)) = seal::fresh_ephemeral() else {
            self.log(&words::link_could_not_dial(url, "this computer has no randomness for a key agreement"));
            return Outcome::Silent;
        };
        let mut private = Some(private);
        let ephemeral: PlaceEphemeral = Base64Bytes::from_bytes(&public);
        let auth = PlaceAuthRequest::new(RequestId::from(1), file.place_id.clone(), nonce.clone(), ephemeral.clone());
        if ws.send(Message::text(crate::frame_text(&auth))).await.is_err() {
            self.log(&words::link_no_answer_to_dial(url));
            return Outcome::Silent;
        }
        let mut step = Step::SentAuth;
        let mut held: Option<Seal> = None;
        loop {
            let frame = match timeout_at(deadline, ws.next()).await {
                Err(_) => {
                    self.log(&words::link_no_answer_in(url, seconds(self.connect.as_millis() as u64)));
                    return self.cut(ws, Outcome::Silent).await;
                }
                // Once the prove has gone out sealed, the host's own reply comes back the same way, and a frame
                // in the clear after it is a carrier writing into the handshake.
                Ok(Some(Ok(Message::Text(t)))) if held.is_none() => t.to_string(),
                Ok(Some(Ok(Message::Binary(b)))) => match held.as_mut() {
                    Some(seal) => match seal.unseal(&b) {
                        Some(text) => text,
                        None => {
                            self.log(&words::link_not_a_frame(url));
                            return self.cut(ws, Outcome::Answered).await;
                        }
                    },
                    None => String::from_utf8_lossy(&b).into_owned(),
                },
                Ok(Some(Ok(Message::Text(_)))) => {
                    self.log(&words::link_not_a_frame(url));
                    return self.cut(ws, Outcome::Answered).await;
                }
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)))) => continue,
                Ok(_) => {
                    self.log(&words::link_no_answer_to_dial(url));
                    return Outcome::Silent;
                }
            };
            let Ok(value) = serde_json::from_str::<Value>(&frame) else {
                self.log(&words::link_not_a_frame(url));
                return self.cut(ws, Outcome::Answered).await;
            };
            let ok = value.get("ok") == Some(&Value::Bool(true));
            match (&step, ok, value.get("id").and_then(Value::as_u64)) {
                (Step::SentAuth, false, Some(1)) => {
                    // A no at the first frame that the pinned key signed is the host's own word, given before it
                    // knew this place, and the long wait follows it: nothing changes until a person acts. One
                    // that carries no signature, or one that key did not make, is a frame anybody who answers at
                    // this address can send, so the sentence is logged, the next address is tried, and no wait of
                    // this place's is spent on the word of someone who might not be its host at all.
                    let sentence = refusal_line(&value);
                    let outcome =
                        if is_the_hosts_word(file, nonce.as_str(), sentence, &value) { Outcome::Refused } else { Outcome::Answered };
                    self.log(&words::link_refused(url, sentence));
                    return self.cut(ws, outcome).await;
                }
                (Step::HostProved, false, Some(2)) => {
                    // The host proved the pinned key and then said no: its own word, and the one refusal the long
                    // wait follows, since nothing changes until a person acts.
                    self.log(&words::link_refused(url, refusal_line(&value)));
                    return self.cut(ws, Outcome::Refused).await;
                }
                (Step::SentAuth, true, Some(1)) => {
                    // A host that sends no key of its own to agree with runs a wsp older than this one, and a
                    // link neither end can seal is one this computer does not hold.
                    if value.get("ephemeral").is_none() {
                        self.log(&words::link_host_unsealed(url));
                        return self.cut(ws, Outcome::Answered).await;
                    }
                    let reply = match serde_json::from_value::<PlaceAuthReply>(value.clone()) {
                        Ok(reply) => reply,
                        Err(e) => {
                            self.log(&words::link_unreadable_auth_reply(url, &e.to_string()));
                            return self.cut(ws, Outcome::Answered).await;
                        }
                    };
                    let ephemerals = LinkEphemerals { challenger: ephemeral.as_str(), answerer: reply.ephemeral.as_str() };
                    let host_bytes =
                        place_link_transcript(LinkRole::Host, &file.place_id, nonce.as_str(), reply.nonce.as_str(), ephemerals);
                    if !stands_for_the_host(file, &reply.host_public_key, &host_bytes, &reply.signature) {
                        // Nothing of this computer's has been sent yet: the report and the place's own signature
                        // are the next frame, and the attempt ends before it.
                        self.log(&words::host_key_refusal(url));
                        return self.cut(ws, Outcome::Answered).await;
                    }
                    // The key both signatures cover, since the transcript named both ephemerals: a carrier that
                    // swapped either of them signed nothing, and from the prove on it reads and writes nothing.
                    let agreed = private.take().and_then(|private| seal::agree(private, &reply.ephemeral.to_bytes()));
                    let Some(secret) = agreed else {
                        self.log(&words::link_host_unsealed(url));
                        return self.cut(ws, Outcome::Answered).await;
                    };
                    let mut seal = Seal::place(&seal::seal_keys(&secret, &file.place_id));
                    let versions = self.agent_versions().await;
                    let prove = match self.prove(
                        file,
                        url,
                        reply.nonce.as_str(),
                        nonce.as_str(),
                        LinkEphemerals { challenger: reply.ephemeral.as_str(), answerer: ephemeral.as_str() },
                        &versions,
                    ) {
                        Ok(prove) => prove,
                        Err(why) => {
                            self.log(&words::link_refused(url, &why));
                            return self.cut(ws, Outcome::Answered).await;
                        }
                    };
                    if ws.send(Message::Binary(seal.seal(&crate::frame_text(&prove)).into())).await.is_err() {
                        self.log(&words::link_no_answer_to_dial(url));
                        return Outcome::Silent;
                    }
                    held = Some(seal);
                    step = Step::HostProved;
                }
                (Step::HostProved, true, Some(2)) => {
                    let Some(seal) = held else { return self.cut(ws, Outcome::Answered).await };
                    return Outcome::Linked(Box::new(ws), Box::new(seal));
                }
                _ => {
                    self.log(&words::link_out_of_order(url));
                    return self.cut(ws, Outcome::Answered).await;
                }
            }
        }
    }

    /// Each agent's version line as of this dial: stats every agent's binary and runs the ones that moved. On the
    /// blocking pool, since one read is a process and a wait and the task holding this link may not stand still
    /// for them; a pool that will not take the work leaves the report the lines it had.
    async fn agent_versions(&self) -> BTreeMap<String, String> {
        let held = Arc::clone(&self.versions);
        let agents = self.agents.clone();
        // What this daemon's own children run on, which a place sets to the probe list at start: a binary a
        // workspace planted under the home this daemon shares with them is on no line of it.
        let path = place::run_path();
        tokio::task::spawn_blocking(move || {
            let mut versions = held.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            versions.refresh(&agents, &path, place::VERSION_DEADLINE);
            versions.lines()
        })
        .await
        .unwrap_or_default()
    }

    /// The second frame: this place's signature over the host's transcript and its report as it stands now.
    fn prove(
        &self,
        file: &PlaceFile,
        url: &str,
        host_nonce: &str,
        my_nonce: &str,
        ephemerals: LinkEphemerals<'_>,
        agent_versions: &BTreeMap<String, String>,
    ) -> Result<PlaceProveRequest, String> {
        let pem = std::fs::read_to_string(Path::new(&file.key_path)).map_err(|e| format!("{}: {e}", file.key_path))?;
        let report = place::place_report(&ReportInput {
            file,
            home: &self.home,
            wsp_argv: &self.ctx.options.wsp_argv,
            agents: &self.agents,
            agent_versions,
            daemon_port: self.daemon_port,
            dialed: url,
            unit_path: self.ctx.options.unit_path.as_deref(),
            runtime_root: self.ctx.options.runtime_root.as_deref().unwrap_or(Path::new(wsp_runtime::DEFAULT_ROOT)),
        });
        let signature =
            place::sign_place_bytes(&pem, &place_link_transcript(LinkRole::Place, &file.place_id, host_nonce, my_nonce, ephemerals))?;
        Ok(PlaceProveRequest::new(RequestId::from(2), signature, report))
    }

    /// Ends an attempt on a socket this side is walking away from, with node's close reason.
    async fn cut(&self, mut ws: Socket, outcome: Outcome) -> Outcome {
        let frame = CloseFrame { code: CloseCode::Normal, reason: words::LINK_CLOSE_ATTEMPT_OVER.into() };
        let _ = tokio::time::timeout(CLOSE_WAIT, async {
            let _ = ws.close(Some(frame)).await;
            while let Some(Ok(_)) = ws.next().await {}
        })
        .await;
        outcome
    }

    /// The socket is this place's link from here: the daemon serves it as it serves an inbound one, the link's own
    /// ops ride it, and a link that carries no frame at all is cut so the redial can find a host that is there.
    async fn hold(&self, ws: Socket, url: &str, seal: Seal) -> Ended {
        self.log(&words::link_linked(url));
        let (tx, rx) = mpsc::unbounded_channel();
        let conn = Arc::new(Conn::new(self.ctx.next_key(), None, Outbound(tx), Road::Link, None));
        door::serve_authed(ws, &self.ctx, conn, rx, Some(self.quiet), Some(seal)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wait_doubles_from_two_seconds_to_thirty_and_stops_there() {
        assert_eq!([1, 2, 3, 4, 5, 6].map(place_backoff_ms), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
        assert_eq!(place_backoff_ms(0), 2_000);
    }

    #[test]
    fn the_jitter_is_four_fifths_to_six_fifths_of_the_wait() {
        assert_eq!(jittered(10_000, 0.0), 8_000);
        assert_eq!(jittered(10_000, 0.5), 10_000);
        assert_eq!(jittered(10_000, 1.0), 12_000);
        for _ in 0..100 {
            let d = draw();
            assert!((0.0..1.0).contains(&d));
        }
    }

    #[test]
    fn the_socket_address_is_the_protocols_reading_of_the_http_or_https_one() {
        assert_eq!(ws_url_of("http://192.168.1.20:4400").unwrap(), "ws://192.168.1.20:4400/ws");
        assert_eq!(ws_url_of("http://192.168.1.20:4400/").unwrap(), "ws://192.168.1.20:4400/ws");
        assert_eq!(ws_url_of("http://host.example/base//").unwrap(), "ws://host.example/base/ws");
        assert_eq!(ws_url_of("HTTP://h:1?x=1").unwrap(), "ws://h:1/ws");
        assert_eq!(ws_url_of("https://h.example/").unwrap(), "wss://h.example/ws");
        assert_eq!(ws_url_of("https://h645d7f8a8d48cbd6.example").unwrap(), "wss://h645d7f8a8d48cbd6.example/ws");
        assert_eq!(ws_url_of("https://h.example/base//").unwrap(), "wss://h.example/base/ws");
        assert_eq!(ws_url_of("HTTPS://h.example:8443?x=1").unwrap(), "wss://h.example:8443/ws");
        assert!(ws_url_of("ftp://h").is_err());
        assert!(ws_url_of("http://").is_err());
        assert!(ws_url_of("http:///path").is_err());
    }

    #[test]
    fn the_nonce_is_thirty_two_fresh_bytes() {
        let a = fresh_nonce();
        let b = fresh_nonce();
        assert_ne!(a, b);
        assert_eq!(a.to_bytes().len(), 32);
        assert_eq!(seconds(10_000), 10);
        assert_eq!(seconds(120), 0);
        assert_eq!(seconds(1_500), 2);
    }
}
