// SPDX-License-Identifier: AGPL-3.0-only
//! What a computer joined as a place says about itself, the key it proves itself with, and what its leave takes.
//! The report is read off the home the daemon was pointed at and the words it was started with, at every dial
//! rather than once: a laptop gains a Docker, loses a disk and is renamed under wsp rather than by it. Signing and
//! verifying are ed25519-dalek's; the bytes they cover are the protocol's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest as _, Sha256};
use wsp_frames::{
    is_under_path, landed_files_script, numbers, own_marks, place_daemon_paths, place_owned_paths, words, Base64Bytes, PlaceFile,
    PlacePublicKey, PlaceReport, PlaceSignature, Platform, WorkspaceSize,
};

/// The place file as it stands, or nothing when this computer is no place: a file that is there and is not one
/// reads the same as none, since the one road that writes it is wsp join.
pub(crate) fn read_place_file(path: &Path) -> Option<PlaceFile> {
    PlaceFile::parse(&std::fs::read_to_string(path).ok()?)
}

/// This place's signature over the transcript, with the pkcs8 PEM key wsp join wrote.
pub(crate) fn sign_place_bytes(private_key_pem: &str, bytes: &[u8]) -> Result<PlaceSignature, String> {
    let key = SigningKey::from_pkcs8_pem(private_key_pem).map_err(|e| format!("the place key does not read as pkcs8 PEM: {e}"))?;
    Ok(Base64Bytes::from_bytes(&key.sign(bytes).to_bytes()))
}

/// Whether the key given (SPKI DER, base64) made this signature over these bytes. A key that will not parse is a
/// refusal rather than a failure: the answer came off the wire.
pub(crate) fn verify_place_bytes(public_key: &PlacePublicKey, bytes: &[u8], signature: &PlaceSignature) -> bool {
    let Ok(key) = VerifyingKey::from_public_key_der(&public_key.to_bytes()) else { return false };
    key.verify(bytes, &Signature::from_bytes(&signature.to_bytes())).is_ok()
}

/// One agent to look for on this computer, as the --agents flag spells it: the catalog id and the command name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentBin {
    pub(crate) id: String,
    pub(crate) bin: String,
}

/// `id=command` pairs; a pair missing either half is dropped, since the report has nothing to look for.
pub(crate) fn parse_agents(words: &[String]) -> Vec<AgentBin> {
    words
        .iter()
        .filter_map(|word| {
            let (id, bin) = word.split_once('=')?;
            (!id.is_empty() && !bin.is_empty()).then(|| AgentBin { id: id.to_owned(), bin: bin.to_owned() })
        })
        .collect()
}

/// How long one `<bin> --version` gets to answer: a binary that hangs costs one dial that long and never the link.
pub(crate) const VERSION_DEADLINE: Duration = Duration::from_secs(5);
/// How often a running version read is looked in on while its deadline runs.
const VERSION_POLL: Duration = Duration::from_millis(50);
/// What the report carries of the line it printed, as the wire bounds it.
const VERSION_LINE_MAX: usize = 64;
/// What the report carries of the logins folder, as the wire bounds it: how many names and how long each.
const LOGINS_MAX: usize = 64;
const LOGIN_PATH_MAX: usize = 200;

/// Where the first executable of that name on this PATH sits, or nothing: the one reading of what stands on this
/// computer, since the agents list and the version read must never disagree about whether an agent is there.
fn found_at(name: &str, path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(name))
        .find(|at| std::fs::metadata(at).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false))
}

/// Where the agents on this computer are looked for: the one tools PATH every process inside a workspace here
/// starts with, and the PATH this daemon's own unit was given after it. A unit's PATH is the distribution's
/// default, which names neither Homebrew's bins nor the directory an agent's own installer writes into, so an
/// agent the recipe installed sits on no line of it and a report read on it alone leaves that agent and its
/// version out. Finding that a file stands somewhere runs nothing, which is why this list may name directories
/// under the home the workspaces share while the list the version read runs on may not.
pub(crate) fn presence_path(unit: Option<&str>) -> String {
    presence_path_over(numbers::TOOLS_PATH, unit.unwrap_or_default())
}

/// The two lists as one, the tools first: a command on both is read from where a workspace here would run it.
/// Written apart from the reading above so a case can hand it a tools list and a unit PATH of its own.
fn presence_path_over(tools: &str, unit: &str) -> String {
    if unit.is_empty() {
        return tools.to_owned();
    }
    format!("{tools}:{unit}")
}

/// The PATH this daemon runs a command through, which on a computer that runs workspaces the start set to the
/// probe list: no directory under the home a workspace writes, so a file planted there is never run as root.
pub(crate) fn run_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Which of the agents asked for stand on this computer, by catalog id. The one reading behind the report's list
/// and the version read, so an agent on one of them is on the other.
fn agents_on(agents: &[AgentBin], path: &str) -> Vec<String> {
    agents.iter().filter(|agent| found_at(&agent.bin, path).is_some()).map(|agent| agent.id.clone()).collect()
}

/// What the last version read of one agent found: the file it ran, as that file was then, and what it printed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentRead {
    at: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    line: String,
}

/// Every agent's version line, held between dials against the binary it came from. A daemon is not restarted by an
/// update that installs a newer agent, so the line is read again at a dial where that binary's path, size or
/// modification time moved, and handed back untouched where none of the three did: one stat per agent per dial.
#[derive(Debug, Default)]
pub(crate) struct AgentVersions {
    held: BTreeMap<String, AgentRead>,
}

impl AgentVersions {
    /// Stats each agent's binary and runs it again where it moved. An agent that is no longer on the PATH drops
    /// off, so the report never carries a version for a binary that is not there.
    pub(crate) fn refresh(&mut self, agents: &[AgentBin], path: &str, deadline: Duration) {
        let mut fresh = BTreeMap::new();
        for agent in agents {
            let Some(at) = found_at(&agent.bin, path) else { continue };
            let meta = std::fs::metadata(&at).ok();
            let size = meta.as_ref().map(std::fs::Metadata::len).unwrap_or(0);
            let modified = meta.as_ref().and_then(|m| m.modified().ok());
            match self.held.remove(&agent.id) {
                Some(read) if read.at == at && read.size == size && read.modified == modified => {
                    fresh.insert(agent.id.clone(), read);
                }
                _ => {
                    if let Some(line) = version_line(&at, deadline) {
                        fresh.insert(agent.id.clone(), AgentRead { at, size, modified, line });
                    }
                }
            }
        }
        self.held = fresh;
    }

    /// The lines as the report carries them, by catalog id.
    pub(crate) fn lines(&self) -> BTreeMap<String, String> {
        self.held.iter().map(|(id, read)| (id.clone(), read.line.clone())).collect()
    }
}

/// What `<bin> --version` printed: the first line it said that is not blank, trimmed and cut to what the report
/// carries. Both streams are read, stdout first: a tool that prints its version on stderr would otherwise read as
/// nothing and be run again at every dial, a process per dial where the point of this is one stat. Nothing where
/// the binary would not start or said nothing inside the deadline, which the next dial reads again. The exit code
/// is not read: what a tool printed about itself is the fact, and some print it and exit non-zero.
fn version_line(at: &Path, deadline: Duration) -> Option<String> {
    let mut child = std::process::Command::new(at)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let until = Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < until => std::thread::sleep(VERSION_POLL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    let streams = [String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)];
    let said = streams.iter().flat_map(|stream| stream.lines()).map(str::trim).find(|line| !line.is_empty())?;
    Some(said.chars().take(VERSION_LINE_MAX).collect())
}

/// Where this computer keeps the logins every workspace on it shares, as the runtime spells it and nothing here
/// does. Nothing on a computer whose runtime boots no workspace at all, which is every computer that is not Linux.
#[cfg(target_os = "linux")]
fn logins_dir(runtime_root: &Path) -> Option<PathBuf> {
    Some(wsp_runtime::bundle::Layout::new(runtime_root).logins())
}

