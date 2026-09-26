// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import { EventUnion, PLACES_TICKET_REFUSAL, THREAD_OPS, computerOffline, machineUnreachableLine, sendRefusal, workspaceState, workspaceWord, type PlaceView, type WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roadFailed, type ExecResult } from "@wsp/engine";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { POLL_INTERVAL_MS, createStatusTracker, probeReach, type StatusListOptions, type StatusRecord, type StatusWatchOptions } from "../src/status.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

/** Every road to the provider's view of a machine: backend.get/list and machine.state(). */
function countProvider(backend: StubBackend): () => { get: number; list: number; state: number } {
  const n = { get: 0, list: 0, state: 0 };
  const get = backend.get.bind(backend);
  const list = backend.list.bind(backend);
  backend.get = async id => { n.get++; return get(id); };
  backend.list = async labels => { n.list++; return list(labels); };
  for (const m of backend.machines) {
    const state = m.state.bind(m);
    m.state = async () => { n.state++; return state(); };
  }
  return () => ({ ...n });
}

function testRuntime(status?: StatusWatchOptions): {
  rt: Runtime;
  backend: StubBackend;
} {
  const backend = stubBackend();
  const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, ...(status ? { status } : {}) });
  return { rt, backend };
}

/** delayMs "never" holds the request open so the probe can only time out; onRequest runs as each request lands. */
async function httpStub(statusCode: number, delayMs: number | "never" = 0, onRequest?: () => void): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    onRequest?.();
    if (delayMs === "never") return;
    setTimeout(() => res.writeHead(statusCode).end(), delayMs);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { server, port, hits: () => hits };
}

const openServers: Server[] = [];
let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
  openServers.length = 0;
});

type Cost = EventUnion & { type: "workspace.cost" };

/** The places a spend read is folded onto: the computer the host runs on, a provider nothing here is metered on,
 * and the provider this runtime forks at, which is the word it stamps its records with. The stamped one is last on
 * purpose, so a fold that fell back to the first provider row instead of reading the stamp would be seen.  */
const PLACES: PlaceView[] = [
  { id: "here", kind: "computer", name: "this-mac", default: true },
  { id: "box", kind: "provider", name: "box", default: false, takesForks: true },
  { id: "default", kind: "provider", name: "default", default: false, takesForks: true },
];

/** The clock jumps an hour in the tests below: the idle window must not nap the workspace behind the test. */
const idle = { defaultWindowMs: 24 * 3_600_000 };
const TICK_MS = 10_000;
/** A cost tick every TICK_MS of a fake clock; the poll timer never falls due, only the poll a watch runs at once. */
const ticking = { costIntervalMs: TICK_MS, pollIntervalMs: 24 * 3_600_000 };

/** One cost tick under a fake clock: the clock reaches the next interval and the tick it fired has landed on the bus. */
async function tickCost(fc: ReturnType<typeof fakeClock>, costs: Cost[]): Promise<void> {
  const n = costs.length;
  fc.advance(TICK_MS);
  await until(() => costs.length > n);
}

/** A lifecycle step that opens or re-prices an awake stretch lands its own cost tick: the step, then that tick, so
 * the next tickCost counts only the timer's. */
async function stepped(costs: Cost[], step: () => Promise<unknown>): Promise<void> {
  const n = costs.length;
  await step();
  await until(() => costs.length > n);
}

describe("status.list", () => {
  it("enriches views with machine state, reach, size, and rate from backend pricing", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const statuses = await rt.status.list();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: "alpha",
      phase: "running",
      machineState: "running",
      reach: { state: "unsupported" }, // stub machines mint no preview URLs
      size: backend.pricing.defaultSize, // asked for explicitly when the caller names none; the stub builds what it is asked
      rateUsdPerHour: backend.pricing.rateUsdPerHour(backend.pricing.defaultSize),
    });
    expect(statuses[0]!.rateUsdPerHour).toBeCloseTo(0.11, 5);
  });

  it("probes the daemon through a minted preview URL and reuses fresh reach", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    // Plain HTTP against the daemon's ws port answers 426 (measured, ticket-6 spike).
    const probe = await httpStub(426);
    openServers.push(probe.server);
    let minted = 0;
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `http://127.0.0.1:${probe.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 };
    };

    const first = await rt.status.list();
    expect(first[0]!.reach).toMatchObject({ state: "reachable" });
    expect(first[0]!.reach.url).toContain(`127.0.0.1:${probe.port}`);
    await rt.status.list();
    expect(minted).toBe(1); // fresh reach is cached, not reminted per call

    // 502 comes from the edge when nothing listens in the guest.
    const dead = await httpStub(502);
    openServers.push(dead.server);
    backend.machines[0]!.previewUrl = async port => ({
      url: `http://127.0.0.1:${dead.port}/?port=${port}`,
      token: "t",
      expiresAt: Date.now() + 3_600_000,
    });
    const ws = (await rt.workspaces.list())[0]!;
    await rt.workspaces.nap(ws.id);
    await rt.workspaces.wake(ws.id); // wake keeps the machine; cached reach still fresh
    const again = await rt.status.list();
    expect(["reachable", "no-daemon"]).toContain(again[0]!.reach.state); // cache may still hold the live stub
  });

  it("maps napping and gone machines without probing", async () => {
    const { rt, backend } = testRuntime();
    const a = await createOn(rt, { golden: "snap_g", name: "a" });
    await createOn(rt, { golden: "snap_g", name: "b" });
    await rt.workspaces.nap(a.id);
    await backend.machines[1]!.kill();
    const statuses = await rt.status.list();
    const byName = new Map(statuses.map(s => [s.name, s]));
    expect(byName.get("a")).toMatchObject({ machineState: "paused", reach: { state: "napping" } });
    expect(byName.get("b")).toMatchObject({ machineState: "gone", reach: { state: "gone" } });
  });

  it("an explicit list() asks the provider once per machine and never list()", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const calls = countProvider(backend);
    const statuses = await rt.status.list();
    expect(statuses[0]).toMatchObject({ machineState: "running" });
    expect(calls()).toEqual({ get: 0, list: 0, state: 1 });
    backend.machines[0]!.paused = true; // the provider paused it behind our back
    expect((await rt.status.list())[0]).toMatchObject({ phase: "running", machineState: "paused" });
    await backend.machines[0]!.kill();
    expect((await rt.status.list())[0]).toMatchObject({ machineState: "gone", reach: { state: "gone" } });
  });

  it("maps a prompt 502 to no-daemon, a late answer to slow, silence to unreachable, and leaves the row where it was for any other answer the edge gives", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    // The stub moves the clock as the request lands, so "late" is what the clock says and not how fast the box answered.
    // The probe timeout is a real abort: only the silent case keeps it short, the answering ones get more than any local fetch needs.
    const cases: [number, number | "never", number, string][] = [
      [426, 0, 5_000, "reachable"],
      [502, 0, 5_000, "no-daemon"],
      // Not the guest's answer, so it decides nothing on its own: an edge refusal must not take a live workspace
      // out of service in the row, it only sends the poll to the provider for the machine's real state.
      [200, 0, 5_000, "reachable"],
      [401, 0, 5_000, "reachable"],
      [404, 0, 5_000, "reachable"],
      [503, 0, 5_000, "reachable"],
      [502, 150, 5_000, "slow"],
      [426, 150, 5_000, "slow"],
      [426, "never", 300, "unreachable"],
    ];
    for (const [code, took, probeTimeoutMs, expected] of cases) {
      const opts = { probeTimeoutMs, promptMs: 60 };
      const stub = await httpStub(code, took === "never" ? "never" : 0, () => fc.advance(took === "never" ? 0 : took));
      openServers.push(stub.server);
      // A fresh runtime per case so no cached reach carries the previous stub over.
      const fresh = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock });
      await createOn(fresh, { golden: "snap_g", name: `case-${code}-${took}` });
      const last = backend.machines.at(-1)!;
      last.previewUrl = async port => ({
        url: `http://127.0.0.1:${stub.port}/?port=${port}&case=${code}-${took}`,
        token: "t",
        expiresAt: Date.now() + 3_600_000,
      });
      const status = (await fresh.status.list(opts)).find(s => s.machineId === last.id)!;
      expect(status.reach.state, `${code} after ${took}`).toBe(expected);
      expect(status.machineState).toBe("running");
      // A running machine stays sendable through every answer but the guest's own silence or a dead daemon port.
      const sendable = sendRefusal(workspaceState({ phase: status.phase, machineState: status.machineState, reach: status.reach.state })) === null;
      expect(sendable, `${code} after ${took} sendable`).toBe(expected === "reachable" || expected === "slow");
    }
  });
});

