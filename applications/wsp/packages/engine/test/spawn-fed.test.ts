// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { spawnSyncFed } from "../src/spawn-fed.js";

describe("a child fed its stdin from bytes", () => {
  it("reads every byte and their end from a file, never from a pipe whose end can be lost", () => {
    const bytes = Buffer.alloc(1024 * 1024, 5);
    const ran = spawnSyncFed("sh", ["-c", "[ -f /dev/stdin ] && echo file; wc -c | tr -d ' '"], bytes, { encoding: "utf8", timeout: 15_000 });
    expect(ran.error).toBeUndefined();
    expect(ran.stdout).toBe(`file\n${bytes.length}\n`);
  });

  it("gives the child nothing to read where the bytes are empty", () => {
    const ran = spawnSyncFed("cat", [], Buffer.alloc(0), { timeout: 15_000 });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toEqual(Buffer.alloc(0));
  });
});
