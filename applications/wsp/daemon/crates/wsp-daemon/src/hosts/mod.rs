// SPDX-License-Identifier: AGPL-3.0-only
//! Pull requests through the git host's own signed-in command line, which is what the image or the box carries:
//! wsp holds no token for a git host and speaks no host's API. One module per host, each saying which program it
//! runs, the argv for asking and for opening, and how to read that program's JSON; one registry keyed on the name
//! the remote's url carries. Adding GitLab is a module beside github.rs and one row in HOSTS.

use std::path::Path;

use wsp_frames::{words, DaemonErrorCode, GitPrReply, PullRequest};

use crate::git::Runs;
use crate::paths::OpError;

mod github;

/// One git host's command line, as data: what to run, what to run it with, and how to read what it answered.
pub(crate) trait PullRequests: Sync {
    /// The host name a remote's url carries for this module.
    fn host(&self) -> &'static str;
    /// The program every one of its lines runs, which is what a computer with no login for this host lacks.
    fn program(&self) -> &'static str;
    /// The line that answers with the branch's pull request as JSON, and refuses where there is none.
    fn find_argv(&self, branch: &str) -> Vec<String>;
    /// The line that opens one. A title turns into the pull request's own title and body; without one the host
    /// fills both from the commits, which is what an agent's branch usually wants said.
    fn create_argv(&self, base: &str, branch: &str, title: Option<&str>, body: Option<&str>) -> Vec<String>;
    /// The pull request one of those lines answered with, off its JSON and never its prose; nothing where the JSON
    /// is not one this module reads.
    fn read(&self, stdout: &str) -> Option<PullRequest>;
    /// The exit code that program answers with when it is there and nobody is signed in, where it has one of its
    /// own. Read off the code and not the sentence: a sentence is the program's to reword between releases.
    fn sign_in_exit(&self) -> Option<i32>;
    /// What gives this computer a git credential for the host, in the words of the one command only the person can
    /// run. Said beside a push refused for want of one; a host with no module here says none of it.
    fn credential_fix(&self) -> &'static str;
}

/// Every git host wsp knows a command line for.
const HOSTS: [&dyn PullRequests; 1] = [&github::GitHub];

/// The host name a remote's url carries: the authority of a url, or what stands before the colon in the scp form
/// every host also offers. A login and a port are no part of the name.
pub(crate) fn host_name(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    // A remote that is a folder is a remote with no host: a checkout pushed to a bare repository beside it has one.
    if url.starts_with('/') || url.starts_with('.') || url.starts_with('~') {
        return None;
    }
    let authority = match url.split_once("://") {
        Some((_, rest)) => rest.split(['/', ':']).next().unwrap_or_default(),
        None => url.split_once(':')?.0,
    };
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty() && host.contains('.')).then(|| host.to_ascii_lowercase())
}

/// The module for the host that remote lives on, or nothing where wsp knows no command line for it.
pub(crate) fn host_for(remote_url: &str) -> Option<&'static dyn PullRequests> {
    let name = host_name(remote_url)?;
    HOSTS.iter().copied().find(|h| h.host() == name)
}

/// What one pull request call is made against: the checkout as the way of running sees it, the remote that says
/// which host it is, and the branch. Where the command line is looked up and run is the runner's, not this ask's:
/// a workspace on a computer somebody owns runs its own gh, on its own PATH, inside itself.
pub(crate) struct Ask<'a> {
    pub(crate) cwd: &'a Path,
    pub(crate) remote_url: &'a str,
    pub(crate) branch: &'a str,
}

