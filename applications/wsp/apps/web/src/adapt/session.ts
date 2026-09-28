// SPDX-License-Identifier: AGPL-3.0-only
// Session events into chat view models. Ported from t3code session-logic.ts
// (deriveWorkLogEntries, deriveTimelineEntries; commit 57a66608) against
// @wsp/protocol's SessionEvent. One wsp session run is one turn, keyed by the
// runtime's turnId; events from before the runtime stamped one fall back to
// the session id plus the ordinal of its session.start, since a resumed Claude
// session id repeats across turns. Wire order is the timeline order. createdAt
// is the wire's `at` (ms epoch) as ISO, else the caller's receipt clock, else
// "" for unstamped history.
import { AFTER_CUT_LINE, NOTIFY_ME, internalToolResult, subagentTaskLine, toolActivityLine, toolCallFacts, toolDoneLine, toolResultLine, type SessionEvent, type SessionHarness, type TurnResult } from "@wsp/protocol";
import type {
  ChatMessage,
  PermissionPrompt,
  SubagentLine,
  SubagentRun,
  TimelineEntry,
  TurnState,
  TurnSummary,
  WorkLogEntry,
} from "./view-model.js";

export interface SessionModel {
  readonly turns: ReadonlyArray<TurnSummary>;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly timeline: ReadonlyArray<TimelineEntry>;
  readonly latestTurn: TurnSummary | null;
  readonly running: boolean;
  readonly model: string | null;
  /** What the CLI announced about itself on the last session.start that carried it. */
  readonly harness: SessionHarness | null;
  /** The thread's own record as its transcript carries it, off the last session.start that named each: the agent
   * the thread runs on, by its catalog id, and the access its last turn started at. Null before a start carried it. */
  readonly agent: string | null;
  readonly permissionMode: string | null;
}

export interface DeriveSessionOptions {
  /** Receipt clock for an event without a wire `at`; undefined leaves createdAt empty. */
  readonly at?: (event: SessionEvent, index: number) => string | undefined;
}

type SessionDelta = Extract<SessionEvent, { type: "session.delta" }>;

interface ToolCall {
  readonly entryIndex: number;
  input: string;
  /** What the call itself answered, once it really has, read by the fold that opens later so a subagent's life is
   * keyed off the call whatever order the frames arrive in. The harness's own note to the agent is not an answer:
   * it says a background agent was launched, and a launch is where the work starts. */
  answered?: { readonly at: string; readonly failed: boolean };
}

interface TurnBuild {
  summary: TurnSummary;
  readonly startCount: number;
  ordinal: number;
  /** Index into `timeline` of the assistant message still accepting text, if the tail is one. */
  openMessage: number | null;
  /** The harness message that one is a piece of, where the harness named it; text of another opens its own bubble. */
  openMessageId: string | null;
  sawText: boolean;
  tools: Map<string, ToolCall>;
  /** Each of a subagent's open calls as the harness has reported it so far, by that line's own key: a call whose
   * input arrives in pieces reads as the whole of it, in both tenses, as the parent's own calls do. */
  childCalls: Map<string, { name: string; input: string }>;
  /** Tool calls without an id resolve to the newest open one, as the CLI streams them in order. */
  openAnonymousTool: number | null;
  /** Where each subagent's fold sits in the timeline, by the call that launched it. */
  subagents: Map<string, number>;
  /** The reply's result once session.done landed; the turn stays running until session.end applies its status. */
  reply: TurnResult | null;
}

