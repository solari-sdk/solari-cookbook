// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { copyKey, createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { OWN_GRACE_MS } from "@wsp/engine";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";

const GB = 1e9;
/** templateHost() takes the part after the last colon, so this host's mark on every name it writes is "h1". */
const HOST = "box:h1";
const NOW = Date.parse("2026-09-08T12:00:00.000Z");
/** Past OWN_GRACE_MS, so the grace never decides these rows: only the mark and the record do. */
const OLD = new Date(NOW - 3_600_000).toISOString();

const version = (n: number, templateId?: string) => ({
  version: n,
  snapshotId: `snap_wsp-h1-default-v${n}`,
  ...(templateId !== undefined ? { templateId } : {}),
  baseTemplate: "base",
  setupSha: `sha${n}`,
  createdAt: `2026-09-0${n}T00:00:00.000Z`,
  smoke: { cmd: "true", exitCode: 0 },
});

/** One sealed version this host records, one snapshot and one template this host made that nothing records, one
 * snapshot from before the mark existed and one another host sealed. */
async function account(): Promise<{ backend: StubBackend; rt: ReturnType<typeof createRuntime>; store: ReturnType<typeof memoryStore> }> {
  const store = memoryStore();
  const backend = stubBackend();
  backend.capabilities.templates = true;
  await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version(1, "tpl_wsp-h1-default-v1")] });
  backend.snapshots.push(
    { id: "snap_wsp-h1-default-v1", name: "wsp-h1-default-v1", sizeBytes: 12 * GB, createdAt: OLD },
    { id: "snap_orphan", name: "wsp-h1-default-v9", sizeBytes: 20 * GB, createdAt: OLD },
    { id: "snap_before", name: "golden-v1", sizeBytes: 21 * GB, createdAt: OLD },
    { id: "snap_other", name: "wsp-zz9-default-v1", sizeBytes: 7 * GB, createdAt: OLD },
  );
  for (const t of [
    { id: "tpl_wsp-h1-default-v1", name: "wsp-h1-default-v1", snapshotId: "snap_wsp-h1-default-v1" },
    // Standing on the orphan snapshot, so the provider refuses that snapshot while this template lives.
    { id: "tpl_wsp-h1-old-v1", name: "wsp-h1-old-v1", snapshotId: "snap_orphan" },
    { id: "base", name: "base", snapshotId: "" },
  ]) backend.templates.set(t.id, { ...t, status: "ready", createdAt: OLD });
  const rt = createRuntime({ backend, store, adapters: {}, hostId: HOST, clock: fakeClock(NOW).clock });
  return { backend, rt, store };
}

