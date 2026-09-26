// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops a host sends down a place link, as the engine's MachineBackend and Machine interfaces carry
//! them. The runtime crate answers them there; the daemon refuses them on every socket that is not the link, but
//! for the two read-only ones a person at the computer itself asks of it.

use std::collections::BTreeMap;
use std::num::NonZeroU16;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::validate::{bounded, plain_path, plain_path_opt, positive};
use crate::{RequestId, WorkspaceSize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum MachineKind {
    Sandbox,
    Desktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum OnIdle {
    Pause,
    Kill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineSpec {
    pub kind: MachineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mem_mb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub disk_gb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub envs: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub on_idle: Option<OnIdle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub idle_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub idempotency_key: Option<String>,
    /// The workspace gets the box's container engine through this daemon's fenced socket; refused where the box has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub engine: Option<bool>,
    /// The project this workspace is made with, on a computer the person owns: a checkout on that computer, copied
    /// once for this workspace and mounted read-write inside it at the project's real path. Absent is a workspace
    /// of the computer with no project in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copy: Option<WorkspaceCopy>,
    /// The logins this computer holds for every workspace on it, each mounted into this one. Absent is a
    /// workspace that shares none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shares: Option<Vec<Share>>,
    /// Folders this computer holds, each mounted into the workspace at `target`: a project's memory folder rides
    /// this, so every workspace of one project reads and writes the memory the computer keeps for it. Absent is a
    /// workspace with none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub binds: Option<Vec<Bind>>,
}

/// One folder the computer running a workspace mounts into it, read-write unless the bind says otherwise. Both
/// paths are absolute and are read as paths by the wire itself, as a share's are: a bind mount lands on the
/// workspace's own files and is the one thing a slip cannot be taken back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Bind {
    #[serde(deserialize_with = "plain_path")]
    pub source: String,
    #[serde(deserialize_with = "plain_path")]
    pub target: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
}

/// One file the computer running a workspace keeps outside every one of them and mounts into each at `target`:
/// a login signed in once on that computer, read-write, so a refresh inside one workspace is the computer's own
/// refresh rather than a copy going stale. `source` lives under the daemon's logins directory and a create
/// refuses one that does not; `target` is where the tool reads it inside, both absolute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Share {
    #[serde(deserialize_with = "plain_path")]
    pub source: String,
    #[serde(deserialize_with = "plain_path")]
    pub target: String,
}

/// Where a workspace's copy comes from and where it lands inside: both absolute paths, the first on the computer,
/// the second in the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WorkspaceCopy {
    #[serde(deserialize_with = "plain_path")]
    pub from: String,
    #[serde(deserialize_with = "plain_path")]
    pub at: String,
}

/// How a computer makes a workspace's copy of a checkout: a reflink shares blocks with it, a snapshot is a btrfs
/// subvolume snapshot of it, a plain copy writes every byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum CopyWord {
    Reflink,
    Snapshot,
    Plain,
}

impl CopyWord {
    /// The word the report carries and the host reads.
    pub fn word(self) -> &'static str {
        match self {
            CopyWord::Reflink => "reflink",
            CopyWord::Snapshot => "snapshot",
            CopyWord::Plain => "plain",
        }
    }
}

