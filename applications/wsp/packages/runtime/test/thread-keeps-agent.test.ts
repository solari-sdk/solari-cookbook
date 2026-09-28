// SPDX-License-Identifier: AGPL-3.0-only
// A thread keeps the agent and the access its own record carries. A send into
// it runs on the harness that record names, whatever the request names, and a
// request naming another agent is refused before anything is started: that
// agent would resume a harness session it never wrote, at its own access. An
// access named on such a send is dropped the same way, since a thread's
// access is changed through sessions.access and by no message. A session
// named beside the thread is the thread's own or the send is refused, so no
// other thread's transcript or access is read as this thread's. The record
// outlives the rows: a thread whose rows fell off the index cap still keeps
// both. A thread the send opens takes the request's picks whole, which is
// where an agent and an access are chosen.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, resumeNotOfThreadLine, threadRunsOnLine, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, copyingFake, createOn, testPlatform } from "./stub-backend.js";

const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
const CODEX_SESSION = "22222222-2222-4222-8222-222222222222";

/** A harness that answers at once and keeps every start it was handed, one recorder per agent, so a case reads
 * which agent ran and what it ran at rather than what the request asked for. */
function recording(session: string): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId: session });
        o.onEvent({ type: "turn.done", sessionId: session, result });
        o.onEvent({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: session, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

describe("the agent and the access a send into an existing thread runs on", () => {
  let root: string;
  let store: Store;
  let claude: ReturnType<typeof recording>;
  let codex: ReturnType<typeof recording>;
  let rt: Runtime;

  const runtime = (): Runtime => {
    claude = recording(CLAUDE_SESSION);
    codex = recording(CODEX_SESSION);
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    return createRuntime({ backend: stubBackend(), store, adapters: { claude: claude.adapter, codex: codex.adapter }, local });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-keeps-"));
    store = memoryStore();
    rt = runtime();
  });
  afterEach(async () => {
    await rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A thread opened on one agent at one access, as the person opened the read-only review thread. */
  const openThread = async (harness: "claude" | "codex", permissionMode: string, workspaceId?: string): Promise<{ workspaceId: string; thread: string }> => {
    const on = workspaceId ?? (await createOn(rt, { on: HERE_PLACE_ID, name: "mac" })).id;
    const first = await rt.sessions.start(on, { prompt: "one", harness, permissionMode });
    await first.finished;
    return { workspaceId: on, thread: first.view().threadId! };
  };

  it("refuses a send naming another agent, in one sentence naming the thread's own, and starts nothing", async () => {
    const { workspaceId, thread } = await openThread("codex", "read-only");
    await expect(rt.sessions.start(workspaceId, { prompt: "two", thread, harness: "claude" })).rejects.toThrow("this thread runs on codex; open a new thread to run claude");
    // The refusal is read before anything is started, so the other agent was never launched and the thread still
    // holds the one turn it ran.
    expect(claude.starts).toEqual([]);
    expect((await rt.sessions.list(workspaceId)).map(s => s.harness)).toEqual(["codex"]);
    // The same refusal on the road that names the harness session instead of the thread, which is what the
    // command line and the MCP door send.
    await expect(rt.sessions.start(workspaceId, { prompt: "two", resume: CODEX_SESSION, harness: "claude" })).rejects.toThrow("this thread runs on codex");
    expect(claude.starts).toEqual([]);
  });

  it("keeps the thread's own access where a send names one, so a read-only thread stays read-only", async () => {
    const { workspaceId, thread } = await openThread("codex", "read-only");
    expect(codex.starts.at(-1)?.permissionMode).toBe("read-only");
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread, permissionMode: "danger-full-access" })).finished;
    expect(codex.starts.at(-1)?.permissionMode).toBe("read-only");
    // And the thread's row says the same, which is what every client folds its access off.
    expect((await rt.sessions.list(workspaceId)).map(s => s.permissionMode)).toEqual(["read-only"]);
    // A send that names the thread's own agent is no refusal: it is the agent the thread runs on.
    await (await rt.sessions.start(workspaceId, { prompt: "three", thread, harness: "codex" })).finished;
    expect(codex.starts).toHaveLength(3);
  });

  it("refuses a session named beside the thread that is not one of the thread's own turns, and the thread's next turn is its own", async () => {
    const { workspaceId, thread } = await openThread("codex", "read-only");
    const wide = await openThread("claude", "bypassPermissions", workspaceId);
    // A send into the read-only thread that names the wide thread's session: taken, it would run the wide thread's
    // transcript under the read-only thread's id and read the wide thread's access as this one's.
    await expect(rt.sessions.start(workspaceId, { prompt: "two", thread, resume: CLAUDE_SESSION })).rejects.toThrow(resumeNotOfThreadLine(CLAUDE_SESSION, thread));
    // A session no thread here ran is refused by the same sentence, so the two cannot be told apart by asking.
    await expect(rt.sessions.start(workspaceId, { prompt: "two", thread, resume: "33333333-3333-4333-8333-333333333333" })).rejects.toThrow(resumeNotOfThreadLine("33333333-3333-4333-8333-333333333333", thread));
    expect(codex.starts).toHaveLength(1);
    expect(claude.starts).toHaveLength(1);
    // The thread's own session is what a send into it resumes, at the thread's own access, and naming that session
    // beside the thread is no refusal.
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread, resume: CODEX_SESSION })).finished;
    await (await rt.sessions.start(workspaceId, { prompt: "three", thread })).finished;
    expect(codex.starts.map(s => [s.resume, s.permissionMode])).toEqual([[undefined, "read-only"], [CODEX_SESSION, "read-only"], [CODEX_SESSION, "read-only"]]);
    const rows = (await rt.sessions.list(workspaceId)).map(s => [s.threadId, s.harness, s.permissionMode]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([[thread, "codex", "read-only"], [wide.thread, "claude", "bypassPermissions"]]));
  });

  it("keeps the agent and the access of a thread whose rows fell off the index cap, off the thread's own record", async () => {
    const { workspaceId, thread } = await openThread("codex", "read-only");
    await rt.close();
    // The state the cap leaves: the index holds no row of the thread, while the workspace's document and the
    // transcript still hold the thread. The rows are dropped here the way the cap drops them, oldest finished first.
    const doc = (await store.get("sessions", workspaceId)) as { sessions: unknown[] };
    await store.put("sessions", workspaceId, { ...doc, sessions: [] });
    rt = runtime();
    expect(await rt.sessions.list(workspaceId)).toEqual([]);
    // The sighting past the cap: the other agent named on the road that names the harness session. Refused in the
    // thread's own words, and the other agent never launched.
    await expect(rt.sessions.start(workspaceId, { prompt: "two", resume: CODEX_SESSION, harness: "claude" })).rejects.toThrow(threadRunsOnLine("codex", "claude"));
    expect(claude.starts).toEqual([]);
    // A send that names an access alone is a send into the thread, which drops it: the turn runs on the thread's
    // agent at the thread's access, under the thread's own id.
    const again = await rt.sessions.start(workspaceId, { prompt: "two", resume: CODEX_SESSION, permissionMode: "danger-full-access" });
    await again.finished;
    expect(codex.starts.map(s => [s.resume, s.permissionMode])).toEqual([[CODEX_SESSION, "read-only"]]);
    expect(again.view().threadId).toBe(thread);
    // The transcript stamps the thread's record on every start, so a client with no row of this thread still reads
    // its agent and its access off the transcript.
    const starts = (await rt.sessions.history(workspaceId)).filter(e => e.type === "session.start");
    expect(starts.map(e => [e.threadId, e.agent, e.permissionMode])).toEqual([[thread, "codex", "read-only"], [thread, "codex", "read-only"]]);
  });

  it("runs a thread the send opens on the agent and the access that send names, which is where both are picked", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(ws.id, { prompt: "one", harness: "codex", permissionMode: "read-only" });
    await first.finished;
    // A second thread in the same workspace, on another agent at another access: neither the thread beside it nor
    // the agent the project now remembers stands in the way of the picks this start names.
    const other = await rt.sessions.start(ws.id, { prompt: "two", harness: "claude", permissionMode: "plan" });
    await other.finished;
    expect(other.view().threadId).not.toBe(first.view().threadId);
    expect(claude.starts.at(-1)?.permissionMode).toBe("plan");
    expect(codex.starts).toHaveLength(1);
  });
});