describe("a machine that answers for its own daemon", () => {
  it("takes the guest's own word and never dials the route: a container whose published port is on another computer's loopback reads reachable while its turns run", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    // The route mints and the row carries it, but nothing on this computer answers it: on a box dialling another
    // computer's Docker daemon that is the whole of what the old reading saw.
    const edge = await httpStub(502);
    openServers.push(edge.server);
    const machine = backend.machines[0]!;
    machine.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "", expiresAt: Number.MAX_SAFE_INTEGER });
    machine.daemonAnswers = async () => true;

    const status = (await rt.status.list())[0]!;
    expect(status.reach.state).toBe("reachable");
    expect(workspaceWord(workspaceState({ phase: status.phase, machineState: status.machineState, reach: status.reach.state }))).toBe("Running");
    expect(status.reach.url).toContain(`127.0.0.1:${edge.port}`);
    expect(edge.hits()).toBe(0);
  });

  it("a guest that says the daemon's port is dead reads Unreachable, and a machine that will not answer at all reads unreachable too", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const machine = backend.machines[0]!;
    machine.previewUrl = async port => ({ url: `http://127.0.0.1:1/?port=${port}`, token: "", expiresAt: Number.MAX_SAFE_INTEGER });
    machine.daemonAnswers = async () => false;
    const dead = (await rt.status.list())[0]!;
    expect(dead.reach.state).toBe("no-daemon");
    expect(workspaceWord(workspaceState({ phase: dead.phase, machineState: dead.machineState, reach: dead.reach.state }))).toBe("Unreachable");

    machine.daemonAnswers = async () => {
      throw new Error("container 7d8f is not running");
    };
    expect((await rt.status.list())[0]!.reach.state).toBe("unreachable");
  });

  it("a route the machine has none of is no silence: the reach is still the guest's word, with no url on the row", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const machine = backend.machines[0]!;
    machine.previewUrl = async () => {
      throw new Error("container 7d8f publishes no port 7070; only the daemon's own port is published");
    };
    machine.daemonAnswers = async () => true;
    const calls = countProvider(backend);
    const status = (await rt.status.list({ reconcile: "on-failure" }))[0]!;
    expect(status.reach).toEqual({ state: "reachable" });
    // Nothing failed, so the provider is left alone: a route the app has none of is not a reach that missed.
    expect(calls()).toEqual({ get: 0, list: 0, state: 0 });
  });

  it("a machine with no route at all is asked all the same: only a machine with neither road reads unsupported", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const machine = backend.machines[0]!;
    expect(machine.previewUrl).toBeUndefined();
    machine.daemonAnswers = async () => true;
    expect((await rt.status.list())[0]!.reach).toEqual({ state: "reachable" });
    machine.daemonAnswers = async () => false;
    // The first silence after an answer keeps the answer's word, as it does on the edge road; the second turns it.
    expect((await rt.status.list())[0]!.reach).toEqual({ state: "reachable" });
    expect((await rt.status.list())[0]!.reach).toEqual({ state: "no-daemon" });
    // Neither road: nothing to ask, and that alone is unsupported.
    delete machine.daemonAnswers;
    expect((await rt.status.list())[0]!.reach).toEqual({ state: "unsupported" });
  });

  it("a status pushed between polls makes the same claim: a machine with no route but an answer of its own is not called unsupported", async () => {
    const { rt, backend } = testRuntime();
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const machine = backend.machines[0]!;
    expect(machine.previewUrl).toBeUndefined();
    machine.daemonAnswers = async () => true;
    const pushed: WorkspaceStatus[] = [];
    rt.events.on("*", e => {
      if (e.type === "workspace.status") pushed.push(e.status);
    });
    // A pause the provider refuses pushes the row with whatever the runtime claims about its reach, and nothing
    // has polled this machine, so the claim is all there is.
    machine.pause = async () => {
      throw new Error("the provider would not pause it");
    };
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow("would not pause");
    expect(pushed.at(-1)).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
  });

  it("a guest that takes longer than the prompt reads slow, and one inside it reads reachable", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const machine = backend.machines[0]!;
    // The clock moves as the guest answers, so slow is what the clock says and not how fast this Mac ran.
    let took = 0;
    machine.daemonAnswers = async () => {
      fc.advance(took);
      return true;
    };
    const opts = { promptMs: 60, probeTimeoutMs: 5_000 };
    took = 40;
    expect((await rt.status.list(opts))[0]!.reach.state).toBe("reachable");
    took = 150;
    // Three Docker API round trips ride this road where the edge road rode one, so the slow word is reachable here.
    expect((await rt.status.list(opts))[0]!.reach.state).toBe("slow");
    expect((await rt.status.list(opts))[0]!.machineState).toBe("running");
  });

  it("the caller's bound is the whole ask: a machine that never answers reads unreachable rather than holding the read open", async () => {
    const { rt, backend } = testRuntime();
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const machine = backend.machines[0]!;
    machine.previewUrl = async port => ({ url: `http://127.0.0.1:1/?port=${port}`, token: "", expiresAt: Number.MAX_SAFE_INTEGER });
    let bound: number | undefined;
    machine.daemonAnswers = async opts => {
      bound = opts?.timeoutMs;
      return new Promise<boolean>(() => {});
    };
    const started = Date.now();
    const status = (await rt.status.list({ probeTimeoutMs: 300 }))[0]!;
    expect(status.reach.state).toBe("unreachable");
    expect(bound).toBe(300);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("status.watch provider calls", () => {
  it("asks the provider nothing across healthy polls", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5 });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const probe = await httpStub(426);
    openServers.push(probe.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${probe.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await createOn(rt, { golden: "snap_g", name: "no-preview" }); // unsupported reach is healthy too
    const calls = countProvider(backend);
    const stop = rt.status.watch();
    await until(() => probe.hits() >= 8);
    stop();
    expect(calls()).toEqual({ get: 0, list: 0, state: 0 });
  });

  it("asks the provider once after a failed reach, then not again inside the reconcile window", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const dead = await httpStub(502);
    openServers.push(dead.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${dead.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const calls = countProvider(backend);
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));
    const stop = rt.status.watch();
    await until(() => dead.hits() >= 8);
    stop();
    expect(calls()).toEqual({ get: 0, list: 0, state: 1 });
    expect(seen.at(-1)).toMatchObject({ machineState: "running", reach: { state: "no-daemon" } });
  });
});

describe("status.watch cost events", () => {
  it("emits workspace.cost on a timer with awake-time accrual, zero rate while napping", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 15, pollIntervalMs: 60_000 });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha", cpu: 4, memMb: 8192 });
    const costs: (EventUnion & { type: "workspace.cost" })[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as EventUnion & { type: "workspace.cost" }));

    const stop = rt.status.watch();
    await until(() => costs.length >= 2);
    const running = costs.at(-1)!;
    EventUnion.parse(running); // the wire schema accepts what the bus emits
    expect(running.workspaceId).toBe(ws.id);
    expect(running.phase).toBe("running");
    expect(running.rateUsdPerHour).toBeCloseTo(backend.pricing.rateUsdPerHour({ cpu: 4, memMb: 8192 }), 5);
    expect(running.awakeMs).toBeGreaterThan(0);
    expect(running.accruedUsd).toBeGreaterThan(0);

    await rt.workspaces.nap(ws.id);
    costs.length = 0;
    await until(() => costs.length >= 2);
    stop();
    expect(costs.at(-1)!.rateUsdPerHour).toBe(0);
    // napping accrues nothing: consecutive events carry the same total
    expect(costs.at(-1)!.accruedUsd).toBeCloseTo(costs[0]!.accruedUsd, 10);
    expect(costs.at(-1)!.awakeMs).toBe(costs[0]!.awakeMs);

    costs.length = 0;
    await new Promise(r => setTimeout(r, 40));
    expect(costs.length).toBe(0); // unwatched = no timers running
  });

  it("emits workspace.status when the enriched status changes, not on every poll", async () => {
    const { rt } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 15 });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));

    const stop = rt.status.watch();
    await until(() => seen.length >= 1); // first poll baselines every workspace once
    expect(seen.length).toBe(1);
    await rt.workspaces.nap(ws.id);
    // The nap pushes pausing and napping itself; the poller re-emits napping once in its own shape, then stays quiet.
    await until(() => seen.filter(s => s.phase === "napping").length >= 2);
    const settled = seen.length;
    await new Promise(r => setTimeout(r, 60));
    stop();
    expect(seen.length).toBe(settled);
    const phases = seen.map(s => s.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);
    expect(phases).toEqual(["running", "pausing", "napping"]);
    expect(seen.at(-1)).toMatchObject({ id: ws.id, phase: "napping", machineState: "paused" });
  });
});

