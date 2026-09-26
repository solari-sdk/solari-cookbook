// SPDX-License-Identifier: AGPL-3.0-only
//! The link a place holds to its host, against a fake host that is a real WebSocket server with a real ed25519
//! pair: nothing here fakes a signature, so the handshake the daemon runs is the one the host answers. One case per
//! case of the node daemon's place-link suite, with the same assertions.

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use wsp_daemon::seal::{self, Seal};
use wsp_daemon::{place_backoff_ms, Daemon, Options};
use wsp_frames::{
    place_daemon_paths, place_link_transcript, place_refusal_transcript, words, DaemonEvent, LinkEphemerals, LinkRole, PlaceProveRequest,
    PlaceReport,
};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const PLACE_UNKNOWN_REFUSAL: &str = "this host holds no place by that id; join it with a code from wsp add";

struct Pair {
    key: SigningKey,
    public_key: String,
    private_key_pem: String,
}

fn place_pair() -> Pair {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    let key = SigningKey::from_bytes(&seed);
    let public_key = B64.encode(key.verifying_key().to_public_key_der().unwrap().as_bytes());
    let private_key_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    Pair { key, public_key, private_key_pem }
}

type Held = WebSocketStream<TcpStream>;

/// A host that answers the handshake with a real signature. `wrong_transcript` signs the place's own half instead
/// of its own, which is the one thing a place must refuse; `refuse` answers the auth frame with that sentence.
struct FakeHost {
    url: String,
    dials: Arc<AtomicUsize>,
    /// Every frame the place sent after the handshake, in order.
    frames: Arc<Mutex<Vec<Value>>>,
    /// Every place.prove the place sent, report and all.
    proofs: Arc<Mutex<Vec<Value>>>,
    /// Every place.auth it opened with.
    auths: Arc<Mutex<Vec<Value>>>,
    /// The socket the place is holding, once it has proved, with the seal its frames ride inside.
    socket: mpsc::UnboundedReceiver<(Held, Seal)>,
    public_key: String,
}

#[derive(Default)]
struct HostOpts {
    key: Option<Pair>,
    wrong_transcript: bool,
    /// Answers the auth frame with this refusal, which `sign` says whose word it is given as.
    refuse: Option<&'static str>,
    /// How that refusal is signed: not at all, which is what anyone who answers at the address can say; with the
    /// host's own key over this dial's nonce, which is its own word; or with a key nobody pinned or over another
    /// dial's nonce, neither of which the place may take as one.
    sign: SignRefusal,
    /// Proves its key and then refuses the prove: the host's own word, and the one refusal a long wait follows.
    refuse_prove: Option<&'static str>,
    /// Answers with no key of its own to agree with, which is what a host older than the seal does.
    unsealed: bool,
    answer: Answer,
}

/// Whose word a refusal of the first frame is given as, and over which bytes.
#[derive(Clone, Copy, Default, PartialEq)]
enum SignRefusal {
    /// Nothing signed, which is what any peer that answers at the address can say.
    #[default]
    Not,
    /// The host's own key over this dial's place id, nonce and sentence.
    Own,
    /// A key this computer never pinned, over the same bytes.
    OtherKey,
    /// The host's own key, over a nonce this dial never sent: an earlier refusal played back.
    OtherNonce,
}

/// What the fake host answers `place.auth` with in place of its challenge, which is how a peer that holds neither
/// key tries to reach the socket the prove would have won it.
#[derive(Clone, Copy, Default, PartialEq)]
enum Answer {
    #[default]
    Challenge,
    /// The prove's own reply and nothing before it.
    LinkedFirst,
    /// A success under an id neither reply uses, then the prove's reply.
    OtherIdThenLinked,
    /// The challenge again once the prove has landed, in place of the prove's reply.
    ChallengeAfterProve,
    /// Its own challenge, signed with a key this place never pinned, and the prove's reply behind it.
    ChallengeThenLinked,
}

impl FakeHost {
    fn dials(&self) -> usize {
        self.dials.load(Ordering::SeqCst)
    }

    async fn held(&mut self) -> (Held, Seal) {
        tokio::time::timeout(Duration::from_secs(5), self.socket.recv()).await.expect("the place proved within five seconds").unwrap()
    }
}

