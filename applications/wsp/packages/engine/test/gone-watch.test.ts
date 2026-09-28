// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { Machine, MachineBackend } from "../src/machine.js";
import { GONE_READS, GoneWatch, KILL_ASKS, MachineAliveError, readGone } from "../src/golden.js";
import { Workspace } from "../src/lifecycle.js";
import { reap } from "../src/orphans.js";
import { SolariBackend } from "../src/solari-backend.js";
import { splitGateway } from "./split-gateway.js";

const confirm = { graceMs: 50, pollMs: 1 };
/** Every read reaches the holder; the first `empty` deletes land on the copy that never held the machine. */
const emptyDeletes = (empty: number) => {
  let seen = 0;
  return (_call: number, method: string): "holder" | "empty" => (method === "DELETE" && ++seen <= empty ? "empty" : "holder");
};

describe("a background stop read back through a gateway whose copies disagree", () => {
  it("resolves on the provider's first yes and keeps asking behind it until the holder lets the machine go", async () => {
    const { f, holder, deletes } = splitGateway(emptyDeletes(1));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    const watch = new GoneWatch({ confirm, warn: () => {} });
    await watch.stop(b, machine);
    expect(deletes()).toBe(1);
    expect(watch.ids()).toEqual([machine.id]);
    await watch.settled();
    expect([...holder.keys()]).toEqual([]);
    expect(deletes()).toBe(2);
    expect(watch.ids()).toEqual([]);
  });

  it("a read-back that ends with the machine still there is said, and the stop is asked again after the wait until it reads gone", async () => {
    const { f, holder, deletes } = splitGateway(emptyDeletes(KILL_ASKS));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    const said: string[] = [];
    const watch = new GoneWatch({ confirm, retryMs: 5, warn: line => void said.push(line) });
    await watch.stop(b, machine);
    await watch.settled();
    expect([...holder.keys()]).toEqual([]);
    expect(deletes()).toBe(KILL_ASKS + 1);
    expect(said).toEqual([`${new MachineAliveError("sb1", "running").message}; asking again in 0 s`, "machine sb1 read gone after asking again"]);
  });

  it("a watch closed while it waits to ask again asks nothing more", async () => {
    const { f, holder, deletes } = splitGateway(emptyDeletes(Infinity));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    const watch = new GoneWatch({ confirm, retryMs: 60_000, warn: () => {} });
    await watch.stop(b, machine);
    await expect.poll(() => deletes()).toBe(KILL_ASKS);
    watch.close();
    await watch.settled();
    expect(deletes()).toBe(KILL_ASKS);
    expect([...holder.keys()]).toEqual(["sb1"]);
  });

  it("the orphan reap hands each machine to the watch: a delete the empty copy took is asked again and the machine ends gone", async () => {
    const { f, holder } = splitGateway(emptyDeletes(1));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    const watch = new GoneWatch({ confirm, warn: () => {} });
    const listing = [{ id: machine.id, state: "running" as const, labels: { wsp: "1", "wsp-owner": "h_me", createdAt: "2026-09-01T00:00:00Z" } }];
    const { reaped } = await reap({ backend: b, owner: "h_me", listing, knownIds: () => [], stop: m => watch.stop(b, m) });
    expect(reaped.map(r => r.id)).toEqual([machine.id]);
    await watch.settled();
    expect([...holder.keys()]).toEqual([]);
  });

  it("a rebuilt workspace retires the machine it replaced through the watch, so the old one ends gone at the holder", async () => {
    const { f, holder } = splitGateway(emptyDeletes(1));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const old = await b.create({ kind: "sandbox" });
    const watch = new GoneWatch({ confirm, warn: () => {} });
    const ws = new Workspace(old, { goldenSnapshot: "snap_g", wakeAttempts: 1, resurrect: () => b.create({ kind: "sandbox" }), retire: m => watch.stop(b, m) });
    await ws.rebuild();
    await watch.settled();
    expect(ws.machineId).toBe("sb2");
    expect([...holder.keys()]).toEqual(["sb2"]);
  });

  it.each([401, 402, 403])("a %s on a later ask ends the watch with one line: no re-ask can fix it, and the next start's sweep stops the machine", async status => {
    let kills = 0;
    const machine = {
      id: "m1",
      kill: async () => {
        if (++kills > 1) throw Object.assign(new Error(`refused ${status}`), { kind: status === 401 ? "auth" : "plan", status });
      },
      seen: { state: "running" },
    } as unknown as Machine;
    const backend = { get: async () => machine } as unknown as MachineBackend;
    const said: string[] = [];
    const watch = new GoneWatch({ confirm, retryMs: 5, warn: line => void said.push(line) });
    await watch.stop(backend, machine);
    await watch.settled();
    expect(kills).toBe(2);
    expect(said).toEqual([`refused ${status}; not asked again, the next start's sweep stops machine m1`]);
    expect(watch.ids()).toEqual([]);
  }, 2_000);
});

describe("reading whether the provider still has a machine, through a gateway whose copies disagree", () => {
  const gets = (f: ReturnType<typeof splitGateway>["f"]): number => f.mock.calls.filter(c => (c[1]?.method ?? "GET") === "GET").length;

  it("a 404 from the copy that never held the machine is not gone: the next read finds it running", async () => {
    const { f } = splitGateway((call, method) => (method === "GET" && call === 0 ? "empty" : "holder"));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    expect(await readGone(b, machine.id)).toBe("running");
    expect(gets(f)).toBe(2);
  });

  it("a machine neither copy holds reads gone only after GONE_READS reads in a row", async () => {
    const { f, holder } = splitGateway(() => "holder");
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    holder.clear();
    expect(await readGone(b, machine.id)).toBe("gone");
    expect(gets(f)).toBe(GONE_READS);
  });

  /** A backend whose get hands back a bare handle with no state on it, as a linked computer's does: only its
   * state() asks the provider, so that is where the 404 comes from. */
  const bareHandles = (b: MachineBackend): MachineBackend =>
    Object.assign(Object.create(b) as MachineBackend, {
      get: async (id: string) => ({ id, state: async () => (await b.get(id)).seen!.state }) as unknown as Machine,
    });

  it("a 404 from a bare handle's state read counts as a gone read, not a failure", async () => {
    const { f, holder } = splitGateway(() => "holder");
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    holder.clear();
    expect(await readGone(bareHandles(b), machine.id)).toBe("gone");
    expect(gets(f)).toBe(GONE_READS);
  });

  it("a bare handle's state read that lands on the empty copy once is followed by one that finds the machine", async () => {
    const { f } = splitGateway((call, method) => (method === "GET" && call === 0 ? "empty" : "holder"));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const machine = await b.create({ kind: "sandbox" });
    expect(await readGone(bareHandles(b), machine.id)).toBe("running");
    expect(gets(f)).toBe(2);
  });
});