#[cfg(not(target_os = "linux"))]
fn logins_dir(_runtime_root: &Path) -> Option<PathBuf> {
    None
}

/// The files under that directory: what a sign-in here wrote and every workspace on this computer shares.
pub(crate) fn logins_present(runtime_root: &Path) -> Vec<String> {
    logins_dir(runtime_root).map(|dir| names_under(&dir)).unwrap_or_default()
}

/// Every file under a directory, one level of directories deep, each named under it. Which tool a name belongs to
/// is the host's to say, since this daemon carries no catalog; what does not fit the wire's bounds is left out
/// rather than sent and refused with the whole report.
fn names_under(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let Ok(inner) = std::fs::read_dir(entry.path()) else { continue };
            for file in inner.flatten() {
                if file.file_type().map(|k| !k.is_dir()).unwrap_or(false) {
                    out.push(format!("{name}/{}", file.file_name().to_string_lossy()));
                }
            }
        } else {
            out.push(name);
        }
    }
    out.retain(|p| p.len() <= LOGIN_PATH_MAX && is_under_path(p));
    out.sort();
    out.truncate(LOGINS_MAX);
    out
}

/// How much room is left on the volume the folder sits on, or nothing when this computer will not say.
fn disk_free(folder: &Path) -> Option<u64> {
    let fs = nix::sys::statfs::statfs(folder).ok()?;
    Some(fs.blocks_available() * u64::try_from(fs.block_size()).ok()?)
}

/// node's os.arch() words for the machines wsp runs on; anything else travels as Rust names it.
fn arch_word() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        other => other,
    }
    .to_owned()
}

#[cfg(target_os = "linux")]
fn total_memory_bytes() -> u64 {
    nix::sys::sysinfo::sysinfo().map(|s| s.ram_total()).unwrap_or(0)
}

#[cfg(not(target_os = "linux"))]
fn total_memory_bytes() -> u64 {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .unwrap_or(0)
}

fn os_line() -> String {
    match nix::sys::utsname::uname() {
        Ok(u) => format!("{} {}", u.sysname().to_string_lossy(), u.release().to_string_lossy()),
        Err(_) => std::env::consts::OS.to_owned(),
    }
}

fn user_name() -> String {
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|u| u.name)
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default()
}

/// What this report is built from: the file, the home, the words the daemon was started with.
pub(crate) struct ReportInput<'a> {
    pub(crate) file: &'a PlaceFile,
    pub(crate) home: &'a Path,
    pub(crate) wsp_argv: &'a [String],
    pub(crate) agents: &'a [AgentBin],
    /// What each of those agents last answered its version flag with, read on the blocking pool before the report
    /// is built rather than here: building a report runs nothing.
    pub(crate) agent_versions: &'a BTreeMap<String, String>,
    pub(crate) daemon_port: u16,
    pub(crate) dialed: &'a str,
    /// The PATH this daemon's unit gave it, which the login row carries and the presence read looks along.
    pub(crate) unit_path: Option<&'a str>,
    /// Where this daemon keeps the workspaces it runs; the copy word is probed under it.
    pub(crate) runtime_root: &'a Path,
}

/// Why this computer runs no workspace, as the row carries it: its own reason first, the kernel's and the
/// login's, then where this daemon's root was put. A root inside one of the directories every workspace reads
/// through an overlay is refused by the open, so the row says so rather than reading ready and then refusing
/// every create. One reading, so the row and the open cannot part ways.
fn workspaces_blocked_by(its_own: Option<String>, runtime_root: &Path) -> Option<String> {
    its_own.or_else(|| wsp_runtime::doctor::root_under_a_lower(runtime_root))
}

/// What this computer says about itself on this link, in the shape the host parses.
pub(crate) fn place_report(input: &ReportInput<'_>) -> PlaceReport {
    let path = input.unit_path.unwrap_or_default().to_owned();
    let work = input.home.join("wsp-work");
    let free = disk_free(if work.exists() { &work } else { input.home });
    let wsp = if input.wsp_argv.is_empty() { vec!["wsp".to_owned()] } else { input.wsp_argv.to_vec() };
    let doctor = wsp_runtime::doctor::assess(&wsp_runtime::doctor::read_facts());
    let blocked = workspaces_blocked_by(doctor.blocked.clone(), input.runtime_root);
    let runs_workspaces = blocked.is_none();
    PlaceReport {
        name: input.file.name.clone(),
        platform: if cfg!(target_os = "macos") { Platform::Darwin } else { Platform::Linux },
        arch: arch_word(),
        os: os_line(),
        shape: WorkspaceSize {
            cpu: std::thread::available_parallelism().map_or(1.0, |n| n.get() as f64),
            mem_mb: (total_memory_bytes() as f64 / (1024.0 * 1024.0)).round() as u64,
        },
        disk_free_bytes: free,
        login: [
            ("HOME".to_owned(), input.home.to_string_lossy().into_owned()),
            ("USER".to_owned(), user_name()),
            ("PATH".to_owned(), path),
        ]
        .into_iter()
        .collect(),
        runs_workspaces,
        workspaces_blocked: blocked,
        engine: doctor.engine.word().to_owned(),
        // How a copy of a project is made here, probed on the disk under the runtime's own root, and only
        // where a workspace runs here at all: a computer that boots none has no copy to describe, and the probe
        // is not run for one.
        copies: runs_workspaces.then(|| wsp_runtime::copy::copies_word(input.runtime_root)),
        daemon_version: numbers::DAEMON_VERSION,
        daemon_port: std::num::NonZeroU16::new(input.daemon_port),
        wsp,
        dialed: input.dialed.to_owned(),
        // Read on the tools PATH before the unit's own, while the login above carries the unit's PATH as it
        // stands: what this daemon was started with is a fact about the unit, and where its agents are is not.
        agents: agents_on(input.agents, &presence_path(input.unit_path)),
        agent_versions: input.agent_versions.clone(),
        // Read at every dial, since a sign-in on this computer changes it between one link and the next.
        logins: Some(logins_present(input.runtime_root)),
    }
}

/// The ownership read as this computer runs it: the one script text the engine renders, through a plain sh. Handed
/// in rather than run from inside the sweep so a case can read the script that was run and when it was run.
pub(crate) fn sh_stdout(script: &str) -> String {
    sh_stdout_within(script, Duration::from_millis(u64::from(numbers::EXEC_TIMEOUT_DEFAULT_MS)))
}

/// By its own path: the script is POSIX sh, and a daemon under a service unit holds almost no PATH to find one on.
const SH: &str = "/bin/sh";

/// The same read under a bound, which every run of ours has: the script hashes a file per line of the list, and one
/// of those files on a mount that has stopped answering would otherwise hang the leave for as long as the mount
/// does, with the link's host waiting on a reply that never comes. Past the bound the process this started is
/// killed by the pid it was started with and the read answers nothing, which keeps every file of the person's.
fn sh_stdout_within(script: &str, within: Duration) -> String {
    let child = std::process::Command::new(SH)
        .arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(child) = child else { return String::new() };
    let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap_or(-1));
    let (said, wait) = std::sync::mpsc::channel();
    // stdout is read as it comes and not after the wait: a list long enough to fill the pipe would stop a child
    // that nothing is reading from, and a child that never exits is the one thing this bound is here for.
    let reading = std::thread::spawn(move || {
        let read = child.wait_with_output().map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
        let _ = said.send(read.unwrap_or_default());
    });
    let answer = wait.recv_timeout(within);
    if answer.is_err() && pid.as_raw() > 0 {
        let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
    }
    let _ = reading.join();
    answer.unwrap_or_default()
}

