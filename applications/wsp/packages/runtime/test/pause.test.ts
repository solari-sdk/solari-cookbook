// SPDX-License-Identifier: AGPL-3.0-only
// A pause is a phase of its own: pausing is persisted and pushed before the
// provider is asked, sends are refused from then on, and every live session
// of the workspace ends with a reason the timeline shows as its last row. The
// same ending runs on delete. What a machine that has stopped answering costs
// a running turn, which is nothing, lives in link-drop.test.ts.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveUnansweredError, ResumeUnansweredError } from "@wsp/engine";
import { ALREADY_RUNNING, machineWord, moveTimedOutLine, providerCannotRefusal, RESUME_UNANSWERED, sendRefusal, workspaceState, workspaceWord, type AdapterEvent, type EventUnion, type SessionEvent } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type RuntimeOptions } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { wsRequest } from "./ws-client.js";

const PAUSED = "machine paused while the agent was working";

/** A harness whose turn never ends on its own: interrupt ends it the way the CLI would, with a session.end of its own. */
function hangingAdapter() {
  const emitters = new Map<string, (e: AdapterEvent) => void>();
  const interrupts: string[] = [];
  let n = 0;
  const factory: HarnessAdapterFactory = ({ workspaceId }) => ({
    steers: false,
    start: ({ onEvent }) => {
      const sessionId = `sess-${++n}`;
      emitters.set(workspaceId, onEvent);
      let settle: (r: { status: "interrupted" }) => void = () => {};
      const finished = new Promise<{ status: "interrupted" }>(resolve => (settle = resolve));
      onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
      onEvent({ type: "turn.delta", sessionId, kind: "text", text: "working" });
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {
          interrupts.push(workspaceId);
          onEvent({ type: "turn.done", sessionId, result: { status: "interrupted" } });
          onEvent({ type: "session.end", sessionId, exitCode: 143, sawResult: false });
          settle({ status: "interrupted" });
        },
      };
    },
  });
  const emit = (workspaceId: string, e: AdapterEvent): void => emitters.get(workspaceId)!(e);
  return { factory, interrupts, emit };
}

function holdable<T>(): { promise: Promise<T>; release: (v: T) => void } {
  let release: (v: T) => void = () => {};
  const promise = new Promise<T>(resolve => (release = resolve));
  return { promise, release };
}

const ends = (events: EventUnion[]): Extract<SessionEvent, { type: "session.end" }>[] =>
  events.filter((e): e is Extract<SessionEvent, { type: "session.end" }> => e.type === "session.end");

describe("the pause mode gates the two moves", () => {
  it("nap and wake are refused with the provider's own sentence on a backend without a pause mode, and taken on one declaring disk", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    delete backend.capabilities.pauseMode;
    // A machine wsp forks whose provider does not pause is not a machine wsp does not run: the refusal names the
    // provider's limit, as every other verb this machine cannot take does.
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow(providerCannotRefusal("x", machineWord("cloud"), "be paused"));
    expect(backend.machines[0]!.paused).toBe(false);
    // The runtime reads that a mode is there, never which: a disk pause is a nap and a wake like any other here.
    backend.capabilities.pauseMode = "disk";
    expect((await rt.workspaces.nap(ws.id)).phase).toBe("napping");
    expect(backend.machines[0]!.paused).toBe(true);
    delete backend.capabilities.pauseMode;
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(providerCannotRefusal("x", machineWord("cloud"), "be woken"));
    expect(backend.machines[0]!.paused).toBe(true);
    backend.capabilities.pauseMode = "disk";
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    expect(backend.machines[0]!.resumes).toBe(1);
  });
});

