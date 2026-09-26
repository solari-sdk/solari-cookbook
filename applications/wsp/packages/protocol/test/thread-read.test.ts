// SPDX-License-Identifier: AGPL-3.0-only
// One thread read off a transcript: the rows the fold makes of the events the
// runtime recorded, the result its latest turn ended with, and the printout
// the command line and the tool put in front of a reader.
import { describe, expect, it } from "vitest";
import {
  fmtClock,
  noMessagesLine,
  NEWER_TURN_LINE,
  noReplyLine,
  notifyLine,
  threadReplyRows,
  threadMessages,
  threadReadText,
  threadResult,
  leadAsk,
  openAsk,
  threadRowLines,
  turnEndLine,
  type SessionEvent,
} from "@wsp/protocol";

const SCOPE = { workspaceId: "w1", sessionId: "s1", threadId: "t1" };
const AT = Date.UTC(2026, 8, 9, 5, 5, 12);

/** The events one turn of a scripted thread leaves: the person's message, two pieces of text with a tool call
 * between them, and the reply the harness reported. */
const turn = (prompt: string, text: string, result: Partial<SessionEvent & { type: "session.done" }>["result"] = { status: "completed", text }): SessionEvent[] => [
  { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt },
  { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1_000, kind: "text", text: text.slice(0, 4) },
  { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 2_000, kind: "tool_use", toolName: "Bash", toolUseId: "toolu_1", text: JSON.stringify({ command: "pnpm test" }) },
  { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 3_000, kind: "text", text: text.slice(4) },
  { type: "session.done", ...SCOPE, turnId: "u1", at: AT + 4_000, result: result! },
  { type: "session.end", ...SCOPE, turnId: "u1", at: AT + 5_000, exitCode: 0, sawResult: true },
];

