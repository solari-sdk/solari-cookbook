// SPDX-License-Identifier: AGPL-3.0-only
//! The numbers and paths the protocol and the node daemon own, as the contract fixture pins them.

/// The daemon's protocol version, carried in its hello: the length of the protocol's DAEMON_CONTENTS record.
pub const DAEMON_VERSION: u32 = 79;

pub const DEFAULT_HOST: &str = "0.0.0.0";
pub const DEFAULT_PORT: u16 = 7070;
/// Where the daemon inside a machine keeps everything of its own: its token, its inbox, its manifest, its open
/// socket, its run and log folders and its roots file, every one of them under this folder by default. A
/// workspace on a computer somebody joined has this folder of its own bound over the computer's, so two
/// workspaces there never read or write each other's token and the computer's own daemon folder is not readable
/// from inside at all. The shape is `place_daemon_paths("/root")`'s, which the test below holds it to: one
/// daemon, one rule for where it puts its own files under the home it was given.
pub const GUEST_WSP_HOME: &str = "/root/.wsp";
pub const DEFAULT_TOKEN_PATH: &str = "/root/.wsp/daemon-token";
pub const DEFAULT_INBOX_DIR: &str = "/root/.wsp/inbox";
pub const DEFAULT_MANIFEST_PATH: &str = "/root/.wsp/manifest.json";
pub const DEFAULT_RUN_DIR: &str = "/root/.wsp/run";
pub const DEFAULT_LOG_DIR: &str = "/root/.wsp/logs";
pub const GUEST_DAEMON_DIR: &str = "/root/wsp-daemon";
/// The wsp a process inside a machine runs: two lines the host's deploy writes onto the machine's PATH, handing
/// the whole line to the daemon binary beside them. Here so the two halves of the contract cannot spell it apart.
/// The binary's own path is not pinned: it sits in the bundle under one folder per chip.
pub const GUEST_WSP_PATH: &str = "/usr/local/bin/wsp";
/// The socket a process inside a workspace on a computer somebody owns reaches its host over. The daemon of that
/// computer binds one per workspace in that workspace's own wsp folder, which is bound over the folder above
/// inside it, so the file is in that workspace's view and in no other's and nowhere on the computer's own. The
/// file itself is the gate and no token rides this road; a fork has no such socket and dials the port instead.
pub const GUEST_DAEMON_SOCKET_PATH: &str = "/root/.wsp/daemon.sock";
pub const DAEMON_ROOTS_PATH: &str = "/root/.wsp/roots";
pub const OPEN_SHIM_PATH: &str = "/usr/local/bin/wsp-open";
pub const XDG_OPEN_PATH: &str = "/usr/local/bin/xdg-open";
/// The AppArmor profile a root install's workspaces run under, which a leave unloads and takes off.
pub const WORKSPACE_APPARMOR_PATH: &str = "/etc/apparmor.d/wsp-workspace";
pub const OPEN_SOCKET_PATH: &str = "/root/.wsp/open.sock";

/// The computer's own system directories a workspace on a computer somebody owns reads through a tree of its own,
/// which is what a daemon root may not sit under: a workspace's upper would otherwise sit inside the tree it
/// reads through. A directory outside these and outside /root is in no workspace of that computer unless a shared
/// tool root below brings it in. How each of the five is built is the runtime's own table; this list is what the
/// doctor holds a root away from.
pub const OVERLAID: [&str; 5] = ["/usr", "/etc", "/opt", "/var", "/srv"];
/// Where Homebrew on Linux keeps its own user's home, and the prefix under it every formula is installed into.
pub const HOMEBREW_HOME: &str = "/home/linuxbrew";
pub const HOMEBREW_PREFIX: &str = "/home/linuxbrew/.linuxbrew";
/// Every install root a road writes outside the overlaid trees and outside /root, bound read-only into a workspace
/// where the computer has it: a root left off this list is on the computer and out of every workspace's sight while
/// the PATH inside names it.
pub const SHARED_TOOL_ROOTS: [&str; 1] = [HOMEBREW_HOME];
/// Directories a machine recreates, by exact name, which a repos listing never walks into.
pub const CACHE_DIRS: [&str; 22] = [
    "node_modules",
    ".pnpm-store",
    "venv",
    ".venv",
    "virtenv",
    "site-packages",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".gradle",
];
/// How deep under a root a repos listing looks, and how many repos it stops at.
pub const REPO_DEPTH: u32 = 5;
pub const REPO_CAP: usize = 400;
/// The one PATH the tools on a machine sit on, in one order: a sealed image's login shell reads it from the profile
/// the image writes, every thread and exec carries it, and a workspace on a computer somebody owns boots with it,
/// so the boot's own children and a person's thread find the same gcc and the same gh.
pub const TOOLS_PATH: &str = "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/root/go/bin:/root/.cargo/bin:/root/.local/share/pnpm:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/// The same directories in the order a workspace on a computer somebody owns reads them, which is what its boot,
/// its execs, its threads and its pane carry: the folders no process inside can write first, then the folders
/// under the home every workspace there shares, then the computer's own system directories. That home is bound
/// into every workspace read-write, so a file planted in it under the name of a tool the recipe installed would
/// otherwise be what a sibling's thread, command and pane run. A machine wsp forked keeps TOOLS_PATH: its home is
/// root's alone and a sealed image keeps the order it was sealed with. The protocol's twin is PLACE_WORKSPACE_PATH.
pub const PLACE_WORKSPACE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/root/.local/bin:/root/go/bin:/root/.cargo/bin:/root/.local/share/pnpm:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Wire bytes a peer may send before its auth frame passes; an auth frame is under 200.
pub const PRE_AUTH_MAX_BYTES: u64 = 4096;
/// How long a fresh socket has to send its auth frame.
pub const AUTH_DEADLINE_MS: u64 = 5000;
/// Laptop connections one socket may hold open through the forward at once.
pub const TUNNEL_CAP: usize = 64;

