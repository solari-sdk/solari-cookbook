// SPDX-License-Identifier: AGPL-3.0-only
//! The handshake a place opens toward its host, and the report it carries. The encodings both sides sign and
//! send are pinned here as the protocol pins them: a nonce, a key and a signature are base64 of a fixed byte count.

use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::num::NonZeroU16;

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::{alphabet, Engine};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::validate::{bounded, bounded_list, bounded_map, bounded_opt, http_url, non_empty_list, under_paths_opt};
use crate::{CopyWord, RequestId};

/// Decodes what the protocol's regex accepts: the standard alphabet, padded, with the trailing bits of the last
/// symbol left unchecked, since the zod side counts bytes off the text and never decodes.
const AS_ZOD: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true));

/// Base64 text that decodes to exactly N bytes; anything else is refused at the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Base64Bytes<const N: usize> {
    text: String,
    #[serde(skip)]
    _n: PhantomData<[u8; N]>,
}

impl<const N: usize> Base64Bytes<N> {
    pub fn from_bytes(bytes: &[u8; N]) -> Self {
        Base64Bytes { text: STANDARD.encode(bytes), _n: PhantomData }
    }

    pub fn parse(text: &str) -> Option<Self> {
        if !text.len().is_multiple_of(4) || !text.trim_end_matches('=').bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        {
            return None;
        }
        let decoded = AS_ZOD.decode(text).ok()?;
        (decoded.len() == N).then(|| Base64Bytes { text: text.to_owned(), _n: PhantomData })
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn to_bytes(&self) -> [u8; N] {
        let mut out = [0u8; N];
        out.copy_from_slice(&AS_ZOD.decode(&self.text).expect("validated at construction"));
        out
    }
}

impl<'de, const N: usize> Deserialize<'de> for Base64Bytes<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Base64Bytes::parse(&text).ok_or_else(|| de::Error::custom(format!("must be {N} bytes, base64")))
    }
}

pub type PlaceNonce = Base64Bytes<{ crate::numbers::PLACE_LINK_NONCE_BYTES }>;
/// An ed25519 public key as SPKI DER.
pub type PlacePublicKey = Base64Bytes<44>;
/// An ed25519 signature.
pub type PlaceSignature = Base64Bytes<64>;
/// An X25519 public key as its raw 32 bytes: what each end of a link sends to agree the key every frame after the
/// handshake is sealed under. Fresh per attempt and never held past the socket.
pub type PlaceEphemeral = Base64Bytes<32>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSize {
    pub cpu: f64,
    pub mem_mb: u64,
}

/// What a place says about itself on every link. agents names the catalog ids found on its login PATH.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceReport {
    #[serde(deserialize_with = "bounded::<_, 1, 200>")]
    pub name: String,
    pub platform: Platform,
    #[serde(deserialize_with = "bounded::<_, 0, 32>")]
    pub arch: String,
    #[serde(deserialize_with = "bounded::<_, 0, 200>")]
    pub os: String,
    pub shape: WorkspaceSize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub disk_free_bytes: Option<u64>,
    pub login: BTreeMap<String, String>,
    /// Whether this computer's own daemon runs workspaces here: cgroup v2 with the controllers a cap needs, an
    /// overlay, and root. What decides whether the place forks at all, where the docker row once did.
    pub runs_workspaces: bool,
    /// When it does not, the one kernel reason, in the self check's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspaces_blocked: Option<String>,
    /// The engine a project's own containers would run on here, none until the person installs one.
    #[serde(deserialize_with = "bounded::<_, 0, 16>")]
    pub engine: String,
    /// How this computer makes a workspace's copy of a checkout, read off a clone probe under the runtime's root.
    /// Absent where the computer runs no workspaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub copies: Option<CopyWord>,
    pub daemon_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub daemon_port: Option<NonZeroU16>,
    #[serde(deserialize_with = "non_empty_list")]
    pub wsp: Vec<String>,
    #[serde(deserialize_with = "http_url")]
    pub dialed: String,
    #[serde(deserialize_with = "bounded_list::<_, 32, 32>")]
    pub agents: Vec<String>,
    /// What each of those agents answered its own version flag with, by the same catalog id: the first line of
    /// `<bin> --version`, as the computer said it. Empty on a computer whose agents have not been read yet.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty", deserialize_with = "bounded_map::<_, 64, 32>")]
    pub agent_versions: BTreeMap<String, String>,
    /// The files under this computer's logins directory, each named under it: what a sign-in there wrote and every
    /// workspace on it shares. Absent from a report a daemon older than this field sent, which reads as unknown
    /// rather than as none.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "under_paths_opt::<_, 200, 64>")]
    #[ts(optional)]
    pub logins: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum PlaceAuthTag {
    #[serde(rename = "place.auth")]
    PlaceAuth,
}

