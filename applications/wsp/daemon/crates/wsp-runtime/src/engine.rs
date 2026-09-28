// SPDX-License-Identifier: AGPL-3.0-only
//! The fenced engine socket: a workspace that asked for one gets a Unix socket at the path a Docker client
//! expects, served by this daemon as one HTTP proxy over the box's own engine socket. What passes: the container,
//! image, network, volume, exec, logs and attach routes, ping and version. Nothing under /plugins, /swarm or
//! /system, no build and no info: the engine is one blast radius on the box, and the socket a workspace holds is
//! its own containers alone. Every create is labelled with the workspace's id and every listing filtered by it,
//! every route naming a container, an exec, a network or a volume is refused unless that thing wears the label,
//! and a create that asks for the box (privileged, capabilities, devices, security options, the box's pid, ipc or
//! network namespace, a bind outside the workspace's project folders) is refused with one sentence. Published
//! ports land on the box's loopback at a port the engine picks, and the workspace reaches each at
//! 127.0.0.1:<the port it asked for> through a listener this daemon holds inside its network namespace. Images
//! stay shared: what one workspace pulls, every workspace and the box see.
//!
//! One engine connection per client request, both sides told to close: the Docker client pools connections and
//! sends its next request on an idle one, and the head of every request has to be read here, so keep-alive is
//! turned off rather than framed. What the client sends after the head is copied on within the request's own
//! framing, its Content-Length or its chunks, and not one byte past it: a second request pipelined behind the
//! body reaches nothing. Nothing on this side is closed toward the engine before the engine has answered, since
//! its server reads a half closed request as the client gone and cancels the handler under it; the close forced
//! on the forwarded head is what ends the answer and the connection. The two routes the engine may hand a
//! connection over on, an attach and an exec start, keep their connection headers and are copied raw once the
//! engine has taken them; an upgrade asked for on any other route is dropped from the head before it goes.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use crate::doctor::{Engine, Facts};

/// The label every container, network and volume a workspace makes wears, with the workspace's id as its value.
pub const LABEL: &str = "wsp.workspace";
/// The ports a container's create asked for on the workspace's loopback, `80/tcp=18080,...`, kept on the container
/// since the engine binds an ephemeral port on the box instead and the two are joined after the start.
pub const PORTS_LABEL: &str = "wsp.ports";
/// Where the socket's directory is bound inside the workspace.
pub const INSIDE_DIR: &str = "/run/wsp";
pub const SOCKET_NAME: &str = "docker.sock";
/// The path a Docker client dials, a symlink into `INSIDE_DIR`: /var/run is /run on the images a workspace runs.
pub const CLIENT_PATH: &str = "/run/docker.sock";
/// The doctor's sentence on a box with no engine, which a create that asked for one is refused with.
pub const NO_ENGINE: &str =
    "this computer has no container engine; a project's docker compose runs here once you install Docker or podman on it";
const DOCKER_SOCKET: &str = "/var/run/docker.sock";
const PODMAN_SOCKET: &str = "/run/podman/podman.sock";
/// The most a request body read here may weigh; a compose service's create body is a few kilobytes.
const BODY_MAX: usize = 4 * 1024 * 1024;
const HEAD_MAX: usize = 64 * 1024;
const LOOPBACK: &str = "127.0.0.1";
/// The three network modes the engine reads as its own default bridge, which is the box's and shared with every
/// container on it: each is rewritten to the workspace's own network.
const DEFAULT_NETWORKS: [&str; 3] = ["", "default", "bridge"];
/// The mode that is no network at all, which passes as it came.
const NO_NETWORK: &str = "none";

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Error {
        Error(e.to_string())
    }
}

/// The engine's socket on the box, by the engine the doctor found.
pub fn engine_socket(engine: Engine) -> Option<&'static Path> {
    match engine {
        Engine::None => None,
        Engine::Docker => Some(Path::new(DOCKER_SOCKET)),
        Engine::Podman => Some(Path::new(PODMAN_SOCKET)),
    }
}

/// The socket a workspace's proxy dials, or the one sentence a create asking for an engine is refused with.
pub fn socket_of(facts: &Facts) -> Result<PathBuf, String> {
    let socket = engine_socket(facts.engine).ok_or_else(|| NO_ENGINE.to_owned())?;
    if !socket.exists() {
        return Err(format!(
            "{} is on this computer but its socket {} is not there; start its service and a workspace's socket follows",
            facts.engine.word(),
            socket.display()
        ));
    }
    Ok(socket.to_path_buf())
}

/// What a request is, off its method and path, before its body is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Forwarded as it came: ping, version, and every image route.
    Pass,
    Refused(String),
    /// A container create: fenced and labelled.
    Create,
    /// A listing, filtered to the workspace's label: containers, networks, volumes, events.
    List,
    /// A network create: fenced and labelled.
    NetworkCreate,
    /// A volume create: fenced and labelled.
    VolumeCreate,
    /// A route naming one container, which must be the workspace's; `verb` is what follows the id.
    Container {
        id: String,
        verb: Option<String>,
    },
    /// A route naming one exec, whose container must be the workspace's; `verb` is what follows the id.
    Exec {
        id: String,
        verb: Option<String>,
    },
    Network {
        id: String,
        verb: Option<String>,
    },
    Volume {
        name: String,
    },
}

impl Route {
    /// Whether the engine may answer this request by handing the connection over: the two routes a Docker client
    /// attaches a terminal through, and no other. Every other route's answer is one response, so an upgrade asked
    /// for on one of them is a raw pipe to the box's engine and is not passed on.
    pub fn hijacks(&self, method: &str) -> bool {
        match self {
            Route::Container { verb, .. } => method == "POST" && verb.as_deref() == Some("attach"),
            Route::Exec { verb, .. } => method == "POST" && verb.as_deref() == Some("start"),
            _ => false,
        }
    }
}

fn not_served(path: &str) -> String {
    format!("{path} is not served on a workspace's socket, which serves its own containers, images, networks, volumes and execs alone")
}

/// The route of one request. The versioned prefix Docker clients send is dropped for the reading and kept on the wire.
pub fn route(method: &str, path: &str) -> Route {
    let bare = path.split('?').next().unwrap_or(path);
    let mut segments: Vec<&str> = bare.split('/').filter(|s| !s.is_empty()).collect();
    if segments.first().is_some_and(|s| s.starts_with("v1.")) {
        segments.remove(0);
    }
    let seg = |i: usize| segments.get(i).copied();
    match (seg(0), seg(1), seg(2)) {
        (Some("_ping"), None, _) | (Some("version"), None, _) => Route::Pass,
        (Some("images"), _, _) => Route::Pass,
        (Some("events"), None, _) => Route::List,
        (Some("build"), _, _) | (Some("session"), _, _) => Route::Refused(
            "image builds are not served on a workspace's socket yet; pull the image, or build it on the computer itself".into(),
        ),
        (Some("containers"), Some("create"), None) if method == "POST" => Route::Create,
        (Some("containers"), Some("json"), None) => Route::List,
        (Some("containers"), Some("prune"), None) | (Some("networks"), Some("prune"), None) | (Some("volumes"), Some("prune"), None) => {
            Route::Refused(format!("{bare} reaches everything on this computer; remove the workspace's own by name"))
        }
        (Some("containers"), Some(id), verb) => Route::Container { id: id.to_owned(), verb: verb.map(str::to_owned) },
        (Some("exec"), Some(id), verb) => Route::Exec { id: id.to_owned(), verb: verb.map(str::to_owned) },
        (Some("networks"), None, _) => Route::List,
        (Some("networks"), Some("create"), None) if method == "POST" => Route::NetworkCreate,
        (Some("networks"), Some(id), verb) => Route::Network { id: id.to_owned(), verb: verb.map(str::to_owned) },
        (Some("volumes"), None, _) => Route::List,
        (Some("volumes"), Some("create"), None) if method == "POST" => Route::VolumeCreate,
        (Some("volumes"), Some(name), None) => Route::Volume { name: name.to_owned() },
        _ => Route::Refused(not_served(bare)),
    }
}

/// What a fenced create body named beyond itself: the containers, networks and named volumes it attaches, each
/// checked for the label before the create goes, and the ports it asked for on the workspace's loopback.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Fenced {
    pub ports: BTreeMap<String, u16>,
    pub containers: Vec<String>,
    pub networks: Vec<String>,
    pub volumes: Vec<String>,
}

