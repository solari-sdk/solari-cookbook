// SPDX-License-Identifier: AGPL-3.0-only
// What the road between this host and a machine may cost a turn running on it.
// The reach probe reads this computer's own road, so a resolver that drops a
// name reads every machine behind it dark while their processes go on working:
// four times on 2026-09-12 a blip of that shape ended every running turn on two
// machines and killed their process trees. A dial that fails on the road is
// made again for a minute, a link that drops mid-turn is dialled again while
// the turn runs on, and a turn ends where its process does, which the machine
// reports, or where its machine does, which the provider reports.
import { describe, expect, it, vi } from "vitest";
import type { ExecResult, MachineState } from "@wsp/engine";
import type { EventUnion, SessionEvent, TurnResult } from "@wsp/protocol";
import type { MachineExecOptions } from "../src/machine-exec.js";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { scriptGuest } from "./script-guest.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";

const GONE = "machine gone at the provider while the agent was working";
/** A name this computer's resolver would not answer, as fetch raises it. */
const resolverError = (): Error => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN edge.example"), { code: "EAI_AGAIN" }) });

const ends = (events: EventUnion[]): Extract<SessionEvent, { type: "session.end" }>[] =>
  events.filter((e): e is Extract<SessionEvent, { type: "session.end" }> => e.type === "session.end");
const dones = (events: EventUnion[]): Extract<SessionEvent, { type: "session.done" }>[] =>
  events.filter((e): e is Extract<SessionEvent, { type: "session.done" }> => e.type === "session.done");

/** A turn that runs on the machine's own road: one command through the stream the runtime hands it, whose output is
 * the reply and whose exit is the turn's. What a real harness does over that road, without the harness. */
const streamingAdapter: HarnessAdapterFactory = ctx => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const finished = (async (): Promise<TurnResult> => {
      onEvent({ type: "session.start", sessionId });
      let result: TurnResult;
      let exitCode: number | null = null;
      try {
        const stream = ctx.execStream("agent -p hi", { env: { ...ctx.env } });
        let out = "";
        for await (const line of stream.lines) out += line;
        exitCode = await stream.exited;
        result = exitCode === 0 ? { status: "completed", text: out } : { status: "failed", error: `agent exited with ${String(exitCode)}` };
      } catch (e) {
        result = { status: "failed", error: e instanceof Error ? e.message : String(e) };
      }
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

/** The clock the turn's stream waits on: each wait is counted whole and taken in a millisecond, so the stream lives
 * a hundred seconds for every second this test does and three minutes of dark road cost under two. The turn's own
 * idle and wall limits are the real ones, so a turn these tests leave dark too long is cut here as it would be on a
 * machine. */
function turnClock(): MachineExecOptions & { now: () => number; advance: (ms: number) => void } {
  let now = 0;
  return {
    pollMs: 100,
    now: () => now,
    sleep: async (ms: number): Promise<void> => {
      now += ms;
      await new Promise(r => setTimeout(r, 1));
    },
    advance: (ms: number) => (now += ms),
  };
}

/** A runtime over one cloud workspace whose machine runs a scripted guest, with the road to that machine in the
 * test's hand. The preview route points at a port nothing listens on, so a reach probe fails as it does when the
 * edge cannot be reached; the provider goes on saying the machine runs, as the Box API did throughout. */
async function box(): Promise<{
  rt: Runtime;
  backend: StubBackend;
  clock: ReturnType<typeof turnClock>;
  guest: ReturnType<typeof scriptGuest>;
  events: EventUnion[];
  workspaceId: string;
  cut: (how?: () => Error) => void;
  restore: () => void;
  launches: () => number;
  probes: () => number;
}> {
  const backend = stubBackend();
  const plain = backend.execImpl;
  // The reach tracker's own probe into the guest, which answers while the machine is there and fails with the rest
  // of the road when it is not.
  const guest = scriptGuest(backend, [], (m, cmd) => (cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : plain(m, cmd)));
  const scripted = backend.execImpl;
  let down: (() => Error) | undefined;
  let launches = 0;
  let probes = 0;
  backend.execImpl = async (m, cmd): Promise<ExecResult> => {
    if (cmd.includes("WSP_LAUNCHED")) launches++;
    if (cmd === "echo ok") probes++;
    if (down !== undefined) throw down();
    return scripted(m, cmd);
  };
  const clock = turnClock();
  const rt = createRuntime({
    backend,
    store: memoryStore(),
    adapters: { claude: streamingAdapter },
    machineExec: clock,
    goneConfirmMs: 0,
    status: { costIntervalMs: 60_000, pollIntervalMs: 5, promptMs: 10, probeTimeoutMs: 500, zombieWindowMs: 80, zombieProbeTimeoutMs: 200 },
  });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e));
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:1/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
  return {
    rt,
    backend,
    clock,
    guest,
    events,
    workspaceId: ws.id,
    cut: (how = resolverError) => (down = how),
    restore: () => (down = undefined),
    launches: () => launches,
    probes: () => probes,
  };
}

