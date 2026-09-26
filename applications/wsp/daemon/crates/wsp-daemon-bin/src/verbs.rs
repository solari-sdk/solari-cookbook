// SPDX-License-Identifier: AGPL-3.0-only
//! Verbs beside the daemon: run in the foreground, do one thing, exit. `runtime ask` answers one machine frame
//! from the runtime under a root, so a create or a wake can be driven and timed on a box with nothing else
//! running. `runtime create` and `runtime exec` are the fresh processes the daemon runs youki's clone in;
//! `runtime init` is a workspace's first process. `copy` makes and removes the copy a workspace on the computer
//! somebody sits at is: the host runs it as a child and reads one JSON line back, so the road picking and the two
//! rules live in the daemon's own code without the door answering a new op.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use clap::Subcommand;
use wsp_frames::{numbers, CopyAsk, CopyRoadName};

#[derive(Debug, Subcommand)]
pub(crate) enum Verb {
    /// The workspace runtime's own verbs.
    Runtime {
        #[command(subcommand)]
        verb: RuntimeVerb,
    },
    /// The copy a workspace on the computer somebody sits at is made of: one JSON line on stdout when it stands,
    /// one sentence on stderr and exit 1 when it does not.
    Copy {
        #[command(subcommand)]
        verb: CopyVerb,
    },
    /// The wsp a process inside this machine runs: the whole line goes to the host over this machine's own daemon.
    /// Nothing here reads a verb or a flag, so the words the host's command line takes are the words that work.
    #[command(disable_help_flag = true)]
    Wsp {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        line: Vec<String>,
    },
    /// The wsp command on the computer the host runs on: a `wsp mcp` line is served by the host already serving it
    /// rather than by a process of its own, and every other line runs as the wsp the words after --wsp-argv name,
    /// which is also what is asked where the host is. The line follows `--`, whole.
    #[command(disable_help_flag = true)]
    Forward {
        #[arg(long = "wsp-argv", value_name = "word", required = true, action = clap::ArgAction::Append, allow_hyphen_values = true)]
        wsp_argv: Vec<String>,
        #[arg(last = true)]
        line: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum RuntimeVerb {
    /// One machine frame answered by the runtime under the root, as the daemon answers it on its link: the frame's
    /// JSON without its id, the reply printed with the milliseconds the op took. Not for a root a daemon is serving,
    /// which is why the root has no default: it is named on purpose every time.
    Ask {
        /// The frame: {"op":"machine.create","spec":{"kind":"sandbox","cpu":1,"memMb":512}}
        frame: String,
        /// The runtime root the frame is answered under; never the one a running daemon serves.
        #[arg(long, value_name = "dir")]
        root: PathBuf,
    },
    /// youki's create for the bundle the daemon wrote under <root>/run/<id>; the daemon runs this as a fresh process.
    Create {
        #[arg(long, value_name = "dir")]
        root: PathBuf,
        #[arg(long)]
        id: String,
    },
    /// A command inside a workspace as a tenant, this process's stdio as the command's; exits with its code, 124
    /// past the deadline. Without a deadline it runs until it ends, which is what a person's shell does, and the
    /// pid file is where the tenant's pid on this computer is written the moment it is made.
    Exec {
        #[arg(long, value_name = "dir")]
        root: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long, value_name = "n")]
        timeout_ms: Option<u64>,
        #[arg(long, value_name = "file")]
        pid_file: Option<PathBuf>,
        #[arg(last = true, required = true)]
        cmd: Vec<String>,
    },
    /// The terminal a workspace's pane runs on, run inside that workspace as the command of a plain exec: the pty
    /// is opened there, the shell put on its slave, and this process is the wire between that pty and the exec's
    /// own pipes. Not a verb anything on a computer runs: the daemon spells this line, and the binary that
    /// answers it is the one bound inside every workspace as its init.
    Pty {
        #[arg(long, value_name = "n")]
        cols: u16,
        #[arg(long, value_name = "n")]
        rows: u16,
        /// The folder the shell starts in, as the workspace sees it.
        #[arg(long, value_name = "dir")]
        cwd: PathBuf,
        /// Where the size of the pane is read at every window-change signal.
        #[arg(long, value_name = "file")]
        size_file: PathBuf,
        /// One name=value the shell carries beyond the workspace's own environment, once per name.
        #[arg(long, value_name = "name=value")]
        env: Vec<String>,
        #[arg(last = true, required = true)]
        cmd: Vec<String>,
    },
    /// A workspace's first process: runs the boot command and reaps what it leaves behind.
    Init {
        #[arg(last = true, required = true)]
        cmd: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum CopyVerb {
    /// Copies the folder to a path of its own by the best road this computer has, then makes it a clean checkout.
    Make {
        /// The project folder, which is the top of a git work tree.
        #[arg(long, value_name = "dir")]
        from: PathBuf,
        /// Where the copy lands; it must not be there yet.
        #[arg(long, value_name = "dir")]
        to: PathBuf,
        /// The ref the copy is reset to; the folder's default branch when absent.
        #[arg(long, value_name = "ref")]
        base: Option<String>,
        /// A directory removed from the copy so it rebuilds at the new path, once per directory.
        #[arg(long, value_name = "dir")]
        exclude: Vec<String>,
        /// Apparent size above which the directory clone is not taken.
        #[arg(long, default_value_t = u64::MAX, value_name = "n")]
        size_line_bytes: u64,
        /// A road named outright; the picker's own choice when absent.
        #[arg(long, value_name = "clonefile|worktree", value_parser = road_of)]
        road: Option<CopyRoadName>,
    },
    /// Takes a copy away by the road that made it.
    Remove {
        #[arg(long, value_name = "dir")]
        from: PathBuf,
        #[arg(long, value_name = "dir")]
        to: PathBuf,
        #[arg(long, value_name = "clonefile|worktree|in-place", value_parser = road_of)]
        road: CopyRoadName,
    },
}

/// The road a person or a host names on the line, read through the words the wire carries and nothing of its own.
fn road_of(word: &str) -> Result<CopyRoadName, String> {
    CopyRoadName::of_word(word).ok_or_else(|| format!("{word} is not a road: {}", CopyRoadName::words()))
}

/// The copy, with its report as the one line on stdout. Nothing else is printed there, so a caller reads the line
/// and parses it; the reason a copy was refused goes to stderr as one sentence.
fn copy(verb: CopyVerb) -> i32 {
    let done = match verb {
        CopyVerb::Make { from, to, base, exclude, size_line_bytes, road } => {
            let ask = CopyAsk {
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
                base,
                exclude,
                size_line_bytes,
                road,
            };
            wsp_runtime::copy_road::make(&ask).and_then(|report| serde_json::to_string(&report).map_err(|e| e.to_string()))
        }
        CopyVerb::Remove { from, to, road } => wsp_runtime::copy_road::remove(&from, &to, road).map(|()| String::new()),
    };
    match done {
        Ok(line) => {
            if !line.is_empty() {
                println!("{line}");
            }
            0
        }
        Err(why) => {
            eprintln!("{why}");
            1
        }
    }
}

pub(crate) fn run(verb: Verb) -> i32 {
    match verb {
        Verb::Runtime { verb: RuntimeVerb::Ask { frame, root } } => linux::ask(&root, &frame),
        Verb::Runtime { verb: RuntimeVerb::Create { root, id } } => linux::create(&root, &id),
        Verb::Runtime { verb: RuntimeVerb::Exec { root, id, timeout_ms, pid_file, cmd } } => {
            linux::exec(&root, &id, cmd, timeout_ms, pid_file)
        }
        Verb::Runtime { verb: RuntimeVerb::Pty { cols, rows, cwd, size_file, env, cmd } } => {
            linux::pty(cols, rows, cwd, size_file, &env, cmd)
        }
        Verb::Runtime { verb: RuntimeVerb::Init { cmd } } => linux::init(&cmd),
        Verb::Copy { verb } => copy(verb),
        Verb::Wsp { line } => {
            let daemon = SocketAddr::from((Ipv4Addr::LOCALHOST, numbers::DEFAULT_PORT));
            wsp_guest::run(
                &line,
                &|name| std::env::var(name).ok(),
                daemon,
                Path::new(numbers::DEFAULT_TOKEN_PATH),
                Path::new(numbers::GUEST_DAEMON_SOCKET_PATH),
            )
        }
        Verb::Forward { wsp_argv, line } => wsp_guest::run_here(&line, &wsp_argv),
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use wsp_runtime::runtime::{helper_create, helper_exec, helper_failure_line, HELPER_FAILED};

    pub(super) fn ask(root: &Path, frame: &str) -> i32 {
        match answer(root, frame) {
            Ok((reply, ms)) => {
                println!("{reply}");
                println!("{ms} ms");
                0
            }
            Err(e) => {
                eprintln!("runtime ask: {e}");
                1
            }
        }
    }

    /// The frame under a fresh id, answered by the ops on a runtime of this process's own; the network's forwards
    /// live on that runtime and end with the process. A snapshot is a job the ops name at once, so the verb asks
    /// after it every second, each reading on stderr, and prints the reading that ends it.
    fn answer(root: &Path, frame: &str) -> Result<(String, u128), Box<dyn std::error::Error>> {
        let mut frame: serde_json::Value = serde_json::from_str(frame)?;
        frame["id"] = serde_json::Value::from(1);
        let exe = std::env::current_exe()?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        runtime.block_on(async {
            // No door of its own: this process answers one frame and ends, so no port of it is a workspace's
            // to reach at the gateway.
            let ops = wsp_runtime::ops::Ops::open(root, exe, 0)?;
            ops.restore().await?;
            let started = std::time::Instant::now();
            let mut reply = ops.answer(Some(wsp_frames::RequestId::from(1)), &frame).await;
            let job = serde_json::from_str::<serde_json::Value>(&reply).ok().and_then(|v| v["job"].as_str().map(str::to_owned));
            if let Some(job) = job {
                loop {
                    let ask = serde_json::json!({ "id": 1, "op": "machine.snapshotJob", "job": job });
                    reply = ops.answer(Some(wsp_frames::RequestId::from(1)), &ask).await;
                    let read: serde_json::Value = serde_json::from_str(&reply)?;
                    if read["state"] != "running" {
                        break;
                    }
                    eprintln!("{} ms {reply}", started.elapsed().as_millis());
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
            Ok((reply, started.elapsed().as_millis()))
        })
    }

    pub(super) fn create(root: &Path, id: &str) -> i32 {
        crate::score::for_workspace();
        match helper_create(root, id) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{}", helper_failure_line(&e));
                HELPER_FAILED
            }
        }
    }

    pub(super) fn exec(root: &Path, id: &str, cmd: Vec<String>, timeout_ms: Option<u64>, pid_file: Option<PathBuf>) -> i32 {
        crate::score::for_workspace();
        match helper_exec(root, id, cmd, timeout_ms.map(Duration::from_millis), pid_file) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("{}", helper_failure_line(&e));
                HELPER_FAILED
            }
        }
    }

    /// Inside the workspace: the pty, the shell on it, and the wire between that pty and this process's pipes.
    pub(super) fn pty(cols: u16, rows: u16, cwd: PathBuf, size_file: PathBuf, env: &[String], cmd: Vec<String>) -> i32 {
        let ask = wsp_runtime::pty::Ask {
            cols,
            rows,
            cwd,
            size_file,
            env: env.iter().filter_map(|pair| pair.split_once('=')).map(|(k, v)| (k.to_owned(), v.to_owned())).collect(),
            argv: cmd,
        };
        wsp_runtime::pty::run(&ask)
    }

    pub(super) fn init(cmd: &[String]) -> i32 {
        wsp_runtime::init::run(cmd)
    }
}

#[cfg(not(target_os = "linux"))]
mod linux {
    use std::path::{Path, PathBuf};

    const NOT_HERE: &str = "workspaces run on Linux alone";

    pub(super) fn ask(_root: &Path, _frame: &str) -> i32 {
        eprintln!("runtime ask: {NOT_HERE}");
        1
    }

    pub(super) fn create(_root: &Path, _id: &str) -> i32 {
        eprintln!("runtime create: {NOT_HERE}");
        1
    }

    pub(super) fn exec(_root: &Path, _id: &str, _cmd: Vec<String>, _timeout_ms: Option<u64>, _pid_file: Option<PathBuf>) -> i32 {
        eprintln!("runtime exec: {NOT_HERE}");
        1
    }

    pub(super) fn pty(_cols: u16, _rows: u16, _cwd: PathBuf, _size_file: PathBuf, _env: &[String], _cmd: Vec<String>) -> i32 {
        eprintln!("runtime pty: {NOT_HERE}");
        1
    }

    pub(super) fn init(_cmd: &[String]) -> i32 {
        eprintln!("runtime init: {NOT_HERE}");
        1
    }
}