export function deriveSession(events: ReadonlyArray<SessionEvent>, options: DeriveSessionOptions = {}): SessionModel {
  const timeline: TimelineEntry[] = [];
  const turns: TurnSummary[] = [];
  const startsBySession = new Map<string, number>();
  /** Where each relayed permission prompt sits in the timeline, so its close lands on the row it opened rather than
   * on a second row after the work the answer let through. */
  const promptRows = new Map<string, number>();
  let turn: TurnBuild | null = null;
  let model: string | null = null;
  let harness: SessionHarness | null = null;
  let agent: string | null = null;
  let permissionMode: string | null = null;

  const push = (entry: TimelineEntry): number => {
    timeline.push(entry);
    return timeline.length - 1;
  };
  const replace = (index: number, entry: TimelineEntry): void => {
    timeline[index] = entry;
  };
  const message = (index: number): ChatMessage | undefined => {
    const entry = timeline[index];
    return entry?.kind === "message" ? entry.message : undefined;
  };
  const work = (index: number): WorkLogEntry | undefined => {
    const entry = timeline[index];
    return entry?.kind === "work" ? entry.entry : undefined;
  };
  const subagent = (index: number | undefined): SubagentRun | undefined => {
    const entry = index === undefined ? undefined : timeline[index];
    return entry?.kind === "subagent" ? entry.subagent : undefined;
  };
  const subagentEntry = (run: SubagentRun, createdAt: string): TimelineEntry => ({
    id: `subagent:${run.parentToolUseId}`,
    kind: "subagent",
    createdAt,
    subagent: run,
  });
  /** The fold one subagent's lines gather under, opened the first time it writes. It takes the place of the call
   * that launched it where that call already has a row: the fold is that call, read as the run it started, and two
   * rows for one launch would say the same thing twice. */
  const foldFor = (t: TurnBuild, parentToolUseId: string, at: string): number => {
    const held = t.subagents.get(parentToolUseId);
    if (held !== undefined) return held;
    const call = t.tools.get(parentToolUseId);
    const launched = call === undefined ? undefined : work(call.entryIndex);
    const openedAt = call === undefined || launched === undefined ? at : timeline[call.entryIndex]!.createdAt;
    const ended = call?.answered;
    const run: SubagentRun = {
      parentToolUseId,
      turnId: t.summary.turnId,
      title: (call === undefined ? undefined : subagentTaskLine(call.input)) ?? launched?.detail ?? launched?.label ?? "Subagent",
      lines: [],
      prompts: [],
      state: ended === undefined ? "running" : ended.failed ? "failed" : "done",
      startedAt: openedAt,
      endedAt: ended?.at ?? null,
    };
    const index = call !== undefined && launched !== undefined ? call.entryIndex : push(subagentEntry(run, openedAt));
    if (call !== undefined && launched !== undefined) replace(index, subagentEntry(run, openedAt));
    t.subagents.set(parentToolUseId, index);
    return index;
  };
  const changeFold = (t: TurnBuild, parentToolUseId: string, at: string, change: (run: SubagentRun) => SubagentRun): void => {
    const index = foldFor(t, parentToolUseId, at);
    const run = subagent(index);
    if (run === undefined) return;
    replace(index, subagentEntry(change(run), timeline[index]!.createdAt));
  };
  /** One line inside a fold, or a change to the one the same call already wrote: a subagent's tool call streams its
   * input and then its result, and both land on one line. */
  const addFoldLine = (t: TurnBuild, parentToolUseId: string, at: string, line: Omit<SubagentLine, "id" | "label"> & { label?: string }, key?: string): void => {
    changeFold(t, parentToolUseId, at, run => {
      const held = key === undefined ? -1 : run.lines.findIndex(l => l.id === key);
      if (held >= 0) {
        const lines = [...run.lines];
        // A call's result reaches the line its input opened and says only what it changes; the call's own words stand.
        lines[held] = { ...lines[held]!, ...line, label: line.label ?? lines[held]!.label, id: key! };
        return { ...run, lines };
      }
      return { ...run, lines: [...run.lines, { ...line, label: line.label ?? "", id: key ?? `${run.parentToolUseId}:l${run.lines.length}` }] };
    });
  };
  const closeOpenMessage = (t: TurnBuild): void => {
    if (t.openMessage === null) return;
    const m = message(t.openMessage);
    if (m && m.streaming) replace(t.openMessage, messageEntry({ ...m, streaming: false }));
    t.openMessage = null;
    t.openMessageId = null;
  };
  const addWork = (t: TurnBuild, entry: Omit<WorkLogEntry, "id" | "turnId">, at: string): number => {
    t.ordinal += 1;
    const full: WorkLogEntry = { ...entry, id: `${t.summary.turnId}:w${t.ordinal}`, turnId: t.summary.turnId };
    return push({ id: full.id, kind: "work", createdAt: at, entry: full });
  };
  const addMessage = (t: TurnBuild, role: ChatMessage["role"], text: string, at: string, streaming: boolean, steered = false, carried?: Pick<ChatMessage, "attachments" | "requestId">): number => {
    t.ordinal += 1;
    const m: ChatMessage = { id: `${t.summary.turnId}:m${t.ordinal}`, role, text, turnId: t.summary.turnId, streaming, createdAt: at, updatedAt: at, ...(steered ? { steered } : {}), ...carried };
    return push(messageEntry(m));
  };
  // The reply's content and cost, applied once at session.done; the state is set separately, so a turn whose process
  // lives past its reply keeps running until session.end.
  const applyResult = (t: TurnBuild, result: TurnResult, at: string): void => {
    closeOpenMessage(t);
    for (const call of t.tools.values()) {
      const w = work(call.entryIndex);
      if (w && w.toolLifecycleStatus === "inProgress") {
        replace(call.entryIndex, workEntry({ ...w, toolLifecycleStatus: "stopped" }, timeline[call.entryIndex]!.createdAt));
      }
    }
    // The harness ends the subagents it started when its turn ends, so a fold still running at the reply is one
    // whose launch never answered; a slot left reading nothing would say it is still working.
    for (const parentToolUseId of t.subagents.keys()) {
      changeFold(t, parentToolUseId, at, run => (run.state === "running" ? { ...run, state: "stopped", endedAt: at || null } : run));
    }
    if (result.status === "completed" && !t.sawText && result.text !== undefined && result.text.length > 0) {
      addMessage(t, "assistant", result.text, at, false);
    }
    if (result.status === "failed") {
      const label = result.error ?? "session failed";
      addWork(t, { createdAt: at, label, tone: "error", sourceActivityKind: "runtime.error" }, at);
    }
    t.summary = {
      ...t.summary,
      durationMs: result.durationMs ?? null,
      waitedMs: result.waitedMs ?? null,
      costUsd: result.costUsd ?? null,
      error: result.error ?? null,
      completedAt: at || null,
    };
    turns[turns.length - 1] = t.summary;
  };
  const setState = (t: TurnBuild, status: TurnResult["status"]): void => {
    t.summary = { ...t.summary, state: turnState(status) };
    turns[turns.length - 1] = t.summary;
  };
  // A turn cut by the runtime (a restart, an exit with no reply): its result is both the reply and the end at once.
  const finishTurn = (t: TurnBuild, result: TurnResult, at: string): void => {
    applyResult(t, result, at);
    setState(t, result.status);
  };
  // session.done: the reply is in, the process may still be working, so record it and keep the turn running.
  const recordReply = (t: TurnBuild, result: TurnResult, at: string): void => {
    applyResult(t, result, at);
    t.reply = result;
    t.summary = { ...t.summary, replied: true };
    turns[turns.length - 1] = t.summary;
  };
  // A running turn a new start supersedes: one that already replied ended between here (its session.end unseen in a cut
  // transcript) and keeps its reply's status; one still working when it was cut is a failure.
  const endRunningTurn = (t: TurnBuild, at: string): void => {
    if (t.reply !== null) setState(t, t.reply.status);
    else finishTurn(t, { status: "failed", error: "session restarted before it finished" }, at);
  };

  const openTurn = (event: SessionEvent, turnId: string, count: number, at: string): TurnBuild => {
    const start = event.type === "session.start" ? event : null;
    const summary: TurnSummary = {
      turnId,
      sessionId: event.sessionId,
      state: "running",
      replied: false,
      prompt: start?.prompt ?? null,
      model: start?.model ?? null,
      durationMs: null,
      waitedMs: null,
      costUsd: null,
      error: null,
      startedAt: at || null,
      completedAt: null,
    };
    turns.push(summary);
    return { summary, startCount: count, ordinal: 0, openMessage: null, openMessageId: null, sawText: false, tools: new Map(), childCalls: new Map(), openAnonymousTool: null, subagents: new Map(), reply: null };
  };
  /** A delta, done or end whose turn never started here (history capped mid-turn) still needs a turn to hang on. */
  const turnFor = (event: SessionEvent, at: string): TurnBuild => {
    if (turn !== null && (event.turnId === undefined || event.turnId === turn.summary.turnId)) return turn;
    if (turn !== null && turn.summary.state === "running") endRunningTurn(turn, at);
    turn = openTurn(event, event.turnId ?? `${event.sessionId}#0`, 0, at);
    return turn;
  };

  for (const [index, event] of events.entries()) {
    const at = event.at !== undefined ? new Date(event.at).toISOString() : options.at?.(event, index) ?? "";
    switch (event.type) {
      case "session.start": {
        if (turn && turn.summary.state === "running") endRunningTurn(turn, at);
        const count = (startsBySession.get(event.sessionId) ?? 0) + 1;
        startsBySession.set(event.sessionId, count);
        model = event.model ?? model;
        harness = event.harness ?? harness;
        agent = event.agent ?? agent;
        permissionMode = event.permissionMode ?? permissionMode;
        turn = openTurn(event, event.turnId ?? `${event.sessionId}#${count}`, count, at);
        if (event.prompt !== undefined) {
          addMessage(turn, "user", event.prompt, at, false, false, {
            ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
          });
        }
        if (event.afterCut === true) addWork(turn, { createdAt: at, label: AFTER_CUT_LINE, tone: "notice", sourceActivityKind: "runtime.resume" }, at);
        continue;
      }
      case "session.delta": {
        applyDelta(turnFor(event, at), event, at);
        continue;
      }
      case "session.steer": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        addMessage(t, "user", event.prompt, at, false, true);
        continue;
      }
      case "session.notify": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        const label = event.notify === NOTIFY_ME ? "told you" : `told thread ${event.notify.slice(0, 8)}`;
        addWork(t, { createdAt: at, label, detail: event.text, tone: "notice", sourceActivityKind: "runtime.notify" }, at);
        continue;
      }
      case "session.permission": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        const permission: PermissionPrompt = {
          askId: event.askId,
          turnId: t.summary.turnId,
          sessionId: t.summary.sessionId,
          toolName: event.toolName,
          ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
          input: event.input,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
          options: event.options,
          createdAt: at,
          outcome: null,
          optionId: null,
        };
        // A subagent's own prompt sits inside that subagent's fold, where the fold's title says who is asking; a
        // prompt in the flat stream says nothing about which of several running agents raised it.
        if (event.parentToolUseId !== undefined) {
          changeFold(t, event.parentToolUseId, at, run => ({ ...run, prompts: [...run.prompts, permission] }));
          promptRows.set(event.askId, t.subagents.get(event.parentToolUseId)!);
          continue;
        }
        promptRows.set(event.askId, push({ id: `permission:${event.askId}`, kind: "permission", createdAt: at, permission }));
        continue;
      }
      case "session.permission.closed": {
        const index = promptRows.get(event.askId);
        const row = index === undefined ? undefined : timeline[index];
        if (index === undefined || row === undefined) continue;
        if (row.kind === "subagent") {
          replace(index, {
            ...row,
            subagent: {
              ...row.subagent,
              prompts: row.subagent.prompts.map(p =>
                p.askId === event.askId ? { ...p, outcome: event.outcome, optionId: event.optionId ?? null } : p,
              ),
            },
          });
          continue;
        }
        if (row.kind !== "permission") continue;
        replace(index, {
          ...row,
          permission: { ...row.permission, outcome: event.outcome, optionId: event.optionId ?? null },
        });
        continue;
      }
      case "session.done": {
        recordReply(turnFor(event, at), event.result, at);
        continue;
      }
      case "session.end": {
        // An end for a turn nothing here opened is the runtime's word that a send never became a turn, sent so a wait
        // on the thread is answered; it opens no turn, since the reply, the read and the wait all fold these rows and
        // would take it for the thread's latest. It still ends the turn it interrupted, a thread running one turn at a
        // time, and where it says why, that sentence is the only account that send will ever have, so it stands as a
        // row of its own rather than nowhere.
        if (turn === null || (event.turnId !== undefined && event.turnId !== turn.summary.turnId)) {
          if (turn !== null && turn.summary.state === "running") endRunningTurn(turn, at);
          if (event.reason !== undefined) {
            push(workEntry({ id: `refusal:${event.turnId ?? event.sessionId}`, turnId: event.turnId ?? null, createdAt: at, label: event.reason, tone: "error", sourceActivityKind: "runtime.error" }, at));
          }
          continue;
        }
        const t = turn;
        if (t.summary.state !== "running") continue;
        if (t.reply !== null) {
          setState(t, t.reply.status);
        } else {
          const error = event.reason ?? (event.sawResult
            ? "session exited without a result"
            : `session exited without a result (exit code ${event.exitCode ?? "unknown"})`);
          finishTurn(t, { status: "failed", error }, at);
        }
        continue;
      }
      default: {
        const _exhaustive: never = event;
        continue;
      }
    }
  }

  /** Every line a subagent wrote, inside its own fold. Read before the parent's own rules so a child's prose never
   * reaches the parent's open message: two agents writing at once would otherwise land in one paragraph with no
   * space between their sentences. */
  function applyChildDelta(t: TurnBuild, e: SessionDelta, at: string, parent: string): void {
    switch (e.kind) {
      case "text":
      case "thinking":
        addFoldLine(t, parent, at, { createdAt: at, kind: e.kind, label: e.text });
        return;
      case "tool_use": {
        const key = foldLineKey(parent, e.toolUseId);
        // The call as it stands, kept beside the line it opens: its result carries none of its own input, and both
        // the line and the past it turns into are written off that input alone.
        const open = key === undefined ? undefined : t.childCalls.get(key);
        const call = { name: e.toolName ?? open?.name ?? "tool", input: (open?.input ?? "") + e.text };
        if (key !== undefined) t.childCalls.set(key, call);
        addFoldLine(t, parent, at, { createdAt: at, kind: "tool", label: toolActivityLine(call.name, call.input), status: "inProgress" }, key);
        return;
      }
      case "note":
        addFoldLine(t, parent, at, { createdAt: at, kind: "text", label: e.text });
        return;
      case "tool_result": {
        const key = foldLineKey(parent, e.toolUseId);
        const call = key === undefined ? undefined : t.childCalls.get(key);
        const did = call === undefined || e.isError === true ? undefined : toolDoneLine(call.name, call.input);
        addFoldLine(
          t,
          parent,
          at,
          {
            createdAt: at,
            kind: "tool",
            status: e.isError === true ? "failed" : "completed",
            ...(did !== undefined ? { label: did } : {}),
            ...(toolResultLine(e.text, e.isError === true) !== undefined ? { detail: toolResultLine(e.text, e.isError === true)! } : {}),
          },
          key,
        );
        if (key !== undefined) t.childCalls.delete(key);
        return;
      }
      default: {
        const _exhaustive: never = e.kind;
        return;
      }
    }
  }

  function applyDelta(t: TurnBuild, e: SessionDelta, at: string): void {
    if (e.parentToolUseId !== undefined) {
      closeOpenMessage(t);
      applyChildDelta(t, e, at, e.parentToolUseId);
      return;
    }
    // The launching call's own result closes the fold. Where the harness marked that result its own note to the
    // agent it neither draws nor ends anything: it is written to a model, carries handles no person needs, and says
    // a background agent was launched rather than that it finished. Where it is the subagent's answer it is the last
    // line inside the fold, which is where that subagent's work is read.
    if (e.kind === "tool_result" && e.toolUseId !== undefined && t.subagents.has(e.toolUseId)) {
      if (internalToolResult(e.text)) return;
      const answer = toolResultLine(e.text, e.isError === true);
      if (answer !== undefined) addFoldLine(t, e.toolUseId, at, { createdAt: at, kind: "text", label: answer });
      changeFold(t, e.toolUseId, at, run => ({ ...run, state: e.isError === true ? "failed" : "done", endedAt: at || null }));
      t.tools.delete(e.toolUseId);
      return;
    }
    switch (e.kind) {
      case "text": {
        // Text of another of the harness's messages is a bubble of its own, the rule messageId carries.
        if (t.openMessageId !== null && e.messageId !== undefined && e.messageId !== t.openMessageId) closeOpenMessage(t);
        const open = t.openMessage !== null ? message(t.openMessage) : undefined;
        if (t.openMessage !== null && open) {
          replace(t.openMessage, messageEntry({ ...open, text: open.text + e.text, updatedAt: at || open.updatedAt }));
        } else {
          t.openMessage = addMessage(t, "assistant", e.text, at, true);
          t.openMessageId = e.messageId ?? null;
        }
        t.sawText = true;
        return;
      }
      case "note": {
        // The harness's own line about itself, shown the way the resumed-past-a-cut line is: a notice beside the
        // work, never a message under the agent's name and never a failure. It ends no message of the agent's, as
        // it ends none in the read and none on the terminal's stream.
        addWork(t, { createdAt: at, label: e.text, tone: "notice", sourceActivityKind: "harness.note" }, at);
        return;
      }
      case "thinking": {
        closeOpenMessage(t);
        const last = timeline[timeline.length - 1];
        if (last?.kind === "work" && last.entry.tone === "thinking" && last.entry.turnId === t.summary.turnId) {
          replace(timeline.length - 1, workEntry(thinkingEntry(last.entry, (last.entry.detail ?? "") + e.text), last.createdAt));
          return;
        }
        addWork(t, thinkingEntry({ createdAt: at, label: "Thinking", tone: "thinking", sourceActivityKind: "reasoning" }, e.text), at);
        return;
      }
      case "tool_use": {
        closeOpenMessage(t);
        const key = e.toolUseId ?? (t.openAnonymousTool !== null ? `anon:${t.openAnonymousTool}` : undefined);
        const existing = key !== undefined ? t.tools.get(key) : undefined;
        const existingEntry = existing ? work(existing.entryIndex) : undefined;
        if (existing && existingEntry && existingEntry.toolLifecycleStatus === "inProgress") {
          existing.input += e.text;
          const arriving = e.toolName ?? existingEntry.label;
          const grown = toolCallFacts(arriving, existing.input);
          const named = grown.title ?? arriving;
          replace(existing.entryIndex, workEntry({ ...existingEntry, label: named, toolTitle: named, ...grown }, timeline[existing.entryIndex]!.createdAt));
          return;
        }
        const toolName = e.toolName ?? "tool";
        const facts = toolCallFacts(toolName, e.text);
        const named = facts.title ?? toolName;
        const base: WorkLogEntry = {
          id: "", turnId: null, createdAt: at, label: named, toolTitle: named, tone: "tool",
          toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started",
          ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
        };
        const index = addWork(t, { ...base, ...facts }, at);
        const registryKey = e.toolUseId ?? `anon:${index}`;
        t.tools.set(registryKey, { entryIndex: index, input: e.text });
        if (e.toolUseId === undefined) t.openAnonymousTool = index;
        return;
      }
      case "tool_result": {
        closeOpenMessage(t);
        const key = e.toolUseId ?? (t.openAnonymousTool !== null ? `anon:${t.openAnonymousTool}` : undefined);
        const call = key !== undefined ? t.tools.get(key) : undefined;
        const entry = call ? work(call.entryIndex) : undefined;
        const note = internalToolResult(e.text);
        const output = note ? undefined : summarizeOutput(e.text);
        if (!call || !entry) {
          addWork(t, {
            createdAt: at, label: e.toolName ?? "tool", toolTitle: e.toolName ?? "tool", tone: "tool",
            ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
            toolLifecycleStatus: e.isError ? "failed" : "completed", sourceActivityKind: "tool.completed",
            ...(output !== undefined ? { detail: output } : {}),
          }, at);
          return;
        }
        const failed = e.isError === true || entry.toolLifecycleStatus === "failed";
        if (!note) call.answered = { at, failed };
        replace(call.entryIndex, workEntry({
          ...entry,
          toolLifecycleStatus: failed ? "failed" : "completed",
          sourceActivityKind: "tool.completed",
          ...(output !== undefined ? { detail: output } : {}),
        }, timeline[call.entryIndex]!.createdAt));
        if (e.toolUseId === undefined) t.openAnonymousTool = null;
        return;
      }
      default: {
        const _exhaustive: never = e.kind;
        return;
      }
    }
  }

  const running = turn !== null && turn.summary.state === "running";
  const messages: ChatMessage[] = [];
  const workEntries: WorkLogEntry[] = [];
  for (const entry of timeline) {
    if (entry.kind === "message") messages.push(entry.message);
    else if (entry.kind === "work") workEntries.push(entry.entry);
  }
  return { turns, messages, workEntries, timeline, latestTurn: turns[turns.length - 1] ?? null, running, model, harness, agent, permissionMode };
}