fn non_empty(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        Some(Value::Null) | None => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn word(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// The workspace's own default network, which every container of it that asked for no network of its own joins.
pub fn default_network(workspace: &str) -> String {
    format!("wsp-{workspace}")
}

/// What compose adds to a project's name for the network a stack that named none of its own runs on. The project
/// is `compose_project` of the workspace's id, so that word and this suffix are the one network a workspace's
/// own stack derives for itself.
const COMPOSE_DEFAULT: &str = "_default";

/// The name the box's link for one of a workspace's networks wears: under the prefix every rule of the
/// workspace table matches, so a container on it meets the same drops the workspace does, and short enough for
/// an interface name. Off the workspace and the network's own name, so one network asked for twice is one
/// bridge; a box already holding a link by that name refuses the create, which is a collision saying so.
fn bridge_name(workspace: &str, network: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in workspace.bytes().chain(std::iter::once(b'/')).chain(network.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{}e{:08x}", crate::net::LINK_PREFIX, hash as u32)
}

/// Whether a subnet a create asked for shares an address with the range every workspace's own network draws
/// from: two blocks overlap where each masked to the shorter of the two prefixes is the same network.
fn overlaps_workspaces(subnet: &str) -> Option<bool> {
    let (address, prefix) = subnet.split_once('/')?;
    let address: std::net::Ipv4Addr = address.parse().ok()?;
    let prefix: u8 = prefix.parse().ok().filter(|p| *p <= 32)?;
    let shorter = prefix.min(crate::net::RANGE_PREFIX);
    let mask = if shorter == 0 { 0 } else { u32::MAX << (32 - u32::from(shorter)) };
    Some(u32::from(address) & mask == u32::from(crate::net::RANGE) & mask)
}

/// The fence over a network create: a workspace's network is an IPv4 bridge of its own whose link on the box the
/// fence names, since the rules that keep a workspace off the box's metadata and off its neighbours match on that
/// name. Answers the bridge name the engine is being told to make.
pub fn fence_network_create(body: &mut Value, workspace: &str) -> Result<String, String> {
    // Two names belong to a workspace on this box and to nobody else: the one this computer mints for its own
    // default network, `default_network`, which reads as the link prefix twice over since every id is itself
    // under the prefix; and the one its `compose up` derives, which is the project compose was handed and this
    // suffix. The project is `compose_project` of the workspace's id and not the id itself, since an id may
    // carry a character compose does not take, so the stem is read against that one function. A workspace
    // holding either of a sibling's would refuse that sibling every plain container it starts, or its whole
    // stack at the network step. What the rule leaves: every other name under the prefix is this workspace's to
    // take, and two workspaces reaching for one such name meet the engine's own refusal of a name already held
    // rather than anything here.
    let asked = word(body.get("Name"));
    let derived = asked.strip_suffix(COMPOSE_DEFAULT).filter(|stem| stem.starts_with(crate::net::LINK_PREFIX));
    if let Some(stem) = derived {
        if stem != crate::ops::compose_project(workspace) {
            return Err(format!(
                "a network named {asked} is the one the workspace whose compose project is {stem} brings its own stack up on, so it is refused here"
            ));
        }
    } else if asked.starts_with(&default_network(crate::net::LINK_PREFIX)) {
        return Err(format!("a network named {asked} is one this computer makes for a workspace of its own, so it is refused here"));
    }
    let driver = word(body.get("Driver"));
    if !matches!(driver, "" | "bridge") {
        return Err(format!("a workspace's network is a bridge of its own on this computer; the driver {driver} is refused"));
    }
    if body.get("EnableIPv6").and_then(Value::as_bool) == Some(true) {
        return Err("a workspace's network carries IPv4 alone; EnableIPv6 is refused".into());
    }
    // Written and not merely left out: a box whose engine turns IPv6 on by default would give the bridge a
    // range the table that fences a workspace never sees.
    body["EnableIPv6"] = Value::Bool(false);
    for config in body.pointer("/IPAM/Config").and_then(Value::as_array).into_iter().flatten() {
        let subnet = word(config.get("Subnet"));
        if subnet.is_empty() {
            continue;
        }
        match overlaps_workspaces(subnet) {
            Some(false) => {}
            Some(true) => {
                return Err(format!(
                    "a workspace's network takes no address out of the range the workspaces themselves are on; the subnet {subnet} overlaps {}/{}",
                    crate::net::RANGE,
                    crate::net::RANGE_PREFIX
                ))
            }
            None => return Err(format!("a workspace's network names its subnet as an address and a prefix, and {subnet} is not one")),
        }
    }
    name_the_bridge(body, workspace)
}

/// The link the engine is told to make this network on, written into its options: under the prefix every rule of
/// the workspace table matches, so a container on it meets the same drops the workspace does. The one road to a
/// bridge name, read by a create a workspace sent and by the workspace's own default network alike.
fn name_the_bridge(body: &mut Value, workspace: &str) -> Result<String, String> {
    let bridge = bridge_name(workspace, word(body.get("Name")));
    let options =
        body.as_object_mut().ok_or_else(|| "a create carries a JSON object".to_owned())?.entry("Options").or_insert_with(|| json!({}));
    if options.is_null() {
        *options = json!({});
    }
    let options = options.as_object_mut().ok_or_else(|| "Options is an object".to_owned())?;
    if options.contains_key(BRIDGE_NAME) {
        return Err(format!("a workspace's network is named by this computer; {BRIDGE_NAME} is refused"));
    }
    options.insert(BRIDGE_NAME.into(), Value::String(bridge.clone()));
    Ok(bridge)
}

/// The engine option naming the link a bridge network is made on.
const BRIDGE_NAME: &str = "com.docker.network.bridge.name";

/// A container another container shares a namespace or volumes with, off `container:<id>` or `<id>[:ro]`.
fn named_container(mode: &str) -> Option<String> {
    mode.strip_prefix("container:").map(|rest| rest.split(':').next().unwrap_or(rest).to_owned())
}

/// The fence over a container create: the body is rewritten in place and what it named beyond itself answered, or
/// the one sentence the create is refused with. `map_bind` turns a bind source inside the workspace into the box
/// path the engine mounts, or refuses it.
pub fn fence_create(body: &mut Value, workspace: &str, map_bind: &dyn Fn(&str) -> Result<PathBuf, String>) -> Result<Fenced, String> {
    let mut fenced = Fenced::default();
    if !body.is_object() {
        return Err("a container create carries a JSON object".into());
    }
    let host = body.get("HostConfig").cloned().unwrap_or_else(|| json!({}));
    if host.get("Privileged").and_then(Value::as_bool) == Some(true) {
        return Err("a privileged container is root on this computer, so a workspace cannot ask for one".into());
    }
    if non_empty(host.get("CapAdd")) {
        return Err("a workspace's container runs with the engine's default capabilities; CapAdd is refused".into());
    }
    if non_empty(host.get("Devices")) || non_empty(host.get("DeviceRequests")) || non_empty(host.get("DeviceCgroupRules")) {
        return Err("a workspace's container gets no device of this computer; Devices is refused".into());
    }
    if non_empty(host.get("SecurityOpt")) {
        return Err("a workspace's container keeps the engine's seccomp and AppArmor defaults; SecurityOpt is refused".into());
    }
    if host.get("PublishAllPorts").and_then(Value::as_bool) == Some(true) {
        return Err("a workspace publishes ports one by one on this computer's loopback; PublishAllPorts is refused".into());
    }
    let pid = word(host.get("PidMode"));
    match pid {
        "" => {}
        "host" => return Err("a workspace's container cannot share this computer's pid namespace; PidMode host is refused".into()),
        _ => match named_container(pid) {
            Some(id) => fenced.containers.push(id),
            None => return Err(format!("PidMode {pid} is not one a workspace's container may ask for")),
        },
    }
    let ipc = word(host.get("IpcMode"));
    match ipc {
        "" | "none" | "private" | "shareable" => {}
        "host" => return Err("a workspace's container cannot share this computer's ipc namespace; IpcMode host is refused".into()),
        _ => match named_container(ipc) {
            Some(id) => fenced.containers.push(id),
            None => return Err(format!("IpcMode {ipc} is not one a workspace's container may ask for")),
        },
    }
    let network = word(host.get("NetworkMode"));
    if network == "host" {
        return Err("a workspace's container cannot join this computer's network; NetworkMode host is refused".into());
    }
    // The engine's default bridge is the box's, shared with every container on it and outside every rule that
    // keeps a workspace off the box's metadata and off its neighbours, so the three words naming it are read as
    // the workspace's own network instead.
    let own_default = default_network(workspace);
    let mut mode = None;
    if let Some(id) = named_container(network) {
        fenced.containers.push(id);
    } else if network != NO_NETWORK {
        let named = if DEFAULT_NETWORKS.contains(&network) { own_default.clone() } else { network.to_owned() };
        mode = Some(named.clone());
        fenced.networks.push(named);
    }
    if let Some(endpoints) = body.pointer_mut("/NetworkingConfig/EndpointsConfig").and_then(Value::as_object_mut) {
        for plain in DEFAULT_NETWORKS {
            if let Some(held) = endpoints.remove(plain) {
                endpoints.insert(own_default.clone(), held);
            }
        }
        fenced.networks.extend(endpoints.keys().filter(|k| *k != NO_NETWORK).cloned());
    }
    for from in host.get("VolumesFrom").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = from.as_str().map(|s| s.split(':').next().unwrap_or(s)) {
            fenced.containers.push(id.to_owned());
        }
    }
    let mut binds = Vec::new();
    for bind in host.get("Binds").and_then(Value::as_array).into_iter().flatten() {
        let Some(text) = bind.as_str() else { return Err("a bind is a string of the form source:destination".into()) };
        let (source, rest) = text.split_once(':').ok_or_else(|| format!("{text} is not a bind of the form source:destination"))?;
        if source.starts_with('/') {
            let mapped = map_bind(source)?;
            binds.push(Value::String(format!("{}:{rest}", mapped.display())));
        } else {
            fenced.volumes.push(source.to_owned());
            binds.push(bind.clone());
        }
    }
    let mut mounts = Vec::new();
    for mount in host.get("Mounts").and_then(Value::as_array).into_iter().flatten() {
        let mut mount = mount.clone();
        match word(mount.get("Type")) {
            "bind" => {
                let source = word(mount.get("Source")).to_owned();
                let mapped = map_bind(&source)?;
                mount["Source"] = Value::String(mapped.display().to_string());
            }
            "volume" => {
                let config = mount.pointer("/VolumeOptions/DriverConfig");
                plain_volume(word(config.and_then(|c| c.get("Name"))), config.and_then(|c| c.get("Options")))?;
                // An anonymous volume names none and goes with the container, as the engine makes it.
                let named = word(mount.get("Source"));
                if !named.is_empty() {
                    fenced.volumes.push(named.to_owned());
                }
            }
            "tmpfs" => {}
            other => {
                return Err(format!("a workspace's container mounts a bind, a volume or a tmpfs; a mount of kind {other:?} is refused"))
            }
        }
        mounts.push(mount);
    }
    let mut bindings = serde_json::Map::new();
    for (port, given) in host.get("PortBindings").and_then(Value::as_object).into_iter().flatten() {
        let asked = given
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|b| b.get("HostPort").and_then(Value::as_str).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0));
        if let Some(asked) = asked {
            fenced.ports.insert(port.clone(), asked);
        }
        bindings.insert(port.clone(), json!([{ "HostIp": LOOPBACK, "HostPort": "" }]));
    }
    let host_config = body.as_object_mut().and_then(|o| o.entry("HostConfig").or_insert_with(|| json!({})).as_object_mut());
    if let Some(host_config) = host_config {
        if let Some(mode) = mode {
            host_config.insert("NetworkMode".into(), Value::String(mode));
        }
        if !binds.is_empty() {
            host_config.insert("Binds".into(), Value::Array(binds));
        }
        if !mounts.is_empty() {
            host_config.insert("Mounts".into(), Value::Array(mounts));
        }
        if !bindings.is_empty() {
            host_config.insert("PortBindings".into(), Value::Object(bindings));
        }
    }
    let labels = body.as_object_mut().and_then(|o| o.entry("Labels").or_insert_with(|| json!({})).as_object_mut());
    if let Some(labels) = labels {
        labels.insert(LABEL.into(), Value::String(workspace.to_owned()));
        if !fenced.ports.is_empty() {
            labels.insert(PORTS_LABEL.into(), Value::String(ports_word(&fenced.ports)));
        }
    }
    // Compose names its network in NetworkMode and in EndpointsConfig both; each name is checked once.
    for named in [&mut fenced.containers, &mut fenced.networks, &mut fenced.volumes] {
        named.sort_unstable();
        named.dedup();
    }
    Ok(fenced)
}

fn ports_word(ports: &BTreeMap<String, u16>) -> String {
    ports.iter().map(|(port, asked)| format!("{port}={asked}")).collect::<Vec<_>>().join(",")
}

fn ports_of_word(word: &str) -> BTreeMap<String, u16> {
    word.split(',')
        .filter_map(|pair| {
            let (port, asked) = pair.split_once('=')?;
            Some((port.to_owned(), asked.parse().ok()?))
        })
        .collect()
}

/// A volume a workspace makes is the engine's own plain local volume: another driver, or a driver option, names
/// a path or a server of the box's, and the rootful engine mounts it for the workspace wherever it points. Read
/// off a volume create and off the driver config a container create may carry inline, which are the two roads to
/// the same mount.
fn plain_volume(driver: &str, options: Option<&Value>) -> Result<(), String> {
    let keys: Vec<&str> = options.and_then(Value::as_object).map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
    let asked = if !keys.is_empty() {
        format!("driver options ({})", keys.join(", "))
    } else if matches!(driver, "" | "local") {
        return Ok(());
    } else {
        format!("the driver {driver}")
    };
    Err(format!("a workspace's volume is a plain local volume, and this one asks for {asked}"))
}

/// The fence over an exec create: a privileged exec is root on the box as a privileged container is.
pub fn fence_exec(body: &Value) -> Result<(), String> {
    if body.get("Privileged").and_then(Value::as_bool) == Some(true) {
        return Err("a privileged exec is root on this computer, so a workspace cannot ask for one".into());
    }
    Ok(())
}

/// A network or volume create with the workspace's label on it.
pub fn label_create(body: &mut Value, workspace: &str) -> Result<(), String> {
    let labels =
        body.as_object_mut().ok_or_else(|| "a create carries a JSON object".to_owned())?.entry("Labels").or_insert_with(|| json!({}));
    if labels.is_null() {
        *labels = json!({});
    }
    labels.as_object_mut().ok_or_else(|| "Labels is an object".to_owned())?.insert(LABEL.into(), Value::String(workspace.to_owned()));
    Ok(())
}

/// The query of a listing with the workspace's label added to its filters, whatever filters it carried.
pub fn filtered_query(query: Option<&str>, workspace: &str) -> Result<String, String> {
    let want = format!("{LABEL}={workspace}");
    let mut parts: Vec<String> = Vec::new();
    let mut filtered = false;
    for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "filters" {
            parts.push(pair.to_owned());
            continue;
        }
        let text = percent_decode_str(value).decode_utf8().map_err(|e| format!("filters: {e}"))?;
        let mut filters: Value = serde_json::from_str(&text).map_err(|e| format!("filters: {e}"))?;
        let object = filters.as_object_mut().ok_or_else(|| "filters is a JSON object".to_owned())?;
        // The engine refuses one filters object in two forms, and compose sends the older map form.
        let map_form = object.values().any(Value::is_object);
        match object.get_mut("label") {
            Some(Value::Array(labels)) => labels.push(Value::String(want.clone())),
            Some(Value::Object(labels)) => {
                labels.insert(want.clone(), Value::Bool(true));
            }
            _ if map_form => {
                object.insert("label".into(), json!({ want.clone(): true }));
            }
            _ => {
                object.insert("label".into(), json!([want]));
            }
        }
        parts.push(format!("filters={}", utf8_percent_encode(&filters.to_string(), NON_ALPHANUMERIC)));
        filtered = true;
    }
    if !filtered {
        parts.push(format!("filters={}", utf8_percent_encode(&json!({ "label": [want] }).to_string(), NON_ALPHANUMERIC)));
    }
    Ok(parts.join("&"))
}

