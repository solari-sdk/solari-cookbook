// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenImport } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { copyKey, createRuntime } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { wsRequest } from "./ws-client.js";

const GB = 1e9;
/** templateHost() takes the part after the last colon, so every name this host writes carries the mark "h1". */
const HOST = "box:h1";
/** Version n sealed from the one before it, as an update chain records them. */
const version = (n: number) => ({
  version: n,
  snapshotId: `snap_golden-v${n}`,
  baseTemplate: "base",
  setupSha: `sha${n}`,
  createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
  smoke: { cmd: "true", exitCode: 0 },
  base: [{ name: "node", version: "22.23.2" }],
  ...(n > 1 ? { parentSnapshotId: `snap_golden-v${n - 1}` } : {}),
});

/** Four sealed versions on the account, sized as the listing would report them, with a recipe stored per version. */
async function fourVersions() {
  const store = memoryStore();
  const backend = stubBackend();
  await store.put("goldens", copyKey("default", "default"), { head: 4, versions: [1, 2, 3, 4].map(version) });
  for (const n of [1, 2, 3, 4]) {
    backend.snapshots.push({ id: `snap_golden-v${n}`, sizeBytes: (7 + n) * GB, createdAt: version(n).createdAt });
    await store.put("golden-recipes", copyKey("default", `default@v${n}`), { ticks: [], files: [] });
  }
  const rt = createRuntime({ backend, store, adapters: {}, hostId: HOST });
  return { store, backend, rt };
}

describe("runtime snapshot storage", () => {
  it("counts every snapshot the provider lists, sizes from the listing, and the monthly cost past the free GB", async () => {
    const { backend, rt } = await fourVersions();
    backend.snapshots.push({ id: "snap_old-golden", sizeBytes: 20 * GB });
    // The four versions are recorded; the fifth carries no mark of this host, so it is named and never touched.
    expect(await rt.golden.storage()).toEqual({
      count: 5, totalBytes: 58 * GB, freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01", monthlyUsd: 48 * 0.05,
      kept: { count: 4, bytes: 38 * GB }, orphans: { count: 0, bytes: 0 }, others: { count: 1, bytes: 20 * GB },
    });
  });

  it("is undefined on a backend that cannot list snapshots, and null over the wire", async () => {
    const backend = stubBackend();
    const { listSnapshots: _l, ...bare } = backend;
    const rt = createRuntime({ backend: { ...bare, capabilities: { ...backend.capabilities, snapshotListing: false } }, store: memoryStore(), adapters: {}, hostId: HOST });
    expect(await rt.golden.storage()).toBeUndefined();
    expect(await rt.golden.retention()).toBeUndefined();
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "snapshots.storage" })).toMatchObject({ ok: true, storage: null });
    await srv.close();
  });

  it("answers snapshots.storage over the wire", async () => {
    const { rt } = await fourVersions();
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "snapshots.storage" })).toMatchObject({ ok: true, storage: { count: 4, totalBytes: 38 * GB, freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01", monthlyUsd: 28 * 0.05, kept: { count: 4, bytes: 38 * GB }, orphans: { count: 0, bytes: 0 }, others: { count: 0, bytes: 0 } } });
    await srv.close();
  });
});