pub const EXEC_BODY_MAX: usize = 16 * 1024;
pub const EXEC_OUTPUT_MAX: usize = 2 * 1024 * 1024;
pub const EXEC_TIMEOUT_DEFAULT_MS: u32 = 20_000;
pub const EXEC_TIMEOUT_MAX_MS: u32 = 600_000;
pub const EXEC_DEADLINE_EXIT: i32 = 124;

pub const FS_READ_CAP_BYTES: u64 = 2 * 1024 * 1024;
pub const FS_LIST_CAP_ENTRIES: usize = 10_000;
pub const GIT_DIFF_CAP_BYTES: usize = 2 * 1024 * 1024;
pub const SCROLLBACK_CAP_BYTES: usize = 256 * 1024;
/// How much of /proc/<pid>/cmdline a process row carries.
pub const CMDLINE_BYTES: usize = 200;
/// How much of the holder's cmdline a port row carries; a cut argv ends with an ellipsis.
pub const PORT_CMDLINE_CAP_BYTES: usize = 512;
pub const PROC_CAP: usize = 1000;
/// Linux pid_max ceiling; both proc ops refuse anything above it.
pub const PID_MAX: u32 = 4_194_304;
/// How often a daemon samples the computer it runs on for sys.watch and proc.watch, and so how long after the reply
/// to a watch its first sample lands. The protocol's DAEMON_SAMPLER_INTERVAL_MS is the same figure, held so by the
/// contract fixture.
pub const SAMPLER_INTERVAL_MS: u64 = 2000;
/// One tick of the stat files under /proc in milliseconds: the kernel reports those fields at 100 Hz whatever its
/// own timer runs at, so a start time or a cpu count read there is turned into time with this.
pub const STAT_TICK_MS: u64 = 10;
/// The most one POST /open body may carry.
pub const OPEN_BODY_CAP: usize = 8 * 1024;
pub const OPEN_URL_MAX: usize = 8192;

/// One guest message's JSON: a thread's whole transcript is the largest thing that rides this road.
pub const GUEST_MESSAGE_CAP_BYTES: usize = 4 * 1024 * 1024;
/// Frames one guest session may hold while no watcher is attached: its guest's messages and its close, since the
/// frame it opened with rides a field of its own and is named to every watcher that arrives. Past the cap the
/// session is closed to the guest.
pub const GUEST_QUEUE_CAP_FRAMES: usize = 256;
/// Guest bytes one workspace may have waiting at once, queued in its sessions and written onto the watcher's
/// channel but not carried out of the socket yet. One count per workspace on a computer that runs them, and one
/// for the daemon itself inside a machine, where a session names no workspace and every session shares it. Four
/// of one message's cap, so the largest honest thing on this road is never what fills it; a send past the cap is
/// refused and its session stands.
pub const GUEST_IN_FLIGHT_CAP_BYTES: usize = 4 * GUEST_MESSAGE_CAP_BYTES;
/// Guest sockets one workspace's door serves at once, and guest sessions one workspace holds at once, a session
/// whose socket went and whose close is waiting for a watcher counted among them. The door of a workspace on a
/// computer somebody owns needs no token, so what a process inside opens is what this bounds: past the cap a
/// socket is closed with no hello and an open is refused, while the workspaces beside it and the host link stand.
/// One count per workspace, and one for the daemon inside a machine, where a session names no workspace.
pub const GUEST_SESSIONS_PER_WORKSPACE_CAP: usize = 64;
/// The largest frame a workspace's door reads, in place of the ceiling every other socket is opened with: one
/// guest message's cap and room for the envelope around it. A frame past this is refused by the framing before a
/// byte of it is held or parsed, which is what makes the cap above worth having, since a frame becomes a message
/// before any guest cap is read.
pub const GUEST_FRAME_CAP_BYTES: usize = GUEST_MESSAGE_CAP_BYTES + 64 * 1024;
/// How long a guest session stands with nobody watching it. Every watcher that arrives is told the sessions this
/// machine holds, so a host that restarted picks them back up; past this span nobody is coming, and the session
/// ends to its guest rather than leaving the process inside the machine waiting for the life of the workspace.
pub const GUEST_UNWATCHED_MS: u64 = 10 * 60 * 1000;
/// The thread token and the turn token a guest session opens with; the daemon never reads either.
pub const GUEST_TOKEN_MAX: usize = 512;
/// Words in one guest command line, and the length of the folder it runs in.
pub const GUEST_ARGV_MAX: usize = 256;
pub const GUEST_CWD_MAX: usize = 4096;

