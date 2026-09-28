// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's chat thread: the thread pinned from the sidebar, or the
// last one of the persisted transcript, replayed from sessions.history on
// mount and folded together with that thread's live session.* events. A row
// sits where the runtime stamped it, never where this client first saw it,
// so a reply and the socket build one thread whichever of them lands first.
// The hook itself waits for the reply before it takes a live event, since
// the socket is FIFO and anything pushed before the reply is already in it.
// The adapter derives the view; this hook only keeps the event list, the
// arrival clock for unstamped events, and the things the wire cannot know
// yet: a prompt the user just sent, a send that failed locally, a new
// thread requested while a turn was still running, and a send still in
// flight when the person moved to another thread, with the key its rows
// wait under. A turn a new thread leaves behind keeps running as its own
// thread: the runtime runs a workspace's threads side by side and holds
// each to one turn, so a fresh view owes the left one nothing.
import { isProjectHomeKey } from "../../protocol/store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSessionEvent } from "@wsp/protocol";
import type { ImageRecord, SessionEvent, SessionHarness, SessionView } from "@wsp/protocol";
import { useProtocolEvents, useStore } from "../../protocol/store";
import type { ProtocolEvent } from "../../protocol/client";
import { deriveSession, entryTurnId, type TimelineEntry, type TurnSummary } from "./adapt";

export interface ChatThreadView {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly turns: ReadonlyArray<TurnSummary>;
  readonly latestTurn: TurnSummary | null;
  readonly running: boolean;
  readonly activeTurnStartedAt: string | null;
  /** The latest turn once it has settled; null while it runs or before any turn. */
  readonly settled: TurnSummary | null;
  /** The folder the thread's harness runs in, as its last session.start named it, or, with no start in view, as the
   * row the next send resumes carries: the strip shows it and the send runs there. */
  readonly cwd: string | null;
  /** Where the agent's tool shell last was, as its tool calls moved it; null until one did. */
  readonly shellCwd: string | null;
  /** What the last session.start announced about the CLI; the composer's catalog reads it. */
  readonly harness: SessionHarness | null;
  readonly model: string | null;
  /** The thread's own record off its transcript: the agent it runs on and the access its last turn started at,
   * which the composer reads before the thread's rows, since the rows are capped and the transcript keeps a
   * thread longer. Null before a start carried them. */
  readonly agent: string | null;
  readonly permissionMode: string | null;
}

export interface ChatThreadHandle {
  readonly view: ChatThreadView;
  /** False until the history reply for this workspace has landed. */
  readonly hydrated: boolean;
  /** True while this thread's turn is running or its send is in flight. */
  readonly busy: boolean;
  /** True from a send until its session.start lands (or its turn ends without one). */
  readonly sending: boolean;
  /** True from a new-thread request until its first session.start: the next send must not resume the old session. */
  readonly fresh: boolean;
  /** The harness session the next send resumes: the shown thread's last started turn, else, on an empty latest view, the workspace's remembered one, else, pinned, the one its session row carries; none while fresh. */
  readonly resume: string | undefined;
  /** The thread the next send names when it has no session to resume: the one the view shows, its launch having failed, so the runtime runs the message as that thread's first turn. None on a fresh view or an empty latest one, where the runtime opens a thread. */
  readonly thread: string | undefined;
  /** The held thread's runtime id, else the pinned one, else the workspace id before the thread has one; keys what belongs to this thread outside the transcript. */
  readonly threadKey: string;
  /** The last send's start, once it landed: the key its rows waited under (the thread id the view held or was pinned to, or the workspace id before the thread had one) and the thread that start carried. Null while a send is in flight, after one that settled without a start, and before any. */
  readonly named: NamedStart | null;
  /** Optimistic user message for a send, with the request id the send carries; the session.start stamped with it replaces it. */
  readonly appendUserTurn: (prompt: string, requestId: string, attachments?: ReadonlyArray<ImageRecord>) => void;
  /** A send that failed before the runtime emitted anything. */
  readonly appendLocalError: (message: string) => void;
  readonly setSending: (sending: boolean) => void;
  /** Clears the visible thread and marks the next send as a fresh session. */
  readonly startNewThread: () => void;
}

/** Where a send's rows waited and where its start took them. */
export interface NamedStart {
  readonly key: string;
  readonly thread: string;
}

