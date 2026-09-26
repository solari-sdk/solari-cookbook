// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces into sidebar projects: a wsp workspace (a machine) is the first
// level, its sessions are the threads. Shape from t3code
// sidebarProjectGrouping.ts SidebarProjectSnapshot and Sidebar.logic.ts
// resolveThreadStatusPill (commit 57a66608). Phase is the product word and
// leads; machine state and reach only add when they diverge from it.
import { foldThreads, IDLE_REASON, threadState, threadWordOf, waitingLine, workspaceStateOf, workspaceWord, type PauseMode, type SessionView, type ThreadView, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot, StatusIndicator } from "./view-model.js";

export interface SidebarInput {
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly statuses?: Readonly<Record<string, WorkspaceStatus>>;
  readonly sessions?: Readonly<Record<string, ReadonlyArray<SessionView>>>;
  /** How the computer each workspace's project lands on pauses a machine, by the project's id: the state word is
   * Paused on a computer that keeps the machine's memory and Stopped on every other. A project the host has not
   * answered a landing for reads the stopping words, as every caller holding no mode does. */
  readonly pauseModes?: Readonly<Record<string, PauseMode | undefined>>;
}

export function deriveSidebarProjects(input: SidebarInput): SidebarProjectSnapshot[] {
  return input.workspaces
    .map(workspace => {
      const status = input.statuses?.[workspace.id] ?? null;
      const phase = status?.phase ?? workspace.phase;
      const state = workspaceStateOf({ phase }, status);
      const threads = foldThreads(input.sessions?.[workspace.id] ?? []);
      const pauseMode = input.pauseModes?.[workspace.project.id];
      return {
        id: workspace.id,
        projectKey: workspace.id,
        displayName: workspace.name,
        groupedProjectCount: 1,
        environmentPresence: "remote-only",
        allRemoteMembersAreDesktopLocal: false,
        remoteEnvironmentLabels: [status?.machineId ?? workspace.machineId],
        workspace,
        status,
        phase,
        machineState: status?.machineState ?? null,
        reach: status?.reach.state ?? null,
        state,
        indicator: indicatorFor(state, pauseMode),
        threads: threads.map(thread => deriveThread(thread, workspace)),
      } satisfies SidebarProjectSnapshot;
    })
    .sort(byCreation);
}

/** A list a person picks rows out of by position may not reshuffle while they reach for one, so nothing about what
 * a machine is doing sorts it and recency lives in the palette's Recent list instead. Two workspaces stamped the
 * same millisecond fall to their ids, since the record they arrive in is a map with no order of its own. */
const byCreation = (a: SidebarProjectSnapshot, b: SidebarProjectSnapshot): number =>
  Date.parse(a.workspace.createdAt) - Date.parse(b.workspace.createdAt) || a.id.localeCompare(b.id);

/** The workspace ids as the sidebar draws them, top to bottom: the one order every "first" or "next" workspace reads. */
export function sidebarWorkspaceOrder(input: SidebarInput): string[] {
  return deriveSidebarProjects(input).map(project => project.id);
}

/** The workspace a surface holding no pick of its own is about: the selected one, or the sidebar's first row while
 * what is selected is not a workspace, which is what a creation in flight leaves behind. One rule, so the chords
 * that walk the list and the palette's rows cannot land on two different workspaces.  */
export function currentWorkspaceId(orderedIds: ReadonlyArray<string>, selectedId: string | null): string | null {
  return selectedId !== null && orderedIds.includes(selectedId) ? selectedId : orderedIds[0] ?? null;
}

export function workspaceIndicator(workspace: Pick<WorkspaceView, "phase">, status: WorkspaceStatus | null, pauseMode?: PauseMode): StatusIndicator {
  return indicatorFor(workspaceStateOf(workspace, status), pauseMode);
}

function indicatorFor(state: WorkspaceState, pauseMode?: PauseMode): StatusIndicator {
  return { label: workspaceWord(state, pauseMode), tone: indicatorTone(state), pulse: state === "pausing" || state === "waking" };
}

function indicatorTone(state: WorkspaceState): StatusIndicator["tone"] {
  switch (state) {
    case "running":
      return "running";
    case "pausing":
    case "paused":
      return "paused";
    case "waking":
    case "unreachable":
    case "gone":
      return "neutral";
    default: {
      const _exhaustive: never = state;
      return "neutral";
    }
  }
}

/** What the timeline's line says in place of "Working" while the thread's workspace cannot run the turn, and
 * whether to offer the wake beside it; null while the workspace runs. Every line names the workspace, and the
 * waking one names where it runs too, since that is the send's whole answer: the turn starts there in a moment.
 * The elapsed rides beside the words on the row, not in them, because it ticks. */
export function turnWait(state: WorkspaceState, workspace: { readonly name: string; readonly where: string }): { readonly label: string; readonly wake: boolean; readonly elapsed: boolean } | null {
  switch (state) {
    case "running":
      return null;
    case "pausing":
    case "paused":
      return { label: `waiting for ${workspace.name} to wake`, wake: true, elapsed: false };
    case "waking":
      return { label: `waking ${workspace.name} on ${workspace.where}`, wake: false, elapsed: true };
    case "unreachable":
      return { label: `waiting for ${workspace.name} to answer`, wake: false, elapsed: false };
    case "gone":
      return { label: `${workspace.name} is gone`, wake: false, elapsed: false };
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

/** The line a paused workspace puts under its last turn, where nothing is running and the next send is what wakes
 * it: the state, and what it napped after where the status that brought the nap said so. The window is read back
 * through the protocol's own marker, which the runtime writes the reason with, so neither side can reword it alone.
 * A window that was not open at the nap is told none of that and says the state alone rather than guessing. */
export function pausedLine(reason: string | undefined): string {
  const window = IDLE_REASON.windowIn(reason);
  return window === undefined ? "paused" : `paused after ${window} idle`;
}

function deriveThread(thread: ThreadView, workspace: Pick<WorkspaceView, "project">): SidebarThreadSnapshot {
  return {
    id: thread.id,
    threadId: thread.threadId ?? null,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    title: thread.title,
    status: thread.status,
    ran: thread.ran,
    startedAt: thread.startedAt !== undefined ? new Date(thread.startedAt).toISOString() : null,
    endedAt: thread.endedAt !== undefined ? new Date(thread.endedAt).toISOString() : null,
    indicator: threadIndicator(thread),
    harness: thread.harness,
    startedBy: thread.startedBy,
    project: workspace.project.name,
    parentThreadId: thread.parentThreadId ?? null,
    asking: waitingLine(thread) ?? null,
    costUsd: thread.costUsd ?? null,
  };
}

/** The thread's word, from the protocol's one table, and whether it pulses: a running turn does, and a turn stopped
 * on a question does not, since nothing is moving until the person answers. */
export function threadIndicator(session: Pick<ThreadView, "status" | "asking" | "waitingOn">): StatusIndicator {
  return { label: threadWordOf(session), tone: "neutral", pulse: threadState(session) === "running" };
}
