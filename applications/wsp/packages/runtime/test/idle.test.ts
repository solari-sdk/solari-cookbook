// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterEvent, EventUnion, TurnResult, WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveUnansweredError } from "@wsp/engine";
import { moveTimedOutLine } from "@wsp/protocol";
import { IDLE_OFF_BACKSTOP_MS, createIdlePolicy, type IdlePolicy } from "../src/idle.js";
import { createRuntime, type HarnessAdapterFactory, type RuntimeOptions } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

/** Minutes, not milliseconds: the clock is fake, so a long window costs nothing and scheduling jitter cannot reach it. */
const WINDOW = 5 * 60_000;
const RETRY = 15_000;

/** The policy hears a nap's outcome one microtask after the nap settles. */
const settled = (): Promise<void> => new Promise(r => setImmediate(r));

describe("idle policy mechanics", () => {
  const windows = new Map<string, number | null>();
  let fired: { id: string; windowMs: number }[] = [];
  let failing = false;
  let policy: IdlePolicy | undefined;
  let fc = fakeClock();
  const make = (): IdlePolicy =>
    (policy = createIdlePolicy({
      windowOf: id => (windows.has(id) ? windows.get(id)! : WINDOW),
      onIdle: async (id, windowMs) => {
        fired.push({ id, windowMs });
        if (failing) throw new Error("fetch failed");
      },
      retryMs: RETRY,
      clock: fc.clock,
    }));
  afterEach(() => {
    policy?.close();
    policy = undefined;
    windows.clear();
    fired = [];
    failing = false;
    fc = fakeClock();
  });

  it("fires once after the window with the window it used, then waits for the next touch", async () => {
    const p = make();
    p.touch("a");
    expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
    expect(fc.pending()).toBe(1);
    expect(fc.holding()).toBe(0); // an armed window never keeps the process alive
    fc.advance(WINDOW - 1);
    expect(fired).toEqual([]);
    fc.advance(1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
    await settled();
    expect(p.idleAt("a")).toBeUndefined();
    fc.advance(WINDOW * 2);
    expect(fired).toHaveLength(1);
  });

  it("every touch starts the window over", () => {
    const p = make();
    for (let i = 0; i < 8; i++) {
      p.touch("a");
      fc.advance(WINDOW / 4);
    }
    expect(fired).toEqual([]);
    expect(p.idleAt("a")).toBe(fc.clock.now() + (WINDOW * 3) / 4);
    fc.advance((WINDOW * 3) / 4);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
  });

  it("a hold keeps the window from firing; the last release starts it over", () => {
    const p = make();
    p.touch("a");
    p.hold("a");
    p.hold("a");
    expect(p.idleAt("a")).toBeUndefined();
    fc.advance(WINDOW * 2.5);
    expect(fired).toEqual([]);
    p.release("a");
    fc.advance(WINDOW * 1.5);
    expect(fired).toEqual([]); // one hold still stands
    p.release("a");
    expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW - 1);
    expect(fired).toEqual([]);
    fc.advance(1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
  });

  it("the last release starts the window over from the release, not from the touch", () => {
    const p = make();
    p.touch("a");
    p.hold("a");
    fc.advance(WINDOW / 2);
    p.release("a");
    expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW - 1);
    expect(fired).toEqual([]);
    fc.advance(1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
  });

  it("off means never: no timer, no deadline", () => {
    windows.set("a", null);
    const p = make();
    p.touch("a");
    expect(p.idleAt("a")).toBeUndefined();
    expect(fc.pending()).toBe(0);
    fc.advance(WINDOW * 3);
    expect(fired).toEqual([]);
  });

  it("forget cancels the window (a nap or a delete)", () => {
    const p = make();
    p.touch("a");
    p.forget("a");
    expect(p.idleAt("a")).toBeUndefined();
    expect(fc.pending()).toBe(0);
    fc.advance(WINDOW * 2);
    expect(fired).toEqual([]);
  });

  it("a per-workspace window overrides the default", () => {
    windows.set("fast", WINDOW / 4);
    const p = make();
    p.touch("fast");
    p.touch("slow");
    fc.advance(WINDOW / 4);
    expect(fired).toEqual([{ id: "fast", windowMs: WINDOW / 4 }]);
    fc.advance((WINDOW * 3) / 4);
    expect(fired.map(f => f.id)).toEqual(["fast", "slow"]);
  });

  it("a nap that fails keeps its deadline and is asked again every retry interval until one lands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      failing = true;
      const p = make();
      p.touch("a");
      const deadline = p.idleAt("a")!;
      fc.advance(WINDOW);
      await settled();
      expect(fired).toHaveLength(1);
      expect(p.idleAt("a")).toBe(deadline);
      expect(fc.holding()).toBe(0);
      fc.advance(RETRY - 1);
      expect(fired).toHaveLength(1);
      fc.advance(1);
      await settled();
      expect(fired).toEqual([{ id: "a", windowMs: WINDOW }, { id: "a", windowMs: WINDOW }]);
      expect(p.idleAt("a")).toBe(deadline);
      expect(warn).toHaveBeenCalledTimes(2);
      failing = false;
      fc.advance(RETRY);
      await settled();
      expect(fired).toHaveLength(3);
      expect(p.idleAt("a")).toBeUndefined();
      fc.advance(RETRY * 4);
      expect(fired).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("onBackstop hears now plus twice the window on every arming, now plus six hours when the window is off, and nothing on forget", () => {
    const heard: { id: string; until: number }[] = [];
    windows.set("off", null);
    const p = (policy = createIdlePolicy({
      windowOf: id => (windows.has(id) ? windows.get(id)! : WINDOW),
      onIdle: async () => {},
      retryMs: RETRY,
      clock: fc.clock,
      onBackstop: (id, until) => heard.push({ id, until }),
    }));
    const t0 = fc.clock.now();
    p.touch("a");
    p.touch("off");
    expect(heard).toEqual([{ id: "a", until: t0 + 2 * WINDOW }, { id: "off", until: t0 + IDLE_OFF_BACKSTOP_MS }]);
    // Every arming pushes again, from now: a touch, and the last release of a hold.
    fc.advance(1_000);
    p.touch("a");
    p.hold("a");
    p.release("a");
    expect(heard.slice(2)).toEqual([{ id: "a", until: t0 + 1_000 + 2 * WINDOW }, { id: "a", until: t0 + 1_000 + 2 * WINDOW }]);
    // A forget pushes nothing: a napped or deleted machine needs no stop timer.
    p.forget("a");
    p.forget("off");
    expect(heard).toHaveLength(4);
    expect(p.idleAt("off")).toBeUndefined();
  });

  it("a touch or a forget during the retries ends them: the person acted, or the nap landed another way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      failing = true;
      const p = make();
      p.touch("a");
      p.touch("b");
      fc.advance(WINDOW);
      await settled();
      expect(fired.map(f => f.id)).toEqual(["a", "b"]);
      p.touch("a");
      expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
      p.forget("b");
      expect(p.idleAt("b")).toBeUndefined();
      fc.advance(RETRY * 3);
      await settled();
      expect(fired).toHaveLength(2);
      fc.advance(WINDOW - RETRY * 3);
      await settled();
      expect(fired.map(f => f.id)).toEqual(["a", "b", "a"]);
    } finally {
      warn.mockRestore();
    }
  });
});

