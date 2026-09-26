// SPDX-License-Identifier: AGPL-3.0-only
// The thread's actions, one registry: what a thread row's context menu offers
// for one session. Stop takes the runtime's session id, the one
// sessions.interrupt is keyed by; the rename opens the name for editing on
// the row by the thread's own key, and the row sends it.
import { LinkIcon, PencilIcon, SquareIcon, Trash2Icon } from "lucide-react";
import type { HarnessCatalog, SessionStatus, WorkspaceState } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { addressLink } from "../protocol/address.js";
import { CLIENT_CANNOT_STOP, THREAD_HAS_NO_ID, THREAD_NOT_RUNNING, THREAD_WORDS, threadForgetRefusalFor, threadRenameRefusal } from "./format.js";
import type { ActionEntry } from "./registry.js";

export interface ThreadTarget {
  /** The fold key of the thread, what a row is keyed by. */
  readonly id: string;
  /** The runtime's thread id, what a link opens; null for a row the runtime stamped none on. */
  readonly threadId: string | null;
  /** The latest turn's runtime session id, what a stop interrupts and what a rename names. */
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The agent the thread runs on: whose store a rename would have to be kept in. */
  readonly harness: string;
  readonly title: string;
  readonly status: SessionStatus;
  /** Whether a turn of this thread ever did work, as the protocol's fold reads the rows; a thread with none is
   * the one a forget removes. */
  readonly ran: boolean;
  /** That agent's catalog row on this workspace's machine, which says whether a name of a person's is kept there;
   * null while no catalog is known, which is no answer either way. */
  readonly catalog: HarnessCatalog | null;
  /** The workspace's state, since the store a rename writes to is on its machine. */
  readonly state: WorkspaceState;
  /** What the runtime said about a machine that is gone, for the refusal that names it. */
  readonly goneWords?: string | undefined;
}

/** One thread as its actions read it: the row, the agent's catalog row for the machine it runs on, and that
 * machine's state, as workspaceTarget does for a workspace row. */
export function threadTarget(thread: SidebarThreadSnapshot, machine: { catalog: HarnessCatalog | null; state: WorkspaceState; goneWords?: string | undefined }): ThreadTarget {
  return {
    id: thread.id,
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    harness: thread.harness,
    title: thread.title,
    status: thread.status,
    ran: thread.ran,
    catalog: machine.catalog,
    state: machine.state,
    ...(machine.goneWords !== undefined ? { goneWords: machine.goneWords } : {}),
  };
}

export interface ThreadVerbs {
  readonly stop?: ((sessionId: string) => Promise<void>) | undefined;
  /** Opens the name for editing on the thread's own row, by the thread's fold key, which a turn starting on the
   * thread does not move; the surface that draws the rows puts its own opener here, and a surface with no row to
   * edit leaves it out. */
  readonly rename?: ((threadId: string) => void) | undefined;
  /** Drops a thread no turn ever ran on through the host; the surface that draws the rows leaves it out when its
   * client has no road to the op. */
  readonly forget?: ((thread: { threadId: string; workspaceId: string }) => void) | undefined;
  readonly copyText: (text: string) => Promise<void>;
}

/** The page's own address for one thread: the link a person pastes elsewhere, and the href a row that points at
 * another thread carries. One shape for both, so an address written in the app never differs from one copied out. */
export const threadLink = (target: Pick<ThreadTarget, "workspaceId">, threadId: string): string => addressLink({ workspaceId: target.workspaceId, threadId });

export const threadActions: ReadonlyArray<ActionEntry<ThreadTarget, ThreadVerbs>> = [
  {
    id: "stop",
    group: "state",
    icon: () => SquareIcon,
    title: () => THREAD_WORDS.stop,
    refusal: (target, verbs) => (target.status !== "running" ? THREAD_NOT_RUNNING : verbs.stop === undefined ? CLIENT_CANNOT_STOP : null),
    run: (target, verbs) => verbs.stop?.(target.sessionId),
  },
  {
    id: "rename",
    group: "edit",
    icon: () => PencilIcon,
    title: () => THREAD_WORDS.rename,
    refusal: (target, verbs) =>
      threadRenameRefusal({ catalog: target.catalog, harness: target.harness, state: target.state, goneWords: target.goneWords, hasVerb: verbs.rename !== undefined }),
    run: (target, verbs) => verbs.rename?.(target.id),
  },
  {
    id: "copy-link",
    group: "copy",
    icon: () => LinkIcon,
    title: () => THREAD_WORDS.copyLink,
    refusal: target => (target.threadId === null ? THREAD_HAS_NO_ID : null),
    run: (target, verbs) => (target.threadId === null ? undefined : verbs.copyText(threadLink(target, target.threadId))),
  },
  {
    id: "forget",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    title: () => THREAD_WORDS.forget,
    refusal: (target, verbs) => threadForgetRefusalFor(target, verbs.forget !== undefined),
    run: (target, verbs) => (target.threadId === null ? undefined : verbs.forget?.({ threadId: target.threadId, workspaceId: target.workspaceId })),
  },
];
