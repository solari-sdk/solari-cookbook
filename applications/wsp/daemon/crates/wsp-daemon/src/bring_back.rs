// SPDX-License-Identifier: AGPL-3.0-only
//! Work leaves a workspace through git and nothing else: the branch the agent made is pushed to the project's
//! remote, and the branch the work started from is never pushed at all.

use std::path::Path;

use wsp_frames::{words, GitPushReply};

use crate::git::{check, default_branch, parse_porcelain_v2, rev_exists, run_git, stdout_text, Runs};
use crate::paths::OpError;

/// Files of the diffstat one push carries; past it git prints its own "N more files" line and the reply stays a
/// thing a person reads rather than a whole tree.
const STAT_FILES: &str = "--stat-count=50";

/// The remote a push goes to: origin where there is one, else the first the checkout names.
async fn remote_name<R: Runs>(runner: &R, cwd: &Path) -> Result<String, OpError> {
    let listed = run_git(runner, cwd, &["remote"], None, None).await?;
    check(&listed, "remote")?;
    let text = stdout_text(&listed);
    let mut names = text.lines().map(str::trim).filter(|n| !n.is_empty());
    let first = names.next().map(str::to_owned);
    match first {
        None => Err(OpError::plain(words::NO_REMOTE)),
        Some(one) => Ok(if text.lines().any(|n| n.trim() == "origin") { "origin".to_owned() } else { one }),
    }
}

/// Where that remote points, which is what says which git host this project lives on.
pub(crate) async fn remote_url<R: Runs>(runner: &R, cwd: &Path) -> Result<(String, String), OpError> {
    let name = remote_name(runner, cwd).await?;
    let url = run_git(runner, cwd, &["remote", "get-url", &name], None, None).await?;
    check(&url, "remote get-url")?;
    Ok((name, stdout_text(&url).trim().to_owned()))
}

/// The branch this checkout is on; a detached head is on none, and there is nothing to bring back from one.
pub(crate) async fn branch_at<R: Runs>(runner: &R, cwd: &Path) -> Result<String, OpError> {
    let head = run_git(runner, cwd, &["symbolic-ref", "-q", "--short", "HEAD"], None, None).await?;
    check(&head, "symbolic-ref")?;
    let branch = stdout_text(&head).trim().to_owned();
    if head.code != Some(0) || branch.is_empty() {
        return Err(OpError::plain(words::NOT_ON_A_BRANCH));
    }
    Ok(branch)
}

/// The branch the work started from when the caller named none: what the remote says its default is, read as the
/// branch's own name rather than the remote's word for it, else a main or a master here. A checkout with none is
/// measured against nothing, and every commit on it is ahead.
pub(crate) async fn base_of<R: Runs>(runner: &R, cwd: &Path, remote: &str, named: Option<&str>) -> Result<String, OpError> {
    if let Some(base) = named {
        return Ok(base.to_owned());
    }
    let read = default_branch(runner, cwd).await?;
    Ok(read.map_or_else(String::new, |b| b.strip_prefix(&format!("{remote}/")).unwrap_or(&b).to_owned()))
}

/// The branch a bring back would carry: the one this checkout is on, refused when it is the base itself. One home
/// for the rule, so the push and the pull request refuse the base alike.
pub(crate) async fn head_for<R: Runs>(runner: &R, cwd: &Path, base: &str) -> Result<String, OpError> {
    let branch = branch_at(runner, cwd).await?;
    if branch == base {
        return Err(OpError::plain(words::on_base_refusal(base)));
    }
    Ok(branch)
}

/// What the ahead count and the diffstat are measured from: the base branch here, else the remote's copy of it.
/// Neither, on a checkout whose base has never been fetched, leaves every commit of the branch ahead.
async fn base_ref<R: Runs>(runner: &R, cwd: &Path, remote: &str, base: &str) -> Result<Option<String>, OpError> {
    for rev in [base.to_owned(), format!("{remote}/{base}")] {
        if rev_exists(runner, cwd, &rev).await? {
            return Ok(Some(rev));
        }
    }
    Ok(None)
}

