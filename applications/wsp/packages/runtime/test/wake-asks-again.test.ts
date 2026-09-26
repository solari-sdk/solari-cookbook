// SPDX-License-Identifier: AGPL-3.0-only
// A wake the provider never takes: the backend gives its resume up as unanswered
// and the row says so, the host asks again on its own once a cadence, the person
// can stop it from the row, and a resume the provider finally takes ends the
// wake with the machine running. The provider here is a backend whose resume
// ends unanswered every time, which is what Solari's did for every paused
// machine on the account on 2026-09-10.
import { describe, expect, it, vi } from "vitest";
import { RESUME_CAP_MS, ResumeUnansweredError, SOLARI_LIFECYCLE } from "@wsp/engine";
import { needsRebuild, RESUME_UNANSWERED, WAKE_STOPPED, wakeAskingAgainLine, wakeAsksIn, wakeGaveUpLine, type EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { createRuntime, type RuntimeOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { abortedCall, stubBackend, type StubMachine, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";

/** The cadence between asks, shaped like the shipped one and short enough to count in whole ticks. The cap and the
 * read after it are the backend's own, so the fake provider is the one that ends a call, when the test says so. */
const EVERY = 60;
/** The head of the line a run that gave up ends with; the test steps the clock in whole cadences, so the span it
 * names is not exact. */
const GAVE_UP = /^the provider answered none of \d+ resume requests over /;

/** A runtime over a stub whose backend asks again at the cadence given, for as long as given; `asks: null` declares
 * no asking at all, so the host asks once and stops. Absent, the stub keeps the cloud provider's numbers. */
function rig(asks?: { everyMs?: number; forMs: number } | null) {
  const backend = stubBackend();
  if (asks === null) delete backend.lifecycle.budgets.resumeAsks;
  else if (asks !== undefined) backend.lifecycle.budgets.resumeAsks = { everyMs: asks.everyMs ?? EVERY, forMs: asks.forMs };
  const store = memoryStore();
  const fc = fakeClock();
  const rt = createRuntime({ backend, store, adapters: {}, clock: fc.clock });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e));
  const rows = (): WorkspaceStatus[] => events.filter(e => e.type === "workspace.status").map(e => (e.type === "workspace.status" ? e.status : null)!);
  return { backend, store, fc, rt, events, rows };
}

/** The provider as the probe found it: the resume is taken and never answered, until the backend's cap cuts it off
 * and its read still finds the machine paused, or the caller's own stop ends it. `cap()` ends whatever call is in
 * flight the way the backend ends one it gave up on, with the typed error; `takes` lets a later call land at once. */
function deafResume(machine: StubMachine) {
  const state = { calls: 0, takes: false, cap: () => {} };
  machine.resume = async (signal?: AbortSignal) => {
    state.calls++;
    if (state.takes) {
      machine.paused = false;
      return;
    }
    return new Promise<never>((_resolve, reject) => {
      state.cap = () => reject(new ResumeUnansweredError(RESUME_UNANSWERED));
      signal?.addEventListener("abort", () => reject(abortedCall(`resume of ${machine.id}`)), { once: true });
    });
  };
  return state;
}

/** Fires the cap on the call in flight and moves the clock a cadence, over and over until cond holds, so the test
 * never advances past a timer the runtime has not scheduled yet; fake time costs nothing, so a step taken early is
 * simply taken again. */
async function tick(fc: ReturnType<typeof fakeClock>, cap: () => void, cond: () => boolean, step = EVERY, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("the runtime did not get there in time");
    cap();
    await new Promise(r => setTimeout(r, 5));
    fc.advance(step);
    await new Promise(r => setTimeout(r, 5));
  }
}

/** When each resume was sent, on the runtime's own clock. */
function timesResumes(machine: StubMachine, now: () => number): number[] {
  const at: number[] = [];
  const resume = machine.resume.bind(machine);
  machine.resume = async signal => {
    at.push(now());
    return resume(signal);
  };
  return at;
}

/** The wake's outcome as a value, watched from the instant it starts so a rejection is never left unheld while the
 * test moves the clock; `ended` says when the clock has been moved far enough for the wake to be over. */
