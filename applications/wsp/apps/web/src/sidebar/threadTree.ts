// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's tree, read once for every surface that draws it: which project
// holds which workspaces, which thread opened which, and which workspace an
// agent forked out of a thread, which is drawn under that thread.
// The runtime stamps the opener on the thread it opened and nothing else
// records it, so parentThreadId is the only field read here and a name, a
// folder or a shared workspace never stands in for it. A thread joins the rows
// of the workspace its opener is drawn among, however many steps up that is,
// while the workspace its session is filed under stays what its meta names and
// what selecting it opens: the two are the same thread's two facts and a
// surface needs both.
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { nestSpawnedThreads } from "./Sidebar.logic.js";

/** One project of the sidebar: the record the host holds for it, and the workspaces of it that stand in its own
 * list. A workspace an agent forked stands here too unless the thread that forked it has a row drawn, where it
 * nests under that thread instead: one row per workspace, whatever is shut. */
export interface ProjectGroup {
  readonly project: ProjectRef;
  readonly workspaces: ReadonlyArray<SidebarProjectSnapshot>;
}

/** What a project row needs to draw itself, whether the host's projects list has arrived or not: a workspace
 * carries its project's id and name, which is enough for a header, and the record adds the computer it lives on. */
export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly computer?: string;
}

/** The thread rows one workspace's block draws while nothing under it is shut: what the body would list for it,
 * given to the rule below so a fork's nesting reads the same rows a person can see. */
export interface ThreadsShown {
  readonly workspace: string;
  readonly threads: ReadonlyArray<string>;
}

/** Which workspaces nest under a thread rather than standing in their project's list: a workspace an agent forked
 * nests under the thread that forked it while that thread has a row of its own, and stands in the list otherwise.
 * A thread has a row only while the workspace it runs on has one, so a fork under a fork's undrawn thread falls
 * back too; the walk repeats until nothing more can be reached, which is what keeps the two rules one rule.
 *
 * Every state that hides a thread reads here: its workspace collapsed, its project's section shut, the settled
 * shelf shut over it, the archive shut over it, the thread forgotten. A fork whose opener is hidden by any of them
 * would otherwise have no row anywhere, taking its own threads with it. */
export function nestedWorkspaces(rows: ReadonlyArray<SidebarProjectSnapshot>, shown: ReadonlyArray<ThreadsShown>): Set<string> {
  const threadsOf = new Map(shown.map(one => [one.workspace, one.threads]));
  const forkOf = [...rows].flatMap(row => (row.workspace.parentThreadId === undefined ? [] : [{ workspace: row.id, opener: row.workspace.parentThreadId }]));
  /** The threads whose rows are reachable, which starts at the workspaces standing in a project's own list. */
  const drawn = new Set<string>();
  const nested = new Set<string>();
  const reach = (workspaces: ReadonlyArray<string>): void => {
    for (const workspace of workspaces) for (const thread of threadsOf.get(workspace) ?? []) drawn.add(thread);
  };
  reach(rows.filter(row => row.workspace.parentThreadId === undefined).map(row => row.id));
  for (;;) {
    const next = forkOf.filter(fork => drawn.has(fork.opener) && !nested.has(fork.workspace)).map(fork => fork.workspace);
    if (next.length === 0) return nested;
    for (const workspace of next) nested.add(workspace);
    reach(next);
  }
}

/** The projects the sidebar draws, in the order the host holds them, each with the workspaces that stand in its
 * own list: every workspace of it but the forks nesting under a thread the body draws. A project every one of
 * whose workspaces nests still has its header and its plus, and one whose fork has nowhere to nest lists it where
 * the plain rule puts it. A workspace whose project the host's list does not carry keeps a project of its own off
 * its own record, so a list that has not arrived, or a workspace of a project another computer holds, never loses
 * its row. */
export function projectGroups(recorded: ReadonlyArray<ProjectView>, rows: ReadonlyArray<SidebarProjectSnapshot>, nested: ReadonlySet<string> = new Set()): ProjectGroup[] {
  const groups = new Map<string, { project: ProjectRef; workspaces: SidebarProjectSnapshot[] }>();
  for (const project of recorded) groups.set(project.id, { project: { id: project.id, name: project.name, computer: project.computer }, workspaces: [] });
  for (const row of rows) {
    const own = row.workspace.project;
    const group = groups.get(own.id) ?? { project: { id: own.id, name: own.name, computer: own.computer }, workspaces: [] };
    groups.set(own.id, group);
    if (!nested.has(row.id)) group.workspaces.push(row);
  }
  return [...groups.values()];
}