describe("nap phase order", () => {
  it("persists and pushes pausing before the provider pause, napping after, and a read mid-pause says pausing", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const pushed: string[] = [];
    rt.events.on("workspace.status", e => e.type === "workspace.status" && pushed.push(`${e.status.phase}/${e.status.machineState}/${e.status.reach.state}`));
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const pause = m.pause.bind(m);
    let midPause: { stored: string; read: string; pushed: string[] } | undefined;
    m.pause = async () => {
      midPause = { stored: (await store.get("workspaces", ws.id) as { phase: string }).phase, read: (await rt.workspaces.get(ws.id)).phase, pushed: [...pushed] };
      await pause();
    };
    const napped = await rt.workspaces.nap(ws.id);
    expect(midPause).toEqual({ stored: "pausing", read: "pausing", pushed: ["pausing/running/napping"] });
    expect(napped.phase).toBe("napping");
    expect(pushed).toEqual(["pausing/running/napping", "napping/paused/napping"]);
    expect((await store.get("workspaces", ws.id) as { phase: string }).phase).toBe("napping");
  });

  it("a pause the provider refuses goes back to running with the error on the pushed status, its sessions untouched", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const pushed: EventUnion[] = [];
    rt.events.on("*", e => pushed.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    backend.machines[0]!.pause = async () => {
      throw new Error("provider down");
    };
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow("provider down");
    expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    expect(pushed.some(e => e.type === "session.end")).toBe(false);
    expect(handle.view().status).toBe("running");
    expect(pushed.filter(e => e.type === "workspace.status").map(e => e.type === "workspace.status" && [e.status.phase, e.status.reason])).toEqual([["pausing", undefined], ["running", "provider down"]]);
  });

  it("a wake asked during the pause waits for it and then wakes; a second nap joins the first", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const gate = holdable<void>();
    const pause = m.pause.bind(m);
    m.pause = async () => {
      await gate.promise;
      await pause();
    };
    const first = rt.workspaces.nap(ws.id);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "pausing");
    const second = rt.workspaces.nap(ws.id);
    const waking = rt.workspaces.wake(ws.id);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("pausing");
    gate.release();
    expect((await first).phase).toBe("napping");
    expect((await second).phase).toBe("napping");
    expect((await waking).phase).toBe("running");
    expect(m.resumes).toBe(1);
  });
});

describe("the start guard", () => {
  it("refuses sessions.start while pausing, paused and waking with the composer's sentence, in process and over the wire", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const pauseGate = holdable<void>();
    const pause = m.pause.bind(m);
    m.pause = async () => {
      await pauseGate.promise;
      await pause();
    };
    const napping = rt.workspaces.nap(ws.id);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "pausing");
    await expect(rt.sessions.start(ws.id, { prompt: "hi" })).rejects.toThrow("Workspace is pausing; wake it to send");
    pauseGate.release();
    await napping;
    await expect(rt.sessions.start(ws.id, { prompt: "hi" })).rejects.toThrow("Workspace is paused; wake it to send");

    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    try {
      const res = await wsRequest(srv.port, "t", { op: "sessions.start", workspaceId: ws.id, prompt: "hi" });
      expect(res).toMatchObject({ ok: false, error: "Workspace is paused; wake it to send" });
    } finally {
      await srv.close();
    }

    const resumeGate = holdable<void>();
    const resume = m.resume.bind(m);
    m.resume = async () => {
      await resumeGate.promise;
      await resume();
    };
    const waking = rt.workspaces.wake(ws.id);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "waking");
    await expect(rt.sessions.start(ws.id, { prompt: "hi" })).rejects.toThrow("Workspace is waking; sends open when it is running");
    resumeGate.release();
    await waking;
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(handle.view().status).toBe("running");
    expect(await rt.sessions.list(ws.id)).toHaveLength(1);
  });
});

