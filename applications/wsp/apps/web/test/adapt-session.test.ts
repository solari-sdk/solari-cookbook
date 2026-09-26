// SPDX-License-Identifier: AGPL-3.0-only
// Session events into the chat view models: messages, work rows, turn
// summaries and the timeline rows the transplanted MessagesTimeline renders.
import { describe, expect, expectTypeOf, it } from "vitest";
import { fmtDuration, type SessionEvent } from "@wsp/protocol";
import { deriveMessagesTimelineRows, deriveSession, toolGroupSummaryKind, workEntryKind } from "../src/adapt/index.js";
import type { ToolGroupAction, ToolGroupSummaryKind, WorkLogEntry } from "../src/adapt/index.js";
import { CHAT_STREAM, CHAT_TURN } from "./fixtures/chat-stream.js";
import { LIVE_RUN_1, LIVE_SID, sessionEventsOf } from "./fixtures/live-run-1.js";

const scope = { workspaceId: "ws_t", sessionId: "sess_t" };
const start: SessionEvent = { type: "session.start", ...scope, prompt: "do it", model: "claude-opus-5" };
const tool = (toolName: string, input: unknown, toolUseId = "toolu_1"): SessionEvent => ({
  type: "session.delta", ...scope, kind: "tool_use", toolName, toolUseId, text: JSON.stringify(input),
});
const result = (text: string, isError = false, toolUseId = "toolu_1"): SessionEvent => ({
  type: "session.delta", ...scope, kind: "tool_result", toolUseId, text, isError,
});
const done: SessionEvent = { type: "session.done", ...scope, result: { status: "completed", durationMs: 1500, costUsd: 0.01 } };
const end: SessionEvent = { type: "session.end", ...scope, exitCode: 0, sawResult: true };

const liveSession = sessionEventsOf(LIVE_RUN_1);
const liveEvents = liveSession.map(s => s.event);
const liveAt = (_e: SessionEvent, index: number) => liveSession[index]?.at;

describe("deriveSession: a message steered into the running turn", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_s" };
  const events: SessionEvent[] = [
    { type: "session.start", ...scoped, at: 1_000, prompt: "run the long job" },
    { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "Starting." },
    { type: "session.steer", ...scoped, at: 3_000, prompt: "when it ends, say pineapple", requestId: "req_s" },
    { type: "session.delta", ...scoped, at: 4_000, kind: "text", text: "Pineapple." },
  ];

  it("is the person's own message row inside the same turn, in wire order, marked steered", () => {
    const model = deriveSession(events);
    expect(model.turns).toHaveLength(1);
    expect(model.running).toBe(true);
    expect(model.messages.map(m => [m.role, m.text, m.steered ?? false, m.turnId])).toEqual([
      ["user", "run the long job", false, "turn_s"],
      ["assistant", "Starting.", false, "turn_s"],
      ["user", "when it ends, say pineapple", true, "turn_s"],
      ["assistant", "Pineapple.", false, "turn_s"],
    ]);
    expect(model.messages[2]!.createdAt).toBe(new Date(3_000).toISOString());
  });

  it("a settled turn keeps the steered row visible: user rows never fold behind Worked for", () => {
    const settled: SessionEvent[] = [...events, { type: "session.done", ...scoped, at: 5_000, result: { status: "completed", durationMs: 4_000 } }, { type: "session.end", ...scoped, at: 5_100, exitCode: 0, sawResult: true }];
    const model = deriveSession(settled);
    const rows = deriveMessagesTimelineRows({ timelineEntries: model.timeline, turns: model.turns, isWorking: false, activeTurnStartedAt: null });
    const shown = rows.filter(r => r.kind === "message").map(r => (r.kind === "message" ? [r.message.role, r.message.text] : []));
    expect(shown).toEqual([
      ["user", "run the long job"],
      ["user", "when it ends, say pineapple"],
      ["assistant", "Pineapple."],
    ]);
  });
});

describe("deriveSession: a turn whose agent wrote twice", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_h" };
  const events: SessionEvent[] = [
    { type: "session.start", ...scoped, at: 1_000, prompt: "hold for 90 seconds" },
    { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "Waiting for the hold to complete.", messageId: "msg_a" },
    { type: "session.delta", ...scoped, at: 92_000, kind: "text", text: "Done. ", messageId: "msg_b" },
    { type: "session.delta", ...scoped, at: 92_500, kind: "text", text: "It ended with exit code 0.", messageId: "msg_b" },
  ];

  it("is two bubbles, the one it wrote while its background command ran and the one it wrote when that command woke it", () => {
    expect(deriveSession(events).messages.map(m => [m.role, m.text])).toEqual([
      ["user", "hold for 90 seconds"],
      ["assistant", "Waiting for the hold to complete."],
      ["assistant", "Done. It ended with exit code 0."],
    ]);
  });
});

describe("deriveSession: a harness's note about itself", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_n" };
  const warning = "loading hooks from both hooks.json and config.toml; prefer a single representation for this layer";

  it("is a notice beside the work, not a message under the agent's name and not a failure", () => {
    const model = deriveSession([
      { type: "session.start", ...scoped, at: 1_000, prompt: "say ready" },
      { type: "session.delta", ...scoped, at: 1_500, kind: "note", text: warning },
      { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "ready", messageId: "msg_a" },
      { type: "session.done", ...scoped, at: 2_500, result: { status: "completed", text: "ready" } },
    ]);
    expect(model.messages.map(m => [m.role, m.text])).toEqual([["user", "say ready"], ["assistant", "ready"]]);
    const notes = model.timeline.filter(row => row.kind === "work" && row.entry.label === warning);
    expect(notes.map(row => (row.kind === "work" ? [row.entry.tone, row.entry.sourceActivityKind] : []))).toEqual([["notice", "harness.note"]]);
  });

  it("ends no message of the agent's: prose a note lands in the middle of goes on in the same bubble, as it does in the read and on the stream", () => {
    const model = deriveSession([
      { type: "session.start", ...scoped, at: 1_000, prompt: "say ready" },
      { type: "session.delta", ...scoped, at: 1_500, kind: "text", text: "Almost ", messageId: "msg_a" },
      { type: "session.delta", ...scoped, at: 1_700, kind: "note", text: warning },
      { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "ready.", messageId: "msg_a" },
    ]);
    expect(model.messages.map(m => [m.role, m.text])).toEqual([["user", "say ready"], ["assistant", "Almost ready."]]);
  });
});

