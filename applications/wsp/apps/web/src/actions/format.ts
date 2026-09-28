// SPDX-License-Identifier: AGPL-3.0-only
// The words every action carries: its title as the palette and the menus
// show it, the label a row button on the object's own row wears, and the one
// sentence for why it cannot run right now. Every surface reads these, so a
// menu, a palette row and a button never say two things about one action.
import { agentName } from "@wsp/catalog";
import { actionRefusal, type BringBackResult, goneRefusal, isBilling, keepsRename, onDeleteOf, threadForgetRefusal, threadStateWord, type HarnessCatalog, type ProjectCopy, type SessionRenameOutcome, type WorkspaceKind, type WorkspaceState } from "@wsp/protocol";
import { MAX_TERMINALS_PER_GROUP } from "../terminal/groups.js";

export const WORKSPACE_WORDS = {
  pause: "Pause task",
  wake: "Wake task",
  stopWake: "Stop waking",
  rebuild: "Rebuild task",
  newThread: "New thread",
  openTerminal: "Open terminal",
  openBrowser: "Open browser",
  bringBack: "Bring back",
  exportProject: "Export project",
  rename: "Rename task",
  theme: "Edit theme colour",
  icon: "Change icon",
  fork: "Run a copy",
  copyId: "Copy computer id",
  delete: "Delete task",
  forget: "Forget task",
  startDaemon: "Start the daemon",
} as const;

/** What the creation log and the sidebar's creation row say before the runtime's first stage line lands; one
 * sentence in one place, since both surfaces stand in for the same silence. */
export const CREATION_ASKED = "Asking wsp to start it.";
/** The word a creation row's slot carries once the create was refused: the state table's own, so a thread that
 * failed and a create that failed read as one word. */
export const CREATION_FAILED = threadStateWord("failed");

export const THREAD_WORDS = {
  stop: "Stop thread",
  rename: "Rename thread",
  copyLink: "Copy thread link",
  forget: "Forget thread",
} as const;

export const TERMINAL_WORDS = {
  copy: "Copy",
  paste: "Paste",
  clear: "Clear",
  split: "Split Terminal Horizontally",
  splitVertical: "Split Terminal Vertically",
  new: "New Terminal",
  close: "Close Terminal",
} as const;

/** Pause, wake and the stop are one slot: a machine that is up offers the pause, one the host is still asking the
 * provider for offers the stop, and every other state the wake. */
export function phaseWord(state: WorkspaceState): string {
  if (state === "waking") return WORKSPACE_WORDS.stopWake;
  return isBilling(state) ? WORKSPACE_WORDS.pause : WORKSPACE_WORDS.wake;
}

/** The phase slot's two words per state: what its button offers, and the verb a machine that cannot take the move
 * is refused for, in the runtime's own words. One table, so a state whose button changes cannot leave the refusal
 * beside it naming the other verb. */
const PHASE_SLOT: Record<WorkspaceState, { button: string; cannot: string }> = {
  running: { button: "Pause", cannot: "be paused" },
  unreachable: { button: "Pause", cannot: "be paused" },
  paused: { button: "Wake", cannot: "be woken" },
  gone: { button: "Wake", cannot: "be woken" },
  pausing: { button: "Pausing…", cannot: "be paused" },
  waking: { button: "Stop", cannot: "be woken" },
};

/** The word the phase button on the machine's own surface shows: the verb, or the moving state while it moves. */
export const phaseButtonWord = (state: WorkspaceState): string => PHASE_SLOT[state].button;

/** The verb the machine cannot take, for the one sentence a machine wsp does not drive refuses with. */
export const phaseCannot = (state: WorkspaceState): string => PHASE_SLOT[state].cannot;

export const phaseHint = (state: WorkspaceState): string =>
  state === "waking" ? "Stop asking the provider to wake this task" : isBilling(state) ? "Suspend the VM and keep the disk" : "Boot the VM from its disk";
export const FORGET_HINT = "Its computer is gone; forget the task to drop it from this computer";
export const REBUILD_HINT = "The task answers nothing; rebuild it from your image";

/** What a rebuild the host refused says, wherever it was asked from. The host's own reason is not quoted: it ends
 * in whatever threw, and the line used to begin with the workspace's name and a colon. */
export const rebuildRefusedLine = (name: string): string => `${name} was not rebuilt. Its row says what it is doing.`;

