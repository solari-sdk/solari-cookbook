// SPDX-License-Identifier: AGPL-3.0-only
use serde::{Deserialize, Serialize};
use serde_json::Number;
use ts_rs::TS;

/// The id a request carries and its reply echoes: a string or a number, as the client chose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(untagged)]
pub enum RequestId {
    Num(#[ts(type = "number")] Number),
    Str(String),
}

impl From<u64> for RequestId {
    fn from(n: u64) -> Self {
        RequestId::Num(Number::from(n))
    }
}

impl From<&str> for RequestId {
    fn from(s: &str) -> Self {
        RequestId::Str(s.to_owned())
    }
}