describe("deriveSession: the chat fixture", () => {
  const model = deriveSession(CHAT_STREAM);

  it("folds contiguous text deltas into one assistant message and starts a new one after a tool", () => {
    expect(model.messages.map(m => [m.role, m.text])).toEqual([
      ["assistant", "Creating the server file, then starting it."],
      ["assistant", "Server is live at :3000."],
    ]);
    expect(model.messages.every(m => !m.streaming)).toBe(true);
    expect(model.messages.every(m => m.turnId === CHAT_TURN)).toBe(true);
  });

  it("turns the tool call and its result into one completed command row, thinking into a thinking row", () => {
    expect(model.workEntries).toHaveLength(2);
    const [bash, thinking] = model.workEntries as [WorkLogEntry, WorkLogEntry];
    expect(bash).toMatchObject({
      tone: "tool",
      label: "Bash",
      toolCallId: "toolu_01WspFixBash1",
      itemType: "command_execution",
      command: "node /root/server.js >/dev/null 2>&1 & sleep 0.3 && curl -s http://localhost:3000",
      detail: "Hello, World!",
      toolLifecycleStatus: "completed",
      sourceActivityKind: "tool.completed",
    });
    expect(thinking).toMatchObject({ tone: "thinking", label: "Thinking", detail: "curl returned the greeting, so the server is live.", preview: "curl returned the greeting, so the server is live.", sourceActivityKind: "reasoning" });
  });

  it("keeps the turn running with its reply recorded between session.done and session.end, then settles at the end", () => {
    const replied = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Done." }, done]);
    expect(replied.running).toBe(true);
    expect(replied.latestTurn).toMatchObject({ state: "running", replied: true, durationMs: 1500, costUsd: 0.01 });
    expect(replied.messages.map(m => [m.role, m.text])).toEqual([["user", "do it"], ["assistant", "Done."]]);
    const settled = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Done." }, done, end]);
    expect(settled.running).toBe(false);
    expect(settled.latestTurn).toMatchObject({ state: "completed", replied: true, durationMs: 1500 });
  });

  it("summarises the turn from session.done and clears running on session.end", () => {
    expect(model.turns).toEqual([
      expect.objectContaining({ turnId: CHAT_TURN, state: "completed", durationMs: 10458, costUsd: 0.0187, model: "claude-sonnet-4-5", prompt: null }),
    ]);
    expect(model.running).toBe(false);
    expect(model.latestTurn?.turnId).toBe(CHAT_TURN);
    expect(model.turns[0]).toMatchObject({ startedAt: "2026-09-01T01:31:29.412Z", completedAt: "2026-09-01T01:31:39.870Z" });
  });

  it("keeps wire order in the timeline: text, tool, thinking, text", () => {
    expect(model.timeline.map(e => (e.kind === "message" ? `m:${e.message.role}` : `w:${e.kind === "work" ? e.entry.tone : e.kind}`))).toEqual([
      "m:assistant", "w:tool", "w:thinking", "m:assistant",
    ]);
  });
});