describe("a thread's messages", () => {
  it("folds the transcript into who spoke, when and the text, with the tool call one row between the pieces of the reply", () => {
    const rows = threadMessages(turn("build it", "read the ticket, then built it"), "t1");
    expect(rows).toEqual([
      { who: "person", at: AT, text: "build it" },
      { who: "agent", at: AT + 1_000, text: "read" },
      { who: "tool", at: AT + 2_000, text: "$ pnpm test" },
      { who: "agent", at: AT + 3_000, text: " the ticket, then built it" },
      { who: "turn", at: AT + 4_000, text: "completed" },
    ]);
  });

  it("reads the harness's two messages as two rows: the reply given while a background command ran and the one it was woken for", () => {
    const rows = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "hold for 90 seconds" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1_000, kind: "text", text: "Waiting for the hold to complete.", messageId: "msg_a" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 91_000, kind: "text", text: "Done. ", messageId: "msg_b" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 91_500, kind: "text", text: "It ended with exit code 0.", messageId: "msg_b" },
      ],
      "t1",
    );
    expect(rows).toEqual([
      { who: "person", at: AT, text: "hold for 90 seconds" },
      { who: "agent", at: AT + 1_000, text: "Waiting for the hold to complete." },
      { who: "agent", at: AT + 91_000, text: "Done. It ended with exit code 0." },
    ]);
  });

  it("leaves a harness's note out: a read is the words of a thread, and the note is the harness talking about itself", () => {
    const rows = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "say ready" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1, kind: "note", text: "loading hooks from both files; prefer a single representation for this layer" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 2, kind: "text", text: "ready" },
      ],
      "t1",
    );
    expect(rows).toEqual([
      { who: "person", at: AT, text: "say ready" },
      { who: "agent", at: AT + 2, text: "ready" },
    ]);
  });

  it("keeps the pieces of one message in one row, and text a harness named no message for appends as it always did", () => {
    const pieces = (first: Partial<{ messageId: string }>, second: Partial<{ messageId: string }>): string[] =>
      threadMessages(
        [
          { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "go" },
          { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1, kind: "text", text: "half a ", ...first },
          { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 2, kind: "text", text: "sentence", ...second },
        ],
        "t1",
      )
        .filter(row => row.who === "agent")
        .map(row => row.text);
    expect(pieces({ messageId: "msg_a" }, { messageId: "msg_a" })).toEqual(["half a sentence"]);
    expect(pieces({}, {})).toEqual(["half a sentence"]);
    expect(pieces({}, { messageId: "msg_a" })).toEqual(["half a sentence"]);
  });

  it("reads only the named thread's events, and none of a row the runtime stamped no thread on", () => {
    const other: SessionEvent[] = [
      { type: "session.start", workspaceId: "w1", sessionId: "s2", threadId: "t2", at: AT, prompt: "someone else's task" },
      { type: "session.start", workspaceId: "w1", sessionId: "s3", at: AT, prompt: "a turn from before the stamp" },
    ];
    expect(threadMessages([...other, ...turn("mine", "done")], "t1").map(r => r.text)).toEqual(["mine", "done", "$ pnpm test", "completed"]);
    expect(threadMessages(other, "t1")).toEqual([]);
  });

  it("keeps a call whose input arrives in pieces as one row and draws its line from the whole of it", () => {
    const rows = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "edit it" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1, kind: "tool_use", toolName: "Edit", toolUseId: "toolu_1", text: '{"file_path":"packages/host' },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 2, kind: "tool_use", toolUseId: "toolu_1", text: '/src/verbs.ts"}' },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 3, kind: "tool_result", toolUseId: "toolu_1", text: "ok" },
      ],
      "t1",
    );
    expect(rows).toEqual([
      { who: "person", at: AT, text: "edit it" },
      { who: "tool", at: AT + 1, text: "edited packages/host/src/verbs.ts" },
    ]);
  });

  it("holds a call in the present until its result lands, so a read of a write nobody has allowed never says it happened", () => {
    const events = [
      { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "write it" },
      { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1, kind: "tool_use", toolName: "Write", toolUseId: "toolu_1", text: JSON.stringify({ file_path: "kai.txt" }) },
    ] as const;
    expect(threadMessages([...events], "t1").map(row => row.text)).toEqual(["write it", "writing kai.txt"]);
    const answered = threadMessages([...events, { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 2, kind: "tool_result", toolUseId: "toolu_1", text: "File created successfully at: kai.txt" }], "t1");
    expect(answered.map(row => row.text)).toEqual(["write it", "wrote kai.txt"]);
  });

  it("gives a call the harness named no id for a row of its own, and never runs a new turn's words into the turn before it", () => {
    const rows = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "look around" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1, kind: "tool_use", toolName: "Bash", text: JSON.stringify({ command: "ls" }) },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 2, kind: "tool_use", toolName: "Bash", text: JSON.stringify({ command: "pwd" }) },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 3, kind: "text", text: "here we are" },
        // The turn was cut without a done or an end, as a capped transcript leaves one; the next turn opens anyway.
        { type: "session.start", ...SCOPE, turnId: "u2", at: AT + 4 },
        { type: "session.delta", ...SCOPE, turnId: "u2", at: AT + 5, kind: "text", text: "starting over" },
      ],
      "t1",
    );
    expect(rows.map(row => [row.who, row.text])).toEqual([
      ["person", "look around"],
      ["tool", "$ ls"],
      ["tool", "$ pwd"],
      ["agent", "here we are"],
      ["agent", "starting over"],
    ]);
  });

  it("takes the reply from the result where no text arrived, which is a transcript capped mid-turn or a harness that reports the message at the end alone", () => {
    const rows = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "build it" },
        { type: "session.done", ...SCOPE, turnId: "u1", at: AT + 1_000, result: { status: "completed", text: "built it", durationMs: 724_000, costUsd: 0.41 } },
      ],
      "t1",
    );
    expect(rows).toEqual([
      { who: "person", at: AT, text: "build it" },
      { who: "agent", at: AT + 1_000, text: "built it" },
      { who: "turn", at: AT + 1_000, text: "completed  Worked for 12m 4s  $0.41" },
    ]);
  });

  it("says why a turn did not complete on its turn row, and says so too for a turn the runtime ended with no result of its own", () => {
    const failed = threadMessages(turn("cut", "", { status: "failed", error: "stopped after 15m 00s with no output for 10m" }), "t1");
    expect(failed.at(-1)).toEqual({ who: "turn", at: AT + 4_000, text: "failed: stopped after 15m 00s with no output for 10m" });
    const napped = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "loop forever" },
        { type: "session.end", ...SCOPE, turnId: "u1", at: AT + 9_000, exitCode: null, sawResult: false, reason: "machine paused while the agent was working" },
      ],
      "t1",
    );
    expect(napped.at(-1)).toEqual({ who: "turn", at: AT + 9_000, text: "failed: machine paused while the agent was working" });
    const quiet = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "loop forever" },
        { type: "session.end", ...SCOPE, turnId: "u1", at: AT + 1, exitCode: null, sawResult: false },
      ],
      "t1",
    );
    expect(quiet.at(-1)!.text).toBe("failed: turn ended without a result");
  });

  it("puts a message steered into a running turn where the turn saw it, as a person's", () => {
    const steered = threadMessages(
      [
        { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "build it" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 1, kind: "text", text: "on it" },
        { type: "session.steer", ...SCOPE, turnId: "u1", at: AT + 2, prompt: "also the codex case" },
        { type: "session.delta", ...SCOPE, turnId: "u1", at: AT + 3, kind: "text", text: "that too" },
      ],
      "t1",
    );
    expect(steered.map(r => [r.who, r.text])).toEqual([
      ["person", "build it"],
      ["agent", "on it"],
      ["person", "also the codex case"],
      ["agent", "that too"],
    ]);
  });
});