/// Takes wsp off this computer and answers what went: first every file wsp itself landed in the agents' homes here
/// whose bytes are still the ones wsp left, read by the one ownership script, then the paths the protocol names, in
/// its order. The read comes first because the list it reads sits in the provision folder that walk takes. A path
/// is there when it exists as a link or a file, since the browser name is a symlink whose target may already be
/// gone. A file the person has written since is on no line of that read and stays.
pub(crate) fn sweep_place_home(home: &Path, read: &dyn Fn(&str) -> String) -> Vec<String> {
    let mut removed = Vec::new();
    for rel in own_marks(&read(&landed_files_script(home))) {
        let path = home.join(&rel);
        match remove_under_home(home, Path::new(&rel)) {
            Removed::Gone => {
                removed.push(path.to_string_lossy().into_owned());
                if let Some(parent) = path.parent() {
                    prune_empty(home, parent);
                }
            }
            Removed::Linked => removed.push(words::place_kept_for_link(path.to_string_lossy())),
            Removed::Absent => {}
        }
    }
    for path in place_owned_paths(home) {
        let Ok(rel) = path.strip_prefix(home) else { continue };
        match remove_under_home(home, rel) {
            Removed::Gone => removed.push(path.to_string_lossy().into_owned()),
            Removed::Linked => removed.push(words::place_kept_for_link(path.to_string_lossy())),
            Removed::Absent => {}
        }
    }
    removed
}

/// Takes the workspace AppArmor profile a root install loaded off this computer: unloaded while its file is still
/// there, since the kernel holds a profile by name and a bare removal would leave it loaded for a binary that is
/// gone, then the file. Answers the path when it went; nothing when there was none to take.
pub(crate) fn sweep_workspace_profile(profile: &Path, read: &dyn Fn(&str) -> String) -> Option<String> {
    if !profile.is_file() {
        return None;
    }
    let quoted = format!("'{}'", profile.to_string_lossy().replace('\'', r"'\''"));
    read(&format!("command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R {quoted} 2>/dev/null; true"));
    std::fs::remove_file(profile).ok().map(|()| profile.to_string_lossy().into_owned())
}

/// What one removal under the home did, which is what the leave's lines say.
enum Removed {
    Gone,
    /// Nothing of that name is there, which is most of the list on most computers, or the path is one the walk
    /// does not take, a `..` or a leading `.` in it: either way nothing goes and nothing is said of it.
    Absent,
    /// A folder on the way to it is a link, or is no folder at all: nothing was removed and the path is named as
    /// one that stayed.
    Linked,
}

/// One path under the home, removed through the home's own descriptor: each folder on the way is opened with no
/// link followed, and the leaf is unlinked on the descriptor of the folder holding it. A workspace on a computer
/// somebody owns writes in that computer's home, so the shared `/root/.local/bin` can be a link it planted, and a
/// removal by name would follow it and take the box's own file of that name; here the walk stops instead.
fn remove_under_home(home: &Path, rel: &Path) -> Removed {
    let (parent, name) = match walk_under_home(home, rel) {
        Under::At(parent, name) => (parent, name),
        Under::Absent => return Removed::Absent,
        Under::Linked => return Removed::Linked,
    };
    let Ok(meta) = nix::sys::stat::fstatat(&parent, name.as_os_str(), nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW) else {
        return Removed::Absent;
    };
    let directory = nix::sys::stat::SFlag::from_bits_truncate(meta.st_mode).contains(nix::sys::stat::SFlag::S_IFDIR);
    let flag = if directory { nix::unistd::UnlinkatFlags::RemoveDir } else { nix::unistd::UnlinkatFlags::NoRemoveDir };
    match nix::unistd::unlinkat(&parent, name.as_os_str(), flag) {
        Ok(()) => Removed::Gone,
        // A folder with something in it is the one removal the standard library does by path alone, and it runs
        // only after the walk above stood: every folder on the way to it is a folder of this computer's own.
        Err(_) if directory => {
            if std::fs::remove_dir_all(home.join(rel)).is_ok() {
                Removed::Gone
            } else {
                Removed::Absent
            }
        }
        Err(_) => Removed::Absent,
    }
}

/// Where a path under the home is, opened one folder at a time.
enum Under {
    /// The folder holding it, and its name inside that folder.
    At(std::os::fd::OwnedFd, std::ffi::OsString),
    /// Nothing of that name is there, which is most of the list on most computers, or the path is not one this
    /// walk takes at all: either way nothing goes and nothing is said of it.
    Absent,
    /// A folder on the way to it is a link, or is no folder at all: nothing was removed and the path is named as
    /// one that stayed.
    Linked,
}

/// The walk itself: the home is opened as it stands, since it is what the daemon was pointed at, and every folder
/// under it with O_NOFOLLOW, so a link left where a folder was ends the walk rather than pointing what follows at
/// whatever it names. A path that is not plainly under the home, one naming `..` or opening with `.` among them,
/// is no path of wsp's and reads as absent rather than as one a link kept: the sentence for a path left standing
/// names a link, and such a path holds none.
fn walk_under_home(home: &Path, rel: &Path) -> Under {
    use std::path::Component;
    let mut parts = Vec::new();
    for part in rel.components() {
        match part {
            Component::Normal(name) => parts.push(name),
            _ => return Under::Absent,
        }
    }
    let Some((leaf, folders)) = parts.split_last() else { return Under::Absent };
    let flags = nix::fcntl::OFlag::O_DIRECTORY | nix::fcntl::OFlag::O_CLOEXEC;
    let Ok(mut at) = nix::fcntl::open(home, flags, nix::sys::stat::Mode::empty()) else { return Under::Absent };
    for folder in folders {
        at = match nix::fcntl::openat(&at, *folder, flags | nix::fcntl::OFlag::O_NOFOLLOW, nix::sys::stat::Mode::empty()) {
            Ok(next) => next,
            Err(nix::errno::Errno::ENOENT) => return Under::Absent,
            Err(_) => return Under::Linked,
        };
    }
    Under::At(at, leaf.to_os_string())
}

/// The folders wsp's own files left empty, taken from the file's own upwards, each through the same walk and
/// removed on its parent's descriptor. Never the first folder under the home: ~/.claude-cfg and ~/.codex are the
/// agents' own to make and to keep, whatever wsp put inside them.
fn prune_empty(home: &Path, from: &Path) {
    let mut at = from;
    while at != home && at.starts_with(home) && at.parent() != Some(home) {
        let Ok(rel) = at.strip_prefix(home) else { return };
        let Under::At(parent, name) = walk_under_home(home, rel) else { return };
        if nix::unistd::unlinkat(&parent, name.as_os_str(), nix::unistd::UnlinkatFlags::RemoveDir).is_err() {
            return;
        }
        match at.parent() {
            Some(parent) => at = parent,
            None => return,
        }
    }
}

/// Where the parts of an update are appended while they arrive: under the place's own put folder, named after the
/// upload, so nothing half landed ever sits where the binary the unit starts does.
pub(crate) fn update_part(home: &Path, upload_id: &str) -> PathBuf {
    place_daemon_paths(home).put_dir.join(upload_id)
}

/// Where the seq this upload expects next is written, beside its bytes. Two files rather than one: the bytes are
/// appended to and their length says nothing about how many parts made them, since a part is whatever the host cut.
fn update_next(part: &Path) -> PathBuf {
    part.with_extension("next")
}

/// Everything under the put folder except the upload named, removed. A link that drops mid-upload leaves its parts
/// there and the host picks a fresh id for its next try, so without this the box keeps every abandoned attempt.
/// Run when the agent starts and again when an upload begins, which are the two moments nothing else is arriving.
pub(crate) fn sweep_updates(home: &Path, keep: Option<&str>) -> usize {
    let dir = place_daemon_paths(home).put_dir;
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let mut swept = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
        if keep.is_some() && stem.as_deref() == keep {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            swept += 1;
        }
    }
    swept
}

