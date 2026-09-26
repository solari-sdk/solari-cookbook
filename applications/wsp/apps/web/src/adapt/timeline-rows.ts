// SPDX-License-Identifier: AGPL-3.0-only
// Timeline entries into the rows MessagesTimeline renders. Ported from t3code
// apps/web/src/components/chat/MessagesTimeline.logic.ts and the work-log
// presentation helpers in client-runtime (commit 57a66608), cut down to what
// wsp's turns can express: no proposed plans, subagent fleets, checkpoints or
// MCP presentation tables. Turn duration comes from the turn summary because
// entries are unstamped on our wire.
import { fmtDuration, isCodeSearchTool, waitingAskerLine, type ThreadWaitingOn } from "@wsp/protocol";
import { isPromptOpen } from "./session.js";
import type { MessagesTimelineRow, PermissionPrompt, TimelineEntry, ToolGroupAction, ToolGroupSummaryKind, TurnSummary, WorkLogEntry, WorkLogTone } from "./view-model.js";

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export interface DeriveRowsInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly turns: ReadonlyArray<TurnSummary>;
  readonly expandedTurnIds?: ReadonlySet<string>;
  readonly expandedWorkGroupIds?: ReadonlySet<string>;
  readonly isWorking: boolean;
  readonly activeTurnStartedAt: string | null;
  /** The thread this one's running call is stopped behind, with that thread's open question; null when it is behind
   * nobody. The question is drawn here, at the tail, because this is the screen the person is reading and the wait
   * ends the moment they answer it. */
  readonly waitingOn?: ThreadWaitingOn | null;
}