/** The workspaces one thread's own agent forked and that nest under it, in the order the sidebar draws workspaces.
 * A fork is a copy of the whole computer with its own branch, so its row carries the same three lines a top-level
 * row does, one step in under the thread that asked for it. One whose opener has no row is not here: it stands in
 * its project's list instead, which is the same set read the other way about. */
export function forkedWorkspaces(rows: ReadonlyArray<SidebarProjectSnapshot>, openerThreadId: string, nested: ReadonlySet<string> = new Set()): SidebarProjectSnapshot[] {
  return rows.filter(row => row.workspace.parentThreadId === openerThreadId && nested.has(row.id));
}

/** A thread with the workspace it runs on, which is not always the workspace whose rows it is drawn among. */
export interface ThreadOnWorkspace {
  readonly thread: SidebarThreadSnapshot;
  readonly runs: SidebarProjectSnapshot;
}

/** One workspace's rows: its own threads whose opener is not on another workspace, and every thread its own
 * threads opened elsewhere. Each workspace keeps a group even when it has no rows left to draw. */
export interface ThreadTreeGroup {
  readonly project: SidebarProjectSnapshot;
  readonly threads: ReadonlyArray<SidebarThreadSnapshot>;
}

/** The workspace a thread runs on, by the id its session carries. */
export function workspaceOf(
  projects: ReadonlyArray<SidebarProjectSnapshot>,
  thread: Pick<SidebarThreadSnapshot, "workspaceId">,
): SidebarProjectSnapshot | undefined {
  return projects.find(project => project.id === thread.workspaceId);
}

/** The threads one thread's own agent opened, each with the workspace it runs on, in the order the workspaces are
 * drawn in. The transcript row and the footer's total both read this, so a thread named in one is named in both. */
export function threadsOpenedBy(projects: ReadonlyArray<SidebarProjectSnapshot>, openerThreadId: string): ThreadOnWorkspace[] {
  return projects.flatMap(project =>
    project.threads.filter(thread => thread.parentThreadId === openerThreadId).map(thread => ({ thread, runs: project })),
  );
}

/** The thread that opened this one, with the workspace it runs on, which is the other way along the same edge
 * threadsOpenedBy walks. Nothing for a thread nobody opened, and nothing while the opener's own workspace has not
 * arrived: a name is only drawn for an opener a click can reach. */
export function openedBy(
  projects: ReadonlyArray<SidebarProjectSnapshot>,
  thread: Pick<SidebarThreadSnapshot, "parentThreadId">,
): ThreadOnWorkspace | undefined {
  const opener = thread.parentThreadId;
  if (opener === null) return undefined;
  for (const project of projects) {
    const found = project.threads.find(row => row.id === opener);
    if (found !== undefined) return { thread: found, runs: project };
  }
  return undefined;
}

/** Every workspace with the threads its rows draw, each spawned thread behind the thread that opened it. A surface
 * that sorts the rows itself (the sidebar parts the working ones from the idle shelf) nests them again after; one
 * that lists them as they come reads the tree from here. */
export function threadTree(projects: ReadonlyArray<SidebarProjectSnapshot>): ThreadTreeGroup[] {
  const byId = new Map<string, SidebarThreadSnapshot>();
  for (const project of projects) for (const thread of project.threads) byId.set(thread.id, thread);
  // A workspace an agent forked has a row of its own under the thread that forked it, so its threads stay on it
  // rather than joining the rows of the workspace that thread runs on: the row is already one step in there.
  const forks = new Set(projects.filter(project => project.workspace.parentThreadId !== undefined).map(project => project.id));
  const groups = new Map<string, SidebarThreadSnapshot[]>(projects.map(project => [project.id, []]));
  for (const project of projects) {
    // drawnUnder answers the workspace of a thread one of these projects holds, so every group it names is here.
    for (const thread of project.threads) groups.get(drawnUnder(thread, byId, forks))!.push(thread);
  }
  return projects.map(project => ({ project, threads: nestSpawnedThreads(groups.get(project.id)!) }));
}

/** The workspace whose rows a thread joins: its own where that workspace is a fork with a row of its own, else
 * the one its opener joins, up the chain to the thread a person or the command line opened. A chain that leads
 * round in a circle leaves the thread on its own workspace, since a thread nobody can reach is worse than one
 * drawn where it runs. */
function drawnUnder(thread: SidebarThreadSnapshot, byId: ReadonlyMap<string, SidebarThreadSnapshot>, forks: ReadonlySet<string>): string {
  if (forks.has(thread.workspaceId)) return thread.workspaceId;
  const seen = new Set<string>([thread.id]);
  let at = thread;
  for (;;) {
    const opener = at.parentThreadId === null ? undefined : byId.get(at.parentThreadId);
    if (opener === undefined) return at.workspaceId;
    if (seen.has(opener.id)) return thread.workspaceId;
    seen.add(opener.id);
    at = opener;
  }
}
