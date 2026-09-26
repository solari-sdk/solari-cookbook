// SPDX-License-Identifier: AGPL-3.0-only
// A machine the provider stopped knowing settles its record to gone through
// one road, whichever call saw the 404: the poll, a nap, a wake's read or the
// sweep. The awake stretch closes there, the idle clock is dropped, the row's
// words name the call and the time, and the host log carries one line. A poll
// that began before the record settled lands nothing. A nap the provider
// refuses in words (Not pausable) is a refusal that stands for the machine,
// not a vanish.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GONE_UNCHECKED, goneRefusal, goneWords, napRefusedLine, NOT_GONE, type EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { GONE_READS, NapRefusedError, SolariBackend, type MachineBackend } from "@wsp/engine";
import { backstopMs } from "../src/idle.js";
import { createRuntime, type RuntimeOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubMachine, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { splitGateway } from "../../engine/test/split-gateway.js";

const WINDOW = 5 * 60_000;
const POLL = 15_000;
const COST = 60_000;
/** Short enough that releasing the confirm never fires the poll or the cost ticker with it. */
const CONFIRM = 4_000;
const T0 = Date.parse("2026-09-07T01:20:00Z");

type Cost = EventUnion & { type: "workspace.cost" };

/** `provider` serves the runtime in place of the stub, for a test whose machines live behind a real backend. */
type Seed = { backend?: ReturnType<typeof stubBackend>; provider?: MachineBackend; store?: ReturnType<typeof memoryStore> };

function testRuntime(extra: Partial<RuntimeOptions> = {}, seed: Seed = {}) {
  const backend = seed.backend ?? stubBackend();
  const store = seed.store ?? memoryStore();
  const fc = fakeClock(T0);
  const rt = createRuntime({
    backend: seed.provider ?? backend,
    store,
    adapters: {},
    clock: fc.clock,
    idle: { defaultWindowMs: WINDOW },
    status: { costIntervalMs: COST, pollIntervalMs: POLL, reconcileMinMs: 0, probeTimeoutMs: 5_000 },
    // The confirming read runs on the same tick unless a test is about the wait itself.
    goneConfirmMs: 0,
    ...extra,
  });
  const statuses: WorkspaceStatus[] = [];
  const costs: Cost[] = [];
  const events: EventUnion[] = [];
  rt.events.on("*", e => {
    events.push(e);
    if (e.type === "workspace.status") statuses.push(e.status);
    if (e.type === "workspace.cost") costs.push(e);
  });
  return { rt, backend, store, fc, statuses, costs, events };
}

const missing = (message: string) => Object.assign(new Error(message), { kind: "missing", status: 404 });

/** The provider's answer to a pause it will not do, as the Solari backend types its 409. */
const notPausable = (machineId: string) => new NapRefusedError(machineId, "Not pausable");

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
  openServers.length = 0;
});

/** The edge answers for the machine, not the daemon, and only when the test says: a probe waits in `held` until the test
 * answers it (404) or drops it (a failed reach); either way the poll goes on to ask the provider, in the order the test picks. */
async function edgeHolding(m: StubMachine): Promise<{ held: ServerResponse[]; fromDaemon: boolean; answer: (res: ServerResponse) => void; drop: (res: ServerResponse) => void }> {
  const held: ServerResponse[] = [];
  const server = createServer((_req, res) => void held.push(res));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  openServers.push(server);
  const port = (server.address() as { port: number }).port;
  m.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
  // fromDaemon set, the answer is the daemon's own (426), which sends nobody to the provider.
  const edge = { held, fromDaemon: false, answer: (res: ServerResponse) => void res.writeHead(edge.fromDaemon ? 426 : 404).end(), drop: (res: ServerResponse) => void res.destroy() };
  return edge;
}

const countReads = (m: StubMachine): { n: number } => {
  const state = m.state.bind(m);
  const reads = { n: 0 };
  m.state = async () => {
    reads.n++;
    return state();
  };
  return reads;
};

const goneLines = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map(c => String(c[0])).filter(l => /is gone/.test(l));

