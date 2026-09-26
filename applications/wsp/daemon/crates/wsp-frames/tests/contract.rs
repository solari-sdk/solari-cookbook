// SPDX-License-Identifier: AGPL-3.0-only
//! The Rust half of the contract: the fixture set under daemon/fixtures/contract, which the protocol package's
//! own test reads with the zod schemas, read here with the serde types. Every accept frame must deserialize and
//! serialize back to the same JSON, every reject frame must fail, and every word and number must match.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use wsp_frames::{
    guest_wsp_shim, landed_files_script, numbers, place_owned_paths, probe_path, words, BackendFacts, CopyReport, DaemonAuthRequest,
    DaemonErrorResponse, DaemonEvent, DaemonRequest, GitPrReply, GitPrStateReply, GitPushReply, GuestCliMessage, GuestOpenReply,
    HostFolderListing, MachineAnswersReply, MachineExecReply, MachineHandleReply, MachineLinkRequest, MachineListReply, MachineReachReply,
    MachineReadingReply, MachineShapeReply, MachineStateReply, PlaceAuthRequest, PlaceCapacity, PlaceProveRequest, DAEMON_OPS, MACHINE_OPS,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contract")
}

fn read_frames(path: &Path) -> Vec<Value> {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let frames: Vec<Value> = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(!frames.is_empty(), "{} holds no frames", path.display());
    frames
}

/// Which files sit in a fixture folder, as (name, accept or reject, path).
fn cases(folder: &str) -> Vec<(String, bool, PathBuf)> {
    let dir = fixtures().join(folder);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        let file = path.file_name().unwrap().to_str().unwrap().to_owned();
        let (name, accept) = if let Some(n) = file.strip_suffix(".accept.json") {
            (n.to_owned(), true)
        } else if let Some(n) = file.strip_suffix(".reject.json") {
            (n.to_owned(), false)
        } else {
            panic!("{} is neither an accept nor a reject file", path.display());
        };
        out.push((name, accept, path));
    }
    out.sort();
    assert!(!out.is_empty(), "{} is empty", dir.display());
    out
}

/// Equal as JSON values, with numbers compared by value so 80 and 80.0 are one number.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w))),
        _ => a == b,
    }
}

fn round_trip<T: DeserializeOwned + Serialize>(frame: &Value, at: &str) -> Value {
    let parsed: T = serde_json::from_value(frame.clone()).unwrap_or_else(|e| panic!("{at}: refused an accept frame {frame}: {e}"));
    let back = serde_json::to_value(&parsed).unwrap();
    assert!(json_eq(frame, &back), "{at}: {frame} came back as {back}");
    back
}

fn refuses<T: DeserializeOwned>(frame: &Value, at: &str) {
    assert!(serde_json::from_value::<T>(frame.clone()).is_err(), "{at}: accepted a reject frame {frame}");
}

#[test]
fn every_request_frame_reads_as_the_protocol_does() {
    let mut seen = Vec::new();
    for (op, accept, path) in cases("frames") {
        let at = path.display().to_string();
        if accept {
            seen.push(op.clone());
        }
        for frame in read_frames(&path) {
            let tag = frame.get("op").and_then(Value::as_str).map(str::to_owned);
            match (op.as_str(), accept) {
                ("auth", true) => {
                    round_trip::<DaemonAuthRequest>(&frame, &at);
                }
                ("auth", false) => refuses::<DaemonAuthRequest>(&frame, &at),
                ("place.auth", true) => {
                    round_trip::<PlaceAuthRequest>(&frame, &at);
                }
                ("place.auth", false) => refuses::<PlaceAuthRequest>(&frame, &at),
                ("place.prove", true) => {
                    round_trip::<PlaceProveRequest>(&frame, &at);
                }
                ("place.prove", false) => refuses::<PlaceProveRequest>(&frame, &at),
                (name, true) if name.starts_with("machine.") => {
                    round_trip::<MachineLinkRequest>(&frame, &at);
                }
                (name, false) if name.starts_with("machine.") => refuses::<MachineLinkRequest>(&frame, &at),
                (_, true) => {
                    round_trip::<DaemonRequest>(&frame, &at);
                }
                (_, false) => refuses::<DaemonRequest>(&frame, &at),
            }
            if accept {
                assert_eq!(tag.as_deref(), Some(op.as_str()), "{at}: an accept frame names another op");
            }
        }
    }
    let mut expected: Vec<String> =
        DAEMON_OPS.iter().chain(MACHINE_OPS.iter()).chain(["auth", "place.auth", "place.prove"].iter()).map(|s| (*s).to_owned()).collect();
    expected.sort();
    assert_eq!(seen, expected, "every op has one accept file and every accept file names an op");
}