/// The first frame of a place that already joined: names itself and challenges the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceAuthRequest {
    pub id: RequestId,
    #[ts(type = "\"place.auth\"")]
    op: PlaceAuthTag,
    #[serde(deserialize_with = "bounded::<_, 0, 64>")]
    pub place_id: String,
    #[ts(type = "string")]
    pub nonce: PlaceNonce,
    #[ts(type = "string")]
    pub ephemeral: PlaceEphemeral,
}

impl PlaceAuthRequest {
    pub fn new(id: RequestId, place_id: impl Into<String>, nonce: PlaceNonce, ephemeral: PlaceEphemeral) -> Self {
        PlaceAuthRequest { id, op: PlaceAuthTag::PlaceAuth, place_id: place_id.into(), nonce, ephemeral }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceAuthReply {
    #[ts(type = "string")]
    pub nonce: PlaceNonce,
    #[ts(type = "string")]
    pub host_public_key: PlacePublicKey,
    #[ts(type = "string")]
    pub signature: PlaceSignature,
    #[ts(type = "string")]
    pub ephemeral: PlaceEphemeral,
}

/// What a host that holds no place by the id a computer named puts on its refusal of the first frame: its own
/// key and a signature over the refusal transcript. Absent from a host older than this, which reads as a refusal
/// that proved nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceAuthRefusal {
    #[ts(type = "string")]
    pub host_public_key: PlacePublicKey,
    #[ts(type = "string")]
    pub signature: PlaceSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum PlaceProveTag {
    #[serde(rename = "place.prove")]
    PlaceProve,
}

/// The second frame, and the first one sealed: the place's answer to the host's nonce and its report as it stands
/// now. A join's prove carries the code it spends and the window it wants too, which this daemon never sends: a
/// join is typed on the computer being joined and its own wsp sends it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceProveRequest {
    pub id: RequestId,
    #[ts(type = "\"place.prove\"")]
    op: PlaceProveTag,
    #[ts(type = "string")]
    pub signature: PlaceSignature,
    pub report: PlaceReport,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "bounded_opt::<_, 64>")]
    #[ts(optional)]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client: Option<PlaceClient>,
}

/// The window a join also wants a token for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceClient {
    #[serde(deserialize_with = "bounded::<_, 1, 200>")]
    pub name: String,
}

impl PlaceProveRequest {
    pub fn new(id: RequestId, signature: PlaceSignature, report: PlaceReport) -> Self {
        PlaceProveRequest { id, op: PlaceProveTag::PlaceProve, signature, report, code: None, client: None }
    }
}

/// Which side signs: the host answers the place's challenge, the place answers the host's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRole {
    Host,
    Place,
}

impl LinkRole {
    fn word(self) -> &'static str {
        match self {
            LinkRole::Host => "host",
            LinkRole::Place => "place",
        }
    }
}

/// The two public values the seal is agreed from, in the order the transcript names them: the side that
/// challenged first, then the side that answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkEphemerals<'a> {
    pub challenger: &'a str,
    pub answerer: &'a str,
}

