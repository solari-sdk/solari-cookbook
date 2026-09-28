// SPDX-License-Identifier: AGPL-3.0-only
// The port every harness adapter is written against: the process a turn runs
// in (ExecStream, whatever launched it), the events an adapter normalizes its
// CLI's output into (AdapterEvent), what it reads off its binary when the
// runtime asks what that binary takes (HarnessCatalogAnswer), and what it
// reads out of the harness's own store when the runtime asks what that harness
// calls a session (SessionTitleReader), what it writes back into that store
// when a thread is named (SessionRenamer), and what it answers when the runtime
// asks the harness itself to name a thread (SessionTitleMaker), and how it
// takes an image with a turn (AttachmentRoad). It sits here, beside the wire types,
// so no adapter owns the interface its siblings implement. The runtime folds
// these into the SessionEvent shapes in index.ts that clients read, which is
// why the vocabulary they share (DeltaKind, TurnResult, SessionHarness) is
// declared once there and imported back here.
import type { DeltaKind, PermissionOption, PermissionOutcome, SessionHarness, TurnResult } from "./index.js";

/** The id every adapter's ask carries for "run this call" and for "refuse it", so the runtime's own answers (the
 * deny it sends when nobody answered in time) name an option without knowing which CLI raised the prompt. Options
 * beyond these two are the harness's own, ids and all. */
export const PERMISSION_ALLOW = "allow";
export const PERMISSION_DENY = "deny";

/** One permission prompt a harness raised mid-turn, as its adapter reads it off the CLI's own channel. The turn is
 * blocked on it: the CLI runs nothing until an option comes back, so every ask is answered, by the person or by the
 * runtime's wait. `askId` is the adapter's own handle for it, whatever the CLI keys its request by. */
export interface PermissionAsk {
  askId: string;
  toolName: string;
  toolUseId?: string;
  /** The tool call that launched the subagent this prompt came from; absent on the thread's own agent's prompts. */
  parentToolUseId?: string;
  /** The tool's input as the CLI sent it, JSON, the same text a tool_use delta carries. */
  input: string;
  /** The CLI's own one phrase for the call; absent where it named none. */
  detail?: string;
  /** Allow and deny, plus whatever else the CLI suggested for this call; a call that only asks the person something
   * carries its own answers instead, since there is no consent in it to give. */
  options: readonly PermissionOption[];
}

export type AdapterEvent =
  | {
      type: "session.start";
      sessionId: string;
      model?: string;
      cwd?: string;
      tools?: string[];
      harness?: SessionHarness;
    }
  | {
      type: "turn.delta";
      sessionId: string;
      kind: DeltaKind;
      text: string;
      /** Set off the id the harness itself sends with each message it writes, on the kinds it sends one for; left
       * out where it sends none. What a reader does with it is the rule on SessionDeltaEvent. */
      messageId?: string;
      toolName?: string;
      toolUseId?: string;
      isError?: boolean;
      /** The tool call that launched the subagent this line came from; absent on the thread's own agent's lines. */
      parentToolUseId?: string;
      /** The agent's tool shell folder after this tool_use, present only when the call moved it. */
      cwd?: string;
    }
  | { type: "turn.done"; sessionId: string; result: TurnResult }
  | {
      /** How many commands and subagents the harness reports running in the background right now, sent every time
       * that set changes. The turn is still working while the count is above zero, whatever its agent has said, so
       * this is what holds its idle clock the way an open permission prompt does. Read by the runtime alone: no
       * client sees it and nothing folds it into a wire event. */
      type: "turn.tasks";
      sessionId: string;
      running: number;
    }
  | { type: "permission.ask"; sessionId: string; ask: PermissionAsk }
  | {
      type: "permission.close";
      sessionId: string;
      askId: string;
      outcome: PermissionOutcome;
      /** The option that closed it, where one did. */
      optionId?: string;
    }
  | { type: "session.end"; sessionId: string; exitCode: number | null; sawResult: boolean };

/** What re-opening a turn a harness is still running on the machine takes: the run its stream reported, the session
 * the row already knows it by, and what that row records about the turn. The CLI announces its session, its model
 * and its folder once, and those lines may be behind whoever attaches, so the row is where they come from. */
export interface AdapterAttachOptions {
  run: string;
  sessionId: string;
  startedAt: number;
  model?: string;
  cwd?: string;
  onEvent: (event: AdapterEvent) => void;
}