#[test]
fn every_event_frame_reads_as_the_protocol_does() {
    let mut seen = Vec::new();
    for (kind, accept, path) in cases("events") {
        let at = path.display().to_string();
        for frame in read_frames(&path) {
            if accept {
                let back = round_trip::<DaemonEvent>(&frame, &at);
                assert_eq!(back.get("type").and_then(Value::as_str), Some(kind.as_str()), "{at}: an accept frame names another type");
            } else {
                refuses::<DaemonEvent>(&frame, &at);
            }
        }
        if accept {
            seen.push(kind);
        }
    }
    let mut expected = vec![
        "browser.open",
        "callback.port",
        "daemon.hello",
        "guest.closed",
        "guest.message",
        "guest.opened",
        "inbox.file",
        "localhost.url",
        "port.close",
        "port.open",
        "proc.snapshot",
        "pty.data",
        "pty.exit",
        "pty.mode",
        "sys.sample",
        "tunnel.data",
        "tunnel.end",
    ];
    expected.sort_unstable();
    assert_eq!(seen, expected);
}

/// The replies a daemon answers the machine ops with, one file per protocol reply schema, each sample read into
/// the reply type here and written back to the same JSON. A file no type here reads is a reply this daemon does
/// not answer yet, and the test says so rather than skipping it.
#[test]
fn every_reply_fixture_round_trips_through_the_reply_types() {
    let dir = fixtures().join("replies");
    let mut seen = Vec::new();
    for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_str().unwrap().to_owned();
        let at = path.display().to_string();
        for sample in read_frames(&path) {
            match name.as_str() {
                "MachineBackendReply" => {
                    round_trip::<BackendFacts>(&sample, &at);
                }
                "MachineCapacityReply" => {
                    round_trip::<PlaceCapacity>(&sample, &at);
                }
                "MachineHandleReply" => {
                    round_trip::<MachineHandleReply>(&sample, &at);
                }
                "MachineListReply" => {
                    round_trip::<MachineListReply>(&sample, &at);
                }
                "MachineExecReply" => {
                    round_trip::<MachineExecReply>(&sample, &at);
                }
                "MachineStateReply" => {
                    round_trip::<MachineStateReply>(&sample, &at);
                }
                "MachineShapeReply" => {
                    round_trip::<MachineShapeReply>(&sample, &at);
                }
                "MachineReadingReply" => {
                    round_trip::<MachineReadingReply>(&sample, &at);
                }
                "MachineAnswersReply" => {
                    round_trip::<MachineAnswersReply>(&sample, &at);
                }
                "MachineReachReply" => {
                    round_trip::<MachineReachReply>(&sample, &at);
                }
                "CopyReport" => {
                    round_trip::<CopyReport>(&sample, &at);
                }
                "DaemonErrorResponse" => {
                    round_trip::<DaemonErrorResponse>(&sample, &at);
                }
                "GitPushReply" => {
                    round_trip::<GitPushReply>(&sample, &at);
                }
                "GitPrReply" => {
                    round_trip::<GitPrReply>(&sample, &at);
                }
                "GitPrStateReply" => {
                    round_trip::<GitPrStateReply>(&sample, &at);
                }
                "GuestOpenReply" => {
                    round_trip::<GuestOpenReply>(&sample, &at);
                }
                "GuestCliMessage" => {
                    round_trip::<GuestCliMessage>(&sample, &at);
                }
                "HostFolderListing" => {
                    round_trip::<HostFolderListing>(&sample, &at);
                }
                other => panic!("{at}: no reply type here reads {other}"),
            }
        }
        seen.push(name);
    }
    seen.sort();
    let mut expected = vec![
        "CopyReport",
        "DaemonErrorResponse",
        "GitPrReply",
        "GitPrStateReply",
        "GitPushReply",
        "GuestCliMessage",
        "GuestOpenReply",
        "HostFolderListing",
        "MachineAnswersReply",
        "MachineBackendReply",
        "MachineCapacityReply",
        "MachineExecReply",
        "MachineHandleReply",
        "MachineListReply",
        "MachineReachReply",
        "MachineReadingReply",
        "MachineShapeReply",
        "MachineStateReply",
    ];
    expected.sort_unstable();
    assert_eq!(seen, expected, "every reply this daemon answers has its fixture");
}