describe("the status ticks", () => {
  it("an answer the guest did not send sends the poll to the provider once, and leaves the row running", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    // The edge refusing a token it minted itself: the request never reached the guest, so it says nothing about it.
    const edge = await httpStub(401);
    openServers.push(edge.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const calls = countProvider(backend);
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));

    const stop = rt.status.watch();
    try {
      await until(() => edge.hits() >= 8, 5_000);
    } finally {
      stop();
    }
    expect(calls()).toEqual({ get: 0, list: 0, state: 1 });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ phase: "running", machineState: "running", reach: { state: "reachable" } });
    expect(sendRefusal(workspaceState({ phase: last.phase, machineState: last.machineState, reach: last.reach.state }))).toBeNull();
  }, 10_000);

  it("a workspace that goes takes its facts backoff with it, so the next workspace under that id is asked at once", async () => {
    const fc = fakeClock();
    const heard: ((e: EventUnion) => void)[] = [];
    let dials = 0;
    const dark: StatusRecord = {
      id: "ws_a",
      name: "box",
      machineId: "ssh://dev@box:22",
      kind: "ssh",
      phase: "running",
      golden: "",
      project: { id: "pr_1a2b3c4d", name: "box", path: "/home/dev/box", computer: "pl_box" },
      createdAt: new Date(fc.clock.now()).toISOString(),
      size: { cpu: 2, memMb: 2048 },
      rateUsdPerHour: 0,
      generation: 1,
      providerState: async () => "running",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      // A machine that is off: every read of what it is costs a dial and answers nothing.
      facts: async () => {
        dials++;
        throw new Error("did not say what it is over ssh");
      },
    };
    const tracker = createStatusTracker({
      records: async () => [dark],
      store: memoryStore(),
      emit: () => {},
      on: (_type, listener) => {
        heard.push(listener);
        return () => {};
      },
      clock: fc.clock,
    });
    await tracker.list();
    expect(dials).toBe(1);
    // Backed off: a second read inside the window spends no dial.
    await tracker.list();
    expect(dials).toBe(1);
    // The workspace is deleted. Its entry goes with every other per-workspace thing the tracker held, so a record
    // that turns up under that id again is a new workspace and is asked at once rather than serving out the
    // window the dead one earned.
    for (const listener of heard) listener({ type: "workspace.deleted", workspaceId: "ws_a" });
    await tracker.list();
    expect(dials).toBe(2);
  });

  it("a tick that throws is logged and the next tick still runs; nothing reaches the process as an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const caught = (e: unknown): void => void rejections.push(e);
    process.on("unhandledRejection", caught);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let asked = 0;
    const tracker = createStatusTracker({
      records: async () => {
        asked++;
        throw new Error("the store is gone");
      },
      store: memoryStore(),
      emit: () => {},
      on: () => () => {},
      defaults: { costIntervalMs: 5, pollIntervalMs: 5 },
    });
    const stop = tracker.watch();
    try {
      await until(() => asked >= 4, 5_000);
    } finally {
      stop();
      process.off("unhandledRejection", caught);
      warn.mockRestore();
    }
    expect(rejections).toEqual([]);
  }, 10_000);
});

describe("a pause the provider made", () => {
  it("the poll asks the provider when the edge answers for the machine instead of the daemon, and the record follows", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 0 });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    // The edge answers for a machine it cannot hand the request to; only the daemon's own 426 proves a live guest.
    const edge = await httpStub(404);
    openServers.push(edge.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const napped: EventUnion[] = [];
    rt.events.on("workspace.napped", e => napped.push(EventUnion.parse(e)));
    backend.machines[0]!.paused = true;

    const stop = rt.status.watch();
    try {
      await until(() => statuses.some(s => s.phase === "napping"), 5_000);
    } finally {
      stop();
    }
    // The wire event says the pause was found, not made here: what the meter needs to end the stretch where it did.
    expect(napped).toMatchObject([{ type: "workspace.napped", workspaceId: ws.id, found: true }]);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    // The status that moved it: the record still said running, the edge answered for the machine, the provider said
    // paused. The edge's answer never reads as a dead daemon, so the row says Paused and not Unreachable.
    const moved = statuses.find(s => s.phase === "running" && s.machineState === "paused")!;
    expect(moved.reach.state).toBe("reachable");
    expect(workspaceState({ phase: moved.phase, machineState: moved.machineState, reach: moved.reach.state })).toBe("paused");
  }, 10_000);

  it("a machine paused at the provider while the host was down hydrates napping, in the store too, and the gap is not billed", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await tickCost(fc, costs);
    stop();
    await first.close();
    expect(costs.at(-1)).toMatchObject({ phase: "running", awakeMs: TICK_MS });

    // An hour down, and the provider paused the machine meanwhile: the next host reads the state off the view it fetches.
    backend.machines[0]!.paused = true;
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    expect((await second.workspaces.get(ws.id)).phase).toBe("napping");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await tickCost(fc, after);
    await tickCost(fc, after);
    // The hour down bills nothing: the stretch ended at the last tick that proved the machine awake.
    expect(after).toMatchObject([
      { phase: "napping", rateUsdPerHour: 0, awakeMs: TICK_MS },
      { phase: "napping", rateUsdPerHour: 0, awakeMs: TICK_MS },
    ]);

    // The wake resumes the machine the provider paused, and the stretch starts there, not an hour ago.
    await stepped(after, () => second.workspaces.wake(ws.id));
    await tickCost(fc, after);
    stop();
    expect(after.at(-1)).toMatchObject({ phase: "running", awakeMs: 2 * TICK_MS });
    expect(backend.machines[0]!.resumes).toBe(1);
    await second.close();
  });

  it("a pause found after a gap in watching ends the awake stretch at the last proof the machine was awake", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const status = { ...ticking, promptMs: 10_000, probeTimeoutMs: 50, reconcileMinMs: 0 };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, status, idle });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const live = await httpStub(426);
    openServers.push(live.server);
    // Under the refresh margin, so every poll mints the route again and the probe follows the machine's current one.
    const minted = (port: number, at: number): { url: string; token: string; expiresAt: number } => ({ url: `http://127.0.0.1:${at}/?port=${port}`, token: "t", expiresAt: Date.now() + 60_000 });
    backend.machines[0]!.previewUrl = async port => minted(port, live.port);
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const napped: string[] = [];
    rt.events.on("workspace.napped", () => napped.push("napped"));
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));

    const before = statuses.length;
    let stop = rt.status.watch();
    // The poll a watch runs at once has finished, so its proof of an awake machine lands before the clock moves.
    await until(() => statuses.length > before);
    await tickCost(fc, costs);
    expect(costs.at(-1)).toMatchObject({ phase: "running", awakeMs: TICK_MS });
    // The last proof the machine was awake: the daemon answers a list at this instant.
    expect((await rt.status.list())[0]).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
    stop();

    // An hour with nothing watching: no tick and no poll runs, and the provider pauses the machine within it.
    fc.advance(3_600_000);
    backend.machines[0]!.paused = true;
    // The reach goes dark while a machine is paused (measured), whatever the record still says.
    const dark = await httpStub(426, "never");
    openServers.push(dark.server);
    backend.machines[0]!.previewUrl = async port => minted(port, dark.port);

    stop = rt.status.watch();
    try {
      await until(() => napped.length >= 1, 5_000);
      await tickCost(fc, costs);
    } finally {
      stop();
    }
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(costs.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: TICK_MS });
    expect((await rt.status.history(ws.id)).at(-1)).toMatchObject({ awakeMs: TICK_MS });
  }, 20_000);
});