/**
 * How one harness takes an image with a turn, the single fact that varies between them: `inline` puts the bytes in
 * the message the adapter writes, so nothing lands on the machine; `file` reads the image off the machine's disk, so
 * the runtime lands each one under the thread's images folder first and the adapter passes the paths on its flag.
 * An adapter that declares neither reads no image at all, and the runtime refuses such a turn in that agent's name
 * before the machine is asked.
 */
export type AttachmentRoad = "inline" | "file";

/** One image as the adapter for its road reads it: an inline road reads mediaType and bytes, a file road reads path,
 * where the runtime landed this image before the start. */
export interface TurnImage {
  mediaType: string;
  /** The image's bytes, base64, as the client sent them. */
  bytes: string;
  /** Where this image sits on the machine; set by the runtime on the file road only. */
  path?: string;
}

export interface ExecStream {
  readonly lines: AsyncIterable<string>;
  /** What a later host process attaches to this run by, on a factory whose runs outlive the process that launched
   * them; absent where they do not, and a turn on such a factory dies with its host. */
  readonly run?: string;
  /** The process this run leads on the computer the host runs on, where the factory starts one here; absent on a
   * factory whose run is on another machine, whose pids say nothing about this one. */
  readonly pid?: number;
  /** Graceful stop: SIGTERM to the process and to everything it started. A harness leaves its own children behind
   * when it goes (MCP servers under npx were seen holding 90 MB each for the machine's life), so a signal that
   * reaches the leader alone is not a stop. */
  teardown(): void;
  /** SIGKILL to the process and to everything it started. */
  kill(): void;
  /** Appends one line to the process's stdin channel, or answers gone when the process already ended where it runs;
   * rejects once the stream ended or when it was started without one. */
  write(line: string): Promise<"written" | "gone">;
  /** Ends the stdin channel: the process reads EOF. Nothing after the stream ended. */
  closeInput(): void;
  readonly exited: Promise<number | null>;
  /** The signal that ended the run, by the name the computer running it spells, once `exited` has settled; absent
   * where it ended on its own and on a road that cannot tell, which is every run read off a machine's exit file.
   * What says a harness was killed rather than answering with a code of its own. */
  readonly signalled?: string | undefined;
}

export interface ExecStreamFactory {
  (
    command: string,
    options: {
      env: Record<string, string>;
      /** Present, the process's stdin is a line channel seeded with these lines; absent, the process gets no channel. */
      input?: readonly string[];
    },
  ): ExecStream;
  /** Asks the machine whether it still holds a run this factory launched in an earlier process, and reads it from
   * its first byte when it does: what the run printed while no host was listening is on the machine, so the reader
   * is where the replay happens. `gone` is the machine's own answer that the run is not there, the one answer that
   * may take what is left of it. A machine that answers nothing rejects, since silence says nothing about the run
   * and must leave it running. Absent on a factory whose runs die with the process that launched them. */
  attach?(run: string, options: { input: boolean }): Promise<ExecStream | "gone">;
  /** Ends every run of this road the machine still holds that is not named in `keep`, and answers the ones it ended.
   * A host that went down mid-turn, and a turn whose row this host could not re-open, leave a harness process nobody
   * reads holding the machine's memory for its life, so a host that connects ends the runs it does not own. The runs
   * it does own are named rather than found, since only this host knows which reader it just opened. Absent on a
   * factory whose runs die with the process that launched them. */
  sweep?(keep: readonly string[]): Promise<readonly string[]>;
}

/** Settles false when the process exited inside `ms`, true when it is still running once `ms` passed. */
async function outlasted(stream: ExecStream, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    stream.exited.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return waited;
}

/**
 * The one road a turn's process leaves by, whatever launched it and whatever ended the turn: SIGTERM to it and to
 * everything it started, then SIGKILL to whatever is still there once the grace window passes. Settles when the
 * process is gone. A graceful stop can be acknowledged while background tasks keep the harness alive, which is why
 * the kill is not conditional on the harness's own word that it is going.
 */
export async function endRun(stream: ExecStream, graceMs: number): Promise<void> {
  stream.teardown();
  if (await outlasted(stream, graceMs)) stream.kill();
  await stream.exited;
}

