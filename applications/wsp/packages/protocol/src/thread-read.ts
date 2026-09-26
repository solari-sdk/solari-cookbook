// SPDX-License-Identifier: AGPL-3.0-only
// One thread read off the transcript the host holds: the messages a reader
// sees, and the result its latest turn ended with. The app draws the same
// events as a timeline in its own adapter, which no client outside the browser
// may import, so the reading a line of text needs sits here and both the
// command line and the tool print it. A tool call is one row, the line
// toolActivityLine gives it; the call's output and the agent's reasoning are
// not rows, since a read is for the words of a thread and either of those runs
// to megabytes.
import { z } from "zod";
import { NEWER_TURN_LINE, notifyBody, notifyReply, toolActivityLine, toolDoneLine, turnEndLine } from "./format.js";
import type { SessionEvent, SessionPermissionEvent, TurnResult } from "./index.js";

/** Who a row of a read is: the message that opened or steered a turn, the agent's own words, one tool call, or the
 * turn's own end as the chat's footer states it. */
export const ThreadVoice = z.enum(["person", "agent", "tool", "turn"]);
export type ThreadVoice = z.infer<typeof ThreadVoice>;

export const ThreadMessage = z.object({
  who: ThreadVoice,
  /** Ms epoch from the runtime clock, as the event carried it; absent on a row written before the stamp existed. */
  at: z.number().optional(),
  text: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

/** Whether the event is this thread's. The runtime stamps every event with the thread it belongs to; a row from
 * before the stamp carries none and is read by no thread id, which is what a wait on such a thread already does. */
const inThread = (event: { threadId?: string }, threadId: string): boolean => event.threadId === threadId;

/** A turn that ended with no result and no reason from the runtime. */
const NO_RESULT_LINE = "turn ended without a result";

const message = (who: ThreadVoice, at: number | undefined, text: string): ThreadMessage => ({ who, ...(at !== undefined ? { at } : {}), text });

/** The thread's messages, oldest first: the prompt of every turn and every steer, the agent's text as it arrived,
 * one row per tool call, and each turn's end. Text runs into the open agent row until a call, a person's message or
 * the turn's end closes it, so a reply broken by tool calls reads as the pieces the agent wrote. A turn whose reply
 * never arrived as text (a transcript capped mid-turn, a harness that reports the message only at the end) takes it
 * from the result, the same rule the app's timeline follows. */
export function threadMessages(events: ReadonlyArray<SessionEvent>, threadId: string): ThreadMessage[] {
  const rows: ThreadMessage[] = [];
  /** The agent row text deltas append to and the harness message it is a piece of; nothing when the last row is
   * not one of the agent's. */
  let open: { row: number; messageId?: string } | undefined;
  /** The running turn's tool rows by the id of their call, since a call's JSON may arrive in pieces and the line is
   * drawn from the whole of it. */
  const calls = new Map<string, { row: number; name: string; input: string }>();
  let sawText = false;
  let replied = false;
  const say = (who: ThreadVoice, at: number | undefined, text: string): number => {
    open = undefined;
    rows.push(message(who, at, text));
    return rows.length - 1;
  };
  const turn = (at: number | undefined, result: TurnResult): void => {
    if (!sawText && result.text !== undefined && result.text !== "") say("agent", at, result.text);
    say("turn", at, turnEndLine(result));
    calls.clear();
    sawText = false;
  };
  for (const event of events) {
    if (!inThread(event, threadId)) continue;
    switch (event.type) {
      case "session.start":
        open = undefined;
        calls.clear();
        sawText = false;
        replied = false;
        if (event.prompt !== undefined) say("person", event.at, event.prompt);
        continue;
      case "session.steer":
        say("person", event.at, event.prompt);
        continue;
      case "session.delta": {
        if (event.kind === "text") {
          // An empty piece of text opens no row: an adapter that splits a reply hands over the tail of a short one
          // as nothing at all, and a row of no words is not a message anybody sent.
          if (event.text === "") continue;
          // A piece of another of the harness's messages opens a row of its own, the rule messageId carries.
          if (open?.messageId !== undefined && event.messageId !== undefined && event.messageId !== open.messageId) open = undefined;
          if (open === undefined) open = { row: rows.push(message("agent", event.at, event.text)) - 1, ...(event.messageId !== undefined ? { messageId: event.messageId } : {}) };
          else rows[open.row]!.text += event.text;
          sawText = true;
        } else if (event.kind === "tool_result") {
          // The call's own row turns to the past here and nowhere else: what the transcript holds a result for is
          // what actually ran, and a call still waiting on a person has no result and keeps its present.
          const answered = event.toolUseId === undefined ? undefined : calls.get(event.toolUseId);
          if (answered !== undefined && event.isError !== true) {
            const did = toolDoneLine(answered.name, answered.input);
            if (did !== undefined) rows[answered.row]!.text = did;
          }
        } else if (event.kind === "tool_use") {
          open = undefined;
          const key = event.toolUseId;
          const call = key === undefined ? undefined : calls.get(key);
          if (call !== undefined) {
            call.name = event.toolName ?? call.name;
            call.input += event.text;
            rows[call.row]!.text = toolActivityLine(call.name, call.input);
          } else {
            // A call the harness named an id for takes the pieces that follow it; one it named none for keys
            // nothing, so it is a row of its own rather than words appended to whichever call came before.
            const row = say("tool", event.at, toolActivityLine(event.toolName, event.text));
            if (key !== undefined) calls.set(key, { row, name: event.toolName ?? "tool", input: event.text });
          }
        }
        continue;
      }
      case "session.done":
        replied = true;
        turn(event.at, event.result);
        continue;
      case "session.end":
        // A turn the runtime ended before the harness replied: the read says so where the transcript has no result.
        if (!replied) turn(event.at, { status: "failed", error: event.reason ?? NO_RESULT_LINE });
        continue;
      default:
        continue;
    }
  }
  return rows;
}

/** The thread's latest turn as its transcript ended it, with the time of the row it came off: the done's result
 * when the turn replied, else failed with the runtime's reason when the runtime ended it. Nothing when the
 * transcript holds no turn of the thread. Read newest first, since an end may follow its done by minutes and an
 * older turn's done must not stand in for a newer turn's; a start met before that turn is one the thread began
 * afterwards and has not ended, which makes the turn below it the one before the thread's newest. */
function latestTurn(events: ReadonlyArray<SessionEvent>, threadId: string): { at?: number; result: TurnResult; running: boolean } | undefined {
  let end: Extract<SessionEvent, { type: "session.end" }> | undefined;
  let running = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (!inThread(event, threadId)) continue;
    if (event.type === "session.end") {
      if (end !== undefined) break;
      end = event;
      continue;
    }
    if (event.type === "session.done" && (end === undefined || event.turnId === end.turnId)) return { ...(event.at !== undefined ? { at: event.at } : {}), result: event.result, running };
    if (event.type === "session.start") {
      if (end === undefined) running = true;
      else if (event.turnId === end.turnId) break;
    }
  }
  if (end === undefined) return undefined;
  return { ...(end.at !== undefined ? { at: end.at } : {}), result: { status: "failed", error: end.reason ?? NO_RESULT_LINE }, running };
}

/** The result above alone, for a caller that only has to say how the turn went; a thread the transcript holds no
 * turn of answers with the thread's own row instead. */
export function threadResult(events: ReadonlyArray<SessionEvent>, threadId: string): TurnResult | undefined {
  return latestTurn(events, threadId)?.result;
}

/** The final reply alone, as the thread's finished line carries it: the whole message the thread's latest ended turn
 * left, at the time of the row that carried it. Nothing when the transcript holds no ended turn of the thread. The
 * row is the agent's where the text is the agent's own words and the turn's where it is an error or the footer, so
 * nothing the agent did not say is handed back under its name; a second row says when the thread has since started
 * another turn, since the reply is then the report before the one being written. */
export function threadReplyRows(events: ReadonlyArray<SessionEvent>, threadId: string): ThreadMessage[] {
  const latest = latestTurn(events, threadId);
  if (latest === undefined) return [];
  const { result } = latest;
  const reply = notifyReply(result, "whole");
  const body = notifyBody(result, "whole") ?? turnEndLine(result);
  const rows = [message(body === reply ? "agent" : "turn", latest.at, body)];
  // The note carries no clock: it is not a row the runtime recorded, it is what the transcript says about now.
  return latest.running ? [...rows, message("turn", undefined, NEWER_TURN_LINE)] : rows;
}

/** Which of the prompts a turn holds open the thread is waiting on: the oldest still open, since that is the one the
 * harness stopped at. The runtime leads a row's `asking` with it and a client answering off the transcript picks the
 * same one, so a listing and the line that answers never name two different questions. */
export function leadAsk<T>(open: Iterable<T>): T | undefined {
  return [...open][0];
}

/** The permission prompt this thread has open and nobody has answered, read off the transcript alone, by the rule
 * above; nothing where the thread is waiting on nobody. A client answering a prompt it did not watch arrive reads it
 * here, so the rule that a close ends a prompt is written once. */
export function openAsk(events: ReadonlyArray<SessionEvent>, threadId: string): SessionPermissionEvent | undefined {
  const open = new Map<string, SessionPermissionEvent>();
  for (const e of events) {
    if (e.threadId !== threadId) continue;
    if (e.type === "session.permission") open.set(e.askId, e);
    if (e.type === "session.permission.closed") open.delete(e.askId);
  }
  return leadAsk(open.values());
}