describe("deriveSession: streaming states", () => {
  it("marks the tail assistant message streaming and the open tool call inProgress while the turn runs", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Looking" }, tool("Read", { file_path: "/a.ts" })]);
    expect(m.running).toBe(true);
    expect(m.latestTurn?.state).toBe("running");
    expect(m.messages.map(x => [x.role, x.text, x.streaming])).toEqual([["user", "do it", false], ["assistant", "Looking", false]]);
    expect(m.workEntries[0]).toMatchObject({ toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started", requestKind: "file-read", detail: "/a.ts" });
  });

  it("the newest assistant message in a running turn is streaming", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Look" }]);
    expect(m.messages.at(-1)?.streaming).toBe(true);
  });

  it("appends streamed tool input chunks for the same toolUseId into one row", () => {
    const m = deriveSession([
      start,
      { type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: '{"command":"ls' },
      { type: "session.delta", ...scope, kind: "tool_use", toolUseId: "t1", text: ' -la"}' },
      result("total 0", false, "t1"),
    ]);
    expect(m.workEntries).toHaveLength(1);
    expect(m.workEntries[0]).toMatchObject({ command: "ls -la", detail: "total 0", toolLifecycleStatus: "completed" });
  });

  it("keeps the Bash tool's description on the row after its output replaces the detail", () => {
    const m = deriveSession([start, tool("Bash", { command: "git status", description: "Show working tree status" }), result("On branch main")]);
    expect(m.workEntries[0]).toMatchObject({ command: "git status", description: "Show working tree status", detail: "On branch main" });
  });

  it("another tool's description field stays a detail and never becomes the row's label", () => {
    const m = deriveSession([start, tool("Task", { description: "scan repo", prompt: "find every caller" }), result("Found 12 files")]);
    expect(m.workEntries[0]).toMatchObject({ detail: "Found 12 files" });
    expect(m.workEntries[0]).not.toHaveProperty("description");
  });

  it("a tool_result with no visible call still renders as a completed row", () => {
    const m = deriveSession([start, result("orphan output", false, "t9")]);
    expect(m.workEntries[0]).toMatchObject({ toolCallId: "t9", label: "tool", detail: "orphan output", toolLifecycleStatus: "completed" });
  });

  it("an error result marks the row failed and carries the error text as detail", () => {
    const m = deriveSession([start, tool("Bash", { command: "false" }), result("exit 1: nope", true)]);
    expect(m.workEntries[0]).toMatchObject({ toolLifecycleStatus: "failed", detail: "exit 1: nope", command: "false" });
  });

  it("uses result.text as the assistant message when no text delta arrived (capped replay)", () => {
    const m = deriveSession([start, { type: "session.done", ...scope, result: { status: "completed", text: "All done." } }, end]);
    expect(m.messages.map(x => [x.role, x.text])).toEqual([["user", "do it"], ["assistant", "All done."]]);
  });

  it("does not repeat result.text when the deltas already carried it", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "All done." }, { type: "session.done", ...scope, result: { status: "completed", text: "All done." } }, end]);
    expect(m.messages.filter(x => x.role === "assistant")).toHaveLength(1);
  });

  it.each([
    ["failed result", [start, { type: "session.done", ...scope, result: { status: "failed", error: "boom" } }, end] as SessionEvent[], "error", "boom"],
    ["exit without result", [start, { type: "session.end", ...scope, exitCode: 137, sawResult: false }] as SessionEvent[], "error", "session exited without a result (exit code 137)"],
    ["interrupted", [start, { type: "session.done", ...scope, result: { status: "interrupted" } }, end] as SessionEvent[], "interrupted", null],
  ])("%s: turn state and error row", (_name, events, state, errorLabel) => {
    const m = deriveSession(events);
    expect(m.latestTurn?.state).toBe(state);
    expect(m.running).toBe(false);
    const errors = m.workEntries.filter(w => w.tone === "error");
    if (errorLabel === null) expect(errors).toEqual([]);
    else expect(errors).toEqual([expect.objectContaining({ label: errorLabel, sourceActivityKind: "runtime.error", turnId: "sess_t#1" })]);
  });

  it("a start stamped afterCut puts a notice row under the prompt, so the person knows why context may be missing", () => {
    const m = deriveSession([{ ...start, afterCut: true } as SessionEvent, done, end]);
    const rows = m.workEntries.filter(w => w.sourceActivityKind === "runtime.resume");
    expect(rows.map(w => [w.label, w.tone, w.turnId])).toEqual([["previous turn was cut; resuming", "notice", "sess_t#1"]]);
    expect(m.timeline.slice(0, 2).map(e => e.kind)).toEqual(["message", "work"]);
    expect(deriveSession([start, done, end]).workEntries.filter(w => w.sourceActivityKind === "runtime.resume")).toEqual([]);
  });

  it("createdAt: the wire's at wins, then the caller's clock, then empty", () => {
    const wire = deriveSession(CHAT_STREAM, { at: () => "1999-01-01T00:00:00Z" });
    expect(wire.messages[0]?.createdAt).toBe("2026-09-01T01:31:30.612Z");
    expect(wire.messages[0]?.updatedAt).toBe("2026-09-01T01:31:30.862Z");
    const unstamped = CHAT_STREAM.map(({ at: _at, ...e }) => e as SessionEvent);
    const clock = deriveSession(unstamped, { at: (_e, i) => `2026-09-01T00:00:0${i}Z` });
    expect(clock.messages[0]?.createdAt).toBe("2026-09-01T00:00:01Z");
    expect(clock.turns[0]).toMatchObject({ startedAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T00:00:07Z" });
    expect(deriveSession(unstamped).messages[0]?.createdAt).toBe("");
  });

  it("turn id: the wire's turnId wins; without one the session id plus start ordinal stands in", () => {
    const unkeyed = CHAT_STREAM.map(({ turnId: _t, ...e }) => e as SessionEvent);
    expect(deriveSession(unkeyed).turns.map(t => t.turnId)).toEqual(["sess_0001#1"]);
    expect(deriveSession([...unkeyed, ...unkeyed]).turns.map(t => t.turnId)).toEqual(["sess_0001#1", "sess_0001#2"]);
  });

  it("a delta whose turnId never started here opens its own turn (history cut mid-turn)", () => {
    const m = deriveSession([
      { type: "session.delta", ...scope, turnId: "turn_x", kind: "text", text: "tail of an older turn" },
      { type: "session.done", ...scope, turnId: "turn_x", result: { status: "completed", durationMs: 5 } },
      { ...start, turnId: "turn_y" },
    ]);
    expect(m.turns.map(t => [t.turnId, t.state])).toEqual([["turn_x", "completed"], ["turn_y", "running"]]);
    expect(m.messages.map(x => [x.turnId, x.role])).toEqual([["turn_x", "assistant"], ["turn_y", "user"]]);
  });

  it("a session.end with no turn of its own opens no turn: the settled turn stays the latest, and the reason it carries is the one row it leaves", () => {
    const scoped = { ...scope, turnId: "turn_1" };
    const m = deriveSession([
      { type: "session.start", ...scoped, prompt: "build it" },
      { type: "session.delta", ...scoped, kind: "text", text: "all green" },
      { type: "session.done", ...scoped, result: { status: "completed", text: "all green" } },
      { type: "session.end", ...scoped, exitCode: 0, sawResult: true },
      { type: "session.end", workspaceId: scope.workspaceId, sessionId: "turn_2", turnId: "turn_2", exitCode: null, sawResult: false, reason: "the harness would not launch" },
    ]);
    expect(m.turns.map(t => [t.turnId, t.state])).toEqual([["turn_1", "completed"]]);
    expect(m.latestTurn?.turnId).toBe("turn_1");
    expect(m.running).toBe(false);
    expect(m.timeline.map(e => e.kind)).toEqual(["message", "message", "work"]);
    expect(m.workEntries.map(w => [w.turnId, w.label])).toEqual([["turn_2", "the harness would not launch"]]);
  });

  it("a fence-only tool result carries no detail", () => {
    const m = deriveSession([start, tool("Bash", { command: "cat x" }), result("```")]);
    expect(m.workEntries[0]?.detail).toBeUndefined();
    expect(m.workEntries[0]?.toolLifecycleStatus).toBe("completed");
  });
});

describe("deriveSession: tool classification", () => {
  it.each([
    ["Bash", { command: "pnpm test" }, { itemType: "command_execution", command: "pnpm test" }],
    ["Read", { file_path: "/x/a.ts" }, { requestKind: "file-read", detail: "/x/a.ts" }],
    ["Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" }, { itemType: "file_change", changedFiles: ["/x/a.ts"] }],
    ["Write", { file_path: "/x/b.ts", content: "..." }, { itemType: "file_change", changedFiles: ["/x/b.ts"] }],
    ["Grep", { pattern: "foo", path: "src" }, { toolTitle: "Grep", detail: "foo" }],
    ["Glob", { pattern: "**/*.ts" }, { toolTitle: "Glob", detail: "**/*.ts" }],
    ["WebSearch", { query: "vitest snapshots" }, { itemType: "web_search", detail: "vitest snapshots" }],
    ["WebFetch", { url: "https://example.com" }, { itemType: "web_search", detail: "https://example.com" }],
    ["Task", { description: "scan repo", prompt: "..." }, { itemType: "collab_agent_tool_call", detail: "scan repo" }],
    ["mcp__gh__issue", { number: 5 }, { itemType: "mcp_tool_call" }],
  ])("%s", (toolName, input, expected) => {
    const m = deriveSession([start, tool(toolName, input)]);
    expect(m.workEntries[0]).toMatchObject({ label: toolName, ...expected });
  });

  it.each([
    ["command_execution", { command: "pnpm test" }, { itemType: "command_execution", command: "pnpm test" }],
    ["file_change", { changes: [{ kind: "edit", path: "src/a.ts" }, { kind: "add", path: "src/b.ts" }] }, { itemType: "file_change", changedFiles: ["src/a.ts", "src/b.ts"] }],
    ["web_search", { query: "vitest snapshots" }, { itemType: "web_search", detail: "vitest snapshots" }],
  ])("a Codex turn's %s row reads as the same kind of call the Claude name reads as", (toolName, input, expected) => {
    const m = deriveSession([start, tool(toolName, input)]);
    expect(m.workEntries[0]).toMatchObject({ label: toolName, ...expected });
  });

  it("keeps unparsable tool input as the detail", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: "{not json" }]);
    expect(m.workEntries[0]).toMatchObject({ detail: "{not json" });
    expect(m.workEntries[0]?.command).toBeUndefined();
  });
});