/// A path opened beneath a directory with no link followed anywhere in it: the kernel refuses the open where a
/// component is a link or a magic link and where the path would leave the directory, so what the descriptor
/// holds is the inode at that path under that directory and nothing else. Opened for its path alone, which is
/// what a bind mounts through and what a stat reads.
fn open_beneath(dir: &Path, at: &str) -> io::Result<std::os::fd::OwnedFd> {
    let under = at.trim_start_matches('/');
    let under = if under.is_empty() { "." } else { under };
    let how = nix::fcntl::OpenHow::new().flags(nix::fcntl::OFlag::O_PATH | nix::fcntl::OFlag::O_CLOEXEC).resolve(
        nix::fcntl::ResolveFlag::RESOLVE_BENEATH
            | nix::fcntl::ResolveFlag::RESOLVE_NO_SYMLINKS
            | nix::fcntl::ResolveFlag::RESOLVE_NO_MAGICLINKS,
    );
    let root = fs::File::open(dir)?;
    nix::fcntl::openat2(&root, under, how).map_err(io::Error::from)
}

/// The same, with the one sentence a bind source is refused with: a link met on the way and a path that would
/// leave the directory are the road this fence closes, and anything else is the path not being there.
fn beneath(dir: &Path, at: &str, source: &str) -> Result<std::os::fd::OwnedFd, String> {
    open_beneath(dir, at).map_err(|e| {
        let loop_or_out = [nix::errno::Errno::ELOOP as i32, nix::errno::Errno::EXDEV as i32];
        if e.raw_os_error().is_some_and(|code| loop_or_out.contains(&code)) {
            format!("{source} is reached through a link inside the workspace, and a container binds nothing through a link")
        } else {
            format!("{source} is not there in the workspace")
        }
    })
}

/// One bind source staged for the engine: the entry it is bound at, which is the path the create carries on,
/// and the descriptor the source was opened at, which is the inode the bind lands on.
#[derive(Debug)]
pub struct Staged {
    pub at: PathBuf,
    pub source: std::os::fd::OwnedFd,
}

/// Where the engine mounts a bind source from, for a source inside the workspace. Three walls in order: the
/// source is a plain path and opens beneath the rootfs with no link followed, so nothing the workspace planted
/// under its own project resolves out of it; its path sits under one of the folders the workspace's own record
/// says its containers may bind; and the remainder opens beneath that folder on the box the same way and is
/// staged at `binds/<at>`, an entry under a directory nothing inside the workspace reaches. What the engine is
/// handed is that entry: the engine resolves a bind source again at every container start, so a path this fence
/// only read would be a path the workspace swapped in between.
pub fn map_bind(rootfs: &Path, roots: &[(String, PathBuf)], binds: &Path, at: &str, source: &str) -> Result<Staged, String> {
    if roots.is_empty() {
        return Err(format!("this workspace has no project folder yet, so a container can bind nothing of it; {source} is refused"));
    }
    if !wsp_frames::is_plain_path(source) {
        return Err(format!("a bind mount's source is an absolute path inside the workspace, and {source} is not"));
    }
    drop(beneath(rootfs, source, source)?);
    let under = |root: &str| {
        let rest = source.strip_prefix(root)?;
        (rest.is_empty() || rest.starts_with('/')).then(|| rest.trim_start_matches('/').to_owned())
    };
    let Some((rest, root)) = roots.iter().find_map(|(inside, on_box)| Some((under(inside)?, on_box))) else {
        let named: Vec<&str> = roots.iter().map(|(inside, _)| inside.as_str()).collect();
        return Err(format!(
            "a bind mount's source must sit under a project folder of this workspace ({}), and {source} does not",
            named.join(", ")
        ));
    };
    let opened = beneath(root, &rest, source)?;
    let staged = stage(binds, at, &opened)?;
    Ok(Staged { at: staged, source: opened })
}

/// The entry one bind source is staged at, made through a descriptor of the staging directory: a directory for
/// a directory and an empty file for anything else, since a bind wants the same kind at both ends.
fn stage(binds: &Path, at: &str, source: &std::os::fd::OwnedFd) -> Result<PathBuf, String> {
    let held = nix::sys::stat::fstat(source).map_err(|e| format!("the bind source could not be read: {e}"))?;
    let directory = nix::sys::stat::SFlag::from_bits_truncate(held.st_mode).contains(nix::sys::stat::SFlag::S_IFDIR);
    let dir = fs::File::open(binds).map_err(|e| format!("{}: {e}", binds.display()))?;
    let made = if directory {
        nix::sys::stat::mkdirat(&dir, at, nix::sys::stat::Mode::from_bits_truncate(0o700))
    } else {
        nix::fcntl::openat(
            &dir,
            at,
            nix::fcntl::OFlag::O_CREAT | nix::fcntl::OFlag::O_EXCL | nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_WRONLY,
            nix::sys::stat::Mode::from_bits_truncate(0o600),
        )
        .map(|_| ())
    };
    made.map_err(|e| format!("{}/{at}: {e}", binds.display()))?;
    Ok(binds.join(at))
}

/// The ports a container's create asked for, joined to the box ports the engine bound: (inside, box) pairs.
pub fn published_ports(inspect: &Value) -> Vec<(u16, u16)> {
    let asked =
        inspect.pointer("/Config/Labels").and_then(|l| l.get(PORTS_LABEL)).and_then(Value::as_str).map(ports_of_word).unwrap_or_default();
    let mut out = Vec::new();
    for (port, bindings) in inspect.pointer("/NetworkSettings/Ports").and_then(Value::as_object).into_iter().flatten() {
        let bound = bindings
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|b| b.get("HostPort").and_then(Value::as_str).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0));
        if let Some(bound) = bound {
            out.push((asked.get(port).copied().unwrap_or(bound), bound));
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Where a workspace's published ports are joined: the daemon holds a listener inside the workspace for each.
pub trait Ports: Send + Sync {
    fn published(&self, workspace: &str, inside: u16, box_port: u16);
}

/// What the daemon does on the box for one workspace's fence: the two are separate concerns and the fence is
/// handed both at its start.
pub struct Hooks {
    pub ports: Arc<dyn Ports>,
    pub bridges: Arc<dyn Bridges>,
}

/// What the daemon does on the box for a network the fence lets the engine make.
pub trait Bridges: Send + Sync {
    /// Whether the box holds a link by that name now; where it does, the rule letting two containers of this
    /// workspace reach each other across it goes in with it. False is the fence's word to take the network away.
    fn made(&self, workspace: &str, bridge: &str) -> bool;
    /// That rule taken off again, with the network it was written for.
    fn gone(&self, workspace: &str, bridge: &str);
}

/// One workspace's fence: what its socket may reach and how its paths map.
pub struct Fence {
    pub workspace: String,
    pub rootfs: PathBuf,
    /// Where a container of this workspace may bind from: the path inside paired with the box directory bound
    /// there, read off the workspace's own record. Not off a file inside the workspace, which the workspace
    /// writes, so the allowlist is an authority of its own.
    pub roots: Vec<(String, PathBuf)>,
    /// Where those sources are staged for the engine.
    pub binds: PathBuf,
    pub engine: PathBuf,
    pub hooks: Hooks,
    /// What tells this life of the workspace from the ones before it, and the first half of every staging
    /// entry's name: a container made in an earlier life still names the entry it was given, and the entries
    /// of two lives sit side by side under one directory rather than one overwriting the other.
    life: String,
    /// The second half. One entry per bind source per create, since the alternative is reusing an inode a
    /// workspace may have replaced since.
    staged: std::sync::atomic::AtomicUsize,
}

impl Fence {
    pub fn new(
        workspace: String,
        rootfs: PathBuf,
        roots: Vec<(String, PathBuf)>,
        binds: PathBuf,
        engine: PathBuf,
        hooks: Hooks,
        life: String,
    ) -> Fence {
        Fence { workspace, rootfs, roots, binds, engine, hooks, life, staged: std::sync::atomic::AtomicUsize::new(0) }
    }

    fn map_bind(&self, source: &str) -> Result<PathBuf, String> {
        let at = format!("{}-{}", self.life, self.staged.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let staged = map_bind(&self.rootfs, &self.roots, &self.binds, &at, source)?;
        crate::bundle::bind_opened(&staged.source, &staged.at).map_err(|e| format!("{source} could not be staged for the engine: {e}"))?;
        Ok(staged.at)
    }
}

/// One HTTP request head as parsed off the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub content_length: Option<usize>,
    pub chunked: bool,
}

/// Bytes up to and including the blank line that ends a head, and whatever came after it.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut held = Vec::with_capacity(1024);
    let mut buf = [0u8; 4096];
    loop {
        if let Some(at) = held.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = held.split_off(at + 4);
            return Ok((held, rest));
        }
        if held.len() > HEAD_MAX {
            return Err(io::Error::other("a request head over 64 KiB"));
        }
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        held.extend_from_slice(&buf[..n]);
    }
}

fn parse_request(head: &[u8]) -> Result<Head, String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(head) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err("an incomplete request head".into()),
        Err(e) => return Err(format!("a request head that does not parse: {e}")),
    }
    let method = request.method.ok_or("a request without a method")?.to_owned();
    let path = request.path.ok_or("a request without a path")?.to_owned();
    let headers: Vec<(String, String)> =
        request.headers.iter().map(|h| (h.name.to_owned(), String::from_utf8_lossy(h.value).into_owned())).collect();
    let find = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_owned());
    let content_length = find("content-length").and_then(|v| v.parse().ok());
    let chunked = find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    // Two framings are two readings of where the body ends: this socket would take the length and the engine
    // the chunks, and what lies between the two is a request the engine reads on its own. Refused here, before
    // a byte of it crosses, since no client of the engine sends both.
    if content_length.is_some() && chunked {
        return Err("a request frames its body with a length or with chunks and not both, and this one carries both".into());
    }
    Ok(Head { method, path, headers, content_length, chunked })
}

/// The head as this proxy sends it on: the path given, the body's length named where this socket rewrote the
/// body, and the connection told to close. Where the body rides on in the client's own framing, that framing
/// rides on the head with it, since the copy is held to it. Where the route is one the engine may hand the
/// connection over on, the connection headers ride along as they came, since that hand-over is what they ask for.
fn request_head(head: &Head, path: &str, body_length: Option<usize>, hijacks: bool) -> Vec<u8> {
    let mut out = format!("{} {} HTTP/1.1\r\n", head.method, path);
    for (name, value) in &head.headers {
        let lower = name.to_ascii_lowercase();
        if ((lower == "content-length" || lower == "transfer-encoding") && body_length.is_some())
            || ((lower == "connection" || lower == "upgrade") && !hijacks)
        {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(n) = body_length {
        out.push_str(&format!("Content-Length: {n}\r\n"));
    }
    if !hijacks {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

/// The two content types a hijacked answer carries under a 200, which the engine sends instead of a 101 where the
/// client asked for no upgrade.
const RAW_STREAMS: [&str; 2] = ["application/vnd.docker.raw-stream", "application/vnd.docker.multiplexed-stream"];

/// The engine's answer as this proxy sends it on: the status, whether the engine handed the connection over, and
/// the head with the connection told to close unless it did.
struct Answer {
    status: u16,
    raw: bool,
    head: Vec<u8>,
}

fn response_head(head: &[u8]) -> Result<Answer, String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    match response.parse(head) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err("an incomplete response head".into()),
        Err(e) => return Err(format!("a response head that does not parse: {e}")),
    }
    let status = response.code.ok_or("a response without a status")?;
    let kind = response
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| String::from_utf8_lossy(h.value).trim().to_ascii_lowercase())
        .unwrap_or_default();
    let raw = status == 101 || (status == 200 && RAW_STREAMS.contains(&kind.as_str()));
    if status == 101 {
        return Ok(Answer { status, raw, head: head.to_vec() });
    }
    let mut out = format!("HTTP/1.1 {status} {}\r\n", response.reason.unwrap_or(""));
    for h in response.headers.iter() {
        if h.name.eq_ignore_ascii_case("connection") {
            continue;
        }
        out.push_str(&format!("{}: {}\r\n", h.name, String::from_utf8_lossy(h.value)));
    }
    out.push_str("Connection: close\r\n\r\n");
    Ok(Answer { status, raw, head: out.into_bytes() })
}

/// The size a chunked body's size line names, its extension after a semicolon dropped; none where the line is no
/// size at all. One reader, since the fence reads a chunked body of the engine's own and copies one of a
/// client's, and a size read two ways is a body framed two ways.
fn chunk_size(line: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(line);
    usize::from_str_radix(text.split(';').next().unwrap_or("").trim(), 16).ok()
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < body.len() {
        let Some(line_end) = body[at..].windows(2).position(|w| w == b"\r\n") else { break };
        let size = chunk_size(&body[at..at + line_end]).unwrap_or(0);
        at += line_end + 2;
        if size == 0 {
            break;
        }
        let end = (at + size).min(body.len());
        out.extend_from_slice(&body[at..end]);
        at = end + 2;
    }
    out
}

/// The reason word beside a status, for the answers this socket writes itself.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "Bad Gateway",
    }
}

