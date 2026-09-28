// SPDX-License-Identifier: AGPL-3.0-only
// Every verb that moves a workspace's machine reads the capability naming its own road, never a neighbour's, and
// refuses in the words its own reason has: a machine wsp does not run, a host with no provider at all, or a machine
// wsp does run whose provider is short of that one road.
import { NoProviderBackend } from "@wsp/engine";
import { MACHINE_WSP_FORKS, NO_PROVIDER_LINE, providerCannotRefusal, THIS_COMPUTER } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { copyKey, createRuntime, wiredPlace, type Runtime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";

const version = (n: number) => ({ version: n, snapshotId: `snap_golden-v${n}`, baseTemplate: "base", setupSha: `s${n}`, createdAt: `2026-09-0${n}T00:00:00.000Z`, smoke: { cmd: "true", exitCode: 0 } });

async function setup(): Promise<{ rt: Runtime; backend: StubBackend; store: Store }> {
  const backend = stubBackend();
  const store = memoryStore();
  await store.put("goldens", copyKey("default", "default"), { head: 2, versions: [version(1), version(2)] });
  return { backend, store, rt: createRuntime({ backend, store, adapters: {} }) };
}

/** A container provider's shape: a commit holds no memory, so a fork of an image boots cold and wsp starts the
 * agents on it again. It says nothing about whether the provider can give a machine a new size or stand a fresh
 * one in for it, which is what the three gates below need. */
const forksBootCold = (backend: StubBackend): void => {
  backend.capabilities.liveCloneForks = false;
};

describe("the provider a workspace's view names", () => {
  /** A host wired to one provider module, which is what every fork it holds was made at. The word is the module's
   * own id, so a row on a Box host never reads Solari. */
  const wiredTo = async (id: string): Promise<Runtime> => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey(id, "default"), { head: 2, versions: [version(1), version(2)] });
    return createRuntime({ backend, store, adapters: {}, places: wiredPlace(id, backend) });
  };

  it("a fork carries the id of the provider module this host is wired with, so a row on Box never reads Solari", async () => {
    for (const id of ["box", "solari"]) {
      const rt = await wiredTo(id);
      const ws = await createOn(rt, { on: id, golden: "snap_golden-v1", name: "api" });
      expect([id, ws.provider]).toEqual([id, id]);
      expect([id, (await rt.workspaces.list()).map(w => w.provider)]).toEqual([id, [id]]);
      await rt.close();
    }
  });
});

describe("each verb that moves a machine reads its own capability", () => {
  it("a provider that stands a fresh machine in for another moves a workspace onto a newer image, though its forks boot cold", async () => {
    const { rt, backend, store } = await setup();
    forksBootCold(backend);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const moved = await rt.workspaces.updateImage(ws.id);
    expect(moved).toMatchObject({ moved: true, workspace: { golden: "snap_golden-v2", machineId: "m2" } });
    expect(await store.get("workspaces", ws.id)).toMatchObject({ golden: "snap_golden-v2" });
    await rt.close();
  });

  it("that same provider rebuilds a workspace's machine, though its forks boot cold", async () => {
    const { rt, backend } = await setup();
    forksBootCold(backend);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const rebuilt = await rt.workspaces.rebuild(ws.id);
    expect(rebuilt.machineId).toBe("m2");
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
    await rt.close();
  });

  it("a provider that stands no machine in refuses the replacement, and the machine is untouched", async () => {
    const { rt, backend } = await setup();
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    backend.capabilities.replacesMachine = false;
    await expect(rt.workspaces.upgrade(ws.id)).rejects.toThrow(providerCannotRefusal("api", MACHINE_WSP_FORKS, "have its machine replaced"));
    // The machine is untouched: the gate refused before the engine was asked.
    expect(backend.machines.map(m => m.killed)).toEqual([false]);
    await rt.close();
  });
});

describe("what a refusal calls a machine wsp forks", () => {
  it("names the provider's limit, never this computer", async () => {
    const { rt, backend } = await setup();
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    backend.capabilities.replacesMachine = false;
    backend.capabilities.diskSnapshots = false;
    delete backend.capabilities.pauseMode;
    const gates = [
      ["have its machine replaced", () => rt.workspaces.upgrade(ws.id)],
      ["move to a newer image", () => rt.workspaces.updateImage(ws.id)],
      ["be rebuilt", () => rt.workspaces.rebuild(ws.id)],
      ["be snapshotted", () => rt.workspaces.snapshot(ws.id)],
      ["be paused", () => rt.workspaces.nap(ws.id)],
    ] as const;
    for (const [action, run] of gates) {
      const said = await run().then(() => "", (e: unknown) => (e as Error).message);
      expect([action, said]).toEqual([action, providerCannotRefusal("api", MACHINE_WSP_FORKS, action)]);
      expect(said).not.toContain(THIS_COMPUTER);
    }
    await rt.close();
  });

  it("a host holding cloud records with no provider says no provider is set up here", async () => {
    const { rt, backend, store } = await setup();
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    // The none row's shape at the gate: it offers no size, so this host forks no machine at all and the verbs that
    // move one name that rather than the machine.
    backend.capabilities.sizes = [];
    backend.capabilities.replacesMachine = false;
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(NO_PROVIDER_LINE);
    await expect(rt.workspaces.upgrade(ws.id)).rejects.toThrow(NO_PROVIDER_LINE);
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow(NO_PROVIDER_LINE);
    await rt.close();
    // And the row itself, over the same records: a host restarted without its provider env holds cloud workspaces
    // it can say nothing else about, and none of the three tells a person their fork is their own computer.
    const restarted = createRuntime({ backend: new NoProviderBackend(), store, adapters: {} });
    for (const run of [() => restarted.workspaces.rebuild(ws.id), () => restarted.workspaces.upgrade(ws.id), () => restarted.workspaces.updateImage(ws.id)]) {
      const said = await run().then(() => "", (e: unknown) => (e as Error).message);
      expect([said, said.includes("which wsp does not run")]).toEqual([NO_PROVIDER_LINE, false]);
    }
    await restarted.close();
  });
});