describe("a link that drops under a running turn", () => {
  it("keeps the turn running while a dial fails twice on a resolver error, and delivers its finished line", async () => {
    const b = await box();
    // The launch is the dial: the first two never leave this computer, each costing twenty seconds to a name that
    // will not resolve, and the third lands. Together they run past the half minute one road used to be given.
    const endsSeen: number[] = [];
    const scripted = b.backend.execImpl;
    let failures = 0;
    b.backend.execImpl = async (m, cmd): Promise<ExecResult> => {
      if (cmd.includes("WSP_LAUNCHED") && failures < 2) {
        failures++;
        b.clock.advance(20_000);
        endsSeen.push(ends(b.events).length);
        throw resolverError();
      }
      return scripted(m, cmd);
    };
    b.guest.append("pong");
    b.guest.exit(0);
    const handle = await b.rt.sessions.start(b.workspaceId, { prompt: "one" });
    expect(await handle.finished).toMatchObject({ status: "completed", text: "pong" });
    expect(failures).toBe(2);
    expect(b.clock.now()).toBeGreaterThan(40_000);
    // Nothing had ended while the dial was still failing, and nothing ended for the road afterwards.
    expect(endsSeen).toEqual([0, 0]);
    expect(ends(b.events)).toHaveLength(1);
    expect(ends(b.events)[0]).toMatchObject({ exitCode: 0 });
    expect(ends(b.events)[0]!.reason).toBeUndefined();
    expect(dones(b.events)[0]!.result).toMatchObject({ status: "completed", text: "pong" });
  });

  it("reads the machine as not answering after three minutes dark, ends nothing, and delivers the finished line when the road is back", async () => {
    const b = await box();
    const handle = await b.rt.sessions.start(b.workspaceId, { prompt: "one" });
    await until(() => b.launches() === 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = b.rt.status.watch();
    try {
      // The edge refuses the reach probe from the first tick; while the guest itself answers, the window restarts
      // and nothing is a zombie. Then the road goes.
      await until(() => b.probes() >= 1);
      const darkFrom = b.clock.now();
      b.cut();
      // The row says what a person sees: the machine is not answering. Held until the row has said so and the turn's
      // own clock has run the three minutes measured on 2026-09-12, whichever comes second.
      const dark = (): boolean => b.clock.now() - darkFrom >= 3 * 60_000;
      await until(() => dark() && b.events.some(e => e.type === "workspace.status" && e.status.reach.state === "zombie"), 20_000);
      expect(ends(b.events)).toHaveLength(0);
      expect(handle.view().status).toBe("running");
      expect((await b.rt.workspaces.get(b.workspaceId)).phase).toBe("running");
      // The machine had the process the whole time; the road comes back and the turn's own line lands.
      b.guest.append("pong");
      b.guest.exit(0);
      b.restore();
      expect(await handle.finished).toMatchObject({ status: "completed", text: "pong" });
      expect(ends(b.events)).toHaveLength(1);
      expect(ends(b.events)[0]!.reason).toBeUndefined();
      // The run was launched once: nothing re-posted it, since the machine never lost it.
      expect(b.launches()).toBe(1);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it("ends the session with the process's own exit when the machine reports the process gone", async () => {
    const b = await box();
    const handle = await b.rt.sessions.start(b.workspaceId, { prompt: "one" });
    await until(() => b.launches() === 1);
    b.guest.append("half a reply");
    b.guest.exit(42);
    expect(await handle.finished).toMatchObject({ status: "failed", error: "agent exited with 42" });
    expect(ends(b.events)).toHaveLength(1);
    expect(ends(b.events)[0]).toMatchObject({ exitCode: 42, sawResult: true });
    expect(ends(b.events)[0]!.reason).toBeUndefined();
  });

  it("ends the sessions of a machine the provider no longer holds", async () => {
    const b = await box();
    const handle = await b.rt.sessions.start(b.workspaceId, { prompt: "one" });
    await until(() => b.launches() === 1);
    b.backend.machines[0]!.killed = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = b.rt.status.watch();
    try {
      await until(() => ends(b.events).length > 0, 5_000);
      expect(ends(b.events)[0]).toMatchObject({ workspaceId: b.workspaceId, reason: GONE });
      expect(handle.view().status).toBe("failed");
      expect((await b.rt.workspaces.get(b.workspaceId)).phase).toBe("gone");
      expect(await b.backend.machines[0]!.state()).toBe("gone" satisfies MachineState);
    } finally {
      stop();
      warn.mockRestore();
    }
  });
});