/// The engine's own error kinds, carried on a refused frame; absent is the link's own: the place is not connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MachineErrorKind {
    Concurrency,
    Plan,
    Missing,
    Conflict,
    SnapshotUnavailable,
    Transient,
    Auth,
    Unknown,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineLinkRequest {
    pub id: RequestId,
    #[serde(flatten)]
    pub op: MachineOp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op")]
pub enum MachineOp {
    #[serde(rename = "machine.backend")]
    Backend,
    #[serde(rename = "machine.capacity")]
    Capacity,
    #[serde(rename = "machine.checkKey")]
    CheckKey,
    #[serde(rename = "machine.create")]
    Create { spec: MachineSpec },
    #[serde(rename = "machine.get", rename_all = "camelCase")]
    Get { machine_id: String },
    #[serde(rename = "machine.list")]
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        labels: Option<BTreeMap<String, String>>,
    },
    #[serde(rename = "machine.exec", rename_all = "camelCase")]
    Exec {
        machine_id: String,
        #[serde(deserialize_with = "bounded::<_, 0, { crate::numbers::EXEC_BODY_MAX }>")]
        cmd: String,
        #[serde(default, deserialize_with = "positive", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        timeout_ms: Option<u32>,
    },
    #[serde(rename = "machine.pause", rename_all = "camelCase")]
    Pause { machine_id: String },
    #[serde(rename = "machine.resume", rename_all = "camelCase")]
    Resume { machine_id: String },
    #[serde(rename = "machine.kill", rename_all = "camelCase")]
    Kill { machine_id: String },
    #[serde(rename = "machine.state", rename_all = "camelCase")]
    State { machine_id: String },
    #[serde(rename = "machine.describe", rename_all = "camelCase")]
    Describe { machine_id: String },
    #[serde(rename = "machine.facts", rename_all = "camelCase")]
    Facts { machine_id: String },
    #[serde(rename = "machine.metrics", rename_all = "camelCase")]
    Metrics { machine_id: String },
    #[serde(rename = "machine.daemonAnswers", rename_all = "camelCase")]
    DaemonAnswers {
        machine_id: String,
        #[serde(default, deserialize_with = "positive", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        timeout_ms: Option<u32>,
    },
    #[serde(rename = "machine.previewUrl", rename_all = "camelCase")]
    PreviewUrl { machine_id: String, port: NonZeroU16 },
    #[serde(rename = "machine.downloadUrl", rename_all = "camelCase")]
    DownloadUrl { machine_id: String, path: String },
    #[serde(rename = "machine.uploadUrl", rename_all = "camelCase")]
    UploadUrl { machine_id: String, path: String },
    #[serde(rename = "machine.putBytes", rename_all = "camelCase")]
    PutBytes {
        machine_id: String,
        path: String,
        #[serde(deserialize_with = "bounded::<_, 0, 32>")]
        upload_id: String,
        seq: u64,
        last: bool,
        data: String,
        #[serde(default, deserialize_with = "positive", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        timeout_ms: Option<u32>,
    },
}

/// The op names above, which the daemon refuses on every socket but the link.
pub const MACHINE_OPS: [&str; 19] = [
    "machine.backend",
    "machine.capacity",
    "machine.checkKey",
    "machine.create",
    "machine.get",
    "machine.list",
    "machine.exec",
    "machine.pause",
    "machine.resume",
    "machine.kill",
    "machine.state",
    "machine.describe",
    "machine.facts",
    "machine.metrics",
    "machine.daemonAnswers",
    "machine.previewUrl",
    "machine.downloadUrl",
    "machine.uploadUrl",
    "machine.putBytes",
];

/// The two of them a client on the computer itself may ask, holding the daemon's own token: what this computer is
/// running and one workspace's reading. Both only read, so neither is the link's to keep; every other op in
/// MACHINE_OPS makes, moves or ends something and stays the link's alone.
pub const MACHINE_OPS_ON_ANY_ROAD: [&str; 2] = ["machine.list", "machine.metrics"];

/// The provider word for a machine's state: a napping workspace's machine reads `paused` here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum MachineState {
    Starting,
    Running,
    Paused,
    Gone,
}