describe("sessions end with the machine", () => {
  it("nap ends every live session of that workspace with the reason once the provider has paused, once, and drops what the harness says after", async () => {
    const backend = stubBackend();
    const { factory, interrupts, emit } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const a = await createOn(rt, { golden: "snap_g", name: "a" });
    const b = await createOn(rt, { golden: "snap_g", name: "b" });
    const one = await rt.sessions.start(a.id, { prompt: "one" });
    const two = await rt.sessions.start(a.id, { prompt: "two" });
    const other = await rt.sessions.start(b.id, { prompt: "other" });
    let sessionsAtPause: string[] = [];
    const m = backend.machines[0]!;
    const pause = m.pause.bind(m);
    m.pause = async () => {
      sessionsAtPause = (await rt.sessions.list(a.id)).map(s => s.status);
      await pause();
    };

    await rt.workspaces.nap(a.id);

    // The reason says the machine paused, so it is written once the provider has confirmed the pause, not before.
    expect(sessionsAtPause).toEqual(["running", "running"]);
    const ended = ends(events).filter(e => e.workspaceId === a.id);
    expect(ended).toHaveLength(2);
    for (const e of ended) expect(e).toMatchObject({ exitCode: null, sawResult: false, reason: PAUSED });
    expect(new Set(ended.map(e => e.sessionId))).toEqual(new Set([one.view().claudeSessionId, two.view().claudeSessionId]));
    expect(events.findIndex(e => e.type === "session.end")).toBeLessThan(events.findIndex(e => e.type === "workspace.napped"));
    for (const s of await rt.sessions.list(a.id)) expect(s).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
    expect(interrupts).toEqual([a.id, a.id]);
    expect(other.view().status).toBe("running");
    expect(ends(events).filter(e => e.workspaceId === b.id)).toEqual([]);

    // The harness's own end and anything after it are already told: the reason row stays the last one.
    const history = await rt.sessions.history(a.id);
    expect(history.at(-1)).toMatchObject({ type: "session.end", reason: PAUSED });
    expect(history.filter(e => e.type === "session.end")).toHaveLength(2);
    emit(a.id, { type: "turn.delta", sessionId: "sess-2", kind: "text", text: "late" });
    expect((await rt.sessions.history(a.id)).length).toBe(history.length);
    expect(await rt.sessions.interrupt(two.id)).toEqual({ outcome: "not-running" });
    await one.finished;
    expect(one.view().status).toBe("failed");
  });

  it("delete ends the live sessions with its own reason before the machine dies", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "one" });
    await rt.workspaces.delete(ws.id);
    expect(ends(events)).toHaveLength(1);
    expect(ends(events)[0]).toMatchObject({ workspaceId: ws.id, reason: "machine deleted while the agent was working" });
    expect(events.findIndex(e => e.type === "session.end")).toBeLessThan(events.findIndex(e => e.type === "workspace.deleted"));
    expect(handle.view()).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
  });
});