/// How many commits the branch has that the base lacks.
async fn ahead_of<R: Runs>(runner: &R, cwd: &Path, from: Option<&str>) -> Result<u64, OpError> {
    let range = from.map_or_else(|| "HEAD".to_owned(), |base| format!("{base}..HEAD"));
    let counted = run_git(runner, cwd, &["rev-list", "--count", &range], None, None).await?;
    check(&counted, "rev-list")?;
    Ok(stdout_text(&counted).trim().parse().unwrap_or(0))
}

/// Changes in the checkout that no commit holds, ignored files apart: what a person is told they are leaving behind.
async fn uncommitted<R: Runs>(runner: &R, cwd: &Path) -> Result<u64, OpError> {
    let status = run_git(runner, cwd, &["status", "--porcelain=v2", "--branch", "-z"], None, None).await?;
    check(&status, "status")?;
    let (_, entries) = parse_porcelain_v2(&stdout_text(&status));
    Ok(entries.iter().filter(|e| e.xy != "!!").count() as u64)
}

/// The diffstat of what the branch carries over the base, git's own lines; empty where the base is not here to
/// measure against.
async fn stat_over<R: Runs>(runner: &R, cwd: &Path, from: Option<&str>) -> Result<Vec<String>, OpError> {
    let Some(base) = from else { return Ok(Vec::new()) };
    let range = format!("{base}...HEAD");
    let diffed = run_git(runner, cwd, &["diff", "--stat", STAT_FILES, &range], None, None).await?;
    check(&diffed, "diff --stat")?;
    Ok(stdout_text(&diffed).lines().map(|l| l.trim_end().to_owned()).filter(|l| !l.is_empty()).collect())
}

/// What git says when it wanted an https credential and had none: the prompt it was refused by GIT_TERMINAL_PROMPT
/// and the two answers a host gives a request with no credential on it. A key an ssh remote wants is not here: it
/// wants a key on this computer and not a signed-in command line, so git's own line rides as it always has.
const NO_CREDENTIAL_SAID: [&str; 3] = ["could not read Username", "terminal prompts disabled", "Authentication failed for"];

/// The sentence a push refused for want of a credential is refused with, or nothing where git refused it for some
/// other reason. The remote's host names itself and its own module names the fix, so a host wsp knows no command
/// line for is not told to run gh; a remote that is a folder beside the checkout has no host and no credential to
/// want, whatever it said.
async fn no_credential<R: Runs>(runner: &R, cwd: &Path, remote: &str, said: &str) -> Result<Option<String>, OpError> {
    if !NO_CREDENTIAL_SAID.iter().any(|mark| said.contains(mark)) {
        return Ok(None);
    }
    let url = run_git(runner, cwd, &["remote", "get-url", remote], None, None).await?;
    let Some(host) = crate::hosts::host_name(stdout_text(&url).trim()) else { return Ok(None) };
    let fix = crate::hosts::host_for(stdout_text(&url).trim()).map(|module| module.credential_fix());
    Ok(Some(words::no_git_credential(&host, fix)))
}