describe("accrued cost", () => {
  const usd = (rateUsdPerHour: number, ms: number): number => (rateUsdPerHour * ms) / 3_600_000;

  it("is each awake stretch billed at the rate that held over it: a pause, an unwatched wake, a restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const small = backend.pricing.rateUsdPerHour(backend.pricing.defaultSize);
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await tickCost(fc, costs);
    await tickCost(fc, costs);
    expect(costs.at(-1)).toMatchObject({ rateUsdPerHour: small, awakeMs: 2 * TICK_MS });
    expect(costs.at(-1)!.accruedUsd).toBeCloseTo(usd(small, 2 * TICK_MS), 10);

    // A pause adds nothing, tick after tick.
    await first.workspaces.nap(ws.id);
    await tickCost(fc, costs);
    await tickCost(fc, costs);
    expect(costs.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: 2 * TICK_MS });
    expect(costs.at(-1)!.accruedUsd).toBeCloseTo(usd(small, 2 * TICK_MS), 10);
    stop();

    // Nobody watching. The wake lands its own tick, then an hour passes with nothing looking: the meter reads wall
    // time, so the first tick after it carries that hour rather than only the ticks that ran.
    await stepped(costs, () => first.workspaces.wake(ws.id));
    expect(costs.at(-1)).toMatchObject({ phase: "running", rateUsdPerHour: small, awakeMs: 2 * TICK_MS });
    fc.advance(3_600_000);

    stop = first.status.watch();
    await tickCost(fc, costs);
    await tickCost(fc, costs);
    stop();
    const awake = 4 * TICK_MS + 3_600_000;
    const billed = usd(small, awake);
    expect(costs.at(-1)).toMatchObject({ rateUsdPerHour: small, awakeMs: awake });
    expect(costs.at(-1)!.accruedUsd).toBeCloseTo(billed, 10);
    await first.close();

    // An hour down with the machine running: the next host meters on from the stored total at the stored rate.
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await tickCost(fc, after);
    stop();
    expect(after.at(-1)).toMatchObject({ phase: "running", rateUsdPerHour: small, awakeMs: awake + 3_600_000 + TICK_MS });
    expect(after.at(-1)!.accruedUsd).toBeCloseTo(billed + usd(small, 3_600_000 + TICK_MS), 10);
    expect((await second.status.history(ws.id)).at(-1)!.accruedUsd).toBeCloseTo(after.at(-1)!.accruedUsd, 10);
    await second.close();
  });

  it("a rebuild at an unchanged rate lands no cost event: an event's tick rides the bus only when it changed the series", async () => {
    const fc = fakeClock();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    await until(async () => (await rt.status.history(ws.id)).length === 1);
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    await tickCost(fc, costs);
    await tickCost(fc, costs);
    const before = costs.length;
    await rt.workspaces.rebuild(ws.id);
    await tickCost(fc, costs);
    stop();
    // The timer's tick is the only one that landed: the rebuild's folded into the run and reported nothing.
    expect(costs.length).toBe(before + 1);
    expect(costs.at(-1)).toMatchObject({ phase: "running", awakeMs: 3 * TICK_MS });
    expect(await rt.status.history(ws.id)).toHaveLength(2);
    await rt.close();
  });
});

describe("a rename and the machine's own accounting", () => {
  const usd = (rateUsdPerHour: number, ms: number): number => (rateUsdPerHour * ms) / 3_600_000;

  it("leaves the awake meter and the accrued spend where they were: a rename is a record changing, never a machine coming up", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const rate = backend.pricing.rateUsdPerHour(backend.pricing.defaultSize);
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    for (let i = 0; i < 3; i++) await tickCost(fc, costs);
    const before = costs.at(-1)!;
    expect(before).toMatchObject({ phase: "running", awakeMs: 3 * TICK_MS });

    await rt.workspaces.rename(ws.id, "the name he typed");

    // The stretch the machine is already running is not re-opened: the next tick counts on from where it was.
    await tickCost(fc, costs);
    const after = costs.at(-1)!;
    expect(after.awakeMs).toBe(4 * TICK_MS);
    expect(after.accruedUsd).toBeCloseTo(usd(rate, 4 * TICK_MS), 10);
    expect(after.accruedUsd).toBeGreaterThan(before.accruedUsd);
    // Nothing in the stored line ever runs backwards, which is what a re-opened stretch writes into it.
    const history = await rt.status.history(ws.id);
    expect(history.map(p => p.awakeMs)).toEqual([...history.map(p => p.awakeMs)].sort((a, b) => a - b));
    stop();
    await rt.close();
  });

  it("leaves the auto-nap window where it was: a rename is not a person acting in the workspace", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const windowMs = 20 * 60_000;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, status: ticking, idle: { defaultWindowMs: windowMs } });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const armed = (await rt.status.list())[0]!.idleAt;
    expect(armed).toBeDefined();

    fc.advance(5 * 60_000);
    await rt.workspaces.rename(ws.id, "the name he typed");

    // The window still fires when the create armed it: a rename touched no machine.
    expect((await rt.status.list())[0]!.idleAt).toBe(armed);
    await rt.close();
  });
});