async fn fake_place_host(opts: HostOpts) -> FakeHost {
    let pair = opts.key.unwrap_or_else(place_pair);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dials = Arc::new(AtomicUsize::new(0));
    let frames = Arc::new(Mutex::new(Vec::new()));
    let proofs = Arc::new(Mutex::new(Vec::new()));
    let auths = Arc::new(Mutex::new(Vec::new()));
    let (held_tx, socket) = mpsc::unbounded_channel();
    let public_key = pair.public_key.clone();
    let key = Arc::new(pair.key);
    let (d, f, p, a, pk) = (Arc::clone(&dials), Arc::clone(&frames), Arc::clone(&proofs), Arc::clone(&auths), public_key.clone());
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            d.fetch_add(1, Ordering::SeqCst);
            let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { continue };
            let (key, f, p, a, pk, held_tx) =
                (Arc::clone(&key), Arc::clone(&f), Arc::clone(&p), Arc::clone(&a), pk.clone(), held_tx.clone());
            let tuning = ChallengeOpts { wrong_transcript: opts.wrong_transcript, unsealed: opts.unsealed };
            tokio::spawn(async move {
                let mut challenged: Option<Asked> = None;
                let mut seal: Option<Seal> = None;
                while let Some(Ok(msg)) = ws.next().await {
                    // Every frame after this host's own reply is sealed, which is what the place holds it to.
                    let text = match (msg, seal.as_mut()) {
                        (Message::Text(t), None) => t.to_string(),
                        (Message::Binary(b), Some(seal)) => seal.unseal(&b).expect("the place sealed its frame"),
                        _ => continue,
                    };
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    match frame["op"].as_str() {
                        Some("place.auth") => {
                            a.lock().unwrap().push(frame.clone());
                            if let Some(refusal) = opts.refuse {
                                let mut said = json!({"id": frame["id"], "ok": false, "error": refusal, "kind": "auth"});
                                if opts.sign != SignRefusal::Not {
                                    let stranger = place_pair();
                                    let signer = if opts.sign == SignRefusal::OtherKey { &stranger.key } else { key.as_ref() };
                                    let shown = if opts.sign == SignRefusal::OtherKey { &stranger.public_key } else { &pk };
                                    let nonce = match opts.sign {
                                        SignRefusal::OtherNonce => B64.encode([5u8; 32]),
                                        _ => frame["nonce"].as_str().unwrap().to_owned(),
                                    };
                                    let bytes = place_refusal_transcript(frame["placeId"].as_str().unwrap(), &nonce, refusal);
                                    said["hostPublicKey"] = json!(shown);
                                    said["signature"] = json!(B64.encode(signer.sign(&bytes).to_bytes()));
                                }
                                let _ = ws.send(Message::text(said.to_string())).await;
                                let _ = ws.close(None).await;
                                return;
                            }
                            challenged = Some(Asked {
                                place_id: frame["placeId"].as_str().unwrap().to_owned(),
                                place_nonce: frame["nonce"].as_str().unwrap().to_owned(),
                                ephemeral: frame["ephemeral"].as_str().unwrap_or_default().to_owned(),
                            });
                            let (answered, agreed) = challenge(&key, &pk, tuning, challenged.as_ref().unwrap());
                            for reply in match opts.answer {
                                Answer::LinkedFirst => vec![json!({"id": 2, "ok": true})],
                                Answer::OtherIdThenLinked => vec![json!({"id": 9, "ok": true}), json!({"id": 2, "ok": true})],
                                Answer::ChallengeThenLinked => vec![answered.clone(), json!({"id": 2, "ok": true})],
                                _ => vec![answered.clone()],
                            } {
                                let _ = ws.send(Message::text(reply.to_string())).await;
                            }
                            // The reply is the last frame in the clear; a host that answers out of order sends
                            // nothing more and agrees nothing.
                            if matches!(opts.answer, Answer::Challenge | Answer::ChallengeAfterProve) {
                                seal = agreed;
                            }
                        }
                        Some("place.prove") => {
                            p.lock().unwrap().push(frame.clone());
                            let mut say = |value: Value| {
                                let text = value.to_string();
                                match seal.as_mut() {
                                    Some(seal) => Message::Binary(seal.seal(&text).into()),
                                    None => Message::text(text),
                                }
                            };
                            if let Some(refusal) = opts.refuse_prove {
                                let out = say(json!({"id": frame["id"], "ok": false, "error": refusal, "kind": "auth"}));
                                let _ = ws.send(out).await;
                                let _ = ws.close(None).await;
                                return;
                            }
                            if opts.answer == Answer::ChallengeAfterProve {
                                let (again, _) = challenge(&key, &pk, tuning, challenged.as_ref().unwrap());
                                let out = say(again);
                                let _ = ws.send(out).await;
                                continue;
                            }
                            let out = say(json!({"id": frame["id"], "ok": true}));
                            let _ = ws.send(out).await;
                            let _ = held_tx.send((ws, seal.take().expect("a proved link agreed a key")));
                            return;
                        }
                        _ => f.lock().unwrap().push(frame),
                    }
                }
            });
        }
    });
    FakeHost { url: format!("http://127.0.0.1:{port}"), dials, frames, proofs, auths, socket, public_key }
}