/// Pushes the branch this checkout is on, with the base guard ahead of it and the counts a person reads beside it.
pub(crate) async fn push<R: Runs>(runner: &R, cwd: &Path, named: Option<&str>) -> Result<GitPushReply, OpError> {
    let remote = remote_name(runner, cwd).await?;
    let base = base_of(runner, cwd, &remote, named).await?;
    let branch = head_for(runner, cwd, &base).await?;
    let from = base_ref(runner, cwd, &remote, &base).await?;
    let ahead = ahead_of(runner, cwd, from.as_deref()).await?;
    if ahead == 0 {
        return Err(OpError::plain(words::nothing_ahead(&branch, &base)));
    }
    let left = uncommitted(runner, cwd).await?;
    let stat = stat_over(runner, cwd, from.as_deref()).await?;
    let pushed = run_git(runner, cwd, &["push", "-u", &remote, &branch], None, None).await?;
    if pushed.code != Some(0) {
        if let Some(refusal) = no_credential(runner, cwd, &remote, &pushed.stderr).await? {
            return Err(OpError::plain(refusal));
        }
        let said = pushed.stderr.trim();
        return Err(OpError::plain(format!("git push failed: {}", if said.is_empty() { stdout_text(&pushed) } else { said.to_owned() })));
    }
    Ok(GitPushReply { branch, base, remote, ahead, uncommitted: left, stat })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;
    use crate::git::here::Here;
    use crate::git::recorded::Recorded;

    /// git on this computer, as every case here runs it: the road the daemon takes for every machine but a
    /// workspace on a computer somebody owns.
    fn here() -> Here {
        Here::new()
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@x")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    /// A checkout on main with one commit, its own bare origin beside it, and main pushed there.
    struct Repo {
        dir: tempfile::TempDir,
    }

    impl Repo {
        fn new() -> Repo {
            let dir = tempfile::Builder::new().prefix("wsp-bring-back-").tempdir().unwrap();
            let repo = dir.path().join("work");
            let origin = dir.path().join("origin.git");
            std::fs::create_dir_all(&repo).unwrap();
            git(dir.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "commit.gpgsign", "false"]);
            std::fs::write(repo.join("README.md"), "# readme\n").unwrap();
            git(&repo, &["add", "-A"]);
            git(&repo, &["commit", "-q", "-m", "first"]);
            git(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
            git(&repo, &["push", "-q", "-u", "origin", "main"]);
            Repo { dir }
        }

        fn at(&self) -> PathBuf {
            self.dir.path().join("work")
        }

        fn origin(&self) -> PathBuf {
            self.dir.path().join("origin.git")
        }

        fn commit(&self, name: &str) {
            std::fs::write(self.at().join(name), "x\n").unwrap();
            git(&self.at(), &["add", name]);
            git(&self.at(), &["commit", "-q", "-m", name]);
        }
    }

    #[tokio::test]
    async fn a_push_from_the_base_branch_names_the_base_and_pushes_nothing() {
        let repo = Repo::new();
        repo.commit("on-main.txt");
        let err = push(&here(), &repo.at(), Some("main")).await.unwrap_err();
        assert_eq!(err.message, words::on_base_refusal("main"));
        let landed = git(&repo.origin(), &["rev-parse", "main"]);
        assert_eq!(landed.trim(), git(&repo.at(), &["rev-parse", "HEAD~1"]).trim());
    }

    #[tokio::test]
    async fn a_checkout_on_no_branch_says_there_is_nothing_to_bring_back_yet() {
        let repo = Repo::new();
        repo.commit("one.txt");
        git(&repo.at(), &["checkout", "-q", "--detach", "HEAD"]);
        assert_eq!(push(&here(), &repo.at(), Some("main")).await.unwrap_err().message, words::NOT_ON_A_BRANCH);
    }

    #[tokio::test]
    async fn a_branch_the_base_already_holds_every_commit_of_is_refused_by_name() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "quiet"]);
        assert_eq!(push(&here(), &repo.at(), Some("main")).await.unwrap_err().message, words::nothing_ahead("quiet", "main"));
    }

    #[tokio::test]
    async fn a_branch_ahead_is_pushed_with_its_upstream_and_the_reply_counts_what_travelled() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        repo.commit("two.txt");
        std::fs::write(repo.at().join("dirty.txt"), "not committed\n").unwrap();
        let reply = push(&here(), &repo.at(), Some("main")).await.unwrap();
        assert_eq!((reply.branch.as_str(), reply.base.as_str(), reply.remote.as_str()), ("work", "main", "origin"));
        assert_eq!((reply.ahead, reply.uncommitted), (2, 1));
        assert!(reply.stat.iter().any(|l| l.contains("one.txt")), "{:?}", reply.stat);
        assert!(reply.stat.last().is_some_and(|l| l.contains("2 files changed")), "{:?}", reply.stat);
        assert_eq!(git(&repo.origin(), &["rev-parse", "work"]).trim(), git(&repo.at(), &["rev-parse", "HEAD"]).trim());
        // -u is what the push carried, so the next one from inside the workspace needs no remote named.
        assert_eq!(git(&repo.at(), &["rev-parse", "--abbrev-ref", "work@{upstream}"]).trim(), "origin/work");
    }

    #[tokio::test]
    async fn a_checkout_with_nowhere_to_push_says_so() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        git(&repo.at(), &["remote", "remove", "origin"]);
        assert_eq!(push(&here(), &repo.at(), Some("main")).await.unwrap_err().message, words::NO_REMOTE);
    }

    #[tokio::test]
    async fn the_base_is_measured_against_the_remote_copy_where_the_branch_is_not_here() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        git(&repo.at(), &["branch", "-q", "-D", "main"]);
        let reply = push(&here(), &repo.at(), Some("main")).await.unwrap();
        assert_eq!((reply.ahead, reply.base.as_str()), (1, "main"));
    }

    #[tokio::test]
    async fn a_push_that_names_no_base_takes_the_branch_the_checkout_reads_as_its_default() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        let reply = push(&here(), &repo.at(), None).await.unwrap();
        assert_eq!((reply.base.as_str(), reply.ahead), ("main", 1));
        // And on that default branch itself the guard still fires, which is the whole reason the base is read.
        git(&repo.at(), &["switch", "-q", "main"]);
        repo.commit("two.txt");
        assert_eq!(push(&here(), &repo.at(), None).await.unwrap_err().message, words::on_base_refusal("main"));
    }

    /// Every git a push runs goes through the way of running it was handed, in the checkout that way sees, and the
    /// push runs nothing else: a workspace on a computer somebody owns is served by this daemon, and its git runs
    /// inside it rather than as root on the computer.
    #[tokio::test]
    async fn a_push_runs_every_git_through_the_way_it_was_handed_and_nothing_of_its_own() {
        let runner = Recorded::new(&[]).answering(vec![
            (0, "origin\n"),                                      // remote
            (0, "main\n"),                                        // the base the checkout reads as its default
            (0, "work\n"),                                        // the branch HEAD is on
            (0, "0123456789abcdef\n"),                            // the base is here to measure against
            (0, "2\n"),                                           // commits ahead
            (0, "# branch.head work\0"),                          // nothing uncommitted
            (0, " README.md | 2 +-\n"),                           // the diffstat
            (0, "branch 'work' set up to track 'origin/work'\n"), // the push itself
        ]);
        let reply = push(&runner, Path::new("/private/tmp/proof/repo"), None).await.unwrap();
        assert_eq!((reply.branch.as_str(), reply.base.as_str(), reply.remote.as_str(), reply.ahead), ("work", "main", "origin", 2));
        let calls = runner.asked();
        // Every call: git, in the checkout the caller named, and never a program or a folder of the daemon's own.
        assert!(calls.iter().all(|call| call.cwd == "/private/tmp/proof/repo" && call.program == "git"), "a call ran somewhere else");
        assert_eq!(calls.first().map(|call| call.args.clone()), Some(vec!["remote".to_owned()]));
        assert_eq!(
            calls.last().map(|call| call.args.clone()),
            Some(vec!["push".to_owned(), "-u".to_owned(), "origin".to_owned(), "work".to_owned()])
        );
        // And nothing was fed on stdin: a push carries its words and reads nothing from this end.
        assert!(calls.iter().all(|call| call.stdin.is_none()), "a git call was fed stdin");
        assert_eq!(calls.len(), 8);
    }

    /// The eight answers a push reads before it pushes, in order, with the push's own answer and whatever comes
    /// after it handed in: the remote, the base, the branch, the base ref, the count ahead, the status, the
    /// diffstat, then the push.
    fn push_answering(after: Vec<(i32, &str, &str)>) -> Recorded {
        let mut answers = vec![
            (0, "origin\n", ""),
            (0, "main\n", ""),
            (0, "work\n", ""),
            (0, "0123456789abcdef\n", ""),
            (0, "2\n", ""),
            (0, "# branch.head work\0", ""),
            (0, " README.md | 2 +-\n", ""),
        ];
        answers.extend(after);
        Recorded::new(&[]).answering_said(answers)
    }

    /// What git printed on a box with no git credential, measured on spoo on 2026-09-18.
    const NO_USERNAME: &str = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

    #[tokio::test]
    async fn a_push_git_refused_for_want_of_a_credential_says_so_in_the_persons_words_with_the_hosts_own_fix() {
        let runner = push_answering(vec![(128, "", NO_USERNAME), (0, "https://github.com/o/r.git\n", "")]);
        let refused = push(&runner, Path::new("/private/tmp/proof/repo"), None).await.unwrap_err();
        let fix = crate::hosts::host_for("https://github.com/o/r.git").unwrap().credential_fix();
        assert_eq!(refused.message, words::no_git_credential("github.com", Some(fix)));
        // The words a person reads name the host and the commands only they can run, and say nothing landed.
        assert!(refused.message.contains("gh auth login"), "{}", refused.message);
        assert!(refused.message.contains("nothing was pushed"), "{}", refused.message);
        // The remote's url is read only where the push was refused for a credential: the happy road runs eight.
        assert_eq!(runner.asked().len(), 9);
        assert_eq!(runner.asked()[8].args, ["remote", "get-url", "origin"]);

        // The other two sentences a host with no credential on the request answers with read the same way.
        for said in [
            "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
            "fatal: terminal prompts disabled",
        ] {
            let runner = push_answering(vec![(128, "", said), (0, "https://github.com/o/r.git\n", "")]);
            assert_eq!(
                push(&runner, Path::new("/private/tmp/proof/repo"), None).await.unwrap_err().message,
                words::no_git_credential("github.com", Some(fix))
            );
        }
    }

    #[tokio::test]
    async fn a_host_wsp_knows_no_command_line_for_is_told_no_command_to_run_and_a_folder_remote_reads_as_git_did() {
        // A host with no module here: the sentence names the host and stops, rather than naming gh's commands.
        let runner = push_answering(vec![(128, "", NO_USERNAME), (0, "https://gitlab.example.com/o/r.git\n", "")]);
        let refused = push(&runner, Path::new("/private/tmp/proof/repo"), None).await.unwrap_err();
        assert_eq!(refused.message, words::no_git_credential("gitlab.example.com", None));
        assert!(!refused.message.contains("gh"), "{}", refused.message);
        // A remote that is a folder beside the checkout has no host and no credential to want.
        let folder = push_answering(vec![(128, "", NO_USERNAME), (0, "/srv/mirrors/r.git\n", "")]);
        assert!(push(&folder, Path::new("/private/tmp/proof/repo"), None).await.unwrap_err().message.starts_with("git push failed: "));
    }

    #[tokio::test]
    async fn a_key_an_ssh_remote_wants_and_every_other_refusal_ride_gits_own_line() {
        // A key on the box is not a signed-in command line, so this one is not in the matcher at all.
        for said in ["git@github.com: Permission denied (publickey).", "error: failed to push some refs to 'origin'"] {
            let runner = push_answering(vec![(128, "", said)]);
            let refused = push(&runner, Path::new("/private/tmp/proof/repo"), None).await.unwrap_err();
            assert_eq!(refused.message, format!("git push failed: {said}"));
            // Nothing beyond the push was asked: the url is read for the credential sentence alone.
            assert_eq!(runner.asked().len(), 8);
        }
    }

    #[tokio::test]
    async fn the_remote_is_origin_where_there_is_one_and_the_first_named_otherwise() {
        let repo = Repo::new();
        assert_eq!(remote_url(&here(), &repo.at()).await.unwrap().0, "origin");
        git(&repo.at(), &["remote", "rename", "origin", "elsewhere"]);
        let (name, url) = remote_url(&here(), &repo.at()).await.unwrap();
        assert_eq!(name, "elsewhere");
        assert!(url.ends_with("origin.git"), "{url}");
    }
}
