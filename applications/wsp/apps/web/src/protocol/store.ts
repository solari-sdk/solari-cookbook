// SPDX-License-Identifier: AGPL-3.0-only
// Zustand store fed by one ProtocolClient + typed React hooks: the stable
// contract components code against.
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { applyPreferencesPatch, threadsFollowed, type AbsentComputer, type BringBackResult, foldThreads, goldenHead, threadKeyOf, workspaceStateOf, type AppAddress, type Capabilities, copyBuildOf, type GoldenStageEvent, type HarnessCatalog, type InitJob, type InitSetup, type PlaceView, type PortForward, type ProjectView, type Preferences, type PreferencesPatch, type ReleaseView, type SessionView, type ThreadView, type WorkspaceCreateStage, type WorkspaceLook, type WorkspacePhase, type WorkspaceProject, type WorkspaceSize, type WorkspaceState, type WorkspaceStatus, type WorkspaceView, type PlaceDial, type WorkspaceLanding } from "@wsp/protocol";
import { noSuchThreadLine, renameNotTakenLine } from "../actions/format.js";
import { readAddress, readProjectHome, writeAddress, writeProjectHome } from "./address.js";
import { deriveSidebarProjects, sidebarWorkspaceOrder } from "../adapt/workspaces.js";
import type { Launch, SidebarProjectSnapshot } from "../adapt/view-model.js";
import { DisconnectedError, RequestError, type Api, type ConnStatus, type ProtocolEvent } from "./client.js";
import { failureOf, type Failure } from "./failure.js";
import { addNotice, noticeFailure } from "../notices/store.js";
import { lastWorkspaceId, rememberWorkspace } from "./lastWorkspace.js";
import { clearLegacyPreferences, legacyPreferences } from "./legacyPreferences.js";
import { bootPreferences, rememberFirstPaint } from "./firstPaint.js";
import { applyAddStage, takeAdds } from "../settings/adds.js";
import { WHERE_WORDS } from "../settings/format.js";
import { absenceOf, placeName, placeNamed } from "../settings/places.js";
import { sameAt, useSettingsStore, type SettingsAt } from "../settings/settingsStore.js";
import { imageBuildFrame } from "../shell/creationLog.js";
import { requestNewThread } from "../shell/shellRequests.js";
import { useSignInStore } from "../shell/signInStore.js";

export interface CostTick {
  rateUsdPerHour: number;
  accruedUsd: number;
  at: string;
}

/** One line of a create's stage log, stamped with the wall clock when it arrived here. A line the image build put
 * there carries `image` rather than one of the create's own stages: the two streams share the log. */
export interface CreationLine {
  readonly stage: WorkspaceCreateStage | "image";
  readonly message: string;
  readonly at: string;
  readonly elapsedMs: number;
  readonly notice?: string;
  /** What the machine answered this step with, for the line's title; never drawn as a sentence. */
  readonly detail?: string;
}

/** A workspace being created: the sidebar row and the center view read it until workspace.created replaces it. */
export interface Creation {
  /** What select() takes for it; stable from the click through the runtime's first stage event. */
  readonly key: string;
  readonly name: string;
  /** When this row was made here, in wall-clock ms. A line the create's own stages carry their elapsed on needs
   * nothing from it; a line this app stamps itself (the image build's) measures from here, since the build runs
   * before the runtime's own clock on this create starts. */
  readonly askedAt: number;
  /** The project this work is on, by its id: what the create was asked with, and what a retry asks again. Absent on
   * a row another client started, whose creating frames name the workspace and not the project it came from. */
  readonly project?: string;
  /** The snapshot the create forks, when it is not the image's head: a project image's. */
  readonly golden?: string;
  /** The size the person picked; absent, the golden's. */
  readonly size?: WorkspaceSize;
  /** The computer the work lands on, which is the project's own, by the id its row carries. The image build's own
   * frames name their place, so this is what says which are this create's. */
  readonly where?: string;
  /** The id the runtime minted, known from its first stage event. */
  readonly workspaceId: string | null;
  readonly lines: ReadonlyArray<CreationLine>;
  /** Set once the create was refused; the lines keep the failing one. */
  readonly failed: CreateRefusal | null;
}

export interface CreateRefusal {
  readonly title: string;
  readonly detail: string;
}

export function explainCreateRefusal(error: unknown): CreateRefusal {
  const message = error instanceof Error ? error.message : String(error);
  // The runtime names the machines holding the slots and the move that frees one; a second wording here would say less.
  if (error instanceof RequestError && error.kind === "concurrency") {
    return { title: "The provider refused: no more tasks can run there now", detail: message };
  }
  if (error instanceof DisconnectedError) {
    return { title: "Not connected to the runtime", detail: message };
  }
  return { title: "Could not create the task", detail: message };
}