/// The fixture set is generated from the protocol package's exports, so its keys are that package's names and a
/// sentence with a hole in it is kept as a template whose braces name what the daemon fills in. This table is the
/// one place a Rust name meets a fixture key, and every hole is rendered with the same placeholder word the protocol
/// test renders it with, so the two halves compare the same text. Sentences the node daemon never emits and no
/// client matches on (the bin's failure prefix, the link's close reasons, the ready line) stay Rust-only.
fn rendered_words() -> BTreeMap<&'static str, String> {
    let mut m = BTreeMap::new();
    m.insert("tokenRefused", words::AUTH_TOKEN_REFUSED.to_owned());
    m.insert("firstFrameNotAuth", words::AUTH_FIRST_FRAME.to_owned());
    m.insert("preAuthBytesExceeded", words::AUTH_TOO_MANY_BYTES.to_owned());
    m.insert("authDeadlinePassed", words::AUTH_NO_FRAME_IN_TIME.to_owned());
    m.insert("tokenRotated", words::AUTH_TOKEN_ROTATED.to_owned());
    m.insert("invalidJson", words::INVALID_JSON.to_owned());
    m.insert("noToken", words::NO_TOKEN_AT_START.to_owned());
    m.insert("unknownOp", words::unknown_op("{op}"));
    m.insert("portScopeRefusal", words::port_scope_refusal("{port}"));
    m.insert("foldersOutside", words::folders_outside("{dir}", "{roots}"));
    m.insert("notOnThisRoad", words::NOT_ON_THIS_ROAD.to_owned());
    m.insert("notOnThisKind", words::NOT_ON_THIS_KIND.to_owned());
    m.insert("noImagesHere", words::NO_IMAGES_HERE.to_owned());
    m.insert("guestNotWatcher", words::GUEST_NOT_WATCHER.to_owned());
    m.insert("guestQueueFull", words::GUEST_QUEUE_FULL.to_owned());
    m.insert("guestInFlightFull", words::GUEST_IN_FLIGHT_FULL.to_owned());
    m.insert("guestWorkspaceFull", words::GUEST_WORKSPACE_FULL.to_owned());
    m.insert("guestUnwatched", words::GUEST_UNWATCHED.to_owned());
    m.insert("guestNoDaemon", words::guest_no_daemon_line("{port}"));
    m.insert("hostClosed", words::HOST_CLOSED.to_owned());
    m.insert("placeKeptForLink", words::place_kept_for_link("{path}"));
    m.insert("onBase", words::on_base_refusal("{base}"));
    m.insert("notOnABranch", words::NOT_ON_A_BRANCH.to_owned());
    m.insert("nothingAhead", words::nothing_ahead("{branch}", "{base}"));
    m.insert("noRemote", words::NO_REMOTE.to_owned());
    m.insert("noHostCli", words::no_host_cli("{host}"));
    m.insert("noGitCredential", words::no_git_credential("{host}", Some("{fix}")));
    m.insert("noGitCredentialNoFix", words::no_git_credential("{host}", None));
    m.insert("hostKeyRefusal", words::host_key_refusal("{url}"));
    m.insert("listening", words::listening_line("{host}", "{port}"));
    m.insert("sysSamplerStarted", words::SYS_SAMPLER_STARTED.to_owned());
    m.insert("sysSamplerStopped", words::SYS_SAMPLER_STOPPED.to_owned());
    m.insert("procSamplerStarted", words::PROC_SAMPLER_STARTED.to_owned());
    m.insert("procSamplerStopped", words::PROC_SAMPLER_STOPPED.to_owned());
    m.insert("noPlaceFile", words::NO_PLACE_FILE.to_owned());
    m.insert("linked", words::link_linked("{url}"));
    m.insert("hostQuiet", words::link_quiet("{url}", "{seconds}"));
    m.insert("dialUnanswered", words::link_no_answer_to_dial("{url}"));
    m.insert("dialTimedOut", words::link_no_answer_in("{url}", "{seconds}"));
    m.insert("dialFailed", words::link_could_not_dial("{url}", "{error}"));
    m.insert("notAFrame", words::link_not_a_frame("{url}"));
    m.insert("authUnreadable", words::link_unreadable_auth_reply("{url}", "{error}"));
    m.insert("hostRefused", words::link_refused("{url}", "{refusal}"));
    m.insert("linkOutOfOrder", words::link_out_of_order("{url}"));
    m.insert("linkHostUnsealed", words::link_host_unsealed("{url}"));
    m
}

