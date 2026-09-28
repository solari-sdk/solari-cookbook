// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.test.tsx at 57a66608 (MIT).
// Differs from upstream: the XSS probe global is __xss instead of the branded name; cases for removed features are dropped.
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import type { ImageRecord, SessionEvent } from "@wsp/protocol";
import { MessagesTimeline, WORK_TONES } from "./MessagesTimeline";
import { deriveSession, type TimelineEntry, type TurnSummary, type WorkLogEntry, type WorkLogTone } from "./adapt";
import { imageFactsOf, imageOf, useComposerImagesStore } from "./composerImages";

// jsdom has no object URLs; a thumbnail only needs one string per image.
URL.createObjectURL = (): string => "blob:wsp/1";
URL.revokeObjectURL = (): void => {};

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
    };
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    ref?: Ref<LegendListRef>;
  }) => {
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    turns: [],
    turnDiffSummaryByAssistantMessageId: new Map(),
    threadKey: "thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildTurn(
  turnId: string,
  state: TurnSummary["state"],
  startedAt: string | null,
  completedAt: string | null,
): TurnSummary {
  return {
    turnId,
    sessionId: "session-1",
    state,
    replied: state !== "running",
    prompt: null,
    model: null,
    durationMs: null,
    waitedMs: null,
    costUsd: null,
    error: null,
    startedAt,
    completedAt,
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "message-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-1",
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

/** A person's message that carried images: the runtime's records, and the request id whichever client made the send
 * still holds their bytes under. */
function buildUserTimelineEntryWithImages(text: string, attachments: ImageRecord[], requestId?: string) {
  const entry = buildUserTimelineEntry(text);
  return { ...entry, message: { ...entry.message, attachments, ...(requestId !== undefined ? { requestId } : {}) } };
}

function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders elapsed time for a completed turn", () => {
    const turnId = "turn-with-fold";
    const assistantEntry = buildAssistantTimelineEntry("Done.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        turns={[
          buildTurn(turnId, "completed", "2026-03-17T19:12:20.000Z", "2026-03-17T19:12:28.000Z"),
        ]}
        timelineEntries={[
          {
            id: "work-entry-with-fold",
            kind: "work",
            createdAt: "2026-03-17T19:12:22.000Z",
            entry: {
              id: "work-with-fold",
              createdAt: "2026-03-17T19:12:22.000Z",
              turnId,
              label: "Ran command",
              tone: "tool",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            ...assistantEntry,
            message: { ...assistantEntry.message, turnId },
          },
        ]}
      />,
    );

    expect(markup).toContain("Worked for 8.0s");
  });

  it("draws the settled turn's facts on the last reply's row, beside its time", () => {
    const turnId = "turn-with-meta";
    const assistantEntry = buildAssistantTimelineEntry("Done.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        turns={[buildTurn(turnId, "completed", "2026-03-17T19:12:20.000Z", "2026-03-17T19:12:28.000Z")]}
        timelineEntries={[{ ...assistantEntry, message: { ...assistantEntry.message, turnId } }]}
        replyMeta={<span data-reply-meta>$0.47</span>}
      />,
    );
    const row = markup.slice(markup.lastIndexOf("group-hover/assistant:opacity-100"));
    expect(row.indexOf("data-reply-meta")).toBeGreaterThan(0);
    expect(row.indexOf("data-reply-meta")).toBeLessThan(row.indexOf("</div>"));
  });

  it("keeps assistant changed-files headers sticky below the thread header", () => {
    const assistantMessageId = "message-assistant-with-files";
    const turnId = "turn-with-files";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        turns={[buildTurn(turnId, "completed", MESSAGE_CREATED_AT, MESSAGE_CREATED_AT)]}
        timelineEntries={[
          {
            id: assistantMessageId,
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the fixture.",
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                checkpointTurnCount: 1,
                checkpointRef: "checkpoint-with-files",
                status: "ready" as const,
                files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
                assistantMessageId,
                completedAt: MESSAGE_CREATED_AT,
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("sticky top-2 z-10");
    expect(markup).not.toContain("self-start");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("!size-[22px]");
    expect(markup).toContain("size-3");
    expect(markup).toContain('aria-label="Collapse all folders"');
    expect(markup).toContain('aria-label="Open diff"');
    expect(markup).toContain("1 changed file");
  });

  it("treats only the strict list end as the live edge", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
    // Within the pixel band above the content bottom counts as the end...
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 1170,
        scrollLength: 800,
      }),
    ).toBe(true);
    // ...but half a viewport up (LegendList's isNearEnd territory) does not.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 900,
        scrollLength: 800,
      }),
    ).toBe(false);
    // The composer inset is part of contentLength and must not count as
    // distance-to-end.
    expect(
      resolveTimelineIsAtEnd(
        { isAtEnd: false, contentLength: 2100, scroll: 1170, scrollLength: 800 },
        100,
      ),
    ).toBe(true);
    // Geometry missing (older state shape): fall back to the strict flag.
    expect(resolveTimelineIsAtEnd({ isAtEnd: false })).toBe(false);

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);

    // No usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(792)).toBe(0);
    // Partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14);
    // Full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(1400)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(0)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0);

    // The collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40);
    expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe("22rem");
  });

  it("keeps reserved end space when tool work starts while reading history", () => {
    const turnId = "turn-with-active-tool";
    const firstEntry = buildUserTimelineEntry("Run the command.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        anchorMessageId={firstEntry.message.id}
        liveFollowEnabled={false}
        timelineEntries={[
          firstEntry,
          {
            id: "entry-active-tool",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-active-tool",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-active-tool",
              label: "Run command",
              tone: "tool",
              itemType: "command_execution",
              command: "git status",
              toolLifecycleStatus: "inProgress",
              sourceActivityKind: "tool.started",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-anchor-index="0"');
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  it("hands end-following back to the list once the send anchor is released", () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "message-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: "message-2",
      },
    };
    const timelineEntries = [firstEntry, secondEntry];

    // While the send anchor holds the end space open, ChatView owns streaming
    // scrolls and LegendList must not re-pin behind it.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={firstEntry.message.id}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');

    // Dropping the anchor is what actually gives end-following back, so
    // returning to the live edge has to release it — re-enabling live follow
    // alone leaves nothing pinned to the stream.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          timelineEntries={timelineEntries}
        />,
      ),
    ).toContain('data-maintain-scroll-at-end="enabled"');

    // Reading history still wins over both.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          liveFollowEnabled={false}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  it("renders collapse controls for long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("marks a steered user message with the muted mono word and nothing else; a plain one carries no mark", () => {
    const entry = buildUserTimelineEntry("when it ends, say pineapple");
    const steered = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[{ ...entry, message: { ...entry.message, steered: true } }]} />,
    );
    expect(steered).toContain('data-user-message-steered="true"');
    expect(steered).toMatch(/font-mono[^>]*>steered</);
    expect(steered).not.toContain("role=\"status\"");
    const plain = renderToStaticMarkup(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);
    expect(plain).not.toContain("steered");
  });

  it("does not render collapse controls for short user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
    expect(markup).toContain("rounded-2xl bg-message p-3");
  });

  it("preserves arbitrary XML-like tags and comparisons in rendered user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Without reading a file, do you have <global-agent-instructions scope="workspace">',
              'Before <nested data-value="a&b">inside</nested> after',
              "</global-agent-instructions> in your context?",
              "Comparison: 2 < 3 and 5 > 4.",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;global-agent-instructions scope=&quot;workspace&quot;&gt;");
    expect(markup).toContain(
      "Before &lt;nested data-value=&quot;a&amp;b&quot;&gt;inside&lt;/nested&gt; after",
    );
    expect(markup).toContain("&lt;/global-agent-instructions&gt; in your context?");
    expect(markup).toContain("Comparison: 2 &lt; 3 and 5 &gt; 4.");
  });

  it("preserves XML-like source inside user code spans and fences", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Inline `<tag attr="x">`',
              "",
              "```xml",
              '<root><child enabled="true" /></root>',
              "```",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;tag attr=&quot;x&quot;&gt;");
    expect(markup).toContain("&lt;root&gt;&lt;child enabled=&quot;true&quot; /&gt;&lt;/root&gt;");
  });

  it("renders unsafe user HTML as inert source text", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '<script>globalThis.__xss = 1</script><img src="x" onerror="globalThis.__xss = 2">',
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;script&gt;globalThis.__xss = 1&lt;/script&gt;");
    expect(markup).toContain(
      "&lt;img src=&quot;x&quot; onerror=&quot;globalThis.__xss = 2&quot;&gt;",
    );
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toMatch(/<img(?:\s|>)/i);
  });

  it("sanitizes executable HTML while preserving supported assistant markup", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry(
            [
              '<details open onclick="globalThis.__xss = 1">',
              "<summary>Safe details</summary>",
              "<script>globalThis.__xss = 2</script>",
              '<img src="x" onerror="globalThis.__xss = 3">',
              '<a href="javascript:globalThis.__xss = 4">Unsafe link</a>',
              "</details>",
            ].join(""),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Safe details");
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toContain("onclick=");
    expect(markup).not.toContain("onerror=");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("globalThis.__xss");
  });

  it("keeps the copy button for collapsed long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("summarizes changed files in one line", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/repo/apps/web/src/session-logic.ts"],
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/repo"
      />,
    );

    expect(markup).toContain("Changed 1 file");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/repo/apps/web/src/session-logic.ts");
  });

  it("keeps mixed-success tool groups neutral", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: null,
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands");
    expect(markup).not.toContain('aria-label="Tool call failed"');
  });

  it("keeps the collapsed summary icon neutral when the group ends in a failure", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: null,
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands");
    expect(markup).toContain("lucide-terminal");
    expect(markup).not.toContain("lucide-x");
    expect(markup).not.toContain("text-destructive");
    // The failure stays discoverable for screen readers.
    expect(markup).toContain("tool call failed");
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: null,
              label: "Status updated",
              tone: "notice",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId: null,
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands and received 1 update");
    expect(markup).not.toContain('aria-label="Hidden work includes a failure"');
  });

  it("shows the animated one-line label for a live tool group", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[
          {
            id: "entry-live",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-live",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-live",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
              sourceActivityKind: "tool.started",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Working for");
    expect(markup).toContain('Running <span class="font-mono">pnpm test</span>');
    expect(markup).toContain("live-activity-focus");
  });

  const promptEntry = (id: string, turnId: string, outcome: "allowed" | null): TimelineEntry => ({
    id,
    kind: "permission",
    createdAt: MESSAGE_CREATED_AT,
    permission: {
      askId: `ask-${id}`,
      turnId,
      sessionId: "session-1",
      toolName: "Write",
      input: JSON.stringify({ file_path: "/tmp/hello.txt", content: "banana" }),
      options: [{ id: "allow", label: "Allow", effect: "allow" }],
      createdAt: MESSAGE_CREATED_AT,
      outcome,
      optionId: outcome === null ? null : "allow",
    },
  });

  it.each([
    ["answered", "Working for", "allowed" as const],
    ["open", "Waiting for you", null],
  ])("counts the time under an %s prompt as %s", (_state, lead, outcome) => {
    const turnId = "turn-asking";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[promptEntry("entry-permission", turnId, outcome)]}
      />,
    );

    // The elapsed count says what the thread is doing: an open prompt is time the person has kept it waiting,
    // and the turn is stopped on the question rather than working.
    expect(markup).toContain(lead);
    expect(markup).not.toContain(lead === "Working for" ? "Waiting for you" : "Working for");
  });

  it("counts a working turn as working while an older turn's prompt is still drawn open", () => {
    // A host that restarted while a prompt stood open leaves that prompt in the transcript with no outcome on it:
    // the runtime cuts the row short at load and records nothing that closes the question. The row's own word reads
    // the latest turn and says Working, so the counter has to read that turn's prompts and no others.
    const settled = "turn-cut";
    const running = "turn-now";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(settled, "completed", MESSAGE_CREATED_AT, MESSAGE_CREATED_AT), buildTurn(running, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[promptEntry("entry-cut", settled, null)]}
      />,
    );

    expect(markup).toContain("Working for");
    expect(markup).not.toContain("Waiting for you");
  });

  it("scopes a live row failure to the tool named by the row", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-failed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-failed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-running",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-running",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-running",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
              sourceActivityKind: "tool.started",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('Running <span class="font-mono">pnpm test</span>');
    expect(markup).not.toContain("tool call failed");
  });

  it("renders initial thinking as the shared live activity row", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain("Thinking");
    expect(markup).toContain("lucide-brain");
    expect(markup).toContain('data-timeline-row-id="live-activity-row"');
  });

  it("keeps the completed command in the shared activity row with a past-tense label", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-completed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-completed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('Ran <span class="font-mono">pnpm lint</span>');
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("live-activity-focus");
    expect(markup).not.toContain("Running ");
    expect(markup).not.toContain("Thinking");
    expect(markup).not.toContain('data-timeline-row-kind="thinking"');
  });

  it("labels a command row with its whole first line in mono, or with the harness's description in prose", () => {
    const turnId = "turn-live";
    const commandEntry = (id: string, command: string, description?: string): TimelineEntry => ({
      id: `entry-${id}`,
      kind: "work",
      createdAt: MESSAGE_CREATED_AT,
      entry: {
        id: `work-${id}`,
        createdAt: MESSAGE_CREATED_AT,
        turnId,
        toolCallId: `call-${id}`,
        label: "Bash",
        tone: "tool",
        itemType: "command_execution",
        command,
        ...(description !== undefined ? { description } : {}),
        toolLifecycleStatus: "completed",
        sourceActivityKind: "tool.completed",
      },
    });
    const renderLive = (entry: TimelineEntry) =>
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          isWorking
          activeTurnStartedAt={MESSAGE_CREATED_AT}
          turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
          timelineEntries={[entry]}
        />,
      );

    const plain = renderLive(commandEntry("status", "cd /repo && git status"));
    expect(plain).toContain('Ran <span class="font-mono">cd /repo &amp;&amp; git status</span>');
    expect(plain).not.toContain("Ran cd<");

    const described = renderLive(commandEntry("described", "cd /repo && git status", "Show working tree status"));
    expect(described).toContain("<span>Show working tree status</span>");
    expect(described).not.toContain("Ran ");
    expect(described).not.toContain("font-mono");
  });

  it("keeps failed lifecycle entries discoverable in mixed activity summaries", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              turnId: null,
              label: "Status updated",
              tone: "notice",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Received 1 update and used 1 tool, tool call failed"');
    // Ordinary tool failures render muted, not red.
    expect(markup).not.toContain("text-destructive");
  });

  it("keeps the red treatment for severe orchestration failures", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              turnId: null,
              label: "Status updated",
              tone: "notice",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-turn-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-turn-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Provider turn start failed",
              tone: "error",
              sourceActivityKind: "runtime.error",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain("text-destructive");
  });

  it("groups settled tool calls behind a toggle row and renders assistant markdown", async () => {
    const userEntry = buildUserTimelineEntry("List the files.");
    const assistantBase = buildAssistantTimelineEntry(
      ["Here is the listing helper:", "", "```ts", "const answer = 42;", "```"].join("\n"),
    );
    const assistantEntry = {
      ...assistantBase,
      id: "message-assistant",
      message: { ...assistantBase.message, id: "message-assistant" },
    };
    const timelineEntries: TimelineEntry[] = [
      userEntry,
      assistantEntry,
      {
        id: "entry-command",
        kind: "work",
        createdAt: "2026-03-17T19:12:29.000Z",
        entry: {
          id: "work-command",
          createdAt: "2026-03-17T19:12:29.000Z",
          turnId: null,
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          command: "ls",
          toolLifecycleStatus: "completed",
          sourceActivityKind: "tool.completed",
        },
      },
      {
        id: "entry-thinking",
        kind: "work",
        createdAt: "2026-03-17T19:12:30.000Z",
        entry: {
          id: "work-thinking",
          createdAt: "2026-03-17T19:12:30.000Z",
          turnId: null,
          label: "Thinking",
          tone: "thinking",
          preview: "quiet reasoning",
          detail: "quiet reasoning, at length",
          sourceActivityKind: "reasoning",
        },
      },
    ];

    // Markdown code blocks suspend while their highlighter loads.
    const view = await act(async () =>
      render(
        <MessagesTimeline
          {...buildProps()}
          turns={[
            buildTurn("turn-settled", "completed", MESSAGE_CREATED_AT, "2026-03-17T19:12:31.000Z"),
          ]}
          timelineEntries={timelineEntries}
        />,
      ),
    );
    const { container, getByRole } = view;

    expect(container.textContent).toContain("List the files.");
    expect(container.textContent).toContain("Here is the listing helper:");
    expect(container.textContent).toContain("const answer = 42;");
    expect(container.querySelector("code")).not.toBeNull();

    // Reasoning is not a tool: the collapsed group counts the command only and shows neither.
    const toggle = getByRole("button", { name: "Ran 1 command" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
    expect(container.textContent).not.toContain("quiet reasoning");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(getByRole("button", { name: "Ran 1 command" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const expandedGroup = container.querySelector('[data-timeline-row-kind="work"]');
    expect(expandedGroup).not.toBeNull();
    const commandRow = within(expandedGroup as HTMLElement).getByRole("button", { name: "ls" });
    expect(commandRow.getAttribute("aria-expanded")).toBe("false");
    expect(commandRow.querySelector(".font-mono")?.textContent).toBe("ls");
    // The reasoning row collapses to its preview line and expands to the full text.
    const thinkingRow = within(expandedGroup as HTMLElement).getByRole("button", {
      name: "quiet reasoning",
    });
    expect(thinkingRow.getAttribute("aria-expanded")).toBe("false");
    expect((expandedGroup as HTMLElement).textContent).not.toContain("at length");

    await act(async () => {
      fireEvent.click(thinkingRow);
    });

    expect(thinkingRow.getAttribute("aria-expanded")).toBe("true");
    expect((expandedGroup as HTMLElement).textContent).toContain("quiet reasoning, at length");

    await act(async () => {
      fireEvent.click(commandRow);
    });

    expect(commandRow.getAttribute("aria-expanded")).toBe("true");
    expect(within(expandedGroup as HTMLElement).getByText("Command")).toBeTruthy();
    expect((expandedGroup as HTMLElement).querySelector("pre")?.textContent).toBe("ls");
  });

  it("a person's message with images this client did not send shows one muted mono line per image, the words the command line prints", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntryWithImages("what does this show?", [{ mediaType: "image/png", bytes: 1_258_291, name: "shot.png" }])]}
      />,
    );
    expect(markup).toContain("[image 1 MB png]");
    expect(markup).toContain("what does this show?");
    // No pixels to draw: the runtime keeps the records and never the bytes.
    expect(markup).not.toContain("<img");
  });

  it("shows the thumbnails when this client holds the bytes it sent, and each opens the image at full size", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const image = await imageOf(file, (await imageFactsOf(file))!);
    act(() => useComposerImagesStore.setState({ sent: { req_1: [image] } }));
    const view = render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntryWithImages("what does this show?", [{ mediaType: "image/png", bytes: 12, name: "shot.png" }], "req_1")]}
      />,
    );
    const thumb = view.container.querySelector<HTMLElement>("[data-chat-image-row=true] [data-chat-image='shot.png'] img");
    expect(thumb).not.toBeNull();
    expect(view.container.textContent).not.toContain("[image");
    fireEvent.click(view.getByRole("button", { name: "Open image 1 at full size" }));
    const full = await vi.waitFor(() => document.querySelector<HTMLImageElement>("[data-slot=dialog-popup] img")!);
    expect(full.getAttribute("src")).toBe(thumb!.getAttribute("src"));
    act(() => useComposerImagesStore.setState({ sent: {} }));
    view.unmount();
  });

  it("a message with no image draws no image row at all", () => {
    const markup = renderToStaticMarkup(<MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry("plain")]} />);
    expect(markup).not.toContain("data-chat-image-row");
  });

});

