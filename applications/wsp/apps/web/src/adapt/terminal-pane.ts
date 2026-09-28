// SPDX-License-Identifier: AGPL-3.0-only
// What a terminal pane says over its frozen frame, from the workspace's state
// (the one vocabulary), the daemon reach and the pane's own socket. A pty
// survives a pause (the machine is frozen, not rebuilt), so a paused pane keeps
// its frame and offers the wake; only a replaced machine loses the shell.
import { biggerSizeLine, outOfMemoryLine, THIS_COMPUTER, type AbsentComputer, type DaemonLinkStatus, type MachineSizeOffer, type MemoryReading, type ReachState, type WorkspaceSize, type WorkspaceState } from "@wsp/protocol";

export type TerminalPaneState =
  | { readonly kind: "live" }
  /** Nothing has been open on this link yet and its first-answer bound has not passed: the pane says what is being
   * started here, which is the one thing that is true, and promises nothing back. */
  | { readonly kind: "starting"; readonly local: boolean; readonly where: string }
  /** Nothing has been open on this link and the bound has passed: the pane names what is not answering and what to
   * do about it, since a wait that has already run out is not something to go on offering. */
  | { readonly kind: "unanswered"; readonly local: boolean; readonly where: string }
  /** The machine runs, this link was open once, and it is being dialled again: the one state that promises a return. */
  | { readonly kind: "reconnecting"; readonly outOfMemory?: MemoryReading }
  /** The workspace refused the token the host opened the connection with; the host dials again with the one it
   * holds now. No token of this window's is involved: it holds none. */
  | { readonly kind: "reauth" }
  /** What the workspace runs on turned this window's connection away with a status, so it never opened and no retry
   * at the usual pace would open one. reason is that answer in its own words, empty when it sent none. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The runtime's reach tracker spent its budget: the provider says running, the guest answers nothing. */
  | { readonly kind: "not-answering"; readonly outOfMemory?: MemoryReading }
  /** There is no daemon on this machine to dial: the host wired none for its kind, or the machine carries no route
   * to one. Nothing is reconnecting, so the pane says the daemon is absent instead of promising it back. */
  | { readonly kind: "no-daemon" }
  /** The computer this workspace stands on is not answering. Nothing is reconnecting and nothing is wrong with the
   * workspace: the computer dials this host itself when it is on, so the pane says so in the two halves the one
   * reading of it carries rather than leaving a line in the sidebar's corner. */
  | { readonly kind: "absent"; readonly absent: AbsentComputer }
  | { readonly kind: "paused"; readonly pausing: boolean }
  | { readonly kind: "waking" }
  | { readonly kind: "gone" };

export interface TerminalPaneInput {
  readonly state: WorkspaceState;
  readonly reach: ReachState | null;
  readonly socket: DaemonLinkStatus;
  /** What turned the connection away, in its own words, while the socket reads refused. */
  readonly refusal?: string | null;
  /** The daemon's last reading before its link went, when memory was near full; the pane then says what took the machine. */
  readonly outOfMemory?: MemoryReading | null;
  /** Whether this workspace is the person's own computer, which is the only thing the words for a link that has
   * never been open turn on. Read through the protocol's own reading of it, never by comparing a kind here. */
  readonly local?: boolean;
  /** The one reading of this workspace's computer while it is not answering; null while it is. */
  readonly absent?: AbsentComputer | null;
  /** What this link's sentences call where they are being opened: the workspace's own name, which on a machine wsp
   * forked is the name of that machine. Left out only where the caller holds no record yet. */
  readonly where?: string;
}