export function deriveMessagesTimelineRows(input: DeriveRowsInput): MessagesTimelineRow[] {
  const rows: MessagesTimelineRow[] = [];
  const entries = input.timelineEntries;
  const durationStartByMessageId = computeMessageDurationStart(entries);
  const terminalAssistantIds = terminalAssistantMessageIds(entries);
  const latest = input.turns[input.turns.length - 1] ?? null;
  const unsettledTurnId = latest !== null && latest.state === "running" ? latest.turnId : null;
  const turnById = new Map(input.turns.map(t => [t.turnId, t]));
  const folds = deriveTurnFolds(entries, terminalAssistantIds, turnById, unsettledTurnId);
  const collapsed = new Set<string>();
  for (const fold of folds.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) for (const id of fold.hiddenEntryIds) collapsed.add(id);
  }

  let activeTurnHeaderIndex = entries.length;
  if (input.isWorking) {
    const lastUser = lastUserMessageIndex(entries);
    let firstOwned = -1;
    if (unsettledTurnId !== null) {
      for (let i = lastUser + 1; i < entries.length; i++) {
        if (entryTurnId(entries[i]!) === unsettledTurnId) { firstOwned = i; break; }
      }
    }
    activeTurnHeaderIndex = firstOwned >= 0 ? firstOwned : lastUser + 1;
  }
  const belongsToActiveTurn = (entry: TimelineEntry, index: number): boolean =>
    input.isWorking && index >= activeTurnHeaderIndex && (unsettledTurnId === null || entryTurnId(entry) === unsettledTurnId);
  const inActiveRun = (entry: WorkLogEntry): boolean =>
    input.isWorking && unsettledTurnId !== null && entry.toolLifecycleStatus === "inProgress" && entry.turnId === unsettledTurnId;

  // The trailing run of tool rows in the active turn renders as one live row.
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  for (let i = entries.length - 1; i >= activeTurnHeaderIndex; i--) {
    const entry = entries[i]!;
    if (!belongsToActiveTurn(entry, i) || entry.kind !== "work" || entry.entry.tone === "error") break;
    activeToolEntries.unshift(entry);
  }
  const visibleActive = activeToolEntries.filter(e => isVisibleInGroup(e.entry, true));
  const anchor = activeToolEntries[0];
  const latestVisible = visibleActive[visibleActive.length - 1];
  const latestRunning = findLast(visibleActive, e => isActiveTurnActivity(e.entry));
  const latestToolFailed = latestRunning === undefined && latestVisible !== undefined
    && latestVisible.entry.toolLifecycleStatus !== "declined" && indicatesFailure(latestVisible.entry);
  const keepsLive = latestRunning !== undefined || (latestVisible !== undefined && indicatesSuccess(latestVisible.entry));
  const activePlacementId = latestVisible?.id;
  const activeRow: Extract<MessagesTimelineRow, { kind: "work-live" }> | null =
    anchor && latestVisible && !latestToolFailed
      ? {
          kind: "work-live",
          id: keepsLive ? LIVE_ACTIVITY_ROW_ID : `work-live:${groupIdentity(anchor.id, anchor.entry)}`,
          createdAt: anchor.createdAt,
          entry: (latestRunning ?? latestVisible).entry,
          groupedEntries: visibleActive.map(e => e.entry),
          groupId: groupId(anchor.id, anchor.entry),
          expanded: input.expandedWorkGroupIds?.has(groupId(anchor.id, anchor.entry)) ?? false,
          active: keepsLive,
        }
      : null;
  const activeIds = new Set(activeRow !== null || latestToolFailed ? activeToolEntries.map(e => e.id) : []);

  let hasActivityRow = false;
  // Whether the turn the count belongs to is stopped on a question: a prompt of that turn and no other with no
  // outcome on it. The turn matters. A host that restarted while a prompt stood open leaves it in the transcript
  // with none, since the runtime cuts the row short at load and records nothing that closes the question, and the
  // thread's own row reads the latest turn alone. Scoped here, the count and the row cannot say two things.
  const behind = input.waitingOn ?? null;
  const waitingOnYou = behind !== null || (unsettledTurnId !== null && entries.some(entry => entry.kind === "permission" && entry.permission.turnId === unsettledTurnId && isPromptOpen(entry.permission)));
  const pushWorking = (): void => { rows.push({ kind: "working", id: "working-indicator-row", createdAt: input.activeTurnStartedAt, waitingOnYou }); };
  const pushActive = (): void => {
    if (activeRow === null) return;
    rows.push(activeRow);
    hasActivityRow ||= activeRow.active;
    if (activeRow.expanded) rows.push(expandedGroupRow(activeRow.groupId, activeRow.createdAt, activeRow.groupedEntries));
  };

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (input.isWorking && index === activeTurnHeaderIndex) pushWorking();
    if (entry.id === activePlacementId) pushActive();

    const fold = folds.get(entry.id);
    if (fold) {
      rows.push({ kind: "turn-fold", id: `turn-fold:${fold.turnId}`, createdAt: fold.createdAt, turnId: fold.turnId, label: fold.label, expanded: input.expandedTurnIds?.has(fold.turnId) ?? false });
    }
    if (collapsed.has(entry.id) || activeIds.has(entry.id)) continue;

    if (entry.kind === "work") {
      if (entry.entry.tone === "error") {
        rows.push({ kind: "work", id: entry.id, createdAt: entry.createdAt, groupedEntries: [entry.entry], isExpandedToolGroup: false });
        continue;
      }
      const grouped = [entry.entry];
      let cursor = index + 1;
      while (cursor < entries.length) {
        const next = entries[cursor]!;
        if (next.kind !== "work" || next.entry.tone === "error" || activeIds.has(next.id) || collapsed.has(next.id) || folds.has(next.id)) break;
        grouped.push(next.entry);
        cursor++;
      }
      const visible = grouped.filter(e => isVisibleInGroup(e, inActiveRun(e)));
      if (visible.length === 1 && !isToolLike(visible[0]!)) {
        // A lone row that is not a tool has nothing to fold: it stands as itself.
        rows.push({ kind: "work", id: entry.id, createdAt: entry.createdAt, groupedEntries: visible, isExpandedToolGroup: false });
      } else if (visible.length > 0) {
        const id = groupId(entry.id, entry.entry);
        const expanded = input.expandedWorkGroupIds?.has(id) ?? false;
        const activeInProgress = visible.filter(inActiveRun);
        if (activeInProgress.length > 0) {
          rows.push({
            kind: "work-live", id: `work-live:${groupIdentity(entry.id, entry.entry)}`, createdAt: entry.createdAt,
            entry: activeInProgress[activeInProgress.length - 1]!, groupedEntries: visible, groupId: id, expanded, active: true,
          });
          hasActivityRow = true;
        } else {
          const latestTool = findLast(visible, isToolLike);
          rows.push({
            kind: "work-toggle", id: `work-toggle:${entry.id}`, createdAt: entry.createdAt, groupId: id, hiddenCount: visible.length, expanded,
            summary: summarizeToolGroup(visible),
            summaryKind: toolGroupSummaryKind(visible),
            hasFailure: latestTool !== undefined && indicatesFailure(latestTool),
          });
        }
        if (expanded) rows.push(expandedGroupRow(id, entry.createdAt, visible));
      }
      index = cursor - 1;
      continue;
    }

    if (entry.kind === "proposed-plan") {
      rows.push({ kind: "proposed-plan", id: entry.id, createdAt: entry.createdAt, proposedPlan: entry.proposedPlan });
      continue;
    }

    if (entry.kind === "permission") {
      rows.push({ kind: "permission", id: entry.id, createdAt: entry.createdAt, permission: entry.permission });
      continue;
    }

    if (entry.kind === "subagent") {
      rows.push({ kind: "subagent", id: entry.id, createdAt: entry.createdAt, subagent: entry.subagent });
      continue;
    }

    const m = entry.message;
    const stillInProgress = m.role === "assistant" && unsettledTurnId !== null && m.turnId === unsettledTurnId;
    const showAssistantMeta = m.role === "assistant" && terminalAssistantIds.has(m.id) && !stillInProgress;
    rows.push({
      kind: "message", id: entry.id, createdAt: entry.createdAt, message: m,
      durationStart: durationStartByMessageId.get(m.id) ?? m.createdAt,
      showAssistantMeta, showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: m.streaming || stillInProgress,
    });
  }

  if (input.isWorking && activeTurnHeaderIndex === entries.length) pushWorking();
  if (behind !== null) rows.push({ kind: "permission", id: `waiting-on:${behind.threadId}:${behind.prompt.askId}`, createdAt: input.activeTurnStartedAt ?? "", permission: borrowedPrompt(behind), asker: waitingAskerLine(behind.title) });
  else if (input.isWorking && (!hasActivityRow || latestToolFailed)) {
    rows.push({ kind: "thinking", id: LIVE_ACTIVITY_ROW_ID, createdAt: input.activeTurnStartedAt });
  }
  return rows;
}