/** A send as this client made it: its text, and the request id it carried, which the runtime stamps on the start it opens. */
export interface Sent {
  readonly text: string;
  readonly requestId: string;
}

/** A send this view holds the words of: when it was made, what rode with it, and, once a turn refused it, which turn. */
export interface Kept extends Sent {
  readonly at: string;
  readonly attachments?: ReadonlyArray<ImageRecord>;
  readonly turnId?: string;
}

export interface ThreadState {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
  readonly pendingPrompt: Kept | null;
  readonly localErrors: ReadonlyArray<{ message: string; at: string }>;
  readonly fresh: boolean;
  /** A send in flight, with the turn that had settled when it began, until its session.start lands or a reload rebuilds this. */
  readonly sending: { readonly after: string | undefined } | null;
  /** Every thread id the history reply carried, this view or the one before it in this workspace held, or the wire showed and this view dropped; while fresh, an event from none of them is the person's own send. */
  readonly known: ReadonlyArray<string>;
  /** The last send's start once it landed: the key its rows waited under (the thread id the view held or was pinned to, or the workspace id without one) and the thread the start carried. Null from the send until then, and after a send that settled without a start. */
  readonly named: NamedStart | null;
  /** A send from a view without a start, left in flight by a view change: the key its rows wait under (the pin, or the workspace id from the latest view), the thread the view showed, which its start comes under (none from an empty view, whose start opens a thread the view never knew), and the send itself, whose start still names those rows from whichever view sees it. */
  readonly stray: (Sent & { readonly key: string; readonly thread?: string }) | null;
  /** The sends of this view that ended without a turn of their own, each under the turn whose end refused it. The
   * runtime writes a row for a send only once its harness announces itself, so a turn that died before that leaves
   * the person's words nowhere: this view is their only home, and it keeps them rather than letting the next send
   * write over the slot they sat in. */
  readonly refused: ReadonlyArray<Kept>;
}

const EMPTY: ThreadState = { events: [], arrivals: [], pendingPrompt: null, localErrors: [], fresh: false, sending: null, known: [], named: null, stray: null, refused: [] };
const now = () => new Date().toISOString();

/** One row as the view holds it: the event and when this client saw it, which stamps a row the wire left unstamped. */
interface HeldRow {
  readonly event: SessionEvent;
  readonly at: string;
}

function heldRows(state: ThreadState): HeldRow[] {
  return state.events.map((event, index) => ({ event, at: state.arrivals[index] ?? "" }));
}

function withRows(rows: ReadonlyArray<HeldRow>): Pick<ThreadState, "events" | "arrivals"> {
  return { events: rows.map(r => r.event), arrivals: rows.map(r => r.at) };
}

/**
 * Whether a row already held belongs after one arriving. Between two lines of one turn the runtime's own counter
 * decides, since that is the place it gave them and a restart writes the same line again under a new clock;
 * everything else is placed by the stamp the runtime wrote. `seq` never reaches a history reply, so nothing else can
 * place a reply's rows against the live ones a view holds, and a row from before the stamp existed has no order of
 * its own and keeps the place it arrived in.
 */
function comesAfter(held: SessionEvent, arriving: SessionEvent): boolean {
  if (
    held.type === "session.delta" &&
    arriving.type === "session.delta" &&
    held.turnId === arriving.turnId &&
    held.line !== undefined &&
    arriving.line !== undefined
  ) {
    return held.line > arriving.line;
  }
  if (held.at === undefined || arriving.at === undefined) return false;
  return held.at > arriving.at;
}

/**
 * Where the protocol puts a row inside its turn, which every copy of that row carries: a delta's line, an ask's id,
 * a steer's request id, and the one start, done or end a turn ever writes. Nothing for a row the wire gave no place.
 */
function ownPlace(e: SessionEvent): string | undefined {
  if (e.type === "session.permission" || e.type === "session.permission.closed") return `${e.type}:${e.askId}`;
  if (e.turnId === undefined) return undefined;
  switch (e.type) {
    case "session.start":
    case "session.done":
    case "session.end":
      return `${e.type}:${e.turnId}`;
    case "session.delta":
      return e.line === undefined ? undefined : `session.delta:${e.turnId}:${e.line}`;
    case "session.steer":
      return e.requestId === undefined ? undefined : `session.steer:${e.turnId}:${e.requestId}`;
    case "session.notify":
      return `session.notify:${e.turnId}:${e.notify}`;
    default: {
      const _exhaustive: never = e;
      return undefined;
    }
  }
}

