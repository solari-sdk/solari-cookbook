// SPDX-License-Identifier: AGPL-3.0-only
//! git through the git binary, never a library: one parser of porcelain v2, and the diff pane's shared byte budget.
//!
//! Where that binary runs is one seam, `Runs`, with a module per way: `here` runs it on the computer this daemon
//! is, `inside` runs it in one workspace this daemon holds. A workspace on a computer somebody owns runs no daemon
//! of its own, so this daemon answers its git, and it runs that git inside the workspace: a checkout's hooks and
//! its config are agent-written and run code, and code of a workspace's belongs in that workspace's namespaces,
//! its cgroup and its covers rather than as root on the computer. Adding a third way is a module and nothing in
//! the callers.

use std::future::Future;
use std::path::Path;

use wsp_frames::{DaemonErrorCode, GitBranch, GitDiffFile, GitDiffReply, GitDiffScope, GitStatusEntry, GitStatusReply};

use crate::fs::utf8_text;
use crate::paths::OpError;

pub(crate) mod here;
#[cfg(target_os = "linux")]
pub(crate) mod inside;

/// What a frame is doing to the workspace it names, which is what that workspace's quiet clock reads. A pane
/// reading a checkout's status, its diff or a folder asks the workspace nothing: it may be read a hundred times
/// over an afternoon nobody is working, and a workspace nobody is working in is one this computer may stop.
/// Pushing a branch, opening a pull request or reading one back is work somebody asked for, and starts that
/// clock over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Asked {
    Read,
    Work,
}

pub(crate) struct GitResult {
    /// None when a signal ended the program, which is what the byte cap does.
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
    /// stdout passed the cap; the program was killed and code is None.
    pub(crate) truncated: bool,
}

/// One way to run a program for a git operation. Both ways carry the same environment: GIT_OPTIONAL_LOCKS keeps a
/// status from touching the index, LC_ALL=C keeps the not-a-repo message matchable, GIT_TERMINAL_PROMPT keeps a
/// push that wants a credential from waiting on a person who is not there, and the work score line puts the
/// process where every shell of ours runs, last for the kernel's memory killer.
pub(crate) trait Runs {
    /// The program with its arguments in that directory, stdin fed then closed, stdout under an optional cap past
    /// which the program is killed.
    fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        max_bytes: Option<usize>,
    ) -> impl Future<Output = Result<GitResult, OpError>> + Send;
    /// Whether that program is on the PATH this way of running finds programs on: a computer with no gh and a
    /// workspace with no gh read the same to whoever asked for a pull request, and neither is a failure.
    fn on_path(&self, program: &str) -> impl Future<Output = Result<bool, OpError>> + Send;
}

/// The environment every git and every host command line of ours runs with, as shell exports: one line, so the two
/// ways of running cannot part ways on it.
pub(crate) const GIT_ENV: [(&str, &str); 3] = [("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C")];

/// Runs git through the way given: the one place the program is named git.
pub(crate) async fn run_git<R: Runs>(
    runner: &R,
    cwd: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    max_bytes: Option<usize>,
) -> Result<GitResult, OpError> {
    runner.run(cwd, "git", args, input, max_bytes).await
}

/// Exit 0 and 1 are answers, a cut is the cap's doing; anything else failed, and a missing repo has its own code.
pub(crate) fn check(res: &GitResult, what: &str) -> Result<(), OpError> {
    if res.truncated || matches!(res.code, Some(0 | 1)) {
        return Ok(());
    }
    if res.stderr.to_ascii_lowercase().contains("not a git repository") {
        return Err(OpError::coded(DaemonErrorCode::NotAGitRepo, "not inside a git repository"));
    }
    let code = res.code.map_or_else(|| "killed".to_owned(), |c| c.to_string());
    Err(OpError::plain(format!("git {what} failed ({code}): {}", res.stderr.trim())))
}

pub(crate) fn stdout_text(res: &GitResult) -> String {
    String::from_utf8_lossy(&res.stdout).into_owned()
}