describe("a thread's latest turn and its final reply", () => {
  it("is the done's result, and the reply is the whole final message the thread's finished line carries", () => {
    const events = turn("build it", "green\nbuilt it", { status: "completed", text: "green\nbuilt it", durationMs: 724_000, costUsd: 0.41 });
    const result = threadResult(events, "t1")!;
    expect(result).toEqual({ status: "completed", text: "green\nbuilt it", durationMs: 724_000, costUsd: 0.41 });
    // The reply's clock is the row the result came off, the done, not the end that may follow it by minutes.
    expect(threadReplyRows(events, "t1")).toEqual([{ who: "agent", at: AT + 4_000, text: "green\nbuilt it" }]);
    // The one rule: the wait's line for the same turn ends on the same message, whole.
    expect(notifyLine("t1", result, "whole")).toContain("green\nbuilt it");
  });

  it("is failed with the runtime's reason where the runtime ended the turn, and the reply says that instead", () => {
    const events: SessionEvent[] = [
      { type: "session.start", ...SCOPE, turnId: "u1", at: AT, prompt: "loop forever" },
      { type: "session.end", ...SCOPE, turnId: "u1", at: AT + 1, exitCode: null, sawResult: false, reason: "machine paused while the agent was working" },
    ];
    expect(threadResult(events, "t1")).toEqual({ status: "failed", error: "machine paused while the agent was working" });
    expect(threadReplyRows(events, "t1")).toEqual([{ who: "turn", at: AT + 1, text: "machine paused while the agent was working" }]);
  });

  it("is nothing when the transcript holds no turn of the thread, which a caller answers with the thread's own row", () => {
    expect(threadResult(turn("build it", "done"), "t2")).toBeUndefined();
    expect(threadReplyRows(turn("build it", "done"), "t2")).toEqual([]);
  });

  it("never hands a footer or an error back under the agent's name: a completed turn that left no text is the turn's own row", () => {
    // The Claude CLI answers a completed turn with an empty message where it spent its tokens and said nothing.
    const quiet = turn("build it", "", { status: "completed", text: "", durationMs: 724_000, costUsd: 0.41 });
    expect(threadReplyRows(quiet, "t1")).toEqual([{ who: "turn", at: AT + 4_000, text: "completed  Worked for 12m 4s  $0.41" }]);
    // The words of a turn that did not complete are the agent's where the harness left any and the runtime's error
    // where it did not, and each row says which.
    const cut = turn("build it", "", { status: "interrupted", text: "got half of it" });
    expect(threadReplyRows(cut, "t1")).toEqual([{ who: "agent", at: AT + 4_000, text: "got half of it" }]);
    const failed = turn("build it", "", { status: "failed", text: "got half of it", error: "the harness died" });
    expect(threadReplyRows(failed, "t1")).toEqual([{ who: "turn", at: AT + 4_000, text: "the harness died" }]);
  });

  it("says under the reply when the thread has started another turn since, so a stale report is never read as the new one", () => {
    const events: SessionEvent[] = [
      ...turn("first", "the old report"),
      { type: "session.start", ...SCOPE, turnId: "u2", at: AT + 6_000, prompt: "again" },
      { type: "session.delta", ...SCOPE, turnId: "u2", at: AT + 7_000, kind: "text", text: "on it" },
    ];
    expect(threadReplyRows(events, "t1")).toEqual([
      { who: "agent", at: AT + 4_000, text: "the old report" },
      { who: "turn", text: NEWER_TURN_LINE },
    ]);
    // The turn that gave the reply is the newest ended one either way; the note is the only thing the newer turn adds.
    expect(threadResult(events, "t1")!.text).toBe("the old report");
    // A thread whose turn replied and whose agent process has not exited yet has started nothing newer, so no note.
    expect(threadReplyRows(events.slice(0, 5), "t1")).toEqual([{ who: "agent", at: AT + 4_000, text: "the old report" }]);
  });

  it("takes the newest turn, not an older turn's done", () => {
    const events: SessionEvent[] = [
      ...turn("first", "first done"),
      { type: "session.start", ...SCOPE, turnId: "u2", at: AT + 6_000, prompt: "again" },
      { type: "session.done", ...SCOPE, turnId: "u2", at: AT + 7_000, result: { status: "completed", text: "second done" } },
      { type: "session.end", ...SCOPE, turnId: "u2", at: AT + 8_000, exitCode: 0, sawResult: true },
    ];
    expect(threadResult(events, "t1")!.text).toBe("second done");
  });
});