describe("a notice row: the cut-turn row and the notify row", () => {
  const scoped = { workspaceId: "ws_n", sessionId: "sess_n", turnId: "turn_n" };
  const cutStart: SessionEvent = { type: "session.start", ...scoped, at: 1_000, prompt: "carry on", afterCut: true };
  const settled: SessionEvent[] = [
    cutStart,
    { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "picking up where it stopped" },
    { type: "session.notify", ...scoped, at: 2_500, notify: "me", text: "thread thread_c finished (completed, 1.5s): picking up" },
    { type: "session.done", ...scoped, at: 3_000, result: { status: "completed", durationMs: 1500, text: "picking up where it stopped" } },
    { type: "session.end", ...scoped, at: 3_100, exitCode: 0, sawResult: true },
  ];
  // The row's glyphs, without the disclosure chevron every row carries.
  const glyphs = (el: Element): string[] =>
    [...new Set([...el.querySelectorAll("svg")].flatMap(svg => [...svg.classList].filter(c => c.startsWith("lucide-") && !c.startsWith("lucide-chevron"))))];

  it("a subagent's tool line reads as what the call is doing until its result lands, and as what it did after", () => {
    const inside = { workspaceId: "ws_1", sessionId: "s_1", turnId: "u1", threadId: "thread_a" } as const;
    const opened: SessionEvent[] = [
      { type: "session.start", ...inside, at: 0, prompt: "have a look" },
      { type: "session.delta", ...inside, at: 1, kind: "tool_use", toolName: "Task", toolUseId: "agent_1", text: JSON.stringify({ description: "write it" }) },
      { type: "session.delta", ...inside, at: 2, kind: "tool_use", toolName: "Write", toolUseId: "toolu_1", parentToolUseId: "agent_1", text: JSON.stringify({ file_path: "kai.txt" }) },
    ];
    const lineOf = (events: SessionEvent[]): string | undefined => {
      const entry = deriveSession(events).timeline.find(row => row.kind === "subagent");
      return entry?.kind === "subagent" ? entry.subagent.lines.at(-1)?.label : undefined;
    };
    expect(lineOf(opened)).toBe("writing kai.txt");
    expect(lineOf([...opened, { type: "session.delta", ...inside, at: 3, kind: "tool_result", toolUseId: "toolu_1", parentToolUseId: "agent_1", text: "File created successfully at: kai.txt" }])).toBe("wrote kai.txt");

    // A call whose input the harness streams in pieces reads as the whole of it in both tenses, as the parent's own
    // calls do: neither line is written off one piece.
    const streamed: SessionEvent[] = [
      ...opened.slice(0, 2),
      { type: "session.delta", ...inside, at: 2, kind: "tool_use", toolName: "Write", toolUseId: "toolu_2", parentToolUseId: "agent_1", text: '{"file_path":"src/' },
      { type: "session.delta", ...inside, at: 3, kind: "tool_use", toolUseId: "toolu_2", parentToolUseId: "agent_1", text: 'kai.txt"}' },
    ];
    expect(lineOf(streamed)).toBe("writing src/kai.txt");
    expect(lineOf([...streamed, { type: "session.delta", ...inside, at: 4, kind: "tool_result", toolUseId: "toolu_2", parentToolUseId: "agent_1", text: "ok" }])).toBe("wrote src/kai.txt");
  });

  it("on a settled turn both rows open from the fold as muted mono text under the info glyph, with no check mark, no cross and no failure", async () => {
    const model = deriveSession(settled);
    const { container, getByRole } = await act(async () =>
      render(<MessagesTimeline {...buildProps()} turns={model.turns} timelineEntries={model.timeline} />),
    );
    expect(container.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Worked for 1.5s" }));
    });

    const rows = [...container.querySelectorAll('[data-timeline-row-kind="work"]')];
    expect(rows.map(r => r.textContent)).toEqual([
      "Previous turn was cut; resuming",
      "thread thread_c finished (completed, 1.5s): picking up",
    ]);
    for (const row of rows) {
      expect(glyphs(row)).toEqual(["lucide-info"]);
      const label = row.querySelector(".truncate") as HTMLElement;
      expect(label.className).toContain("font-mono");
      expect(label.className).toContain("text-muted-foreground");
      expect(row.querySelector(".text-icon-muted")).not.toBeNull();
      expect(row.innerHTML).not.toContain("text-destructive");
      expect(row.innerHTML).not.toContain("failed");
    }
  });

  it("on a running turn the cut row is the latest activity, drawn with the info glyph in muted mono and without the shimmer", () => {
    const model = deriveSession([cutStart]);
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} isWorking={model.running} activeTurnStartedAt="2026-03-17T19:12:28.000Z" turns={model.turns} timelineEntries={model.timeline} />,
    );
    const live = markup.slice(markup.indexOf('data-timeline-row-kind="work-live"'), markup.indexOf('data-timeline-row-kind="thinking"'));
    expect(live).toContain("Previous turn was cut; resuming");
    expect(live).toContain("lucide-info");
    expect(live).not.toContain("lucide-check");
    expect(live).not.toContain("lucide-hammer");
    expect(live).toContain("font-mono text-muted-foreground");
    expect(live).not.toContain("Tool call failed");
  });
});

