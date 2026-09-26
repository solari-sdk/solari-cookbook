// SPDX-License-Identifier: AGPL-3.0-only
// The left region, the four nouns as one tree. Fixed at the top: the search
// row with the compose glyph that opens a thread in the selected workspace,
// and the project switcher, "All projects" or the one project the tree is
// filtered to. Under them, scrolling: one row per project with its workspaces
// under it, each workspace's threads under that, a thread another thread's
// agent opened one step in under its opener, and a workspace an agent forked
// one step in under the thread that forked it with its own threads under
// that; under one picked project the tree starts at its workspaces. Child
// lists draw the rails that make it read as a tree. Computers are not here at
// all: they live in Settings, and a project on another computer names it once
// beside its row. On a wsp with no project the body holds one row that points
// at the first run in the centre. The settled shelf with the archive nested
// in it, keyboard traversal, the rebuild of a zombie or gone machine, the
// forget of a gone one and the project trips' dialogs live here; the rows are
// WorkspaceRow and ThreadRow beside this file, and the logic comes from the
// copied t3code files. Every action a row carries, as a button or in its
// right-click menu, comes from the project, workspace and thread registries.
// The surface itself is the shell's sidebar-glass: nothing here paints a
// background.
import { openProjectSettings } from "../settings/openAt.js";
import { ChevronDownIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, computerOffline, creationAwaits, hereWord, workspaceState, type WorkspaceState } from "@wsp/protocol";
import { ProjectGlyph } from "../projects/look.js";
import { placeName } from "../settings/places.js";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { CREATION_ASKED, CREATION_FAILED, rebuildRefusedLine } from "../actions/format.js";
import { actionById, resolveActions, type ResolvedAction } from "../actions/registry.js";
import { projectActions, type ProjectVerbs } from "../actions/projectActions.js";
import { threadActions, threadTarget, type ThreadVerbs } from "../actions/threadActions.js";
import { useThreadVerbs, useWorkspaceVerbs } from "../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../actions/workspaceActions.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { useOutOfMemoryReadings } from "../machine/live.js";
import { ForgetWorkspaceDialog } from "../components/ForgetWorkspaceDialog.js";
import { SidebarContent, SidebarGroupAction, SidebarMenuAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Spinner } from "../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { cn } from "../lib/utils.js";
import { addNotice } from "../notices/store.js";
import { catalogIn, useLaunches, useProjectsRead, useProjectsRefused, useReady, useSelectedId, useSelectedThreadId, useSelectedWorkspaceId, useSidebarProjects, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { hostAsleep } from "../boot.js";
import { onAddProjectRequest, onForgetWorkspaceRequest, onNewWorkspaceRequest, onProjectTripRequest, onRenameWorkspaceRequest, requestAddProject, type ProjectTripRequest } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { AddProjectDialog } from "./AddProjectDialog.js";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { CHILD_LIST_CLASS, GLYPH_ROW_CLASS, HOVER_GLYPH_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_LEAD_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, ROW_SENTENCE_CLASS, TWO_LINE_FIRST_CLASS, TWO_LINE_ROW_CLASS, TWO_LINE_SECOND_CLASS, groupRowId, projectRowK, threadRowId, workspaceRowId } from "./rowGrammar.js";
import { SearchRow } from "./SearchRow.js";
import { foldArchivedThreads, resolveAdjacentThreadId, resolveSettledTimestamp, splitSidebarThreads, threadForest, type ThreadNode } from "./Sidebar.logic.js";
import { forkedWorkspaces, nestedWorkspaces, projectGroups, threadTree, workspaceOf, type ProjectGroup, type ProjectRef } from "./threadTree.js";
import { SettingsRow } from "./SettingsRow.js";
import { HostFoot } from "../hosts/HostFoot.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { ThreadLaunchRow, ThreadRow } from "./ThreadRow.js";
import { WorkspaceRow } from "./WorkspaceRow.js";
import { NEW_THREAD_TITLE, compactTimeLabel, placeNames, projectComputerWord, whereWord } from "./workspaceRows.js";
import { NEW_WORKSPACE, PROJECT_WORDS } from "./words.js";

/** Which workspaces have their idle shelf shut, so a shelf is open until this workspace's own chevron shuts it. */
/** The projects whose idle workspaces the person opened; a fold starts shut. */
const IDLE_OPEN_KEY = "wsp:sidebar-idle-open";
/** The archive is the other way about: it holds the rows a person has stopped looking at, so it is shut until this
 * workspace's own chevron opens it, and the list remembers the ones that were opened. */
const ARCHIVED_OPEN_KEY = "wsp:sidebar-archived-open";
/** The project the tree is filtered to. A view of this window alone, so it never follows a person to another one. */
const PROJECT_PICK_KEY = "wsp:sidebar-project";
const NOTHING_COLLAPSED: ReadonlyArray<string> = [];
const workspaceIdsCodec: Codec<ReadonlyArray<string>> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string")) {
      throw new Error(`Expected workspace ids, got ${raw}.`);
    }
    return parsed as ReadonlyArray<string>;
  },
  encode: value => JSON.stringify(value),
};
const projectPickCodec: Codec<string | null> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") throw new Error(`Expected a project id, got ${raw}.`);
    return parsed;
  },
  encode: value => JSON.stringify(value),
};

