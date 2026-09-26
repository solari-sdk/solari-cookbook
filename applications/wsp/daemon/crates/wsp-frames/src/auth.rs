// SPDX-License-Identifier: AGPL-3.0-only
use std::num::NonZeroU16;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RequestId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum AuthTag {
    #[serde(rename = "auth")]
    Auth,
}

/// The first frame on every daemon socket. port scopes the socket to one guest port: only tunnel ops on that port
/// and ping are answered on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DaemonAuthRequest {
    pub id: RequestId,
    #[ts(type = "\"auth\"")]
    op: AuthTag,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port: Option<NonZeroU16>,
}

impl DaemonAuthRequest {
    pub fn new(id: RequestId, token: impl Into<String>, port: Option<NonZeroU16>) -> Self {
        DaemonAuthRequest { id, op: AuthTag::Auth, token: token.into(), port }
    }
}
