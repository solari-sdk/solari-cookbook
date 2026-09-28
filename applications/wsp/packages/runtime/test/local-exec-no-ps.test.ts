// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gone, grandchild, sweepStrays } from "./strays.js";

// A whole file of its own because the mock is the case: node hands only five errnos to a spawn's async error path
// and throws every other one straight out of execFile, so the reading of a turn's tree has to survive a throw where
// its callback never runs. EPERM is what this computer answers where ps is out of reach, and ENOMEM is what a full
// box answers; either one used to leave the timer's exception uncaught, which ends the host and every turn on it.
const spawns = vi.hoisted(() => ({ trees: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    execFile: (file: string, ...rest: unknown[]) => {
      if (file === "ps") {
        // Every ps throws, so both readings this module makes meet the throw; only the tree's is counted, since
        // that is the one the idle clock pays for every second. The reap's one read of a leader's age at the end
        // of a run is not a reading of the tree and says nothing about the clock.
        const args = rest[0];
        if (Array.isArray(args) && args.includes("-eo")) spawns.trees++;
        throw Object.assign(new Error("spawn EPERM"), { code: "EPERM", errno: -1, syscall: "spawn ps" });
      }
      return (cp.execFile as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    },
  };
});

const { localExecStream } = await import("../src/local-exec.js");

describe("local exec stream where the group read cannot spawn", () => {
  let root: string;
  let runDir: string;
  /** What escaped the timer instead of being answered as no reading; the first throw lands on the first check, so
   * the listener is on before any stream starts. */
  let escaped: unknown[];
  const onUncaught = (e: unknown): void => void escaped.push(e);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-nops-"));
    runDir = join(root, "runs");
    spawns.trees = 0;
    escaped = [];
    process.on("uncaughtException", onUncaught);
  });
  afterEach(() => {
    process.off("uncaughtException", onUncaught);
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  it("a read that throws where node never calls back leaves this process up, the idle clock on the stream, and still ends the group", async () => {
    const marker = join(root, "busy.pid");
    const factory = localExecStream({ root, runDir, idleMs: 300, deadlineMs: 30_000, pollMs: 20 });
    const stream = factory(`( while :; do :; done ) & echo $! > ${marker}; sleep 20`, { env: {} });
    const busy = await grandchild(marker);
    const lines: string[] = [];
    await expect(
      (async () => {
        for await (const line of stream.lines) lines.push(line);
      })(),
    ).rejects.toThrow(/^stopped after \d+m \d\ds with no output for 0m$/);
    expect(escaped).toEqual([]);
    expect(lines).toEqual([]);
    expect(await stream.exited).toBeNull();
    expect(spawns.trees).toBeGreaterThan(0);
    await gone(busy);
  }, 20_000);

  it("a stream with no idle limit, as the exec verb runs one, never reads its tree at all", async () => {
    const stream = localExecStream({ root, runDir, idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY, pollMs: 20 })("sleep 0.5; echo built", { env: {} });
    const lines: string[] = [];
    for await (const line of stream.lines) lines.push(line);
    expect(lines).toEqual(["built"]);
    expect(await stream.exited).toBe(0);
    expect(spawns.trees).toBe(0);
  }, 20_000);

  it("a stream that never goes quiet for half its idle limit never reads its tree either", async () => {
    const stream = localExecStream({ root, runDir, idleMs: 10_000, deadlineMs: 30_000, pollMs: 20 })("for i in 1 2 3 4 5; do echo tick; sleep 0.1; done", { env: {} });
    const lines: string[] = [];
    for await (const line of stream.lines) lines.push(line);
    expect(lines).toHaveLength(5);
    expect(await stream.exited).toBe(0);
    expect(spawns.trees).toBe(0);
  }, 20_000);
});