describe("deriveSession: live run 1", () => {
  const m = deriveSession(liveEvents, { at: liveAt });

  it("one resumed Claude session id becomes four turns, keyed by start ordinal", () => {
    expect(m.turns.map(t => t.turnId)).toEqual([1, 2, 3, 4].map(n => `${LIVE_SID}#${n}`));
    expect(m.turns.map(t => t.prompt)).toEqual(["hello", "build a simple chat app, run it locally, use npm", "/model", "anyways can you make it more beautiful, use shadcn"]);
    expect(m.turns.map(t => t.durationMs)).toEqual([2772, 101515, 114, 862399]);
    expect(m.turns.map(t => t.state)).toEqual(["completed", "completed", "completed", "completed"]);
  });

  it("a stream with no deltas yields user messages only, and the model sticks from the last start that named one", () => {
    expect(m.messages.map(x => x.role)).toEqual(["user", "user", "user", "user"]);
    expect(m.workEntries).toEqual([]);
    expect(m.model).toBe("claude-opus-5");
    expect(m.running).toBe(false);
  });

  it("turn timing comes from the stamped start and done events", () => {
    expect(m.turns[1]).toMatchObject({ startedAt: liveSession[3]?.at, completedAt: liveSession[4]?.at });
  });
});

describe("deriveMessagesTimelineRows", () => {
  const rows = (events: ReadonlyArray<SessionEvent>, extra: Partial<Parameters<typeof deriveMessagesTimelineRows>[0]> = {}) => {
    const m = deriveSession(events);
    return deriveMessagesTimelineRows({ timelineEntries: m.timeline, turns: m.turns, isWorking: m.running, activeTurnStartedAt: null, ...extra });
  };

  it("settled turn: work folds behind 'Worked for' and only the terminal assistant message shows meta", () => {
    const r = rows(CHAT_STREAM);
    expect(r.map(x => x.kind)).toEqual(["turn-fold", "message"]);
    expect(r[0]).toMatchObject({ kind: "turn-fold", turnId: CHAT_TURN, label: "Worked for 10s", expanded: false });
    expect(r[1]).toMatchObject({ kind: "message", showAssistantMeta: true, assistantCopyStreaming: false });
  });

  it("the cut row and the notify row hide behind the fold like any work, and stand alone as notice rows when it opens", () => {
    const scoped = { ...scope, turnId: "turn_c" };
    const events: SessionEvent[] = [
      { type: "session.start", ...scoped, at: 1_000, prompt: "carry on", afterCut: true },
      { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "picking up where it stopped" },
      { type: "session.notify", ...scoped, at: 2_500, notify: "me", text: "thread thread_c finished (completed, 1.5s): picking up" },
      { type: "session.done", ...scoped, at: 3_000, result: { status: "completed", durationMs: 1500, text: "picking up where it stopped" } },
      { type: "session.end", ...scoped, at: 3_100, exitCode: 0, sawResult: true },
    ];
    expect(rows(events).map(x => x.kind)).toEqual(["message", "turn-fold", "message"]);
    const open = rows(events, { expandedTurnIds: new Set(["turn_c"]) });
    expect(open.map(x => x.kind)).toEqual(["message", "turn-fold", "work", "message", "work"]);
    const notices = open.filter(x => x.kind === "work").map(x => x.kind === "work" && x.groupedEntries.map(e => [e.tone, e.sourceActivityKind]));
    expect(notices).toEqual([[["notice", "runtime.resume"]], [["notice", "runtime.notify"]]]);
    expect(open[1]).toMatchObject({ kind: "turn-fold", label: "Worked for 1.5s" });
  });

  it("expanding the fold shows every entry: first message, the tool group toggle, the last message", () => {
    const r = rows(CHAT_STREAM, { expandedTurnIds: new Set([CHAT_TURN]) });
    expect(r.map(x => x.kind)).toEqual(["turn-fold", "message", "work-toggle", "message"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Ran 1 command", summaryKind: "command", hiddenCount: 2, hasFailure: false });
    expect(r[1]).toMatchObject({ kind: "message", showAssistantMeta: false });
  });

  it("reasoning rows carry a one-line preview and the full text, and a reasoning-only group reads Thinking", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "thinking", text: "first line of thought\nsecond line" }, { type: "session.delta", ...scope, kind: "thinking", text: " continues" }, done, end]);
    expect(m.workEntries[0]).toMatchObject({ tone: "thinking", preview: "first line of thought", detail: "first line of thought\nsecond line continues" });
    const r = rows([start, { type: "session.delta", ...scope, kind: "thinking", text: "quiet reasoning" }, done, end], { expandedTurnIds: new Set(["sess_t#1"]) });
    expect(r.map(x => x.kind)).toEqual(["message", "turn-fold", "work-toggle"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Thinking", summaryKind: "agent-tool", hiddenCount: 1 });
  });

  it("an empty reasoning marker stays neutral and out of the group", () => {
    const r = rows([start, { type: "session.delta", ...scope, kind: "thinking", text: "" }, tool("Bash", { command: "ls" }), result("ok"), done, end], { expandedTurnIds: new Set(["sess_t#1"]) });
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Ran 1 command", hiddenCount: 1 });
  });

  it("the live row names the reasoning when it came after the last tool", () => {
    const r = rows([start, tool("Bash", { command: "ls" }), result("ok"), { type: "session.delta", ...scope, kind: "thinking", text: "weighing the output" }]);
    const live = r.find(x => x.kind === "work-live");
    expect(live?.kind === "work-live" && live.entry.tone).toBe("thinking");
    expect(live?.kind === "work-live" && live.groupedEntries.map(e => e.tone)).toEqual(["tool", "thinking"]);
  });

  it("expanding the tool group appends the detail row with the thinking entry included", () => {
    const r = rows(CHAT_STREAM, { expandedTurnIds: new Set([CHAT_TURN]), expandedWorkGroupIds: new Set([`work-group:tool:${CHAT_TURN}:toolu_01WspFixBash1`]) });
    const detail = r.find(x => x.kind === "work");
    expect(detail).toMatchObject({ kind: "work", isExpandedToolGroup: true });
    expect(detail?.kind === "work" && detail.groupedEntries.map(e => e.tone)).toEqual(["tool", "thinking"]);
  });

  it("running turn: user message, working row, then a live row for the in-progress tool", () => {
    const r = rows([start, { type: "session.delta", ...scope, kind: "text", text: "On it." }, tool("Bash", { command: "pnpm test" })]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "message", "work-live"]);
    expect(r[3]).toMatchObject({ kind: "work-live", active: true, id: "live-activity-row" });
    expect(r[3]?.kind === "work-live" && r[3].entry.command).toBe("pnpm test");
  });

  it("running turn with nothing produced yet shows the working and thinking rows", () => {
    const r = rows([start]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "thinking"]);
  });

  it("a failed tool at the tail of a running turn is withheld until the turn reacts; the thinking row shows", () => {
    const r = rows([start, tool("Bash", { command: "false" }), result("exit 1", true)]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "thinking"]);
  });

  it("a failed tool followed by text is grouped with hasFailure", () => {
    const r = rows([start, tool("Bash", { command: "false" }), result("exit 1", true), { type: "session.delta", ...scope, kind: "text", text: "Retrying" }]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "work-toggle", "message", "thinking"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", hasFailure: true, summary: "Ran 1 command" });
  });

  it("an interrupted turn is labelled as stopped by the user", () => {
    const r = rows([start, tool("Bash", { command: "sleep 9" }), result("", false), { type: "session.done", ...scope, result: { status: "interrupted", durationMs: 4000 } }, end]);
    expect(r[1]).toMatchObject({ kind: "turn-fold", label: "You stopped after 4.0s" });
  });

  it("error rows never fold or group", () => {
    const r = rows([start, tool("Bash", { command: "x" }), result("ok"), { type: "session.done", ...scope, result: { status: "failed", error: "boom", durationMs: 100 } }, end]);
    expect(r.map(x => x.kind)).toEqual(["message", "turn-fold", "work"]);
    expect(r[2]?.kind === "work" && r[2].groupedEntries[0]?.tone).toBe("error");
  });

  it("snapshot: the chat fixture, settled and expanded", () => {
    expect(rows(CHAT_STREAM)).toMatchSnapshot();
    expect(rows(CHAT_STREAM, { expandedTurnIds: new Set([CHAT_TURN]) })).toMatchSnapshot();
  });

  it("snapshot: live run 1", () => {
    const m = deriveSession(liveEvents, { at: liveAt });
    expect(deriveMessagesTimelineRows({ timelineEntries: m.timeline, turns: m.turns, isWorking: m.running, activeTurnStartedAt: null })).toMatchSnapshot();
  });
});