/// The reply a host that holds this place answers `place.auth` with: its own nonce, its key and its signature over
/// the host's half of the transcript. `wrong_transcript` signs the place's half instead, which is the one thing a
/// place must refuse.
fn challenge(key: &SigningKey, public_key: &str, opts: ChallengeOpts, asked: &Asked) -> (Value, Option<Seal>) {
    let Asked { place_id, place_nonce, ephemeral } = asked;
    let nonce = B64.encode([9u8; 32]);
    let role = if opts.wrong_transcript { LinkRole::Place } else { LinkRole::Host };
    let (private, public) = seal::fresh_ephemeral().unwrap();
    let mine = B64.encode(public);
    let pair = LinkEphemerals { challenger: ephemeral, answerer: &mine };
    let signature = B64.encode(key.sign(&place_link_transcript(role, place_id, place_nonce, &nonce, pair)).to_bytes());
    if opts.unsealed {
        return (json!({"id": 1, "ok": true, "nonce": nonce, "hostPublicKey": public_key, "signature": signature}), None);
    }
    let mut raw = [0u8; 32];
    raw.copy_from_slice(&B64.decode(ephemeral).unwrap());
    let secret = seal::agree(private, &raw).unwrap();
    let seal = Seal::host(&seal::seal_keys(&secret, place_id));
    (json!({"id": 1, "ok": true, "nonce": nonce, "hostPublicKey": public_key, "signature": signature, "ephemeral": mine}), Some(seal))
}

/// The two things about a host's answer a case tunes, copied out of the options so the task that answers one
/// socket takes them by value.
#[derive(Clone, Copy)]
struct ChallengeOpts {
    wrong_transcript: bool,
    unsealed: bool,
}

/// What the place's first frame asked with: the id it names, its nonce and its half of the key agreement.
struct Asked {
    place_id: String,
    place_nonce: String,
    ephemeral: String,
}

struct Place {
    home: tempfile::TempDir,
    file: std::path::PathBuf,
}

/// A fake home joined as a place: the place file and its key where a join puts them under that home.
fn place_file(host_urls: &[&str], host_public_key: &str, key_pem: &str) -> Place {
    let home = tempfile::tempdir().unwrap();
    let at = place_daemon_paths(home.path());
    std::fs::create_dir_all(&at.wsp).unwrap();
    let file = json!({
        "placeId": "p_ab12cd34", "name": "old-macbook", "hostName": "zingzy-mbp", "hostUrls": host_urls,
        "hostPublicKey": host_public_key, "keyPath": at.place_key, "joinedAt": "1970-01-01T00:00:00.000Z",
    });
    std::fs::write(&at.place_file, format!("{}\n", serde_json::to_string_pretty(&file).unwrap())).unwrap();
    std::fs::write(&at.place_key, key_pem).unwrap();
    Place { home, file: at.place_file }
}

struct Running {
    port: u16,
    lines: Arc<Mutex<Vec<String>>>,
    run: tokio::task::JoinHandle<std::io::Result<()>>,
    token: tempfile::NamedTempFile,
}

impl Running {
    fn log(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }

    /// Waits for one line of the daemon's log.
    async fn until_logged(&self, test: impl Fn(&str) -> bool) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(line) = self.log().into_iter().find(|l| test(l)) {
                return line;
            }
            assert!(tokio::time::Instant::now() < deadline, "no such line within five seconds; the log is {:?}", self.log());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.run.abort();
    }
}

/// The daemon a place runs, dialling out on the file under its home; the token is what its own loopback door takes.
async fn place_daemon(place: &Place, tune: impl FnOnce(&mut Options)) -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "link-token").unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.kind = "place".to_owned();
    options.root = Some(place.home.path().to_path_buf());
    options.home = Some(place.home.path().to_path_buf());
    options.place_file = Some(place.file.clone());
    options.runtime_root = Some(place.home.path().join("runtime"));
    options.roots_path = Some(place_daemon_paths(place.home.path()).roots_path);
    tune(&mut options);
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);
    let daemon = Daemon::bind_with(options, Box::new(move |line| sink.lock().unwrap().push(line.to_owned()))).await.unwrap();
    let port = daemon.local_addr().port();
    let run = tokio::spawn(daemon.run());
    Running { port, lines, run, token }
}

