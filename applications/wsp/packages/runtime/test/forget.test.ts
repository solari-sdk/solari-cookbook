// SPDX-License-Identifier: AGPL-3.0-only
// Forgetting, on both objects. A workspace whose machine the provider no longer has: the record,
// its transcripts and its sessions leave the store and workspace.deleted
// follows, with nothing asked of the machine; a workspace whose machine any read still
// finds is refused with the reason and kept whole. A thread: a launch refused
// before the agent started writes no row anywhere, and a thread left standing
// with no turn that ever did work is dropped, a turn the agent refused outright
// among them, while one whose turn worked is refused in one sentence.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexNotSignedInLine, foldThreads, forgetUndrivenRefusal, HERE_PLACE_ID, THIS_COMPUTER, signInRefusalLine, threadForgetRefusal, type EventUnion, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { answersGoneOnce, fakeLocal, stubBackend, createOn, projectOn } from "./stub-backend.js";

describe("workspaces.forget", () => {
  it("drops a workspace whose machine is gone: record, transcripts and sessions leave the store and workspace.deleted follows", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "first" });
    await store.put("transcripts", ws.id, { events: [{ type: "session.start", sessionId: "s1" }] });
    await store.put("sessions", ws.id, { rows: [{ id: "s1", workspaceId: ws.id, harness: "claude", status: "completed" }] });
    backend.machines[0]!.killed = true;

    await rt.workspaces.forget(ws.id);

    expect(await rt.workspaces.list()).toEqual([]);
    await expect(rt.workspaces.get(ws.id)).rejects.toThrow(`no such workspace: ${ws.id}`);
    expect(await store.get("workspaces", ws.id)).toBeUndefined();
    expect(await store.get("transcripts", ws.id)).toBeUndefined();
    expect(await store.get("sessions", ws.id)).toBeUndefined();
    expect(events.filter(e => e.type === "workspace.deleted")).toMatchObject([{ type: "workspace.deleted", workspaceId: ws.id }]);
  });

  it("sends a workspace on a computer wsp does not run to delete: its machine is never gone and there is no provider to pause it at", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, local: fakeLocal(mkdtempSync(join(tmpdir(), "wsp-forget-"))) });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });

    await expect(rt.workspaces.forget(ws.id)).rejects.toMatchObject({ message: forgetUndrivenRefusal("mac", THIS_COMPUTER), kind: "conflict" });

    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    await rt.close();
  });

  it("refuses a workspace whose machine still exists, running or paused, with the reason, and keeps everything", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "live" });

    await expect(rt.workspaces.forget(ws.id)).rejects.toMatchObject({
      message: "live's machine m1 is still running; pause it or delete it at the provider first",
      kind: "conflict",
    });
    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.forget(ws.id)).rejects.toThrow("live's machine m1 is still paused; pause it or delete it at the provider first");

    expect(backend.machines[0]!.killed).toBe(false);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ id: ws.id, phase: "napping" });
  });

  it("refuses a workspace one gateway copy answers 404 for while the other still runs its machine, and keeps everything", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "split" });
    answersGoneOnce(backend, backend.machines[0]!);

    await expect(rt.workspaces.forget(ws.id)).rejects.toMatchObject({ message: "split's machine m1 is still running; pause it or delete it at the provider first", kind: "conflict" });

    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ id: ws.id });
  });
});

/** A harness that dies before it announces a session: only a done and an end, under its own local id. This is the
 * launch that leaves a failed row nobody can read anything off. */
const dying: HarnessAdapterFactory = () => ({
  steers: false,
  start: o => {
    const localId = randomUUID();
    const result: TurnResult = { status: "failed", error: "claude exited with code 1 before emitting a result" };
    const finished = Promise.resolve().then(() => {
      o.onEvent({ type: "turn.done", sessionId: localId, result });
      o.onEvent({ type: "session.end", sessionId: localId, exitCode: 1, sawResult: false });
      return result;
    });
    return { localId, finished, interrupt: async () => {} };
  },
});

