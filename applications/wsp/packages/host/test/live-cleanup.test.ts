// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { cleanupUntilGone, describeLeak } from "./live-cleanup.js";
import { stubBackend } from "./stub-backend.js";

/** A clock the cleanup moves itself: each sleep advances it, so a budget is spent without waiting. */
function timed() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

describe("live cleanup retries until gone", () => {
  it("a kill and a snapshot delete that fail twice then succeed end with nothing leaked, one line per retry, backoff doubling from the start", async () => {
    const backend = stubBackend();
    const m = await backend.create({ kind: "sandbox", template: "base" });
    const kill = m.kill.bind(m);
    let kills = 0;
    m.kill = async () => {
      if (++kills <= 2) throw new Error("fetch failed");
      await kill();
    };
    let deletes = 0;
    backend.deleteSnapshot = async () => {
      if (++deletes <= 2) throw new Error("fetch failed");
    };
    const t = timed();
    const lines: string[] = [];
    const leaked = await cleanupUntilGone(backend, [m.id], ["snap_x"], { budgetMs: 300_000, startMs: 2_000, now: t.now, sleep: t.sleep, log: l => lines.push(l) });
    expect(leaked).toEqual({ machines: [], snapshots: [] });
    expect(await m.state()).toBe("gone");
    expect(kills).toBe(3);
    expect(deletes).toBe(3);
    expect(lines).toEqual([
      `kill ${m.id}: fetch failed; retrying in 2 s`,
      `kill ${m.id}: fetch failed; retrying in 4 s`,
      "delete snapshot snap_x: fetch failed; retrying in 8 s",
      "delete snapshot snap_x: fetch failed; retrying in 16 s",
    ]);
    expect(t.waits).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(describeLeak(leaked)).toBeUndefined();
  });

  it("a machine already gone counts as cleaned without a kill", async () => {
    const backend = stubBackend();
    const m = await backend.create({ kind: "sandbox", template: "base" });
    await m.kill();
    const leaked = await cleanupUntilGone(backend, [m.id], [], { now: () => 0, sleep: async () => {} });
    expect(leaked.machines).toEqual([]);
  });

  it("a kill that never takes and a delete that never succeeds are given up on after the budget, named in the leak line", async () => {
    const backend = stubBackend();
    const m = await backend.create({ kind: "sandbox", template: "base" });
    m.kill = async () => {
      throw new Error("fetch failed");
    };
    backend.deleteSnapshot = async () => {
      throw new Error("fetch failed");
    };
    const t = timed();
    const lines: string[] = [];
    const leaked = await cleanupUntilGone(backend, [m.id], ["snap_a", "snap_b"], { budgetMs: 60_000, startMs: 2_000, now: t.now, sleep: t.sleep, log: l => lines.push(l) });
    expect(leaked).toEqual({ machines: [m.id], snapshots: ["snap_a", "snap_b"] });
    expect(t.now()).toBeLessThanOrEqual(60_000);
    expect(lines.every(l => l.includes(m.id) || l.includes("snap_a") || l.includes("snap_b"))).toBe(true);
    expect(describeLeak(leaked)).toBe(`cleanup gave up after its budget; machines still on the account: ${m.id}; snapshots still on the account: snap_a, snap_b. Kill and delete them by these ids.`);
  });

  it("a snapshot delete that throws missing counts as gone at once: no retry, not in the leak line", async () => {
    const backend = stubBackend();
    let deletes = 0;
    backend.deleteSnapshot = async () => {
      deletes++;
      throw Object.assign(new Error("no such snapshot"), { kind: "missing", status: 404 });
    };
    const t = timed();
    const lines: string[] = [];
    const leaked = await cleanupUntilGone(backend, [], ["snap_gone"], { budgetMs: 60_000, startMs: 2_000, now: t.now, sleep: t.sleep, log: l => lines.push(l) });
    expect(leaked).toEqual({ machines: [], snapshots: [] });
    expect(deletes).toBe(1);
    expect(lines).toEqual([]);
    expect(t.waits).toEqual([]);
    expect(describeLeak(leaked)).toBeUndefined();
  });

  it("a kill that is acknowledged while the machine stays running is retried, not read as done", async () => {
    const backend = stubBackend();
    const m = await backend.create({ kind: "sandbox", template: "base" });
    let kills = 0;
    const kill = m.kill.bind(m);
    m.kill = async () => {
      if (++kills >= 3) await kill();
    };
    const t = timed();
    const lines: string[] = [];
    const leaked = await cleanupUntilGone(backend, [m.id], [], { budgetMs: 300_000, startMs: 2_000, now: t.now, sleep: t.sleep, log: l => lines.push(l) });
    expect(leaked.machines).toEqual([]);
    expect(kills).toBe(3);
    expect(lines).toEqual([`kill ${m.id}: still there; retrying in 2 s`, `kill ${m.id}: still there; retrying in 4 s`]);
  });
});