/// The module for this ask, refused in one sentence where the host is unknown or its command line is not on the
/// PATH the runner finds programs on: the two read the same to a person, and the push has already landed either way.
async fn cli_for<R: Runs>(runner: &R, ask: &Ask<'_>) -> Result<&'static dyn PullRequests, OpError> {
    let named = host_name(ask.remote_url).unwrap_or_else(|| ask.remote_url.to_owned());
    let refused = || OpError::coded(DaemonErrorCode::NoHostCli, words::no_host_cli(&named));
    let host = host_for(ask.remote_url).ok_or_else(refused)?;
    if !runner.on_path(host.program()).await? {
        return Err(refused());
    }
    Ok(host)
}

/// One host command line, run the way the runner runs a program: in the checkout, at the work score every command
/// of ours runs at, with nothing of the line interpolated into a shell.
///
/// A program that is there and answers its own not-signed-in code is the same refusal a program that is not there
/// at all is: the push has landed either way and the pull request waits for a signed-in command line. Decided
/// here, so looking one up and opening one answer it alike.
async fn run_cli<R: Runs>(
    runner: &R,
    host: &'static dyn PullRequests,
    ask: &Ask<'_>,
    args: &[String],
) -> Result<(Option<i32>, String, String), OpError> {
    let line: Vec<&str> = args.iter().map(String::as_str).collect();
    let done = runner.run(ask.cwd, host.program(), &line, None, None).await?;
    if done.code.is_some() && done.code == host.sign_in_exit() {
        return Err(OpError::coded(DaemonErrorCode::NoHostCli, words::no_host_cli(host.host())));
    }
    Ok((done.code, String::from_utf8_lossy(&done.stdout).into_owned(), done.stderr))
}

/// The branch's pull request as its host has it, or nothing where the host knows none: a line that refused is a
/// branch with no pull request, which is what every one of these hosts answers with.
pub(crate) async fn find<R: Runs>(runner: &R, ask: &Ask<'_>) -> Result<Option<PullRequest>, OpError> {
    let host = cli_for(runner, ask).await?;
    let (code, stdout, _) = run_cli(runner, host, ask, &host.find_argv(ask.branch)).await?;
    Ok(if code == Some(0) { host.read(&stdout) } else { None })
}

/// The branch's pull request, opened where the host has none. Read back through the same line that looks one up, so
/// the number and the state come off that command's JSON rather than off what it printed when it opened one.
pub(crate) async fn open<R: Runs>(
    runner: &R,
    ask: &Ask<'_>,
    base: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<GitPrReply, OpError> {
    if let Some(pr) = find(runner, ask).await? {
        return Ok(GitPrReply { pr, created: false });
    }
    let host = cli_for(runner, ask).await?;
    let (code, stdout, stderr) = run_cli(runner, host, ask, &host.create_argv(base, ask.branch, title, body)).await?;
    if code != Some(0) {
        let said = stderr.trim();
        return Err(OpError::plain(format!("{} said: {}", host.program(), if said.is_empty() { stdout.trim() } else { said })));
    }
    match find(runner, ask).await? {
        Some(pr) => Ok(GitPrReply { pr, created: true }),
        None => Err(OpError::plain(format!("{} opened the pull request and then answered with none for {}", host.program(), ask.branch))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::here::Here;
    use crate::git::recorded::Recorded;

    #[test]
    fn the_host_name_is_read_off_a_url_and_off_the_scp_form_alike() {
        for url in
            ["git@github.com:o/r.git", "https://github.com/o/r", "https://user@github.com:443/o/r.git", "ssh://git@GitHub.com/o/r.git"]
        {
            assert_eq!(host_name(url).as_deref(), Some("github.com"), "{url}");
        }
        assert_eq!(host_name("git@gitlab.example.com:o/r.git").as_deref(), Some("gitlab.example.com"));
        // A path with no host in it names no host: a remote that is a folder beside the checkout is one.
        assert_eq!(host_name("/srv/mirrors/r.git"), None);
        assert_eq!(host_name("../origin.git"), None);
        assert_eq!(host_name("origin.git"), None);
    }

    #[test]
    fn the_registry_answers_for_github_by_either_form_and_for_no_other_host() {
        assert!(host_for("git@github.com:o/r.git").is_some());
        assert!(host_for("https://github.com/o/r").is_some());
        assert!(host_for("git@gitlab.com:o/r.git").is_none());
        assert!(host_for("/srv/mirrors/r.git").is_none());
    }

    /// A gh that records every word it was given and answers about the one pull request it holds, so the two roads
    /// through this module are read without a login or a network.
    fn fake_gh() -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("wsp-fake-gh-").tempdir().unwrap();
        let at = dir.path().join("gh");
        std::fs::write(
            &at,
            concat!(
                "#!/bin/sh\n",
                "dir=$(dirname \"$0\")\n",
                "for word in \"$@\"; do printf '%s\\n' \"$word\" >> \"$dir/argv\"; done\n",
                "printf -- '--\\n' >> \"$dir/argv\"\n",
                "case \"$2\" in\n",
                "  view) if [ -f \"$dir/pr.json\" ]; then cat \"$dir/pr.json\"; exit 0; fi\n",
                "        echo 'no pull requests found for branch' >&2; exit 1;;\n",
                "  create) printf '%s' '{\"number\":7,\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\"}' > \"$dir/pr.json\"\n",
                "        echo https://github.com/o/r/pull/7; exit 0;;\n",
                "esac\n",
                "exit 2\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        dir
    }

    /// The computer as a case runs it: the fake gh first on the PATH, then this computer's own, since the script
    /// itself runs dirname and cat and a PATH of one directory would leave it without them.
    fn with_gh(dir: &tempfile::TempDir) -> Here {
        Here::on(&format!("{}:{}", dir.path().to_string_lossy(), std::env::var("PATH").unwrap_or_default()))
    }

    /// The words that fake gh was given, one call per inner list.
    fn argv_of(dir: &tempfile::TempDir) -> Vec<Vec<String>> {
        let text = std::fs::read_to_string(dir.path().join("argv")).unwrap_or_default();
        text.split("--\n").filter(|call| !call.trim().is_empty()).map(|call| call.lines().map(str::to_owned).collect()).collect()
    }

    #[tokio::test]
    async fn the_pull_request_is_opened_once_and_found_the_next_time() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        let ask = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git", branch: "work" };
        assert_eq!(find(&runner, &ask).await.unwrap(), None);
        let opened = open(&runner, &ask, "main", None, None).await.unwrap();
        assert_eq!((opened.created, opened.pr.number, opened.pr.state), (true, 7, wsp_frames::PullRequestState::Open));
        assert_eq!(opened.pr.url, "https://github.com/o/r/pull/7");
        let again = open(&runner, &ask, "main", None, None).await.unwrap();
        assert_eq!((again.created, again.pr.number), (false, 7));
        assert_eq!(find(&runner, &ask).await.unwrap().unwrap().number, 7);
        let calls = argv_of(&gh);
        assert_eq!(calls.iter().filter(|c| c.get(1).is_some_and(|w| w == "create")).count(), 1, "{calls:?}");
        assert_eq!(calls[2], ["pr", "create", "--base", "main", "--head", "work", "--fill"]);
        assert_eq!(calls[0], ["pr", "view", "work", "--json", "number,url,state"]);
        // The open looks first and reads the pull request back off the same line afterwards, so the number and the
        // state come off gh's JSON and never off what it printed when it opened one.
        assert_eq!(calls.iter().filter(|c| c.get(1).is_some_and(|w| w == "view")).count(), 5, "{calls:?}");
    }

    #[tokio::test]
    async fn a_title_rides_the_line_that_opens_it() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        let ask = Ask { cwd: gh.path(), remote_url: "https://github.com/o/r", branch: "work" };
        open(&runner, &ask, "main", Some("a title"), Some("a body")).await.unwrap();
        assert_eq!(argv_of(&gh)[1], ["pr", "create", "--base", "main", "--head", "work", "--title", "a title", "--body", "a body"]);
    }

    /// The pull request half runs the host's command line through the way of running it was handed, in the
    /// checkout that way sees: on a workspace of a computer somebody owns that is a gh inside the workspace, signed
    /// in with what that computer holds, and never a gh of the daemon's own.
    #[tokio::test]
    async fn the_host_command_line_runs_through_the_way_it_was_handed() {
        let runner = Recorded::new(&["gh"]).answering(vec![
            (1, ""),
            (0, "https://github.com/o/r/pull/7\n"),
            (0, "{\"number\":7,\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\"}"),
        ]);
        let ask = Ask { cwd: Path::new("/private/tmp/proof/repo"), remote_url: "git@github.com:o/r.git", branch: "work" };
        let opened = open(&runner, &ask, "main", Some("a title"), Some("a body")).await.unwrap();
        assert_eq!((opened.created, opened.pr.number), (true, 7));
        let calls = runner.asked();
        assert!(calls.iter().all(|call| call.cwd == "/private/tmp/proof/repo" && call.program == "gh"), "a call ran somewhere else");
        assert_eq!(calls[0].args, ["pr", "view", "work", "--json", "number,url,state"]);
        assert_eq!(calls[1].args, ["pr", "create", "--base", "main", "--head", "work", "--title", "a title", "--body", "a body"]);
        // And a way of running whose PATH holds no gh is the note beside a landed push, whatever the host is.
        let bare = Recorded::new(&[]);
        let err = open(&bare, &ask, "main", None, None).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("github.com").as_str()));
        assert!(bare.asked().is_empty(), "a computer with no gh ran something");
    }

    /// What gh prints on a box it is on and nobody has signed it in, measured on spoo on 2026-09-18: its own
    /// authentication-required code, and a sentence it is free to reword, which is why the code is what is read.
    const SIGN_IN_SAID: &str = "To get started with GitHub CLI, please run:  gh auth login";

    #[tokio::test]
    async fn a_gh_that_is_there_and_not_signed_in_reads_as_a_gh_that_is_not_there() {
        let ask = Ask { cwd: Path::new("/private/tmp/proof/repo"), remote_url: "git@github.com:o/r.git", branch: "work" };
        // Looking one up and opening one answer alike, and the open never reaches its create.
        let looked = Recorded::new(&["gh"]).answering_said(vec![(4, "", SIGN_IN_SAID)]);
        let found = find(&looked, &ask).await.unwrap_err();
        assert_eq!((found.code, found.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("github.com").as_str()));
        let runner = Recorded::new(&["gh"]).answering_said(vec![(4, "", SIGN_IN_SAID), (4, "", SIGN_IN_SAID)]);
        let opened = open(&runner, &ask, "main", None, None).await.unwrap_err();
        assert_eq!((opened.code, opened.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("github.com").as_str()));
        let calls = runner.asked();
        assert_eq!(calls.len(), 1, "a gh nobody is signed in on was asked to create a pull request");
        assert_eq!(calls[0].args, ["pr", "view", "work", "--json", "number,url,state"]);
    }

    #[tokio::test]
    async fn a_gh_that_refused_for_any_other_reason_still_says_what_it_said() {
        let ask = Ask { cwd: Path::new("/private/tmp/proof/repo"), remote_url: "git@github.com:o/r.git", branch: "work" };
        let runner = Recorded::new(&["gh"])
            .answering_said(vec![(1, "", "no pull requests found for branch"), (1, "", "could not create pull request")]);
        let refused = open(&runner, &ask, "main", None, None).await.unwrap_err();
        assert_eq!(refused.code, None);
        assert_eq!(refused.message, "gh said: could not create pull request");
        // And a branch with no pull request is still a branch with no pull request rather than a refusal.
        let quiet = Recorded::new(&["gh"]).answering_said(vec![(1, "", "no pull requests found for branch")]);
        assert_eq!(find(&quiet, &ask).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_computer_with_no_command_line_for_the_host_says_the_pull_request_waits() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        // A computer whose PATH holds no gh at all: the module is known and the program is not there.
        let bare = Here::on("");
        let nowhere = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git", branch: "work" };
        for err in [find(&bare, &nowhere).await.unwrap_err(), open(&bare, &nowhere, "main", None, None).await.unwrap_err()] {
            assert_eq!(err.code, Some(DaemonErrorCode::NoHostCli));
            assert_eq!(err.message, words::no_host_cli("github.com"));
        }
        // A host no module here answers for reads the same: the push landed and the pull request waits for a line.
        let elsewhere = Ask { cwd: gh.path(), remote_url: "git@gitlab.com:o/r.git", branch: "work" };
        let err = open(&runner, &elsewhere, "main", None, None).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("gitlab.com").as_str()));
        assert!(argv_of(&gh).is_empty());
    }
}