describe("a record left at pausing", () => {
  it("hydrates as napping when the provider holds the machine paused, so the next wake resumes it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(first, { golden: "snap_g", name: "x" });
    const stored = (await store.get("workspaces", ws.id)) as { phase: string };
    await store.put("workspaces", ws.id, { ...stored, phase: "pausing" });
    backend.machines[0]!.paused = true;
    const second = createRuntime({ backend, store, adapters: {} });
    expect((await second.workspaces.get(ws.id)).phase).toBe("napping");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
    const woken = await second.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(backend.machines[0]!.resumes).toBe(1);
  });

  // The host died between writing pausing and the provider's pause taking, or the pause was refused; or the nap
  // wrote napping over a pause that never took, and the host was restarted with the store saying so.
  it.each(["pausing", "napping"] as const)("left %s over a machine the provider runs, it hydrates running, says so in the log, and the machine bills and takes sends again", async left => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(first, { golden: "snap_g", name: "x" });
    const stored = (await store.get("workspaces", ws.id)) as { phase: string };
    await store.put("workspaces", ws.id, { ...stored, phase: left });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const second = createRuntime({ backend, store, adapters: {} });
      const hydrated = await second.workspaces.get(ws.id);
      expect(hydrated.phase).toBe("running");
      expect(sendRefusal(workspaceState({ phase: hydrated.phase }))).toBeNull();
      expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
      expect((await second.status.list())[0]).toMatchObject({ phase: "running", machineState: "running" });
      expect(warn.mock.calls.map(c => String(c[0]))).toContain(`workspace ${ws.id} was left ${left} and its machine is running at the provider; the record hydrates running`);
      expect(backend.machines[0]!.resumes).toBe(0);
      expect(backend.machines[0]!.paused).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a record that says napping over a machine the provider runs", () => {
  /** A nap whose pause never took at the provider: the record says napping, the machine runs, and a resume would be refused. */
  async function napThatNeverTook(): Promise<{ backend: StubBackend; rt: ReturnType<typeof createRuntime>; id: string; events: EventUnion[] }> {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    m.paused = false;
    m.resume = async () => {
      throw Object.assign(new Error("Sandbox is not paused"), { kind: "conflict", status: 409 });
    };
    events.length = 0;
    return { backend, rt, id: ws.id, events };
  }

  it("pause asks the provider first and pauses the machine for real", async () => {
    const { backend, rt, id } = await napThatNeverTook();
    const napped = await rt.workspaces.nap(id);
    expect(napped.phase).toBe("napping");
    expect(backend.machines[0]!.paused).toBe(true);
    expect((await rt.workspaces.get(id)).phase).toBe("napping");
  });

  it("two pauses asked at once adopt running once and pause once: one provider pause, one woken, no running push inside the pause", async () => {
    const { backend, rt, id, events } = await napThatNeverTook();
    const m = backend.machines[0]!;
    let pauses = 0;
    const pause = m.pause.bind(m);
    m.pause = async () => {
      pauses++;
      return pause();
    };
    const [a, b] = await Promise.all([rt.workspaces.nap(id), rt.workspaces.nap(id)]);
    expect(a.phase).toBe("napping");
    expect(b.phase).toBe("napping");
    expect(pauses).toBe(1);
    expect(m.paused).toBe(true);
    expect(events.filter(e => e.type === "workspace.woken")).toHaveLength(1);
    const phases = events.filter(e => e.type === "workspace.status").map(e => (e.type === "workspace.status" ? e.status.phase : ""));
    expect(phases).toEqual(["running", "pausing", "napping"]);
  });

  it("pause on a record that says napping over a machine the provider holds paused asks once and pauses nothing", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    let asked = 0;
    let pauses = 0;
    const state = m.state.bind(m);
    m.state = async () => { asked++; return state(); };
    m.pause = async () => { pauses++; };
    expect((await rt.workspaces.nap(ws.id)).phase).toBe("napping");
    expect(asked).toBe(1);
    expect(pauses).toBe(0);
  });

  it("wake takes the provider's running as the fact: the record becomes running with the line in words, nothing is resumed, and the row never says waking", async () => {
    const { backend, rt, id, events } = await napThatNeverTook();
    const woken = await rt.workspaces.wake(id);
    expect(woken.phase).toBe("running");
    expect((await rt.workspaces.get(id)).phase).toBe("running");
    expect(backend.machines[0]!.resumes).toBe(0);
    const pushed = events.filter(e => e.type === "workspace.status").map(e => (e.type === "workspace.status" ? e.status : null)!);
    expect(pushed.map(s => s.phase)).not.toContain("waking");
    expect(pushed.at(-1)).toMatchObject({ phase: "running", machineState: "running", reason: ALREADY_RUNNING });
    expect(events.map(e => e.type)).toContain("workspace.woken");
    // The exec that asked for the wake goes on, as on any running machine.
    expect((await rt.workspaces.exec(id, "true")).exitCode).toBe(0);
    await rt.workspaces.nap(id);
    expect(backend.machines[0]!.paused).toBe(true);
  });
});

