// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's bundle under `<root>/run/<id>`: a rootfs made of the computer's own system directories, one
//! read-only overlay each with an upper and a work directory of its own, the box's /root bound in with the
//! daemon's own folder blanked over it, the files the container binds over /etc, the record the ops keep, and the
//! config.json youki reads, built from the embedded profile plus what the spec asks for. Every path the runtime
//! writes under its root is spelled in `Layout` and nowhere else.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{open, openat, openat2, readlinkat, OFlag, OpenHow, ResolveFlag};
use nix::mount::{mount, umount2, MntFlags, MsFlags};
use nix::sys::stat::{fstat, mkdirat, stat, Mode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wsp_frames::numbers::GUEST_WSP_HOME;
use wsp_frames::{Bind, CopyWord, Share};

use crate::doctor::OVERLAID;
use crate::hardening;
use crate::profile;

/// Every path the runtime writes under its root.
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(root: &Path) -> Layout {
        Layout { root: root.to_path_buf() }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn run(&self) -> PathBuf {
        self.root.join("run")
    }
    /// The bundle: config.json, the record, the rootfs mount point, the upper and work directories.
    pub fn workspace(&self, id: &str) -> PathBuf {
        self.run().join(id)
    }
    pub fn rootfs(&self, id: &str) -> PathBuf {
        self.workspace(id).join("rootfs")
    }
    /// What every path under that rootfs is opened through: the one road a mount, a create or a write inside a
    /// workspace takes, so no destination there is ever named by a path the kernel resolves a second time.
    pub fn inside_of(&self, id: &str) -> Inside {
        Inside { rootfs: self.rootfs(id), uppers: self.upper_roots(id), id: id.to_owned() }
    }
    /// Every overlay's upper under one directory: what the workspace has written since it booted, which is what
    /// a stop keeps and a describe counts.
    pub fn upper(&self, id: &str) -> PathBuf {
        self.workspace(id).join("upper")
    }
    /// The upper of the overlay over one of the computer's system directories.
    pub fn upper_of(&self, id: &str, dir: &str) -> PathBuf {
        self.upper(id).join(dir.trim_start_matches('/'))
    }
    pub fn work(&self, id: &str) -> PathBuf {
        self.workspace(id).join("work")
    }
    /// The work directory overlayfs needs beside that upper, on the same filesystem as it.
    pub fn work_of(&self, id: &str, dir: &str) -> PathBuf {
        self.work(id).join(dir.trim_start_matches('/'))
    }
    /// The upper and work directories of an overlay of a tree the box lends inside a tree the workspace owns, the
    /// package database under its own /var among them. Kept apart from that tree's own upper rather than under it:
    /// one overlay's upper directory sitting inside another's is a shape overlayfs says nothing good about, and
    /// what the workspace wrote is still one tree to count and one tree to keep.
    pub fn lent_upper_of(&self, id: &str, at: &str) -> PathBuf {
        self.upper(id).join(Layout::LENT).join(at.trim_start_matches('/'))
    }
    pub fn lent_work_of(&self, id: &str, at: &str) -> PathBuf {
        self.work(id).join(Layout::LENT).join(at.trim_start_matches('/'))
    }
    /// What the lent trees' own directories are held under, named here and read nowhere else.
    const LENT: &'static str = "lent";
    /// Every directory a workspace's own writes land in, which is what says whose a link met inside a workspace
    /// is: the uppers of the trees it owns and the uppers of the trees the box lends inside them.
    pub fn upper_roots(&self, id: &str) -> [PathBuf; 2] {
        [self.upper(id), self.upper(id).join(Layout::LENT)]
    }
    /// The workspace's own wsp folder, bound over the box's at `GUEST_WSP_HOME`: where the daemon inside writes
    /// its token, its inbox and its manifest. Its own rather than the computer's, since the box's /root is
    /// shared by every workspace on it and a token is not a thing two workspaces may take turns writing. Kept
    /// by a stop as the uppers are, so a wake reads back what the daemon inside wrote.
    pub fn wsp_home(&self, id: &str) -> PathBuf {
        self.workspace(id).join("wsp-home")
    }
    /// The socket the computer's own daemon binds inside one workspace, in that folder and so in that
    /// workspace's view alone. Named here rather than where it is bound: the daemon binds what this hands it and
    /// the stop takes the same path off, so a stopped workspace holds no socket of a daemon that may not even be
    /// the one that bound it.
    pub fn guest_socket(&self, id: &str) -> PathBuf {
        self.wsp_home(id).join(guest_socket_name())
    }
    /// An empty directory of the workspace's own, bound over a path inside it that the computer's own directory
    /// holds something at: the engine's data under /var/lib. One directory per path, since what the workspace
    /// writes at one of them is not what it writes at another.
    pub fn empty_at(&self, id: &str, at: &str) -> PathBuf {
        self.workspace(id).join("empty").join(at.trim_start_matches('/'))
    }
    /// The lower of one tree's overlay where that tree is not the box's own directory taken whole: built fresh at
    /// every boot, holding what of the box's a workspace is allowed to read and the skeleton the tree needs. One
    /// directory per tree, under the workspace's own folder, so a stop takes it and a boot writes it again.
    pub fn view(&self, id: &str, dir: &str) -> PathBuf {
        self.workspace(id).join("view").join(dir.trim_start_matches('/'))
    }
    /// The workspace's own copy of a file the box keeps under the home every workspace here shares, or its own
    /// folder where the box keeps one: taken at the first boot that finds no copy and kept across wakes as the
    /// uppers are, so what a login inside writes in its rc files is the workspace's and what the box root's own
    /// login reads is the box's. One directory per path, as the empty ones are.
    pub fn own_at(&self, id: &str, at: &str) -> PathBuf {
        self.workspace(id).join("own").join(at.trim_start_matches('/'))
    }
    /// The three files bound over the container's /etc.
    pub fn etc(&self, id: &str) -> PathBuf {
        self.workspace(id).join("etc")
    }
    pub fn config(&self, id: &str) -> PathBuf {
        self.workspace(id).join("config.json")
    }
    pub fn record(&self, id: &str) -> PathBuf {
        self.workspace(id).join("workspace.json")
    }
    /// The mount points this boot has made on the computer's own disk, written under the claim before the
    /// container is created and taken away by the record write that carries them: between those two moments the
    /// claim is the only thing naming what the boot put on the computer's home, so a create that fails there, or
    /// a daemon that dies there, still leaves the remove and the open's sweep something to take off.
    pub fn points(&self, id: &str) -> PathBuf {
        self.workspace(id).join("points.json")
    }
    /// The workspace's network: its link, its addresses and the ports published for it.
    pub fn net(&self, id: &str) -> PathBuf {
        self.workspace(id).join("net.json")
    }
    /// What the boot command prints, since its first process is nobody's child to read.
    pub fn boot_log(&self, id: &str) -> PathBuf {
        self.workspace(id).join("boot.log")
    }
    /// The directory holding the workspace's fenced engine socket, bound into it where it asked for an engine.
    pub fn engine(&self, id: &str) -> PathBuf {
        self.workspace(id).join("engine")
    }
    /// Where the fence stages the sources a container of this workspace binds, one entry per source: the fence
    /// opens the source beneath the rootfs with no link followed and binds it here, and this is the path the
    /// engine is handed. Beside the engine socket's directory and bound into the workspace nowhere, so nothing
    /// inside reaches an entry to unlink it and put a link of its own in its place before the container starts.
    pub fn binds(&self, id: &str) -> PathBuf {
        self.workspace(id).join("binds")
    }
    /// youki's own root: `<root>/state/<id>` holds its state.json and notify sockets.
    pub fn state(&self) -> PathBuf {
        self.root.join("state")
    }
    pub fn state_of(&self, id: &str) -> PathBuf {
        self.state().join(id)
    }
    /// The parts of one upload while they arrive.
    pub fn put(&self, upload_id: &str) -> PathBuf {
        self.root.join("put").join(upload_id)
    }
    /// Scratch for the self check's overlay mount and the clone probe the copies word is read from. Its upper
    /// sits under the root, as a workspace's own does, which is why a root under one of the directories a
    /// workspace overlays is refused before either is made.
    pub fn check(&self) -> PathBuf {
        self.root.join("check")
    }
    /// Every workspace's own copy of the checkout it was made with, one directory per workspace.
    pub fn copies(&self) -> PathBuf {
        self.root.join("copies")
    }
    pub fn copy_of(&self, id: &str) -> PathBuf {
        self.copies().join(id)
    }
    /// Where a copy is made before it is one: a create that dies mid-copy leaves this rather than a half
    /// written `copy_of`, and the open sweeps every one of them. The copy is renamed into place, which is one
    /// directory entry, only once every byte of it is there.
    pub fn copy_being_made(&self, id: &str) -> PathBuf {
        self.copies().join(format!(".{id}{}", Layout::PARTIAL))
    }
    /// The mark a name being made carries, written by `copy_being_made` and read by `copy_belongs_to`, which are
    /// the only two that know it.
    const PARTIAL: &'static str = ".partial";
    /// The workspace a name under the copies directory belongs to: the name itself, or what the mark above wraps.
    /// The sweep asks it of every name it finds there, since a copy belongs to one workspace and to nothing else.
    pub fn copy_belongs_to(name: &str) -> String {
        name.strip_suffix(Layout::PARTIAL).and_then(|rest| rest.strip_prefix('.')).unwrap_or(name).to_owned()
    }
    /// Where this computer keeps the logins every workspace on it shares, one directory per tool: a login signed
    /// in once here, outside every workspace, and mounted into each of them. Nothing under it is ever in an image.
    pub fn logins(&self) -> PathBuf {
        self.root.join("logins")
    }
    /// Where the project checkouts a box holds live; the copies directory sits beside it under the same root,
    /// which is what lets a copy share blocks with the checkout it was made from.
    pub fn projects(&self) -> PathBuf {
        self.root.join("projects")
    }
    /// The workspace's cgroup as the spec names it, under the cgroup root.
    pub fn cgroup_name(&self, id: &str) -> String {
        format!("/wsp/{id}")
    }
    /// Where the plain cgroup manager puts it.
    pub fn cgroup_dir(&self, id: &str) -> PathBuf {
        Path::new(crate::freeze::CGROUP_ROOT).join(self.cgroup_name(id).trim_start_matches('/'))
    }
}

/// The init process as it was at create: its pid, and what tells that pid apart from any process the kernel
/// hands the same number to later, or after a reboot. youki's state file keeps the pid alone and reads any live
/// process under it as the container, which is not a reading this crate may act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Init {
    pub pid: i32,
    /// Its start time in clock ticks since boot, field 22 of /proc/<pid>/stat.
    pub started: u64,
    /// The box's boot id, since ticks since boot start over with it.
    pub boot_id: String,
}

/// What the ops keep about one workspace: the spec as it was built, when, and the init that runs it. It names no
/// image, since every workspace here is made of this computer's own directories: a wake mounts them again as they
/// are now, which is the box's own upgrades and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub hostname: String,
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub envs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_mb: Option<u64>,
    pub created_at: String,
    pub init: Init,
    /// The workspace asked for the box's container engine, so every boot serves the fenced socket into it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub engine: bool,
    /// The project this workspace was made with, where it was made with one: the copy of a checkout this
    /// computer holds, bound inside at the project's own path by every boot. A record written before any
    /// workspace took a project reads as one without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<CopyMade>,
    /// The logins this computer holds and this workspace was made with, mounted into it by every boot: a wake
    /// takes whatever the file says now, which is what makes one sign-in on the computer the workspaces' own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<Share>,
    /// The folders of this computer's own this workspace was made with, mounted into it by every boot: a
    /// project's memory folder is one, so every workspace of that project works the same memory. A record
    /// written before any workspace took one reads as a workspace with none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub binds: Vec<Bind>,
    /// The mount points this workspace's boot made under a tree the rootfs takes from the computer, as the
    /// computer's own paths rather than the paths under the rootfs, which name nothing once the unmount has run.
    /// A shared login is bound at the agent's own path inside, and under /root that path is the computer's own
    /// home, so the empty file the bind lands on is made on the computer's disk: kept here so the stop and the
    /// remove take off what this workspace put there and nothing the person had. A record written before this
    /// reads as a workspace that made none. Until this record is written the claim's own points file carries
    /// them, and what the take-off reads is the two together.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub made_points: Vec<String>,
}

/// The copy one workspace was made with, as the create made it: where it came from, where it is mounted inside,
/// the way this disk made it and how long that took. The way is kept because the remove takes a snapshot away
/// through the kernel and a copied tree away through the filesystem, and the time because a plain copy's minutes
/// are a thing the person is told rather than left to guess at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyMade {
    pub from: String,
    pub at: String,
    pub made: CopyWord,
    pub ms: u64,
}

/// What one config.json is built from, beside the profile.
pub struct Config<'a> {
    pub hostname: &'a str,
    /// The process youki starts: the init in front of the boot command.
    pub args: &'a [String],
    pub envs: &'a BTreeMap<String, String>,
    pub cpu: Option<f64>,
    pub mem_mb: Option<u64>,
    pub cgroup: &'a str,
    /// The binary bound at `INIT_PATH`: this daemon's own.
    pub init: &'a Path,
    /// The directory holding hostname, hosts and resolv.conf.
    pub etc: &'a Path,
    /// The directory holding the engine socket, bound at `engine::INSIDE_DIR` where the workspace asked for one.
    pub engine: Option<&'a Path>,
    /// The computer's own logins, each bound at the path its tool reads inside; empty where none is shared.
    pub shares: &'a [Share],
    /// The computer's own folders, each bound at the path the workspace reads inside; empty where there are none.
    pub binds: &'a [Bind],
    /// The install roots this computer has of the ones outside the overlaid trees, bound read-only at their own
    /// paths: without them the tools a road installed there are on the computer and out of every workspace's
    /// sight, while the PATH inside names them. Read at every boot, so a Homebrew installed after the create is
    /// inside at the next wake.
    pub tool_roots: &'a [&'a str],
    /// The compose project every container engine call inside the workspace belongs to, where the workspace asked
    /// for an engine; nothing where it did not, since a workspace with no engine runs no compose.
    pub compose_project: Option<&'a str>,
}

#[derive(Debug)]
pub struct Error {
    pub path: PathBuf,
    pub source: io::Error,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path.display(), self.source)
    }
}

impl std::error::Error for Error {}

fn at(path: &Path) -> impl FnOnce(io::Error) -> Error + '_ {
    move |source| Error { path: path.to_owned(), source }
}

fn nix_at(path: &Path) -> impl FnOnce(nix::Error) -> Error + '_ {
    move |e| Error { path: path.to_owned(), source: io::Error::from(e) }
}

/// The config.json for one workspace: the profile with the root, the hostname, the process, the resources and
/// the bind mounts filled in.
pub fn config_json(c: &Config) -> Value {
    let mut spec = profile::profile();
    spec["root"] = json!({ "path": "rootfs", "readonly": false });
    spec["hostname"] = json!(c.hostname);
    spec["process"]["args"] = json!(c.args);
    spec["process"]["cwd"] = json!("/");
    // The order a workspace on this computer reads its directories in, with the home every workspace here shares
    // after the folders none of them can write. The host sends the same value in the envs below, and the crate
    // keeps the later entry of a name, so this line is the boot's PATH where a create carries none.
    let mut env = vec![format!("PATH={}", wsp_frames::numbers::PLACE_WORKSPACE_PATH), format!("HOSTNAME={}", c.hostname)];
    env.extend(c.envs.iter().map(|(k, v)| format!("{k}={v}")));
    // Last of the environment, so it stands whatever else was asked for: two workspaces of one project whose
    // compose names are both the project's own directory name fail at compose's network step, the second one
    // finding the first one's network under the name it wants (measured on a box). One name per workspace is
    // what makes the two of them two stacks.
    if let Some(project) = c.compose_project {
        env.push(format!("COMPOSE_PROJECT_NAME={project}"));
    }
    spec["process"]["env"] = json!(env);
    let bind = |destination: &str, source: PathBuf, options: &[&str]| json!({ "destination": destination, "type": "bind", "source": source, "options": options });
    let mounts = spec["mounts"].as_array_mut().expect("the profile lists mounts");
    mounts.push(bind(profile::INIT_PATH, c.init.to_path_buf(), &["bind", "ro"]));
    for name in ["resolv.conf", "hostname", "hosts"] {
        mounts.push(bind(&format!("/etc/{name}"), c.etc.join(name), &["rbind", "rprivate"]));
    }
    if let Some(engine) = c.engine {
        mounts.push(bind(crate::engine::INSIDE_DIR, engine.to_path_buf(), &["rbind", "rprivate"]));
    }
    // Read-write, and the one file rather than the directory around it: the tool refreshes its own login in
    // place, and what it writes is what the computer holds for every other workspace on it.
    for share in c.shares {
        mounts.push(bind(&share.target, PathBuf::from(&share.source), &["rbind", "rw"]));
    }
    // A whole folder of the computer's, read-write unless the bind says otherwise: what the workspace writes in
    // it is what the computer holds for every other workspace of the same project. The same words a shared login
    // takes, and no propagation word here either: the boot makes every one of these binds itself through
    // `bind_into`, which is where the one propagation rule for everything under a rootfs lives.
    for b in c.binds {
        mounts.push(bind(&b.target, PathBuf::from(&b.source), if b.read_only { &["rbind", "ro"] } else { &["rbind", "rw"] }));
    }
    // An install root of the computer's own at its own path inside, read-only: a workspace reads the tools a road
    // installed there and writes none of them, since an install happens on the computer and nowhere else. What a
    // tool writes while it runs goes under /root, which is the computer's own and read-write already.
    for root in c.tool_roots {
        mounts.push(bind(root, PathBuf::from(root), &["rbind", "ro"]));
    }
    spec["linux"]["cgroupsPath"] = json!(c.cgroup);
    let mut resources = serde_json::Map::new();
    if let Some(mem_mb) = c.mem_mb {
        resources.insert("memory".into(), json!({ "limit": mem_mb * 1024 * 1024 }));
    }
    if let Some(cpu) = c.cpu {
        // Docker's NanoCpus as a quota over the default period: 2 cpus is 200000 of every 100000 microseconds.
        resources.insert("cpu".into(), json!({ "quota": (cpu * 100_000.0).round() as i64, "period": 100_000 }));
    }
    if !resources.is_empty() {
        spec["linux"]["resources"] = Value::Object(resources);
    }
    spec
}