/**
 * The row itself. A host that re-opens a running turn reads its run again and writes the lines the store never got
 * under a fresh clock with the same place, so the place is what says two copies are one row; `at` only says which
 * host's clock wrote a copy. A row with no place of its own is named by its stamp and its words instead, and a
 * transcript that truly holds one row twice is told by the fold's tally rather than by this.
 */
function rowIdentity(e: SessionEvent): string {
  const words = e.type === "session.delta" ? `${e.kind}:${e.text}` : e.type === "session.steer" ? e.prompt : "";
  return ownPlace(e) ?? `copy:${e.type}:${e.turnId ?? ""}:${e.at ?? ""}:${words}`;
}

/** Folds rows into the ones held, each by its own order rather than by when it arrived, each row written once. */
function foldIn(held: ReadonlyArray<HeldRow>, arriving: ReadonlyArray<HeldRow>): HeldRow[] {
  const written = new Map<string, number>();
  for (const row of held) {
    const id = rowIdentity(row.event);
    written.set(id, (written.get(id) ?? 0) + 1);
  }
  const rows: HeldRow[] = [];
  let next = 0;
  for (const row of arriving) {
    const id = rowIdentity(row.event);
    const seen = written.get(id) ?? 0;
    if (seen > 0) {
      written.set(id, seen - 1);
      continue;
    }
    while (next < held.length && !comesAfter(held[next]!.event, row.event)) rows.push(held[next++]!);
    rows.push(row);
  }
  while (next < held.length) rows.push(held[next++]!);
  return rows;
}

/** A live row is one this view has not seen, so it is placed rather than folded: no tally, one copy per list. */
function append(state: ThreadState, e: SessionEvent, at: string): ThreadState {
  const starts = e.type === "session.start";
  let index = state.events.length;
  while (index > 0 && comesAfter(state.events[index - 1]!, e)) index--;
  return {
    ...state,
    events: [...state.events.slice(0, index), e, ...state.events.slice(index)],
    arrivals: [...state.arrivals.slice(0, index), at, ...state.arrivals.slice(index)],
    pendingPrompt: starts ? null : state.pendingPrompt,
    refused: starts ? replaced(state.refused, [e]) : state.refused,
    fresh: starts ? false : state.fresh,
  };
}

/** The thread ids a list of events carries, each once, in first appearance order. */
function threadIds(events: ReadonlyArray<SessionEvent>): string[] {
  return [...new Set(events.flatMap(e => (e.threadId === undefined ? [] : [e.threadId])))];
}

function knowing(known: ReadonlyArray<string>, events: ReadonlyArray<SessionEvent>): ReadonlyArray<string> {
  const more = threadIds(events).filter(id => !known.includes(id));
  return more.length === 0 ? known : [...known, ...more];
}

/**
 * The kept sends a start among these events replaces. A start carrying a send's request id is the runtime's own row
 * for that send, and the words this view stood in with are the runtime's to draw from there: two clients racing on
 * one thread can land another turn's end inside a send's launch window, which keeps its words before its own start
 * has come.
 */
function replaced(refused: ReadonlyArray<Kept>, events: ReadonlyArray<SessionEvent>): ReadonlyArray<Kept> {
  const kept = refused.filter(sent => !events.some(e => startOf(sent, e)));
  return kept.length === refused.length ? refused : kept;
}

/** A send settling at an end wrote no start, since a start settles it first: its words go under the turn that end names. */
function keeping(state: ThreadState, turnId?: string): Pick<ThreadState, "pendingPrompt" | "refused"> {
  const sent = state.pendingPrompt;
  return sent === null ? { pendingPrompt: null, refused: state.refused } : { pendingPrompt: null, refused: [...state.refused, { ...sent, ...(turnId === undefined ? {} : { turnId }) }] };
}