/** Another thread's open question as this thread's own row: the turn it belongs to is not one of these, so it hangs
 * on no turn here, and the session it answers is that thread's, which is what lets one click end both waits. */
function borrowedPrompt(behind: ThreadWaitingOn): PermissionPrompt {
  const { prompt } = behind;
  return {
    askId: prompt.askId,
    turnId: null,
    sessionId: behind.sessionId,
    toolName: prompt.toolName,
    input: prompt.input,
    ...(prompt.detail !== undefined ? { detail: prompt.detail } : {}),
    options: prompt.options,
    createdAt: "",
    outcome: null,
    optionId: null,
  };
}

// --- folds -----------------------------------------------------------------------

interface TurnFold {
  readonly turnId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

/** Settled turns keep only their terminal assistant message; everything before it folds behind "Worked for ...". */
function deriveTurnFolds(
  entries: ReadonlyArray<TimelineEntry>,
  terminalAssistantIds: ReadonlySet<string>,
  turnById: ReadonlyMap<string, TurnSummary>,
  unsettledTurnId: string | null,
): ReadonlyMap<string, TurnFold> {
  const groups = new Map<string, { entries: TimelineEntry[]; terminalId: string | null; streaming: boolean }>();
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user") continue;
    const turnId = entryTurnId(entry);
    if (turnId === null) continue;
    let group = groups.get(turnId);
    if (!group) {
      group = { entries: [], terminalId: null, streaming: false };
      groups.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (terminalAssistantIds.has(entry.message.id)) group.terminalId = entry.message.id;
      if (entry.message.streaming) group.streaming = true;
    }
  }
  const folds = new Map<string, TurnFold>();
  for (const [turnId, group] of groups) {
    if (turnId === unsettledTurnId || group.streaming) continue;
    // Error rows stay visible on a settled turn: a failed turn often has no terminal message to stand in for them.
    const hidden = new Set(group.entries.filter(e => e.id !== group.terminalId && !(e.kind === "work" && e.entry.tone === "error")).map(e => e.id));
    if (hidden.size === 0) continue;
    const firstHidden = group.entries.find(e => hidden.has(e.id))!;
    const turn = turnById.get(turnId);
    const durationMs = turn?.durationMs ?? elapsedMs(turn?.startedAt ?? group.entries[0]!.createdAt, turn?.completedAt ?? group.entries[group.entries.length - 1]!.createdAt);
    const duration = durationMs !== null ? fmtDuration(durationMs) : null;
    const label = turn?.state === "interrupted"
      ? (duration ? `You stopped after ${duration}` : "You stopped this response")
      : (duration ? `Worked for ${duration}` : "Worked");
    folds.set(firstHidden.id, { turnId, createdAt: firstHidden.createdAt, hiddenEntryIds: hidden, label });
  }
  return folds;
}

function elapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// --- message helpers --------------------------------------------------------------------

function computeMessageDurationStart(entries: ReadonlyArray<TimelineEntry>): Map<string, string> {
  const result = new Map<string, string>();
  let boundary: string | null = null;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const m = entry.message;
    if (m.role === "user") boundary = m.createdAt;
    result.set(m.id, boundary ?? m.createdAt);
    if (m.role === "assistant" && !m.streaming) boundary = m.updatedAt;
  }
  return result;
}

/** The last assistant message of each response (a turn, or the run after a user message when unkeyed). */
function terminalAssistantMessageIds(entries: ReadonlyArray<TimelineEntry>): Set<string> {
  const byKey = new Map<string, string>();
  let unkeyed = 0;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const m = entry.message;
    if (m.role === "user") { unkeyed++; continue; }
    if (m.role !== "assistant") continue;
    byKey.set(m.turnId ? `turn:${m.turnId}` : `unkeyed:${unkeyed}`, m.id);
  }
  return new Set(byKey.values());
}

function lastUserMessageIndex(entries: ReadonlyArray<TimelineEntry>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "message" && e.message.role === "user") return i;
  }
  return -1;
}

/** The turn a rendered entry belongs to, or null where it belongs to none. */
export function entryTurnId(entry: TimelineEntry): string | null {
  switch (entry.kind) {
    case "message":
      return entry.message.role === "assistant" ? entry.message.turnId : null;
    case "proposed-plan":
      return entry.proposedPlan.turnId;
    case "permission":
      return entry.permission.turnId;
    case "subagent":
      return entry.subagent.turnId;
    case "work":
      return entry.entry.turnId;
    default: {
      const _exhaustive: never = entry;
      return null;
    }
  }
}

function findLast<T>(items: ReadonlyArray<T>, test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return items[i];
  return undefined;
}

// --- work groups -----------------------------------------------------------------