/** A double-click on the name opens the box the menu's Rename opens, and only where that action can run: a refused
 * rename leaves the name as text, so nothing opens a field the runtime would turn away. */
const openerOf = (rename: ResolvedAction): (() => void) | undefined => (rename.refusal === null ? () => void runAction(rename) : undefined);

/** The machine one workspace runs on, read per row off the workspace that row's thread runs on: what a rename has
 * to reach. */
interface RowMachine {
  readonly state: WorkspaceState;
  readonly goneWords?: string | undefined;
}

interface VisibleProject {
  readonly project: SidebarProjectSnapshot;
  readonly active: ReadonlyArray<ThreadNode<SidebarThreadSnapshot>>;
  readonly settled: ReadonlyArray<ThreadNode<SidebarThreadSnapshot>>;
  readonly archived: ReadonlyArray<ThreadNode<SidebarThreadSnapshot>>;
  /** Every thread the three trees hold, top to bottom, for the rule that says which forks nest. */
  readonly rows: { readonly active: ReadonlyArray<string>; readonly settled: ReadonlyArray<string>; readonly archived: ReadonlyArray<string> };
}

/** How many idle workspaces a project shows before it folds them under one Idle row: a few read at a glance. */
const IDLE_FOLD_AFTER = 3;

/** Each workspace's threads split into the working ones, the settled shelf, and the ones the shelf has held long
 * enough to archive, each side a tree of openers and the threads they opened. The archive is a reading of the
 * clock, so it comes from the same minute tick the countdowns do. */
function visibleProjects(projects: ReadonlyArray<SidebarProjectSnapshot>, nowMs: number): VisibleProject[] {
  return threadTree(projects).map(({ project, threads }) => {
    const { active, settled } = splitSidebarThreads(threads);
    const folded = foldArchivedThreads(settled, nowMs);
    return {
      project,
      active: threadForest(active),
      settled: threadForest(folded.settled),
      archived: threadForest(folded.archived),
      rows: { active: active.map(t => t.id), settled: folded.settled.map(t => t.id), archived: folded.archived.map(t => t.id) },
    };
  });
}

/** The new-workspace dialog open on one project, keyed per opening so its field resets. */
interface DialogState {
  readonly key: number;
  /** The project the plus was pressed on; the dialog picks it, and with none it picks the first there is. */
  readonly project: string | null;
}

/** A project trip's dialog open for one workspace; keyed per opening so its folder and plan reset. */
interface ProjectTripState extends ProjectTripRequest {
  readonly key: number;
}

/** The frame round one row and the glyphs its hover puts beside it: the hover group is this frame and not the
 * whole list item, so a pointer over a row's children lifts nothing on the row above them. */
function RowFrame({ children, ...props }: { children: ReactNode; onContextMenu?: ((event: MouseEvent<HTMLElement>) => void) | undefined }) {
  return (
    <div className="group/menu-item relative" {...props}>
      {children}
    </div>
  );
}

