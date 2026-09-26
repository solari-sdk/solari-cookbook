// SPDX-License-Identifier: AGPL-3.0-only
//! The seal over a place link: after the two ends have proved their ed25519 keys to each other, every frame
//! between them travels inside one AEAD under a key agreed in the same handshake, so whoever carries the bytes
//! reads nothing and writes nothing into the link. The carrier is real: a managed tunnel ends TLS on the relay
//! operator's account, and a plain http address is open to anyone on the path. The host's twin is
//! packages/runtime/src/seal.ts and the fixture daemon/fixtures/place-link-seal.json holds the two to one
//! derivation and one set of bytes.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf;
use ring::rand::SystemRandom;

/// One info word per direction, so the two keys of a link can never be swapped for each other.
pub const HOST_TO_PLACE_INFO: &[u8] = b"wsp place link host to place";
pub const PLACE_TO_HOST_INFO: &[u8] = b"wsp place link place to host";
/// An X25519 public key and an AES-256 key are both this many bytes.
pub const KEY_BYTES: usize = 32;

/// The two keys of one link, one per direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealKeys {
    pub host_to_place: [u8; KEY_BYTES],
    pub place_to_host: [u8; KEY_BYTES],
}

/// The keys both ends derive from the agreed secret: HKDF-SHA256, the place id as the salt, one info word per
/// direction. The place id is public and is the salt rather than a secret, which is what a salt is for.
pub fn seal_keys(secret: &[u8], place_id: &str) -> SealKeys {
    SealKeys { host_to_place: derive(secret, place_id, HOST_TO_PLACE_INFO), place_to_host: derive(secret, place_id, PLACE_TO_HOST_INFO) }
}

fn derive(secret: &[u8], place_id: &str, info: &[u8]) -> [u8; KEY_BYTES] {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, place_id.as_bytes()).extract(secret);
    let parts: [&[u8]; 1] = [info];
    let okm = prk.expand(&parts, hkdf::HKDF_SHA256).expect("one output block of sha256");
    let mut out = [0u8; KEY_BYTES];
    okm.fill(&mut out).expect("one output block of sha256");
    out
}

/// A fresh pair for one attempt: the raw public bytes that cross the wire and the private key to agree with. One
/// per socket, never held past it, so a key that leaks later opens nothing that was said before.
pub fn fresh_ephemeral() -> Option<(EphemeralPrivateKey, [u8; KEY_BYTES])> {
    let private = EphemeralPrivateKey::generate(&X25519, &SystemRandom::new()).ok()?;
    let public = private.compute_public_key().ok()?;
    let mut raw = [0u8; KEY_BYTES];
    if public.as_ref().len() != KEY_BYTES {
        return None;
    }
    raw.copy_from_slice(public.as_ref());
    Some((private, raw))
}

/// The bytes the two ephemerals agree on; nothing where the peer's key is not a point this curve takes.
pub fn agree(private: EphemeralPrivateKey, peer: &[u8; KEY_BYTES]) -> Option<Vec<u8>> {
    agreement::agree_ephemeral(private, &UnparsedPublicKey::new(&X25519, peer.as_slice()), |secret| secret.to_vec()).ok()
}

/// One end's view of a sealed link: what it seals outgoing frames with and what it opens incoming ones with, each
/// counting on its own. Every frame one side sends goes through one of these, so the counters follow the wire.
pub struct Seal {
    outward: LessSafeKey,
    inward: LessSafeKey,
    sent: u64,
    taken: u64,
}

impl Seal {
    /// This daemon's own end: a computer joined as a place seals what it sends its host and opens what comes
    /// back. The host's end is node's, in the runtime's own seal; only a case here ever stands on that side.
    pub fn place(keys: &SealKeys) -> Seal {
        Seal { outward: aead_key(&keys.place_to_host), inward: aead_key(&keys.host_to_place), sent: 0, taken: 0 }
    }

    /// The host's end, which in the product is node's own seal in the runtime: only a case here ever stands on
    /// this side, and both of them are what hold the two stacks to one set of bytes.
    pub fn host(keys: &SealKeys) -> Seal {
        Seal { outward: aead_key(&keys.host_to_place), inward: aead_key(&keys.place_to_host), sent: 0, taken: 0 }
    }

    /// One frame sealed: the ciphertext with the tag behind it, as node writes it too.
    pub fn seal(&mut self, text: &str) -> Vec<u8> {
        let mut bytes = text.as_bytes().to_vec();
        self.outward.seal_in_place_append_tag(nonce(self.sent), Aad::empty(), &mut bytes).expect("aes-gcm seals a frame");
        self.sent += 1;
        bytes
    }