fn json_message(status: u16, message: &str) -> Vec<u8> {
    json_answer(status, &json!({ "message": message }))
}

/// One JSON answer this socket writes itself, for the routes it runs against the engine rather than forwarding.
fn json_answer(status: u16, body: &Value) -> Vec<u8> {
    let text = body.to_string();
    format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        reason(status),
        text.len()
    )
    .into_bytes()
}

/// One request of this daemon's own to the engine: the status and the body as JSON, null where there was none.
pub async fn ask(engine: &Path, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Error> {
    let mut stream = UnixStream::connect(engine).await.map_err(|e| Error(format!("{}: {e}", engine.display())))?;
    let text = body.map(Value::to_string).unwrap_or_default();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n");
    if body.is_some() {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", text.len()));
    }
    request.push_str("\r\n");
    request.push_str(&text);
    stream.write_all(request.as_bytes()).await?;
    let (head, mut rest) = read_head(&mut stream).await?;
    stream.read_to_end(&mut rest).await?;
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    let status = match response.parse(&head) {
        Ok(httparse::Status::Complete(_)) => response.code.ok_or_else(|| Error("a response without a status".into()))?,
        _ => return Err(Error("the engine answered with a head that does not parse".into())),
    };
    let chunked = response.headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("transfer-encoding") && String::from_utf8_lossy(h.value).to_ascii_lowercase().contains("chunked")
    });
    let bytes = if chunked { dechunk(&rest) } else { rest };
    let value = if bytes.iter().all(u8::is_ascii_whitespace) { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    Ok((status, value))
}

/// The engine's inspect of a container the workspace owns, or none for one it does not (or that is not there).
async fn owned_container(fence: &Fence, id: &str) -> Result<Option<Value>, Error> {
    let (status, inspect) = ask(&fence.engine, "GET", &format!("/containers/{}/json", encoded(id)), None).await?;
    if status != 200 {
        return Ok(None);
    }
    let ours = inspect.pointer("/Config/Labels").and_then(|l| l.get(LABEL)).and_then(Value::as_str) == Some(fence.workspace.as_str());
    Ok(ours.then_some(inspect))
}

/// What the engine holds under a name the fence asked it about.
#[derive(Debug, PartialEq, Eq)]
enum Owned {
    Ours,
    Another,
    Nothing,
}

/// The engine's inspect of a network or a volume and whose it is: both wear the label at the top of the inspect,
/// which is what tells one workspace's from another's.
async fn owned(fence: &Fence, path: &str) -> Result<(Owned, Value), Error> {
    let (status, inspect) = ask(&fence.engine, "GET", path, None).await?;
    // Nothing means the fence may make one under that name, so nothing is the engine's own word for it and no
    // other: an engine that answered anything else was not asked, and a create that read it as nothing would
    // make a volume on a name a sibling already holds and attach the sibling's.
    match status {
        200 => {
            let ours = inspect.get("Labels").and_then(|l| l.get(LABEL)).and_then(Value::as_str) == Some(fence.workspace.as_str());
            Ok((if ours { Owned::Ours } else { Owned::Another }, inspect))
        }
        404 => Ok((Owned::Nothing, inspect)),
        other => Err(Error(format!("the engine answered {other} for {path}"))),
    }
}

async fn owned_network(fence: &Fence, id: &str) -> Result<(Owned, Value), Error> {
    owned(fence, &format!("/networks/{}", encoded(id))).await
}

async fn held_volume(fence: &Fence, name: &str) -> Result<Owned, Error> {
    Ok(owned(fence, &format!("/volumes/{}", encoded(name))).await?.0)
}

/// The bridge the engine was told to make, proven to be on the box and carrying its rule. Where it is not, the
/// network goes again rather than standing outside every rule that keeps a workspace off the box.
async fn bridge_stands(fence: &Fence, answer: &Value, bridge: &str) -> Result<(), String> {
    if fence.hooks.bridges.made(&fence.workspace, bridge) {
        return Ok(());
    }
    if let Some(id) = answer.get("Id").and_then(Value::as_str) {
        let _ = ask(&fence.engine, "DELETE", &format!("/networks/{}", encoded(id)), None).await;
    }
    Err("the engine did not make the bridge this workspace's network needs".into())
}

/// The workspace's own default network, made the first time a container of it asks for no network of its own.
async fn make_default_network(fence: &Fence, name: &str) -> Result<(), Error> {
    let mut body = json!({ "Name": name, "EnableIPv6": false });
    let bridge = name_the_bridge(&mut body, &fence.workspace).map_err(Error)?;
    label_create(&mut body, &fence.workspace).map_err(Error)?;
    let (status, answer) = ask(&fence.engine, "POST", "/networks/create", Some(&body)).await?;
    if status != 201 {
        return Err(Error(format!("this workspace's own network was not made: {status} {answer}")));
    }
    bridge_stands(fence, &answer, &bridge).await.map_err(Error)
}

/// A named volume a create asked for that the engine holds nothing under, made here wearing the workspace's
/// label: `docker run -v data:/x` on a name nothing has made yet is the common road, and the label is what the
/// next attach, the sweep and the remove read it by.
async fn make_volume(fence: &Fence, name: &str) -> Result<(), Error> {
    let body = json!({ "Name": name, "Labels": { LABEL: fence.workspace.clone() } });
    let (status, answer) = ask(&fence.engine, "POST", "/volumes/create", Some(&body)).await?;
    if status != 201 && status != 200 {
        return Err(Error(format!("the volume {name} this create attaches was not made: {status} {answer}")));
    }
    Ok(())
}

/// The container an exec belongs to, when the engine knows the exec.
async fn exec_container(fence: &Fence, id: &str) -> Result<Option<String>, Error> {
    let (status, inspect) = ask(&fence.engine, "GET", &format!("/exec/{}/json", encoded(id)), None).await?;
    Ok((status == 200).then(|| inspect.get("ContainerID").and_then(Value::as_str).map(str::to_owned)).flatten())
}

fn encoded(word: &str) -> String {
    utf8_percent_encode(word, NON_ALPHANUMERIC).to_string()
}

/// What one request comes to after the fence: the head to send, the body to send with it, and the container whose
/// published ports are joined once the engine has taken its start; or the response the client gets instead.
enum Verdict {
    Forward { head: Vec<u8>, body: Body, started: Option<String> },
    Answer(Vec<u8>),
}

/// The bytes of a request's body as the fence hands them on.
enum Body {
    /// Exactly these and nothing more: a body this socket read whole and wrote again.
    Whole(Vec<u8>),
    /// These, and then the rest of the request's own framing copied on from the client as it comes.
    Framed(Vec<u8>),
}

/// What came from the client past the head, read on as the framing asks for more. What has been written on is
/// dropped at each read, so a body of any size costs one buffer.
struct Held<'a, S> {
    client: &'a mut S,
    bytes: Vec<u8>,
    at: usize,
}

impl<'a, S: AsyncRead + Unpin> Held<'a, S> {
    fn new(client: &'a mut S, bytes: Vec<u8>) -> Held<'a, S> {
        Held { client, bytes, at: 0 }
    }

    fn rest(&self) -> &[u8] {
        &self.bytes[self.at..]
    }

    /// One more read from the client; false where the client closed first.
    async fn more(&mut self) -> Result<bool, String> {
        self.bytes.drain(..self.at);
        self.at = 0;
        let mut buf = [0u8; 64 * 1024];
        let n = self.client.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(false);
        }
        self.bytes.extend_from_slice(&buf[..n]);
        Ok(true)
    }

    /// The next `n` bytes written on to the engine.
    async fn copy<W: AsyncWrite + Unpin>(&mut self, engine: &mut W, n: usize) -> Result<(), String> {
        let mut left = n;
        while left > 0 {
            if self.rest().is_empty() && !self.more().await? {
                return Err("the body ended early".into());
            }
            let take = self.rest().len().min(left);
            engine.write_all(&self.bytes[self.at..self.at + take]).await.map_err(|e| e.to_string())?;
            self.at += take;
            left -= take;
        }
        Ok(())
    }

    /// The next line with its own newline. Read and answered, never written on: a line the caller refuses is a
    /// line the engine must not have seen.
    async fn line(&mut self) -> Result<Vec<u8>, String> {
        loop {
            if let Some(end) = self.rest().windows(2).position(|w| w == b"\r\n") {
                let line = self.bytes[self.at..self.at + end + 2].to_vec();
                self.at += end + 2;
                return Ok(line);
            }
            if self.rest().len() > HEAD_MAX {
                return Err(format!("a chunked body's line over the {HEAD_MAX} bytes this socket reads"));
            }
            if !self.more().await? {
                return Err("the body ended early".into());
            }
        }
    }
}

/// The client's body copied on to the engine within the request's own framing and not one byte past it: a length
/// counts down, a chunked body runs through its terminator and its trailer, and a request that frames no body
/// carries none. Whatever the client sent behind the framing goes with the connection.
async fn copy_body<S: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    client: &mut S,
    engine: &mut W,
    head: &Head,
    rest: Vec<u8>,
) -> Result<(), String> {
    let mut held = Held::new(client, rest);
    if let Some(length) = head.content_length {
        return held.copy(engine, length).await;
    }
    if !head.chunked {
        return Ok(());
    }
    loop {
        // Read, then written: a size line this socket cannot read ends the request here rather than at the
        // engine, which would have the bytes behind it already.
        let line = held.line().await?;
        let Some(size) = chunk_size(&line) else {
            return Err(format!("a chunk size this socket cannot read: {}", String::from_utf8_lossy(&line).trim()));
        };
        engine.write_all(&line).await.map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        held.copy(engine, size + 2).await?;
    }
    loop {
        let line = held.line().await?;
        engine.write_all(&line).await.map_err(|e| e.to_string())?;
        if line == b"\r\n" {
            return Ok(());
        }
    }
}

async fn read_body<S: AsyncRead + Unpin>(stream: &mut S, head: &Head, mut rest: Vec<u8>) -> Result<Vec<u8>, String> {
    if head.chunked {
        return Err("a chunked body on a route this socket reads whole".into());
    }
    let wanted = head.content_length.unwrap_or(0);
    if wanted > BODY_MAX {
        return Err(format!("a body of {wanted} bytes, over the {BODY_MAX} this socket reads"));
    }
    while rest.len() < wanted {
        let mut buf = vec![0u8; (wanted - rest.len()).min(64 * 1024)];
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the body ended early".into());
        }
        rest.extend_from_slice(&buf[..n]);
    }
    Ok(rest)
}

fn json_body(bytes: &[u8]) -> Result<Value, String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    serde_json::from_slice(bytes).map_err(|e| format!("a body that is not JSON: {e}"))
}

fn no_such(kind: &str, id: &str) -> Vec<u8> {
    json_message(404, &format!("No such {kind}: {id}"))
}

