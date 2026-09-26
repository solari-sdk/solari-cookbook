// SPDX-License-Identifier: AGPL-3.0-only
// One place that turns a keybinding command into store calls, shared by the
// shortcut dispatcher, the palette, the header button and the terminal
// surfaces so they all agree on what a command does. The terminal shortcuts
// drive the drawer under the chat, except that new and split act on the right
// panel's terminal while one of its terminals has focus; the panel surface
// itself opens only from its own tab strip. Every pty comes from the link.
// The workspace switch walks the sidebar's own order and lands in the new
// workspace's composer; the chord's walk stays inside the switcher overlay
// until the hold is let go. In Spaces the same chord walks one level down,
// over the last five threads opened in the workspace on screen: the hold
// shows them, letting go lands on the highlighted one, and a tap is the
// thread before this one. With no workspace selected the terminal chord
// opens this computer's own terminal, and the panel chord a panel whose
// panels wait for a workspace.
import { terminalRefusedLine } from "../actions/format.js";
import { deriveSidebarProjects, type SidebarProjectSnapshot, type SidebarThreadSnapshot } from "../adapt/index.js";
import { toggleCommandPalette } from "../commandPaletteBus.js";
import { isWorkspaceSelectCommand, workspaceSelectSlot, type KeybindingCommand, type WorkspaceSelectSlot } from "../keybindingTypes.js";
import { threadFolderOf } from "../files/root.js";
import { getTerminalFocusOwner } from "../lib/terminalFocus.js";
import { addNotice } from "../notices/store.js";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { absenceOf } from "../settings/places.js";
import { sidebarThreadOrder } from "../sidebar/Sidebar.logic.js";
import { currentWorkspaceId } from "../adapt/workspaces.js";
import { threadTree } from "../sidebar/threadTree.js";
import { workspaceOrHere } from "../terminal/computer.js";
import { useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { resetTerminalZoom, stepTerminalZoom } from "../terminal/fontSetting.js";
import { getTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import { requestComposerFocus } from "./shellRequests.js";
import { recentThreads, useThreadHistory } from "./threadHistory.js";
import { highlightedTarget, stepSwitcherAt, useWorkspaceSwitcher } from "./workspaceSwitcher.js";

export interface ShellCommandTarget {
  readonly workspaceId: string | null;
  readonly toggleSidebar: () => void;
}

export type SplitDirection = "horizontal" | "vertical";

/** A workspace the link refused a pty for, as a notice with the link's reason. Only for a refusal with no pane to
 * stand in for it: a computer that is not answering is the pane's own sentence, said where the click was, so
 * nothing is said here about one. */
export function reportTerminalRefused(workspaceId: string, e: unknown): void {
  const { workspaces, statuses, places } = useStore.getState();
  const workspace = workspaces.find(w => w.id === workspaceId) ?? null;
  if (absenceOf(places, workspace, statuses[workspaceId] ?? null, null) !== null) return;
  addNotice({ kind: "error", text: terminalRefusedLine(workspace?.name, failureOf(e).said) });
}

/** Runs fn against the workspace's link. Nothing is asked of a workspace whose computer is not answering: its pane
 * already says so in that computer's own words and stands there. The tab that opens a pane is held on the same
 * reading, so every road to a pty reads one state. */
function withTerminals(workspaceId: string, fn: (terminals: WorkspaceTerminals) => Promise<unknown>): Promise<void> {
  const { workspaces, statuses, places } = useStore.getState();
  const workspace = workspaces.find(w => w.id === workspaceId) ?? null;
  if (absenceOf(places, workspace, statuses[workspaceId] ?? null, null) !== null) return Promise.resolve();
  const terminals = getTerminals(workspaceId);
  if (!terminals) return Promise.resolve();
  return fn(terminals).then(() => undefined, (e: unknown) => reportTerminalRefused(workspaceId, e));
}

/** Where a fresh pty starts: the folder a thread of this workspace would start in, which is the project's own
 * rather than the daemon's home. The card says a shell in this workspace, and a shell in the person's home folder
 * is a shell in the machine and not in the work. */
export function ptyStartFolder(workspaceId: string): { cwd?: string } {
  const cwd = threadFolderOf(workspaceId);
  return cwd === null ? {} : { cwd };
}

/** The drawer, shown; a workspace that never had a pty spawns one on mount. */
export function showTerminal(workspaceId: string): Promise<void> {
  useTerminalDrawerStore.getState().setOpen(workspaceId, true);
  return Promise.resolve();
}

/** A fresh pty as its own drawer tab; the drawer opens if it was closed. */
export function openDrawerTerminal(workspaceId: string): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open(ptyStartFolder(workspaceId)).then(tab => useTerminalDrawerStore.getState().add(workspaceId, tab.ptyId)),
  );
}

/** A fresh pty split into the drawer's active group. */
export function splitDrawerTerminal(workspaceId: string, direction: SplitDirection = "horizontal"): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open(ptyStartFolder(workspaceId)).then(tab => useTerminalDrawerStore.getState().split(workspaceId, tab.ptyId, direction)),
  );
}

