// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenManifest, GoldenVersion } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { ownershipOf, retentionPlan, snapshotStorage, splitByOwner } from "../src/snapshot-storage.js";
import { OWN_GRACE_MS } from "../src/orphans.js";
import { SNAPSHOT_STORAGE } from "../src/solari-backend.js";

const GB = 1e9;
const NOW = Date.parse("2026-09-08T12:00:00.000Z");
/** Past the grace, so only the mark and the record decide. */
const OLD = new Date(NOW - 3_600_000).toISOString();
const row = (id: string, gb: number) => ({ id, sizeBytes: gb * GB });
const version = (n: number, parent?: number): GoldenVersion => ({ version: n, snapshotId: `snap_v${n}`, baseTemplate: "base", setupSha: "s", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 }, ...(parent !== undefined ? { parentSnapshotId: `snap_v${parent}` } : {}) });
/** Versions sealed before parents were recorded: a linear chain by number. */
const manifest = (head: number, ...versions: number[]): GoldenManifest => ({ head, versions: versions.map(n => version(n)) });
/** Versions with their recorded parents, [version, parent]. */
const chained = (head: number, ...links: [number, number | undefined][]): GoldenManifest => ({ head, versions: links.map(([n, p]) => version(n, p)) });
const nobody = (): string[] => [];

/** Nothing on the account is recorded, so only the name says whose a row is. */
const unrecorded = { hostId: "h1", recorded: new Set<string>(), now: NOW };
const named = (id: string, gb: number, name?: string) => ({ ...row(id, gb), createdAt: OLD, ...(name !== undefined ? { name } : {}) });

