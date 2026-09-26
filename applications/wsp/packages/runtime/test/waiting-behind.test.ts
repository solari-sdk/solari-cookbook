// SPDX-License-Identifier: AGPL-3.0-only
// Two threads where one is waiting on the other: the caller's own call is a
// wsp send that cannot answer until the thread it names is done, and that
// thread is stopped on a question. The runtime holds both facts, so the
// caller's row says it is waiting on the person and carries the question, and
// one answer ends both waits. Beside it, what a settled turn reports as worked:
// the minutes it stood on a question are the person's, not the turn's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_ALLOW, PERMISSION_DENY, foldThreads, threadWordOf, turnSettledParts, waitingLine, type PermissionAsk, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type Runtime, type SessionHandle } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";

const ASK: PermissionAsk = {
  askId: "ask_1",
  toolName: "Read",
  toolUseId: "toolu_read",
  input: '{"file_path":"/root/hello.txt"}',
  detail: "hello.txt",
  options: [
    { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
    { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
  ],
};

/** What a running fake turn lets a test do to it: write a tool call, answer it, raise a prompt and reply. */
interface Turn {
  calls: (toolUseId: string, toolName: string, input: string) => void;
  answers: (toolUseId: string) => void;
  raise: (ask?: Partial<PermissionAsk>) => void;
  reply: (result?: Partial<TurnResult>) => void;
}

/** An adapter whose every turn is driven by the test, on a session id of its own so two threads never share a row. */
function drivenAdapter(turns: Turn[]): HarnessAdapterFactory {
  let opened = 0;
  return () => ({
    steers: false,
    start: ({ onEvent }) => {
      const sessionId = `11111111-1111-4111-8111-${String(++opened).padStart(12, "0")}`;
      const open = new Map<string, PermissionAsk>();
      let settle: ((result: TurnResult) => void) | undefined;
      const finished = new Promise<TurnResult>(resolve => {
        settle = result => {
          for (const askId of [...open.keys()]) {
            open.delete(askId);
            onEvent({ type: "permission.close", sessionId, askId, outcome: "cancelled" });
          }
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      onEvent({ type: "session.start", sessionId, cwd: "/root" });
      turns.push({
        calls: (toolUseId, toolName, input) => onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: input, toolName, toolUseId }),
        answers: toolUseId => onEvent({ type: "turn.delta", sessionId, kind: "tool_result", text: "ok", toolUseId }),
        raise: overrides => {
          const ask = { ...ASK, ...overrides };
          open.set(ask.askId, ask);
          onEvent({ type: "permission.ask", sessionId, ask });
        },
        reply: result => settle?.({ status: "completed", text: "done", ...result }),
      });
      return {
        localId: sessionId,
        finished,
        interrupt: async () => settle?.({ status: "interrupted" }),
        answer: async (askId, o) => {
          if (!open.delete(askId)) return "gone";
          onEvent({ type: "permission.close", sessionId, askId, outcome: o.outcome, optionId: o.optionId });
          return "answered";
        },
      };
    },
  });
}

describe("a thread waiting on another thread's turn", () => {
  let store: Store;
  let turns: Turn[];
  let rt: Runtime;
  let wait: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    store = memoryStore();
    turns = [];
    wait = fakeClock();
    rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: drivenAdapter(turns) }, clock: wait.clock });
  });
  afterEach(async () => {
    await rt.close();
  });

  /** The two threads of the story: the one that sends, and the one it sends to. */
  const pair = async (): Promise<{ workspaceId: string; caller: SessionHandle; target: SessionHandle }> => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const caller = await rt.sessions.start(ws.id, { prompt: "ask the other one" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const target = await rt.sessions.start(ws.id, { prompt: "read the file" });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    return { workspaceId: ws.id, caller, target };
  };

  const threadOf = async (workspaceId: string, handle: SessionHandle) =>
    foldThreads(await rt.sessions.list(workspaceId)).find(t => t.threadId === handle.view().threadId)!;

  it("reads as waiting on the person, carries the other thread's question, and one answer ends both waits", async () => {
    const { workspaceId, caller, target } = await pair();
    const targetThread = target.view().threadId!;

    // The caller's agent calls send and the call is still running; nothing has asked anybody anything yet.
    turns[0]!.calls("toolu_send", "mcp__wsp__send", JSON.stringify({ thread: targetThread, message: "read hello.txt" }));
    expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Working");

    // The thread it sent to stops on a question. Nothing on the caller's own row changed, and the caller is stuck.
    turns[1]!.raise();
    await vi.waitFor(async () => expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Needs you"));
    const behind = (await threadOf(workspaceId, caller)).waitingOn!;
    expect(behind).toMatchObject({ threadId: targetThread, workspaceId, title: "read the file", prompt: { askId: "ask_1", toolName: "Read" } });
    expect(behind.prompt.options.map(o => o.id)).toEqual([PERMISSION_ALLOW, PERMISSION_DENY]);
    // The caller was asked nothing of its own; the line it shows is the other thread's question.
    expect((await threadOf(workspaceId, caller)).asking).toBeUndefined();
    expect(waitingLine(await threadOf(workspaceId, caller))).toBe("Permission for Read: hello.txt needs an answer");

    // The prompt is answered off the caller's row, which is where the person is reading: the session it names is
    // the other thread's turn, so one click ends the wait on both.
    expect(await rt.sessions.answer(behind.sessionId, { askId: behind.prompt.askId, optionId: PERMISSION_ALLOW })).toEqual({ outcome: "answered" });
    await vi.waitFor(async () => expect(threadWordOf(await threadOf(workspaceId, target))).toBe("Working"));
    expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Working");
    expect(await threadOf(workspaceId, caller)).not.toHaveProperty("waitingOn");

    turns[1]!.reply();
    turns[0]!.answers("toolu_send");
    turns[0]!.reply();
    await Promise.all([caller.finished, target.finished]);
  });

  it("follows only a call that waits for the other thread: a detached send answers at once and is behind nobody", async () => {
    const { workspaceId, caller, target } = await pair();
    turns[0]!.calls("toolu_send", "mcp__wsp__send", JSON.stringify({ thread: target.view().threadId, message: "go", detach: true }));
    turns[1]!.raise();
    await vi.waitFor(async () => expect(threadWordOf(await threadOf(workspaceId, target))).toBe("Needs you"));
    expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Working");

    // A call of the agent's own, into no thread at all, is no wait either.
    turns[0]!.calls("toolu_read", "Read", JSON.stringify({ file_path: "/root/notes.md" }));
    expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Working");

    turns[1]!.reply();
    turns[0]!.reply();
    await Promise.all([caller.finished, target.finished]);
  });

  it("drops the wait when the call the thread was inside answers, whatever the other thread is still doing", async () => {
    const { workspaceId, caller, target } = await pair();
    turns[0]!.calls("toolu_wait", "mcp__wsp__threads_wait", JSON.stringify({ threads: [target.view().threadId], timeout: 60 }));
    turns[1]!.raise();
    await vi.waitFor(async () => expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Needs you"));

    // The wait gave up on its deadline while the question still stands: the caller is working again, and the thread
    // that was asked still is not.
    turns[0]!.answers("toolu_wait");
    await vi.waitFor(async () => expect(threadWordOf(await threadOf(workspaceId, caller))).toBe("Working"));
    expect(threadWordOf(await threadOf(workspaceId, target))).toBe("Needs you");

    turns[1]!.reply();
    turns[0]!.reply();
    await Promise.all([caller.finished, target.finished]);
  });
});

describe("what a settled turn reports as worked", () => {
  it("takes off the minutes it stood on a question, and says where they went when they are most of it", async () => {
    const store = memoryStore();
    const wait = fakeClock();
    const turns: Turn[] = [];
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: drivenAdapter(turns) }, clock: wait.clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "read the file" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));

    turns[0]!.raise();
    await vi.waitFor(async () => expect((await rt.sessions.list(ws.id))[0]!.asking).toBeDefined());
    wait.advance(60_000);
    await rt.sessions.answer(handle.view().id, { askId: "ask_1", optionId: PERMISSION_ALLOW });
    await vi.waitFor(async () => expect((await rt.sessions.list(ws.id))[0]!.asking).toBeUndefined());

    // The harness counts wall time from launch to result: a minute of it was the person.
    turns[0]!.reply({ durationMs: 64_000, costUsd: 0.05 });
    await handle.finished;
    const done = (await rt.sessions.history(ws.id)).find((e: SessionEvent) => e.type === "session.done")!;
    const result = done.type === "session.done" ? done.result : undefined;
    expect(result).toMatchObject({ durationMs: 64_000, waitedMs: 60_000 });
    expect(turnSettledParts(result!)).toEqual(["Worked for 4.0s", "waited on you 1m", "$0.05"]);
    await rt.close();
  });
});