/// The bytes both sides sign, as the protocol's placeLinkTranscript builds them: the role of the signer, the place
/// id, the two nonces and the two ephemerals, the challenged party's first in each pair, each on its own line.
/// The ephemerals are inside it, so the key the two ends agree is one both signatures cover and a carrier that
/// swapped either of them has signed nothing.
pub fn place_link_transcript(role: LinkRole, place_id: &str, challenge: &str, answer: &str, ephemerals: LinkEphemerals<'_>) -> Vec<u8> {
    let LinkEphemerals { challenger, answerer } = ephemerals;
    format!("wsp place link v2\n{}\n{place_id}\n{challenge}\n{answer}\n{challenger}\n{answerer}\n", role.word()).into_bytes()
}

/// The bytes a host signs to refuse a place at its first frame, as the protocol's placeRefusalTranscript builds
/// them: the place id it named, the nonce it challenged with and the sentence, each on its own line. The nonce is
/// inside, so one dial's refusal cannot be replayed at the next; the sentence is inside, so it cannot be bent.
pub fn place_refusal_transcript(place_id: &str, place_nonce: &str, sentence: &str) -> Vec<u8> {
    format!("wsp place refusal v1\n{place_id}\n{place_nonce}\n{sentence}\n").into_bytes()
}

/// What a computer joined as a place keeps about the wsp it belongs to, as wsp join writes it and the agent reads
/// it on every attempt. Fields the protocol's parse does not check are optional here for the same reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceFile {
    pub place_id: String,
    pub name: String,
    pub host_name: String,
    /// Dialled in this order on every attempt.
    pub host_urls: Vec<String>,
    /// SPKI DER in base64, compared as text against what the host sends.
    pub host_public_key: String,
    pub key_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub joined_at: Option<String>,
}

impl PlaceFile {
    /// The place file a text holds, or nothing when that text is not one, as the protocol's parsePlaceFile reads it.
    pub fn parse(text: &str) -> Option<PlaceFile> {
        serde_json::from_str(text).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_transcript_is_the_protocols_seven_lines() {
        let pair = LinkEphemerals { challenger: "CCC=", answerer: "DDD=" };
        assert_eq!(
            place_link_transcript(LinkRole::Host, "p_1", "AAA=", "BBB=", pair),
            b"wsp place link v2\nhost\np_1\nAAA=\nBBB=\nCCC=\nDDD=\n"
        );
        let swapped = LinkEphemerals { challenger: "DDD=", answerer: "CCC=" };
        assert_eq!(
            place_link_transcript(LinkRole::Place, "p_1", "BBB=", "AAA=", swapped),
            b"wsp place link v2\nplace\np_1\nBBB=\nAAA=\nDDD=\nCCC=\n"
        );
    }

    #[test]
    fn a_place_file_reads_as_the_protocol_parses_one_and_anything_else_is_none() {
        let text = r#"{"placeId":"p_ab12cd34","name":"old-macbook","hostName":"zingzy-mbp","hostUrls":["http://192.168.1.20:4400"],"hostPublicKey":"MCow","keyPath":"/h/.wsp/place-key.pem","joinedAt":"1970-01-01T00:00:00.000Z"}"#;
        let file = PlaceFile::parse(text).unwrap();
        assert_eq!((file.place_id.as_str(), file.name.as_str()), ("p_ab12cd34", "old-macbook"));
        assert_eq!(file.host_urls, vec!["http://192.168.1.20:4400"]);
        assert!(PlaceFile::parse("not a place file").is_none());
        assert!(PlaceFile::parse(r#"{"placeId":"p","name":"n","hostUrls":[],"hostPublicKey":"k","keyPath":"p"}"#).is_none());
        assert!(PlaceFile::parse(r#"{"placeId":"p","name":"n","hostName":"h","hostUrls":[1],"hostPublicKey":"k","keyPath":"p"}"#).is_none());
        let without_joined_at = text.replace(r#""joinedAt":"1970-01-01T00:00:00.000Z","#, "");
        assert!(PlaceFile::parse(&without_joined_at).is_some());
    }
}