describe("the turn's duration comes from the protocol's one formatter", () => {
  it.each([
    [0, "1ms"], [7, "7ms"], [999, "999ms"], [1500, "1.5s"], [9960, "10s"], [10458, "10s"], [59_400, "59s"], [60_000, "1m"], [101_515, "1m 42s"], [862_399, "14m 22s"], [-5, "0ms"], [4000, "4.0s"],
  ])("%d ms -> %s", (ms, text) => expect(fmtDuration(ms)).toBe(text));
});

describe("workEntryKind: the one rule a tool-like row's kind is read by", () => {
  const row = (extra: Partial<WorkLogEntry>): WorkLogEntry =>
    ({ id: "w", createdAt: "", turnId: "turn_k", label: "row", tone: "tool", sourceActivityKind: "tool.completed", ...extra });

  it.each<[string, Partial<WorkLogEntry>, ToolGroupSummaryKind | null]>([
    ["a file read", { requestKind: "file-read" }, "read"],
    ["a file change", { itemType: "file_change", changedFiles: ["/x/a.ts"] }, "edit"],
    ["a command", { itemType: "command_execution", command: "pnpm test" }, "command"],
    ["a code search", { toolTitle: "Grep" }, "code-search"],
    ["a web search", { itemType: "web_search" }, "search"],
    ["an MCP call", { itemType: "mcp_tool_call" }, "other"],
    ["a dynamic tool call", { itemType: "dynamic_tool_call" }, "dynamic-tool"],
    ["a subagent call", { itemType: "collab_agent_tool_call" }, "agent-tool"],
    ["a plain tool call with no item type, whose tone must say", {}, null],
    ["reasoning, whose tone must say", { tone: "thinking", detail: "weighing the options" }, null],
    ["a notice that is tool-like, whose tone must say", { tone: "notice", requestKind: "mcp-elicitation" }, null],
  ])("%s", (_name, extra, kind) => {
    expect(workEntryKind(row(extra))).toBe(kind);
  });

  it("a group's kind is its rows' one kind, the tone standing in where no item type does, and mixed otherwise", () => {
    expect(toolGroupSummaryKind([row({ itemType: "mcp_tool_call" })])).toBe("other");
    expect(toolGroupSummaryKind([row({ itemType: "dynamic_tool_call" }), row({ itemType: "dynamic_tool_call" })])).toBe("dynamic-tool");
    expect(toolGroupSummaryKind([row({ itemType: "collab_agent_tool_call" })])).toBe("agent-tool");
    expect(toolGroupSummaryKind([row({})])).toBe("tone-tool");
    expect(toolGroupSummaryKind([row({ tone: "thinking" })])).toBe("agent-tool");
    expect(toolGroupSummaryKind([row({ tone: "notice", requestKind: "mcp-elicitation" })])).toBe("other");
    expect(toolGroupSummaryKind([row({ itemType: "mcp_tool_call" }), row({ itemType: "dynamic_tool_call" })])).toBe("mixed");
    expect(toolGroupSummaryKind([row({ itemType: "mcp_tool_call" }), row({ tone: "thinking" })])).toBe("mixed");
    expect(toolGroupSummaryKind([row({ itemType: "command_execution", command: "ls" }), row({ tone: "thinking" })])).toBe("command");
  });

  it("every action a summary can name comes from a fact the adapter reads off the wire", () => {
    expectTypeOf<ToolGroupAction>().toEqualTypeOf<"read" | "edit" | "command" | "code-search" | "search" | "other" | "update">();
  });
});