interface State {
  api: Api | null;
  /** The runtime socket as the client reports it; the shell's banner reads this. */
  conn: ConnStatus;
  /** Backend feature flags; null until the first reply. Gate upgrade/resize on these. */
  capabilities: Capabilities | null;
  /** Whether a golden with a head is sealed; null until the first reply. The sidebar's cloud row shows while it is false. */
  hasGolden: boolean | null;
  /** The init job on the host as its last event or the first reply left it; null while none has run. The cloud row
   * reads its progress while the modal is shut, and the modal opens where it stands. */
  initJob: InitJob | null;
  /** The last golden.stage frames of the copy built at each place, by the place id the frames carry, the newest
   * last: only the build running there or the one that last ended, since a frame after a sealed or failed one starts
   * the place over. Cleared on every pull, since a host that restarted mid-build holds no build to end it. */
  goldenFrames: Record<string, GoldenStageEvent[]>;
  /** What each harness's CLI takes at launch, from the runtime's table; empty until it answers, and the composer shows no pickers. */
  harnesses: HarnessCatalog[];
  /** The same, as the binaries on a workspace's machine reported them; set once loadHarnesses got an answer for it. */
  harnessesByWorkspace: Record<string, HarnessCatalog[]>;
  workspaces: WorkspaceView[];
  statuses: Record<string, WorkspaceStatus>;
  costs: Record<string, CostTick>;
  /** Live session count per workspace; > 0 renders the spend-pulse. */
  spending: Record<string, number>;
  /** Guest ports the host forwards to localhost here, from the host's list and its forward events. */
  forwards: PortForward[];
  /** Every computer this wsp runs on, as the Settings table shows them; the four place events keep it current. */
  places: PlaceView[];
  /** Every project this wsp holds, which is what a workspace is made of; the two project events keep it current. */
  projects: ProjectView[];
  /** What the last bring back on a workspace answered, by its id: the branch it pushed and the pull request it
   * opened, which the row's third line reads until another one lands. Nothing is kept for a workspace nobody has
   * brought work back from. */
  broughtBack: Record<string, BringBackResult>;
  /** Where a workspace of each project would land, by the project's id: asked once per project, and the one home of
   * the flags a row's words about its copy's ports and its state word are read off. A key with null under it is a
   * project the runtime refused a landing for, which is what keeps that refusal from being asked again on every
   * render; its rows say what their records carry and nothing more. */
  landings: Record<string, WorkspaceLanding | null>;
  /** Whether the host has answered about that list yet. An empty list is an answer and a list not asked for yet is
   * not: what draws only while this computer is the only row would otherwise draw on every load and go again. */
  placesRead: boolean;
  /** The same for the projects: the first run is the whole centre while this wsp holds none, and the workspaces
   * list answers first, so a host with projects and no workspace painted that screen for one round trip. */
  projectsRead: boolean;
  /** Why the host refused the place list, while it does; a list this socket may not see is not refused, only empty. */
  placesRefused: Failure | null;
  /** The same for the projects. */
  projectsRefused: Failure | null;
  /** Whether the Add a computer sheet stands open over the Settings page. */
  addComputerOpen: boolean;
  /** Whether the Connect a provider sheet stands open over the Settings page. */
  /** A workspace id, or a creation's key while that create runs. */
  selectedId: string | null;
  /** The project whose home stands in the centre while no workspace is picked: where its next task is typed. */
  projectHome: string | null;
  /** The thread of the selected workspace the centre is on, which the page's address names too; null until a pick
   * or the centre's own view has settled on one, where the workspace's latest thread shows. */
  selectedThreadId: string | null;
  /** Whether the centre is on the screen the selected workspace's next thread is written on: it has no thread of its
   * own yet, and its address says so, so a reload opens it again rather than the thread it was opened from. */
  freshThread: boolean;
  creations: Creation[];
  sessions: Record<string, SessionView[]>;
  /** The send that has opened no thread yet, per workspace. The runtime writes a session row only once the agent
   * announces itself, which on this computer is the seconds the agent takes to boot, so between the send and that
   * row the sidebar had nothing to draw while the message was already in the transcript. */
  launches: Record<string, Launch>;
  ready: boolean;
  /** How many reconnects the runtime could not replay events for; anything built from sessions.history reloads when it moves. */
  gaps: number;
  /** The person's view preferences, the host's one record; until the host answers, the defaults with what this browser
   * kept of the last record, so the first paint is the side, the width and the body the person picked. */
  preferences: Preferences;
  /** The newest release as the host last read it; null until it answers, and on a host that reads none. */
  release: ReleaseView | null;
  /** Whether the centre shows the settings page in place of the selected workspace's thread. */
  settingsOpen: boolean;
  bind(api: Api): void;
  noteGap(): void;
  /** Mirrors the client's status; live with an api bound pulls list and statuses again so a reconnect converges. */
  setConn(conn: ConnStatus): void;
  /** Also leaves the settings page: every road to a workspace lands on its thread. The pick goes into the page's
   * address, which is where the next load reads it back from. */
  select(id: string | null, threadId?: string | null): void;
  /** Opens a project's home in the centre, where a task typed and sent becomes a workspace of its own. */
  openProjectHome(projectId: string): void;
  /** Opens the screen the workspace's next thread is written on, with an address of its own, and asks the chat for
   * that workspace to clear itself: the palette, the shortcut, the row's action and the files pane take this road. */
  newThread(workspaceId: string): void;
  /** What the centre settled on with nothing picked: the thread its own view holds, whether it found it in the
   * transcript or this turn opened it. The address records it, so a reload comes back to it and a thread an agent
   * opens next cannot take the centre. Ignored once anything else is selected. */
  readingThread(workspaceId: string, threadId: string): void;
  openSettings(): void;
  closeSettings(): void;
  toggleSettings(): void;
  /** Paints the patch at once and sends it; the host's answer settles the record, a refusal is a toast and the host's record is read again. */
  setPreferences(patch: PreferencesPatch): Promise<void>;
  /** Starts a workspace for one piece of work on the project named, by the project's id, selects its row and follows
   * it through the stage events; resolves with the runtime's id for the new workspace, or null when the create was
   * refused. `picked` carries a project image or a size only where the person chose one. */
  createWorkspace(project: string, name: string, picked?: { golden?: string; size?: WorkspaceSize }): Promise<string | null>;
  /** Records a project and answers the record the host kept: a folder on this computer, or a repository address on
   * the computer named. The row arrives by the project.added event too; this is what the first run and the sheet
   * wait on. Null on a client that cannot record one. */
  addProject(source: string, on?: string): Promise<ProjectView | null>;
  /** Forgets a project; the row leaves on project.removed. A refusal (a workspace still stands on it) is a toast. */
  removeProject(projectId: string): Promise<void>;
  /** Pushes the agent's branch and opens its pull request. The answer lands under the workspace's id, where the
   * row's third line reads it; a refusal is thrown for the caller's own toast, in the daemon's own sentence. */
  bringBack(workspaceId: string): Promise<void>;
  /** Asks where a workspace of this project would land, once per project. A refusal is remembered as no landing
   * rather than asked again on every render. */
  loadLanding(project: string): Promise<void>;
  /** Runs a failed creation again under the same row. */
  retryCreation(key: string): Promise<void>;
  dismissCreation(key: string): void;
  refresh(): Promise<void>;
  /** Optimistic nap/wake: paint now, reconcile on the event, revert + toast on failure. */
  toggle(id: string): Promise<void>;
  /** The wake alone: what every Wake button calls, whatever the row says. A running workspace is left as it is. */
  wake(id: string): Promise<void>;
  /** Stops the host asking the provider again for a wake it never took; the row repaints on the runtime's own push. */
  stopWake(id: string): Promise<void>;
  /** A workspace view the runtime handed back to a caller, over the one in the rail: no event carries the image a
   * workspace forks from, so a move to a newer golden version would read stale until the next full refresh. */
  applyWorkspace(workspace: WorkspaceView): void;
  /** The project an import landed, onto the workspace it landed on: the host answers the record it has just kept, so
   * the pane lists the folder as soon as the import returns, whether or not the machine's daemon is up to say
   * anything about what is in it. */
  /** The row leaves on the host's forward.close; a refusal is a toast. */
  stopForward(workspaceId: string, port: number): Promise<void>;
  /** Opens Settings with the Add a computer sheet over it: the palette row and the table's button take one road. */
  openAddComputer(): void;
  closeAddComputer(): void;
  /** Saves keys on the host and answers with its setup after the save. A provider key makes that provider a
   * computer, so the places and the setup Settings reads are taken again here rather than at the next reload. */
  saveKeys(keys: { provider?: string; key?: string; rows?: Record<string, string> }): Promise<InitSetup>;
  /** Asks the host to dial one computer once and takes the row it answers with, so every surface reading that row
   * says the same thing about it. Answers the whole of what came back for the slot that asked. */
  dialPlace(placeId: string): Promise<PlaceDial>;
  /** Puts this wsp's daemon on one computer and runs the recipe there again, and writes the job it answers with
   * onto that row, so the word in the row's state slot is the job's own. A refusal is the host's own sentence in
   * a notice. */
  updatePlace(placeId: string): Promise<void>;
  applyEvent(e: ProtocolEvent): void;
  /** Rows come from the runtime (only it knows harness and final status); events say when to ask. */
  reloadSessions(workspaceId: string): Promise<void>;
  /** Holds a send whose thread the runtime has yet to write a row for, so every surface reading the workspace's
   * threads has the one the transcript already shows. */
  launching(workspaceId: string, launch: Launch): void;
  /** Drops it: any start or end of this workspace's own means the runtime's rows are the newer answer, and a send
   * refused before it reached the runtime drops its own by request id, so a late refusal cannot take a newer send's
   * row away. A refresh drops every one of them in the same write as the rows it answered, since that list is the
   * whole of what threads there are. */
  launched(workspaceId: string, requestId?: string): void;
  /** Names the thread's harness session through the runtime, which writes it into the harness's own store: the
   * machine comes up first, as the command line's own rename does, then the name goes, then the workspace's rows are
   * reloaded so the sidebar shows it. True once the store took the name; an answer that named nothing and a failure
   * are false and a toast, so the caller can leave the name where a person can still see it. */
  renameThread(opts: { sessionId: string; workspaceId: string; harness: string; title: string }): Promise<boolean>;
  /** Drops a thread no turn ever ran on through the runtime, then reloads the workspace's rows so the row leaves
   * the sidebar. True once the runtime dropped it; its refusal for a thread whose turn reached its agent is false
   * and a toast. */
  forgetThread(opts: { threadId: string; workspaceId: string }): Promise<boolean>;
  /** Names the workspace through the runtime, which holds the name on this computer, and puts the record it answers
   * with in place of the row. True once the runtime took the name; a refusal (a name another workspace holds, a blank
   * one) is false and a toast, so the caller can leave the name where a person can still see it. */
  renameWorkspace(opts: { workspaceId: string; name: string }): Promise<boolean>;
  /** Sets the workspace's hue or its glyph through the runtime, which holds them beside the record, and puts what it
   * answers with on the row. A key left out keeps that fact as it is and null clears it. False on a client without
   * the verb or a refusal, which lands in the toast. */
  setWorkspaceLook(opts: { workspaceId: string; look: WorkspaceLook }): Promise<boolean>;
  /** Asks the runtime for the catalogs as the workspace's machine reports them; a refusal leaves the table's in place. */
  loadHarnesses(workspaceId: string): Promise<void>;
}