export function terminalPaneState(input: TerminalPaneInput): TerminalPaneState {
  const oom = input.outOfMemory ? { outOfMemory: input.outOfMemory } : {};
  const local = input.local ?? false;
  const where = local ? THIS_COMPUTER : (input.where ?? "this task");
  /** What a machine that is up but whose link is not open reads as, from the link alone. */
  const fromLink = (): TerminalPaneState => {
    if (input.socket === "opening") return { kind: "starting", local, where };
    if (input.socket === "unanswered") return { kind: "unanswered", local, where };
    return { kind: "reconnecting", ...oom };
  };
  // Ahead of every other reading: while that computer is not connected, nothing else here is known about the
  // workspace, and the socket's own words would promise a link nobody is opening.
  if (input.absent != null) return { kind: "absent", absent: input.absent };
  switch (input.state) {
    case "gone":
      return { kind: "gone" };
    case "pausing":
      return { kind: "paused", pausing: true };
    case "paused":
      return { kind: "paused", pausing: false };
    case "waking":
      return { kind: "waking" };
    case "unreachable":
      return input.reach === "zombie" ? { kind: "not-answering", ...oom } : fromLink();
    case "running":
      if (input.socket === "live") return { kind: "live" };
      if (input.socket === "refused") return { kind: "refused", reason: input.refusal ?? "" };
      // The runtime says this machine has no daemon road at all, so no amount of dialling would open a terminal.
      if (input.reach === "unsupported") return { kind: "no-daemon" };
      return input.socket === "reauth-needed" ? { kind: "reauth" } : fromLink();
    default: {
      const _exhaustive: never = input.state;
      return { kind: "live" };
    }
  }
}

/** The one line a pane shows for its state; null while live. */
export function terminalPaneTitle(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "live":
      return null;
    case "starting":
      return `Starting a terminal on ${pane.where}`;
    case "unanswered":
      return `Nothing has answered on ${pane.where}`;
    case "reconnecting":
      return "Reconnecting to the task";
    case "reauth":
      return "The task refused a stale daemon token; reconnecting with the one wsp holds now";
    case "not-answering":
      return pane.outOfMemory ? outOfMemoryLine(pane.outOfMemory) : "The task is not answering";
    case "absent":
      return pane.absent.said;
    case "no-daemon":
      return NO_DAEMON_TITLE;
    case "refused":
      return REFUSED_TITLE;
    case "paused":
      return `${pane.pausing ? "Pausing" : "Paused"}. The shell is kept; wake the task to continue`;
    case "waking":
      return "Waking the task. The shell continues when it is back";
    case "gone":
      return "The task is gone";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}

/** Where a person now reads what a workspace is doing and reaches its verbs: its own row in the sidebar, the pane
 * that held those facts having gone. Written once here because two sentences in this file name it and a rename
 * that moved one would leave the other. */
const WORKSPACE_ROW = "task's row";

const REBUILD_HINT = `Rebuild it from the ${WORKSPACE_ROW}`;

/** What a shell says when the daemon that was holding it is gone: the pane's overlay and the bytes written into
 * the terminal itself read one sentence, so a person who saw it in the scrollback and a person who saw the overlay
 * read the same thing. It names the daemon and not a move, because the same refusal comes back when the workspace
 * moved to another computer and when this computer's own daemon was started again under a shell. */
export const SHELL_ENDED_LINE = "This shell ended when the daemon holding it stopped";

/** What to do once nothing has answered. The fact is in the title; this half is the one thing a person can act on,
 * and it names the thing to look at rather than leaving an "it" open. Both halves read the same name for where,
 * so the pair cannot drift apart. */
const unansweredHint = (pane: { local: boolean; where: string }): string =>
  pane.local
    ? `wsp keeps trying; look at the terminal you started wsp in on ${pane.where}`
    : `wsp keeps trying; the ${WORKSPACE_ROW} says what ${pane.where} is doing`;

/** What a pane says for a machine with no daemon at all. One sentence stating the fact, with no return promised and
 * nothing to wait for: a pane that read "reconnecting" for a workspace that never had a daemon road was the bug
 * (seen on a local workspace before its daemon landed).  */
const NO_DAEMON_TITLE = "There is no daemon on this task";
const NO_DAEMON_LINE = "There is no daemon on this task, so no terminal opens here";
const NO_DAEMON_TYPING = "Typing is refused: there is no daemon on this task";

/** What a pane says for a connection that was turned away. The fact of what happened to this window's connection,
 * then that the work on the workspace is untouched by it, with no return promised and nothing offered to do: the
 * retry that goes on behind it is at the slowest pace there is. Neither sentence says machine or daemon, which a
 * person never reads, and a test pins the words. */
const REFUSED_TITLE = "The connection to this task was refused; its threads keep running";
const REFUSED_TYPING = "Typing is refused: the connection to this task was refused";

/** The lines under the pane's title, in the order they are shown. A drop with memory near full says so and names
 * the next size up before anything else; the rebuild is the last thing offered, and only once the runtime gave up
 * on the machine or the provider lost it. The size line needs the machine's size and the provider's table, which
 * a pane may not have yet. */
