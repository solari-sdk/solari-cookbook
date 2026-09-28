// SPDX-License-Identifier: AGPL-3.0-only
// A record never leaves the store while its machine exists at the provider,
// and the other way round: a workspace machine of this setup's that no record
// claims is recorded again at the sweep, never killed, so it can be seen and
// deleted. A name names at most one workspace, and a fork of a name whose
// workspace is being deleted is refused in words, so the two never interleave.
// A rename takes the same rule the fork's name takes, keeps the record's id
// and machine, and leaves the threads on that machine alone.
import { describe, expect, it, vi } from "vitest";
import { BLANK_NAME_REFUSAL, RECORD_RESTORED, nameDeletingRefusal, nameTakenRefusal, type EventUnion, type WorkspaceTheme } from "@wsp/protocol";
import { copyKey, createRuntime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** A workspace forked by one process whose record the store then lost, seen by a fresh runtime over the same store. */
async function lostRecord(paused = false) {
  const backend = stubBackend();
  const store = memoryStore();
  const first = createRuntime({ backend, store, adapters: {} });
  const ws = await createOn(first, { golden: "snap_g", name: "first" });
  await first.close();
  const machine = backend.machines[0]!;
  machine.spec.labels!["createdAt"] = ago(2 * 60_000);
  machine.paused = paused;
  await store.delete("workspaces", ws.id);
  const rt = createRuntime({ backend, store, adapters: {} });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e));
  return { backend, store, rt, ws, machine, events };
}