async fn settled(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Asks one op on the held socket and reads frames until its reply lands; events seen on the way are kept.
async fn ask(held: &mut (Held, Seal), id: u64, op: &str, events: &mut Vec<Value>) -> Value {
    let (ws, seal) = held;
    let out = seal.seal(&json!({"id": id, "op": op}).to_string());
    ws.send(Message::Binary(out.into())).await.unwrap();
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("an answer").unwrap().unwrap();
        let Message::Binary(bytes) = msg else { continue };
        let text = seal.unseal(&bytes).expect("every frame the daemon sends a sealed link is sealed");
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame.get("type").is_some() {
            events.push(frame);
        } else if frame["id"] == json!(id) {
            return frame;
        }
    }
}

#[test]
fn the_wait_before_each_attempt_doubles_from_two_seconds_to_thirty_and_stops_there() {
    assert_eq!([1, 2, 3, 4, 5, 6].map(place_backoff_ms), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
}

#[tokio::test]
async fn sends_place_auth_as_its_first_frame_and_proves_with_a_report_the_host_reads_before_anything_else() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    // The place's own key is not the host's; the file pins the host's, which is what it verifies against.
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| {
        o.wsp_argv = vec!["/usr/local/bin/node".to_owned(), "/opt/wsp/bin.js".to_owned()];
        o.agents = vec!["a1=sh".to_owned(), "b2=no-such-agent-command".to_owned()];
    })
    .await;
    host.held().await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    // The place asked nothing of the host: what the host saw after the handshake is no request.
    assert!(host.frames.lock().unwrap().iter().all(|f| f.get("op").is_none()));
    let proof: PlaceProveRequest = serde_json::from_value(host.proofs.lock().unwrap()[0].clone()).unwrap();
    let report: PlaceReport = proof.report;
    assert_eq!(report.name, "old-macbook");
    assert_eq!(report.dialed, host.url);
    assert_eq!(report.daemon_port.map(|p| p.get()), Some(d.port));
    assert_eq!(report.wsp, vec!["/usr/local/bin/node", "/opt/wsp/bin.js"]);
    assert_eq!(report.login["HOME"], place.home.path().to_string_lossy());
    // The agents are the ids off the list it was started with whose command is on PATH now: sh is, the other is not.
    assert_eq!(report.agents, vec!["a1"]);
    assert!(report.shape.cpu > 0.0);
}

#[tokio::test]
async fn dials_the_second_address_when_the_first_refuses_the_connect_and_names_both_in_its_log() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let dead = "http://127.0.0.1:1";
    let place = place_file(&[dead, &host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_connect_ms = Some(500)).await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    let log = d.log().join("\n");
    assert!(log.contains(dead), "{log}");
    assert!(log.contains(&host.url), "{log}");
}

#[tokio::test]
async fn ends_the_attempt_before_it_sends_its_report_when_the_hosts_signature_is_over_the_wrong_transcript() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), wrong_transcript: true, ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    d.until_logged(|l| l == words::host_key_refusal(&host.url)).await;
    settled(100).await;
    assert!(host.frames.lock().unwrap().is_empty());
    assert!(host.proofs.lock().unwrap().is_empty());
    assert!(!d.log().contains(&words::link_linked(&host.url)));
}

#[tokio::test]
async fn refuses_a_host_whose_key_is_not_the_one_this_computer_pinned() {
    let host = fake_place_host(HostOpts::default()).await;
    let place = place_file(&[&host.url], &place_pair().public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    d.until_logged(|l| l == words::host_key_refusal(&host.url)).await;
    settled(100).await;
    assert!(host.proofs.lock().unwrap().is_empty());
    assert!(!d.log().contains(&words::link_linked(&host.url)));
}

#[tokio::test]
async fn stops_dialling_for_minutes_when_the_host_that_proved_its_key_refuses_the_prove() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), refuse_prove: Some(PLACE_UNKNOWN_REFUSAL), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| {
        o.link_refused_retry_ms = Some(600_000);
        o.link_backoff_ms = Some(20);
    })
    .await;
    d.until_logged(|l| l.contains("holds no place by that id")).await;
    // Refused is a wait of minutes, not the backoff of milliseconds this daemon was given: no second dial lands.
    settled(300).await;
    assert_eq!(host.dials(), 1);
}