/**
 * The history reply, folded to the selected thread, or to its last thread when none is. A send in flight
 * decides otherwise: a view showing a thread keeps it, whether that send resumed its session or named it
 * for a first turn after a failed launch, since another thread's start in the reply is another client's,
 * while a view showing none takes the thread whose start carries the prompt it sent, since that send opened
 * a new one, and stays where it was until the reply shows it, since any other new thread may be another
 * client's. A new-thread request that landed while history was in flight wins over the transcript it asked
 * to leave, unless the transcript already holds the thread that request opened, told the same way; a send
 * whose session.start the transcript cannot hold yet stays pending, its prompt still shown. The reply's rows are
 * folded into the ones this view already holds for that thread, each row by its own order and written once, so a
 * live row of the running turn the reply was built too early to carry keeps its place among them.
 */
export function reloadTranscript(s: ThreadState, events: ReadonlyArray<SessionEvent>, at: string, threadId: string | null = null): ThreadState {
  const own = foldTo(s, events, threadId);
  const chosen = own === undefined ? events.at(-1)?.threadId : own;
  const thread = own === null ? [] : events.filter(e => e.threadId === chosen);
  const known = knowing(s.known, events);
  const strayed = replayStray(s, events);
  if (!s.fresh || thread.length > 0) {
    const held = own === null ? [] : heldRows(s).filter(r => r.event.threadId === chosen);
    const rows = foldIn(held, thread.map(event => ({ event, at })));
    const send = replaySend(s, thread, threadId);
    return { ...EMPTY, ...withRows(rows), known, stray: s.stray, ...send, refused: replaced(send.refused, thread), ...strayed };
  }
  return { ...s, known, ...strayed };
}

/**
 * The thread a reply folds to: undefined for its last one, null for none. Idle, the pin, else the last thread,
 * or, fresh, only the dead thread of a send that already settled here. During a send, a view showing a thread
 * keeps it; one showing none takes the thread its send opened, else stays empty.
 */
function foldTo(s: ThreadState, events: ReadonlyArray<SessionEvent>, threadId: string | null): string | null | undefined {
  const shown = s.events.length === 0 ? null : s.events.at(-1)?.threadId;
  if (s.sending === null) return s.fresh ? shown : threadId ?? undefined;
  return shownThread(s, threadId) ?? openedThread(s, events) ?? shown;
}

/** The thread a send from a view showing none opened, as a reply shows it: the one whose start carries the sent prompt, else one the view never knew with no start at all, its harness dead before init. */
function openedThread(s: ThreadState, events: ReadonlyArray<SessionEvent>): string | undefined {
  const start = events.find(e => startsSend(s, e));
  if (start !== undefined) return start.threadId;
  return threadIds(events).findLast(id => !s.known.includes(id) && !events.some(e => e.type === "session.start" && e.threadId === id));
}

/**
 * What a replayed thread did with the send in flight, read the way live events would settle it: the events past the
 * turn that had settled when it began. A start among them is the send's own row and the prompt goes with it; an end
 * with no start before it is a turn that died before it wrote anything, and the words stay under that turn.
 */
function replaySend(s: ThreadState, thread: ReadonlyArray<SessionEvent>, pinned: string | null): Pick<ThreadState, "sending" | "named" | "pendingPrompt" | "refused"> {
  const settled = { sending: null, named: null, pendingPrompt: null, refused: s.refused };
  if (s.sending === null) return settled;
  const { after } = s.sending;
  const since = thread.slice(thread.findLastIndex(e => e.turnId === after) + 1);
  const start = since.find(e => e.type === "session.start" && (shownThread(s, pinned) !== undefined || startsSend(s, e)));
  if (start !== undefined) return { ...settled, named: nameOf(heldThreadId(s) ?? pinned ?? start.workspaceId, start) };
  const ended = since.find(e => e.type === "session.end");
  if (ended === undefined) return { sending: s.sending, named: null, pendingPrompt: s.pendingPrompt, refused: s.refused };
  return { sending: null, named: null, ...keeping(s, ended.turnId) };
}

/** What a reply did with a send a view change left in flight, read the way the dropped live events would have settled it. */
function replayStray(s: ThreadState, events: ReadonlyArray<SessionEvent>): Partial<Pick<ThreadState, "stray" | "named">> {
  if (s.stray === null) return {};
  const folded = events.reduce<ThreadState>((st, e) => (st.stray === null ? st : dropEvent(st, e)), { ...s, named: null });
  if (folded.stray !== null) return {};
  return folded.named === null ? { stray: null } : { stray: null, named: folded.named };
}

function nameOf(key: string, start: SessionEvent): NamedStart {
  return { key, thread: start.threadId ?? start.workspaceId };
}

