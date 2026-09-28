// SPDX-License-Identifier: AGPL-3.0-only
//! git and a git host's command line run on the computer this daemon is: the road every machine but a workspace on
//! a computer somebody owns takes, word for word what this daemon always did.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use wsp_frames::numbers;

use super::{GitResult, Runs, GIT_ENV};
use crate::paths::OpError;

/// This computer, and the PATH programs are looked up on: the daemon's own environment, or the one a caller names,
/// which is what a case hands in rather than writing the process's own environment from under every other case.
pub(crate) struct Here {
    path: String,
}

impl Here {
    pub(crate) fn new() -> Here {
        Here { path: std::env::var("PATH").unwrap_or_default() }
    }

    #[cfg(test)]
    pub(crate) fn on(path: &str) -> Here {
        Here { path: path.to_owned() }
    }
}

impl Runs for Here {
    async fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        max_bytes: Option<usize>,
    ) -> Result<GitResult, OpError> {
        let mut command = command_of(&self.path, cwd, program, args);
        let mut child = command.spawn()?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let feed = async {
            if let (Some(mut stdin), Some(bytes)) = (stdin, input) {
                let _ = stdin.write_all(bytes).await;
            }
        };
        let read_out = async {
            let mut collected = Vec::new();
            let mut truncated = false;
            if let Some(mut pipe) = stdout {
                let mut buf = vec![0u8; 64 * 1024];
                while let Ok(n) = pipe.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if truncated {
                        continue;
                    }
                    collected.extend_from_slice(&buf[..n]);
                    if max_bytes.is_some_and(|cap| collected.len() > cap) {
                        truncated = true;
                        let _ = child.start_kill();
                    }
                }
            }
            (collected, truncated)
        };
        let read_err = async {
            let mut collected = Vec::new();
            if let Some(mut pipe) = stderr {
                let _ = pipe.read_to_end(&mut collected).await;
            }
            String::from_utf8_lossy(&collected).into_owned()
        };
        let ((), (stdout, truncated), stderr) = tokio::join!(feed, read_out, read_err);
        let status = child.wait().await?;
        Ok(GitResult { code: status.code(), stdout, stderr, truncated })
    }

    async fn on_path(&self, program: &str) -> Result<bool, OpError> {
        Ok(on_path(&self.path, program).is_some())
    }
}

/// argv behind the work-score line, never interpolated into a shell: sh runs the line, then execs the program in
/// its own place.
fn command_of(path: &str, cwd: &Path, program: &str, args: &[&str]) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(format!("{}; exec \"$0\" \"$@\"", numbers::work_score_line()))
        .arg(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (name, value) in GIT_ENV {
        command.env(name, value);
    }
    command
}

/// The program on that PATH, by the same reading a shell makes: the first entry holding a file that can be run.
pub(crate) fn on_path(path: &str, program: &str) -> Option<PathBuf> {
    path.split(':').filter(|dir| !dir.is_empty()).map(|dir| Path::new(dir).join(program)).find(|at| at.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_is_found_on_the_path_the_caller_named_and_nowhere_else() {
        let dir = tempfile::Builder::new().prefix("wsp-host-cli-").tempdir().unwrap();
        let bin = dir.path().join("gh");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        assert_eq!(on_path(&dir.path().to_string_lossy(), "gh"), Some(bin));
        assert_eq!(on_path("", "gh"), None);
        assert_eq!(on_path(&dir.path().to_string_lossy(), "glab"), None);
    }

    #[tokio::test]
    async fn the_program_runs_in_the_directory_with_the_git_environment_and_the_work_score() {
        let dir = tempfile::tempdir().unwrap();
        let res = Here::new()
            .run(dir.path(), "sh", &["-c", "pwd; echo \"$GIT_OPTIONAL_LOCKS|$LC_ALL|$GIT_TERMINAL_PROMPT\""], None, None)
            .await
            .unwrap();
        assert_eq!(res.code, Some(0), "{}", res.stderr);
        let out = String::from_utf8_lossy(&res.stdout).into_owned();
        let said: Vec<&str> = out.lines().collect();
        assert_eq!(said.first().map(|p| std::fs::canonicalize(p).unwrap()), Some(std::fs::canonicalize(dir.path()).unwrap()));
        assert_eq!(said.get(1), Some(&"0|C|0"));
        // And a program nothing on the PATH holds is not there, which is what a pull request with no gh reads.
        assert!(!Here::on("").on_path("gh").await.unwrap());
    }
}
