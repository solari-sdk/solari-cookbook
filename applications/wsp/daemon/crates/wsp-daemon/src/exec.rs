// SPDX-License-Identifier: AGPL-3.0-only
//! One command on this machine, for a host that drives it over a link this machine opened rather than over a
//! provider's API. bash -c, never a login shell, which would reset PATH; the daemon's own root and environment.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use wsp_frames::{numbers, DaemonExecReply};

pub(crate) struct ExecOptions {
    /// Past it the command's process group is killed and the reply carries what it had.
    pub(crate) timeout: Duration,
    /// Bytes written to the command's stdin, which is closed either way: a command left holding an open pipe waits
    /// for a writer that never comes.
    pub(crate) stdin: Option<Vec<u8>>,
    /// The combined cap on both streams; the protocol's unless a test shrinks it.
    pub(crate) output_max: usize,
}

/// What the command said so far, under one budget for both streams: a caller reads one reply, so one cap.
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    spent: usize,
    truncated: bool,
    cap: usize,
}

impl Output {
    fn take(&mut self, chunk: &[u8], err: bool) {
        let room = self.cap - self.spent;
        if room == 0 {
            self.truncated = true;
            return;
        }
        let kept = if chunk.len() > room {
            self.truncated = true;
            &chunk[..room]
        } else {
            chunk
        };
        self.spent += kept.len();
        if err {
            self.stderr.extend_from_slice(kept);
        } else {
            self.stdout.extend_from_slice(kept);
        }
    }

    fn reply(&self, exit_code: i32) -> DaemonExecReply {
        DaemonExecReply {
            exit_code,
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            truncated: self.truncated,
        }
    }
}

/// Runs the command and answers what it said, its code, and whether the cap cut it.
pub(crate) async fn run_exec(root: &Path, env: &[(OsString, OsString)], cmd: &str, opts: ExecOptions) -> DaemonExecReply {
    let out = Mutex::new(Output { stdout: Vec::new(), stderr: Vec::new(), spent: 0, truncated: false, cap: opts.output_max });
    let mut command = Command::new("bash");
    command.arg("-c").arg(cmd).current_dir(root).env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    // Its own process group, so the deadline kills the children a script started and not the shell alone: a turn's
    // launch backgrounds a session, and a kill that took the shell would leave that session running for good.
    command.process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        // A bash that could not be spawned at all is a machine without one, which is the same shape as a command
        // that could not run: the code says so and the reason is on stderr.
        Err(e) => {
            out.lock().unwrap_or_else(|e| e.into_inner()).stderr.extend_from_slice(e.to_string().as_bytes());
            return out.into_inner().unwrap_or_else(|e| e.into_inner()).reply(127);
        }
    };
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let feed = async {
        if let (Some(mut stdin), Some(bytes)) = (stdin, opts.stdin) {
            let _ = stdin.write_all(&bytes).await;
        }
    };
    // The reply waits for the exit and for both pipes to close, as node's close event does; a child that outlives
    // the shell holds the pipes and is the deadline's to kill.
    let run = async {
        let ((), (), (), status) = tokio::join!(feed, read_into(stdout, false, &out), read_into(stderr, true, &out), child.wait());
        status
    };
    let code = match tokio::time::timeout(opts.timeout, run).await {
        Ok(status) => status.ok().and_then(|s| s.code()).unwrap_or(numbers::EXEC_DEADLINE_EXIT),
        Err(_) => {
            kill_group(pid, &mut child).await;
            numbers::EXEC_DEADLINE_EXIT
        }
    };
    out.into_inner().unwrap_or_else(|e| e.into_inner()).reply(code)
}

/// One task polls both readers, so the lock is never contended; it is a lock only because the future must be Send.
async fn read_into<R: AsyncRead + Unpin>(pipe: Option<R>, err: bool, out: &Mutex<Output>) {
    let Some(mut pipe) = pipe else { return };
    let mut buf = vec![0u8; 16 * 1024];
    while let Ok(n) = pipe.read(&mut buf).await {
        if n == 0 {
            break;
        }
        out.lock().unwrap_or_else(|e| e.into_inner()).take(&buf[..n], err);
    }
}