describe("the sweep records a machine of this setup that no record claims", () => {
  it("stamps the record's id, name and golden on the fork, so a lost record can be rebuilt from the machine", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    expect(backend.machines[0]!.spec.labels).toMatchObject({ wsp: "1", "wsp-workspace": ws.id, "wsp-name": "first", "wsp-golden": "snap_g", "wsp-owner": expect.stringMatching(/^h_/) });
  });

  it("a running machine with the owner label and no record becomes a running record under its own id and name, is listed, says so once, and is not killed", async () => {
    const { backend, store, rt, ws, machine, events } = await lostRecord();

    const result = await rt.reap();

    expect(result).toEqual({ reaped: [], spared: [], adopted: [{ id: machine.id, workspaceId: ws.id, name: "first", phase: "running" }] });
    expect(machine.killed).toBe(false);
    expect(await rt.workspaces.list()).toMatchObject([{ id: ws.id, name: "first", machineId: machine.id, phase: "running", golden: "snap_g" }]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ id: ws.id, name: "first", machineId: machine.id, phase: "running", firstLife: false });
    expect(events.filter(e => e.type === "workspace.created")).toMatchObject([{ workspace: { id: ws.id, name: "first" } }]);
    expect(events.filter(e => e.type === "workspace.status")).toMatchObject([{ status: { id: ws.id, phase: "running", reason: RECORD_RESTORED } }]);

    // The second sweep finds it claimed; the delete road then works as for any workspace.
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    await rt.workspaces.delete(ws.id);
    expect(machine.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a paused one hydrates napping with the same words", async () => {
    const { rt, ws, machine, events } = await lostRecord(true);
    const result = await rt.reap();
    expect(result.adopted).toEqual([{ id: machine.id, workspaceId: ws.id, name: "first", phase: "napping" }]);
    expect(await rt.workspaces.list()).toMatchObject([{ id: ws.id, phase: "napping" }]);
    expect(events.filter(e => e.type === "workspace.status")).toMatchObject([{ status: { id: ws.id, phase: "napping", machineState: "paused", reason: RECORD_RESTORED } }]);
  });

  it("a machine forked before the stamps is reported, not recorded: this host can name no project for it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [{ version: 1, snapshotId: "snap_head", baseTemplate: "base", setupSha: "x", createdAt: ago(3_600_000), smoke: { cmd: "true", exitCode: 0 } }] });
    const rt = createRuntime({ backend, store, adapters: {} });
    await rt.workspaces.list();
    const { id: owner } = (await store.get("owner", "id")) as { id: string };
    const old = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-host": "1", "wsp-owner": owner, createdAt: ago(2 * 60_000) } });

    const result = await rt.reap();

    // A workspace is one project's copy, so a machine this host can name no project for is reported and left
    // running rather than recorded: nothing here knows what work it holds.
    expect(result.adopted).toBeUndefined();
    expect(result.failed).toMatchObject([{ id: old.id, message: expect.stringContaining("this host holds no project for it") }]);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("leaves a machine inside its create minute for the next sweep, and one the provider no longer knows to the listing's lag", async () => {
    const { backend, rt, ws, machine } = await lostRecord();
    machine.spec.labels!["createdAt"] = ago(30_000);
    const young = await rt.reap();
    expect(young.adopted).toBeUndefined();
    expect(young.spared).toMatchObject([{ id: machine.id, whose: "own" }]);
    expect(await rt.workspaces.list()).toEqual([]);

    machine.spec.labels!["createdAt"] = ago(2 * 60_000);
    const realGet = backend.get.bind(backend);
    backend.get = async id => {
      if (id === machine.id) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
      return realGet(id);
    };
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    expect((await rt.workspaces.list()).map(w => w.id)).not.toContain(ws.id);
  });

  it("a body a rebuild or a wake replaced and failed to stop is not recorded twice: its record lives on the new machine, so the engine kills it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    const { id: owner } = (await store.get("owner", "id")) as { id: string };
    const body = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": owner, "wsp-workspace": ws.id, "wsp-name": "first", "wsp-golden": "snap_g", createdAt: ago(2 * 60_000) } });

    const result = await rt.reap();

    expect(result.adopted).toBeUndefined();
    expect((await rt.workspaces.list()).map(w => [w.id, w.machineId])).toEqual([[ws.id, "m1"]]);
    expect(result.reaped).toMatchObject([{ id: body.id, reason: "own" }]);
    expect(backend.machines.map(m => m.killed)).toEqual([false, true]);
  });

  it("a name a live workspace already holds is not taken twice: the recovered record is named by its machine", async () => {
    const { backend, rt, ws, machine } = await lostRecord();
    const again = await createOn(rt, { golden: "snap_g", name: "first" });
    backend.machines[1]!.spec.labels!["createdAt"] = ago(2 * 60_000);

    const result = await rt.reap();

    expect(result.adopted).toEqual([{ id: machine.id, workspaceId: ws.id, name: machine.id, phase: "running" }]);
    expect((await rt.workspaces.list()).map(w => [w.id, w.name]).sort()).toEqual([[again.id, "first"], [ws.id, machine.id]].sort());
  });

  it("a confirming read the provider refuses leaves the machine for the next sweep: not recorded, not killed, its own words in failed", async () => {
    const { backend, rt, ws, machine } = await lostRecord();
    const realGet = backend.get.bind(backend);
    let refused = false;
    backend.get = async id => {
      if (id === machine.id && !refused) {
        refused = true;
        throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      }
      return realGet(id);
    };

    const first = await rt.reap();

    expect(first.adopted).toBeUndefined();
    expect(first.reaped).toEqual([]);
    expect(first.failed).toEqual([{ id: machine.id, message: "not recorded: Bad Gateway; retried next sweep" }]);
    expect(machine.killed).toBe(false);
    expect(await rt.workspaces.list()).toEqual([]);

    const second = await rt.reap();
    expect(second.adopted).toEqual([{ id: machine.id, workspaceId: ws.id, name: "first", phase: "running" }]);
    expect(machine.killed).toBe(false);
  });

  it("builders, smoke forks, another setup's machines and reserved experiments are never recorded as workspaces", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    await rt.workspaces.list();
    const { id: owner } = (await store.get("owner", "id")) as { id: string };
    const at = ago(2 * 60_000);
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": owner, createdAt: at } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-smoke": "1", "wsp-owner": owner, createdAt: at } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": "h_other", createdAt: at } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": owner, poc: "ttl-test", createdAt: at } });

    const result = await rt.reap();

    expect(result.adopted).toBeUndefined();
    expect(await rt.workspaces.list()).toEqual([]);
    expect(result.reaped.map(r => r.id)).toEqual(["m1", "m2"]);
  });
});