/** A harness that announces its session and replies: a turn that ran. */
const working: HarnessAdapterFactory = () => ({
  steers: false,
  start: o => {
    const sessionId = randomUUID();
    const result: TurnResult = { status: "completed", text: "all green" };
    const finished = Promise.resolve().then(() => {
      o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
      o.onEvent({ type: "turn.done", sessionId, result });
      o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    });
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

describe("a launch refused before the agent started", () => {
  it("records no thread at all: no row in the listing, none in the store, and nothing in the transcript", async () => {
    const refusing: HarnessAdapterFactory = () => ({
      steers: false,
      start: () => {
        throw new Error("the harness would not launch");
      },
    });
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: refusing } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });

    await expect(rt.sessions.start(ws.id, { prompt: "build it" })).rejects.toThrow("the harness would not launch");
    // Named again, as the person who tried twice did: a second refusal is a second nothing, not a second row.
    await expect(rt.sessions.start(ws.id, { prompt: "build it" })).rejects.toThrow("the harness would not launch");

    expect(await rt.sessions.list(ws.id)).toEqual([]);
    expect(foldThreads(await rt.sessions.list(ws.id))).toEqual([]);
    expect(await rt.sessions.history(ws.id)).toEqual([]);
    await rt.close();
    expect(await store.get("sessions", ws.id)).toBeUndefined();
  });

  it("is refused before the machine is asked when no adapter here runs that agent, and leaves nothing either", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });

    await expect(rt.sessions.start(ws.id, { prompt: "build it", harness: "gemini" })).rejects.toThrow(/no adapter registered for harness "gemini"/);

    expect(await rt.sessions.list(ws.id)).toEqual([]);
    expect(await rt.sessions.history(ws.id)).toEqual([]);
    await rt.close();
  });
});

describe("sessions.forget", () => {
  it("drops a thread no turn ever ran on: its row and its transcript rows go, the thread beside it is untouched, and nothing is asked of the machine", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: working, codex: dying } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const ran = await rt.sessions.start(ws.id, { prompt: "build it" });
    await ran.finished;
    const junk = await rt.sessions.start(ws.id, { prompt: "build it", harness: "codex" });
    await junk.finished.catch(() => {});
    const kept = ran.view().threadId!;
    const going = junk.view().threadId!;
    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => ({ id: t.id, status: t.status, ran: t.ran }))).toEqual([
      { id: kept, status: "completed", ran: true },
      { id: going, status: "failed", ran: false },
    ]);

    await rt.sessions.forget(going);

    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => t.id)).toEqual([kept]);
    expect(new Set((await rt.sessions.history(ws.id)).map(e => e.threadId))).toEqual(new Set([kept]));
    expect(backend.machines[0]!.execLog.join("\n")).not.toContain(going);
    await rt.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: { threadId?: string }[] };
    expect(stored.sessions.map(s => s.threadId)).toEqual([kept]);
    const transcript = (await store.get("transcripts", ws.id)) as { events: { threadId?: string }[] };
    expect(transcript.events.every(e => e.threadId === kept)).toBe(true);
  });

  it("refuses a thread whose turn did work, in one sentence, and keeps its row and its transcript whole", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "build it" });
    await handle.finished;
    const thread = handle.view().threadId!;

    await expect(rt.sessions.forget(thread)).rejects.toMatchObject({ message: threadForgetRefusal(thread), kind: "conflict" });

    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => t.id)).toEqual([thread]);
    expect((await rt.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done", "session.end"]);
    // A name this runtime holds nothing by, the same shape a workspace name nothing holds has: a value nothing takes.
    await expect(rt.sessions.forget("thr_nobody")).rejects.toMatchObject({ message: "no thread thr_nobo", kind: "not-found" });
    await rt.close();
  });

  it("refuses a thread whose rows fell off the index cap while its record stands, and leaves its transcript whole", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "build it" });
    await handle.finished;
    const thread = handle.view().threadId!;
    await rt.close();
    // The state the cap leaves: the index holds no row of the thread, while the workspace's document keeps the
    // thread's record and the transcript keeps its events. The rows are dropped here the way the cap drops them.
    const doc = (await store.get("sessions", ws.id)) as { sessions: unknown[] };
    await store.put("sessions", ws.id, { ...doc, sessions: [] });
    const after = createRuntime({ backend, store, adapters: { claude: working } });
    expect(await after.sessions.list(ws.id)).toEqual([]);

    // The record is written once a turn was handed over, so a thread with a record and no row is one that ran: the
    // forget is refused in the one sentence, as it is for a thread whose row still says so.
    await expect(after.sessions.forget(thread)).rejects.toMatchObject({ message: threadForgetRefusal(thread), kind: "conflict" });

    expect((await after.sessions.history(ws.id)).map(e => [e.threadId, e.type])).toEqual([[thread, "session.start"], [thread, "session.done"], [thread, "session.end"]]);
    await after.close();
    const transcript = (await store.get("transcripts", ws.id)) as { events: unknown[] };
    expect(transcript.events).toHaveLength(3);
  });
});