function testRuntime(extra: Partial<RuntimeOptions> = {}) {
  const backend = stubBackend();
  const fc = fakeClock();
  const rt = createRuntime({
    backend,
    store: memoryStore(),
    adapters: {},
    clock: fc.clock,
    idle: { defaultWindowMs: WINDOW },
    status: { costIntervalMs: 60_000, pollIntervalMs: 60_000 },
    ...extra,
  });
  return { rt, backend, fc };
}

const phaseOf = async (rt: ReturnType<typeof testRuntime>["rt"], id: string) => (await rt.workspaces.get(id)).phase;
const napping = (rt: ReturnType<typeof testRuntime>["rt"], id: string) => until(async () => (await phaseOf(rt, id)) === "napping");

/** A session that stays running until the test ends it. */
function heldSession(): { factory: HarnessAdapterFactory; end: () => void } {
  let end!: () => void;
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    start(o) {
      const result: TurnResult = { status: "completed" };
      const finished = new Promise<TurnResult>(resolve => {
        end = () => {
          o.onEvent({ type: "turn.done", sessionId: "c1", result } as AdapterEvent);
          o.onEvent({ type: "session.end", sessionId: "c1", exitCode: 0, sawResult: true } as AdapterEvent);
          resolve(result);
        };
      });
      o.onEvent({ type: "session.start", sessionId: "c1" } as AdapterEvent);
      return { localId: "s1", finished, interrupt: async () => {} };
    },
  });
  return { factory, end: () => end() };
}

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe("idle policy in the runtime", () => {
  it("naps an untouched workspace after the window and pushes a status that says why", async () => {
    const { rt, backend, fc } = testRuntime();
    const napped: EventUnion[] = [];
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.napped", e => napped.push(e));
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const [before] = await rt.status.list();
    expect(before!.idleAt).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW - 1);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    fc.advance(1);
    await until(() => statuses.some(s => s.phase === "napping"));
    expect(await phaseOf(rt, ws.id)).toBe("napping");
    expect(napped).toHaveLength(1);
    expect(backend.machines[0]!.paused).toBe(true);
    const pushed = statuses.find(s => s.phase === "napping");
    expect(pushed).toMatchObject({ id: ws.id, machineState: "paused", reach: { state: "napping" } });
    expect(pushed!.reason).toBe("idle 5 min");
    expect(pushed!.idleAt).toBeUndefined();
    fc.advance(WINDOW * 2);
    expect(napped).toHaveLength(1); // napping is not idle
  });

  it("starts the window over instead of stopping a workspace its own computer says is busy", async () => {
    const { rt, backend, fc } = testRuntime();
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    // The computer running it saw a byte through a published port a minute ago, which is inside the window: the
    // window starts over and nothing is stopped under the person clicking through it.
    backend.lifecycle.quietForMs = async () => 60_000;
    const [before] = await rt.status.list();
    expect(before!.idleAt).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW);
    await until(async () => (await rt.status.list())[0]!.idleAt === fc.clock.now() + WINDOW);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
    // And once that computer says it has been quiet for the whole window, the stop goes ahead.
    backend.lifecycle.quietForMs = async () => WINDOW;
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    expect(backend.machines[0]!.paused).toBe(true);
  });

  it("reads the figure off a lifecycle that writes it as a method, which keeps that lifecycle's own fields", async () => {
    const { rt, backend, fc } = testRuntime();
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    // A lifecycle written as a method reading a field of its own: pulled off the interface and called detached,
    // the read of that field throws or answers nothing, and the workspace stops under somebody using it.
    const said = {
      budgets: backend.lifecycle.budgets,
      figure: 60_000,
      quietForMs(this: { figure: number }): Promise<number | undefined> {
        return Promise.resolve(this.figure);
      },
    };
    backend.lifecycle = said;
    fc.advance(WINDOW);
    await until(async () => (await rt.status.list())[0]!.idleAt === fc.clock.now() + WINDOW);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
    // And the same lifecycle once its own figure is past the window: the stop goes ahead.
    said.figure = WINDOW;
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    expect(backend.machines[0]!.paused).toBe(true);
  });

  it("stops a workspace whose computer cannot say how quiet it is, and one whose reading fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Every provider: nothing above the daemon on a computer somebody owns counts a byte on a port, so the
      // host's own clock is the whole policy there, as it was before the figure existed.
      const { rt, backend, fc } = testRuntime();
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      backend.lifecycle.quietForMs = async () => undefined;
      fc.advance(WINDOW);
      await napping(rt, ws.id);
      expect(backend.machines[0]!.paused).toBe(true);

      // A reading that fails says nothing about the workspace, so the stop goes ahead rather than a workspace
      // living for ever behind a computer that will not answer.
      const second = testRuntime();
      const other = await createOn(second.rt, { golden: "snap_g", name: "b" });
      second.backend.lifecycle.quietForMs = async () => {
        throw new Error("the computer did not answer");
      };
      second.fc.advance(WINDOW);
      await napping(second.rt, other.id);
      expect(second.backend.machines[0]!.paused).toBe(true);
      expect(warn.mock.calls.flat().join(" ")).toContain("quiet figure of");
    } finally {
      warn.mockRestore();
    }
  });

  it("names the window in minutes the way the rail will show it", async () => {
    const { rt, fc } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    await createOn(rt, { golden: "snap_g", name: "a", idleWindowMs: 3 * 60_000 });
    fc.advance(3 * 60_000);
    await until(() => statuses.some(s => s.phase === "napping"));
    expect(statuses.at(-1)!.reason).toBe("idle 3 min");
    const [status] = await rt.status.list();
    expect(status!.idleAt).toBeUndefined();
  });

  it("workspaces.touch over the wire starts the window over", async () => {
    const { rt, fc } = testRuntime();
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    for (let i = 0; i < 8; i++) {
      fc.advance(WINDOW / 4);
      const res = await c.request("workspaces.touch", { workspaceId: ws.id });
      expect(res.ok).toBe(true);
    }
    expect(await phaseOf(rt, ws.id)).toBe("running");
    const [status] = await rt.status.list();
    expect(status!.idleAt).toBe(fc.clock.now() + WINDOW);
    c.close();
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    const missing = await rt.workspaces.touch("ws_nope").catch((e: Error) => e.message);
    expect(missing).toContain("no such workspace");
  });

  it("a running session holds the workspace awake; the window starts when it ends", async () => {
    const held = heldSession();
    const { rt, fc } = testRuntime({ adapters: { claude: held.factory } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    fc.advance(WINDOW * 3);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    const [active] = await rt.status.list();
    expect(active!.idleAt).toBeUndefined();
    held.end();
    await until(async () => (await rt.status.list())[0]!.idleAt !== undefined);
    expect((await rt.status.list())[0]!.idleAt).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW);
    await napping(rt, ws.id);
  });

  it("off means never; a per-workspace window beats the default", async () => {
    const { rt, fc } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const off = await createOn(rt, { golden: "snap_g", name: "off", idleWindowMs: null });
    const fast = await createOn(rt, { golden: "snap_g", name: "fast", idleWindowMs: WINDOW });
    fc.advance(WINDOW);
    await napping(rt, fast.id);
    fc.advance(40 * 60_000);
    expect(await phaseOf(rt, off.id)).toBe("running");
    const byName = new Map((await rt.status.list()).map(s => [s.name, s]));
    expect(byName.get("off")!.idleAt).toBeUndefined();
  });

  it("wake and upgrade start the window over; a rehydrated running workspace gets one too", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, clock: fc.clock, idle: { defaultWindowMs: WINDOW } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    await rt.workspaces.wake(ws.id);
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    await rt.workspaces.upgrade(ws.id);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    await rt.workspaces.wake(ws.id);
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: {}, clock: fc.clock, idle: { defaultWindowMs: WINDOW } });
    expect(await phaseOf(rt2, ws.id)).toBe("running");
    fc.advance(WINDOW);
    await napping(rt2, ws.id);
  });
  const running = (statuses: WorkspaceStatus[]) => statuses.filter(s => s.phase === "running");

  it("an idle nap the provider refuses is not asked again at the cadence: the row keeps the words and one full window starts from the answer", async () => {
    const { rt, backend, fc } = testRuntime();
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    const pause = m.pause.bind(m);
    let calls = 0;
    let refusing = true;
    m.pause = async () => {
      calls++;
      if (refusing) throw new Error("upstream request timeout");
      await pause();
    };
    const since = statuses.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fc.advance(WINDOW);
      await until(() => running(statuses.slice(since)).some(s => s.idleAt === fc.clock.now() + WINDOW));
    } finally {
      warn.mockRestore();
    }
    const answered = fc.clock.now();
    expect(calls).toBe(1);
    const last = running(statuses.slice(since)).at(-1)!;
    expect(last.reason).toBe("upstream request timeout");
    expect(last.idleAt).toBe(answered + WINDOW);
    expect((await rt.status.list())[0]!.idleAt).toBe(answered + WINDOW);
    fc.advance(WINDOW - 1);
    await settled();
    expect(calls).toBe(1);
    refusing = false;
    fc.advance(1);
    await napping(rt, ws.id);
    expect(calls).toBe(2);
    expect(statuses.at(-1)).toMatchObject({ phase: "napping", reason: "idle 5 min" });
  });

  it("an idle nap whose pause the backend gave up on keeps the deadline on the row with the backend's words, and is asked again at the cadence until one lands", async () => {
    const { rt, backend, fc } = testRuntime();
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const deadline = (await rt.status.list())[0]!.idleAt!;
    const m = backend.machines[0]!;
    const pause = m.pause.bind(m);
    const words = moveTimedOutLine("pause", 20, "running");
    let calls = 0;
    let unanswered = 2;
    m.pause = async () => {
      calls++;
      if (unanswered-- > 0) throw new MoveUnansweredError(words);
      await pause();
    };
    const since = statuses.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fc.advance(WINDOW);
      await until(() => running(statuses.slice(since)).length > 0);
      const failed = running(statuses.slice(since)).at(-1)!;
      // The row carries the backend's own words and the deadline it had, so it never reads active.
      expect(failed.reason).toBe(words);
      expect(failed.idleAt).toBe(deadline);
      expect(calls).toBe(1);
      expect(await phaseOf(rt, ws.id)).toBe("running");
      expect(warn.mock.calls.map(c => c[0])).toContainEqual(expect.stringMatching(/^idle nap of ws_\w+ failed: pause did not complete/));
      fc.advance(60_000 - 1);
      expect(calls).toBe(1);
      fc.advance(1);
      await until(() => running(statuses.slice(since)).length > 1);
      expect(running(statuses.slice(since)).at(-1)!.idleAt).toBe(deadline);
      expect(calls).toBe(2);
      fc.advance(60_000);
      await napping(rt, ws.id);
    } finally {
      warn.mockRestore();
    }
    expect(calls).toBe(3);
    expect(statuses.at(-1)).toMatchObject({ phase: "napping", reason: "idle 5 min" });
    expect(running(statuses.slice(since)).every(s => s.idleAt === deadline)).toBe(true);
    fc.advance(WINDOW * 2);
    expect(calls).toBe(3);
  });
});