describe("a pause the runtime did not start", () => {
  const openServers: Server[] = [];
  afterEach(async () => {
    await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
    openServers.length = 0;
  });

  /** The edge answers nothing for a paused machine (measured: the reach goes dark only while paused). */
  async function darkReach(backend: StubBackend): Promise<void> {
    const server = createServer(() => {});
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    const port = (server.address() as { port: number }).port;
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
  }

  it("the poll sees the provider's machine paused under a running record: the phase follows, the sessions end, the status is pushed, and wake resumes it", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: factory },
      status: { costIntervalMs: 60_000, pollIntervalMs: 5, promptMs: 10, probeTimeoutMs: 50, reconcileMinMs: 0 },
    });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "one" });
    await darkReach(backend);
    const m = backend.machines[0]!;
    m.paused = true;
    const stop = rt.status.watch();
    try {
      await until(() => events.some(e => e.type === "workspace.napped"), 5_000);
    } finally {
      stop();
    }
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(ends(events)).toHaveLength(1);
    expect(ends(events)[0]).toMatchObject({ workspaceId: ws.id, reason: PAUSED });
    expect(handle.view().status).toBe("failed");
    const pushed = events.filter(e => e.type === "workspace.status").map(e => e.type === "workspace.status" && e.status);
    expect(pushed.some(s => s !== false && s.phase === "napping" && s.machineState === "paused" && s.reason === "paused outside wsp")).toBe(true);
    await expect(rt.sessions.start(ws.id, { prompt: "again" })).rejects.toThrow("Workspace is paused; wake it to send");
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(m.resumes).toBe(1);
    expect(m.paused).toBe(false);
  });

  it("a record left waking by a wake that never landed hydrates paused when the provider holds the machine paused, and the row offers Wake", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(first, { golden: "snap_g", name: "x" });
    const stored = (await store.get("workspaces", ws.id)) as { phase: string };
    // The host died inside a wake the provider never finished, and the machine is paused at the provider.
    await store.put("workspaces", ws.id, { ...stored, phase: "waking" });
    backend.machines[0]!.paused = true;

    const second = createRuntime({ backend, store, adapters: {} });
    const hydrated = await second.workspaces.get(ws.id);
    expect(hydrated.phase).toBe("napping");
    expect(workspaceWord(workspaceState({ phase: hydrated.phase }), backend.capabilities.pauseMode)).toBe("Paused");
    expect(sendRefusal(workspaceState({ phase: hydrated.phase }))).toBe("Workspace is paused; wake it to send");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });

    const woken = await second.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(backend.machines[0]!.resumes).toBe(1);
  });

  it("a record left waking whose machine the provider is running hydrates running, so it bills, naps and takes sends again", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(first, { golden: "snap_g", name: "x" });
    const stored = (await store.get("workspaces", ws.id)) as { phase: string };
    // The resume landed and the host died before it could write the record.
    await store.put("workspaces", ws.id, { ...stored, phase: "waking" });

    const second = createRuntime({ backend, store, adapters: {} });
    const hydrated = await second.workspaces.get(ws.id);
    expect(hydrated.phase).toBe("running");
    expect(workspaceWord(workspaceState({ phase: hydrated.phase }))).toBe("Running");
    expect(sendRefusal(workspaceState({ phase: hydrated.phase }))).toBeNull();
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
    expect((await second.status.list())[0]).toMatchObject({ phase: "running", machineState: "running" });
  });

  it("a wake the provider refuses leaves the record paused, not waking, and the next wake tries again", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    const resume = m.resume.bind(m);
    let refuse = true;
    // What Solari's resume answers when it gives up: a transient status, out of retries.
    m.resume = async () => {
      if (refuse) throw Object.assign(new Error("upstream request timeout"), { kind: "transient", status: 504 });
      return resume();
    };
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow("upstream request timeout");
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });

    refuse = false;
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    expect(m.paused).toBe(false);
  });

  it("a wake asked while the record still says running asks the provider once and resumes a machine it finds paused", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    let asked = 0;
    const state = m.state.bind(m);
    m.state = async () => { asked++; return state(); };
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    expect(asked).toBe(1);
    expect(m.resumes).toBe(0);
    m.paused = true;
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(m.resumes).toBe(1);
    expect(events.map(e => e.type)).toContain("workspace.napped");
    expect(events.map(e => e.type)).toContain("workspace.woken");
  });
});

