// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { mintStamp, mintToken, readStamp, readToken } from "../src/tokens.js";

const KEY = "signing-key-fake";
const now = Date.parse("2026-09-11T12:00:00.000Z");

describe("the tokens the relay signs", () => {
  it("names the host and the account it was minted for", async () => {
    const token = await mintToken(KEY, { kind: "host", subject: "h_1", account: "a_1", issuedAt: now });
    expect(await readToken(KEY, token)).toEqual({ kind: "host", subject: "h_1", account: "a_1", issuedAt: now });
  });

  it("is refused under another key", async () => {
    const token = await mintToken(KEY, { kind: "host", subject: "h_1", account: "a_1", issuedAt: now });
    expect(await readToken("another-key", token)).toBeUndefined();
  });

  it("is refused once its claims are edited", async () => {
    const token = await mintToken(KEY, { kind: "host", subject: "h_1", account: "a_1", issuedAt: now });
    const [payload, signature] = token.split(".");
    const edited = Buffer.from(JSON.stringify({ k: "host", s: "h_2", a: "a_1", t: now })).toString("base64url");
    expect(payload).not.toBe(edited);
    expect(await readToken(KEY, `${edited}.${signature}`)).toBeUndefined();
  });

  it("is refused when it carries no signature at all", async () => {
    expect(await readToken(KEY, "")).toBeUndefined();
    expect(await readToken(KEY, "eyJrIjoiaG9zdCJ9")).toBeUndefined();
  });
});

describe("the stamps that carry a code through a sign-in", () => {
  it("reads back what it was stamped with", async () => {
    const stamp = await mintStamp(KEY, "approve", "ABCD2345", now);
    expect(await readStamp(KEY, "approve", stamp, now + 60_000)).toBe("ABCD2345");
  });

  it("is refused for another purpose, past its window, and when edited", async () => {
    const stamp = await mintStamp(KEY, "approve", "ABCD2345", now);
    expect(await readStamp(KEY, "sign-in", stamp, now)).toBeUndefined();
    expect(await readStamp(KEY, "approve", stamp, now + 20 * 60_000)).toBeUndefined();
    expect(await readStamp(KEY, "approve", `${stamp}x`, now)).toBeUndefined();
  });
});