describe("status.history", () => {
  /** A store whose writes to the cost history collection are counted. */
  function countingStore(): { store: Store; puts: () => number; deletes: () => number } {
    const store = memoryStore();
    const n = { puts: 0, deletes: 0 };
    const put = store.put.bind(store);
    const del = store.delete.bind(store);
    store.put = async (collection, id, value) => {
      if (collection === "cost-histories") n.puts++;
      return put(collection, id, value);
    };
    store.delete = async (collection, id) => {
      if (collection === "cost-histories") n.deletes++;
      return del(collection, id);
    };
    return { store, puts: () => n.puts, deletes: () => n.deletes };
  }

  it("holds the folded ticks since metering began and hands them out over the wire", async () => {
    const fc = fakeClock();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    // The create opens the stretch with a tick of its own, before anything watches.
    await until(async () => (await rt.status.history(ws.id)).length === 1);
    expect(await rt.status.history(ws.id)).toMatchObject([{ phase: "running", awakeMs: 0, accruedUsd: 0 }]);
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    for (let i = 0; i < 4; i++) await tickCost(fc, costs);
    const rate = costs[0]!.rateUsdPerHour;
    expect(rate).toBeGreaterThan(0);
    // One rate the whole way: the create's tick and the newest, nothing between.
    let history = await rt.status.history(ws.id);
    expect(history.map(p => [p.rateUsdPerHour, p.awakeMs])).toEqual([[rate, 0], [rate, 4 * TICK_MS]]);
    // The bus stamps a seq on what it emits; the history holds the ticks as the tracker built them.
    expect(costs[3]).toMatchObject(history[1]!);

    await rt.workspaces.nap(ws.id);
    for (let i = 0; i < 3; i++) await tickCost(fc, costs);
    stop();
    history = await rt.status.history(ws.id);
    // The last running tick and the first napping one bracket the change; the napping run folds to its newest.
    expect(history.map(p => [p.phase, p.rateUsdPerHour, p.awakeMs])).toEqual([
      ["running", rate, 0],
      ["running", rate, 4 * TICK_MS],
      ["napping", 0, 4 * TICK_MS],
      ["napping", 0, 4 * TICK_MS],
    ]);
    expect(costs[4]).toMatchObject(history[2]!);
    expect(costs[6]).toMatchObject(history[3]!);

    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const res = await c.request("cost.history", { workspaceId: ws.id });
    c.close();
    expect(res.ok).toBe(true);
    expect(res["points"]).toEqual(history);
    expect(await rt.status.history("ws_nobody")).toEqual([]);
  });

  it("survives a host restart: a fresh runtime over the same store hands out the stored ticks and meters on from them", async () => {
    const backend = stubBackend();
    const { store, puts } = countingStore();
    const fc = fakeClock();
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    for (let i = 0; i < 3; i++) await tickCost(fc, costs);
    stop();
    const stored = await first.status.history(ws.id);
    expect(stored.map(p => p.awakeMs)).toEqual([0, 3 * TICK_MS]);
    // The create's tick and the first timer tick add points; ticks of one rate then replace the newest in memory and
    // reach the store only when a point is added.
    expect(puts()).toBe(2);

    // An hour down, the machine still running and billing the whole time. The store's newest point is the tick
    // that added it, so the series it hands out before its first tick ends where the rate run began.
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const handed = await second.status.history(ws.id);
    expect(handed.map(p => p.awakeMs)).toEqual([0, TICK_MS]);
    expect(handed[0]).toEqual(stored[0]);
    expect(handed[1]).toMatchObject({ workspaceId: ws.id, phase: "running", rateUsdPerHour: stored[1]!.rateUsdPerHour });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await tickCost(fc, after);
    // The meter runs on from the stored point through the hour down, as the provider billed it.
    const tick = after[0]!;
    expect(tick).toMatchObject({ phase: "running", awakeMs: 4 * TICK_MS + 3_600_000 });
    expect(tick.accruedUsd).toBeCloseTo(stored[1]!.accruedUsd + (stored[1]!.rateUsdPerHour * (TICK_MS + 3_600_000)) / 3_600_000, 10);
    // The run continues at one rate: the stored first tick stays, the newest moves, no point was added.
    const history = await second.status.history(ws.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(stored[0]);
    expect(history[1]).toMatchObject({ awakeMs: tick.awakeMs, accruedUsd: tick.accruedUsd });
    expect(puts()).toBe(2);

    // A nap after the restart is a rate change: it adds two points and both reach the store.
    await second.workspaces.nap(ws.id);
    for (let i = 0; i < 3; i++) await tickCost(fc, after);
    stop();
    expect((await second.status.history(ws.id)).map(p => [p.rateUsdPerHour, p.awakeMs])).toEqual([
      [tick.rateUsdPerHour, 0],
      [tick.rateUsdPerHour, tick.awakeMs],
      [0, tick.awakeMs],
      [0, tick.awakeMs],
    ]);
    expect(puts()).toBe(4);
    const third = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const restored = await third.status.history(ws.id);
    expect(restored).toHaveLength(4);
    expect(restored.at(-1)).toMatchObject({ rateUsdPerHour: 0, awakeMs: tick.awakeMs });
  });

  it("a workspace napping across the restart keeps its total and accrues nothing until it wakes", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    for (let i = 0; i < 3; i++) await tickCost(fc, costs);
    await first.workspaces.nap(ws.id);
    await tickCost(fc, costs);
    stop();
    const total = 3 * TICK_MS;
    expect(costs.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: total });
    expect(await first.status.history(ws.id)).toHaveLength(3);

    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await tickCost(fc, after);
    expect(after.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: total });
    await stepped(after, () => second.workspaces.wake(ws.id));
    await tickCost(fc, after);
    stop();
    expect(after.at(-1)).toMatchObject({ phase: "running", awakeMs: total + TICK_MS });
  });

  it("a host that died between a nap and its tick does not bill the nap: the wake starts the stretch afresh", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await tickCost(fc, costs);
    await tickCost(fc, costs);
    stop();
    // The store's newest point still says running when the nap lands and the host dies before the next tick.
    await first.workspaces.nap(ws.id);

    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    // The store holds the points that were added: the create's tick and the first timer tick; the second only moved the newest in memory.
    expect((await second.status.history(ws.id)).at(-1)).toMatchObject({ phase: "running", awakeMs: TICK_MS });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await tickCost(fc, after);
    // The hour between the nap and the restart is not on the bill: the stretch ended at the newest stored tick.
    expect(after.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: TICK_MS });
    await stepped(after, () => second.workspaces.wake(ws.id));
    await tickCost(fc, after);
    stop();
    expect(after.at(-1)).toMatchObject({ phase: "running", awakeMs: 2 * TICK_MS });
  });

  it("hands a deleted workspace's chart to nobody and keeps what it spent on the place that billed for it", async () => {
    const backend = stubBackend();
    const { store, deletes } = countingStore();
    const rt = createRuntime({ backend, store, adapters: {}, status: { costIntervalMs: 15, pollIntervalMs: 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    await until(() => costs.length >= 2);
    const spent = (await rt.status.spend(PLACES))[0]!.monthUsd;
    expect(spent).toBeGreaterThan(0);
    await rt.workspaces.delete(ws.id);
    stop();
    // The pane is gone with the workspace and there is no record left to read a caller's right to the series off.
    expect(await rt.status.history(ws.id)).toEqual([]);
    // The month keeps it, and nothing is burning now: the delete ended the stretch wherever it stood.
    await until(async () => (await rt.status.spend(PLACES))[0]?.rateUsdPerHour === 0);
    expect((await rt.status.spend(PLACES))[0]).toMatchObject({ place: "default", monthUsd: spent, rateUsdPerHour: 0 });
    expect(deletes()).toBe(0);

    const fresh = createRuntime({ backend, store, adapters: {}, status: { costIntervalMs: 15, pollIntervalMs: 60_000 } });
    expect(await fresh.status.history(ws.id)).toEqual([]);
    expect(await fresh.status.spend(PLACES)).toEqual([{ place: "default", monthUsd: spent, rateUsdPerHour: 0 }]);
  });

  it("drops a deleted workspace's document once its last tick falls out of the month, so the store holds one month of them", async () => {
    const backend = stubBackend();
    const { store, deletes } = countingStore();
    const fc = fakeClock(Date.parse("2026-09-13T09:00:00.000Z"));
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = first.status.watch();
    await tickCost(fc, costs);
    await first.workspaces.delete(ws.id);
    stop();
    await until(async () => (await first.status.spend(PLACES)).length === 1);

    // A host started the next month reads a series that ended in the one before it and lets it go.
    const later = fakeClock(Date.parse("2026-10-02T09:00:00.000Z"));
    const second = createRuntime({ backend, store, adapters: {}, clock: later.clock, status: ticking, idle });
    expect(await second.status.spend(PLACES)).toEqual([]);
    await until(() => deletes() >= 1);
  });

  it("totals each place over the workspaces metered on it, and burns only for the ones still awake", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, status: ticking, idle });
    const alpha = await createOn(rt, { golden: "snap_g", name: "alpha" });
    const beta = await createOn(rt, { golden: "snap_g", name: "beta" });
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    for (let i = 0; i < 3; i++) await tickCost(fc, costs);
    const rate = costs[0]!.rateUsdPerHour;
    const both = await rt.status.spend(PLACES);
    // One row for the place both forks stand on, and the computer the host runs on is not on it: nothing was
    // metered there, and a row with no meter is not a row that cost nothing.
    // One row, and it is the provider the records name rather than the first provider on the list.
    expect(both).toHaveLength(1);
    expect(both[0]!.place).toBe("default");
    expect(both[0]!.rateUsdPerHour).toBeCloseTo(2 * rate, 10);
    const alone = (await rt.status.history(alpha.id)).at(-1)!.accruedUsd + (await rt.status.history(beta.id)).at(-1)!.accruedUsd;
    expect(both[0]!.monthUsd).toBeCloseTo(alone, 10);

    // A nap lands no tick of its own; the next one on the timer is where the rate it left reads.
    await rt.workspaces.nap(beta.id);
    await tickCost(fc, costs);
    const napped = await rt.status.spend(PLACES);
    expect(napped[0]!.rateUsdPerHour).toBeCloseTo(rate, 10);
    // What a place took before a nap is still what it took: the total holds where the meter stopped.
    expect(napped[0]!.monthUsd).toBeGreaterThanOrEqual(both[0]!.monthUsd);
    stop();
  });

  it("counts a month from its first day: a series that ran out in the month before is on no total of this one", async () => {
    const backend = stubBackend();
    const fc = fakeClock(Date.parse("2026-09-15T09:00:00.000Z"));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, status: ticking, idle });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    for (let i = 0; i < 3; i++) await tickCost(fc, costs);
    expect((await rt.status.spend(PLACES))[0]!.monthUsd).toBeGreaterThan(0);
    // The same series read a month later: every tick of it is behind that month's first day, so it owes nothing.
    expect((await rt.status.spend(PLACES, Date.parse("2026-10-15T09:00:00.000Z")))[0]!.monthUsd).toBe(0);
    stop();
  });

  it("is refused on a socket let in on a ticket, as the places list it feeds is", async () => {
    const { rt } = testRuntime({ costIntervalMs: 15, pollIntervalMs: 60_000 });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const host = await WsClient.connect(srv.port, { token: "secret" });
    const own = await host.request("cost.spend");
    expect(own).toMatchObject({ ok: true });
    // This host holds no places of its own, so there is no row to put a total on.
    expect(own["places"]).toEqual([]);
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("cost.spend")).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    relayed.close();
    expect(THREAD_OPS).not.toContain("cost.spend");
  });
});