/** Where a refused places list is drawn: while that page is on screen, the refusal says itself there. */
const COMPUTERS_PAGE: SettingsAt = { kind: "group", group: "computers" };
const NO_SESSIONS: SessionView[] = [];

function groupSessions(rows: SessionView[]): Record<string, SessionView[]> {
  const out: Record<string, SessionView[]> = {};
  for (const r of rows) (out[r.workspaceId] ??= []).push(r);
  return out;
}

const NO_LINES: CreationLine[] = [];

/** The workspace the page's address opens on, when the list still has it: wsp init writes it after its first fork.
 * An id that is gone falls through to the first row, as an address with no workspace in it does. */
function addressed(address: AppAddress | undefined, workspaces: readonly WorkspaceView[]): string | undefined {
  return address !== undefined && workspaces.some(w => w.id === address.workspaceId) ? address.workspaceId : undefined;
}

/** What the centre opens on after a refresh, the address being the one record of it: the thread it names while the
 * rows still carry it, else the pick standing, which every road wrote the address with. A thread the rows do not
 * carry opens the workspace and says so. The screen a next thread is written on keeps its own address and no thread. */
function openThreadOf(
  address: AppAddress | undefined,
  workspaceId: string | null,
  pinned: string | null,
  rows: readonly SessionView[],
): { threadId: string | null; fresh: boolean; toast?: string } {
  const own = address?.workspaceId === workspaceId ? address : undefined;
  if (own?.fresh === true) return { threadId: null, fresh: true };
  if (own?.threadId === undefined) return { threadId: pinned, fresh: false };
  if (rows.some(r => r.workspaceId === workspaceId && r.threadId === own.threadId)) return { threadId: own.threadId, fresh: false };
  // A session list is best-effort: the one a refused call leaves behind carries no rows at all, and reading that as
  // the thread being gone would move the person off the pick they are holding and write the loss into the address.
  // Only a list that answered can say a thread is not there, which is what a pick nobody is holding meets.
  if (pinned === own.threadId) return { threadId: pinned, fresh: false };
  return { threadId: null, fresh: false, toast: noSuchThreadLine() };
}

/** The workspace the person had open last, when the list still has it. */
function remembered(workspaces: readonly WorkspaceView[]): string | undefined {
  const id = lastWorkspaceId();
  return id !== undefined && workspaces.some(w => w.id === id) ? id : undefined;
}

/** The sidebar's top row: the one fallback for a selection with nothing to go on. */
function firstRow(s: Pick<State, "workspaces" | "statuses" | "sessions">): string | null {
  return sidebarWorkspaceOrder(s)[0] ?? null;
}

let creationSeq = 0;
/** Sets on their way to the host. While one is, a reply or a preferences.changed for an earlier set would paint an
 * older record over the one the person sees; the last reply, or the record read after a refusal, settles it. */
let preferenceSetsInFlight = 0;
/** Every init.job view taken so far. The setup snapshot read on a connect is a view of the moment it was asked
 * for, so a job started or ended between the ask and the reply would be painted over by the older one; a snapshot
 * that raced a view is dropped and the view stands. Dropping it loses nothing because the reply and the events
 * travel one ordered socket and the host emits on every change, so the last event before a reply carries the state
 * that reply was computed from or newer. The day they travel separate channels this needs a stamp instead. */
let initJobViews = 0;

/** How many of one place's build frames are kept: every stage of a build and the tail of its install steps. */
export const GOLDEN_FRAMES_KEPT = 64;