/// The three files bound over /etc: the hostname, a hosts file naming it and the box at `host.wsp.internal` once
/// the gateway is known, and the box's resolvers.
pub fn write_etc(etc: &Path, hostname: &str, gateway: Option<Ipv4Addr>) -> Result<(), Error> {
    fs::create_dir_all(etc).map_err(at(etc))?;
    let hostname_file = etc.join("hostname");
    fs::write(&hostname_file, format!("{hostname}\n")).map_err(at(&hostname_file))?;
    let hosts = etc.join("hosts");
    fs::write(&hosts, hosts_text(hostname, gateway)).map_err(at(&hosts))?;
    let resolv = etc.join("resolv.conf");
    fs::write(&resolv, resolv_text(&read_or_empty(BOX_RESOLV), &read_or_empty(UPSTREAM_RESOLV))).map_err(at(&resolv))?;
    Ok(())
}

pub fn hosts_text(hostname: &str, gateway: Option<Ipv4Addr>) -> String {
    let mut text = format!("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.0.1\t{hostname}\n");
    if let Some(gateway) = gateway {
        text.push_str(&format!("{gateway}\t{}\n", crate::net::HOST_NAME));
    }
    text
}

const BOX_RESOLV: &str = "/etc/resolv.conf";
/// Where systemd-resolved keeps the resolvers it forwards to, when the box's own file names only its stub.
const UPSTREAM_RESOLV: &str = "/run/systemd/resolve/resolv.conf";
/// Where a workspace reads its resolvers, which is where the box has a link on every computer that runs
/// systemd-resolved: the box's own path, read here as a path inside a workspace.
const RESOLV_INSIDE: &str = BOX_RESOLV;
/// The resolvers Docker hands a container when the box names none it can use.
const DEFAULT_NAMESERVERS: [&str; 2] = ["8.8.8.8", "8.8.4.4"];

fn read_or_empty(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// The box's resolv.conf as a workspace can use it: a nameserver on the box's own loopback is a stub the workspace
/// cannot reach, so the upstream file stands in for it; IPv6 nameservers go, since the workspace has no IPv6 route;
/// a box with no usable nameserver gets Docker's defaults. Search and options lines come along as they are.
pub fn resolv_text(box_file: &str, upstream: &str) -> String {
    let usable = |file: &str| -> Vec<String> {
        file.lines()
            .filter_map(|line| line.trim().strip_prefix("nameserver").map(str::trim))
            .filter_map(|word| word.parse::<IpAddr>().ok())
            .filter(|ip| matches!(ip, IpAddr::V4(v4) if !v4.is_loopback()))
            .map(|ip| ip.to_string())
            .collect()
    };
    let (mut servers, source) = match usable(box_file) {
        found if !found.is_empty() => (found, box_file),
        _ => match usable(upstream) {
            found if !found.is_empty() => (found, upstream),
            _ => (Vec::new(), box_file),
        },
    };
    if servers.is_empty() {
        servers = DEFAULT_NAMESERVERS.iter().map(|s| (*s).to_owned()).collect();
    }
    let mut text = String::new();
    for server in servers {
        text.push_str(&format!("nameserver {server}\n"));
    }
    for line in source.lines().map(str::trim) {
        if line.starts_with("search ") || line.starts_with("options ") {
            text.push_str(line);
            text.push('\n');
        }
    }
    text
}

/// One overlay: the lower directory read only under the workspace's own upper and work directories, mounted
/// nodev so no device node under the lower reaches a device from inside.
pub fn mount_overlay(lower: &Path, upper: &Path, work: &Path, target: &Path) -> Result<(), Error> {
    mount_overlay_at(lower, upper, work, target, target)
}

/// The same, landed on a descriptor's own name under proc, with the path a person reads for the failure.
fn mount_overlay_at(lower: &Path, upper: &Path, work: &Path, target: &Path, named: &Path) -> Result<(), Error> {
    let data = format!("lowerdir={},upperdir={},workdir={}", lower.display(), upper.display(), work.display());
    mount(Some("overlay"), target, Some("overlay"), MsFlags::MS_NODEV, Some(data.as_str())).map_err(nix_at(named))
}

/// The directories a rootfs carries whatever the box holds: the mount points of the overlays and the binds
/// above, the ones youki mounts the kernel's own filesystems at, and the ones a login expects to be there.
const SKELETON: [&str; 15] =
    ["usr", "etc", "opt", "var", "srv", "root", "home", "tmp", "run", "proc", "sys", "dev", "mnt", "media", "boot"];

/// What that socket is called in the workspace's own wsp folder: the last part of the path a process inside
/// dials it by, so the two halves of that path are never spelled apart.
fn guest_socket_name() -> &'static str {
    Path::new(wsp_frames::numbers::GUEST_DAEMON_SOCKET_PATH)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .expect("the guest socket path names a file")
}

/// The two a boot empties: every distribution expects /run and /tmp empty at boot, since what is in them is pid
/// files and sockets of processes that are gone. They are plain directories of the workspace's own on the
/// daemon's disk rather than a tmpfs, which is what keeps the box's own engine socket at /run/docker.sock out of
/// a workspace, so emptying them is this function's to do and not the kernel's.
const EMPTIED_AT_BOOT: [&str; 2] = ["run", "tmp"];

/// The rootfs of a workspace on a computer somebody owns, made fresh at every boot: the box's own top-level
/// symlinks as the box writes them, an empty directory for everything else, /run and /tmp emptied, the rootfs
/// made a mount of its own that propagates nothing, an overlay over each of the computer's system directories,
/// the box's /root bound in read-write so the agents' sign-ins and caches are the person's own, the workspace's
/// own wsp folder over the box's, and an empty file or directory of the workspace's own over every path
/// `hardening::covered` names. The copy of a project and youki's own mounts come after, in the boot.
///
/// Every mount here is the workspace's alone: `bind_into` says why that takes two calls rather than one.
///
/// Nothing here is reached under a root that sits inside one of the overlaid directories: the open refuses such
/// a root before it makes anything and `crate::doctor::root_under_a_lower` says which lower it sits under. The
/// kernel takes that mount, and what it gives is a workspace reading its own upper inside the directory it
/// overlays, which is why DEFAULT_ROOT is `/wsp`.
pub fn mount_computer(layout: &Layout, id: &str, tool_roots: &[&str]) -> Result<(), Error> {
    let rootfs = layout.rootfs(id);
    // Before anything: a computer whose /bin is a directory of its own rather than a link into /usr would give a
    // workspace no shell, since /usr is the only place a tool comes from here.
    if let Some(reason) = unmerged_root()? {
        return Err(Error { path: PathBuf::from("/"), source: io::Error::new(io::ErrorKind::Unsupported, reason) });
    }
    fs::create_dir_all(&rootfs).map_err(at(&rootfs))?;
    // A wake finds what the last boot wrote at /run and /tmp, which every distribution expects empty: the pid
    // files and sockets in them name processes the stop took away.
    for name in EMPTIED_AT_BOOT {
        let dir = rootfs.join(name);
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(&dir)(e)),
        }
    }
    let place = layout.inside_of(id);
    // The top of the rootfs is the daemon's own to make, so a link at one of these names is the workspace's and
    // refuses the boot: every one of them is a mount point of the boot's or of youki's.
    for name in SKELETON {
        open_inside(&place, &format!("/{name}"), Want::Dir, BoxLink::FollowedOnce)?;
    }
    // The rootfs itself, bound to its own path and made to receive only, before one overlay or bind goes under
    // it: the volume this root sits on may be in a shared peer group of its own (a loop volume on a box was
    // shared:32), and a mount placed under a shared parent lands on every peer at the same relative path. With
    // the rootfs as its own mount and slave, nothing mounted under it can reach a peer of that volume, whatever
    // the volume is. youki binds the rootfs to itself as it pivots in any case; this is the same bind, made
    // early and made quiet.
    bind_into(&rootfs, &rootfs)?;
    // Read off the box, never written down here: on a merged-usr box bin, sbin, lib and lib64 are links into usr,
    // and a box may hold links of its own beside them. A wake finds the links its own first boot wrote, and one
    // the box has since pointed somewhere else is written again: the link itself is read, never what it points
    // at, since what it points at is under an overlay this has not mounted yet.
    for (name, target) in top_level_links()? {
        let link = rootfs.join(&name);
        match fs::read_link(&link) {
            Ok(held) if held == target => continue,
            Ok(_) => fs::remove_file(&link).map_err(at(&link))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(&link)(e)),
        }
        std::os::unix::fs::symlink(&target, &link).map_err(at(&link))?;
    }
    for (dir, built) in hardening::TREES {
        // What this tree reads under it: the box's own directory whole, or a view built fresh under the
        // workspace's own folder holding what the box lends it and what the tree needs where it lends nothing.
        let lower = match built {
            hardening::Built::Whole => PathBuf::from(dir),
            hardening::Built::Allowed => {
                let view = layout.view(id, dir);
                view_of(&view, Path::new(dir), hardening::ETC_ALLOWED, &[], &[])?;
                view
            }
            hardening::Built::Own { dirs, links, .. } => {
                let view = layout.view(id, dir);
                view_of(&view, Path::new(dir), &[], dirs, links)?;
                view
            }
        };
        overlay_inside(&place, dir, &lower, &layout.upper_of(id, dir), &layout.work_of(id, dir))?;
        // And inside a tree the workspace owns, the box's own trees it lends it: apt and dpkg read what the box
        // has installed and write their own, and nothing else of the box's /var is there to read.
        if let hardening::Built::Own { from_box, .. } = built {
            for tree in from_box {
                if !Path::new(tree).is_dir() {
                    continue;
                }
                overlay_inside(&place, tree, Path::new(tree), &layout.lent_upper_of(id, tree), &layout.lent_work_of(id, tree))?;
            }
        }
    }
    // The overlays are up, so this lands in the workspace's own upper: a regular resolv.conf where the box has a
    // link into a /run the workspace does not share.
    write_resolv_inside(&place)?;
    // And the one line that puts the workspace's own order in front of a login shell there, in the same upper:
    // the box's own /etc/profile sets PATH to the distribution's list for root before it reads this folder.
    write_workspace_profile_inside(&place)?;
    // The person's own home on the box, shared by every workspace on it: the agents' sign-ins, their memory and
    // their caches are the computer's and last past any one workspace, last writer wins.
    bind_inside(&place, Path::new(BOX_ROOT), BOX_ROOT)?;
    // And over it, the one folder under that home that is the workspace's own rather than the computer's: the
    // daemon inside writes its token, its inbox and its manifest there by default, and two workspaces on one
    // computer would otherwise take turns rewriting each other's token in a folder they share. It is made at the
    // first boot, kept by a stop as the uppers are, and goes with the workspace.
    bind_over(&place, &layout.wsp_home(id), GUEST_WSP_HOME, BoxLink::FollowedOnce)?;
    // And over every path of the box's own that nothing inside may read, the workspace's own empty file or
    // directory: one per path, so what a workspace writes at one of them is not what it writes at another. Last,
    // after the mounts above: the person's home and the box's /etc are both among the trees being covered, and a
    // cover of either lands on a path that is not there until those are up.
    for cover in hardening::covered() {
        let source = if cover.own { layout.own_at(id, &cover.at) } else { layout.empty_at(id, &cover.at) };
        // Every cover refuses a link on its path, the box root's own as much as the workspace's: what is bound
        // over a link's target leaves that name a link the workspace may unlink and write in its place.
        if cover.file {
            bind_file_over(&place, &source, &cover.at, cover.own)?;
        } else {
            bind_over(&place, &source, &cover.at, BoxLink::Refused)?;
        }
    }
    // Last, and after the covers: the Homebrew prefix sits under /home, which a cover has just emptied, so a bind
    // made before it would be the one thing the cover hid. What lands here is the computer's own tools at their own
    // path, and the PATH every process inside starts with names them.
    for root in tool_roots {
        bind_inside(&place, Path::new(root), root)?;
    }
    Ok(())
}

/// Which of those install roots this computer keeps as a directory of its own, in the order they were given: a path
/// that is not there, a file, or a symlink is passed over. A link is passed over for the reason `hardening::cover_of`
/// passes one over: an absolute link under a rootfs is resolved by the kernel against this process's own root, so a
/// bind that followed one would land on whatever the computer keeps at that path instead.
pub fn tool_roots_present<'a>(roots: &[&'a str]) -> Vec<&'a str> {
    roots.iter().copied().filter(|root| fs::symlink_metadata(root).is_ok_and(|held| held.is_dir())).collect()
}

/// One tree of a workspace's rootfs: the lower given, the workspace's own upper over it, and the mount landed on
/// the descriptor of the path inside rather than on the path itself.
fn overlay_inside(place: &Inside, dir: &str, lower: &Path, upper: &Path, work: &Path) -> Result<(), Error> {
    for made in [upper, work] {
        fs::create_dir_all(made).map_err(at(made))?;
    }
    let opened = open_inside(place, dir, Want::Dir, BoxLink::FollowedOnce)?;
    mount_overlay_at(lower, upper, work, &opened.at(), &opened.named(place))
}

/// The lower of a tree the box does not lend whole, built fresh at every boot: every entry of the allowlist the
/// box has copied out of its own directory without following a link, then the directories and links the tree
/// needs where the box lends it nothing. What is not named here is not in the view, so it is not inside.
fn view_of(view: &Path, from: &Path, allowed: &[&str], dirs: &[(&str, u32)], links: &[(&str, &str)]) -> Result<(), Error> {
    match fs::remove_dir_all(view) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(at(view)(e)),
    }
    fs::create_dir_all(view).map_err(at(view))?;
    for entry in allowed {
        for name in named_by(from, entry) {
            let to = view.join(&name);
            if let Some(above) = to.parent() {
                fs::create_dir_all(above).map_err(at(above))?;
            }
            copy_no_follow(&from.join(&name), &to)?;
        }
    }
    for (name, mode) in dirs {
        let made = view.join(name);
        fs::create_dir_all(&made).map_err(at(&made))?;
        fs::set_permissions(&made, fs::Permissions::from_mode(*mode)).map_err(at(&made))?;
    }
    for (name, target) in links {
        let made = view.join(name);
        std::os::unix::fs::symlink(target, &made).map_err(at(&made))?;
    }
    Ok(())
}

/// The names under this directory one allowlist entry stands for: the entry itself where the box has it, and
/// every name in its folder beginning with the rest where its last part ends in a star.
fn named_by(from: &Path, entry: &str) -> Vec<String> {
    let (folder, last) = entry.rsplit_once('/').unwrap_or(("", entry));
    let Some(prefix) = last.strip_suffix('*') else {
        return if fs::symlink_metadata(from.join(entry)).is_ok() { vec![entry.to_owned()] } else { Vec::new() };
    };
    let Ok(entries) = fs::read_dir(from.join(folder)) else { return Vec::new() };
    let mut found: Vec<String> = entries
        .flatten()
        .map(|held| held.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(prefix))
        .map(|name| if folder.is_empty() { name } else { format!("{folder}/{name}") })
        .collect();
    found.sort();
    found
}