/// One part appended under the seq this upload is waiting for: 0 for an upload nothing has been landed for, and the
/// one after the last part taken from then on. A part that is not it, a repeat or a skip alike, drops the upload
/// rather than letting it become a file with a hole in it or the same bytes twice.
pub(crate) fn take_update_part(part: &Path, seq: u64, bytes: &[u8], upload_id: &str) -> Result<(), String> {
    let dropped = |part: &Path| {
        let _ = std::fs::remove_file(part);
        let _ = std::fs::remove_file(update_next(part));
    };
    let next = std::fs::read_to_string(update_next(part)).ok().and_then(|text| text.trim().parse::<u64>().ok());
    let wanted = match (next, std::fs::metadata(part).is_ok()) {
        // Nothing landed and nothing recorded: this upload starts here.
        (None, false) => 0,
        (Some(wanted), true) => wanted,
        // Bytes with no record beside them, or a record with no bytes: neither is an upload this can go on with.
        _ => {
            dropped(part);
            return Err(words::update_out_of_order(seq, 0, upload_id));
        }
    };
    if seq != wanted {
        dropped(part);
        return Err(words::update_out_of_order(seq, wanted, upload_id));
    }
    if let Some(parent) = part.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new().append(true).create(true).open(part).map_err(|e| format!("{}: {e}", part.display()))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| format!("{}: {e}", part.display()))?;
    std::fs::write(update_next(part), format!("{}", seq + 1)).map_err(|e| format!("{}: {e}", update_next(part).display()))
}

/// Lowercase hex sha256 of some bytes, as the host spells the one it names on the frame.
fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The file this daemon was execed from, which is the file its unit starts. Linux answers /proc/self/exe with the
/// path and " (deleted)" after it once the inode the process runs has been unlinked, which is what a rename over
/// that path leaves behind: an update that landed and whose daemon has not restarted yet reads its own path that
/// way, and writing to it would make a second file nothing starts.
pub(crate) fn running_daemon(said: std::io::Result<PathBuf>) -> Result<PathBuf, String> {
    let exe = said.map_err(|e| format!("this daemon cannot say which file it runs from: {e}"))?;
    let text = exe.to_string_lossy();
    Ok(match text.strip_suffix(" (deleted)") {
        Some(path) => PathBuf::from(path),
        None => exe,
    })
}