/// Porcelain v2 with -z: every record is NUL-terminated and a rename's original path follows as its own record
/// instead of a tab suffix.
pub(crate) fn parse_porcelain_v2(text: &str) -> (GitBranch, Vec<GitStatusEntry>) {
    let mut branch = GitBranch { oid: String::new(), head: String::new(), upstream: None, ahead: 0, behind: 0 };
    let mut entries = Vec::new();
    let tokens: Vec<&str> = text.split('\0').collect();
    let count = |word: Option<&&str>| word.and_then(|w| w.get(1..)).and_then(|n| n.parse().ok()).unwrap_or(0);
    let path_from = |parts: &[&str], from: usize| parts.get(from..).unwrap_or_default().join(" ");
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        let parts: Vec<&str> = tok.split(' ').collect();
        let xy = || parts.get(1).copied().unwrap_or_default().to_owned();
        match &tok[..1] {
            "#" => match parts.get(1).copied() {
                Some("branch.oid") => branch.oid = parts.get(2).copied().unwrap_or_default().to_owned(),
                Some("branch.head") => branch.head = parts.get(2).copied().unwrap_or_default().to_owned(),
                Some("branch.upstream") => branch.upstream = Some(parts.get(2).copied().unwrap_or_default().to_owned()),
                Some("branch.ab") => {
                    branch.ahead = count(parts.get(2));
                    branch.behind = count(parts.get(3));
                }
                _ => {}
            },
            "1" => entries.push(GitStatusEntry { xy: xy(), path: path_from(&parts, 8), orig_path: None }),
            "2" => {
                let orig_path = tokens.get(i).copied().unwrap_or_default().to_owned();
                i += 1;
                entries.push(GitStatusEntry { xy: xy(), path: path_from(&parts, 9), orig_path: Some(orig_path) });
            }
            "u" => entries.push(GitStatusEntry { xy: xy(), path: path_from(&parts, 10), orig_path: None }),
            kind @ ("?" | "!") => {
                entries.push(GitStatusEntry { xy: kind.repeat(2), path: tok.get(2..).unwrap_or_default().to_owned(), orig_path: None })
            }
            _ => {}
        }
    }
    (branch, entries)
}

pub(crate) async fn git_status<R: Runs>(runner: &R, cwd: &Path) -> Result<GitStatusReply, OpError> {
    let res = run_git(runner, cwd, &["status", "--porcelain=v2", "--branch", "-z"], None, None).await?;
    check(&res, "status")?;
    let top = run_git(runner, cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    let (branch, entries) = parse_porcelain_v2(&stdout_text(&res));
    Ok(GitStatusReply { branch, entries, root: stdout_text(&top).trim().to_owned() })
}

pub(crate) async fn rev_exists<R: Runs>(runner: &R, cwd: &Path, rev: &str) -> Result<bool, OpError> {
    Ok(run_git(runner, cwd, &["rev-parse", "--verify", "-q", rev], None, None).await?.code == Some(0))
}

/// origin/HEAD when a remote set it, else a local main or master.
pub(crate) async fn default_branch<R: Runs>(runner: &R, cwd: &Path) -> Result<Option<String>, OpError> {
    let remote = run_git(runner, cwd, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], None, None).await?;
    check(&remote, "symbolic-ref")?;
    if remote.code == Some(0) {
        return Ok(Some(stdout_text(&remote).trim().to_owned()));
    }
    for name in ["main", "master"] {
        if rev_exists(runner, cwd, &format!("refs/heads/{name}")).await? {
            return Ok(Some(name.to_owned()));
        }
    }
    Ok(None)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ListedFile {
    pub(crate) path: String,
    pub(crate) orig_path: Option<String>,
}

/// `diff --name-status -z`: a status record, then the path, and for a rename or a copy the new path after it.
pub(crate) fn parse_name_status(text: &str) -> Vec<ListedFile> {
    let mut files = Vec::new();
    let mut tokens = text.split('\0');
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        let first = tokens.next().unwrap_or_default().to_owned();
        if status.starts_with('R') || status.starts_with('C') {
            files.push(ListedFile { path: tokens.next().unwrap_or_default().to_owned(), orig_path: Some(first) });
        } else {
            files.push(ListedFile { path: first, orig_path: None });
        }
    }
    files
}