describe("who owns what on the account", () => {
  it("the storage line splits the listing into this host's recorded, this host's orphans and what carries no mark of it", async () => {
    const { rt } = await account();
    const storage = (await rt.golden.storage())!;
    expect(storage.count).toBe(4);
    expect(storage.kept).toEqual({ count: 1, bytes: 12 * GB });
    expect(storage.orphans).toEqual({ count: 1, bytes: 20 * GB });
    expect(storage.others).toEqual({ count: 2, bytes: 28 * GB });
  });

  it("names this host's orphan snapshot and template, and names what is left alone beside them", async () => {
    const { rt } = await account();
    const plan = (await rt.golden.orphans())!;
    expect(plan.snapshots.map(r => r.id)).toEqual(["snap_orphan"]);
    expect(plan.templates.map(t => t.id)).toEqual(["tpl_wsp-h1-old-v1"]);
    expect(plan.others.snapshots.map(r => r.name)).toEqual(["golden-v1", "wsp-zz9-default-v1"]);
    expect(plan.others.templates.map(t => t.name)).toEqual(["base"]);
    expect(plan.freedBytes).toBe(20 * GB);
    // 60 GB on the account, 40 GB once the orphan goes, both past the free 10 GB.
    expect(plan.savesUsdPerMonth).toBeCloseTo(20 * 0.05, 6);
  });

  it("deletes this host's orphans and nothing else: the snapshot from before the mark and another host's both stay", async () => {
    const { rt, backend } = await account();
    const done = (await rt.golden.deleteOrphans())!;
    expect(done.snapshots.map(r => r.id)).toEqual(["snap_orphan"]);
    expect(done.templates.map(t => t.id)).toEqual(["tpl_wsp-h1-old-v1"]);
    expect(done.failed).toEqual([]);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
    expect([...backend.templates.keys()]).toEqual(["tpl_wsp-h1-default-v1", "base"]);
    expect((await rt.golden.orphans())!.snapshots).toEqual([]);
  });

  it("deletes the orphan template before the snapshot it stands on, which the provider refuses in the other order", async () => {
    const { rt, backend } = await account();
    const done = (await rt.golden.deleteOrphans())!;
    expect(done.failed).toEqual([]);
    expect(done.templates.map(t => t.id)).toEqual(["tpl_wsp-h1-old-v1"]);
    expect(done.snapshots.map(r => r.id)).toEqual(["snap_orphan"]);
    expect(backend.snapshots.map(r => r.id)).not.toContain("snap_orphan");
  });

  it("a snapshot a live workspace forks from is recorded, so it is never an orphan whatever its name", async () => {
    const { rt, backend } = await account();
    backend.snapshots.push({ id: "snap_forked", name: "wsp-h1-default-v8", sizeBytes: 5 * GB, createdAt: OLD });
    await createOn(rt, { golden: "snap_forked", name: "alpha" });
    expect((await rt.golden.orphans())!.snapshots.map(r => r.id)).toEqual(["snap_orphan"]);
    await rt.golden.deleteOrphans();
    expect(backend.snapshots.map(r => r.id)).toContain("snap_forked");
    await rt.close();
  });

  it("a project golden this host took is recorded by its own document, not by a version", async () => {
    const { rt, backend, store } = await account();
    backend.snapshots.push({ id: "snap_project", name: "wsp-h1-project-spoo-2026-09-08", sizeBytes: 9 * GB, createdAt: OLD });
    await store.put("project-goldens", "snap_project", { snapshotId: "snap_project", project: { name: "spoo", path: "/root/spoo" }, golden: "snap_wsp-h1-default-v1", workspaceId: "w1", workspaceName: "alpha", createdAt: "2026-09-08T00:00:00.000Z" });
    expect((await rt.golden.orphans())!.snapshots.map(r => r.id)).toEqual(["snap_orphan"]);
    expect((await rt.golden.storage())!.kept).toEqual({ count: 2, bytes: 21 * GB });
  });

  it("a delete the provider refuses leaves the row on the account and names it, and the rest still go", async () => {
    const { rt, backend } = await account();
    // A machine outside this runtime forked from the orphan, so the provider answers 409.
    await backend.create({ kind: "sandbox", fromSnapshot: "snap_orphan" });
    const done = (await rt.golden.deleteOrphans())!;
    expect(done.snapshots).toEqual([]);
    expect(done.templates.map(t => t.id)).toEqual(["tpl_wsp-h1-old-v1"]);
    expect(done.failed).toEqual([{ id: "snap_orphan", name: "wsp-h1-default-v9", message: "SnapshotHasChildren" }]);
    expect(backend.snapshots.map(r => r.id)).toContain("snap_orphan");
  });

  it("a snapshot this host marked moments ago is never an orphan: a seal records its snapshot only after the kill, the promote and the smoke fork", async () => {
    const { rt, backend } = await account();
    // Where a seal in flight leaves its snapshot: marked, nothing recording it yet, taken seconds ago.
    backend.snapshots.push(
      { id: "snap_sealing", name: "wsp-h1-default-v2", sizeBytes: 9 * GB, createdAt: new Date(NOW - 5_000).toISOString() },
      { id: "snap_sealing_edge", name: "wsp-h1-default-v3", sizeBytes: 1 * GB, createdAt: new Date(NOW - (OWN_GRACE_MS - 1)).toISOString() },
    );
    backend.templates.set("tpl_promoting", { id: "tpl_promoting", name: "wsp-h1-default-v2", status: "ready", snapshotId: "snap_sealing", createdAt: new Date(NOW - 5_000).toISOString() });
    const plan = (await rt.golden.orphans())!;
    expect(plan.snapshots.map(r => r.id)).toEqual(["snap_orphan"]);
    expect(plan.templates.map(t => t.id)).toEqual(["tpl_wsp-h1-old-v1"]);
    // Counted as this host's and kept, not as another host's, so the line never disowns a snapshot it just took.
    expect((await rt.golden.storage())!.kept).toEqual({ count: 3, bytes: 22 * GB });

    await rt.golden.deleteOrphans();
    expect(backend.snapshots.map(r => r.id)).toContain("snap_sealing");
    expect(backend.snapshots.map(r => r.id)).toContain("snap_sealing_edge");
    expect([...backend.templates.keys()]).toContain("tpl_promoting");
  });

  it("on a backend that lists no snapshots there is nothing to split and nothing to delete", async () => {
    const bare = stubBackend();
    const { listSnapshots: _l, ...rest } = bare;
    const rt = createRuntime({ backend: { ...rest, capabilities: { ...bare.capabilities, snapshotListing: false } }, store: memoryStore(), adapters: {}, hostId: HOST });
    expect(await rt.golden.orphans()).toBeUndefined();
    expect(await rt.golden.deleteOrphans()).toBeUndefined();
  });
});
