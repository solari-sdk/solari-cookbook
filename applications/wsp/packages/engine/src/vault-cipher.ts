// SPDX-License-Identifier: AGPL-3.0-only
// One sealed container for the image vault, two ways of keying it: a
// passphrase a person types for the export they keep, and a place's public key
// for the copy that travels to a place over the relay. One interface per
// concern and one module per variant, so a third way is a module and a row and
// nothing else. node:crypto only; no key material is ever logged.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, type KeyObject } from "node:crypto";
import { SealedVaultHeader, type SealedImage } from "@wsp/protocol";

export interface OpenedVault {
  image: SealedImage;
  plain: Buffer;
}

export interface VaultCipher<To> {
  seal(plain: Buffer, image: SealedImage, to: To): Buffer;
  open(sealed: Buffer, with_: To): OpenedVault;
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
/** scrypt at 2^15 rounds, the cost a person waits for once per export. 128 * N * r is 32 MiB, which is node's own
 * default cap to the byte and is refused at it, so the call names its own. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const b64 = (b: Buffer): string => b.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

/** The header's own bytes are the cipher's additional data, so a header somebody edited fails to open rather than
 * opening onto a record that is not the one the bytes were sealed under. */
function packed(header: SealedVaultHeader, seal: (aad: Buffer) => Buffer): Buffer {
  const line = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return Buffer.concat([line, seal(line)]);
}

/** The header line and the ciphertext behind it; a file that carries no newline, or whose line is not this format,
 * is refused before any key is derived. */
function unpacked(sealed: Buffer): { header: SealedVaultHeader; aad: Buffer; body: Buffer } {
  const at = sealed.indexOf(0x0a);
  if (at === -1) throw new Error("this file is not a sealed wsp image: it has no header line");
  const parsed = SealedVaultHeader.safeParse(readJson(sealed.subarray(0, at).toString("utf8")));
  if (!parsed.success) throw new Error("this file is not a sealed wsp image: its header is not one wsp wrote");
  return { header: parsed.data, aad: sealed.subarray(0, at + 1), body: sealed.subarray(at + 1) };
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function encrypt(key: Buffer, nonce: Buffer, aad: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(key: Buffer, nonce: Buffer, aad: Buffer, body: Buffer): Buffer {
  if (body.length < TAG_BYTES) throw new Error("the sealed vault is shorter than its own tag");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error("the sealed vault would not open: the passphrase or the key is not the one it was sealed to, or the file was changed");
  }
}

/** scrypt then AES-256-GCM: the export a person keeps and types a passphrase for. */
export const passphraseCipher: VaultCipher<string> = {
  seal(plain, image, passphrase) {
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const key = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT);
    return packed({ format: "wsp-vault-1", cipher: "aes-256-gcm", to: "passphrase", salt: b64(salt), nonce: b64(nonce), image }, aad => encrypt(key, nonce, aad, plain));
  },
  open(sealed, passphrase) {
    const { header, aad, body } = unpacked(sealed);
    if (header.to !== "passphrase") throw new Error("this vault was sealed to a place's key, not to a passphrase");
    const key = scryptSync(passphrase, unb64(header.salt), KEY_BYTES, SCRYPT);
    return { image: header.image, plain: decrypt(key, unb64(header.nonce), aad, body) };
  },
};

/** Which side of the place's keypair a call holds: the sender seals to the public key, the place opens with its private one. */
export type VaultKey = { publicKey: KeyObject } | { privateKey: KeyObject };

/** The shared secret stretched to a key, one rule both sides read. */
const derive = (shared: Buffer, salt: Buffer, ephemeral: Buffer): Buffer =>
  Buffer.from(hkdfSync("sha256", shared, salt, Buffer.concat([Buffer.from("wsp-vault-1", "utf8"), ephemeral]), KEY_BYTES));

/** X25519 with an ephemeral key, HKDF-SHA256, AES-256-GCM: what travels to a place, keyed by the place's public
 * key and opened there with its private one. Nothing of the sender's own key is in it, so a vault carries no
 * standing secret of this computer's. */
export const publicKeyCipher: VaultCipher<VaultKey> = {
  seal(plain, image, to) {
    if (!("publicKey" in to)) throw new Error("sealing to a place needs its public key");
    const mine = generateKeyPairSync("x25519");
    const ephemeral = mine.publicKey.export({ type: "spki", format: "der" });
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const key = derive(diffieHellman({ privateKey: mine.privateKey, publicKey: to.publicKey }), salt, ephemeral);
    return packed(
      { format: "wsp-vault-1", cipher: "aes-256-gcm", to: "key", salt: b64(salt), nonce: b64(nonce), ephemeral: b64(ephemeral), image },
      aad => encrypt(key, nonce, aad, plain),
    );
  },
  open(sealed, with_) {
    if (!("privateKey" in with_)) throw new Error("opening a vault sealed to a place needs that place's private key");
    const { header, aad, body } = unpacked(sealed);
    if (header.to !== "key") throw new Error("this vault was sealed to a passphrase, not to a place's key");
    if (header.ephemeral === undefined) throw new Error("this vault names no ephemeral key and cannot be opened");
    const ephemeral = unb64(header.ephemeral);
    const key = derive(diffieHellman({ privateKey: with_.privateKey, publicKey: createPublicKey({ key: ephemeral, type: "spki", format: "der" }) }), unb64(header.salt), ephemeral);
    return { image: header.image, plain: decrypt(key, unb64(header.nonce), aad, body) };
  },
};

/** The record a sealed file names, read without any key: what an import shows before it asks for the passphrase. */
export function sealedImageOf(sealed: Buffer): SealedImage {
  return unpacked(sealed).header.image;
}
