// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { copyKey, createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";

const GB = 1e9;
const version = (n: number, templateId?: string) => ({
  version: n,
  snapshotId: `snap_golden-v${n}`,
  ...(templateId !== undefined ? { templateId } : {}),
  baseTemplate: "base",
  setupSha: `sha${n}`,
  createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
  smoke: { cmd: "true", exitCode: 0 },
  base: [{ name: "node", version: "22.23.2" }],
  ...(n > 1 ? { parentSnapshotId: `snap_golden-v${n - 1}` } : {}),
});

/** A backend with templates holding a golden of `versions`, each version's snapshot on the account. */
async function seeded(versions: ReturnType<typeof version>[], head = versions.at(-1)!.version) {
  const store = memoryStore();
  const backend = stubBackend();
  backend.capabilities.templates = true;
  await store.put("goldens", copyKey("default", "default"), { head, versions });
  for (const v of versions) {
    backend.snapshots.push({ id: v.snapshotId, sizeBytes: (7 + v.version) * GB, createdAt: v.createdAt });
    await store.put("golden-recipes", copyKey("default", `default@v${v.version}`), { ticks: [], files: [] });
  }
  const rt = createRuntime({ backend, store, adapters: {}, hostId: "h1" });
  return { store, backend, rt };
}

describe("golden templates", () => {
  it("the template's name is wsp-<hex>-<golden>-v<n>: the host's hex id alone, never the hostname, in the character class the provider has taken", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "zingzys-MacBook-Pro.local:9f3a1c2b" });
    await rt.golden.build({ setup: "true", smoke: "true" });
    expect(backend.promoted.map(p => p.name)).toEqual(["wsp-9f3a1c2b-default-v1"]);
    expect(backend.promoted[0]!.name).toMatch(/^[a-z0-9-]+$/);
    // The doctor's road names a version the same way the seal does.
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version(1)] });
    // The snapshot the build sealed carries the same name as its template, since one rule names both.
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [{ ...version(1), snapshotId: "snap_wsp-9f3a1c2b-default-v1" }] });
    const doctorRt = createRuntime({ backend, store, adapters: {}, hostId: "zingzys-MacBook-Pro.local:9f3a1c2b" });
    expect(await doctorRt.golden.promote()).toEqual([{ golden: "default", version: 1, templateId: "tpl_wsp-9f3a1c2b-default-v1", sharing: 1 }]);
  });

  it("a build on a backend with templates seals the version with the template promoted under wsp-<host>-default-v<n>, and the smoke fork boots from it", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1" });
    const frames: string[] = [];
    const { version: sealed } = await rt.golden.build({ setup: "true", smoke: "true", onStage: (stage, detail) => frames.push(detail === undefined ? stage : `${stage}:${detail}`) });
    expect(sealed).toMatchObject({ version: 1, snapshotId: "snap_wsp-h1-default-v1", templateId: "tpl_wsp-h1-default-v1" });
    expect(backend.promoted).toEqual([{ snapshotId: "snap_wsp-h1-default-v1", name: "wsp-h1-default-v1" }]);
    expect(backend.machines[1]!.spec).toMatchObject({ template: "tpl_wsp-h1-default-v1" });
    expect(backend.machines[1]!.spec.fromSnapshot).toBeUndefined();
    expect(frames.filter(f => f.startsWith("promoting"))).toEqual(["promoting:saving the image", "promoting:the image is saved"]);
    expect((await rt.golden.get())!.versions[0]!.templateId).toBe("tpl_wsp-h1-default-v1");
  });

  it("a workspace forks from the version's template when it has one and from the snapshot when it has none; a project golden forks from its own snapshot", async () => {
    const { backend, rt } = await seeded([version(1), version(2, "tpl_two")]);
    backend.templates.set("tpl_two", { id: "tpl_two", name: "wsp-default-v2", status: "ready", snapshotId: "snap_golden-v2" });
    const volatile = await createOn(rt, { golden: "snap_golden-v1", name: "old" });
    const durable = await createOn(rt, { golden: "snap_golden-v2", name: "new" });
    const specOf = (machineId: string) => {
      const { template, fromSnapshot } = backend.machines.find(m => m.id === machineId)!.spec;
      return { template, fromSnapshot };
    };
    expect(specOf(volatile.machineId)).toEqual({ template: undefined, fromSnapshot: "snap_golden-v1" });
    expect(specOf(durable.machineId)).toEqual({ template: "tpl_two", fromSnapshot: undefined });
    // A rebuild is the same fork road: the fresh machine boots from the template too.
    await rt.workspaces.nap(durable.id);
    const rebuilt = await rt.workspaces.rebuild(durable.id);
    expect(specOf(rebuilt.machineId)).toEqual({ template: "tpl_two", fromSnapshot: undefined });
    // A project golden is a snapshot of a fork, not a version: it boots from that snapshot whatever its root version does.
    await backend.snapshots.push({ id: "snap_project", sizeBytes: 9 * GB });
    await rt.close();
    const store2 = memoryStore();
    await store2.put("goldens", "default", { head: 2, versions: [version(1), version(2, "tpl_two")] });
    await store2.put("project-goldens", "snap_project", { snapshotId: "snap_project", golden: "snap_golden-v2", version: 2, workspaceName: "new", createdAt: "2026-09-07T00:00:00Z", project: { name: "app", path: "/root/app", importedAt: "2026-09-07T00:00:00Z" } });
    const rt2 = createRuntime({ backend, store: store2, adapters: {}, hostId: "h1" });
    const task = await createOn(rt2, { golden: "snap_project", name: "task" });
    expect(specOf(task.machineId)).toEqual({ template: undefined, fromSnapshot: "snap_project" });
  });

  it("promote makes a fresh template for every version without one, never adopts a template by name, and says how many already carry the name; a second run finds nothing to do", async () => {
    const { backend, rt } = await seeded([version(1), version(2), version(3, "tpl_three")]);
    // Another host's template under the legacy name, and one under this host's own shape: neither is this version's.
    backend.templates.set("tpl_his", { id: "tpl_his", name: "wsp-default-v1", status: "ready", snapshotId: "snap_other" });
    backend.templates.set("tpl_stale", { id: "tpl_stale", name: "wsp-h1-default-v1", status: "ready", snapshotId: "snap_other2" });
    backend.templates.set("tpl_three", { id: "tpl_three", name: "wsp-h1-default-v3", status: "ready", snapshotId: "snap_golden-v3" });
    expect(await rt.golden.promote()).toEqual([
      { golden: "default", version: 1, templateId: "tpl_wsp-h1-default-v1", sharing: 1 },
      { golden: "default", version: 2, templateId: "tpl_wsp-h1-default-v2", sharing: 0 },
    ]);
    expect(backend.promoted).toEqual([{ snapshotId: "snap_golden-v1", name: "wsp-h1-default-v1" }, { snapshotId: "snap_golden-v2", name: "wsp-h1-default-v2" }]);
    expect((await rt.golden.get())!.versions.map(v => v.templateId)).toEqual(["tpl_wsp-h1-default-v1", "tpl_wsp-h1-default-v2", "tpl_three"]);
    expect(backend.templates.has("tpl_his")).toBe(true);
    expect(await rt.golden.promote()).toEqual([]);
    expect(backend.promoted).toHaveLength(2);
  });

  it("a version whose snapshot is gone is a row saying so and nothing is written at the provider, whatever templates carry its name; the other versions are still recorded", async () => {
    const { backend, rt } = await seeded([version(1), version(2)]);
    backend.snapshots.splice(0, 1);
    backend.templates.set("tpl_his", { id: "tpl_his", name: "wsp-default-v1", status: "ready", snapshotId: "snap_other" });
    expect(await rt.golden.promote()).toEqual([
      { golden: "default", version: 1, error: "its snapshot is gone at the provider" },
      { golden: "default", version: 2, templateId: "tpl_wsp-h1-default-v2", sharing: 0 },
    ]);
    expect(backend.promoted).toEqual([{ snapshotId: "snap_golden-v2", name: "wsp-h1-default-v2" }]);
    expect([...backend.templates.keys()]).toEqual(["tpl_his", "tpl_wsp-h1-default-v2"]);
    expect((await rt.golden.get())!.versions.map(v => v.templateId)).toEqual([undefined, "tpl_wsp-h1-default-v2"]);
  });

  it("a listing the provider will not give leaves the count out of the row and the promote still lands", async () => {
    const { backend, rt } = await seeded([version(1)]);
    backend.listTemplates = async () => {
      throw Object.assign(new Error("upstream unavailable"), { kind: "unavailable", status: 502 });
    };
    expect(await rt.golden.promote()).toEqual([{ golden: "default", version: 1, templateId: "tpl_wsp-h1-default-v1" }]);
  });

  it("promote is undefined on a backend without templates, and a golden that does not exist has nothing to promote", async () => {
    const bare = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    expect(await bare.golden.promote()).toBeUndefined();
    const { rt } = await seeded([version(1)]);
    expect(await rt.golden.promote("other")).toEqual([]);
  });

  it("prune deletes a durable version's template before its snapshot, which the provider refuses to delete while the template stands", async () => {
    const { backend, rt } = await seeded([version(1, "tpl_one"), version(2), version(3), version(4)]);
    backend.templates.set("tpl_one", { id: "tpl_one", name: "wsp-default-v1", status: "ready", snapshotId: "snap_golden-v1" });
    const pruned = await rt.golden.prune();
    expect(pruned.failed).toEqual([]);
    expect(pruned.dropped.map(v => v.version)).toEqual([1, 2]);
    expect(backend.templates.has("tpl_one")).toBe(false);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v3", "snap_golden-v4"]);
  });

  it("a template the provider already lost does not stop the prune: the snapshot still goes", async () => {
    const { backend, rt } = await seeded([version(1, "tpl_gone"), version(2), version(3), version(4)]);
    const pruned = await rt.golden.prune();
    expect(pruned.failed).toEqual([]);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v3", "snap_golden-v4"]);
  });
});