pub const PLACE_LINK_NONCE_BYTES: usize = 32;

/// The daemon is last for the kernel's memory killer and ahead of every default-priority process.
pub const DAEMON_OOM_SCORE_ADJ: i32 = -999;
pub const DAEMON_NICE: i32 = -10;
/// Work is taken first: every shell the daemon opens starts at this score.
pub const WORK_OOM_SCORE_ADJ: i32 = 500;

/// The sh line that puts a shell, and everything it starts, at the work scores.
pub fn work_score_line() -> String {
    format!("{{ echo {WORK_OOM_SCORE_ADJ} > /proc/self/oom_score_adj; }} 2>/dev/null; renice 0 $$ >/dev/null 2>&1")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every file the daemon inside a machine writes for itself sits under one folder, and that folder is the
    /// workspace's own on a computer somebody joined. A path that slipped out of it would be written into a
    /// `/root` every workspace on that computer shares, where the second workspace's deploy would rewrite the
    /// first one's token.
    #[test]
    fn every_path_the_daemon_writes_for_itself_is_under_the_one_folder() {
        for path in [
            DEFAULT_TOKEN_PATH,
            DEFAULT_INBOX_DIR,
            DEFAULT_MANIFEST_PATH,
            DEFAULT_RUN_DIR,
            DEFAULT_LOG_DIR,
            DAEMON_ROOTS_PATH,
            OPEN_SOCKET_PATH,
            GUEST_DAEMON_SOCKET_PATH,
        ] {
            assert!(path.starts_with(&format!("{GUEST_WSP_HOME}/")), "{path} is not under {GUEST_WSP_HOME}");
        }
        // And they are the names a daemon on a computer somebody joined uses under that computer's home: one
        // daemon, one rule, whether the machine is a fork or a computer of the person's own.
        let at = crate::place_daemon_paths(std::path::Path::new("/root"));
        assert_eq!(at.wsp, std::path::PathBuf::from(GUEST_WSP_HOME));
        assert_eq!(at.token_path, std::path::PathBuf::from(DEFAULT_TOKEN_PATH));
        assert_eq!(at.inbox, std::path::PathBuf::from(DEFAULT_INBOX_DIR));
        assert_eq!(at.manifest_path, std::path::PathBuf::from(DEFAULT_MANIFEST_PATH));
        assert_eq!(at.open_socket, std::path::PathBuf::from(OPEN_SOCKET_PATH));
        assert_eq!(at.run_dir, std::path::PathBuf::from(DEFAULT_RUN_DIR));
        assert_eq!(at.roots_path, std::path::PathBuf::from(DAEMON_ROOTS_PATH));
        // The binary the host deploys is not one of them: it is the host's to land and lives beside the folder.
        assert!(!GUEST_DAEMON_DIR.starts_with(GUEST_WSP_HOME));
    }

    /// The PATH a workspace on a computer somebody owns reads holds exactly the directories the tools PATH holds,
    /// in one other order: the probe path's own folders other than the four the system keeps, then every folder
    /// under the shared home in the tools PATH's order, then those four. A directory added to one list and not to
    /// the other is a tool on a fork and not on a box, or the reverse.
    #[test]
    fn a_workspace_on_a_computer_reads_the_same_directories_with_the_shared_home_after_the_prefixes() {
        let system = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];
        let tools: Vec<&str> = TOOLS_PATH.split(':').collect();
        let probe = crate::place_paths::probe_path(std::path::Path::new("/root"));
        let mut wanted: Vec<&str> = probe.split(':').filter(|dir| !system.contains(dir)).collect();
        wanted.extend(tools.iter().filter(|dir| dir.starts_with("/root/")));
        wanted.extend(system);
        assert_eq!(PLACE_WORKSPACE_PATH.split(':').collect::<Vec<_>>(), wanted);
        let mut here: Vec<&str> = PLACE_WORKSPACE_PATH.split(':').collect();
        let mut there = tools.clone();
        here.sort_unstable();
        there.sort_unstable();
        assert_eq!(here, there, "the two lists hold different directories");
    }
}