export const useStore = create<State>((set, get) => {
  const patchCreation = (key: string, patch: (c: Creation) => Creation): void => {
    set(s => ({ creations: s.creations.map(c => (c.key === key ? patch(c) : c)) }));
  };
  /** The row leaves with its workspace in place of it; the selection follows. */
  const finishCreation = (key: string, workspaceId: string): void => {
    const opened = get().selectedId === key;
    set(s => ({
      creations: s.creations.filter(c => c.key !== key),
      selectedId: opened ? workspaceId : s.selectedId,
    }));
    if (opened) writeAddress({ workspaceId });
  };
  const runCreation = async (key: string, project: string, name: string, picked?: { golden?: string; size?: WorkspaceSize }): Promise<string | null> => {
    const api = get().api;
    if (!api) return null;
    try {
      const { notice, ...workspace } = await api.createWorkspace(project, name, picked);
      if (notice !== undefined) addNotice({ kind: "note", text: notice, where: name });
      // The created event normally lands first; when the reply beats it, the row still has a workspace to become.
      set(s => (s.workspaces.some(w => w.id === workspace.id) ? {} : { workspaces: [...s.workspaces, workspace].sort((a, b) => a.id.localeCompare(b.id)) }));
      finishCreation(key, workspace.id);
      return workspace.id;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchCreation(key, c => ({
        ...c,
        failed: explainCreateRefusal(e),
        lines: c.lines.at(-1)?.stage === "failed" ? c.lines : [...c.lines, { stage: "failed", message, at: new Date().toISOString(), elapsedMs: c.lines.at(-1)?.elapsedMs ?? 0 }],
      }));
      return null;
    }
  };

  // wake-via-resurrect and upgrade replace the machine, so those events carry a new machineId; gone carries the
  // words, and any other phase drops the ones the view was holding, since a record that left gone has none to show
  const setPhase = (id: string, phase: WorkspacePhase, machineId?: string, gone?: string): void => {
    const words = phase !== "gone" ? { gone: undefined } : gone !== undefined ? { gone } : {};
    const patch = { phase, ...(machineId !== undefined ? { machineId } : {}), ...words };
    set(s => ({
      workspaces: s.workspaces.map(w => (w.id === id ? { ...w, ...patch } : w)),
      statuses: s.statuses[id] ? { ...s.statuses, [id]: { ...s.statuses[id]!, ...patch } } : s.statuses,
    }));
  };

  // The optimistic phase paints at once; the runtime's own pushes (pausing, napping, waking, running) reconcile it.
  const move = async (id: string, to: "pausing" | "waking"): Promise<void> => {
    const api = get().api;
    const w = get().workspaces.find(x => x.id === id);
    if (!api || !w) return;
    setPhase(id, to);
    try {
      await (to === "pausing" ? api.nap(id) : api.wake(id));
    } catch (e) {
      setPhase(id, w.phase);
      noticeFailure(e, said => `${w.name} was not ${to === "pausing" ? "paused" : "woken"}: ${said}`);
    }
  };

  /** What a refused list reads as: undefined for a lost socket, which the banner says and the next pull asks again;
   * null for a socket that may not see it, an empty list that says nothing; else the fault, said once as a notice.
   * Either answer clears the rows, as a refused forwards read does: rows read before it are not today's list. */
  /** A refused list, said as a notice unless the page it is drawn on is the one on screen. */
  const listRefusal = (e: unknown, what: string, home?: SettingsAt): Failure | null | undefined => {
    const failure = failureOf(e);
    if (failure.disconnected) return undefined;
    if (failure.kind === "ticket") return null;
    if (home === undefined || !get().settingsOpen || !sameAt(useSettingsStore.getState().at, home)) noticeFailure(e, said => `${what} not read: ${said}`);
    return failure;
  };

  /** Said once per bind: a host that refuses them refuses every time they are asked. */
  let capabilitiesSaid = false;
  /** The workspaces whose refused thread list has been said since the bind. */
  const sessionsSaid = new Set<string>();
  const readCapabilities = (api: Api): void => {
    void api
      .capabilities()
      .then(capabilities => set({ capabilities }))
      .catch((e: unknown) => {
        if (capabilitiesSaid || failureOf(e).disconnected) return;
        capabilitiesSaid = true;
        noticeFailure(e, said => `What the host can do was not read: ${said}`);
      });
  };

  const readPlaces = (api: Api): void => {
    // An answer either way settles it, and a host whose wire carries no place list settles it at once: nothing
    // waits on a reply that is never coming.
    const placesAsked = api.placesList?.();
    if (placesAsked === undefined) set({ placesRead: true });
    else {
      takeAdds(api, placesAsked.then(read => read.adds));
      void placesAsked.then(
        ({ places }) => set({ places, placesRead: true, placesRefused: null }),
        (e: unknown) => {
          const refused = listRefusal(e, "Computers", COMPUTERS_PAGE);
          if (refused !== undefined) set({ places: [], placesRead: true, placesRefused: refused });
        },
      );
    }
    // The landings go with it: a host that has gained a computer or an image since answers differently now.
    set({ landings: {} });
  };
  // What bind fetches and a reconnect fetches again: the list plus the status snapshot that also arms status.subscribe.
  const pull = (api: Api): void => {
    void get().refresh().catch((e: unknown) => noticeFailure(e, said => `Workspaces not read: ${said}`));
    void api
      .watchStatuses()
      .then(statuses => set({ statuses: Object.fromEntries(statuses.map(s => [s.id, s])) }))
      .catch((e: unknown) => noticeFailure(e, said => `Live status is not coming from the host: ${said}`));
    // A refused list clears the rows: a forward that closed while the socket was down must not stay listed.
    void api
      .listForwards?.()
      .then(forwards => set({ forwards }))
      .catch((e: unknown) => {
        set({ forwards: [] });
        noticeFailure(e, said => `Forwards not read: ${said}`);
      });
    set({ goldenFrames: {} });
    const initJobsAtAsk = initJobViews;
    void api
      .initGet?.()
      .then(setup => {
        if (initJobViews !== initJobsAtAsk) return;
        set({ initJob: setup.job });
      })
      .catch((e: unknown) => {
        if (failureOf(e).kind !== "ticket") noticeFailure(e, said => `Setup not read: ${said}`);
      });
    readPlaces(api);
    // An answer either way settles it, and a host whose wire carries no projects list settles it at once.
    const projectsAsked = api.projectsList?.();
    if (projectsAsked === undefined) set({ projectsRead: true });
    else
      void projectsAsked.then(
        projects => set({ projects, projectsRead: true, projectsRefused: null }),
        (e: unknown) => {
          const refused = listRefusal(e, "Projects");
          if (refused !== undefined) set({ projects: [], projectsRead: true, projectsRefused: refused });
        },
      );
    void api
      .preferences?.()
      .then(preferences => {
        if (preferenceSetsInFlight === 0) set({ preferences });
        // What this browser kept before the record existed goes onto the record once, then the old keys go.
        const legacy = legacyPreferences(window.localStorage);
        if (legacy !== null) void get().setPreferences(legacy).then(() => clearLegacyPreferences(window.localStorage));
      })
      .catch((e: unknown) => noticeFailure(e, said => `Preferences not read: ${said}`));
    // release.changed is never replayed, so a reconnect reads the whole view again.
    void api
      .releaseGet?.()
      .then(release => set({ release }))
      .catch(() => {});
  };

  return {
    api: null,
    conn: "connecting",
    capabilities: null,
    hasGolden: null,
    initJob: null,
    goldenFrames: {},
    harnesses: [],
    harnessesByWorkspace: {},
    workspaces: [],
    statuses: {},
    costs: {},
    spending: {},
    forwards: [],
    places: [],
    projects: [],
    broughtBack: {},
    landings: {},
    projectsRead: false,
    placesRead: false,
    placesRefused: null,
    projectsRefused: null,
    addComputerOpen: false,
    selectedId: null,
    projectHome: readProjectHome(),
    selectedThreadId: null,
    freshThread: false,
    creations: [],
    sessions: {},
    launches: {},
    ready: false,
    gaps: 0,
    preferences: bootPreferences(),
    release: null,
    settingsOpen: false,
    noteGap() { set(s => ({ gaps: s.gaps + 1 })); },
    bind(api) {
      set({ api });
      capabilitiesSaid = false;
      sessionsSaid.clear();
      api.subscribe(e => get().applyEvent(e));
      readCapabilities(api);
      // A failed lookup reads as sealed: the row is a door, not a gate, and the create's own error says the rest.
      void api
        .getGolden()
        .then(m => set({ hasGolden: goldenHead(m) !== undefined }))
        .catch(() => set({ hasGolden: true }));
      void api
        .listHarnesses?.()
        .then(harnesses => set({ harnesses }))
        .catch((e: unknown) => noticeFailure(e, said => `Agents not read: ${said}`));
      pull(api);
    },
    setConn(conn) {
      set({ conn });
      const api = get().api;
      if (conn === "live" && api) pull(api);
    },
    select(id, threadId = null) {
      set({ selectedId: id, selectedThreadId: threadId, freshThread: false, settingsOpen: false, projectHome: null });
      writeAddress(id === null || get().creations.some(c => c.key === id) ? null : { workspaceId: id, ...(threadId === null ? {} : { threadId }) });
    },
    openProjectHome(projectId) {
      set({ selectedId: null, selectedThreadId: null, freshThread: false, settingsOpen: false, projectHome: projectId });
      writeProjectHome(projectId);
    },
    newThread(workspaceId) {
      set({ selectedId: workspaceId, selectedThreadId: null, freshThread: true, settingsOpen: false, projectHome: null });
      writeAddress({ workspaceId, fresh: true });
      requestNewThread({ workspaceId });
    },
    readingThread(workspaceId, threadId) {
      const s = get();
      if (s.selectedId !== workspaceId || s.selectedThreadId !== null) return;
      set({ selectedThreadId: threadId, freshThread: false });
      writeAddress({ workspaceId, threadId });
    },
    openSettings() { set({ settingsOpen: true }); },
    closeSettings() { set({ settingsOpen: false, addComputerOpen: false }); },
    toggleSettings() { set(s => ({ settingsOpen: !s.settingsOpen, addComputerOpen: s.settingsOpen ? false : s.addComputerOpen })); },
    async setPreferences(patch) {
      const api = get().api;
      set(s => ({ preferences: applyPreferencesPatch(s.preferences, patch) }));
      if (!api?.setPreferences) return;
      preferenceSetsInFlight++;
      try {
        const { notice, ...preferences } = await api.setPreferences(patch);
        if (--preferenceSetsInFlight === 0) set({ preferences });
        if (notice !== undefined) addNotice({ kind: "error", text: notice });
      } catch (e) {
        preferenceSetsInFlight--;
        if (e instanceof DisconnectedError) return;
        noticeFailure(e, said => `That setting was not saved: ${said.replace(/\.$/, "")}. It shows the host's value again.`);
        if (preferenceSetsInFlight === 0) void api.preferences?.().then(preferences => set({ preferences })).catch(() => {});
      }
    },
    async createWorkspace(project, name, picked) {
      // The computer is the project's own, so the row that waits on an image build is keyed by it and nothing asks
      // the person where the work goes. Nothing is refused here: a project on this computer forks nothing, and a
      // project on a computer with no image is refused by the runtime in its own sentence on the creation view.
      const computer = get().projects.find(p => p.id === project)?.computer;
      if (!get().api) return null;
      const key = `creating:${++creationSeq}`;
      set(s => ({
        creations: [
          ...s.creations,
          { key, name, project, askedAt: Date.now(), ...(picked?.golden !== undefined ? { golden: picked.golden } : {}), ...(picked?.size !== undefined ? { size: picked.size } : {}), ...(computer !== undefined ? { where: computer } : {}), workspaceId: null, lines: NO_LINES, failed: null },
        ],
        selectedId: key,
        selectedThreadId: null,
      }));
      return runCreation(key, project, name, picked);
    },
    async addProject(source, on) {
      const api = get().api;
      if (api?.projectsAdd === undefined) return null;
      const project = await api.projectsAdd(source, on);
      // The event carries the same record; taking it here too means the caller's next read holds it whichever
      // arrived first, and the create that follows a first run has a project to be made of.
      set(s => ({ projects: [...s.projects.filter(p => p.id !== project.id), project] }));
      get().openProjectHome(project.id);
      return project;
    },
    async bringBack(workspaceId) {
      const api = get().api;
      if (api?.bringBack === undefined) return;
      const back = await api.bringBack(workspaceId);
      set(s => ({ broughtBack: { ...s.broughtBack, [workspaceId]: back } }));
    },
    async removeProject(projectId) {
      const api = get().api;
      if (api?.projectsRemove === undefined) return;
      try {
        await api.projectsRemove(projectId);
      } catch (e) {
        noticeFailure(e);
      }
    },
    async loadLanding(project) {
      const api = get().api;
      if (api?.workspacesLanding === undefined || project in get().landings) return;
      // The mark goes down before the ask, so a project drawn in three rows is asked about once.
      set(s => ({ landings: { ...s.landings, [project]: null } }));
      try {
        const landing = await api.workspacesLanding(project);
        set(s => ({ landings: { ...s.landings, [project]: landing } }));
      } catch {
        // A computer that forks nothing has no landing to give; the rows say what their records carry.
      }
    },
    async retryCreation(key) {
      const creation = get().creations.find(c => c.key === key);
      // A row another client started carries no project, so there is nothing here to ask again.
      if (!creation || creation.project === undefined) return;
      patchCreation(key, c => ({ ...c, workspaceId: null, lines: NO_LINES, failed: null }));
      await runCreation(key, creation.project, creation.name, { ...(creation.golden !== undefined ? { golden: creation.golden } : {}), ...(creation.size !== undefined ? { size: creation.size } : {}) });
    },
    dismissCreation(key) {
      set(s => {
        const project = s.creations.find(c => c.key === key)?.project;
        // The next row is one of the same project's, never the sidebar's first, which may be another project's.
        const sibling = project === undefined ? undefined : sidebarWorkspaceOrder(s).find(id => s.workspaces.find(w => w.id === id)?.project.id === project);
        return { creations: s.creations.filter(c => c.key !== key), selectedId: s.selectedId === key ? (sibling ?? null) : s.selectedId };
      });
    },
    async refresh() {
      const api = get().api;
      if (!api) return;
      const [workspaces, answered] = await Promise.all([api.listWorkspaces(), api.listSessions().then(rows => rows, () => null)]);
      const s = get();
      const rows = answered ?? NO_SESSIONS;
      const sessions = groupSessions(rows);
      // The address is read on every refresh, not only the first: a reconnect after the host restarted rebuilds this
      // store from nothing, and what the person is reading is recorded there rather than here.
      const address = readAddress();
      // A project's home stands in the centre with nothing picked on purpose; a refresh fills the gap only when no home does.
      const selectedId = s.selectedId ?? (s.projectHome !== null ? null : (addressed(address, workspaces) ?? remembered(workspaces) ?? firstRow({ workspaces, statuses: s.statuses, sessions })));
      const open = openThreadOf(address, selectedId, s.selectedThreadId, rows);
      set({
        workspaces,
        sessions,
        ready: true,
        selectedId,
        selectedThreadId: open.threadId,
        freshThread: open.fresh,
        // A list the runtime answered is the whole of what threads there are: a send it has since written a row for
        // is that row now, and one it has not is a turn that died while this client was away, so neither may keep a
        // row of its own. A list it refused says nothing, and the sends in flight stand until a start or an end.
        ...(answered === null ? {} : { launches: {} }),
      });
      if (open.toast !== undefined) addNotice({ kind: "error", text: open.toast });
      if (selectedId === null || !workspaces.some(w => w.id === selectedId)) return;
      // The chat for the workspace clears itself when it takes this, whether it is mounted yet or not.
      if (open.fresh && !s.freshThread) requestNewThread({ workspaceId: selectedId });
      writeAddress({ workspaceId: selectedId, ...(open.threadId === null ? {} : { threadId: open.threadId }), ...(open.fresh ? { fresh: true } : {}) });
    },
    async reloadSessions(workspaceId) {
      const api = get().api;
      if (!api) return;
      try {
        const rows = await api.listSessions(workspaceId);
        set(s => ({ sessions: { ...s.sessions, [workspaceId]: rows } }));
      } catch (e) {
        // Said once per workspace for a refusal; anything else, the next session event asks again.
        if (e instanceof RequestError && !sessionsSaid.has(workspaceId)) {
          sessionsSaid.add(workspaceId);
          noticeFailure(e, said => `Threads not read: ${said}`, { where: get().workspaces.find(w => w.id === workspaceId)?.name ?? workspaceId });
        }
      }
    },
    launching(workspaceId, launch) {
      set(s => ({ launches: { ...s.launches, [workspaceId]: launch } }));
    },
    launched(workspaceId, requestId) {
      set(s => {
        const held = s.launches[workspaceId];
        if (held === undefined || (requestId !== undefined && held.requestId !== requestId)) return {};
        const { [workspaceId]: _gone, ...rest } = s.launches;
        return { launches: rest };
      });
    },
    async renameThread({ sessionId, workspaceId, harness, title }) {
      const api = get().api;
      if (!api?.renameSession) return false;
      try {
        // The store the name goes into is on the machine, so a napping one is woken first and its reply repaints the
        // row; every client that can rename can wake, since wake is not an optional verb.
        const workspace = get().workspaces.find(w => w.id === workspaceId);
        if (workspace !== undefined && workspace.phase !== "running") get().applyWorkspace(await api.wake(workspaceId));
        const { outcome, error } = await api.renameSession(sessionId, title);
        if (outcome !== "renamed") {
          addNotice({ kind: "error", text: renameNotTakenLine(harness, outcome, error) });
          return false;
        }
        await get().reloadSessions(workspaceId);
        return true;
      } catch (e: unknown) {
        noticeFailure(e, said => `${title}: ${said}`);
        return false;
      }
    },
    async forgetThread({ threadId, workspaceId }) {
      const api = get().api;
      if (!api?.forgetThread) return false;
      try {
        await api.forgetThread(threadId);
        await get().reloadSessions(workspaceId);
        return true;
      } catch (e: unknown) {
        noticeFailure(e);
        return false;
      }
    },
    async renameWorkspace({ workspaceId, name }) {
      const api = get().api;
      if (!api?.renameWorkspace) return false;
      try {
        get().applyWorkspace(await api.renameWorkspace(workspaceId, name));
        return true;
      } catch (e: unknown) {
        noticeFailure(e);
        return false;
      }
    },
    async setWorkspaceLook({ workspaceId, look }) {
      const api = get().api;
      if (!api?.setWorkspaceLook) return false;
      try {
        const workspace = await api.setWorkspaceLook(workspaceId, look);
        // The record answers with the whole look, and a cleared fact is absent from it, so the row takes it the way
        // the event does rather than through a merge, which cannot unset a key.
        get().applyEvent({ type: "workspace.look", workspaceId, theme: workspace.theme ?? null, glyph: workspace.glyph ?? null });
        return true;
      } catch (e: unknown) {
        noticeFailure(e);
        return false;
      }
    },
    async loadHarnesses(workspaceId) {
      const api = get().api;
      if (!api?.listHarnesses) return;
      try {
        const harnesses = await api.listHarnesses(workspaceId);
        set(s => ({ harnessesByWorkspace: { ...s.harnessesByWorkspace, [workspaceId]: harnesses } }));
      } catch {
        // the table's catalogs stand
      }
    },
    async toggle(id) {
      const w = get().workspaces.find(x => x.id === id);
      if (!w) return;
      // A workspace already waking is one the host may be asking the provider again for; the one slot stops that.
      if (w.phase === "waking") await get().stopWake(id);
      else if (w.phase === "running") await move(id, "pausing");
      else await get().wake(id);
    },
    async wake(id) {
      const w = get().workspaces.find(x => x.id === id);
      if (!w || w.phase === "running") return;
      await move(id, "waking");
    },
    async stopWake(id) {
      const api = get().api;
      if (!api?.stopWake) return;
      try {
        get().applyWorkspace(await api.stopWake(id));
      } catch (e) {
        noticeFailure(e);
      }
    },
    async stopForward(workspaceId, port) {
      const api = get().api;
      if (!api?.stopForward) return;
      try {
        await api.stopForward(workspaceId, port);
      } catch (e) {
        noticeFailure(e, said => `localhost:${port}: ${said}`);
      }
    },
    openAddComputer() { set({ settingsOpen: true, addComputerOpen: true }); },
    closeAddComputer() { set({ addComputerOpen: false }); },
    async saveKeys(keys) {
      const api = get().api;
      if (api?.initKeys === undefined) throw new Error(WHERE_WORDS.cannotSaveKey);
      const setup = await api.initKeys(keys);
      useSettingsStore.getState().setReads({ setup });
      readPlaces(api);
      return setup;
    },
    async dialPlace(placeId) {
      const api = get().api;
      if (api?.dialPlace === undefined) throw new Error(WHERE_WORDS.cannotDial);
      const answer = await api.dialPlace(placeId);
      set(s => ({ places: s.places.map(p => (p.id === answer.place.id ? answer.place : p)) }));
      return answer;
    },
    async updatePlace(placeId) {
      const api = get().api;
      if (api?.placesUpdate === undefined) return;
      try {
        const answer = await api.placesUpdate(placeId);
        // The job as the reply carries it, onto the row the word is read off: the state slot says what is being
        // put on that computer and then what stands, with no second reading of the same job here.
        if (answer.provision !== undefined) set(s => ({ places: s.places.map(p => (p.id === placeId ? { ...p, provision: answer.provision } : p)) }));
        if (answer.said !== undefined) addNotice({ kind: "note", text: answer.said });
      } catch (e) {
        noticeFailure(e);
      }
    },
    applyWorkspace(workspace) {
      set(s => ({
        workspaces: s.workspaces.map(w => (w.id === workspace.id ? { ...w, ...workspace } : w)),
        statuses: s.statuses[workspace.id] ? { ...s.statuses, [workspace.id]: { ...s.statuses[workspace.id]!, ...workspace } } : s.statuses,
      }));
    },
    applyEvent(e) {
      switch (e.type) {
        case "workspace.renamed":
          // The record alone changed: the row and its status take the name, and nothing about the machine moves.
          set(s => ({
            workspaces: s.workspaces.map(w => (w.id === e.workspaceId ? { ...w, name: e.name } : w)),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: { ...s.statuses[e.workspaceId]!, name: e.name } } : s.statuses,
          }));
          return;
        case "workspace.look": {
          // Both facts travel whole, so a cleared one leaves the record rather than lingering under a merge.
          const put = <T extends WorkspaceView>(w: T): T => {
            const { theme: _theme, glyph: _glyph, ...rest } = w;
            return { ...rest, ...(e.theme !== null ? { theme: e.theme } : {}), ...(e.glyph !== null ? { glyph: e.glyph } : {}) } as T;
          };
          set(s => ({
            workspaces: s.workspaces.map(w => (w.id === e.workspaceId ? put(w) : w)),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: put(s.statuses[e.workspaceId]!) } : s.statuses,
          }));
          return;
        }
        case "workspace.deleted":
          set(s => {
            const { [e.workspaceId]: _s, ...statuses } = s.statuses;
            const { [e.workspaceId]: _c, ...costs } = s.costs;
            const { [e.workspaceId]: _p, ...spending } = s.spending;
            const { [e.workspaceId]: _r, ...sessions } = s.sessions;
            const { [e.workspaceId]: _b, ...broughtBack } = s.broughtBack;
            return {
              workspaces: s.workspaces.filter(x => x.id !== e.workspaceId),
              statuses,
              costs,
              spending,
              sessions,
              broughtBack,
              forwards: s.forwards.filter(f => f.workspaceId !== e.workspaceId),
            };
          });
          return;
        case "place.joined":
          set(s => ({ places: [...s.places.filter(p => p.id !== e.place.id), e.place] }));
          return;
        case "place.stage":
          applyAddStage(get().api, e);
          return;
        case "place.present":
        case "place.absent":
          set(s => ({
            places: s.places.map(p => (p.id === e.placeId ? { ...p, present: e.type === "place.present", lastSeenAt: new Date().toISOString() } : p)),
          }));
          return;
        case "place.removed":
          set(s => {
            const { [e.placeId]: _gone, ...goldenFrames } = s.goldenFrames;
            return { places: s.places.filter(p => p.id !== e.placeId), goldenFrames };
          });
          return;
        case "project.added":
          set(s => ({ projects: [...s.projects.filter(p => p.id !== e.project.id), e.project] }));
          return;
        case "project.removed":
          set(s => {
            const { [e.projectId]: _gone, ...landings } = s.landings;
            return { projects: s.projects.filter(p => p.id !== e.projectId), landings };
          });
          return;
        case "forward.open":
          set(s => ({ forwards: [...s.forwards.filter(f => !(f.workspaceId === e.forward.workspaceId && f.port === e.forward.port)), e.forward] }));
          return;
        case "forward.close":
          set(s => ({ forwards: s.forwards.filter(f => !(f.workspaceId === e.workspaceId && f.port === e.port)) }));
          useSignInStore.getState().portClosed(e.workspaceId, e.port);
          return;
        case "golden.stage": {
          // Kept per place for that computer's image card, and folded into the log of a create waiting on the build
          // there, so the build's own stages read as its first lines. A frame naming no place is the image's own
          // build, which the init job owns; one naming a place nobody here is waiting on is only the card's.
          const word = e.place;
          if (word === undefined) return;
          set(s => {
            const kept = s.goldenFrames[word] ?? [];
            const last = kept.at(-1);
            const ended = last !== undefined && copyBuildOf(last)?.stopped !== false;
            const goldenFrames = { ...s.goldenFrames, [word]: [...(ended ? [] : kept), e].slice(-GOLDEN_FRAMES_KEPT) };
            // The create may have been asked by the row's name while the frames carry its id, so the row matches the two.
            const at = s.places.find(p => placeNamed(p, word));
            const own = s.creations.find(c => c.failed === null && c.where !== undefined && (c.where === word || (at !== undefined && placeNamed(at, c.where))));
            const line = own === undefined ? undefined : imageBuildFrame(e, at === undefined ? word : placeName(at));
            if (own === undefined || line === undefined) return { goldenFrames };
            const logged: CreationLine = { stage: "image", at: new Date().toISOString(), elapsedMs: Date.now() - own.askedAt, ...line };
            return { goldenFrames, creations: s.creations.map(c => (c === own ? { ...c, lines: [...c.lines, logged] } : c)) };
          });
          return;
        }
        case "workspace.creating": {
          const line: CreationLine = {
            stage: e.stage,
            message: e.message,
            at: new Date().toISOString(),
            elapsedMs: e.elapsedMs,
            ...(e.notice !== undefined ? { notice: e.notice } : {}),
            ...(e.detail !== undefined ? { detail: e.detail } : {}),
          };
          set(s => {
            // Ours is matched by the id once known, before that by the name it was asked for; another client's create shows up
            // too. Two clients creating the same name at once can swap logs until the reply lands, and workspace.created
            // settles which row is whose; the runtime's id is not known here any earlier than its first stage.
            const own = s.creations.find(c => c.workspaceId === e.workspaceId) ?? s.creations.find(c => c.workspaceId === null && c.name === e.name && c.failed === null);
            const failed = e.stage === "failed" ? { title: "Could not create the task", detail: e.message } : null;
            if (own === undefined) {
              return { creations: [...s.creations, { key: `creating:${e.workspaceId}`, name: e.name, askedAt: Date.now() - e.elapsedMs, workspaceId: e.workspaceId, lines: [line], failed }] };
            }
            return { creations: s.creations.map(c => (c === own ? { ...c, workspaceId: e.workspaceId, lines: [...c.lines, line], failed: c.failed ?? failed } : c)) };
          });
          return;
        }
        case "workspace.created":
          set(s => {
            const rest = s.workspaces.filter(x => x.id !== e.workspace.id);
            const creation = s.creations.find(c => c.workspaceId === e.workspace.id);
            return {
              workspaces: [...rest, e.workspace].sort((a, b) => a.id.localeCompare(b.id)),
              creations: s.creations.filter(c => c !== creation),
              selectedId: creation !== undefined && s.selectedId === creation.key ? e.workspace.id : s.selectedId,
            };
          });
          return;
        // napped/woken carry only ids; they are also the optimistic toggle's reconcile.
        case "workspace.napped":
          setPhase(e.workspaceId, "napping");
          return;
        case "workspace.gone":
          setPhase(e.workspaceId, "gone", undefined, e.reason);
          return;
        case "workspace.woken":
        case "workspace.upgraded":
          setPhase(e.workspaceId, "running", e.machineId);
          return;
        case "workspace.status":
          set(s => ({ statuses: { ...s.statuses, [e.status.id]: e.status } }));
          return;
        case "workspace.cost":
          set(s => ({
            costs: { ...s.costs, [e.workspaceId]: { rateUsdPerHour: e.rateUsdPerHour, accruedUsd: e.accruedUsd, at: e.at } },
          }));
          return;
        case "session.start": {
          // The next send resumes this id; the runtime persists it, the view learns it here.
          const remember = <T extends WorkspaceView>(w: T): T => (w.id === e.workspaceId ? { ...w, claudeSessionId: e.sessionId } : w);
          set(s => ({
            spending: { ...s.spending, [e.workspaceId]: (s.spending[e.workspaceId] ?? 0) + 1 },
            workspaces: s.workspaces.map(remember),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: remember(s.statuses[e.workspaceId]!) } : s.statuses,
          }));
          void get().reloadSessions(e.workspaceId).then(() => get().launched(e.workspaceId));
          // The runtime re-asks the binary at a start, so a Claude Code upgrade on the machine shows within its TTL.
          void get().loadHarnesses(e.workspaceId);
          return;
        }
        case "session.done":
          // The reply is in, but the row stays running until the process exits (session.end): a turn is not over while
          // its agent keeps working, and a send that met a done-but-running row would be one the runtime refuses.
          return;
        case "session.end":
          set(s => ({ spending: { ...s.spending, [e.workspaceId]: Math.max(0, (s.spending[e.workspaceId] ?? 0) - 1) } }));
          // An end without a start of its own is a harness that died before it announced itself: the send it stood
          // for has no row coming, so the row it was drawn as goes with it.
          void get().reloadSessions(e.workspaceId).then(() => get().launched(e.workspaceId));
          return;
        case "session.permission":
        case "session.permission.closed":
          // The row the sidebar reads carries what the thread is waiting on, so a prompt opening or closing is a row
          // that changed: every workspace's rows are read here, not only the open thread's. Every workspace and not
          // only this one, since a thread waiting behind this one carries the same question and may run anywhere.
          for (const id of Object.keys(get().sessions)) void get().reloadSessions(id);
          return;
        case "session.delta": {
          // A call that follows another thread to the end of its turn is what puts a thread behind a question it
          // never asked, so the row moves when such a call opens, with no prompt of its own in sight. A call
          // answering moves it back, but only where a row here is already behind something: every other turn writes
          // hundreds of results that change no row at all.
          const opens = e.kind === "tool_use" && e.toolName !== undefined && threadsFollowed({ toolName: e.toolName, input: e.text }) !== undefined;
          const closes = e.kind === "tool_result" && (get().sessions[e.workspaceId] ?? []).some(row => row.waitingOn !== undefined);
          if (opens || closes) void get().reloadSessions(e.workspaceId);
          return;
        }
        case "preferences.changed":
          if (preferenceSetsInFlight === 0) set({ preferences: e.preferences });
          return;
        case "release.changed":
          set({ release: e.release });
          return;
        case "init.job": {
          initJobViews++;
          set({ initJob: e.job });
          // A seal is what the cloud row waits on, and the provider the host wired in is what the sizes come from.
          if (e.job.phase === "done") {
            set({ hasGolden: true });
            const api = get().api;
            if (api !== null) readCapabilities(api);
          }
          return;
        }
        default:
          return;
      }
    },
  };
});