/// One entry of the box's own directory copied into a view: a link as the link it is, a directory whole and a
/// file with its mode. No component is ever followed, so a link in the box's own tree brings in what it names and
/// never what it points at, and anything that is none of the three is passed over.
fn copy_no_follow(from: &Path, to: &Path) -> Result<(), Error> {
    let held = fs::symlink_metadata(from).map_err(at(from))?;
    let kind = held.file_type();
    if kind.is_symlink() {
        let target = fs::read_link(from).map_err(at(from))?;
        return std::os::unix::fs::symlink(target, to).map_err(at(to));
    }
    if kind.is_dir() {
        fs::create_dir_all(to).map_err(at(to))?;
        fs::set_permissions(to, held.permissions()).map_err(at(to))?;
        for entry in fs::read_dir(from).map_err(at(from))? {
            let entry = entry.map_err(at(from))?;
            copy_no_follow(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if kind.is_file() {
        fs::copy(from, to).map_err(at(from))?;
        fs::set_permissions(to, held.permissions()).map_err(at(to))?;
    }
    Ok(())
}

/// Which workspace a path is opened inside: the rootfs on the box, the workspace's own uppers, which say whose a
/// link met on the way is, and the id the refusal names.
pub struct Inside {
    rootfs: PathBuf,
    uppers: [PathBuf; 2],
    id: String,
}

impl Inside {
    pub fn rootfs(&self) -> &Path {
        &self.rootfs
    }
}

/// What the last part of a path opened inside a workspace is: a directory a bind or an overlay lands on, or a
/// file a file bind lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    Dir,
    File,
}

/// What a walk does with a link the box root keeps under the home every workspace here shares.
///
/// A share lands at the path a person's own tool reads inside, and a box whose root keeps that path inside a
/// dotfiles checkout keeps it as a link: the follow is what lets such a box boot at all, and the road out stays
/// closed because the follow lands beneath the rootfs and a second link refuses.
///
/// A cover goes over a path the box root's own login and its systemd run by name. Following a link there would
/// bind the workspace's own copy over the link's target and leave the name itself a plain link in a directory the
/// workspace is uid 0 in, which the workspace can unlink and write: the road the cover is here to close, left
/// open. So a link met on a cover's path refuses the boot, and the person moves the file into place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxLink {
    FollowedOnce,
    Refused,
}

/// A path inside a workspace, opened: the descriptor of the entry itself and the path under the rootfs it landed
/// at, which is the path asked for unless a link the box root keeps led elsewhere.
#[derive(Debug)]
pub struct Opened {
    fd: OwnedFd,
    /// The folder the entry sits in, the name it sits there under and what the walk opened it as: what it takes
    /// to open the entry again with no path resolved. Where the walk had no component at all, which is the
    /// rootfs itself, the folder is the rootfs and the name is `.`, which crosses no mount: a bind asked for at
    /// the rootfs itself is refused at its propagation step, and nothing in a boot asks for one.
    parent: OwnedFd,
    name: String,
    want: Want,
    pub landed: String,
    /// Whether this walk made the entry itself rather than finding it: what says a mount point is the boot's own
    /// and not something the person had there.
    pub made: bool,
}

impl Opened {
    /// What a mount or an open names this entry by. Through the descriptor and never through the path again: a
    /// path resolved a second time is a path a workspace can point somewhere else between the two resolutions.
    pub fn at(&self) -> PathBuf {
        by_fd(self.fd.as_fd())
    }
    /// The entry opened again from the folder it sits in, under the flags the walk itself took, so no link is
    /// followed and nothing outside the rootfs is reached.
    fn again(&self) -> Result<OwnedFd, Errno> {
        open_step(&self.parent, &self.name, self.want)
    }
    /// The entry's own descriptor, for a call that takes one rather than a path.
    pub fn fd(&self) -> BorrowedFd<'_> {
        self.fd.as_fd()
    }
    /// Where it sits on the box, for the sentence a failure carries.
    pub fn named(&self, place: &Inside) -> PathBuf {
        place.rootfs.join(self.landed.trim_start_matches('/'))
    }
}

/// Opens a path inside a workspace beneath its rootfs, making the directories above it and the entry itself where
/// they are missing, and answers the entry's own descriptor. Every component is walked with `openat2` under
/// `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`, so the kernel resolves no link behind this
/// walk, and what lands lands on the descriptor rather than on a path resolved a second time.
///
/// Where a component is a link, whose link it is decides. Under an overlaid tree the workspace's own upper at the
/// same relative path says so: present there the link is the workspace's and the boot is refused; absent it is the
/// box's and is followed once. Under the box's own home every link is read as the box root's, since that home is
/// shared and the daemon cannot tell one from the other, both being uid 0 in one folder; what closes the road
/// there is where the follow lands. Anywhere else under the rootfs a link is the workspace's and is refused.
///
/// Followed once means the link's target resolved beneath the rootfs, an absolute target under the rootfs's own
/// path and a relative one against the link's parent, and the walk goes on with no link followed: a second link,
/// or a target that leaves the rootfs, is refused with the same sentence.
pub fn open_inside(place: &Inside, at: &str, want: Want, shared: BoxLink) -> Result<Opened, Error> {
    inside(&place.rootfs, at)?;
    let root = open_dir(&place.rootfs)?;
    let mut parts: Vec<String> = at.split('/').filter(|part| !part.is_empty()).map(str::to_owned).collect();
    let mut walked: Vec<String> = Vec::new();
    let mut dir = root.try_clone().map_err(|e| Error { path: place.rootfs.clone(), source: e })?;
    let mut parent = root.try_clone().map_err(|e| Error { path: place.rootfs.clone(), source: e })?;
    let mut followed = false;
    let mut made = false;
    let mut i = 0;
    while i < parts.len() {
        let want_here = if i + 1 == parts.len() { want } else { Want::Dir };
        match step(&dir, &parts[i], want_here) {
            Ok(Some((fd, fresh))) => {
                walked.push(parts[i].clone());
                parent = std::mem::replace(&mut dir, fd);
                made = fresh;
                i += 1;
            }
            // A link: whose it is decides, and one the box root keeps is followed by walking its target from the
            // rootfs again, which is where `RESOLVE_BENEATH` reads a target that leaves the workspace.
            Ok(None) => {
                let refusal = || link_refusal(place, at, &walked, &parts[i], want_here);
                if followed || shared == BoxLink::Refused || !the_boxs_own_link(place, &walked, &parts[i]) {
                    return Err(refusal());
                }
                followed = true;
                let target = readlinkat(&dir, parts[i].as_str()).map_err(nix_at(&place.rootfs))?;
                let led = beneath(&walked, Path::new(&target)).ok_or_else(refusal)?;
                parts = led.into_iter().chain(parts[i + 1..].iter().cloned()).collect();
                walked.clear();
                dir = root.try_clone().map_err(|e| Error { path: place.rootfs.clone(), source: e })?;
                parent = root.try_clone().map_err(|e| Error { path: place.rootfs.clone(), source: e })?;
                i = 0;
            }
            Err(e) => return Err(Error { path: place.rootfs.join(walked.join("/")).join(&parts[i]), source: e.into() }),
        }
    }
    let name = walked.last().cloned().unwrap_or_else(|| ".".to_owned());
    Ok(Opened { fd: dir, parent, name, want, landed: format!("/{}", walked.join("/")), made })
}

