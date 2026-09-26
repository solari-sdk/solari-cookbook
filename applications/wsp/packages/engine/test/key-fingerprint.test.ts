// SPDX-License-Identifier: AGPL-3.0-only
// One spelling of a fingerprint for every key this repo names to a person.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyFingerprint } from "../src/key-fingerprint.js";

describe("a key's fingerprint", () => {
  /** The ed25519 entry of the known_hosts fixture in ssh-backend.test.ts, and what `ssh-keygen -lf` printed for it. */
  const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIC6sV8jQCzynkpUOM40rRIjA7tPstUSjC+A/LVMnAZhP";

  it("is the word every ssh tool prints for the same key", () => {
    expect(keyFingerprint(BLOB)).toBe("SHA256:Ge9MQ9S/Faik2WzsxidRXnoEOJRIHkJKTBkOJ903vq4");
  });

  it("wears that one form for a place link key too, which travels as SPKI DER rather than an ssh blob", () => {
    const der = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(keyFingerprint(der)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(keyFingerprint(der)).not.toBe(keyFingerprint(other));
  });
});