/** Reasoning renders as one collapsed line (preview) that opens onto the text (detail). */
function thinkingEntry<T extends Omit<WorkLogEntry, "id" | "turnId" | "detail" | "preview">>(base: T, text: string): T & Pick<WorkLogEntry, "detail" | "preview"> {
  const preview = summarizeOutput(text);
  return { ...base, detail: text, ...(preview !== undefined ? { preview } : {}) };
}

/** The line one of a subagent's tool calls owns inside its fold; a call with no id of its own takes a line of its
 * own rather than overwriting the last. */
function foldLineKey(parent: string, toolUseId: string | undefined): string | undefined {
  return toolUseId === undefined ? undefined : `${parent}:t${toolUseId}`;
}

function messageEntry(m: ChatMessage): TimelineEntry {
  return { id: m.id, kind: "message", createdAt: m.createdAt, message: m };
}

function workEntry(w: WorkLogEntry, createdAt: string): TimelineEntry {
  return { id: w.id, kind: "work", createdAt, entry: w };
}

function turnState(status: TurnResult["status"]): TurnState {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    default: {
      const _exhaustive: never = status;
      return "error";
    }
  }
}

function compactLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(line => line.length > 0);
}

/** Whether a prompt is one nobody has answered. Written once because three surfaces ask it and each of them says
 * something different when it is true: the prompt row offers its options, the thread's row and header say the
 * thread needs the person, and the elapsed count says the thread is waiting rather than working. */
export function isPromptOpen(permission: Pick<PermissionPrompt, "outcome">): boolean {
  return permission.outcome === null;
}

/** The line a row shows for a command: its first non-empty line, whole; the row's width cuts it. */
export function commandFirstLine(command: string): string {
  return compactLines(command)[0] ?? command.trim();
}

/** First non-empty line, cut to 84 characters like t3code's inline preview; fence-only output has nothing to show. */
export function summarizeOutput(text: string): string | undefined {
  const lines = compactLines(text);
  const first = lines.find(line => line !== "```");
  if (first === undefined) return lines.length > 1 ? `${lines.length} lines` : undefined;
  return first.length <= 84 ? first : `${first.slice(0, 83).trimEnd()}…`;
}