#[tokio::test]
async fn takes_the_long_wait_when_every_address_that_answered_refused_after_proving_itself() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), refuse_prove: Some(PLACE_UNKNOWN_REFUSAL), ..HostOpts::default() }).await;
    // An address nothing answers at is passed over and counts for nothing: the refusal of the one host that
    // answered is still the host's own word, and the wait is its.
    let place = place_file(&["http://127.0.0.1:1", &host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| {
        o.link_refused_retry_ms = Some(600_000);
        o.link_backoff_ms = Some(20);
        o.link_connect_ms = Some(500);
    })
    .await;
    d.until_logged(|l| l.contains("holds no place by that id")).await;
    settled(300).await;
    assert_eq!(host.dials(), 1);
}

#[tokio::test]
async fn a_success_under_the_proves_id_before_the_host_proved_links_nothing_and_the_next_address_is_dialled() {
    let key = place_pair();
    let stranger = fake_place_host(HostOpts { answer: Answer::LinkedFirst, ..HostOpts::default() }).await;
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&stranger.url, &host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    host.held().await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    // Nothing of this computer's reached the stranger, and the address it holds was passed over by name.
    assert!(stranger.proofs.lock().unwrap().is_empty());
    assert!(stranger.frames.lock().unwrap().is_empty());
    assert!(d.log().contains(&words::link_out_of_order(&stranger.url)), "{:?}", d.log());
    assert!(!d.log().contains(&words::link_linked(&stranger.url)));
}

#[tokio::test]
async fn a_success_under_an_id_neither_reply_uses_ends_the_attempt_before_the_prove() {
    let stranger = fake_place_host(HostOpts { answer: Answer::OtherIdThenLinked, ..HostOpts::default() }).await;
    let place = place_file(&[&stranger.url], &place_pair().public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    d.until_logged(|l| l == words::link_out_of_order(&stranger.url)).await;
    settled(100).await;
    assert!(stranger.proofs.lock().unwrap().is_empty());
    assert!(!d.log().contains(&words::link_linked(&stranger.url)));
}

#[tokio::test]
async fn a_second_auth_reply_after_the_prove_ends_the_attempt_and_sends_no_second_prove() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), answer: Answer::ChallengeAfterProve, ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    d.until_logged(|l| l == words::link_out_of_order(&host.url)).await;
    settled(100).await;
    assert_eq!(host.proofs.lock().unwrap().len(), 1);
    assert!(!d.log().contains(&words::link_linked(&host.url)));
}

#[tokio::test]
async fn a_refusal_from_a_peer_that_proved_nothing_is_passed_over_and_the_next_address_links() {
    let key = place_pair();
    let stranger = fake_place_host(HostOpts { refuse: Some(PLACE_UNKNOWN_REFUSAL), ..HostOpts::default() }).await;
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&stranger.url, &host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    host.held().await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    assert_eq!(stranger.dials(), 1);
}

#[tokio::test]
async fn a_refusal_from_a_peer_that_proved_nothing_costs_the_backoff_and_not_the_long_wait() {
    let stranger = fake_place_host(HostOpts { refuse: Some(PLACE_UNKNOWN_REFUSAL), ..HostOpts::default() }).await;
    let place = place_file(&[&stranger.url], &place_pair().public_key, &place_pair().private_key_pem);
    let _d = place_daemon(&place, |o| {
        o.link_refused_retry_ms = Some(600_000);
        o.link_backoff_ms = Some(20);
    })
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while stranger.dials() < 3 {
        assert!(tokio::time::Instant::now() < deadline, "a stranger's refusal held this computer off its host; {} dials", stranger.dials());
        settled(10).await;
    }
}

#[tokio::test]
async fn a_refusal_the_pinned_key_signed_costs_the_long_wait_and_one_dial() {
    let key = place_pair();
    let host =
        fake_place_host(HostOpts { key: Some(key), refuse: Some(PLACE_UNKNOWN_REFUSAL), sign: SignRefusal::Own, ..HostOpts::default() })
            .await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| {
        o.link_refused_retry_ms = Some(600_000);
        o.link_backoff_ms = Some(20);
    })
    .await;
    d.until_logged(|l| l.contains("holds no place by that id")).await;
    // The host gave its word before it knew this place, so the wait is the long one and no second dial lands in
    // the milliseconds a backoff would have taken.
    settled(300).await;
    assert_eq!(host.dials(), 1);
}

