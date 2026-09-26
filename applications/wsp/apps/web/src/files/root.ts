// SPDX-License-Identifier: AGPL-3.0-only
// Where the files and diff panes are rooted, per workspace: the folder the
// thread's agent works in, as the composer picked it, the harness then
// reported it, and the agent's own tool calls then moved its shell, unless
// the person pinned the panes somewhere; before any, the daemon's home. The
// roots the daemon browses are its home and every project folder on the
// workspace record; both panes read that one list. Beside them, the folder
// the next thread starts in: a folder the person chose outright, else the
// project the runtime's rule picks, else the daemon's home, which is what the
// line under the composer shows and what the start names. Every path here is
// absolute. Not persisted: a reload follows the thread again.
import { useMemo } from "react";
import { create } from "zustand";
import type { ProjectRef } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import { parentPath, pathSegments, type PathSegment } from "./entries.js";
import { getDaemonRoot, useDaemonRoot } from "./wire.js";

export interface WorkspaceRoot {
  /** The thread's working directory, where its harness runs and the next turn resumes; null before any thread or pick. */
  readonly followed: string | null;
  /** Where the agent's tool shell is, as its tool calls moved it; null until one did. */
  readonly shell: string | null;
  /** Where the person parked the panes; null while they follow the thread. */
  readonly pinned: string | null;
  /** The folder the person chose for the next thread through the composer's folder picker, over every project; null
   * until one is chosen, and again once a project is picked instead. */
  readonly chosen: string | null;
}

interface RootStoreState {
  byWorkspaceId: Record<string, WorkspaceRoot>;
  follow: (workspaceId: string, cwd: string) => void;
  shell: (workspaceId: string, dir: string | null) => void;
  pin: (workspaceId: string, dir: string) => void;
  unpin: (workspaceId: string) => void;
  choose: (workspaceId: string, dir: string) => void;
  unchoose: (workspaceId: string) => void;
}

const NONE: WorkspaceRoot = { followed: null, shell: null, pinned: null, chosen: null };

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

/** The browsable roots, home first: the daemon's home and every project folder on the record, each once. Empty until
 * the daemon's hello. */
export function rootsOf(home: string | null, projectDests: readonly string[]): string[] {
  if (home === null) return [];
  return [...new Set([home, ...projectDests])];
}

/** The root a path sits in, the nearest when roots nest; null when it is outside every root. */
export function rootOf(roots: readonly string[], path: string): string | null {
  let found: string | null = null;
  for (const root of roots) if (within(path, root) && (found === null || root.length > found.length)) found = root;
  return found;
}

/** The folder above, while a root still holds it: null at a root's edge, which is where the daemon refuses to list. */
export function parentWithin(roots: readonly string[], path: string): string | null {
  const above = parentPath(path);
  return above !== null && rootOf(roots, above) !== null ? above : null;
}

/** The shown folder as one row of crumbs: the root it sits in first, then one per folder below it, the last being the
 * folder itself. A folder no root holds is its own single crumb, so the row still names it once. */
export function folderCrumbs(roots: readonly string[], folder: string): PathSegment[] {
  const root = rootOf(roots, folder) ?? folder;
  return [{ name: root, path: root }, ...pathSegments(root, folder)];
}

export const useRootStore = create<RootStoreState>()(set => ({
  byWorkspaceId: {},
  follow: (workspaceId, cwd) =>
    set(s => {
      const current = s.byWorkspaceId[workspaceId] ?? NONE;
      return current.followed === cwd ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, followed: cwd } } };
    }),
  shell: (workspaceId, dir) =>
    set(s => {
      const current = s.byWorkspaceId[workspaceId] ?? NONE;
      return current.shell === dir ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, shell: dir } } };
    }),
  pin: (workspaceId, dir) =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), pinned: dir } } })),
  unpin: workspaceId =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), pinned: null } } })),
  // A chosen folder is where the panes go too, so the person sees the folder the thread will start in.
  choose: (workspaceId, dir) =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), chosen: dir, followed: dir } } })),
  unchoose: workspaceId =>
    set(s => {
      const current = s.byWorkspaceId[workspaceId] ?? NONE;
      return current.chosen === null ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, chosen: null } } };
    }),
}));