/// The numbers the set pins, under the protocol's names. The run and log dirs, the exec timeout ceiling, the auth
/// close code and the second spelling of the open body cap are Rust-only until the protocol exports them.
fn rendered_numbers() -> BTreeMap<&'static str, Value> {
    let mut m = BTreeMap::new();
    m.insert("daemonVersion", Value::from(numbers::DAEMON_VERSION));
    m.insert("execBodyMax", Value::from(numbers::EXEC_BODY_MAX));
    m.insert("guestMessageCapBytes", Value::from(numbers::GUEST_MESSAGE_CAP_BYTES));
    m.insert("guestQueueCapFrames", Value::from(numbers::GUEST_QUEUE_CAP_FRAMES));
    m.insert("guestInFlightCapBytes", Value::from(numbers::GUEST_IN_FLIGHT_CAP_BYTES));
    m.insert("guestSessionsPerWorkspaceCap", Value::from(numbers::GUEST_SESSIONS_PER_WORKSPACE_CAP));
    m.insert("guestFrameCapBytes", Value::from(numbers::GUEST_FRAME_CAP_BYTES));
    m.insert("guestUnwatchedMs", Value::from(numbers::GUEST_UNWATCHED_MS));
    m.insert("guestTokenMax", Value::from(numbers::GUEST_TOKEN_MAX));
    m.insert("guestArgvMax", Value::from(numbers::GUEST_ARGV_MAX));
    m.insert("guestCwdMax", Value::from(numbers::GUEST_CWD_MAX));
    m.insert("execOutputMax", Value::from(numbers::EXEC_OUTPUT_MAX));
    m.insert("execTimeoutDefaultMs", Value::from(numbers::EXEC_TIMEOUT_DEFAULT_MS));
    m.insert("execDeadlineExit", Value::from(numbers::EXEC_DEADLINE_EXIT));
    m.insert("placeLinkNonceBytes", Value::from(numbers::PLACE_LINK_NONCE_BYTES));
    m.insert("preAuthMaxBytes", Value::from(numbers::PRE_AUTH_MAX_BYTES));
    m.insert("authDeadlineMs", Value::from(numbers::AUTH_DEADLINE_MS));
    m.insert("tunnelCap", Value::from(numbers::TUNNEL_CAP));
    m.insert("fsReadCapBytes", Value::from(numbers::FS_READ_CAP_BYTES));
    m.insert("fsListCapEntries", Value::from(numbers::FS_LIST_CAP_ENTRIES));
    m.insert("gitDiffCapBytes", Value::from(numbers::GIT_DIFF_CAP_BYTES));
    m.insert("ptyScrollbackCapBytes", Value::from(numbers::SCROLLBACK_CAP_BYTES));
    m.insert("procCmdlineBytes", Value::from(numbers::CMDLINE_BYTES));
    m.insert("portCommandBytes", Value::from(numbers::PORT_CMDLINE_CAP_BYTES));
    m.insert("procCap", Value::from(numbers::PROC_CAP));
    m.insert("pidMax", Value::from(numbers::PID_MAX));
    m.insert("openBodyMax", Value::from(numbers::OPEN_BODY_CAP));
    m.insert("daemonDefaultHost", Value::from(numbers::DEFAULT_HOST));
    m.insert("daemonDefaultPort", Value::from(numbers::DEFAULT_PORT));
    m.insert("daemonSamplerIntervalMs", Value::from(numbers::SAMPLER_INTERVAL_MS));
    m.insert("guestWspHome", Value::from(numbers::GUEST_WSP_HOME));
    m.insert("workspaceOverlaid", Value::from(numbers::OVERLAID.to_vec()));
    m.insert("homebrewHome", Value::from(numbers::HOMEBREW_HOME));
    m.insert("homebrewPrefix", Value::from(numbers::HOMEBREW_PREFIX));
    m.insert("sharedToolRoots", Value::from(numbers::SHARED_TOOL_ROOTS.to_vec()));
    m.insert("toolsPath", Value::from(numbers::TOOLS_PATH));
    m.insert("placeWorkspacePath", Value::from(numbers::PLACE_WORKSPACE_PATH));
    m.insert("daemonTokenPath", Value::from(numbers::DEFAULT_TOKEN_PATH));
    m.insert("daemonRootsPath", Value::from(numbers::DAEMON_ROOTS_PATH));
    m.insert("guestInboxDir", Value::from(numbers::DEFAULT_INBOX_DIR));
    m.insert("guestManifestPath", Value::from(numbers::DEFAULT_MANIFEST_PATH));
    m.insert("openShimPath", Value::from(numbers::OPEN_SHIM_PATH));
    m.insert("xdgOpenPath", Value::from(numbers::XDG_OPEN_PATH));
    m.insert("workspaceApparmorPath", Value::from(numbers::WORKSPACE_APPARMOR_PATH));
    m.insert("openSocketPath", Value::from(numbers::OPEN_SOCKET_PATH));
    m.insert("guestDaemonSocketPath", Value::from(numbers::GUEST_DAEMON_SOCKET_PATH));
    m.insert("guestDaemonDir", Value::from(numbers::GUEST_DAEMON_DIR));
    m.insert("guestWspPath", Value::from(numbers::GUEST_WSP_PATH));
    m.insert("daemonOomScoreAdj", Value::from(numbers::DAEMON_OOM_SCORE_ADJ));
    m.insert("daemonNice", Value::from(numbers::DAEMON_NICE));
    m.insert("workOomScoreAdj", Value::from(numbers::WORK_OOM_SCORE_ADJ));
    m.insert("workScoreLine", Value::from(numbers::work_score_line()));
    m.insert("cacheDirs", Value::from(numbers::CACHE_DIRS.to_vec()));
    m.insert("repoDepth", Value::from(numbers::REPO_DEPTH));
    m.insert("repoCap", Value::from(numbers::REPO_CAP));
    m
}