/** Each CLI's own announce-then-refuse sequence, in the shapes its adapter's tests pin: both announce their session
 * before they can know the machine has no sign-in, then fail the turn with the cause and no work behind it. */
const refusingSignIn = (sequence: { exitCode: number; sawResult: boolean; error: string }): HarnessAdapterFactory => () => ({
  steers: false,
  start: o => {
    const sessionId = randomUUID();
    const result: TurnResult = { status: "failed", refusal: "sign-in", error: sequence.error };
    const finished = Promise.resolve().then(() => {
      o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
      o.onEvent({ type: "turn.done", sessionId, result });
      o.onEvent({ type: "session.end", sessionId, exitCode: sequence.exitCode, sawResult: sequence.sawResult });
      return result;
    });
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

describe("a turn the agent refused for want of a sign-in", () => {
  // Claude Code writes its init line, then its own refusal as an api error message, then a result flagged in error;
  // codex announces thread.started, retries the 401 and dies at 101 with no turn event. Announcing is what both do
  // first, so it says nothing about whether the turn worked.
  const CLAUDE = { exitCode: 1, sawResult: true, error: `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}` };
  const CODEX = { exitCode: 101, sawResult: false, error: codexNotSignedInLine("codex login --device-auth") };

  it("is a thread that ran nothing on either agent, whatever the row's session id says, and the forget takes it", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: refusingSignIn(CLAUDE), codex: refusingSignIn(CODEX) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "ship it" });
    await first.finished.catch(() => {});
    const second = await rt.sessions.start(ws.id, { prompt: "ship it", harness: "codex" });
    await second.finished.catch(() => {});

    const rows = await rt.sessions.list(ws.id);
    // The session id is on both rows: the announce landed, which is exactly why it cannot be the rule.
    expect(rows.map(r => [r.harness, r.status, r.claudeSessionId !== undefined, r.refusal])).toEqual([
      ["claude", "failed", true, "sign-in"],
      ["codex", "failed", true, "sign-in"],
    ]);
    expect(foldThreads(rows).map(t => t.ran)).toEqual([false, false]);

    for (const thread of foldThreads(rows).map(t => t.id)) await rt.sessions.forget(thread);

    expect(await rt.sessions.list(ws.id)).toEqual([]);
    expect(await rt.sessions.history(ws.id)).toEqual([]);
    await rt.close();
    expect(((await store.get("sessions", ws.id)) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("still refuses the forget once the person signed in and the thread's next turn did work", async () => {
    let signedIn = false;
    const refusesUntilSignedIn: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const sessionId = o.resume ?? randomUUID();
        const result: TurnResult = signedIn ? { status: "completed", text: "all green" } : { status: "failed", refusal: "sign-in", error: CLAUDE.error };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
          if (signedIn) o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: "all green" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: signedIn ? 0 : CLAUDE.exitCode, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: refusesUntilSignedIn } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const refused = await rt.sessions.start(ws.id, { prompt: "ship it" });
    await refused.finished.catch(() => {});
    const thread = refused.view().threadId!;
    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => t.ran)).toEqual([false]);

    signedIn = true;
    await (await rt.sessions.start(ws.id, { prompt: "ship it", thread })).finished;

    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => t.ran)).toEqual([true]);
    await expect(rt.sessions.forget(thread)).rejects.toMatchObject({ message: threadForgetRefusal(thread), kind: "conflict" });
    await rt.close();
  });
});