describe("deriveSession: a thread's end told where its start said", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_n", threadId: "thread_child_0001" };
  const line = "thread thread_c finished (completed, 8m 12s, $1.94): all green";
  const events = (notify: string): SessionEvent[] => [
    { type: "session.start", ...scoped, at: 1_000, prompt: "build it" },
    { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "all green" },
    { type: "session.notify", ...scoped, at: 2_999, notify, text: line },
    { type: "session.done", ...scoped, at: 3_000, result: { status: "completed", durationMs: 492_000, costUsd: 1.94, text: "all green" } },
    { type: "session.end", ...scoped, at: 3_100, exitCode: 0, sawResult: true },
  ];

  it("is one notice work row in the turn naming the thread told, with the line as its detail", () => {
    const model = deriveSession(events("thread_parent_0001"));
    const rows = model.workEntries.filter(w => w.sourceActivityKind === "runtime.notify");
    expect(rows.map(w => [w.label, w.detail, w.tone, w.turnId])).toEqual([["told thread thread_p", line, "notice", "turn_n"]]);
    expect(model.turns[0]).toMatchObject({ state: "completed", durationMs: 492_000, costUsd: 1.94 });
  });

  it("names the person when the start said me", () => {
    const model = deriveSession(events("me"));
    expect(model.workEntries.filter(w => w.sourceActivityKind === "runtime.notify").map(w => w.label)).toEqual(["told you"]);
  });
});

describe("a person's message that carried images", () => {
  const records = [
    { mediaType: "image/png", bytes: 1_258_291, name: "shot.png" },
    { mediaType: "image/webp", bytes: 4096 },
  ];

  it("keeps the runtime's records and the request id on the message, so the client that sent them can draw them", () => {
    const model = deriveSession([{ ...start, attachments: records, requestId: "req_1" }, done, end]);
    const user = model.messages.find(m => m.role === "user")!;
    expect(user.text).toBe("do it");
    expect(user.attachments).toEqual(records);
    expect(user.requestId).toBe("req_1");
  });

  it("carries neither on a turn that had no image", () => {
    const user = deriveSession([start, done, end]).messages.find(m => m.role === "user")!;
    expect(user.attachments).toBeUndefined();
    expect(user.requestId).toBeUndefined();
  });
});

describe("deriveSession: a permission prompt relayed into the chat", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_p" };
  const options = [
    { id: "allow", label: "Allow", effect: "allow" as const },
    { id: "deny", label: "Deny", effect: "deny" as const },
    { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode" as const, mode: "acceptEdits" },
  ];
  const ask: SessionEvent = {
    type: "session.permission",
    ...scoped,
    at: 2_000,
    askId: "ask_1",
    toolName: "Write",
    toolUseId: "toolu_1",
    input: '{"file_path":"/root/out.txt","content":"hi"}',
    detail: "out.txt",
    options,
  };
  const closed = (over: Partial<Extract<SessionEvent, { type: "session.permission.closed" }>> = {}): SessionEvent => ({
    type: "session.permission.closed",
    ...scoped,
    at: 3_000,
    askId: "ask_1",
    outcome: "allowed",
    optionId: "allow",
    ...over,
  });
  const opening: SessionEvent[] = [{ type: "session.start", ...scoped, at: 1_000, prompt: "write it" }];

  it("becomes its own timeline row, still open, carrying the session the answer names and every option", () => {
    const model = deriveSession([...opening, ask]);
    const rows = model.timeline.filter(e => e.kind === "permission");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "permission:ask_1", kind: "permission", createdAt: new Date(2_000).toISOString() });
    expect(rows[0]!.kind === "permission" ? rows[0]!.permission : null).toEqual({
      askId: "ask_1",
      turnId: "turn_p",
      sessionId: "sess_t",
      // The runtime's session id, what sessions.answer takes, not the harness's own.
      toolName: "Write",
      toolUseId: "toolu_1",
      input: '{"file_path":"/root/out.txt","content":"hi"}',
      detail: "out.txt",
      options,
      createdAt: new Date(2_000).toISOString(),
      // Null is what an open prompt reads as: the turn is waiting on it.
      outcome: null,
      optionId: null,
    });
  });

  it("its close lands on the row it opened, not on a second row after the work the answer let through", () => {
    const model = deriveSession([...opening, ask, { type: "session.delta", ...scoped, at: 2_500, kind: "text", text: "Writing." }, closed()]);
    const rows = model.timeline.filter(e => e.kind === "permission");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === "permission" ? rows[0]!.permission : null).toMatchObject({ outcome: "allowed", optionId: "allow" });
    // The row stays where the prompt was raised, above the reply the answer let through.
    expect(model.timeline.findIndex(e => e.kind === "permission")).toBeLessThan(model.timeline.length - 1);
  });

  it("carries every outcome, and a close with no option (the wait, a cancel) leaves the option null", () => {
    for (const outcome of ["allowed", "denied", "unanswered", "cancelled"] as const) {
      const row = deriveSession([...opening, ask, closed({ outcome })]).timeline.find(e => e.kind === "permission");
      expect(row!.kind === "permission" ? row!.permission.outcome : null).toBe(outcome);
    }
    const { optionId: _o, ...noOption } = closed({ outcome: "unanswered" }) as Extract<SessionEvent, { type: "session.permission.closed" }>;
    const row = deriveSession([...opening, ask, noOption]).timeline.find(e => e.kind === "permission");
    expect(row!.kind === "permission" ? row!.permission : null).toMatchObject({ outcome: "unanswered", optionId: null });
  });

  it("a close for a prompt this transcript never held changes nothing, since history is capped and may start mid-turn", () => {
    const model = deriveSession([...opening, closed({ askId: "ask_gone" })]);
    expect(model.timeline.filter(e => e.kind === "permission")).toEqual([]);
    expect(model.turns).toHaveLength(1);
  });

  it("reaches the timeline rows the chat renders as its own kind, in the order it was raised", () => {
    const model = deriveSession([...opening, ask, closed()]);
    const rows = deriveMessagesTimelineRows({ timelineEntries: model.timeline, turns: model.turns, isWorking: false, activeTurnStartedAt: null });
    expect(rows.filter(r => r.kind === "permission").map(r => r.id)).toEqual(["permission:ask_1"]);
  });
});