export function WorkspaceSidebar() {
  const api = useStore(s => s.api);
  const conn = useStore(s => s.conn);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const select = useStore(s => s.select);
  const creations = useStore(s => s.creations);
  // Until the first list lands an empty group is unknown rather than empty, and the design spec gives this group no
  // waiting state of its own, so it holds nothing at all.
  const ready = useReady();
  const projectsRead = useProjectsRead();
  const projectsRefused = useProjectsRefused();
  const createWorkspace = useStore(s => s.createWorkspace);
  const removeProject = useStore(s => s.removeProject);
  // Where a workspace can go: the same list Settings draws, so a row and that table never name a computer twice.
  const places = useStore(s => s.places);
  // What a workspace is made of. Named apart from the sidebar's own `projects`, which are its workspace rows.
  const recorded = useStore(s => s.projects);
  const projectHome = useStore(s => s.projectHome);
  const openProjectHome = useStore(s => s.openProjectHome);
  const landings = useStore(s => s.landings);
  const loadLanding = useStore(s => s.loadLanding);
  const selectedId = useSelectedId();
  const selectedThreadId = useSelectedThreadId();
  const selectedWorkspace = useWorkspace(useSelectedWorkspaceId());
  const nowMinute = useNowMinute();
  // One clock sample per minute tick so every idle countdown reads the same now.
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const [openIdle, setOpenIdle] = useLocalStorage(IDLE_OPEN_KEY, NOTHING_COLLAPSED, workspaceIdsCodec);
  const [archivedOpenIds, setArchivedOpenIds] = useLocalStorage(ARCHIVED_OPEN_KEY, NOTHING_COLLAPSED, workspaceIdsCodec);
  const [pickStored, setPickStored] = useLocalStorage<string | null>(PROJECT_PICK_KEY, null, projectPickCodec);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** The projects whose own rows are shut, by the project's id. */
  const [shutProjects, setShutProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [addProject, setAddProject] = useState<number | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  /** Workspace id to the machine id a rebuild was asked for; the action stays disabled while that machine is still the one reported. */
  const [rebuilding, setRebuilding] = useState<Readonly<Record<string, string>>>({});
  const [forgetting, setForgetting] = useState<{ workspaceId: string; act: "forget" | "delete" } | null>(null);
  /** The row whose name is being typed, by the row id every row already carries, and whether that name is on its way;
   * one row at a time whatever its kind, the row is the only editor, and the field stays until the store has the name. */
  const [renaming, setRenaming] = useState<{ rowId: string; saving: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const renameThread = useStore(s => s.renameThread);
  const renameWorkspace = useStore(s => s.renameWorkspace);
  const canRename = useStore(s => s.api?.renameSession !== undefined);
  const harnesses = useStore(s => s.harnesses);
  const harnessesByWorkspace = useStore(s => s.harnessesByWorkspace);
  // The sidebar draws the rows, so it owns the rename's opener, as it owns the forget's dialog; a client that cannot
  // send the name offers no box, and the action carries that refusal.
  const defaultThreadVerbs = useThreadVerbs();
  const threadVerbs = useMemo<ThreadVerbs>(
    () => ({ ...defaultThreadVerbs, ...(canRename ? { rename: (threadId: string) => setRenaming({ rowId: threadRowId(threadId), saving: false }) } : {}) }),
    [canRename, defaultThreadVerbs],
  );
  const defaultVerbs = useWorkspaceVerbs();

  // This window is on another computer and the one running wsp has gone quiet: the rows stand as they were last
  // known, and the line under the head says why nothing moves.
  const asleep = hostAsleep(conn);
  const projects = useSidebarProjects();
  const launches = useLaunches();
  const visible = useMemo(() => visibleProjects(projects, nowMs), [projects, nowMs]);
  /** The thread rows this body draws for each workspace, by the rules that hide one: its project's row shut, its
   * own threads collapsed, the settled shelf shut over it, the archive shut inside that shelf. What it leaves out
   * is what a fork cannot nest under, so the rule below gives that fork a row in its project's list instead. */
  const shown = useMemo(
    () =>
      visible.map(({ project, rows }) => {
        const archivedOpen = archivedOpenIds.includes(project.id);
        const hidden = shutProjects.has(project.workspace.project.id) || collapsed.has(project.id);
        return {
          workspace: project.id,
          threads: hidden ? [] : [...rows.active, ...rows.settled, ...(rows.archived.length > 0 && archivedOpen ? rows.archived : [])],
        };
      }),
    [visible, archivedOpenIds, shutProjects, collapsed],
  );
  const nested = useMemo(() => nestedWorkspaces(projects, shown), [projects, shown]);
  const groups = useMemo(() => projectGroups(recorded, projects, nested), [recorded, projects, nested]);
  const named = useMemo(() => placeNames(places), [places]);
  // A pick for a project this host no longer holds reads as every project.
  const picked = pickStored === null ? null : groups.find(group => group.project.id === pickStored) ?? null;
  const outOfMemory = useOutOfMemoryReadings(projects);
  // One landing per project, for the pause mode a row's state word takes. Asked here, where the projects are drawn,
  // so no row asks for itself.
  useEffect(() => {
    for (const group of groups) void loadLanding(group.project.id);
  }, [groups, loadLanding]);
  const tripTarget = trip === null ? undefined : workspaces.find(w => w.id === trip.workspaceId);
  const forgetTarget = forgetting === null ? undefined : projects.find(p => p.id === forgetting.workspaceId);

  const openDialog = (project: string | null): void => setDialog({ key: Date.now(), project });
  // The palette's New workspace lands on the project the head names while one is picked, as the head's plus does.
  const openDialogForPick = (project?: string): void => openDialog(project ?? picked?.project.id ?? null);
  const openDialogRef = useRef(openDialogForPick);
  openDialogRef.current = openDialogForPick;
  useEffect(() => onNewWorkspaceRequest(({ project }) => openDialogRef.current(project)), []);
  useEffect(() => onAddProjectRequest(() => setAddProject(Date.now())), []);
  useEffect(() => onForgetWorkspaceRequest(({ workspaceId, act }) => setForgetting({ workspaceId, act })), []);
  useEffect(
    () =>
      onRenameWorkspaceRequest(({ workspaceId }) => {
        // The row is the only editor, so a box asked for from the palette opens a project row that was shut.
        setShutProjects(new Set());
        setRenaming({ rowId: workspaceRowId(workspaceId), saving: false });
      }),
    [],
  );
  useEffect(() => onProjectTripRequest(request => setTrip({ ...request, key: Date.now() })), []);

  const create = async (name: string, project: string): Promise<void> => {
    setDialog(null);
    await createWorkspace(project, name);
  };

  // The row's rebuild spins until the status names a new machine, so it stands in for the registry's plain call.
  const rebuild = async (workspaceId: string): Promise<void> => {
    const project = projects.find(p => p.id === workspaceId);
    if (!api?.rebuild || !project) return;
    setRebuilding(r => ({ ...r, [project.id]: project.status?.machineId ?? project.workspace.machineId }));
    try {
      await api.rebuild(project.id);
    } catch (e) {
      setRebuilding(({ [project.id]: _dropped, ...rest }) => rest);
      addNotice({ kind: "error", text: rebuildRefusedLine(project.displayName), where: project.displayName });
    }
  };
  const verbs = { ...defaultVerbs, rebuild: api?.rebuild ? rebuild : undefined };
  const projectVerbs: ProjectVerbs = {
    newWorkspace: project => openDialog(project),
    openSettings: openProjectSettings,
    ...(api?.projectsRemove === undefined ? {} : { removeProject: (project: string) => void removeProject(project) }),
  };
  /** One project's actions, as its row and the head standing in for its row both offer them. */
  const projectActionsOf = (group: ProjectGroup): ResolvedAction[] =>
    resolveActions(projectActions, { id: group.project.id, name: group.project.name, workspaces: group.workspaces.map(w => w.displayName) }, projectVerbs);

  const toggleCollapsed = (id: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** The project's home in the centre, with its workspaces shown under its row. */
  const openHome = (id: string): void => {
    openProjectHome(id);
    setShutProjects(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };
  const toggleProject = (id: string): void => {
    setShutProjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleIdle = (id: string): void => {
    setOpenIdle(prev => (prev.includes(id) ? prev.filter(other => other !== id) : [...prev, id]));
  };

  const toggleArchived = (id: string): void => {
    setArchivedOpenIds(prev => (prev.includes(id) ? prev.filter(other => other !== id) : [...prev, id]));
  };

  /** The name a person typed on a row, whichever kind of row it is: the store takes it while the field stays as it
   * is, and the field closes only once the store has it. A refusal leaves the name in the field to try again, with
   * the reason in the toast, so nothing a person typed is lost to a message. */
  const sendName = async (rowId: string, take: () => Promise<boolean>): Promise<void> => {
    setRenaming({ rowId, saving: true });
    const named = await take();
    setRenaming(open => (open?.rowId !== rowId ? open : named ? null : { rowId, saving: false }));
  };

  /** The machine one workspace runs on, as a thread's verbs read it: the state its row shows and, where it is gone,
   * the words that say so. Read per thread off the workspace the thread itself runs on. */
  const machineOf = (project: SidebarProjectSnapshot): RowMachine => {
    const workspace = workspaceTarget(project.workspace, project.status, places);
    return { state: workspaceState(workspace), ...(workspace.reason !== null ? { goneWords: workspace.reason } : {}) };
  };

  /** One thread's item, wherever it is listed: the active tree and the idle shelf read the same props. The row is
   * told the workspace the thread itself runs in, which is the one it is drawn under except where an agent opened
   * a thread on another workspace, and the workspace whose rows it sits among, which is what it names against.
   * Its verbs reach the machine that workspace runs on, never the one whose rows it sits among: a rename or a stop
   * travels to the thread's own machine, so a thread on a machine that is gone is refused wherever it is drawn.
   * Under the row, one step in: the threads its own agent opened, then the workspaces its agent forked, each a
   * block of its own with its threads under it. */
  const threadItem = (node: ThreadNode<SidebarThreadSnapshot>, time: (thread: SidebarThreadSnapshot) => string, under: SidebarProjectSnapshot, depth: number) => {
    const { thread, children } = node;
    const owner = workspaceOf(projects, thread) ?? under;
    const target = threadTarget(thread, { catalog: catalogIn({ harnesses, harnessesByWorkspace }, thread.workspaceId, thread.harness), ...machineOf(owner) });
    const actionsOf = resolveActions(threadActions, target, threadVerbs);
    const rowId = threadRowId(thread.id);
    const forked = forkedWorkspaces(projects, thread.id, nested);
    return (
      <li key={thread.id} data-thread-item className={RAIL_ITEM_CLASS}>
        <RowFrame>
          <ThreadRow
            thread={thread}
            time={time(thread)}
            runs={{ workspace: owner.displayName, where: whereWord(owner) }}
            under={under.displayName}
            depth={depth}
            active={selectedId === thread.workspaceId && selectedThreadId === thread.id}
            renaming={renaming?.rowId === rowId}
            saving={renaming?.rowId === rowId && renaming.saving}
            onSelect={() => select(thread.workspaceId, thread.threadId)}
            onContextMenu={event => void openContextMenu(event, actionsOf)}
            onRename={title => void sendName(rowId, () => renameThread({ sessionId: thread.sessionId, workspaceId: thread.workspaceId, harness: thread.harness, title }))}
            onRenameCancel={() => setRenaming(null)}
            onRenameOpen={openerOf(actionById(actionsOf, "rename"))}
          />
        </RowFrame>
        {children.length + forked.length > 0 ? (
          <ul className={CHILD_LIST_CLASS}>
            {children.map(child => threadItem(child, time, under, depth + 1))}
            {forked.map(child => {
              const pane = visible.find(v => v.project.id === child.id);
              return pane === undefined ? null : workspaceItem(pane, depth + 1, true);
            })}
          </ul>
        ) : null}
      </li>
    );
  };

  /** The rows under one workspace: the send in flight, the working rows, then the idle shelf under its own fold
   * with the archive nested inside it; nothing at all while the workspace is collapsed or has nothing to draw. */
  const threadsOf = ({ project, active, settled, archived }: VisibleProject, shut: boolean, depth: number) => {
    const archivedOpen = archivedOpenIds.includes(project.id);
    /** Everything the shelf holds, the archived rows included, since shutting it hides the archive with them: the
     * count on a shut shelf is what it took away, not only the rows it draws itself. */
    const shelved = settled.length + archived.length;
    /** The send this workspace has in flight, which stands as a row of its own until the runtime writes that
     * thread's: a workspace running a person's first message may not read that it has no threads. */
    const launch = launches[project.id];
    if (shut || (launch === undefined && active.length + shelved === 0)) return null;
    const started = (thread: SidebarThreadSnapshot): string => compactTimeLabel(thread.startedAt);
    const ended = (thread: SidebarThreadSnapshot): string => compactTimeLabel(resolveSettledTimestamp(thread));
    return (
      <ul className={CHILD_LIST_CLASS}>
        {launch === undefined ? null : (
          <li data-thread-selection-safe className={RAIL_ITEM_CLASS}>
            <ThreadLaunchRow launch={launch} depth={depth} />
          </li>
        )}
        {active.map(node => threadItem(node, started, project, depth))}
        {settled.map(node => threadItem(node, ended, project, depth))}
        {archived.length > 0 ? (
          <ThreadGroupRow rowId={groupRowId("archived", project.id)} label="Archived" count={archived.length} open={archivedOpen} depth={depth} onToggle={() => toggleArchived(project.id)} />
        ) : null}
        {archived.length > 0 && archivedOpen ? archived.map(node => threadItem(node, ended, project, depth)) : null}
      </ul>
    );
  };

  /** One workspace's block: its row and the rows under it. The item carries the rail where it stands in a child
   * list, and none where it stands at the top, which is a workspace under one picked project. */
  const workspaceItem = (visibleProject: VisibleProject, depth: number, rail: boolean) => {
    const { project } = visibleProject;
    const actions = resolveActions(workspaceActions, workspaceTarget(project.workspace, project.status, places), verbs);
    const isCollapsed = collapsed.has(project.id);
    const rebuildAsked = rebuilding[project.id] !== undefined && rebuilding[project.id] === (project.status?.machineId ?? project.workspace.machineId);
    const naming = renaming?.rowId === workspaceRowId(project.id);
    return (
      <li key={project.id} data-sidebar="menu-item" className={cn(rail && RAIL_ITEM_CLASS)}>
        {/* A row holding the box takes no menu over it, as a thread row being named does not. */}
        <RowFrame {...(naming ? {} : { onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, actions, { returnTo: event.currentTarget.querySelector<HTMLElement>("[data-sidebar-row]") }) })}>
          <WorkspaceRow
            project={project}
            outOfMemory={outOfMemory[project.id]}
            nowMs={nowMs}
            depth={depth}
            actions={actions}
            active={selectedId === project.id && selectedThreadId === null}
            collapsed={isCollapsed}
            rebuildAsked={rebuildAsked}
            renaming={naming}
            saving={naming && renaming?.saving === true}
            onSelect={() => select(project.id)}
            onToggleCollapsed={() => toggleCollapsed(project.id)}
            onRename={name => void sendName(workspaceRowId(project.id), () => renameWorkspace({ workspaceId: project.id, name }))}
            onRenameCancel={() => setRenaming(null)}
            onRenameOpen={openerOf(actionById(actions, "rename"))}
          />
        </RowFrame>
        {threadsOf(visibleProject, isCollapsed, depth + 1)}
      </li>
    );
  };

  /** A workspace being made, under the project it belongs to, at the bottom where it will stand once it is one. */
  const creationItem = (creation: Creation, depth: number, rail: boolean) => (
    <li key={creation.key} className={cn(rail && RAIL_ITEM_CLASS)}>
      <RowFrame>
        <CreationRow creation={creation} depth={depth} active={selectedId === creation.key} onSelect={() => select(creation.key)} />
      </RowFrame>
    </li>
  );

  /** What stands under a project: its workspaces, the ones being made, and the leaf that says it has none. */
  const projectChildren = (group: ProjectGroup, depth: number, rail: boolean) => {
    const made = creations.filter(creation => creation.project === group.project.id);
    return (
      <>
        {(() => {
          const panes = group.workspaces.flatMap(workspace => visible.filter(v => v.project.id === workspace.id));
          // Idle is a workspace with nothing running and no send in flight; past a few, they fold under one row.
          const idle = panes.filter(pane => pane.active.length === 0 && launches[pane.project.id] === undefined);
          if (idle.length <= IDLE_FOLD_AFTER) return panes.map(pane => workspaceItem(pane, depth, rail));
          const open = openIdle.includes(group.project.id);
          return [
            ...panes.filter(pane => !idle.includes(pane)).map(pane => workspaceItem(pane, depth, rail)),
            <ThreadGroupRow key="idle" rowId={groupRowId("settled", group.project.id)} label="Idle" count={idle.length} open={open} depth={depth} onToggle={() => toggleIdle(group.project.id)} />,
            ...(open ? idle.map(pane => workspaceItem(pane, depth, rail)) : []),
          ];
        })()}
        {made.map(creation => creationItem(creation, depth, rail))}
        {group.workspaces.length === 0 && made.length === 0 ? (
          <li data-thread-selection-safe className={cn(rail && RAIL_ITEM_CLASS)}>
            <p data-k="no-workspaces" data-depth={depth} className="flex h-9 items-center px-2 text-[13px] text-muted-foreground">
              {PROJECT_WORDS.noWorkspaces}
            </p>
          </li>
        ) : null}
      </>
    );
  };

  /** One project under "All projects": its row, with the count of what it hides while shut and the plus that
   * starts another piece of work on it on hover, then its workspaces one step in. */
  /** The computer a project lives on, by the name its person gave it. */
  const deviceOf = (group: ProjectGroup): string => projectComputerWord(group.project, named) ?? (places[0] === undefined ? hereWord(true) : placeName(places[0], true));
  const projectItem = (group: ProjectGroup) => {
    const { id, name } = group.project;
    const shut = shutProjects.has(id);
    const actions = projectActionsOf(group);
    const device = deviceOf(group);
    const count = group.workspaces.length + creations.filter(creation => creation.project === id).length;
    return (
      <li key={id} data-project={id} className="mt-2 first:mt-0">
        <RowFrame onContextMenu={event => void openContextMenu(event, actions, { returnTo: event.currentTarget.querySelector<HTMLElement>("[data-sidebar-row]") })}>
          <SidebarMenuButton
            size="sm"
            data-sidebar-row
            data-row-id={projectRowK(id)}
            data-depth={0}
            data-lines={2}
            aria-expanded={!shut}
            aria-label={[name, device, ...(shut ? [String(count)] : [])].join(", ")}
            className={cn(TWO_LINE_ROW_CLASS, GLYPH_ROW_CLASS, "items-center")}
            isActive={projectHome === id}
            onClick={() => (projectHome === id ? toggleProject(id) : openHome(id))}
          >
            {/* One block: the glyph centred on the two lines, the computer the project lives on small and quiet
                right over its name, which is the row's subject in the full ink. */}
            <ProjectGlyph projectId={id} />
            <span className="flex min-w-0 flex-1 flex-col justify-center">
              <span data-project-computer className="truncate text-[11px] leading-[14px] text-muted-foreground">
                {device}
              </span>
              <span className="flex min-w-0 items-center gap-2.5 leading-5">
                <span data-project-name className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">
                  {name}
                </span>
                {shut ? (
                  <span data-project-count className={cn(ROW_META_CLASS, "shrink-0 transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0")}>
                    {count}
                  </span>
                ) : null}
              </span>
            </span>
          </SidebarMenuButton>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  showOnHover
                  className={cn(HOVER_GLYPH_CLASS, "disabled:pointer-events-none disabled:opacity-50")}
                  data-k="new-workspace"
                  data-project={id}
                  aria-label={NEW_WORKSPACE}
                  disabled={api === null}
                  onClick={() => openDialog(id)}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{NEW_WORKSPACE}</TooltipPopup>
          </Tooltip>
        </RowFrame>
        {shut ? null : <ul className={CHILD_LIST_CLASS}>{projectChildren(group, 1, true)}</ul>}
      </li>
    );
  };

  // The body on its way out of a slide is still drawn: its rows are not the ones the keyboard walks.
  const rows = (): HTMLElement[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []);
  const focusRow = (id: string | null): void => {
    if (id === null) return;
    rows().find(r => r.dataset["rowId"] === id)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const ids = rows().map(r => r.dataset["rowId"] ?? "");
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row]")?.dataset["rowId"] ?? null;
    switch (e.key) {
      case "ArrowDown":
        focusRow(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: current, direction: "next" }) ?? current);
        break;
      case "ArrowUp":
        if (current === null) return;
        focusRow(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: current, direction: "previous" }) ?? current);
        break;
      case "Home":
        if (current === null) return;
        focusRow(ids[0] ?? null);
        break;
      case "End":
        if (current === null) return;
        focusRow(ids.at(-1) ?? null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const offline = useMemo(() => computerOffline(Object.values(statuses)), [statuses]);
  /** The one add control at rest: a new thread in the selected workspace, held while none is selected. Held by
   * aria-disabled rather than the disabled attribute, so the pointer still reaches it and the tooltip can say what
   * it is in the one state a person might ask why it is held. */
  const compose = (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarGroupAction
            className="text-sidebar-muted-foreground transition-colors duration-150 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-sidebar-muted-foreground"
            aria-label="New thread"
            aria-disabled={selectedWorkspace === null || undefined}
            onClick={() => {
              if (selectedWorkspace !== null) verbs.newThread(selectedWorkspace.id);
            }}
          />
        }
      >
        <SquarePenIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{NEW_THREAD_TITLE}</TooltipPopup>
    </Tooltip>
  );
  const header = (
    <div className="flex flex-col px-[var(--sidebar-content-inset)] pb-1" data-sidebar-search>
      <div className="relative">
        <SearchRow action={compose} />
      </div>
      <ProjectSwitcher
        projects={groups.map(group => group.project)}
        named={named}
        pick={picked?.project ?? null}
        onPick={setPickStored}
        onNewWorkspace={openDialog}
        onAddProject={() => setAddProject(Date.now())}
        onContextMenu={(event, projectId) => {
          const group = groups.find(g => g.project.id === projectId);
          if (group !== undefined) void openContextMenu(event, projectActionsOf(group));
        }}
      />
      {asleep ? (
        <p data-sidebar-asleep className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
          {HOST_ASLEEP_LINE}
        </p>
      ) : offline ? (
        <p data-sidebar-offline className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
          {PROVIDER_UNREACHED_LINE}
        </p>
      ) : null}
    </div>
  );

  /** The creations whose project this host has not answered for: they belong to no row yet, so they wait under
   * the projects rather than not being drawn at all. */
  const homeless = creations.filter(creation => !groups.some(group => group.project.id === creation.project));
  const empty = ready && projectsRead && projectsRefused === null && groups.length === 0 && creations.length === 0;

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={header}>
          <ul data-sidebar-tree className="flex w-full min-w-0 flex-col gap-1 px-[var(--sidebar-content-inset)] pt-1">
            {picked === null ? groups.map(projectItem) : projectChildren(picked, 0, false)}
            {homeless.map(creation => creationItem(creation, 0, false))}
            {projectsRefused !== null ? (
              <li>
                <p data-k="projects-refused" className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
                  {PROJECT_WORDS.notRead(projectsRefused.said)}
                </p>
              </li>
            ) : null}
            {empty ? (
              <li>
                <SidebarMenuButton size="sm" data-k="new-project" className={ONE_LINE_ROW_CLASS} onClick={requestAddProject}>
                  <PlusIcon className="size-4" />
                  <span>{PROJECT_WORDS.new}</span>
                </SidebarMenuButton>
              </li>
            ) : null}
          </ul>
          <ForwardsList />
        </SidebarContent>
        <SidebarChromeFooter>
          <SettingsRow />
          <HostFoot />
        </SidebarChromeFooter>
      </div>
      {dialog ? (
        <NewWorkspaceDialog
          key={dialog.key}
          projects={recorded}
          landings={landings}
          places={places}
          picked={dialog.project}
          onCreate={(name, project) => void create(name, project)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {addProject !== null ? <AddProjectDialog key={addProject} onClose={() => setAddProject(null)} /> : null}
      {trip !== null && tripTarget !== undefined ? <ExportProjectDialog key={trip.key} workspace={tripTarget} onClose={() => setTrip(null)} /> : null}
      {forgetTarget !== undefined ? (
        <ForgetWorkspaceDialog
          workspace={forgetTarget.workspace}
          threads={forgetTarget.threads.length}
          act={forgetting!.act}
          open
          onOpenChange={next => {
            if (!next) setForgetting(null);
          }}
        />
      ) : null}
    </>
  );
}

/** The fold over one group of thread rows, which shuts and opens it: the word alone while the group is open, the
 * word with its count while it is shut, so a shut group still says how much it holds. The idle shelf and the archive
 * under it are one row, so neither can drift from the other. The label says the two words with the space the face
 * draws as a gap. */
function ThreadGroupRow({ rowId, label, count, open, depth, onToggle }: { rowId: string; label: string; count: number; open: boolean; depth: number; onToggle: () => void }) {
  // A fold is a label over rows, not a row of its own: no fill on hover, only its words step up.
  return (
    <li data-thread-selection-safe className={RAIL_ITEM_CLASS}>
      <button
        type="button"
        data-sidebar-row
        data-row-id={rowId}
        data-depth={depth}
        aria-expanded={open}
        aria-label={open ? label : `${label} ${count}`}
        onClick={onToggle}
        className="group/fold flex h-7 w-full items-center gap-1.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span data-group-word className={cn(ROW_PROSE_CLASS, "shrink-0 transition-colors duration-150 group-hover/fold:text-sidebar-foreground")}>
          {label}
        </span>
        {open ? null : (
          <span data-group-count className={cn(ROW_META_CLASS, "shrink-0")}>
            {count}
          </span>
        )}
        <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-sidebar-foreground/45 transition-transform duration-150", !open && "-rotate-90")} />
      </button>
    </li>
  );
}

/** A workspace still being created: the spinner in the lead, the name, the word for a create that was refused in
 * the slot, and under them the step the create is waiting on, cut at the row's width with the whole of it on the
 * row's hover text. A note on a step already taken stays in the log: this line is the create's state. */
function CreationRow({ creation, depth, active, onSelect }: { creation: Creation; depth: number; active: boolean; onSelect: () => void }) {
  const failed = creation.failed !== null;
  const line = failed ? creation.failed.title : creation.lines.findLast(l => creationAwaits(l.stage))?.message ?? CREATION_ASKED;
  return (
    <SidebarMenuButton size="lg" isActive={active} aria-busy={failed ? undefined : "true"} data-sidebar-row data-row-id={creation.key} data-depth={depth} data-lines={2} className={TWO_LINE_ROW_CLASS} onClick={onSelect}>
      {/* The lead centres on the first line, as a one-line row's lead does. */}
      <span aria-hidden className={cn(ROW_LEAD_CLASS, "h-8")}>
        {failed ? null : <Spinner className="size-4" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={TWO_LINE_FIRST_CLASS}>
          <span data-creation-name className="min-w-0 flex-1 truncate text-sidebar-foreground">
            {creation.name}
          </span>
          <span data-creation-state className={cn(ROW_PROSE_CLASS, "shrink-0 text-right")}>
            {failed ? CREATION_FAILED : ""}
          </span>
        </span>
        <span className={TWO_LINE_SECOND_CLASS}>
          <span data-creation-line className={cn(ROW_PROSE_CLASS, "min-w-0 flex-1 truncate")} title={line}>
            {line}
          </span>
        </span>
      </span>
    </SidebarMenuButton>
  );
}