/// The head of bytes that fits the limit, cut at the last line end inside it when there is one.
pub(crate) fn cut_at_line(bytes: &[u8], limit: usize) -> &[u8] {
    if bytes.len() <= limit {
        return bytes;
    }
    let head = &bytes[..limit];
    match head.iter().rposition(|b| *b == b'\n') {
        Some(nl) if nl > 0 => &head[..=nl],
        _ => head,
    }
}

/// One name-status pass picks the files (so renames stay renames), then one diff per file spends a shared byte
/// budget; a file past the budget is still listed with an empty patch so the client knows it changed. path narrows
/// relative to cwd; per-file pathspecs use :(top) because git reports names from the repo root whatever cwd is.
pub(crate) async fn git_diff<R: Runs>(
    runner: &R,
    cwd: &Path,
    scope: GitDiffScope,
    path: Option<&str>,
    cap: usize,
) -> Result<GitDiffReply, OpError> {
    let mut args: Vec<String> = Vec::new();
    let mut base = None;
    match scope {
        GitDiffScope::Staged => args.push("--cached".to_owned()),
        GitDiffScope::Branch => {
            base = default_branch(runner, cwd).await?;
            match &base {
                None => args.push("HEAD".to_owned()),
                Some(base) => {
                    let mb = run_git(runner, cwd, &["merge-base", base, "HEAD"], None, None).await?;
                    check(&mb, "merge-base")?;
                    args.push(if mb.code == Some(0) { stdout_text(&mb).trim().to_owned() } else { "HEAD".to_owned() });
                }
            }
        }
        GitDiffScope::Unstaged => {}
    }
    let mut list_args: Vec<&str> = vec!["diff"];
    list_args.extend(args.iter().map(String::as_str));
    list_args.extend(["-M", "--name-status", "-z"]);
    if let Some(path) = path {
        list_args.extend(["--", path]);
    }
    let listed = run_git(runner, cwd, &list_args, None, None).await?;
    check(&listed, "diff --name-status")?;
    if listed.code != Some(0) {
        return Err(OpError::plain(format!("git diff --name-status failed: {}", listed.stderr.trim())));
    }
    let mut files = Vec::new();
    let mut remaining = cap;
    let mut truncated = false;
    for file in parse_name_status(&stdout_text(&listed)) {
        if remaining == 0 {
            truncated = true;
            files.push(GitDiffFile { path: file.path, patch: String::new() });
            continue;
        }
        let specs: Vec<String> = file.orig_path.iter().chain([&file.path]).map(|p| format!(":(top){p}")).collect();
        let mut diff_args: Vec<&str> = vec!["diff"];
        diff_args.extend(args.iter().map(String::as_str));
        diff_args.extend(["-M", "--no-color", "--no-ext-diff", "--"]);
        diff_args.extend(specs.iter().map(String::as_str));
        let res = run_git(runner, cwd, &diff_args, None, Some(remaining)).await?;
        check(&res, "diff")?;
        let mut bytes = res.stdout.as_slice();
        if res.truncated || bytes.len() > remaining {
            truncated = true;
            bytes = cut_at_line(bytes, remaining);
            remaining = 0;
        } else {
            remaining -= bytes.len();
        }
        files.push(GitDiffFile { path: file.path, patch: utf8_text(bytes, true) });
    }
    Ok(GitDiffReply { base, files, truncated })
}

/// A way of running that records what it was asked and answers what a case told it to, for the cases that read
/// what the halves above hand a runner without a git, a gh or a workspace anywhere.
#[cfg(test)]
pub(crate) mod recorded {
    use std::path::Path;
    use std::sync::Mutex;

    use super::{GitResult, Runs};
    use crate::paths::OpError;