/** A fresh pty in its own right-panel surface. */
export function openPanelTerminal(workspaceId: string): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open(ptyStartFolder(workspaceId)).then(tab => useRightPanelStore.getState().openTerminal(workspaceId, tab.ptyId)),
  );
}

/** A fresh pty in its own right-panel surface with a line typed at its prompt and left for the person to run. */
export function openPanelTerminalWith(workspaceId: string, line: string): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open(ptyStartFolder(workspaceId)).then(tab => {
      useRightPanelStore.getState().openTerminal(workspaceId, tab.ptyId);
      terminals.write(tab.ptyId, line);
    }),
  );
}

/** A fresh pty split into one right-panel terminal surface. */
export function splitPanelTerminal(workspaceId: string, surfaceId: string, direction: SplitDirection = "horizontal"): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open(ptyStartFolder(workspaceId)).then(tab => useRightPanelStore.getState().splitTerminal(workspaceId, surfaceId, tab.ptyId, direction)),
  );
}

/** A fresh pty split into the panel's active terminal surface, or a new surface when none is active. */
export function splitActivePanelTerminal(workspaceId: string, direction: SplitDirection = "horizontal"): Promise<void> {
  const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, workspaceId);
  const active = state.surfaces.find(surface => surface.id === state.activeSurfaceId);
  if (!active || active.kind !== "terminal") return openPanelTerminal(workspaceId);
  return splitPanelTerminal(workspaceId, active.id, direction);
}

/** The sidebar's own snapshots, in its own order. The creation rows a fork draws above them are left out: a
    creation row has no workspace to switch to, and counting one would move every slot under the person's fingers
    while a fork is in flight. */
function sidebarProjects(): SidebarProjectSnapshot[] {
  const { workspaces, statuses, sessions } = useStore.getState();
  return deriveSidebarProjects({ workspaces, statuses, sessions });
}

function orderedWorkspaceIds(): string[] {
  return sidebarProjects().map(project => project.id);
}

/** A thread row a walk can land on: one the runtime stamped a thread id on, which is the one field the walk's
    list, its compare against what is open and its select all read. */
export type WalkableThread = SidebarThreadSnapshot & { readonly threadId: string };

/** The threads of the workspace on screen that a walk can land on, in the order the sidebar draws
    them. The chord and the palette's rows read this one list, so a row that says it is disabled and a chord that
    does nothing agree. A row the runtime stamped no thread id on pins the workspace alone, so a walk that landed
    on it could never step off it. */
export function threadWalk(projects: ReadonlyArray<SidebarProjectSnapshot>, selectedId: string | null): WalkableThread[] {
  const current = currentWorkspaceId(projects.map(project => project.id), selectedId);
  const group = threadTree(projects).find(candidate => candidate.project.id === current);
  if (group === undefined) return [];
  return sidebarThreadOrder(group.threads).filter((thread): thread is WalkableThread => thread.threadId !== null);
}

/** One step along an order that wraps at both ends, or null where there is nowhere else to go, which is what
    the palette's disabled rows say. A current id the order does not hold (a creation row) steps in from the
    end it came from. */
