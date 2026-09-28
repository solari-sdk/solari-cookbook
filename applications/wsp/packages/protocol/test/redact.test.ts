// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SECRET_REQUEST_FIELDS, issuesLine, redacted, requestSecrets } from "../src/index.js";

describe("redacted", () => {
  it("blanks every hidden value wherever it appears, and its trimmed form, and skips empty ones", () => {
    expect(redacted("key sk-ant-x-1 then sk-ant-x-1 again", ["sk-ant-x-1"])).toBe("key <redacted> then <redacted> again");
    expect(redacted("the door read sk-ant-x-2.", ["  sk-ant-x-2\n"])).toBe("the door read <redacted>.");
    expect(redacted("nothing here", ["", "   "])).toBe("nothing here");
  });

  it("never blanks a value shorter than four characters once trimmed, so a stray space or letter cannot blank the sentence", () => {
    expect(redacted("unauthorized: ws-80 refused", [" ", "u", "80", " ab "])).toBe("unauthorized: ws-80 refused");
    expect(redacted("the key abcd was refused", ["abcd"])).toBe("the key <redacted> was refused");
  });

  it("blanks the longest value first, so a shorter one that is its prefix leaves no tail", () => {
    const key = "sk-ant-x-probe-key-12345";
    expect(redacted(`Box refused ${key}`, [key.slice(0, 12), key])).toBe("Box refused <redacted>");
  });
});

describe("requestSecrets", () => {
  it("reads the secret fields a request carries, one level into a record, and nothing else", () => {
    expect(SECRET_REQUEST_FIELDS).toEqual(expect.arrayContaining(["token", "key", "rows", "code", "passphrase", "env", "envs"]));
    const frame = { id: 1, op: "init.keys", provider: "box", key: "k1", rows: { "logins/claude": "r1", deep: { x: "no" } }, env: { A: "e1" } };
    expect(requestSecrets(frame).sort()).toEqual(["e1", "k1", "r1"]);
    expect(requestSecrets("not a frame")).toEqual([]);
  });
});

describe("issuesLine", () => {
  it("flattens a schema's issues to one line of path and message", () => {
    const r = z.object({ provider: z.string(), rows: z.record(z.string()) }).safeParse({ provider: 42, rows: { a: 1 } });
    expect(r.success).toBe(false);
    if (r.success) return;
    const line = issuesLine(r.error.issues);
    expect(line).toBe("provider: Expected string, received number; rows.a: Expected string, received number");
    expect(line).not.toContain("\n");
  });
});