    /// One call a way of running was asked to make: where it was to run, the program, its arguments and its stdin.
    #[derive(Clone)]
    pub(crate) struct Call {
        pub(crate) cwd: String,
        pub(crate) program: String,
        pub(crate) args: Vec<String>,
        pub(crate) stdin: Option<Vec<u8>>,
    }

    pub(crate) struct Recorded {
        pub(crate) calls: Mutex<Vec<Call>>,
        pub(crate) answers: Mutex<Vec<GitResult>>,
        pub(crate) has: Vec<String>,
    }

    impl Recorded {
        pub(crate) fn new(has: &[&str]) -> Recorded {
            Recorded { calls: Mutex::new(Vec::new()), answers: Mutex::new(Vec::new()), has: has.iter().map(|w| (*w).to_owned()).collect() }
        }

        /// What the next call answers with, in the order they are given.
        pub(crate) fn answering(self, answers: Vec<(i32, &str)>) -> Recorded {
            self.answering_said(answers.into_iter().map(|(code, out)| (code, out, "")).collect())
        }

        /// The same, for the cases that read what a program said on stderr as well as what it exited with.
        pub(crate) fn answering_said(self, answers: Vec<(i32, &str, &str)>) -> Recorded {
            *self.answers.lock().unwrap() = answers
                .into_iter()
                .map(|(code, out, err)| GitResult {
                    code: Some(code),
                    stdout: out.as_bytes().to_vec(),
                    stderr: err.to_owned(),
                    truncated: false,
                })
                .collect();
            self
        }