export function stepInOrder(ids: ReadonlyArray<string>, currentId: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  if (at === -1) return (step === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  const next = ids[(at + step + ids.length) % ids.length] ?? null;
  return next === currentId ? null : next;
}

/** Selects the workspace, and one of its threads where the caller names one, then puts the caret in its composer:
 * the chords and the palette's rows land the same way. */
export function goToWorkspace(workspaceId: string, threadId: string | null = null): void {
  useStore.getState().select(workspaceId, threadId);
  requestComposerFocus(workspaceId);
}

export function goToAdjacentWorkspace(step: 1 | -1): void {
  const next = stepInOrder(orderedWorkspaceIds(), useStore.getState().selectedId, step);
  if (next !== null) goToWorkspace(next);
}

/** One step through the threads of the workspace Spaces has on screen; nothing happens where there is nowhere
 * else to go, as the palette's disabled row says. */
export function cycleThreadInSpace(step: 1 | -1): void {
  const threads = threadWalk(sidebarProjects(), useStore.getState().selectedId);
  const next = stepInOrder(threads.map(thread => thread.threadId), useStore.getState().selectedThreadId, step);
  const thread = threads.find(candidate => candidate.threadId === next);
  if (thread !== undefined) goToWorkspace(thread.workspaceId, thread.threadId);
}

/** The switch chord's step. The first one puts the overlay up over the workspace it would land on and the rest walk
 * it; nothing is selected until the hold is let go, so a walk past a workspace never mounts its threads and a tap,
 * which is a step and a release, still switches at once. The hold comes from the chord that stepped, so the walk
 * ends on the key that is really down whichever of the switch chords opened it. */
export function cycleWorkspaceSwitcher(step: 1 | -1, hold: ReadonlyArray<string>): void {
  const switcher = useWorkspaceSwitcher.getState();
  if (switcher.open) {
    switcher.step(step);
    return;
  }
  const ids = orderedWorkspaceIds();
  const selectedId = useStore.getState().selectedId;
  const next = stepInOrder(ids, selectedId, step);
  if (next === null) return;
  switcher.openAt(ids.map(workspaceId => ({ workspaceId, threadId: null })), ids.indexOf(next), selectedId, hold);
}

/** The switch chord's step in Spaces: the overlay over the last five threads opened in the space on screen, the
 * open one first, so a tap lands on the thread before this one and a hold walks the rest. With no thread open,
 * which is how a switch between spaces leaves the space, the most recently opened thread is the one a tap lands on,
 * so the walk starts on it rather than a step past it. Nothing opens where there is no second thread to land on,
 * as the palette's disabled row says. */
export function cycleThreadSwitcher(step: 1 | -1, hold: ReadonlyArray<string>): void {
  const switcher = useWorkspaceSwitcher.getState();
  if (switcher.open) {
    switcher.step(step);
    return;
  }
  const { selectedId, selectedThreadId } = useStore.getState();
  const threads = recentThreads(threadWalk(sidebarProjects(), selectedId), useThreadHistory.getState().recent, selectedThreadId);
  if (threads.length < 2) return;
  const targets = threads.map(thread => ({ workspaceId: thread.workspaceId, threadId: thread.threadId }));
  const fromOpen = threads[0]!.threadId === selectedThreadId;
  switcher.openAt(targets, fromOpen ? stepSwitcherAt(targets.length, 0, step) : step === 1 ? 0 : targets.length - 1, selectedId, hold);
}

/** The hold let go: the highlighted workspace, or thread, becomes the open one. */
export function commitWorkspaceSwitch(): void {
  const state = useWorkspaceSwitcher.getState();
  const target = highlightedTarget(state);
  state.close();
  if (target !== null) goToWorkspace(target.workspaceId, target.threadId);
}

/** Escape, or the window losing focus mid-walk: the overlay leaves and the person stays where they were. */
export function cancelWorkspaceSwitch(): void {
  useWorkspaceSwitcher.getState().close();
}

/** Nothing happens while the sidebar has no row in that slot. */
export function goToWorkspaceInSlot(slot: WorkspaceSelectSlot): void {
  const target = orderedWorkspaceIds()[slot - 1];
  if (target !== undefined) goToWorkspace(target);
}

/** The hold is the modifiers the chord that ran the command is carrying; the switch's walk ends when one comes up. */
export function runShellCommand(command: KeybindingCommand, target: ShellCommandTarget, hold: ReadonlyArray<string>): void {
  if (isWorkspaceSelectCommand(command)) {
    goToWorkspaceInSlot(workspaceSelectSlot(command));
    return;
  }
  const { workspaceId } = target;
  switch (command) {
    case "sidebar.toggle":
      target.toggleSidebar();
      return;
    case "commandPalette.toggle":
      toggleCommandPalette();
      return;
    case "settings.toggle":
      useStore.getState().toggleSettings();
      return;
    // Settings takes the whole region right of the sidebar and mounts neither the panel nor the drawer, so a chord
    // that flips one would move a record behind a page that never shows it.
    case "rightPanel.toggle":
      if (useStore.getState().settingsOpen) return;
      useRightPanelStore.getState().toggleVisibility(workspaceOrHere(workspaceId));
      return;
    case "preview.toggle":
      if (workspaceId && !useStore.getState().settingsOpen) useRightPanelStore.getState().toggle(workspaceId, "preview");
      return;
    case "terminal.toggle":
      if (!useStore.getState().settingsOpen) useTerminalDrawerStore.getState().toggle(workspaceOrHere(workspaceId));
      return;
    case "terminal.new":
      if (!workspaceId) return;
      void (getTerminalFocusOwner() === "right-panel" ? openPanelTerminal(workspaceId) : openDrawerTerminal(workspaceId));
      return;
    case "terminal.split":
      if (!workspaceId) return;
      void (getTerminalFocusOwner() === "right-panel" ? splitActivePanelTerminal(workspaceId) : splitDrawerTerminal(workspaceId));
      return;
    case "terminal.zoomIn":
      if (workspaceId) stepTerminalZoom(workspaceId, 1);
      return;
    case "terminal.zoomOut":
      if (workspaceId) stepTerminalZoom(workspaceId, -1);
      return;
    case "terminal.zoomReset":
      if (workspaceId) resetTerminalZoom(workspaceId);
      return;
    case "chat.new":
      if (workspaceId) useStore.getState().newThread(workspaceId);
      return;
    case "workspace.next":
      cycleWorkspaceSwitcher(1, hold);
      return;
    case "workspace.previous":
      cycleWorkspaceSwitcher(-1, hold);
      return;
    case "thread.next":
      cycleThreadSwitcher(1, hold);
      return;
    case "thread.previous":
      cycleThreadSwitcher(-1, hold);
      return;
    default: {
      const _exhaustive: never = command;
      return;
    }
  }
}