describe("a name names one workspace", () => {
  it("a fork of a name whose workspace is being deleted is refused in words, mints no machine, and lands once the delete is done", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    const machine = backend.machines[0]!;
    let release: (() => void) | undefined;
    machine.kill = () =>
      new Promise<void>(done => {
        release = () => {
          machine.killed = true;
          done();
        };
      });

    const deleting = rt.workspaces.delete(ws.id);
    // The delete holds the name once it has reached the machine; a fork asked for before that meets the plain refusal.
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(createOn(rt, { golden: "snap_g", name: "first" })).rejects.toMatchObject({ message: nameDeletingRefusal("first"), kind: "conflict" });
    expect(backend.machines).toHaveLength(1);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);

    release!();
    await deleting;
    const again = await createOn(rt, { golden: "snap_g", name: "first" });
    expect(again.id).not.toBe(ws.id);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([again.id]);
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
  });

  it("a second delete of the same workspace joins the first: one kill, one drop", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    let kills = 0;
    backend.machines[0]!.kill = async () => {
      kills++;
      backend.machines[0]!.killed = true;
    };
    await Promise.all([rt.workspaces.delete(ws.id), rt.workspaces.delete(ws.id)]);
    expect(kills).toBe(1);
    expect(events.filter(e => e.type === "workspace.deleted")).toHaveLength(1);
  });

  it("two forks of one name asked for together: one lands, the other is refused in words, one machine", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const settled = await Promise.allSettled([createOn(rt, { golden: "snap_g", name: "first" }), createOn(rt, { golden: "snap_g", name: "first" })]);
    expect(settled.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = settled.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ message: nameTakenRefusal("first"), kind: "conflict" });
    expect(backend.machines).toHaveLength(1);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["first"]);
  });

  it("a fork of a name another workspace holds is refused in words and mints no machine", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "a" });
    await expect(createOn(rt, { golden: "snap_g", name: "a" })).rejects.toMatchObject({ message: nameTakenRefusal("a"), kind: "conflict" });
    expect(backend.machines).toHaveLength(1);
    expect(await createOn(rt, { golden: "snap_g", name: "b" })).toMatchObject({ name: "b" });
  });
});

describe("a workspace's look", () => {
  const theme: WorkspaceTheme = { dots: [{ angle: 200, radius: 0.5 }, { angle: 20, radius: 0.5 }], harmony: "complementary", grain: 0.25, opacity: 0.6, mode: "auto" };

  it("holds the theme and the glyph beside the name, one fact at a time, and a fresh runtime reads them back", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));

    expect(await rt.workspaces.look(ws.id, { theme })).toMatchObject({ id: ws.id, theme });
    // The glyph alone: the theme it was not sent stays as it is.
    expect(await rt.workspaces.look(ws.id, { glyph: "flask" })).toMatchObject({ theme, glyph: "flask" });
    expect(await store.get("workspaces", ws.id)).toMatchObject({ theme, glyph: "flask" });
    // Its own event, both facts whole, and never workspace.created: the machine was not touched.
    expect(events.filter(e => e.type === "workspace.look")).toMatchObject([
      { workspaceId: ws.id, theme, glyph: null },
      { workspaceId: ws.id, theme, glyph: "flask" },
    ]);
    expect(events.filter(e => e.type === "workspace.created")).toEqual([]);
    expect(backend.machines[0]!.killed).toBe(false);

    await rt.close();
    const next = createRuntime({ backend, store, adapters: {} });
    expect(await next.workspaces.get(ws.id)).toMatchObject({ theme, glyph: "flask" });
    await next.close();
  });

  it("null clears one fact back to none and leaves the other, and the record loses the key rather than holding an empty one", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    await rt.workspaces.look(ws.id, { theme, glyph: "rocket" });

    expect(await rt.workspaces.look(ws.id, { theme: null })).toMatchObject({ glyph: "rocket" });
    expect(await rt.workspaces.get(ws.id)).not.toHaveProperty("theme");
    expect(await store.get("workspaces", ws.id)).not.toHaveProperty("theme");
    expect(await rt.workspaces.look(ws.id, { glyph: null })).not.toHaveProperty("glyph");
    // A default workspace has neither, so nothing is themed until a person picks.
    expect(await createOn(rt, { golden: "snap_g", name: "second" })).not.toHaveProperty("theme");
  });
});