function groupIdentity(entryId: string, entry: WorkLogEntry): string {
  return entry.toolCallId ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}` : entryId;
}

function groupId(entryId: string, entry: WorkLogEntry): string {
  return `work-group:${groupIdentity(entryId, entry)}`;
}

function expandedGroupRow(id: string, createdAt: string, grouped: ReadonlyArray<WorkLogEntry>): MessagesTimelineRow {
  return { kind: "work", id: `${id}:details`, createdAt, groupedEntries: grouped, isExpandedToolGroup: true };
}

export function isToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  return entry.requestKind !== undefined || entry.itemType !== undefined;
}

export function indicatesFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") return true;
  return entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "declined";
}

export function indicatesSuccess(entry: WorkLogEntry): boolean {
  if (!isToolLike(entry) || indicatesFailure(entry) || entry.tone === "thinking") return false;
  const s = entry.toolLifecycleStatus;
  return s !== "inProgress" && s !== "stopped";
}

/** Tool-like with neither clear success nor failure: in progress or stopped. Reasoning with text is its own thing to show, never neutral. */
export function indicatesNeutral(entry: WorkLogEntry): boolean {
  if (entry.tone === "thinking" && entry.detail !== undefined && entry.detail.trim().length > 0) return false;
  return isToolLike(entry) && !indicatesFailure(entry) && !indicatesSuccess(entry);
}

function isVisibleInGroup(entry: WorkLogEntry, expandedOrActive: boolean): boolean {
  return (expandedOrActive && entry.toolLifecycleStatus === "inProgress") || !indicatesNeutral(entry);
}

function isActiveTurnActivity(entry: WorkLogEntry): boolean {
  return entry.toolLifecycleStatus === "inProgress" || (entry.toolLifecycleStatus === undefined && isToolLike(entry));
}

export function toolGroupAction(entry: WorkLogEntry): ToolGroupAction {
  if (entry.requestKind === "file-read" || entry.itemType === "image_view") return "read";
  if (entry.requestKind === "file-change" || entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) return "edit";
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) return "command";
  if (isCodeSearchTool(entry.toolTitle)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return isToolLike(entry) ? "other" : "update";
}

function actionCount(action: ToolGroupAction, entries: ReadonlyArray<WorkLogEntry>): number {
  if (action !== "edit") return entries.length;
  const files = new Set<string>();
  let withoutFiles = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) withoutFiles++;
    else for (const f of entry.changedFiles) files.add(f);
  }
  return files.size + withoutFiles;
}

function actionLabel(action: ToolGroupAction, count: number): string {
  const one = count === 1;
  switch (action) {
    case "read": return `Read ${count} ${one ? "file" : "files"}`;
    case "edit": return `Changed ${count} ${one ? "file" : "files"}`;
    case "command": return `Ran ${count} ${one ? "command" : "commands"}`;
    case "search": return `Searched the web ${count} ${one ? "time" : "times"}`;
    case "code-search": return `Searched code ${count} ${one ? "time" : "times"}`;
    case "other": return `Used ${count} ${one ? "tool" : "tools"}`;
    case "update": return `Received ${count} ${one ? "update" : "updates"}`;
    default: {
      const _exhaustive: never = action;
      return "";
    }
  }
}

/** Reasoning rows sit in the group but are not tools: the summary counts tools, and a group of reasoning alone reads "Thinking". */
export function summarizeToolGroup(entries: ReadonlyArray<WorkLogEntry>): string {
  const tools = entries.filter(e => e.tone !== "thinking");
  if (tools.length === 0 && entries.length > 0) return "Thinking";
  const byAction = new Map<ToolGroupAction, WorkLogEntry[]>();
  for (const entry of tools) {
    const action = toolGroupAction(entry);
    const group = byAction.get(action);
    if (group) group.push(entry);
    else byAction.set(action, [entry]);
  }
  const labels = [...byAction].map(([action, group], i) => {
    const label = actionLabel(action, actionCount(action, group));
    return i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
  });
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/** What a group of plain calls is called when no item type says: reasoning reads as an agent's, a tool call as a tool's. */
const TONE_GROUP_KINDS: Record<WorkLogTone, ToolGroupSummaryKind> = {
  thinking: "agent-tool",
  tool: "tone-tool",
  notice: "other",
  error: "other",
};

export function toolGroupSummaryKind(entries: ReadonlyArray<WorkLogEntry>): ToolGroupSummaryKind {
  const tools = entries.filter(e => e.tone !== "thinking");
  const actions = new Set((tools.length > 0 ? tools : entries).map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = [...actions][0]!;
  if (action !== "other") return action;
  const kinds = new Set(entries.map(entry => workEntryKind(entry) ?? TONE_GROUP_KINDS[entry.tone]));
  return kinds.size === 1 ? [...kinds][0]! : "mixed";
}

/** The kind one tool-like row is drawn as: its action, else what the harness called the item; null when only its tone can say. */
export function workEntryKind(entry: WorkLogEntry): ToolGroupSummaryKind | null {
  const action = toolGroupAction(entry);
  if (action !== "other") return action;
  switch (entry.itemType) {
    case "mcp_tool_call": return "other";
    case "dynamic_tool_call": return "dynamic-tool";
    case "collab_agent_tool_call": return "agent-tool";
    default: return null;
  }
}