describe("serveRuntime status.subscribe", () => {
  it("returns a snapshot and pushes cost events to a subscribed socket", async () => {
    const { rt } = testRuntime({ costIntervalMs: 15, pollIntervalMs: 60_000 });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const res = await c.request("status.subscribe");
    expect(res.ok).toBe(true);
    const statuses = res["statuses"] as WorkspaceStatus[];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ name: "alpha", machineState: "running" });
    await until(() => c.events.some(e => e.type === "workspace.cost"));
    c.close();
  });
});

describe("status zombie at rest", () => {
  /** A stub that answers 426 late: the machine is there, the edge is slow (the two measured zombies read this way for minutes). */
  async function slowMachine(backend: StubBackend): Promise<{ hits: () => number }> {
    const slow = await httpStub(426, 40);
    openServers.push(slow.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${slow.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    return slow;
  }
  const probes = (backend: StubBackend) => backend.machines[0]!.execLog.filter(c => c === "echo ok").length;
  const statuses = (rt: Runtime): WorkspaceStatus[] => {
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));
    return seen;
  };
  const opts = { costIntervalMs: 60_000, pollIntervalMs: 5, promptMs: 10, probeTimeoutMs: 500, zombieWindowMs: 80, zombieProbeTimeoutMs: 200 };

  it("reach slow past the window and a failing exec probe mark the workspace zombie, with the machine id and timings in the reason, once", async () => {
    const { rt, backend } = testRuntime(opts);
    const ws = await createOn(rt, { golden: "snap_g", name: "hello" });
    await slowMachine(backend);
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? { exitCode: 1, stdout: "", stderr: "502 exec failed" } : { exitCode: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.reach.state === "zombie"), 5_000);
      const zombie = seen.find(s => s.reach.state === "zombie")!;
      expect(zombie).toMatchObject({ id: ws.id, phase: "running", machineState: "running", machineId: "m1" });
      expect(zombie.reason).toMatch(/m1/);
      expect(zombie.reason).toMatch(/slow .*\d+ s/);
      expect(zombie.reason).toMatch(/echo ok.*\d+ ms.*exit 1: 502 exec failed/);
      expect(seen.filter(s => s.reach.state === "slow").length).toBeGreaterThan(0);
      // The mark sticks: later polls keep saying zombie without probing again.
      const before = probes(backend);
      const pushed = seen.length;
      await new Promise(r => setTimeout(r, 100));
      expect(probes(backend)).toBe(before);
      expect(before).toBe(1);
      expect(seen.slice(pushed).every(s => s.reach.state === "zombie")).toBe(true);
      expect(seen.filter(s => s.reach.state === "zombie").length).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/zombie.*m1/);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it("a slow spell where exec answers never flags, and the probe repeats once per window rather than per poll", async () => {
    const { rt, backend } = testRuntime(opts);
    await createOn(rt, { golden: "snap_g", name: "weather" });
    const slow = await slowMachine(backend);
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => probes(backend) >= 2, 5_000);
      const polls = slow.hits();
      expect(seen.every(s => s.reach.state === "slow")).toBe(true);
      expect(seen.every(s => s.reason === undefined)).toBe(true);
      expect(polls).toBeGreaterThan(probes(backend) * 2);
    } finally {
      stop();
    }
  });

  it("an exec probe that never returns is cut at its timeout and counts as failed", async () => {
    const { rt, backend } = testRuntime({ ...opts, zombieProbeTimeoutMs: 60 });
    await createOn(rt, { golden: "snap_g", name: "hang" });
    await slowMachine(backend);
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? new Promise<never>(() => {}) : { exitCode: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.reach.state === "zombie"), 5_000);
      expect(seen.find(s => s.reach.state === "zombie")!.reason).toMatch(/timed out after 60 ms/);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it("a listing that will not wait spends no exec probe on a machine dark past the window: it reads the word the poller settled, and the poller still flags it", async () => {
    const { rt, backend } = testRuntime(opts);
    await createOn(rt, { golden: "snap_g", name: "dark" });
    await slowMachine(backend);
    // A probe that never returns: had the listing started one it would have cost the whole zombie timeout.
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? new Promise<never>(() => {}) : { exitCode: 0, stdout: "", stderr: "" });
    const list = async (): Promise<WorkspaceStatus> => (await rt.status.list({ ...opts, reconcile: "on-failure", zombieProbe: false }))[0]!;

    expect((await list()).reach.state).toBe("slow");
    await new Promise(r => setTimeout(r, opts.zombieWindowMs + 20));
    const past = await list();
    expect(past.reach.state).toBe("slow");
    expect(past.machineState).toBe("running");
    expect(probes(backend)).toBe(0);

    // The verdict is the poller's, and it still reaches it on the same machine.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.reach.state === "zombie"), 5_000);
      expect(probes(backend)).toBe(1);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it("a machine the provider says is paused gets no probe: the divergence already explains the slow reach", async () => {
    const { rt, backend } = testRuntime(opts);
    await createOn(rt, { golden: "snap_g", name: "behind-our-back" });
    await slowMachine(backend);
    backend.machines[0]!.paused = true;
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.machineState === "paused"), 5_000);
      await new Promise(r => setTimeout(r, 200));
      expect(probes(backend)).toBe(0);
      expect(seen.some(s => s.reach.state === "zombie")).toBe(false);
    } finally {
      stop();
    }
  });
});

describe("a machine the provider answered it cannot reach", () => {
  const LINE = machineUnreachableLine("Sandbox is not reachable");
  const EXPIRES = 1_900_000_000_000;
  const wordOf = (s: WorkspaceStatus): string => workspaceWord(workspaceState({ phase: s.phase, machineState: s.machineState, reach: s.reach.state }));

  /** A running fork whose daemon answers over its route while the provider refuses every command on it. */
  async function marked(exec: StatusRecord["exec"], over: Partial<Pick<StatusRecord, "phase" | "providerState">> = {}) {
    const daemon = await httpStub(426);
    openServers.push(daemon.server);
    const fc = fakeClock();
    const calls = { state: 0, exec: 0, mints: 0 };
    /** Down, the mint fails the way a lookup on this computer does, which is a tick that learns nothing. */
    const road = { down: false };
    const record: StatusRecord = {
      id: "ws_u",
      name: "far",
      machineId: "sbx_1",
      kind: "cloud",
      phase: "running",
      golden: "snap_g",
      project: { id: "pr_1a2b3c4d", name: "far", path: "/root/far", computer: "here" },
      createdAt: new Date(fc.clock.now()).toISOString(),
      size: { cpu: 2, memMb: 4096 },
      rateUsdPerHour: 0.11,
      generation: 1,
      daemonReach: async () => {
        calls.mints++;
        if (road.down) throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN edge.example"), { code: "EAI_AGAIN" }) });
        return { url: `http://127.0.0.1:${daemon.port}/?port=7681`, expiresAt: EXPIRES };
      },
      providerState: async () => {
        calls.state++;
        return "running";
      },
      exec: (cmd, o) => {
        calls.exec++;
        return exec(cmd, o);
      },
      unreached: LINE,
      ...over,
    };
    const tracker = createStatusTracker({ records: async () => [record], store: memoryStore(), emit: () => {}, on: () => () => {}, clock: fc.clock, defaults: { zombieProbeTimeoutMs: 2_000 } });
    const poll = async (opts?: StatusListOptions): Promise<WorkspaceStatus> => {
      fc.advance(POLL_INTERVAL_MS);
      return (await tracker.list(opts))[0]!;
    };
    return { record, fc, calls, road, poll };
  }
  const refused = async (): Promise<ExecResult> => {
    throw new Error(LINE);
  };

  it("reads Unreachable on the first poll with the provider's sentence, asks the provider, and starts one exec probe", async () => {
    const { calls, poll } = await marked(refused);
    const status = await poll();
    expect(status).toMatchObject({ machineState: "running", reach: { state: "unreachable" }, reason: LINE });
    expect(wordOf(status)).toBe("Unreachable");
    expect(calls.state).toBe(1);
    expect(calls.exec).toBe(1);
  });

  it("keeps the route minted and probed as every running record's, so the app's preview keeps its address", async () => {
    const { calls, poll } = await marked(refused);
    const status = await poll();
    expect(calls.mints).toBe(1);
    expect(status.reach.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?port=7681$/);
    expect(status.reach.expiresAt).toBe(EXPIRES);
  });

  it("keeps Unreachable and the sentence across a tick where this computer's own road fails", async () => {
    const { road, poll } = await marked(refused);
    expect((await poll()).reach.state).toBe("unreachable");
    road.down = true;
    const status = await poll();
    expect(status).toMatchObject({ reach: { state: "unreachable", offline: true }, reason: LINE });
    expect(wordOf(status)).toBe("Unreachable");
  });

  it("reads Unreachable with the sentence when this computer's own road is down from a reader's first read", async () => {
    const { road, poll } = await marked(refused);
    road.down = true;
    for (const status of [await poll(), await poll({ zombieProbe: false, reader: "table" })]) {
      expect(status).toMatchObject({ reach: { state: "unreachable", offline: true }, reason: LINE });
      expect(wordOf(status)).toBe("Unreachable");
    }
  });

  it("spends no exec on a listing that will not wait, and keeps the sentence and the route there, while the poll still probes", async () => {
    const { calls, poll } = await marked(refused);
    const table = await poll({ zombieProbe: false, reader: "table" });
    expect(table).toMatchObject({ reach: { state: "unreachable", expiresAt: EXPIRES }, reason: LINE });
    expect(table.reach.url).toContain("127.0.0.1");
    expect(calls.exec).toBe(0);
    expect((await poll()).reason).toBe(LINE);
    expect(calls.exec).toBe(1);
  });

  it("holds one exec probe in flight however many ticks pass while the provider hangs", async () => {
    const { calls, poll } = await marked(() => new Promise<never>(() => {}));
    expect((await poll()).reach.state).toBe("unreachable");
    expect((await poll()).reach.state).toBe("unreachable");
    expect((await poll()).reason).toBe(LINE);
    expect(calls.exec).toBe(1);
  });

  it("past the zombie window with the probe failing reads zombie, the sentence still its reason and the judge's line in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fc, poll } = await marked(refused);
      expect((await poll()).reach.state).toBe("unreachable");
      fc.advance(3 * 60_000);
      const status = await poll();
      expect(status).toMatchObject({ machineState: "running", reach: { state: "zombie" }, reason: LINE });
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([expect.stringMatching(/^zombie on sbx_1 \(workspace ws_u\): .*exec probe "echo ok" failed after \d+ ms/)]);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads what the probe says again once the mark is off", async () => {
    const { record, poll } = await marked(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }));
    expect((await poll()).reason).toBe(LINE);
    delete record.unreached;
    const status = await poll();
    expect(status.reach.state).toBe("reachable");
    expect(status.reason).toBeUndefined();
  });

  it("a napping record with the mark reads napping and asks the machine nothing", async () => {
    const { calls, poll } = await marked(refused, { phase: "napping", providerState: async () => "paused" });
    const status = await poll();
    expect(status.reach.state).toBe("napping");
    expect(status.reason).toBeUndefined();
    expect(calls.exec).toBe(0);
  });
});