describe("a 404 settles the record gone through one road", () => {
  it("from the status poll: the stretch closes with a cost tick at that instant, the idle clock is dropped, the words name the poll and the time, one log line, and a poll that began before lands nothing", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const reads = countReads(m);
      const pause = vi.spyOn(m, "pause");
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => reads.n >= 1);
        fc.advance(COST);
        const polls = COST / POLL;
        await until(() => edge.held.length >= polls);
        // All but one of the polls the advance fired land now; the last stays in flight across the kill.
        for (const res of edge.held.splice(0, polls - 1)) edge.answer(res);
        await until(() => costs.some(c => c.awakeMs === COST) && reads.n >= polls);
        expect(costs.at(-1)).toMatchObject({ phase: "running", awakeMs: COST });
        expect(costs.at(-1)!.rateUsdPerHour).toBeCloseTo(0.11);

        const gets = vi.spyOn(backend, "get");
        m.killed = true;
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 2);
        edge.answer(edge.held.pop()!);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone" && costs.at(-1)!.phase === "gone");

        const record = await rt.workspaces.get(ws.id);
        expect(record.gone).toBe(goneWords("m1", { by: "status poll", at: seenAt }));
        expect(record.gone).toBe("machine m1 is gone at the provider: the status poll found it gone at 2026-09-07T01:21:15Z");
        const pushed = statuses.at(-1)!;
        expect(pushed).toMatchObject({ id: ws.id, phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: record.gone });
        expect(pushed.idleAt).toBeUndefined();
        expect((await rt.status.list())[0]!.idleAt).toBeUndefined();
        // The tick at the gone instant: the stretch ends at the last proof the machine was awake, and no rate follows.
        expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, awakeMs: COST, at: new Date(seenAt).toISOString() });
        const accrued = costs.at(-1)!.accruedUsd;
        fc.advance(COST);
        await until(() => costs.at(-1)!.at === new Date(fc.clock.now()).toISOString());
        expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, awakeMs: COST, accruedUsd: accrued });
        // The poll left in flight lands now, a minute on: its reach failed, it asks the provider and hears gone, and
        // the row it built on the running record it read is dropped, so nothing after the gone row says running.
        const rows = statuses.length;
        // The kill pass read the state once, the poll's read, and confirmed its verdict with GONE_READS reads of the machine.
        expect(reads.n).toBe(polls + 1);
        expect(gets.mock.calls.filter(c => c[0] === m.id)).toHaveLength(GONE_READS);
        edge.drop(edge.held.shift()!);
        await until(() => reads.n >= polls + 2);
        await new Promise(r => setImmediate(r));
        expect(statuses.slice(rows)).toEqual([]);
        expect(edge.held.length).toBe(0);
        expect(goneLines(warn)).toEqual([`workspace ${ws.id} is gone: ${record.gone}`]);
        fc.advance(WINDOW * 2);
        expect(pause).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("from an idle nap: gone, not a refusal; no window re-armed, the words name the pause and quote the 404, the stretch closes, one log line", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      let calls = 0;
      m.pause = async () => {
        calls++;
        m.killed = true;
        throw missing("Sandbox not found");
      };
      fc.advance(WINDOW);
      const seenAt = fc.clock.now();
      await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone" && costs.at(-1)!.phase === "gone");

      const record = await rt.workspaces.get(ws.id);
      expect(record.gone).toBe(goneWords("m1", { by: "pause", at: seenAt, answer: "404 Sandbox not found" }));
      expect(record.gone).toBe("machine m1 is gone at the provider: the pause found it gone at 2026-09-07T01:25:00Z (404 Sandbox not found)");
      expect(statuses.map(s => s.phase)).toEqual(["pausing", "gone"]);
      expect(statuses.at(-1)).toMatchObject({ machineState: "gone", reach: { state: "gone" }, reason: record.gone });
      expect(statuses.at(-1)!.idleAt).toBeUndefined();
      expect((await rt.status.list())[0]!.idleAt).toBeUndefined();
      expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, at: new Date(seenAt).toISOString() });
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`workspace ${ws.id} is gone: ${record.gone}`]);
      fc.advance(WINDOW * 2);
      await new Promise(r => setImmediate(r));
      expect(calls).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("from a nap asked for: the caller hears the provider's error and the record is gone", async () => {
    const { rt, backend } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.pause = async () => {
        m.killed = true;
        throw missing("Sandbox not found");
      };
      await expect(rt.workspaces.nap(ws.id)).rejects.toThrow("Sandbox not found");
      const record = await rt.workspaces.get(ws.id);
      expect(record.phase).toBe("gone");
      expect(record.gone).toMatch(/^machine m1 is gone at the provider: the pause found it gone at .* \(404 Sandbox not found\)$/);
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(goneRefusal("wake", record.gone));
    } finally {
      warn.mockRestore();
    }
  });

  it("from a wake's read of a record that says running: gone, and the wake is refused with the gone sentence", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.killed = true;
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow("Workspace machine is gone; rebuild it to wake");
      const record = await rt.workspaces.get(ws.id);
      expect(record.phase).toBe("gone");
      expect(record.gone).toMatch(/^machine m1 is gone at the provider: the wake found it gone at \S+Z$/);
      expect(statuses.at(-1)).toMatchObject({ phase: "gone", reason: record.gone });
      expect(m.resumes).toBe(0);
      expect(goneLines(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("from the sweep: a recorded machine the listing lacks is read once; gone settles the record, a machine still there is left alone", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = await createOn(rt, { golden: "snap_g", name: "a" });
      const b = await createOn(rt, { golden: "snap_g", name: "b" });
      const c = await createOn(rt, { golden: "snap_g", name: "c" });
      const [ma, mb, mc] = backend.machines as [StubMachine, StubMachine, StubMachine];
      ma.killed = true;
      // The listing lags: b is missing from it but the provider still has it; c answers 404 in words to the read.
      const list = backend.list.bind(backend);
      backend.list = async labels => (await list(labels)).filter(r => r.id !== mb.id && r.id !== mc.id);
      const readsB = countReads(mb);
      mc.state = async () => {
        throw missing("Sandbox not found");
      };
      const get = backend.get.bind(backend);
      backend.get = async id => {
        if (id === mc.id) throw missing("Sandbox not found");
        return get(id);
      };
      await rt.reap();

      expect((await rt.workspaces.get(a.id)).gone).toMatch(/^machine m1 is gone at the provider: the sweep found it gone at \S+Z$/);
      expect((await rt.workspaces.get(b.id)).phase).toBe("running");
      expect(readsB.n).toBe(1);
      expect((await rt.workspaces.get(c.id)).gone).toMatch(/^machine m3 is gone at the provider: the sweep found it gone at \S+Z \(404 Sandbox not found\)$/);
      expect(statuses.filter(s => s.phase === "gone").map(s => s.id).sort()).toEqual([a.id, c.id].sort());
      expect(goneLines(warn)).toHaveLength(2);
      // A second sweep asks nothing about a record already gone.
      const readsA = countReads(ma);
      await rt.reap();
      expect(readsA.n).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the host's metrics as the early warning", () => {
  /** How many times the provider was asked for the machine's state and for the host's metrics. */
  const countAsks = (m: StubMachine): { state: number; metrics: number } => {
    const asks = { state: 0, metrics: 0 };
    const state = m.state.bind(m);
    const metrics = m.metrics.bind(m);
    m.state = async () => {
      asks.state++;
      return state();
    };
    m.metrics = async () => {
      asks.metrics++;
      return metrics();
    };
    return asks;
  };
  const doubtLines = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map(c => String(c[0])).filter(l => /^host metrics for/.test(l));
  /** One status pass over the edge the test controls: the pass is awaited, so what it asked is known when it returns. */
  const pass = async (rt: ReturnType<typeof testRuntime>["rt"], edge: Awaited<ReturnType<typeof edgeHolding>>, reconcile: "always" | "on-failure"): Promise<WorkspaceStatus> => {
    const rows = rt.status.list({ reconcile });
    await until(() => edge.held.length >= 1);
    edge.answer(edge.held.shift()!);
    return (await rows)[0]!;
  };

  it("a metrics 404 with the daemon's probe missed on the same pass leaves the record running: the state read said running, so the row does, and the gap is one logged line", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const asks = countAsks(m);
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.state >= 1 && asks.metrics >= 1);
        expect((await rt.workspaces.get(ws.id)).phase).toBe("running");

        m.hostLost = true;
        fc.advance(POLL);
        await until(() => edge.held.length >= 1);
        edge.drop(edge.held.shift()!);
        await until(() => asks.state >= 2 && doubtLines(warn).length === 1);
        // A second pass with the guest missing again: still one witness, and one witness is not a verdict.
        fc.advance(POLL);
        await until(() => edge.held.length >= 1);
        edge.drop(edge.held.shift()!);
        await until(() => asks.state >= 3);

        const record = await rt.workspaces.get(ws.id);
        expect(m.killed).toBe(false);
        expect(record.phase).toBe("running");
        expect(record.gone).toBeUndefined();
        expect(statuses.filter(s => s.machineState === "gone")).toEqual([]);
        expect(statuses.at(-1)).toMatchObject({ id: ws.id, phase: "running", machineState: "running" });
        expect(statuses.at(-1)!.idleAt).toBe(T0 + WINDOW);
        expect(costs.filter(c => c.phase === "gone")).toEqual([]);
        expect(goneLines(warn)).toEqual([]);
        expect(doubtLines(warn)).toEqual([`host metrics for m1 (workspace ${ws.id}) answered 404 host no longer knows this VM; the state read says running and the record follows the state read`]);
        expect(asks).toEqual({ state: 3, metrics: 3 });
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a metrics 404 over a machine the state read answers 404 for settles the record gone as before, and the words quote that read", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const asks = countAsks(m);
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.state >= 1 && asks.metrics >= 1);

        m.hostLost = true;
        m.killed = true;
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 1);
        edge.drop(edge.held.shift()!);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone" && costs.at(-1)!.phase === "gone");

        const record = await rt.workspaces.get(ws.id);
        expect(record.gone).toBe(goneWords("m1", { by: "status poll", at: seenAt }));
        expect(record.gone).toBe("machine m1 is gone at the provider: the status poll found it gone at 2026-09-07T01:20:15Z");
        expect(statuses.at(-1)).toMatchObject({ id: ws.id, phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: record.gone });
        expect(statuses.at(-1)!.idleAt).toBeUndefined();
        expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, at: new Date(seenAt).toISOString() });
        expect(goneLines(warn)).toEqual([`workspace ${ws.id} is gone: ${record.gone}`]);
        // The metrics read never spoke: the state read answered 404 before it was reached.
        expect(doubtLines(warn)).toEqual([]);
        expect(asks.metrics).toBe(1);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a metrics 404 while the daemon answers on the same pass is one logged line and nothing else, on an explicit refresh too", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      edge.fromDaemon = true;
      const asks = countAsks(m);
      m.hostLost = true;

      const first = await pass(rt, edge, "always");
      expect(first).toMatchObject({ phase: "running", machineState: "running", reach: { state: "reachable" } });
      expect(first.reason).toBeUndefined();
      expect(asks).toEqual({ state: 1, metrics: 1 });
      expect(doubtLines(warn)).toEqual([`host metrics for m1 (workspace ${ws.id}) answered 404 host no longer knows this VM; the state read says running and the record follows the state read`]);

      const second = await pass(rt, edge, "always");
      expect(second).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
      expect(asks).toEqual({ state: 2, metrics: 2 });
      expect(doubtLines(warn)).toHaveLength(1);
      expect(goneLines(warn)).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      expect(statuses.filter(s => s.machineState === "gone")).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("the edge speaking for the machine is not the daemon missing: a metrics 404 there leaves the record running while the guest still answers exec", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const asks = countAsks(m);
      m.hostLost = true;
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => doubtLines(warn).length === 1);
        fc.advance(POLL);
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.state >= 2);
      } finally {
        stop();
      }
      // A full pass after the poll's: anything the poll settled has landed by now.
      const row = await pass(rt, edge, "on-failure");
      expect(row).toMatchObject({ phase: "running", machineState: "running" });
      expect(asks).toEqual({ state: 3, metrics: 3 });
      expect(doubtLines(warn)).toHaveLength(1);
      expect(goneLines(warn)).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      expect(statuses.filter(s => s.machineState === "gone")).toEqual([]);
      expect(await m.exec("echo ok")).toMatchObject({ exitCode: 0 });

      // The guest missing on a later pass adds no witness the state read has not already outvoted.
      const later = rt.status.list({ reconcile: "on-failure" });
      await until(() => edge.held.length >= 1);
      edge.drop(edge.held.shift()!);
      expect((await later)[0]).toMatchObject({ machineState: "running" });
      expect(goneLines(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a metrics read that fails any other way changes nothing, and metrics ride only the passes that ask the provider", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const metrics = m.metrics.bind(m);
      const asks = countAsks(m);
      let failing = true;
      m.metrics = async () => {
        asks.metrics++;
        if (failing) throw Object.assign(new Error("Bad Gateway"), { kind: "transient", status: 502 });
        return metrics();
      };
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.metrics >= 1 && statuses.length >= 1);
        expect(asks).toEqual({ state: 1, metrics: 1 });
        expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
        expect(statuses.at(-1)).toMatchObject({ phase: "running", machineState: "running" });
        expect(warn.mock.calls).toEqual([]);
      } finally {
        stop();
      }

      // The guest answers the next passes itself: the provider is not asked, so neither are its metrics.
      failing = false;
      edge.fromDaemon = true;
      expect(await pass(rt, edge, "on-failure")).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
      expect(await pass(rt, edge, "on-failure")).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
      expect(asks).toEqual({ state: 1, metrics: 1 });
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a gone verdict is checked against the state read before it ends a turn", () => {
  /** A machine whose next state read answers 404 and whose later ones answer as they always did. */
  const flakeOnce = (m: StubMachine): void => {
    const state = m.state.bind(m);
    let flaky = true;
    m.state = async () => {
      if (!flaky) return state();
      flaky = false;
      throw missing("Sandbox not found");
    };
  };

  it("one 404 over a machine that is there: the record stays running, the row is corrected, and the log says it is not gone", async () => {
    const { rt, backend, fc, statuses, events } = testRuntime({ goneConfirmMs: CONFIRM });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => statuses.length >= 1);

        flakeOnce(m);
        const reads = countReads(m);
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 1);
        const timers = fc.pending();
        edge.drop(edge.held.shift()!);
        // The verdict is waiting on its confirming read: nothing has ended, and the record has not moved.
        await until(() => fc.pending() > timers);
        expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
        expect(reads.n).toBe(1);

        fc.advance(CONFIRM);
        await until(() => warn.mock.calls.length >= 1);
        await new Promise(r => setImmediate(r));
        const saw = goneWords("m1", { by: "status poll", at: seenAt, answer: "404 Sandbox not found" });
        expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`workspace ${ws.id} is not gone: ${saw}, and the state read that followed said running`]);
        expect(events.filter(e => e.type === "workspace.gone")).toEqual([]);
        const record = await rt.workspaces.get(ws.id);
        expect(record.phase).toBe("running");
        expect(record.gone).toBeUndefined();
        expect(statuses.at(-1)).toMatchObject({ id: ws.id, phase: "running", machineState: "running", reason: NOT_GONE });
        // The window was never dropped, so it still runs from the create that armed it.
        expect(statuses.at(-1)!.idleAt).toBe(T0 + WINDOW);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("the state read agrees after the wait: the record settles gone and its turn ends, and nothing settled before the wait was up", async () => {
    const { rt, backend, fc, events } = testRuntime({ goneConfirmMs: CONFIRM });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "running");

        m.killed = true;
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 1);
        const timers = fc.pending();
        edge.drop(edge.held.shift()!);
        await until(() => fc.pending() > timers);
        expect((await rt.workspaces.get(ws.id)).phase).toBe("running");

        fc.advance(CONFIRM);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone");
        expect((await rt.workspaces.get(ws.id)).gone).toBe(goneWords("m1", { by: "status poll", at: seenAt }));
        expect(events.filter(e => e.type === "workspace.gone")).toHaveLength(1);
        expect(goneLines(warn)).toHaveLength(1);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("the state read a short wait later says paused: a machine the provider holds is not a machine it lost", async () => {
    const { rt, backend, fc, events } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "running");

        // The 404 the poll met is followed by a read that finds the machine paused at the provider.
        const state = m.state.bind(m);
        let flaky = true;
        m.state = async () => {
          if (!flaky) return state();
          flaky = false;
          m.paused = true;
          throw missing("Sandbox not found");
        };
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 1);
        edge.drop(edge.held.shift()!);
        await until(() => warn.mock.calls.length >= 1);

        expect((await rt.workspaces.get(ws.id)).gone).toBeUndefined();
        expect(events.filter(e => e.type === "workspace.gone")).toEqual([]);
        expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
          `workspace ${ws.id} is not gone: ${goneWords("m1", { by: "status poll", at: seenAt, answer: "404 Sandbox not found" })}, and the state read that followed said paused`,
        ]);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a pause the provider answers 404 for over a machine that is there is a refused pause, not a vanish", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.pause = async () => {
        throw missing("Sandbox not found");
      };
      await expect(rt.workspaces.nap(ws.id)).rejects.toThrow("Sandbox not found");
      const record = await rt.workspaces.get(ws.id);
      expect(record.phase).toBe("running");
      expect(record.gone).toBeUndefined();
      expect(statuses.map(s => s.phase)).toEqual(["pausing", "running"]);
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
        `workspace ${ws.id} is not gone: ${goneWords("m1", { by: "pause", at: T0, answer: "404 Sandbox not found" })}, and the state read that followed said running`,
      ]);
      // The row carries the provider's answer, as any refused pause does.
      expect(statuses.at(-1)).toMatchObject({ phase: "running", machineState: "running", reason: "Sandbox not found" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a 404 settles nothing until the provider answers gone twelve reads in a row", () => {
  /** A record made on the stub, then served by the Solari backend over the split gateway, whose holder runs its
   * machine; the next `lies.n` reads of it land on the copy that never held it. */
  const onSplitGateway = async () => {
    const t = testRuntime();
    const ws = await createOn(t.rt, { golden: "snap_g", name: "a" });
    await t.rt.close();
    const lies = { n: 0 };
    const gw = splitGateway((_call, method) => (method === "GET" && lies.n > 0 && lies.n-- > 0 ? "empty" : "holder"));
    gw.holder.set(ws.machineId, "running");
    const solari: MachineBackend = new SolariBackend({ apiKey: "k", fetch: gw.f });
    return { ws, store: t.store, gw, lies, solari };
  };

  it("the record load: two 404s over a machine the holder runs leave the record running, never gone at rate 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, store, lies, solari } = await onSplitGateway();
      lies.n = 2;
      const t = testRuntime({}, { store, provider: solari });
      try {
        const record = await t.rt.workspaces.get(ws.id);
        expect(record.phase).toBe("running");
        expect(record.gone).toBeUndefined();
        expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
        expect(t.events.filter(e => e.type === "workspace.gone")).toEqual([]);
        expect(t.costs.filter(c => c.phase === "gone")).toEqual([]);
        expect(goneLines(warn)).toEqual([]);
      } finally {
        await t.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("the record load: a machine the provider answers 404 for twelve reads in a row settles gone once the host serves, through the one road to gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, store, gw, solari } = await onSplitGateway();
      gw.holder.delete(ws.machineId);
      const t = testRuntime({}, { store, provider: solari });
      try {
        await until(async () => (await t.rt.workspaces.get(ws.id)).phase === "gone");
        expect(gw.f.mock.calls.filter(c => (c[1]?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(1 + GONE_READS);
        const words = (await t.rt.workspaces.get(ws.id)).gone!;
        expect(words).toMatch(/^machine m1 is gone at the provider: the record load found it gone at \S+Z \(404 [^)]*\)$/);
        expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "gone", gone: words });
        // The event, the row and the meter move with the record, as they do on every other road to gone.
        const gone = t.events.filter(e => e.type === "workspace.gone");
        expect(gone).toHaveLength(1);
        expect(gone[0]).toMatchObject({ workspaceId: ws.id, machineId: "m1", reason: words });
        expect(t.statuses.at(-1)).toMatchObject({ id: ws.id, phase: "gone", reason: words });
        await until(() => t.costs.some(c => c.workspaceId === ws.id && c.phase === "gone"));
        expect(t.costs.filter(c => c.phase === "gone").every(c => c.rateUsdPerHour === 0)).toBe(true);
        expect(goneLines(warn)).toEqual([`workspace ${ws.id} is gone: ${words}`]);
      } finally {
        await t.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a host start over records whose machines answer 404 serves at once, and confirms them after", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const made = [];
      for (const name of ["a", "b", "c"]) made.push(await createOn(t.rt, { golden: "snap_g", name }));
      await t.rt.close();
      // Every machine is gone, and every read after the first one of each waits until the test lets it answer.
      for (const m of t.backend.machines) m.killed = true;
      let release!: () => void;
      const held = new Promise<void>(r => (release = r));
      const first = new Set<string>();
      const get = t.backend.get.bind(t.backend);
      t.backend.get = async id => {
        if (first.has(id)) await held;
        first.add(id);
        return get(id);
      };
      const second = testRuntime({}, { store: t.store, backend: t.backend });
      try {
        const listed = await second.rt.workspaces.list();
        expect(listed.map(w => w.phase)).toEqual(["running", "running", "running"]);
        expect(second.events.filter(e => e.type === "workspace.gone")).toEqual([]);
        release();
        await until(async () => (await second.rt.workspaces.list()).every(w => w.phase === "gone"));
        expect(second.events.filter(e => e.type === "workspace.gone").map(e => (e as { workspaceId: string }).workspaceId).sort()).toEqual(made.map(w => w.id).sort());
      } finally {
        await second.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a wake's read: two 404s over a machine the holder runs leave the record running and the wake answers running", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, store, lies, solari } = await onSplitGateway();
      const t = testRuntime({}, { store, provider: solari });
      try {
        expect((await t.rt.workspaces.get(ws.id)).phase).toBe("running");
        lies.n = 2;
        expect(await t.rt.workspaces.wake(ws.id)).toMatchObject({ phase: "running", machineId: ws.machineId });
        const record = await t.rt.workspaces.get(ws.id);
        expect(record.phase).toBe("running");
        expect(record.gone).toBeUndefined();
        expect(t.events.filter(e => e.type === "workspace.gone")).toEqual([]);
        expect(t.costs.filter(c => c.phase === "gone")).toEqual([]);
        expect(t.statuses.filter(s => s.phase === "gone")).toEqual([]);
      } finally {
        await t.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["a 404 and then reads that fail", 1],
    ["a first read that fails", 0],
  ])("the record load: %s leave the host serving and the record as it was, and the next sweep reads it again", async (_, lies) => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(t.rt, { golden: "snap_g", name: "a" });
      const other = await createOn(t.rt, { golden: "snap_g", name: "b" });
      await t.rt.close();
      const m = t.backend.machines[0]!;
      const get = t.backend.get.bind(t.backend);
      let left = lies;
      let down = true;
      t.backend.get = async id => {
        if (id === m.id && left > 0) {
          left--;
          throw missing("Sandbox not found");
        }
        if (id === m.id && down) throw Object.assign(new Error("Bad gateway"), { kind: "provider", status: 502 });
        return get(id);
      };
      const second = testRuntime({}, { store: t.store, backend: t.backend });
      try {
        expect(await second.rt.workspaces.get(ws.id)).toMatchObject({ phase: "running", machineId: m.id });
        expect(await second.rt.workspaces.get(other.id)).toMatchObject({ phase: "running" });
        expect(await t.store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
        expect(second.events.filter(e => e.type === "workspace.gone")).toEqual([]);

        // The sweep's read finds the machine, and the record is served on it: a pause reaches the provider.
        down = false;
        await second.rt.reap();
        expect(await second.rt.workspaces.nap(ws.id)).toMatchObject({ phase: "napping", machineId: m.id });
        expect(m.paused).toBe(true);
      } finally {
        await second.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("reads that fail after the 404 leave the machine claimed and running, and the next sweep asks again", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const state = m.state.bind(m);
      m.state = async () => {
        m.state = state;
        throw missing("Sandbox not found");
      };
      // Every read after the wake's 404 fails as a gateway that answers nothing.
      const get = backend.get.bind(backend);
      let down = true;
      backend.get = async id => {
        if (down && id === m.id) throw Object.assign(new Error("Bad gateway"), { kind: "provider", status: 502 });
        return get(id);
      };
      expect(await rt.workspaces.wake(ws.id)).toMatchObject({ phase: "running" });
      expect((await rt.workspaces.get(ws.id)).gone).toBeUndefined();
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
        `workspace ${ws.id} is not gone: ${goneWords("m1", { by: "wake", at: T0, answer: "404 Sandbox not found" })}, and the reads that followed failed: Bad gateway`,
      ]);

      // The sweep meets the same: its row says nothing was learned, not that the machine was found.
      const list = backend.list.bind(backend);
      backend.list = async labels => (await list(labels)).filter(r => r.id !== m.id);
      m.state = async () => {
        m.state = state;
        throw missing("Sandbox not found");
      };
      await rt.reap();
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      expect(statuses.at(-1)).toMatchObject({ id: ws.id, phase: "running", reason: GONE_UNCHECKED });
      down = false;
      const swept = await rt.reap();
      expect(swept.reaped).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      m.killed = true;
      await rt.reap();
      expect((await rt.workspaces.get(ws.id)).gone).toMatch(/^machine m1 is gone at the provider: the sweep found it gone at \S+Z/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a record marked gone recovers on a state read that says running", () => {
  /** A record settled gone by a wake over a machine the provider then has again: what the incident left behind. */
  const wronglyGone = async (t: ReturnType<typeof testRuntime>) => {
    const ws = await createOn(t.rt, { golden: "snap_g", name: "a" });
    const m = t.backend.machines[0]!;
    m.killed = true;
    await expect(t.rt.workspaces.wake(ws.id)).rejects.toThrow(goneRefusal("wake", (await t.rt.workspaces.get(ws.id)).gone));
    expect((await t.rt.workspaces.get(ws.id)).phase).toBe("gone");
    m.killed = false;
    return { ws, m };
  };

  it("a wake: the record follows the read back to running and nothing is resumed", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, m } = await wronglyGone(t);
      expect(await t.rt.workspaces.wake(ws.id)).toMatchObject({ phase: "running", machineId: "m1" });
      const record = await t.rt.workspaces.get(ws.id);
      expect(record.phase).toBe("running");
      expect(record.gone).toBeUndefined();
      expect(m.resumes).toBe(0);
      expect(t.backend.machines).toHaveLength(1);
      expect(t.statuses.at(-1)).toMatchObject({ id: ws.id, phase: "running", machineState: "running", reason: NOT_GONE });
      expect((await t.rt.status.list())[0]).toMatchObject({ phase: "running", machineState: "running", machineId: "m1" });
    } finally {
      warn.mockRestore();
    }
  });

  it("a rebuild: the healthy machine is kept rather than abandoned, and no second machine is built", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, m } = await wronglyGone(t);
      expect(await t.rt.workspaces.rebuild(ws.id)).toMatchObject({ phase: "running", machineId: "m1" });
      expect(t.backend.machines).toHaveLength(1);
      expect(m.killed).toBe(false);
      expect((await t.rt.workspaces.get(ws.id)).gone).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("the sweep: a machine the listing still carries under a gone record is read once and the record follows it", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, m } = await wronglyGone(t);
      const reads = countReads(m);
      await t.rt.reap();
      expect(reads.n).toBe(1);
      expect((await t.rt.workspaces.get(ws.id))).toMatchObject({ phase: "running", machineId: "m1" });
      expect((await t.rt.workspaces.get(ws.id)).gone).toBeUndefined();
      expect(t.backend.machines).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("the sweep, over a machine the provider holds paused: the record leaves gone as napping, on the same predicate", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, m } = await wronglyGone(t);
      m.paused = true;
      await t.rt.reap();
      const record = await t.rt.workspaces.get(ws.id);
      expect(record).toMatchObject({ phase: "napping", machineId: "m1" });
      expect(record.gone).toBeUndefined();
      expect(t.backend.machines).toHaveLength(1);
      expect(t.statuses.at(-1)).toMatchObject({ id: ws.id, phase: "napping", reason: NOT_GONE });
      // The wake road takes it from there the way it takes any napping record: one resume, the same machine.
      expect(await t.rt.workspaces.wake(ws.id)).toMatchObject({ phase: "running", machineId: "m1" });
      expect(m.resumes).toBe(1);
      expect(t.backend.machines).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("the record load, over a machine the provider holds paused: the record leaves gone as napping, on the same predicate", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws, m } = await wronglyGone(t);
      m.paused = true;
      await t.rt.close();
      expect(await t.store.get("workspaces", ws.id)).toMatchObject({ phase: "gone" });

      const second = testRuntime({}, { store: t.store, backend: t.backend });
      try {
        expect(await second.rt.workspaces.get(ws.id)).toMatchObject({ phase: "napping", machineId: "m1" });
        expect((await second.rt.workspaces.get(ws.id)).gone).toBeUndefined();
        expect(await t.store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
        expect(((await t.store.get("workspaces", ws.id)) as { gone?: string }).gone).toBeUndefined();
      } finally {
        await second.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a stored gone record whose machine the provider still runs hydrates running, and the words go with it", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ws } = await wronglyGone(t);
      await t.rt.close();
      expect(await t.store.get("workspaces", ws.id)).toMatchObject({ phase: "gone" });

      const second = testRuntime({}, { store: t.store, backend: t.backend });
      try {
        expect(await second.rt.workspaces.get(ws.id)).toMatchObject({ phase: "running", machineId: "m1" });
        expect((await second.rt.workspaces.get(ws.id)).gone).toBeUndefined();
        expect(await t.store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
        expect(((await t.store.get("workspaces", ws.id)) as { gone?: string }).gone).toBeUndefined();
      } finally {
        await second.rt.close();
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the awake meter across a verdict that did not hold", () => {
  const GAP = 3 * 60_000;

  it("a recovery reopens the stretch the gone verdict closed, so the hours the machine went on billing are metered", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(t.rt, { golden: "snap_g", name: "a" });
      const m = t.backend.machines[0]!;
      await until(() => t.costs.some(c => c.phase === "running"));
      expect(t.costs.at(-1)).toMatchObject({ phase: "running", awakeMs: 0 });

      m.killed = true;
      await expect(t.rt.workspaces.wake(ws.id)).rejects.toThrow(goneRefusal("wake", (await t.rt.workspaces.get(ws.id)).gone));
      await until(() => t.costs.some(c => c.phase === "gone"));
      expect(t.costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, awakeMs: 0 });

      // The machine was never gone: it ran and billed through the whole gap, and the read that unmakes the verdict
      // has to hand those hours back to the stretch rather than start a new one here.
      m.killed = false;
      t.fc.advance(GAP);
      expect(await t.rt.workspaces.wake(ws.id)).toMatchObject({ phase: "running", machineId: "m1" });
      await until(() => t.costs.at(-1)!.phase === "running");
      expect(t.costs.at(-1)).toMatchObject({ phase: "running", awakeMs: GAP });
      expect(t.costs.at(-1)!.rateUsdPerHour).toBeCloseTo(0.11);

      // The reopened stretch is the stored one, so a host that reads the series back meters those hours too.
      expect((await t.rt.status.history(ws.id)).at(-1)).toMatchObject({ phase: "running", awakeMs: GAP });
    } finally {
      warn.mockRestore();
    }
  });

  it("a rebuild out of gone leaves the closed stretch closed: the new machine's first tick counts none of the gap", async () => {
    const t = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(t.rt, { golden: "snap_g", name: "a" });
      const m = t.backend.machines[0]!;
      m.killed = true;
      await expect(t.rt.workspaces.wake(ws.id)).rejects.toThrow(goneRefusal("wake", (await t.rt.workspaces.get(ws.id)).gone));
      await until(() => t.costs.some(c => c.phase === "gone"));
      t.fc.advance(GAP);
      expect(await t.rt.workspaces.rebuild(ws.id)).toMatchObject({ phase: "running", machineId: "m2" });
      await until(() => t.costs.at(-1)!.phase === "running");
      expect(t.costs.at(-1)).toMatchObject({ phase: "running", awakeMs: 0 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a nap the provider refuses in words", () => {
  /** A machine whose pause is refused until the test says otherwise, with every call counted. */
  const refusingPause = (m: StubMachine): { calls: number; refusing: boolean } => {
    const pause = m.pause.bind(m);
    const said = { calls: 0, refusing: true };
    m.pause = async () => {
      said.calls++;
      if (said.refusing) throw notPausable(m.id);
      await pause();
    };
    return said;
  };
  const vaultPuts = (store: ReturnType<typeof memoryStore>): { n: number } => {
    const putBlob = store.putBlob.bind(store);
    const puts = { n: 0 };
    store.putBlob = async (collection, id, blob) => {
      if (collection === "vaults") puts.n++;
      return putBlob(collection, id, blob);
    };
    return puts;
  };

  it("Not pausable is a refusal that stands for the machine: the next window is the backstop, the sentence is on the row and on the poll, the log names the provider's answer once, and the record stays running", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const pause = refusingPause(backend.machines[0]!);
      fc.advance(WINDOW);
      const answered = fc.clock.now();
      await until(() => statuses.some(s => s.phase === "running" && s.idleAt === answered + backstopMs(WINDOW)));
      expect(pause.calls).toBe(1);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      expect(statuses.at(-1)).toMatchObject({ phase: "running", machineState: "running", reason: napRefusedLine("Not pausable"), idleAt: answered + backstopMs(WINDOW) });
      expect((await rt.status.list())[0]).toMatchObject({ reason: napRefusedLine("Not pausable"), idleAt: answered + backstopMs(WINDOW) });
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`the provider does not pause m1 of ${ws.id} (Not pausable); an idle nap waits for the backstop and exports no vault until a pause lands`]);
      fc.advance(backstopMs(WINDOW) - 1);
      await new Promise(r => setImmediate(r));
      expect(pause.calls).toBe(1);
      pause.refusing = false;
      fc.advance(1);
      await until(async () => (await rt.workspaces.get(ws.id)).phase === "napping");
      expect(pause.calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("a second window with the refusal standing exports no vault, asks the provider once more only at the backstop, and logs nothing new", async () => {
    const store = memoryStore();
    const { rt, backend, fc, statuses } = testRuntime({}, { store });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const pause = refusingPause(backend.machines[0]!);
      const puts = vaultPuts(store);
      fc.advance(WINDOW);
      const first = fc.clock.now();
      await until(() => statuses.some(s => s.idleAt === first + backstopMs(WINDOW)));
      // The first refusal came after the export the nap always ran; nothing yet said the pause would be refused.
      expect(puts.n).toBe(1);
      fc.advance(WINDOW);
      await new Promise(r => setImmediate(r));
      expect(pause.calls).toBe(1);
      fc.advance(backstopMs(WINDOW) - WINDOW);
      const second = fc.clock.now();
      await until(() => statuses.some(s => s.idleAt === second + backstopMs(WINDOW)));
      expect(pause.calls).toBe(2);
      expect(puts.n).toBe(1);
      expect(statuses.at(-1)).toMatchObject({ phase: "running", reason: napRefusedLine("Not pausable") });
      expect(warn.mock.calls).toHaveLength(1);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    } finally {
      warn.mockRestore();
    }
  });

  it("a pause that lands clears the refusal: after the wake the window is the full one again, the row carries no sentence, and the next nap exports its vault", async () => {
    const store = memoryStore();
    const { rt, backend, fc, statuses } = testRuntime({}, { store });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const pause = refusingPause(backend.machines[0]!);
      const puts = vaultPuts(store);
      fc.advance(WINDOW);
      const answered = fc.clock.now();
      await until(() => statuses.some(s => s.idleAt === answered + backstopMs(WINDOW)));
      pause.refusing = false;
      await rt.workspaces.nap(ws.id);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
      expect(puts.n).toBe(1);
      await rt.workspaces.wake(ws.id);
      const woke = fc.clock.now();
      const row = (await rt.status.list())[0]!;
      expect(row.idleAt).toBe(woke + WINDOW);
      expect(row.reason).toBeUndefined();
      fc.advance(WINDOW);
      await until(async () => (await rt.workspaces.get(ws.id)).phase === "napping");
      expect(puts.n).toBe(2);
      expect(pause.calls).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("a pause asked for is rejected with the typed refusal and its sentence, and the refusal stands as the idle nap's does", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const pause = refusingPause(backend.machines[0]!);
      const asked = fc.clock.now();
      const e = await rt.workspaces.nap(ws.id).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(NapRefusedError);
      expect((e as Error).message).toBe(napRefusedLine("Not pausable"));
      expect(pause.calls).toBe(1);
      expect(statuses.at(-1)).toMatchObject({ phase: "running", reason: napRefusedLine("Not pausable") });
      expect((await rt.status.list())[0]).toMatchObject({ reason: napRefusedLine("Not pausable"), idleAt: asked + WINDOW });
      expect(warn.mock.calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a rebuild that puts another machine under the record drops the refusal: the full window and no sentence on the new machine", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      refusingPause(backend.machines[0]!);
      fc.advance(WINDOW);
      const answered = fc.clock.now();
      await until(() => statuses.some(s => s.idleAt === answered + backstopMs(WINDOW)));
      await rt.workspaces.rebuild(ws.id);
      const rebuilt = fc.clock.now();
      const row = (await rt.status.list())[0]!;
      expect(row.machineId).toBe("m2");
      expect(row.reason).toBeUndefined();
      expect(row.idleAt).toBe(rebuilt + WINDOW);
    } finally {
      warn.mockRestore();
    }
  });
});