        pub(crate) fn asked(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Runs for Recorded {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            _max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            self.calls.lock().unwrap().push(Call {
                cwd: cwd.to_string_lossy().into_owned(),
                program: program.to_owned(),
                args: args.iter().map(|a| (*a).to_owned()).collect(),
                stdin: input.map(<[u8]>::to_vec),
            });
            let mut answers = self.answers.lock().unwrap();
            Ok(if answers.is_empty() {
                GitResult { code: Some(0), stdout: Vec::new(), stderr: String::new(), truncated: false }
            } else {
                answers.remove(0)
            })
        }

        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            Ok(self.has.iter().any(|held| held == program))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::here::Here;
    use super::*;
    use wsp_frames::numbers;

    /// git as the daemon runs it on the computer it is, which is what every case below reads.
    fn here() -> Here {
        Here::new()
    }

    #[tokio::test]
    async fn every_git_call_carries_optional_locks_off_and_the_c_locale_and_runs_at_the_work_score() {
        let dir = tempfile::tempdir().unwrap();
        let alias = "!sh -c 'echo \"$GIT_OPTIONAL_LOCKS|$LC_ALL|$GIT_TERMINAL_PROMPT\"; cat /proc/self/oom_score_adj'";
        let res = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={alias}"), "probe"], None, None).await.unwrap();
        assert_eq!((res.code, res.truncated), (Some(0), false), "{}", res.stderr);
        assert_eq!(String::from_utf8_lossy(&res.stdout), format!("0|C|0\n{}\n", numbers::WORK_OOM_SCORE_ADJ));
    }

    #[tokio::test]
    async fn stdout_past_the_cap_ends_git_and_says_so_while_stdin_reaches_it() {
        let dir = tempfile::tempdir().unwrap();
        let echo = "!sh -c 'cat; yes | head -c 200000'";
        let res = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={echo}"), "probe"], Some(b"in\n"), Some(10)).await.unwrap();
        assert!(res.truncated);
        assert_eq!(res.code, None);
        assert!(res.stdout.starts_with(b"in\ny\n"), "{:?}", &res.stdout[..8]);
        let whole = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={echo}"), "probe"], Some(b"in\n"), None).await.unwrap();
        assert_eq!((whole.code, whole.truncated, whole.stdout.len()), (Some(0), false, 200_003));
    }

    #[tokio::test]
    async fn outside_a_repo_the_refusal_has_its_code_and_other_failures_name_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let err = git_status(&here(), dir.path()).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NotAGitRepo), "not inside a git repository"));
        let boom = "!sh -c 'echo boom >&2; exit 3'";
        let res = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={boom}"), "probe"], None, None).await.unwrap();
        let err = check(&res, "probe").unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (None, "git probe failed (3): boom"));
        let answered = run_git(&here(), dir.path(), &["-c", "alias.probe=!sh -c 'exit 1'", "probe"], None, None).await.unwrap();
        assert_eq!(check(&answered, "probe"), Ok(()));
    }

    fn entry(xy: &str, path: &str, orig: Option<&str>) -> GitStatusEntry {
        GitStatusEntry { xy: xy.to_owned(), path: path.to_owned(), orig_path: orig.map(str::to_owned) }
    }

    #[test]
    fn porcelain_v2_reads_the_branch_header_and_every_entry_kind() {
        let text = concat!(
            "# branch.oid 0123456789abcdef0123456789abcdef01234567\0",
            "# branch.head feature\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/index.ts\0",
            "1 A. N... 000000 100644 100644 0000 cccc staged.txt\0",
            "2 R. N... 100644 100644 100644 dddd dddd R100 docs.md\0README.md\0",
            "u UU N... 100644 100644 100644 100644 e1 e2 e3 both.txt\0",
            "? untracked.txt\0",
            "! ignored.log\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb with space.txt\0",
        );
        let (branch, entries) = parse_porcelain_v2(text);
        assert_eq!(
            branch,
            GitBranch {
                oid: "0123456789abcdef0123456789abcdef01234567".to_owned(),
                head: "feature".to_owned(),
                upstream: Some("origin/main".to_owned()),
                ahead: 2,
                behind: 1,
            }
        );
        assert_eq!(
            entries,
            vec![
                entry(".M", "src/index.ts", None),
                entry("A.", "staged.txt", None),
                entry("R.", "docs.md", Some("README.md")),
                entry("UU", "both.txt", None),
                entry("??", "untracked.txt", None),
                entry("!!", "ignored.log", None),
                entry(".M", "with space.txt", None),
            ]
        );
    }

    #[test]
    fn porcelain_v2_on_a_repo_without_commits_or_upstream_leaves_the_header_blank_and_the_counts_at_zero() {
        let (branch, entries) = parse_porcelain_v2("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(branch, GitBranch { oid: "(initial)".to_owned(), head: "main".to_owned(), upstream: None, ahead: 0, behind: 0 });
        assert!(entries.is_empty());
        let (blank, none) = parse_porcelain_v2("");
        assert_eq!(blank, GitBranch { oid: String::new(), head: String::new(), upstream: None, ahead: 0, behind: 0 });
        assert!(none.is_empty());
    }

    #[test]
    fn name_status_keeps_a_rename_and_a_copy_as_one_file_with_its_origin() {
        let files = parse_name_status("M\0src/index.ts\0R100\0README.md\0docs.md\0A\0staged.txt\0C075\0a.txt\0b.txt\0D\0gone.txt\0");
        assert_eq!(
            files,
            vec![
                ListedFile { path: "src/index.ts".to_owned(), orig_path: None },
                ListedFile { path: "docs.md".to_owned(), orig_path: Some("README.md".to_owned()) },
                ListedFile { path: "staged.txt".to_owned(), orig_path: None },
                ListedFile { path: "b.txt".to_owned(), orig_path: Some("a.txt".to_owned()) },
                ListedFile { path: "gone.txt".to_owned(), orig_path: None },
            ]
        );
        assert!(parse_name_status("").is_empty());
        assert_eq!(parse_name_status("M\0"), vec![ListedFile { path: String::new(), orig_path: None }]);
    }

    #[test]
    fn the_budget_cuts_at_the_last_line_end_inside_it_and_leaves_short_output_alone() {
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 100), b"one\ntwo\nthree\n");
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 9), b"one\ntwo\n");
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 8), b"one\ntwo\n");
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 7), b"one\n");
        assert_eq!(cut_at_line(b"no line end here", 5), b"no li");
        assert_eq!(cut_at_line(b"\nabc", 2), b"\na");
    }
}