/// How a backend pauses: memory keeps the processes and every byte they hold, disk is a stop and a saved copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PauseMode {
    Memory,
    Disk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum DaemonSupervisor {
    Systemd,
    Entrypoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineSizeOffer {
    pub cpu: f64,
    pub mem_mb: u64,
    pub rate_usd_per_hour: f64,
}

/// The backend's own flags, as the protocol's Capabilities carries them; the app degrades on these, never on probing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub live_clone_forks: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pause_mode: Option<PauseMode>,
    pub replaces_machine: bool,
    pub preview_urls: bool,
    pub signed_urls: bool,
    pub callback_relay: bool,
    pub disk_snapshots: bool,
    /// The backend keeps images at all: a template or a snapshot a fork can boot from. False on a computer
    /// somebody joined, where a workspace is a copy of that computer itself and nothing is pulled or built.
    pub images: bool,
    /// A copy may be taken from any life of the machine, not only its first; false where the provider refuses a
    /// machine that was resumed.
    pub snapshots_any_life: bool,
    pub snapshot_listing: bool,
    pub templates: bool,
    pub sizes: Vec<MachineSizeOffer>,
    pub kept: bool,
    /// The computer makes a workspace as a copy of itself with the project inside.
    pub copies: bool,
    /// A copy gets its own network: its own localhost, its own ports. False on a Mac, where ports are shared.
    pub own_network: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStoragePricing {
    pub free_gb: f64,
    pub usd_per_gb_month: f64,
    pub billed_from: String,
}

/// Pricing as a wire carries it: the numbers, never the function the engine builds from them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackendPricing {
    pub default_size: WorkspaceSize,
    pub snapshot_storage: SnapshotStoragePricing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub builder_disk_gb: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ResumeAsks {
    pub every_ms: u64,
    pub for_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleBudgets {
    pub wake_attempts: u32,
    pub daemon_answers_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume_asks: Option<ResumeAsks>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Lifecycle {
    pub budgets: LifecycleBudgets,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BaseTemplates {
    pub sandbox: String,
    pub desktop: String,
}

/// What a backend says about itself once, when a link opens: the machine.backend reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackendFacts {
    pub offer: String,
    pub capabilities: Capabilities,
    pub pricing: BackendPricing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lifecycle: Option<Lifecycle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_templates: Option<BaseTemplates>,
    /// Where this computer keeps the logins every workspace on it shares, absolute. Absent from a backend that
    /// shares none, which is every provider: a machine somebody else runs has no file of this person's on it.
    #[serde(default, deserialize_with = "plain_path_opt", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub logins: Option<String>,
    /// Where this computer keeps the project checkouts it holds and each project's own memory, absolute. Absent
    /// from a backend that keeps none, which is every provider: what a project is there lives in an image.
    #[serde(default, deserialize_with = "plain_path_opt", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projects: Option<String>,
}

/// Which optional calls a handle carries, so the client builds a machine whose methods are present exactly where
/// the backend's are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineRoads {
    pub preview_url: bool,
    pub daemon_answers: bool,
    pub put_bytes: bool,
    pub describe: bool,
    pub facts: bool,
    pub metrics: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineSeen {
    pub state: MachineState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<String>,
}

/// One machine as the place hands it over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineHandle {
    pub id: String,
    pub kind: MachineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stream_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seen: Option<MachineSeen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replayed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub daemon_supervisor: Option<DaemonSupervisor>,
    /// One sentence on a create or a fork whose size the computer would not give as asked, naming what it gave
    /// instead; the record holds the size itself, so this is said once and never read back for a number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notice: Option<String>,
    pub roads: MachineRoads,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineListRow {
    pub id: String,
    pub state: MachineState,
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<WorkspaceSize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineShape {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mem_mb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub disk_gb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<String>,
    /// What the machine has written since it booted, where the backend can read that: a workspace's upper directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub used_bytes: Option<u64>,
}

/// One workspace as the computer running it reads it, in one frame: the sizes its cgroup was written with, what it
/// holds of them now, and where its processes, its files and its address are. Every figure is read at the moment of
/// the ask rather than sampled, so a row drawn from it is true of that moment and of no moment since; a workspace
/// that is not running carries the sizes and the paths and none of the live figures.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineReading {
    pub state: MachineState,
    /// The cores and the memory the workspace was given, as they were applied rather than as they were asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mem_mb: Option<u64>,
    /// What its cgroup holds this moment, against the cap memMb names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mem_bytes: Option<u64>,
    /// The processor time its cgroup has spent since the workspace booted; a rate is the difference between two
    /// readings, which is the caller's to take.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpu_usage_usec: Option<u64>,
    /// How long its first process has been running, which a wake starts again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub uptime_ms: Option<u64>,
    /// Every process in its cgroup and in the cgroups under it, which is what a container engine inside it makes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub procs: Option<u64>,
    /// Milliseconds since this computer last saw the workspace do anything on its own: a byte through a published
    /// port, or a command run in it. Counts from the boot until something happens. Absent when it is not running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quiet_for_ms: Option<u64>,
    /// The address it answers on inside the computer's own network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub address: Option<String>,
    pub cgroup: String,
    /// The overlay directory holding everything it has written since it was made, which is what a snapshot saves.
    pub upper: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceImage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineCounts {
    pub running: u64,
    pub paused: u64,
}

/// What the computer holding a backend has left for one more machine: the machine.capacity reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceCapacity {
    pub cores: u64,
    pub mem_mb: u64,
    pub mem_room_mb: u64,
    pub machine_mem_mb: u64,
    /// What the workspaces on this computer hold of it right now, summed over the ones that are not stopped:
    /// the cores their quotas name and the memory their caps name. Absent from a backend that counts neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpu_taken: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mem_taken_mb: Option<u64>,
    pub disk_free_bytes: u64,
    pub images: Vec<PlaceImage>,
    pub machines: MachineCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineHandleReply {
    pub machine: MachineHandle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineListReply {
    pub machines: Vec<MachineListRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineExecReply {
    pub result: ExecResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineStateReply {
    pub state: MachineState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineShapeReply {
    pub shape: MachineShape,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineReadingReply {
    pub reading: MachineReading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineAnswersReply {
    pub answers: bool,
}

/// Where a host dials one port of a machine: a URL, the token the route wants and when it expires. A route on a
/// place's own loopback carries no token and never expires, which the two empty values say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReach {
    pub url: String,
    pub token: String,
    pub expires_at: u64,
}

impl PreviewReach {
    /// What a reach that never expires carries, node's Number.MAX_SAFE_INTEGER, as the Docker backend answers it.
    pub const NEVER: u64 = 9_007_199_254_740_991;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineReachReply {
    pub reach: PreviewReach,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_carries_the_logins_the_computer_shares_and_a_spec_without_them_carries_no_key() {
        let bare = MachineSpec {
            kind: MachineKind::Sandbox,
            template: None,
            from_snapshot: None,
            cpu: None,
            mem_mb: None,
            disk_gb: None,
            envs: None,
            labels: None,
            on_idle: None,
            idle_timeout_ms: None,
            idempotency_key: None,
            engine: None,
            copy: None,
            shares: None,
            binds: None,
        };
        let written = serde_json::to_string(&bare).unwrap();
        assert_eq!(written, r#"{"kind":"sandbox"}"#);
        assert_eq!(serde_json::from_str::<MachineSpec>(&written).unwrap(), bare);
        let shared = MachineSpec {
            shares: Some(vec![Share {
                source: "/var/lib/wsp/logins/codex/auth.json".to_owned(),
                target: "/root/.codex/auth.json".to_owned(),
            }]),
            ..bare
        };
        let written = serde_json::to_string(&shared).unwrap();
        assert_eq!(
            written,
            r#"{"kind":"sandbox","shares":[{"source":"/var/lib/wsp/logins/codex/auth.json","target":"/root/.codex/auth.json"}]}"#
        );
        assert_eq!(serde_json::from_str::<MachineSpec>(&written).unwrap(), shared);
        // Both paths are read by the wire's own rule: a bind mount is the one thing a slip cannot be taken back.
        for bad in [
            r#"{"kind":"sandbox","shares":[{"source":"logins/codex/auth.json","target":"/root/.codex/auth.json"}]}"#,
            r#"{"kind":"sandbox","shares":[{"source":"/var/lib/wsp/logins/../../root/.ssh/id","target":"/root/.codex/auth.json"}]}"#,
            r#"{"kind":"sandbox","shares":[{"source":"/var/lib/wsp/logins/codex/auth.json","target":"/root/../etc/passwd"}]}"#,
        ] {
            assert!(serde_json::from_str::<MachineSpec>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_spec_carries_the_folders_the_computer_binds_and_reads_both_paths_as_paths() {
        let bare = MachineSpec {
            kind: MachineKind::Sandbox,
            template: None,
            from_snapshot: None,
            cpu: None,
            mem_mb: None,
            disk_gb: None,
            envs: None,
            labels: None,
            on_idle: None,
            idle_timeout_ms: None,
            idempotency_key: None,
            engine: None,
            copy: None,
            shares: None,
            binds: None,
        };
        let bound = MachineSpec {
            binds: Some(vec![Bind {
                source: "/wsp/projects/pr_1/memory".to_owned(),
                target: "/root/.claude-cfg/projects/-root-wsp/memory".to_owned(),
                read_only: false,
            }]),
            ..bare.clone()
        };
        let written = serde_json::to_string(&bound).unwrap();
        // A bind that is read-write carries no key for it, so a spec written before there were binds and one
        // written now read the same on the far side.
        assert_eq!(
            written,
            r#"{"kind":"sandbox","binds":[{"source":"/wsp/projects/pr_1/memory","target":"/root/.claude-cfg/projects/-root-wsp/memory"}]}"#
        );
        assert_eq!(serde_json::from_str::<MachineSpec>(&written).unwrap(), bound);
        let read_only = MachineSpec {
            binds: Some(vec![Bind { source: "/wsp/projects/pr_1/memory".to_owned(), target: "/root/memory".to_owned(), read_only: true }]),
            ..bare.clone()
        };
        let written = serde_json::to_string(&read_only).unwrap();
        assert!(written.contains(r#""readOnly":true"#), "{written}");
        assert_eq!(serde_json::from_str::<MachineSpec>(&written).unwrap(), read_only);
        // Both paths are read by the wire's own rule, as a share's are: a bind mount is the one thing a slip
        // cannot be taken back.
        for bad in [
            r#"{"kind":"sandbox","binds":[{"source":"projects/pr_1/memory","target":"/root/memory"}]}"#,
            r#"{"kind":"sandbox","binds":[{"source":"/var/lib/wsp/../../root/.ssh","target":"/root/memory"}]}"#,
            r#"{"kind":"sandbox","binds":[{"source":"/wsp/projects/pr_1/memory","target":"/root/../etc"}]}"#,
        ] {
            assert!(serde_json::from_str::<MachineSpec>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_backend_says_where_the_logins_it_shares_live_and_only_as_a_path() {
        let facts = r#"{"offer":"runtime","capabilities":{"liveCloneForks":false,"replacesMachine":true,"previewUrls":false,"signedUrls":false,"callbackRelay":false,"diskSnapshots":true,"images":false,"snapshotsAnyLife":false,"snapshotListing":true,"templates":true,"sizes":[],"kept":false,"copies":true,"ownNetwork":true},"pricing":{"defaultSize":{"cpu":2,"memMb":4096},"snapshotStorage":{"freeGb":0,"usdPerGbMonth":0,"billedFrom":""}}}"#;
        assert_eq!(serde_json::from_str::<BackendFacts>(facts).unwrap().logins, None);
        let shared = facts.replace(r#"{"offer":"runtime""#, r#"{"logins":"/var/lib/wsp/logins","offer":"runtime""#);
        assert_eq!(serde_json::from_str::<BackendFacts>(&shared).unwrap().logins.as_deref(), Some("/var/lib/wsp/logins"));
        let relative = facts.replace(r#"{"offer":"runtime""#, r#"{"logins":"logins","offer":"runtime""#);
        assert!(serde_json::from_str::<BackendFacts>(&relative).is_err());
    }

    #[test]
    fn a_backend_says_where_the_projects_it_holds_live_and_only_as_a_path() {
        let facts = r#"{"offer":"runtime","capabilities":{"liveCloneForks":false,"replacesMachine":true,"previewUrls":false,"signedUrls":false,"callbackRelay":false,"diskSnapshots":true,"images":false,"snapshotsAnyLife":false,"snapshotListing":true,"templates":true,"sizes":[],"kept":false,"copies":true,"ownNetwork":true},"pricing":{"defaultSize":{"cpu":2,"memMb":4096},"snapshotStorage":{"freeGb":0,"usdPerGbMonth":0,"billedFrom":""}}}"#;
        assert_eq!(serde_json::from_str::<BackendFacts>(facts).unwrap().projects, None);
        let holding = facts.replace(r#"{"offer":"runtime""#, r#"{"projects":"/wsp/projects","offer":"runtime""#);
        assert_eq!(serde_json::from_str::<BackendFacts>(&holding).unwrap().projects.as_deref(), Some("/wsp/projects"));
        let relative = facts.replace(r#"{"offer":"runtime""#, r#"{"projects":"projects","offer":"runtime""#);
        assert!(serde_json::from_str::<BackendFacts>(&relative).is_err());
    }
}