describe("gone machines and the meter", () => {
  it("a record found gone at hydrate drops its awake mark without folding: gone ticks are frozen and the first tick after a rebuild does not bill the downtime", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    const ws = await createOn(first, { golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await tickCost(fc, costs);
    stop();
    await first.close();
    expect(costs.at(-1)).toMatchObject({ phase: "running", awakeMs: TICK_MS });

    // An hour down, and the machine deleted at the provider meanwhile: the next host finds it gone.
    backend.machines[0]!.killed = true;
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status: ticking, idle });
    await until(async () => (await second.workspaces.get(ws.id)).phase === "gone");
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await tickCost(fc, after);
    await tickCost(fc, after);
    expect(after).toMatchObject([
      { phase: "gone", rateUsdPerHour: 0, awakeMs: TICK_MS },
      { phase: "gone", rateUsdPerHour: 0, awakeMs: TICK_MS },
    ]);

    // The rebuild starts the stretch with a tick at that instant: the hour the host was down and the machine did not exist is not on the bill.
    await stepped(after, () => second.workspaces.rebuild(ws.id));
    expect(after.at(-1)).toMatchObject({ phase: "running", awakeMs: TICK_MS });
    await tickCost(fc, after);
    expect(after.at(-1)).toMatchObject({ phase: "running", awakeMs: 2 * TICK_MS });
    stop();
    await second.close();
  });
});