describe("the tone table owns every work glyph", () => {
  const TURN = "turn_tones";
  const workEntry = (tone: WorkLogTone, extra: Partial<WorkLogEntry> = {}): TimelineEntry => ({
    id: `entry-${tone}`,
    kind: "work",
    createdAt: MESSAGE_CREATED_AT,
    entry: { id: `work-${tone}`, createdAt: MESSAGE_CREATED_AT, turnId: TURN, label: `${tone} row`, tone, sourceActivityKind: "tool.completed", ...extra },
  });
  const drawn = (row: Element) => {
    const svg = [...row.querySelectorAll("svg")].find(el => ![...el.classList].some(c => c.startsWith("lucide-chevron")))!;
    return {
      glyph: [...svg.classList].find(c => c.startsWith("lucide-") && c !== "lucide")!,
      iconClass: svg.parentElement!.className,
      labelClass: (row.querySelector(".truncate") as HTMLElement).className,
    };
  };
  const renderSettled = async (entries: TimelineEntry[]) => {
    const view = await act(async () => render(<MessagesTimeline {...buildProps()} timelineEntries={entries} />));
    // The turn folds first and the group toggles inside it; open whatever is still closed until nothing is.
    for (let closed = view.queryAllByRole("button", { expanded: false }); closed.length > 0; closed = view.queryAllByRole("button", { expanded: false })) {
      await act(async () => { fireEvent.click(closed[0]!); });
    }
    return view.container.querySelectorAll('[data-timeline-row-kind="work"]');
  };
  const renderLive = async (entry: TimelineEntry) => {
    const view = await act(async () =>
      render(<MessagesTimeline {...buildProps()} isWorking activeTurnStartedAt={MESSAGE_CREATED_AT} turns={[buildTurn(TURN, "running", MESSAGE_CREATED_AT, null)]} timelineEntries={[entry]} />),
    );
    return view.container.querySelector('[data-timeline-row-kind="work-live"]')!;
  };

  const settledEntries: Record<WorkLogTone, TimelineEntry> = {
    thinking: workEntry("thinking", { detail: "weighing the options", sourceActivityKind: "reasoning" }),
    tool: workEntry("tool", { toolLifecycleStatus: "completed" }),
    notice: workEntry("notice", { sourceActivityKind: "runtime.notify" }),
    error: workEntry("error"),
  };
  const settledDrawing = {
    thinking: { glyph: "lucide-brain", iconClass: "flex size-6 shrink-0 items-center justify-center text-foreground", labelClass: "min-w-0 flex-1 truncate text-secondary-label" },
    tool: { glyph: "lucide-zap", iconClass: "flex size-6 shrink-0 items-center justify-center text-icon-muted", labelClass: "min-w-0 flex-1 truncate text-secondary-label" },
    notice: { glyph: "lucide-info", iconClass: "flex size-6 shrink-0 items-center justify-center text-icon-muted", labelClass: "min-w-0 flex-1 truncate font-mono text-muted-foreground" },
    error: { glyph: "lucide-circle-alert", iconClass: "flex size-6 shrink-0 items-center justify-center text-icon-muted", labelClass: "min-w-0 flex-1 truncate text-secondary-label" },
  } satisfies Record<WorkLogTone, ReturnType<typeof drawn>>;

  it.each(Object.keys(settledDrawing) as WorkLogTone[])("a settled %s row draws its glyph and colours as before", async tone => {
    const rows = await renderSettled([settledEntries[tone]]);
    expect(rows).toHaveLength(1);
    expect(drawn(rows[0]!)).toEqual(settledDrawing[tone]);
  });

  const liveDrawing = {
    thinking: { glyph: "lucide-brain", iconClass: "flex size-6 shrink-0 items-center justify-center text-foreground", labelClass: "min-w-0 flex-1 truncate" },
    tool: { glyph: "lucide-zap", iconClass: "flex size-6 shrink-0 items-center justify-center text-icon-muted", labelClass: "min-w-0 flex-1 truncate" },
    notice: { glyph: "lucide-info", iconClass: "flex size-6 shrink-0 items-center justify-center text-icon-muted", labelClass: "min-w-0 flex-1 truncate" },
  } satisfies Partial<Record<WorkLogTone, ReturnType<typeof drawn>>>;

  it.each(Object.keys(liveDrawing) as Array<keyof typeof liveDrawing>)("a live %s row draws its glyph and colours as before", async tone => {
    const entry = tone === "tool" ? workEntry("tool", { toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started" }) : settledEntries[tone];
    const live = await renderLive(entry);
    expect(drawn(live)).toEqual(liveDrawing[tone]);
  });

  const kindDrawing: Array<[string, Partial<WorkLogEntry>, string]> = [
    ["a file read", { requestKind: "file-read" }, "lucide-eye"],
    ["a file change", { itemType: "file_change", changedFiles: ["/x/a.ts"] }, "lucide-square-pen"],
    ["a command", { itemType: "command_execution", command: "pnpm test" }, "lucide-terminal"],
    ["a code search", { toolTitle: "Grep" }, "lucide-search"],
    ["a web search", { itemType: "web_search" }, "lucide-globe"],
    ["an MCP call", { itemType: "mcp_tool_call" }, "lucide-wrench"],
    ["a dynamic tool call", { itemType: "dynamic_tool_call" }, "lucide-hammer"],
    ["a subagent call", { itemType: "collab_agent_tool_call" }, "lucide-bot"],
    ["a plain tool call with no item type", {}, "lucide-zap"],
    ["a notice that is tool-like", { tone: "notice", requestKind: "mcp-elicitation" }, "lucide-info"],
  ];

  it.each(kindDrawing)("a settled row for %s draws its glyph as before", async (_name, extra, glyph) => {
    const rows = await renderSettled([workEntry("tool", { toolLifecycleStatus: "completed", ...extra })]);
    expect(rows).toHaveLength(1);
    expect(drawn(rows[0]!).glyph).toBe(glyph);
  });

  it.each(kindDrawing)("a live row for %s draws its glyph as before", async (_name, extra, glyph) => {
    const live = await renderLive(workEntry("tool", { toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started", ...extra }));
    expect(drawn(live).glyph).toBe(glyph);
  });

  it("a failed tool row, settled or live, draws the error tone's glyph from the table", async () => {
    const ErrorGlyph = WORK_TONES.error.Glyph;
    const tableGlyph = [...render(<ErrorGlyph />).container.querySelector("svg")!.classList].find(c => c.startsWith("lucide-") && c !== "lucide")!;
    expect(tableGlyph).toMatch(/^lucide-/);

    const rows = await renderSettled([workEntry("tool", { toolLifecycleStatus: "failed" }), settledEntries.error]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('[aria-label="Tool call failed"]')).not.toBeNull();
    expect(drawn(rows[0]!).glyph).toBe(tableGlyph);
    expect(drawn(rows[1]!).glyph).toBe(tableGlyph);

    const live = await renderLive(workEntry("tool", { toolLifecycleStatus: "declined" }));
    expect(live.querySelector('[aria-label="Tool call failed"]')).not.toBeNull();
    expect(drawn(live).glyph).toBe(tableGlyph);
  });
});