/** The folder the panes show: the pin, else the agent's shell folder where the daemon can list it, else the thread's
 * folder, else the daemon's home (null until its hello). */
export function selectRoot(byWorkspaceId: Record<string, WorkspaceRoot>, workspaceId: string, roots: readonly string[]): string | null {
  const entry = byWorkspaceId[workspaceId] ?? NONE;
  const shell = entry.shell !== null && rootOf(roots, entry.shell) !== null ? entry.shell : null;
  return entry.pinned ?? shell ?? entry.followed ?? roots[0] ?? null;
}

/** The workspace's one project off the store: a workspace is one project's copy, so this is the whole of what it
 * holds. Null while the store has no record for it yet. */
export function useProject(workspaceId: string): ProjectRef | null {
  return useStore(s => s.workspaces.find(w => w.id === workspaceId)?.project ?? null);
}

export function useRoots(workspaceId: string): string[] {
  const home = useDaemonRoot(workspaceId);
  const project = useProject(workspaceId);
  const path = project?.path;
  return useMemo(() => rootsOf(home, path === undefined ? [] : [path]), [home, path]);
}

export function useRoot(workspaceId: string): string | null {
  const roots = useRoots(workspaceId);
  return useRootStore(s => selectRoot(s.byWorkspaceId, workspaceId, roots));
}

export function usePinned(workspaceId: string): boolean {
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).pinned !== null);
}

/** The project the next thread on the workspace starts in when no folder was chosen outright: the workspace's own,
 * since a workspace is one project's copy. Null while the store has no record for it yet. */
export function useDefaultProject(workspaceId: string): ProjectRef | null {
  return useProject(workspaceId);
}

/** The folder the workspace's thread works in, for a dialog about that folder (export): the thread's own as the
 * harness reported it, else the default project's, else the daemon's home. */
export function useWorkingFolder(workspaceId: string): string | null {
  const daemonRoot = useDaemonRoot(workspaceId);
  const project = useDefaultProject(workspaceId);
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).followed) ?? project?.path ?? daemonRoot;
}

export function useChosenFolder(workspaceId: string): string | null {
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).chosen);
}

/** The folder the next thread starts in, as the line under the composer shows it: the folder chosen outright, else
 * the default project's, else the kind's own folder as the runtime publishes it on the view, else the daemon's home,
 * which is where a kind that names no folder lands the shell (a fork's daemon runs from that home). A shown thread's
 * own folder is its row's, not this: a resume runs where its harness already is. */
export function useThreadFolder(workspaceId: string): string | null {
  const daemonRoot = useDaemonRoot(workspaceId);
  const kindFolder = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.folder);
  const project = useDefaultProject(workspaceId);
  const chosen = useChosenFolder(workspaceId);
  return pickThreadFolder({ chosen, project: project?.path, kindFolder, daemonRoot });
}

/** The rule itself, so the hook above and the command that opens a terminal cannot answer it two ways. */
export function pickThreadFolder(input: { chosen: string | null; project: string | undefined; kindFolder: string | undefined; daemonRoot: string | null }): string | null {
  return input.chosen ?? input.project ?? input.kindFolder ?? input.daemonRoot;
}

/** The same folder for a caller that holds no hooks: a command reads the stores once where a component subscribes. */
export function threadFolderOf(workspaceId: string): string | null {
  const workspace = useStore.getState().workspaces.find(w => w.id === workspaceId);
  return pickThreadFolder({
    chosen: (useRootStore.getState().byWorkspaceId[workspaceId] ?? NONE).chosen,
    project: workspace?.project?.path,
    kindFolder: workspace?.folder,
    daemonRoot: getDaemonRoot(workspaceId),
  });
}

/** What the start names about its folder: the folder chosen outright as cwd, else nothing, which leaves the
 * runtime's rule to land the thread in the workspace's own project. Never the shown folder itself, so the rule has
 * one home and the composer opens where the command line does. */
export function threadStart(chosen: string | null): { cwd?: string } {
  return chosen === null ? {} : { cwd: chosen };
}

export function useThreadStart(workspaceId: string): { cwd?: string } {
  const chosen = useChosenFolder(workspaceId);
  return useMemo(() => threadStart(chosen), [chosen]);
}