describe("provider backstop on the fork spec", () => {
  it("pauses on idle at twice the policy window", async () => {
    const { rt, backend } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    await createOn(rt, { golden: "snap_g", name: "a" });
    expect(backend.machines[0]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: 40 * 60_000 });
  });

  it("follows the per-workspace window, and a resurrected fork carries it too", async () => {
    const { rt, backend } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a", idleWindowMs: 5 * 60_000 });
    expect(backend.machines[0]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: 10 * 60_000 });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    await rt.workspaces.wake(ws.id);
    expect(backend.machines[1]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: 10 * 60_000 });
  });

  it("a backend declaring a backstop is handed the machine and the instant on create and on activity, nothing on nap, the six-hour instant with auto-nap off, and a call that fails is logged", async () => {
    const { rt, backend, fc } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const heard: { machine: string; until: number }[] = [];
    let refuse = false;
    backend.lifecycle.backstop = async (machine, until) => {
      if (refuse) throw new Error("PATCH ttlSeconds refused");
      heard.push({ machine: machine.id, until });
    };
    const t0 = fc.clock.now();
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    expect(heard).toEqual([{ machine: "m1", until: t0 + 40 * 60_000 }]);
    fc.advance(5_000);
    await rt.workspaces.touch(ws.id);
    expect(heard).toEqual([{ machine: "m1", until: t0 + 40 * 60_000 }, { machine: "m1", until: t0 + 5_000 + 40 * 60_000 }]);
    await rt.workspaces.nap(ws.id);
    expect(heard).toHaveLength(2);
    // A client touching a napped workspace arms nothing at the backend: its machine is stopped, and on a provider
    // whose backstop is a stop timer that call would land on an archived machine.
    await rt.workspaces.touch(ws.id);
    fc.advance(1_000);
    await rt.workspaces.touch(ws.id);
    expect(heard).toHaveLength(2);
    // With auto-nap off the runtime still hands over its six-hour instant, so a dead host never leaves a machine billing.
    const off = await createOn(rt, { golden: "snap_g", name: "b", idleWindowMs: null });
    expect(heard.at(-1)).toEqual({ machine: "m2", until: fc.clock.now() + IDLE_OFF_BACKSTOP_MS });
    // A call the provider refuses is logged, and the window is armed all the same.
    refuse = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await rt.workspaces.touch(off.id);
      await new Promise(r => setImmediate(r));
      expect(warn.mock.calls.map(c => c[0])).toContainEqual(expect.stringMatching(/^backstop of ws_\w+ on m2 not set: PATCH ttlSeconds refused$/));
    } finally {
      warn.mockRestore();
    }
    expect((await rt.status.list()).find(s => s.id === off.id)!.idleAt).toBeUndefined();
    expect(heard).toHaveLength(3);
  });

  it("a backend without a backstop is never asked: the window arms as before", async () => {
    const { rt, backend, fc } = testRuntime();
    expect(backend.lifecycle.backstop).toBeUndefined();
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.workspaces.touch(ws.id);
    expect((await rt.status.list())[0]!.idleAt).toBe(fc.clock.now() + WINDOW);
  });

  it("off still leaves a long pause backstop so a crashed runtime stops billing", async () => {
    const { rt, backend } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    await createOn(rt, { golden: "snap_g", name: "a", idleWindowMs: null });
    expect(backend.machines[0]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: IDLE_OFF_BACKSTOP_MS });
    expect(IDLE_OFF_BACKSTOP_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });
});