/** The view's last session.start: what its thread is held and resumed by. A harness that dies before its start leaves events under ids no start announced, and those name nothing. */
function lastStart(events: ReadonlyArray<SessionEvent>): SessionEvent | undefined {
  return events.findLast(e => e.type === "session.start");
}

function heldThreadId(state: ThreadState): string | undefined {
  return lastStart(state.events)?.threadId;
}

/**
 * The thread a view shows: the one its events carry, started or dead before its start, else the pin. A send from
 * it resumes its session or, without one, names it for a first turn, so every event of that send comes under it.
 * A fresh view or an empty latest one shows none: its send opens a thread the view never knew.
 */
function shownThread(state: ThreadState, pinned: string | null): string | undefined {
  return state.events.at(-1)?.threadId ?? pinned ?? undefined;
}

/** Whether an event comes from the harness a send opened: under the thread the view showed, or, from a view showing none, under a thread the view never knew, since the runtime mints one at the start and a harness that dies before init carries it too. */
function fromSend(state: ThreadState, e: SessionEvent, shown: string | undefined): boolean {
  return shown === undefined ? unknownThread(state, e) : e.threadId === shown;
}

/** An event from no thread the view knows is the person's own send: the runtime mints its id at the start, and a harness that dies before init carries it too. */
function unknownThread(state: ThreadState, e: SessionEvent): boolean {
  return e.threadId === undefined || !state.known.includes(e.threadId);
}

/** The start a send opened: the one the runtime stamped with the send's request id, or, when the start carries none (a client that sent none), the one carrying the send's text. By thread id alone two clients' starts look the same, and by text so do two clients sending the same words at once. */
function startOf(sent: Sent, e: SessionEvent): boolean {
  if (e.type !== "session.start") return false;
  return e.requestId !== undefined ? e.requestId === sent.requestId : e.prompt === sent.text;
}

/** The start of the send a view change left in flight: under the thread that view showed, or, from a view showing none, under a thread this view never knew. */
function startsStray(state: ThreadState, e: SessionEvent): boolean {
  const { stray } = state;
  return stray !== null && startOf(stray, e) && fromSend(state, e, stray.thread);
}

/** The start of the send in flight on a view showing no thread, under a thread the view never knew. */
function startsSend(state: ThreadState, e: SessionEvent): boolean {
  return state.sending !== null && state.pendingPrompt !== null && unknownThread(state, e) && startOf(state.pendingPrompt, e);
}

/** An event of the send in flight on a view showing no thread: its own start, or the done and end of a thread the view never knew, its harness dying before it could start. A start with another prompt, a delta or a steer is another client's thread. */
function sentEvent(state: ThreadState, e: SessionEvent): boolean {
  if (state.sending === null) return false;
  if (e.type === "session.start") return startsSend(state, e);
  return (e.type === "session.done" || e.type === "session.end") && unknownThread(state, e);
}

/**
 * An event the view does not hold. While a send a view change left in flight waits for its start, that
 * start names the rows under the stray's key; a thread the view never knew ending without one is that
 * send's harness dying before init, and its done alone keeps waiting for the end. Every other event
 * only makes its thread known, so a thread another client opened after this view's history cannot pass
 * for the person's own send later.
 */
export function dropEvent(state: ThreadState, e: SessionEvent): ThreadState {
  if (state.stray !== null && startsStray(state, e)) return { ...state, stray: null, named: nameOf(state.stray.key, e) };
  if (state.stray !== null && unknownThread(state, e)) {
    if (e.type === "session.end") return { ...state, stray: null };
    if (e.type === "session.done") return state;
  }
  const known = knowing(state.known, [e]);
  return known === state.known ? state : { ...state, known };
}

/**
 * A view holds one thread: once its events carry a thread id, or a pin names one, another thread's events are
 * not its own, and a send from it, resuming its session or naming it after a failed launch, lands under it too.
 * Fresh, before any event, it holds only its send's own events, or the start of a new thread a send left in
 * flight before it opened; a known thread waking is not its own, whether it was left, older, or resumed by that
 * send. An empty latest view idle takes anything; sending, unstamped events and its send's own.
 */