describe("deriveSession: a turn refused before it reached a machine", () => {
  const first = { ...scope, turnId: "turn_1" };
  // The runtime's own frame for a send whose turn never opened: a session.end on the bus alone, carrying the
  // sentence the start road refused with, the turn id it had minted and the row id, never a harness session id.
  const refused: SessionEvent = {
    type: "session.end", workspaceId: scope.workspaceId, sessionId: "turn_2", turnId: "turn_2",
    at: 70_000, exitCode: null, sawResult: false, reason: "the harness would not launch",
  };
  // The turn before it: its reply is in but its process has not exited, so the thread still reads as working.
  const working: SessionEvent[] = [
    { type: "session.start", ...first, at: 1_000, prompt: "fan out five agents" },
    { type: "session.delta", ...first, at: 2_000, line: 1, kind: "text", text: "Five agents are running." },
    { type: "session.done", ...first, at: 66_000, result: { status: "failed", error: "Ended with 5 background tasks running", durationMs: 66_000, costUsd: 0.51 } },
  ];

  it("says why in the transcript, as one line carrying the turn that was refused", () => {
    const m = deriveSession([...working, refused]);
    expect(m.workEntries.map(w => [w.turnId, w.label, w.tone])).toEqual([
      ["turn_1", "Ended with 5 background tasks running", "error"],
      ["turn_2", "the harness would not launch", "error"],
    ]);
  });

  it("ends the turn it interrupted: a thread runs one turn at a time, so a newer turn's end says the one before it is over", () => {
    const m = deriveSession([...working, refused]);
    expect(m.running).toBe(false);
    expect(m.turns.map(t => [t.turnId, t.state])).toEqual([["turn_1", "error"]]);
  });

  it("opens no turn of its own: the footer still reads the turn that ran", () => {
    const m = deriveSession([...working, refused]);
    expect(m.latestTurn?.turnId).toBe("turn_1");
    expect(m.latestTurn?.durationMs).toBe(66_000);
  });

  it("an end that says nothing stays a wake for whoever waits on the thread and puts no line in the transcript", () => {
    const quiet: SessionEvent = { ...refused, reason: undefined };
    const m = deriveSession([...working, { type: "session.end", ...first, at: 67_000, exitCode: 0, sawResult: true }, quiet]);
    expect(m.workEntries.map(w => w.label)).toEqual(["Ended with 5 background tasks running"]);
    expect(m.turns.map(t => t.turnId)).toEqual(["turn_1"]);
  });

  // The other road to a turn with no start: the harness ran, answered nothing and exited, so its reply is recorded
  // and its end is a plain one. That turn is a turn, and its reason is the reply's error.
  it("a reply with no start behind it opens its turn and that turn's own rows carry it", () => {
    const second = { ...scope, turnId: "turn_2" };
    const m = deriveSession([
      ...working,
      { type: "session.done", ...second, at: 70_000, result: { status: "failed", error: "claude answered with no output and no usage after 48ms", durationMs: 48, costUsd: 0 } },
      { type: "session.end", ...second, at: 70_050, exitCode: 1, sawResult: true },
    ]);
    expect(m.running).toBe(false);
    expect(m.turns.map(t => [t.turnId, t.state])).toEqual([["turn_1", "error"], ["turn_2", "error"]]);
    expect(m.workEntries.map(w => [w.turnId, w.label])).toEqual([
      ["turn_1", "Ended with 5 background tasks running"],
      ["turn_2", "claude answered with no output and no usage after 48ms"],
    ]);
  });
});