describe("the reach word a row shows", () => {
  /** A daemon stub the test switches between answering 426 at once and holding every request open past the probe's timeout. */
  async function switchable(): Promise<{ port: number; mode: { answer: boolean }; hits: () => number }> {
    const mode = { answer: true };
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      if (mode.answer) res.writeHead(426).end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    const addr = server.address();
    return { port: typeof addr === "object" && addr !== null ? addr.port : 0, mode, hits: () => hits };
  }
  /** A port nothing listens on: the far end refuses, which is the machine's miss, not this computer's. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    await new Promise<void>(r => server.close(() => r()));
    return port;
  }
  /** What fetch rejects with when the name will not resolve: the shape Node gives, with the system error as the cause. */
  const noDns = (code = "ENOTFOUND"): TypeError => new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ${code} edge.example`), { code }) });
  /** The same over several addresses tried, as Node reports a host with no route to any of them. */
  const noRoute = (): TypeError => new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }), Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" })]) });
  /** The probe's timeout is real time, so a held request costs the test 300 ms; the prompt bound never trips on the fake clock. */
  const opts = { probeTimeoutMs: 300, promptMs: 5_000 };
  const wordOf = (s: WorkspaceStatus): string => workspaceWord(workspaceState({ phase: s.phase, machineState: s.machineState, reach: s.reach.state }));

  it("one silence keeps the word an answer earned, a second in a row turns it Unreachable, an answer clears it at once; the raw miss under it still sends the poll to the provider", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, idle });
    await createOn(rt, { golden: "snap_g", name: "steady" });
    const daemon = await switchable();
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${daemon.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const calls = countProvider(backend);
    const poll = async (): Promise<WorkspaceStatus> => {
      fc.advance(POLL_INTERVAL_MS);
      return (await rt.status.list({ ...opts, reconcile: "on-failure" }))[0]!;
    };

    expect(wordOf(await poll())).toBe("Running");
    daemon.mode.answer = false;
    const first = await poll();
    expect(first.reach.state).toBe("reachable");
    expect(wordOf(first)).toBe("Running");
    expect(calls().state).toBe(1);
    const second = await poll();
    expect(second.reach.state).toBe("unreachable");
    expect(wordOf(second)).toBe("Unreachable");
    daemon.mode.answer = true;
    const back = await poll();
    expect(back.reach.state).toBe("reachable");
    expect(wordOf(back)).toBe("Running");
    daemon.mode.answer = false;
    expect(wordOf(await poll())).toBe("Running");
    expect(wordOf(await poll())).toBe("Unreachable");
    expect(daemon.hits()).toBe(6);
  });

  it("the table keeps its own run of probes: its reads never spend the silence the sidebar's row is granted, and are dampened by the read before them", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, idle });
    await createOn(rt, { golden: "snap_g", name: "steady" });
    await createOn(rt, { golden: "snap_g", name: "dark" });
    const daemon = await switchable();
    const dead = await closedPort();
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${daemon.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    backend.machines[1]!.previewUrl = async port => ({ url: `http://127.0.0.1:${dead}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const row = (all: WorkspaceStatus[], name: string): WorkspaceStatus => all.find(w => w.name === name)!;
    const poll = async (): Promise<WorkspaceStatus[]> => {
      fc.advance(POLL_INTERVAL_MS);
      return rt.status.list({ ...opts, reconcile: "on-failure" });
    };
    const table = async (): Promise<WorkspaceStatus[]> => rt.status.list({ ...opts, reconcile: "on-failure", reader: "table" });

    expect(wordOf(row(await poll(), "steady"))).toBe("Running");
    expect(wordOf(row(await table(), "steady"))).toBe("Running");
    daemon.mode.answer = false;
    // One blip is not a machine gone dark on this door either: the table's own last read answered, so this one waits.
    expect(wordOf(row(await table(), "steady"))).toBe("Running");
    // The table's second silence in a row turns the table's word, and only the table's.
    expect(wordOf(row(await table(), "steady"))).toBe("Unreachable");
    // A machine no read of this door ever found answering is unreachable at once: what is dampened is a run of
    // probes, not a word a row is owed.
    expect(wordOf(row(await table(), "dark"))).toBe("Unreachable");
    // The poller's own next probe is still the first silence after an answer, however many table reads went by.
    expect(wordOf(row(await poll(), "steady"))).toBe("Running");
    expect(wordOf(row(await poll(), "steady"))).toBe("Unreachable");
    // And back the other way: the poller's answer is not the table's, so the table waits out its own silence again.
    daemon.mode.answer = true;
    expect(wordOf(row(await poll(), "steady"))).toBe("Running");
    expect(wordOf(row(await table(), "steady"))).toBe("Running");
  });

  it("with no app open nothing else probes, and the table is dampened by its own last read: one blip keeps the word", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, idle });
    await createOn(rt, { golden: "snap_g", name: "steady" });
    const daemon = await switchable();
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${daemon.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    // No watcher and no poll anywhere in this test: every probe of this machine is a table read's own.
    const table = async (): Promise<WorkspaceStatus> => {
      fc.advance(POLL_INTERVAL_MS);
      return (await rt.status.list({ ...opts, reconcile: "on-failure", reader: "table" }))[0]!;
    };

    expect(wordOf(await table())).toBe("Running");
    daemon.mode.answer = false;
    expect(wordOf(await table())).toBe("Running");
    daemon.mode.answer = true;
    expect(wordOf(await table())).toBe("Running");
    daemon.mode.answer = false;
    expect(wordOf(await table())).toBe("Running");
    expect(wordOf(await table())).toBe("Unreachable");
  });

  it("a dead daemon port waits out the same window: one 502 keeps Running, the second reads Unreachable", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, idle });
    await createOn(rt, { golden: "snap_g", name: "steady" });
    const mode = { answer: true };
    const server = createServer((_req, res) => res.writeHead(mode.answer ? 426 : 502).end());
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    const port = (server.address() as { port: number }).port;
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const poll = async (): Promise<WorkspaceStatus> => {
      fc.advance(POLL_INTERVAL_MS);
      return (await rt.status.list({ ...opts, reconcile: "on-failure" }))[0]!;
    };

    expect((await poll()).reach.state).toBe("reachable");
    mode.answer = false;
    const first = await poll();
    expect(first.reach.state).toBe("reachable");
    expect(wordOf(first)).toBe("Running");
    const second = await poll();
    expect(second.reach.state).toBe("no-daemon");
    expect(wordOf(second)).toBe("Unreachable");
    mode.answer = true;
    expect((await poll()).reach.state).toBe("reachable");
  });

  it("over the poll, a single silence pushes no status at all and two push Unreachable once", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, idle, status: { ...opts, costIntervalMs: 24 * 3_600_000 } });
    await createOn(rt, { golden: "snap_g", name: "watched" });
    const daemon = await switchable();
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${daemon.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));
    const stop = rt.status.watch();
    try {
      await until(() => seen.length === 1);
      expect(seen[0]!.reach.state).toBe("reachable");
      daemon.mode.answer = false;
      const polled = daemon.hits();
      fc.advance(POLL_INTERVAL_MS);
      await until(() => daemon.hits() > polled);
      await new Promise(r => setTimeout(r, 400));
      expect(seen.length).toBe(1);
      fc.advance(POLL_INTERVAL_MS);
      await until(() => seen.length === 2);
      expect(wordOf(seen[1]!)).toBe("Unreachable");
      daemon.mode.answer = true;
      fc.advance(POLL_INTERVAL_MS);
      await until(() => seen.length === 3);
      expect(wordOf(seen[2]!)).toBe("Running");
    } finally {
      stop();
    }
  });

  it("the probe tells this computer's road from the machine's silence: no DNS or no route is offline; a timeout, a refused port and a dropped request are the machine's miss", async () => {
    expect(roadFailed(noDns())).toBe(true);
    expect(roadFailed(noDns("EAI_AGAIN"))).toBe(true);
    expect(roadFailed(noRoute())).toBe(true);
    expect(roadFailed(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }))).toBe(false);
    expect(roadFailed(new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }))).toBe(false);
    expect(roadFailed(new TypeError("fetch failed"))).toBe(false);
    expect(roadFailed(new DOMException("timed out", "TimeoutError"))).toBe(false);
    expect(roadFailed(new Error("machine m1 is on a backend without preview URLs"))).toBe(false);

    const probe = { timeoutMs: opts.probeTimeoutMs, promptMs: opts.promptMs };
    const held = await httpStub(426, "never");
    openServers.push(held.server);
    expect(await probeReach(`http://127.0.0.1:${held.port}/`, probe)).toEqual({ state: "unreachable", fromDaemon: false });
    expect(await probeReach(`http://127.0.0.1:${await closedPort()}/`, probe)).toEqual({ state: "unreachable", fromDaemon: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(noDns());
    try {
      expect(await probeReach("http://edge.example/", probe)).toEqual({ state: "unreachable", fromDaemon: false, offline: true });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a request that never leaves this computer marks no row: each keeps its word with the computer flagged offline, the provider is not asked, the zombie window does not run, and the run of misses under it is neither broken nor extended", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, idle });
    await createOn(rt, { golden: "snap_g", name: "alpha" });
    await createOn(rt, { golden: "snap_g", name: "beta" });
    const alpha = await switchable();
    const beta = await switchable();
    // An expired mint, so every poll asks for the route again and the test can fail the mint itself the way a DNS miss does.
    const ports = { m1: alpha.port, m2: beta.port };
    let mintFails = false;
    for (const m of backend.machines) {
      m.previewUrl = async port => {
        if (mintFails) throw noDns();
        return { url: `http://127.0.0.1:${ports[m.id as keyof typeof ports]}/?port=${port}`, token: "t", expiresAt: Date.now() };
      };
    }
    const calls = countProvider(backend);
    const poll = async (): Promise<Record<string, WorkspaceStatus>> => {
      fc.advance(POLL_INTERVAL_MS);
      return Object.fromEntries((await rt.status.list({ ...opts, reconcile: "on-failure" })).map(s => [s.name, s]));
    };
    /** Polls with every request from this computer failing before it leaves, the probe's or the mint's. */
    const offline = async (road: "probe" | "mint", fn: () => Promise<void>): Promise<void> => {
      const fetchSpy = road === "probe" ? vi.spyOn(globalThis, "fetch").mockRejectedValue(noDns()) : undefined;
      mintFails = road === "mint";
      try {
        await fn();
      } finally {
        fetchSpy?.mockRestore();
        mintFails = false;
      }
    };

    beta.mode.answer = false;
    await poll();
    let rows = await poll();
    expect(wordOf(rows["alpha"]!)).toBe("Running");
    expect(wordOf(rows["beta"]!)).toBe("Unreachable");
    expect(computerOffline(Object.values(rows))).toBe(false);
    const asked = calls().state;
    const polled = alpha.hits() + beta.hits();

    for (const road of ["probe", "mint"] as const) {
      await offline(road, async () => {
        for (let i = 0; i < 8; i++) {
          rows = await poll();
          expect(rows["alpha"]!.reach, road).toMatchObject({ state: "reachable", offline: true });
          expect(rows["beta"]!.reach, road).toMatchObject({ state: "unreachable", offline: true });
          expect(wordOf(rows["alpha"]!)).toBe("Running");
          expect(wordOf(rows["beta"]!)).toBe("Unreachable");
          expect(computerOffline(Object.values(rows))).toBe(true);
        }
      });
    }
    // Sixteen polls, four minutes on the clock: no provider call, no exec probe, and nothing reached the daemons.
    expect(calls().state).toBe(asked);
    expect(backend.machines.flatMap(m => m.execLog).filter(c => c === "echo ok")).toEqual([]);
    expect(alpha.hits() + beta.hits()).toBe(polled);

    beta.mode.answer = true;
    rows = await poll();
    expect(rows["alpha"]!.reach).toEqual(expect.not.objectContaining({ offline: true }));
    expect(wordOf(rows["alpha"]!)).toBe("Running");
    expect(wordOf(rows["beta"]!)).toBe("Running");
    expect(computerOffline(Object.values(rows))).toBe(false);

    // One miss, the computer offline, then a miss: two misses in a row for the machine, so the word turns.
    alpha.mode.answer = false;
    expect(wordOf((await poll())["alpha"]!)).toBe("Running");
    await offline("probe", async () => {
      expect((await poll())["alpha"]!.reach).toMatchObject({ state: "reachable", offline: true });
    });
    expect(wordOf((await poll())["alpha"]!)).toBe("Unreachable");
  });
});