function inHeldThread(state: ThreadState, e: SessionEvent, pinned: string | null): boolean {
  const shown = shownThread(state, pinned);
  if (shown !== undefined) return e.threadId === shown;
  if (state.fresh) return sentEvent(state, e) || (startsStray(state, e) && unknownThread(state, e));
  return state.sending === null || e.threadId === undefined || sentEvent(state, e);
}

/**
 * Applies one live event; returns the same state object when the event belongs to a thread already known. A
 * send ends at its session.start, or at a session.end of some other turn than the one that had settled when
 * it began: that turn's own end still trails its done, and only the end opens the composer, while a harness
 * that dies before init produces only a done and an end under a new turn id.
 */
export function reduceEvent(state: ThreadState, e: SessionEvent, at: string, pinned: string | null = null): ThreadState {
  if (!inHeldThread(state, e, pinned)) return dropEvent(state, e);
  const next = append(state, e, at);
  if (state.sending === null) return state.stray !== null && startsStray(state, e) ? { ...next, stray: null, named: nameOf(state.stray.key, e) } : next;
  const starts = e.type === "session.start";
  const settles = starts || (e.type === "session.end" && e.turnId !== state.sending.after);
  const named = starts ? nameOf(heldThreadId(state) ?? pinned ?? e.workspaceId, e) : state.named;
  if (!settles) return next;
  return { ...next, sending: null, named, ...(starts ? {} : keeping(next, e.turnId)) };
}

function shallowEqual(a: object, b: object): boolean {
  const entries = Object.entries(a);
  if (entries.length !== Object.keys(b).length) return false;
  return entries.every(([key, value]) => {
    const other: unknown = Reflect.get(b, key);
    if (value === other) return true;
    return Array.isArray(value) && Array.isArray(other) && value.length === other.length && value.every((item, i) => item === other[i]);
  });
}

function sameEntry(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.createdAt !== b.createdAt) return false;
  if (a.kind === "message" && b.kind === "message") return shallowEqual(a.message, b.message);
  if (a.kind === "work" && b.kind === "work") return shallowEqual(a.entry, b.entry);
  if (a.kind === "proposed-plan" && b.kind === "proposed-plan") return shallowEqual(a.proposedPlan, b.proposedPlan);
  return false;
}

/**
 * The adapter rebuilds every entry from the whole event list, so without this
 * one text chunk would hand the memoized rows a new object per message and
 * re-render the whole thread. Entries whose content did not change keep the
 * object from the previous derivation.
 */
export function stabilizeEntries(next: ReadonlyArray<TimelineEntry>, previous: ReadonlyArray<TimelineEntry>): TimelineEntry[] {
  const byId = new Map(previous.map(entry => [entry.id, entry]));
  return next.map(entry => {
    const prev = byId.get(entry.id);
    return prev !== undefined && sameEntry(prev, entry) ? prev : entry;
  });
}

/** The person's own row for one send, from the click until the runtime's own row replaces it: one id the whole way,
 * since a row that changes identity under the list is torn down and built again where the person was reading. The
 * records and the request id ride it, so their thumbnails are there at the click rather than a roundtrip later. */
function sentEntry(sent: Kept): TimelineEntry {
  const { text, at, requestId, attachments } = sent;
  const id = `sent-user:${requestId}`;
  return {
    id,
    kind: "message",
    createdAt: at,
    message: { id, role: "user", text, turnId: null, streaming: false, createdAt: at, updatedAt: at, requestId, ...(attachments !== undefined ? { attachments } : {}) },
  };
}

export function deriveChatThread(state: ThreadState, previous: ReadonlyArray<TimelineEntry> = []): ChatThreadView {
  const model = deriveSession(state.events, { at: (_e, index) => state.arrivals[index] });
  const entries: TimelineEntry[] = [...model.timeline];
  // A kept send sits above the first row its turn wrote, whatever that row is: a reply the harness managed before it
  // died, or the line the runtime left in its place. A send still in flight has no turn yet and no rows under it, so
  // it sits at the tail, and so does one whose turn left no row at all.
  for (const one of state.refused) {
    const first = one.turnId === undefined ? -1 : entries.findIndex(e => entryTurnId(e) === one.turnId);
    entries.splice(first === -1 ? entries.length : first, 0, sentEntry(one));
  }
  if (state.pendingPrompt !== null) entries.push(sentEntry(state.pendingPrompt));
  state.localErrors.forEach(({ message, at }, index) => {
    const id = `local-error:${index}`;
    entries.push({
      id,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, turnId: null, label: message, tone: "error", sourceActivityKind: "runtime.error" },
    });
  });
  const latestTurn = model.latestTurn;
  let cwd: string | null = null;
  let shellCwd: string | null = null;
  for (const e of state.events) {
    if (e.type === "session.start" && e.cwd !== undefined) cwd = e.cwd;
    if (e.type === "session.delta" && e.cwd !== undefined) shellCwd = e.cwd;
  }
  return {
    entries: stabilizeEntries(entries, previous),
    turns: model.turns,
    latestTurn,
    running: model.running,
    activeTurnStartedAt: model.running ? (latestTurn?.startedAt ?? null) : null,
    settled: latestTurn !== null && !model.running ? latestTurn : null,
    cwd,
    shellCwd,
    harness: model.harness,
    model: model.model,
    agent: model.agent,
    permissionMode: model.permissionMode,
  };
}

