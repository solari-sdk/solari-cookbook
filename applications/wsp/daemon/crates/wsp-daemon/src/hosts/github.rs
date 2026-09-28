// SPDX-License-Identifier: AGPL-3.0-only
//! GitHub through gh, the command line the image signs in once: `gh pr view --json` for what is there and
//! `gh pr create` for what is not, both run in the checkout so gh reads the repository off its remote.

use serde::Deserialize;
use wsp_frames::{PullRequest, PullRequestState};

use super::PullRequests;

pub(crate) struct GitHub;

/// The fields gh is asked for, in gh's own spelling.
const FIELDS: &str = "number,url,state";

/// gh's JSON for one pull request; its state is the API's word in capitals.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    url: String,
    state: String,
}

fn state_of(word: &str) -> Option<PullRequestState> {
    match word.to_ascii_uppercase().as_str() {
        "OPEN" => Some(PullRequestState::Open),
        "MERGED" => Some(PullRequestState::Merged),
        "CLOSED" => Some(PullRequestState::Closed),
        _ => None,
    }
}

impl PullRequests for GitHub {
    fn host(&self) -> &'static str {
        "github.com"
    }

    fn program(&self) -> &'static str {
        "gh"
    }

    fn find_argv(&self, branch: &str) -> Vec<String> {
        ["pr", "view", branch, "--json", FIELDS].iter().map(|w| (*w).to_owned()).collect()
    }

    fn create_argv(&self, base: &str, branch: &str, title: Option<&str>, body: Option<&str>) -> Vec<String> {
        let mut argv: Vec<String> = ["pr", "create", "--base", base, "--head", branch].iter().map(|w| (*w).to_owned()).collect();
        match title {
            Some(title) => argv.extend(["--title".to_owned(), title.to_owned(), "--body".to_owned(), body.unwrap_or_default().to_owned()]),
            None => argv.push("--fill".to_owned()),
        }
        argv
    }

    fn read(&self, stdout: &str) -> Option<PullRequest> {
        let read: GhPullRequest = serde_json::from_str(stdout.trim()).ok()?;
        Some(PullRequest { number: read.number, url: read.url, state: state_of(&read.state)?, host: self.host().to_owned() })
    }

    fn sign_in_exit(&self) -> Option<i32> {
        Some(AUTH_REQUIRED)
    }

    fn credential_fix(&self) -> &'static str {
        CREDENTIAL_FIX
    }
}

/// gh's own code for authentication required, which it has printed since its 2.0 line and which every one of its
/// lines answers with on a computer nobody has signed it in on.
const AUTH_REQUIRED: i32 = 4;

/// The two lines only the person at that computer can run: the sign-in, and the one that hands git the credential
/// gh holds, which is what a push over https reads.
const CREDENTIAL_FIX: &str = "sign gh in on it with gh auth login, then gh auth setup-git";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lines_gh_is_given_name_the_branch_the_base_and_the_head() {
        assert_eq!(GitHub.find_argv("work"), ["pr", "view", "work", "--json", "number,url,state"]);
        assert_eq!(GitHub.create_argv("main", "work", None, None), ["pr", "create", "--base", "main", "--head", "work", "--fill"]);
        assert_eq!(
            GitHub.create_argv("main", "work", Some("a title"), Some("a body")),
            ["pr", "create", "--base", "main", "--head", "work", "--title", "a title", "--body", "a body"]
        );
        // A body with no title has no title to hang on, so the host fills both and the body rides the commits.
        assert_eq!(
            GitHub.create_argv("main", "work", None, Some("a body")),
            ["pr", "create", "--base", "main", "--head", "work", "--fill"]
        );
    }

    #[test]
    fn the_sign_in_code_is_ghs_own_and_the_fix_names_the_two_commands_only_the_person_can_run() {
        assert_eq!(GitHub.sign_in_exit(), Some(4));
        assert_eq!(GitHub.credential_fix(), "sign gh in on it with gh auth login, then gh auth setup-git");
    }

    #[test]
    fn the_pull_request_is_read_off_ghs_json_and_never_off_its_prose() {
        let read = GitHub.read("{\"number\":12,\"url\":\"https://github.com/o/r/pull/12\",\"state\":\"OPEN\"}").unwrap();
        assert_eq!((read.number, read.state, read.host.as_str()), (12, PullRequestState::Open, "github.com"));
        assert_eq!(read.url, "https://github.com/o/r/pull/12");
        assert_eq!(GitHub.read("{\"number\":1,\"url\":\"u\",\"state\":\"MERGED\"}").unwrap().state, PullRequestState::Merged);
        assert_eq!(GitHub.read("{\"number\":1,\"url\":\"u\",\"state\":\"CLOSED\"}").unwrap().state, PullRequestState::Closed);
        assert!(GitHub.read("https://github.com/o/r/pull/12\n").is_none());
        assert!(GitHub.read("{\"number\":1,\"url\":\"u\",\"state\":\"DRAFTED\"}").is_none());
        assert!(GitHub.read("").is_none());
    }
}