/// The group, not the pid: -pid reaches the session the script may have opened. A group that is already gone is
/// the command having exited between the timer and this line.
async fn kill_group(pid: Option<u32>, child: &mut tokio::process::Child) {
    let group = pid.and_then(|p| i32::try_from(p).ok()).map(Pid::from_raw);
    if group.is_none_or(|g| killpg(g, Signal::SIGKILL).is_err()) {
        let _ = child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env_of(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn own_env() -> Vec<(OsString, OsString)> {
        std::env::vars_os().collect()
    }

    fn opts(timeout_ms: u64) -> ExecOptions {
        ExecOptions { timeout: Duration::from_millis(timeout_ms), stdin: None, output_max: numbers::EXEC_OUTPUT_MAX }
    }

    #[tokio::test]
    async fn runs_under_bash_in_the_daemons_root_with_its_environment_and_answers_both_streams_and_the_code() {
        let root = tempfile::tempdir().unwrap();
        let env = env_of(&[("HOME", root.path().to_str().unwrap()), ("WSP_TEST_WORD", "kept")]);
        let res = run_exec(root.path(), &env, "pwd; printf \"%s\\n\" \"$WSP_TEST_WORD\"; echo bad >&2; exit 3", opts(5_000)).await;
        assert_eq!(res.exit_code, 3);
        assert!(res.stdout.contains("kept"), "{}", res.stdout);
        assert_eq!(res.stderr.trim(), "bad");
        assert!(!res.truncated);
        // The root, not the process's cwd: a place's daemon is rooted at the person's home.
        let leaf = root.path().file_name().unwrap().to_str().unwrap();
        assert!(res.stdout.lines().next().unwrap().contains(leaf));
    }

    #[tokio::test]
    async fn kills_the_whole_process_group_at_the_deadline_and_answers_124_with_nothing_said_after_the_kill() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("child.pid");
        let cmd = format!("(sleep 30 & echo $! > {}); sleep 5; echo late", pid_file.display());
        let res = run_exec(root.path(), &own_env(), &cmd, opts(300)).await;
        assert_eq!(res.exit_code, numbers::EXEC_DEADLINE_EXIT);
        assert!(!res.stdout.contains("late"));
        // The child the script started is gone with the group, not left behind for the life of the machine.
        let pid: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(nix::sys::signal::kill(Pid::from_raw(pid), None).is_err(), "pid {pid} still alive");
    }

    #[tokio::test]
    async fn lands_the_bytes_a_caller_sends_on_stdin() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("landed.txt");
        let res = run_exec(
            root.path(),
            &own_env(),
            &format!("cat > {}", target.display()),
            ExecOptions { stdin: Some(b"bytes on the wire\n".to_vec()), ..opts(5_000) },
        )
        .await;
        assert_eq!(res.exit_code, 0);
        assert_eq!(fs::read_to_string(target).unwrap(), "bytes on the wire\n");
    }

    #[tokio::test]
    async fn closes_stdin_when_the_caller_sends_none_so_a_command_that_reads_it_is_not_left_waiting() {
        let root = tempfile::tempdir().unwrap();
        let res = run_exec(root.path(), &own_env(), "cat; echo done", opts(3_000)).await;
        assert_eq!(res.exit_code, 0);
        assert!(res.stdout.contains("done"));
    }

    #[tokio::test]
    async fn cuts_the_output_at_the_cap_and_says_it_did() {
        let root = tempfile::tempdir().unwrap();
        let res = run_exec(root.path(), &own_env(), "printf 'x%.0s' $(seq 1 5000)", ExecOptions { output_max: 100, ..opts(5_000) }).await;
        assert!(res.truncated);
        assert!(res.stdout.len() + res.stderr.len() <= 100);
    }

    #[tokio::test]
    async fn carries_a_files_bytes_under_the_script_the_ssh_road_uses_and_a_short_count_leaves_the_target_alone() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("over-the-wire.bin");
        let bytes = b"a token, as it happens\n".to_vec();
        let tmp = format!("{}.in", target.display());
        let script = |count: usize| {
            [
                "set -e".to_owned(),
                "umask 077".to_owned(),
                format!("cat > {tmp}"),
                format!("[ \"$(wc -c < {tmp} | tr -d ' ')\" = {count} ] || {{ rm -f {tmp}; echo WSP_BYTES_SHORT; exit 1; }}"),
                format!("mv -f {tmp} {}", target.display()),
                "echo WSP_BYTES_OK".to_owned(),
            ]
            .join("\n")
        };
        let ok = run_exec(root.path(), &own_env(), &script(bytes.len()), ExecOptions { stdin: Some(bytes.clone()), ..opts(5_000) }).await;
        assert!(ok.stdout.contains("WSP_BYTES_OK"), "{ok:?}");
        assert_eq!(fs::read(&target).unwrap(), bytes);

        fs::write(&target, "the old one\n").unwrap();
        let short = run_exec(root.path(), &own_env(), &script(bytes.len() + 1), ExecOptions { stdin: Some(bytes), ..opts(5_000) }).await;
        assert!(short.stdout.contains("WSP_BYTES_SHORT"), "{short:?}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "the old one\n");
        assert!(!Path::new(&tmp).exists());
    }
}