interface ViewKey {
  readonly workspaceId: string;
  readonly threadId: string | null;
}

/**
 * The state one view leaves for the next: nothing across workspaces; within one, what it knew, and a send
 * still in flight from a view without a start, whose rows wait under the pin or, from the latest view, the
 * workspace id, and whose start comes under the thread that view showed, or, from an empty view, under a
 * thread no view holds yet.
 */
export function leaveView(s: ThreadState, from: ViewKey, to: ViewKey): ThreadState {
  if (from.workspaceId !== to.workspaceId) return EMPTY;
  const sent = s.sending !== null && heldThreadId(s) === undefined ? s.pendingPrompt : null;
  if (sent === null) return { ...EMPTY, known: knowing(s.known, s.events), stray: s.stray };
  const thread = shownThread(s, from.threadId);
  return { ...EMPTY, known: knowing(s.known, s.events), stray: { text: sent.text, requestId: sent.requestId, key: from.threadId ?? from.workspaceId, ...(thread === undefined ? {} : { thread }) } };
}

/** The row a view without a session.start resumes from: pinned, the thread's latest turn the harness answered; on the latest view, the turn the workspace remembers. */
function resumedRow(rows: ReadonlyArray<SessionView> | undefined, threadId: string | null, remembered: string | undefined): SessionView | undefined {
  if (threadId !== null) return rows?.findLast(r => r.threadId === threadId && r.claudeSessionId !== undefined);
  return remembered === undefined ? undefined : rows?.findLast(r => r.claudeSessionId === remembered);
}

/** The session the thread's last session.start opened; a turn that ended without one, its harness dead before init, names an id no harness ever held. */
export function startedSession(events: ReadonlyArray<SessionEvent>): string | undefined {
  return lastStart(events)?.sessionId;
}

/** A thread pinned from the sidebar, or the workspace's latest when none is; fresh opens the workspace's next
 * thread, which is what the store says while the centre is on that screen. */
