// SPDX-License-Identifier: AGPL-3.0-only
// The sealed container: both ways of keying it round trip, neither opens with
// the wrong key, and a header somebody edited fails to open at all.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SealedVaultHeader, type SealedImage } from "@wsp/protocol";
import { passphraseCipher, publicKeyCipher, sealedImageOf } from "../src/vault-cipher.js";

const IMAGE: SealedImage = {
  name: "default",
  version: 1,
  hash: "a".repeat(64),
  recipeHash: "rh",
  logins: [{ name: "codex", state: "signed-in" }],
  sealedAt: "2026-09-12T00:00:00.000Z",
  sealedFrom: "this-mac",
  vault: { sha256: "b".repeat(64), bytes: 128, paths: 2, takenAt: "2026-09-12T00:00:00.000Z" },
};
const PLAIN = Buffer.from("tar bytes that are the person's logins");
const PASSPHRASE = "a-long-enough-passphrase";

const headerOf = (sealed: Buffer): SealedVaultHeader => SealedVaultHeader.parse(JSON.parse(sealed.subarray(0, sealed.indexOf(0x0a)).toString("utf8")));

describe("vault cipher", () => {
  it("a passphrase round trips the bytes and the record, and the header says what it is before any key is asked for", () => {
    const sealed = passphraseCipher.seal(PLAIN, IMAGE, PASSPHRASE);
    expect(headerOf(sealed)).toMatchObject({ format: "wsp-vault-1", cipher: "aes-256-gcm", to: "passphrase" });
    expect(sealedImageOf(sealed)).toEqual(IMAGE);
    expect(sealed.includes(PLAIN)).toBe(false);
    const opened = passphraseCipher.open(sealed, PASSPHRASE);
    expect(opened.plain.equals(PLAIN)).toBe(true);
    expect(opened.image).toEqual(IMAGE);
  });

  it("another passphrase does not open it", () => {
    const sealed = passphraseCipher.seal(PLAIN, IMAGE, PASSPHRASE);
    expect(() => passphraseCipher.open(sealed, `${PASSPHRASE}x`)).toThrow(/would not open/);
  });

  it("a header somebody edited does not open, even with the right passphrase", () => {
    const sealed = passphraseCipher.seal(PLAIN, IMAGE, PASSPHRASE);
    const edited = Buffer.from(sealed);
    const at = edited.indexOf(Buffer.from('"version":1'));
    expect(at).toBeGreaterThan(0);
    edited[at + '"version":'.length] = "2".charCodeAt(0);
    expect(() => passphraseCipher.open(edited, PASSPHRASE)).toThrow(/would not open/);
  });

  it("a file that is not one of ours is refused before any key is derived", () => {
    expect(() => passphraseCipher.open(Buffer.from("not a vault"), PASSPHRASE)).toThrow(/no header line/);
    expect(() => passphraseCipher.open(Buffer.from('{"format":"other"}\nbody'), PASSPHRASE)).toThrow(/not one wsp wrote/);
  });

  it("a place's key round trips, and another place's key does not open it", () => {
    const place = generateKeyPairSync("x25519");
    const other = generateKeyPairSync("x25519");
    const sealed = publicKeyCipher.seal(PLAIN, IMAGE, { publicKey: place.publicKey });
    expect(headerOf(sealed)).toMatchObject({ to: "key" });
    expect(headerOf(sealed).ephemeral).toBeDefined();
    expect(publicKeyCipher.open(sealed, { privateKey: place.privateKey }).plain.equals(PLAIN)).toBe(true);
    expect(() => publicKeyCipher.open(sealed, { privateKey: other.privateKey })).toThrow(/would not open/);
  });

  it("neither cipher opens the other's file", () => {
    const place = generateKeyPairSync("x25519");
    const toKey = publicKeyCipher.seal(PLAIN, IMAGE, { publicKey: place.publicKey });
    const toWord = passphraseCipher.seal(PLAIN, IMAGE, PASSPHRASE);
    expect(() => passphraseCipher.open(toKey, PASSPHRASE)).toThrow(/sealed to a place's key/);
    expect(() => publicKeyCipher.open(toWord, { privateKey: place.privateKey })).toThrow(/sealed to a passphrase/);
  });
});