describe("snapshot storage", () => {
  it("counts every snapshot on the account and bills the GB past the free tier at the published rate", () => {
    const s = snapshotStorage([row("a", 7.8), row("b", 8.5), row("c", 20), row("d", 3.84)], SNAPSHOT_STORAGE, unrecorded);
    expect(s.count).toBe(4);
    expect(s.totalBytes).toBe(40.14 * GB);
    expect(s.monthlyUsd).toBeCloseTo((40.14 - 10) * 0.05, 6);
    expect(s).toMatchObject({ freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" });
  });

  it("inside the free tier the monthly cost is zero, never negative", () => {
    expect(snapshotStorage([row("a", 7.8)], SNAPSHOT_STORAGE, unrecorded).monthlyUsd).toBe(0);
    expect(snapshotStorage([], SNAPSHOT_STORAGE, unrecorded)).toMatchObject({ count: 0, totalBytes: 0, monthlyUsd: 0 });
  });

  it("splits the sum by who made each snapshot, so the count on the line says why the account holds them", () => {
    const rows = [named("s1", 12, "wsp-h1-default-v1"), named("s2", 20, "wsp-h1-default-v9"), named("s3", 21, "golden-v1"), named("s4", 7, "wsp-zz9-default-v1")];
    const s = snapshotStorage(rows, SNAPSHOT_STORAGE, { hostId: "h1", recorded: new Set(["s1"]), now: NOW });
    expect(s.kept).toEqual({ count: 1, bytes: 12 * GB });
    expect(s.orphans).toEqual({ count: 1, bytes: 20 * GB });
    expect(s.others).toEqual({ count: 2, bytes: 28 * GB });
    expect(s.kept.bytes + s.orphans.bytes + s.others.bytes).toBe(s.totalBytes);
  });
});

describe("who made a snapshot or a template", () => {
  const recorded = new Set(["s1", "tpl_recorded"]);
  /** Old enough that the grace below never decides these rows. */
  const read = { hostId: "h1", recorded, now: NOW };

  it("a row anything records is kept whatever its name, so a snapshot named before the mark existed is never an orphan", () => {
    expect(ownershipOf({ id: "s1", name: "golden-v1" }, read)).toBe("kept");
    expect(ownershipOf({ id: "s1" }, read)).toBe("kept");
  });

  it("this host's mark with nothing recording the id is an orphan", () => {
    expect(ownershipOf({ id: "s9", name: "wsp-h1-default-v9", createdAt: OLD }, read)).toBe("orphan");
    expect(ownershipOf({ id: "s9", name: "wsp-h1-project-spoo-2026", createdAt: OLD }, read)).toBe("orphan");
  });

  it("no mark of this host is foreign, whether it is another host's, a person's own, or a name from before the mark", () => {
    expect(ownershipOf({ id: "s9", name: "wsp-zz9-default-v1", createdAt: OLD }, read)).toBe("foreign");
    expect(ownershipOf({ id: "s9", name: "golden-v1", createdAt: OLD }, read)).toBe("foreign");
    expect(ownershipOf({ id: "s9", name: "base", createdAt: OLD }, read)).toBe("foreign");
    expect(ownershipOf({ id: "s9", createdAt: OLD }, read)).toBe("foreign");
  });

  it("the one split serves snapshots and templates alike", () => {
    const split = splitByOwner([{ id: "tpl_recorded", name: "wsp-h1-default-v1" }, { id: "tpl_old", name: "wsp-h1-old-v1", createdAt: OLD }, { id: "base", name: "base" }], read);
    expect(split.kept.map(t => t.id)).toEqual(["tpl_recorded"]);
    expect(split.orphans.map(t => t.id)).toEqual(["tpl_old"]);
    expect(split.foreign.map(t => t.id)).toEqual(["base"]);
  });

  it("a marked row the provider listed inside the grace is kept: a seal records its snapshot only after the smoke fork, minutes later", () => {
    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const marked = (createdAt?: string) => ({ id: "s9", name: "wsp-h1-default-v9", ...(createdAt !== undefined ? { createdAt } : {}) });
    expect(ownershipOf(marked(at(OWN_GRACE_MS - 1)), read)).toBe("kept");
    expect(ownershipOf(marked(at(0)), read)).toBe("kept");
    expect(ownershipOf(marked(at(OWN_GRACE_MS + 1)), read)).toBe("orphan");
    // Deleting a snapshot cannot be undone, so a row whose age the provider did not give is never offered; the
    // reaper kills an own machine of unknown age, where the cost of waiting is an hourly bill rather than a version.
    expect(ownershipOf(marked(), read)).toBe("kept");
    expect(ownershipOf(marked("not a date"), read)).toBe("kept");
    // A clock behind the provider's reads as age zero, never as a row old enough to delete.
    expect(ownershipOf(marked(new Date(NOW + 60_000).toISOString()), read)).toBe("kept");
  });

  it("without this host's mark there is no split at all, rather than one that claims every unmarked row", () => {
    expect(() => splitByOwner([{ id: "s1", name: "wsp-h1-default-v1" }], { ...read, hostId: "" })).toThrow(/mark/);
  });
});

describe("retention plan", () => {
  const rows = [row("snap_v1", 7.8), row("snap_v2", 8), row("snap_v3", 8.2), row("snap_v4", 8.5)];

  it("keeps the head and its recorded parent and offers the older ancestors oldest first, with what they hold and save", () => {
    const plan = retentionPlan(chained(4, [1, undefined], [2, 1], [3, 2], [4, 3]), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([4, 3]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 2]);
    expect(plan.guarded).toEqual([]);
    expect(plan.parentAssumed).toBe(false);
    expect(plan.freedBytes).toBe(15.8 * GB);
    // 32.5 GB billed at 22.5 over the free tier; 16.7 GB left bills 6.7 over it.
    expect(plan.savesUsdPerMonth).toBeCloseTo(15.8 * 0.05, 6);
  });

  it("once an update seals a new head from the rolled-back version, the branch rolled back from is behind the head and offered as abandoned", () => {
    // v1 to v4, head rolled back to v2, then an update seals v5 from v2.
    const plan = retentionPlan(chained(5, [1, undefined], [2, 1], [3, 2], [4, 3], [5, 2]), [...rows, row("snap_v5", 9)], nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([5, 2]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 3, 4]);
    expect(plan.abandoned.map(v => v.version)).toEqual([3, 4]);
    expect(plan.guarded).toEqual([]);
    expect(plan.parentAssumed).toBe(false);
    expect(plan.freedBytes).toBe((7.8 + 8.2 + 8.5) * GB);
    expect(plan.savesUsdPerMonth).toBeCloseTo((7.8 + 8.2 + 8.5) * 0.05, 6);
  });

  it("an abandoned branch a workspace was forked from is guarded like an ancestor and stays out of the offer", () => {
    const forkedFrom = (id: string): string[] => (id === "snap_v4" ? ["alpha"] : []);
    const plan = retentionPlan(chained(5, [1, undefined], [2, 1], [3, 2], [4, 3], [5, 2]), [...rows, row("snap_v5", 9)], forkedFrom, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([5, 2]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 3]);
    expect(plan.abandoned.map(v => v.version)).toEqual([3]);
    expect(plan.guarded.map(g => [g.version.version, g.workspaces])).toEqual([[4, ["alpha"]]]);
    expect(plan.freedBytes).toBe((7.8 + 8.2) * GB);
  });

  it("a manifest whose head is not among its versions keeps nothing and offers nothing", () => {
    const plan = retentionPlan(chained(9, [1, undefined], [2, 1]), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.abandoned).toEqual([]);
  });

  it("versions sealed before parents were recorded chain by number, and the offer knows the kept parent was assumed", () => {
    const plan = retentionPlan(manifest(4, 1, 2, 3, 4), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([4, 3]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 2]);
    expect(plan.parentAssumed).toBe(true);
    // A recorded parent on the head alone settles the kept pair; the older hops still chain by number.
    const mixed = retentionPlan(chained(5, [1, undefined], [2, undefined], [3, undefined], [4, undefined], [5, 2]), rows, nobody, SNAPSHOT_STORAGE);
    expect(mixed.keep.map(v => v.version)).toEqual([5, 2]);
    expect(mixed.drop.map(v => v.version)).toEqual([1, 3, 4]);
    expect(mixed.abandoned.map(v => v.version)).toEqual([3, 4]);
    expect(mixed.parentAssumed).toBe(false);
  });

  it("a recorded parent no longer in the manifest ends the chain: the head alone is kept and the rest is abandoned", () => {
    const plan = retentionPlan(chained(3, [1, undefined], [3, 9]), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([3]);
    expect(plan.drop.map(v => v.version)).toEqual([1]);
    expect(plan.abandoned.map(v => v.version)).toEqual([1]);
    expect(plan.parentAssumed).toBe(false);
  });

  it("a drop that lands inside the free GB saves nothing, and the parent is the next version down whatever its number", () => {
    const plan = retentionPlan(manifest(4, 1, 2, 4), [row("snap_v1", 3), row("snap_v2", 3), row("snap_v4", 3)], nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([4, 2]);
    expect(plan.drop.map(v => v.version)).toEqual([1]);
    expect(plan.freedBytes).toBe(3 * GB);
    expect(plan.savesUsdPerMonth).toBe(0);
  });

  it("never offers a version a workspace was forked from; it is named with the workspaces on it", () => {
    const forkedFrom = (id: string): string[] => (id === "snap_v1" ? ["alpha", "beta"] : []);
    const plan = retentionPlan(manifest(4, 1, 2, 3, 4), rows, forkedFrom, SNAPSHOT_STORAGE);
    expect(plan.drop.map(v => v.version)).toEqual([2]);
    expect(plan.guarded.map(g => [g.version.version, g.workspaces])).toEqual([[1, ["alpha", "beta"]]]);
    expect(plan.freedBytes).toBe(8 * GB);
  });

  it("with two versions or fewer there is nothing to offer", () => {
    const plan = retentionPlan(manifest(2, 1, 2), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([2, 1]);
    expect(plan.drop).toEqual([]);
    expect(plan.savesUsdPerMonth).toBe(0);
  });

  it("after a rollback alone the versions ahead of the head may still be rolled forward to: neither kept nor offered", () => {
    const plan = retentionPlan(chained(2, [1, undefined], [2, 1], [3, 2], [4, 3]), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([2, 1]);
    expect(plan.drop).toEqual([]);
    expect(plan.abandoned).toEqual([]);
    // The same over a manifest sealed before parents were recorded.
    expect(retentionPlan(manifest(2, 1, 2, 3, 4), rows, nobody, SNAPSHOT_STORAGE).drop).toEqual([]);
  });

  it("a snapshot the listing does not carry counts as holding nothing", () => {
    const plan = retentionPlan(manifest(3, 1, 2, 3), [row("snap_v2", 8), row("snap_v3", 8)], nobody, SNAPSHOT_STORAGE);
    expect(plan.drop.map(v => v.version)).toEqual([1]);
    expect(plan.freedBytes).toBe(0);
    expect(plan.savesUsdPerMonth).toBe(0);
  });
});