/**
 * The result is the turn's end, but not the process's: the harness exits on the EOF the runtime closes its channel
 * with, and one that does not exit is a process nobody reads holding the machine's memory (seven were found alive on
 * one guest, the oldest fourteen hours past its turn's reply). This waits `waitMs` for the harness to go on its own
 * and ends it and its tree when it has not.
 */
export async function endAfterResult(stream: ExecStream, waitMs: number, graceMs: number): Promise<void> {
  if (await outlasted(stream, waitMs)) await endRun(stream, graceMs);
}

/** One model as an adapter reads it off its binary: the values the CLI takes, without the words the runtime's table
 * lends them. contextWindows carries both windows where the CLI offers the model at two, else none. */
export interface HarnessCatalogModelProbe {
  slug: string;
  label: string;
  description?: string;
  /** The effort values this model takes: absent where the binary does not say and every effort stays open, empty
   * where it says the model takes none. The two are different answers and the composer draws them differently. */
  efforts?: readonly string[];
  /** The effort this model runs at when a turn names none, where the binary reports one. */
  defaultEffort?: string;
  contextWindows: readonly string[];
  isDefault: boolean;
}

/** What an adapter reads off its binary on the workspace's machine: the lists the CLI itself reports. */
export interface HarnessCatalogProbe {
  version: string | null;
  models: readonly HarnessCatalogModelProbe[];
  efforts: readonly string[];
  permissionModes: readonly string[];
}

/** What an adapter answers when its binary ran and described no models for a reason it can name (no sign-in): the
 * runtime's table stands, and the composer's footer says these words in place of naming the binary as silent. */
export interface HarnessCatalogRefusal {
  refused: string;
}

/** The three things asking a binary about itself can come back with: its lists, its named reason for having none,
 * or nothing at all. */
export type HarnessCatalogAnswer = HarnessCatalogProbe | HarnessCatalogRefusal | null;

/** A refusal, not lists: an answer that named why the binary described nothing. */
export function catalogRefused(answer: HarnessCatalogAnswer): answer is HarnessCatalogRefusal {
  return answer !== null && "refused" in answer;
}

/**
 * Reads what the harness itself calls one of its sessions, from the harness's own store on the machine: the title
 * it generated, overridden by whatever the person renamed the session to inside the harness. The id is the session
 * as that harness keys it, in whatever word it uses for one (Claude Code's session id, Codex's thread id). One
 * shell line goes to `exec` and its stdout is the answer. Null when the store keeps no title for that id, and when
 * it holds no such session at all; absent on an adapter whose harness keeps no title.
 */
export type SessionTitleReader = (harnessSessionId: string, exec: (command: string) => Promise<string>) => Promise<string | null>;

/**
 * What a rename came to in the harness's own store. written: the store took the name. no-session: the store answered
 * and holds no such session, so there was nothing to name. failed: the store was there and the write did not land,
 * and `error` is the line the machine gave for it (the store's own message, a lock that never came free, no store on
 * the machine at all); nothing may be told about a session from it.
 */
export type SessionRenameWrite = { kind: "written" } | { kind: "no-session" } | { kind: "failed"; error: string };

/**
 * Writes the name a person gave one of the harness's sessions into the harness's own store on the machine, the same
 * field the harness writes when the person renames the session inside it, so the harness itself shows the new name
 * too. The id is the session as that harness keys it, as SessionTitleReader takes it, and one shell line goes to
 * `exec`, whose stdout says which of the three answers it is. Absent on an adapter whose harness keeps no name of a
 * person's.
 */
export type SessionRenamer = (harnessSessionId: string, title: string, exec: (command: string) => Promise<string>) => Promise<SessionRenameWrite>;

/** What a thread's title is asked for from: its opening turn's words, the reply where the caller has one (the runtime
 * asks at the turn's start and has none), and the model the question runs on, the cheapest the harness's catalog
 * lists; absent leaves the CLI's own. */
export interface TitleTurn {
  opening: string;
  reply?: string;
  model?: string;
}

/**
 * Asks the harness itself, on the machine, for a name for a thread whose first turn has just started: one shell line
 * to `exec` running the harness's own CLI on the question protocol's titlePrompt asks, and its stdout parsed back to
 * a title. Null when the CLI refused, answered nothing or answered something that is not a title, and the thread
 * keeps the words its opening turn seeded it with. Absent on an adapter whose CLI cannot answer a question without a
 * thread.
 */
export type SessionTitleMaker = (turn: TitleTurn, exec: (command: string) => Promise<string>) => Promise<string | null>;