describe("runtime golden retention", () => {
  it("keeps the head and its parent, offers the older ancestors with their size and saving, and prune deletes them and drops their versions and recipes", async () => {
    const { store, backend, rt } = await fourVersions();
    const plan = (await rt.golden.retention())!;
    expect(plan.keep.map(v => v.version)).toEqual([4, 3]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 2]);
    expect(plan.guarded).toEqual([]);
    expect(plan.freedBytes).toBe(17 * GB);
    expect(plan.savesUsdPerMonth).toBeCloseTo(17 * 0.05, 6);

    const pruned = await rt.golden.prune();
    expect(pruned.dropped.map(v => v.version)).toEqual([1, 2]);
    expect(pruned.failed).toEqual([]);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v3", "snap_golden-v4"]);
    expect(await rt.golden.get()).toEqual({ head: 4, versions: [version(3), version(4)] });
    expect(await store.get("golden-recipes", copyKey("default", "default@v1"))).toBeUndefined();
    expect(await store.get("golden-recipes", copyKey("default", "default@v2"))).toBeUndefined();
    expect(await store.get("golden-recipes", copyKey("default", "default@v3"))).toBeDefined();
    expect((await rt.golden.retention())!.drop).toEqual([]);
  });

  it("never offers or deletes a snapshot a running or paused workspace was forked from; the workspace is named", async () => {
    const { backend, rt } = await fourVersions();
    const alpha = await createOn(rt, { golden: "snap_golden-v1", name: "alpha" });
    const beta = await createOn(rt, { golden: "snap_golden-v1", name: "beta" });
    await rt.workspaces.nap(beta.id);
    const plan = (await rt.golden.retention())!;
    expect(plan.drop.map(v => v.version)).toEqual([2]);
    expect(plan.guarded.map(g => [g.version.version, g.workspaces])).toEqual([[1, ["alpha", "beta"]]]);
    expect(plan.freedBytes).toBe(9 * GB);

    const pruned = await rt.golden.prune();
    expect(pruned.dropped.map(v => v.version)).toEqual([2]);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v1", "snap_golden-v3", "snap_golden-v4"]);
    expect((await rt.golden.get())!.versions.map(v => v.version)).toEqual([1, 3, 4]);
    expect((await rt.workspaces.get(alpha.id)).golden).toBe("snap_golden-v1");
  });

  it("a snapshot the provider refuses to delete keeps its version, and the refusal is reported by version", async () => {
    const { backend, rt } = await fourVersions();
    // A machine outside this runtime forked from v1, so the provider answers 409.
    await backend.create({ kind: "sandbox", fromSnapshot: "snap_golden-v1" });
    const pruned = await rt.golden.prune();
    expect(pruned.dropped.map(v => v.version)).toEqual([2]);
    expect(pruned.failed).toEqual([{ version: 1, message: "SnapshotHasChildren" }]);
    expect((await rt.golden.get())!.versions.map(v => v.version)).toEqual([1, 3, 4]);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v1", "snap_golden-v3", "snap_golden-v4"]);
  });

  it("a snapshot the provider no longer has is dropped from the manifest all the same", async () => {
    const { backend, rt } = await fourVersions();
    backend.snapshots.splice(0, 1);
    backend.deleteSnapshot = async () => {
      throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
    };
    const pruned = await rt.golden.prune();
    expect(pruned.dropped.map(v => v.version)).toEqual([1, 2]);
    expect((await rt.golden.get())!.versions.map(v => v.version)).toEqual([3, 4]);
  });

  it("after a rollback the branch rolled back from is left alone until an update seals past it; then it is abandoned and offered, unless a workspace was forked from it", async () => {
    const { store, backend, rt } = await fourVersions();
    await rt.close();
    // The update needs a recipe; the delta below is the smallest one the stages accept.
    const imp: GoldenImport = { recipeHash: "h1", recipe: { ticks: [], files: [] }, files: { count: 0, rungs: {}, bytes: 0, lands: [], skipped: [], pack: async () => ({ tar: Buffer.alloc(0), bytes: 0, unpacked: 0, skipped: [], cut: [], silenced: [], macPaths: [] }) }, tools: [], agents: [] };
    // The stages read free disk and expect the guest to answer a probe; the stub answers both.
    backend.execImpl = (_m, cmd) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${2000 * 1024}\n`, stderr: "" } : cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const updating = createRuntime({ backend, store, adapters: {}, hostId: HOST, goldenRecipe: { setup: "true", smoke: "true", import: imp } });
    await updating.golden.rollback(2);
    // Right after the rollback v3 and v4 are ahead of the head and may still be rolled forward to.
    const rolledBack = (await updating.golden.retention())!;
    expect(rolledBack.keep.map(v => v.version)).toEqual([2, 1]);
    expect(rolledBack.drop).toEqual([]);
    expect(rolledBack.abandoned).toEqual([]);
    const result = await updating.golden.upgrade({ delta: { import: { ...imp, recipeHash: "h2" }, retired: [], retiredOnImage: [] } });
    expect(result.road).toBe("fork");
    // A version sealed now carries this host's mark in the snapshot's name, which is the only place ownership rides.
    expect(result.version).toMatchObject({ version: 5, snapshotId: "snap_wsp-h1-default-v5", parentSnapshotId: "snap_golden-v2" });
    // The stub sizes the new snapshot like a golden.
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v1", "snap_golden-v2", "snap_golden-v3", "snap_golden-v4", "snap_wsp-h1-default-v5"]);
    const plan = (await updating.golden.retention())!;
    expect(plan.keep.map(v => v.version)).toEqual([5, 2]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 3, 4]);
    expect(plan.abandoned.map(v => v.version)).toEqual([3, 4]);
    expect(plan.parentAssumed).toBe(false);
    // A workspace forked from v4 guards it: prune deletes v1 and v3, and v4 stays with its recipe.
    await createOn(updating, { golden: "snap_golden-v4", name: "alpha" });
    const guarded = (await updating.golden.retention())!;
    expect(guarded.drop.map(v => v.version)).toEqual([1, 3]);
    expect(guarded.guarded.map(g => [g.version.version, g.workspaces])).toEqual([[4, ["alpha"]]]);
    const pruned = await updating.golden.prune();
    expect(pruned.dropped.map(v => v.version)).toEqual([1, 3]);
    expect(pruned.failed).toEqual([]);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v2", "snap_golden-v4", "snap_wsp-h1-default-v5"]);
    expect((await updating.golden.get())!.versions.map(v => v.version)).toEqual([2, 4, 5]);
    expect(await store.get("golden-recipes", copyKey("default", "default@v3"))).toBeUndefined();
    expect(await store.get("golden-recipes", copyKey("default", "default@v4"))).toBeDefined();
    await updating.close();
  });

  it("with no golden there is nothing to plan", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, hostId: HOST });
    expect(await rt.golden.retention()).toBeUndefined();
    expect(await rt.golden.prune()).toEqual({ dropped: [], failed: [] });
  });
});
