// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.logic.test.ts at 57a66608 (MIT).
// Differs from upstream: the derive cases moved with the derivation to the adapter, stable-rows cases build rows through the adapter, one preview case is added, and the compact-label cases moved to work-log/presentation.test.ts.
import { describe, expect, it } from "vitest";
import {
  deriveMessagesTimelineRows,
  type ChatMessage,
  type TimelineEntry,
  type TurnSummary,
  type WorkLogEntry,
} from "./adapt";
import {
  computeStableMessagesTimelineRows,
  liveWorkEntryLabel,
  resolveAssistantMessageCopyState,
  resolveWorkGroupScrollIndex,
  shouldFollowWorkGroupAppend,
  shouldPreserveAssistantLineBreaks,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("expanded tool group scrolling", () => {
  const entries = [{ id: "first" }, { id: "second" }];

  it("follows appended calls only at the hard end", () => {
    const appended = [...entries, { id: "third" }];
    expect(shouldFollowWorkGroupAppend(entries, appended, 0)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, appended, 0.5)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, appended, 1)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, appended, 1.01)).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, appended, 10)).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, appended, Infinity)).toBe(false);
  });

  it("does not follow output updates, prepends, or replacements", () => {
    expect(
      shouldFollowWorkGroupAppend(
        entries,
        entries.map((entry) => ({ ...entry })),
        0,
      ),
    ).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, [{ id: "older" }, ...entries], 0)).toBe(false);
    expect(
      shouldFollowWorkGroupAppend(
        entries,
        [{ id: "replacement" }, entries[1]!, { id: "third" }],
        0,
      ),
    ).toBe(false);
    expect(shouldFollowWorkGroupAppend([], entries, 0)).toBe(false);
  });

  it("restores the visible tool and its offset inside expanded output", () => {
    const anchor = { entryId: "second", offset: 120 };
    expect(resolveWorkGroupScrollIndex(entries, anchor)).toEqual({ index: 1, viewOffset: -120 });
    expect(resolveWorkGroupScrollIndex([{ id: "older" }, ...entries], anchor)).toEqual({
      index: 2,
      viewOffset: -120,
    });
  });

  it("starts normally when the saved tool no longer exists", () => {
    expect(resolveWorkGroupScrollIndex(entries, undefined)).toBeUndefined();
    expect(
      resolveWorkGroupScrollIndex(entries, { entryId: "removed", offset: 120 }),
    ).toBeUndefined();
  });
});

