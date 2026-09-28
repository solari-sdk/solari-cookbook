// SPDX-License-Identifier: AGPL-3.0-only
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which kind of machine a daemon serves, which picks the modules its readings come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Cloud,
    Local,
    Ssh,
    Place,
}

impl WorkspaceKind {
    /// The kind a word names on the wire, or nothing for a word that is not one.
    pub fn from_word(word: &str) -> Option<WorkspaceKind> {
        serde_json::from_value(serde_json::Value::String(word.to_owned())).ok()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WorkspaceKind::Cloud => "cloud",
            WorkspaceKind::Local => "local",
            WorkspaceKind::Ssh => "ssh",
            WorkspaceKind::Place => "place",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum DaemonErrorCode {
    Unsupported,
    OutsideRoot,
    NotFound,
    NotADirectory,
    NotAFile,
    NotAGitRepo,
    BadRequest,
    Forbidden,
    /// No command line for the git host this remote names is on this computer, so the pull request waits; the push
    /// itself went through, which is why a client reads this as a note beside the push rather than as a failure.
    NoHostCli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ProcSignal {
    #[serde(rename = "TERM")]
    Term,
    #[serde(rename = "KILL")]
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum FsReadEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffScope {
    Branch,
    Unstaged,
    Staged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryType {
    File,
    Dir,
    Symlink,
}

/// Where a pull request stands, in the three words every host of them has: open, merged, or closed unmerged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

/// The slave termios ICANON bit as a word: line when set, raw when not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PtyMode {
    Line,
    Raw,
}