fn split_query(path: &str) -> (&str, Option<&str>) {
    match path.split_once('?') {
        Some((bare, query)) => (bare, Some(query)),
        None => (path, None),
    }
}

/// One request judged: the fence's reading of the head, the body where the route needs it, and every name it
/// carries checked against the label.
async fn judge<S: AsyncRead + Unpin>(fence: &Fence, stream: &mut S, head: &Head, asked: Route, rest: Vec<u8>) -> Verdict {
    let refused = |sentence: String| Verdict::Answer(json_message(403, &sentence));
    let failed = |e: Error| Verdict::Answer(json_message(502, &format!("the engine did not answer: {e}")));
    let (bare, query) = split_query(&head.path);
    let hijacks = asked.hijacks(&head.method);
    match asked {
        Route::Refused(sentence) => refused(sentence),
        Route::Pass => Verdict::Forward { head: request_head(head, &head.path, None, hijacks), body: Body::Framed(rest), started: None },
        Route::List => match filtered_query(query, &fence.workspace) {
            Ok(filtered) => Verdict::Forward {
                head: request_head(head, &format!("{bare}?{filtered}"), None, hijacks),
                body: Body::Framed(rest),
                started: None,
            },
            Err(e) => Verdict::Answer(json_message(400, &e)),
        },
        Route::Create => {
            let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                Ok(body) => body,
                Err(e) => return Verdict::Answer(json_message(400, &e)),
            };
            let mut body = body;
            let fenced = match fence_create(&mut body, &fence.workspace, &|source| fence.map_bind(source)) {
                Ok(fenced) => fenced,
                Err(sentence) => return refused(sentence),
            };
            for id in &fenced.containers {
                match owned_container(fence, id).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return Verdict::Answer(no_such("container", id)),
                    Err(e) => return failed(e),
                }
            }
            // The workspace's own network, which a container that asked for no network of its own joins: the
            // engine's default bridge is the box's, and a container on it is outside every rule.
            let own_default = default_network(&fence.workspace);
            let mut make_default = false;
            for name in &fenced.networks {
                match owned_network(fence, name).await {
                    Ok((Owned::Ours, _)) => {}
                    Ok((Owned::Nothing, _)) if *name == own_default => make_default = true,
                    Ok(_) => return Verdict::Answer(no_such("network", name)),
                    Err(e) => return failed(e),
                }
            }
            let mut missing = Vec::new();
            for name in &fenced.volumes {
                match held_volume(fence, name).await {
                    Ok(Owned::Ours) => {}
                    Ok(Owned::Nothing) => missing.push(name.clone()),
                    Ok(Owned::Another) => return Verdict::Answer(no_such("volume", name)),
                    Err(e) => return failed(e),
                }
            }
            // Every name this create carries is read before anything is made for it, so a create this fence
            // refuses leaves the engine as it found it.
            if make_default {
                if let Err(e) = make_default_network(fence, &own_default).await {
                    return failed(e);
                }
            }
            for name in missing {
                if let Err(e) = make_volume(fence, &name).await {
                    return failed(e);
                }
            }
            let text = body.to_string().into_bytes();
            Verdict::Forward { head: request_head(head, &head.path, Some(text.len()), hijacks), body: Body::Whole(text), started: None }
        }
        Route::VolumeCreate => {
            let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                Ok(body) => body,
                Err(e) => return Verdict::Answer(json_message(400, &e)),
            };
            let mut body = body;
            if let Err(sentence) = plain_volume(word(body.get("Driver")), body.get("DriverOpts")) {
                return refused(sentence);
            }
            if let Err(e) = label_create(&mut body, &fence.workspace) {
                return Verdict::Answer(json_message(400, &e));
            }
            let text = body.to_string().into_bytes();
            Verdict::Forward { head: request_head(head, &head.path, Some(text.len()), hijacks), body: Body::Whole(text), started: None }
        }
        // Run here rather than forwarded: what the engine answers decides two things the client must not see
        // first, whether the bridge was made under the name the table's rules match and, where it was not, that
        // the network goes again.
        Route::NetworkCreate => {
            let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                Ok(body) => body,
                Err(e) => return Verdict::Answer(json_message(400, &e)),
            };
            let mut body = body;
            let bridge = match fence_network_create(&mut body, &fence.workspace) {
                Ok(bridge) => bridge,
                Err(sentence) => return refused(sentence),
            };
            if let Err(e) = label_create(&mut body, &fence.workspace) {
                return Verdict::Answer(json_message(400, &e));
            }
            match ask(&fence.engine, "POST", &head.path, Some(&body)).await {
                Ok((201, answer)) => match bridge_stands(fence, &answer, &bridge).await {
                    Ok(()) => Verdict::Answer(json_answer(201, &answer)),
                    Err(sentence) => Verdict::Answer(json_message(502, &sentence)),
                },
                Ok((status, answer)) => Verdict::Answer(json_answer(status, &answer)),
                Err(e) => failed(e),
            }
        }
        Route::Container { id, verb } => {
            match owned_container(fence, &id).await {
                Ok(Some(_)) => {}
                Ok(None) => return Verdict::Answer(no_such("container", &id)),
                Err(e) => return failed(e),
            }
            if verb.as_deref() == Some("exec") && head.method == "POST" {
                let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                    Ok(body) => body,
                    Err(e) => return Verdict::Answer(json_message(400, &e)),
                };
                if let Err(sentence) = fence_exec(&body) {
                    return refused(sentence);
                }
                let text = body.to_string().into_bytes();
                return Verdict::Forward {
                    head: request_head(head, &head.path, Some(text.len()), hijacks),
                    body: Body::Whole(text),
                    started: None,
                };
            }
            let started = (verb.as_deref() == Some("start") && head.method == "POST").then(|| id.clone());
            Verdict::Forward { head: request_head(head, &head.path, None, hijacks), body: Body::Framed(rest), started }
        }
        Route::Exec { id, .. } => {
            let container = match exec_container(fence, &id).await {
                Ok(Some(container)) => container,
                Ok(None) => return Verdict::Answer(no_such("exec instance", &id)),
                Err(e) => return failed(e),
            };
            match owned_container(fence, &container).await {
                Ok(Some(_)) => {
                    Verdict::Forward { head: request_head(head, &head.path, None, hijacks), body: Body::Framed(rest), started: None }
                }
                Ok(None) => Verdict::Answer(no_such("exec instance", &id)),
                Err(e) => failed(e),
            }
        }
        Route::Network { id, verb } => {
            let inspect = match owned_network(fence, &id).await {
                Ok((Owned::Ours, inspect)) => inspect,
                Ok(_) => return Verdict::Answer(no_such("network", &id)),
                Err(e) => return failed(e),
            };
            // The delete is run here so the bridge's own rule goes with the network the engine took away.
            if head.method == "DELETE" && verb.is_none() {
                let bridge = word(inspect.pointer(&format!("/Options/{BRIDGE_NAME}"))).to_owned();
                return match ask(&fence.engine, "DELETE", &head.path, None).await {
                    Ok((204, _)) => {
                        if !bridge.is_empty() {
                            fence.hooks.bridges.gone(&fence.workspace, &bridge);
                        }
                        Verdict::Answer(format!("HTTP/1.1 204 {}\r\nConnection: close\r\n\r\n", reason(204)).into_bytes())
                    }
                    Ok((status, answer)) => Verdict::Answer(json_answer(status, &answer)),
                    Err(e) => failed(e),
                };
            }
            if matches!(verb.as_deref(), Some("connect" | "disconnect")) {
                let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                    Ok(body) => body,
                    Err(e) => return Verdict::Answer(json_message(400, &e)),
                };
                let container = word(body.get("Container")).to_owned();
                match owned_container(fence, &container).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return Verdict::Answer(no_such("container", &container)),
                    Err(e) => return failed(e),
                }
                let text = body.to_string().into_bytes();
                return Verdict::Forward {
                    head: request_head(head, &head.path, Some(text.len()), hijacks),
                    body: Body::Whole(text),
                    started: None,
                };
            }
            Verdict::Forward { head: request_head(head, &head.path, None, hijacks), body: Body::Framed(rest), started: None }
        }
        Route::Volume { name } => match held_volume(fence, &name).await {
            Ok(Owned::Ours) => {
                Verdict::Forward { head: request_head(head, &head.path, None, hijacks), body: Body::Framed(rest), started: None }
            }
            Ok(_) => Verdict::Answer(no_such("volume", &name)),
            Err(e) => failed(e),
        },
    }
}

/// One client connection: one request, judged, forwarded on a fresh engine connection, the body copied on within
/// its own framing, the answer copied back and both sides closed. A start that the engine took joins the
/// container's published ports afterwards.
async fn handle(fence: Arc<Fence>, mut client: UnixStream) -> Result<(), Error> {
    let (head_bytes, rest) = read_head(&mut client).await?;
    let head = match parse_request(&head_bytes) {
        Ok(head) => head,
        Err(e) => {
            client.write_all(&json_message(400, &e)).await?;
            return Ok(());
        }
    };
    let asked = route(&head.method, &head.path);
    let hijacks = asked.hijacks(&head.method);
    let (forward, body, started) = match judge(&fence, &mut client, &head, asked, rest).await {
        Verdict::Answer(bytes) => {
            client.write_all(&bytes).await?;
            let _ = client.shutdown().await;
            return Ok(());
        }
        Verdict::Forward { head, body, started } => (head, body, started),
    };
    let mut engine = match UnixStream::connect(&fence.engine).await {
        Ok(engine) => engine,
        Err(e) => {
            client.write_all(&json_message(502, &format!("the engine at {} did not answer: {e}", fence.engine.display()))).await?;
            return Ok(());
        }
    };
    engine.write_all(&forward).await?;
    match body {
        Body::Whole(bytes) => engine.write_all(&bytes).await?,
        Body::Framed(rest) => {
            if let Err(e) = copy_body(&mut client, &mut engine, &head, rest).await {
                client.write_all(&json_message(400, &e)).await?;
                return Ok(());
            }
        }
    }
    let (answer_head, answer_rest) = read_head(&mut engine).await?;
    let answer = match response_head(&answer_head) {
        Ok(parsed) => parsed,
        Err(e) => {
            client.write_all(&json_message(502, &e)).await?;
            return Ok(());
        }
    };
    // A hijack route the engine answered without handing the connection over is one answer like any other, and
    // its connection was never told to close: ending this side here is what keeps the engine from reading
    // anything behind the body as a request of its own, and what ends the wait on a close that never comes.
    if hijacks && !answer.raw {
        let _ = engine.shutdown().await;
    }
    client.write_all(&answer.head).await?;
    client.write_all(&answer_rest).await?;
    if hijacks && answer.raw {
        let _ = tokio::io::copy_bidirectional(&mut client, &mut engine).await;
    } else {
        let _ = tokio::io::copy(&mut engine, &mut client).await;
    }
    let _ = client.shutdown().await;
    if let (Some(id), 204) = (started, answer.status) {
        if let Ok(Some(inspect)) = owned_container(&fence, &id).await {
            for (inside, box_port) in published_ports(&inspect) {
                fence.hooks.ports.published(&fence.workspace, inside, box_port);
            }
        }
    }
    Ok(())
}