#[tokio::test]
async fn a_refusal_signed_by_a_key_this_computer_never_pinned_costs_the_backoff() {
    let key = place_pair();
    let host = fake_place_host(HostOpts {
        key: Some(key),
        refuse: Some(PLACE_UNKNOWN_REFUSAL),
        sign: SignRefusal::OtherKey,
        ..HostOpts::default()
    })
    .await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let _d = place_daemon(&place, |o| {
        o.link_refused_retry_ms = Some(600_000);
        o.link_backoff_ms = Some(20);
    })
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while host.dials() < 3 {
        assert!(tokio::time::Instant::now() < deadline, "a stranger's signature bought the long wait; {} dials", host.dials());
        settled(10).await;
    }
}

#[tokio::test]
async fn a_refusal_signed_over_another_dials_nonce_costs_the_backoff() {
    let key = place_pair();
    let host = fake_place_host(HostOpts {
        key: Some(key),
        refuse: Some(PLACE_UNKNOWN_REFUSAL),
        sign: SignRefusal::OtherNonce,
        ..HostOpts::default()
    })
    .await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let _d = place_daemon(&place, |o| {
        o.link_refused_retry_ms = Some(600_000);
        o.link_backoff_ms = Some(20);
    })
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while host.dials() < 3 {
        assert!(tokio::time::Instant::now() < deadline, "a refusal of another dial held this one off; {} dials", host.dials());
        settled(10).await;
    }
}

#[tokio::test]
async fn an_auth_reply_under_a_key_this_computer_never_pinned_links_nothing_even_when_a_success_follows_it() {
    let stranger = fake_place_host(HostOpts { answer: Answer::ChallengeThenLinked, ..HostOpts::default() }).await;
    let place = place_file(&[&stranger.url], &place_pair().public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    d.until_logged(|l| l == words::host_key_refusal(&stranger.url)).await;
    settled(100).await;
    assert!(stranger.proofs.lock().unwrap().is_empty());
    assert!(!d.log().contains(&words::link_linked(&stranger.url)));
}

#[tokio::test]
async fn says_so_and_waits_when_this_computer_holds_no_place_file_at_all() {
    let home = tempfile::tempdir().unwrap();
    let file = place_daemon_paths(home.path()).place_file;
    let place = Place { home, file };
    let d = place_daemon(&place, |o| o.link_refused_retry_ms = Some(600_000)).await;
    d.until_logged(|l| l == words::NO_PLACE_FILE).await;
}

#[tokio::test]
async fn proves_the_places_own_half_against_the_key_on_its_file_which_is_what_the_host_verifies() {
    let key = place_pair();
    let mine = place_pair();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (proved_tx, mut proved_rx) = mpsc::unbounded_channel::<bool>();
    let mine_public = VerifyingKey::from_public_key_der(&B64.decode(&mine.public_key).unwrap()).unwrap();
    let host_key = key.key.clone();
    let host_public = key.public_key.clone();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let mut expect: Option<Vec<u8>> = None;
        let mut seal: Option<Seal> = None;
        while let Some(Ok(msg)) = ws.next().await {
            let text = match (msg, seal.as_mut()) {
                (Message::Text(t), None) => t.to_string(),
                (Message::Binary(b), Some(seal)) => seal.unseal(&b).expect("the place sealed its frame"),
                _ => continue,
            };
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["op"] == "place.auth" {
                let place_id = frame["placeId"].as_str().unwrap();
                let place_nonce = frame["nonce"].as_str().unwrap();
                let theirs = frame["ephemeral"].as_str().unwrap().to_owned();
                let nonce = B64.encode([4u8; 32]);
                let (private, public) = seal::fresh_ephemeral().unwrap();
                let ours = B64.encode(public);
                expect = Some(place_link_transcript(
                    LinkRole::Place,
                    place_id,
                    &nonce,
                    place_nonce,
                    LinkEphemerals { challenger: &ours, answerer: &theirs },
                ));
                let bytes = place_link_transcript(
                    LinkRole::Host,
                    place_id,
                    place_nonce,
                    &nonce,
                    LinkEphemerals { challenger: &theirs, answerer: &ours },
                );
                let signature = B64.encode(host_key.sign(&bytes).to_bytes());
                let reply = json!({"id": frame["id"], "ok": true, "nonce": nonce, "hostPublicKey": host_public, "signature": signature, "ephemeral": ours});
                ws.send(Message::text(reply.to_string())).await.unwrap();
                let mut raw = [0u8; 32];
                raw.copy_from_slice(&B64.decode(&theirs).unwrap());
                seal = Some(Seal::host(&seal::seal_keys(&seal::agree(private, &raw).unwrap(), place_id)));
            } else if frame["op"] == "place.prove" {
                let sig: [u8; 64] = B64.decode(frame["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
                let ok = mine_public.verify(expect.as_ref().unwrap(), &Signature::from_bytes(&sig)).is_ok();
                let out = seal.as_mut().unwrap().seal(&json!({"id": frame["id"], "ok": true}).to_string());
                ws.send(Message::Binary(out.into())).await.unwrap();
                proved_tx.send(ok).unwrap();
            }
        }
    });
    let place = place_file(&[&format!("http://127.0.0.1:{port}")], &key.public_key, &mine.private_key_pem);
    let _d = place_daemon(&place, |_| {}).await;
    let proved = tokio::time::timeout(Duration::from_secs(5), proved_rx.recv()).await.expect("the place proved").unwrap();
    assert!(proved);
}

#[tokio::test]
async fn cuts_a_link_that_carried_no_frame_at_all_and_dials_again() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| {
        o.link_quiet_ms = Some(120);
        o.link_backoff_ms = Some(60_000);
    })
    .await;
    d.until_logged(|l| l == words::link_quiet(&host.url, 0)).await;
    // Dialling again is the backoff away, a minute here: the link is down and nothing has redialled yet.
    settled(100).await;
    assert_eq!(host.dials(), 1);
}