    /// The text back, or nothing: a tag that does not verify, a counter out of step and a frame cut short all
    /// read the same, and the one answer to any of them is to end the socket.
    pub fn unseal(&mut self, bytes: &[u8]) -> Option<String> {
        let mut held = bytes.to_vec();
        let plain = self.inward.open_in_place(nonce(self.taken), Aad::empty(), &mut held).ok()?;
        let text = String::from_utf8(plain.to_vec()).ok()?;
        self.taken += 1;
        Some(text)
    }
}

fn aead_key(key: &[u8; KEY_BYTES]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).expect("a 32 byte key"))
}

/// Four zero bytes then the counter, big endian: one nonce per frame per direction, so no key ever seals two
/// frames under the same nonce and a frame moved or repeated does not open.
fn nonce(counter: u64) -> Nonce {
    let mut bytes = [0u8; NONCE_LEN];
    bytes[NONCE_LEN - 8..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        place_id: String,
        secret: String,
        host_to_place_key: String,
        place_to_host_key: String,
        frame: String,
        host_to_place_sealed: String,
        place_to_host_sealed: String,
    }

    fn vectors() -> Vectors {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/place-link-seal.json");
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
    }

    /// ring makes an ephemeral by generate alone, so this half starts where node's leaves off: the agreed secret.
    /// That the two stacks agree on the secret itself is proven where they meet, by the wire suite against the
    /// built binary and by the live run on a box.
    #[test]
    fn derives_the_two_keys_the_host_derives_from_the_same_secret() {
        let v = vectors();
        let keys = seal_keys(&B64.decode(&v.secret).unwrap(), &v.place_id);
        assert_eq!(B64.encode(keys.host_to_place), v.host_to_place_key);
        assert_eq!(B64.encode(keys.place_to_host), v.place_to_host_key);
    }

    #[test]
    fn seals_and_opens_the_fixtures_frame_byte_for_byte_in_each_direction() {
        let v = vectors();
        let keys = seal_keys(&B64.decode(&v.secret).unwrap(), &v.place_id);
        let mut host = Seal::host(&keys);
        let mut place = Seal::place(&keys);
        assert_eq!(B64.encode(host.seal(&v.frame)), v.host_to_place_sealed);
        assert_eq!(B64.encode(place.seal(&v.frame)), v.place_to_host_sealed);
        // And each end opens what the other sealed, at the counter that frame was sealed at.
        let mut host = Seal::host(&keys);
        let mut place = Seal::place(&keys);
        assert_eq!(place.unseal(&B64.decode(&v.host_to_place_sealed).unwrap()).as_deref(), Some(v.frame.as_str()));
        assert_eq!(host.unseal(&B64.decode(&v.place_to_host_sealed).unwrap()).as_deref(), Some(v.frame.as_str()));
    }

    #[test]
    fn opens_nothing_under_a_counter_that_does_not_follow_or_a_tag_that_was_touched() {
        let v = vectors();
        let keys = seal_keys(&B64.decode(&v.secret).unwrap(), &v.place_id);
        let mut host = Seal::host(&keys);
        let first = host.seal("{\"id\":1}");
        let second = host.seal("{\"id\":2}");
        let mut place = Seal::place(&keys);
        // The second frame where the first was waited for opens nothing, which is a frame dropped on the way.
        assert_eq!(place.unseal(&second), None);
        assert_eq!(place.unseal(&first).as_deref(), Some("{\"id\":1}"));
        let mut touched = second.clone();
        let last = touched.len() - 1;
        touched[last] ^= 1;
        assert_eq!(place.unseal(&touched), None);
        // A frame from the other direction does not open either: one key per direction.
        let mut place = Seal::place(&keys);
        assert_eq!(place.unseal(&place_sealed(&keys)), None);
    }

    fn place_sealed(keys: &SealKeys) -> Vec<u8> {
        Seal::place(keys).seal("{\"id\":1}")
    }

    #[test]
    fn two_fresh_ephemerals_agree_on_one_secret_and_a_key_that_is_not_a_point_agrees_on_none() {
        let (mine, my_public) = fresh_ephemeral().unwrap();
        let (theirs, their_public) = fresh_ephemeral().unwrap();
        assert_ne!(my_public, their_public);
        let ours = agree(mine, &their_public).unwrap();
        let yours = agree(theirs, &my_public).unwrap();
        assert_eq!(ours, yours);
        assert_eq!(ours.len(), KEY_BYTES);
        let (third, _) = fresh_ephemeral().unwrap();
        assert!(agree(third, &[0u8; KEY_BYTES]).is_none());
    }
}
