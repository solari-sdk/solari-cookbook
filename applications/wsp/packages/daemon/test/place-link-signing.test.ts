// SPDX-License-Identifier: AGPL-3.0-only
// The known-answer vectors the Rust place link is held to, regenerated here
// from an ed25519 implementation that is not the daemon's: node signs the two
// transcripts with the fixture's key and the bytes must come out as the file
// holds them. The Rust test reads the same file, so a change to what the
// protocol puts on the wire fails on both sides rather than agreeing with
// itself. This is the whole of what node does for a place link.
import { createPublicKey, createPrivateKey, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLACE_UNKNOWN_REFUSAL, placeLinkTranscript, placeRefusalTranscript } from "@wsp/protocol";
import { fixture } from "./fixtures.js";

/** A signature over the bytes both sides build from one function; ed25519 takes no digest name, which is what the null says. */
function signPlaceBytes(privateKeyPem: string, bytes: Uint8Array): string {
  return signBytes(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether the key pinned at join made this signature. */
function verifyPlaceBytes(publicKeyBase64: string, bytes: Uint8Array, signatureBase64: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  return verifyBytes(null, bytes, key, Buffer.from(signatureBase64, "base64"));
}

interface SigningVectors {
  privateKeyPem: string;
  publicKey: string;
  placeId: string;
  placeNonce: string;
  hostNonce: string;
  /** The two X25519 public values the transcript covers, so a carrier that swapped either has signed nothing. */
  placeEphemeral: string;
  hostEphemeral: string;
  hostTranscript: string;
  placeTranscript: string;
  hostSignature: string;
  placeSignature: string;
  /** The refusal a host signs at the first frame, which the place verifies against the key it pinned at join. */
  refusalSentence: string;
  refusalTranscript: string;
  refusalSignature: string;
}

const FILE = "place-link-signing.json";

describe("the place link signing vectors", () => {
  it("regenerates every field of the fixture the Rust link is proven against", () => {
    const v = JSON.parse(fixture(FILE)) as SigningVectors;
    // The place challenges the host, so the place's nonce and its ephemeral come first in the host's transcript,
    // and the host's come first in the place's.
    const host = placeLinkTranscript("host", v.placeId, v.placeNonce, v.hostNonce, { challenger: v.placeEphemeral, answerer: v.hostEphemeral });
    const place = placeLinkTranscript("place", v.placeId, v.hostNonce, v.placeNonce, { challenger: v.hostEphemeral, answerer: v.placeEphemeral });
    // The refusal a host gives before it has proved anything: the place it was asked for, the nonce that dial
    // challenged with, and the sentence, so neither a later dial nor another sentence can carry this signature.
    const refusal = placeRefusalTranscript(v.placeId, v.placeNonce, PLACE_UNKNOWN_REFUSAL);
    const fresh: SigningVectors = {
      ...v,
      hostTranscript: Buffer.from(host).toString("base64"),
      placeTranscript: Buffer.from(place).toString("base64"),
      hostSignature: signPlaceBytes(v.privateKeyPem, host),
      placeSignature: signPlaceBytes(v.privateKeyPem, place),
      refusalSentence: PLACE_UNKNOWN_REFUSAL,
      refusalTranscript: Buffer.from(refusal).toString("base64"),
      refusalSignature: signPlaceBytes(v.privateKeyPem, refusal),
    };
    const text = `${JSON.stringify(fresh, null, 2)}\n`;
    const regenerated = join(tmpdir(), `wsp-${FILE}`);
    writeFileSync(regenerated, text);
    expect(fixture(FILE), `daemon/fixtures/${FILE} is behind. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
    expect(verifyPlaceBytes(v.publicKey, place, fresh.placeSignature)).toBe(true);
    expect(verifyPlaceBytes(v.publicKey, host, fresh.placeSignature)).toBe(false);
    expect(verifyPlaceBytes(v.publicKey, refusal, fresh.refusalSignature)).toBe(true);
    // The nonce is in the bytes, so one dial's refusal proves nothing at the next.
    expect(verifyPlaceBytes(v.publicKey, placeRefusalTranscript(v.placeId, v.hostNonce, PLACE_UNKNOWN_REFUSAL), fresh.refusalSignature)).toBe(false);
  });
});
