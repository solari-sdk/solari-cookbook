// SPDX-License-Identifier: AGPL-3.0-only
// The palette's item list over the sidebar's project snapshots: the shell's
// own actions, the selected workspace's actions from the workspace registry,
// one row per workspace to switch to, recent threads at rest and every thread
// whose title holds the typed query. Pure apart from the callbacks it is
// handed, so the list is testable without the dialog.
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronUpIcon, FolderPlusIcon, MessageSquareIcon, MonitorIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { PLACES_WORDS, type PlaceView } from "@wsp/protocol";
import { resolveActions, type ResolvedAction } from "../../actions/registry.js";
import { workspaceActions, workspaceTarget, type WorkspaceVerbs } from "../../actions/workspaceActions.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../../adapt/index.js";
import { WORKSPACE_SELECT_SLOTS, workspaceSelectCommand } from "../../keybindingTypes.js";
import { cn } from "../../lib/utils.js";
import { SETTINGS_WORDS } from "../../settings/format.js";
import { groupNames } from "../../settings/groups.js";
import { absenceOf } from "../../settings/places.js";
import { threadWalk } from "../../shell/shellCommands.js";
import { searchSidebarThreadsByTitle } from "../../sidebar/Sidebar.logic.js";
import { currentWorkspaceId } from "../../adapt/workspaces.js";
import { threadTree, workspaceOf } from "../../sidebar/threadTree.js";
import { compactTimeLabel, dotClassForTone, whereWord } from "../../sidebar/workspaceRows.js";
import { NEW_WORKSPACE, PROJECT_WORDS } from "../../sidebar/words.js";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS, RECENT_THREAD_LIMIT } from "./CommandPalette.logic.js";

export interface PaletteHandlers {
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly selectThread: (workspaceId: string, threadId: string | null) => void;
  readonly newWorkspace: () => void;
  readonly toggleSidebar: () => void;
  readonly toggleRightPanel: (workspaceId: string) => void;
  /** One step down the sidebar's workspaces, and back up; both wrap. */
  readonly nextWorkspace: () => void;
  readonly previousWorkspace: () => void;
  /** The same step one level down, over the threads of the workspace on screen. */
  readonly nextThread: () => void;
  readonly previousThread: () => void;
  readonly openSettings: () => void;
  readonly addProject: () => void;
  readonly openAddComputer: () => void;
}

export interface PaletteItemsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selectedId: string | null;
  /** What the person typed; the thread search runs over it, the at-rest list ignores it. */
  readonly query: string;
  readonly canCreate: boolean;
  readonly handlers: PaletteHandlers;
  readonly verbs: WorkspaceVerbs;
  /** The computers and providers this host holds, for the one reading of a workspace whose computer is not
   * answering: a row that named its own state read Unreachable for the computer the app is drawn on. */
  readonly places: readonly PlaceView[];
}

export interface PaletteItems {
  readonly actionItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly workspaceItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}

const sync = (fn: () => void) => async (): Promise<void> => {
  fn();
};

/** A registry action as a palette row, whichever registry it came from: its refusal is the row's description and its
 * disabled state, and what the row says about itself otherwise is the caller's line. */
function actionItem(action: ResolvedAction, description: string): CommandPaletteActionItem {
  const Icon = action.icon;
  return {
    kind: "action",
    value: `action:${action.id}`,
    searchTerms: [action.title, ...action.searchTerms],
    icon: Icon ? <Icon className={ITEM_ICON_CLASS} /> : null,
    title: action.title,
    description: action.refusal ?? description,
    disabled: action.refusal !== null,
    ...(action.shortcutCommand !== undefined ? { shortcutCommand: action.shortcutCommand } : {}),
    run: action.run,
  };
}

function actionItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  const { handlers, selectedId } = input;
  const selected = selectedId === null ? null : (input.projects.find(project => project.id === selectedId) ?? null);
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:new-workspace",
      searchTerms: ["new task", "create task"],
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      title: NEW_WORKSPACE,
      description: input.canCreate ? "One piece of work on one project" : "Not connected to the runtime",
      disabled: !input.canCreate,
      run: sync(handlers.newWorkspace),
    },
    {
      kind: "action",
      value: "action:add-project",
      searchTerms: ["add a project", "project", "folder", "repository", "clone", "record a project"],
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      title: PROJECT_WORDS.add,
      description: "One folder or repository address on one computer",
      run: sync(handlers.addProject),
    },
  ];
  if (selected !== null) {
    items.push(...resolveActions(workspaceActions, workspaceTarget(selected.workspace, selected.status, input.places), input.verbs).map(action => actionItem(action, selected.displayName)));
  }

  const oneWorkspace = input.projects.length < 2;
  const walk = threadWalk(input.projects, selectedId);
  const oneThread = walk.length < 2;
  // A walk steps inside the workspace on screen, and the thread lists under these rows hold every workspace's, so a
  // held Next thread over a list of four has to name the workspace it is walking and say the four are not in it.
  // Nothing to step to covers both ways the walk can come up empty: no rows under that workspace at all, and rows
  // the runtime stamped no thread id on, which pin the workspace alone and so are no step.
  const walkingIn = walkedWorkspace(input);
  const threadWalkDescription =
    walk.length > 0 ? "Only one thread" : walkingIn === null ? "No threads to walk" : `Nothing to step to on ${walkingIn}; a walk stays inside one task`;
  items.push(
    {
      kind: "action",
      value: "action:next-workspace",
      searchTerms: ["next task", "switch task", "cycle tasks"],
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      title: "Next task",
      shortcutCommand: "workspace.next",
      ...(oneWorkspace ? { disabled: true, description: "Only one task" } : {}),
      run: sync(handlers.nextWorkspace),
    },
    {
      kind: "action",
      value: "action:previous-workspace",
      searchTerms: ["previous task", "switch task", "cycle tasks"],
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      title: "Previous task",
      shortcutCommand: "workspace.previous",
      ...(oneWorkspace ? { disabled: true, description: "Only one task" } : {}),
      run: sync(handlers.previousWorkspace),
    },
    {
      kind: "action",
      value: "action:next-thread",
      searchTerms: ["next thread", "switch thread", "cycle threads"],
      icon: <ChevronDownIcon className={ITEM_ICON_CLASS} />,
      title: "Next thread",
      shortcutCommand: "thread.next",
      ...(oneThread ? { disabled: true, description: threadWalkDescription } : {}),
      run: sync(handlers.nextThread),
    },
    {
      kind: "action",
      value: "action:previous-thread",
      searchTerms: ["previous thread", "switch thread", "cycle threads"],
      icon: <ChevronUpIcon className={ITEM_ICON_CLASS} />,
      title: "Previous thread",
      shortcutCommand: "thread.previous",
      ...(oneThread ? { disabled: true, description: threadWalkDescription } : {}),
      run: sync(handlers.previousThread),
    },
    {
      kind: "action",
      value: "action:toggle-sidebar",
      searchTerms: ["toggle sidebar", "hide sidebar", "show sidebar"],
      icon: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
      title: "Toggle sidebar",
      shortcutCommand: "sidebar.toggle",
      run: sync(handlers.toggleSidebar),
    },
    {
      kind: "action",
      value: "action:add-computer",
      searchTerms: ["add a computer", "join", "box", "another mac", "laptop", "linux", "ssh"],
      icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
      title: PLACES_WORDS.addComputer,
      description: `${PLACES_WORDS.section} in ${SETTINGS_WORDS.title}`,
      run: sync(handlers.openAddComputer),
    },
    {
      kind: "action",
      value: "action:settings",
      searchTerms: ["settings", "preferences", "computers", "projects", "devices", "account", "privacy", "keybindings", "appearance", "theme", "sidebar width", "terminal size"],
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      title: SETTINGS_WORDS.title,
      description: groupNames(),
      shortcutCommand: "settings.toggle",
      run: sync(handlers.openSettings),
    },
    {
      kind: "action",
      value: "action:toggle-right-panel",
      searchTerms: ["toggle right panel", "hide panel", "show panel"],
      icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "rightPanel.toggle",
      title: "Toggle right panel",
      description: selected ? selected.displayName : "Select a task first",
      disabled: selected === null,
      run: async () => {
        if (selected) handlers.toggleRightPanel(selected.id);
      },
    },
  );
  return items;
}

/** The workspace a walk steps inside, by the name the list under these rows shows for it; null while the sidebar
 * has no workspace on screen, where there is no walk to explain. The same rule the walk itself takes its threads
 * from, so the name and the list can never name two workspaces. */
function walkedWorkspace(input: PaletteItemsInput): string | null {
  const id = currentWorkspaceId(input.projects.map(project => project.id), input.selectedId);
  return input.projects.find(project => project.id === id)?.displayName ?? null;
}

function workspaceItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  return input.projects.map((project, index) => {
    // Where it runs, in the one word the sidebar row reads for it: a person picks a workspace by its state and the
    // computer it is on, never by the id wsp holds the machine under. The state word is the row's own, which on a
    // computer that is not answering is that computer's word and not the wire's.
    const absent = absenceOf(input.places, project.workspace, project.status, null);
    const current = project.id === input.selectedId;
    // The projects arrive in sidebar order, so a row's index is the slot its chord jumps to.
    const slot = WORKSPACE_SELECT_SLOTS[index];
    return {
      kind: "action",
      value: `workspace:${project.id}`,
      searchTerms: [project.displayName],
      icon: (
        <span
          aria-hidden
          className={cn("mx-1 size-2 shrink-0 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")}
        />
      ),
      title: project.displayName,
      description: `${absent?.word ?? project.indicator.label} on ${whereWord(project)}`,
      ...(current ? { titleTrailingContent: <span className="shrink-0 text-muted-foreground/70 text-xs">Current task</span> } : {}),
      ...(slot === undefined ? {} : { shortcutCommand: workspaceSelectCommand(slot) }),
      run: sync(() => input.handlers.selectWorkspace(project.id)),
    };
  });
}

function threadItem(thread: SidebarThreadSnapshot, project: SidebarProjectSnapshot, handlers: PaletteHandlers): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `thread:${thread.id}`,
    searchTerms: [thread.title],
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    title: thread.title,
    // The workspace it runs on and where that runs, the pair the sidebar's own row carries: a thread an agent
    // opened somewhere else is told apart from its opener by these two words and nothing else.
    description: `${project.displayName} on ${whereWord(project)}`,
    timestamp: compactTimeLabel(thread.startedAt),
    run: sync(() => handlers.selectThread(thread.workspaceId, thread.threadId)),
  };
}

export function buildPaletteItems(input: PaletteItemsInput): PaletteItems {
  // The same tree the sidebar draws, read through the one rule for which thread opened which: every thread is
  // listed once, under the workspace whose rows it is drawn among, and each still names the workspace it runs on.
  const threads = threadTree(input.projects).flatMap(group =>
    group.threads.map(thread => ({ ...thread, workspace: workspaceOf(input.projects, thread) ?? group.project })),
  );
  const item = (thread: (typeof threads)[number]) => threadItem(thread, thread.workspace, input.handlers);
  const latest = [...threads].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return {
    actionItems: actionItems(input),
    workspaceItems: workspaceItems(input),
    recentThreadItems: latest.slice(0, RECENT_THREAD_LIMIT).map(item),
    threadSearchItems: searchSidebarThreadsByTitle(threads, input.query).map(item),
  };
}
