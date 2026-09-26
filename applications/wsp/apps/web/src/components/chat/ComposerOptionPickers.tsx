// SPDX-License-Identifier: AGPL-3.0-only
// The model, defaults and project pickers inside the composer box. Each lists
// what the runtime's catalog says the harness's CLI takes, asked of the
// binary on the workspace's machine once it runs; a picker whose list is
// empty does not exist. The reasoning effort, the context window and the
// access are one quiet button and one menu: the button reads the picked
// effort and the picked access, each in its short form where the row has one,
// and the menu has a Reasoning, a Context window and an Access group, each
// default marked and checked until a pick, with each access mode's one line
// under it. The button wears the access mode's own icon, since the mode is
// the one pick that says what the agent may touch. No button shrinks: the row wraps
// before any of them is cut, so every pick reads whole down to a centre column
// of about 300 px (measured 2026-09-09); the shell keeps the column wider
// than that beside the inline panel. The one label a person writes, the
// project's name, has no bound, so its button alone is capped at the row and
// cuts the name; the menu row says it whole. A pick is remembered per
// workspace and rides the next sessions.start, except that a thread that has
// run keeps the agent and the access its own rows carry: the model, its
// window and the effort a pick made on such a thread still ride its next
// send, the agent and the access never do. The access pick is
// the exception: it is remembered on the host's own record, so the next thread
// here starts at it whichever client or CLI opens it, and on a thread that has
// run it goes through the access verb, the one road that changes a thread's
// access, so that thread's next turn runs at it; where the harness takes a
// mode change mid-turn it reaches the turn in front of the person too, the
// prompt it is stopped on included, and the menu says which of the two a pick
// will do while a turn runs, over the list, before the pick is made.
// The project pick exists only on a workspace holding projects and only while
// the thread is still to be opened: it reads the runtime's default folder rule
// off the record, its menu is the workspace's projects and other folder, which
// opens the folder picker under the box, and a pick lands on the host's record
// as the workspace's last project, where the runtime reads it for every road.
import { ChevronDownIcon, CircleSlashIcon, FolderIcon, FolderOpenIcon, HandIcon, LockIcon, LockOpenIcon, PenLineIcon, PencilRulerIcon, ShieldIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { ACCESS_REFUSED_LINE, accessReachLine, kindForComputer, workspaceAccess, contextWindowsFor, effortsFor, movesRunningAccess, type HarnessCatalog, type HarnessModel, type HarnessOption, type ProjectRef, type ProjectView, type SessionView } from "@wsp/protocol";
import { baseName } from "../../files/entries";
import { useChosenFolder, useDefaultProject, useProject, useRootStore } from "../../files/root";
import { projectHomeKey, useHarnessCatalog, useHarnessCatalogs, useLatestSession, useProjects, useStore, useThreadSessions, useWorkspace } from "../../protocol/store";
import { useWhereWord } from "../../sidebar/workspaceRows";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { canPickFolder } from "./ComposerCheckoutRow";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { useComposerDraftStore } from "./composerDraftStore";
import { useComposerOptions, useComposerOptionsStore, type ComposerOptionKey, type PickThreads } from "./composerOptionsStore";
import { effectivePicks, pickedFor, resolveModel, startOptionsFrom, threadPicks, type ComposerStart, type ResolvedPicks } from "./composerPicks";
import { ACCESS_WORD, accessLabel, REASONING_WORD, reasoningLabel } from "./format";
import type { ChatThreadHandle } from "./useChatThread";

export const DEFAULT_HARNESS = DEFAULT_AGENT.id;

/** One object for a workspace nobody has picked on, so the selector hands the hook the same reference every render. */
const NO_THREADS: PickThreads = {};

/** One icon per permission mode the table knows; a mode it does not gets the shield. */
const ACCESS_ICONS: Readonly<Record<string, LucideIcon>> = {
  default: LockIcon,
  acceptEdits: PenLineIcon,
  plan: PencilRulerIcon,
  bypassPermissions: LockOpenIcon,
  auto: SparklesIcon,
  manual: HandIcon,
  dontAsk: CircleSlashIcon,
  "read-only": LockIcon,
  "workspace-write": PenLineIcon,
  "danger-full-access": LockOpenIcon,
  auto_edit: PenLineIcon,
  yolo: LockOpenIcon,
};

export interface ComposerPicks {
  readonly harness: string;
  readonly catalog: HarnessCatalog | null;
  /** The model the next start runs with, as the pickers show it. */
  readonly model: HarnessModel | null;
  readonly picks: ResolvedPicks | null;
  /** What rides a start that opens a thread; a send into a thread that has run carries the model and the effort of it. */
  readonly startOptions: ComposerStart;
  /** The thread has a turn on this harness, so the rail offers no other. */
  readonly pinned: boolean;
  /** The pinned thread's latest own row, which an access pick between turns is put to through the access verb; null
   * on a thread that has not run, and on one whose rows fell off the runtime's cap. */
  readonly latestRow: SessionView | null;
}

/** The agent the project's last thread ran, where the agents here carry it: what a fresh thread opens on, so a
 * second piece of work on a project opens where the first one left off instead of on the catalog's first row. An
 * agent the record names that this workspace has no catalog for is dropped, since a composer pointed at one would
 * draw no pickers at all. */
export function rememberedAgent(project: Pick<ProjectView, "lastAgent"> | undefined, catalogs: ReadonlyArray<HarnessCatalog>): string | undefined {
  const last = project?.lastAgent;
  return last !== undefined && catalogs.some(entry => entry.harness === last) ? last : undefined;
}

/** The one offer: taken the first time nothing says which agent to run, and given back when the person types. It
 * is not given back by the pick itself, which is the person reading that agent's models. The store holds the mark,
 * so the offer does not come back when the composer is remounted by a switch of threads, nor when the box is
 * emptied again. */
/** The record for the workspace's own project, which is where its remembered agent is written. */
function useProjectRecord(workspaceId: string): ProjectView | undefined {
  const ref = useProject(workspaceId);
  const projects = useProjects();
  return ref === null ? undefined : projects.find(entry => entry.id === ref.id);
}

/** The composer's picks for a workspace, and the catalog they read from: the machine's once it answered, else the table's. */
export function useComposerPicks(workspaceId: string, thread: ChatThreadHandle): ComposerPicks {
  const latest = useLatestSession(workspaceId);
  const catalogs = useHarnessCatalogs(workspaceId);
  const project = useProjectRecord(workspaceId);
  const remembered = rememberedAgent(project, catalogs);
  const kept = useComposerOptions(workspaceId);
  const rows = useThreadSessions(workspaceId, thread.threadKey);
  const pickedOn = useComposerOptionsStore(s => s.pickedOn[workspaceId] ?? NO_THREADS);
  const picked = useMemo(() => pickedFor(kept, thread.view, pickedOn, thread.threadKey), [kept, pickedOn, thread.threadKey, thread.view]);
  const onThread = useMemo(() => threadPicks(thread.view, rows), [rows, thread.view]);
  // The agent the open thread runs on, off its own record and then its own rows: a workspace's latest session is
  // as often another thread's.
  const own = thread.view.agent ?? rows.at(-1)?.harness;
  const pinned = own !== undefined && !thread.fresh && (thread.view.entries.length > 0 || thread.view.running);
  const latestRow = pinned ? rows.at(-1) ?? null : null;
  const harness = (pinned ? own : picked.harness ?? latest?.harness ?? remembered) ?? DEFAULT_HARNESS;
  const listed = useHarnessCatalog(harness, workspaceId);
  // A home's lists were read against no machine; the kind of workspace its send makes decides the mode it starts at.
  const homeKind = useStore(s => {
    const home = s.projects.find(p => projectHomeKey(p.id) === workspaceId);
    return home === undefined ? null : kindForComputer(home.computer);
  });
  const catalog = useMemo(() => (listed === null || homeKind === null ? listed : workspaceAccess(listed, homeKind)), [homeKind, listed]);
  const model = useMemo(() => (catalog === null ? null : resolveModel(catalog, { picked: picked.model, thread: onThread.model })), [catalog, picked.model, onThread.model]);
  const picks = useMemo(() => (catalog === null ? null : effectivePicks(catalog, { picked, thread: onThread })), [catalog, picked, onThread]);
  const startOptions = useMemo(() => (catalog === null ? {} : startOptionsFrom(catalog, picked, onThread)), [catalog, picked, onThread]);
  return { harness, catalog, model, picks, startOptions, pinned, latestRow };
}

/** Asks the workspace's machine for its catalogs once it runs; the table shows until then and stays when it does not answer. */
function useMachineCatalogs(workspaceId: string): void {
  const workspace = useWorkspace(workspaceId);
  const conn = useStore(s => s.conn);
  const load = useStore(s => s.loadHarnesses);
  const running = workspace?.phase === "running";
  useEffect(() => {
    if (running && conn === "live") void load(workspaceId);
  }, [conn, load, running, workspaceId]);
}

const triggerClass = "h-8 shrink-0 gap-2 px-2 text-[15px] font-normal text-muted-foreground hover:text-foreground sm:h-8 sm:text-[15px] [&_svg]:mx-0";

function DefaultBadge() {
  return <span className="ms-2 rounded border border-border/70 bg-muted/60 px-1 font-mono text-[10px] leading-4 text-muted-foreground">default</span>;
}

function OptionRows({ options }: { options: ReadonlyArray<HarnessOption> }) {
  return options.map(option => {
    const Icon = ACCESS_ICONS[option.value];
    return (
      <MenuRadioItem key={option.value} value={option.value} data-composer-option={option.value} className={option.description !== undefined ? "items-start py-1.5" : undefined}>
        <span className="flex min-w-0 items-start gap-2">
          {Icon !== undefined ? <Icon className="mx-0! mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center">
              <span className="truncate">{option.label}</span>
              {option.isDefault ? <DefaultBadge /> : null}
            </span>
            {/* The line under each access mode drops at the narrow width: with it the menu is taller than a phone's
                viewport and its last row was cut across the middle, and the mode's own name is what the row is. */}
            {option.description !== undefined ? <span className="hidden text-xs leading-4 text-muted-foreground sm:block">{option.description}</span> : null}
          </span>
        </span>
      </MenuRadioItem>
    );
  });
}

/** The one quiet menu behind the composer's defaults: the agent's reasoning effort, its context window and the
 * access it starts a turn at, three groups with the agent's own default marked in each. They were three buttons;
 * a person reads the row for the agent, the model and the folder, and these three are what an agent already has a
 * default for. The effort and the window belong to the thread they are picked on; the access goes onto the host's
 * record and, where the harness takes one mid-turn, into the turn in front of the person. */
/** The reasoning effort and the context window, one menu: both are how hard and how far the model reads. */
function ReasoningPicker({
  workspaceId,
  /** The thread an effort or a window pick belongs to: each is something the thread already runs at, so a pick here
   * is a change to this thread and not to every thread of the workspace. */
  threadKey,
  efforts,
  contextWindows,
  picks,
}: {
  workspaceId: string;
  threadKey: string;
  efforts: HarnessOption[];
  contextWindows: HarnessOption[];
  picks: ResolvedPicks;
}) {
  const pick = useComposerOptionsStore(s => s.pick);
  const label = reasoningLabel(efforts.find(o => o.value === picks.effort), contextWindows.find(o => o.value === picks.contextWindow));
  const onPick = (key: ComposerOptionKey) => (next: unknown) => {
    if (typeof next === "string") pick(workspaceId, key, next, threadKey);
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={triggerClass}
        aria-label={`${REASONING_WORD}: ${label}`}
        data-composer-picker="reasoning"
        data-effort={picks.effort ?? undefined}
        data-context-window={picks.contextWindow ?? undefined}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        {efforts.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Reasoning</MenuGroupLabel>
            <MenuRadioGroup value={picks.effort} onValueChange={onPick("effort")}>
              <OptionRows options={efforts} />
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {efforts.length > 0 && contextWindows.length > 0 ? <MenuSeparator /> : null}
        {contextWindows.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Context window</MenuGroupLabel>
            <MenuRadioGroup value={picks.contextWindow} onValueChange={onPick("contextWindow")}>
              <OptionRows options={contextWindows} />
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** What the agent may do without asking: its own menu, with what a pick does to a running turn over the list. */
function AccessPicker({
  modes,
  picks,
  className,
  /** What a pick does to the turn running now, over the access list; nothing while no turn runs and the pick only starts one. */
  note,
  onPickAccess,
}: {
  modes: ReadonlyArray<HarnessOption>;
  picks: ResolvedPicks;
  note: string | null;
  onPickAccess: (mode: string) => void;
  className?: string;
}) {
  const access = modes.find(o => o.value === picks.permissionMode);
  const label = accessLabel(access);
  const Icon = (picks.permissionMode !== null ? ACCESS_ICONS[picks.permissionMode] : undefined) ?? ShieldIcon;
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={cn(triggerClass, className)}
        aria-label={`${ACCESS_WORD}: ${label}`}
        data-composer-picker="access"
        data-access={picks.permissionMode ?? undefined}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Access</MenuGroupLabel>
          {note !== null ? <MenuGroupLabel data-composer-access-reach>{note}</MenuGroupLabel> : null}
          <MenuRadioGroup
            value={picks.permissionMode}
            onValueChange={next => {
              const mode = modes.find(o => o.value === next);
              if (mode !== undefined) onPickAccess(mode.value);
            }}
          >
            <OptionRows options={modes} />
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The hairline between two pickers of the bar, so each reads as its own control. */
const BarRule = () => <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border" />;

/** The thread an access pick is put to through the access verb, once it has run: the runtime's id for one of its
 * rows, which is what sessions.access takes, and the turn running now where one is, which the refusal note belongs
 * to; null on a thread that has not run, whose pick only decides what it opens at. */
export interface AccessTarget {
  readonly sessionId: string;
  readonly turnId: string | null;
}

/** The one road an access pick takes. It goes onto the host's record, where the next thread in this workspace reads
 * it whoever opens it, and, on a thread that has run, through the access verb, the one road that changes a thread's
 * access: the thread's next turn runs at it, and the turn in front of the person moves too where the harness's own
 * row says it takes a mode change mid-turn (`movesAccess`, which is what the menu says over its list before the
 * pick). `line` is the refusal that stands under the box when a row saying so came back refused all the same:
 * nothing is said for a harness whose row already said the pick waits, since the person read that before they
 * picked, and nothing for a turn that simply ended. It stands only while the turn it is about is still the running
 * one. */
export function useAccessPick(workspaceId: string, target: AccessTarget | null, threadKey: string, movesRunningTurn: boolean): { pick: (mode: string) => void; line: string | null } {
  const api = useStore(s => s.api);
  const setPreferences = useStore(s => s.setPreferences);
  const stamp = useComposerOptionsStore(s => s.pick);
  const [note, setNote] = useState<{ turnId: string } | null>(null);
  const pick = useCallback(
    (mode: string) => {
      setNote(null);
      void setPreferences({ access: { [workspaceId]: mode } });
      // The thread it was picked on is kept in the browser beside the other picks, so the button paints this
      // thread's pick before the thread's row comes round with it, and not every thread here.
      stamp(workspaceId, "permissionMode", mode, threadKey);
      if (target === null || api?.setSessionAccess === undefined) return;
      const turnId = target.turnId;
      void api.setSessionAccess(target.sessionId, mode).then(outcome => {
        if (outcome === "unsupported" && movesRunningTurn && turnId !== null) setNote({ turnId });
      }, () => {});
    },
    [api, movesRunningTurn, setPreferences, stamp, target, threadKey, workspaceId],
  );
  return { pick, line: note !== null && note.turnId === target?.turnId ? ACCESS_REFUSED_LINE : null };
}

/** The word other folder wears in the project menu and, once one is chosen, the folder's own name on the trigger. */
export const OTHER_FOLDER = "other folder";

/** The project the workspace holds, and the road to a folder beside it: the project's own name, or the chosen
 * folder's last segment once one is picked. A workspace is one project's copy, so the menu offers that project and
 * other folder, which hands the pick to the folder picker under the box. The button is capped at the row's width,
 * since a folder's name is as long as the person made it. */
function ProjectPicker({ workspaceId, projects, onOtherFolder }: { workspaceId: string; projects: readonly ProjectRef[]; onOtherFolder: () => void }) {
  const project = useDefaultProject(workspaceId);
  const chosen = useChosenFolder(workspaceId);
  const unchoose = useRootStore(s => s.unchoose);
  const follow = useRootStore(s => s.follow);
  const value = chosen === null ? project?.name ?? null : null;
  const label = chosen !== null ? baseName(chosen) : project?.name ?? "Project";
  const Icon = chosen !== null ? FolderOpenIcon : FolderIcon;
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className={`${triggerClass} max-w-full`}
        aria-label={`Project: ${label}`}
        data-composer-picker="project"
        data-value={value ?? undefined}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span data-composer-project-name className="min-w-0 truncate font-mono">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuRadioGroup
          value={value}
          onValueChange={next => {
            const picked = projects.find(p => p.name === next);
            if (picked === undefined) return;
            unchoose(workspaceId);
            follow(workspaceId, picked.path);
          }}
        >
          {projects.map(p => (
            <MenuRadioItem key={p.name} value={p.name} data-composer-project={p.name} title={p.path}>
              <span className="flex min-w-0 items-center gap-2">
                <FolderIcon className="mx-0! size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-mono">{p.name}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={onOtherFolder} data-composer-project-other>
          <FolderOpenIcon />
          <span className="truncate">{OTHER_FOLDER}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function ComposerOptionPickers({
  workspaceId,
  thread,
  onPickAccess,
  onOtherFolder,
  compact = false,
}: {
  /** The one-line composer's pickers: the model and the reasoning only, the access having moved under the box. */
  compact?: boolean;
  workspaceId: string;
  thread: ChatThreadHandle;
  onPickAccess: (mode: string) => void;
  /** Opens the folder picker under the box, where the project menu's other folder row sends the pick. */
  onOtherFolder: () => void;
}) {
  useMachineCatalogs(workspaceId);
  const pick = useComposerOptionsStore(s => s.pick);
  const catalogs = useHarnessCatalogs(workspaceId);
  const project = useProject(workspaceId);
  const projects = useMemo(() => (project === null ? [] : [project]), [project]);
  const where = useWhereWord(workspaceId);
  const { catalog, model, picks, pinned } = useComposerPicks(workspaceId, thread);
  if (catalog === null || picks === null) return null;
  const efforts = effortsFor(catalog, model);
  const contextWindows = contextWindowsFor(catalog, model);
  return (
    <>
      <ComposerModelPicker
        catalogs={catalogs}
        catalog={catalog}
        model={model}
        pinned={pinned}
        where={where}
        onPickHarness={harness => pick(workspaceId, "harness", harness)}
        onPickModel={(harness, value) => {
          if (harness !== catalog.harness) pick(workspaceId, "harness", harness);
          pick(workspaceId, "model", value, thread.threadKey);
        }}
      />
      {efforts.length > 0 || contextWindows.length > 0 ? (
        <>
          {compact ? null : <BarRule />}
          <ReasoningPicker workspaceId={workspaceId} threadKey={thread.threadKey} efforts={efforts} contextWindows={contextWindows} picks={picks} />
        </>
      ) : null}
      {!compact && catalog.permissionModes.length > 0 ? (
        <>
          <BarRule />
          <AccessPicker modes={catalog.permissionModes} picks={picks} note={thread.view.running ? accessReachLine(movesRunningAccess(catalog)) : null} onPickAccess={onPickAccess} />
        </>
      ) : null}
      {!compact && projects.length > 0 && canPickFolder(thread) ? <ProjectPicker workspaceId={workspaceId} projects={projects} onOtherFolder={onOtherFolder} /> : null}
    </>
  );
}

/** The access picker alone, sized for the strip under the one-line composer. */
export function ComposerAccessPicker({ workspaceId, thread, onPickAccess }: { workspaceId: string; thread: ChatThreadHandle; onPickAccess: (mode: string) => void }) {
  const { catalog, picks } = useComposerPicks(workspaceId, thread);
  if (catalog === null || picks === null || catalog.permissionModes.length === 0) return null;
  return (
    <AccessPicker
      modes={catalog.permissionModes}
      picks={picks}
      note={thread.view.running ? accessReachLine(movesRunningAccess(catalog)) : null}
      onPickAccess={onPickAccess}
      className="h-7 gap-1.5 px-2 text-sm text-muted-foreground sm:h-6 sm:text-xs [&_svg]:size-3"
    />
  );
}