export function terminalPaneHints(pane: TerminalPaneState, size: WorkspaceSize | null, sizes: readonly MachineSizeOffer[] | null): string[] {
  const bigger = size !== null && sizes !== null ? [biggerSizeLine(size, sizes)] : [];
  switch (pane.kind) {
    case "unanswered":
      return [unansweredHint(pane)];
    case "starting":
      return [];
    case "reconnecting":
      return pane.outOfMemory ? [outOfMemoryLine(pane.outOfMemory), ...bigger] : [];
    case "not-answering":
      return pane.outOfMemory ? [...bigger, REBUILD_HINT] : [REBUILD_HINT];
    case "absent":
      // A reading whose daemon this host owns carries a button instead of a second sentence; the pane draws it.
      return pane.absent.will === undefined ? [] : [pane.absent.will];
    case "no-daemon":
    case "refused":
      return [];
    case "gone":
      return [REBUILD_HINT];
    case "live":
    case "reauth":
    case "paused":
    case "waking":
      return [];
    default: {
      const _exhaustive: never = pane;
      return [];
    }
  }
}

/** What an empty pane says instead of offering a terminal; null while live. */
export function terminalEmptyLine(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "live":
      return null;
    case "starting":
      return `Starting a terminal on ${pane.where}; the first one opens when it is ready`;
    case "unanswered":
      return `Nothing has answered on ${pane.where}, so no terminal opens yet`;
    case "reconnecting":
      return "The daemon link is reconnecting; terminals open when it is back";
    case "reauth":
      return "The task refused a stale daemon token; terminals open once the link carries the current one";
    case "not-answering":
      return "The task is not answering; terminals open when it does";
    case "absent":
      // The one sentence the pane already shows for an absent computer, which a refused terminal lands in too: a
      // reading with a button promises nothing after it, since the button is what opens the terminal.
      return pane.absent.start !== undefined ? pane.absent.said : `${pane.absent.sentence}, and a terminal opens then`;
    case "no-daemon":
      return NO_DAEMON_LINE;
    case "refused":
      return `No terminal opens from this window: ${pane.reason}. The task's threads keep running.`;
    case "paused":
      return `Task is ${pane.pausing ? "pausing" : "paused"}; wake it to open a terminal`;
    case "waking":
      return "Task is waking; terminals open when it is running";
    case "gone":
      return `The task is gone; rebuild it from the ${WORKSPACE_ROW}`;
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}

/** Why a keystroke is not sent; null while live. */
export function terminalInputRefusal(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "live":
      return null;
    case "starting":
      return "Typing is refused while the terminal starts";
    case "unanswered":
      return `Typing is refused: nothing has answered on ${pane.where}`;
    case "reconnecting":
      return "Typing is refused while the task is reconnecting";
    case "reauth":
      return "Typing is refused until the task takes the current daemon token";
    case "not-answering":
      return "Typing is refused: the task is not answering";
    case "absent":
      return `Typing is refused: ${pane.absent.said}`;
    case "no-daemon":
      return NO_DAEMON_TYPING;
    case "refused":
      return REFUSED_TYPING;
    case "paused":
      return `Typing is refused: the task is ${pane.pausing ? "pausing" : "paused"}`;
    case "waking":
      return "Typing is refused while the task wakes";
    case "gone":
      return "Typing is refused: the task is gone";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}

/** The one line the screen carries under the composer while this workspace's link is not open, so the box never
 * sits there looking live over a link nobody can reach. It is the pane's own title, not a second sentence: the
 * states that belong to the machine (paused, waking, gone, a computer that is not answering) are left out, since
 * the row's state word and the composer's held send already carry those, and so is a link still inside its
 * first-answer bound, which is not down. It is drawn beside the workspace it is about and nowhere else: the same
 * sentence in the sidebar's corner slot read as a line about nothing, naming no workspace. */
export function linkDownLine(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "unanswered":
    case "reconnecting":
    case "refused":
    case "reauth":
      return terminalPaneTitle(pane);
    case "live":
    case "starting":
    case "not-answering":
    case "no-daemon":
    case "absent":
    case "paused":
    case "waking":
    case "gone":
      return null;
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}