// Every road to a workspace (a click, a chord, a finished creation, the boot fallback) lands here; a creation row is not a workspace yet.
useStore.subscribe((s, prev) => {
  if (s.selectedId !== prev.selectedId && s.selectedId !== null && s.workspaces.some(w => w.id === s.selectedId)) rememberWorkspace(s.selectedId);
});
// Every change to the record, the host's or a pick painted ahead of it, is what the next load paints first.
useStore.subscribe((s, prev) => {
  if (s.preferences !== prev.preferences) rememberFirstPaint(s.preferences);
});

/** Every workspace with its threads, as the sidebar's rows read them, for the surfaces that need the whole fleet
 * rather than one workspace: the sidebar, the palette, the rows a transcript draws for the threads it opened, and
 * the header's name for the thread that opened this one. */
export function useSidebarProjects(): SidebarProjectSnapshot[] {
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const landings = useStore(s => s.landings);
  const pauseModes = useMemo(() => Object.fromEntries(Object.entries(landings).map(([project, landing]) => [project, landing?.capabilities.pauseMode])), [landings]);
  return useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions, pauseModes }), [workspaces, statuses, sessions, pauseModes]);
}

/** Every workspace's send in flight, for the sidebar, which reads them beside the rows the runtime has written. */
export function useLaunches(): Record<string, Launch> {
  return useStore(s => s.launches);
}