#[tokio::test]
async fn hands_the_host_a_daemon_that_answers_ping_and_pushes_only_frames_the_protocol_takes() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let _d = place_daemon(&place, |_| {}).await;
    let mut ws = host.held().await;
    let mut events = Vec::new();
    let answer = ask(&mut ws, 11, "ping", &mut events).await;
    assert_eq!(answer, json!({"id": 11, "ok": true}));
    // The hello the daemon pushes the moment the socket is served, which is what tells the host what it is talking to.
    assert!(events.iter().any(|e| e["type"] == "daemon.hello"), "{events:?}");
    for event in &events {
        serde_json::from_value::<DaemonEvent>(event.clone()).unwrap_or_else(|e| panic!("{event}: {e}"));
    }
}

#[tokio::test]
async fn on_the_link_the_machine_ops_are_the_runtimes_to_answer_and_inbound_the_roads_to_refuse() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |_| {}).await;
    let mut ws = host.held().await;
    let mut events = Vec::new();
    let answer = ask(&mut ws, 31, "machine.list", &mut events).await;
    assert_eq!(answer, json!({"id": 31, "ok": true, "machines": []}));
    // And an op a layer store answered is an op no more: this computer keeps no image, so the frame is named the
    // way any op this daemon does not serve is.
    let gone = ask(&mut ws, 32, "machine.listSnapshots", &mut events).await;
    assert_eq!(gone, json!({"id": 32, "ok": false, "error": words::unknown_op("machine.listSnapshots")}));
    // The same op on the place's own door, from a client holding its token, is answered exactly as the link's was:
    // the listing only reads, so which road it came in on makes no difference to it. Whatever this box answers on
    // the link is what is expected here, so the case reads the same on a box with a runtime and on one without.
    let (mut inbound, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/", d.port)).await.unwrap();
    inbound.send(Message::text(json!({"id": 1, "op": "auth", "token": "link-token"}).to_string())).await.unwrap();
    inbound.send(Message::text(json!({"id": 2, "op": "machine.list"}).to_string())).await.unwrap();
    let mut listed = answer.clone();
    listed["id"] = json!(2);
    assert_eq!(reply_with_id(&mut inbound, 2).await, listed);
    // An op that does something to a workspace is still the link's alone.
    inbound.send(Message::text(json!({"id": 3, "op": "machine.kill", "machineId": "wsp-x"}).to_string())).await.unwrap();
    assert_eq!(reply_with_id(&mut inbound, 3).await, json!({"id": 3, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD}));
}

/// The reply to one request off a socket, the events before it skipped.
async fn reply_with_id<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, id: u64) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    while let Some(Ok(Message::Text(text))) = socket.next().await {
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["id"] == id {
            return frame;
        }
    }
    panic!("the socket closed before it answered {id}")
}