fn committed<T: DeserializeOwned>(file: &str) -> BTreeMap<String, T> {
    let path = fixtures().join(file);
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// One committed fixture read as whatever shape it holds, for the ones that are not a map of names to sentences.
fn committed_value<T: DeserializeOwned>(file: &str) -> T {
    let path = fixtures().join(file);
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn every_word_matches_the_committed_fixture() {
    let ours = rendered_words();
    let theirs: BTreeMap<String, String> = committed("words.json");
    let our_keys: Vec<&str> = ours.keys().copied().collect();
    let their_keys: Vec<&str> = theirs.keys().map(String::as_str).collect();
    assert_eq!(our_keys, their_keys, "words.json and the Rust words name the same sentences");
    for (key, sentence) in &ours {
        assert_eq!(&theirs[*key], sentence, "words.json[{key}]");
    }
}

/// The home the owned-paths fixture is rendered for, as the protocol's own test renders it: one letter, so the
/// list reads as the shape of the paths rather than as somebody's login.
const FIXTURE_HOME: &str = "/h";

/// The home the ownership read's fixture is rendered for: the hole its one substitution goes in, as a word with a
/// value in it is kept as its template everywhere else in this set.
const SCRIPT_HOME: &str = "{home}";

/// The binary the wsp shim's fixture is rendered onto: the shim's one hole, kept as its template the same way.
const SHIM_BINARY: &str = "{binary}";

#[test]
fn the_leaves_own_list_matches_the_committed_fixture() {
    let theirs: Vec<String> = committed_value("place-paths.json");
    let ours: Vec<String> = place_owned_paths(Path::new(FIXTURE_HOME)).iter().map(|p| p.to_string_lossy().into_owned()).collect();
    assert_eq!(ours, theirs, "place-paths.json and place_owned_paths name the same paths in the same order");
}

/// The home the probe path's fixture is rendered for, as the protocol's own test renders it: root's, since every
/// directory the tools PATH names under a home is under that one.
const PROBE_HOME: &str = "/root";

#[test]
fn the_probe_path_matches_the_committed_fixture_byte_for_byte() {
    let path = fixtures().join("probe-path.txt");
    let theirs = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(
        format!("{}\n", probe_path(Path::new(PROBE_HOME))),
        theirs,
        "probe-path.txt and probe_path are one list: what this daemon resolves a command through and what the recipe job exports"
    );
}

#[test]
fn the_ownership_read_matches_the_committed_fixture_byte_for_byte() {
    let path = fixtures().join("landed-files.sh");
    let theirs = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(
        format!("{}\n", landed_files_script(Path::new(SCRIPT_HOME))),
        theirs,
        "landed-files.sh and landed_files_script are one script"
    );
}

#[test]
fn the_wsp_shim_matches_the_committed_fixture_byte_for_byte() {
    let path = fixtures().join("guest-wsp-shim.sh");
    let theirs = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(guest_wsp_shim(SHIM_BINARY), theirs, "guest-wsp-shim.sh and guest_wsp_shim are one text");
}

#[test]
fn every_number_matches_the_committed_fixture() {
    let ours = rendered_numbers();
    let theirs: BTreeMap<String, Value> = committed("numbers.json");
    let our_keys: Vec<&str> = ours.keys().copied().collect();
    let their_keys: Vec<&str> = theirs.keys().map(String::as_str).collect();
    assert_eq!(our_keys, their_keys, "numbers.json and the Rust numbers name the same constants");
    for (key, value) in &ours {
        assert!(json_eq(&theirs[*key], value), "numbers.json[{key}] is {} here and {} there", value, theirs[*key]);
    }
}
