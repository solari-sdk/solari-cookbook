// SPDX-License-Identifier: AGPL-3.0-only
//! git and a git host's command line run inside one workspace this daemon holds, through the runtime's own exec:
//! the road a workspace on a computer somebody owns takes, since such a workspace runs no daemon of its own.
//!
//! Inside rather than on the computer because a checkout's hooks and its config are agent-written and run code:
//! `core.fsmonitor`, `core.hooksPath`, `credential.helper` and a pre-push hook are all a turn's to write, and a
//! git the daemon ran as root on the computer would run them outside the workspace's namespaces, its cgroup and
//! the covers over the computer's own logins and keys.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use wsp_frames::numbers;
use wsp_runtime::ops::Ops;

use super::{Asked, GitResult, Runs, GIT_ENV};
use crate::paths::OpError;

/// One workspace of this computer's, and how long a command in it may run: the daemon's own exec ceiling rather
/// than the runtime's default, since a push over a slow link outlives twenty seconds and a person is waiting on
/// the whole bring back rather than on one frame.
pub(crate) struct Inside {
    runtime: Arc<Ops>,
    machine: String,
    asked: Asked,
}

impl Inside {
    pub(crate) fn new(runtime: Arc<Ops>, machine: &str, asked: Asked) -> Inside {
        Inside { runtime, machine: machine.to_owned(), asked }
    }

    /// One command inside, on the road the frame asked for.
    async fn ran(&self, line: &str, input: Option<Vec<u8>>) -> Result<wsp_runtime::runtime::Exec, OpError> {
        let done = match self.asked {
            Asked::Read => self.runtime.read_in(&self.machine, line, input, DEADLINE).await,
            Asked::Work => self.runtime.exec_in(&self.machine, line, input, DEADLINE).await,
        };
        done.map_err(crate::ops::from_runtime)
    }
}

/// How long one command inside may run.
const DEADLINE: Duration = Duration::from_millis(numbers::EXEC_TIMEOUT_MAX_MS as u64);

impl Runs for Inside {
    async fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        max_bytes: Option<usize>,
    ) -> Result<GitResult, OpError> {
        let done = self.ran(&line(cwd, program, args), input.map(<[u8]>::to_vec)).await?;
        let mut stdout = done.stdout.into_bytes();
        let truncated = was_cut(stdout.len(), max_bytes, done.truncated);
        if let Some(cap) = max_bytes.filter(|cap| stdout.len() > *cap) {
            stdout.truncate(cap);
        }
        Ok(GitResult { code: Some(done.exit_code), stdout, stderr: done.stderr, truncated })
    }

    async fn on_path(&self, program: &str) -> Result<bool, OpError> {
        let read = format!("command -v {} >/dev/null 2>&1", quoted(program));
        Ok(self.ran(&read, None).await?.exit_code == 0)
    }
}

/// Whether what came back was cut, by either cap it passed. The caller's is the pane's byte budget, spent on
/// what arrived rather than by killing a process this daemon does not hold: an exec inside answers whole or not
/// at all. The exec road inside has a cap of its own under it, and what that road dropped is dropped whatever the
/// caller's budget says, so the person reading is told either way.
fn was_cut(bytes: usize, max_bytes: Option<usize>, runtime_said: bool) -> bool {
    runtime_said || max_bytes.is_some_and(|cap| bytes > cap)
}

/// The one line an exec inside runs: the work score every shell of ours starts at, the git environment, the
/// directory, and the program execed in its own place so nothing of its own argv is read by a shell.
fn line(cwd: &Path, program: &str, args: &[&str]) -> String {
    let mut words = vec![quoted(program)];
    words.extend(args.iter().map(|arg| quoted(arg)));
    let env = GIT_ENV.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join(" ");
    format!("{}\nexport {env}\ncd {} && exec {}", numbers::work_score_line(), quoted(&cwd.to_string_lossy()), words.join(" "))
}

/// One word for a shell, quoted the one way this daemon quotes: single quotes, with a quote of its own closed and
/// reopened, so nothing of a path or an argument is read as shell.
fn quoted(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// At exactly the caller's cap nothing of its own was dropped, so what says the answer is cut is the road
    /// underneath saying it dropped something.
    #[test]
    fn what_came_back_reads_cut_at_the_cap_only_where_the_road_under_it_cut() {
        let cap = numbers::GIT_DIFF_CAP_BYTES;
        assert!(!was_cut(cap, Some(cap), false));
        assert!(was_cut(cap, Some(cap), true));
        assert!(was_cut(cap + 1, Some(cap), false));
        assert!(!was_cut(cap - 1, Some(cap), false));
        // A read with no budget of its own, which is every git call but the diff, is cut only by that road.
        assert!(!was_cut(cap + 1, None, false));
        assert!(was_cut(0, None, true));
    }

    #[test]
    fn the_line_carries_the_work_score_the_git_environment_the_folder_and_the_program_execed() {
        let status = line(Path::new("/root/a repo"), "git", &["status", "--porcelain=v2"]);
        let said: Vec<&str> = status.lines().collect();
        assert_eq!(said[0], numbers::work_score_line());
        assert_eq!(said[1], "export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 LC_ALL=C");
        assert_eq!(said[2], "cd '/root/a repo' && exec 'git' 'status' '--porcelain=v2'");
        // Nothing of a path or an argument reaches a shell as shell: a folder with a quote in its name is one word.
        let odd = line(Path::new("/root/it's"), "gh", &["pr", "create", "--title", "a $(rm -rf /) title"]);
        assert!(odd.contains("cd '/root/it'\\''s' && exec 'gh' 'pr' 'create' '--title' 'a $(rm -rf /) title'"), "{odd}");
    }
}