#[tokio::test]
async fn answers_place_leave_with_what_the_sweep_took_and_then_ends_the_daemon() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let at = place_daemon_paths(place.home.path());
    // What a join and a daemon leave under the home: the token file beside the place file and its key.
    std::fs::write(&at.token_path, "a-token\n").unwrap();
    let d = place_daemon(&place, |_| {}).await;
    let mut ws = host.held().await;
    let mut events = Vec::new();
    let answer = ask(&mut ws, 21, "place.leave", &mut events).await;
    // The sweep is the real one over that home: the place file, its key and the token are gone and named, and
    // wsp's own folder goes last and whole, so nothing of wsp's is left under the home.
    let swept =
        json!([at.place_file.to_string_lossy(), at.place_key.to_string_lossy(), at.token_path.to_string_lossy(), at.wsp.to_string_lossy()]);
    assert_eq!(answer, json!({"id": 21, "ok": true, "swept": swept}));
    for path in [&at.place_file, &at.place_key, &at.token_path, &at.wsp] {
        assert!(!path.exists(), "{}", path.display());
    }
    // The daemon ends after the reply is on the wire, and nothing dials again: the sweep took what would bring it back.
    let run = &d.run;
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while !run.is_finished() {
            settled(10).await;
        }
    })
    .await;
    assert!(ended.is_ok(), "the daemon did not end after the leave");
    let dialed = host.dials();
    settled(150).await;
    assert_eq!(host.dials(), dialed);
}

#[test]
fn the_place_file_reads_back_what_was_written_and_a_file_that_is_not_one_reads_as_none() {
    let key = place_pair();
    let place = place_file(&["http://192.168.1.20:4400"], &key.public_key, &place_pair().private_key_pem);
    let text = std::fs::read_to_string(&place.file).unwrap();
    assert_eq!(wsp_frames::PlaceFile::parse(&text).unwrap().place_id, "p_ab12cd34");
    assert!(wsp_frames::PlaceFile::parse("not a place file").is_none());
    assert!(std::fs::read_to_string(format!("{}.nope", place.file.display())).is_err());
}

#[tokio::test]
async fn opens_with_its_own_half_of_the_key_agreement_and_seals_every_frame_it_sends_after_the_prove() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |_| {}).await;
    let mut held = host.held().await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    // Frame one carries the public value the key is agreed from, the length a key of this curve is.
    let auth = host.auths.lock().unwrap()[0].clone();
    let ephemeral = auth["ephemeral"].as_str().expect("the auth frame carries an ephemeral").to_owned();
    assert_eq!(B64.decode(&ephemeral).unwrap().len(), 32);
    // The prove and everything behind it are binary and open under the key both ends agreed: the hello the
    // daemon pushes the moment the socket is served, and the reply to an op asked on the link.
    let mut events = Vec::new();
    let answer = ask(&mut held, 11, "ping", &mut events).await;
    assert_eq!(answer, json!({"id": 11, "ok": true}));
    assert!(events.iter().any(|e| e["type"] == "daemon.hello"), "{events:?}");
}

#[tokio::test]
async fn passes_over_a_host_that_agreed_no_key_and_never_sends_it_a_prove() {
    let key = place_pair();
    let host = fake_place_host(HostOpts { key: Some(key), unsealed: true, ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    d.until_logged(|l| l == words::link_host_unsealed(&host.url)).await;
    settled(100).await;
    assert!(host.proofs.lock().unwrap().is_empty(), "the report went to a host that sealed nothing");
    assert!(!d.log().contains(&words::link_linked(&host.url)));
}

#[tokio::test]
async fn ends_the_socket_on_a_frame_sent_in_the_clear_after_the_seal_began() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.link_backoff_ms = Some(60_000)).await;
    let (mut ws, _) = host.held().await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    // A carrier writing into a sealed link: the bytes are a frame this daemon would answer, in the clear.
    ws.send(Message::text(json!({"id": 5, "op": "ping"}).to_string())).await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), async { while ws.next().await.is_some() {} }).await;
    assert!(ended.is_ok(), "the socket stayed open on a frame nobody sealed");
}

#[tokio::test]
async fn a_rotation_of_this_computers_own_token_leaves_the_link_alone() {
    let key = place_pair();
    let mut host = fake_place_host(HostOpts { key: Some(key), ..HostOpts::default() }).await;
    let place = place_file(&[&host.url], &host.public_key, &place_pair().private_key_pem);
    let d = place_daemon(&place, |o| o.token_watch_ms = Some(20)).await;
    let mut held = host.held().await;
    d.until_logged(|l| l == words::link_linked(&host.url)).await;
    // The link came through no door of this daemon's and carries no token, so a rotation of the file has nothing
    // of it to take: the host keeps the socket it is holding.
    std::fs::write(d.token.path(), "rotated-token\n").unwrap();
    settled(200).await;
    let mut events = Vec::new();
    assert_eq!(ask(&mut held, 41, "ping", &mut events).await, json!({"id": 41, "ok": true}));
}