/// One component walked, made where it is not there: its descriptor and whether this call made it, or nothing
/// where the component is a link.
fn step(dir: &OwnedFd, name: &str, want: Want) -> Result<Option<(OwnedFd, bool)>, Errno> {
    match open_step(dir, name, want) {
        Ok(fd) => Ok(Some((fd, false))),
        Err(Errno::ELOOP) => Ok(None),
        Err(Errno::ENOENT) => {
            let made = match want {
                Want::Dir => mkdirat(dir, name, Mode::from_bits_truncate(0o755)),
                // Mode 0600, since a login is what lands on it; exclusive and following no link, so the entry
                // this walk goes on to open is the entry this call made.
                Want::File => openat(
                    dir,
                    name,
                    OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map(drop),
            };
            let fresh = match made {
                Ok(()) => true,
                Err(Errno::EEXIST) => false,
                Err(e) => return Err(e),
            };
            match open_step(dir, name, want) {
                Ok(fd) => Ok(Some((fd, fresh))),
                Err(Errno::ELOOP) => Ok(None),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

fn open_step(dir: &OwnedFd, name: &str, want: Want) -> Result<OwnedFd, Errno> {
    let flags = match want {
        Want::Dir => OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Want::File => OFlag::O_PATH | OFlag::O_CLOEXEC,
    };
    let how = OpenHow::new()
        .flags(flags)
        .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_SYMLINKS | ResolveFlag::RESOLVE_NO_MAGICLINKS);
    openat2(dir, name, how)
}

/// What a descriptor is named by where a call takes a path: the kernel resolves it to the file as it was opened,
/// which is why a mount lands on the inode held rather than on whatever a path leads to now.
fn by_fd(fd: BorrowedFd<'_>) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()))
}

fn open_dir(path: &Path) -> Result<OwnedFd, Error> {
    open(path, OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()).map_err(nix_at(path))
}

/// Whether a link met at this path inside is the box's own rather than the workspace's: one under the box's home,
/// which every workspace here shares, and one in an overlaid tree that none of the workspace's own upper
/// directories has anything at, the uppers of the trees the box lends inside them among those.
fn the_boxs_own_link(place: &Inside, walked: &[String], name: &str) -> bool {
    let mut rel: Vec<&str> = walked.iter().map(String::as_str).collect();
    rel.push(name);
    let path = format!("/{}", rel.join("/"));
    let under = |tree: &str| path.strip_prefix(tree).is_some_and(|rest| rest.starts_with('/'));
    if under(BOX_ROOT) {
        return true;
    }
    let wrote_it = place.uppers.iter().any(|upper| fs::symlink_metadata(upper.join(rel.join("/"))).is_ok());
    OVERLAID.iter().any(|tree| under(tree)) && !wrote_it
}

/// What a link no walk may follow refuses the boot with, wherever it is met: the path it stands at and what to
/// put there instead, which is a folder at every part but the last and whatever the last part is to carry.
fn link_refusal(place: &Inside, at: &str, walked: &[String], name: &str, want: Want) -> Error {
    let mut rel: Vec<&str> = walked.iter().map(String::as_str).collect();
    rel.push(name);
    let make = if want == Want::File { "file" } else { "folder" };
    let detail = format!(
        "{at} inside workspace {} is reached through a link at /{}; replace the link with a {make} and wake the workspace",
        place.id,
        rel.join("/")
    );
    Error { path: place.rootfs.clone(), source: io::Error::new(io::ErrorKind::PermissionDenied, detail) }
}

/// Where a link's target lands under the rootfs, as the components to walk from it: an absolute target under the
/// rootfs's own path and a relative one against the link's parent. Nothing where it climbs out of the rootfs.
fn beneath(parent: &[String], target: &Path) -> Option<Vec<String>> {
    let mut out: Vec<String> = if target.is_absolute() { Vec::new() } else { parent.to_vec() };
    for part in target.components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                out.pop()?;
            }
            Component::Normal(name) => out.push(name.to_string_lossy().into_owned()),
            Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// One of this computer's own directories bound at a path inside a workspace, landed on the descriptor the walk
/// above answered. Answers where it landed, which is what the record keeps.
pub fn bind_inside(place: &Inside, source: &Path, at_path: &str) -> Result<String, Error> {
    bind_inside_with(place, source, at_path, BoxLink::FollowedOnce)
}

/// The same, saying what a link the box root keeps on the way is: followed once for a share of the person's own,
/// refused for a cover over a path the box root's own login runs by name.
fn bind_inside_with(place: &Inside, source: &Path, at_path: &str, shared: BoxLink) -> Result<String, Error> {
    let opened = open_inside(place, at_path, Want::Dir, shared)?;
    mount_bind(source, Onto::Entry(&opened), &opened.named(place))?;
    Ok(opened.landed)
}

/// One of the workspace's own directories bound over a path inside it. The mount point is under a bind of the
/// box's own directory or inside an overlay, so the daemon makes it where the box has none: the box's own wsp
/// folder is there on a computer somebody joined and the two engine folders are made by an engine that may not
/// be installed at all.
fn bind_over(place: &Inside, source: &Path, at_path: &str, shared: BoxLink) -> Result<(), Error> {
    fs::create_dir_all(source).map_err(at(source))?;
    bind_inside_with(place, source, at_path, shared).map(drop)
}

/// The same for a path the box keeps a file at: a file bind wants a file at both ends, so the workspace's own one
/// is made here and the one inside is made by the walk where the box keeps none. Where the cover is the
/// workspace's own copy, the first boot that finds no copy takes the bytes the box keeps there, read through the
/// same descriptor the bind lands on and never through the path a second time. Every caller is a cover, so a link
/// met on the way refuses the boot rather than being followed.
fn bind_file_over(place: &Inside, source: &Path, at_path: &str, own: bool) -> Result<(), Error> {
    let opened = open_inside(place, at_path, Want::File, BoxLink::Refused)?;
    if let Some(dir) = source.parent() {
        fs::create_dir_all(dir).map_err(at(dir))?;
    }
    if own && !source.exists() {
        let held = fs::read(opened.at()).map_err(at(&opened.named(place)))?;
        fs::write(source, held).map_err(at(source))?;
        fs::set_permissions(source, fs::Permissions::from_mode(0o600)).map_err(at(source))?;
    } else {
        empty_file(source)?;
    }
    mount_bind(source, Onto::Entry(&opened), &opened.named(place))
}

/// The box's own /root, bound into every workspace at the same path.
const BOX_ROOT: &str = "/root";

/// The workspace's own /etc/resolv.conf, written through the merged view of the /etc overlay so it lands in the
/// workspace's upper and the computer's own file is untouched.
///
/// Two reasons it is written here rather than left to the box's. A computer that runs systemd-resolved, which is
/// every stock Ubuntu, keeps /etc/resolv.conf as a link into /run, and /run inside a workspace is the
/// workspace's own empty folder: the runtime resolves its own bind of the file inside the root, the link leads
/// nowhere there, and the boot fails before the first process with nothing but `failed to prepare rootfs`
/// (measured on a box, 6.8.0-139). And the address that link leads to is 127.0.0.53, the box's own stub, which
/// inside a workspace's network namespace is the workspace's loopback and answers nothing.
///
/// So: the link in the upper goes, a regular file takes its place, and what it holds is the resolvers the box
/// forwards to, read by `resolv_text` from the upstream file where systemd-resolved keeps them and from the
/// box's own file where that is a file of its own. The mode is the one a write of this file lands with on every
/// box, and what takes the link off is the one writer below rather than a rule of this function's own.
fn write_resolv_inside(place: &Inside) -> Result<(), Error> {
    let text = resolv_text(&read_or_empty(BOX_RESOLV), &read_or_empty(UPSTREAM_RESOLV));
    write_file_inside(place, RESOLV_INSIDE, text.as_bytes(), 0o644)
}

/// The wsp a process inside a workspace runs, written into the workspace's own upper at `GUEST_WSP_PATH`: two
/// lines onto the init this workspace already carries read-only, which is the same binary the daemon out here is.
/// The computer's own wsp, where it has one at all, is a command under the wsp folder every workspace covers, so
/// a workspace that was not given this word has none.
pub fn write_wsp_shim_inside(place: &Inside) -> Result<(), Error> {
    write_file_inside(place, wsp_frames::numbers::GUEST_WSP_PATH, wsp_frames::guest_wsp_shim(profile::INIT_PATH).as_bytes(), 0o755)
}

/// One file of the boot's own written inside a workspace, at the mode given: the folder it sits in opened beneath
/// the rootfs with no link of the workspace's followed, the file opened through that descriptor rather than
/// through its path again, and a link the computer keeps at the name taken off rather than written through. An
/// absolute link under a rootfs is resolved by the kernel against this process's own root, so a write that
/// followed one would land on the computer's own file instead. Every file the boot puts inside goes through here,
/// so that rule has one home.
pub fn write_file_inside(place: &Inside, path: &str, bytes: &[u8], mode: u32) -> Result<(), Error> {
    let (folder, name) = path.rsplit_once('/').expect("a file written inside names the folder it sits in");
    let dir = open_inside(place, folder, Want::Dir, BoxLink::FollowedOnce)?;
    let made = |flags: OFlag| {
        openat(dir.fd(), name, flags | OFlag::O_WRONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC, Mode::from_bits_truncate(mode))
    };
    let file = match made(OFlag::O_CREAT | OFlag::O_TRUNC) {
        // A link at the name: taken off through the same descriptor and the file written in its place.
        Err(Errno::ELOOP) => {
            nix::unistd::unlinkat(dir.fd(), name, nix::unistd::UnlinkatFlags::NoRemoveDir).map_err(nix_at(&dir.named(place)))?;
            made(OFlag::O_CREAT | OFlag::O_EXCL)
        }
        other => other,
    }
    .map_err(nix_at(&dir.named(place).join(name)))?;
    let landed = dir.named(place).join(name);
    let mut file = std::fs::File::from(file);
    file.write_all(bytes).map_err(at(&landed))?;
    file.set_permissions(fs::Permissions::from_mode(mode)).map_err(at(&landed))
}

/// Where the login shell inside a workspace reads its PATH from: a file of the workspace's own under the /etc
/// tree it reads through an overlay, written at every boot so a wake carries this version's line.
pub const WORKSPACE_PROFILE_INSIDE: &str = "/etc/profile.d/wsp-workspace.sh";

/// That file, written into the workspace's own upper: the box's `/etc/profile` sets PATH to the distribution's
/// list for root and then reads this folder, so a pane there opens on the order the workspace's threads and
/// commands already carry. Nothing else is in it: the recipe's knobs ride the boot's environment, which the shell
/// inherits, and nothing in a login file unsets them.
///
/// The person's own login file still has the last word, as it would on any machine of theirs: bash reads the
/// first of `~/.bash_profile`, `~/.bash_login` and `~/.profile` after `/etc/profile`, and each of those is the
/// workspace's own copy of what the box root keeps.
pub fn write_workspace_profile_inside(place: &Inside) -> Result<(), Error> {
    let line = format!("export PATH={}\n", wsp_frames::numbers::PLACE_WORKSPACE_PATH);
    write_file_inside(place, WORKSPACE_PROFILE_INSIDE, line.as_bytes(), 0o644)
}

/// Whether this computer keeps any of the four merged names as a directory of its own, in the doctor's own
/// sentence: read off `/` here, where the rootfs is made, and asked again by the self check so a box that cannot
/// hold a workspace says so at the dial rather than at the first create.
pub fn unmerged_root() -> Result<Option<String>, Error> {
    let root = Path::new("/");
    let mut its_own = Vec::new();
    for entry in fs::read_dir(root).map_err(at(root))? {
        let entry = entry.map_err(at(root))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if crate::doctor::MERGED_INTO_USR.contains(&name.as_str()) && entry.file_type().map_err(at(&entry.path()))?.is_dir() {
            its_own.push(name);
        }
    }
    let names: Vec<&str> = its_own.iter().map(String::as_str).collect();
    Ok(crate::doctor::root_not_merged(&names))
}

/// Every top-level name on this computer that is a symlink, with what it points at: on a box with merged usr,
/// bin, sbin, lib and lib64 point into usr, and a rootfs that lacked them would have no shell at all.
fn top_level_links() -> Result<Vec<(String, PathBuf)>, Error> {
    let root = Path::new("/");
    let mut links = Vec::new();
    for entry in fs::read_dir(root).map_err(at(root))? {
        let entry = entry.map_err(at(root))?;
        if !entry.file_type().map_err(at(&entry.path())).map(|kind| kind.is_symlink())? {
            continue;
        }
        let target = fs::read_link(entry.path()).map_err(at(&entry.path()))?;
        links.push((entry.file_name().to_string_lossy().into_owned(), target));
    }
    links.sort();
    Ok(links)
}

/// Detaches the mount; a target that is not mounted is already what was asked for.
pub fn unmount(target: &Path) -> Result<(), Error> {
    match umount2(target, MntFlags::MNT_DETACH) {
        Ok(()) | Err(nix::Error::EINVAL) | Err(nix::Error::ENOENT) => Ok(()),
        Err(e) => Err(nix_at(target)(e)),
    }
}

/// One bind under a workspace's rootfs, made from this daemon's own mount namespace and before youki's create:
/// youki rebinds the rootfs recursively as it pivots, so what is bound here travels into the workspace with it,
/// and the daemon keeps seeing it at the same path outside, which is the path the engine fence already rewrites
/// a bind source to.
///
/// Every bind here is made to receive only, the moment it exists and before anything is mounted under it. A
/// computer's own `/` is in a shared peer group on every box that boots systemd, and a bind of a mount in such a
/// group stays in it: a mount placed under that bind then lands at the same relative path on every peer, which
/// includes the computer itself. Measured on a box: the workspace's own folder bound at `rootfs/root/.wsp`
/// appeared at the computer's own `/root/.wsp` for as long as the workspace lived, hiding that computer's daemon
/// files, its token and its socket from every process on it, and a second workspace's recursive bind of `/root`
/// picked up the first workspace's folder and then covered it. Slave, not private: what the computer mounts
/// later under a bound directory still reaches the workspaces, which is what a person plugging a disk in
/// expects, and nothing a workspace mounts reaches the computer.
pub fn bind_into(source: &Path, target: &Path) -> Result<(), Error> {
    fs::create_dir_all(target).map_err(at(target))?;
    mount_bind(source, Onto::Path(target), target)
}

/// A source already opened as a descriptor, bound at a path of this daemon's own: the mount lands on the inode
/// the descriptor holds, so a path swapped underneath between the open and the mount mounts nothing. The target
/// is the caller's to make, since a bind wants a directory at both ends or a file at both.
pub fn bind_opened(source: &impl AsFd, target: &Path) -> Result<(), Error> {
    mount_bind(&by_fd(source.as_fd()), Onto::Path(target), target)
}

/// The two calls of one bind, made in the one order: every bind under a rootfs goes through here, so neither road
/// can make one and forget the propagation that makes it receive only. A failure names the path inside a person
/// reads rather than the descriptor the call handed the kernel.
fn mount_bind(source: &Path, onto: Onto<'_>, named: &Path) -> Result<(), Error> {
    for (from, naming, flags) in bind_steps(source) {
        let (_held, target) = onto.target(naming, source, named)?;
        mount(from, &target, None::<&str>, flags, None::<&str>).map_err(nix_at(named))?;
    }
    Ok(())
}

/// What a bind lands on: a path of this daemon's own, or an entry under a workspace's rootfs the walk above
/// opened and holds, which no call of the bind names by a path again.
#[derive(Debug, Clone, Copy)]
enum Onto<'a> {
    Path(&'a Path),
    Entry(&'a Opened),
}

impl Onto<'_> {
    /// The path one call names its target by, with the descriptor that path stands for held for as long as the
    /// call. A path of the daemon's own is resolved by the kernel at each call, so the second call lands on the
    /// mount the first made with nothing more asked of it.
    fn target(&self, naming: Naming, source: &Path, named: &Path) -> Result<(Option<OwnedFd>, PathBuf), Error> {
        match (self, naming) {
            (Onto::Path(path), _) => Ok((None, path.to_path_buf())),
            (Onto::Entry(entry), Naming::AsOpened) => Ok((None, entry.at())),
            (Onto::Entry(entry), Naming::Again) => {
                let fd = entry.again().map_err(nix_at(named))?;
                the_bind_just_made(&fd, source, named)?;
                let path = by_fd(fd.as_fd());
                Ok((Some(fd), path))
            }
        }
    }
}

/// Whether what the reopen answered is the bind the call before it made, which holds the source's own inode: a
/// workspace beside this one, uid 0 in the home they share, can rename a directory of its own or one of this
/// boot's earlier mount points onto the name between the two calls, and the propagation would then land on a
/// mount that is not this one. Refused before that call is made; the bind already landed stays standing for the
/// sweep that takes an unfinished boot's mounts off.
fn the_bind_just_made(fd: &OwnedFd, source: &Path, named: &Path) -> Result<(), Error> {
    let landed = fstat(fd).map_err(nix_at(named))?;
    let from = stat(source).map_err(nix_at(named))?;
    if (landed.st_dev, landed.st_ino) == (from.st_dev, from.st_ino) {
        return Ok(());
    }
    let detail = format!(
        "the bind of {} landed and the name then held something else, so the propagation would land on a mount that is not this boot's; what was bound stays for the sweep",
        source.display()
    );
    Err(Error { path: named.to_owned(), source: io::Error::new(io::ErrorKind::PermissionDenied, detail) })
}

/// Which descriptor a call of a bind names an entry under a rootfs by: the one the walk answered, or the entry
/// opened again from the folder it sits in, which a fresh walk of the name crosses into the mount for. A
/// descriptor opened before the bind still names the directory that mount now covers, and a propagation change
/// of anything but a mount's own root is refused by the kernel (EINVAL, measured on a box, 6.8.0-139), so the
/// propagation takes the entry opened again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Naming {
    AsOpened,
    Again,
}

/// The two calls one bind is made of, in order: the bind itself, then the propagation that makes it receive
/// only. Written as a list so a test reads what the boot will do without mounting anything, and so the second
/// call cannot drift away from the first.
fn bind_steps(source: &Path) -> [(Option<&Path>, Naming, MsFlags); 2] {
    [(Some(source), Naming::AsOpened, MsFlags::MS_BIND | MsFlags::MS_REC), (None, Naming::Again, MsFlags::MS_SLAVE | MsFlags::MS_REC)]
}

/// The file a bind mount is to land on, made where the image carries none: a file bind needs the file to be
/// there inside, and the runtime makes it rather than trusting the container runtime to. Mode 0600, since a
/// login is what lands on it; a file already there is left as it is.
pub fn empty_file(path: &Path) -> Result<(), Error> {
    if path.exists() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(at(dir))?;
    }
    fs::OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).open(path).map(|_| ()).map_err(at(path))
}

/// One mount point a boot made on the computer's own disk, taken off now that the workspace's mounts are down.
/// Walked from the computer's own root with no link followed and unlinked through the descriptor of the folder it
/// sits in: these paths run through the home every workspace here shares, where a link somebody kept would
/// otherwise carry the unlink somewhere else. Only an empty file goes: a sign-in made on the computer since the
/// boot wrote the person's own login into that file, and it is theirs. Answers the sentence where a link on the
/// way left the point standing.
pub fn take_off_point(point: &str) -> Result<Option<String>, Error> {
    let mut parts: Vec<&str> = point.split('/').filter(|part| !part.is_empty()).collect();
    let Some(name) = parts.pop() else { return Ok(None) };
    let stands = |at: &str| Some(format!("{point} is reached through a link at {at} and stays standing"));
    let mut dir = open_dir(Path::new("/"))?;
    let mut walked = PathBuf::from("/");
    for part in parts {
        walked.push(part);
        match open_step(&dir, part, Want::Dir) {
            Ok(fd) => dir = fd,
            Err(Errno::ENOENT) => return Ok(None),
            Err(Errno::ELOOP) => return Ok(stands(&walked.to_string_lossy())),
            Err(e) => return Err(Error { path: walked, source: e.into() }),
        }
    }
    let held = match nix::sys::stat::fstatat(&dir, name, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(held) => held,
        Err(Errno::ENOENT) => return Ok(None),
        Err(e) => return Err(Error { path: walked.join(name), source: e.into() }),
    };
    let kind = nix::sys::stat::SFlag::from_bits_truncate(held.st_mode) & nix::sys::stat::SFlag::S_IFMT;
    if kind == nix::sys::stat::SFlag::S_IFLNK {
        return Ok(stands(&walked.join(name).to_string_lossy()));
    }
    if kind == nix::sys::stat::SFlag::S_IFREG && held.st_size == 0 {
        nix::unistd::unlinkat(&dir, name, nix::unistd::UnlinkatFlags::NoRemoveDir).map_err(nix_at(&walked.join(name)))?;
    }
    Ok(None)
}

/// Where a path inside a workspace lands under its rootfs on the box. A second wall after the wire's own, held
/// to the wire's own rule rather than to a copy of it: a path that walks up out of the rootfs resolves to a
/// path on the box, and a bind mount is the one place a slip cannot be undone afterwards.
pub fn inside(rootfs: &Path, at: &str) -> Result<PathBuf, Error> {
    if !wsp_frames::is_plain_path(at) {
        let detail = format!("{at} is not a path inside a workspace");
        return Err(Error { path: rootfs.to_owned(), source: io::Error::new(io::ErrorKind::InvalidInput, detail) });
    }
    Ok(rootfs.join(at.trim_start_matches('/')))
}

/// Which tree a rootfs takes from the computer itself this path is, or sits under: the person's own home, bound
/// into every workspace at the same path, and every shared install root. A mount point under one of them is made
/// through the computer's own directory and stays on it once the workspace is gone, which is why a copy or a bind
/// asking for one is refused rather than made.
///
/// The roots are read from the list and not off the disk. Presence is read again at every boot, so a destination
/// under a prefix this computer has no Homebrew at yet would be taken by the create and mounted through the
/// prefix at the first wake after a recipe run installed it.
pub fn under_computer_tree(at: &str) -> Option<&'static str> {
    std::iter::once(BOX_ROOT)
        .chain(wsp_frames::numbers::SHARED_TOOL_ROOTS)
        .find(|tree| at == *tree || at.strip_prefix(*tree).is_some_and(|under| under.starts_with('/')))
}

/// What such a destination is refused with, wherever it is read: at the create and at every boot.
pub fn computer_tree_refusal(at: &str, tree: &str) -> String {
    format!(
        "the computer's own directories are not a place for a workspace's mounts: {at} sits under {tree}, which every workspace here reads from the computer itself"
    )
}

/// Every mount under this path taken down, deepest first, and then the path itself: a rootfs carries the
/// overlay, the copy bound into it and whatever youki mounted under that, and a stop that detached only the
/// rootfs would leave the rest of them on the box. Read off this process's own mount table, so nothing outside
/// the path is ever named, let alone unmounted.
pub fn unmount_under(target: &Path) -> Result<(), Error> {
    unmount_inside(target)?;
    unmount(target)
}

/// The same, for a directory of this daemon's own that is no mount itself and whose entries are: the fence's
/// staging directory. Asking the kernel to detach a path that was never mounted is its own refusal to read, so
/// nothing but what the table names is named here.
pub fn unmount_inside(target: &Path) -> Result<(), Error> {
    let mut under: Vec<PathBuf> = mount_points(&fs::read_to_string(MOUNTINFO).map_err(at(Path::new(MOUNTINFO)))?)
        .into_iter()
        .filter(|point| point.starts_with(target) && point != target)
        .collect();
    // Deepest first: a mount cannot be detached while another sits under it.
    under.sort_by_key(|point| std::cmp::Reverse(point.components().count()));
    for point in under {
        unmount(&point)?;
    }
    Ok(())
}

/// The filesystem the mount covering this path is of, for the sentence a plain copy is explained in; nothing
/// where the table names no mount over it.
pub fn filesystem_at(path: &Path) -> Option<String> {
    let table = fs::read_to_string(MOUNTINFO).ok()?;
    mounts(&table)
        .into_iter()
        .filter(|(point, _)| path.starts_with(point))
        .max_by_key(|(point, _)| point.components().count())
        .map(|(_, kind)| kind)
}

/// Where the kernel writes this process's own mounts.
const MOUNTINFO: &str = "/proc/self/mountinfo";

fn mount_points(table: &str) -> Vec<PathBuf> {
    mounts(table).into_iter().map(|(point, _)| point).collect()
}

/// Every mount in the table as its point and its filesystem. A line is the kernel's: the point is the fifth
/// field with its spaces and other odd bytes written as octal escapes, and the filesystem is the first field
/// after the lone dash, which the optional fields before it are told from by nothing else.
fn mounts(table: &str) -> Vec<(PathBuf, String)> {
    table
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(' ');
            let point = unescaped(fields.nth(4)?);
            let kind = fields.by_ref().skip_while(|word| *word != "-").nth(1)?;
            Some((PathBuf::from(point), kind.to_owned()))
        })
        .collect()
}

/// A mount point as the kernel wrote it: \040 and its three siblings back to the bytes they stand for.
fn unescaped(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut bytes = word.chars();
    while let Some(c) = bytes.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let octal: String = bytes.clone().take(3).collect();
        match u8::from_str_radix(&octal, 8) {
            Ok(byte) if octal.len() == 3 => {
                out.push(char::from(byte));
                bytes.nth(2);
            }
            _ => out.push(c),
        }
    }
    out
}

/// The sibling a death leaves sits in the workspace's own directory, which the remove and the open's sweep take
/// away with everything else under it.
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    crate::files::write_json(path, value).map_err(at(path))
}