describe("work entry labels", () => {
  const entry: WorkLogEntry = {
    id: "tool-1",
    createdAt: "2026-09-01T12:00:00Z",
    turnId: "turn-1",
    label: "Tool call",
    tone: "tool",
    sourceActivityKind: "tool.completed",
  };

  it("keeps custom titles and output for unrecognized tools", () => {
    const unknownEntry = { ...entry, toolTitle: "mcp__github__search_issues" };
    expect(liveWorkEntryLabel(unknownEntry, undefined, true)).toEqual(
      { verb: null, text: "Mcp__github__search_issues", mono: false },
    );
    expect(workEntryDisplayLabel({ ...unknownEntry, detail: "Found 3 issues" }, undefined)).toEqual(
      { verb: null, text: "Found 3 issues", mono: false },
    );
  });

  it("shows the whole command line in mono, with the state word only on the live row", () => {
    const commandEntry = { ...entry, command: "git status", detail: "On branch main" };
    expect(liveWorkEntryLabel(commandEntry, undefined, true)).toEqual({ verb: "Running", text: "git status", mono: true });
    expect(liveWorkEntryLabel(commandEntry, undefined, false)).toEqual({ verb: "Ran", text: "git status", mono: true });
    expect(workEntryDisplayLabel(commandEntry, undefined)).toEqual({ verb: null, text: "git status", mono: true });
  });

  it("shows a multi-line command's first line and leaves the rest to the expanded body", () => {
    const commandEntry = { ...entry, command: "  git   status\ngit diff --stat\n" };
    expect(liveWorkEntryLabel(commandEntry, undefined, false)).toEqual({ verb: "Ran", text: "git status", mono: true });
    expect(workEntryDisplayLabel(commandEntry, undefined)).toEqual({ verb: null, text: "git status", mono: true });
  });

  it("shows the harness's description alone: it carries its own verb", () => {
    const commandEntry = { ...entry, command: "git status", description: "Show working tree status", detail: "On branch main" };
    const label = { verb: null, text: "Show working tree status", mono: false };
    expect(liveWorkEntryLabel(commandEntry, undefined, true)).toEqual(label);
    expect(liveWorkEntryLabel({ ...commandEntry, toolLifecycleStatus: "failed" }, undefined, false)).toEqual(label);
    expect(workEntryDisplayLabel(commandEntry, undefined)).toEqual(label);
  });

  it.each([
    ["inProgress", "Running"],
    ["completed", "Ran"],
    ["failed", "Failed"],
    ["declined", "Declined"],
    ["stopped", "Stopped"],
  ] as const)(
    "uses the command's %s outcome even while the turn continues",
    (toolLifecycleStatus, verb) => {
      const commandEntry = {
        ...entry,
        command: "/bin/bash -lc 'vp test run'",
        toolLifecycleStatus,
      };
      const label = { verb, text: "/bin/bash -lc 'vp test run'", mono: true };
      expect(liveWorkEntryLabel(commandEntry, undefined, true)).toEqual(label);
      expect(liveWorkEntryLabel(commandEntry, undefined, false)).toEqual(label);
    },
  );

  it("renders a row's preview as its label ahead of its detail", () => {
    const reasoningEntry: WorkLogEntry = {
      ...entry,
      label: "Thinking",
      tone: "thinking",
      sourceActivityKind: "reasoning",
      detail: "The failing test imports the old module.\nI should repoint it.",
      preview: "The failing test imports the old module.",
    };
    const label = { verb: null, text: "The failing test imports the old module.", mono: false };
    expect(workEntryDisplayLabel(reasoningEntry, undefined)).toEqual(label);
    expect(liveWorkEntryLabel(reasoningEntry, undefined, false)).toEqual(label);
  });
});

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves insight block formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("computeStableMessagesTimelineRows", () => {
  const userMessageEntry = (id: string, text: string, createdAt: string): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: { id, role: "user", text, turnId: null, streaming: false, createdAt, updatedAt: createdAt },
  });

  it.each(["", " \n"])("keeps Thinking after assistant content grows from %j", (text) => {
    const startedAt = "2026-01-01T00:00:00Z";
    const turnId = "turn-1";
    const runningTurn: TurnSummary = {
      turnId,
      sessionId: "session-1",
      state: "running",
      replied: false,
      prompt: null,
      model: null,
      durationMs: null,
      waitedMs: null,
      costUsd: null,
      error: null,
      startedAt,
      completedAt: null,
    };
    const input = {
      turns: [runningTurn],
      isWorking: true,
      activeTurnStartedAt: startedAt,
    };
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text,
      turnId,
      createdAt: startedAt,
      updatedAt: startedAt,
      streaming: true,
    };
    const assistantEntry: TimelineEntry = {
      id: "assistant-entry",
      kind: "message",
      createdAt: startedAt,
      message,
    };
    const initial = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({ ...input, timelineEntries: [assistantEntry] }),
      { byId: new Map(), result: [] },
    );
    const updated = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: [
          {
            ...assistantEntry,
            message: { ...message, text: "I will inspect the repository." },
          },
        ],
      }),
      initial,
    );

    const initialThinking = initial.byId.get("live-activity-row");
    const updatedThinking = updated.byId.get("live-activity-row");
    expect(initialThinking).toMatchObject({ kind: "thinking" });
    expect(updatedThinking).toBe(initialThinking);
    expect(updated.result.at(-1)).toBe(updatedThinking);
  });

  it("returns the previous result when row order and content are unchanged", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userMessageEntry("user-1", "First", "2026-01-01T00:00:00Z"),
        userMessageEntry("user-2", "Second", "2026-01-01T00:00:10Z"),
      ],
      turns: [],
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry: WorkLogEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      turnId: null,
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking",
      sourceActivityKind: "reasoning",
    };
    const secondWorkEntry: WorkLogEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      turnId: null,
      label: "read",
      detail: "Reading package.json",
      tone: "tool",
      toolLifecycleStatus: "completed",
      sourceActivityKind: "tool.completed",
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        turns: [],
        expandedWorkGroupIds: new Set(["work-group:entry-work-1"]),
        isWorking: false,
        activeTurnStartedAt: null,
      });

    const firstRows = createRows();
    expect(firstRows.map((row) => row.kind)).toEqual(["work-toggle", "work"]);
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);
    expect(secondRows[1]).not.toBe(firstRows[1]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
    expect(repeated.result[1]).toBe(initial.result[1]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        userMessageEntry("user-1", "First", "2026-01-01T00:00:00Z"),
        userMessageEntry("user-2", "Second", "2026-01-01T00:00:10Z"),
      ],
      turns: [],
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