describe("the printout a reader sees", () => {
  it("is who and the clock on one line and the text under it, a blank line between rows", () => {
    const rows = threadMessages(turn("build it", "read the ticket, then built it"), "t1");
    expect(threadReadText(rows).split("\n")).toEqual([
      `person ${fmtClock(AT)}`,
      "build it",
      "",
      `agent ${fmtClock(AT + 1_000)}`,
      "read",
      "",
      `tool ${fmtClock(AT + 2_000)}`,
      "$ pnpm test",
      "",
      `agent ${fmtClock(AT + 3_000)}`,
      " the ticket, then built it",
      "",
      `turn ${fmtClock(AT + 4_000)}`,
      "completed",
    ]);
  });

  it("prints a reply of many lines as the agent wrote it, and a row the runtime stamped no time on as who alone", () => {
    expect(threadRowLines({ who: "agent", at: AT, text: "green\nbuilt it" })).toEqual([`agent ${fmtClock(AT)}`, "green", "built it"]);
    expect(threadRowLines({ who: "person", text: "no clock" })).toEqual(["person", "no clock"]);
  });

  it("reads the clock to the second in the zone of the computer reading it, and nothing at all with no time", () => {
    expect(fmtClock(AT)).toBe(new Date(AT).toTimeString().slice(0, 8));
    expect(fmtClock(AT)).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(fmtClock(undefined)).toBe("");
  });

  it("says which silence it is: no message in the transcript, or a thread that has not replied", () => {
    expect(noMessagesLine("1a2b3c4d-0000")).toBe("thread 1a2b3c4d has no messages in the transcript this host holds");
    expect(noReplyLine("1a2b3c4d-0000")).toBe("thread 1a2b3c4d has not replied yet");
  });

  it("ends a turn's row on the footer the chat shows, with the reason where it did not complete", () => {
    expect(turnEndLine({ status: "completed", durationMs: 724_000, costUsd: 0.41 })).toBe("completed  Worked for 12m 4s  $0.41");
    expect(turnEndLine({ status: "interrupted" })).toBe("interrupted");
    expect(turnEndLine({ status: "failed", error: "the harness died" })).toBe("failed: the harness died");
  });
});

describe("the prompt a thread is stopped on", () => {
  const ask = (askId: string, command: string): SessionEvent => ({
    type: "session.permission",
    ...SCOPE,
    turnId: "u1",
    at: AT,
    askId,
    toolName: "Bash",
    input: JSON.stringify({ command }),
    options: [{ id: "allow", label: "Allow", effect: "allow" }],
  });
  const closed = (askId: string): SessionEvent => ({ type: "session.permission.closed", ...SCOPE, turnId: "u1", at: AT + 1, askId, outcome: "allowed" });

  it("is the oldest ask with no close behind it, the one the harness stopped at, and nothing once every ask was answered", () => {
    expect(openAsk([], "t1")).toBeUndefined();
    expect(openAsk([ask("a1", "ls")], "t1")).toMatchObject({ askId: "a1" });
    expect(openAsk([ask("a1", "ls"), closed("a1")], "t1")).toBeUndefined();
    expect(openAsk([ask("a1", "ls"), closed("a1"), ask("a2", "rm -rf x")], "t1")).toMatchObject({ askId: "a2" });
    // Two open at once: the older leads, which is what the runtime leads the thread's row with.
    expect(openAsk([ask("a1", "ls"), ask("a2", "rm -rf x")], "t1")).toMatchObject({ askId: "a1" });
    expect(leadAsk([])).toBeUndefined();
  });

  it("is read per thread: an ask open on another thread is not this one's", () => {
    const elsewhere = { ...ask("a1", "ls"), threadId: "t2" } as SessionEvent;
    expect(openAsk([elsewhere], "t1")).toBeUndefined();
    expect(openAsk([elsewhere], "t2")).toMatchObject({ askId: "a1" });
  });
});