describe("a rename of a workspace", () => {
  it("names the record, keeps its id and machine, says so once, and the next listing carries it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));

    expect(await rt.workspaces.rename(ws.id, "the name he typed")).toMatchObject({ id: ws.id, name: "the name he typed", machineId: ws.machineId });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["the name he typed"]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ id: ws.id, name: "the name he typed" });
    // Its own event: the record changed, so nothing that meters the machine reads it as one coming up.
    expect(events.filter(e => e.type === "workspace.renamed")).toMatchObject([{ workspaceId: ws.id, name: "the name he typed" }]);
    expect(events.filter(e => e.type === "workspace.created")).toEqual([]);
    // The machine is untouched: the provider takes metadata at create and offers no update, so the name it was
    // forked under stands there until the next fork stamps the record's.
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.spec.labels).toMatchObject({ "wsp-name": "first" });
    expect(backend.machines[0]!.killed).toBe(false);
  });

  it("takes the name the fork's own rule takes: one another workspace holds, one a fork is landing under, and a blank one are refused and nothing is renamed", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const a = await createOn(rt, { golden: "snap_g", name: "a" });
    await createOn(rt, { golden: "snap_g", name: "b" });

    await expect(rt.workspaces.rename(a.id, "b")).rejects.toMatchObject({ message: nameTakenRefusal("b"), kind: "conflict" });
    await expect(rt.workspaces.rename(a.id, "   ")).rejects.toMatchObject({ message: BLANK_NAME_REFUSAL, kind: "conflict" });
    expect(await rt.workspaces.get(a.id)).toMatchObject({ name: "a" });
    // Its own name is no duplicate: the record comes back untouched.
    expect(await rt.workspaces.rename(a.id, "a")).toMatchObject({ id: a.id, name: "a" });
    // A fork of the name is landing this moment, so the rename waits for it as a second fork would.
    const forC = (await projectOn(rt)).id;
    const landing = rt.workspaces.create({ project: forC, golden: "snap_g", name: "c" });
    // The create holds the name once it has resolved its project; the rename below is the second asker.
    await new Promise(done => setImmediate(done));
    await expect(rt.workspaces.rename(a.id, "c")).rejects.toMatchObject({ message: nameTakenRefusal("c"), kind: "conflict" });
    await landing;
    // A fork of the name it gave up lands after it.
    await rt.workspaces.rename(a.id, "d");
    expect(await createOn(rt, { golden: "snap_g", name: "a" })).toMatchObject({ name: "a" });
  });

  it("a blank name is refused a fork too, so the rule the rename takes is the fork's own", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await expect(createOn(rt, { golden: "snap_g", name: " " })).rejects.toMatchObject({ message: BLANK_NAME_REFUSAL, kind: "conflict" });
    expect(backend.machines).toHaveLength(0);
  });

  it("the machine takes the new name at its next fork, so a rebuilt machine carries it", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    await rt.workspaces.rename(ws.id, "the name he typed");
    await rt.workspaces.rebuild(ws.id);
    expect(backend.machines.at(-1)!.spec.labels).toMatchObject({ "wsp-name": "the name he typed", "wsp-workspace": ws.id });
  });

  it("drops the space around the name, as a fork's own name rule does, so nothing has to be typed back for --in", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "  alpha  " });
    expect(ws.name).toBe("alpha");
    expect(backend.machines[0]!.spec.labels).toMatchObject({ "wsp-name": "alpha" });
    expect(await rt.workspaces.rename(ws.id, "  the name he typed  ")).toMatchObject({ name: "the name he typed" });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["the name he typed"]);
    // The trimmed name is the one it holds, so renaming to it again is the no-op, not a duplicate.
    expect(await rt.workspaces.rename(ws.id, "the name he typed")).toMatchObject({ name: "the name he typed" });
  });

  it("a sweep that records this machine after the store lost its workspace document restores the name a person gave, not the fork's", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(first, { golden: "snap_g", name: "first" });
    await first.workspaces.rename(ws.id, "the name he typed");
    await first.close();
    // The machine still wears the name it was forked under: the provider takes metadata at create and offers no update.
    expect(backend.machines[0]!.spec.labels).toMatchObject({ "wsp-name": "first" });
    backend.machines[0]!.spec.labels!["createdAt"] = ago(2 * 60_000);
    await store.delete("workspaces", ws.id);

    const rt = createRuntime({ backend, store, adapters: {} });
    expect(await rt.reap()).toMatchObject({ adopted: [{ workspaceId: ws.id, name: "the name he typed" }] });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["the name he typed"]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ name: "the name he typed" });
    await rt.close();
  });

  it("the name is kept by workspace id, so a rebuild leaves no second copy behind and a delete takes it with the record", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    await rt.workspaces.rename(ws.id, "the name he typed");
    expect(await store.get("workspace-names", ws.id)).toMatchObject({ workspaceId: ws.id, name: "the name he typed" });
    // The machine is replaced but the workspace is not: one row, still under the id its machines carry as a label.
    await rt.workspaces.rebuild(ws.id);
    expect(await store.list("workspace-names")).toHaveLength(1);
    await rt.workspaces.delete(ws.id);
    expect(await store.get("workspace-names", ws.id)).toBeUndefined();
    await rt.close();
  });

  it("a workspace the runtime does not know is refused, and nothing is recorded", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    await expect(rt.workspaces.rename("ws_nope", "a")).rejects.toThrow();
  });
});

