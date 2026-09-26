// SPDX-License-Identifier: AGPL-3.0-only
// Event replay over the socket: a client that lost its socket resubscribes
// with the last sequence it saw and gets what it missed, in order, once. The
// runtime runs on a fake clock and the waits below are driven by the socket's
// own frames, so nothing here reads the wall clock.
import { afterEach, describe, expect, it } from "vitest";
import type { TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { WsClient, type WireMsg, createOverWire } from "./ws-client.js";
import { stubBackend } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { until } from "./until.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

/** A harness the test drives by hand: each delta() is one session.delta on the wire, so a test can push the runtime
 * far past its retention without a machine or a clock. */
function drivenHarness() {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  let onEvent: HarnessStartOptions["onEvent"] | undefined;
  let finish!: (r: TurnResult) => void;
  const finished = new Promise<TurnResult>(r => (finish = r));
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      onEvent = o.onEvent;
      onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return {
    adapter,
    sessionId,
    delta: (text: string): void => onEvent!({ type: "turn.delta", sessionId, kind: "text", text }),
    end: (): void => {
      onEvent!({ type: "turn.done", sessionId, result: { status: "completed" } });
      onEvent!({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      finish({ status: "completed" });
    },
  };
}

/** Settles once the client holds n events, woken by the socket's own frames. */
function received(c: WsClient, n: number): Promise<WireMsg[]> {
  return new Promise(resolve => {
    const check = (): void => {
      if (c.events.length < n) return;
      c.ws.off("message", check);
      resolve([...c.events]);
    };
    c.ws.on("message", check);
    check();
  });
}

const seqs = (events: WireMsg[]): number[] => events.map(e => e["seq"] as number);
const texts = (events: WireMsg[]): string[] => events.map(e => e["text"] as string);

/** A runtime with one project, one workspace of it and one running session: project.added is seq 1, the create's
 * stages are seq 2 to 5 (the project's clone is one of them), workspace.created is seq 6, the cost tick the create
 * lands (the meter's first point, at the machine's rate) is seq 7, session.start is seq 8, and the preferences
 * record moving to name that workspace as the last target is seq 9. */
async function boot() {
  const h = drivenHarness();
  const fc = fakeClock();
  const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fc.clock });
  srv = await serveRuntime(runtime, { port: 0, authToken: "secret", now: fc.clock.now });
  const c = await WsClient.connect(srv.port, { token: "secret" });
  const created = await createOverWire(c, "x", { golden: "snap_g" });
  const workspaceId = (created["workspace"] as { id: string }).id;
  await c.request("sessions.start", { workspaceId, prompt: "go" });
  return { h, runtime, workspaceId, c, port: srv.port };
}

describe("events.subscribe replay", () => {
  it("a fresh subscribe without a cursor behaves as today: nothing replayed, live events flow, each stamped once per runtime", async () => {
    const { h, c, port } = await boot();
    h.delta("before");
    const sub = await c.request("events.subscribe");
    expect(sub).toEqual({ id: sub.id, ok: true, seq: 10, stream: expect.any(String) });

    const other = await WsClient.connect(port, { token: "secret" });
    expect((await other.request("events.subscribe"))["seq"]).toBe(10);

    h.delta("live");
    const [mine, theirs] = await Promise.all([received(c, 1), received(other, 1)]);
    expect(mine).toEqual([expect.objectContaining({ type: "session.delta", text: "live", seq: 11 })]);
    expect(theirs).toEqual(mine);
    c.close();
    other.close();
  });

  it("events emitted between a close and a re-subscribe arrive once and in order, then live continues", async () => {
    const { h, c, port } = await boot();
    await c.request("events.subscribe");
    h.delta("a");
    h.delta("b");
    const seen = await received(c, 2);
    expect(seqs(seen)).toEqual([10, 11]);
    const cursor = seen[seen.length - 1]!["seq"] as number;
    c.close();
    await c.closed();

    h.delta("dark 1");
    h.delta("dark 2");
    h.delta("dark 3");

    const back = await WsClient.connect(port, { token: "secret" });
    const sub = await back.request("events.subscribe", { after: cursor });
    expect(sub).toEqual({ id: sub.id, ok: true, seq: 14, stream: expect.any(String) });
    h.delta("live");
    const got = await received(back, 4);
    expect(texts(got)).toEqual(["dark 1", "dark 2", "dark 3", "live"]);
    expect(seqs(got)).toEqual([12, 13, 14, 15]);
    back.close();
  });

  it("an in-ring cursor replays exactly the events after it, whether or not that socket ever saw them", async () => {
    const { h, port } = await boot();
    for (const t of ["1", "2", "3", "4", "5", "6"]) h.delta(t);
    const late = await WsClient.connect(port, { token: "secret" });
    const sub = await late.request("events.subscribe", { after: 12 });
    expect(sub).toEqual({ id: sub.id, ok: true, seq: 15, stream: expect.any(String) });
    h.delta("live");
    const got = await received(late, 4);
    expect(seqs(got)).toEqual([13, 14, 15, 16]);
    expect(texts(got)).toEqual(["4", "5", "6", "live"]);

    const caughtUp = await WsClient.connect(port, { token: "secret" });
    expect(await caughtUp.request("events.subscribe", { after: 16 })).toEqual({ id: expect.any(Number), ok: true, seq: 16, stream: expect.any(String) });
    h.delta("only this");
    expect(texts(await received(caughtUp, 1))).toEqual(["only this"]);
    late.close();
    caughtUp.close();
  });

  it("a cursor older than the ring gets gap and no replay; sessions.history is the refetch and holds the turn", async () => {
    const { h, workspaceId, port } = await boot();
    // 5000 deltas after project.added (1), the create's stages and workspace.created (2 to 6), the create's cost
    // tick (7), session.start (8) and the record's target (9): the ring keeps 10..5009 and drops the first nine.
    for (let i = 1; i <= 5000; i++) h.delta(`d${i}`);

    const stale = await WsClient.connect(port, { token: "secret" });
    const sub = await stale.request("events.subscribe", { after: 1 });
    expect(sub).toEqual({ id: sub.id, ok: true, seq: 5009, gap: true, stream: expect.any(String) });
    h.delta("live");
    const got = await received(stale, 1);
    expect(got).toEqual([expect.objectContaining({ text: "live", seq: 5010 })]);

    // The transcript is capped at the same 5000, so it too starts past the first events; its tail is the truth the chat needs.
    const history = (await stale.request("sessions.history", { workspaceId }))["events"] as { type: string; text?: string }[];
    expect(history).toHaveLength(5000);
    expect(history[history.length - 1]).toMatchObject({ type: "session.delta", text: "live" });
    stale.close();

    // "live" made 5010 the head, so the ring now holds 11..5010: cursor 10 is the oldest that replays, 9 is a gap.
    const edge = await WsClient.connect(port, { token: "secret" });
    expect((await edge.request("events.subscribe", { after: 10 }))["gap"]).toBeUndefined();
    const all = await received(edge, 5000);
    expect(seqs(all)[0]).toBe(11);
    expect(seqs(all)[4999]).toBe(5010);
    edge.close();
    const out = await WsClient.connect(port, { token: "secret" });
    expect(await out.request("events.subscribe", { after: 9 })).toMatchObject({ ok: true, seq: 5010, gap: true });
    out.close();
  });

  it("a cursor past head is a gap too: that is what a cursor from a runtime that restarted looks like", async () => {
    const { h, port } = await boot();
    const c = await WsClient.connect(port, { token: "secret" });
    const sub = await c.request("events.subscribe", { after: 90 });
    expect(sub).toEqual({ id: sub.id, ok: true, seq: 9, gap: true, stream: expect.any(String) });
    h.delta("live");
    expect(seqs(await received(c, 1))).toEqual([10]);
    c.close();
  });

  it("runtime restarts between the drop and the re-subscribe: a cursor from the old stream is a gap, nothing of the new stream is replayed", async () => {
    const store = memoryStore();
    const first = drivenHarness();
    const fc = fakeClock();
    const rtA = createRuntime({ backend: stubBackend(), store, adapters: { claude: first.adapter }, clock: fc.clock });
    srv = await serveRuntime(rtA, { port: 0, authToken: "secret", now: fc.clock.now });
    const port = srv.port;
    const c = await WsClient.connect(port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    await c.request("sessions.start", { workspaceId, prompt: "go" });
    const subA = await c.request("events.subscribe");
    const streamA = subA["stream"] as string;
    first.delta("old 1");
    const seen = await received(c, 1);
    const cursor = seen[0]!["seq"] as number;
    expect([streamA, cursor]).toEqual([expect.any(String), 10]);
    await srv.close();
    await c.closed();

    // The new process over the same store issues sequences from 1 again (its first is the end it writes for the turn
    // the restart cut) and soon passes the old cursor.
    const second = drivenHarness();
    const rtB = createRuntime({ backend: stubBackend(), store, adapters: { claude: second.adapter }, clock: fc.clock });
    // The new backend never heard of the first machine: the host confirms it gone once it serves, and the gone
    // event, its row and its cost tick take three sequences before anything else.
    await until(async () => (await rtB.workspaces.get(workspaceId)).phase === "gone");
    srv = await serveRuntime(rtB, { port, authToken: "secret", now: fc.clock.now });
    const back = await WsClient.connect(port, { token: "secret" });
    const again = await createOverWire(back, "y", { golden: "snap_g" });
    await back.request("sessions.start", { workspaceId: (again["workspace"] as { id: string }).id, prompt: "go" });
    for (const t of ["new 1", "new 2", "new 3"]) second.delta(t);

    const subB = await back.request("events.subscribe", { after: cursor, stream: streamA });
    expect(subB).toEqual({ id: subB.id, ok: true, seq: 16, gap: true, stream: expect.any(String) });
    expect(subB["stream"]).not.toBe(streamA);
    second.delta("live");
    const got = await received(back, 1);
    expect(texts(got)).toEqual(["live"]);
    expect(seqs(got)).toEqual([17]);
    // Without the stream the same cursor would have replayed 9 to 11 of a stream this client never saw.
    const naive = await WsClient.connect(port, { token: "secret" });
    expect(await naive.request("events.subscribe", { after: cursor })).toEqual({ id: expect.any(Number), ok: true, seq: 17, stream: subB["stream"] });
    expect(texts((await received(naive, 7)).slice(3))).toEqual(["new 1", "new 2", "new 3", "live"]);
    back.close();
    naive.close();
  });

  it("the transcript on disk never carries a sequence: it belongs to the process, not the record", async () => {
    const { h, runtime, workspaceId, c } = await boot();
    h.delta("x");
    h.end();
    c.close();
    const history = await runtime.sessions.history(workspaceId);
    expect(history).toHaveLength(4);
    for (const e of history) expect(e).not.toHaveProperty("seq");
  });
});