/// The accept loop of one workspace's socket; ends when its task is aborted.
pub async fn serve(listener: UnixListener, fence: Arc<Fence>) {
    loop {
        match listener.accept().await {
            Ok((client, _)) => {
                let fence = Arc::clone(&fence);
                tokio::spawn(async move {
                    let _ = handle(fence, client).await;
                });
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
}

/// Binds the workspace's socket in its directory on the box, a stale file from an earlier life removed first.
pub fn bind(dir: &Path) -> io::Result<UnixListener> {
    fs::create_dir_all(dir)?;
    let path = dir.join(SOCKET_NAME);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    UnixListener::bind(&path)
}

/// The symlink a Docker client inside follows to the socket, made through the descriptor of the folder it sits
/// in so no link of the workspace's leads the make anywhere else; one already there stands.
pub fn link_client_path(place: &crate::bundle::Inside) -> Result<(), crate::bundle::Error> {
    let (folder, name) = CLIENT_PATH.rsplit_once('/').expect("the client path names a folder");
    let dir = crate::bundle::open_inside(place, folder, crate::bundle::Want::Dir, crate::bundle::BoxLink::FollowedOnce)?;
    match nix::unistd::symlinkat(format!("{INSIDE_DIR}/{SOCKET_NAME}").as_str(), dir.fd(), name) {
        Ok(()) | Err(nix::errno::Errno::EEXIST) => Ok(()),
        Err(e) => Err(crate::bundle::Error { path: dir.named(place).join(name), source: io::Error::from(e) }),
    }
}

async fn listed(engine: &Path, path: &str, key: &str, workspace: &str) -> Result<Vec<Value>, Error> {
    let query = filtered_query(None, workspace).map_err(Error)?;
    let (status, rows) = ask(engine, "GET", &format!("{path}?all=1&{query}"), None).await?;
    if status != 200 {
        return Err(Error(format!("{path} answered {status}")));
    }
    let rows = if key.is_empty() { rows } else { rows.get(key).cloned().unwrap_or(Value::Null) };
    Ok(rows.as_array().cloned().unwrap_or_default())
}

/// The (inside, box) port pairs of every running container the workspace owns, for a wake or a daemon restart.
pub async fn published(engine: &Path, workspace: &str) -> Result<Vec<(u16, u16)>, Error> {
    let mut out = Vec::new();
    for row in listed(engine, "/containers/json", "", workspace).await? {
        if row.get("State").and_then(Value::as_str) != Some("running") {
            continue;
        }
        let Some(id) = row.get("Id").and_then(Value::as_str) else { continue };
        let (status, inspect) = ask(engine, "GET", &format!("/containers/{id}/json"), None).await?;
        if status == 200 {
            out.extend(published_ports(&inspect));
        }
    }
    Ok(out)
}

/// Every container, network and volume the workspace owns, removed from the engine: what a killed workspace leaves
/// on the box is nothing. Answers how many of each went.
pub async fn remove_all(engine: &Path, workspace: &str) -> Result<(usize, usize, usize), Error> {
    let mut counts = (0, 0, 0);
    for row in listed(engine, "/containers/json", "", workspace).await? {
        if let Some(id) = row.get("Id").and_then(Value::as_str) {
            let (status, _) = ask(engine, "DELETE", &format!("/containers/{id}?force=true&v=true"), None).await?;
            if status == 204 || status == 404 {
                counts.0 += 1;
            }
        }
    }
    for row in listed(engine, "/networks", "", workspace).await? {
        if let Some(id) = row.get("Id").and_then(Value::as_str) {
            let (status, _) = ask(engine, "DELETE", &format!("/networks/{id}"), None).await?;
            if status == 204 || status == 404 {
                counts.1 += 1;
            }
        }
    }
    for row in listed(engine, "/volumes", "Volumes", workspace).await? {
        if let Some(name) = row.get("Name").and_then(Value::as_str) {
            let (status, _) = ask(engine, "DELETE", &format!("/volumes/{}?force=true", encoded(name)), None).await?;
            if status == 204 || status == 404 {
                counts.2 += 1;
            }
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_binds(source: &str) -> Result<PathBuf, String> {
        Ok(PathBuf::from(format!("/box/rootfs{source}")))
    }

    #[test]
    fn the_route_table_passes_the_engines_own_routes_and_refuses_the_boxs() {
        assert_eq!(route("HEAD", "/_ping"), Route::Pass);
        assert_eq!(route("GET", "/v1.55/version"), Route::Pass);
        assert_eq!(route("POST", "/v1.55/images/create?fromImage=postgres&tag=16-alpine"), Route::Pass);
        assert_eq!(route("GET", "/v1.55/images/json"), Route::Pass);
        assert_eq!(route("GET", "/v1.55/images/nginx:alpine/json"), Route::Pass);
        assert_eq!(route("POST", "/v1.55/containers/create?name=web"), Route::Create);
        assert_eq!(route("GET", "/v1.55/containers/json?all=1"), Route::List);
        assert_eq!(route("GET", "/v1.55/networks"), Route::List);
        assert_eq!(route("GET", "/v1.55/volumes"), Route::List);
        assert_eq!(route("GET", "/v1.55/events?since=1"), Route::List);
        assert_eq!(route("POST", "/v1.55/networks/create"), Route::NetworkCreate);
        assert_eq!(route("POST", "/v1.55/volumes/create"), Route::VolumeCreate);
        assert_eq!(route("POST", "/v1.55/containers/abc/start"), Route::Container { id: "abc".into(), verb: Some("start".into()) });
        assert_eq!(route("DELETE", "/v1.55/containers/abc?force=1"), Route::Container { id: "abc".into(), verb: None });
        assert_eq!(route("GET", "/v1.55/containers/abc/logs?follow=1"), Route::Container { id: "abc".into(), verb: Some("logs".into()) });
        assert_eq!(route("POST", "/v1.55/containers/abc/attach"), Route::Container { id: "abc".into(), verb: Some("attach".into()) });
        assert_eq!(route("POST", "/v1.55/exec/e1/start"), Route::Exec { id: "e1".into(), verb: Some("start".into()) });
        assert_eq!(route("GET", "/v1.55/exec/e1/json"), Route::Exec { id: "e1".into(), verb: Some("json".into()) });
        assert_eq!(route("GET", "/v1.55/networks/n1"), Route::Network { id: "n1".into(), verb: None });
        assert_eq!(route("GET", "/v1.55/volumes/v1"), Route::Volume { name: "v1".into() });
        for path in [
            "/v1.55/info",
            "/v1.55/system/df",
            "/v1.55/swarm",
            "/v1.55/plugins",
            "/v1.55/services",
            "/v1.55/secrets",
            "/v1.55/auth",
            "/nonsense",
        ] {
            assert!(matches!(route("GET", path), Route::Refused(_)), "{path}");
        }
        assert!(matches!(route("POST", "/v1.55/build?t=x"), Route::Refused(s) if s.contains("image builds")));
        assert!(matches!(route("POST", "/v1.55/containers/prune"), Route::Refused(s) if s.contains("everything on this computer")));
    }

    #[test]
    fn a_create_is_labelled_its_ports_move_to_the_loopback_and_its_binds_are_mapped() {
        let mut body = json!({
            "Image": "nginx:alpine",
            "Labels": { "com.docker.compose.project": "demo" },
            "HostConfig": {
                "Binds": ["/root/demo/html:/usr/share/nginx/html:ro", "dbdata:/var/lib/postgresql/data"],
                "Mounts": [{ "Type": "bind", "Source": "/root/demo/conf", "Target": "/etc/nginx/conf.d" }, { "Type": "volume", "Source": "v", "Target": "/v" }],
                "PortBindings": { "80/tcp": [{ "HostIp": "", "HostPort": "18080" }], "443/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "" }] },
                "NetworkMode": "demo_default"
            },
            "NetworkingConfig": { "EndpointsConfig": { "demo_default": {} } }
        });
        let fenced = fence_create(&mut body, "wsp-a", &no_binds).unwrap();
        assert_eq!(fenced.ports, BTreeMap::from([("80/tcp".to_owned(), 18080)]));
        assert_eq!(fenced.networks, vec!["demo_default"], "named in NetworkMode and EndpointsConfig both, checked once");
        assert_eq!(fenced.volumes, vec!["dbdata", "v"], "a bind whose source is no path and a volume mount both name one");
        assert!(fenced.containers.is_empty());
        assert_eq!(body["Labels"][LABEL], "wsp-a");
        assert_eq!(body["Labels"][PORTS_LABEL], "80/tcp=18080");
        assert_eq!(body["Labels"]["com.docker.compose.project"], "demo");
        assert_eq!(
            body["HostConfig"]["Binds"],
            json!(["/box/rootfs/root/demo/html:/usr/share/nginx/html:ro", "dbdata:/var/lib/postgresql/data"])
        );
        assert_eq!(body["HostConfig"]["Mounts"][0]["Source"], "/box/rootfs/root/demo/conf");
        assert_eq!(body["HostConfig"]["Mounts"][1]["Source"], "v");
        assert_eq!(
            body["HostConfig"]["PortBindings"],
            json!({ "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "" }], "443/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "" }] })
        );
        // A create that named no network at all still names one: the workspace's own, which the fence makes.
        let mut bare = json!({ "Image": "alpine" });
        assert_eq!(
            fence_create(&mut bare, "wsp-b", &no_binds).unwrap(),
            Fenced { networks: vec!["wsp-wsp-b".to_owned()], ..Fenced::default() }
        );
        assert_eq!(bare, json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "wsp-wsp-b" }, "Labels": { LABEL: "wsp-b" } }));
    }

    #[test]
    fn a_privileged_container_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "Privileged": true } });
        assert_eq!(
            fence_create(&mut body, "w", &no_binds).unwrap_err(),
            "a privileged container is root on this computer, so a workspace cannot ask for one"
        );
    }

    #[test]
    fn cap_add_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "CapAdd": ["SYS_ADMIN"] } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("CapAdd is refused"));
        let mut empty = json!({ "Image": "alpine", "HostConfig": { "CapAdd": [], "CapDrop": ["NET_RAW"] } });
        assert!(fence_create(&mut empty, "w", &no_binds).is_ok(), "an empty CapAdd and a CapDrop pass");
    }

    #[test]
    fn devices_are_refused() {
        for field in ["Devices", "DeviceRequests", "DeviceCgroupRules"] {
            let mut body = json!({ "Image": "alpine", "HostConfig": { field: [{ "PathOnHost": "/dev/sda" }] } });
            assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("no device of this computer"), "{field}");
        }
    }

    #[test]
    fn security_opt_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "SecurityOpt": ["seccomp=unconfined"] } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("SecurityOpt is refused"));
    }

    #[test]
    fn pid_mode_host_is_refused_and_a_containers_is_checked() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "PidMode": "host" } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("PidMode host is refused"));
        let mut shared = json!({ "Image": "alpine", "HostConfig": { "PidMode": "container:other" } });
        assert_eq!(fence_create(&mut shared, "w", &no_binds).unwrap().containers, vec!["other"]);
        let mut odd = json!({ "Image": "alpine", "HostConfig": { "PidMode": "weird" } });
        assert!(fence_create(&mut odd, "w", &no_binds).is_err());
    }

    #[test]
    fn network_mode_host_is_refused_and_a_named_network_is_checked() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "host" } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("NetworkMode host is refused"));
        let mut none = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": NO_NETWORK } });
        assert!(fence_create(&mut none, "w", &no_binds).unwrap().networks.is_empty(), "no network at all is no network to check");
        let mut shared = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "container:peer" } });
        assert_eq!(fence_create(&mut shared, "w", &no_binds).unwrap().containers, vec!["peer"]);
    }

    /// The three words the engine reads as its own default bridge, which is the box's: each is read as the
    /// workspace's own network, in the mode and in the endpoints both, and the name is checked like any other.
    #[test]
    fn a_container_that_asked_for_no_network_of_its_own_joins_the_workspaces() {
        for plain in DEFAULT_NETWORKS {
            let mut body = json!({
                "Image": "alpine",
                "HostConfig": { "NetworkMode": plain },
                "NetworkingConfig": { "EndpointsConfig": { plain: { "Aliases": ["web"] } } }
            });
            let fenced = fence_create(&mut body, "wsp-a", &no_binds).unwrap();
            assert_eq!(fenced.networks, vec!["wsp-wsp-a"], "{plain}");
            assert_eq!(body["HostConfig"]["NetworkMode"], "wsp-wsp-a", "{plain}");
            assert_eq!(body["NetworkingConfig"]["EndpointsConfig"]["wsp-wsp-a"], json!({ "Aliases": ["web"] }), "{plain}");
            assert!(body["NetworkingConfig"]["EndpointsConfig"].get(plain).is_none() || plain.is_empty(), "{plain}");
        }
        assert_eq!(default_network("wsp-a"), "wsp-wsp-a");
        // A network the workspace named itself is left as it is and checked for the label as it always was.
        let mut named = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "demo_default" } });
        assert_eq!(fence_create(&mut named, "wsp-a", &no_binds).unwrap().networks, vec!["demo_default"]);
    }

    /// A workspace's network is an IPv4 bridge of its own whose link the fence names, so every rule of the
    /// workspace table reads a container on it as it reads the workspace.
    #[test]
    fn a_network_create_is_a_named_bridge_of_the_workspaces_own() {
        let made = |body: &mut Value| fence_network_create(body, "wsp-a");
        let mut plain = json!({ "Name": "demo_default" });
        let bridge = made(&mut plain).unwrap();
        assert!(bridge.starts_with("wsp-e") && bridge.len() == 13, "{bridge}");
        assert!(bridge[5..].chars().all(|c| c.is_ascii_hexdigit()), "{bridge}");
        assert_eq!(plain["Options"][BRIDGE_NAME], bridge);
        assert_eq!(made(&mut json!({ "Name": "demo_default" })).unwrap(), bridge, "one network is one bridge");
        assert_ne!(made(&mut json!({ "Name": "other" })).unwrap(), bridge);
        assert_ne!(fence_network_create(&mut json!({ "Name": "demo_default" }), "wsp-b").unwrap(), bridge);
        assert_eq!(
            made(&mut json!({ "Name": "n", "Driver": "macvlan" })).unwrap_err(),
            "a workspace's network is a bridge of its own on this computer; the driver macvlan is refused"
        );
        assert_eq!(
            made(&mut json!({ "Name": "n", "EnableIPv6": true })).unwrap_err(),
            "a workspace's network carries IPv4 alone; EnableIPv6 is refused"
        );
        // Written into the body, since a box whose engine turns it on by default would hand the bridge a range
        // the table that fences a workspace never sees.
        assert_eq!(plain["EnableIPv6"], false);
        // A name this computer makes for a workspace's own default network is a name a sibling's network holds
        // or will hold, which would refuse every plain container that sibling starts.
        let taken = made(&mut json!({ "Name": "wsp-wsp-b" })).unwrap_err();
        assert_eq!(taken, "a network named wsp-wsp-b is one this computer makes for a workspace of its own, so it is refused here");
        let siblings = made(&mut json!({ "Name": "wsp-b_default" })).unwrap_err();
        assert_eq!(
            siblings,
            "a network named wsp-b_default is the one the workspace whose compose project is wsp-b brings its own stack up on, so it is refused here"
        );
        assert!(made(&mut json!({ "Name": "wsp" })).is_ok(), "a name that is not under the prefix passes");
        // The name compose gives this workspace's own default network, which is its project and the suffix:
        // refusing it is refusing every stack a workspace brings up without naming a project.
        assert!(made(&mut json!({ "Name": "wsp-a_default" })).is_ok(), "the compose default network of a workspace is refused");
        // And where the id carries a character compose does not take, the project is the id rewritten, which is
        // the name the workspace's own stack asks for.
        assert!(
            fence_network_create(&mut json!({ "Name": "wsp-spoo-landing_default" }), "wsp-spoo.landing").is_ok(),
            "a workspace whose id is rewritten for compose is refused its own network"
        );
        // A subnet inside the workspaces' range, and one that holds the whole of it.
        for subnet in ["10.65.4.0/24", "10.0.0.0/8", "10.65.0.0/16"] {
            let refused = made(&mut json!({ "Name": "n", "IPAM": { "Config": [{ "Subnet": subnet }] } })).unwrap_err();
            assert!(refused.contains(&format!("the subnet {subnet} overlaps 10.65.0.0/16")), "{subnet}: {refused}");
        }
        assert!(made(&mut json!({ "Name": "n", "IPAM": { "Config": [{ "Subnet": "172.30.0.0/16" }] } })).is_ok());
        assert!(made(&mut json!({ "Name": "n", "IPAM": { "Config": [{ "Subnet": "nonsense" }] } }))
            .unwrap_err()
            .contains("names its subnet as an address and a prefix"));
        assert_eq!(
            made(&mut json!({ "Name": "n", "Options": { BRIDGE_NAME: "docker0" } })).unwrap_err(),
            format!("a workspace's network is named by this computer; {BRIDGE_NAME} is refused")
        );
    }

    #[test]
    fn ipc_mode_host_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "IpcMode": "host" } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("IpcMode host is refused"));
        let mut fine = json!({ "Image": "alpine", "HostConfig": { "IpcMode": "shareable" } });
        assert!(fence_create(&mut fine, "w", &no_binds).is_ok());
    }

    #[test]
    fn publish_all_ports_is_refused_and_volumes_from_is_checked() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "PublishAllPorts": true } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("PublishAllPorts is refused"));
        let mut from = json!({ "Image": "alpine", "HostConfig": { "VolumesFrom": ["data:ro"] } });
        assert_eq!(fence_create(&mut from, "w", &no_binds).unwrap().containers, vec!["data"]);
    }

    /// The allowlist is the record's and the source is opened by descriptor at both ends: what the engine is
    /// handed is an entry under the daemon's own staging directory, never the box path the source sits at, and
    /// a link anywhere on either side refuses the create.
    #[test]
    fn a_bind_is_read_off_the_record_opened_with_no_link_followed_and_staged() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        let on_box = dir.path().join("copies/wsp-a");
        let binds = dir.path().join("binds");
        // Every path read below is there inside the workspace, so what answers is the allowlist and not the
        // path being missing.
        for made in [
            rootfs.join("wsp/projects/demo/html"),
            rootfs.join("wsp/projects/demo/link/x"),
            rootfs.join("wsp/projects/demoted"),
            rootfs.join("root/.wsp"),
            rootfs.join("root/other"),
            rootfs.join("etc"),
        ] {
            fs::create_dir_all(made).unwrap();
        }
        for made in [on_box.join("html"), on_box.join("elsewhere/x"), binds.clone()] {
            fs::create_dir_all(made).unwrap();
        }
        // A link the workspace planted under its own project, on each side of the bind in turn.
        std::os::unix::fs::symlink("/", rootfs.join("wsp/projects/demo/escape")).unwrap();
        std::os::unix::fs::symlink("elsewhere", on_box.join("link")).unwrap();
        let roots = vec![("/wsp/projects/demo".to_owned(), on_box.clone())];
        let map = |at: &str, source: &str| map_bind(&rootfs, &roots, &binds, at, source);

        let staged = map("life-0", "/wsp/projects/demo/html").unwrap();
        assert_eq!(staged.at, binds.join("life-0"), "the engine is handed the staging entry");
        assert!(staged.at.is_dir() && !staged.at.starts_with(&on_box), "{}", staged.at.display());
        assert_eq!(map("life-1", "/wsp/projects/demo").unwrap().at, binds.join("life-1"), "the project folder itself is a source");
        // A life of its own in the name: the entries of the life before are still there and still mounted, so
        // a container the engine holds from then starts on the source it was given.
        assert_eq!(map("next-0", "/wsp/projects/demo/html").unwrap().at, binds.join("next-0"));
        assert!(binds.join("life-0").is_dir(), "an earlier life's entry went");
        // A link met on the rootfs side, and one met on the box side behind a path the rootfs side holds whole.
        for through in ["/wsp/projects/demo/escape", "/wsp/projects/demo/link/x"] {
            let refused = map("x", through).unwrap_err();
            assert_eq!(
                refused,
                format!("{through} is reached through a link inside the workspace, and a container binds nothing through a link")
            );
        }
        let outside = map("x", "/").unwrap_err();
        assert_eq!(outside, "a bind mount's source must sit under a project folder of this workspace (/wsp/projects/demo), and / does not");
        assert!(map("x", "/etc").unwrap_err().contains("and /etc does not"));
        assert!(map("x", "/root/other").unwrap_err().contains("and /root/other does not"));
        // A name that merely begins with the folder's own is not under it.
        assert!(map("x", "/wsp/projects/demoted").unwrap_err().contains("and /wsp/projects/demoted does not"));
        assert!(map("x", "/wsp/projects/demo/missing").unwrap_err().contains("is not there in the workspace"));
        assert!(map("x", "relative").unwrap_err().contains("absolute path"));
        assert!(map("x", "/wsp/projects/demo/../../etc").unwrap_err().contains("absolute path"));
        // The roots file the workspace owns says nothing here, however it is written.
        fs::write(rootfs.join("root/.wsp/roots"), "/\n/etc\n").unwrap();
        assert!(map("x", "/etc").unwrap_err().contains("and /etc does not"));
        // A workspace the record gives no folder binds nothing at all.
        let none = map_bind(&rootfs, &[], &binds, "x", "/wsp/projects/demo/html").unwrap_err();
        assert!(none.contains("no project folder yet"), "{none}");

        let next = std::sync::atomic::AtomicUsize::new(3);
        let entry = || format!("life-{}", next.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let mapped = |source: &str| map(&entry(), source).map(|staged| staged.at);
        let mut body = json!({ "Image": "alpine", "HostConfig": { "Binds": ["/:/host"] } });
        assert_eq!(fence_create(&mut body, "w", &mapped).unwrap_err(), outside);
        let mut mount = json!({ "Image": "alpine", "HostConfig": { "Mounts": [{ "Type": "bind", "Source": "/etc", "Target": "/x" }] }});
        assert!(fence_create(&mut mount, "w", &mapped).unwrap_err().contains("and /etc does not"));
        let mut fine = json!({ "Image": "alpine", "HostConfig": { "Binds": ["/wsp/projects/demo/html:/usr/share/nginx/html:ro"] } });
        let at = format!("life-{}", next.load(std::sync::atomic::Ordering::Relaxed));
        fence_create(&mut fine, "w", &mapped).unwrap();
        assert_eq!(fine["HostConfig"]["Binds"][0], format!("{}:/usr/share/nginx/html:ro", binds.join(at).display()));
    }

    #[test]
    fn a_privileged_exec_is_refused_and_a_network_or_volume_create_is_labelled() {
        assert!(fence_exec(&json!({ "Cmd": ["sh"], "Privileged": true })).unwrap_err().contains("privileged exec"));
        assert!(fence_exec(&json!({ "Cmd": ["sh"] })).is_ok());
        let mut network = json!({ "Name": "demo_default", "Labels": { "com.docker.compose.network": "default" } });
        label_create(&mut network, "wsp-a").unwrap();
        assert_eq!(network["Labels"], json!({ "com.docker.compose.network": "default", LABEL: "wsp-a" }));
        let mut volume = json!({ "Name": "data", "Labels": null });
        label_create(&mut volume, "wsp-a").unwrap();
        assert_eq!(volume["Labels"][LABEL], "wsp-a");
    }

    /// A volume the fence lets a workspace make reaches nothing of the box's: a local volume with a device and a
    /// bind option is how the box's own /etc is mounted into a container, and an inline driver config on a
    /// container create is the same road by another door.
    #[test]
    fn a_volume_carrying_a_driver_or_driver_options_is_refused() {
        let refused = plain_volume("local", Some(&json!({ "type": "none", "device": "/etc", "o": "bind" }))).unwrap_err();
        assert_eq!(refused, "a workspace's volume is a plain local volume, and this one asks for driver options (device, o, type)");
        assert_eq!(
            plain_volume("nfs", None).unwrap_err(),
            "a workspace's volume is a plain local volume, and this one asks for the driver nfs"
        );
        assert!(plain_volume("", None).is_ok() && plain_volume("local", None).is_ok());
        assert!(plain_volume("local", Some(&json!({}))).is_ok(), "an empty options object asks for nothing");
        let inline = json!({
            "Image": "alpine",
            "HostConfig": { "Mounts": [{
                "Type": "volume",
                "Source": "data",
                "Target": "/data",
                "VolumeOptions": { "DriverConfig": { "Name": "local", "Options": { "device": "/etc", "o": "bind", "type": "none" } } }
            }] }
        });
        let mut inline = inline;
        assert_eq!(fence_create(&mut inline, "w", &no_binds).unwrap_err(), refused);
        let mut npipe = json!({ "Image": "alpine", "HostConfig": { "Mounts": [{ "Type": "npipe", "Target": "/x" }] } });
        assert_eq!(
            fence_create(&mut npipe, "w", &no_binds).unwrap_err(),
            "a workspace's container mounts a bind, a volume or a tmpfs; a mount of kind \"npipe\" is refused"
        );
        let mut missing = json!({ "Image": "alpine", "HostConfig": { "Mounts": [{ "Target": "/x" }] } });
        assert!(fence_create(&mut missing, "w", &no_binds).unwrap_err().contains("a mount of kind \"\" is refused"));
        let mut fine = json!({
            "Image": "alpine",
            "HostConfig": { "Mounts": [
                { "Type": "tmpfs", "Target": "/scratch" },
                { "Type": "volume", "Source": "data", "Target": "/data" },
                { "Type": "volume", "Target": "/anon" }
            ] }
        });
        assert_eq!(fence_create(&mut fine, "w", &no_binds).unwrap().volumes, vec!["data"], "an anonymous volume names none");
    }

    #[test]
    fn a_listing_gets_the_label_filter_whatever_filters_it_carried() {
        let decode = |q: &str| -> Value {
            let filters = q.split('&').find_map(|p| p.strip_prefix("filters=")).unwrap();
            serde_json::from_str(&percent_decode_str(filters).decode_utf8().unwrap()).unwrap()
        };
        let plain = filtered_query(None, "wsp-a").unwrap();
        assert_eq!(decode(&plain), json!({ "label": ["wsp.workspace=wsp-a"] }));
        let with_all = filtered_query(Some("all=1&limit=0"), "wsp-a").unwrap();
        assert!(with_all.starts_with("all=1&limit=0&filters="), "{with_all}");
        let compose = filtered_query(
            Some(&format!("all=1&filters={}", utf8_percent_encode(r#"{"label":["com.docker.compose.project=demo"]}"#, NON_ALPHANUMERIC))),
            "wsp-a",
        )
        .unwrap();
        assert_eq!(decode(&compose), json!({ "label": ["com.docker.compose.project=demo", "wsp.workspace=wsp-a"] }));
        let old_form = filtered_query(
            Some(&format!("filters={}", utf8_percent_encode(r#"{"label":{"x=y":true},"status":{"running":true}}"#, NON_ALPHANUMERIC))),
            "w",
        )
        .unwrap();
        assert_eq!(decode(&old_form), json!({ "label": { "x=y": true, "wsp.workspace=w": true }, "status": { "running": true } }));
        // Compose asks for a network by name in the map form; the label joins in that form, since the engine refuses
        // one filters object in two forms.
        let by_name =
            filtered_query(Some(&format!("filters={}", utf8_percent_encode(r#"{"name":{"demo_default":true}}"#, NON_ALPHANUMERIC))), "w")
                .unwrap();
        assert_eq!(decode(&by_name), json!({ "name": { "demo_default": true }, "label": { "wsp.workspace=w": true } }));
        assert!(filtered_query(Some("filters=notjson"), "w").is_err());
    }

    #[test]
    fn the_published_ports_join_what_was_asked_to_what_the_engine_bound() {
        let inspect = json!({
            "Config": { "Labels": { LABEL: "wsp-a", PORTS_LABEL: "80/tcp=18080" } },
            "NetworkSettings": { "Ports": { "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "40001" }], "5432/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "40002" }], "9/udp": null } }
        });
        assert_eq!(published_ports(&inspect), vec![(18080, 40001), (40002, 40002)]);
        assert_eq!(published_ports(&json!({})), Vec::<(u16, u16)>::new());
    }

    #[test]
    fn the_engine_socket_follows_the_doctor_and_a_box_without_one_gets_the_sentence() {
        let facts = |engine| Facts { linux: true, cgroup2: true, controllers: vec![], overlay: true, root: true, kvm: false, engine };
        assert_eq!(socket_of(&facts(Engine::None)).unwrap_err(), NO_ENGINE);
        assert_eq!(engine_socket(Engine::Docker), Some(Path::new("/var/run/docker.sock")));
        assert_eq!(engine_socket(Engine::Podman), Some(Path::new("/run/podman/podman.sock")));
        if !Path::new(PODMAN_SOCKET).exists() {
            assert!(socket_of(&facts(Engine::Podman)).unwrap_err().contains("its socket /run/podman/podman.sock is not there"));
        }
    }

    #[test]
    fn heads_are_read_and_rewritten_with_the_connection_told_to_close() {
        let head = parse_request(b"POST /v1.55/containers/create?name=x HTTP/1.1\r\nHost: docker\r\nUser-Agent: Docker-Client\r\nContent-Length: 12\r\nContent-Type: application/json\r\n\r\n").unwrap();
        assert_eq!(
            (head.method.as_str(), head.path.as_str(), head.content_length, head.chunked),
            ("POST", "/v1.55/containers/create?name=x", Some(12), false)
        );
        let sent = String::from_utf8(request_head(&head, "/v1.55/containers/create?name=x", Some(40), false)).unwrap();
        assert!(sent.starts_with("POST /v1.55/containers/create?name=x HTTP/1.1\r\n"));
        assert!(sent.contains("Content-Length: 40\r\n") && !sent.contains("Content-Length: 12"));
        // A body this socket does not rewrite keeps the framing it came with, since the copy is held to it.
        let riding = String::from_utf8(request_head(&head, &head.path, None, false)).unwrap();
        assert!(riding.contains("Content-Length: 12\r\n"), "{riding}");
        let chunked =
            parse_request(b"PUT /v1.55/containers/x/archive HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        let riding = String::from_utf8(request_head(&chunked, &chunked.path, None, false)).unwrap();
        assert!(riding.contains("Transfer-Encoding: chunked\r\n"), "{riding}");
        assert!(sent.contains("User-Agent: Docker-Client\r\n") && sent.ends_with("Connection: close\r\n\r\n"));
        let upgrade = parse_request(
            b"POST /v1.55/exec/e/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        let sent = String::from_utf8(request_head(&upgrade, &upgrade.path, None, true)).unwrap();
        assert!(sent.contains("Connection: Upgrade\r\n") && sent.contains("Upgrade: tcp\r\n") && !sent.contains("Connection: close"));
        let answer = response_head(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n").unwrap();
        assert_eq!((answer.status, answer.raw), (200, false));
        assert_eq!(
            String::from_utf8(answer.head).unwrap(),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"
        );
        let raw = response_head(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();
        assert_eq!(
            (raw.status, raw.raw, raw.head.as_slice()),
            (101, true, &b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"[..])
        );
        assert_eq!(dechunk(b"5\r\nhello\r\n1\r\n!\r\n0\r\n\r\n"), b"hello!");
        assert!(parse_request(b"garbage\r\n\r\n").is_err());
    }

    /// A head that frames its body twice is refused before a byte of it crosses: this socket would read the
    /// length and the engine the chunks, and what lies between the two readings is a request the engine reads
    /// on its own.
    #[test]
    fn a_request_framed_both_ways_is_refused_at_its_head() {
        let smuggling =
            parse_request(b"POST /v1.55/exec/e/start HTTP/1.1\r\nHost: docker\r\nContent-Length: 66\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap_err();
        assert_eq!(smuggling, "a request frames its body with a length or with chunks and not both, and this one carries both");
        assert!(parse_request(b"POST /x HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n").is_ok());
        assert!(parse_request(b"POST /x HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n").is_ok());
    }

    /// One reader of a chunked body's size line, for the fence's own asks and for a body it copies alike.
    #[test]
    fn a_chunk_size_line_reads_one_way() {
        assert_eq!(chunk_size(b"1f4"), Some(500));
        assert_eq!(chunk_size(b"5\r\n"), Some(5));
        assert_eq!(chunk_size(b"a;name=value\r\n"), Some(10));
        assert_eq!(chunk_size(b"0\r\n"), Some(0));
        assert_eq!(chunk_size(b"GET /containers/json HTTP/1.1\r\n"), None);
        assert_eq!(chunk_size(b"\r\n"), None);
        assert_eq!(dechunk(b"5\r\nhello\r\n0\r\n\r\n"), b"hello");
    }

    /// The two routes the engine may hand a connection over on, and the reading that an upgrade asked for on any
    /// other one is dropped from the head before it goes.
    #[test]
    fn an_attach_and_an_exec_start_hijack_and_no_other_route_does() {
        assert!(route("POST", "/v1.55/containers/abc/attach?stream=1").hijacks("POST"));
        assert!(route("POST", "/v1.55/exec/e1/start").hijacks("POST"));
        assert!(!route("GET", "/v1.55/containers/abc/attach").hijacks("GET"));
        assert!(!route("POST", "/v1.55/containers/abc/start").hijacks("POST"));
        assert!(!route("GET", "/v1.55/exec/e1/json").hijacks("GET"));
        assert!(!route("HEAD", "/_ping").hijacks("HEAD"));
        assert!(!route("GET", "/v1.55/containers/abc/logs?follow=1").hijacks("GET"));
        let pinged = parse_request(b"HEAD /_ping HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();
        let sent = String::from_utf8(request_head(&pinged, &pinged.path, None, false)).unwrap();
        assert!(!sent.to_ascii_lowercase().contains("upgrade"), "{sent}");
        assert!(sent.ends_with("Connection: close\r\n\r\n"), "{sent}");
    }

    /// A body of each framing copied on, and nothing behind it: whatever the client pipelined after the framed
    /// body is left on the connection this socket closes.
    #[tokio::test]
    async fn a_body_is_copied_within_its_framing_and_what_follows_it_is_not() {
        let framed = |method: &str, headers: &str| {
            parse_request(format!("{method} /x HTTP/1.1\r\nHost: docker\r\n{headers}\r\n").as_bytes()).unwrap()
        };
        // A length: exactly that many bytes, the rest of what arrived with the head left where it is.
        let head = framed("POST", "Content-Length: 5\r\n");
        let (mut client, _idle) = tokio::io::duplex(64);
        let mut engine = Vec::new();
        copy_body(&mut client, &mut engine, &head, b"helloGET /containers/json HTTP/1.1\r\n\r\n".to_vec()).await.unwrap();
        assert_eq!(engine, b"hello");
        // A length whose bytes come after the head, in a write of their own.
        let (mut client, mut sending) = tokio::io::duplex(64);
        let waited = tokio::spawn(async move {
            let mut engine = Vec::new();
            copy_body(&mut client, &mut engine, &framed("POST", "Content-Length: 12\r\n"), Vec::new()).await.unwrap();
            engine
        });
        sending.write_all(b"twelve bytes").await.unwrap();
        sending.write_all(b"GET /containers/json HTTP/1.1\r\n\r\n").await.unwrap();
        assert_eq!(waited.await.unwrap(), b"twelve bytes");
        // Chunks: through the terminator and its blank line, and nothing behind it.
        let head = framed("PUT", "Transfer-Encoding: chunked\r\n");
        let (mut client, mut sending) = tokio::io::duplex(64);
        let waited = tokio::spawn(async move {
            let mut engine = Vec::new();
            copy_body(&mut client, &mut engine, &head, b"5\r\nhello".to_vec()).await.unwrap();
            engine
        });
        sending.write_all(b"\r\n2\r\n!!\r\n0\r\n\r\nGET /containers/json HTTP/1.1\r\n\r\n").await.unwrap();
        assert_eq!(waited.await.unwrap(), b"5\r\nhello\r\n2\r\n!!\r\n0\r\n\r\n");
        // Neither framing: the request carries no body at all, whatever came in behind the head.
        let head = framed("GET", "");
        let (mut client, _idle) = tokio::io::duplex(64);
        let mut engine = Vec::new();
        copy_body(&mut client, &mut engine, &head, b"GET /containers/json HTTP/1.1\r\n\r\n".to_vec()).await.unwrap();
        assert!(engine.is_empty());
        // A size line that is not a size ends the request rather than being passed on, and the engine has not
        // seen the line: it is read before it is written.
        let head = framed("PUT", "Transfer-Encoding: chunked\r\n");
        let (mut client, _idle) = tokio::io::duplex(64);
        let mut engine = Vec::new();
        let refused = copy_body(&mut client, &mut engine, &head, b"nonsense\r\n".to_vec()).await.unwrap_err();
        assert!(refused.contains("a chunk size this socket cannot read"), "{refused}");
        assert!(engine.is_empty(), "the line reached the engine before it was read: {engine:?}");
    }
}