// The backend settles its own pause and resume, on its own budgets and with its own reads of the machine: the runtime
// sends each move once, puts a typed failure's words on the row, and never reads the machine inside a move. What a
// provider does when a call hangs is that provider's, in its backend and its tests.
describe("a provider move the backend gave up on", () => {
  const pushes = (events: EventUnion[]) => events.filter(e => e.type === "workspace.status").map(e => (e.type === "workspace.status" ? e.status : null)!);
  const PAUSE_WORDS = moveTimedOutLine("pause", 20, "running");
  /** A move that ends the way a backend ends one it gave up on: with the typed error carrying the row's words. After
   * `land` the machine reaches the state instead, as a provider that took the call late would. */
  function unanswered(backend: StubBackend, move: "pause" | "resume"): { calls: number; land: () => void } {
    const m = backend.machines[0]!;
    let lands = false;
    const counter = { calls: 0, land: () => { lands = true; } };
    m[move] = async () => {
      counter.calls++;
      if (lands) {
        m.paused = move === "pause";
        return;
      }
      throw move === "pause" ? new MoveUnansweredError(PAUSE_WORDS) : new ResumeUnansweredError(RESUME_UNANSWERED);
    };
    return counter;
  }
  /** A runtime on a clock the test moves, so the late read and the asking cadence fire only where the test says. */
  function rig(o: Pick<RuntimeOptions, "wake"> = {}) {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, clock: fc.clock, ...o });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    return { backend, store, fc, rt, events };
  }

  it("a pause that ends in MoveUnansweredError puts the record back to running with the backend's words on the row, and the next pause works", async () => {
    const { backend, store, rt, events } = rig();
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const hung = unanswered(backend, "pause");
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow(PAUSE_WORDS);
    expect(hung.calls).toBe(1);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
    expect(pushes(events).at(-1)).toMatchObject({ phase: "running", machineState: "running", reason: PAUSE_WORDS });
    hung.land();
    expect((await rt.workspaces.nap(ws.id)).phase).toBe("napping");
    expect(hung.calls).toBe(2);
  });

  // Asking again is the host's own road and has its own file; a backend that declares no asking ends the wake on the first one.
  it("a wake that ends in ResumeUnansweredError says so on the row, leaves the wake control open, and the next wake works", async () => {
    const { backend, store, rt, events } = rig();
    delete backend.lifecycle.budgets.resumeAsks;
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await rt.workspaces.nap(ws.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hung = unanswered(backend, "resume");
    try {
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/^the provider answered none of 1 resume request over /);
    } finally {
      warn.mockRestore();
    }
    expect(hung.calls).toBe(1);
    // The row said the machine was being read about while the wake was still in flight.
    expect(pushes(events).some(s => s.phase === "waking" && s.reason === RESUME_UNANSWERED)).toBe(true);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
    const last = pushes(events).at(-1)!;
    expect(last).toMatchObject({ phase: "napping", machineState: "paused" });
    expect(last.reason).toMatch(/^the provider answered none of 1 resume request over /);
    expect(workspaceWord(workspaceState({ phase: last.phase }), backend.capabilities.pauseMode)).toBe("Paused");
    hung.land();
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
  });

  it("a resume that lands after the wake gave up is found by one later read: the record follows to running instead of billing under a paused row", async () => {
    const { backend, store, fc, rt, events } = rig({ wake: { lateReadMs: 50 } });
    delete backend.lifecycle.budgets.resumeAsks;
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await rt.workspaces.nap(ws.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    unanswered(backend, "resume");
    try {
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/^the provider answered none of 1 resume request over /);
    } finally {
      warn.mockRestore();
    }
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    // The provider's resume lands once nobody is waiting on it; the one late read is due 50 ms after the wake gave up.
    backend.machines[0]!.paused = false;
    fc.advance(50);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "running", 2_000);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "running" });
    expect(events.map(e => e.type)).toContain("workspace.woken");
    expect(pushes(events).at(-1)).toMatchObject({ phase: "running", machineState: "running", reason: ALREADY_RUNNING });
  });

  it("the runtime sends a pause once and never reads the machine inside it; a wake reads the machine before its resume and before a second ask, never inside a move", async () => {
    const { backend, fc, rt } = rig();
    backend.lifecycle.budgets.resumeAsks = { everyMs: 60, forMs: 120 };
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const log: string[] = [];
    const realState = m.state.bind(m);
    const realPause = m.pause.bind(m);
    const realResume = m.resume.bind(m);
    m.state = async () => { log.push("state"); return realState(); };
    m.pause = async () => { log.push("pause"); return realPause(); };
    m.resume = async signal => { log.push("resume"); return realResume(signal); };
    await rt.workspaces.nap(ws.id);
    expect(log).toEqual(["pause"]);
    log.length = 0;
    await rt.workspaces.wake(ws.id);
    // One read before the resume, which is the adopt check on a napping record; nothing between the resume and its outcome.
    expect(log).toEqual(["state", "resume"]);
    await rt.workspaces.nap(ws.id);
    log.length = 0;
    // A resume the backend gave up on: the host reads the machine once before it asks again, never inside the move.
    let deaf = 1;
    m.resume = async () => {
      log.push("resume");
      if (deaf-- > 0) throw new ResumeUnansweredError(RESUME_UNANSWERED);
      m.paused = false;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const waking = rt.workspaces.wake(ws.id);
      await until(() => log.filter(c => c === "resume").length === 1);
      // The cadence is on the runtime's clock; a step taken before the timer exists is simply taken again.
      while (log.filter(c => c === "resume").length < 2) {
        fc.advance(60);
        await new Promise(r => setTimeout(r, 5));
      }
      expect((await waking).phase).toBe("running");
    } finally {
      warn.mockRestore();
    }
    expect(log).toEqual(["state", "resume", "state", "resume"]);
  });
});