/// The mount points a boot wrote under its claim, or none where the record has taken them over and the file is
/// gone. This daemon wrote it and no other program reads it, so a name in it the record already carries costs
/// the take-off nothing: what that removes is an empty file no running record has bound.
///
/// A file that does not parse reads as none as well. This daemon writes the file whole or not at all, so a torn
/// one is an older daemon's death inside its write and what it named is lost with it: an empty file at an
/// agent's login path, which is the box as it was before any of this was written down. Refusing instead would
/// refuse that workspace's every stop and remove, and its neighbours' every boot, for as long as the file
/// stands, with no road out but a delete by hand on the box. The record's own reader is strict still: a
/// workspace whose record does not read is one nothing here can reason about, and the open says so by name.
pub fn read_points(path: &Path) -> Result<Vec<String>, Error> {
    match fs::read(path) {
        Ok(text) => Ok(serde_json::from_slice(&text).unwrap_or_default()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(Error { path: path.to_owned(), source: e }),
    }
}

pub fn read_record(path: &Path) -> Result<Option<Workspace>, Error> {
    match fs::read(path) {
        Ok(text) => serde_json::from_slice(&text).map(Some).map_err(|e| Error { path: path.to_owned(), source: io::Error::other(e) }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error { path: path.to_owned(), source: e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A workspace to open paths inside, on a rootfs made by hand: the uppers beside it, as a layout puts them.
    fn place_at(root: &Path, id: &str) -> Inside {
        Inside { rootfs: root.join("rootfs"), uppers: Layout::new(root).upper_roots(id), id: id.to_owned() }
    }

    /// The one reader of a claim's points takes a file that does not parse as no points, so a file an older
    /// daemon tore costs that workspace its claim's names and nothing else. The record's reader refuses such a
    /// file by name still: a workspace whose record does not read is one nothing here can reason about.
    #[test]
    fn a_points_file_that_does_not_parse_reads_as_absent_and_a_record_that_does_not_still_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let points = dir.path().join("points.json");
        fs::write(&points, "[\"/root/.codex/auth.json\"").unwrap();
        assert!(read_points(&points).unwrap().is_empty(), "a torn claim file refused the read where it had nothing to say");
        // A whole one answers what it names, and one that is not there answers none, as they both did before.
        write_json(&points, &vec!["/root/.codex/auth.json".to_owned()]).unwrap();
        assert_eq!(read_points(&points).unwrap(), ["/root/.codex/auth.json"]);
        fs::remove_file(&points).unwrap();
        assert!(read_points(&points).unwrap().is_empty());

        let record = dir.path().join("workspace.json");
        fs::write(&record, "{ \"id\": \"wsp-torn\"").unwrap();
        let refused = read_record(&record).unwrap_err().to_string();
        assert!(refused.contains("workspace.json"), "{refused}");
    }

    #[test]
    fn every_path_sits_under_the_root() {
        let l = Layout::new(Path::new(crate::DEFAULT_ROOT));
        assert_eq!(l.workspace("wsp-a"), PathBuf::from("/wsp/run/wsp-a"));
        assert_eq!(l.rootfs("wsp-a"), PathBuf::from("/wsp/run/wsp-a/rootfs"));
        assert_eq!(l.state_of("wsp-a"), PathBuf::from("/wsp/state/wsp-a"));
        assert_eq!(l.put("u1"), PathBuf::from("/wsp/put/u1"));
        assert_eq!(l.cgroup_name("wsp-a"), "/wsp/wsp-a");
        assert_eq!(l.copies(), PathBuf::from("/wsp/copies"));
        assert_eq!(l.copy_of("wsp-a"), PathBuf::from("/wsp/copies/wsp-a"));
        assert_eq!(l.projects(), PathBuf::from("/wsp/projects"));
        // The copies sit beside the checkouts under one root, which is what lets a copy share their blocks.
        assert_eq!(l.copies().parent(), l.projects().parent());
        // One upper and one work directory per overlaid directory, both under the workspace's own two, so what a
        // workspace has written is one tree to count and one tree to keep.
        assert_eq!(l.upper_of("wsp-a", "/usr"), PathBuf::from("/wsp/run/wsp-a/upper/usr"));
        assert_eq!(l.work_of("wsp-a", "/var"), PathBuf::from("/wsp/run/wsp-a/work/var"));
        assert!(OVERLAID.iter().all(|dir| l.upper_of("wsp-a", dir).starts_with(l.upper("wsp-a"))));
        // A tree the box lends inside a tree the workspace owns keeps its upper beside that tree's and never
        // under it, since one overlay's upper inside another's is a shape overlayfs says nothing good about.
        assert_eq!(l.lent_upper_of("wsp-a", "/var/lib/dpkg"), PathBuf::from("/wsp/run/wsp-a/upper/lent/var/lib/dpkg"));
        assert_eq!(l.lent_work_of("wsp-a", "/var/lib/dpkg"), PathBuf::from("/wsp/run/wsp-a/work/lent/var/lib/dpkg"));
        for lent in hardening::VAR_FROM_BOX {
            assert!(l.lent_upper_of("wsp-a", lent).starts_with(l.upper("wsp-a")));
            assert!(!l.lent_upper_of("wsp-a", lent).starts_with(l.upper_of("wsp-a", "/var")));
            assert!(!l.lent_work_of("wsp-a", lent).starts_with(l.work_of("wsp-a", "/var")));
        }
        // The workspace's own wsp folder, which the daemon inside writes its token into: one per workspace, so
        // no two of them are one directory however many run on the computer.
        assert_eq!(l.wsp_home("wsp-a"), PathBuf::from("/wsp/run/wsp-a/wsp-home"));
        assert_ne!(l.wsp_home("wsp-a"), l.wsp_home("wsp-b"));
        assert_eq!(l.empty_at("wsp-a", "/var/lib/docker"), PathBuf::from("/wsp/run/wsp-a/empty/var/lib/docker"));
        // The fence's staging directory sits beside the engine socket's and under neither: what is bound into
        // the workspace is the socket's directory alone, so nothing inside reaches a staged bind.
        assert_eq!(l.binds("wsp-a"), PathBuf::from("/wsp/run/wsp-a/binds"));
        assert!(l.binds("wsp-a").starts_with(l.workspace("wsp-a")));
        assert_ne!(l.binds("wsp-a"), l.engine("wsp-a"));
        assert!(!l.binds("wsp-a").starts_with(l.engine("wsp-a")) && !l.engine("wsp-a").starts_with(l.binds("wsp-a")));
        // An empty directory per path and no two of them one directory: what a workspace writes at one of them
        // is not what it writes at another.
        let empties: std::collections::BTreeSet<PathBuf> = hardening::EMPTY_BINDS.iter().map(|(at, _)| l.empty_at("wsp-a", at)).collect();
        assert_eq!(empties.len(), hardening::EMPTY_BINDS.len());
        // The workspace's own copies of what the box root's shell runs by name sit apart from the empty ones, one
        // directory per path and all of them under the workspace's own folder, so a stop keeps them.
        assert_eq!(l.own_at("wsp-a", "/root/.bashrc"), PathBuf::from("/wsp/run/wsp-a/own/root/.bashrc"));
        let owned: std::collections::BTreeSet<PathBuf> = hardening::ROOT_RUN_COVERS.iter().map(|(at, _)| l.own_at("wsp-a", at)).collect();
        assert_eq!(owned.len(), hardening::ROOT_RUN_COVERS.len());
        assert!(owned.iter().all(|made| made.starts_with(l.workspace("wsp-a")) && !made.starts_with(l.empty_at("wsp-a", "/"))));
        // Every one of them under the workspace's own folder, so a stop keeps them and a remove takes them all.
        for made in [l.wsp_home("wsp-a"), l.empty_at("wsp-a", hardening::EMPTY_BINDS[0].0), l.upper("wsp-a")] {
            assert!(made.starts_with(l.workspace("wsp-a")), "{}", made.display());
        }
        // The mark a copy being made carries is written and read in one place.
        assert_eq!(l.copy_being_made("wsp-a"), PathBuf::from("/wsp/copies/.wsp-a.partial"));
        assert_eq!(Layout::copy_belongs_to(".wsp-a.partial"), "wsp-a");
        assert_eq!(Layout::copy_belongs_to("wsp-a"), "wsp-a");
        assert_eq!(Layout::copy_belongs_to(".clone-probe-42-0"), ".clone-probe-42-0");
    }

    #[test]
    fn a_copy_lands_inside_the_workspace_at_the_projects_own_path_and_nowhere_else() {
        let l = Layout::new(Path::new("/wsp"));
        assert_eq!(inside(&l.rootfs("wsp-a"), "/Users/zingzy/wsp").unwrap(), PathBuf::from("/wsp/run/wsp-a/rootfs/Users/zingzy/wsp"));
        assert_eq!(inside(Path::new("/r"), "/x").unwrap(), PathBuf::from("/r/x"));
        // The wire refuses these before they reach here; this is the wall behind that one, since what a bind
        // mount lands on cannot be taken back.
        for walking in ["/Users/../../etc", "/..", "/a/../b", "/a/./b", "Users/zingzy/wsp"] {
            let refused = inside(&l.rootfs("wsp-a"), walking).unwrap_err().to_string();
            assert!(refused.contains(walking) && refused.contains("not a path inside a workspace"), "{walking}: {refused}");
        }
    }

    #[test]
    fn the_mount_table_reads_as_the_kernel_writes_it() {
        // The kernel's own shape: optional fields before the dash on the first line and none on the second, a
        // point with a space in it as an octal escape, and a filesystem after the dash rather than before it.
        let table = concat!(
            "36 35 98:0 / /wsp rw,noatime shared:1 master:2 - xfs /dev/sda1 rw\n",
            "37 36 0:24 / /wsp/run/wsp-a/rootfs rw - overlay overlay rw\n",
            "38 37 98:0 /copies/wsp-a /wsp/run/wsp-a/rootfs/Users/my\\040project rw - xfs /dev/sda1 rw\n",
        );
        assert_eq!(
            mounts(table),
            vec![
                (PathBuf::from("/wsp"), "xfs".to_owned()),
                (PathBuf::from("/wsp/run/wsp-a/rootfs"), "overlay".to_owned()),
                (PathBuf::from("/wsp/run/wsp-a/rootfs/Users/my project"), "xfs".to_owned()),
            ]
        );
        assert_eq!(unescaped("/a\\040b\\011c"), "/a b\tc");
        assert_eq!(unescaped("/plain\\x"), "/plain\\x");
        assert!(mounts("not a mount line").is_empty());
    }

    #[test]
    fn the_config_is_the_profile_with_the_spec_filled_in() {
        let envs = BTreeMap::from([("WSP_TOKEN".to_owned(), "t".to_owned())]);
        let args = vec!["/sbin/wsp-init".to_owned(), "--".to_owned(), "sleep".to_owned()];
        let c = Config {
            hostname: "wsp-a",
            args: &args,
            envs: &envs,
            cpu: Some(2.0),
            mem_mb: Some(1024),
            cgroup: "/wsp/wsp-a",
            init: Path::new("/usr/local/bin/wsp-daemon"),
            etc: Path::new("/wsp/run/wsp-a/etc"),
            engine: None,
            shares: &[],
            binds: &[],
            tool_roots: &[],
            compose_project: None,
        };
        let spec = config_json(&c);
        assert_eq!(spec["root"]["path"], "rootfs");
        assert_eq!(spec["hostname"], "wsp-a");
        assert_eq!(spec["process"]["args"], json!(args));
        // The order a workspace on a computer somebody owns reads, which every thread, exec and pane on it carries
        // too: the shared home after the folders no process inside can write.
        assert_eq!(
            spec["process"]["env"],
            json!([format!("PATH={}", wsp_frames::numbers::PLACE_WORKSPACE_PATH), "HOSTNAME=wsp-a", "WSP_TOKEN=t"])
        );
        assert_eq!(spec["linux"]["resources"]["memory"]["limit"], 1024 * 1024 * 1024);
        assert_eq!(spec["linux"]["resources"]["cpu"], json!({ "quota": 200000, "period": 100000 }));
        assert_eq!(spec["linux"]["cgroupsPath"], "/wsp/wsp-a");
        let mounts = spec["mounts"].as_array().unwrap();
        let init = mounts.iter().find(|m| m["destination"] == profile::INIT_PATH).unwrap();
        assert_eq!(init["source"], "/usr/local/bin/wsp-daemon");
        assert_eq!(init["options"], json!(["bind", "ro"]));
        let hosts = mounts.iter().find(|m| m["destination"] == "/etc/hosts").unwrap();
        assert_eq!(hosts["source"], "/wsp/run/wsp-a/etc/hosts");
        assert_eq!(spec["process"]["capabilities"]["bounding"].as_array().unwrap().len(), 13);
        assert!(mounts.iter().all(|m| m["destination"] != crate::engine::INSIDE_DIR));
        let bare = config_json(&Config { cpu: None, mem_mb: None, ..c });
        assert!(bare["linux"].get("resources").is_none());
        let with_engine = config_json(&Config { engine: Some(Path::new("/wsp/run/wsp-a/engine")), ..c });
        let socket_dir = with_engine["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == crate::engine::INSIDE_DIR).unwrap();
        assert_eq!(socket_dir["source"], "/wsp/run/wsp-a/engine");
        // The socket's directory and nothing beside it: the fence's staging directory is bound in nowhere, so
        // a workspace reaches no entry the engine is about to mount for it.
        let staging = Layout::new(Path::new("/wsp")).binds("wsp-a");
        assert!(
            with_engine["mounts"].as_array().unwrap().iter().all(|m| !Path::new(m["source"].as_str().unwrap_or("")).starts_with(&staging)),
            "{:?}",
            with_engine["mounts"]
        );
        // The compose project is the workspace's own, and it is the last word in the environment: a workspace
        // with an engine runs compose against the box's engine through the fence, and two workspaces of one
        // project share no network there only because their project names differ.
        let composing = config_json(&Config { engine: Some(Path::new("/wsp/run/wsp-a/engine")), compose_project: Some("wsp-a"), ..c });
        let env = composing["process"]["env"].as_array().unwrap();
        assert_eq!(env.last().unwrap(), "COMPOSE_PROJECT_NAME=wsp-a");
        assert_eq!(env.iter().filter(|word| word.as_str().is_some_and(|w| w.starts_with("COMPOSE_PROJECT_NAME="))).count(), 1);
        // And a workspace that asked for no engine carries none, since it runs no compose at all.
        assert!(!spec["process"]["env"].as_array().unwrap().iter().any(|w| w.as_str().is_some_and(|w| w.contains("COMPOSE_PROJECT"))));
        assert!(!with_engine["process"]["env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().is_some_and(|w| w.contains("COMPOSE_PROJECT"))));
        // A login the computer signs in once: the one file, at the path the tool reads it inside, read-write, so
        // the tool refreshing it there is the computer's own refresh. Nothing else about the mounts moves.
        let shares = [Share { source: "/wsp/logins/codex/auth.json".to_owned(), target: "/root/.codex/auth.json".to_owned() }];
        let shared = config_json(&Config { shares: &shares, ..c });
        let login = shared["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == "/root/.codex/auth.json").unwrap();
        assert_eq!(login["source"], "/wsp/logins/codex/auth.json");
        assert_eq!(login["type"], "bind");
        assert_eq!(login["options"], json!(["rbind", "rw"]));
        assert_eq!(shared["mounts"].as_array().unwrap().len(), mounts.len() + 1);
        // And a workspace that shares none carries no mount of its own.
        assert!(mounts.iter().all(|m| m["destination"] != "/root/.codex/auth.json"));
        // A folder of the computer's own, at the path the workspace reads it inside: one more mount after the
        // profile's, read-write, so what the workspace writes in the project's checkout is what the computer
        // holds for the next piece of work on it.
        let held = "/srv/spoo-landing";
        let binds = [Bind { source: "/wsp/projects/pr_1/checkout".to_owned(), target: held.to_owned(), read_only: false }];
        let bound = config_json(&Config { binds: &binds, ..c });
        let folder = bound["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == held).unwrap();
        assert_eq!(folder["source"], "/wsp/projects/pr_1/checkout");
        assert_eq!(folder["type"], "bind");
        // The same words a shared login takes: the boot makes the bind itself, and `bind_steps` is the one place
        // the propagation of everything under a rootfs is decided.
        assert_eq!(folder["options"], json!(["rbind", "rw"]));
        assert_eq!(bound["mounts"].as_array().unwrap().len(), mounts.len() + 1);
        // A bind the host asked to be read-only is mounted that way, and a workspace with no bind carries none.
        let read_only = [Bind { source: "/wsp/projects/pr_1/checkout".to_owned(), target: held.to_owned(), read_only: true }];
        let fenced = config_json(&Config { binds: &read_only, ..c });
        assert_eq!(
            fenced["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == held).unwrap()["options"],
            json!(["rbind", "ro"])
        );
        assert!(mounts.iter().all(|m| m["destination"] != held));
        // An install root of the computer's own outside the overlaid trees: one bind at its own path, read-only,
        // and nothing else about the mounts moves. A workspace on a computer with none carries no such mount.
        let with_roots = config_json(&Config { tool_roots: &[wsp_frames::numbers::HOMEBREW_HOME], ..c });
        let root_mount =
            with_roots["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == wsp_frames::numbers::HOMEBREW_HOME).unwrap();
        assert_eq!(root_mount["source"], wsp_frames::numbers::HOMEBREW_HOME);
        assert_eq!(root_mount["type"], "bind");
        assert_eq!(root_mount["options"], json!(["rbind", "ro"]));
        assert_eq!(with_roots["mounts"].as_array().unwrap().len(), mounts.len() + 1);
        assert!(mounts.iter().all(|m| m["destination"] != wsp_frames::numbers::HOMEBREW_HOME));
        // The PATH is the same on both, since it is one rule and not a reading of what this computer has: a box
        // with no Homebrew yet gets a workspace whose PATH names the prefix and whose rootfs carries no bind.
        assert_eq!(with_roots["process"]["env"], spec["process"]["env"]);
    }

    #[test]
    fn a_tool_root_the_computer_keeps_as_a_directory_is_present_and_nothing_else_is() {
        let dir = tempfile::tempdir().unwrap();
        let (held, file, link, missing) = ("held", "a-file", "a-link", "not-there");
        fs::create_dir_all(dir.path().join(held)).unwrap();
        fs::write(dir.path().join(file), "x\n").unwrap();
        std::os::unix::fs::symlink(dir.path().join(held), dir.path().join(link)).unwrap();
        let at = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        let (held, file, link, missing) = (at(held), at(file), at(link), at(missing));
        let roots: Vec<&str> = vec![&held, &file, &link, &missing];
        // A directory of the computer's own is bound in; a file, a missing path and a link are passed over. The link
        // for the reason a cover passes one over: the kernel resolves an absolute link under a rootfs against this
        // process's own root, so a bind that followed it would land somewhere else entirely.
        assert_eq!(tool_roots_present(&roots), vec![held.as_str()]);
        assert_eq!(tool_roots_present(&[]), Vec::<&str>::new());
        // And the roots this computer is asked about are the ones the wire names, whatever this computer has.
        assert_eq!(wsp_frames::numbers::SHARED_TOOL_ROOTS, [wsp_frames::numbers::HOMEBREW_HOME]);
    }

    /// Which destinations sit under a tree the rootfs takes from the computer, read off the list rather than off
    /// this computer's disk: the prefix answers whether a Homebrew is installed at it or not, since a wake after
    /// a recipe run installed one would find it there.
    #[test]
    fn a_destination_under_the_computers_own_home_or_a_tool_root_names_the_tree_it_is_under() {
        let brew = wsp_frames::numbers::HOMEBREW_HOME;
        assert_eq!(under_computer_tree("/root/x"), Some(BOX_ROOT));
        assert_eq!(under_computer_tree(BOX_ROOT), Some(BOX_ROOT));
        assert_eq!(under_computer_tree("/root/.claude-cfg/projects/k/memory"), Some(BOX_ROOT));
        assert_eq!(under_computer_tree(&format!("{brew}/bin")), Some(brew));
        assert_eq!(under_computer_tree(brew), Some(brew));
        // Every path a workspace's own mounts land at: the projects folder, a copy at the checkout's own path,
        // and the scratch a case writes in.
        for taken in ["/private/tmp/repo", "/wsp/projects/p", "/var/tmp/x", "/Users/zingzy/wsp"] {
            assert_eq!(under_computer_tree(taken), None, "{taken}");
        }
        // A name the tree's own name is a prefix of is not under it: the reading is by path component.
        assert_eq!(under_computer_tree("/rootfs"), None);
        assert_eq!(under_computer_tree(&format!("{brew}er")), None);
        // One sentence, naming the destination and the tree it sits under.
        assert_eq!(
            computer_tree_refusal("/root/x", BOX_ROOT),
            "the computer's own directories are not a place for a workspace's mounts: /root/x sits under /root, which every workspace here reads from the computer itself"
        );
    }

    #[test]
    fn the_etc_files_name_the_host_and_the_box_once_the_gateway_is_known() {
        let dir = tempfile::tempdir().unwrap();
        write_etc(dir.path(), "wsp-b", None).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("hostname")).unwrap(), "wsp-b\n");
        let hosts = fs::read_to_string(dir.path().join("hosts")).unwrap();
        assert!(hosts.contains("127.0.0.1\twsp-b") && !hosts.contains("host.wsp.internal"), "{hosts}");
        let resolv = fs::read_to_string(dir.path().join("resolv.conf")).unwrap();
        assert!(resolv.contains("nameserver "), "{resolv}");
        write_etc(dir.path(), "wsp-b", Some(Ipv4Addr::new(10, 65, 0, 5))).unwrap();
        assert!(fs::read_to_string(dir.path().join("hosts")).unwrap().ends_with("10.65.0.5\thost.wsp.internal\n"));
    }

    #[test]
    fn the_resolvers_handed_in_are_ones_a_workspace_can_reach() {
        let stub = "# stub\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n";
        let upstream = "nameserver 2a01:4ff:ff00::add:2\nnameserver 185.12.64.1\nnameserver 185.12.64.2\nsearch corp.example\n";
        assert_eq!(resolv_text(stub, upstream), "nameserver 185.12.64.1\nnameserver 185.12.64.2\nsearch corp.example\n");
        assert_eq!(resolv_text("nameserver 1.1.1.1\nsearch lan\n", upstream), "nameserver 1.1.1.1\nsearch lan\n");
        assert_eq!(resolv_text("nameserver ::1\n", ""), "nameserver 8.8.8.8\nnameserver 8.8.4.4\n");
        assert_eq!(resolv_text("", ""), "nameserver 8.8.8.8\nnameserver 8.8.4.4\n");
        // The stub's own address never travels into a workspace whatever the box's two files hold: inside a
        // workspace's network namespace that loopback is the workspace's own and answers nothing.
        for (box_file, upstream) in [(stub, upstream), (stub, ""), ("nameserver 127.0.0.53\n", "nameserver 127.0.0.53\n")] {
            assert!(!resolv_text(box_file, upstream).contains("127.0.0.53"), "{box_file:?} {upstream:?}");
        }
    }

    #[test]
    fn a_record_reads_back_and_a_missing_one_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        assert_eq!(read_record(&path).unwrap(), None);
        let record = Workspace {
            id: "wsp-a".into(),
            hostname: "wsp-a".into(),
            labels: BTreeMap::from([("wsp".to_owned(), "1".to_owned())]),
            envs: BTreeMap::from([("WSP_TOKEN".to_owned(), "t".to_owned())]),
            cpu: Some(2.0),
            mem_mb: None,
            created_at: "2026-09-12T00:00:00.000Z".into(),
            init: Init { pid: 4242, started: 123_456, boot_id: "b0".into() },
            engine: false,
            copy: None,
            shares: Vec::new(),
            binds: Vec::new(),
            made_points: Vec::new(),
        };
        write_json(&path, &record).unwrap();
        assert_eq!(read_record(&path).unwrap(), Some(record.clone()));
        // A record written before the engine, the copy, the shares and the binds fields existed reads as a
        // workspace with none of them.
        let written = fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("engine") && !written.contains("copy") && !written.contains("shares") && !written.contains("binds"),
            "{written}"
        );
        assert!(read_record(&path).unwrap().unwrap().shares.is_empty());
        assert!(read_record(&path).unwrap().unwrap().binds.is_empty());
        // And a record an older daemon wrote carries no mount point of its own, so a workspace booted then and
        // removed now takes off nothing it cannot say it made.
        assert!(!written.contains("madePoints") && read_record(&path).unwrap().unwrap().made_points.is_empty());
        assert_eq!(read_record(&path).unwrap().unwrap().copy, None);
        write_json(&path, &Workspace { engine: true, ..record.clone() }).unwrap();
        assert!(read_record(&path).unwrap().unwrap().engine);
        let made = CopyMade {
            from: "/wsp/projects/wsp/checkout".to_owned(),
            at: "/Users/zingzy/wsp".to_owned(),
            made: CopyWord::Reflink,
            ms: 1_903,
        };
        write_json(&path, &Workspace { copy: Some(made.clone()), ..record.clone() }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().copy, Some(made));
        assert!(fs::read_to_string(&path).unwrap().contains("\"made\": \"reflink\""));
        // The logins the workspace was made with are the record's too: every boot binds whatever the file says now.
        let shares = vec![Share { source: "/var/lib/wsp/logins/codex/auth.json".to_owned(), target: "/root/.codex/auth.json".to_owned() }];
        write_json(&path, &Workspace { shares: shares.clone(), ..record.clone() }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().shares, shares);
        // And the folders it was made with, which every boot mounts again: the project's checkout on the computer.
        let binds =
            vec![Bind { source: "/wsp/projects/pr_1/checkout".to_owned(), target: "/srv/spoo-landing".to_owned(), read_only: false }];
        write_json(&path, &Workspace { binds: binds.clone(), ..record }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().binds, binds);
    }

    /// Every bind the boot makes is two calls in one order: the bind, then the propagation that makes it
    /// receive only, and the second names the entry by a descriptor opened again rather than by the one the bind
    /// landed on. Read off the list the boot walks and off what each call names, so a bind added later cannot
    /// skip the second call. Nothing is mounted to read either, and no root is needed.
    #[test]
    fn a_bind_under_a_rootfs_is_made_to_receive_only_right_after_it_is_made() {
        let source = Path::new("/root");
        let steps = bind_steps(source);
        assert_eq!(steps.len(), 2);
        // The bind itself, recursive, so what the computer holds under the source comes along, landed on the
        // entry as the walk opened it.
        assert_eq!(steps[0].0, Some(source));
        assert_eq!(steps[0].1, Naming::AsOpened);
        assert_eq!(steps[0].2, MsFlags::MS_BIND | MsFlags::MS_REC);
        // Then the same entry made a slave of its source, recursively: it receives what the computer mounts
        // later and propagates nothing back, which is what keeps a workspace's own folder off the computer's
        // own path. Second, not first: the propagation is of the mount, and before the bind there is none.
        assert_eq!(steps[1].0, None);
        assert_eq!(steps[1].2, MsFlags::MS_SLAVE | MsFlags::MS_REC);
        assert!(!steps[1].2.contains(MsFlags::MS_SHARED) && !steps[1].2.contains(MsFlags::MS_PRIVATE));
        // And named by the entry opened again after the bind, never by the descriptor the bind landed on: that
        // one names the directory under the new mount, where a propagation change is refused.
        assert_eq!(steps[1].1, Naming::Again);
        assert_ne!(steps[1].1, steps[0].1);

        // What each call hands the kernel, on an entry under a rootfs. The bind takes the descriptor the walk
        // answered; the propagation takes another descriptor of the same entry, opened from the folder it sits
        // in, which is the walk a mount is crossed by. Nothing is mounted here, so the entry stands in for the
        // bind: what the reopen has to answer is the source's own inode, which is what a landed bind holds.
        let dir = tempfile::tempdir().unwrap();
        let place = place_at(dir.path(), "wsp-bind");
        let from = place.rootfs.join("root");
        fs::create_dir_all(&from).unwrap();
        let opened = open_inside(&place, "/root", Want::Dir, BoxLink::FollowedOnce).unwrap();
        let named = opened.named(&place);
        let (held, bound) = Onto::Entry(&opened).target(steps[0].1, &from, &named).unwrap();
        assert!(held.is_none() && bound == opened.at());
        let (held, slaved) = Onto::Entry(&opened).target(steps[1].1, &from, &named).unwrap();
        let held = held.expect("the propagation names a descriptor opened again");
        assert_eq!(slaved, by_fd(held.as_fd()));
        assert_ne!(slaved, bound);
        assert_eq!(fs::read_link(&slaved).unwrap(), fs::read_link(&bound).unwrap());

        // And an entry that is not the bind, which is what a workspace beside this one leaves by renaming
        // another directory onto the name between the two calls: refused before the propagation is asked for,
        // naming the path inside and what was bound there.
        let elsewhere = place.rootfs.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let refused = Onto::Entry(&opened).target(steps[1].1, &elsewhere, &named).unwrap_err().to_string();
        assert!(refused.starts_with(&format!("{}: ", named.display())), "{refused}");
        assert!(refused.contains(&format!("the bind of {} landed", elsewhere.display())), "{refused}");
        assert!(refused.contains("what was bound stays for the sweep"), "{refused}");
    }

    /// The socket a process inside a workspace dials its host over, as this computer keeps it: in that
    /// workspace's own wsp folder, which is what is mounted over the wsp home inside it, under the name the
    /// contract pins for the path there. One name, so the daemon binds and the stop sweeps the same file.
    #[test]
    fn the_socket_inside_a_workspace_is_the_file_a_process_there_dials() {
        let layout = Layout::new(Path::new("/wsp"));
        assert_eq!(layout.guest_socket("wsp-a"), PathBuf::from("/wsp/run/wsp-a/wsp-home/daemon.sock"));
        assert_eq!(layout.guest_socket("wsp-a").parent(), Some(layout.wsp_home("wsp-a").as_path()));
        let inside = Path::new(wsp_frames::numbers::GUEST_DAEMON_SOCKET_PATH);
        assert_eq!(layout.guest_socket("wsp-a").file_name(), inside.file_name());
        assert_eq!(inside.parent(), Some(Path::new(GUEST_WSP_HOME)));
    }

    /// What a workspace's /etc/resolv.conf is after the boot writes it, on a rootfs made by hand: the link the
    /// box keeps there on every computer that runs systemd-resolved is gone, a regular file stands in its place,
    /// and what it holds is a nameserver a workspace can reach. No mount and no root: this is the write the boot
    /// makes through the merged view, and the live case below is the same write over a real overlay.
    #[test]
    fn the_workspaces_own_resolv_conf_is_a_file_where_the_box_keeps_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        let at = rootfs.join(RESOLV_INSIDE.trim_start_matches('/'));
        fs::create_dir_all(rootfs.join("etc")).unwrap();
        fs::create_dir_all(rootfs.join("run")).unwrap();
        // The link every stock Ubuntu keeps, pointing into a /run the workspace's own is empty of.
        std::os::unix::fs::symlink("../run/systemd/resolve/stub-resolv.conf", &at).unwrap();
        assert!(fs::read_to_string(&at).is_err(), "the link resolves inside this rootfs");

        let place = place_at(dir.path(), "wsp-resolv");
        write_resolv_inside(&place).unwrap();
        let held = fs::symlink_metadata(&at).unwrap();
        assert!(held.file_type().is_file(), "the workspace's resolv.conf is not a regular file");
        assert_eq!(held.permissions().mode() & 0o777, 0o644);
        let text = fs::read_to_string(&at).unwrap();
        assert!(text.lines().any(|line| line.starts_with("nameserver ")), "{text}");
        assert!(!text.contains("127.0.0.53"), "{text}");
        // Written again, as a wake writes it, over the file the last boot left.
        write_resolv_inside(&place).unwrap();
        assert_eq!(fs::read_to_string(&at).unwrap(), text);
        // And on a rootfs whose /etc has nothing there at all, which is a box with no resolv.conf of its own.
        let bare = dir.path().join("bare");
        fs::create_dir_all(bare.join("rootfs/etc")).unwrap();
        write_resolv_inside(&place_at(&bare, "wsp-bare-resolv")).unwrap();
        assert!(fs::read_to_string(bare.join("rootfs").join(RESOLV_INSIDE.trim_start_matches('/'))).unwrap().contains("nameserver "));
    }

    /// The word a process inside runs, written on a rootfs made by hand: two lines onto the init already bound
    /// inside, the text the contract fixture pins, and a link the computer keeps at that path removed first, as
    /// the resolv.conf above is, so nothing of this write lands on the computer itself.
    #[test]
    fn the_workspaces_own_wsp_is_the_shim_onto_its_init_where_the_computer_keeps_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        let at = rootfs.join(wsp_frames::numbers::GUEST_WSP_PATH.trim_start_matches('/'));
        let elsewhere = dir.path().join("the-computers-own-wsp");
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(&elsewhere, "the computer's own").unwrap();
        std::os::unix::fs::symlink(&elsewhere, &at).unwrap();

        let place = place_at(dir.path(), "wsp-shim");
        write_wsp_shim_inside(&place).unwrap();
        let held = fs::symlink_metadata(&at).unwrap();
        assert!(held.file_type().is_file(), "the workspace's wsp is not a regular file");
        assert_eq!(held.permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::read_to_string(&at).unwrap(), wsp_frames::guest_wsp_shim(profile::INIT_PATH));
        assert!(fs::read_to_string(&at).unwrap().contains("/sbin/wsp-init"));
        // What the link pointed at is untouched: a link in the computer's own /usr/local/bin cannot point this
        // write out of the rootfs.
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "the computer's own");
        // Written again at every boot, as the resolv.conf is, over what the last boot left.
        write_wsp_shim_inside(&place).unwrap();
        assert_eq!(fs::read_to_string(&at).unwrap(), wsp_frames::guest_wsp_shim(profile::INIT_PATH));
        // And on a rootfs with no such folder yet, which is a workspace whose upper holds nothing there.
        let bare = dir.path().join("bare");
        fs::create_dir_all(bare.join("rootfs")).unwrap();
        write_wsp_shim_inside(&place_at(&bare, "wsp-bare")).unwrap();
        assert!(bare.join("rootfs").join(wsp_frames::numbers::GUEST_WSP_PATH.trim_start_matches('/')).is_file());
    }

    /// What a login shell inside a workspace reads its PATH from, on a rootfs made by hand: one export line of the
    /// workspace's own in its /etc tree, a link the computer keeps at that name removed first as the wsp shim
    /// beside it does, and the line written again at every boot.
    #[test]
    fn the_login_shell_inside_a_workspace_reads_the_workspaces_own_order_from_its_own_profile_file() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        let at = rootfs.join(WORKSPACE_PROFILE_INSIDE.trim_start_matches('/'));
        let elsewhere = dir.path().join("the-computers-own-profile");
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(&elsewhere, "the computer's own").unwrap();
        std::os::unix::fs::symlink(&elsewhere, &at).unwrap();

        let place = place_at(dir.path(), "wsp-profile");
        write_workspace_profile_inside(&place).unwrap();
        let held = fs::symlink_metadata(&at).unwrap();
        assert!(held.file_type().is_file(), "the workspace's profile file is not a regular file");
        let line = format!("export PATH={}\n", wsp_frames::numbers::PLACE_WORKSPACE_PATH);
        assert_eq!(fs::read_to_string(&at).unwrap(), line);
        // What the link pointed at is untouched: a link in the computer's own /etc cannot point this write out
        // of the rootfs.
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "the computer's own");
        // Written again at every boot, as the resolv.conf and the shim are, over what the last boot left.
        write_workspace_profile_inside(&place).unwrap();
        assert_eq!(fs::read_to_string(&at).unwrap(), line);
        // And on a rootfs whose /etc holds no such folder yet, which is a box that keeps none of its own.
        let bare = dir.path().join("bare");
        fs::create_dir_all(bare.join("rootfs")).unwrap();
        write_workspace_profile_inside(&place_at(&bare, "wsp-bare-profile")).unwrap();
        assert_eq!(fs::read_to_string(bare.join("rootfs").join(WORKSPACE_PROFILE_INSIDE.trim_start_matches('/'))).unwrap(), line);
    }

    /// Every destination under a rootfs is opened beneath it with no link followed: the folders above it made on
    /// the way, the entry itself made as a directory or a 0600 file, and the descriptor answered is the entry a
    /// mount lands on rather than a path the kernel resolves a second time. No mount and no root.
    #[test]
    fn a_path_inside_is_opened_beneath_the_rootfs_and_the_descriptor_is_the_entry_itself() {
        let dir = tempfile::tempdir().unwrap();
        let place = place_at(dir.path(), "wsp-open");
        fs::create_dir_all(&place.rootfs).unwrap();

        let made = open_inside(&place, "/a/b/c", Want::Dir, BoxLink::FollowedOnce).unwrap();
        assert_eq!(made.landed, "/a/b/c");
        assert!(made.made && place.rootfs.join("a/b/c").is_dir());
        let file = open_inside(&place, "/a/b/c/f", Want::File, BoxLink::FollowedOnce).unwrap();
        assert_eq!(fs::symlink_metadata(place.rootfs.join("a/b/c/f")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_link(file.at()).unwrap(), fs::canonicalize(place.rootfs.join("a/b/c/f")).unwrap());
        // A path already there is not made again, which is what tells a mount point this boot made from a file
        // the person had at that path.
        assert!(!open_inside(&place, "/a/b/c/f", Want::File, BoxLink::FollowedOnce).unwrap().made);
        // The wire's own rule stands behind this one still.
        let refused = open_inside(&place, "/a/../etc", Want::Dir, BoxLink::FollowedOnce).unwrap_err().to_string();
        assert!(refused.contains("not a path inside a workspace"), "{refused}");

        // A link the workspace planted outside every overlaid tree and outside the shared home: refused, naming
        // the component and what to do about it, and nothing is made where it pointed.
        std::os::unix::fs::symlink("../..", place.rootfs.join("a/b/link")).unwrap();
        let refused = open_inside(&place, "/a/b/link/x", Want::Dir, BoxLink::FollowedOnce).unwrap_err().to_string();
        assert!(refused.contains("/a/b/link") && refused.contains("wsp-open"), "{refused}");
        assert!(refused.contains("replace the link with a folder and wake the workspace"), "{refused}");
        assert!(!dir.path().join("x").exists() && !place.rootfs.join("x").exists());
    }

    /// Whose a link met on the way is decides what happens to it: one the workspace's own upper carries refuses
    /// the boot, one the box keeps in an overlay's lower or under the home every workspace shares is followed
    /// once, and a second link behind it, or a target that leaves the rootfs, refuses with the same sentence.
    #[test]
    fn a_link_the_box_keeps_is_followed_once_beneath_the_rootfs_and_the_workspaces_own_refuses_the_boot() {
        let dir = tempfile::tempdir().unwrap();
        let place = place_at(dir.path(), "wsp-links");
        for made in [place.rootfs.join("etc"), place.rootfs.join("root"), place.uppers[0].join("etc")] {
            fs::create_dir_all(made).unwrap();
        }

        // In an overlaid tree, with the same path in the workspace's own upper: the workspace wrote it.
        std::os::unix::fs::symlink("/", place.rootfs.join("etc/x")).unwrap();
        std::os::unix::fs::symlink("/", place.uppers[0].join("etc/x")).unwrap();
        let refused = open_inside(&place, "/etc/x/planted", Want::Dir, BoxLink::FollowedOnce).unwrap_err().to_string();
        assert!(refused.contains("/etc/x") && refused.contains("replace the link with a folder"), "{refused}");

        // The same link with nothing of the workspace's at that path is the box's own, and is followed once: the
        // target is resolved beneath the rootfs, so what lands lands inside and never on the box.
        fs::remove_file(place.uppers[0].join("etc/x")).unwrap();
        fs::remove_file(place.rootfs.join("etc/x")).unwrap();
        std::os::unix::fs::symlink("/etc/held", place.rootfs.join("etc/x")).unwrap();
        let opened = open_inside(&place, "/etc/x/under", Want::Dir, BoxLink::FollowedOnce).unwrap();
        assert_eq!(opened.landed, "/etc/held/under");
        assert!(place.rootfs.join("etc/held/under").is_dir());
        assert!(!Path::new("/etc/held").exists(), "the walk followed the link onto the box");

        // A second link behind the first, whoever keeps it.
        std::os::unix::fs::symlink("/etc/again", place.rootfs.join("etc/held/second")).unwrap();
        let refused = open_inside(&place, "/etc/x/second/deeper", Want::Dir, BoxLink::FollowedOnce).unwrap_err().to_string();
        assert!(refused.contains("/etc/held/second"), "{refused}");
        // And a target that climbs out of the rootfs.
        std::os::unix::fs::symlink("../../../../..", place.rootfs.join("etc/out")).unwrap();
        let refused = open_inside(&place, "/etc/out/x", Want::Dir, BoxLink::FollowedOnce).unwrap_err().to_string();
        assert!(refused.contains("/etc/out") && refused.contains("replace the link with a folder"), "{refused}");

        // A link the workspace wrote under a tree the box lends inside one it owns: its upper for that tree sits
        // under the lent folder, and the rule reads that one too, so the link is the workspace's and refuses.
        fs::create_dir_all(place.rootfs.join("var/lib")).unwrap();
        std::os::unix::fs::symlink("/", place.rootfs.join("var/lib/dpkg")).unwrap();
        fs::create_dir_all(place.uppers[1].join("var/lib")).unwrap();
        std::os::unix::fs::symlink("/", place.uppers[1].join("var/lib/dpkg")).unwrap();
        let refused = open_inside(&place, "/var/lib/dpkg/status", Want::File, BoxLink::FollowedOnce).unwrap_err().to_string();
        assert!(refused.contains("/var/lib/dpkg") && refused.contains("replace the link with a folder"), "{refused}");

        // Under the home every workspace here shares the link is the box root's whatever the upper holds, since
        // the daemon cannot tell one from the other and both are uid 0 in one folder; the follow lands inside.
        std::os::unix::fs::symlink("/etc/dotfiles", place.rootfs.join("root/.codex")).unwrap();
        fs::create_dir_all(place.uppers[0].join("root")).unwrap();
        std::os::unix::fs::symlink("/etc/dotfiles", place.uppers[0].join("root/.codex")).unwrap();
        let opened = open_inside(&place, "/root/.codex/auth.json", Want::File, BoxLink::FollowedOnce).unwrap();
        assert_eq!(opened.landed, "/etc/dotfiles/auth.json");
        assert!(place.rootfs.join("etc/dotfiles/auth.json").is_file());
    }

    /// A cover goes over a name the box root's own login and its systemd run, so a link at that name refuses the
    /// boot and the sentence says to put the file there: a copy bound over the link's target would leave the name
    /// itself a link in a folder the workspace is uid 0 in, which it may unlink and write. A share's path is the
    /// other road, since a box whose root keeps its dotfiles in a checkout keeps that path as a link on purpose.
    #[test]
    fn a_link_on_a_cover_name_refuses_the_boot_and_the_same_link_on_a_shares_path_is_followed() {
        let dir = tempfile::tempdir().unwrap();
        let place = place_at(dir.path(), "wsp-covers");
        for made in [place.rootfs.join("root"), place.rootfs.join("var/tmp/dotfiles")] {
            fs::create_dir_all(made).unwrap();
        }
        // The box root's own rc file, kept in a dotfiles checkout and linked to by the name a login reads.
        std::os::unix::fs::symlink("/var/tmp/dotfiles/bashrc", place.rootfs.join("root/.bashrc")).unwrap();

        let refused = open_inside(&place, "/root/.bashrc", Want::File, BoxLink::Refused).unwrap_err().to_string();
        assert!(refused.contains("/root/.bashrc") && refused.contains("wsp-covers"), "{refused}");
        assert!(refused.contains("replace the link with a file and wake the workspace"), "{refused}");
        // And the refusal came before anything was made where the link led.
        assert!(!place.rootfs.join("var/tmp/dotfiles/bashrc").exists());

        // A row of the list the cover is a folder for says a folder, and a link above the name refuses too.
        std::os::unix::fs::symlink("/var/tmp/dotfiles/config", place.rootfs.join("root/.config")).unwrap();
        let refused = open_inside(&place, "/root/.config/systemd", Want::Dir, BoxLink::Refused).unwrap_err().to_string();
        assert!(refused.contains("/root/.config") && refused.contains("replace the link with a folder"), "{refused}");

        // The two rows that are not the box root's own startup files take the same word. A box root that keeps
        // .ssh as a link refuses, since the cover would land on what the link leads to and the keys would read
        // inside by the name itself.
        std::os::unix::fs::symlink("/var/tmp/dotfiles/ssh", place.rootfs.join("root/.ssh")).unwrap();
        let refused = open_inside(&place, "/root/.ssh", Want::Dir, BoxLink::Refused).unwrap_err().to_string();
        assert!(refused.contains("/root/.ssh") && refused.contains("replace the link with a folder"), "{refused}");
        assert!(!place.rootfs.join("var/tmp/dotfiles/ssh").exists());
        // And a box root with no .ssh at all gets the folder made and covered, so an authorized_keys a workspace
        // writes lands in the workspace's own folder and never on the home the box root shares with it.
        fs::remove_file(place.rootfs.join("root/.ssh")).unwrap();
        let made = open_inside(&place, "/root/.ssh", Want::Dir, BoxLink::Refused).unwrap();
        assert!(made.made, "the walk found a folder where the box keeps none");
        assert_eq!(made.landed, "/root/.ssh");
        assert!(place.rootfs.join("root/.ssh").is_dir());

        // The other road, which a share takes: the same link followed once and landing beneath the rootfs.
        let opened = open_inside(&place, "/root/.bashrc", Want::File, BoxLink::FollowedOnce).unwrap();
        assert_eq!(opened.landed, "/var/tmp/dotfiles/bashrc");
        assert!(place.rootfs.join("var/tmp/dotfiles/bashrc").is_file());
    }

    /// The mount point a boot left on the computer's own disk, taken off through the descriptor of the folder it
    /// sits in: an empty file goes, a file somebody wrote a login into stays, and a point now reached through a
    /// link stays with the sentence that says so.
    #[test]
    fn the_take_off_unlinks_an_empty_point_and_leaves_one_reached_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home/.codex");
        fs::create_dir_all(&home).unwrap();
        let point = home.join("auth.json");
        let named = point.display().to_string();
        empty_file(&point).unwrap();
        assert_eq!(take_off_point(&named).unwrap(), None);
        assert!(!point.exists());
        // A folder on the way replaced by a link: nothing is unlinked and the sentence names the link.
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let kept = elsewhere.join("auth.json");
        empty_file(&kept).unwrap();
        fs::remove_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &home).unwrap();
        let stands = take_off_point(&named).unwrap().unwrap();
        assert!(stands.contains(&home.display().to_string()) && stands.contains("stays standing"), "{stands}");
        assert!(kept.is_file(), "the take-off unlinked a file through a link");
        // A sign-in written into the point since the boot is the person's, as it was before this rule.
        fs::remove_file(&home).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&point, b"{}").unwrap();
        assert_eq!(take_off_point(&named).unwrap(), None);
        assert!(point.is_file());
        // And a point that is not there is nothing to take off.
        fs::remove_file(&point).unwrap();
        assert_eq!(take_off_point(&named).unwrap(), None);
    }

    /// What a workspace reads of the box's own /etc is the view the boot builds, holding the allowlist and
    /// nothing else, and a tree the box lends nothing to is the skeleton it needs. Built over a directory of this
    /// case's own rather than the box's, and no mount and no root.
    #[test]
    fn the_view_of_a_tree_holds_what_the_list_allows_and_nothing_of_the_boxs_own_services() {
        let dir = tempfile::tempdir().unwrap();
        let boxs = dir.path().join("etc");
        for made in ["apt/apt.conf.d", "apt/auth.conf.d", "ssl/private", "ssl/certs", "python3.12/lib", "systemd/system"] {
            fs::create_dir_all(boxs.join(made)).unwrap();
        }
        for (file, text) in [
            ("passwd", "root:x:0:0:root:/root:/bin/bash\n"),
            ("shadow", "root:$y$of.the.box\n"),
            ("apt/sources.list", "deb http://example.invalid x main\n"),
            ("apt/auth.conf", "machine example.invalid login u password p\n"),
            ("apt/auth.conf.d/private.conf", "machine x login u password p\n"),
            ("apt/apt.conf.d/99local", "Acquire::Retries \"3\";\n"),
            ("ssl/private/box.key", "the box's own key\n"),
            ("ssl/certs/ca.pem", "a certificate\n"),
            ("python3.12/lib/sitecustomize.py", "# the box's own\n"),
            ("systemd/system/wsp.service", "[Service]\n"),
        ] {
            fs::write(boxs.join(file), text).unwrap();
        }
        // What df and mount read, which every box keeps as a link into proc, and what it points at.
        std::os::unix::fs::symlink("/proc/self/mounts", boxs.join("mtab")).unwrap();

        let view = dir.path().join("view");
        view_of(&view, &boxs, hardening::ETC_ALLOWED, &[], &[]).unwrap();
        // An allowed file, an allowed tree taken whole, and a name the box keeps by version taken through the
        // star at the end of its row.
        assert_eq!(fs::read_to_string(view.join("passwd")).unwrap(), "root:x:0:0:root:/root:/bin/bash\n");
        assert_eq!(fs::read_to_string(view.join("apt/sources.list")).unwrap(), "deb http://example.invalid x main\n");
        assert!(view.join("apt/apt.conf.d/99local").is_file());
        assert!(view.join("ssl/certs/ca.pem").is_file());
        assert!(view.join("python3.12/lib/sitecustomize.py").is_file(), "a versioned name did not come in");
        // A link comes in as the link it is and what it points at is never read.
        let held = fs::symlink_metadata(view.join("mtab")).unwrap();
        assert!(held.file_type().is_symlink());
        assert_eq!(fs::read_link(view.join("mtab")).unwrap(), Path::new("/proc/self/mounts"));
        // And what a service of the box's own reads is not there at all, rather than covered inside: the
        // repository credentials the whole apt tree used to carry among them.
        for kept in ["shadow", "apt/auth.conf", "apt/auth.conf.d", "ssl/private", "ssl/private/box.key", "systemd"] {
            assert!(!view.join(kept).exists(), "{kept} is in the view");
        }
        // Built again over a box that has moved on: the view is what the box has now and not what it had.
        fs::remove_file(boxs.join("apt/sources.list")).unwrap();
        fs::write(boxs.join("passwd"), "root:x:0:0:root:/root:/bin/sh\n").unwrap();
        view_of(&view, &boxs, hardening::ETC_ALLOWED, &[], &[]).unwrap();
        assert!(!view.join("apt/sources.list").exists(), "the view carried what the last boot read");
        assert_eq!(fs::read_to_string(view.join("passwd")).unwrap(), "root:x:0:0:root:/root:/bin/sh\n");

        // A tree the box lends nothing to: the skeleton a distribution expects, the two names it keeps as links,
        // and nothing of the box's own tree of that name.
        let var = dir.path().join("view-var");
        view_of(&var, Path::new("/var"), &[], &hardening::VAR_DIRS, &hardening::VAR_LINKS).unwrap();
        for (name, mode) in hardening::VAR_DIRS {
            assert!(var.join(name).is_dir(), "{name}");
            assert_eq!(fs::symlink_metadata(var.join(name)).unwrap().permissions().mode() & 0o7777, mode, "{name}");
        }
        for (name, target) in hardening::VAR_LINKS {
            assert_eq!(fs::read_link(var.join(name)).unwrap(), Path::new(target));
        }
        assert!(!var.join("lib/dpkg").exists(), "the box's own /var showed through the workspace's");
        assert!(!var.join("lib/cloud").exists() && !var.join("www").exists());
    }

    /// The whole of what a workspace on a computer somebody owns is made of, mounted on a throwaway root and
    /// taken down again: the box's own top-level symlinks, the skeleton, an overlay over each of the computer's
    /// system directories with the workspace's own upper under it, the box's /root, an empty directory over every
    /// path nothing inside may read, and this computer's own install roots outside those trees bound in at their
    /// own paths. Root, as every mount case here is. Nothing of the computer's /home is written here: the roots
    /// are whatever it already has, read rather than made.
    #[test]
    #[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
    fn a_workspace_is_the_computers_own_directories_over_the_workspaces_own_uppers() {
        assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("root"));
        let (id, rootfs) = ("wsp-computer", layout.rootfs("wsp-computer"));
        // What the computer keeps at its own resolv.conf, read before anything is mounted: a link on every
        // computer that runs systemd-resolved, and whatever it is, this leaves it alone.
        let box_resolv = (fs::symlink_metadata(BOX_RESOLV).map(|m| m.file_type().is_symlink()).ok(), fs::read_link(BOX_RESOLV).ok());
        // And what the box keeps at two of the paths the covers go over, so the case can say afterwards that the
        // computer's own are as they were: how many entries its /root/.ssh holds and how long its shadow file is,
        // neither of which is a thing this reads the content of.
        let box_ssh = fs::read_dir("/root/.ssh").map(|d| d.count()).unwrap_or(0);
        let box_shadow = fs::metadata("/etc/shadow").map(|m| m.len()).ok();
        // And what the box root's own login reads by name, so the case can say the workspace's write stayed off it.
        let box_rc = fs::read("/root/.bashrc").ok();
        // What this computer has of the install roots outside the overlaid trees: /home/linuxbrew on a box the
        // recipe's Homebrew rows ran on, nothing on one with no Homebrew, and the case reads both.
        let roots = tool_roots_present(&wsp_frames::numbers::SHARED_TOOL_ROOTS);
        mount_computer(&layout, id, &roots).unwrap();
        let table = || fs::read_to_string(MOUNTINFO).unwrap();
        let mounted = |at: &Path| mount_points(&table()).contains(&at.to_path_buf());

        // The box's own links, read off / rather than written down: on a merged-usr box bin, sbin, lib and lib64
        // point into usr, and a rootfs without them has no shell at all.
        for (name, target) in top_level_links().unwrap() {
            assert_eq!(fs::read_link(rootfs.join(&name)).unwrap(), target, "{name}");
        }
        // And a second mount of the same rootfs, which is what a wake is, writes them again rather than
        // tripping on the links its first boot left.
        unmount_under(&rootfs).unwrap();
        mount_computer(&layout, id, &roots).unwrap();
        for (name, target) in top_level_links().unwrap() {
            assert_eq!(fs::read_link(rootfs.join(&name)).unwrap(), target, "{name} after a second mount");
        }
        for name in SKELETON {
            assert!(rootfs.join(name).is_dir(), "{name}");
        }
        // Each of the five is its own overlay, and each carries the box's own files.
        for lower in OVERLAID {
            let at = rootfs.join(lower.trim_start_matches('/'));
            assert!(mounted(&at), "{lower} is not mounted");
            assert!(layout.upper_of(id, lower).is_dir() && layout.work_of(id, lower).is_dir(), "{lower}");
        }
        assert!(rootfs.join("etc/os-release").is_file(), "the box's /etc did not come in");
        // The one file in the box's /etc a workspace may not take as it is: the boot writes a regular
        // resolv.conf in the workspace's own upper, whatever the box keeps there, and the box's own is
        // untouched. Without it the runtime's bind of that file resolves inside the root to nothing.
        let inside_resolv = rootfs.join(RESOLV_INSIDE.trim_start_matches('/'));
        assert!(fs::symlink_metadata(&inside_resolv).unwrap().file_type().is_file(), "the workspace's resolv.conf is not a file");
        let text = fs::read_to_string(&inside_resolv).unwrap();
        assert!(text.lines().any(|line| line.starts_with("nameserver ")) && !text.contains("127.0.0.53"), "{text}");
        assert!(layout.upper_of(id, "/etc").join("resolv.conf").is_file(), "the write did not land in the workspace's upper");
        assert_eq!(
            (fs::symlink_metadata(BOX_RESOLV).map(|m| m.file_type().is_symlink()).ok(), fs::read_link(BOX_RESOLV).ok()),
            box_resolv,
            "the computer's own resolv.conf changed"
        );

        // And the one file of the workspace's own the boot puts under /etc/profile.d, which is what a login shell
        // in a pane there reads its PATH from after the box's own profile has set root's.
        let inside_profile = rootfs.join(WORKSPACE_PROFILE_INSIDE.trim_start_matches('/'));
        assert_eq!(fs::read_to_string(&inside_profile).unwrap(), format!("export PATH={}\n", wsp_frames::numbers::PLACE_WORKSPACE_PATH));
        assert!(layout.upper_of(id, "/etc").join("profile.d/wsp-workspace.sh").is_file(), "the line did not land in the workspace's upper");
        assert!(!Path::new(WORKSPACE_PROFILE_INSIDE).exists(), "the boot wrote the line on the computer itself");

        // A write through the merged view lands in the workspace's own upper, and the box's directory does not
        // have it: a workspace installs a package and the computer does not.
        let written = rootfs.join("usr/lib/wsp-computer-probe");
        fs::write(&written, b"the workspace wrote this\n").unwrap();
        assert_eq!(fs::read(layout.upper_of(id, "/usr").join("lib/wsp-computer-probe")).unwrap(), b"the workspace wrote this\n");
        assert!(!Path::new("/usr/lib/wsp-computer-probe").exists(), "a workspace's write reached the box");

        // The person's own /root is the box's, shared and writable; every path the hardening list names is the
        // workspace's own empty file or directory over the box's, so the box's logins, its sudo rules, its ssh
        // host keys, the keys that open it and every other home on it show nothing inside.
        assert!(mounted(&rootfs.join("root")));
        let covers = hardening::covered();
        for named in ["/root/.ssh", "/home"] {
            assert!(covers.iter().any(|c| c.at == named), "{named} is not covered: {covers:?}");
        }
        // What the covers used to hide is not inside to hide: the box's /etc is a view of what a tool inside
        // reads, and its /var and /srv are the workspace's own with the package trees the only ones lent.
        for kept in ["etc/shadow", "etc/gshadow", "etc/ssl/private", "etc/apt/auth.conf", "etc/apt/auth.conf.d", "var/lib/docker"] {
            assert!(fs::symlink_metadata(rootfs.join(kept)).is_err(), "{kept} reads inside the workspace");
        }
        assert!(!rootfs.join("etc/ssh").join("ssh_host_ed25519_key").exists(), "a host key reads inside the workspace");
        // And what a tool inside reads is there: the accounts, the mounts df reads, the certificates and, where
        // the box has them, the package database and the caches apt writes its own over.
        for held in ["etc/passwd", "etc/group", "etc/mtab", "etc/ssl/certs", "etc/os-release"] {
            assert!(fs::symlink_metadata(rootfs.join(held)).is_ok(), "{held} does not read inside the workspace");
        }
        for lent in hardening::VAR_FROM_BOX {
            if Path::new(lent).is_dir() {
                assert!(mounted(&rootfs.join(lent.trim_start_matches('/'))), "{lent} is not lent inside the workspace");
            }
        }
        // The workspace's own /var carries the skeleton and nothing else of the box's.
        assert!(rootfs.join("var/tmp").is_dir() && rootfs.join("var/log").is_dir());
        assert_eq!(fs::read_link(rootfs.join("var/run")).unwrap(), Path::new("/run"));
        assert!(fs::symlink_metadata(rootfs.join("var/lib/cloud")).is_err(), "the box's own /var reads inside");
        for cover in &covers {
            let at_path = inside(&rootfs, &cover.at).unwrap();
            assert!(mounted(&at_path), "{} is not covered", cover.at);
            let source = if cover.own { layout.own_at(id, &cover.at) } else { layout.empty_at(id, &cover.at) };
            if cover.file {
                // What reads inside is the workspace's own file, empty where the cover is an empty one and the
                // box's bytes as they were at the first boot where it is the workspace's own copy.
                assert_eq!(fs::read(&at_path).unwrap(), fs::read(&source).unwrap(), "{} is not the workspace's own", cover.at);
                if !cover.own {
                    assert_eq!(fs::metadata(&at_path).unwrap().len(), 0, "{} reads bytes inside", cover.at);
                }
                continue;
            }
            // Empty, but for the install roots the boot binds in after the covers: the only thing under /home a
            // workspace reads is the prefix a road installed the computer's tools into, which lands inside the
            // cover because the boot binds it after the cover is up.
            let mut expected: Vec<String> = roots
                .iter()
                .filter_map(|root| Path::new(root).strip_prefix(&cover.at).ok())
                .filter_map(|rest| rest.components().next().map(|first| first.as_os_str().to_string_lossy().into_owned()))
                .collect();
            let mut held: Vec<String> =
                fs::read_dir(&at_path).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            held.sort();
            expected.sort();
            expected.dedup();
            assert_eq!(held, expected, "{} holds more than the install roots brought in", cover.at);
            fs::write(at_path.join("probe"), b"w").unwrap();
            assert!(source.join("probe").is_file(), "{} wrote somewhere else", cover.at);
            // And the write went to the workspace's own empty directory, never to the bound root inside it.
            assert_eq!(fs::read_dir(&at_path).unwrap().count(), expected.len() + 1, "{}", cover.at);
        }
        // Every install root this computer has is mounted at its own path inside, under the cover over /home, and
        // what it holds is the computer's own: the tools a road installed there answer in the workspace.
        for root in &roots {
            let at_path = inside(&rootfs, root).unwrap();
            assert!(mounted(&at_path), "{root} is not bound into the workspace");
            let mut inside_names: Vec<String> =
                fs::read_dir(&at_path).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            let mut own: Vec<String> = fs::read_dir(root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            inside_names.sort();
            own.sort();
            assert_eq!(inside_names, own, "{root} reads differently inside");
        }
        // What the box root's own login runs by name is the workspace's own copy of it: a line written inside is
        // in that copy and the box's own file is as it was. A box that keeps no such file gains the empty file
        // the cover lands on, and nothing is ever written into it.
        let rc = Path::new("/root/.bashrc");
        let inside_rc = inside(&rootfs, "/root/.bashrc").unwrap();
        assert_eq!(fs::read(&inside_rc).unwrap(), box_rc.clone().unwrap_or_default(), "the workspace's own rc is not the box's");
        fs::write(&inside_rc, b"# the workspace wrote this\n").unwrap();
        match &box_rc {
            Some(held) => assert_eq!(fs::read(rc).ok().as_ref(), Some(held), "a write inside reached the box root's own rc file"),
            None => assert_eq!(fs::metadata(rc).unwrap().len(), 0, "the cover's mount point on the box is not empty"),
        }
        assert_eq!(fs::read_dir("/root/.ssh").map(|d| d.count()).unwrap_or(0), box_ssh, "the computer's own keys changed");
        assert_eq!(fs::metadata("/etc/shadow").map(|m| m.len()).ok(), box_shadow, "the computer's own logins changed");

        // The wsp folder under that home is the workspace's own: what the daemon inside writes at its token's
        // default path lands under run/<id> and nothing of it reaches the box's own folder.
        let home = inside(&rootfs, GUEST_WSP_HOME).unwrap();
        assert!(mounted(&home), "the workspace's own wsp folder is not mounted");
        let token = PathBuf::from(wsp_frames::numbers::DEFAULT_TOKEN_PATH);
        let held = fs::read(&token).ok();
        fs::write(inside(&rootfs, wsp_frames::numbers::DEFAULT_TOKEN_PATH).unwrap(), b"a-token-of-this-workspace\n").unwrap();
        assert_eq!(fs::read(layout.wsp_home(id).join("daemon-token")).unwrap(), b"a-token-of-this-workspace\n");
        assert_eq!(fs::read(&token).ok(), held, "a write inside reached the computer's own daemon token");

        // /run and /tmp are the workspace's own and empty at every boot, which is what every distribution
        // expects: a pid file or a socket left there names a process the stop took away.
        for name in EMPTIED_AT_BOOT {
            assert_eq!(fs::read_dir(rootfs.join(name)).unwrap().count(), 0, "/{name} is not empty at boot");
            fs::write(rootfs.join(name).join("last-boot.pid"), b"4242\n").unwrap();
        }

        unmount_under(&rootfs).unwrap();
        assert!(!table().contains(&rootfs.display().to_string()), "a mount of the workspace outlived the stop");
        // What the workspace wrote is still on disk, which is what a wake boots over: the uppers, the wsp
        // folder with the daemon's own token in it, and the empty directories' own writes.
        assert!(layout.upper_of(id, "/usr").join("lib/wsp-computer-probe").is_file());
        assert_eq!(fs::read(layout.wsp_home(id).join("daemon-token")).unwrap(), b"a-token-of-this-workspace\n");
        // And what it left at /run and /tmp is gone at the next boot, as a boot leaves them.
        mount_computer(&layout, id, &roots).unwrap();
        for name in EMPTIED_AT_BOOT {
            assert_eq!(fs::read_dir(rootfs.join(name)).unwrap().count(), 0, "/{name} carried the last boot's files");
        }
        assert_eq!(fs::read(inside(&rootfs, wsp_frames::numbers::DEFAULT_TOKEN_PATH).unwrap()).unwrap(), b"a-token-of-this-workspace\n");
        unmount_under(&rootfs).unwrap();
    }

    /// A bind whose source is in a shared peer group, which is what the computer's own `/` is on a box: what
    /// the boot mounts under that bind may not appear at the source's own path. The source here is a temp
    /// directory this case makes shared itself, never the computer's `/root`, which this case neither reads nor
    /// writes. Root, as every mount case here is.
    #[test]
    #[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
    fn nothing_mounted_under_a_bind_reaches_the_peer_group_its_source_is_in() {
        assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
        let dir = tempfile::tempdir().unwrap();
        // The stand-in for the computer's own home and the folder under it a workspace covers: a marker in it,
        // so a mount that reached the source would hide this file and the case would read that.
        let (home, under) = (dir.path().join("home"), dir.path().join("home/.wsp"));
        let (own, rootfs) = (dir.path().join("own"), dir.path().join("rootfs"));
        for made in [&home, &under, &own, &rootfs] {
            fs::create_dir_all(made).unwrap();
        }
        fs::write(
            under.join("token"),
            b"the computer's own
",
        )
        .unwrap();
        // The source made a mount of its own and shared, which is the shape a box's / has.
        mount(Some(&home), &home, None::<&str>, MsFlags::MS_BIND | MsFlags::MS_REC, None::<&str>).unwrap();
        mount(None::<&str>, &home, None::<&str>, MsFlags::MS_SHARED | MsFlags::MS_REC, None::<&str>).unwrap();
        let table = || fs::read_to_string(MOUNTINFO).unwrap();
        let at_path = |p: &Path| mount_points(&table()).iter().filter(|point| *point == p).count();
        assert_eq!(at_path(&home), 1, "the stand-in source is not its own mount");

        // The boot's own road: the source bound under a rootfs, then the workspace's own folder over a path
        // inside that bind.
        bind_into(&rootfs, &rootfs).unwrap();
        bind_into(&home, &rootfs.join("root")).unwrap();
        bind_into(&own, &rootfs.join("root/.wsp")).unwrap();
        assert_eq!(at_path(&rootfs.join("root/.wsp")), 1, "the workspace's own folder is not mounted");
        // The whole of it: nothing new at the source's own path, and what the source holds there is still what
        // it held. A bind left in the source's peer group would have put the workspace's empty folder here.
        assert_eq!(at_path(&under), 0, "a mount under the bind reached the source's own path");
        assert_eq!(
            fs::read_to_string(under.join("token")).unwrap(),
            "the computer's own
"
        );
        assert_eq!(fs::read_dir(&under).unwrap().count(), 1);
        // And the workspace reads its own folder at that path, which is the point of the bind.
        fs::write(
            rootfs.join("root/.wsp/token"),
            b"the workspace's own
",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(own.join("token")).unwrap(),
            "the workspace's own
"
        );
        assert_eq!(
            fs::read_to_string(under.join("token")).unwrap(),
            "the computer's own
"
        );

        unmount_under(&rootfs).unwrap();
        assert_eq!(at_path(&under), 0);
        unmount(&home).unwrap();
    }

    /// Two binds under a rootfs, as a boot leaves them, taken down by one call while the mount the box itself
    /// holds under the same root stays. Root and a mount namespace of its own, so it runs where the mount cases do.
    #[test]
    #[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
    fn unmount_under_takes_a_bind_under_a_bind_and_leaves_the_boxs_own_mounts() {
        assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
        let dir = tempfile::tempdir().unwrap();
        let (root, rootfs) = (dir.path().join("root"), dir.path().join("root/run/wsp-a/rootfs"));
        let outside = dir.path().join("outside");
        for made in [&rootfs, &outside, &root.join("copies/wsp-a")] {
            fs::create_dir_all(made).unwrap();
        }
        fs::write(root.join("copies/wsp-a/file"), b"in the copy").unwrap();
        // The box's own mount under the same root, which nothing here may take down.
        let kept = root.join("projects");
        fs::create_dir_all(&kept).unwrap();
        bind_into(&outside, &kept).unwrap();
        bind_into(&root.join("copies/wsp-a"), &rootfs.join("Users/zingzy/wsp")).unwrap();
        bind_into(&root.join("copies/wsp-a"), &rootfs.join("Users/zingzy/wsp/again")).unwrap();
        let mounted = |at: &Path| mount_points(&fs::read_to_string(MOUNTINFO).unwrap()).contains(&at.to_path_buf());
        assert!(mounted(&rootfs.join("Users/zingzy/wsp")) && mounted(&rootfs.join("Users/zingzy/wsp/again")));
        unmount_under(&rootfs).unwrap();
        assert!(!mounted(&rootfs.join("Users/zingzy/wsp")) && !mounted(&rootfs.join("Users/zingzy/wsp/again")));
        assert!(mounted(&kept), "the box's own mount went with the workspace's");
        unmount(&kept).unwrap();
    }
}