describe("subagents an agent launched inside its own turn", () => {
  const sc = { workspaceId: "ws_t", sessionId: "sess_sub", turnId: "turn_sub" };
  const launch = (id: string, description: string): SessionEvent => ({
    type: "session.delta", ...sc, at: 1_000, kind: "tool_use", toolName: "Agent", toolUseId: id,
    text: JSON.stringify({ description, prompt: "go", subagent_type: "general-purpose" }),
  });
  const child = (parent: string, text: string, at: number): SessionEvent => ({
    type: "session.delta", ...sc, at, kind: "text", text, parentToolUseId: parent,
  });
  const opening: SessionEvent[] = [{ type: "session.start", ...sc, at: 0, prompt: "fan out" }];

  it("gathers two subagents' interleaved lines into two folds, titled by their tasks, and never onto one line", () => {
    const model = deriveSession([
      ...opening,
      { type: "session.delta", ...sc, at: 500, kind: "text", text: "Launching two." },
      launch("toolu_a", "count alpha files"),
      launch("toolu_b", "read beta hostname"),
      // The harness streams both runs on the parent's session, one line from each in turn.
      child("toolu_a", "I'll verify the repo contents myself first.", 1_100),
      child("toolu_b", "Let me check history and search for anything API-shaped.", 1_200),
      child("toolu_a", " Now the listing.", 1_300),
      {
        type: "session.delta", ...sc, at: 1_400, kind: "tool_use", toolName: "Bash", toolUseId: "toolu_a1",
        parentToolUseId: "toolu_a", text: JSON.stringify({ command: "ls /etc" }),
      },
      { type: "session.delta", ...sc, at: 1_500, kind: "tool_result", toolUseId: "toolu_a1", parentToolUseId: "toolu_a", text: "acpi" },
    ]);

    const folds = model.timeline.filter(e => e.kind === "subagent");
    expect(folds).toHaveLength(2);
    const runs = folds.map(f => (f.kind === "subagent" ? f.subagent : null)!);
    expect(runs.map(r => r.title)).toEqual(["count alpha files", "read beta hostname"]);
    expect(runs.map(r => r.parentToolUseId)).toEqual(["toolu_a", "toolu_b"]);
    // Each fold holds only its own agent's lines; nothing from one is glued to the other.
    expect(runs[0]!.lines.map(l => l.label)).toEqual(["I'll verify the repo contents myself first.", " Now the listing.", "$ ls /etc"]);
    expect(runs[1]!.lines.map(l => l.label)).toEqual(["Let me check history and search for anything API-shaped."]);
    // The subagent's own tool call carries what it answered, on the one line that call owns.
    expect(runs[0]!.lines[2]).toMatchObject({ kind: "tool", status: "completed", detail: "acpi" });
    // The parent said one thing, and no child's sentence reached it.
    const said = model.messages.filter(m => m.role === "assistant").map(m => m.text);
    expect(said).toEqual(["Launching two."]);
    for (const text of said) expect(text).not.toContain("I'll verify");
    // Two folds, drawn as two rows in the order they were launched.
    const rows = deriveMessagesTimelineRows({ timelineEntries: model.timeline, turns: model.turns, isWorking: true, activeTurnStartedAt: null });
    expect(rows.filter(r => r.kind === "subagent").map(r => r.id)).toEqual(["subagent:toolu_a", "subagent:toolu_b"]);
  });

  it("shows nobody the note the harness wrote for the agent, and does not end the fold on it", () => {
    const note = "Async agent launched successfully. (This tool result is internal metadata, never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a057760";
    const model = deriveSession([
      ...opening,
      launch("toolu_a", "count alpha files"),
      child("toolu_a", "done", 1_100),
      { type: "session.delta", ...sc, at: 2_000, kind: "tool_result", toolUseId: "toolu_a", text: note },
    ]);
    const run = model.timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []));
    expect(run).toHaveLength(1);
    // The note says the agent was launched, not that it finished, so the fold is still the run's own.
    expect(run[0]!.state).toBe("running");
    expect(run[0]!.endedAt).toBeNull();
    // The note is not a line of the run; a subagent's own answer would have been.
    expect(run[0]!.lines.map(l => l.label)).toEqual(["done"]);
    // The fold's own line says what was launched; the harness's note is nowhere on the screen.
    expect(run[0]!.title).toBe("count alpha files");
    for (const row of [...model.workEntries, ...run[0]!.lines]) {
      expect(JSON.stringify(row)).not.toContain("internal metadata");
      expect(JSON.stringify(row)).not.toContain("agentId");
    }
    expect(JSON.stringify(model.timeline)).not.toContain("internal metadata");
  });

  it("puts a subagent's own answer inside its fold as the run's last line", () => {
    const model = deriveSession([
      ...opening,
      launch("toolu_a", "count alpha files"),
      child("toolu_a", "listing now", 1_100),
      { type: "session.delta", ...sc, at: 2_000, kind: "tool_result", toolUseId: "toolu_a", text: "acpi, adduser.conf, alsa" },
    ]);
    const run = model.timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(run.lines.map(l => l.label)).toEqual(["listing now", "acpi, adduser.conf, alsa"]);
    expect(run.state).toBe("done");
    // The answer stays inside the fold; it is no row of the parent's.
    expect(model.workEntries.some(w => (w.detail ?? "").includes("adduser.conf"))).toBe(false);
  });

  it("ends the fold whatever order the frames come in: a launch answered before its first line still reads done", () => {
    // A capped transcript can start with the answer already on the wire, before the agent's own first line.
    const model = deriveSession([
      ...opening,
      launch("toolu_a", "count alpha files"),
      { type: "session.delta", ...sc, at: 1_050, kind: "tool_result", toolUseId: "toolu_a", text: "18 files under alpha." },
      child("toolu_a", "listing now", 1_100),
      { type: "session.done", ...sc, at: 3_000, result: { status: "completed", durationMs: 3_000 } },
      { type: "session.end", ...sc, at: 3_100, exitCode: 0, sawResult: true },
    ]);
    const run = model.timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(run.state).toBe("done");
    expect(run.endedAt).toBe(new Date(1_050).toISOString());
    expect(run.lines.map(l => l.label)).toEqual(["listing now"]);
  });

  it("keeps a background launch running while its agent writes: the note it answered with is not a finish", () => {
    const note = "Async agent launched successfully. (This tool result is internal metadata, never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a057760";
    // A background launch is answered by the harness's note 80 ms in, and the agent writes for another eight seconds.
    const running: SessionEvent[] = [
      ...opening,
      launch("toolu_a", "check gamma disk"),
      { type: "session.delta", ...sc, at: 1_080, kind: "tool_result", toolUseId: "toolu_a", text: note },
      child("toolu_a", "Reading the mounts.", 4_000),
      child("toolu_a", " Root has 28G free.", 9_000),
    ];
    const mid = deriveSession(running).timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(mid.state).toBe("running");
    expect(mid.endedAt).toBeNull();
    expect(mid.lines.map(l => l.label)).toEqual(["Reading the mounts.", " Root has 28G free."]);
    expect(JSON.stringify(mid)).not.toContain("internal metadata");
    // The turn's own end is what settles it, the way it settles a launch that never answered at all.
    const ended = deriveSession([
      ...running,
      { type: "session.done", ...sc, at: 12_000, result: { status: "completed", durationMs: 12_000 } },
      { type: "session.end", ...sc, at: 12_100, exitCode: 0, sawResult: true },
    ]).timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(ended.state).toBe("stopped");
    expect(ended.endedAt).toBe(new Date(12_000).toISOString());
  });

  it("settles a fold the turn ended under, so a subagent cut off with its turn leaves no slot reading nothing", () => {
    const model = deriveSession([
      ...opening,
      launch("toolu_a", "count alpha files"),
      child("toolu_a", "still going", 1_100),
      { type: "session.done", ...sc, at: 3_000, result: { status: "completed", durationMs: 3_000 } },
      { type: "session.end", ...sc, at: 3_100, exitCode: 0, sawResult: true },
    ]);
    const run = model.timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(run.state).toBe("stopped");
    expect(run.endedAt).not.toBeNull();
  });

  it("keeps a subagent's own prompt inside that subagent's fold, and closes it there", () => {
    const ask: SessionEvent = {
      type: "session.permission", ...sc, at: 1_200, askId: "ask_child", toolName: "Bash",
      toolUseId: "toolu_a1", parentToolUseId: "toolu_a", input: '{"command":"ls /etc"}',
      options: [{ id: "allow", label: "Allow", effect: "allow" }, { id: "deny", label: "Deny", effect: "deny" }],
    };
    const events: SessionEvent[] = [...opening, launch("toolu_a", "count alpha files"), child("toolu_a", "checking", 1_100), ask];
    const open = deriveSession(events);
    // Not a row of its own in the flat stream: it belongs to the agent that raised it.
    expect(open.timeline.filter(e => e.kind === "permission")).toEqual([]);
    const run = open.timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(run.prompts.map(p => p.askId)).toEqual(["ask_child"]);
    expect(run.prompts[0]!.outcome).toBeNull();

    const closed = deriveSession([...events, { type: "session.permission.closed", ...sc, at: 1_300, askId: "ask_child", outcome: "allowed", optionId: "allow" }]);
    const after = closed.timeline.flatMap(e => (e.kind === "subagent" ? [e.subagent] : []))[0]!;
    expect(after.prompts[0]).toMatchObject({ outcome: "allowed", optionId: "allow" });
  });
});
