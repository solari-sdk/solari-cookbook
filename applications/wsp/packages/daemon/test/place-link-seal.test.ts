// SPDX-License-Identifier: AGPL-3.0-only
// The known-answer vectors the Rust seal is held to. The two ephemerals are
// fixed in the file; everything after them is regenerated here from node's own
// X25519, HKDF and AES-256-GCM and must come out as the file holds them. The
// Rust test reads the same file and starts at the agreed secret, since ring
// makes an ephemeral by generate alone and cannot rebuild one from a fixture:
// that the two stacks agree on the secret itself is proven where they meet,
// against the built binary and on a box.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rawPublicKey, sealKeys, sealWith, sharedSecret } from "@wsp/runtime";
import { fixturePath } from "./fixtures.js";

interface SealVectors {
  note: string;
  placeId: string;
  challengerPrivate: Record<string, string>;
  answererPrivate: Record<string, string>;
  challengerPublic: string;
  answererPublic: string;
  secret: string;
  hostToPlaceKey: string;
  placeToHostKey: string;
  frame: string;
  hostToPlaceSealed: string;
  placeToHostSealed: string;
}

const FILE = "place-link-seal.json";

describe("the place link seal vectors", () => {
  it("regenerates every derived field of the fixture the Rust seal is proven against", () => {
    const path = fixturePath(FILE);
    const v = JSON.parse(readFileSync(path, "utf8")) as SealVectors;
    const challenger = createPrivateKey({ key: v.challengerPrivate, format: "jwk" });
    const answerer = createPrivateKey({ key: v.answererPrivate, format: "jwk" });
    const challengerPublic = rawPublicKey(challenger);
    const answererPublic = rawPublicKey(answerer);
    const secret = sharedSecret(challenger, answererPublic);
    // Each side agrees on the same bytes from its own private key and the other's public one.
    expect(sharedSecret(answerer, challengerPublic).toString("base64")).toBe(secret.toString("base64"));
    const keys = sealKeys(secret, v.placeId);
    const fresh: SealVectors = {
      ...v,
      challengerPublic,
      answererPublic,
      secret: secret.toString("base64"),
      hostToPlaceKey: keys.hostToPlace.toString("base64"),
      placeToHostKey: keys.placeToHost.toString("base64"),
      hostToPlaceSealed: sealWith(keys.hostToPlace, 0n, v.frame).toString("base64"),
      placeToHostSealed: sealWith(keys.placeToHost, 0n, v.frame).toString("base64"),
    };
    const text = `${JSON.stringify(fresh, null, 2)}\n`;
    const regenerated = join(tmpdir(), `wsp-${FILE}`);
    writeFileSync(regenerated, text);
    expect(existsSync(path), `daemon/fixtures/${FILE} is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/${FILE} is behind. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });
});