export function useChatThread(workspaceId: string, threadId: string | null = null, fresh = false): ChatThreadHandle {
  const api = useStore(s => s.api);
  // Moves when a reconnect could not replay what the socket missed: the thread below is rebuilt from history.
  const gaps = useStore(s => s.gaps);
  const remembered = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.claudeSessionId);
  // The runtime stamps a row only once the harness announced its session, so a capped pinned thread resumes by its row and a dead one resumes nothing.
  const rowSession = useStore(s => resumedRow(s.sessions[workspaceId], threadId, remembered)?.claudeSessionId);
  const rowCwd = useStore(s => resumedRow(s.sessions[workspaceId], threadId, remembered)?.cwd);
  const viewKey = threadId === null ? workspaceId : `${workspaceId}/${threadId}`;
  const [state, setState] = useState<ThreadState>(EMPTY);
  const [viewed, setViewed] = useState({ workspaceId, threadId });
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const hydratedRef = useRef<string | null>(null);
  /** The view key a pin named for the transcript already in hand: that reading needs no reply, and asking for one
   * would drop what the socket pushes between the ask and it. Taken once, so a gap still rebuilds. */
  const carriedRef = useRef<string | null>(null);
  const previousEntries = useRef<ReadonlyArray<TimelineEntry>>([]);

  if (viewed.workspaceId !== workspaceId || viewed.threadId !== threadId) {
    const from = viewed;
    setViewed({ workspaceId, threadId });
    // A pin landing on the thread this view already holds is the same reading under a new name: the transcript
    // stays, so a view whose own first turn opened the thread it is now pinned to never blinks through loading.
    if (from.workspaceId === workspaceId && from.threadId === null && threadId !== null && heldThreadId(state) === threadId) {
      carriedRef.current = viewKey;
      setHydratedFor(viewKey);
    } else if (fresh && from.workspaceId === workspaceId && threadId === null) {
      // The pin left for the workspace's next thread: that screen shows nothing, so it needs no transcript and
      // waits for no reply.
      carriedRef.current = viewKey;
      setHydratedFor(viewKey);
      setState(s => ({ ...EMPTY, fresh: true, known: knowing(s.known, s.events), stray: s.stray }));
    } else {
      carriedRef.current = null;
      setState(s => leaveView(s, from, { workspaceId, threadId }));
    }
  }

  useEffect(() => {
    if (!api) return;
    // A project's home has no workspace yet, so there is no history to read for it.
    if (isProjectHomeKey(workspaceId)) {
      setHydratedFor(viewKey);
      return;
    }
    if (carriedRef.current === viewKey) {
      carriedRef.current = null;
      hydratedRef.current = viewKey;
      return;
    }
    let current = true;
    api.sessionHistory(workspaceId).then(
      events => {
        if (!current) return;
        const at = now();
        setState(s => reloadTranscript(s, events, at, threadId));
        hydratedRef.current = viewKey;
        setHydratedFor(viewKey);
      },
      (err: unknown) => {
        if (!current) return;
        const message = `history unavailable: ${err instanceof Error ? err.message : String(err)}`;
        setState(s => ({ ...s, localErrors: [...s.localErrors, { message, at: now() }] }));
        hydratedRef.current = viewKey;
        setHydratedFor(viewKey);
      },
    );
    return () => {
      current = false;
      hydratedRef.current = null;
    };
  }, [api, workspaceId, threadId, viewKey, gaps]);

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (hydratedRef.current !== viewKey) return;
      if (!isSessionEvent(e) || e.workspaceId !== workspaceId) return;
      setState(s => reduceEvent(s, e, now(), threadId));
    },
    [workspaceId, threadId, viewKey],
  );
  useProtocolEvents(onEvent);

  // A view without a start resumes its row: pinned, always; on the latest view, only while it is empty.
  const fromRow = !state.fresh && startedSession(state.events) === undefined && (threadId !== null || state.events.length === 0);
  const view = useMemo(() => {
    const next = deriveChatThread(state, previousEntries.current);
    previousEntries.current = next.entries;
    return fromRow && rowCwd !== undefined ? { ...next, cwd: rowCwd } : next;
  }, [state, fromRow, rowCwd]);
  const setSending = useCallback(
    (sending: boolean) =>
      setState(s => {
        if (sending) return s.sending === null ? { ...s, sending: { after: s.events.at(-1)?.turnId }, named: null } : s;
        return s.sending === null && s.stray === null ? s : { ...s, sending: null, named: null, stray: null };
      }),
    [],
  );
  const appendUserTurn = useCallback(
    (text: string, requestId: string, attachments: ReadonlyArray<ImageRecord> = []) =>
      setState(s => ({ ...s, pendingPrompt: { text, requestId, at: now(), ...(attachments.length > 0 ? { attachments } : {}) } })),
    [],
  );
  const appendLocalError = useCallback(
    (message: string) =>
      setState(s => ({
        ...s,
        pendingPrompt: null,
        localErrors: [...s.localErrors, { message, at: now() }],
      })),
    [],
  );
  const startNewThread = useCallback(() => setState(s => ({ ...EMPTY, fresh: true, known: knowing(s.known, s.events), stray: s.stray })), []);

  const resume = state.fresh ? undefined : (startedSession(state.events) ?? (fromRow ? (threadId === null ? remembered : rowSession) : undefined));
  return {
    view,
    hydrated: hydratedFor === viewKey,
    busy: state.sending !== null || view.running,
    sending: state.sending !== null,
    fresh: state.fresh,
    resume,
    thread: resume === undefined ? shownThread(state, threadId) : undefined,
    threadKey: heldThreadId(state) ?? threadId ?? workspaceId,
    named: state.named,
    appendUserTurn,
    appendLocalError,
    setSending,
    startNewThread,
  };
}