export function useSelectedId(): string | null { return useStore(s => s.selectedId); }
export function useSelectedThreadId(): string | null { return useStore(s => s.selectedThreadId); }
/** The selected workspace's id, or null while a creation row is selected: no command may act on a creation's key. */
export function useSelectedWorkspaceId(): string | null {
  return useStore(s => (s.selectedId !== null && s.creations.some(c => c.key === s.selectedId) ? null : s.selectedId));
}
export function useCreation(key: string | null): Creation | null {
  return useStore(s => (key ? s.creations.find(c => c.key === key) ?? null : null));
}
export function useWorkspace(id: string | null): WorkspaceView | null {
  return useStore(s => (id ? s.workspaces.find(w => w.id === id) ?? null : null));
}
export function useStatus(id: string | null): WorkspaceStatus | null {
  return useStore(s => (id ? s.statuses[id] ?? null : null));
}
/** The one state word for a workspace as this app knows it: its status when one has arrived, and the record's phase
 * alone until then, which reads a paused or unreachable machine as running. null while neither is known, which is
 * how a surface tells a workspace it has not been given yet from one it has. */
export function useWorkspaceState(id: string | null): WorkspaceState | null {
  const workspace = useWorkspace(id);
  const status = useStatus(id);
  const view = status ?? workspace;
  return view === null ? null : workspaceStateOf(view, status);
}
/** The one state of this workspace's computer while it is not answering, null while it is. Every surface that says
 * anything about an absent computer reads it here: the sidebar row, the composer's held send
 * and the terminal pane. The clock is the caller's: a surface that ticks passes its own, so it
 * cannot date the silence differently from the row beside it, and one that shows the sentence alone passes none
 * and is handed a reading with no figure, rather than a clock read on the render path that never ticks again. */
