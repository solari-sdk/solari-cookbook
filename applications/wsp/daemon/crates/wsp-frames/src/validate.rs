// SPDX-License-Identifier: AGPL-3.0-only
//! The bounds the zod schemas put on strings and numbers, applied at deserialization so a frame the protocol
//! refuses is one these types refuse too.

use std::collections::BTreeMap;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// zod's .max counts UTF-16 code units, which is what a JavaScript string's length is.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub(crate) fn bounded<'de, D, const MIN: usize, const MAX: usize>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(d)?;
    let len = js_len(&s);
    if len < MIN {
        return Err(de::Error::custom(format!("string must be at least {MIN} characters, got {len}")));
    }
    if len > MAX {
        return Err(de::Error::custom(format!("string must be at most {MAX} characters, got {len}")));
    }
    Ok(s)
}

pub(crate) fn bounded_list<'de, D, const EACH: usize, const MAX: usize>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let list = Vec::<String>::deserialize(d)?;
    if list.len() > MAX {
        return Err(de::Error::custom(format!("at most {MAX} entries, got {}", list.len())));
    }
    if let Some(long) = list.iter().find(|s| js_len(s) > EACH) {
        return Err(de::Error::custom(format!("entry longer than {EACH} characters: {long}")));
    }
    Ok(list)
}

/// A string that may be absent, under the same cap when it is there.
pub(crate) fn bounded_opt<'de, D, const MAX: usize>(d: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<String>::deserialize(d)? {
        None => Ok(None),
        Some(s) if js_len(&s) <= MAX => Ok(Some(s)),
        Some(s) => Err(de::Error::custom(format!("string must be at most {MAX} characters, got {}", js_len(&s)))),
    }
}

/// A list of any strings under a cap on how many, which is what a zod array with only .max() takes.
pub(crate) fn capped_list<'de, D, const MAX: usize>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let list = Vec::<String>::deserialize(d)?;
    if list.len() > MAX {
        return Err(de::Error::custom(format!("at most {MAX} entries, got {}", list.len())));
    }
    Ok(list)
}

pub(crate) fn non_empty_list<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let list = Vec::<String>::deserialize(d)?;
    if list.is_empty() {
        return Err(de::Error::custom("at least one entry"));
    }
    Ok(list)
}

/// The protocol's upload id: one to thirty-two lowercase letters and digits. A name and never a path, since the
/// far side keeps a file under it.
pub(crate) fn upload_word<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = bounded::<_, 1, 32>(d)?;
    if !s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return Err(de::Error::custom("an upload id is lowercase letters and digits"));
    }
    Ok(s)
}

/// A sha256 as the protocol spells it: sixty-four lowercase hex characters.
pub(crate) fn sha256_hex<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(d)?;
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(de::Error::custom("a sha256 is 64 lowercase hex characters"));
    }
    Ok(s)
}

/// The protocol's isHttpUrl: http or https, then anything that is not whitespace or a control character.
pub fn is_http_url(url: &str) -> bool {
    let bytes = url.as_bytes();
    let rest = if bytes.len() >= 7 && bytes[..7].eq_ignore_ascii_case(b"http://") {
        &url[7..]
    } else if bytes.len() >= 8 && bytes[..8].eq_ignore_ascii_case(b"https://") {
        &url[8..]
    } else {
        return false;
    };
    !rest.is_empty() && !rest.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub(crate) fn http_url<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(d)?;
    if !is_http_url(&s) {
        return Err(de::Error::custom("http or https URL"));
    }
    Ok(s)
}

/// The protocol's isPlainPath: absolute, made of what a path is made of, no empty part in it and no part that
/// walks up out of it. A path off the wire lands in a mount and in the commands a turn runs, so a semicolon, a
/// quote, a backtick, a glob or a `..` in one is refused here rather than quoted or resolved at each of twenty
/// places. A space is a path on macOS and stays allowed, and a name that merely begins with a dot is a name.
pub fn is_plain_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains("//")
        && path.chars().all(|c| c.is_ascii_alphanumeric() || " ._+@:,/-".contains(c))
        && !path.split('/').any(|part| part == "." || part == "..")
}

pub(crate) fn plain_path<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(d)?;
    if !is_plain_path(&s) {
        return Err(de::Error::custom("an absolute path made of what a path is made of"));
    }
    Ok(s)
}

/// The same rule for a path that may be absent, which is how a reply carries one.
pub(crate) fn plain_path_opt<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<String>::deserialize(d)? {
        None => Ok(None),
        Some(s) if is_plain_path(&s) => Ok(Some(s)),
        Some(_) => Err(de::Error::custom("an absolute path made of what a path is made of")),
    }
}

/// The protocol's isUnderPath: a name under a folder the reader already holds, never a path of its own. The host
/// joins one of these onto a folder of its own, so a leading slash, an empty part and a part that walks up out of
/// it are all refused here rather than resolved at the other end.
pub fn is_under_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
}