export function phaseRefusal(state: WorkspaceState): string | null {
  switch (state) {
    case "running":
    case "unreachable":
    case "paused":
      return null;
    case "pausing":
      return "Task is pausing; it can be woken once it is paused";
    // A wake the host keeps asking the provider for is the one moving state with something to offer: its own stop.
    case "waking":
      return null;
    case "gone":
      return goneRefusal("wake");
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

export const CLIENT_CANNOT_REBUILD = "This client cannot rebuild tasks";
export const CLIENT_CANNOT_FORGET = "This client cannot forget tasks";
export const CLIENT_CANNOT_START_DAEMON = "This client cannot start a daemon";
export const NEW_THREAD_WAITS = "New threads wait for the rebuild";
export const PROJECTS_WAIT = "Projects wait for the rebuild";
export const CLIENT_CANNOT_EXPORT = "This client cannot export projects";
export const CLIENT_CANNOT_RENAME_WORKSPACE = "This client cannot rename tasks";
export const CLIENT_CANNOT_LOOK = "This client cannot set a task's theme or icon";
/** What Bring back does, on the button's hover text: the agent's branch is what leaves, and it leaves through git. */
export const BRING_BACK_HINT = "Pushes the agent's branch and opens a pull request";

/** What the row's third line says once a bring back has answered: the branch, then the pull request it opened, or
 * that there is none beside a push that landed. "Pull request" in full, since the row has the width for it and the
 * short form is a word only people who live in one git host read. The note that says why there is none is the
 * host's own sentence and longer than any row: it rides the row's hover text, where the whole of this line does. */
export function broughtBackRowLine(back: Pick<BringBackResult, "branch" | "pr" | "note">): string {
  if (back.pr !== undefined) return `${back.branch}: pull request #${back.pr.number} ${back.pr.state}`;
  return back.note === undefined ? `${back.branch} pushed` : `${back.branch} pushed, no pull request`;
}

export const NO_WORKSPACE_FORK = "Running a copy of a task is not in the runtime yet; make a second task of the same project from the plus on its row";

/** What Delete takes, on the menu row's hover: the machine half in the kind's own words, which is the half a
 * person cannot undo. The dialog says the same half and the record and the threads with it. */
export const DELETE_HINT = (kind: WorkspaceKind, copy?: Pick<ProjectCopy, "path">): string => `Its ${onDeleteOf(kind, copy).asked}`;
export const CLIENT_CANNOT_DELETE = "This client cannot delete tasks";

/** What a terminal the workspace refused says, wherever it was asked from: the link is up, so no pane stands in
 * for this, and the link's reason is what a person can act on. Named where the app holds a record for the
 * workspace, which is everywhere but a pane outliving its own row. */
export const terminalRefusedLine = (name: string | undefined, said: string): string => (name === undefined ? `No terminal: ${said}` : `No terminal on ${name}: ${said}`);

export const openTerminalRefusal = (state: WorkspaceState): string | null => (state === "gone" ? goneRefusal("open a terminal") : null);
export const openBrowserRefusal = (state: WorkspaceState): string | null => actionRefusal(state, "preview");

export const THREAD_NOT_RUNNING = "Thread is not running";
export const CLIENT_CANNOT_STOP = "This client cannot stop a turn";
export const THREAD_HAS_NO_ID = "This thread has no id yet";
export const CLIENT_CANNOT_RENAME = "This client cannot rename a thread";
export const CLIENT_CANNOT_FORGET_THREAD = "This client cannot forget a thread";

/** Why the forget cannot run, or null when it can. The runtime owns the rule and raises the same sentence; the row
 * reads it off the fold so the menu says why without asking the host. */
export function threadForgetRefusalFor(thread: { threadId: string | null; ran: boolean }, hasVerb: boolean): string | null {
  if (thread.threadId === null) return THREAD_HAS_NO_ID;
  if (!hasVerb) return CLIENT_CANNOT_FORGET_THREAD;
  return thread.ran ? threadForgetRefusal(thread.threadId) : null;
}

/** The one sentence for an agent whose own store keeps no name of a person's: a rename there would be gone at the
 * thread's next turn, so nothing offers one. The refusal and the toast both read it. */
export const notKeptLine = (harness: string): string => `Rename in ${agentName(harness)} is not kept`;

/** Why the rename cannot run, or null when it can. The harness's own catalog row answers whether a name is kept, as
 * it answers whether a turn steers; a row the runtime's table stood in for is no answer, so the box opens and the
 * runtime says. A machine that is not up is woken by the rename itself, as the command line's own rename does, so
 * only a machine that cannot be woken at all refuses here. */
export function threadRenameRefusal(opts: { catalog: HarnessCatalog | null; harness: string; state: WorkspaceState; goneWords?: string; hasVerb: boolean }): string | null {
  if (!keepsRename(opts.catalog)) return notKeptLine(opts.harness);
  if (!opts.hasVerb) return CLIENT_CANNOT_RENAME;
  return opts.state === "gone" ? goneRefusal("rename", opts.goneWords) : null;
}

/** What the toast says when the runtime named nothing: the answer in the person's words, never the enum, and the
 * machine's own line where the store refused the write, since nothing else is known about it then. */
export function renameNotTakenLine(harness: string, outcome: Exclude<SessionRenameOutcome, "renamed">, error?: string): string {
  switch (outcome) {
    case "unsupported":
      return notKeptLine(harness);
    case "no-session":
      return `${agentName(harness)} on the task has no session for this thread yet`;
    case "failed":
      return error ?? "The task said nothing about the write";
    case "not-found":
      return "The runtime has no such thread any more";
    default: {
      const _exhaustive: never = outcome;
      return "";
    }
  }
}

export const FOLDER_OPENS_IN_TREE = "A folder opens in the tree";
export const ONLY_FILES_HAVE_DIFFS = "Only a file has a diff";

export const NOTHING_SELECTED = "Nothing is selected";
export const NO_CLIPBOARD_READ = "The clipboard cannot be read here";
export const NO_TERMINAL = "No terminal is active";
export const SPLIT_LIMIT = `max ${MAX_TERMINALS_PER_GROUP} per group`;

/** A thread link named a thread the workspace's list does not carry; the workspace opened instead. The thread is
 * not named: the link carried an id, and an id names no thread to the person who followed it. */
export const noSuchThreadLine = (): string => "That thread is not in this task; opened the task instead";

/** Show in diff asked for a file the diff does not touch. */
export const noDiffLine = (fileName: string, scopeLabel: string): string => `${fileName} has no diff in ${scopeLabel.toLowerCase()}`;

/** A row button on the object's own row names the object: Forget api, New thread in api. */
export const rowVerb = (verb: string, name: string): string => `${verb} ${name}`;
export const rowNewThread = (name: string): string => `New thread in ${name}`;

