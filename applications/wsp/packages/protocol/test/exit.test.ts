// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { EXIT_CODES, EXIT_WORDS, ExitClass, RuntimeResponse, VerbFailure, authRefusal, escapeC1, exitClassOf, jsonLine, keptSaid, notFoundRefusal, refusal, refusalLine, refusalParts, usageRefusal, verbFailure } from "../src/index.js";

describe("the exit code every wsp verb answers with", () => {
  it("is one table: ok 0, provider 1, auth 2, usage 3, each class with its words", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, provider: 1, auth: 2, usage: 3 });
    expect(ExitClass.options).toEqual(["ok", "provider", "auth", "usage"]);
    for (const cls of ExitClass.options) expect(EXIT_WORDS[cls], cls).toMatch(/\S/);
    expect(Object.values(EXIT_WORDS).join(" ")).not.toContain("\u2014");
  });

  it("classes an error by the kind stamped on it and never by its words: usage and invalid are usage, auth is auth, everything else is the provider's", () => {
    expect(exitClassOf(usageRefusal("wsp new takes one name.", "usage: wsp new <name>"))).toBe("usage");
    expect(exitClassOf(Object.assign(new Error("2x9 is not a size"), { kind: "invalid" }))).toBe("usage");
    expect(exitClassOf(authRefusal("unauthorized"))).toBe("auth");
    // A name this host holds nothing by is a value nothing takes, whichever door was typed and however far it got.
    expect(exitClassOf(notFoundRefusal("no workspace nope"))).toBe("usage");
    expect(exitClassOf(Object.assign(new Error("unauthorized"), { kind: "auth", status: 401 }))).toBe("auth");
    for (const kind of ["concurrency", "plan", "missing", "conflict", "exists", "transient", "unknown"]) expect(exitClassOf(Object.assign(new Error("no"), { kind })), kind).toBe("provider");
    expect(exitClassOf(new Error("Unknown option '--json'"))).toBe("provider");
    expect(exitClassOf(new Error("no host answered for /x within 20.0s"))).toBe("provider");
    expect(exitClassOf("a string")).toBe("provider");
    expect(exitClassOf(undefined)).toBe("provider");
  });

  it("the failure object is the message, the class and the code the class owns, and parses against its own schema", () => {
    const failure = verbFailure(usageRefusal("wsp forget takes one workspace.", "usage: wsp forget <workspace>"));
    expect(failure).toEqual({ error: "wsp forget takes one workspace. usage: wsp forget <workspace>", class: "usage", exit: 3 });
    expect(VerbFailure.parse(failure)).toEqual(failure);
    expect(verbFailure(authRefusal("the host's token file is missing: /x"))).toEqual({ error: "the host's token file is missing: /x", class: "auth", exit: 2 });
    expect(verbFailure(new Error("no workspace nope"))).toEqual({ error: "no workspace nope", class: "provider", exit: 1 });
    expect(verbFailure("plain")).toEqual({ error: "plain", class: "provider", exit: 1 });
    expect(VerbFailure.safeParse({ error: "x", class: "ok", exit: 0 }).success).toBe(false);
  });

  it("a refusal keeps both halves apart for a client and still prints as the one line the command line always printed", () => {
    const e = refusal("spoo names no user", "Type user@spoo.", "invalid");
    expect(e.message).toBe(refusalLine("spoo names no user", "Type user@spoo."));
    expect(e).toMatchObject({ fix: "Type user@spoo.", kind: "invalid" });
    expect(exitClassOf(e)).toBe("usage");
    expect((refusal("the host is busy", "Try again.") as Error & { kind?: string }).kind).toBeUndefined();
    const usage = usageRefusal("wsp new takes one name.", "usage: wsp new <name>");
    expect(usage.message).toBe("wsp new takes one name. usage: wsp new <name>");
    expect(usage).toMatchObject({ fix: "usage: wsp new <name>", kind: "usage" });
  });

  it("the refused frame declares the fix, so a client that parses the wire keeps it", () => {
    const frame = { id: 1, ok: false, error: "spoo names no user. Type user@spoo.", kind: "invalid", fix: "Type user@spoo." };
    expect(RuntimeResponse.parse(frame)).toEqual(frame);
  });
});

describe("a refusal a host keeps for every client", () => {
  it("reads the halves a refusal was stamped with, and nothing that is not a string", () => {
    expect(refusalParts(refusal("spoo has no curl", "Install it.", "missing"))).toEqual({ said: "spoo has no curl.", fix: "Install it.", kind: "missing" });
    expect(refusalParts(Object.assign(new Error("no"), { fix: 7, kind: null }))).toEqual({ said: "no", fix: undefined, kind: undefined });
    expect(refusalParts("plain")).toEqual({ said: "plain", fix: undefined, kind: undefined });
  });

  it("cuts each line at 400 characters and the lines past the eleventh, saying each cut", () => {
    const lines = ["box did not dial back", "y".repeat(401), ...Array.from({ length: 12 }, (_, n) => `line ${n}`)];
    const kept = keptSaid(lines.join("\n")).split("\n");
    expect(kept).toHaveLength(12);
    expect(kept[1]).toBe(`${"y".repeat(400)} (cut 1 characters)`);
    expect(kept.at(-2)).toBe("line 8");
    expect(kept.at(-1)).toBe("(cut 3 lines)");
    expect(keptSaid("short\nsaid")).toBe("short\nsaid");
  });
});

describe("the JSON a verb prints", () => {
  it("escapes DEL and every C1 control character as JSON.stringify escapes C0, and parses back to the same value", () => {
    const value = { path: "/opt/s\x9b2J\x1b]0;x\x07\x85\x7f", n: 1 };
    const line = jsonLine(value);
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).toContain("\\u009b");
    expect(JSON.parse(line)).toEqual(value);
    const pretty = jsonLine(value, 2);
    expect(pretty).not.toMatch(/[\x7f-\x9f]/);
    expect(JSON.parse(pretty)).toEqual(value);
    expect(escapeC1(JSON.stringify(value))).toBe(line);
  });
});
