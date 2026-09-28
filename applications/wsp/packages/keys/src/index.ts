// SPDX-License-Identifier: AGPL-3.0-only
// What a wsp link is built out of: the ed25519 pair each end proves itself
// with, the fingerprint of a key as a person copies it, and the seal every
// frame after a handshake travels inside. Node crypto and nothing else, in a
// package of its own with no dependencies, because the command line and the
// tool server hold a host to its key before they send it a token and neither
// of them may load the runtime, the engine or a provider's keys to do it.
//
// The seal: after the two ends have proved their ed25519 keys to each other,
// every frame between them travels inside one AEAD under a key agreed in the
// same handshake, so whoever carries the bytes reads nothing and writes
// nothing into the link. The carrier is real: a managed tunnel ends TLS on the
// relay operator's account, and a plain http address is open to anyone on the
// path. The daemon's twin is seal.rs and the fixture
// daemon/fixtures/place-link-seal.json holds the two to one derivation and
// one set of bytes.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";

/** A key's fingerprint as every ssh tool prints it: the SHA256 of the key's own bytes, base64 with the padding
 * dropped, under the name of the hash. The bytes are the key as it travels, base64: the blob off a known_hosts
 * line on one road, SPKI DER on a place's link key. Worked out here rather than by a second ssh-keygen, since it
 * is a hash of what the caller already holds. */
export function keyFingerprint(keyBase64: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** An ed25519 pair in the two spellings the link uses: the public key as it travels and the private key as it is
 * kept on disk. */
export interface PlaceKeyPair {
  publicKey: string;
  privateKeyPem: string;
}

/** A fresh ed25519 pair in the two spellings the link uses. The one road that makes one, so the host's own key and
 * a joining computer's are the same kind of key written the same way. */
export function newPlaceKeyPair(): PlaceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** A signature over the bytes both sides build from one function; ed25519 takes no digest name. The host signs its
 * half with its own key here, and wsp join signs a joining computer's half with the key it just made.
 *
 * The place's half of this pair is the daemon's, in Rust; the two are held together by the vectors under
 * daemon/fixtures, which packages/daemon's suite regenerates here and the daemon's own test reads. What could
 * drift, the bytes that are signed and the encodings they are sent in, is in the protocol
 * (`placeLinkTranscript`, `PlaceSignature`, `PlacePublicKey`). */
export function signPlaceBytes(privateKeyPem: string, bytes: Uint8Array): string {
  return signBytes(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether the key given made this signature: the key on a place's record here, and at a join the key the host sent
 * with its own challenge. A key that will not even parse is a refusal rather than a throw: it came off the wire. */
export function verifyPlaceBytes(publicKeyBase64: string, bytes: Uint8Array, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return verifyBytes(null, bytes, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** One info word per direction, so the two keys of a link can never be swapped for each other. */
export const HOST_TO_PLACE_INFO = "wsp place link host to place";
export const PLACE_TO_HOST_INFO = "wsp place link place to host";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What a frame that will not open is refused with: the same sentence whichever way it failed, since a peer that
 * cannot make a frame this side accepts learns nothing from which check caught it. The socket ends on it. */
export const SEAL_REFUSAL = "a frame on this link did not open under the key both ends agreed";

/** The two keys of one link, one per direction. */
export interface SealKeys {
  hostToPlace: Buffer;
  placeToHost: Buffer;
}

/** The keys both ends derive from the agreed secret: HKDF-SHA256, the place id as the salt, one info word per
 * direction. The place id is public and is the salt rather than a secret, which is what a salt is for. */
export const sealKeys = (secret: Uint8Array, placeId: string): SealKeys => ({
  hostToPlace: Buffer.from(hkdfSync("sha256", secret, Buffer.from(placeId, "utf8"), HOST_TO_PLACE_INFO, KEY_BYTES)),
  placeToHost: Buffer.from(hkdfSync("sha256", secret, Buffer.from(placeId, "utf8"), PLACE_TO_HOST_INFO, KEY_BYTES)),
});

/** An X25519 public key as the raw 32 bytes the wire carries, base64. */
export const rawPublicKey = (key: KeyObject): string => Buffer.from((key.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("base64");

/** The same read back off the wire; throws on anything that is not 32 bytes of X25519. */
export const publicKeyOf = (raw: string): KeyObject =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw, "base64").toString("base64url") }, format: "jwk" });

/** A fresh pair for one attempt: the raw public bytes that cross the wire and the private key to agree with. One
 * per socket, never held past it, so a key that leaks later opens nothing that was said before. */
export function freshEphemeral(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync("x25519");
  return { privateKey: pair.privateKey, publicKey: rawPublicKey(pair.publicKey) };
}

/** The 32 bytes the two ephemerals agree on. */
export const sharedSecret = (privateKey: KeyObject, peer: string): Buffer => diffieHellman({ privateKey, publicKey: publicKeyOf(peer) });

/** Four zero bytes then the counter, big endian: one nonce per frame per direction, so no key ever seals two
 * frames under the same nonce and a frame moved or repeated does not open. */
export function sealNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

/** One frame sealed under a key at a counter: the ciphertext with the tag behind it, as ring writes it too. */
export function sealWith(key: Buffer, counter: bigint, text: string): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, sealNonce(counter));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
}

/** The text back, or the one refusal: a tag that does not verify, a counter out of step and a frame cut short
 * read the same. */
export function unsealWith(key: Buffer, counter: bigint, bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  if (buf.length < TAG_BYTES) throw new Error(SEAL_REFUSAL);
  const decipher = createDecipheriv("aes-256-gcm", key, sealNonce(counter));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(buf.subarray(0, buf.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(SEAL_REFUSAL);
  }
}

/** One end's view of a sealed link: what it seals outgoing frames with and what it opens incoming ones with, each
 * counting on its own. Every frame one side sends goes through one of these, so the counters follow the wire. */
export interface Seal {
  seal(text: string): Buffer;
  unseal(bytes: Uint8Array): string;
}

/** The text of one frame off a socket, whether or not its link agreed a key. Before the seal a frame is its own
 * text; after it, a frame in the clear and a frame that will not open are the same thing, a carrier writing into
 * a link neither end would read it on, and both throw the one refusal. Written once and read by every end that
 * holds a seal, so no reader can be the one that forgets a text frame is a refusal now. */
export function openFrame(seal: Seal | undefined, raw: unknown): string {
  if (seal === undefined) return String(raw);
  if (!(raw instanceof Uint8Array)) throw new Error(SEAL_REFUSAL);
  return seal.unseal(raw);
}

export function makeSeal(keys: SealKeys, side: "host" | "place"): Seal {
  const outward = side === "host" ? keys.hostToPlace : keys.placeToHost;
  const inward = side === "host" ? keys.placeToHost : keys.hostToPlace;
  let sent = 0n;
  let taken = 0n;
  return {
    seal(text) {
      const bytes = sealWith(outward, sent, text);
      sent += 1n;
      return bytes;
    },
    unseal(bytes) {
      const text = unsealWith(inward, taken, bytes);
      taken += 1n;
      return text;
    },
  };
}