/// A list of names under a folder, each under a cap on its length and the list under a cap on how many.
pub(crate) fn under_paths_opt<'de, D, const EACH: usize, const MAX: usize>(d: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let Some(list) = Option::<Vec<String>>::deserialize(d)? else { return Ok(None) };
    if list.len() > MAX {
        return Err(de::Error::custom(format!("at most {MAX} entries, got {}", list.len())));
    }
    if let Some(long) = list.iter().find(|s| js_len(s) > EACH) {
        return Err(de::Error::custom(format!("entry longer than {EACH} characters: {long}")));
    }
    if let Some(walks) = list.iter().find(|s| !is_under_path(s)) {
        return Err(de::Error::custom(format!("not a name under a folder: {walks}")));
    }
    Ok(Some(list))
}

/// A map whose values are each under a cap, with a cap on how many pairs it carries.
pub(crate) fn bounded_map<'de, D, const EACH: usize, const MAX: usize>(d: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: Deserializer<'de>,
{
    let map = BTreeMap::<String, String>::deserialize(d)?;
    if map.len() > MAX {
        return Err(de::Error::custom(format!("at most {MAX} entries, got {}", map.len())));
    }
    if let Some((name, long)) = map.iter().find(|(_, v)| js_len(v) > EACH) {
        return Err(de::Error::custom(format!("{name} is longer than {EACH} characters: {long}")));
    }
    Ok(map)
}

pub(crate) fn positive<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<u32>::deserialize(d)? {
        Some(0) => Err(de::Error::custom("must be positive")),
        other => Ok(other),
    }
}

pub(crate) fn exec_timeout<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    match positive(d)? {
        Some(ms) if ms > crate::numbers::EXEC_TIMEOUT_MAX_MS => Err(de::Error::custom("timeoutMs above the cap")),
        other => Ok(other),
    }
}

/// A port the host may forward: the protocol's RelayPort, 1024 to 65535.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(transparent)]
#[ts(export)]
pub struct RelayPort(u16);

impl RelayPort {
    pub const MIN: u16 = 1024;

    pub fn new(port: u16) -> Option<RelayPort> {
        (port >= Self::MIN).then_some(RelayPort(port))
    }

    pub fn get(self) -> u16 {
        self.0
    }
}

impl<'de> Deserialize<'de> for RelayPort {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let port = u16::deserialize(d)?;
        RelayPort::new(port).ok_or_else(|| de::Error::custom(format!("port must be between {} and 65535", RelayPort::MIN)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_urls_are_read_as_the_protocol_reads_them() {
        assert!(is_http_url("http://localhost:8123/"));
        assert!(is_http_url("HTTPS://Accounts.Example/auth?x=1"));
        assert!(!is_http_url("http://"));
        assert!(!is_http_url("ftp://x"));
        assert!(!is_http_url("https://a b"));
        assert!(!is_http_url("https://a\u{1f}b"));
        assert!(!is_http_url("日本語://x"));
        assert!(!is_http_url("ħttps://x"));
    }

    #[test]
    fn plain_paths_are_read_as_the_protocol_reads_them() {
        assert!(is_plain_path("/Users/zingzy/wsp") && is_plain_path("/wsp/projects/my project/checkout"));
        assert!(!is_plain_path("wsp") && !is_plain_path("") && !is_plain_path("/a//b"));
        assert!(!is_plain_path("/a; rm -rf /") && !is_plain_path("/a'b") && !is_plain_path("/a*"));
        assert!(!is_plain_path("/日本語"));
        // A path that walks up out of itself is refused here, since what it resolves to is a mount on the box
        // rather than a path inside a workspace.
        assert!(!is_plain_path("/Users/../../etc") && !is_plain_path("/..") && !is_plain_path("/a/../b"));
        assert!(!is_plain_path("/a/./b") && !is_plain_path("/.") && !is_plain_path("/a/.."));
        // A name is still a name where it begins with a dot, which half a home folder does.
        assert!(is_plain_path("/root/.claude/projects") && is_plain_path("/a/...") && is_plain_path("/a/.b"));
    }

    #[test]
    fn a_name_under_a_folder_never_walks_out_of_it() {
        assert!(is_under_path("codex/auth.json") && is_under_path("auth.json") && is_under_path(".codex/auth.json"));
        assert!(!is_under_path("") && !is_under_path("/codex/auth.json") && !is_under_path("codex//auth.json"));
        assert!(!is_under_path("../auth.json") && !is_under_path("codex/../../auth.json") && !is_under_path("./auth.json"));
    }

    #[test]
    fn js_length_counts_utf16_units() {
        assert_eq!(js_len("abc"), 3);
        assert_eq!(js_len("日本語"), 3);
        assert_eq!(js_len("😀"), 2);
    }
}