describe("a create that fails after its fork", () => {
  /** A store whose first write of a workspace record fails, as a full disk would. */
  const refusingOnce = (inner: Store): Store => {
    let refused = false;
    return {
      ...inner,
      put: async (collection, id, value) => {
        if (collection === "workspaces" && !refused) {
          refused = true;
          throw new Error("ENOSPC: no space left on device, write");
        }
        return inner.put(collection, id, value);
      },
    };
  };

  it("kills the machine and forgets the record when the provider parts with it", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: refusingOnce(memoryStore()), adapters: {} });
    await expect(createOn(rt, { golden: "snap_g", name: "first" })).rejects.toThrow("ENOSPC");
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("keeps the record, listed and deletable, when the machine will not die", async () => {
    const backend = stubBackend();
    const store = refusingOnce(memoryStore());
    const rt = createRuntime({ backend, store, adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const realCreate = backend.create.bind(backend);
    backend.create = async spec => {
      const m = await realCreate(spec);
      m.kill = async () => {
        throw new Error("Bad Gateway");
      };
      return m;
    };

    await expect(createOn(rt, { golden: "snap_g", name: "first" })).rejects.toThrow("ENOSPC");

    const listed = await rt.workspaces.list();
    expect(listed).toMatchObject([{ name: "first", machineId: "m1", phase: "running" }]);
    expect(await store.get("workspaces", listed[0]!.id)).toMatchObject({ name: "first", machineId: "m1" });
    expect(events.filter(e => e.type === "workspace.created")).toMatchObject([{ workspace: { name: "first" } }]);
    expect(backend.machines[0]!.killed).toBe(false);

    backend.machines[0]!.kill = async () => {
      backend.machines[0]!.killed = true;
    };
    await rt.workspaces.delete(listed[0]!.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });
});