/// The landed binary moved over the one this process runs from, and where the one it replaced was kept. The bytes
/// are checked against the host's sha256 first and the whole of the move is a rename beside the binary, which is
/// the one write a running executable takes: writing into it is refused while it is mapped, and a copy that failed
/// halfway would leave the unit starting a truncated file forever under Restart=always.
pub(crate) fn install_daemon(exe: &Path, part: &Path, sha256: &str, upload_id: &str) -> Result<(String, String), String> {
    let landed = std::fs::read(part).map_err(|e| format!("{}: {e}", part.display()))?;
    let held = sha256_hex(&landed);
    if held != sha256 {
        let _ = std::fs::remove_file(part);
        let _ = std::fs::remove_file(update_next(part));
        return Err(words::update_bytes_differ(upload_id, sha256, &held));
    }
    let fresh = exe.with_extension("new");
    let kept = exe.with_extension("old");
    std::fs::write(&fresh, &landed).map_err(|e| format!("{}: {e}", fresh.display()))?;
    std::fs::set_permissions(&fresh, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", fresh.display()))?;
    // The old binary kept beside the new one, so a box whose daemon will not come up still holds the one it ran.
    std::fs::copy(exe, &kept).map_err(|e| format!("{}: {e}", kept.display()))?;
    std::fs::rename(&fresh, exe).map_err(|e| format!("{}: {e}", exe.display()))?;
    let _ = std::fs::remove_file(part);
    let _ = std::fs::remove_file(update_next(part));
    Ok((exe.to_string_lossy().into_owned(), kept.to_string_lossy().into_owned()))
}

/// The home the place keeps its files under: --home, else HOME, else the root.
pub(crate) fn place_home(given: Option<&Path>) -> PathBuf {
    given.map(Path::to_path_buf).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use wsp_frames::{place_link_transcript, place_refusal_transcript, LinkEphemerals, LinkRole};

    fn pair() -> (String, PlacePublicKey) {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let key = SigningKey::from_bytes(&seed);
        let der = key.verifying_key().to_public_key_der().unwrap();
        let public = Base64Bytes::parse(&base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der.as_bytes())).unwrap();
        (key.to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF).unwrap().to_string(), public)
    }

    #[test]
    fn a_signature_verifies_under_its_own_key_and_no_other_over_no_other_bytes() {
        let (pem, public) = pair();
        let (_, other) = pair();
        let pair_of = LinkEphemerals { challenger: "CCC=", answerer: "DDD=" };
        let bytes = place_link_transcript(LinkRole::Place, "p_1", "AAA=", "BBB=", pair_of);
        let sig = sign_place_bytes(&pem, &bytes).unwrap();
        assert!(verify_place_bytes(&public, &bytes, &sig));
        assert!(!verify_place_bytes(&other, &bytes, &sig));
        assert!(!verify_place_bytes(&public, &place_link_transcript(LinkRole::Host, "p_1", "AAA=", "BBB=", pair_of), &sig));
        // The ephemerals are inside the bytes, so a carrier that swapped one has a signature over nothing.
        let swapped = LinkEphemerals { challenger: "CCC=", answerer: "EEE=" };
        assert!(!verify_place_bytes(&public, &place_link_transcript(LinkRole::Place, "p_1", "AAA=", "BBB=", swapped), &sig));
        assert!(sign_place_bytes("not a key", &bytes).is_err());
    }

    #[test]
    fn signing_matches_the_node_side_byte_for_byte() {
        let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/place-link-signing.json")).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
        let s = |k: &str| fixture[k].as_str().unwrap().to_owned();
        let b64 = |k: &str| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s(k)).unwrap();
        let (place_ephemeral, host_ephemeral) = (s("placeEphemeral"), s("hostEphemeral"));
        let host_bytes = place_link_transcript(
            LinkRole::Host,
            &s("placeId"),
            &s("placeNonce"),
            &s("hostNonce"),
            LinkEphemerals { challenger: &place_ephemeral, answerer: &host_ephemeral },
        );
        let place_bytes = place_link_transcript(
            LinkRole::Place,
            &s("placeId"),
            &s("hostNonce"),
            &s("placeNonce"),
            LinkEphemerals { challenger: &host_ephemeral, answerer: &place_ephemeral },
        );
        assert_eq!(host_bytes, b64("hostTranscript"));
        assert_eq!(place_bytes, b64("placeTranscript"));
        let public = Base64Bytes::parse(&s("publicKey")).unwrap();
        assert_eq!(sign_place_bytes(&s("privateKeyPem"), &host_bytes).unwrap().as_str(), s("hostSignature"));
        assert_eq!(sign_place_bytes(&s("privateKeyPem"), &place_bytes).unwrap().as_str(), s("placeSignature"));
        assert!(verify_place_bytes(&public, &place_bytes, &Base64Bytes::parse(&s("placeSignature")).unwrap()));

        // The refusal a host gives before it has proved anything, which this side verifies rather than signs.
        let refusal = place_refusal_transcript(&s("placeId"), &s("placeNonce"), &s("refusalSentence"));
        assert_eq!(refusal, b64("refusalTranscript"));
        let signature = Base64Bytes::parse(&s("refusalSignature")).unwrap();
        assert!(verify_place_bytes(&public, &refusal, &signature));
        // The nonce is in the bytes, so one dial's refusal proves nothing at the next.
        assert!(!verify_place_bytes(&public, &place_refusal_transcript(&s("placeId"), &s("hostNonce"), &s("refusalSentence")), &signature));
    }

    #[test]
    fn agents_are_id_command_pairs_and_only_those_on_path_are_reported() {
        assert_eq!(
            parse_agents(&["a1=sh".to_owned(), "broken".to_owned(), "=x".to_owned(), "b2=no-such-agent-command".to_owned()]).len(),
            2
        );
        assert_eq!(found_at("sh", "/nonexistent:/bin:/usr/bin"), Some(PathBuf::from("/bin/sh")));
        assert_eq!(found_at("no-such-agent-command", "/bin:/usr/bin"), None);
        assert_eq!(found_at("sh", ""), None);
    }

    /// A place's daemon runs unattended under a service unit: a word that is not a pair costs the report one agent
    /// row, and refusing the flag would cost the person the whole computer until somebody edits its unit.
    #[test]
    fn a_word_that_is_not_an_id_command_pair_is_dropped_and_the_rest_of_the_list_stands() {
        let read =
            parse_agents(&["a1=sh".to_owned(), "broken".to_owned(), "=no-id".to_owned(), "no-command=".to_owned(), "b2=bash".to_owned()]);
        assert_eq!(
            read,
            vec![AgentBin { id: "a1".to_owned(), bin: "sh".to_owned() }, AgentBin { id: "b2".to_owned(), bin: "bash".to_owned() }]
        );
        // The command may carry an = of its own; only the first one splits the word.
        assert_eq!(
            parse_agents(&["a1=sh -c echo a=b".to_owned()]),
            vec![AgentBin { id: "a1".to_owned(), bin: "sh -c echo a=b".to_owned() }]
        );
    }

    /// A binary that prints a line and records that it ran, so a second read can be told from a held one.
    fn fake_bin(dir: &Path, name: &str, prints: &str, counter: &Path) -> PathBuf {
        let at = dir.join(name);
        std::fs::write(&at, format!("#!/bin/sh\necho ran >> {}\necho '{prints}'\n", counter.display())).unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        at
    }

    fn ran(counter: &Path) -> usize {
        std::fs::read_to_string(counter).map(|t| t.lines().count()).unwrap_or(0)
    }

    #[test]
    fn an_agents_version_is_read_once_and_again_only_when_its_binary_moved() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("runs");
        let bin = fake_bin(dir.path(), "claude", "2.1.270 (Claude Code)", &counter);
        let path = dir.path().to_string_lossy().into_owned();
        let agents = parse_agents(&["claude=claude".to_owned()]);
        let mut held = AgentVersions::default();

        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.270 (Claude Code)"));
        assert_eq!(ran(&counter), 1);

        // Nothing moved, so the dial costs one stat and the line already read stands.
        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert_eq!(ran(&counter), 1, "a dial where nothing moved ran the binary again");
        assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.270 (Claude Code)"));

        // An update that replaces the binary is what the report has to follow, and the daemon is not restarted by
        // one: the file's own size and modification time are what says it happened.
        fake_bin(dir.path(), "claude", "2.1.280 (Claude Code) and then some", &counter);
        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert_eq!(ran(&counter), 2);
        assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.280 (Claude Code) and then some"));

        // The same bytes at another modification time are read again too: a build dropped in by hand says nothing
        // about its size.
        let file = std::fs::File::options().write(true).open(&bin).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000))).unwrap();
        drop(file);
        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert_eq!(ran(&counter), 3);

        // An agent off the PATH drops off the report rather than keeping the version of a binary that is gone.
        std::fs::remove_file(&bin).unwrap();
        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert!(held.lines().is_empty());
    }

    /// The agents are looked for where the recipe puts the tools, not where this daemon's unit looks: a place
    /// daemon runs under a service unit whose PATH is the distribution's default, and an agent installed by
    /// Homebrew or by its own installer under /root/.local/bin is on no line of it.
    #[test]
    fn the_agents_are_read_on_the_tools_path_before_the_units_own() {
        let tools = tempfile::tempdir().unwrap();
        let counter = tools.path().join("runs");
        fake_bin(tools.path(), "claude", "2.1.270 (Claude Code)", &counter);
        let agents = parse_agents(&["claude=claude".to_owned()]);
        // The unit's PATH on its own, which is the hole: the agent is on no report at all.
        assert!(agents_on(&agents, "/nonexistent").is_empty());

        // The list the presence read takes: the agent stands on the row.
        let path = presence_path_over(&tools.path().to_string_lossy(), "/nonexistent");
        assert_eq!(agents_on(&agents, &path), vec!["claude".to_owned()]);

        // The tools first: a command on both lists is read from where a thread inside a workspace would run it.
        let unit = tempfile::tempdir().unwrap();
        fake_bin(unit.path(), "claude", "0.0.1 (the unit's own)", &counter);
        let both = presence_path_over(&tools.path().to_string_lossy(), &unit.path().to_string_lossy());
        assert_eq!(found_at("claude", &both), Some(tools.path().join("claude")));

        // And what this daemon hands that read is that one list over the PATH its unit gave it, in that order.
        let live = presence_path(Some("/nonexistent"));
        assert!(live.starts_with(numbers::TOOLS_PATH), "{live}");
        assert!(live.ends_with("/nonexistent"), "{live}");
        assert_eq!(presence_path(None), numbers::TOOLS_PATH);
        assert_eq!(presence_path(Some("")), numbers::TOOLS_PATH);
    }

    /// The one rule this daemon holds to on a computer that runs workspaces: a command it runs is never resolved
    /// through a directory under the home those workspaces write. A binary planted there still stands on the row,
    /// since reading that a file is there runs nothing, and the version beside it comes from the copy outside.
    #[test]
    fn a_binary_planted_under_the_home_stands_on_the_row_and_is_never_run() {
        let home = tempfile::tempdir().unwrap();
        let planted_dir = home.path().join(".local/bin");
        std::fs::create_dir_all(&planted_dir).unwrap();
        let planted_ran = home.path().join("planted-ran");
        fake_bin(&planted_dir, "claude", "9.9.9 (planted)", &planted_ran);
        let system = tempfile::tempdir().unwrap();
        let system_ran = system.path().join("runs");
        fake_bin(system.path(), "claude", "2.1.270 (Claude Code)", &system_ran);
        let agents = parse_agents(&["claude=claude".to_owned()]);
        // The tools list as it reads on a box: the home's own directory first, the system's behind it.
        let tools = format!("{}:{}", planted_dir.display(), system.path().display());
        assert_eq!(agents_on(&agents, &presence_path_over(&tools, "")), vec!["claude".to_owned()]);
        // The probe list is that list with every directory under the home taken out, which for this home leaves
        // the system's alone; the rule that builds it from the tools PATH is held to the protocol's by the
        // contract fixture, and what is read here is what the version read does with it.
        let probe = system.path().to_string_lossy().into_owned();
        let mut held = AgentVersions::default();
        held.refresh(&agents, &probe, VERSION_DEADLINE);
        assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.270 (Claude Code)"));
        assert!(!planted_ran.exists(), "the binary under the home was run");
        assert!(system_ran.exists());
    }

    #[test]
    fn a_version_read_that_hangs_costs_its_deadline_and_says_nothing_for_that_agent() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("codex");
        std::fs::write(&at, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let mut held = AgentVersions::default();
        let began = Instant::now();
        held.refresh(&parse_agents(&["codex=codex".to_owned()]), &dir.path().to_string_lossy(), Duration::from_millis(300));
        assert!(held.lines().is_empty());
        assert!(began.elapsed() < Duration::from_secs(5), "the read waited past its deadline");
        // A line cut at the wire's bound, so a binary that prints a paragraph cannot refuse the whole report.
        let counter = dir.path().join("runs");
        fake_bin(dir.path(), "long", &"v".repeat(200), &counter);
        held.refresh(&parse_agents(&["long=long".to_owned()]), &dir.path().to_string_lossy(), VERSION_DEADLINE);
        assert_eq!(held.lines()["long"].len(), VERSION_LINE_MAX);
    }

    /// A tool that says its version on stderr is read like any other. Reading stdout alone would leave it with no
    /// line at all, so every dial would run it again: a process per dial where the whole point is one stat.
    #[test]
    fn a_version_printed_on_stderr_is_read_once_like_any_other() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("runs");
        let at = dir.path().join("noisy");
        std::fs::write(&at, format!("#!/bin/sh\necho ran >> {}\necho '' \necho 'noisy 4.5.6' 1>&2\n", counter.display())).unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let agents = parse_agents(&["noisy=noisy".to_owned()]);
        let path = dir.path().to_string_lossy().into_owned();
        let mut held = AgentVersions::default();
        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert_eq!(held.lines().get("noisy").map(String::as_str), Some("noisy 4.5.6"));
        assert_eq!(ran(&counter), 1);
        held.refresh(&agents, &path, VERSION_DEADLINE);
        assert_eq!(ran(&counter), 1, "a version read off stderr was read again at the next dial");

        // What a tool printed on stdout is still what the report carries, whatever it put on stderr beside it.
        let both = dir.path().join("both");
        std::fs::write(&both, "#!/bin/sh\necho 'warning: old config' 1>&2\necho 'both 1.2.3'\n").unwrap();
        std::fs::set_permissions(&both, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        held.refresh(&parse_agents(&["both=both".to_owned()]), &path, VERSION_DEADLINE);
        assert_eq!(held.lines().get("both").map(String::as_str), Some("both 1.2.3"));
    }

    #[test]
    fn the_logins_folder_is_read_as_the_names_under_it_and_nothing_else() {
        let logins = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(logins.path().join("codex")).unwrap();
        // A tool whose sign-in made its folder and wrote nothing yet is not a login that stands.
        std::fs::create_dir_all(logins.path().join("gemini")).unwrap();
        std::fs::write(logins.path().join("codex/auth.json"), "{}").unwrap();
        assert_eq!(names_under(logins.path()), vec!["codex/auth.json".to_owned()]);
        // A computer with no logins folder at all says none, which is what a box before its first sign-in is.
        assert!(names_under(&logins.path().join("nowhere")).is_empty());
        assert!(logins_present(&logins.path().join("nowhere")).is_empty());
    }

    #[test]
    fn the_report_is_read_off_the_home_and_the_words_given() {
        let home = tempfile::tempdir().unwrap();
        let file =
            PlaceFile::parse(r#"{"placeId":"p","name":"old-macbook","hostName":"h","hostUrls":[],"hostPublicKey":"k","keyPath":"/k"}"#)
                .unwrap();
        let agents = parse_agents(&["a1=sh".to_owned(), "b2=no-such-agent-command".to_owned()]);
        let argv = ["/usr/local/bin/node".to_owned(), "/opt/wsp/bin.js".to_owned()];
        let versions: BTreeMap<String, String> = [("a1".to_owned(), "1.2.3".to_owned())].into_iter().collect();
        let report = place_report(&ReportInput {
            file: &file,
            home: home.path(),
            wsp_argv: &argv,
            agents: &agents,
            agent_versions: &versions,
            daemon_port: 4321,
            dialed: "http://h:1",
            unit_path: Some("/units/own/bin:/usr/bin"),
            runtime_root: &home.path().join("runtime"),
        });
        assert_eq!(report.name, "old-macbook");
        assert_eq!(report.wsp, argv);
        assert_eq!(report.agents, vec!["a1"]);
        // The versions read before the report was built, and the logins folder read as this dial found it: a
        // report from this daemon always carries the list, empty or not, which is what tells it from an older one.
        assert_eq!(report.agent_versions, versions);
        assert_eq!(report.logins, Some(logins_present(&home.path().join("runtime"))));
        assert_eq!(report.login["HOME"], home.path().to_string_lossy());
        // The PATH the row carries is the one this daemon's unit gave it, read at start before the probe list
        // took its place: what the person's login shell gives is a fact about that computer, and the list this
        // daemon runs a command through is not.
        assert_eq!(report.login["PATH"], "/units/own/bin:/usr/bin");
        assert_eq!(report.daemon_port.map(|p| p.get()), Some(4321));
        assert_eq!(report.dialed, "http://h:1");
        assert!(report.shape.cpu > 0.0 && report.shape.mem_mb > 0);
        assert!(report.disk_free_bytes.is_some());
        assert_eq!(report.daemon_version, numbers::DAEMON_VERSION);
        // runs_workspaces and engine are the doctor's reading of this box; on this Linux test box it runs them.
        assert_eq!(report.engine, wsp_runtime::doctor::engine_on_path(&std::env::var("PATH").unwrap_or_default()).word());
        // The copy word rides with runs_workspaces: a box that boots workspaces says how it copies a project,
        // and a computer that boots none says nothing rather than a word nothing would use.
        assert_eq!(report.copies.is_some(), report.runs_workspaces);
        let bare = place_report(&ReportInput {
            file: &file,
            home: home.path(),
            wsp_argv: &[],
            agents: &[],
            agent_versions: &BTreeMap::new(),
            daemon_port: 1,
            dialed: "http://h:1",
            unit_path: None,
            runtime_root: home.path(),
        });
        assert_eq!(bare.wsp, vec!["wsp"]);
        // And the root the daemon was given is part of that reading: under one of the directories every
        // workspace overlays, the open refuses it, so the row says why and carries no copy word rather than
        // reading ready and refusing every create.
        let under = std::path::Path::new("/var/lib/wsp-under-a-lower");
        let bad = place_report(&ReportInput {
            file: &file,
            home: home.path(),
            wsp_argv: &[],
            agents: &[],
            agent_versions: &BTreeMap::new(),
            daemon_port: 1,
            dialed: "http://h:1",
            unit_path: None,
            runtime_root: under,
        });
        assert!(!bad.runs_workspaces);
        assert_eq!(bad.copies, None);
        // Which reason the row carries is one reading, held here on every computer this builds for: the
        // computer's own first, where it has one, and the root's where it has none.
        let its_own = "wsp runs workspaces on a Linux computer, and this computer is not one".to_owned();
        assert_eq!(workspaces_blocked_by(Some(its_own.clone()), under), Some(its_own));
        assert_eq!(workspaces_blocked_by(None, under), wsp_runtime::doctor::root_under_a_lower(under));
        assert!(workspaces_blocked_by(None, under).is_some_and(|said| said.contains("/var")));
        assert_eq!(workspaces_blocked_by(None, std::path::Path::new(wsp_runtime::DEFAULT_ROOT)), None);
        // And the row's own reason is whichever of the two this computer gave, never a word written here.
        let first = wsp_runtime::doctor::assess(&wsp_runtime::doctor::read_facts()).blocked;
        assert_eq!(bad.workspaces_blocked, workspaces_blocked_by(first, under));
        // The shape the host parses is the shape this serialises to.
        serde_json::from_value::<PlaceReport>(serde_json::to_value(&report).unwrap()).unwrap();
    }

    #[test]
    fn an_update_takes_only_the_part_it_waits_for_and_moves_the_whole_over_the_running_binary() {
        let home = tempfile::tempdir().unwrap();
        let part = update_part(home.path(), "u1");
        assert_eq!(part, place_daemon_paths(home.path()).put_dir.join("u1"));

        // An upload waits for part 0 first, so a skip to any other part is refused and lands nothing.
        assert_eq!(take_update_part(&part, 1, b"x", "u1").unwrap_err(), words::update_out_of_order(1, 0, "u1"));
        assert!(!part.exists());
        take_update_part(&part, 0, b"new ", "u1").unwrap();

        // From then on it waits for the one after the last it took: a repeat of the part already landed is refused
        // rather than appended twice, and a skip over the one it wants is refused rather than leaving a hole.
        assert_eq!(take_update_part(&part, 0, b"x", "u1").unwrap_err(), words::update_out_of_order(0, 1, "u1"));
        assert!(!part.exists(), "a refused part left the upload on disk");
        take_update_part(&part, 0, b"new ", "u1").unwrap();
        assert_eq!(take_update_part(&part, 2, b"x", "u1").unwrap_err(), words::update_out_of_order(2, 1, "u1"));
        take_update_part(&part, 0, b"new ", "u1").unwrap();
        take_update_part(&part, 1, b"daemon", "u1").unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"new daemon");

        let exe = home.path().join("wsp-daemon");
        std::fs::write(&exe, b"old daemon").unwrap();
        let wrong = "0".repeat(64);
        let refused = install_daemon(&exe, &part, &wrong, "u1").unwrap_err();
        assert_eq!(refused, words::update_bytes_differ("u1", &wrong, &sha256_hex(b"new daemon")));
        assert_eq!(std::fs::read(&exe).unwrap(), b"old daemon", "a binary whose bytes differ was moved anyway");
        assert!(!part.exists(), "the dropped upload stays on disk");

        take_update_part(&part, 0, b"new daemon", "u1").unwrap();
        let (at, kept) = install_daemon(&exe, &part, &sha256_hex(b"new daemon"), "u1").unwrap();
        assert_eq!(at, exe.to_string_lossy());
        assert_eq!(kept, exe.with_extension("old").to_string_lossy());
        assert_eq!(std::fs::read(&exe).unwrap(), b"new daemon");
        assert_eq!(std::fs::read(exe.with_extension("old")).unwrap(), b"old daemon");
        assert!(!exe.with_extension("new").exists(), "the staged copy stays beside the binary");
        // Both the bytes and the seq beside them go with the landing, so the next upload starts from nothing.
        assert!(!part.exists() && !update_next(&part).exists());
        let mode: u32 = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&exe).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn the_parts_a_dropped_link_left_go_when_the_agent_starts_and_when_the_next_upload_begins() {
        let home = tempfile::tempdir().unwrap();
        let abandoned = update_part(home.path(), "aa11");
        take_update_part(&abandoned, 0, b"half a daemon", "aa11").unwrap();
        assert!(abandoned.exists() && update_next(&abandoned).exists());

        // The host picks a fresh id for its next try, so nothing will ever name that one again.
        let fresh = update_part(home.path(), "bb22");
        take_update_part(&fresh, 0, b"a whole one", "bb22").unwrap();
        assert_eq!(sweep_updates(home.path(), Some("bb22")), 2, "the abandoned upload and the seq beside it");
        assert!(!abandoned.exists() && !update_next(&abandoned).exists());
        assert!(fresh.exists(), "the upload arriving now went with them");

        // At the agent's start nothing is arriving, so the lot goes.
        assert_eq!(sweep_updates(home.path(), None), 2);
        assert!(!fresh.exists());
        // A place whose folder is not there at all is not an error.
        assert_eq!(sweep_updates(&home.path().join("nowhere"), None), 0);
    }

    #[test]
    fn the_binary_this_daemon_runs_is_its_own_path_with_the_kernels_deleted_mark_taken_off() {
        assert_eq!(running_daemon(Ok(PathBuf::from("/h/.wsp/daemon/wsp-daemon"))).unwrap(), PathBuf::from("/h/.wsp/daemon/wsp-daemon"));
        // What /proc/self/exe reads once an update has renamed a new binary over the running one's path.
        assert_eq!(
            running_daemon(Ok(PathBuf::from("/h/.wsp/daemon/wsp-daemon (deleted)"))).unwrap(),
            PathBuf::from("/h/.wsp/daemon/wsp-daemon")
        );
        assert!(running_daemon(Err(std::io::Error::other("no /proc"))).unwrap_err().contains("which file it runs from"));
    }

    /// The bytes of the three files the committed ledger names, in its order: what the run that landed them put
    /// there, so the read that hashes a file against the ledger's third column answers for the first two.
    const LANDED_BYTES: [&str; 3] = ["the skill wsp landed\n", "{\"wsp\":true}\n", "wsp = true\n"];

    /// The ledger both sides' cases build a fake home from, as rows of (home-relative path, the bytes wsp left).
    fn ledger_rows() -> Vec<(String, String)> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contract/landed.tsv");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let rows: Vec<(String, String)> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .zip(LANDED_BYTES)
            .map(|(line, bytes)| {
                let fields: Vec<&str> = line.split('\t').collect();
                let standing = fields[2];
                let held: String = Sha256::digest(bytes.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(standing, held, "landed.tsv names bytes for {} that this case does not write", fields[0]);
                (fields[0].to_owned(), bytes.to_owned())
            })
            .collect();
        assert_eq!(rows.len(), LANDED_BYTES.len(), "landed.tsv holds a line per set of bytes here");
        rows
    }

    /// A home with the ledger and what it names: the first two files as wsp left them, the third rewritten by the
    /// person since, and one file of theirs no line names.
    fn home_with_landed_files() -> (tempfile::TempDir, Vec<(String, String)>) {
        let home = tempfile::tempdir().unwrap();
        let rows = ledger_rows();
        let at = place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.wsp).unwrap();
        let provision = wsp_frames::place_provision_paths(home.path());
        std::fs::create_dir_all(&provision.dir).unwrap();
        let tsv = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contract/landed.tsv");
        std::fs::copy(&tsv, &provision.landed).unwrap();
        for (index, (rel, bytes)) in rows.iter().enumerate() {
            let path = home.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, if index + 1 == rows.len() { "the person wrote this\n" } else { bytes }).unwrap();
        }
        std::fs::write(home.path().join(".claude/theirs.md"), "mine\n").unwrap();
        // A line the servers step wrote: a key in an agent's own file, no path under the home, and the digest of
        // the entry wsp left under that name. Nothing on the disk stands at it and nothing is taken for it.
        let mut ledger = std::fs::read_to_string(&provision.landed).unwrap();
        ledger.push_str("agents/mcp/claude/context7\tdeadbeef\tdeadbeef\n");
        std::fs::write(&provision.landed, ledger).unwrap();
        (home, rows)
    }

    /// sh with a sha256sum to find: BSD carries none on every release, and the script the leave runs is the
    /// engine's own, which hashes with it.
    fn with_sha256sum() -> (tempfile::TempDir, impl Fn(&str) -> String) {
        let bin = tempfile::tempdir().unwrap();
        let shim = bin.path().join("sha256sum");
        std::fs::write(&shim, "#!/bin/sh\nexec shasum -a 256 \"$@\"\n").unwrap();
        std::fs::set_permissions(&shim, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        // Last on the PATH, so a computer with the real one runs that and the shim is there for one that has none.
        let path = format!("{}:{}", std::env::var("PATH").unwrap_or_default(), bin.path().to_string_lossy());
        let read = move |script: &str| {
            let out = std::process::Command::new("/bin/sh").arg("-c").arg(script).env("PATH", &path).output().unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        (bin, read)
    }

    #[test]
    fn the_leave_takes_wsps_own_landed_files_and_keeps_the_one_the_person_changed() {
        let (home, rows) = home_with_landed_files();
        let (_bin, read) = with_sha256sum();
        let swept = sweep_place_home(home.path(), &read);
        let took = |rel: &str| swept.contains(&home.path().join(rel).to_string_lossy().into_owned());
        // The two whose bytes are still wsp's go and are named; the one the person rewrote is on no line of the
        // read, so it stays and the leave says nothing about it.
        for (rel, _) in rows.iter().take(2) {
            assert!(!home.path().join(rel).exists(), "{rel}");
            assert!(took(rel), "{swept:?}");
        }
        let (kept, _) = rows.last().unwrap();
        assert!(home.path().join(kept).exists(), "{kept}");
        assert!(!took(kept), "{swept:?}");
        // A folder wsp's own files left empty goes with them, up to but not into the folder the agent itself owns.
        assert!(!home.path().join(".claude/skills").exists());
        assert!(home.path().join(".claude").is_dir());
        assert!(home.path().join(".codex").is_dir());
        assert_eq!(std::fs::read_to_string(home.path().join(".claude/theirs.md")).unwrap(), "mine\n");
        // The list's server line named no path, so the leave took nothing for it and made nothing at its name.
        assert!(!home.path().join("agents").exists());
        assert!(!swept.iter().any(|took| took.contains("agents/mcp")), "{swept:?}");
        // And wsp's own folder is gone whole, the provision folder and the ledger inside it with it.
        assert!(!place_daemon_paths(home.path()).wsp.exists());
        assert!(swept.contains(&place_daemon_paths(home.path()).wsp.to_string_lossy().into_owned()));
    }

    #[test]
    fn the_ledger_is_read_before_the_folder_that_holds_it_goes() {
        let (home, rows) = home_with_landed_files();
        let ledger = wsp_frames::place_provision_paths(home.path()).landed;
        let (_bin, read) = with_sha256sum();
        // The one thing the order buys: at the moment the read runs, the list it reads is still there.
        let ledger_at_read = ledger.clone();
        let watched = move |script: &str| {
            assert!(ledger_at_read.exists(), "the ownership read ran after the folder holding the ledger had gone");
            read(script)
        };
        sweep_place_home(home.path(), &watched);
        assert!(!ledger.exists());
        assert!(!home.path().join(&rows[0].0).exists());
    }

    #[test]
    fn a_read_that_would_not_return_is_killed_at_its_bound_and_answers_nothing() {
        // What a file on a mount that has stopped answering does to the read that hashes it: the sweep waits for
        // the bound and no longer, and a leave over the link answers its host rather than hanging inside it.
        let started = std::time::Instant::now();
        let said = sh_stdout_within("printf 'wsp-own\t.claude/settings.json\n'; while :; do sleep 1; done", Duration::from_millis(300));
        assert_eq!(said, "", "a read that ran past its bound answered with what it had printed so far");
        assert!(started.elapsed() < Duration::from_secs(5), "the bound was not what ended the read: {:?}", started.elapsed());
        // A read that answers inside the bound is the whole of what it printed.
        assert_eq!(
            sh_stdout_within("printf 'wsp-own\t.claude/settings.json\n'", Duration::from_secs(5)),
            "wsp-own\t.claude/settings.json\n"
        );
        assert_eq!(sh_stdout_within("exit 7", Duration::from_secs(5)), "");
    }

    /// A workspace on a computer somebody owns writes in that computer's home, so a folder wsp's list names there
    /// can be a link it planted. The leave removes through the folders themselves, so a link where a folder was
    /// ends the walk: the file the link points at is the computer's own and is still there afterwards.
    #[test]
    fn a_link_where_a_folder_was_leaves_what_it_points_at_standing_and_is_said() {
        let home = tempfile::tempdir().unwrap();
        let at = place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.wsp).unwrap();
        // The box's own bin, with the two names the fixed list ends on, and the shared bin a workspace replaced
        // with a link to it.
        let theirs = tempfile::tempdir().unwrap();
        for name in ["wsp-open", "xdg-open"] {
            std::fs::write(theirs.path().join(name), "the computer's own\n").unwrap();
        }
        std::fs::create_dir_all(home.path().join(".local")).unwrap();
        std::os::unix::fs::symlink(theirs.path(), &at.bin_dir).unwrap();
        // And a row of the ledger whose folder is a link the same way, pointing at a file of the computer's own.
        let planted = tempfile::tempdir().unwrap();
        std::fs::write(planted.path().join("settings.json"), "the computer's own\n").unwrap();
        std::os::unix::fs::symlink(planted.path(), home.path().join(".claude")).unwrap();
        let read = |_: &str| format!("{}\t.claude/settings.json\n", wsp_frames::OWN_MARK);

        let swept = sweep_place_home(home.path(), &read);

        for name in ["wsp-open", "xdg-open"] {
            assert_eq!(std::fs::read_to_string(theirs.path().join(name)).unwrap(), "the computer's own\n", "{name}");
        }
        assert_eq!(std::fs::read_to_string(planted.path().join("settings.json")).unwrap(), "the computer's own\n");
        // The links themselves are the workspace's doing and are left alone; what the leave says is that it took
        // nothing at those three paths and why.
        for path in [at.bin_dir.join("wsp-open"), at.bin_dir.join("xdg-open"), home.path().join(".claude/settings.json")] {
            let said = words::place_kept_for_link(path.to_string_lossy());
            assert!(swept.contains(&said), "{swept:?} does not say {said}");
            assert!(!swept.contains(&path.to_string_lossy().into_owned()), "{swept:?} took a path through a link");
        }
        // Wsp's own folder is under no link and goes as it always did.
        assert!(!at.wsp.exists());
        assert!(swept.contains(&at.wsp.to_string_lossy().into_owned()));
    }

    /// A path this walk will not take is no path of wsp's, and the leave says nothing of it: the sentence for a
    /// path left standing names a link, and a path reaching out of the home holds none.
    #[test]
    fn a_path_that_is_not_plainly_under_the_home_is_absent_and_nothing_is_said_of_it() {
        let home = tempfile::tempdir().unwrap();
        // A folder beside the home, so the path below would answer with a real file of somebody's if the walk
        // took it: both sit under the same temporary folder.
        let beside = tempfile::tempdir().unwrap();
        std::fs::write(beside.path().join("keep"), "not wsp's\n").unwrap();
        let out = Path::new("..").join(beside.path().file_name().unwrap()).join("keep");

        assert!(matches!(remove_under_home(home.path(), &out), Removed::Absent));
        assert!(matches!(remove_under_home(home.path(), Path::new("./settings.json")), Removed::Absent));
        assert!(beside.path().join("keep").exists(), "a path out of the home was taken");
    }

    #[test]
    fn a_home_with_no_ledger_loses_nothing_of_the_persons() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".claude/skills/wsp")).unwrap();
        std::fs::write(home.path().join(".claude/skills/wsp/SKILL.md"), "theirs\n").unwrap();
        let (_bin, read) = with_sha256sum();
        assert!(sweep_place_home(home.path(), &read).is_empty());
        assert!(home.path().join(".claude/skills/wsp/SKILL.md").exists());
    }

    #[test]
    fn the_sweep_takes_what_is_there_in_the_protocols_order_and_leaves_the_work_folder() {
        let home = tempfile::tempdir().unwrap();
        let at = place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.wsp).unwrap();
        std::fs::create_dir_all(&at.bin_dir).unwrap();
        std::fs::write(&at.token_path, "t\n").unwrap();
        std::fs::write(&at.place_key, "k").unwrap();
        std::fs::write(&at.place_file, "{}").unwrap();
        std::fs::create_dir_all(at.dir.join("inner")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/wsp-open", at.bin_dir.join("xdg-open")).unwrap();
        let work = home.path().join("wsp-work");
        std::fs::create_dir_all(&work).unwrap();
        // A stray file under wsp's own folder that no row above names, as two boxes were found holding: the
        // folder goes whole, last, so a leave leaves no .wsp at all.
        std::fs::write(at.wsp.join("place.json.bak-747"), "old").unwrap();
        std::fs::create_dir_all(&at.put_dir).unwrap();
        std::fs::write(at.put_dir.join("797"), "half an update").unwrap();
        let swept = sweep_place_home(home.path(), &|_| String::new());
        let names: Vec<_> = [&at.place_file, &at.place_key, &at.dir, &at.token_path, &at.bin_dir.join("xdg-open"), &at.wsp]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(swept, names);
        assert!(!at.wsp.exists());
        for path in [&at.place_file, &at.place_key, &at.dir, &at.token_path] {
            assert!(!path.exists(), "{}", path.display());
        }
        assert!(std::fs::symlink_metadata(at.bin_dir.join("xdg-open")).is_err());
        assert!(work.exists());
        assert!(sweep_place_home(home.path(), &|_| String::new()).is_empty());
    }

    #[test]
    fn the_workspace_profile_is_unloaded_before_its_file_goes_and_named_in_what_the_leave_took() {
        let etc = tempfile::tempdir().unwrap();
        let profile = etc.path().join("wsp-workspace");
        std::fs::write(&profile, "profile wsp-workspace {}\n").unwrap();
        let asked = std::cell::RefCell::new(Vec::<(String, bool)>::new());
        let read = |script: &str| {
            asked.borrow_mut().push((script.to_owned(), profile.exists()));
            String::new()
        };
        assert_eq!(sweep_workspace_profile(&profile, &read), Some(profile.to_string_lossy().into_owned()));
        assert!(!profile.exists());
        let asked = asked.into_inner();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].0.contains(&format!("apparmor_parser -R '{}'", profile.display())), "{}", asked[0].0);
        assert!(asked[0].1, "the profile was unloaded while its file was still there");
        // A computer that never loaded one is asked nothing and says nothing.
        let never = |_: &str| -> String { panic!("nothing to unload") };
        assert_eq!(sweep_workspace_profile(&profile, &never), None);
    }
}