export function useAbsentComputer(id: string | null, nowMs: number | null = null): AbsentComputer | null {
  const workspace = useWorkspace(id);
  const status = useStatus(id);
  const places = usePlaces();
  return useMemo(() => absenceOf(places, workspace, status, nowMs), [places, workspace, status, nowMs]);
}

export function useCost(id: string | null): CostTick | null {
  return useStore(s => (id ? s.costs[id] ?? null : null));
}
export function useSpending(id: string | null): boolean {
  return useStore(s => (id ? (s.spending[id] ?? 0) > 0 : false));
}
export function useReady(): boolean { return useStore(s => s.ready); }
export function usePreferences(): Preferences { return useStore(s => s.preferences); }
/** Whether this host offers the surfaces still being worked on; the record's one field, read by every surface that hides. */
export function useSettingsOpen(): boolean { return useStore(s => s.settingsOpen); }
export function useForwards(): PortForward[] { return useStore(s => s.forwards); }
/** Whether localhost:port on this computer is a page of that workspace to open: a printed link, not a sign-in callback. */
export function useForwarded(workspaceId: string | null, port: number | null): boolean {
  return useStore(s => workspaceId !== null && port !== null && s.forwards.some(f => f.workspaceId === workspaceId && f.port === port && f.kind === "url"));
}
export function useCapabilities(): Capabilities | null { return useStore(s => s.capabilities); }
export function useInitJob(): InitJob | null { return useStore(s => s.initJob); }
export function useGoldenFrames(): Record<string, GoldenStageEvent[]> { return useStore(s => s.goldenFrames); }
/** The catalogs a composer reads: the workspace's machine's once it answered, else the runtime's table. */
export function useHarnessCatalogs(workspaceId: string | null): HarnessCatalog[] {
  return useStore(s => catalogsIn(s, workspaceId));
}
export function useHarnessCatalog(harness: string, workspaceId: string | null = null): HarnessCatalog | null {
  return useStore(s => catalogIn(s, workspaceId, harness));
}