function watch(waking: Promise<unknown>): { outcome: Promise<string>; ended: () => boolean } {
  let over = false;
  const outcome = waking.then(() => "woke", (e: unknown) => (e instanceof Error ? e.message : String(e))).finally(() => { over = true; });
  return { outcome, ended: () => over };
}

describe("a wake the provider does not answer", () => {
  it("says the provider has not answered and that the machine is being read, as soon as the backend gives the resume up", async () => {
    const { backend, fc, rt, rows } = rig({ forMs: 2 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const began = fc.clock.now();
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      // The runtime holds no timer on the call: the backend's own end of it is what fires here, and the runtime's
      // clock has not moved, so the row speaks the moment the backend gives up and on nothing of the runtime's.
      deaf.cap();
      await until(() => rows().some(r => r.reason === RESUME_UNANSWERED));
      expect(fc.clock.now()).toBe(began);
      expect(rows().find(r => r.reason === RESUME_UNANSWERED)!.phase).toBe("waking");
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
      expect(deaf.calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks again on its own once a cadence, counting the asks on the row, and stops when the asking is spent", async () => {
    const { backend, fc, rt, rows } = rig({ forMs: 4 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
    } finally {
      warn.mockRestore();
    }
    // Four cadences of asking hold four asks: the person's, then three of the host's own, each counted on the row.
    expect(deaf.calls).toBe(4);
    // The numbers ride, so the row and the Machine tab each read them at the length they have room for.
    expect([...new Set(rows().map(r => r.wakeAsk).filter(a => a !== undefined).map(a => `${a.ask}/${a.of}`))]).toEqual(["1/4", "2/4", "3/4"]);
    expect(wakeAskingAgainLine(3, 4)).toBe("waking, asking again (3 of 4)");
    expect(wakeAskingAgainLine(3, 4, "short")).toBe("asking 3/4");
    // The row is a paused workspace again, with the provider's silence as its last word.
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(rows().at(-1)!.phase).toBe("napping");
    expect(rows().at(-1)!.reason).toMatch(GAVE_UP);
  });

  it("counts the cadence from when the ask began, so a cap that eats half of it does not push the next ask out", async () => {
    const { backend, fc, rt, rows } = rig({ forMs: 3 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const at = timesResumes(backend.machines[0]!, fc.clock.now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const began = fc.clock.now();
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      // The provider sits on the call for half the cadence and the cap cuts it off there, which is the shipped
      // half minute of a whole minute.
      fc.advance(EVERY / 2);
      deaf.cap();
      await until(() => rows().some(r => r.wakeAsk?.ask === 1));
      // What is left of the cadence is all the host waits: the minute runs from the ask, not from its cap.
      await until(() => fc.dueFor(began + EVERY));
      fc.advance(EVERY / 2);
      await until(() => deaf.calls === 2);
      expect(at.map(t => t - began)).toEqual([0, EVERY]);
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
    } finally {
      warn.mockRestore();
    }
    // Three cadences of asking hold three asks, each a cadence after the one before it began.
    expect(at.map(t => t - at[0]!)).toEqual([0, EVERY, 2 * EVERY]);
  });

  it("gives up half an hour after the first ask, having asked once a minute, with a cap that always fires", async () => {
    // The cloud provider's own asking, read off its declaration and not off a number of the runtime's.
    const { everyMs, forMs } = SOLARI_LIFECYCLE.budgets.resumeAsks!;
    const { backend, fc, rt } = rig({ everyMs, forMs });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const at = timesResumes(backend.machines[0]!, fc.clock.now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let ended;
    try {
      const began = fc.clock.now();
      const watched = watch(rt.workspaces.wake(ws.id));
      // One minute of wall time a turn, spent as the live road spends it: the provider takes the resume, answers
      // nothing for the half minute the engine's cap gives it, and the host has the rest of the minute to itself.
      for (let ask = 1; !watched.ended() && ask <= 2 * (forMs / everyMs); ask++) {
        await until(() => deaf.calls === ask);
        fc.advance(RESUME_CAP_MS);
        deaf.cap();
        await until(() => fc.dueFor(began + ask * everyMs) || watched.ended());
        fc.advance(everyMs - RESUME_CAP_MS);
      }
      ended = await watched.outcome;
    } finally {
      warn.mockRestore();
    }
    // Half an hour of asking at one ask a minute is thirty asks, the last of them starting a minute inside the half
    // hour; the old count of thirty asks each waiting out its own cap spanned three quarters of an hour.
    expect(deaf.calls).toBe(wakeAsksIn(forMs, everyMs));
    expect(deaf.calls).toBe(30);
    expect(at.map(t => (t - at[0]!) / everyMs)).toEqual([...Array(30).keys()]);
    expect(at.at(-1)! - at[0]!).toBeLessThan(forMs);
    // The line counts the asks made and the wall time they took, which is the last cap firing inside the half hour.
    expect(ended).toContain("none of 30 resume requests over 29m 30s");
  });

  it("reads before it asks again, sends no second resume at one that came up, and still checks the guest and ends first life", async () => {
    const { backend, fc, rt, store, rows } = rig({ forMs: 30 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    expect(await store.get("workspaces", ws.id)).toMatchObject({ firstLife: true });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    const deaf = deafResume(m);
    // The wake check reads the machine's shape; counting that read is how a wake that skipped the check is caught.
    let shapeReads = 0;
    const describe = m.describe!.bind(m);
    m.describe = async () => {
      shapeReads++;
      return describe();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let woken;
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      deaf.cap();
      await until(() => rows().some(r => r.wakeAsk?.ask === 1));
      // The call that hung at the provider goes through while the host waits out its cadence, as the probe measured
      // a pause doing: no answer in 30 s, the machine moved 40 s later.
      m.paused = false;
      await tick(fc, () => deaf.cap(), watched.ended);
      woken = await watched.outcome;
    } finally {
      warn.mockRestore();
    }
    expect(woken).toBe("woke");
    expect(deaf.calls).toBe(1);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    // The same road as a resume whose call answered: the guest was checked, and a machine that has been resumed is
    // out of first life, which is the fence the snapshot rule stands on.
    expect(shapeReads).toBe(1);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ firstLife: false });
  });

  it("leaves the rebuild road on the record when the asking runs out, and a wake that lands takes it away", async () => {
    const { backend, fc, rt, store, rows } = rig({ forMs: 3 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    const deaf = deafResume(m);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
    } finally {
      warn.mockRestore();
    }
    const left = await rt.workspaces.get(ws.id);
    // One ask of the person's and two of the host's, and the record keeps the whole sentence: what the provider did,
    // where the work is, and the road to a machine now.
    expect(left.wakeRefused).toContain("none of 3 resume requests");
    expect(left.wakeRefused).toContain("the work on this machine's disk stays with the provider");
    expect(left.wakeRefused).toContain("a rebuild starts a new machine from the image");
    expect(rows().at(-1)!.reason).toBe(left.wakeRefused);
    expect(rows().at(-1)!.wakeAsk).toBeUndefined();
    // The row offers the rebuild, which before this only a gone or zombie machine did, and the wake beside it.
    expect(needsRebuild({ phase: left.phase, machineState: "paused", reach: "napping", wakeRefused: left.wakeRefused })).toBe(true);
    expect(needsRebuild({ phase: left.phase, machineState: "paused", reach: "napping" })).toBe(false);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ wakeRefused: left.wakeRefused });
    // Every poll after it carries the road too: a row built from the record alone still offers the rebuild.
    expect((await rt.status.list())[0]).toMatchObject({ phase: "napping", reason: left.wakeRefused });
    // The provider comes back: the wake lands and the road goes with the fault that made it.
    m.resume = async () => { m.paused = false; };
    expect((await rt.workspaces.wake(ws.id)).wakeRefused).toBeUndefined();
    expect((await store.get("workspaces", ws.id) as { wakeRefused?: string }).wakeRefused).toBeUndefined();
    expect((await rt.status.list())[0]!.reason).toBeUndefined();
  });

  it("stops when the person stops it from the row, while the host waits to ask again", async () => {
    const { backend, fc, rt, store, rows } = rig({ forMs: 30 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const waking = rt.workspaces.wake(ws.id);
      await until(() => deaf.calls === 1);
      deaf.cap();
      await until(() => rows().some(r => r.wakeAsk?.ask === 1));
      const left = await rt.workspaces.stopWake(ws.id);
      expect(left.phase).toBe("napping");
      await expect(waking).rejects.toThrow(WAKE_STOPPED);
    } finally {
      warn.mockRestore();
    }
    expect(deaf.calls).toBe(1);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
    expect(rows().at(-1)).toMatchObject({ phase: "napping", reason: WAKE_STOPPED });
    // Nothing asks again after the stop: the cadence's timer is spent with no call behind it.
    fc.advance(EVERY * 5);
    await new Promise(r => setTimeout(r, 20));
    expect(deaf.calls).toBe(1);
  });

  it("stops while the host is on a call by ending it, and a cap that fires after says nothing on the paused row", async () => {
    const { backend, fc, rt, rows } = rig({ forMs: 30 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const waking = rt.workspaces.wake(ws.id);
    await until(() => deaf.calls === 1);
    // The call is nowhere near its cap; the stop is what ends it, so nothing goes on running behind the wake.
    await rt.workspaces.stopWake(ws.id);
    await expect(waking).rejects.toThrow(WAKE_STOPPED);
    expect(deaf.calls).toBe(1);
    expect(rows().at(-1)).toMatchObject({ phase: "napping", reason: WAKE_STOPPED });
    // The provider's cap fires on the call the stop already ended, and the whole cadence passes: a settled stop wins,
    // so no poll of a paused row ever says the machine is being read about.
    deaf.cap();
    fc.advance(EVERY * 3);
    await new Promise(r => setTimeout(r, 20));
    expect(rows().at(-1)).toMatchObject({ phase: "napping", reason: WAKE_STOPPED });
    const polled = (await rt.status.list())[0]!;
    expect(polled.phase).toBe("napping");
    expect([polled.reason, polled.wakeAsk]).toEqual([undefined, undefined]);
    expect(deaf.calls).toBe(1);
  });

  it("a resume the provider finally takes ends the wake with the machine running, however many asks it took", async () => {
    const { backend, fc, rt, events } = rig({ forMs: 30 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let woken;
    try {
      const waking = rt.workspaces.wake(ws.id);
      await until(() => deaf.calls === 1);
      deaf.takes = true;
      await tick(fc, () => deaf.cap(), () => deaf.calls === 2);
      woken = await waking;
    } finally {
      warn.mockRestore();
    }
    expect(woken.phase).toBe("running");
    expect(deaf.calls).toBe(2);
    expect(events.filter(e => e.type === "workspace.woken").map(e => e.type === "workspace.woken" && e.workspaceId)).toEqual([ws.id]);
  });

  it("keeps the line on every status the poll builds, so the row does not fall silent between two asks", async () => {
    const { backend, fc, rt } = rig({ forMs: 30 * EVERY });
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      deaf.cap();
      await until(async () => (await rt.status.list()).some(r => r.wakeAsk?.ask === 1));
      // A poll builds its rows from the record alone, so this is the row a client that missed the push would draw.
      expect((await rt.status.list())[0]).toMatchObject({ phase: "waking", wakeAsk: { ask: 1, of: 30 } });
      await rt.workspaces.stopWake(ws.id);
      await watched.outcome;
      // The wake is over, so the ask goes with it and the row keeps only what the poll can see for itself.
      expect((await rt.status.list())[0]!.wakeAsk).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("a stop asked of a workspace with no wake in flight answers with the record as it stands", async () => {
    const { rt } = rig();
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    expect((await rt.workspaces.stopWake(ws.id)).phase).toBe("running");
  });

  it("a backend that declares no asking is asked once: no second resume, and the gave-up line counts one", async () => {
    const { backend, fc, rt, rows } = rig(null);
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      deaf.cap();
      expect(await watched.outcome).toMatch(/^the provider answered none of 1 resume request over /);
    } finally {
      warn.mockRestore();
    }
    // Every ask that reaches a provider that bills starts is a start: a backend that says so is never asked twice.
    fc.advance(EVERY * 5);
    await new Promise(r => setTimeout(r, 20));
    expect(deaf.calls).toBe(1);
    expect(rows().some(r => r.wakeAsk !== undefined)).toBe(false);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
  });
});