type Catalogs = Pick<State, "harnesses" | "harnessesByWorkspace">;

const withoutAccess = new WeakMap<HarnessCatalog[], HarnessCatalog[]>();

/** The host-wide lists with their access modes dropped. Which mode a thread starts at is a fact about the machine it
 * runs on, and the runtime decides it there, once, against that machine's kind: a machine the person keeps asks
 * before a tool, a throwaway fork runs every tool. The host-wide lists were read against no machine, so they answer
 * models and efforts for a workspace still waiting for its own and answer no access at all. The stripped array is
 * kept beside the one it came from, so the selector hands React the same reading every render. */
function hostWide(catalogs: HarnessCatalog[]): HarnessCatalog[] {
  const known = withoutAccess.get(catalogs);
  if (known !== undefined) return known;
  const stripped = catalogs.map(c => ({ ...c, permissionModes: [] }));
  withoutAccess.set(catalogs, stripped);
  return stripped;
}

/** The one rule for which catalogs answer for a workspace, so a surface reading many workspaces' rows and one
 * reading its own read the same thing. */
export const catalogsIn = (s: Catalogs, workspaceId: string | null): HarnessCatalog[] =>
  (workspaceId !== null ? s.harnessesByWorkspace[workspaceId] : undefined) ?? (workspaceId !== null && isProjectHomeKey(workspaceId) ? s.harnesses : hostWide(s.harnesses));

/** The key a project's home composer keeps its draft and picks under until its send makes a workspace. A home has
 * no machine of its own, so it reads the host-wide lists whole, access modes included, which is what the workspace
 * its send makes is picked from. */
const PROJECT_HOME_PREFIX = "project:";
export const projectHomeKey = (projectId: string): string => `${PROJECT_HOME_PREFIX}${projectId}`;
export const isProjectHomeKey = (key: string): boolean => key.startsWith(PROJECT_HOME_PREFIX);
export const catalogIn = (s: Catalogs, workspaceId: string | null, harness: string): HarnessCatalog | null =>
  catalogsIn(s, workspaceId).find(c => c.harness === harness) ?? null;
/** The thread the centre shows for a workspace, which is the one the address names: none while the centre is on a
 * next thread's screen or on a view that has not settled on a thread yet, so a header can never name one thread
 * while the body shows another. */
export function useOpenThread(workspaceId: string | null): ThreadView | null {
  const sessions = useStore(s => (workspaceId !== null ? s.sessions[workspaceId] : undefined) ?? NO_SESSIONS);
  const threadId = useSelectedThreadId();
  return useMemo(() => (threadId === null ? null : foldThreads(sessions).find(t => t.threadId === threadId) ?? null), [sessions, threadId]);
}
/** The workspace's most recent session row, running or not; null before its first session this runtime remembers. */
export function useLatestSession(id: string | null): SessionView | null {
  return useStore(s => (id ? s.sessions[id]?.at(-1) ?? null : null));
}

/** Every turn the runtime holds for one thread, oldest first: what that thread has already run with, which is what a
 * composer reads its pickers off, its running turn included, so a second thread running in the same workspace paints
 * neither. A view holding no thread of its own carries the workspace's id as its key, which no row carries: there the
 * workspace's latest row is the turn that view shows and resumes, which is what the rest of this hook's readings take
 * it to be, and rows from before the runtime stamped a thread on them are only reachable that way. Empty for a thread
 * with no turn yet. */
export function useThreadSessions(workspaceId: string | null, threadKey: string): ReadonlyArray<SessionView> {
  const sessions = useStore(s => (workspaceId !== null ? s.sessions[workspaceId] : undefined) ?? NO_SESSIONS);
  return useMemo(() => threadRows(sessions, workspaceId, threadKey), [sessions, threadKey, workspaceId]);
}

/** The rule under useThreadSessions, for a reader outside React that has to agree with what the centre draws. */
export function threadRows(sessions: ReadonlyArray<SessionView>, workspaceId: string | null, threadKey: string): ReadonlyArray<SessionView> {
  const own = sessions.filter(row => threadKeyOf(row) === threadKey);
  if (own.length > 0 || threadKey !== workspaceId) return own;
  const latest = sessions.at(-1);
  return latest === undefined ? NO_SESSIONS : [latest];
}

/** Subscribe a component to raw protocol events (the thread, terminal and browser surfaces use this). */
export function useProtocolEvents(fn: (e: ProtocolEvent) => void): void {
  const api = useStore(s => s.api);
  useEffect(() => (api ? api.subscribe(fn) : undefined), [api, fn]);
}
export function usePlaces(): PlaceView[] { return useStore(s => s.places); }
export function useProjects(): ProjectView[] { return useStore(s => s.projects); }
/** What the last bring back on this workspace answered, for the row that reads it; undefined until one has. */
export function useBroughtBack(workspaceId: string): BringBackResult | undefined { return useStore(s => s.broughtBack[workspaceId]); }
export function usePlacesRead(): boolean { return useStore(s => s.placesRead); }
export function useProjectsRefused(): Failure | null { return useStore(s => s.projectsRefused); }
export function useProjectsRead(): boolean { return useStore(s => s.projectsRead); }
/** Whether the first run is the whole centre: this wsp holds no project and no workspace, and the host has
 * answered about both. The centre and the header read it here, so the bar cannot title an emptiness the centre is
 * already titling, and neither paints that screen over a host whose lists are still on their way. */
export function useFirstRun(): boolean {
  return useStore(s => s.ready && s.projectsRead && s.projectsRefused === null && s.projects.length === 0 && s.workspaces.length === 0);
}
