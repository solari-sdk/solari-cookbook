import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve as resolvePathOn } from "node:path";
import { CATALOG_AGENTS, DEFAULT_AGENT, GUEST_HOME, PATH_BOUND_DIR_NAMES, TOOL_PREFIX, catalogIdOfRow, serverValuesOf, guestEnv, installEnv, installHomes, sharedOn } from "@wsp/catalog";
import {
  BUILDER_IDLE_MS,
  DAEMON_PORT,
  INLINE_EXEC_MS,
  MachineUnreachableError,
  MoveUnansweredError,
  NotFirstLifeError,
  ResumeUnansweredError,
  SnapshotFailedError,
  BUILDER_LABEL,
  CREATED_AT_LABEL,
  GOLDEN_LABEL,
  NAME_LABEL,
  OWNER_LABEL,
  SMOKE_LABEL,
  WORKSPACE_LABEL,
  WSP_LABEL,
  lostWorkspace,
  Workspace,
  buildGolden,
  destExists,
  exportFolder,
  exportPaths,
  exportPathsInto,
  goldenHead,
  imageHash,
  importImageVault,
  refuseForeignMembers,
  importInto,
  isMissing,
  NapRefusedError,
  installScript,
  INSTALL_MS,
  landBundle,
  landBytes,
  tarOf,
  parseMergeOutput,
  plural,
  recipeHash,
  agentHome,
  agentHomes,
  parseSshMachineId,
  sshDialsThisComputer,
  agentsOnMachine,
  guestAgentHomes,
  guestTmpPath,
  parseStateListing,
  projectInstalls,
  stateListing,
  killUntilGone,
  readGone,
  sightMachine,
  type Sighting,
  GoneWatch,
  snapshotUntilGone,
  MachineAliveError,
  answerOf,
  diskUse,
  prepareBuilder,
  reap,
  refreshPreviewToken,
  promoteVersion,
  sealGolden,
  goldenName,
  projectSnapshotName,
  splitByOwner,
  snapshotMonthlyUsd,
  templatesOf,
  applyDelta,
  applyGoldenImport,
  upgradeBuilder,
  nextSetupSha,
  readOwnedFiles,
  upgradePlan,
  type UpgradePlan,
  type Builder,
  type BuildGoldenOptions,
  type CacheRule,
  type GoldenDelta,
  type GoldenImport,
  type ImportLedger,
  type SealResult,
  type ExecResult,
  type GoldenManifest,
  type GoldenVersion,
  type KillConfirm,
  type ListedMachine,
  type Lifecycle,
  type Machine,
  type MachineBackend,
  type MachineKind,
  type MachineShape,
  type MachineSpec,
  type MachineState,
  type PreviewReach,
  type ReapFailure,
  type ReapResult,
  type ReapedMachine,
  type RunOptions,
  type RetentionPlan,
  type SnapshotRow,
  type TemplateRow,
  type UnreadStore,
  type VaultOptions,
  type WspError,
  type WorkspaceHooks,
  type WorkspacePhase as EnginePhase,
  retentionPlan,
  rollback as rollbackGolden,
  snapshotStorage,
  applyMachineContext,
  MEM_READ,
  memMbOf,
  readValues,
  GUEST_TMP,
  GUEST_USER_ENV,
  landsBytes,
  LOCAL_MACHINE_ID,
  TOOLS_PATH,
  DiskSyncError,
  syncDisk,
} from "@wsp/engine";
import type { AgentsReport, AgentsSignInEvent, AgentsTarget, DaemonFrame, DaemonResponse, PlaceReport, ServerAdd, ServerAsk, ServerToolsAnswer, SignInLine, SkillAdded, SkillHit, SkillPreview } from "@wsp/protocol";
import type {
  AdapterAttachOptions,
  AdapterEvent,
  AttachmentRoad,
  Capabilities,
  DaemonEvent,
  DaemonReachView,
  EventUnion,
  ExecStream,
  ExecStreamFactory,
  GoldenBaseTool,
  GoldenBuilderView,
  GoldenLogin,
  GoldenStage,
  GoldenStep,
  HarnessCatalog,
  HarnessCatalogAnswer,
  HostFolderListing,
  InitJob,
  InitJobEvent,
  InitNeedsYouEvent,
  InitRoad,
  InitScreenId,
  InitSetup,
  Preferences,
  PreferencesPatch,
  Recipe,
  RecipeDigest,
  SealedImage,
  SealedImageBuilt,
  SealedImageCopy,
  SealedImageView,
  SealedProjectImage,
  SealedVault,
  ScreenCommand,
  TerminalConfig,
  TerminalScheme,
  PortProbeView,
  PortReachView,
  ProjectAddStage,
  ProjectAgentOutcome,
  ProjectAgentResult,
  ProjectExportResult,
  ProjectExportStage,
  ProjectGolden,
  ProjectGoldenRemoved,
  ProjectImportResult,
  ProjectRef,
  ProjectSource,
  ProjectView,
  ProjectImportStage,
  ProjectPlan,
  MachineBind,
  SeedChoice,
  SeedPlan,
  WorkspaceCopy,
  PermissionAsk,
  PermissionOption,
  PermissionOutcome,
  ReachState,
  SessionEvent,
  SessionAccessResult,
  SessionAnswerResult,
  SessionInterruptOutcome,
  SessionInterruptResult,
  SessionRenameResult,
  SessionRenamer,
  SessionStartOutcome,
  SessionSteerResult,
  SessionOrigin,
  SessionTitleMaker,
  SessionTitleReader,
  SessionView,
  StartPicks,
  StateShape,
  TitleSource,
  SnapshotStorage,
  ImageAttachment,
  ImageRecord,
  McpServerSpec,
  TurnImage,
  TurnResult,
  TurnStatus,
  SysSample,
  UpgradeResult,
  WorkspaceCostEvent,
  WorkspaceCreateStage,
  Caller,
  WorkspaceAgents,
  WorkspaceKind,
  WorkspaceLook,
  WorkspacePhase,
  WorkspaceProject,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "@wsp/protocol";
import { cloneLines, PROJECT_LANDINGS, projectLanding, type Landed, type LandingDeps, type ProjectLanding, type ProjectPlaces } from "./project-landing.js";
import { DEFAULT_BRANCH, projectRemote, projectSource } from "./project-sources.js";
import { vaultUnlistedRefusal, ThreadScope, WorkspaceOrigin, branchUnreadRefusal, noParentWorkspaceLine, parentProjectRefusal, BringBackResult, GitPrReply, GitPushReply, agentsFrom, foldThreads, agentsKindRefusal, agentsMayDrive, askerOf, MCP_SERVER_NAME, threadForgetRefusal, threadRan, threadWord, threadsFollowed, SPAWN_ACTS_ALLOWED, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, SCOPED_MCP_ARG, agentsOffRefusal, roadOf, scopeOf, spawnActRefusal, spawnCapRefusal, spawnGoldenRefusal, spawnDepthRefusal, spawnProjectRefusal, spawnReachRefusal, workspaceIdOf, type SpawnAct, type ThreadWaitingOn } from "@wsp/protocol";
import { PLACE_WORKSPACE_PATH, THIS_COMPUTER, COPY_BUILD_FIX, copyAsksSignIns, refusal, copyFirstLine, isLocalWorkspace, imageCarriesCheckout, addedProjectOn, addingProjectLine, hereDaemonBehindLine, DAEMON_TOKEN_PATH, IN_PLACE_ROAD, inPlaceRecordLine, CopyRoad, recipePins, mcpServersBlocked, actionRefusal, buildsImages, copyBuildOf, copyIsCurrent, type CopyBuild, forksNoMachines, IDLE_REASON, kindWords, readingRoad, namesSize, NO_PROVIDER_LINE, providerCannotRefusal, ALREADY_APPLIED, ALREADY_RUNNING, applyPreferencesPatch, serverIconsLeftLine, homeShortened, BLANK_NAME_REFUSAL, catalogRefused, CREATE_READY, DAEMON_INSTALL_FAILED, DAEMON_INSTALLING, DAEMON_RESTART_FAILED, DAEMON_RESTARTING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, daemonVersionOf, EMPTY_TITLE_LINE, threadRunsOnLine, resumeNotOfThreadLine, fmtBytes, fmtDuration, folderName, forgetUndrivenRefusal, goldenImage, goneRefusal, goneWords, HOSTNAME_KEPT, hostnameSetLine, imageMoveRefusal, imagePathIn, imageRecord, imagesBlocked, inFolder, labsFromEnv, leadAsk, listedPick, machineCapRefusal, machineLacksLine, machineNeverAnswered, machineWord, napRefusedLine, NO_IMAGE_YET, nameDeletingRefusal, nameTakenRefusal, deleteRefusedLine, snapshotRefusedLine, NO_SUCH_TURN, noAdapterLine, noKindLine, noMachineHomeLine, noSshDaemonLine, noWorkspaceRefusal, ID_PREFIX_MIN, idPrefixRefusal, notFoundRefusal, NOT_GONE, GONE_UNCHECKED, goneUnconfirmedLine, type GoneSeenBy, NOTIFY_ME, notifyLine, offeredSize, PERMISSION_DENIED_LINE, askingLine, permissionModeOptionLabel, pickedOptions, preferencesFrom, RECORD_RESTORED, RESUME_UNANSWERED, refusalLine, registeredLine, REGISTERING_LINE, claudeMemoryDir, claudeProjectKey, folderOnCopyRefusal, gitOnThisMacRefusal, noComputerForSourceLine, bareNoSuchProjectLine, noSuchProjectLine, NOT_A_REPO_LINE, leftBehindLine, projectInUseRefusal, projectNameOf, seedChoiceNeeded, sameSourceRefusal, sourceKind, projectSourceOf, copiesFolder, copyTakesNone, kindForComputer, DEVICE_OPS, relayedRecordRefusal, relayedRefusal, RUN_GONE_LINE, sendRefusal, shellLine, shellQuote, signInRefusalLine, SIZE_PICK_FIX, sizeGotLine, sizeRefusal, sizeWord, sshDaemonPaths, startingLine, startPicks, stateWriterWords, storedTitleSource, titleLine, TURN_TOKEN_ENV, turnImagesDir, underProject, undrivenRefusal, WAKE_STOPPED, wakeAskingAgainLine, wakeAsksIn, wakeGaveUpLine, workspaceState, absentComputer, buildPlaceAskLine, HERE_PLACE_ID, isJoinedComputer, NO_BUILD_PLACE_LINE, noSuchPlaceRefusal, noProjectImageLine, projectImageInUseRefusal, projectImageRefusedLine, projectImageStillListedLine, placeBuildsNoImageLine, placeForksNothingPickLine, placeForksNowhereLine, placeHoldsNoImageLine, placeBehindLine, placeBlocked, placeDaemonBehind, placeWatchesItselfLine, forkProcsUnreadLine, forkOpRefusedLine, placeDaemonPaths, placeDialBackLine, placeWentAwayLine, placeServesDaemonLine, placeNotAWorkspaceLine, placeNotAWorkspaceFix, workspaceAccess, workspacePlace, workFolderIn, workspaceLands, copyPathFor, folderSlug, type ProjectCopy } from "@wsp/protocol";
import { agentsReads, type AgentsActs, type AgentsReader, type CallbackForwards, type ServerIcons, type ServersActs, type SignInAsk, type SkillAsk, type SkillsActs } from "./agents-read.js";
import { openDaemonChannel, type DaemonChannel, type DaemonChannelOptions } from "./daemon-channel.js";
import { templateHost } from "./host-id.js";
import { machineExecStream, type MachineExecOptions, type TurnWaiting } from "./machine-exec.js";
import { isNoProvider, isPlaceAbsent, projectStateKey, type Copier } from "@wsp/engine";
import { realClock, type Clock } from "./clock.js";
import { writeDaemonRootsScript } from "./daemon-roots.js";
import { assertTokenShape, daemonTokenFor, daemonTokenPathOf, rotateDaemonToken } from "./daemon-token.js";
import { DEFAULT_IDLE_WINDOW_MS, backstopMs, createIdlePolicy } from "./idle.js";
import { nextPortBase } from "./ports.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import { POLL_INTERVAL_MS, createStatusTracker, machineStateOf, phaseLeavingGone, providerSaid, type StatusApi, type StatusListOptions, type StatusWatchOptions } from "./status.js";
import { makeDevices, type DeviceDoor, type ScopedRoad } from "./devices.js";
import { makePlaceDoor, PlaceForksNowhereError, PlaceProvisioningError, type PlaceDoor, type PlaceRecord, type PlaceWiring } from "./places.js";
import type { Store } from "./store.js";
import { HARNESS_CATALOGS, catalogFromProbe, harnessCatalog, smallestModel } from "./harness-catalog.js";

// --- adapter port -------------------------------------------------------------

export interface HarnessAdapterContext {
  machine: Machine;
  workspaceId: string;
  /** How a turn's process is launched on this machine: the guest's detached-and-polled road on a cloud fork, a real
   * child process on the local computer. The one concern that varies by machine kind and reaches the adapter here. */
  execStream: ExecStreamFactory;
  /** Where the harness keeps its sessions on this machine, by agent id: the folder the golden's sign-in wrote into on
   * a cloud fork, the person's own store on the local computer. */
  home: (agentId: string) => string;
  /** The machine's login environment, exported under the harness's own on every launch: the golden's PATH, so a
   * launch served by a process with a bare one still finds the binary, and on a guest the variable that points this
   * harness at its store there. On the person's own computer it is their shell's, so a store variable is set only
   * where their shell sets it, and their login is the turn's login. */
  env: Readonly<Record<string, string>>;
  /** What this agent keys its sessions and its auto memory to on this workspace, where the kind has an answer: on
   * a computer whose workspaces are copies of a project folder, the original folder's own key, so every copy and
   * the person's own agent in that folder share one memory. Absent leaves the agent keying off the folder each
   * turn runs in, which is every machine wsp makes. */
  projectKey?: string;
  /** wsp's half of a turn this workspace's agent refuses for want of a sign-in, from the one rule every door reads
   * for how it is signed in: it differs between the person's own computer and a machine, which the adapter cannot
   * know, so it is told the road from here rather than guessing one. */
  signInRefusal: string;
  /** The tokens and API keys the vault holds, by variable. Its own field rather than part of `env`: the Claude
   * adapter strips every inherited CLAUDE_CODE_* off the base environment as a nesting mark, so a token merged
   * into the environment would be stripped and never reach the CLI. Empty where the host wired no vault. */
  vault: Readonly<Record<string, string>>;
  /** Whether a login of one agent's own already stands where this workspace runs, which is what decides whether
   * the vault's key for it is handed to the turn: a harness reads a key in its environment ahead of the login on
   * its disk, so handing one where a person signed in would bill the key and leave that sign-in unused. Where a
   * login lives differs by machine kind, which the adapter cannot know, so it is told from here. */
  loginStands: (agentId: string) => boolean;
}

/** What every machine wsp runs agents on tells them, cloud fork and ssh machine alike, and this computer never does:
 * IS_SANDBOX=1 is what lets Claude Code take --dangerously-skip-permissions as root there (solari-poc P1).
 * DISABLE_AUTOUPDATER=1 holds the agent at the version the image pinned, inside a fork or a box, at run time too. */
export const MACHINE_SANDBOX_ENV: Readonly<Record<string, string>> = { IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1" };

/** The guest's login environment: who it runs as, the PATH the golden's login shells get, and the sandbox flag every
 * machine carries. Every fork carries it in its envs at create and every adapter exports it under the harness's own. */
export const GUEST_LOGIN_ENV: Readonly<Record<string, string>> = { ...GUEST_USER_ENV, PATH: TOOLS_PATH, ...MACHINE_SANDBOX_ENV };

/** The same for a workspace on a computer somebody joined: the order that reads the folders no process inside can
 * write before the home every workspace there shares, and beside it the knobs the recipe's job installed under,
 * off the catalog's one table. A thread, a command and the workspace's own boot carry this, so a tool the recipe
 * put under wsp's prefix is the one that answers inside wherever it is asked for. A fork keeps GUEST_LOGIN_ENV:
 * its home is root's alone, and its image was sealed on that order with each manager's own folders. */
export const PLACE_LOGIN_ENV: Readonly<Record<string, string>> = {
  ...GUEST_USER_ENV,
  PATH: PLACE_WORKSPACE_PATH,
  ...MACHINE_SANDBOX_ENV,
  ...installEnv(installHomes(TOOL_PREFIX)),
};

/** Which of the two a workspace runs on: where it stands, and nothing else. */
export const loginEnvOn = (place: string | undefined): Readonly<Record<string, string>> => (place === undefined ? GUEST_LOGIN_ENV : PLACE_LOGIN_ENV);

export interface HarnessStartOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  /** Catalog slugs the adapter maps to its CLI's flags; absent leaves the CLI's default. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** The name the thread is opened under, for a CLI that takes one at launch; every harness is told it again through
   * renameSession once its session is announced, so an adapter whose CLI cannot take it here need not. */
  title?: string;
  /** The turn's images, each already on the road its adapter declared: bytes for an inline adapter, a path on the
   * machine for a file one. Empty on a turn that carries none. */
  images?: readonly TurnImage[];
  /** MCP servers this turn gets besides the ones the harness's own config on the machine names, by the name each
   * takes in a config; the adapter hands them to its CLI the way that CLI takes one. Absent on a turn that carries
   * none, which is every turn a person sends. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  onEvent: (event: AdapterEvent) => void;
}

export interface HarnessSession {
  readonly localId: string;
  readonly finished: Promise<TurnResult>;
  /** What a later host process attaches to this turn by, on a harness whose run outlives the host that started it;
   * absent where it does not, and the row is settled as cut when this process goes. */
  readonly run?: string;
  /** The process this turn leads on the computer the host runs on, where it runs there; absent on a turn running on
   * another machine, whose pids are not this computer's. */
  readonly pid?: number;
  /** Stops the process this session owns; finished settles after it, once session.end has been emitted. */
  interrupt(): Promise<void>;
  /** Present on a harness that takes a message mid-turn; absent means it cannot. not-running when the turn had not
   * started or had ended when the message was offered. */
  steer?(prompt: string): Promise<"accepted" | "not-running">;
  /** Answers a permission prompt this turn raised; absent on a harness that raises none this host can answer. The
   * caller names the outcome, since only it knows whether the answer is the person's or its own for a prompt nobody
   * came to, and the adapter emits the permission.close that carries it. `gone` when no such prompt is open. */
  answer?(askId: string, answer: { optionId: string; outcome: PermissionOutcome; denyMessage: string }): Promise<"answered" | "gone">;
  /** Puts this running turn into another access mode from its next tool call on, and to the prompt it is stopped on
   * where the mode answers one; absent on a harness whose CLI takes no such change once a turn is under way, and the
   * person's pick then waits for their next message. `refused` is the CLI's own no to that mode with no road left to
   * stand in for it, `gone` a turn whose channel takes nothing any more. */
  setAccess?(mode: string): Promise<"set" | "refused" | "gone">;
}

export interface HarnessAdapter {
  start(options: HarnessStartOptions): HarnessSession;
  /** Re-opens a turn this harness is still running on the machine, by the run handle a session of an earlier host
   * process reported. The run's whole output is read again, so the events the host missed reach this one. `gone` is
   * the machine's own answer that it no longer holds the run, and no event is emitted for one. A machine that
   * answers nothing rejects, and the turn is left where it is. Absent on an adapter whose runs die with the host. */
  attach?(options: AdapterAttachOptions): Promise<HarnessSession | "gone">;
  /** Whether this adapter's sessions carry steer; the catalog tells the composer before a turn runs. */
  readonly steers: boolean;
  /** How this harness takes an image with a turn, and that it takes one at all: absent, a turn carrying an image is
   * refused in this agent's name before the machine is asked for anything. */
  readonly attachments?: AttachmentRoad;
  /** Whether this adapter renders the MCP servers a start names into the launch its CLI takes. Absent means it does
   * not, and a start naming servers is refused in this agent's name before the machine is asked for anything: a
   * launch that dropped them would open a thread whose tools are missing and whose agent looks like it ignored them. */
  readonly mcpServers?: true;
  /** The commands this CLI runs only in its own terminal, which a headless turn answers are not available; the catalog
   * carries them so the composer lists none and sends nothing for one. Absent means none. */
  readonly screenCommands?: ReadonlyArray<ScreenCommand>;
  /** Whether an access picked while a turn runs reaches that turn, so the picker says what a pick does before it is
   * made. Absent means it does not, and a pick waits for the person's next message. */
  readonly movesAccess?: true;
  /** Asks the binary on the workspace's machine what it takes: its lists, its own words for why it has none, or null
   * when it does not answer at all; absent, the table alone answers and nothing runs. */
  probeCatalog?(exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer>;
  /** Reads the harness's own title for a session out of its store on the machine; absent on a harness that keeps none. */
  sessionTitle?: SessionTitleReader;
  /** Writes a person's name for a session into that same store; absent on a harness that keeps no name of a person's. */
  renameSession?: SessionRenamer;
  /** Asks the harness itself for a name for a thread it has just replied in; absent on a harness that cannot answer a
   * question of its own. */
  titleFor?: SessionTitleMaker;
  /** What a turn's command is exported with on the machine; a plain exec on the workspace runs with the same. Absent
   * means nothing is exported and both run with the machine's own environment only. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Called per session start with the workspace's CURRENT machine (it can change on wake/upgrade). */
export type HarnessAdapterFactory = (ctx: HarnessAdapterContext) => HarnessAdapter;

// --- events -------------------------------------------------------------------

export type EventListener = (event: EventUnion) => void;

export interface EventBus {
  on(type: EventUnion["type"] | "*", listener: EventListener): () => void;
  /** The retained events after sequence `after`, oldest first, with head, the newest sequence issued (0 before any),
   * and stream, the id minted for this process's sequences. gap: `after` is not a cursor into this stream, because it
   * came with another stream id, is older than what is retained, or is past head, so nothing is replayed and the
   * caller must refetch. */
  since(after: number | undefined, stream: string | undefined): { stream: string; head: number; events: EventUnion[]; gap: boolean };
}

/** Events kept for a socket that comes back: one ring shared by every workspace, holding the status and cost ticks
 * that no transcript keeps. 5000 bounds it at one transcript's worth of memory (TRANSCRIPT_CAP); a cursor that fell
 * off it gets a gap, and the client refetches the list, the statuses and sessions.history and converges from those. */
const EVENT_RING_CAP = 5000;

/** How long a machine's catalog answer stands before the binary is asked again; t3code's provider health cadence. */
export const CATALOG_TTL_MS = 5 * 60_000;
/** The probe measured 1 to 3 s on a Mac; a guest that takes longer than this is answered from the table. Under the
 * provider's 26 s exec cap, so the probe is one call and not a detached run on every fork. */
const CATALOG_PROBE_TIMEOUT_MS = 25_000;

/** How long a harness's title for a session stands before its store is read again on a refresh. Clients reload the
 * index on every session event, and a person renaming a session in the harness waits at most this long to see it. */
export const SESSION_TITLE_TTL_MS = 10_000;
/** A grep of one session file or a row out of one sqlite; a guest slower than this keeps the title it last gave. */
const SESSION_TITLE_TIMEOUT_MS = 15_000;
/** How many of a workspace's harness sessions one refresh asks about, newest first: a store read is an exec on the
 * machine, and an index at SESSION_INDEX_CAP must not cost one per row. */
export const SESSION_TITLE_REFRESH_MAX = 20;
/** How long the harness has to answer the one title question a thread costs. A claude-sonnet-5 answer measured 1.4 s
 * of model time on 2026-09-07; this is the wedged case, and a thread that hits it keeps its opening words. Under the
 * provider's 26 s exec cap, so the question is one call on every thread. */
export const TITLE_MAKE_TIMEOUT_MS = 25_000;

function eventBus(): EventBus & { emit(event: EventUnion): void } {
  const listeners = new Map<string, Set<EventListener>>();
  const ring: EventUnion[] = [];
  const stream = randomUUID();
  let head = 0;
  return {
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    since(after, from) {
      if (after === undefined) return { stream, head, events: [], gap: false };
      const oldest = head - ring.length + 1;
      const foreign = from !== undefined && from !== stream;
      if (foreign || after > head || after < oldest - 1) return { stream, head, events: [], gap: true };
      return { stream, head, events: ring.slice(after - oldest + 1), gap: false };
    },
    emit(event) {
      const stamped: EventUnion = { ...event, seq: ++head };
      ring.push(stamped);
      if (ring.length > EVENT_RING_CAP) ring.splice(0, ring.length - EVENT_RING_CAP);
      for (const type of [event.type, "*"] as const) {
        for (const l of listeners.get(type) ?? []) l(stamped);
      }
    },
  };
}

// --- runtime ------------------------------------------------------------------

export interface WorkspaceSpec {
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** The workspace gets the place's container engine through the fenced socket; absent takes the image's recipe. */
  engine?: boolean;
  /** The folders of the computer's own this workspace mounts: its project's memory folder, where that computer
   * holds one. Written by the create off the project's landing road and read again by every wake. */
  binds?: MachineBind[];
  /** The checkout on that computer this workspace holds its own copy of, and where that copy is mounted inside.
   * Written by the create off the project's record, so a wake mounts the copy the create was made with. */
  copy?: WorkspaceCopy;
}

/** What a create answers: the view, and a notice when a builder kept after a save was stopped to make room. */
export interface CreatedWorkspace extends WorkspaceView {
  notice?: string;
}

export interface CreateWorkspaceOptions extends WorkspaceSpec {
  /** The project this workspace is made for, by id or by name. Its computer is where the workspace lands, so
   * nothing else says where. */
  project: string;
  /** Snapshot id of a project image to fork; absent takes the head of this host's own image. */
  golden?: string;
  name: string;
  /** What the agents on the new workspace may ask of this host; absent is off, and on a fork a thread asked for it
   * is the forking workspace's own switch, so a tree of machines carries one rule rather than needing it set again.
   * A key left out takes the default. */
  agents?: Partial<WorkspaceAgents>;
  /** Auto-nap window; undefined takes the runtime default, null turns auto-nap off. */
  idleWindowMs?: number | null;
  /** The workspace this one is forked out of, by id: a child of it, holding the same project and starting on the
   * branch that workspace is on right now. A create a thread asked for is a child of the thread's own workspace
   * whether or not this names one. */
  parent?: string;
}

/** A folder's archive as the host packs it: the bytes, what went in, the secret-shaped paths left out, and the ones
 * that went in rewritten as the plan offered. */
export interface PackedProject {
  tar: Buffer;
  files: number;
  bytes: number;
  cut: string[];
  rewritten: string[];
}

/** The agents whose state for the folder travels: each with its home on the machine and whether the agent is there
 * to read the state once it is keyed to `dest`. */
export interface StateRequest {
  dest: string;
  agents: readonly { agent: string; home: string; present: boolean }[];
}

/** The agents' state as the host packs it: an archive of each agent's files at its machine home, for the guest's
 * root, what became of each agent, and the merge scripts in the archive by agent, each at its path on the guest, for
 * the runtime to run once the archive has landed. */
export interface PackedState {
  tar: Buffer;
  agents: ProjectAgentResult[];
  merges: { agent: string; script: string }[];
}

/** A folder on this computer as the host reads it; the runtime never touches the disk itself. `plan` reads names
 * and sizes, `pack` reads the bytes once consent is known: a secret-shaped file travels only when `carry` names it,
 * or rewritten when `rewrite` names a path the plan offered a rewrite for. `packState` reads the named agents'
 * homes for their state for the folder, re-keyed to the destination for the agents on the machine. */
export interface ProjectBundler {
  plan(): Promise<ProjectPlan>;
  pack(carry: ReadonlySet<string>, rewrite: ReadonlySet<string>): Promise<PackedProject>;
  packState(req: StateRequest): Promise<PackedState>;
}

/** The folder's archive as it came off the machine, rooted at the folder, and the agents' state that came with it. */
export interface LandRequest {
  /** The folder's path on the machine: the key its agent state on the machine is stored under. */
  source: string;
  /** Where the folder lands on this computer, absolute. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists". */
  replace: boolean;
  /** The archive as a file on this computer, streamed off the machine rather than held in memory; whoever asked for
   * the landing removes it afterwards. */
  archive: string;
  /** The agents' state under the guest's root as an archive on this computer, each agent's home on the guest by
   * catalog id, and the agents whose state comes home (every one with sessions for the folder when absent). */
  state?: { archive: string; homes: Readonly<Record<string, string>>; agents?: readonly string[] };
  /** The stores an agent keeps for every project that the listing on the machine could not read: nothing of theirs is
   * in the archive, so the landing report carries a row for each one saying which store and why. */
  unread?: readonly UnreadStore[];
}

/** This computer's own folders as a browser tab's picker walks them, one level at a time; the runtime never touches
 * the disk itself, the host that owns it does. The desktop shell has the system dialog and never asks for this. */
export interface HostFolders {
  /** `wide` is this computer's own window, which is not held to the home root; `repos` asks for every repo under the roots. */
  list(req: { dir?: string; hidden?: boolean; repos?: boolean; wide?: boolean }): Promise<HostFolderListing>;
}

/** The person's terminal config on the computer running the host, read again on every ask; the runtime never reads
 * the disk itself, the host that owns it does. */
export interface HostTerminalConfig {
  read(scheme?: TerminalScheme): Promise<TerminalConfig>;
}

/** The init job on the computer running the host: wsp init's run, read and driven from the app over the wire. The
 * host owns it (this computer's files, its Keychain, the sign-ins' terminal link are all the host's); the runtime
 * serves its ops and relays its events beside its own, as it does the host's forwards. */
export interface InitDoor {
  /** The setup as the modal opens on it, priced at the place `on` names, else the default build place. */
  get(o?: { on?: string }): Promise<InitSetup>;
  keys(keys: { provider?: string; key?: string; rows?: Record<string, string> }): Promise<InitSetup>;
  start(o: { road: InitRoad; harness?: string; on?: string }): Promise<InitJob>;
  answer(o: { screen: InitScreenId; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob>;
  step(o: { at: number }): Promise<InitJob>;
  /** Keeps a step's unsent ticks, picks and typed text on the job, so a sheet shut mid-step reopens on them. */
  draft(o: { at: string; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob>;
  retry(o: { tool: string }): Promise<InitJob>;
  /** Starts the build at the place `on` names, else the default build place. `rebuild` seals the next version from
   * a fresh machine rather than from the image plus the changes, which is the question a run at a terminal is asked;
   * absent takes whichever road the changes call for. */
  build(o: { firstWorkspace?: string; importFolder?: string; yes?: boolean; on?: string; rebuild?: boolean }): Promise<InitJob>;
  /** Types the code a sign-in's page handed back into the tool waiting for it on the machine; refused when none is. */
  signInCode(o: { tool: string; code: string }): Promise<InitJob>;
  cancel(): Promise<InitJob>;
  /** Every change to the job, and beside it the arrival of a wait on the person, which a client that speaks once per
   * need rides rather than diffing views. */
  on(fn: (e: InitJobEvent | InitNeedsYouEvent) => void): () => void;
}

/** One agent's result with its catalog name, for the sentence the runtime says about it. */
export type LandedAgent = ProjectAgentResult & { name: string };

/** What landed on this computer: the folder's files and bytes, and each agent found on the machine with sessions for
 * the folder and what became of its state here. */
export interface LandedProject {
  files: number;
  bytes: number;
  agents: LandedAgent[];
}

/** This computer's side of an export, as the host does it; the runtime never touches the disk itself. `probe` looks at
 * the destination before anything is read from the machine, `land` extracts the folder beside its destination and
 * moves it into place, then keys the agents' state to it in their homes here as an overlay. */
export interface ProjectLander {
  /** What the machine's archive leaves behind: the bundle's own cache rule, so the trip home drops what the trip out dropped. */
  caches: CacheRule;
  /** How many files sit at dest on this computer now, or nothing when the path is free. */
  probe(dest: string): Promise<{ files: number } | undefined>;
  land(req: LandRequest): Promise<LandedProject>;
}

export interface ProjectExportOptions {
  workspaceId: string;
  /** The folder on the machine, absolute. */
  source: string;
  /** Where it lands on this computer, absolute. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists" before anything is read. */
  replace?: boolean;
  /** The agents whose state comes home, by catalog id; absent, every agent with sessions for the folder on the machine. */
  agents?: readonly string[];
  lander: ProjectLander;
}

export interface ProjectImportOptions {
  workspaceId: string;
  /** The folder on this computer, absolute; named in the events. */
  source: string;
  /** Where the folder lands on the machine, absolute; its parents are made. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists". */
  replace?: boolean;
  /** The secret-shaped paths from the plan that may travel as they are; every other one is cut and named. */
  carry?: readonly string[];
  /** The paths the plan offered a rewrite for that land rewritten; wins over carry for the same path. */
  rewrite?: readonly string[];
  /** The plan's agents whose state for the folder travels, by catalog id; nothing of any other agent is read. */
  agents?: readonly string[];
  bundler: ProjectBundler;
}

interface WorkspaceRecord extends Omit<WorkspaceView, "project"> {
  /** cloud or local; a record stored before local existed has none and reads cloud. */
  kind: WorkspaceKind;
  /** The project this workspace was made for, by its id. The view joins the record's name, path and computer off
   * the projects map, so one fact has one stored home. */
  project: string;
  spec: Pick<WorkspaceSpec, "envs" | "labels" | "engine" | "binds" | "copy">;
  idleWindowMs?: number | null;
  /** What the provider built, read back after every create (it may clamp the
   * request); the rail and the rate use this, never what was asked for. */
  size: WorkspaceSize;
  firstLife: boolean;
  /** The provider's view of the current machine when it was created; a wake compares against it. */
  shape?: MachineShape;
  /** The machine's login environment as it was read when the workspace was recorded: where its home is, who a turn
   * runs as and the PATH it gets. Only a kind whose machine wsp did not make carries one, since a fork's is the
   * golden's and the same on every one of them. */
  login?: Readonly<Record<string, string>>;
  /** What the machine itself answered about who it is, on the one dial that recorded the workspace, where its kind
   * can ask: two records of one machine under different addresses, ports or keys carry the same string, and it is
   * what says a second workspace would stand on a machine one already stands on. A kind whose id is the machine
   * (a fork at the provider, this computer) carries none and is compared by that id. */
  machineIdentity?: string;
  /** The branch this workspace's copy started from: the branch its parent was on at the fork for a child, and the
   * branch the project starts from for every other workspace. A fact of the fork and not a reading of the parent,
   * since it is the code this copy was cut from, which is where its work goes back however the parent moves on;
   * absent on a record written before it, which reads the project's own base as it always did. */
  base?: string;
  /** With phase gone: the provider's words when the machine was found missing; cleared when a fresh machine lands. */
  gone?: string;
  /** That this host put a daemon on the machine, and which one. Only a kind whose machine wsp did not make carries
   * it: a fork's daemon comes with the golden and its preview route says whether one answers, while a machine the
   * person owns had none until a deploy landed, and nothing may dial one to find out. */
  daemon?: { deployedAt: string; version: number };
}

interface LiveWorkspace {
  record: WorkspaceRecord;
  ws: Workspace;
  machine: Machine;
  /** Moves with every write of the record; the status poll drops a row it built under an older one. */
  generation: number;
  /** The wake in flight, so a second caller joins it instead of resuming twice. */
  waking?: Promise<WorkspaceView>;
  /** The nap in flight: a second nap joins it, a wake waits for it. */
  napping?: Promise<WorkspaceView>;
  /** The record following a machine the provider runs under a napping word: a second verb that read the same fact joins it. */
  adopting?: Promise<void>;
  /** The delete in flight: a second delete joins it, and the name stays held until the record is dropped. */
  deleting?: Promise<void>;
  /** Cancels the one read armed after a wake gave up. */
  lateRead?: () => void;
  /** Stops the wake in flight, whether it is on a call or waiting to ask again: what the row's stop pulls. Aborting
   * it ends the provider call under it, so nothing is left running behind a wake that is over. Absent when no wake
   * is running. */
  wakeStop?: AbortController;
  /** What the row says about the wake in flight, for as long as it is in flight: every status the poll builds carries
   * it, since a line pushed once would be wiped by the next tick and the row would fall silent between two asks. */
  wakeSaid?: string;
  /** What the last delete said when the provider kept the machine, read while the record's phase is still the one it
   * was said under, until the next delete or wake starts: held here, not on the record, so a restart forgets it. */
  deleteSaid?: { phase: WorkspacePhase; line: string };
  /** Which ask the host is on and how many it will make, while it is asking again on its own; the surfaces read it
   * at the length each has room for rather than being handed a sentence built for one of them. */
  wakeAsk?: { ask: number; of: number };
  /** Set from the fork until the create is ready: the sweep knows the machine, nothing else can reach it yet. */
  creating?: true;
}

/** Reports one create stage as it is reached; the runtime stamps id, name and elapsed time. A notice is a second
 * line written for a person; a detail is what the machine answered, which rides the line's title. */
type StageReport = (stage: WorkspaceCreateStage, message: string, said?: { notice?: string; detail?: string }) => void;

export interface SessionHandle {
  readonly id: string;
  readonly workspaceId: string;
  readonly finished: Promise<TurnResult>;
  /** The runtime's id for the turn, as its events carry it. */
  readonly turnId: string;
  /** How the start that handed this out went: steered means the handle is the thread's running turn, not a new one. */
  readonly outcome: SessionStartOutcome;
  view(): SessionView;
  interrupt(): Promise<void>;
  steer?(prompt: string): Promise<"accepted" | "not-running">;
  /** Answers a permission prompt this turn raised, by the prompt's id and one of its options. Only a person answers
   * one: the prompt stands for as long as the turn does. Absent on a harness that raises none. */
  answer?(askId: string, opts: { optionId: string }): Promise<SessionAnswerResult["outcome"]>;
  /** Moves this running turn to another access mode, the prompt it is stopped on included; absent on a harness that
   * takes none mid-turn. */
  setAccess?(mode: string): Promise<"set" | "refused" | "gone">;
}

/** Which backend a place name resolves to. One row today, the provider this host is wired with; a row per joined
 * computer comes with the place link. The runtime reads only this interface, so nothing above it compares a place
 * by name. */
export interface PlaceBackends {
  /** The place every road that names none means: the provider this host forks on now. Read at each call, since a
   * host that starts with no key swaps its provider module in when one is saved. */
  readonly wired: string;
  backend(place: string): MachineBackend | undefined;
  list(): readonly string[];
}

/** The one-row table over the runtime's own backend; `id` is read at each call for the same reason `wired` is. */
export function wiredPlace(id: string | (() => string), backend: MachineBackend): PlaceBackends {
  const at = (): string => (typeof id === "string" ? id : id());
  return {
    get wired() {
      return at();
    },
    backend: place => (place === at() ? backend : undefined),
    list: () => [at()],
  };
}

/** What every golden built by this runtime gets; the host wires it (the daemon
 * bundle and the harness install script live there, not in the runtime). */
export interface GoldenRecipe {
  setup: string;
  /** Must exit 0 on a fork of the snapshot before a version is sealed. */
  smoke: string;
  baseTemplate?: string;
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** A returned string rides the deploying-daemon stage as its detail (the guest's Node version). */
  deployDaemon?: (machine: Machine) => Promise<void | string>;
  /** The person's files, tools and agents from the saved recipe; applied after the daemon, before the harness. */
  import?: GoldenImport;
  /** Every exec on a builder or its smoke fork, once it has returned or failed; the host's run log. */
  onExec?: (exec: GoldenExec) => void;
  /** Absolute guest paths the seal archives as the image vault: the sign-in state the ticked rows name and the
   * secrets files. Absent on a copy's own build, whose vault is the record's already. */
  vaultPaths?: readonly string[];
  /** The small recipe this build was planned from, kept on the record so another place builds from what was sealed. */
  source?: Recipe;
}

/** One exec on a golden machine as the run log records it: the command, what came back, and how long it took. */
export interface GoldenExec {
  machineId: string;
  cmd: string;
  ms: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The exec itself failed (the machine gone, the request refused); no exit code exists. */
  error?: string;
}

/** `ranIn` absent means the workspace's kind named no folder, so the machine's own home is where its shell landed. */
export interface RunningExec extends ExecStream {
  readonly ranIn?: string;
}

/** What a host wires for the one local workspace this computer can be: the backend that answers with this computer,
 * how a turn's process is launched on it (a real child, not the guest's polled road), where each harness keeps its
 * own sessions here, and the environment a turn runs under. Absent, the runtime serves cloud workspaces alone and
 * `createLocal` is refused. The one place the local variant is registered beside the cloud default. */
export interface LocalWiring {
  /** This computer's backend, which publishes the folder its commands run in: the folder a turn and a command start
   * in when the caller names none is that one and not the person's home, which is one `cd` away and holds the
   * checkouts they work in themselves. One fact, so the roads that go through the runtime and the ones that reach
   * the machine directly cannot land in two different folders. */
  backend: MachineBackend & { readonly folder: string };
  /** The launch factory for a turn on this computer, under the limits the registry hands every turn (the turn's own
   * by default, none for the exec verb), so a local turn is cut the way a cloud turn is. `waiting` rides beside them
   * and is not one: it says the run is stopped on a question only a person can answer, which holds the idle clock. */
  execStream: (opts?: MachineExecOptions, waiting?: TurnWaiting) => ExecStreamFactory;
  home: (agentId: string) => string;
  /** The person's own home: where this computer's daemon browses from, and what a path under it is shortened
   * against. */
  homeDir: string;
  /** Where the folders that daemon may browse as projects are written down. The host that started it names the
   * file, beside the state it serves, so one host's roots are never another's. */
  rootsPath: string;
  /** The environment a turn on this computer runs under, asked every time rather than copied: this process's own
   * environment moves after a host is built, the login shell PATH among them, and a copy would outlive the change. */
  env: () => Readonly<Record<string, string>>;
  /** Where this computer's daemon listens and the token that opens it, in the shape a cloud fork's preview route
   * arrives in, so the panes and the status probe read one view. The host starts that daemon on the first call and
   * closes it in close(); a host that wires none leaves the local workspace's panes with nothing to dial. */
  daemonRoad?: () => Promise<DaemonReachView>;
  /** The daemon staged beside this host, which is what a workspace here runs and what the copy road spawns: the
   * version its binary answers as and the line that stages the right one. Both or neither, since a version with no
   * fix line cannot word the refusal. A wiring that answers none refuses no copy over it, which is a test harness
   * that wired no daemon. */
  hereDaemon?: HereDaemon;
  /** Starts another daemon for this computer's workspace, in place of the one this host is holding: the daemon is
   * a child of this process, so nothing else can put it back. The old one is let go of and closed, and the call
   * answers once the new one has listened. */
  restartDaemon?: () => Promise<void>;
  /** This computer's own cpu, memory and disk, pushed to the listener every sample until the returned detach runs.
   * Read off this computer's daemon, the one reader of a machine's load wsp has, so the Live rows of the workspace
   * that is this computer start it if nothing else has. One watch however many listeners there are; it opens with
   * the first and closes with the last. */
  sysSamples?: (fn: (s: SysSample) => void) => Promise<() => void>;
  /** How a copy of a project folder is made and taken away on this computer: the daemon binary's own copy verb,
   * run as a child. Every workspace here is a copy, so a wiring with none refuses every create here in one
   * sentence naming the road it lacks. */
  copier?: Copier;
  /** Which computer this is, for the one line a row says about ports being shared: the word is a Mac's or a plain
   * computer's and nothing here can know which. */
  platform: "darwin" | "linux";
  /** Frees whatever the wiring holds open on this computer when the runtime closes. */
  close?: () => Promise<void>;
}

/** The daemon beside a host on the computer it runs on: which version the binary answers as in its hello, read by
 * starting it where nothing has, and the line that stages the right one where it is behind. The host owns both
 * facts, since the binary is staged beside the command it installed and only the install road knows how to
 * replace it; the runtime reads them before it runs that binary and says nothing else about it. */
export interface HereDaemon {
  version(): Promise<number>;
  fix: string;
}

/** What a host wires for the machines it reaches over ssh: the backend that dials them, and nothing that reaches
 * a daemon on one. A machine somebody owns is a computer this host joins, and the projects on it are cloned into
 * copies of its own image, so nothing here records a workspace: this is the ssh variant's registration beside the
 * cloud default and nothing more. */
export interface SshWiring {
  backend: MachineBackend;
  /** Takes the daemon and everything wsp kept beside it off the machine. wsp put it there when the workspace was
   * recorded, so it goes when that record does: the machine is the person's own and is left as wsp found it. */
  removeDaemon?: (machine: Machine, login: { home: string; path: string }) => Promise<void>;
}

/** What the host wires for the seed half of an add: the menu for a folder on this computer, and the archive of
 * whichever rows the person ticked. Both read that folder, which is why neither is the runtime's own. */
export interface SeedWiring {
  plan(folder: string): Promise<SeedPlan>;
  pack(o: { plan: SeedPlan; choice: SeedChoice }): Promise<{ tar: Buffer; files: number; bytes: number; commits: number; left: readonly string[] }>;
}

export interface RuntimeOptions {
  backend: MachineBackend;
  /** The file this runtime's store is kept in, for the one refusal that asks a person to move it aside: a record
   * written before projects were records of their own is not read, so the sentence has to name what to move. */
  statePath?: string;
  /** The local computer as a workspace, when a host wires it; the cloud backend serves every other workspace. */
  local?: LocalWiring;
  /** The machines this host reaches over ssh, when a host wires them. */
  ssh?: SshWiring;
  /** The computers joined to this host as places, when a host wires the keys and the provider row for them:
   * absent, the runtime holds no place and every place op is refused. Named for the links it wires rather than
   * `places`, which is the row below: that one is where this host can build a copy of its image, and one option
   * cannot be two things. `rt.places`, the `places.*` ops and `wsp places` are this one's. */
  placeLinks?: PlaceWiring;
  /** How long a computer has to dial back after its own join before an install gives up on it; the door's own wait
   * unless a test shortens it. */
  placeJoinWaitMs?: number;
  /** How long a computer that took an update has to dial back running it before the answer says what it still
   * reads; the door's own wait unless a test shortens it. */
  placeUpdateWaitMs?: number;
  /** The same for one dial of a computer, which the door bounds itself rather than leaving to whatever road the
   * dial takes. */
  placeDialWaitMs?: number;
  /** The same for one machine frame on a place link with no bound of its own. */
  placeFrameWaitMs?: number;
  /** The same for how long a frame that may be asked again waits on a computer's link to come back. */
  placeRelinkWaitMs?: number;
  store: Store;
  adapters: Record<string, HarnessAdapterFactory>;
  /** The variables the vault hands a turn, read at each launch off the wsp home's .env, never copied: a token
   * minted after the host started reaches the next turn. Absent, turns get none. */
  vault?: () => Readonly<Record<string, string>>;
  /** How a folder on this computer is read and packed to seed a project on another computer. The runtime reads no
   * folder of the person's itself: the host wires the collector's menu and its own pack, and without them a folder
   * can only be a project on this computer. */
  seed?: SeedWiring;
  /** Required for golden.prepare / golden.seal; the scripted golden.build carries its own. */
  goldenRecipe?: GoldenRecipe;
  /** How a copy of the image is planned off the record, every login set to skip. The runtime writes no recipe of
   * its own, so without it no copy is built anywhere: the build op, the build behind a place being added or a
   * version cut, and a create that waits on one all stop at the one sentence. Asked for only once a build is going
   * to run, since it reads this computer. */
  copyRecipe?: (image: SealedImage) => Promise<GoldenRecipe> | GoldenRecipe;
  /** Where this host can build a copy of its image. Absent, one place named "default" over `backend`; the host
   * passes a row per provider module this computer is set up for, the wired one first. */
  places?: PlaceBackends;
  /**
   * Explicit guest paths carried across an upgrade. Default: everything under
   * /root except golden-provided dirs (VAULT_SKIP), enumerated at export time.
   */
  vaultPaths?: string[];
  /** What a vault export leaves behind, at those paths and under them: the project bundle's cache rule, so a
   * checkout's installs, build output and nested worktrees never travel and never count against the nap-time cap. */
  vaultCaches?: CacheRule;
  /** Defaults for the status poller / cost ticker (tests shrink the intervals). */
  status?: StatusWatchOptions;
  /** Defaults for a turn's stream on a machine: the poll pace and the clock its launch retry and its polls wait on
   * (tests hand in one they move by hand). Each road's own options win over these. */
  machineExec?: MachineExecOptions;
  idle?: { defaultWindowMs?: number };
  /** Drives the idle window and the transcript debounce; tests inject one they advance by hand. */
  clock?: Clock;
  /** How long a seal waits for a killed machine to read gone (tests shrink it). */
  killConfirm?: KillConfirm;
  /** How long a seal waits between snapshot attempts the provider refused (tests shrink it). */
  snapshotRetryMs?: number;
  /** Names this machine and install on the holds it writes, so two machines over one state file never mistake
   * each other's. The entry points pass hostIdentity(); the bare hostname when absent, which touches no disk. */
  hostId?: string;
  wake?: WakeOptions;
  /** How long one read of the provider gets before a wake asks again (tests shrink it). */
  providerReadMs?: number;
  /** How long a gone verdict waits before it reads the machine's state once more (tests shrink it; 0 reads at once). */
  goneConfirmMs?: number;
  /** How a turn on a machine reaches back into this host: what the host knows about where it answers, and the wsp
   * command on this computer for the local kind. The address a turn is told is its kind's own answer, read off
   * `reach` at each turn rather than once, since a host behind a relay is renamed whenever its connector runs.
   * Without an address no turn is given a token at all, so a host no machine can reach spawns nothing. */
  agents?: { reach?: HostReach; wspMcp?: McpServerSpec };
  /** The seed each machine's own daemon token is derived from, so a test that pins one reads a machine's token off
   * its reach view rather than naming it. Absent, every machine's token is minted at random. */
  daemonToken?: string;
  /** How this host dials a workspace's own daemon: for the frames the runtime sends itself, and for the channel a
   * client of this host drives one frame at a time; the real dial unless a test hands in its own. */
  daemonChannel?: (o: DaemonChannelOptions) => Promise<DaemonChannel>;
  /** How long a daemon gets to announce itself when an update reads the version either side of its deploy; the
   * hello lands on connect, so a daemon that is there answers in one round trip (tests shrink it). */
  daemonHelloTimeoutMs?: number;
  /** How the agents, skills and MCP servers are read off a computer or a workspace; the host wires the catalog's
   * readers. Absent, every agents.read is refused. */
  agentsReader?: AgentsReader;
  /** How the host signs agents in on a target, keeps their keys and writes the wsp tools into their configs; the host
   * wires the catalog's roads. Absent, every one of those acts is refused. */
  agentsActs?: AgentsActs;
  /** How the host searches skills.sh and previews, installs, turns off and on and removes a skill on a target; the
   * host wires skills.sh and the catalog's skill folders. Absent, every one of those is refused. */
  skillsActs?: SkillsActs;
  /** How the host adds, removes and turns off and on one MCP server in an agent's config on a target; the host wires
   * the catalog's format modules. Absent, every one of those is refused. */
  serversActs?: ServersActs;
  /** How the host asks Google for a remote MCP server's icon. Absent, every server draws its glyph. */
  serverIcons?: ServerIcons;
  /** The environment labs is read from; this process's when unset, which the entry points mean and a test does not:
   * a test says the environment it means here rather than inheriting the shell that started it. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Where this host answers, as the host itself knows it: the address the person named with --advertise, which
 * every machine wsp forks is told; the address a machine somewhere else dials, which is none where nothing about
 * this computer leaves it; the loopback a turn on this computer dials, which is none on a host bound to one address
 * beyond loopback; and the port, present only where this host bound the wildcard, which is the one bind that
 * answers on every address this computer has, an address a machine knows of its own included. A host bound to one
 * address hands out no port, since it answers there and nowhere else. A machine's kind reads the first two and
 * never `here`, and this computer reads `here` alone, so a token for the loopback never leaves this computer. */
export interface HostReach {
  advertise?: string;
  url?: string;
  here?: string;
  port?: number;
}

export interface WakeOptions {
  /** How long after a wake gave up the provider is read once more for a resume that landed late (tests shrink it). */
  lateReadMs?: number;
  /** A nap-time vault archive over this is not stored (a warning names the size). */
  vaultCapBytes?: number;
}

/** One read of the provider before a wake asks again; the client sets no request timeout of its own. */
const PROVIDER_READ_MS = 30_000;
/** The pause a gone verdict takes before it reads the state once more. A verdict ends every turn on the machine and
 * their unpushed work with them, and the provider answered one call 404 over a machine a direct read found running
 * two minutes later (2026-09-08), so the verdict is worth a second read. */
const GONE_CONFIRM_MS = 5_000;
/** What a gone sighting came to: the record settled gone, the state read found the machine there after all, the
 * reads that were to confirm it failed, or the record moved out from under the read (a rebuild, or another road
 * settled it first) and the sighting is stale. */
type GoneOutcome = "settled" | "not-gone" | "unchecked" | "moot";
/** A read that found the machine, handed to the load in place of its own get. */
type FoundMachine = Sighting & { machine: Machine };
/** Whether the record is gone after the sighting, by this one or by the road that settled it first. */
const settled = (o: GoneOutcome): boolean => o === "settled" || o === "moot";
/** A resume the runtime stopped waiting on can still land: one read this long after a wake gave up finds it. */
const WAKE_LATE_READ_MS = 3 * 60_000;
/** A daemon that is up answers the hello on connect; a machine whose daemon is gone costs this once on each side of an update. */
const DAEMON_HELLO_TIMEOUT_MS = 5_000;
/** The probe's fetch bound; the frame keeps loading meanwhile, so silence costs nothing but the sentence. */
const PORT_PROBE_TIMEOUT_MS = 10_000;

/** How long one read of a checkout's current branch may take. A git call on a checkout that is already there, so
 * the bound is for a machine that has gone quiet rather than for the work; under the provider's 26 s exec cap. */
const BRANCH_READ_MS = 25_000;

/** How long a project's clone inside a fresh copy may take before the create gives up on it. A repo of the size
 * wsp is dogfooded on lands in seconds; the budget is for a cold cache on a small machine. */
const CLONE_MS = 300_000;

/** Why a login is no project: `wsp add user@host` joins a computer, which is the other thing this verb does, and
 * a person who typed one meant that. */
export const ADD_IS_A_COMPUTER_LINE = "that is a computer, not a project; wsp add user@host joins it, and a project is a folder here or a repo's url with --on <computer>";

/** The folder a person named as this computer sees it: `~` is their home and a relative word is under the folder
 * the host runs in, which is where a caller that resolved nothing typed it. */
const folderNamed = (path: string): string => {
  const named = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : isAbsolute(path) ? path : resolvePathOn(path);
  // Through the links: a folder under /tmp on a Mac is reached by two names, and git answers with the real one, so
  // a record written under the other would never match the repo it names.
  try {
    return realpathSync(named);
  } catch {
    return named;
  }
};

/** Whether two sources are the same place: one source on one computer is one project, and the url or the path is
 * the whole of what says so. */
const sameSource = (a: ProjectSource, b: ProjectSource): boolean => (a.kind === "git" && b.kind === "git" ? a.url === b.url : a.kind === "folder" && b.kind === "folder" ? a.path === b.path : false);

/** Why a kind that makes a workspace some other way has no copy of a folder to make. Nothing a person types
 * reaches it: the create reads the kind table first, so this is the wiring's own sentence. */
export const kindMakesNoCopy = (kind: string): string => `a ${kind} workspace is not a copy of a folder on this computer`;

/** What a workspace on a project here is refused with when the host wired no copy road: the daemon binary is what
 * copies, every workspace here is a copy, and a host that cannot find the binary makes none. */
export const NO_COPIER_HERE = "this host has no copy road for a folder on this computer, and every workspace here is a copy of one; stage this wsp's daemon binary and try again";

/** The size above which a folder is not directory-cloned and the copy takes the worktree road instead. Twenty
 * gibibytes is well past the biggest checkout measured here (6 GB with its dependencies) and short of a folder
 * somebody would be surprised to see doubled. One place, so it is one line to change. */
export const COPY_SIZE_LINE_BYTES = 20 * 1024 * 1024 * 1024;

/** Why a host will not serve a state file written before a workspace named its project: nothing reads the old
 * shape, so the file is moved aside by hand and this host starts empty. Where the file says which build wrote it,
 * the build is named first: several wsps share one state file on a computer, and a record another build wrote in
 * its own shape is that build's to put right, not a reason to throw away every project and workspace on the file. */
export const wipeTheState = (workspaceId: string, statePath: string | undefined, wrote?: StateShape): string =>
  `workspace ${workspaceId} was recorded before a workspace held a project, and nothing reads that shape: ` +
  (wrote !== undefined ? `${statePath ?? "this host's state file"} was last written by ${stateWriterWords(wrote)}, so run that wsp on it, or ` : "") +
  `move ${wrote !== undefined ? "the file" : (statePath ?? "this host's state file")} aside and start again, and wsp add records your projects on the new one`;

/** The last line a command said, which is what git puts its reason on. */
const lastLineOf = (said: string): string => said.trimEnd().split("\n").at(-1)?.trim() ?? "";
/** How the import's done line reads each agent's outcome, after the agent's name. */
const OUTCOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed but not yet in its session list",
  carried: "carried unchanged since it is not on the machine",
  nothing: "had nothing to carry",
};
function outcomeWords(a: ProjectAgentResult): string {
  if (a.outcome === "failed") return `failed: ${a.error ?? "no reason given"}`;
  const word = OUTCOME_WORDS[a.outcome];
  const note = a.note !== undefined ? ` (${a.note})` : "";
  if (a.outcome === "moved" && a.rows !== undefined) return `${word}, ${a.rows > 0 ? `${plural(a.rows, "row")} merged` : "its rows already there"}${note}`;
  if (a.outcome === "transcript-only") return `${word}${note}`;
  return word;
}
/** Bounds a merge that hangs; one project's rows take python3 well under it. */
const MERGE_DEADLINE_MS = 120_000;
/** Bounds a listing that hangs; walking the agents' homes takes python3 well under it, and past what one inline exec is allowed to run. */
const LISTING_DEADLINE_MS = 120_000;

/** Runs one agent's merge script on the machine and folds what it printed into the agent's result: rows merged is
 * moved, a store not there yet leaves the rows waiting with the reason, a failure carries the last line of stderr.
 * The script is removed by its own exec once the run ended, so a run the deadline killed leaves nothing behind. */
async function mergeOnMachine(machine: Machine, script: string, agent: ProjectAgentResult): Promise<ProjectAgentResult> {
  const dir = script.slice(0, script.lastIndexOf("/"));
  let run: ExecResult;
  try {
    run = await machine.run(`python3 ${shellQuote(script)}`, { deadlineMs: MERGE_DEADLINE_MS });
  } finally {
    await machine.exec(`rm -f ${shellQuote(script)}; rmdir ${shellQuote(dir)} 2>/dev/null`).catch(() => undefined);
  }
  if (run.exitCode !== 0) {
    const why = run.stderr.trimEnd().split("\n").at(-1) || "no output";
    return { ...agent, outcome: "failed", error: `the merge on the machine failed (exit ${run.exitCode}): ${why}` };
  }
  try {
    const out = parseMergeOutput(run.stdout);
    if ("waiting" in out) return { ...agent, note: out.waiting };
    return { ...agent, outcome: "moved", rows: out.merged, ...(out.note !== undefined ? { note: out.note } : {}) };
  } catch (e) {
    return { ...agent, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The same for the export's done line, where the state lands on this computer; `carried` cannot happen here. */
const HOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed but not yet in its session list here",
  carried: "carried unchanged",
  nothing: "had nothing to bring",
};

/** One agent's export outcome in words: the name, the sessions counted, what became of them, the rollouts skipped. */
function homeOutcome(a: LandedAgent): string {
  const counted = a.sessions === undefined ? "" : ` (${plural(a.sessions, "session")})`;
  const skipped = a.skipped === undefined || a.skipped === 0 ? "" : `, ${plural(a.skipped, "indexed rollout")} not under sessions/ skipped`;
  return `${a.name}${counted} ${a.outcome === "failed" ? `failed: ${a.error ?? "no reason given"}` : HOME_WORDS[a.outcome]}${skipped}`;
}

/** Vite's and Next's refusals fit in a few hundred bytes; a page that loaded fine is not carried back whole. */
export const PORT_PROBE_BODY_CAP = 2048;
const VAULT_CAP_BYTES = 200 * 1024 * 1024;
/** Blob collection: the latest nap-time vault per workspace id. */
const VAULTS = "vaults";

/** What `until` rejects with when the deadline passed and not the promise, so a caller that retries can tell the
 * two apart. */
class DeadlineError extends Error {}

/** Rejects once the deadline passes; the underlying promise is left to settle on its own. The deadline is read on
 * the clock given, so a move budget measured on an injected clock times out on that clock. */
function until<T>(p: Promise<T>, deadline: number, what: string, clock: Clock = realClock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ms = Math.max(0, deadline - clock.now());
    const cancel = clock.schedule(() => reject(new DeadlineError(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      v => { cancel(); resolve(v); },
      e => { cancel(); reject(e); },
    );
  });
}

/** Size fields the provider reports that differ from what was created, as
 * "field got != expected". createdAt is left out on purpose: Solari moves it
 * to the resume time on every resume, healthy ones included (measured 3/3
 * with exec answering right after), so it only rides along in the reason. */
function shapeFault(expected: MachineShape, actual: MachineShape): string | undefined {
  const diffs: string[] = [];
  for (const key of ["cpu", "memMb"] as const) {
    const want = expected[key];
    const got = actual[key];
    if (want !== undefined && got !== undefined && want !== got) diffs.push(`${key} ${got} != ${want}`);
  }
  return diffs.length === 0 ? undefined : diffs.join(", ");
}

/** Dirs the golden image already provides on every fresh fork; re-vaulting
 * them is dead weight, and extracting them with --recursive-unlink would
 * delete the fork's own copies first (the image's uv, pipx and pnpm installs live in .local). */
const VAULT_SKIP = new Set([".local", ".cache", ".npm"]);

/** One RFC 1123 label: lowercase alphanumerics and hyphens, at most 63 chars, hyphen-free at both ends. */
function hostnameFor(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return label === "" ? "wsp" : label;
}

/** A fresh fork boots as "localhost"; naming it is cosmetic, so a guest that refuses is only logged. Hands back the
 * name set, or the refusal. */
async function setHostname(machine: Machine, name: string): Promise<{ host: string; refused?: string }> {
  const host = hostnameFor(name);
  const res = await machine
    .exec(`hostname ${host} && echo ${host} > /etc/hostname`)
    .catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
  if (res.exitCode === 0) return { host };
  const refused = `hostname ${host} on ${machine.id} failed: ${res.stderr.trim()}`;
  console.warn(refused);
  return { host, refused };
}

export interface GoldenBuildRequest extends Omit<BuildGoldenOptions, "backend" | "manifest" | "hostId"> {
  /** Store key; several goldens can coexist. */
  name?: string;
}

/** One version the promote road visited: recorded with the template promoted for it, with how many templates
 * already carried the name when the listing was given, or left as it was with the reason, a lost snapshot in the
 * row's own words. */
export type GoldenPromotion = { golden: string; version: number } & ({ templateId: string; sharing?: number } | { error: string });

export interface GoldenUpgradeResult {
  manifest: GoldenManifest;
  version: GoldenVersion;
  /** builder: the delta went onto the builder kept since the save; fork: onto a fresh fork of the previous head. */
  road: "builder" | "fork";
  /** The previous version's snapshot was deleted and the version dropped from the manifest. */
  previousDropped: boolean;
  /** The builder is still running for its window; false when the cap fallback or a drop ended it. */
  builderKept: boolean;
}

/** How long a builder built from a recipe stays running after its seal, so one more change re-snapshots it (about
 * 11 s, measured) instead of forking. Our clock on the record, since every read of the machine resets the provider's. */
export const GRACE_MS = 10 * 60_000;

/** How long after one attempt to put a daemon back on a machine before another. A deploy that failed fails the
 * same way fifteen seconds later and the row has already said so, so the retry is slow enough to be worth
 * watching and quick enough that a machine whose npm registry blinked is not left dark for an hour. */
export const DAEMON_REVIVE_AGAIN_MS = 5 * 60_000;

/** How long a machine that answered with what it lacks is left alone before a daemon is offered to it again. Far
 * wider than the revive window because nothing this host does moves it: a compiler or a lingering login is a
 * person's to put on their own machine, and until they do, every attempt spends a round trip to be told the same
 * sentence. Read across host starts, since the refusal is on the record. */
export const DAEMON_LACKS_AGAIN_MS = 60 * 60_000;

/** A machine of this setup's the sweep found with no record and recorded again, under the id and name its fork stamped. */
export interface AdoptedMachine {
  id: string;
  workspaceId: string;
  name: string;
  phase: WorkspacePhase;
}

/** What one sweep did: the engine's kills and sparings, plus the machines it recorded rather than killed. */
export interface SweepResult extends ReapResult {
  adopted?: AdoptedMachine[];
}

/** The status tracker as the runtime serves it: the tracker's own surface, with the caller's origin last on the two
 * reads that answer for workspaces, so the snapshot leaves out what that caller may not drive. */
export interface OriginStatusApi extends Omit<StatusApi, "list" | "history"> {
  list(opts?: StatusListOptions, origin?: Caller): Promise<WorkspaceStatus[]>;
  history(workspaceId: string, origin?: Caller): Promise<WorkspaceCostEvent[]>;
}

export interface Runtime {
  readonly events: EventBus;
  readonly backend: MachineBackend;
  /** The places this host holds, when one wired them: the handshake a joining computer takes, the links it keeps
   * and what a remove sweeps. Absent on a runtime wired without them. */
  readonly places?: PlaceDoor;
  /** One channel to the daemon of the computer this host runs on, the one its local workspace dials, for a terminal
   * that belongs to this computer rather than to a workspace on it. */
  hereChannel(onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel>;
  /** The agents, skills and MCP servers on one computer or workspace, read as that computer's login. A napping
   * workspace answers the last report read while it ran and is never woken for this. */
  readonly agents: {
    read(target: AgentsTarget, origin?: Caller): Promise<AgentsReport>;
    /** One MCP server there, started or asked once for its tools on the person's ask; a napping workspace is refused. */
    tools(target: AgentsTarget, ask: { agent: string; name: string; refresh?: boolean }, origin?: Caller): Promise<ServerToolsAnswer>;
    /** Runs an agent's sign-in, or one server's, in a watched pty there, or joins the one already running for that
     * agent or server there; each step goes to `emit` and to nobody outside the sign-in, and `leave` stops following
     * it, which ends it once nobody follows it. A napping workspace is refused. */
    signIn(target: AgentsTarget, ask: SignInAsk, emit: (event: AgentsSignInEvent) => void, origin?: Caller): Promise<{ signInId: string; leave(): void }>;
    /** Types what a page handed back into that sign-in's pty. */
    signInCode(signInId: string, code: string): Promise<void>;
    /** Ends that sign-in and kills its pty, for everyone following it. */
    signInStop(signInId: string): void;
    /** The sign-in as the line the person's own terminal runs there. */
    signInLine(target: AgentsTarget, ask: SignInAsk, origin?: Caller): Promise<SignInLine>;
    /** Writes an agent's token or key into this host's vault. */
    key(agent: string, key: string): Promise<void>;
    /** Writes the wsp server into that agent's own config on this computer. */
    addTools(target: AgentsTarget, agent: string, origin?: Caller): Promise<{ file: string }>;
    /** Hands every sign-in from here on the host relay's callback forward to its target; the return takes it back. */
    forwards(relay: CallbackForwards): () => void;
    /** skills.sh searched by this host, the only caller of it. */
    skillsSearch(q: string, limit?: number): Promise<SkillHit[]>;
    /** A skill's SKILL.md off skills.sh, nothing installed. */
    skillsGet(skill: string): Promise<SkillPreview>;
    /** One skill's SKILL.md there, its first part and its size. */
    skillsPreview(target: AgentsTarget, ask: SkillAsk, origin?: Caller): Promise<SkillPreview>;
    /** A skill off skills.sh put there, checked whole before it lands and run never. */
    skillsAdd(target: AgentsTarget, ask: { skill: string; agents?: readonly string[]; project?: boolean }, origin?: Caller): Promise<SkillAdded>;
    /** Every folder of a skill there and every link to it, gone. */
    skillsRemove(target: AgentsTarget, ask: SkillAsk, origin?: Caller): Promise<{ removed: string[] }>;
    /** A skill turned off or on there, by the rename of its SKILL.md. */
    skillsToggle(target: AgentsTarget, ask: SkillAsk & { on: boolean }, origin?: Caller): Promise<{ paths: string[] }>;
    /** One MCP server written into an agent's config there: its values into that file on this computer, and on any
     * other the file names a variable for each and the value goes to the vault. */
    serversAdd(target: AgentsTarget, ask: ServerAdd, origin?: Caller): Promise<{ file: string }>;
    /** One server's entry taken out of an agent's config there, every other line as it was. */
    serversRemove(target: AgentsTarget, ask: ServerAsk, origin?: Caller): Promise<{ file: string }>;
    /** One server turned off or on there by the switch its agent reads. */
    serversToggle(target: AgentsTarget, ask: ServerAsk & { on: boolean }, origin?: Caller): Promise<{ file: string }>;
    /** A remote server's icon as a data url, asked of Google by this host only while the person's switch is on. */
    serversIcon(host: string, refresh?: boolean): Promise<string | null>;
  };
  /** Every verb takes where the request reached the host from as its last argument: here, this computer's own app,
   * CLI or MCP, or relayed from a machine. Absent reads here. A workspace whose kind takes no relayed request
   * refuses one with the one sentence, and the lists that serve workspaces leave it out for that caller. */
  readonly workspaces: {
    create(opts: CreateWorkspaceOptions, origin?: Caller): Promise<CreatedWorkspace>;
    /** Where a workspace of this project would land and what that computer offers, gated as a create is; `place` is
     * absent where the landing is this computer or the provider this host forks on. Read ahead of a create so the
     * refusal for a computer that forks nothing comes in one sentence before any stage is streamed. */
    landing(o: { project: string }, origin?: Caller): Promise<{ place?: string; name: string; capabilities: Capabilities }>;
    get(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Every workspace this host holds, less the ones the caller's origin may not drive. */
    list(origin?: Caller): Promise<WorkspaceView[]>;
    /** The workspace a name or an id names, off the reading list() serves: every verb that takes a workspace from a
     * person or an agent comes through here, so what the listing shows and what a verb accepts are one thing. A name
     * nothing here carries is refused as absent, and one the caller may not drive with the sentence of the rule that
     * hides it rather than as missing. */
    resolve(ref: string, origin?: Caller): Promise<WorkspaceView>;
    nap(id: string, origin?: Caller): Promise<WorkspaceView>;
    wake(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Stops a wake that is asking the provider again on its own, and answers with the record it leaves behind. The
     * wake itself ends with WAKE_STOPPED; a workspace with no wake in flight is answered with as it stands. */
    stopWake(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Replaces the workspace's machine with a fresh fork of the image behind it, its vaulted files carried over. */
    upgrade(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Moves the workspace onto its golden's head version, carrying its files across. Refused in one sentence when
     * the machine is not running, the image is a project golden, or no golden knows the image; a workspace past
     * those and already on the head is returned untouched. */
    updateImage(id: string, origin?: Caller): Promise<UpgradeResult>;
    /** Fresh golden fork with the nap-time vault, old machine killed, id and name kept: the way out of a zombie. */
    rebuild(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Starts another daemon for a workspace whose daemon this host holds the process of, in place of one that is
     * not running. Refused in one sentence for every kind whose daemon lives on a machine instead. */
    restartDaemon(id: string, origin?: Caller): Promise<void>;
    /** Names the workspace, under the rules a fork's name takes: the space around the name is dropped, and a name
     * another workspace holds, one a fork is landing under and a blank one are refused (kind conflict) naming the
     * holder. A name the workspace already carries answers with the record untouched. The record alone changes, so
     * this goes out as workspace.renamed and never as workspace.created, which the awake meter and the auto-nap
     * window read as the machine coming up. Threads on the machine are addressed by id and run on through it. The
     * machine's own metadata keeps the name it was forked under, since the provider takes metadata at create and
     * its API offers no update; the next fork or rebuild stamps the new one, and the name is kept here beside the
     * records so a sweep that records this machine after the store lost its workspace document restores it under
     * the name a person gave rather than the fork's. */
    rename(id: string, name: string, origin?: Caller): Promise<WorkspaceView>;
    /** The theme and the glyph a person gave this workspace. A key left out keeps that fact as it is and null
     * clears it, so the colour picker and the icon picker each send their own without reading the other's. The record
     * alone changes and the machine is untouched, so this goes out as workspace.look. */
    look(id: string, look: WorkspaceLook, origin?: Caller): Promise<WorkspaceView>;
    /** Snapshots the running machine as a project golden: the golden it stands on plus the project as it is now, so a
     * fork of the snapshot starts a task with the project in place. Refused in one sentence when the workspace is not
     * running or holds no project; a machine that was ever resumed is refused by the engine (kind notFirstLife). The
     * guest freezes for about three seconds and stays first-life. */
    snapshot(id: string, origin?: Caller): Promise<ProjectGolden>;
    /** The recipe's daemon deploy on the running machine, replacing the daemon there, then this runtime's token
     * written again so the next reach opens it. The runtime runs it by itself when a machine's daemon is older than
     * this wsp. Throws on a workspace that is not running or a runtime without the deploy. */
    updateDaemon(id: string, origin?: Caller): Promise<void>;
    /** Turns the workspace's agents switch on or off and names its caps; a key left out keeps what the record holds.
     * Never a thread's own act: what agents may do is the person's to decide. */
    agents(id: string, patch: Partial<WorkspaceAgents>, origin?: Caller): Promise<WorkspaceView>;
    delete(id: string, origin?: Caller): Promise<void>;
    /** Drops a workspace whose machine the provider no longer has: its record, transcripts and sessions go and nothing
     * is asked of the provider. Refused with the reason (kind conflict) while the machine still exists. */
    forget(id: string, origin?: Caller): Promise<void>;
    /** A person acted in the workspace; its idle window starts over. */
    touch(id: string, origin?: Caller): Promise<void>;
    /** One-shot command on the workspace's machine (plumbing for clients; sessions are the main road). */
    exec(id: string, cmd: string, opts?: { timeoutMs?: number }, origin?: Caller): Promise<ExecResult>;
    /** The command, word by word, launched the way a harness turn is: detached on the machine, each word quoted for
     * its shell, exported with what the default harness's turns get, its output streamed by line, its exit code at
     * the end; in cwd when given, else the folder the workspace's kind names, as a harness turn does. The stream
     * carries that folder back as `ranIn`, so a client says where the command ran rather than restating the rule.
     * Rejects when the workspace or that harness's adapter is unknown; a launch that fails ends the stream. */
    execStream(id: string, argv: ReadonlyArray<string>, cwd?: string, origin?: Caller): Promise<RunningExec>;
    /** Pushes the branch this workspace's copy is on and opens or finds its pull request against the base. The
     * base is the branch its parent was on at the fork for a child, read off the child's own record and never off
     * the parent again, and the project's own base otherwise; the base branch itself is refused: work leaves a
     * workspace as a branch of its own. A machine with no signed-in command line for the git host still pushes,
     * and says why the pull request waits as the result's note. */
    bringBack(o: { workspaceId: string; title?: string; body?: string }, origin?: Caller): Promise<BringBackResult>;
    /** How a browser dials this workspace's daemon; throws on backends without preview URLs. */
    daemonReach(id: string, origin?: Caller): Promise<DaemonReachView>;
    /** One channel to the daemon answering for this workspace, frame by frame, with every event that daemon
     * pushes for it: the dial of its own daemon where it runs one, and the link of the computer holding it where
     * that computer answers for it. The one reading of how a workspace's daemon is reached, so the pane's road
     * and the runtime's own cannot disagree about which road a workspace is on. */
    daemonChannel(id: string, onEvent: (event: Record<string, unknown>) => void, origin?: Caller): Promise<DaemonChannel>;
    /** The same channel for the host's own guest road, which also answers the guest sessions that daemon relays. A
     * client of this host is never handed one. */
    guestChannel(id: string, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel>;
    /** Whether the computer holding this workspace answers its daemon frames, which is what a road that would
     * otherwise dial reads first: a workspace on a computer somebody owns runs no daemon of its own. */
    servedByItsComputer(id: string, origin?: Caller): Promise<boolean>;
    /** This workspace's own utilisation, pushed to the listener every poll tick until the returned detach runs.
     * Refused for a kind whose Live rows are read off its machine's daemon, which a pane asks over its own link:
     * the kind table says which is which, so neither side decides it for itself. */
    watchSys(id: string, fn: (s: SysSample) => void, origin?: Caller): Promise<() => void>;
    /** The public route to one guest port, for a browser to frame; same caching and refusal as daemonReach. */
    portReach(id: string, port: number, origin?: Caller): Promise<PortReachView>;
    /** One fetch of that route from here, as the frame would see it, redirects unfollowed; rejects when nothing answers at
     * all. A 401 is the edge refusing the token, so the port's route is reminted before the reply and the next portReach
     * carries the fresh one. */
    portProbe(id: string, port: number, origin?: Caller): Promise<PortProbeView>;
    /** The same rule every verb above reads, as a sentence, for the rows and the roads the runtime does not own
     * itself: the host's port forwards, which it lists and stops by the id of their target. Answers the sentence to
     * refuse this request with, or nothing when it may drive that workspace; a target no record here names, as a
     * builder whose ports the host forwards is, is nobody's to hide or refuse for. */
    originRefusal(id: string, origin?: Caller): Promise<string | undefined>;
    /** Whether one event off the bus is this caller's to see: the same rule read without asking anything, for the
     * one road that cannot await, where a per event promise would sit in the path every delta of every turn takes.
     * A workspace this host does not hold is nobody's to refuse for, as the sentence has it, unless the caller is a
     * thread: a thread sees its own tree, and an id no record answers for is not in it, which is what a fork still
     * landing under somebody else is. An event naming the thread it was asked for by is that thread's and its
     * tree's whatever the records say, which is what a fork's own stages are before its record exists. */
    seenBy(event: unknown, origin?: Caller): boolean;
  };
  readonly projects: {
    /** Records a project: the word a person typed, which is a folder on this computer or a repo a computer clones,
     * and the computer it lives on. Refused when the word is neither, when the computer's kind takes no source of
     * that shape, and when that source is already a project on that computer. */
    add(opts: { source: string; on?: string; name?: string; base?: string; seed?: SeedChoice }, origin?: Caller): Promise<ProjectView & { notice?: string }>;
    /** What a seed of a folder on this computer would carry, with the ticks a remembered choice for that folder
     * leaves on it. Nothing of the folder is read whole and nothing leaves this computer. */
    seedPlan(source: string): Promise<SeedPlan>;
    /** Every project this host holds, oldest first. */
    list(origin?: Caller): Promise<ProjectView[]>;
    /** The computers a project can live on, by the id and the name each carries in the places table: what `add`
     * resolves `on` against, read here so a caller names one rather than guessing at the refusal. */
    computers(): Promise<{ id: string; name: string }[]>;
    /** The project a word names, by id or by name; refused naming the ones there are. */
    resolve(ref: string, origin?: Caller): Promise<ProjectView>;
    /** Drops a project's record and whatever the add made for it on the computer holding it, with the one
     * sentence the person reads for that computer; refused while a workspace of it stands, naming them. */
    remove(id: string, origin?: Caller): Promise<{ said: string }>;
    /** Lands the host's bundle of a folder on the workspace's machine; progress rides project.import events. */
    import(opts: ProjectImportOptions, origin?: Caller): Promise<ProjectImportResult>;
    /** Brings a folder and the agent state keyed to it home from the workspace's machine; progress rides project.export events. */
    export(opts: ProjectExportOptions, origin?: Caller): Promise<ProjectExportResult>;
  };
  readonly sessions: {
    /** Starts a turn; never a second one on a session whose turn is running. A start on a thread whose turn runs
     * steers the message into it when the harness steers (the handle is the running turn's, outcome steered), else
     * waits for the turn to end and then starts (outcome queued), several such starts one after another in order. */
    start(
      workspaceId: string,
      opts: {
        prompt: string;
        harness?: string;
        resume?: string;
        /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness
         * never announced a session (a launch that never reached the machine) takes the message as a first turn on
         * that same thread. Rejects when no thread on the workspace has that id. */
        thread?: string;
        /** The folder the thread starts in, absolute; it wins over project and the default folder rule. */
        cwd?: string;
        model?: string;
        effort?: string;
        permissionMode?: string;
        contextWindow?: string;
        /** Absent means a person asked. */
        startedBy?: SessionOrigin;
        /** The client's id for this send, stamped on the turn's session.start as sent. */
        requestId?: string;
        /** Who the end of every turn on the thread this start opens is told, each a thread id or NOTIFY_ME: the line
         * (notifyLine) goes into each named thread through this same start, and for me it is recorded for the person.
         * A start that resumes a thread keeps what the thread had. Rejects when a target names no thread, and rejects
         * when one names the thread this start opens. */
        notify?: readonly string[];
        /** The TURN_TOKEN_ENV of the turn this request came out of, when it came out of one, off the client's own
         * environment: what NOTIFY_ME is read against, so a thread names itself without knowing its own id. Rejects
         * when no turn here carries it. */
        turnToken?: string;
        /** The name the thread takes as a person's: it stands from the first second, the harness is told it too, and
         * no generated title ever replaces it. Rejects on a blank one. */
        title?: string;
        /** The images the message carries. Rejects over the caps, and rejects naming the agent when that agent's
         * adapter reads no image, both before the machine is asked for anything. */
        attachments?: readonly ImageAttachment[];
        /** MCP servers the thread this start opens gets besides the ones the harness's own config names, by the name
         * each takes in a config: what a caller that needs a tool loaded whatever the person's config says hands
         * over (the cloud setup's own thread, which calls the wsp recipe tools). */
        mcpServers?: Readonly<Record<string, McpServerSpec>>;
      },
      origin?: Caller,
    ): Promise<SessionHandle>;
    /** Every turn this state file knows, the ones before a restart as they were last written. One that was still
     * running then reads running while its machine still holds its run, since the run is re-opened at load and goes
     * on to its reply; one whose run no machine has left reads failed. */
    list(workspaceId?: string, origin?: Caller): Promise<SessionView[]>;
    /** The workspace's persisted session events, oldest first; a chat replays these on mount. */
    history(workspaceId: string, origin?: Caller): Promise<SessionEvent[]>;
    /** Stops the session's running turn through its harness; a turn already over or an unknown id answers, never throws. */
    interrupt(sessionId: string, origin?: Caller): Promise<SessionInterruptResult>;
    /** Sends a message into the session's running turn through its harness and records it as session.steer once the
     * harness took it; a turn already over, a harness without steer or an unknown id answers. Refuses like start
     * while the workspace is pausing or paused. */
    steer(sessionId: string, opts: { prompt: string; requestId?: string }, origin?: Caller): Promise<SessionSteerResult>;
    /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's own id and one
     * of the options it carried; the tool call it blocks then runs or is refused, and a session.permission.closed
     * event records which option did it. A prompt already answered, one the harness withdrew and an unknown id
     * answer rather than throw, since two clients may reach one prompt. */
    answer(sessionId: string, opts: { askId: string; optionId: string }, origin?: Caller): Promise<SessionAnswerResult>;
    /** Puts the session's thread at another access mode: the one road that changes a thread's access, since a send
     * into a thread names none. The thread's record takes the mode and its next turn runs at it; where a turn is
     * running and its harness takes such a change, the turn in front of the person follows it from its next tool
     * call on. unsupported is a running turn that takes none mid-turn and keeps its mode, the next turn taking the
     * pick. The session named is any row of the thread; a thread between turns answers set. */
    access(sessionId: string, permissionMode: string, origin?: Caller): Promise<SessionAccessResult>;
    /** Names the session's harness session in the harness's own store, in the field the harness itself writes, and
     * keeps the name on every row of the thread; a harness that keeps no name of a person's, a store without that
     * session and an unknown id answer. Refuses while the workspace cannot be reached, as a listing's read needs it. */
    rename(sessionId: string, title: string, origin?: Caller): Promise<SessionRenameResult>;
    /** Drops a thread no turn ever ran on, the row a launch that never got going leaves: its rows and its
     * transcript rows go and nothing is asked of the machine. Takes the runtime's thread id, not a session id.
     * Refused (kind conflict) with threadForgetRefusal's sentence once a turn of it did work, which threadRan
     * decides: a turn the agent refused did none, however far its launch got. A thread of another tree reads the
     * absence a name nothing holds reads, before any of that. */
    forget(threadId: string, origin?: Caller): Promise<void>;
  };
  readonly harnesses: {
    /** What each harness with an adapter takes at launch; the composer's pickers render from this. With a running
     * workspace each adapter that probes is asked on its machine, at a session start too, and its answer, or the table
     * when it gives none, is kept per machine and harness for CATALOG_TTL_MS; without one, or on a workspace that is not
     * running, the table answers. */
    list(workspaceId?: string, origin?: Caller): Promise<HarnessCatalog[]>;
  };
  readonly golden: {
    build(opts: GoldenBuildRequest): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    /** The manifest at the place the image's own seal stands: the versions wsp init built and updates there. */
    get(name?: string): Promise<GoldenManifest | undefined>;
    /** Where an image build goes: the image's own place once a record stands, whatever `word` says; before that,
     * the place `word` names, by the name or id wsp places lists, else the default place, else the one other place
     * that runs workspaces. Answers the id its copies are filed under, the name a person
     * reads and the backend a builder there is made on. Refused with the place's own reason where it runs none, with
     * NO_BUILD_PLACE_LINE where no place here does, and with buildPlaceAskLine where more than one does and none is the
     * default. */
    buildPlace(word?: string): Promise<{ place: string; name: string; backend: MachineBackend }>;
    /** Boots a first-life builder from the recipe; a person sets it up on its live screen, then seals it.
     * Once `signal` aborts the call rejects with PrepareStoppedError: a machine this prepare made is killed by its
     * recorded id and its record dropped (a create still in flight is killed as it lands); a builder it attached to
     * keeps the seal in it, its hold is released and its record stays reusable. `place` is where the builder is
     * made, a joined computer or a provider by name or id; absent is the provider this host forks on. `copy` marks a
     * copy's build, whose frames name the place; the image's own build names none, wherever it runs, which is how
     * the app tells the two apart. */
    prepare(opts?: { name?: string; kind?: MachineKind; signal?: AbortSignal; recipe?: GoldenRecipe; place?: string; copy?: boolean }): Promise<GoldenBuilderView>;
    /** Snapshot, smoke-fork, append a version. A builder built from a recipe is kept running for GRACE_MS after a
     * successful seal so one more change re-snapshots it; any other builder, and every failed or refused seal, consumes
     * it, except a snapshot the provider refused: that builder is left as it was and stays recorded for the next init
     * to attach to while the provider still has it (SnapshotFailedError says which). keepBuilder false ends it with
     * the seal instead: a caller with no process left to end the window would otherwise leave it billing until the
     * next host sweeps it. logins: what each sign-in asked of the builder came to, stamped on the version. */
    seal(builderId: string, opts?: { logins?: GoldenLogin[]; keepBuilder?: boolean }): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    /** The recipe the golden's head was built from, or nothing when it was not built from one. */
    recipe(name?: string): Promise<RecipeDigest | undefined>;
    /** The next version from the recipe delta: on the builder kept since the save when there is one, else on a
     * fresh fork of the head. Seals it, repoints the head, and drops the previous version's snapshot when asked. */
    upgrade(opts: { name?: string; delta: GoldenDelta; keepPrevious?: boolean; logins?: GoldenLogin[]; recipe?: GoldenRecipe }): Promise<GoldenUpgradeResult>;
    /** How a browser dials the builder's daemon; the builder is not a workspace, so it has its own road. */
    builderReach(builderId: string): Promise<DaemonReachView>;
    builders(): Promise<GoldenBuilderView[]>;
    /** Stops a builder of this setup by its recorded id and drops the record; one another live process holds or another setup owns is refused. */
    kill(builderId: string): Promise<void>;
    /** Moves the golden's head; new forks follow it, workspaces already forked keep their image. */
    rollback(version: number, name?: string): Promise<GoldenManifest>;
    /** Makes every version of the golden durable: one with no template gets a fresh promotion of its snapshot and
     * forks boot from it from then on; one whose snapshot the provider has lost is a row saying so and nothing is
     * written. Undefined on a backend without templates; empty when every version already has one. */
    promote(name?: string): Promise<GoldenPromotion[] | undefined>;
    /** Every project golden this runtime took, oldest first. */
    projects(): Promise<ProjectGolden[]>;
    /** Deletes a project golden's snapshot at the provider of its place and drops the record once the listing reads
     * it gone, or at once where the provider already lost it. Refused while any workspace stands on it; a refusal
     * of the provider's, or a listing that holds the id through the read-back window, keeps the record. */
    removeProject(snapshotId: string): Promise<ProjectGoldenRemoved>;
    /** Every snapshot on the account by count, size and monthly cost past the free GB, sized from the provider's
     * listing and split by who made each one; undefined on a backend that cannot list snapshots. */
    storage(): Promise<SnapshotStorage | undefined>;
    /** The snapshots and templates this host made that nothing here records, and the rows left alone beside them;
     * undefined on a backend that cannot list snapshots. */
    orphans(): Promise<AccountOrphans | undefined>;
    /** Deletes what orphans() names, each orphan template before the snapshots (the provider refuses to delete a
     * snapshot a template stands on). The split is read again first, so nothing recorded since is touched, and
     * nothing without this host's mark is ever passed to a delete. */
    deleteOrphans(): Promise<OrphansDeleted | undefined>;
    /** The golden's ancestors older than its head and the head's parent, with what deleting them frees, minus every
     * version a workspace of this runtime was forked from; undefined with no golden or no snapshot listing. */
    retention(name?: string): Promise<RetentionPlan | undefined>;
    /** Deletes the snapshots retention offers and drops those versions and their recipes from the manifest. The plan
     * is read again first, so a workspace forked since the offer keeps its version; a delete the provider refuses
     * keeps the version and is reported by version. */
    prune(name?: string): Promise<{ dropped: GoldenVersion[]; failed: { version: number; message: string }[] }>;
  };
  /** The image this host owns, as against the copy each place holds of it. */
  readonly image: {
    get(name?: string): Promise<SealedImageView>;
    /** The vault bytes and the record, for the host to seal and write; refused when the record holds no vault. */
    vault(name?: string): Promise<{ image: SealedImage; tar: Buffer }>;
    /** Prepares a builder at `place` from the recipe `copyRecipe` composes off the record (every login set to skip),
     * lands the record's vault on it and seals; the copy is recorded under that place at the record's hash. The
     * recipe is asked for only once every refusal has passed, so the host composes nothing for a build that cannot
     * run. A place already holding a copy of this record is answered with that copy and builds nothing; a place
     * whose copy is building is answered with that build, joined, never a second one. Any place wsp places lists
     * takes it, a joined computer by name or id included. Refused when the place builds no copy at all, when the
     * record has no small recipe to build from, and, without `force`, when it holds no vault. Progress rides
     * golden.stage frames carrying the place's id, and the place's row reads them. */
    build(o: { place: string; name?: string; force?: boolean; signal?: AbortSignal; starting?: () => void }): Promise<SealedImageBuilt>;
    /** Brings a joined computer's copy up to the record at the end of its setup: nothing where this host holds no
     * image, where the place runs no workspaces or is not connected, or where its copy already stands on the
     * record; else the build, joined where one is running there, and built again where the record moved while it
     * ran. Never rejects: a build that stopped leaves its reason on the place's row until the next build there
     * takes the row over, which wsp image build or a fork there starts. Resolves once the copy stands or the build
     * stopped. */
    keepCurrent(place: string, name?: string): Promise<void>;
  };
  /** Enriched status (machine state, daemon reach, size, rate) + cost ticker; its list leaves out the workspaces the
   * caller's origin may not drive, as workspaces.list does. */
  readonly status: OriginStatusApi;
  /** The computers paired with this host and the one time codes that pair them, one collection each on this state
   * file, so a restart neither locks a paired computer out nor keeps a revoked one in. */
  readonly devices: DeviceDoor;
  /** The person's view preferences, one record on this state file, so the desktop app and a browser tab agree. */
  readonly preferences: {
    get(): Promise<Preferences>;
    /** The patch over the record; the record kept and pushed as preferences.changed to every socket. */
    set(patch: PreferencesPatch): Promise<{ preferences: Preferences; notice?: string }>;
  };
  /** This state file's owner id, stamped on every machine it creates: a machine wearing another one was made by
   * another host standing on the same account. Minted on the first read when the state file has none. */
  owner(): Promise<string>;
  /** Records this state file's workspace machines that no record claims, kills its builders and smoke forks that none
   * claims plus orphans past their backstop, and lists the running machines it left alone. `say` is where every
   * later line about a machine still being asked to stop goes, from this sweep on. */
  reap(olderThanMs?: number, say?: (line: string) => void): Promise<SweepResult>;
  /** Writes every transcript still waiting on its debounce; the store is complete once this resolves. */
  close(): Promise<void>;
}

/** What this host left on the account that nothing here records, and what it deliberately leaves alone beside it.
 * A snapshot carries no provider metadata, so a row is this host's only by the mark in its name; anything without
 * that mark is another host's or a person's and is named, never deleted. */
export interface AccountOrphans {
  snapshots: SnapshotRow[];
  templates: TemplateRow[];
  /** What the orphan snapshots hold, and what deleting them takes off the monthly bill once storage is billed. */
  freedBytes: number;
  savesUsdPerMonth: number;
  /** No mark of this host, so nothing here may touch them. */
  others: { snapshots: SnapshotRow[]; templates: TemplateRow[] };
}

export interface OrphansDeleted {
  snapshots: SnapshotRow[];
  templates: TemplateRow[];
  /** One per delete the provider refused; the row stays on the account. */
  failed: { id: string; name?: string; message: string }[];
}

const WORKSPACES = "workspaces";
/** The projects this host holds, by id: a computer, a source that computer can see and the branch a workspace of
 * it starts on. A workspace's record names one of these and nothing else about it. */
const PROJECTS = "projects";
/** The seed choice a person asked to be remembered, keyed by the folder on this computer it was made for: the next
 * add of that folder starts with those ticks rather than the catalog's own. */
const SEED_CHOICES = "seed-choices";
/** One manifest per place and golden name: a place's own built copy of the image, keyed `<place>/<name>`. A state
 * file written before places carries it under the bare name and the boot moves it under the wired place. */
const GOLDENS = "goldens";
/** The recipe each sealed version was built from, keyed `<place>/<name>@v<version>`; the next update diffs against the head's. */
const GOLDEN_RECIPES = "golden-recipes";
/** One document per project golden, keyed by its snapshot id. */
const PROJECT_GOLDENS = "project-goldens";
/** The image record the host owns, one per golden name; every copy is built from it. */
const IMAGES = "images";
/** The one refusal for a copy build on a runtime wired without a composer for its recipe. */
export const NO_COPY_RECIPE = "this runtime cannot compose the recipe a copy builds from; the host that serves the app wires one";
/** The one refusal for a seed on a runtime the host wired no folder reader into: nothing of the person's folder is
 * read or sent by a runtime that cannot show them the menu first. */
export const NO_SEED_WIRING = "this runtime cannot read a folder on this computer, so a folder cannot seed a project elsewhere; the host that serves the app wires the reader";

/** One blob per sealed version, `<name>@v<version>`: the vault as it was taken off that version's builder. */
const IMAGE_VAULTS = "image-vaults";
/** The one key rule for a place's copy of a golden, and for the recipe that copy was built from. */
export const copyKey = (place: string, name: string): string => `${place}/${name}`;
/** The same rule read back: the place and the golden a stored key names. A key from before places names no place,
 * and its copy is the wired one's, which only the caller knows the name of. */
const copyKeyParts = (key: string): { place?: string; name: string } => {
  const at = key.indexOf("/");
  return at === -1 ? { name: key } : { place: key.slice(0, at), name: key.slice(at + 1) };
};
const recipeKey = (name: string, version: number): string => `${name}@v${version}`;
const vaultKey = recipeKey;
const TRANSCRIPTS = "transcripts";
/** One document per workspace: the turns sessions.list serves, read back at boot so the rows outlive the process. */
const SESSIONS = "sessions";
/** The name a person gave a workspace, keyed by its id, which its machines carry as a label across every rebuild:
 * the sweep reads it when it records a machine whose workspace document this store lost, so a restored record keeps
 * that name rather than the one the fork stamped, which the provider takes at create and never updates. */
const WORKSPACE_NAMES = "workspace-names";
/** One record under one id: the person's view preferences. */
const PREFERENCES = "preferences";
const PREFERENCES_ID = "default";

/** What the timeline shows as the last row of a turn the runtime ended, not the harness. */
const PAUSED_REASON = "machine paused while the agent was working";
const DELETED_REASON = "machine deleted while the agent was working";
const RESTARTED_REASON = "host restarted while the agent was working";
const GONE_REASON = "machine gone at the provider while the agent was working";
/** The host log's one line for a workspace found gone, from the road and from the record load alike. */
const goneLogLine = (workspaceId: string, words: string): string => `workspace ${workspaceId} is gone: ${words}`;
/** The host log's one line for the runs a connecting host ended on a machine because no row of its own held them. */
const sweptRunsLogLine = (workspaceId: string, runs: readonly string[]): string =>
  `ended ${runs.length === 1 ? "1 harness run" : `${runs.length} harness runs`} on ${workspaceId} that no thread here holds: ${runs.join(", ")}`;
/** The host log's one line for a harness store that would not give a title, said once per session until a read
 * answers. */
const noTitleLogLine = (sessionId: string, workspaceId: string, words: string): string =>
  `no title for session ${sessionId.slice(0, 8)} on ${workspaceId}: ${words}`;
/** The host log's one line for a thread its harness would not name; the thread keeps its opening turn's words and
 * nothing asks again, so this is said once per thread. */
const noMadeTitleLogLine = (threadId: string, workspaceId: string, words: string): string =>
  `thread ${threadId.slice(0, 8)} on ${workspaceId} keeps its opening words: ${words}`;
/** The host log's one line for a name the harness's own store would not take: the thread carries the name here
 * whatever its harness did with it, so only the harness's own UI is out of step. */
const noNameWriteLogLine = (sessionId: string, workspaceId: string, words: string): string =>
  `the harness did not take the name for session ${sessionId.slice(0, 8)} on ${workspaceId}: ${words}`;
/** What a cut turn's parent hears: the row's own span, since no harness result reports one. */
const restartCutLine = (elapsedMs: number): string => `cut by a host restart after ${fmtDuration(elapsedMs, "clock")}`;
/** A guest with no daemon is asked again after this long (one may be deployed later). */
const DAEMON_TOKEN_MISS_TTL_MS = 60_000;
/** Events kept per workspace; the oldest fall off so one chatty workspace cannot grow the store forever. */
const TRANSCRIPT_CAP = 5000;
/** Index rows kept per workspace; the oldest finished rows fall off, a running one never does. */
const SESSION_INDEX_CAP = 200;
/** A turn boundary waits this long for more before the transcript is written; measured at one put per
 * event, 5000 events cost 4 s of memory-store clones and 6.6 s of file rewrites after the last turn. */
export const TRANSCRIPT_FLUSH_MS = 250;

/** What a restore needs about a workspace that no label on its machine carries: the name as a person set it here,
 * and the project the workspace was made for. Kept beside the workspace records, so a sweep that finds a machine
 * whose record this store lost can put the record back under the same name and the same project. */
interface NamedWorkspace {
  workspaceId: string;
  name: string;
  project?: string;
}

interface TranscriptRecord {
  workspaceId: string;
  events: SessionEvent[];
}

/** What a live turn knows beyond its row: the status of a reply that landed while its process still ran, absent
 * until the harness's result arrives and read by every road that ends the row before the process exits. */
interface TurnLive {
  reply?: TurnStatus;
}

/** A thread scope read back off the host's own session index: the shape the runtime minted, and nothing where the
 * document holds anything else, so a line delivered after a restart is never started under a caller nobody proved. */
function readScope(raw: unknown): ThreadScope | undefined {
  if (raw === undefined) return undefined;
  const read = ThreadScope.safeParse(raw);
  return read.success ? read.data : undefined;
}

/** The road those targets were registered from, read back the same way and for the same reason: a document
 * written before the road rode beside them carries none, and one carrying a word this protocol does not know
 * carries nothing, so a line delivered after a restart starts under no road nobody wrote. */
function readRoad(raw: unknown): WorkspaceOrigin | undefined {
  if (raw === undefined) return undefined;
  const read = WorkspaceOrigin.safeParse(raw);
  return read.success ? read.data : undefined;
}

/** A thread's own record: the agent it runs on and the access it is at, written at its first turn and moved by the
 * access verb alone. The rows are capped at SESSION_INDEX_CAP per workspace and the transcript at TRANSCRIPT_CAP
 * events, while a thread keeps its agent and its access for its whole life, so both are read here first and off
 * the rows only for a thread from before the record existed. */
interface ThreadRecord {
  harness: string;
  permissionMode?: string;
}

interface SessionIndexRecord {
  workspaceId: string;
  /** reply is the held status of a turn whose result landed while its process still ran, on a row still running;
   * run is where that turn is on its machine, so a host that comes back re-opens it rather than failing it, and
   * turnToken is what that surviving process still has in its environment, so the host that re-opens it can answer
   * for it. All three are written for a running row alone. */
  sessions: (SessionView & { turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; reply?: TurnStatus; run?: string; turnToken?: string; scopeDeviceId?: string })[];
  /** Every thread of the workspace by its runtime id; absent on a document from before threads had a record. */
  threads?: Record<string, ThreadRecord>;
}

/** Builders live apart from workspaces: never in the rail, and a record left
 * by a crashed wizard is exactly what reap() sweeps. */
const BUILDERS = "builders";
/** One id per state file, stamped on every machine it creates so another host's sweep can tell them apart from its own. */
const OWNER = "owner";
/** The create attempt in flight for a record, written before the provider hears of it. */
const CREATES = "creates";
/** The provider caps a key at 255 characters (measured 2026-09-04); the purpose is hashed past what a 16-hex nonce leaves. */
const KEY_PURPOSE_MAX = 255 - 17;
interface PendingCreate {
  key: string;
  createdAt: string;
  /** The request's fingerprint: a changed request is a new attempt, never a replay of the old one. */
  body: string;
  host: string;
  pid: number;
}

/** The spec minus what is minted per attempt, so the same request from two attempts reads the same. */
function fingerprint(spec: MachineSpec): string {
  const { idempotencyKey, labels, ...rest } = spec;
  const { [CREATED_AT_LABEL]: stamp, ...stamped } = labels ?? {};
  void idempotencyKey;
  void stamp;
  return createHash("sha256").update(JSON.stringify({ ...rest, labels: stamped })).digest("hex");
}
/** A holder's heartbeat older than this, or a holder whose pid is gone, no longer keeps a builder from another process. */
const HELD_TTL_MS = 15 * 60_000;
/** Own builders beat this often on their own timer, so a sweep stuck on a slow listing cannot starve the hold. */
const HEARTBEAT_MS = 5 * 60_000;

const isCapRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "concurrency";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

interface BuilderRecord {
  id: string;
  name: string;
  kind: MachineKind;
  baseTemplate: string;
  setupSha: string;
  createdAt: string;
  size: WorkspaceSize;
  streamUrl?: string;
  /** True from creation until the machine is ever paused, resumed or restored. Whether a builder that lost it can
   * still be sealed is the place's own rule, read off its backend (`snapshotsAnyLife`), never assumed here. */
  firstLife: boolean;
  /** The process using this builder: written at creation and attach, refreshed every sweep, cleared on close.
   * Another process over the same store leaves the record alone while the holder is alive and the heartbeat fresh. */
  heldBy?: { host: string; pid: number; heartbeat: string };
  /** Written the moment the machine exists, before any stage runs, and dropped when prepare finishes; a
   * record still marked by a dead holder never completed its setup and can never seal. */
  building?: true;
  /** What of the recipe this builder carries; a prepare with the same recipe hash reuses it. */
  import?: ImportLedger;
  /** The base tools read on this builder, or on the golden it was forked from; the version it seals records them. */
  base?: GoldenBaseTool[];
  /** Saved as this version and kept running since; an update of that version lands on it, the sweep stops it at GRACE_MS. */
  sealed?: { at: string; version: number };
  /** The place this builder was made at, so a provider swapped in mid-build never becomes where it seals. Absent,
   * on a record from before places, reads as the wired place. */
  place?: string;
}

interface LiveBuilder {
  record: BuilderRecord;
  builder: Builder;
  /** Whether a seal can still be taken from it: its machine's first life, or a place whose copy of a disk is the
   * disk as it stands. What `life` is derived from and what the builder's view carries. */
  sealable: boolean;
  /** own: made or attached to by this process. reusable: an earlier process's record, marked and running,
   * wearing this owner's label or none; the sweep ages it out at six hours. stale: an earlier record that
   * can never seal; the sweep stops it. foreign: wears another state file's label; never touched.
   * held: another live process is using it; never touched while its heartbeat is fresh. Read once at load: a
   * host that runs on keeps what it read, and host.lock keeps a second init from starting beside it. */
  life: "own" | "reusable" | "stale" | "foreign" | "held";
  reach?: PreviewReach;
  /** The recipe the prepare that made or attached to it carried, when it named one; the seal reads it back. */
  recipe?: GoldenRecipe;
}

/** What prepare rejects with once its signal aborted. `builderId` is the machine it had, when one existed: killed
 * by its recorded id and its record dropped, unless `kept` (attached to, a seal still in it, hold released,
 * record left reusable) or `left` (the kill failed for this reason and the record stays for the sweep). */
export class PrepareStoppedError extends Error {
  readonly builderId?: string;
  readonly kept: boolean;
  readonly left?: string;
  constructor(builderId?: string, outcome?: { kept: true } | { left: string }) {
    const kept = outcome !== undefined && "kept" in outcome;
    const left = outcome !== undefined && "left" in outcome ? outcome.left : undefined;
    super(
      builderId === undefined
        ? "prepare stopped before a machine existed"
        : kept
          ? `prepare stopped; builder ${builderId} left running with a seal still in it`
          : left === undefined
            ? `prepare stopped; builder ${builderId} killed`
            : `prepare stopped; builder ${builderId} did not stop: ${left}`,
    );
    this.name = "PrepareStoppedError";
    if (builderId !== undefined) this.builderId = builderId;
    this.kept = kept;
    if (left !== undefined) this.left = left;
  }
}

/** Stand-in for a machine that vanished while we were away; resume() failing with
 * kind "missing" is exactly what triggers Workspace's resurrect path. */
function deadMachine(id: string): Machine {
  const gone = () => Object.assign(new Error(`machine ${id} is gone`), { kind: "missing", status: 404 });
  return {
    id,
    kind: "sandbox",
    streamUrl: undefined,
    exec: async () => {
      throw gone();
    },
    run: async () => {
      throw gone();
    },
    snapshot: async () => {
      throw gone();
    },
    pause: async () => {
      throw gone();
    },
    resume: async () => {
      throw gone();
    },
    kill: async () => {},
    state: async () => "gone",
    downloadUrl: async () => {
      throw gone();
    },
    uploadUrl: async () => {
      throw gone();
    },
  };
}

/** The mark a stand-in for an absent place's machine carries, so the one reading of "nothing about this machine is
 * known yet" is a fact of the handle rather than a guess from the record's phase. */
const ABSENT = Symbol("absent machine");

/** Whether this handle is that stand-in. */
const isAbsentMachine = (m: Machine): boolean => (m as { [ABSENT]?: boolean })[ABSENT] === true;

/** The machine a record nothing can be asked about is held by until whatever is missing comes back: the place it
 * stands on dialling in again, or the provider key this host was started without. Nothing about it is known right
 * now and nothing is asked, so the row reads unreachable with the sentence of whatever is away and the provider is
 * asked nothing. The refusal is the caller's, since the two are not the same sentence and neither is a guess. */
function absentMachine(id: string, kind: MachineKind, away: () => never): Machine {
  const machine: Machine = {
    id,
    kind,
    streamUrl: undefined,
    exec: async () => away(),
    run: async () => away(),
    snapshot: async () => away(),
    pause: async () => away(),
    resume: async () => away(),
    kill: async () => away(),
    state: async () => away(),
    downloadUrl: async () => away(),
    uploadUrl: async () => away(),
  };
  return Object.assign(machine, { [ABSENT]: true });
}

/** Reads at most `cap` bytes of the body and cancels the rest; a body that dies mid-read still leaves the status to report. */
async function readBodyUpTo(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, Math.min(size, cap)).toString("utf8");
}

/** The calls a backend carries only when its provider has them. One list, so a handle built out of a backend
 * forwards every one of them rather than naming the few a road happened to need. */
const OPTIONAL_BACKEND_CALLS = ["checkKey", "listSnapshots", "promoteSnapshot", "getTemplate", "listTemplates", "deleteTemplate"] as const;

/** Those calls bound to the backend, for a handle that stands in front of it. A backend is a module with its
 * methods on its prototype, so a spread of it carries none of them; each one is taken by name here. */
function forwardedCalls(backend: MachineBackend): Partial<MachineBackend> {
  const out: Record<string, unknown> = {};
  for (const name of OPTIONAL_BACKEND_CALLS) {
    const call = backend[name];
    if (typeof call === "function") out[name] = call.bind(backend);
  }
  return out as Partial<MachineBackend>;
}

/** What a daemon refused a frame with, the code beside the sentence: a caller branches on the reason rather than
 * on the words, which is what the code is for. */
class DaemonRefusal extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRefusal";
  }
}

/** Whether a refusal is the one a bring back carries as a note: the push landed and the machine has no signed-in
 * command line for the git host, so there is a branch on the remote and no pull request. */
const isNoHostCli = (e: unknown): boolean => e instanceof DaemonRefusal && e.code === "no-host-cli";

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { backend, store, adapters } = opts;
  const local = opts.local;
  const ssh = opts.ssh;

  /** The one place a workspace's kind means anything: the module that answers for machines of that kind. The backend
   * that holds the machine, how a turn's process is launched on it, where each harness keeps its sessions there, the
   * environment a turn runs under, and whether a request relayed from a machine may drive it. Every other road asks
   * the module for a capability or a fact; nothing else compares the kind. Adding a kind (an ssh machine) is a row
   * here and its wiring, nothing more. */
  interface KindModule {
    /** The backend the machine of one record lives on. A function of the record because a fork can stand at this
     * host's own provider or on a computer somebody joined, and which one is a fact of that record rather than of
     * its kind: everything else a fork meets is the same either way, since the two are the same interface. */
    backend: (record: WorkspaceRecord) => MachineBackend;
    /** How a turn's process is launched on this workspace's machine, under the limits the registry hands every turn. */
    execStream: (entry: LiveWorkspace, opts?: MachineExecOptions, waiting?: TurnWaiting) => ExecStreamFactory;
    /** The folder a turn and a command start in on this kind when the caller names none; undefined leaves it to the
     * machine's own road, which for a guest is the home the login shell lands in. A reading of the record, since a
     * workspace on this computer is the copy its record names. */
    folder: (record: WorkspaceRecord) => string | undefined;
    /** Where the harness keeps its sessions on this workspace's machine: a fixed folder on a kind whose machines
     * wsp makes alike, the record's own on a machine that already existed and answered with its home. */
    home: (entry: LiveWorkspace, agentId: string) => string;
    /** The machine's own home, published on the view so a client shortens a folder under it to ~; undefined where
     * the kind has not read one. */
    homeDir: (record: WorkspaceRecord) => string | undefined;
    /** The login environment a turn of one harness runs under there, read the same way. */
    env: (entry: LiveWorkspace, agentId: string) => Readonly<Record<string, string>>;
    /** Whether a login of this agent's own stands where this workspace runs, which decides whether the vault's key
     * is handed to a turn at all: a harness reads a key in its environment ahead of the login on its disk, so
     * handing one where a person signed in would bill the key and leave that login unused. Where a login lives is
     * the kind's own: a computer somebody joined listed what it holds, this computer is read on its own disk, and
     * an image never carries one. */
    loginStands: (entry: LiveWorkspace, agentId: string) => boolean;
    /** How a folder on this computer gets onto a machine of this kind: packed and landed on a fork, its path recorded
     * with nothing copied on this computer, refused where no road exists yet. Answers what landed, which carries the
     * project the record gains, and the done line; the caller keeps the record and the roots file, which every road
     * shares. */
    import: (entry: LiveWorkspace, o: ProjectImportOptions, report: ImportReport) => Promise<ImportLanded>;
    /** Names the project folders the machine's daemon may browse beside its home, where the kind has a daemon. */
    roots: (entry: LiveWorkspace, dests: readonly string[]) => Promise<void>;
    /** Puts this workspace's project inside it, the step between the machine answering and the workspace being
     * ready: a kind that copies a folder here has the copy already and only checks the folder is still a repo,
     * and a kind that forks clones the repo into the fork. A throw ends the create as any failed stage does. */
    landProject: (entry: LiveWorkspace, project: ProjectView, report: StageReport) => Promise<void>;
    /** Makes this workspace's copy of the project on a computer whose capabilities say it copies by directory: the
     * folder the copy lands at, the road that made it and what it stands on. Refused with one sentence where the
     * computer makes no copy. The record is the caller's; this makes the folder and nothing else. */
    makeCopy: (project: ProjectView, work: { slug: string; base?: string }) => Promise<ProjectCopy>;
    /** Takes the copy away; the record is the caller's to delete after. The person's own folder is never touched,
     * since no record names it as its copy. */
    dropCopy: (copy: ProjectCopy) => Promise<void>;
    /** What one agent on this workspace keys its sessions and its memory to, where the kind has an answer: on a
     * computer whose workspaces are copies of a folder, the original folder's own key, so every copy and the
     * person's own terminal in that folder share one memory. Nothing where the folder a turn runs in is the key,
     * which is every machine wsp makes. */
    memoryKey: (entry: LiveWorkspace, agentId: string) => string | undefined;
    /** Whether a request relayed from a machine may drive this workspace; a local one answers only this computer,
     * and so does a machine of another kind whose dial names this computer. The machine id is absent on the one
     * road that asks before a machine exists, a fork's create, where only the kind can answer. */
    relayed: (machineId: string | undefined) => boolean;
    /** How wsp itself is run on this kind's machine, for the tools a turn's own agent is given: a fork runs the
     * binary the daemon deploy lands, this computer runs the command the host itself was started as, and a kind wsp
     * puts nothing on answers none, which leaves that kind's turns without the tools. Neither line names a host:
     * the tools read the pair the launch left in the agent's environment, as the wsp a turn's shell runs does. */
    wspMcp: (entry: LiveWorkspace) => McpServerSpec | undefined;
    /** Where a turn on this workspace's machine dials this host, which the kind answers because whether there is
     * an address at all is a fact about its machines: a fork somewhere else reaches this host where the person
     * named or where it answers, a turn beside the host reaches it on its loopback. None leaves that turn without
     * a token, since one with nowhere to go opens nothing. */
    hostUrl: (entry: LiveWorkspace) => string | undefined;
    /** The road a turn on this kind's machine reaches this host by, written on the token minted into it and
     * stamped on every request that token makes: a machine's is relayed, and this computer's is here. */
    turnRoad: ScopedRoad;
    /** Whether this machine's daemon can be dialled at all, asked before a road is opened so nothing mints a preview
     * route to find out: a cloud fork needs one, this computer's daemon is on it. Read as truthy, the way the reach
     * word and the status poller read it before this seam existed. */
    hasDaemon: (entry: LiveWorkspace) => boolean;
    /** The road to this machine's daemon: where it listens, when the route expires and the token that opens it. A
     * cloud fork's preview route with the token this runtime wrote on the guest; this computer's loopback daemon
     * with the token it holds in memory. Throws with the backend's own words when the machine has no road, which
     * is every time on a kind whose daemon this host cannot prove it is the one dialled. */
    daemonRoad: (entry: LiveWorkspace) => Promise<DaemonReachView>;
    /** The folder on the machine wsp writes its own working files in: a run's script and log, an import's parts.
     * A machine wsp made is wsp's whole, so its shared temporary folder is fine; on a machine somebody owns that
     * folder belongs to every account on it, and one of them could sit on a name wsp is about to write. */
    scratch: (entry: LiveWorkspace) => string;
    /** What comes off the machine when a workspace of this kind is dropped: on a machine the person owns, the
     * daemon and everything wsp kept beside it; nothing on a kind whose machine goes with the delete. The machine
     * itself is the delete's own business; this is only what wsp put on it. */
    dropped: (entry: LiveWorkspace) => Promise<void>;
    /** Which daemon this machine is running, or null where nothing can say: a fork announces it in its hello, a
     * machine the person owns carries what this host put there on its record, and this computer runs its daemon
     * in this process. What the sync compares against the version this wsp would deploy. */
    daemonVersion: (entry: LiveWorkspace) => Promise<number | null>;
    /** Starts another daemon in place of one that is not running, where this host holds the process itself. Only
     * the workspace that is this computer has such a daemon; every other kind's runs on a machine this host can
     * reach but does not hold, and the sentence a caller gets there says so. */
    restartDaemon?: (entry: LiveWorkspace) => Promise<void>;
    /** Puts this runtime's daemon on the machine, replacing one already there. Absent where nothing can: this
     * computer runs its daemon in this process, a host that wired no bundle has none, and a backend that neither
     * mints a signed URL nor carries bytes itself has no road for one. Every road that offers to deploy reads
     * whether this is here, so none offers where another would refuse. */
    deployDaemon?: (entry: LiveWorkspace) => Promise<void | string>;
  }
  type ImportReport = (stage: ProjectImportStage, message: string, progress?: { bytes: number; total: number }) => void;
  interface ImportLanded {
    result: ProjectImportResult;
    done: string;
  }
  const projectOf = (dest: string, size: number): WorkspaceProject => ({ name: folderName(dest), dest, importedAt: new Date(clock.now()).toISOString(), size });
  /** The command that puts a project's repo inside a copy of an image, word for word, so the test that reads the
   * machine's log and the machine that runs it read one line. No --branch where the record names no base: the
   * remote's own default branch is what the clone then takes. */
  const cloneOnMachine = (project: ProjectView, computer: string): string =>
    cloneLines({
      source: projectSource(project.source.kind),
      remote: project.remote,
      checkout: project.path,
      computer,
      ...(project.base !== undefined ? { branch: project.base } : {}),
    }).join("\n");
  /** The clone inside a copy: git's own last line is the failure, so a person reads what git said and not that a
   * stage failed. */
  const cloneProject = async (entry: LiveWorkspace, project: ProjectView, report: StageReport): Promise<void> => {
    // A copy forked from the project's own image already holds the checkout and its dependencies, and so does one
    // the computer copied the checkout into; there is nothing to clone and nothing to install in either.
    if (project.image !== undefined || project.checkout !== undefined) return;
    // And neither has a fork of a project image that carried this checkout: the snapshot is the whole disk, so the
    // project stands at its path with its dependencies installed, and a clone over it is what git refuses. The
    // image the machine was forked from is what says so, read off this workspace's own record.
    if (imageCarriesCheckout((await imageOf(entry.record.golden)).projects, project.path)) return;
    report("project-cloned", `Cloning ${project.remote} into ${project.path}.`);
    const cloned = await entry.machine.exec(cloneOnMachine(project, placeName(entry.record.place ?? places.wired)), { timeoutMs: CLONE_MS });
    if (cloned.exitCode !== 0) throw new Error(lastLineOf(cloned.stderr) || lastLineOf(cloned.stdout) || `git clone exited ${cloned.exitCode}`);
    // Fresh dependencies on the machine holding the checkout: the catalog's row for whichever lockfile the repo's
    // own root carries, run once, its output in wsp's own folder and never inside the project. A repo no row names
    // an install for installs nothing.
    const root = await entry.machine.exec(`ls -A ${shellQuote(project.path)}`, { timeoutMs: INLINE_EXEC_MS });
    const install = projectInstalls(root.stdout.split("\n").map(name => name.trim()), project.path)[0];
    if (install === undefined) return;
    report("project-cloned", `${install.command} in ${project.path}.`);
    const log = `${moduleOf(entry.record.kind).scratch(entry)}/install-${project.id}.log`;
    const ran = await entry.machine.exec(installScript(install, { dir: project.path, log }), { timeoutMs: INSTALL_MS });
    if (ran.exitCode !== 0) throw new Error(`${install.command} in ${project.path}: ${lastLineOf(ran.stderr) || lastLineOf(ran.stdout) || `exit ${ran.exitCode}`}; its whole output is ${log} on the machine`);
  };
  /** A project record with the fields a later build added filled in, or the record itself where it carries them
   * all. Each is the rule the add would have written, read off what the record already holds: the remote a repo
   * source names, the default branch every clone falls back to, the key its agent's memory sits under (the path
   * on the computer holding it) and the folder that memory is in there, which is the landing road's own rule for
   * that computer and never a path spelled here. A record that has them is untouched, and nothing here recomputes
   * a field a record carries. */
  const filledProject = async (held: ProjectView): Promise<ProjectView> => {
    const has = (word: unknown): boolean => typeof word === "string" && word !== "";
    if (has(held.remote) && has(held.defaultBranch) && has(held.memoryKey) && has(held.memoryDir)) return held;
    const memoryKey = has(held.memoryKey) ? held.memoryKey : claudeProjectKey(held.source.kind === "folder" ? held.source.path : held.path);
    return {
      ...held,
      remote: has(held.remote) ? held.remote : projectRemote(held.source),
      defaultBranch: has(held.defaultBranch) ? held.defaultBranch : DEFAULT_BRANCH,
      memoryKey,
      memoryDir: has(held.memoryDir) ? held.memoryDir : (await projectPlaces({ ...held, memoryKey })).memoryDir,
    };
  };

  /** Where the computer holding a project keeps its checkout and its memory, off that computer's own landing road:
   * the one home of those two paths, which the add writes onto the record and every workspace of the project
   * mounts. Asked again here rather than kept anywhere else, since a record written before this rule existed is
   * filled by it and a workspace binds what the road says today. */
  const projectPlaces = async (project: ProjectView): Promise<ProjectPlaces> => {
    const { deps, at } = await landingDeps(project.computer);
    return projectLanding(landingKind(project.computer, at)).places({ project, memoryKey: project.memoryKey, deps });
  };

  /** One folder on this computer's own remote and the branch that remote's HEAD names, in one command: what a
   * project of a folder here keeps on its record. Both empty where the folder has no origin, which a project
   * here is allowed: nothing clones it. */
  const remoteHere = async (path: string): Promise<{ remote: string; defaultBranch: string }> => {
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    // Each command prints exactly one line, its answer or an empty one, so the two are read apart whichever of
    // them the folder can answer: a folder with no origin has no remote and no default branch, not one of each.
    const read = await machine.exec(
      `${shellLine(["git", "-C", path, "remote", "get-url", "origin"])} || echo; ${shellLine(["git", "-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])} || echo`,
      { timeoutMs: INLINE_EXEC_MS },
    );
    const [remote = "", head = ""] = read.stdout.split("\n").map(line => line.trim());
    return { remote, defaultBranch: head.replace(/^origin\//, "") };
  };

  /** The copy of a project folder one piece of work on this computer gets: a sibling of the folder under the work's
   * own name, made by the daemon binary's copy verb, which picks the road, applies the two rules and says which
   * road it took. Every refusal is the verb's, naming the folder in the way or the volume that could not take the
   * copy, since the verb is what read the disk. */
  const makeLocalCopy = async (project: ProjectView, work: { slug: string; base?: string }): Promise<ProjectCopy> => {
    const copier = local?.copier;
    if (copier === undefined) throw Object.assign(new Error(NO_COPIER_HERE), { kind: "invalid" });
    // Before the binary is run at all: one that predates this wsp answers a verb it never heard of with its own
    // usage text, forty flags long, which a person read as the refusal for a second workspace.
    const here = local?.hereDaemon;
    if (here !== undefined) {
      const version = await here.version();
      // No kind: a daemon behind this wsp is not a mistyped line and not a name somebody took, and an error with
      // none of those reads as what the host refused, which is the class this is.
      if (version < DAEMON_VERSION) throw new Error(hereDaemonBehindLine(version, DAEMON_VERSION, here.fix));
    }
    const to = copyPathFor(project.path, work.slug);
    const report = await copier.make({
      from: project.path,
      to,
      ...(work.base !== undefined ? { base: work.base } : {}),
      exclude: [...PATH_BOUND_DIR_NAMES],
      sizeLineBytes: COPY_SIZE_LINE_BYTES,
    });
    return {
      // The verb answers the in-place word only when asked for it, and nothing asks: a record keeps the two roads.
      road: CopyRoad.parse(report.road),
      path: report.path,
      base: report.base,
      branch: report.branch,
      carried: report.carried,
      ...(report.fellBack !== undefined ? { fellBack: report.fellBack } : {}),
      source: project.path,
    };
  };

  /** The copy taken away by the road that made it: the verb is handed the road off the record, so a worktree's
   * registration goes with it rather than being left inside the project's own git directory. */
  const dropLocalCopy = async (copy: ProjectCopy): Promise<void> => {
    const copier = local?.copier;
    if (copier === undefined) throw new Error(NO_COPIER_HERE);
    await copier.remove(copy.source, copy.path, copy.road);
  };

  /** Whether this computer holds a git repo at exactly this folder, which is what a project here stands on: the
   * top of the work tree is the folder itself, not a folder above it. */
  const isRepoHere = async (path: string): Promise<boolean> => {
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    const read = await machine.exec(shellLine(["git", "-C", path, "rev-parse", "--show-toplevel"]), { timeoutMs: INLINE_EXEC_MS });
    return read.exitCode === 0 && read.stdout.trim() === path;
  };
  /** The import road on this computer: the folder is here already, so its path is recorded at once and nothing is
   * packed or sent. The plan is still read, since it is the one measure of the folder and the one check that it is
   * there, and its bytes are the size the record shows. */
  const registerImport = async (o: ProjectImportOptions, report: ImportReport): Promise<ImportLanded> => {
    report("landing", REGISTERING_LINE);
    const plan = await o.bundler.plan();
    return {
      result: { dest: o.dest, files: plan.files, bytes: plan.bytes, parts: 0, cut: [], rewritten: [], agents: [], project: projectOf(o.dest, plan.bytes) },
      done: registeredLine(o.dest),
    };
  };
  /** The roots file as the machine's daemon reads it, written through the machine so the guest and this computer
   * take one script; a machine that will not take it fails the import before the record names the folder. */
  const writeRoots = async (entry: LiveWorkspace, dests: readonly string[], rootsPath?: string): Promise<void> => {
    const browsable = await entry.machine.exec(writeDaemonRootsScript(dests, rootsPath), { timeoutMs: INLINE_EXEC_MS });
    if (browsable.exitCode !== 0) throw new Error(`could not make ${dests.at(-1)} browsable on the machine: ${browsable.stderr.slice(-200)}`);
  };
  const cloudHome = (id: string): string => {
    const home = guestAgentHomes()[id];
    if (home === undefined) throw new Error(`the catalog has no home for ${id}`);
    return home;
  };
  /** The guest's login plus the variable pointing one harness at its store there, the store cloudHome names: a guest
   * exec carries no environment of its own, so the adapter exports this on every launch. */
  const cloudEnv = (place: string | undefined, id: string): Readonly<Record<string, string>> => {
    const login = loginEnvOn(place);
    const agent = CATALOG_AGENTS.find(a => a.id === id);
    return agent === undefined ? login : { ...login, ...guestEnv(agent) };
  };
  const cloudRoad = async (entry: LiveWorkspace): Promise<DaemonReachView> => {
    const reach = await entry.ws.daemonReach();
    const token = await daemonTokenOf(entry.machine, DAEMON_TOKEN_PATH);
    return { url: reach.url, expiresAt: reach.expiresAt, ...(token !== undefined ? { daemonToken: token } : {}) };
  };
  const localRoad = async (): Promise<DaemonReachView> => {
    if (local?.daemonRoad === undefined) throw new Error("this host wired no daemon for its local workspace, so nothing on this computer can be dialled");
    return local.daemonRoad();
  };
  /** The login a machine that already existed answered with, off its own record. A record written before its kind
   * read one is a record no such kind ever wrote. */
  const loginOf = (record: WorkspaceRecord): Readonly<Record<string, string>> => record.login ?? {};
  /** The home the machine answered with, which every path a turn uses over ssh is built from: the run folder and
   * each harness's store. Read in one place and refused when a record carries none, since the roads below would
   * otherwise each pick a folder of their own, and a run folder guessed under /tmp is the shared one this kind's
   * own folder exists to avoid. The dial that records a workspace refuses a machine whose home is not a plain
   * absolute path, so a record without one is one no ssh road wrote. */
  const sshHomeDir = (entry: LiveWorkspace): string => {
    const home = loginOf(entry.record)["HOME"];
    if (home === undefined) throw new Error(noMachineHomeLine(entry.record.name));
    return home;
  };
  /** Where a harness keeps its sessions on a machine reached over ssh: the folder that machine's own login names
   * for it, else the catalog's default under the home it answered with. */
  const sshHome = (entry: LiveWorkspace, agentId: string): string => agentHome(sshHomeDir(entry), agentId, loginOf(entry.record));
  /** Puts this runtime's daemon on a fork and hands it this runtime's token: the deploy writes one of its own,
   * so the guest's file is replaced the moment the deploy is done rather than at the next dial. */
  const cloudDeploy = async (entry: LiveWorkspace): Promise<void> => {
    await opts.goldenRecipe!.deployDaemon!(entry.machine);
    daemonTokens.delete(entry.machine.id);
    await daemonTokenOf(entry.machine, DAEMON_TOKEN_PATH);
  };
  /** Whether the file one agent's shared login lives in stands under the home that agent reads on this computer.
   * The catalog names both the home and the file, and an agent with no shared login has no file to stand. Only a
   * login kept as a file is seen: one a tool put in this computer's keyring reads here as none. */
  const sharedLoginUnder = (home: string, agentId: string): boolean => {
    const shared = sharedOn(agentId);
    return shared !== undefined && existsSync(join(home, shared.file));
  };
  /** The place door once the host wired one; the kind's refusal when it did not, which is what every road on a kind
   * this host does not serve answers. */
  let placeDoor: PlaceDoor | undefined;
  const placeDoorOf = (): PlaceDoor => {
    if (placeDoor === undefined) throw new Error(noKindLine("place"));
    return placeDoor;
  };
  /** Every run on a machine this runtime is reading, as the call that lets go of each. A poll on a turn left
   * running holds this process after its last line, and a turn on a machine is not this host's to end: closing
   * lets go and leaves them running, and whoever opens them next reads their logs from the first byte. Each
   * kind's wiring holds its own set; this one is for the kinds whose runs live on a machine. */
  const machineReading = new Set<() => void>();
  /** Whether a machine reached over ssh is somewhere else: a dial that names the computer wsp runs on is this
   * computer under another kind's name, and both rules about who may drive a workspace of that kind read it here
   * rather than each spelling it. The machine id is absent on the one road that asks before a machine exists. */
  const sshElsewhere = (machineId: string | undefined): boolean => {
    const reach = machineId === undefined ? undefined : parseSshMachineId(machineId);
    return reach !== undefined && !sshDialsThisComputer(reach, [hostname()]);
  };
  const modules: Record<WorkspaceKind, KindModule | undefined> = {
    cloud: {
      // A fork lands either at this host's own provider or on a computer somebody joined; the record says which,
      // and a place that forks nowhere refuses here rather than at the provider.
      backend: record => {
        if (record.place === undefined) return backend;
        const at = placeDoorOf().backendOf(record.place);
        if (at === undefined) throw new PlaceForksNowhereError(placeForksNowhereLine(placeDoorOf().nameOf(record.place)));
        return at;
      },
      execStream: (entry, o, waiting) => machineExecStream(entry.machine, { reading: machineReading, ...o }, waiting),
      folder: () => undefined,
      home: (_entry, id) => cloudHome(id),
      homeDir: () => GUEST_HOME,
      env: (entry, id) => cloudEnv(entry.record.place, id),
      // A fork at a provider is a copy of an image, and no sign-in is ever sealed into one, so the vault's key is
      // what a turn there runs on. A workspace on a computer somebody joined shares that computer's own logins,
      // and the word for each is the one its row carries.
      loginStands: (entry, id) => entry.record.place !== undefined && placeDoor?.signInsAt(entry.record.place)?.[id] === "signed-in",
      relayed: () => true,
      // The word, not a path: the deploy writes the shim onto the machine's PATH and the binary under it carries the
      // chip in its own path, so the one stable name for a fork's wsp is the word a turn's own shell runs. It dials
      // no host of its own, it opens a session on this machine's daemon and the daemon carries it up the socket
      // this host already holds.
      wspMcp: () => ({ command: "wsp", args: ["mcp"] }),
      hostUrl: () => opts.agents?.reach?.advertise ?? opts.agents?.reach?.url,
      turnRoad: "relayed",
      // A workspace whose computer answers its daemon frames has no daemon of its own to dial and no route worth
      // minting: nothing listens inside it, and the road to its files and its git is the link this host holds.
      hasDaemon: entry => servedByItsComputer(entry) === undefined && Boolean(entry.machine.previewUrl),
      daemonRoad: entry =>
        servedByItsComputer(entry) === undefined
          ? cloudRoad(entry)
          : Promise.reject(new Error(placeServesDaemonLine(entry.record.name, computerOf(entry)))),
      scratch: () => GUEST_TMP,
      daemonVersion: entry => helloVersion(entry),
      dropped: async () => {},
      // The bundle is the host's to wire; whether it can reach a given machine is canDeployDaemon's reading, since
      // one kind's machines can differ about it (a container a box's runtime boots mints no signed URL).
      ...(opts.goldenRecipe?.deployDaemon !== undefined ? { deployDaemon: async (entry: LiveWorkspace) => cloudDeploy(entry) } : {}),
      import: (entry, o, report) => copyImport(entry, o, report),
      roots: (entry, dests) => writeRoots(entry, dests),
      landProject: (entry, project, report) => cloneProject(entry, project, report),
      // A fork is the copy: the machine is a copy of an image with the project cloned into it, so there is no
      // folder on this computer to copy and nothing to take away when the record goes.
      makeCopy: () => Promise.reject(new Error(kindMakesNoCopy("cloud"))),
      dropCopy: async () => {},
      // The key the project was recorded with, which is the folder's own on the computer it was seeded from: a
      // fork holds the checkout at a path of the machine's, and keying off that path would give one project as
      // many memories as it has computers.
      memoryKey: (entry, agentId) => projectMemoryKey(agentId, projectHeld(entry.record.project)),
    },
    local:
      local === undefined
        ? undefined
        : {
            backend: () => local.backend,
            execStream: (_entry, o, waiting) => local.execStream(o, waiting),
            // A workspace here is the copy of the project's folder made for this piece of work: that folder is the
            // word its view carries and where a thread on it starts; the same reading threadFolder takes.
            folder: record => checkoutOf(record),
            home: (_entry, id) => local.home(id),
            homeDir: () => local.homeDir,
            // The person's own login on the computer they are sitting at, read where that agent keeps it.
            loginStands: (_entry, id) => sharedLoginUnder(local.home(id), id),
            // The person's own login, plus the port this workspace's apps bind: every copy here shares one
            // loopback, so a copy with no port of its own would race the person's own dev server for 3000.
            env: entry => (entry.record.portBase === undefined ? local.env() : { ...local.env(), PORT: String(entry.record.portBase) }),
            relayed: () => false,
            // This computer's own command: a thread here runs the node wsp, which dials the pair its launch carries
            // rather than riding a machine's daemon. Marked, since here a server missing that pair could otherwise
            // dial the host on the person's own token; a fork's guest door has no such fallback.
            wspMcp: () => {
              const wsp = opts.agents?.wspMcp;
              return wsp === undefined ? undefined : { ...wsp, args: [...wsp.args, SCOPED_MCP_ARG] };
            },
            // A turn here runs on the computer the host runs on, so it dials the host's loopback, and a host that
            // listens on none tells it nothing and hands it no token. The token is identity here, not confinement:
            // the turn runs as the person, who can read the host's own token file.
            hostUrl: () => opts.agents?.reach?.here,
            turnRoad: "here",
            hasDaemon: () => local.daemonRoad !== undefined,
            daemonRoad: localRoad,
            ...(local.restartDaemon !== undefined ? { restartDaemon: local.restartDaemon } : {}),
            scratch: () => local.backend.folder,
            // The binary beside this host, read by starting the daemon where nothing has: this process holds the
            // process, and the binary it spawns is staged beside the command and can be older than this wsp.
            daemonVersion: async () => (local.hereDaemon === undefined ? null : local.hereDaemon.version()),
            dropped: async () => {},
            import: (_entry, o, report) => registerImport(o, report),
            // The file this host's own daemon reads, which is the wiring's and not a path taken off the home it
            // browses: a host on another state file has its own, and neither rewrites the other's.
            roots: (entry, dests) => writeRoots(entry, dests, local.rootsPath),
            // The copy is already made: nothing moves, and the one thing worth reading again is that the folder it
            // was copied from is still the repo the project was recorded on.
            landProject: async (_entry, project) => {
              if (project.source.kind === "folder" && !(await isRepoHere(project.path))) throw new Error(`${project.path} ${NOT_A_REPO_LINE}`);
            },
            makeCopy: (project, work) => makeLocalCopy(project, work),
            dropCopy: copy => dropLocalCopy(copy),
            // The original folder's key, which is the one the person's own terminal already writes under: every
            // copy of that folder and their own agent in it share one memory directory and one sessions list,
            // with nothing seeded and nothing moved.
            memoryKey: (entry, agentId) => projectMemoryKey(agentId, projectHeld(entry.record.project)),
          },
    ssh:
      ssh === undefined
        ? undefined
        : {
            backend: () => ssh.backend,
            // The run's script, log and exit code live in wsp's own folder under the machine's home, not a folder
            // every login on it shares: on the person's own machine another account's /tmp folder is theirs, and a
            // turn that cannot write in it would launch nothing.
            execStream: (entry, o, waiting) => machineExecStream(entry.machine, { reading: machineReading, ...o, runDir: sshDaemonPaths(sshHomeDir(entry)).runDir }, waiting),
            // A turn lands where the person's own login lands. wsp makes no folder on a machine it only reaches, so
            // there is none of its own to start in, and a thread that wants another says so in its own cwd.
            folder: () => undefined,
            // The machine is the person's own, so each harness reads the store their own shell would: the folder
            // their store variable names on that machine when it named one, else the default under the home it
            // answered with. The catalog's rule for both is agentHomes, the same call the local kind makes.
            home: (entry, id) => sshHome(entry, id),
            homeDir: record => loginOf(record)["HOME"],
            // The machine is the person's own and its disk is a round trip away, so what stands there is not read
            // from here: the vault's key is handed as it has been, and the turn's own words say when it was wrong.
            loginStands: () => false,
            // The machine's own login, plus the flag every machine wsp runs agents on carries, whoever owns it.
            env: entry => ({ ...loginOf(entry.record), ...MACHINE_SANDBOX_ENV }),
            // A machine wsp reaches is a machine, so a request relayed from one drives it as it drives a fork. The
            // one exception is a dial that names the computer wsp runs on: that is this computer under another
            // kind's name, and the local kind's refusal is the whole reason the rule exists.
            relayed: machineId => sshElsewhere(machineId),
            // The bundle a deploy lands on a machine over ssh carries the wsp command like every other, but which
            // node runs it there is the place's to say and no turn on this kind is handed a token yet: the tools
            // wait for the round that answers both.
            wspMcp: () => undefined,
            // Nothing on this computer answers for a machine wsp only reaches yet; the round that gives this kind's
            // turns the wsp command answers the address with it.
            hostUrl: () => undefined,
            turnRoad: "relayed",
            // No road to a daemon on such a machine, here or in anything a host wires: the road that carried one
            // dialled a port on this computer that any other process here could have bound first, and handed it
            // the daemon's token. A road comes back when the peer on it proves it is the daemon before one goes out.
            hasDaemon: () => false,
            daemonRoad: entry => Promise.reject(new Error(noSshDaemonLine(entry.record.name))),
            scratch: entry => sshDaemonPaths(sshHomeDir(entry)).wsp,
            // The record says which daemon this host put there, a fact it wrote down when it deployed. A record
            // naming none is behind every version rather than unknown, which is what makes the sync put one on a
            // machine whose first deploy failed: nothing a person types does that, so the host has to.
            daemonVersion: async entry => entry.record.daemon?.version ?? 0,
            // Taking the daemon off rides the connection that carries every command. Whether the record says a
            // daemon landed decides nothing here: a deploy that failed partway left the bundle and the token
            // there and wrote no record, and the promise is that what wsp put on somebody's machine goes with the
            // record that put it there. The removal is every path named and nothing else, so on a machine that
            // took nothing it removes nothing.
            dropped: async entry => {
              const login = loginOf(entry.record);
              await ssh.removeDaemon?.(entry.machine, { home: sshHomeDir(entry), path: login["PATH"] ?? "" });
            },
            // The machine is the person's own and the folder is theirs to land on, so the bytes travel the way a
            // fork's do; the road that carries them reads the machine for how, and over ssh that is the connection.
            import: (entry, o, report) => copyImport(entry, o, report),
            roots: (entry, dests) => writeRoots(entry, dests, sshDaemonPaths(sshHomeDir(entry)).rootsPath),
            // No project lives on a machine wsp only reaches: its row in the kind table takes no source, so no
            // workspace of this kind is ever made and nothing reaches here.
            landProject: async () => {},
            makeCopy: () => Promise.reject(new Error(kindMakesNoCopy("ssh"))),
            dropCopy: async () => {},
            memoryKey: () => undefined,
          },
  };
  const moduleOf = (kind: WorkspaceKind): KindModule => {
    const found = modules[kind];
    if (found === undefined) throw new Error(noKindLine(kind));
    return found;
  };
  const backendFor = (record: WorkspaceRecord): MachineBackend => moduleOf(record.kind).backend(record);
  const openChannel = opts.daemonChannel ?? openDaemonChannel;
  /** The backend a kind's machines live on where no record is in hand yet: the create that is about to write one,
   * and the roads that ask what this host can do at all. The same reading a record gets, off the two facts a record
   * would carry. */
  const backendOfKind = (kind: WorkspaceKind, place?: string): MachineBackend =>
    moduleOf(kind).backend({ kind, ...(place !== undefined ? { place } : {}) } as WorkspaceRecord);
  /** Whether a fork on this backend stands on an image at all: a provider boots a template or a snapshot it keeps,
   * and a workspace on a computer somebody joined is a copy of that computer's own directories, so it names none
   * and nothing is looked up or built for it. The one reading of that road above the backend, so no road here
   * names a provider or a place to learn it. */
  const keepsImages = (at: MachineBackend): boolean => at.capabilities.images;
  /** Whether the machines of this backend come up under the workspace's own name. The one reading of that road
   * above the backend, beside the images one: a fork that is named at its boot is never named again from here. */
  const namesWorkspace = (at: MachineBackend): boolean => at.namesWorkspace === true;
  /** The budgets a kind's backend declares for its naps and wakes. Every reader sits behind the pause refusal or
   * behind a machine's preview route, so a kind without one here is a wiring fault, never a person's road. */
  const lifecycleOf = (entry: LiveWorkspace): Lifecycle => {
    const lifecycle = backendFor(entry.record).lifecycle;
    if (lifecycle === undefined) throw new Error(`${entry.record.kind} machines declare no lifecycle`);
    return lifecycle;
  };
  const execFactoryFor = (entry: LiveWorkspace, o?: MachineExecOptions, waiting?: TurnWaiting): ExecStreamFactory =>
    moduleOf(entry.record.kind).execStream(entry, opts.machineExec === undefined ? o : { ...opts.machineExec, ...o }, waiting);
  /** What one agent on a workspace of this project keys its sessions and its memory to. The project's own key
   * where that agent's catalog row names the variable that pins it, since that key was fixed when the project was
   * recorded and follows it onto whichever computer holds it; every other agent keys off the folder it is worked
   * at, which is the rule the resolver for that agent carries. Read off the catalog row and never off an agent's
   * id, and read here alone, so every kind answers the same way. */
  const projectMemoryKey = (agentId: string, project: ProjectView): string | undefined =>
    CATALOG_AGENTS.find(a => a.id === agentId)?.projectKeyEnv !== undefined ? project.memoryKey : projectStateKey(agentId, project.path);

  /** The folder a turn or a command starts in, the one rule every road reads: the folder the caller named, else
   * the folder this workspace holds its project in, which is the kind's own reading, else the project's own path.
   * The kind is asked rather than the project read directly, because on a computer that makes a workspace by
   * copying the project folder the workspace's folder is that copy and never the person's own checkout. Both
   * roads that launch a process through this runtime read it here, the turn and the exec verb, so the folder a
   * turn opens in and the one a command runs in cannot differ, and the app, the command line and the tool need
   * not restate it. */
  const threadFolder = async (entry: LiveWorkspace, o: { cwd?: string | undefined }): Promise<string | undefined> => {
    return o.cwd ?? moduleOf(entry.record.kind).folder(entry.record) ?? projectHeld(entry.record.project).path;
  };
  /** What a start that opened a thread leaves on the preferences record: the project the thread landed in, by
   * workspace, the second branch of threadFolder for the next thread there, and the target, the workspace and project
   * a thread or an import asked for from nowhere goes to. Written only when it moves the record, so a second thread
   * on the same project pushes no record to any socket. */
  /** One project's record as it stands now, kept and pushed to every client: the one writer, so no road updates
   * the map without the store or the other way round. */
  const rememberProject = async (project: ProjectView): Promise<void> => {
    projectsHeld.set(project.id, project);
    await store.put(PROJECTS, project.id, project);
  };

  /** The agent a thread on this project last ran under, kept on the project's own record: what a start that names
   * none takes, and what the composer shows as the default. Written only when it moves, so a second thread on the
   * same agent writes nothing. */
  const rememberAgent = async (project: ProjectView, harness: string): Promise<void> => {
    if (project.lastAgent === harness) return;
    await rememberProject({ ...project, lastAgent: harness });
  };

  const rememberTarget = async (record: WorkspaceRecord): Promise<void> => {
    const current = await preferences.get();
    if (current.target?.workspace === record.id) return;
    const patch: PreferencesPatch = { target: { workspace: record.id } };
    await preferences.set(patch);
  };
  /** Why a verb this workspace's machine cannot take is refused, in the three sentences the three reasons have: a
   * machine wsp does not run has no meaning for a verb that moves a fork, a host with no provider forks nothing at
   * all and says how to get one, and a machine wsp does run is short of that verb's road at its provider. Written
   * once, so every gate below refuses in the words its own reason has. */
  const cannotLine = (record: WorkspaceRecord, action: string): string => {
    const kind = record.kind;
    if (!kindWords(kind).driven) return undrivenRefusal(record.name, machineWord(kind), action);
    if (forksNoMachines(backendFor(record).capabilities)) return NO_PROVIDER_LINE;
    return providerCannotRefusal(record.name, machineWord(kind), action);
  };
  /** The one throw every gate below goes through, so every capability a verb reads refuses in the same sentence. */
  const refuseUnless = (entry: LiveWorkspace, able: boolean, action: string): void => {
    if (!able) throw new Error(cannotLine(entry.record, action));
  };
  /** The capability a verb reads before it runs: a machine whose capability is false refuses the verb. Each verb
   * names the capability its own move needs and never a neighbour's: a provider that copies a machine's disk but
   * whose forks boot cold takes a snapshot all the same. */
  const refuseCannot = (entry: LiveWorkspace, can: keyof Omit<Capabilities, "sizes" | "pauseMode">, action: string): void => {
    refuseUnless(entry, backendFor(entry.record).capabilities[can] === true, action);
  };
  /** Whether a kind's machines pause at all, which is all the runtime asks of the pause mode: the nap and the wake
   * refuse where no mode is declared, with the same sentence, and never read which mode it is. */
  const pauses = (record: WorkspaceRecord): boolean => backendFor(record).capabilities.pauseMode !== undefined;
  const refusePauseless = (entry: LiveWorkspace, action: string): void => {
    refuseUnless(entry, pauses(entry.record), action);
  };
  /** Whether a workspace holds one of the account's machine slots: only a kind whose machines the provider can nap
   * does, the same fact the pause and wake refusals read, so this computer is never counted against the cap nor
   * named beside the two moves that free a slot. Phase decides the rest off the record alone, since a refusal has
   * no time to ask the provider about every workspace. */
  const holdsSlot = (record: WorkspaceRecord): boolean => {
    if (!pauses(record)) return false;
    const state = workspaceState({ phase: record.phase });
    return state !== "paused" && state !== "gone";
  };
  /** The one rule about where a request came from, read by every verb and every list that serves workspaces: a
   * request relayed from a machine drives and sees only the kinds whose module takes one, so this computer's own
   * workspace answers nothing relayed. Today no machine has a road into the host, so nothing relays yet; the rule
   * holds when one appears. */
  const drives = (record: { kind: WorkspaceKind; machineId?: string }, caller: Caller | undefined): boolean => roadOf(caller) !== "relayed" || moduleOf(record.kind).relayed(record.machineId);
  /** What the two rules a request is read against need of a workspace: what a record holds, and what a create is
   * checked with before there is a record. */
  type WorkspaceLike = { id?: string; kind: WorkspaceKind; name: string; machineId?: string; rootThreadId?: string; project?: string };
  /** Which workspaces a thread's own token reaches: the one its turn runs on, and the ones its root thread forked.
   * A thread never sees or drives a workspace outside its own tree, whatever the verb, so this sits beside the
   * kind rule rather than in any one of them. A caller that is no thread reaches everything the kind rule allows. */
  const inTree = (record: { id?: string; rootThreadId?: string }, scope: ThreadScope | undefined): boolean =>
    // A record with no id is a workspace that does not exist yet, the shape a create is checked against: what a
    // thread may make is the guard's question, not this one's.
    scope === undefined || record.id === undefined || record.id === scope.workspaceId || record.rootThreadId === scope.rootThreadId;
  /** Which project a thread works on: the one its own workspace holds. A thread whose workspace this host no longer
   * holds works on none, and the project rule then has nothing to compare and leaves the tree rule to refuse. */
  const projectOfScope = (scope: ThreadScope): string | undefined => live.get(scope.workspaceId)?.record.project;
  /** The rule as a sentence: what this request is refused with for that record, or nothing when it may drive it.
   * A record this host does not hold, which a port forward's target may be since the host forwards a builder's
   * ports too, is nobody's to refuse for. The project rule is read before the tree rule and answers first: a
   * workspace of another project is outside the tree as well, and the project is why. */
  const refusalFor = (record: WorkspaceLike | undefined, caller: Caller | undefined): string | undefined => {
    if (record === undefined) return undefined;
    if (!drives(record, caller)) return relayedRefusal(record.name);
    const scope = scopeOf(caller);
    if (scope === undefined) return undefined;
    const mine = projectOfScope(scope);
    if (mine !== undefined && record.project !== undefined && record.project !== mine) {
      return spawnProjectRefusal(scope.threadId, projectHeld(mine).name, projectHeld(record.project).name);
    }
    return !inTree(record, scope) ? spawnReachRefusal(scope.threadId, record.name) : undefined;
  };
  /** The rule as the caller reads it. A person is told which rule hid the workspace, since what this host holds is
   * theirs; a thread is told absence and nothing more, since a sentence naming a workspace or a project outside its
   * tree is how a thread learns what else stands here. No word rides the thread's: every verb that reaches this
   * found the workspace itself rather than being handed it. */
  const refuseRelayed = (record: WorkspaceLike | undefined, caller: Caller | undefined): void => {
    const line = refusalFor(record, caller);
    if (line === undefined) return;
    throw scopeOf(caller) === undefined ? new Error(line) : notFoundRefusal(noWorkspaceRefusal());
  };
  /** The rule for a workspace a caller named by id rather than one a verb found for itself: a thread reads one
   * sentence for an id this host does not hold and for one outside its tree alike, since telling the two apart is
   * how a thread walks what else stands here. A caller that is no thread reads what it always did, an id nobody
   * holds being nobody's to refuse for. */
  const refuseNamed = (workspaceId: string, caller: Caller | undefined): void => {
    const record = live.get(workspaceId)?.record;
    if (record === undefined && scopeOf(caller) !== undefined) throw notFoundRefusal(noWorkspaceRefusal());
    refuseRelayed(record, caller);
  };
  /** Every workspace this host holds, as any door serves them: one a create has not finished is not there yet. */
  const held = (): LiveWorkspace[] => [...live.values()].filter(e => !e.creating);
  /** The workspaces this caller is served, which is the one reading behind the listings and behind resolving a name.
   * Both lists a person meets are built here, so neither can drop a workspace the other keeps and no verb denies a
   * name the listing just showed. */
  const listedFor = (caller: Caller | undefined): LiveWorkspace[] => held().filter(e => refusalFor(e.record, caller) === undefined);
  /** Recording a machine that already exists is this computer's own act, whatever the kind takes once it is
   * recorded: the address and the key a record stands on are the person's to name, so a request relayed from a
   * machine is refused before anything is dialled and again where the record is written. */
  const refuseRecording = (named: string, caller: Caller | undefined): void => {
    if (roadOf(caller) === "relayed") throw new Error(relayedRecordRefusal(named));
  };
  /** The switch that governs a workspace, which is the one on the workspace the root thread of its tree runs on: a
   * fork carries the tree it belongs to and not a rule of its own, so turning a lead's switch off stops everything
   * its threads spawned rather than leaving a copy of the old answer standing on every machine under it. A root
   * whose workspace this host no longer holds governs nothing, so the tree under it spawns nothing more. */
  const agentsOf = (record: { agents?: WorkspaceAgents; rootThreadId?: string }): WorkspaceAgents | undefined => {
    if (record.rootThreadId === undefined) return record.agents;
    const at = rowsOn(record.rootThreadId)[0]?.workspaceId;
    return at === undefined ? undefined : live.get(at)?.record.agents;
  };
  /** The tree a thread sits in, read off the rows: its parent, then its parent's, up to the thread a person opened.
   * The walk is bounded by the rows there are, since a chain that somehow looped would otherwise never end. */
  const parentOf = (threadId: string): string | undefined => rowsOn(threadId).find(v => v.parentThreadId !== undefined)?.parentThreadId;
  const depthUnderRoot = (threadId: string): number => {
    let depth = 0;
    let at = threadId;
    for (let steps = sessions.size + 1; steps > 0; steps--) {
      const parent = parentOf(at);
      if (parent === undefined) return depth;
      depth++;
      at = parent;
    }
    return depth;
  };
  /** The top of the tree a thread is in: the root its own rows carry, and itself when nothing spawned it. */
  const rootOf = (threadId: string): string => rowsOn(threadId).find(v => v.rootThreadId !== undefined)?.rootThreadId ?? threadId;
  /** Where a turn on this workspace's machine reaches this host, and the wsp command it runs there: the kind's own
   * answer for its machines, and nothing where that kind reaches this host nowhere or this kind of machine carries
   * no wsp. */
  const agentsReach = (entry: LiveWorkspace): { url: string; wsp?: McpServerSpec } | undefined => {
    const url = moduleOf(entry.record.kind).hostUrl(entry);
    if (url === undefined || url === "") return undefined;
    const wsp = moduleOf(entry.record.kind).wspMcp(entry);
    return { url, ...(wsp !== undefined ? { wsp } : {}) };
  };
  /** The one door every act a thread's own token asks for goes through: the switch on the workspace that thread
   * runs on, then the acts a thread may ask for at all, then how deep it already is, then how many machines its
   * root already holds. A caller that is not a thread passes straight through; nothing here is a second copy of a
   * rule any verb also keeps. */
  const spawnGuard = (act: SpawnAct, caller: Caller | undefined): (() => void) => {
    const free = (): void => {};
    const scope = scopeOf(caller);
    if (scope === undefined) return free;
    const own = live.get(scope.workspaceId)?.record;
    const policy = own === undefined ? undefined : agentsOf(own);
    // Read at the act and not at the mint: a person who turns the switch off while a turn runs has turned it off.
    if (policy?.spawn !== true) throw new Error(agentsOffRefusal(own?.name ?? scope.workspaceId, act));
    if (!SPAWN_ACTS_ALLOWED.includes(act)) throw new Error(spawnActRefusal(scope.threadId, act));
    // The depth cap counts what a thread starts under itself; a send and a bring back start nothing, so a thread
    // at the cap still talks to its tree and still gets its work out.
    if (act === "send" || act === "bring_back") return free;
    const depth = depthUnderRoot(scope.threadId);
    if (depth >= policy.maxDepth) throw new Error(spawnDepthRefusal(scope.threadId, depth, policy.maxDepth));
    if (act !== "fork") return free;
    // Counted off the records rather than kept as a number, so a machine deleted, forgotten or gone frees its place
    // without anything having to remember to give it back, plus the slots forks still landing hold. A record
    // enters the live map only after the provider has answered, so two forks asked for in one tick would both read
    // the same count and both pass; the place is taken here, in the same step the count is read, and handed back by
    // the caller's own finally, the way the name a fork is landing under already is.
    const standing = [...live.values()].filter(e => e.record.rootThreadId === scope.rootThreadId && workspaceState({ phase: e.record.phase }) !== "gone").length;
    const held = landing.get(scope.rootThreadId) ?? 0;
    if (standing + held >= policy.maxMachines) throw new Error(spawnCapRefusal(scope.rootThreadId, standing + held, policy.maxMachines));
    landing.set(scope.rootThreadId, held + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const now = (landing.get(scope.rootThreadId) ?? 1) - 1;
      if (now <= 0) landing.delete(scope.rootThreadId);
      else landing.set(scope.rootThreadId, now);
    };
  };
  /** Where a thread's act lands in its tree: under the thread that asked and its root, which is what the thread
   * tree nests by and what the machine cap counts; nothing for a caller that is no thread. */
  const treeOf = (scope: ThreadScope | undefined): { parentThreadId?: string; rootThreadId?: string } =>
    scope === undefined ? {} : { parentThreadId: scope.threadId, rootThreadId: scope.rootThreadId };
  /** What a record says its machine is, for the one rule that one workspace stands on one machine: what the machine
   * itself answered where its kind can ask, else the id, which is the machine on every other kind. */
  const identityOf = (record: WorkspaceRecord): string => record.machineIdentity ?? record.machineId;
  const bus = eventBus();
  const providerReadMs = opts.providerReadMs ?? PROVIDER_READ_MS;
  const goneConfirmMs = opts.goneConfirmMs ?? GONE_CONFIRM_MS;
  const lateReadMs = opts.wake?.lateReadMs ?? WAKE_LATE_READ_MS;
  const clock = opts.clock ?? realClock;
  /** What the provider says the machine is, bounded by its own read; undefined where the read could not be had. */
  const readsState = (machine: Machine): Promise<MachineState | undefined> =>
    until(machine.state(), clock.now() + providerReadMs, `state of ${machine.id}`, clock).catch(() => undefined);
  /** What a read of the machine before a wake asks again comes to: a resume the backend gave up on went through
   * after all, or as far as anything here can tell it did not. A read that could not be had leaves the resume
   * unsent, and a machine the read calls gone meets its 404 on the next ask and takes the resurrect road. */
  const tookTheResume = (reads: MachineState | undefined): boolean => reads === "running" || reads === "starting";
  /** Resolves after ms on the runtime's clock. Unref'd: a host asked to exit while a wake waits to ask again exits. */
  const sleeps = (ms: number): Promise<void> => new Promise<void>(resolve => clock.schedule(() => resolve(), ms, { unref: true }));
  const daemonHelloTimeoutMs = opts.daemonHelloTimeoutMs ?? DAEMON_HELLO_TIMEOUT_MS;
  const vaultCapBytes = opts.wake?.vaultCapBytes ?? VAULT_CAP_BYTES;
  const defaultIdleWindowMs = opts.idle?.defaultWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  const hostId = opts.hostId ?? hostname();
  /** What names this host's templates: the id's hex alone, in the class the provider's name field has taken. */
  const templateHostId = templateHost(hostId);

  const vaultPathsOf = async (m: Machine): Promise<string[]> => {
    if (opts.vaultPaths) return opts.vaultPaths;
    // Breadcrumb doubles as the guarantee that the export list is never empty.
    await m.exec("date -u +%FT%TZ >> /root/.wsp-upgraded");
    const ls = await m.exec("ls -A /root");
    if (ls.exitCode !== 0) throw new Error(`vault enumeration failed: ${ls.stderr.slice(-200)}`);
    return ls.stdout
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.length > 0 && !VAULT_SKIP.has(s))
      .map(s => `/root/${s}`);
  };
  const vaultExport = async (m: Machine, o: Pick<VaultOptions, "maxBytes" | "drop"> = {}): Promise<Buffer> =>
    exportPaths(m, await vaultPathsOf(m), { ...o, ...(opts.vaultCaches !== undefined ? { exclude: opts.vaultCaches } : {}) });
  /** What the fork's home owes a newer image, read while the machine still runs: the files the image it stands on
   * wrote and it never touched, which the archive leaves behind so the new image's copies stand, and the ones it
   * changed, which travel and are named on the result. A version that recorded none falls back to the old rule,
   * where the whole home lands over the new image. */
  const imageMovePlan = async (m: Machine, from: GoldenVersion | undefined, to: GoldenVersion): Promise<UpgradePlan> => {
    if (from?.owned === undefined) return upgradePlan(undefined, to.owned, []);
    const was = new Set(from.owned.map(f => f.path));
    // What the comparison actually judges by the fork's bytes: the version's own rows, less the volatile ones, whose
    // bytes never stand for an edit; and the volatile rows only the new image writes, where the comparison asks
    // whether the fork holds a live copy of its own to leave alone.
    const read = [
      ...from.owned.filter(f => f.volatile !== true).map(f => f.path),
      ...(to.owned ?? []).filter(f => f.volatile === true && !was.has(f.path)).map(f => f.path),
    ];
    return upgradePlan(from.owned, to.owned, await readOwnedFiles(m, read));
  };
  // One device door for this host: the ops the protocol server answers and the token every turn on a spawn enabled
  // workspace is launched with come out of the same table, so a scoped token is listed, matched and revoked by the
  // rules a paired computer's token already lives under.
  const deviceDoor = makeDevices(store);
  // The places joined to this host, over the one code store every code is spent from: the door holds the records
  // and the links, and the two roads into the runtime it needs are the ordinary record and delete roads below.
  if (opts.placeLinks !== undefined) {
    const wiring = opts.placeLinks;
    placeDoor = makePlaceDoor({
      store,
      devices: deviceDoor,
      wiring,
      // A thunk: the provider table is built below this, and the door reads it only when a line asks where a fork
      // can land.
      providers: () => places,
      now: () => clock.now(),
      onStage: event => bus.emit(event),
      copyBuild: placeId => copyRows.get(placeId),
      // The same vault a turn is launched with: the word a computer's row says about an agent's sign-in and the
      // secrets that turn actually gets are one reading, so a row cannot say a key stands that no turn would use.
      ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      ...(opts.placeJoinWaitMs !== undefined ? { joinWaitMs: opts.placeJoinWaitMs } : {}),
      ...(opts.placeUpdateWaitMs !== undefined ? { updateWaitMs: opts.placeUpdateWaitMs } : {}),
      ...(opts.placeDialWaitMs !== undefined ? { dialWaitMs: opts.placeDialWaitMs } : {}),
      ...(opts.placeFrameWaitMs !== undefined ? { frameWaitMs: opts.placeFrameWaitMs } : {}),
      ...(opts.placeRelinkWaitMs !== undefined ? { relinkWaitMs: opts.placeRelinkWaitMs } : {}),
      recording: {
        // Reads the live records, so it waits on the one hydration every other road waits on: a place that dials a
        // host nothing has asked a verb of yet would otherwise find no records at all.
        forksOn: async placeId => {
          await ready();
          return [...live.values()].filter(e => e.record.place === placeId).map(e => e.record.name);
        },
        projectsOn: async placeId => {
          await ready();
          return [...projectsHeld.values()].filter(p => p.computer === placeId).map(p => p.name);
        },
      },
    });
    // The door's four events ride the one stream every other event rides, so the app follows a computer joining
    // over the socket it already holds and no road subscribes to the door itself.
    placeDoor.on(e => bus.emit(e));
    placeDoor.on(e => {
      if (e.type === "place.removed") copyRows.delete(e.placeId);
    });
    // A copy is built only when somebody asks for one, and a computer's setup was asked for: its end is when the
    // image there can be read at all, which is the moment the tally beside it is written. A link builds nothing.
    bus.on("place.stage", e => {
      if (e.type !== "place.stage" || e.step !== "provision" || e.placeId === undefined) return;
      if (e.state === "done" || e.state === "failed") void image.keepCurrent(e.placeId);
    });
    // A build on that computer is making its requests over the link that just went: the ones that may be asked
    // again are waiting on it, so the stage they are in says what it is waiting for and says its own line again
    // once the computer opens a socket.
    placeDoor.on(e => {
      if (e.type !== "place.absent" && e.type !== "place.present") return;
      const gone = e.type === "place.absent";
      for (const at of stageAt.values()) {
        if (at.place !== e.placeId) continue;
        // The whole frame the stage last sent, with the wait standing in for its line while the gap lasts: the step
        // a reader clocks and the machines a failure left behind are facts of that stage and outlive a socket.
        const detail = gone ? placeDialBackLine(placeDoor!.nameOf(e.placeId)) : at.frame.detail;
        bus.emit({ ...at.frame, type: "golden.stage", ...(detail !== undefined ? { detail } : {}), ...(at.named ? { place: at.place } : {}) });
      }
    });
    // A computer that dials back in is the moment a record nothing could be asked about can be read at last: only
    // the ones this host is holding by a stand-in go through the hydration they would have had at host start, and
    // a fork that was live through the blip is left exactly as it is. A laptop that slept and dialled again is the
    // common case, so a wake, a nap or a delete in flight must not be thrown away by a presence beat.
    placeDoor.on(e => {
      if (e.type !== "place.present") return;
      void (async () => {
        await ready();
        for (const raw of await store.list(WORKSPACES)) {
          const stored = raw as WorkspaceRecord;
          if (stored.place !== e.placeId || !isHeldAway(stored.id)) continue;
          // This road runs after ready, so every session row is already in and the sync can wait out a running turn.
          const entry = await hydrateWorkspace(raw);
          if (entry !== undefined) void syncDaemon(entry);
          else await rereadHeld(stored.id, "record load");
        }
      })().catch((err: unknown) => console.warn(`the records on ${placeDoor!.nameOf(e.placeId)} were not read again: ${err instanceof Error ? err.message : String(err)}`));
    });
  }
  /** The machines a root thread's forks are landing but have no record for yet, by root: a slot is taken before
   * the first await of a fork and handed back when it lands or fails, so the cap counts what is on its way too. */
  const landing = new Map<string, number>();
  const live = new Map<string, LiveWorkspace>();
  /** Every project this host holds, by id, read from the store once at hydration and kept here: a workspace's view
   * joins its project off this map on every read, and the map is the one place a project's name, path and computer
   * are known without a store read. */
  const projectsHeld = new Map<string, ProjectView>();
  const builders = new Map<string, LiveBuilder>();
  /** Every machine a sweep, a landing or a replacement stops, read back behind the sweep and asked again while it stays. */
  let sayStops: ((line: string) => void) | undefined;
  const gone = new GoneWatch({ ...(opts.killConfirm !== undefined ? { confirm: opts.killConfirm } : {}), warn: line => (sayStops ?? console.warn)(line) });
  /** The prepare in flight per place and golden name; a second call for the same recipe joins it instead of running the stages twice on one machine. */
  const preparing = new Map<string, { hash: string | undefined; promise: Promise<GoldenBuilderView> }>();
  /** The copy build in flight per place and image name. A create landing there, a version cut and a person typing
   * the line all ask for the same copy: the second and every later ask joins the first and takes the copy it seals,
   * so one builder runs and this computer is read once. */
  const copyBuilds = new Map<string, Promise<SealedImageBuilt>>();
  /** One build stage as its frame carries it, with nothing of the stream around it: what a gap in a link replays. */
  interface StageFrame {
    name: string;
    stage: GoldenStage;
    detail?: string;
    step?: GoldenStep;
    left?: string[];
  }
  /** The stage each build on a joined computer is in, by that computer and the image's name. A build there makes
   * its requests over that computer's link, and a gap in it holds every one of them: the stage says so while it
   * lasts and reads what it last read once the computer is back, rather than standing still under a line that is
   * no longer true. */
  const stageAt = new Map<string, { place: string; name: string; named: boolean; frame: StageFrame }>();
  /** What each place's row says about its copy: the stage while a build runs there, the reason after one stopped,
   * nothing once the copy stands. Written off the golden.stage frames naming the place, so a build reads the same on
   * the row whoever started it. */
  const copyRows = new Map<string, CopyBuild>();
  bus.on("golden.stage", e => {
    if (e.type !== "golden.stage" || e.place === undefined) return;
    const build = copyBuildOf(e);
    if (build === undefined) copyRows.delete(e.place);
    else copyRows.set(e.place, build);
  });
  /** Whether a refusal before any build at a place is that place's row to say. A place that runs no workspaces has no
   * copy to keep, a link that went is not a build to show, and a computer whose recipe is running is no build either:
   * nothing was asked of its image and the job's own end asks again. */
  const rowSaysFailure = (place: string, e: unknown): boolean =>
    !(e instanceof PlaceForksNowhereError || e instanceof PlaceProvisioningError || isPlaceAbsent(e) || placeAway(place));
  /** A computer this host holds no link to now: a laptop asleep, or one that went mid-ask. */
  const placeAway = (place: string): boolean => placeDoor !== undefined && places.backend(place) === undefined && placeDoor.link(place) === undefined;
  /** A failure said on the bus as the build's own failed frame, so the row, the app's store and the image card read
   * the same stop. */
  const frameStopped = (place: string, name: string, e: unknown): void => stageOf(name, place, true)("failed", e instanceof Error ? e.message : String(e));
  /** A row read back from the store has no handle: its process died with the runtime that started it. */
  /** The record of every thread this host holds, by thread id, persisted beside the workspace's rows. */
  const threadRecords = new Map<string, ThreadRecord & { workspaceId: string }>();
  /** `launch` is carried only by a row the start road wrote before its turn reached the machine, and settles when the
   * turn's harness holds the row or the start gave it up: a send behind such a row waits on it, and the file never
   * takes the row, since a restart could re-open nothing from it. */
  const sessions = new Map<string, { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnToken?: string; scopeDeviceId?: string; handle?: SessionHandle; end?: (reason: string) => void; turnLive?: TurnLive; run?: string; pid?: number; launch?: Promise<void>; calls?: Map<string, { toolName: string; input: string }> }>();
  /** Every exec stream still running, so the machine going away ends it the way it ends a session. */
  const execs = new Set<{ workspaceId: string; end: (reason: string) => void }>();
  const indexFlushes = new Map<string, Promise<void>>();
  const transcripts = new Map<string, SessionEvent[]>();
  // Puts are chained per workspace so the later snapshot always lands last,
  // whatever order the store finishes in.
  const transcriptFlushes = new Map<string, Promise<void>>();
  const transcriptTimers = new Map<string, () => void>();
  // One token per machine, written to a guest the first time a client asks to reach its daemon; the file the
  // guest carried before (the golden's, or an earlier run's) stops working then. Per machine and not per process:
  // a machine whose root is hostile reads its own token file, and that token opens no other machine of this host.
  const daemonSeed = opts.daemonToken;
  if (daemonSeed !== undefined) assertTokenShape(daemonSeed);
  const machineTokens = new Map<string, string>();
  /** The token this machine is given, made once and kept: derived from the seed a caller pinned, or random. */
  const tokenForMachine = (machineId: string): string => {
    const held = machineTokens.get(machineId);
    if (held !== undefined) return held;
    const minted = daemonSeed === undefined ? randomBytes(24).toString("hex") : daemonTokenFor(daemonSeed, machineId);
    machineTokens.set(machineId, minted);
    return minted;
  };
  // Whether each machine answered a daemon, keyed by machine id: a resurrect or upgrade brings a fresh guest and file.
  const daemonTokens = new Map<string, { hasDaemon: boolean; at: number }>();
  const daemonTokenOf = async (machine: Machine, path?: string): Promise<string | undefined> => {
    const token = tokenForMachine(machine.id);
    const cached = daemonTokens.get(machine.id);
    if (cached && (cached.hasDaemon || Date.now() - cached.at < DAEMON_TOKEN_MISS_TTL_MS)) return cached.hasDaemon ? token : undefined;
    const hasDaemon = await rotateDaemonToken(machine, token, daemonTokenPathOf(machine, path));
    daemonTokens.set(machine.id, { hasDaemon, at: Date.now() });
    return hasDaemon ? token : undefined;
  };

  const cancelFlush = (workspaceId: string): void => {
    transcriptTimers.get(workspaceId)?.();
    transcriptTimers.delete(workspaceId);
  };

  // The copy is taken here, not per event: a store may serialise after it
  // returns, and the live array keeps moving under it.
  const flushTranscript = (workspaceId: string): Promise<void> => {
    cancelFlush(workspaceId);
    const events = transcripts.get(workspaceId);
    if (!events) return transcriptFlushes.get(workspaceId) ?? Promise.resolve();
    const snapshot: TranscriptRecord = { workspaceId, events: [...events] };
    const queued = (transcriptFlushes.get(workspaceId) ?? Promise.resolve())
      .then(() => store.put(TRANSCRIPTS, workspaceId, snapshot))
      .catch(() => {});
    transcriptFlushes.set(workspaceId, queued);
    return queued;
  };

  const capSessions = (workspaceId: string): void => {
    const rows = [...sessions].filter(([, s]) => s.view.workspaceId === workspaceId);
    const excess = rows.length - SESSION_INDEX_CAP;
    if (excess <= 0) return;
    const finished = rows.filter(([, s]) => s.view.status !== "running").sort(([, a], [, b]) => (a.view.startedAt ?? 0) - (b.view.startedAt ?? 0));
    for (const [id] of finished.slice(0, excess)) sessions.delete(id);
  };

  // Rows are copied at queue time, like the transcript: the store may serialise after it returns. A harness that
  // settles after its workspace was deleted must not write the document back.
  const persistSessions = (workspaceId: string): Promise<void> => {
    if (!live.has(workspaceId)) return Promise.resolve();
    capSessions(workspaceId);
    const rows = [...sessions.values()]
      .filter(s => s.view.workspaceId === workspaceId && s.launch === undefined)
      .map(s => ({
        ...s.view,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.notifyBy !== undefined ? { notifyBy: s.notifyBy } : {}),
        ...(s.notifyRoad !== undefined ? { notifyRoad: s.notifyRoad } : {}),
        ...(s.view.status === "running" && s.turnLive?.reply !== undefined ? { reply: s.turnLive.reply } : {}),
        ...(s.view.status === "running" && s.run !== undefined ? { run: s.run } : {}),
        ...(s.view.status === "running" && s.turnToken !== undefined ? { turnToken: s.turnToken } : {}),
        // Beside the turn token and for the same reason: the process out there still holds this device, so a host
        // that re-opens the turn has to know which one to take away when it ends.
        ...(s.view.status === "running" && s.scopeDeviceId !== undefined ? { scopeDeviceId: s.scopeDeviceId } : {}),
      }));
    const threads: Record<string, ThreadRecord> = {};
    for (const [threadId, { workspaceId: on, ...held }] of threadRecords) if (on === workspaceId) threads[threadId] = held;
    const snapshot: SessionIndexRecord = { workspaceId, sessions: rows, threads };
    const queued = (indexFlushes.get(workspaceId) ?? Promise.resolve())
      .then(() => store.put(SESSIONS, workspaceId, snapshot))
      .catch(() => {});
    indexFlushes.set(workspaceId, queued);
    return queued;
  };

  // Deltas are only appended in memory; the store sees the transcript at turn
  // boundaries, so a crash mid-turn loses that turn's partial output and
  // nothing else. A session's end is written at once, anything before it waits
  // for the debounce.
  const record = (unstamped: SessionEvent): void => {
    const event: SessionEvent = { ...unstamped, at: Date.now() };
    let events = transcripts.get(event.workspaceId);
    if (!events) {
      events = [];
      transcripts.set(event.workspaceId, events);
    }
    events.push(event);
    if (events.length > TRANSCRIPT_CAP) events.splice(0, events.length - TRANSCRIPT_CAP);
    if (event.type === "session.end") void flushTranscript(event.workspaceId);
    else if (event.type !== "session.delta" && !transcriptTimers.has(event.workspaceId)) {
      transcriptTimers.set(event.workspaceId, clock.schedule(() => void flushTranscript(event.workspaceId), TRANSCRIPT_FLUSH_MS));
    }
    bus.emit(event);
  };

  /** A start without resume opens a thread; a resumed start joins the thread of the session it resumes, found by
   * the id the CLI announced (it may differ from the one first minted). A transcript from before threads existed
   * was one thread, so resuming into it stamps every event in place: the stamp fills an absent field once and never
   * changes a value, so it runs at most once per transcript. A new thread leaves the old events as they were.
   * The index is asked first: it keeps a thread whose start fell off the transcript cap. */
  const threadOf = (workspaceId: string, resume: string | undefined): { threadId: string; unstamped: boolean } => {
    if (resume !== undefined) {
      const holding = threadHolding(workspaceId, resume);
      if (holding !== undefined) return { threadId: holding, unstamped: false };
      const events = transcripts.get(workspaceId) ?? [];
      if (events.some(e => e.type === "session.start" && e.sessionId === resume)) {
        // A transcript written before threads: it takes this id once the caller's reach is read, never before.
        return { threadId: randomUUID(), unstamped: true };
      }
    }
    return { threadId: randomUUID(), unstamped: false };
  };
  /** Gives a transcript written before threads the id its resume was given, in place, once the reach is read. */
  const stampLegacy = (workspaceId: string, threadId: string): void => {
    for (const legacy of transcripts.get(workspaceId) ?? []) legacy.threadId ??= threadId;
  };

  /** The thread a harness session is a turn of, off the rows and then the start events; undefined for a session no
   * thread here ran and for one from before threads existed. Reads only, so a refusal built on it changes nothing. */
  const threadHolding = (workspaceId: string, resume: string): string | undefined => {
    for (const s of sessions.values()) {
      if (s.view.workspaceId === workspaceId && s.view.claudeSessionId === resume && s.view.threadId !== undefined) return s.view.threadId;
    }
    const events = transcripts.get(workspaceId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "session.start" && e.sessionId === resume && e.threadId !== undefined) return e.threadId;
    }
    return undefined;
  };

  /** Whether the thread's last turn ended with no exit code and no result: the runtime or its transport ended the
   * process (a deadline, a host restart, a nap), so the harness resumes a transcript it never finished writing. */
  const cutBefore = (workspaceId: string, threadId: string): boolean => {
    const events = transcripts.get(workspaceId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "session.end" && e.threadId === threadId) return e.exitCode === null && !e.sawResult;
    }
    return false;
  };

  /** What a resumed session's turns carry, read the one way for every such fact: its own rows newest first, then,
   * past the session index cap, the newest start event of that session. The index keeps SESSION_INDEX_CAP rows per
   * workspace and drops the oldest finished ones while the transcript keeps the thread, so the events are where a
   * long-lived thread's own facts survive. Nothing from before a fact was recorded, and the start then fills what
   * its catalog marks. */
  const resumedFact = (workspaceId: string, resume: string, fact: "cwd" | "permissionMode"): string | undefined => {
    const rows = [...sessions.values()];
    for (let i = rows.length - 1; i >= 0; i--) {
      const view = rows[i]!.view;
      if (view.workspaceId === workspaceId && view.claudeSessionId === resume && view[fact] !== undefined) return view[fact];
    }
    const events = transcripts.get(workspaceId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "session.start" && e.sessionId === resume && e[fact] !== undefined) return e[fact];
    }
    return undefined;
  };

  /** The folder a resumed session's harness ran in. The CLI keys a session to that folder, so a resume anywhere
   * else opens nothing. */
  const folderOf = (workspaceId: string, resume: string): string | undefined => resumedFact(workspaceId, resume, "cwd");

  /** The access a thread's turns run at: its own record, then what its latest turn recorded for a thread from
   * before the record. A send that names none keeps the thread's own rather than falling back to the adapter's
   * unnamed default, which is bypass on every harness here; without this a second turn on a thread the person
   * opened at its harness's prompts would quietly skip them. */
  const accessOf = (workspaceId: string, threadId: string, resume: string | undefined): string | undefined =>
    threadRecords.get(threadId)?.permissionMode ?? (resume === undefined ? undefined : resumedFact(workspaceId, resume, "permissionMode"));

  /** The access a thread a send opens runs at when nothing named one: the last access picked in that workspace,
   * kept on the preferences record rather than in one browser, so the next thread starts where the person left the
   * last one and a send from the CLI or a second client reads the same pick. Nothing until a pick is made, and the
   * catalog's own default then stands. */
  const pickedAccess = async (workspaceId: string): Promise<string | undefined> => (await preferences.get()).access[workspaceId];

  /** What the runtime is doing to a machine's daemon, by workspace: the line its row shows while an update runs and
   * the sentence left there when one failed. Held here rather than on the record because it says what this process
   * is doing, not what the workspace is. */
  const daemonNotes = new Map<string, string>();

  /** The machine's home for the view, where the kind knows it. */
  const homeOf = (r: WorkspaceRecord): { home?: string } => {
    const home = moduleOf(r.kind).homeDir(r);
    return home !== undefined ? { home } : {};
  };

  /** Which provider forked this workspace's machine, by the id a registry gives the module that did it. A record
   * that names the computer it was forked on reads that computer's own offer, since the machine was never at this
   * host's provider; every other driven kind reads the module this host wired, one at a time. A kind whose machine
   * the person owns is forked by nobody and carries none, and so does a place this host has not yet heard what it
   * forks with. The one reading of where a machine lives, so this and `place` on one view cannot disagree. */
  const providerOf = (r: WorkspaceRecord): string | undefined =>
    r.place !== undefined ? placeDoor?.offerOf(r.place) : kindWords(r.kind).driven ? places.wired : undefined;

  /** The project a record names. A record whose project this host does not hold is the one shape the boot refuses,
   * so every read after the boot has one. */
  const projectHeld = (id: string): ProjectView => {
    const found = projectsHeld.get(id);
    if (found === undefined) throw new Error(noSuchProjectLine(id, [...projectsHeld.values()].map(p => p.name)));
    return found;
  };

  /** What a workspace's view carries about its project: the four facts a row and a thread need, joined rather than
   * stored a second time. */
  const refOf = (p: ProjectView): ProjectRef => ({ id: p.id, name: p.name, path: p.path, computer: p.computer });

  /** Where a workspace's checkout of its project sits on its machine: the copy made for this piece of work on this
   * computer, else the project's own path, which is the clone inside a fork. */
  const checkoutOf = (r: WorkspaceRecord): string => r.copy?.path ?? projectHeld(r.project).path;
  /** What the computer holding a workspace is called, for the sentences about a workspace whose daemon is that
   * computer's own: the name the person gave that computer, or the word for its kind of machine. */
  const computerOf = (entry: LiveWorkspace): string =>
    entry.record.place !== undefined ? (placeDoor?.nameOf(entry.record.place) ?? entry.record.place) : machineWord(entry.record.kind);

  /** The computer a workspace's daemon is that computer's own: a workspace on a computer somebody owns runs no
   * daemon inside it, so its machine answers the daemon's frames itself, over the link the host already holds.
   * Read in one place, since it decides both which road the frames take and whether anything dials at all. */
  const servedByItsComputer = (entry: LiveWorkspace): ((frame: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined =>
    entry.machine.daemonFrame?.bind(entry.machine);

  /** One dial of a workspace's own daemon, for the frames this host sends itself and for a client of this host
   * driving that daemon one frame at a time: the road its kind answers, and the one sentence for a machine with no
   * daemon answering on it yet. The caller closes what it opened. */
  const ownDaemonChannel = async (entry: LiveWorkspace, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel> =>
    channelOver(await moduleOf(entry.record.kind).daemonRoad(entry), entry.record.name, onEvent);
  const channelOver = (reach: DaemonReachView, name: string, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel> => {
    if (reach.daemonToken === undefined) throw new Error(`${name} has no daemon answering yet`);
    return openChannel({ url: reach.url, token: reach.daemonToken, onEvent });
  };

  /** The frames this host sends a workspace's daemon itself, on a channel closed however the work ends: the road
   * the app's panes take for git.status, taken here for the two a bring back is made of. A refusal comes back
   * with the code the daemon put on it, so a caller reads the reason rather than the sentence.
   *
   * Where the workspace's daemon is the computer's own, the frames go up that computer's link with the workspace
   * named on each one and nothing is dialled: a computer running a daemon too old to read that name would resolve
   * the checkout's path against its own home, so it is refused first, in the word its row already carries. */
  const withDaemon = async <T>(entry: LiveWorkspace, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> => {
    const served = servedByItsComputer(entry);
    if (served !== undefined) {
      const behind = await placeBehind(entry);
      if (behind !== undefined) throw new Error(behind);
      return work(async frame => {
        const reply = await served(frame);
        if (reply["ok"] === true) return reply;
        throw new DaemonRefusal(typeof reply["code"] === "string" ? reply["code"] : undefined, String(reply["error"] ?? `${frame.op} was refused`));
      });
    }
    const channel = await ownDaemonChannel(entry, () => {});
    try {
      return await work(async frame => {
        const reply = (await channel.send(frame)) as Record<string, unknown>;
        if (reply["ok"] === true) return reply;
        throw new DaemonRefusal(typeof reply["code"] === "string" ? reply["code"] : undefined, String(reply["error"] ?? `${frame.op} was refused`));
      });
    } finally {
      channel.close();
    }
  };

  /** Why the computer holding this workspace cannot answer its frames yet, or nothing when it can: a daemon older
   * than the one this wsp deploys reads no workspace name on a files or git frame and would resolve the path
   * against its own home, which is a refusal a person cannot act on. The word is the one the computers table
   * already shows for a computer that is behind, with the line that moves it on. */
  const behindLine = (placeId: string, report: PlaceReport | undefined): string | undefined => {
    if (report === undefined || placeDoor === undefined) return undefined;
    const behind = placeDaemonBehind(report);
    return behind === undefined ? undefined : placeBehindLine(placeDoor.nameOf(placeId), behind);
  };

  /** The same reading where nothing else needs the report: read for this and thrown away. */
  const placeBehind = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const placeId = entry.record.place;
    if (placeId === undefined || placeDoor === undefined) return undefined;
    return behindLine(placeId, await placeDoor.reportOf(placeId));
  };

  /** Refuses whatever runs inside a copy (a create, a turn, a command, a pane, a port, a bring back) on a computer
   * whose doctor says it cannot run workspaces, in the sentence its row carries; a delete, a remove and an update
   * need no copy running and never ask. */
  const placeRefuses = async (placeId: string | undefined): Promise<void> => {
    if (placeId === undefined || placeDoor === undefined) return;
    const report = await placeDoor.reportOf(placeId);
    const blocked = report === undefined ? undefined : placeBlocked(placeDoor.nameOf(placeId), report);
    if (blocked !== undefined) throw new Error(blocked);
  };
  const copyBlocked = (entry: LiveWorkspace): Promise<void> => placeRefuses(entry.record.place);

  /** The three frames a place daemon stamps with the workspace a session was opened inside, which is the listener
   * it arrived on and never anything the guest said. */
  const GUEST_EVENTS = ["guest.opened", "guest.message", "guest.closed"];
  /** What a pty pushes, each naming the pty it is of; a computer answering for many workspaces pushes every
   * workspace's up the one link. */
  const PTY_EVENTS = ["pty.data", "pty.exit", "pty.mode"];
  /** The two a pane opens every link with, and the two a workspace on a computer somebody owns has no answer of
   * its own for: the ports and the load that computer's daemon reads are the whole computer's. */
  const COMPUTER_WATCHES = ["ports.watch", "sys.watch"];
  /** That computer's daemon watches, reads and signals any pid on it and names no workspace on its answers, and the
   * one watch it holds is the link's, which the computer's own page shares. */
  const COMPUTER_PROCS = ["proc.watch", "proc.unwatch", "proc.inspect", "proc.kill"];
  /** The whole of what a client's channel into a served workspace carries, for the reason DEVICE_OPS is a list: that
   * computer's daemon runs every other op on the computer itself, so a deny list would let an op added later reach it.
   * Each of these names the workspace it is for, and the daemon answers it inside that workspace. */
  const WORKSPACE_FRAMES = ["pty.create", "pty.attach", "pty.detach", "pty.write", "pty.resize", "pty.kill", "pty.list", "fs.list", "fs.read", "git.status", "git.diff", "git.push", "git.pr", "git.prState", "ping"];
  /** And the host's own guest road, which answers the sessions that computer relays by the id it gave them. */
  const GUEST_ROAD_FRAMES = [...WORKSPACE_FRAMES, "guest.watch", "guest.reply", "guest.close"];

  /** The channel a client of this host drives a served workspace's daemon over: every frame it carries goes up that
   * computer's link with the workspace named on it, and the events that come back are the ones this workspace's,
   * read off the link every road on that computer shares. Nothing is dialled and no token is spent, since the
   * road is the link that computer opened.
   *
   * Its own hello opens it. The link's hello named the computer's home, and a client builds this workspace's
   * paths off the root it reads here. */
  const servedChannel = async (
    entry: LiveWorkspace,
    served: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>,
    onEvent: (event: Record<string, unknown>) => void,
    carries: readonly string[],
  ): Promise<DaemonChannel> => {
    const placeId = entry.record.place;
    // A machine that answers its own daemon frames is one on a computer this host holds a link to.
    if (placeId === undefined || placeDoor === undefined) throw new Error(placeServesDaemonLine(entry.record.name, computerOf(entry)));
    const door = placeDoor;
    // One read of what that computer last reported, and both facts an open needs off it.
    const report = await door.reportOf(placeId);
    const behind = behindLine(placeId, report);
    if (behind !== undefined) throw new Error(behind);
    const version = report?.daemonVersion;
    const machineId = entry.machine.id;
    const checkout = checkoutOf(entry.record);
    /** The ptys on that computer this channel named, so an event of a pty another pane opened is not pushed at
     * this one; of those, the ones it is listening to, which it takes its listeners off when it goes. */
    const named = new Set<string>();
    const attached = new Set<string>();
    const link = door.channel(placeId, event => {
      const type = String(event["type"]);
      if (GUEST_EVENTS.includes(type)) {
        if (event["machineId"] === machineId) onEvent(event);
        return;
      }
      if (!PTY_EVENTS.includes(type) || !named.has(String(event["ptyId"]))) return;
      // A pty that exited holds no listener worth taking off, so the close below asks only for the ones that stand.
      if (type === "pty.exit") attached.delete(String(event["ptyId"]));
      onEvent(event);
    });
    if (link === undefined) throw new Error(absentComputer(door.nameOf(placeId), null).sentence);
    /** What this channel now holds on the far end, off a frame it sent and the answer to it. */
    const held = (op: string, frame: Record<string, unknown>, reply: Record<string, unknown>): void => {
      if (op === "pty.create") {
        named.add(String(reply["ptyId"]));
        return;
      }
      if (op === "pty.list") {
        for (const row of Array.isArray(reply["ptys"]) ? (reply["ptys"] as Record<string, unknown>[]) : []) named.add(String(row["id"]));
        return;
      }
      const ptyId = String(frame["ptyId"]);
      if (op === "pty.attach") {
        named.add(ptyId);
        attached.add(ptyId);
      }
      if (op === "pty.detach" || op === "pty.kill") attached.delete(ptyId);
    };
    onEvent({ type: "daemon.hello", root: checkout, ...(version !== undefined ? { version } : {}) });
    return {
      async send(frame) {
        const op = frame.op;
        if (COMPUTER_WATCHES.includes(op)) return { id: null, ok: false, code: "unsupported", error: placeWatchesItselfLine(door.nameOf(placeId)) };
        if (COMPUTER_PROCS.includes(op)) return { id: null, ok: false, code: "unsupported", error: forkProcsUnreadLine(entry.record.name, door.nameOf(placeId)) };
        if (!carries.includes(op)) return { id: null, ok: false, code: "unsupported", error: forkOpRefusedLine(op, entry.record.name, door.nameOf(placeId)) };
        // The pane's first tab names no folder, and the daemon answering for a workspace has no working directory
        // inside it: without one the shell would open in the home of the computer, which is bound in.
        const asked = op === "pty.create" && frame["cwd"] === undefined ? { ...frame, cwd: checkout } : frame;
        const reply = await served(asked);
        if (reply["ok"] === true) held(op, asked, reply);
        return { id: null, ...reply } as DaemonResponse;
      },
      close: () => {
        // Every channel on that computer rides the one socket its link is, so a pane that goes says which ptys it
        // is done with; the socket's own close would be the link's, and that is the whole computer going.
        for (const ptyId of attached) void served({ op: "pty.detach", ptyId }).catch(() => undefined);
        attached.clear();
        link.close();
      },
      closed: link.closed,
    };
  };

  /** What a machine that did not answer the branch read exits with, so a read that never happened is told apart
   * from a checkout that is on no branch the remote has. */
  const BRANCH_UNREAD_EXIT = 3;
  /** The branch a workspace's checkout is on right now and the remote has, read off the machine itself rather than
   * off the record: a person or an agent switches branches inside a workspace and nothing here is told. The
   * upstream is what makes it an answer: a branch only this copy holds is one no clone can start from and no pull
   * request can be opened against, so a child of such a workspace starts where the project starts instead, and so
   * does a child of one on no branch at all. A machine that did not answer is neither of those: it is refused in
   * one sentence, since a child that quietly started somewhere else would land its work somewhere else. */
  const branchOn = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const at = shellQuote(checkoutOf(entry.record));
    const said = (line: string): never => {
      throw new Error(branchUnreadRefusal(entry.record.name, line));
    };
    const read = await entry.machine
      .exec(
        `git -C ${at} rev-parse --abbrev-ref HEAD || exit ${BRANCH_UNREAD_EXIT}; git -C ${at} rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true`,
        { timeoutMs: BRANCH_READ_MS },
      )
      .catch((e: unknown) => said(e instanceof Error ? e.message : String(e)));
    if (read.exitCode !== 0) said(lastLineOf(read.stderr) || lastLineOf(read.stdout) || `git exited ${read.exitCode}`);
    const [branch = "", tracked = ""] = read.stdout.split("\n").map(line => line.trim());
    if (branch === "") said("it answered with no branch name");
    return branch === "HEAD" || tracked === "" ? undefined : branch;
  };

  /** What a workspace starts from: the project as it was recorded, seeded for a child with the branch its parent
   * is on where the remote has a copy of it. One reading for both roads a create takes. The branch is read here
   * and nowhere else: it is a fact of the fork, recorded on the child, since it names the code that child was cut
   * from and so where its work goes back, whatever branch the parent moves to afterwards. */
  const startedFrom = async (project: ProjectView, parent: LiveWorkspace | undefined): Promise<ProjectView> => {
    const branch = parent === undefined ? undefined : await branchOn(parent);
    return branch === undefined ? project : { ...project, base: branch };
  };

  const view = (r: WorkspaceRecord): WorkspaceView => ({
    ...((): { folder?: string } => {
      const folder = moduleOf(r.kind).folder(r);
      return folder !== undefined ? { folder } : {};
    })(),
    ...homeOf(r),
    id: r.id,
    name: r.name,
    machineId: r.machineId,
    phase: r.phase,
    kind: r.kind,
    golden: r.golden,
    createdAt: r.createdAt,
    project: refOf(projectHeld(r.project)),
    ...(r.copy !== undefined ? { copy: r.copy } : {}),
    ...(r.portBase !== undefined ? { portBase: r.portBase } : {}),
    ...(r.claudeSessionId !== undefined ? { claudeSessionId: r.claudeSessionId } : {}),
    ...(r.screen !== undefined ? { screen: r.screen } : {}),
    ...(r.gone !== undefined ? { gone: r.gone } : {}),
    ...(r.theme !== undefined ? { theme: r.theme } : {}),
    ...(r.glyph !== undefined ? { glyph: r.glyph } : {}),
    ...(daemonNotes.has(r.id) ? { daemonNote: daemonNotes.get(r.id)! } : {}),
    ...(r.daemonRefusedAt !== undefined ? { daemonRefusedAt: r.daemonRefusedAt } : {}),
    ...(r.vaultedAt !== undefined ? { vaultedAt: r.vaultedAt } : {}),
    ...(r.vaultRefused !== undefined ? { vaultRefused: r.vaultRefused } : {}),
    ...(r.wakeRefused !== undefined ? { wakeRefused: r.wakeRefused } : {}),
    ...(agentsOf(r) !== undefined ? { agents: agentsOf(r)! } : {}),
    ...(r.parentThreadId !== undefined ? { parentThreadId: r.parentThreadId } : {}),
    ...(r.rootThreadId !== undefined ? { rootThreadId: r.rootThreadId } : {}),
    ...(r.parentWorkspaceId !== undefined ? { parentWorkspaceId: r.parentWorkspaceId } : {}),
    ...(r.place !== undefined ? { place: r.place } : {}),
    ...(providerOf(r) !== undefined ? { provider: providerOf(r)! } : {}),
  });

  /** One fact of a workspace's look: a value sets it, null clears it back to none, and undefined leaves what the
   * record holds, so a picker sends its own fact without reading the other's. */
  const putLook = <K extends "theme" | "glyph">(r: WorkspaceRecord, key: K, value: WorkspaceRecord[K] | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) delete r[key];
    else r[key] = value;
  };

  const persist = async (r: WorkspaceRecord): Promise<void> => {
    const entry = live.get(r.id);
    if (entry !== undefined) entry.generation++;
    await store.put(WORKSPACES, r.id, r);
    // The two facts a machine's own labels cannot carry, written beside the record rather than only on a rename:
    // a sweep that finds the machine after this document is lost puts the record back under both.
    await store.put(WORKSPACE_NAMES, r.id, { workspaceId: r.id, name: r.name, project: r.project } satisfies NamedWorkspace);
  };

  const shapeOf = async (m: Machine): Promise<MachineShape | undefined> => {
    if (!m.describe) return undefined;
    return m.describe().catch(() => undefined);
  };

  /** The provider's word on what it built, falling back to the request where it has none. */
  const sizeBuilt = (shape: MachineShape | undefined, asked: WorkspaceSize): WorkspaceSize => ({
    cpu: shape?.cpu ?? asked.cpu,
    memMb: shape?.memMb ?? asked.memMb,
  });

  /** The guest's own count of its memory onto the row, since the provider's view echoes the memory asked for; true
   * where the count was read. A place's daemon already answers the size it applied and is never asked. */
  const readMemory = async (record: WorkspaceRecord, machine: Machine, sizes: MachineBackend["capabilities"]["sizes"]): Promise<boolean> => {
    const memMb = await machine.exec(MEM_READ, { timeoutMs: INLINE_EXEC_MS }).then(
      res => (res.exitCode === 0 ? memMbOf(readValues(res.stdout)) : `exit ${res.exitCode}${res.stderr.trim() === "" ? "" : `: ${res.stderr.trim().slice(-200)}`}`),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (typeof memMb === "string") console.warn(`workspace ${record.id}: memory not read on ${machine.id} (${memMb}); the row keeps ${sizeWord(record.size)}`);
    if (typeof memMb !== "number") return false;
    // The kernel keeps a few percent back: 4032 MB read on a 4096 MB machine.
    const offered = sizes.find(s => Math.abs(s.memMb - memMb) <= s.memMb / 16);
    // The count is the guest's word, and a guest can print any figure: no row or rate goes past the largest offer.
    const largest = Math.max(0, ...sizes.map(s => s.memMb));
    record.size = { ...record.size, memMb: offered?.memMb ?? (largest > 0 ? Math.min(memMb, largest) : memMb) };
    return true;
  };

  /** The workspaces forked from this snapshot, whatever their phase: the lineage retention must not cut. */
  const forkedFrom = (snapshotId: string): string[] => [...live.values()].filter(e => e.record.golden === snapshotId).map(e => e.record.name);

  /** Where this host can build a copy of its image, and which of them every road that names none means. */
  const places: PlaceBackends = opts.places ?? wiredPlace("default", backend);
  /** A place's copy of a golden. A state file the boot has not migrated yet carries the wired place's copy under
   * the bare name, so that key is read as a fallback for the wired place and for no other: a copy under the bare
   * key was built where this host forks, and reading it as another place's would say a place holds an image it has
   * never seen. */
  const bareFallback = (place: string): boolean => place === places.wired;
  const copyOf = async (place: string, name: string): Promise<GoldenManifest | undefined> =>
    ((await store.get(GOLDENS, copyKey(place, name))) ?? (bareFallback(place) ? await store.get(GOLDENS, name) : undefined)) as GoldenManifest | undefined;
  const putCopy = (place: string, name: string, manifest: GoldenManifest): Promise<void> => store.put(GOLDENS, copyKey(place, name), manifest);
  const copyRecipeOf = async (place: string, name: string, version: number): Promise<RecipeDigest | undefined> =>
    ((await store.get(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)))) ??
      (bareFallback(place) ? await store.get(GOLDEN_RECIPES, recipeKey(name, version)) : undefined)) as RecipeDigest | undefined;
  const putCopyRecipe = (place: string, name: string, version: number, digest: RecipeDigest): Promise<void> =>
    store.put(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)), digest);
  const dropCopyRecipe = async (place: string, name: string, version: number): Promise<void> => {
    await store.delete(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)));
    if (bareFallback(place)) await store.delete(GOLDEN_RECIPES, recipeKey(name, version));
  };

  /** A state file written before a golden was one place's copy holds its manifests and recipes under the bare name.
   * Each one moves under the wired place, and the old key goes only once the new one is there to be read: a put
   * that did not land leaves the copy where it was rather than taking it with the key.
   *
   * A host whose module forks nothing has no place to file a copy under: it is the module a host with no provider
   * key starts on, and the key it is given later swaps a different module in. Filing the golden under that module
   * would put it out of reach of every boot after the swap, so nothing moves until a boot knows what it forks on.
   * Runs once, at boot. */
  const migrateCopies = async (): Promise<void> => {
    if (forksNoMachines((places.backend(places.wired) ?? backend).capabilities)) return;
    for (const collection of [GOLDENS, GOLDEN_RECIPES]) {
      for (const key of await store.keys(collection)) {
        if (key.includes("/")) continue;
        const moved = copyKey(places.wired, key);
        if ((await store.get(collection, moved)) === undefined) {
          await store.put(collection, moved, await store.get(collection, key));
          // Read back before the old key goes: a put that did not land would take the copy with it.
          if ((await store.get(collection, moved)) === undefined) continue;
        }
        await store.delete(collection, key);
      }
    }
  };

  /** The image record this host owns for a golden: the one written at the seal, or, for a golden sealed before
   * records existed, what its wired copy's head already says. A backfilled record carries no small recipe and no
   * vault, so `wsp image` says the sign-ins are not held and a copy of it is refused until the next version. */
  const recordOf = async (name: string): Promise<SealedImage | undefined> => {
    const stored = (await store.get(IMAGES, name)) as SealedImage | undefined;
    if (stored !== undefined) return stored;
    const head = goldenHead(await copyOf(places.wired, name));
    if (head === undefined) return undefined;
    const digest = await copyRecipeOf(places.wired, name, head.version);
    const hash = digest === undefined ? "" : recipeHash(digest);
    return {
      name,
      version: head.version,
      hash: imageHash(hash, undefined, []),
      recipeHash: hash,
      logins: head.logins ?? [],
      sealedAt: head.createdAt,
      sealedFrom: hostId,
      ...(head.usedBytes !== undefined ? { usedBytes: head.usedBytes } : {}),
    };
  };

  /** Every snapshot and template id this state file stands on: each golden's versions and their templates, each
   * project golden, and the image every live workspace forks from. A row wsp made that is in none of them is an
   * orphan, whatever its name; a row in one of them is kept even when its name predates the owner mark. */
  const recordedImages = async (): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const raw of await store.list(GOLDENS)) {
      for (const v of (raw as GoldenManifest).versions) {
        ids.add(v.snapshotId);
        if (v.templateId !== undefined) ids.add(v.templateId);
      }
    }
    for (const raw of await store.list(PROJECT_GOLDENS)) ids.add((raw as ProjectGolden).snapshotId);
    for (const e of live.values()) ids.add(e.record.golden);
    return ids;
  };

  /** The manifest holding this snapshot as one of its versions, if any does. */
  const goldenManifestOf = async (snapshotId: string): Promise<GoldenManifest | undefined> => {
    for (const raw of await store.list(GOLDENS)) {
      const m = raw as GoldenManifest;
      if (m.versions.some(v => v.snapshotId === snapshotId)) return m;
    }
    return undefined;
  };

  /** The sealed version behind this snapshot, if any manifest knows it. */
  const goldenVersionOf = async (snapshotId: string): Promise<GoldenVersion | undefined> =>
    (await goldenManifestOf(snapshotId))?.versions.find(v => v.snapshotId === snapshotId);

  /** Whether the small recipe this version was sealed from asks for the engine socket on every fork: the sealed
   * record of the image whose wired copy holds this version says. A version no record names asks for none. */
  const recipeAsksEngine = async (version: GoldenVersion): Promise<boolean> => {
    for (const raw of await store.list(IMAGES)) {
      const image = raw as SealedImage;
      // A copy at any place carries the record's hash it was built from, whatever version number that place gave it.
      if (version.imageHash !== undefined && version.imageHash === image.hash) return image.recipe?.engine === true;
      if (image.version !== version.version) continue;
      const manifest = await copyOf(places.wired, image.name);
      if (manifest?.versions.some(v => v.snapshotId === version.snapshotId && v.version === version.version)) return image.recipe?.engine === true;
    }
    return false;
  };

  /** What stands behind a snapshot a workspace forks from: a golden version, or a project golden and the version at
   * the root of its lineage. `golden` is that root's snapshot id, the one a snapshot taken from the fork records. */
  const imageOf = async (snapshotId: string): Promise<{ golden: string; version?: GoldenVersion; projects?: WorkspaceProject[] }> => {
    const version = await goldenVersionOf(snapshotId);
    if (version !== undefined) return { golden: snapshotId, version };
    const stored = await store.get(PROJECT_GOLDENS, snapshotId);
    if (stored === undefined) return { golden: snapshotId };
    const project = projectGoldenOf(stored);
    const root = await goldenVersionOf(project.golden);
    return { golden: project.golden, ...(root !== undefined ? { version: root } : {}), projects: project.projects };
  };

  /** A project golden as stored, read as one of today: a manifest from before a snapshot carried every project on
   * the disk named the one it was taken for under `project`, and reads as a golden of that one. */
  const projectGoldenOf = (raw: unknown): ProjectGolden => {
    const { project: single, ...rest } = raw as Omit<ProjectGolden, "projects"> & { projects?: WorkspaceProject[]; project?: WorkspaceProject };
    return { ...rest, projects: rest.projects ?? (single !== undefined ? [single] : []) };
  };

  /** A status pushed outside the poll, for a phase change the poller would show
   * late. Machine state is what the phase implies: asking the provider here
   * would reset its idle timer for a fact the runtime already knows. The nap
   * countdown rides along as the poller sends it: a client replaces the whole
   * status, so leaving it out would blank the row until the next poll. */
  /** The reach the poll last measured for a workspace's running machine; a machine that is not running, or one
   * replaced since, leaves nothing here. Held because a status pushed between polls has to say something about the
   * reach and the runtime has no probe of its own. */
  const polledReach = new Map<string, { machineId: string; reach: ReachState }>();

  /** A pause the provider refused outright stands for that machine until one lands: Solari refuses every pause past its size cap (measured 2026-09-23). */
  const napRefusals = new Map<string, { machineId: string; said: string }>();
  const napRefusedOf = (entry: LiveWorkspace): string | undefined => {
    const refused = napRefusals.get(entry.record.id);
    if (refused === undefined) return undefined;
    if (refused.machineId === entry.machine.id) return refused.said;
    napRefusals.delete(entry.record.id);
    return undefined;
  };
  const napRefusedReason = (entry: LiveWorkspace): string | undefined => {
    const said = napRefusedOf(entry);
    return said === undefined ? undefined : napRefusedLine(said);
  };

  /** The reach a status pushed for a running machine carries: what the poll last measured, and where it has
   * measured nothing, the claim this kind's road makes. A measurement outranks the claim because the pushes that
   * carry a line about the daemon happen exactly when the daemon is dead: claiming reachable there paints the row
   * as answering, and leaves the poll's own no-daemon looking like a repeat of the claim, which the bus drops. */
  const reachOf = (entry: LiveWorkspace): ReachState => {
    if (unreachedOf(entry) !== undefined) return "unreachable";
    const seen = polledReach.get(entry.record.id);
    if (seen !== undefined && seen.machineId === entry.machine.id) return seen.reach;
    // The same reading the status poll makes: a machine wsp can ask at all, by a route or by its own answer.
    return moduleOf(entry.record.kind).hasDaemon(entry) || entry.machine.daemonAnswers !== undefined ? "reachable" : "unsupported";
  };
  const emitStatus = async (entry: LiveWorkspace, reach: ReachState, reason?: string): Promise<void> => {
    const size = entry.record.size;
    const idleAt = entry.record.phase === "running" ? idle.idleAt(entry.record.id) : undefined;
    bus.emit({
      type: "workspace.status",
      status: {
        ...view(entry.record),
        machineState: machineStateOf(entry.record.phase),
        reach: { state: reach },
        size,
        rateUsdPerHour: backendFor(entry.record).pricing.rateUsdPerHour(size),
        ...(reason !== undefined ? { reason } : {}),
        ...(entry.wakeAsk !== undefined ? { wakeAsk: entry.wakeAsk } : {}),
        ...(idleAt !== undefined ? { idleAt } : {}),
      },
    });
  };

  /** One line about the wake in flight, pushed now and kept on the entry so the poll's own statuses carry it too. */
  const saysWaking = async (entry: LiveWorkspace, words: string): Promise<void> => {
    entry.wakeSaid = words;
    await emitStatus(entry, "napping", words);
  };

  /** The one preamble every dial this runtime makes to a machine's daemon repeats: the preview route, then this
   * runtime's token on the guest, then the link. null when the guest holds no daemon token, which each caller reads
   * its own way. The caller owns the link and closes it; the previewUrl guard stays with the caller, which knows
   * what a backend without preview routes means for it. */
  const dialDaemon = async (entry: LiveWorkspace, deadline: number, o: { onEvent?: (e: DaemonEvent) => void; heartbeatMs?: number } = {}): Promise<DaemonReach | null> => {
    const reach = await until(entry.ws.daemonReach(), deadline, "preview route");
    const token = await until(daemonTokenOf(entry.machine), deadline, "daemon token");
    if (token === undefined) return null;
    return connectDaemon({ previewUrl: reach.url, token, onEvent: o.onEvent ?? (() => {}), ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}) });
  };

  /** How long one ask of a machine's own daemon check gets, and how long before the next one: the budget is the
   * whole of what the daemon is given, and a boot that is still coming up answers no rather than nothing. */
  const ASK_DAEMON_MS = 5_000;
  const ASK_AGAIN_MS = 500;

  /** The daemon answering is what proves a resumed guest serves; resume() returning does not (a zombie reports
   * running for 10+ minutes while exec and the edge 502). Asked over the machine's own road where it has one and
   * through the edge where the route is the only way in, since the two readings of one machine's reach would
   * otherwise disagree: a container's published port is on the loopback of the box that runs it, and a host that
   * is not that computer would fail this check on a live guest, which on a backend whose wake takes one attempt
   * throws the container away and forks the golden again. A machine with neither road has nothing to ask, so the
   * check falls back to the shape comparison. */
  const pingDaemon = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const machine = entry.machine;
    const answersMs = lifecycleOf(entry).budgets.daemonAnswersMs;
    if (machine.daemonAnswers !== undefined) {
      const deadline = clock.now() + answersMs;
      try {
        // Asked again until the budget is out rather than once at the start of it: a machine that was stopped for
        // its nap rather than frozen comes back with its boot still running, and the budget is what the daemon is
        // given to answer in. A machine that answers at once costs one ask, as it always did.
        for (;;) {
          const up = await until(machine.daemonAnswers({ timeoutMs: Math.min(answersMs, ASK_DAEMON_MS) }), deadline, "daemon answer");
          if (up) return undefined;
          if (clock.now() >= deadline) return `nothing listens on the daemon's port inside ${machine.id}`;
          await new Promise<void>(done => clock.schedule(done, ASK_AGAIN_MS, { unref: true }));
        }
      } catch (e) {
        // The error is in hand here, so it is what the row says: only the edge road, which learns nothing but that
        // it waited, reports the budget.
        return `the daemon on ${machine.id} could not be asked (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    if (!machine.previewUrl) return undefined;
    const deadline = Date.now() + answersMs;
    let link: DaemonReach | null = null;
    try {
      link = await dialDaemon(entry, deadline, { heartbeatMs: answersMs });
      if (link === null) {
        // No daemon to ask; an exec that returns is the guest's own answer.
        await until(machine.exec("true"), deadline, "guest exec");
        return undefined;
      }
      await until(link.ready, deadline, "daemon link");
      await until(link.request("ping"), deadline, "daemon ping");
      return undefined;
    } catch (e) {
      return `daemon on ${machine.id} did not answer within ${answersMs} ms (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      link?.close();
    }
  };

  /** The version the machine's daemon announces in its hello, null when no daemon answers within the bound: a
   * daemon says what it is on connect and answers no op for it, so reading the version is one dial and one frame.
   * A machine whose daemon is gone, whose backend mints no preview route or whose guest holds no token has none. */
  const helloVersion = async (entry: LiveWorkspace): Promise<number | null> => {
    if (!entry.machine.previewUrl) return null;
    const deadline = Date.now() + daemonHelloTimeoutMs;
    let link: DaemonReach | null = null;
    try {
      let announce: (v: number) => void = () => {};
      const hello = new Promise<number>(done => (announce = done));
      link = await dialDaemon(entry, deadline, { onEvent: e => (e.type === "daemon.hello" ? announce(daemonVersionOf(e)) : undefined) });
      if (link === null) return null;
      return await until(hello, deadline, "daemon hello");
    } catch {
      return null;
    } finally {
      link?.close();
    }
  };

  /** The machine's row now, rather than at the next poll. A machine that stopped running is left to the poller:
   * only it knows what that machine's reach is by then. */
  const pushStatus = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running") return;
    await emitStatus(entry, reachOf(entry));
  };

  /** The line the machine's row carries while the runtime is doing something to its daemon; undefined clears it. */
  const noteDaemon = async (entry: LiveWorkspace, note: string | undefined): Promise<void> => {
    if (note === undefined) daemonNotes.delete(entry.record.id);
    else daemonNotes.set(entry.record.id, note);
    await pushStatus(entry);
  };

  /** A line for the machine's row that rides one status and no more, so the next poll shows the row's own facts
   * again. What the row is for is the machine's rate and its nap countdown; a failure nobody here can act on must
   * not sit on top of them for the life of the host. */
  const flashDaemon = async (entry: LiveWorkspace, note: string): Promise<void> => {
    daemonNotes.set(entry.record.id, note);
    await pushStatus(entry);
    daemonNotes.delete(entry.record.id);
  };

  /** The folders the record says this machine's daemon may browse beside its home. Derived state: the record is the
   * one place, and the file follows it on every connect, so a project that landed before the daemon read that file
   * is browsable without a second import. Non-fatal: an update or a turn must not fail on it. */
  const writeDaemonRoots = async (entry: LiveWorkspace): Promise<void> => {
    // A host that has closed writes nothing more on a machine: the boot fires this at every running workspace
    // without waiting for it, and a write that landed after the close would be this process touching a computer
    // it has let go of.
    if (closed) return;
    // And nothing is written inside a workspace whose computer serves its daemon: that daemon reads the path off
    // the frame and browses the workspace's own rootfs, so a list of folders inside it says nothing to anybody.
    if (servedByItsComputer(entry) !== undefined) return;
    // Every checkout the daemon serving this machine has to browse, not this workspace's alone: the file is that
    // daemon's one list and is written whole, and on the computer the host runs on one daemon serves every
    // workspace here, each in a copy of the project folder at a path of its own.
    const sharing = [...live.values()].filter(e => e.record.machineId === entry.record.machineId);
    const dests = [...new Set(sharing.flatMap(e => [projectHeld(e.record.project).path, checkoutOf(e.record)]))];
    // Through the kind, which is what knows where that machine's daemon looks; the import road writes the same
    // file through the same call, so a folder is browsable at the same path whichever of the two got there first.
    await moduleOf(entry.record.kind)
      .roots(entry, dests)
      .catch((e: unknown) => console.warn(`browsable folders for ${entry.record.id} not written on ${entry.machine.id}: ${(e instanceof Error ? e.message : String(e)).slice(-200)}`));
  };

  /** Settles once no turn is running on the workspace: at once when none is, else when the last one ends. Replacing
   * the daemon ends the ptys under it, so the work a person or an agent started finishes first. */
  const turnRuns = (workspaceId: string): boolean => [...sessions.values()].some(s => s.view.workspaceId === workspaceId && s.view.status === "running");

  const whenNoTurnRuns = (workspaceId: string): Promise<void> => {
    if (!turnRuns(workspaceId)) return Promise.resolve();
    return new Promise(done => {
      // A turn leaves running on its done or its end and on nothing else, so this wakes twice a turn rather than
      // once per output chunk of every workspace on the bus.
      const offs: (() => void)[] = [];
      const check = (): void => {
        if (turnRuns(workspaceId)) return;
        for (const off of offs) off();
        done();
      };
      offs.push(bus.on("session.done", check), bus.on("session.end", check));
    });
  };

  /** Whether this runtime has a road to put a daemon on a machine: the kind's own module must have one wired, since
   * what a deploy needs differs by kind and only the module knows whether its host gave it one, and the bundle has
   * to reach the machine, which is the machine's own question and not its kind's. Both roads into updateDaemon
   * read this, so neither offers to deploy where the other would not. */
  const canDeployDaemon = (entry: LiveWorkspace): boolean =>
    // Nothing is put inside a workspace whose computer serves its daemon: the daemon answering for it is that
    // computer's own, moved as a computer and never as a workspace. Read here, so neither the sync nor the revive
    // offers a deploy the update would refuse.
    servedByItsComputer(entry) === undefined &&
    moduleOf(entry.record.kind).deployDaemon !== undefined &&
    landsBytes(backendFor(entry.record).capabilities, entry.machine);

  /** Every road that puts a daemon on a machine runs the kind's deploy through here, and this is the one place
   * that writes down how it went: a machine that answered with what it lacks keeps its own sentence and the
   * moment it said it, and every other ending takes them off. The record rather than a map in this process,
   * because the whole point of remembering is the next host start. */
  const deployDaemonOn = async (entry: LiveWorkspace, deploy: (e: LiveWorkspace) => Promise<void | string>): Promise<void | string> => {
    const forget = async (): Promise<void> => {
      if (entry.record.daemonRefusedAt === undefined) return;
      delete entry.record.daemonRefusedAt;
      await persist(entry.record);
    };
    try {
      const detail = await deploy(entry);
      await forget();
      return detail;
    } catch (e) {
      // Which of the three endings this is decides what the record keeps. A deploy that got past the machine's
      // own checks and fell over later proves the machine no longer lacks what it named, whatever else went
      // wrong. A machine that never answered proves nothing either way, and a box switched off has not stopped
      // lacking a compiler, so what the record already knows stands and its hour keeps running.
      const lacks = machineLacksLine(e);
      if (lacks !== undefined) {
        entry.record.daemonRefusedAt = { machineId: entry.machine.id, at: new Date(clock.now()).toISOString(), why: lacks };
        await persist(entry.record);
      } else if (!machineNeverAnswered(e)) await forget();
      throw e;
    }
  };

  /** What the machine under this record last said it lacks, and nothing another machine said: a machine replaced
   * under the record answers for itself, so the old one's sentence comes off rather than sitting on the record
   * for good and being shown on a row for a machine that is gone. */
  const lacksSaid = async (entry: LiveWorkspace): Promise<{ at: string; why: string } | undefined> => {
    const refused = entry.record.daemonRefusedAt;
    if (refused === undefined) return undefined;
    if (refused.machineId === entry.machine.id) return refused;
    delete entry.record.daemonRefusedAt;
    await persist(entry.record);
    return undefined;
  };

  /** Everything the runtime settles with a machine's daemon the moment it can reach it, and the only place that
   * does: the folders the record says it may browse, then a daemon older than this wsp replaced with this one's,
   * waiting out any running turn first. Nobody asks for it, and nothing about it is a person's to know: the panes
   * that need the new ops simply work once it lands. A failure leaves the old daemon serving, says so on the row
   * once, and puts the reason in this host's log, where the person who runs the host can read it.
   * One run per machine at a time, so two connects at once do the work once. */
  const daemonSyncs = new Map<string, Promise<void>>();
  const syncDaemon = (entry: LiveWorkspace): Promise<void> => {
    const key = entry.machine.id;
    const held = daemonSyncs.get(key);
    if (held !== undefined) return held;
    const work = (async () => {
      const module = moduleOf(entry.record.kind);
      // Nothing is deployed into a workspace whose computer serves its daemon, and no roots file is written in it:
      // the daemon answering for it is that computer's own, which the update road moves as a computer and not as a
      // workspace.
      if (servedByItsComputer(entry) !== undefined) return;
      // A machine that answered with what it lacks is left alone until its window is out, whether it is being
      // given a first daemon or having one replaced: the thing it has not got stops both roads, and only a person
      // can change that answer. Read off the record above every round trip below, so a tick that finds the window
      // still holding costs that machine nothing. Whether a daemon is being placed or replaced decides the words
      // alone, which say installing rather than updating.
      const placing = !module.hasDaemon(entry);
      const said = await lacksSaid(entry);
      if (said !== undefined && clock.now() - Date.parse(said.at) < DAEMON_LACKS_AGAIN_MS) return;
      await writeDaemonRoots(entry);
      // A host that cannot deploy asks no version: a line would promise an ask that changes nothing, at every connect.
      if (!canDeployDaemon(entry)) return;
      const version = await module.daemonVersion(entry);
      if (version === null) {
        unreadAt.set(entry.record.id, { machineId: key, at: clock.now() });
        console.warn(`daemon on ${key} (workspace ${entry.record.id}): version not read within ${daemonHelloTimeoutMs / 1000} s; asking again at the next reach probe`);
        return;
      }
      unreadAt.delete(entry.record.id);
      if (version >= DAEMON_VERSION) return;
      if (turnRuns(entry.record.id)) console.warn(`daemon on ${key} (workspace ${entry.record.id}): update waits for the running turn`);
      await whenNoTurnRuns(entry.record.id);
      if (entry.record.phase !== "running") return;
      await noteDaemon(entry, placing ? DAEMON_INSTALLING : DAEMON_UPDATING);
      // Marking the row awaits a push, which is several ticks wide; a turn that opened inside that window would
      // lose its ptys to the deploy, so the wait runs again until nothing is running as the deploy starts.
      while (turnRuns(entry.record.id)) await whenNoTurnRuns(entry.record.id);
      // The last read before the deploy: a machine that napped under the wait is handed no exec on a paused sandbox.
      if (entry.record.phase !== "running") {
        await noteDaemon(entry, undefined);
        return;
      }
      try {
        // The update verb's door refuses a workspace still creating, which is when the create's sync runs.
        await deployDaemonOn(entry, module.deployDaemon!);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went under the update did not fail one: its row says what its phase says.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) ${placing ? "not installed" : "not updated"}: ${reason}`);
        // The machine's own sentence where it gave one: it is one line, it names the thing the machine has not
        // got, and a person can act on it. A deploy that failed further in gives an npm log instead, which is
        // hundreds of characters of nothing anybody reading a row can do.
        await flashDaemon(entry, machineLacksLine(e) ?? (placing ? DAEMON_INSTALL_FAILED : DAEMON_UPDATE_FAILED));
      }
    })();
    daemonSyncs.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonSyncs.get(key) === work) daemonSyncs.delete(key);
    });
    return work;
  };

  /** Keyed by the workspace and holding the machine it was about, so a machine replaced under the record inherits nothing. */
  type MachineMoment = { machineId: string; at: number };
  /** Every attempt to put a daemon back on a workspace's current machine, and when the last one was. */
  const revivedAt = new Map<string, MachineMoment>();
  /** Every workspace whose last sync could not read its daemon's version, and when that read gave up. */
  const unreadAt = new Map<string, MachineMoment>();
  /** Every workspace whose machine the provider last answered it cannot reach, with the sentence its row carries. */
  const unreached = new Map<string, { machineId: string; line: string }>();
  /** The mark on the entry's own machine; one a replaced machine left is dropped here. */
  const unreachedOf = (entry: LiveWorkspace): string | undefined => {
    const mark = unreached.get(entry.record.id);
    if (mark === undefined) return undefined;
    if (mark.machineId === entry.machine.id) return mark.line;
    unreached.delete(entry.record.id);
    return undefined;
  };
  const daemonRevivals = new Map<string, Promise<void>>();

  /** A running machine whose daemon port answers nothing gets this runtime's daemon put back on it, on the same
   * road the doctor and the golden build use and with the workspace's own token. The kernel's memory killer took
   * a daemon once and the machine sat with none for five hours while its turns, which go over the provider's
   * exec, kept running, so only the reach probe noticed (2026-09-08). Every poll that
   * measures the machine calls this, not every status the bus carries: a machine parked at no-daemon builds the
   * same status each time and the bus rightly drops the repeats, so a road listening there would try once and
   * never again. The probe window is behind the word already, since reachShown gives a row no-daemon only on the
   * second unanswered probe in a row. Unlike an update this waits out no turn: a daemon that answers nothing holds
   * no ptys to lose. One run per machine at a time. */
  const reviveDaemon = (entry: LiveWorkspace, reach: ReachState): void => {
    if (reach !== "no-daemon" || entry.record.phase !== "running") return;
    // A deploy rides the exec the provider is refusing, and its failure would flash over the row's own sentence.
    if (!canDeployDaemon(entry) || unreachedOf(entry) !== undefined) return;
    const key = entry.machine.id;
    if (daemonRevivals.has(key)) return;
    const last = revivedAt.get(entry.record.id);
    if (last !== undefined && last.machineId === key && clock.now() - last.at < DAEMON_REVIVE_AGAIN_MS) return;
    revivedAt.set(entry.record.id, { machineId: key, at: clock.now() });
    const deploy = moduleOf(entry.record.kind).deployDaemon!;
    const work = (async () => {
      await noteDaemon(entry, DAEMON_RESTARTING);
      // The last read before the deploy: a machine that napped under the note is handed no exec on a paused sandbox.
      if (entry.record.phase !== "running") {
        await noteDaemon(entry, undefined);
        return;
      }
      try {
        await deployDaemonOn(entry, deploy);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went while the daemon was going back on did not fail a restart.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) not restarted: ${reason}`);
        await flashDaemon(entry, DAEMON_RESTART_FAILED);
      }
    })();
    daemonRevivals.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonRevivals.get(key) === work) daemonRevivals.delete(key);
    });
  };

  /** A machine that answered with what it lacks is offered the daemon again on the first poll after its hour is
   * out, with this host never restarted. For a machine over ssh the sync runs at hydrate and at a machine swap and
   * nowhere else, so a person who installed the compiler their machine asked for would read the refusal on their
   * row until they restarted the host. The hour itself stays where it is decided, in the sync; this says only
   * which machines are worth asking it about, and asks about none the poll did not just hear from: a status
   * carries the machine's own facts only when it answered a dial this tick, so a box that is off is left alone
   * rather than dialled a second time for the same silence, and so is one whose answer came back unreadable. The
   * window restarts on each refusal, so a machine still lacking what it named is asked once an hour and not once
   * a tick.
   * The evidence is the kind's own read of what its machine is, so only a kind whose machines answer that read can
   * be offered again: one that cannot say what it is gives the same nothing whether it is up or dark. What makes
   * that whole is that a place asks its machine for something only where wsp did not build that machine, and a
   * machine that already existed is one that answers the read; a fork asks nothing, so it records no refusal for
   * anything to re-offer. A check added to a place whose machines answer no such read would sit on its row for
   * good, so that kind answers for itself here first. */
  const offerDaemonAgain = (entry: LiveWorkspace, polled: WorkspaceStatus): void => {
    if (entry.record.daemonRefusedAt === undefined || polled.facts === undefined) return;
    void syncDaemon(entry);
  };

  /** Nothing else runs the sync again before the next connect, and a hello that missed it leaves an old daemon serving. */
  const readVersionAgain = (entry: LiveWorkspace, polled: WorkspaceStatus): void => {
    const unread = unreadAt.get(entry.record.id);
    if (unread === undefined) return;
    if (unread.machineId !== entry.machine.id) {
      unreadAt.delete(entry.record.id);
      return;
    }
    if (polled.phase !== "running" || polled.reach.state !== "reachable" || clock.now() - unread.at < DAEMON_REVIVE_AGAIN_MS) return;
    void syncDaemon(entry);
  };

  /** Size is always explicit: a create that names none gets the provider's own
   * default (2048 MB on Solari), not the size the record and the rate assume. */
  const forkSpec = (r: WorkspaceRecord, kind: MachineKind, image: ReturnType<typeof goldenImage>["spec"] | undefined, engine: boolean, override?: WorkspaceSpec): MachineSpec & WorkspaceSize => ({
    ...image,
    kind,
    ...(engine ? { engine: true } : {}),
    // The project's own folders on its computer, as the create recorded them: a wake mounts what the create did,
    // and the copy of the checkout it was made with is made again from the same folder.
    ...(r.spec.binds !== undefined && r.spec.binds.length > 0 ? { binds: r.spec.binds } : {}),
    ...(r.spec.copy !== undefined ? { copy: r.spec.copy } : {}),
    // The view's size rather than the row's: the row carries the guest's count, which no offer need match.
    cpu: override?.cpu ?? r.shape?.cpu ?? r.size.cpu,
    memMb: override?.memMb ?? r.shape?.memMb ?? r.size.memMb,
    envs: { ...loginEnvOn(r.place), ...r.spec.envs, ...override?.envs },
    labels: { ...r.spec.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: owner, [WORKSPACE_LABEL]: r.id, [NAME_LABEL]: r.name, [GOLDEN_LABEL]: r.golden, [CREATED_AT_LABEL]: new Date().toISOString() },
    onIdle: "pause",
    idleTimeoutMs: backstopMs(idleWindowOf(r)),
  });

  let owner = "";

  /** The store holds the attempt's key and stamp before the provider hears of it: a retry the provider never answered
   * (the connection dropped, the process died) sends the same body under the same key and gets back the machine the
   * first try booted. An answer of any kind ends the attempt and a changed request starts one, so the key after a kill
   * or a refusal is always fresh. A replay naming a dead machine is dropped and the create made anew (measured
   * 2026-09-04: the provider replays a killed machine's id). Another live process's attempt is never joined. */
  const keyedCreate = async (at: MachineBackend, purpose: string, spec: MachineSpec, afterCorpse = false): Promise<Machine> => {
    const body = fingerprint(spec);
    const held = (await store.get(CREATES, purpose)) as PendingCreate | undefined;
    const theirs = held !== undefined && (held.host !== hostId || (held.pid !== process.pid && pidAlive(held.pid)));
    const name = purpose.length <= KEY_PURPOSE_MAX ? purpose : createHash("sha256").update(purpose).digest("hex");
    const attempt: PendingCreate = held?.body === body && !theirs
      ? { ...held, host: hostId, pid: process.pid }
      : { key: `${name}:${randomBytes(8).toString("hex")}`, createdAt: new Date().toISOString(), body, host: hostId, pid: process.pid };
    await store.put(CREATES, purpose, attempt);
    let machine: Machine;
    try {
      machine = await at.create({
        ...spec,
        idempotencyKey: attempt.key,
        ...(spec.labels?.[CREATED_AT_LABEL] !== undefined ? { labels: { ...spec.labels, [CREATED_AT_LABEL]: attempt.createdAt } } : {}),
      });
    } catch (e) {
      if (typeof (e as WspError).status === "number") await store.delete(CREATES, purpose);
      throw e;
    }
    await store.delete(CREATES, purpose);
    if (machine.replayed === true) {
      if ((await machine.state()) === "gone") {
        if (afterCorpse) throw new Error(`create for ${purpose}: the provider replayed ${machine.id}, which is gone, under a key it had never seen (${attempt.key})`);
        console.warn(`create for ${purpose}: the replay under ${attempt.key} named ${machine.id}, which is gone; creating anew`);
        return keyedCreate(at, purpose, spec, true);
      }
      console.warn(`create for ${purpose}: ${machine.id} replayed from an earlier attempt under ${attempt.key}`);
    }
    return machine;
  };

  /** Ids this process has created and not yet recorded; the sweep must not read them as lost. */
  const inflight = new Set<string>();
  /** purpose names the record every create inside run is for; its attempts are keyed under it. */
  const claiming = <T>(purpose: string, run: (b: MachineBackend) => Promise<T>, at: MachineBackend = backend): Promise<T> => {
    const mine: string[] = [];
    const b: MachineBackend = {
      capabilities: at.capabilities,
      pricing: at.pricing,
      // The golden's builder is created through this handle, so the image the provider boots from rides along.
      ...(at.baseTemplates !== undefined ? { baseTemplates: at.baseTemplates } : {}),
      // And whether this backend's machines come up under the workspace's own name, since the fork behind this
      // handle is what would name one again.
      ...(at.namesWorkspace !== undefined ? { namesWorkspace: at.namesWorkspace } : {}),
      get: id => at.get(id),
      list: labels => at.list(labels),
      deleteSnapshot: id => at.deleteSnapshot(id),
      // Every call a backend may or may not carry, in one place: a module keeps its methods on its prototype, so
      // this handle cannot be a spread of the backend, and a call left out is one the roads inside here lose.
      ...forwardedCalls(at),
      create: async spec => {
        const m = await keyedCreate(at, purpose, spec);
        inflight.add(m.id);
        mine.push(m.id);
        return m;
      },
    };
    return run(b).finally(() => mine.forEach(id => inflight.delete(id)));
  };
  /** The machine with its exec reported to the recipe's listener; every other member is the provider's own, bound to it.
   * A listener that throws is warned about once and never changes an exec's result: the log records the run, it cannot fail it. */
  const observed = (machine: Machine): Machine => {
    const onExec = opts.goldenRecipe?.onExec;
    if (onExec === undefined) return machine;
    let unheard = false;
    const report = (exec: GoldenExec): void => {
      try {
        onExec(exec);
      } catch (e) {
        if (unheard) return;
        unheard = true;
        console.warn(`exec log for ${machine.id} failed, its execs go on unlogged: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const reported = async (cmd: string, call: () => Promise<ExecResult>, unlogged = false): Promise<ExecResult> => {
      const t0 = Date.now();
      try {
        const res = await call();
        // A command that says its answer is the person's own file is recorded as having run and exited; what it
        // printed is that file, and a log kept on their disk is no place for it.
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, ...(unlogged ? { exitCode: res.exitCode } : res) });
        return res;
      } catch (e) {
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => reported(cmd, () => machine.exec(cmd, o));
    // A run is one command to the log, however many execs carry it.
    const run = (script: string, o: RunOptions): Promise<ExecResult> => reported(script, () => machine.run(script, o), o.unlogged === true);
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
        if (prop === "run") return run;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  /** The entry's machine with every exec and run read for the provider's word that it cannot reach it: that refusal
   * marks the workspace and puts the sentence on the row now, and any answer takes the mark off for the next tick to
   * say, since a push here would carry the marked tick's reach without its sentence. */
  const watched = (entry: LiveWorkspace, machine: Machine): Machine => {
    const heard = async (call: () => Promise<ExecResult>): Promise<ExecResult> => {
      let res: ExecResult;
      try {
        res = await call();
      } catch (e) {
        if (e instanceof MachineUnreachableError && entry.machine.id === machine.id) {
          const standing = unreached.get(entry.record.id)?.machineId === machine.id;
          unreached.set(entry.record.id, { machineId: machine.id, line: e.message });
          if (!standing && entry.record.phase === "running") await emitStatus(entry, "unreachable", e.message);
        }
        throw e;
      }
      if (unreached.get(entry.record.id)?.machineId === machine.id) unreached.delete(entry.record.id);
      return res;
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => heard(() => machine.exec(cmd, o));
    const run = (script: string, o: RunOptions): Promise<ExecResult> => heard(() => machine.run(script, o));
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
        if (prop === "run") return run;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  const observing = (b: MachineBackend): MachineBackend => ({ ...b, create: async spec => observed(await b.create(spec)), get: async id => observed(await b.get(id)) });
  /** Boots a golden fork for the record and writes back what the provider says it built.
   * A snapshot restores as the kind it was taken from, so the spec names that kind;
   * versions sealed before it was recorded were all sandbox. The create reads the guest's memory itself, once its
   * daemon has answered, so it forks with `readsMemory` off. */
  const fork = (record: WorkspaceRecord, bind: (machine: Machine) => void, override?: WorkspaceSpec, report?: StageReport, readsMemory = true): Promise<Machine> =>
    claiming(
      `workspace/${record.id}`,
      async b => {
        const image = keepsImages(b) ? await imageOf(record.golden) : undefined;
        const golden = image?.version;
        // A project golden's snapshot is the image; only a version's own snapshot may stand behind a template.
        const spec = forkSpec(record, golden?.kind ?? "sandbox", image === undefined ? undefined : goldenImage(image.projects === undefined && golden !== undefined ? golden : { snapshotId: record.golden }).spec, record.spec.engine === true || (golden !== undefined && (await recipeAsksEngine(golden))), override);
        // A place that has never held this image says missing about a reference no registry has: the fork lands
        // nowhere and the sentence says where it would land until that place holds a copy.
        const machine = await b.create(spec).catch((e: unknown) => {
          if (image === undefined || record.place === undefined || !isMissing(e)) throw e;
          throw Object.assign(new Error(placeHoldsNoImageLine(placeDoorOf().nameOf(record.place), spec.fromSnapshot ?? spec.template ?? record.golden)), { kind: "invalid" });
        });
        // Named by its record before the claim is released, so no sweep sees it unclaimed.
        bind(machine);
        // No line for the machine coming up: the starting line above is the step a person waits through, and a
        // fork's own id names nothing to them.
        // A machine that boots under the workspace's name is not named again: the name is on the specification the
        // computer booted it from, and the command here runs inside the workspace, where it has no right to change
        // the host name and says so on every create.
        if (!namesWorkspace(b)) {
          const named = await setHostname(machine, record.name);
          if (named.refused === undefined) report?.("hostname-set", hostnameSetLine(named.host));
          else report?.("hostname-set", HOSTNAME_KEPT, { detail: named.refused });
        }
        // The fork carries the golden's copy; this one names the workspace and reads the disk and secrets as they are now.
        const context = await applyMachineContext(machine, { workspace: { name: record.name }, ...(golden !== undefined ? { golden } : {}) });
        if (context.failure !== undefined) console.warn(`machine context for ${record.id} on ${machine.id} ${context.summary}`);
        const shape = await shapeOf(machine);
        if (shape !== undefined) record.shape = shape;
        else delete record.shape;
        record.size = sizeBuilt(shape, spec);
        if (readsMemory && record.place === undefined) await readMemory(record, machine, b.capabilities.sizes);
        if (machine.streamUrl !== undefined) record.screen = { streamUrl: machine.streamUrl };
        else delete record.screen;
        return machine;
      },
      // The record says where its machine lives: this host's own provider, or the computer it was forked on.
      backendFor(record),
    );

  /** The machine a fork made, taken away and proven gone at the provider rather than at the delete's answer: a
   * DELETE Solari takes and does not act on would otherwise read as a machine that went. Rejects while the
   * provider still holds it, which is what keeps a record naming it. */
  const unfork = (entry: LiveWorkspace): Promise<void> => killUntilGone(backendFor(entry.record), entry.machine, opts.killConfirm);

  /** The engine knows three phases. A pause in flight is a nap to it (the wake resumes either way); a gone record's
   * machine is a stand-in it only ever meets through rebuild, which replaces the machine whatever the phase says. */
  const enginePhaseOf = (phase: WorkspacePhase): EnginePhase => {
    switch (phase) {
      case "running":
      case "napping":
      case "waking":
        return phase;
      case "pausing":
      case "gone":
        return "napping";
      default: {
        const _exhaustive: never = phase;
        return "running";
      }
    }
  };

  /** The record follows the engine once a wake, upgrade or rebuild put a machine under it; a gone record is gone no more. */
  const followMachine = (entry: LiveWorkspace): void => {
    entry.record.phase = "running";
    entry.record.machineId = entry.ws.machineId;
    entry.record.firstLife = entry.ws.isFirstLife;
    delete entry.record.gone;
    void syncDaemon(entry);
  };

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace, generation: (live.get(record.id)?.generation ?? -1) + 1 };
    entry.machine = watched(entry, machine);
    const at = backendFor(record);
    /** A vault carries a workspace's own home onto a fresh fork of an image. A computer that keeps no image forks
     * none: such a workspace is a copy of that computer, its files stand on that computer's own disk, and its
     * pause is the stop of its machine there. So it gets none of the four hooks, a nap reads nothing off it and
     * stores nothing, a wake puts nothing back, and a stamp or a refusal an earlier nap wrote on its record is
     * about a vault it never had and goes. */
    const vaulted = keepsImages(at);
    if (!vaulted) {
      delete record.vaultedAt;
      delete record.vaultRefused;
    }
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        // A kind that declares no lifecycle has its nap and wake refused before the engine is asked, so it never wakes.
        wakeAttempts: at.lifecycle?.budgets.wakeAttempts ?? 0,
        retire: m => gone.stop(at, m),
        resurrect: (override?: Partial<MachineSpec>) =>
          fork(record, m => {
            entry.machine = watched(entry, m);
          }, override),
        ...(vaulted
          ? ({
              vaultExport: (m, drop) => vaultExport(m, drop === undefined ? {} : { drop }),
              vaultImport: async (m, payload) => {
                await importInto(m, payload, "/");
              },
              stashVault: async m => {
                // The vault the last landed nap stored stands until the provider pauses this machine at all.
                if (napRefusedOf(entry) !== undefined) return;
                // A box's pause keeps the disk alone, so it is synced first; a machine that cannot be asked still pauses.
                await syncDisk(entry.machine).catch((e: unknown) => {
                  console.warn(`disk sync before the nap of ${record.id} failed: ${e instanceof DiskSyncError ? e.answer : e instanceof Error ? e.message : String(e)}; napping anyway`);
                });
                try {
                  await store.putBlob(VAULTS, record.id, await vaultExport(m, { maxBytes: vaultCapBytes }));
                  record.vaultedAt = new Date(clock.now()).toISOString();
                  delete record.vaultRefused;
                } catch (e) {
                  const why = e instanceof Error ? e.message : String(e);
                  // The record carries it, and the record alone: the files stay unbacked until a nap stores one, so the
                  // verdict stands on the pane's own backup line rather than passing through one nap's status.
                  record.vaultRefused = why;
                  console.warn(`nap vault for ${record.id} not stored, previous kept: ${why}`);
                }
              },
              restoreVault: async m => {
                const payload = await store.getBlob(VAULTS, record.id);
                if (payload !== undefined) await importInto(m, payload, "/");
              },
            } satisfies Pick<WorkspaceHooks, "vaultExport" | "vaultImport" | "stashVault" | "restoreVault">)
          : {}),
        // The backend settles its own moves under its own budgets; the runtime sends each once, hands the resume
        // the person's stop, and says on the row that a resume the backend gave up on is being read about.
        move: (m, move) =>
          move === "resume"
            ? m.resume(entry.wakeStop?.signal).catch(async (e: unknown) => {
                if (e instanceof ResumeUnansweredError) await saysWaking(entry, RESUME_UNANSWERED);
                throw e;
              })
            : m.pause(),
        wakeCheck: async m => {
          const expected = record.shape;
          let both = "";
          if (expected !== undefined && m.describe) {
            let actual: MachineShape;
            try {
              actual = await m.describe();
            } catch (e) {
              return `provider view of ${m.id} unavailable (${e instanceof Error ? e.message : String(e)})`;
            }
            both = `created as ${JSON.stringify(expected)}, provider view ${JSON.stringify(actual)}`;
            const fault = shapeFault(expected, actual);
            if (fault !== undefined) {
              console.warn(`wake check on ${m.id}: ${fault}; ${both}`);
              return `${fault} on ${m.id} (${both})`;
            }
          }
          const fault = await pingDaemon(entry);
          return fault === undefined || both === "" ? fault : `${fault} (${both})`;
        },
      },
      { phase: enginePhaseOf(record.phase), firstLife: record.firstLife },
    );
    live.set(record.id, entry);
    return entry;
  };

  const idleWindowOf = (r: WorkspaceRecord): number | null => (r.idleWindowMs === undefined ? defaultIdleWindowMs : r.idleWindowMs);

  /** Every live session and exec of a workspace ends here when its machine goes away under it; the harness's own end, if it ever comes, is dropped. */
  const endSessions = (workspaceId: string, reason: string): void => {
    for (const s of sessions.values()) if (s.view.workspaceId === workspaceId) s.end?.(reason);
    for (const e of execs) if (e.workspaceId === workspaceId) e.end(reason);
  };

  /** Everything a workspace left on this side once its machine is dealt with: live state, flushes, stored rows, vault. */
  const drop = async (id: string): Promise<void> => {
    const going = live.get(id);
    going?.lateRead?.();
    // Whatever this host was holding open about the machine goes with the record that named it: the child
    // carrying the road to a machine over ssh would otherwise hold a port for a workspace nobody can name.
    if (going !== undefined) {
      await moduleOf(going.record.kind)
        .dropped(going)
        .catch((e: unknown) => console.warn(`${going.record.name}'s machine ${going.machine.id} kept something of this host's: ${e instanceof Error ? e.message : String(e)}`));
      // The copy this workspace was goes with the record that named it; the person's own folder is named by no
      // record and stays. A copy that will not go leaves its record deleted and says so, since the alternative is
      // a record nobody can delete.
      if (going.record.copy !== undefined) {
        await moduleOf(going.record.kind)
          .dropCopy(going.record.copy)
          .catch((e: unknown) => console.warn(`${going.record.name}'s copy at ${going.record.copy?.path} is still there: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    live.delete(id);
    revivedAt.delete(id);
    unreadAt.delete(id);
    unreached.delete(id);
    polledReach.delete(id);
    napRefusals.delete(id);
    transcripts.delete(id);
    daemonNotes.delete(id);
    for (const [handleId, s] of sessions) if (s.view.workspaceId === id) sessions.delete(handleId);
    for (const [threadId, held] of threadRecords) if (held.workspaceId === id) threadRecords.delete(threadId);
    cancelFlush(id);
    await transcriptFlushes.get(id);
    transcriptFlushes.delete(id);
    await indexFlushes.get(id);
    indexFlushes.delete(id);
    await store.delete(WORKSPACES, id);
    await store.delete(TRANSCRIPTS, id);
    await store.delete(WORKSPACE_NAMES, id);
    await store.delete(SESSIONS, id);
    await store.delete(CREATES, `workspace/${id}`);
    await store.deleteBlob(VAULTS, id);
    bus.emit({ type: "workspace.deleted", workspaceId: id });
  };

  // Pausing is persisted and pushed before the provider is asked, so a list
  // fetched mid-pause never says running, and the sessions end while the
  // machine can still be told to stop them.
  const napWith = async (id: string, reason?: string): Promise<WorkspaceView> => {
    const entry = await entryOf(id);
    if (await runsUnderNapping(entry)) await adoptRunning(entry);
    if (entry.napping) return entry.napping;
    if (entry.record.phase !== "running") return view(entry.record);
    entry.napping = (async () => {
      try {
        entry.record.phase = "pausing";
        await persist(entry.record);
        await emitStatus(entry, "napping");
        try {
          await entry.ws.nap();
        } catch (e) {
          // A 404 the pause answered with is a sighting like any other: it settles only where the state read agrees,
          // and a machine still running takes the road any other refused pause takes.
          if (isMissing(e) && settled(await settleGone(entry, goneWords(entry.record.machineId, { by: "pause", at: clock.now(), answer: providerSaid(e) })))) throw e;
          entry.record.phase = entry.ws.currentPhase;
          await persist(entry.record);
          if (e instanceof NapRefusedError) {
            if (napRefusedOf(entry) === undefined) console.warn(`the provider does not pause ${entry.machine.id} of ${id} (${e.said}); an idle nap waits for the backstop and exports no vault until a pause lands`);
            napRefusals.set(id, { machineId: entry.machine.id, said: e.said });
          }
          await emitStatus(entry, reachOf(entry), e instanceof Error ? e.message : String(e));
          throw e;
        }
        // The reason says the machine paused, so it is written once the provider has confirmed that.
        endSessions(id, PAUSED_REASON);
        napRefusals.delete(id);
        entry.record.phase = "napping";
        await persist(entry.record);
        bus.emit({ type: "workspace.napped", workspaceId: id });
        await emitStatus(entry, "napping", reason);
        return view(entry.record);
      } finally {
        delete entry.napping;
      }
    })();
    return entry.napping;
  };

  /** One read of the provider a while after a wake gave up: a resume the runtime stopped waiting on can land later,
   * and a record still saying napping over a machine that runs would bill under a paused row until a verb met it.
   * The read that finds it running adopts, as any verb would. */
  const armLateRead = (entry: LiveWorkspace): void => {
    entry.lateRead?.();
    entry.lateRead = clock.schedule(() => {
      delete entry.lateRead;
      void runsUnderNapping(entry)
        .then(runs => (runs ? adoptRunning(entry) : undefined))
        .catch((e: unknown) => console.warn(`late read of ${entry.record.id}: ${e instanceof Error ? e.message : String(e)}`));
    }, lateReadMs, { unref: true });
  };

  /** The provider paused the machine outside a nap (its idle timer, a console click): the record follows the fact, so a wake resumes it the normal way. */
  const adoptPause = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running" || entry.napping || entry.waking) return;
    entry.ws.notePaused();
    napRefusals.delete(entry.record.id);
    entry.record.phase = "napping";
    await persist(entry.record);
    endSessions(entry.record.id, PAUSED_REASON);
    bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await emitStatus(entry, "napping", "paused outside wsp");
  };
  /** One read of the provider for a record that says napping: true when the machine runs there, so the pause never
   * took or nobody wrote the resume. A read the provider refuses answers false; the record's word stands until a
   * verb meets the machine. */
  const runsUnderNapping = async (entry: LiveWorkspace): Promise<boolean> =>
    entry.record.phase === "napping" && (await entry.machine.state().catch(() => "paused")) === "running";
  /** The provider runs a machine the record calls napping: the record follows the fact and the machine is reached
   * like any running one. Nothing is resumed, so the first life the record holds is untouched. */
  const adoptRunning = (entry: LiveWorkspace): Promise<void> => {
    if (entry.adopting) return entry.adopting;
    if (entry.record.phase !== "napping" || entry.napping || entry.waking) return Promise.resolve();
    entry.adopting = (async () => {
      try {
        entry.ws.noteRunning();
        followMachine(entry);
        await persist(entry.record);
        bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId, resurrected: false });
        await emitStatus(entry, reachOf(entry), ALREADY_RUNNING);
      } finally {
        delete entry.adopting;
      }
    })();
    return entry.adopting;
  };
  /** What a gone verdict is checked against, a short wait after the call that made it: the provider read until
   * GONE_READS reads in a row answer gone, since a gateway copy that never held the machine answers 404 while the
   * other bills on. A read that fails another way confirms nothing and answers its error. */
  const goneConfirmed = async (backend: MachineBackend, machineId: string): Promise<MachineState | Error> => {
    if (goneConfirmMs > 0) await new Promise<void>(resolve => void clock.schedule(() => resolve(), goneConfirmMs, { unref: true }));
    return readGone(backend, machineId).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  };
  /** The one road to gone, whichever call found the provider no longer knew the machine (deleted behind wsp, or
   * expired): the verdict is confirmed, and where it holds the record follows the fact and stays there. Until then
   * the record keeps the phase it had, so the row and the meter go on reading the machine as billing and the sweep
   * spares it as claimed. The gone event closes the awake stretch with a cost tick at this instant, drops the idle
   * window and ends the sessions; the row and the one log line carry the words; rebuild and delete are the roads out. */
  const settleGone = async (entry: LiveWorkspace, reason: string): Promise<GoneOutcome> => {
    const machineId = entry.record.machineId;
    const read = await goneConfirmed(backendFor(entry.record), machineId);
    if (read !== "gone") {
      const followed = read instanceof Error ? `the reads that followed failed: ${read.message}` : `the state read that followed said ${read}`;
      console.warn(`workspace ${entry.record.id} is not gone: ${reason}, and ${followed}`);
      return read instanceof Error ? "unchecked" : "not-gone";
    }
    return markGone(entry, machineId, reason);
  };
  /** A verdict already confirmed, written: the record, the sessions, the event and the row move together. */
  const markGone = async (entry: LiveWorkspace, machineId: string, reason: string): Promise<GoneOutcome> => {
    if (entry.record.phase === "gone" || entry.record.machineId !== machineId) return "moot";
    entry.record.phase = "gone";
    entry.record.gone = reason;
    await persist(entry.record);
    endSessions(entry.record.id, GONE_REASON);
    console.warn(goneLogLine(entry.record.id, reason));
    bus.emit({ type: "workspace.gone", workspaceId: entry.record.id, machineId: entry.record.machineId, reason });
    await emitStatus(entry, "gone", reason);
    return "settled";
  };
  /** A sighting from outside a verb (the poll, the sweep): a nap or a wake in flight meets the machine itself and
   * settles what it finds, so the sighting defers to it. */
  const adoptGone = async (entry: LiveWorkspace, reason: string): Promise<void> => {
    if (entry.record.phase === "gone" || entry.napping || entry.waking) return;
    // The poll pushed a gone row before the confirming read answered; a verdict that did not hold corrects it here
    // rather than leaving the screen wrong until the next poll.
    const outcome = await settleGone(entry, reason);
    if (outcome === "not-gone" || outcome === "unchecked") await emitStatus(entry, reachOf(entry), outcome === "not-gone" ? NOT_GONE : GONE_UNCHECKED);
  };
  /** A record marked gone over a machine the provider still holds: the state read by id is the word on gone, so the
   * record follows it back rather than leaving a rebuild to abandon a healthy machine that would bill on unrecorded.
   * The phase the record left gone for, or undefined when this read moved nothing. */
  const recoverGone = async (entry: LiveWorkspace): Promise<"running" | "napping" | undefined> => {
    if (entry.record.phase !== "gone" || entry.napping || entry.waking) return undefined;
    const read = await entry.machine.state().catch(() => undefined);
    const phase = read === undefined ? undefined : phaseLeavingGone(read);
    if (phase === undefined) return undefined;
    if (phase === "running") {
      entry.ws.noteRunning();
      followMachine(entry);
    } else {
      entry.ws.notePaused();
      entry.record.phase = phase;
      delete entry.record.gone;
    }
    await persist(entry.record);
    if (phase === "running") bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId, resurrected: false });
    else bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await emitStatus(entry, phase === "running" ? reachOf(entry) : "napping", NOT_GONE);
    return phase;
  };
  bus.on("workspace.status", e => {
    if (e.type !== "workspace.status") return;
    // No session ends on a reach verdict: the probe reads this computer's own road, and a resolver that dropped one
    // name for three minutes on 2026-09-12 read two live machines dark and cost every turn on them its process.
    const entry = live.get(e.status.id);
    if (entry === undefined) return;
    if (e.status.phase === "running" && e.status.machineState === "paused") void adoptPause(entry);
    // A status about a machine since replaced says nothing about the one now under the record.
    if (e.status.machineState === "gone" && e.status.phase !== "gone" && e.status.machineId === entry.record.machineId) {
      void adoptGone(entry, e.status.reason ?? goneWords(e.status.machineId));
    }
  });

  /** How long the machine behind a record has been quiet by its own computer's reading, where that computer
   * counts one. A read that fails says nothing about the workspace, and the stop goes ahead: a backend that
   * cannot be asked is a backend that does not answer. */
  const quietOf = async (id: string): Promise<number | undefined> => {
    const entry = live.get(id);
    if (entry === undefined || entry.record.phase !== "running") return undefined;
    // Called on the lifecycle itself, as the backstop below is, rather than pulled off it and called detached:
    // one interface, and an implementer is free to write this as a method, which keeps its own object only if
    // the call goes through it.
    return backendFor(entry.record).lifecycle?.quietForMs?.(entry.machine).catch((e: unknown) => {
      console.warn(`quiet figure of ${id} not read: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
  };

  const idle = createIdlePolicy({
    windowOf: id => {
      const entry = live.get(id);
      if (entry === undefined) return null;
      const windowMs = idleWindowOf(entry.record);
      // A refusal that stands is asked again only at the backstop; a window that is off stays off.
      return windowMs !== null && napRefusedOf(entry) !== undefined ? backstopMs(windowMs) : windowMs;
    },
    onIdle: async (id, windowMs) => {
      // What the computer running it can see of the workspace working, asked once here rather than counted by
      // the timer: a dev server somebody is clicking through and a build somebody started answer with a figure
      // inside the window, and the window starts over instead of the workspace stopping under them. A backend
      // that cannot say leaves the stop to this host's own clock, which is every provider.
      const quiet = await quietOf(id);
      if (quiet !== undefined && quiet < windowMs) {
        idle.touch(id);
        return;
      }
      try {
        await napWith(id, IDLE_REASON.of(windowMs));
      } catch (e) {
        if (e instanceof MoveUnansweredError) throw e;
        // A machine the pause found gone settled its record on the way out; the gone event dropped this window.
        if (isMissing(e)) return;
        // The provider answered with a refusal: asking again at once changes nothing, so a full window starts from
        // its answer, the backstop where the refusal stands for the machine, and the row is pushed once more with
        // that window, the words unchanged. A refusal that stands was logged once, where the pause met it.
        idle.touch(id);
        const entry = live.get(id);
        if (entry !== undefined) await emitStatus(entry, reachOf(entry), napRefusedReason(entry) ?? (e instanceof Error ? e.message : String(e)));
        if (!(e instanceof NapRefusedError)) console.warn(`idle nap of ${id} was answered with ${providerSaid(e)}; a full ${Math.round(windowMs / 60_000)} min window starts over`);
      }
    },
    retryMs: opts.status?.pollIntervalMs ?? POLL_INTERVAL_MS,
    clock,
    // A backend whose backstop is pushed rather than set at create hears the instant on every arming of a running
    // machine; the backend decides whether one is worth a call, and a call that fails changes nothing about the
    // window. A touch on a napped or gone workspace arms a window too, but its machine needs no stop timer.
    onBackstop: (id, until) => {
      const entry = live.get(id);
      if (entry === undefined || entry.record.phase !== "running") return;
      void backendFor(entry.record)
        .lifecycle?.backstop?.(entry.machine, until)
        .catch((e: unknown) => console.warn(`backstop of ${id} on ${entry.machine.id} not set: ${e instanceof Error ? e.message : String(e)}`));
    },
  });
  // Every road into a workspace the runtime can see starts its window over;
  // typing over the browser's daemon link arrives as workspaces.touch.
  for (const type of ["session.start", "session.delta", "session.done", "session.end", "session.steer", "inbox.file", "workspace.woken", "workspace.upgraded", "project.import", "project.export"] as const) {
    bus.on(type, e => idle.touch((e as { workspaceId: string }).workspaceId));
  }
  bus.on("workspace.created", e => e.type === "workspace.created" && idle.touch(e.workspace.id));
  for (const type of ["workspace.napped", "workspace.gone", "workspace.deleted"] as const) {
    bus.on(type, e => idle.forget((e as { workspaceId: string }).workspaceId));
  }

  type StoredBuilder = Omit<BuilderRecord, "size" | "firstLife"> & { size?: WorkspaceSize; firstLife?: boolean };
  /** Whether a seal can still be taken from a builder at this place: the machine's own first life, or a provider
   * whose copy of a disk is the disk as it stands. The one place the golden road asks it; every reader above the
   * runtime takes the answer on the builder's view. A place nothing here can reach yet answers on first life
   * alone, which is what the record already says. */
  const sealableAt = (place: string | undefined, firstLife: boolean): boolean => {
    if (firstLife) return true;
    const at = places.backend(place ?? places.wired) ?? placeDoor?.backendOf(place ?? places.wired);
    return at?.capabilities.snapshotsAnyLife === true;
  };
  const lifeOf = (stored: StoredBuilder, machine: Machine, sealable: boolean): LiveBuilder["life"] => {
    // Only a label that names another state file makes it foreign; a view with no labels is ours.
    const label = machine.labels?.[OWNER_LABEL];
    // A hold from this host is checked against its pid; one from another host is trusted while its heartbeat
    // is fresh, and a heartbeat that cannot be read counts as fresh: when unsure, the builder is held.
    const holder = stored.heldBy;
    const mine = holder !== undefined && holder.host === hostId && holder.pid === process.pid;
    const beatAge = holder !== undefined ? Date.now() - Date.parse(holder.heartbeat) : Number.NaN;
    const fresh = Number.isNaN(beatAge) || beatAge < HELD_TTL_MS;
    const held = holder !== undefined && !mine && fresh && (holder.host !== hostId || pidAlive(holder.pid));
    // A placeholder its dead holder left mid-setup never finished its stages: stale, whatever the marker says.
    return label !== undefined && label !== owner ? "foreign" : held ? "held" : !sealable || stored.building === true ? "stale" : "reusable";
  };
  const liveOf = (record: BuilderRecord, machine: Machine): LiveBuilder => {
    const sealable = sealableAt(record.place, record.firstLife);
    return {
      record,
      builder: {
        machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: record.firstLife, size: record.size,
        ...(record.import !== undefined ? { import: record.import } : {}),
        ...(record.base !== undefined ? { base: record.base } : {}),
      },
      sealable,
      life: lifeOf(record, machine, sealable),
    };
  };
  /** A stored record this process has no entry for yet; its machine is fetched once, here. */
  const admit = async (stored: StoredBuilder): Promise<void> => {
    // A builder made at another place is read on that place's backend; the wired one has never heard of it. A
    // joined computer that has never said what it forks with cannot be asked, and one that is not connected
    // answers absent: either way the record stays as it is until that computer dials in, and only a place that
    // reads the machine gone through readGone drops it; one it still finds is admitted at the next refresh.
    const place = stored.place ?? places.wired;
    const at = places.backend(place) ?? placeDoor?.backendOf(place);
    if (at === undefined) return;
    let machine: Machine;
    try {
      machine = observed(await at.get(stored.id));
    } catch (e) {
      if (isPlaceAbsent(e) || isNoProvider(e)) return;
      if (!isMissing(e)) throw e;
      if ((await readGone(at, stored.id)) === "gone") await store.delete(BUILDERS, stored.id);
      return;
    }
    // The view get() fetched is read once: a second read would reset the provider's idle timer again.
    const seen = machine.seen;
    const state = seen?.state ?? (await machine.state());
    // A machine found paused was paused: that alone clears the marker for good. Nothing is read from the
    // provider's createdAt: on a running machine never paused, resumed or exec'd it read +6.4 s at two minutes
    // and +306 s at ten (canary, 2026-09-04 UTC), so it moves with no lifecycle event and decides nothing.
    const firstLife = stored.firstLife === true && state === "running";
    const record: BuilderRecord = { ...stored, firstLife, size: stored.size ?? sizeBuilt(await shapeOf(machine), at.pricing.defaultSize) };
    if (stored.firstLife === true && !firstLife) await store.put(BUILDERS, record.id, record);
    builders.set(record.id, liveOf(record, machine));
    if (stored.sealed !== undefined) armGrace(record.id, stored.sealed.at);
  };
  /** The store is the truth across processes, and another wsp (an init beside this host, a second host) writes it
   * after this one hydrated: every decision that kills or reuses a builder reads it first. A row this process has
   * no entry for is admitted, a changed hold or marker re-derives the life, a row another process dropped goes with
   * it. Own records are this process's and are not re-read; no machine is re-read either, so the first-life marker
   * only ever drops here. Passes overlap (a sweep beside a prepare): the newest listing wins, so a pass that finds
   * a newer one started after its own listing applies nothing, drops nothing, and hands its caller the newer pass. */
  let passes = 0;
  let latest: Promise<void> = Promise.resolve();
  const refreshBuilders = (): Promise<void> => (latest = refreshNow(++passes));
  const refreshNow = async (pass: number): Promise<void> => {
    const rows = (await store.list(BUILDERS)) as StoredBuilder[];
    const seen = new Set<string>();
    for (const stored of rows) {
      if (pass !== passes) return latest;
      seen.add(stored.id);
      const current = builders.get(stored.id);
      if (current === undefined) await admit(stored);
      else if (current.life !== "own") {
        const record: BuilderRecord = { ...stored, firstLife: stored.firstLife === true && current.builder.firstLife, size: stored.size ?? current.record.size };
        Object.assign(current, liveOf(record, current.builder.machine));
      }
    }
    if (pass !== passes) return latest;
    for (const [id, b] of [...builders]) if (!seen.has(id) && b.life !== "own") builders.delete(id);
  };

  /** Whether this host holds that workspace by a stand-in for a machine it could not ask anything about: the one
   * reading of "nothing is known about this one yet", which is what a place dialling in is the moment to fix. A
   * record with no live entry at all reads the same, since a hydration that never ran holds nothing either. */
  const isHeldAway = (id: string): boolean => {
    const entry = live.get(id);
    return entry === undefined || isAbsentMachine(entry.machine);
  };

  const rereading = new Set<string>();
  /** What the provider said to the load's one read of a record now held, quoted when the record settles gone. */
  const heldAnswers = new Map<string, string>();
  /** A record the load held by a stand-in, read again the way a gone verdict is confirmed: a machine the provider
   * finds is loaded onto, one it answers gone for GONE_READS reads in a row settles gone through markGone, and a
   * read that fails leaves the record held for the next sweep. */
  const rereadHeld = async (id: string, by: GoneSeenBy): Promise<void> => {
    const entry = live.get(id);
    if (entry === undefined || !isAbsentMachine(entry.machine) || rereading.has(id)) return;
    rereading.add(id);
    try {
      const machineId = entry.record.machineId;
      const seen = await Promise.resolve()
        .then(() => sightMachine(backendFor(entry.record), machineId))
        .catch(() => undefined);
      if (seen === undefined || closed || live.get(id) !== entry) return;
      if (seen.machine !== undefined) {
        const raw = await store.get(WORKSPACES, id);
        const again = raw === undefined ? undefined : await hydrateWorkspace(raw, seen as FoundMachine);
        if (again !== undefined) void syncDaemon(again);
        return;
      }
      const answer = heldAnswers.get(id);
      // The stand-in refuses every call with the held line; a gone record stands on the machine every gone load gets.
      await markGone(attach(entry.record, deadMachine(machineId)), machineId, goneWords(machineId, { by, at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
    } finally {
      if (!isHeldAway(id)) heldAnswers.delete(id);
      rereading.delete(id);
    }
  };

  /** One stored workspace read into a live one: what the provider says about its machine decides the phase, and
   * the record follows. Read once for every record at hydration, and again for a record on a place the moment that
   * place dials in, since until then nothing could be asked about its machine. Answers the entry whose daemon wants
   * syncing, since the sync waits out a running turn and only the caller knows when its session rows are in. */
  const hydrateWorkspace = async (raw: unknown, seen?: FoundMachine): Promise<LiveWorkspace | undefined> => {
    const stored = raw as Omit<WorkspaceRecord, "size" | "kind"> & { size?: WorkspaceSize; kind?: WorkspaceKind };
    const kind: WorkspaceKind = stored.kind ?? "cloud";
    const rest = stored;
    // Nothing reads a record from before projects were records of their own: the owner ruled no migration, so a
    // state file holding one is refused in one sentence and this host does not serve it.
    if (typeof stored.project !== "string" || !projectsHeld.has(stored.project)) throw new Error(wipeTheState(stored.id, opts.statePath, await store.shape()));
    // A record of the person's folder worked in place, which no host writes any more: not served, so an agent is
    // never let loose in that folder, and the host starts with the rest. Read off the raw record, since the cast
    // below reads the road as one of the two a copy takes.
    const copy = (raw as { copy?: { road?: unknown; path?: unknown } }).copy;
    if (copy?.road === IN_PLACE_ROAD) {
      console.warn(inPlaceRecordLine(stored.id, typeof copy.path === "string" ? copy.path : projectsHeld.get(stored.project)?.path ?? "its folder"));
      return;
    }
    // A record whose kind this host wired no module for, or whose place forks nothing any more, is left as it
    // was: only the host that owns that machine can serve it.
    let at: MachineBackend;
    try {
      at = moduleOf(kind).backend(stored as WorkspaceRecord);
    } catch (e) {
      console.warn(`workspace ${stored.id} is left as it was: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // The store is the fleet's truth and get(id) the provider's: a record whose machine the provider lost is
    // gone and one whose machine it holds paused is napping, whatever phase either was left at, and both say so
    // before anything lists it or meters it. A machine nothing can be asked about is neither: a place that is not
    // connected, a host started without its provider key and a provider read that failed all leave the record on
    // the word it was left with, and the host serves the rest rather than failing on the first record it cannot read.
    const goldenKind = (await imageOf(stored.golden).catch(() => undefined))?.version?.kind ?? "sandbox";
    let missing: string | undefined;
    let absent = false;
    // The kind is the golden's, which the record names: a desktop fork on a computer that is away is a desktop
    // fork, and nothing about it is guessed while nothing can be asked. The stand-in refuses with the error that
    // came back, so every road on the row says the one true thing about why it cannot be read.
    const heldAway = (e: unknown): Machine => {
      absent = true;
      const refusal = e instanceof Error ? e : new Error(String(e));
      return absentMachine(stored.machineId, goldenKind, () => {
        throw refusal;
      });
    };
    const machine =
      seen?.machine ??
      (await at.get(stored.machineId).catch((e: unknown) => {
        if (!isMissing(e)) return heldAway(e);
        // One 404 is not gone: a gateway copy that never held the machine answers it while the other bills on. A live
        // record is held as it was and confirmed once the host serves (rereadHeld), since the reads that confirm a
        // gone machine take seconds each and a fleet the provider expired overnight answers 404 for every record.
        if (stored.phase !== "gone") {
          heldAnswers.set(stored.id, providerSaid(e));
          return heldAway(new Error(goneUnconfirmedLine(stored.machineId, providerSaid(e))));
        }
        missing = providerSaid(e);
        return deadMachine(stored.machineId);
      }));
    // The state rides on the view get() just fetched; a second read would reset the provider's idle timer.
    const atProvider = missing !== undefined ? "gone" : absent ? undefined : (seen?.state ?? machine.seen?.state ?? (await machine.state().catch(() => undefined)));
    // A record left gone leaves it on the one predicate every road out of gone reads, and on nothing else. Any
    // other record follows the provider whatever word it was left with: paused means the pause landed or the
    // resume never did, running means the pause never took or the resume landed with nobody left to write it.
    // Only a machine still starting leaves the stored word standing, and a pausing one then reads napping: a
    // wake resumes it either way.
    const phase: WorkspacePhase =
      atProvider === undefined
        ? stored.phase
        : stored.phase === "gone"
          ? (phaseLeavingGone(atProvider) ?? "gone")
          : atProvider === "gone"
            ? "gone"
            : atProvider === "paused"
              ? "napping"
              : atProvider === "running"
                ? "running"
                : stored.phase === "pausing"
                  ? "napping"
                  : stored.phase;
    const record: WorkspaceRecord = {
      ...rest,
      kind,
      phase,
      size: stored.size ?? sizeBuilt(await shapeOf(machine), at.pricing.defaultSize),
      ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
    };
    if (phase === "gone") record.gone = stored.gone ?? goneWords(stored.machineId, { by: "record load", at: clock.now(), ...(missing !== undefined ? { answer: missing } : {}) });
    else delete record.gone;
    attach(record, machine);
    if (phase !== stored.phase) {
      if (phase === "gone") console.warn(goneLogLine(stored.id, record.gone!));
      else console.warn(`workspace ${stored.id} was left ${stored.phase} and its machine is ${String(atProvider)} at the provider; the record hydrates ${phase}`);
      await persist(record);
    }
    if (phase !== "running" || absent) return undefined;
    idle.touch(stored.id);
    return live.get(stored.id)!;
  };

  let hydrated: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    hydrated ??= (async () => {
      const stored = (await store.get(OWNER, "id")) as { id?: unknown } | undefined;
      if (typeof stored?.id === "string" && stored.id !== "") owner = stored.id;
      else {
        owner = `h_${randomBytes(4).toString("hex")}`;
        await store.put(OWNER, "id", { id: owner });
      }
      await migrateCopies();
      // The places are read before the workspaces: a fork standing on one asks which backend it lives on, and that
      // answer comes off what the place last said about itself rather than off a socket that may not be open.
      await placeDoor?.load();
      // The projects are read before the workspaces: every workspace record names one, and its view joins that
      // project's name, path and computer off this map.
      for (const raw of await store.list(PROJECTS)) {
        // A project recorded before it carried the remote it was cloned from and the key its agent's memory sits
        // under: every one of those is the add's own rule over what the record already holds, so they are filled
        // in here and written back rather than costing the person the whole state file.
        const project = await filledProject(raw as ProjectView);
        if (project === raw) projectsHeld.set(project.id, project);
        else await rememberProject(project);
      }
      const toSync: LiveWorkspace[] = [];
      for (const raw of await store.list(WORKSPACES)) {
        const entry = await hydrateWorkspace(raw);
        if (entry !== undefined) toSync.push(entry);
      }
      for (const raw of await store.list(TRANSCRIPTS)) {
        const t = raw as TranscriptRecord;
        transcripts.set(t.workspaceId, t.events);
      }
      const left: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; turnToken?: string; scopeDeviceId?: string }[] = [];
      for (const raw of await store.list(SESSIONS)) {
        const index = raw as SessionIndexRecord;
        if (!live.has(index.workspaceId)) continue;
        for (const [threadId, held] of Object.entries(index.threads ?? {})) {
          if (typeof held?.harness !== "string") continue;
          threadRecords.set(threadId, { workspaceId: index.workspaceId, harness: held.harness, ...(typeof held.permissionMode === "string" ? { permissionMode: held.permissionMode } : {}) });
        }
        if (!Array.isArray(index.sessions)) {
          console.warn(`sessions document for ${index.workspaceId} has no rows array, read as empty`);
          continue;
        }
        for (const { turnId, notify, notifyBy, notifyRoad, reply, run, turnToken, scopeDeviceId, ...view } of index.sessions) {
          const by = readScope(notifyBy);
          const road = readRoad(notifyRoad);
          const row: {
            view: SessionView;
            turnId: string;
            notify?: readonly string[];
            notifyBy?: ThreadScope;
            notifyRoad?: WorkspaceOrigin;
            turnLive?: TurnLive;
            run?: string;
            turnToken?: string;
            scopeDeviceId?: string;
            end?: (reason: string) => void;
          } = {
            view,
            turnId,
            // A state file written before a row held several targets carries the one it had as a bare string; the
            // document is read back unchecked, so the shape is settled here rather than in every reader of it.
            ...(notify !== undefined ? { notify: typeof notify === "string" ? [notify] : notify } : {}),
            // A document written before the scope rode beside the targets carries none, and its lines go as they
            // went then, as the person's; one that does not read as a scope is no scope at all.
            ...(by !== undefined ? { notifyBy: by } : {}),
            ...(road !== undefined ? { notifyRoad: road } : {}),
            ...(reply !== undefined ? { turnLive: { reply } } : {}),
            ...(run !== undefined ? { run } : {}),
            ...(turnToken !== undefined ? { turnToken } : {}),
            ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}),
          };
          // A row left running because nothing answered about its run has no harness of its own to end, and the poll
          // that finds its machine gone must still be able to settle it.
          row.end = reason => {
            if (row.view.status !== "running") return;
            settleCut(row, reason, () => reason);
            void persistSessions(row.view.workspaceId);
          };
          if (view.status === "running") left.push(row);
          sessions.set(view.id, row);
        }
      }
      // A turn's run belongs to the machine it runs on, not to the host that asked for it, so a host that comes back
      // re-opens every run the machines still hold and reads the rest of its output. Only the machine's own answer
      // that a run is gone ends that turn, and a machine that answered nothing leaves its turn running. The ends are
      // told once every workspace's rows are in: the parent a settled turn tells may sit in a workspace read after
      // its own, and a re-opened turn's own end tells it later, when it ends.
      const answers = await Promise.all(left.map(async s => ({ row: s, answer: await reattach(s) })));
      for (const { row, answer } of answers) {
        if (answer === "cannot") settleCut(row, RESTARTED_REASON, endedAt => restartCutLine(endedAt - (row.view.startedAt ?? endedAt)));
        else if (answer === "gone") settleCut(row, RUN_GONE_LINE, () => RUN_GONE_LINE);
      }
      for (const workspaceId of new Set(left.map(s => s.view.workspaceId))) void persistSessions(workspaceId);
      // The re-attach above has settled the rows the machines no longer hold, so a sync waiting out a running turn reads rows that are in.
      for (const entry of toSync) void syncDaemon(entry);
      void Promise.all([...live.keys()].map(id => rereadHeld(id, "record load").catch((e: unknown) => console.warn(`workspace ${id} was not read again: ${e instanceof Error ? e.message : String(e)}`))));
      // Every run left over from a host that never came back to read it, now that this host knows which ones it does
      // hold: a harness whose reader is gone answers nobody and holds the machine's memory for its life.
      await Promise.all([...live.values()].map(entry => sweepRuns(entry)));
      // A turn's token dies with the turn, and a host that went down under one never reached that exit: every scoped
      // device whose thread is not running now is taken away here, so a restart is not how a token outlives its turn.
      for (const device of await deviceDoor.list()) {
        const thread = device.scope?.threadId;
        if (thread !== undefined && !threadRuns(thread)) await deviceDoor.revoke(device.id);
      }
      for (const raw of await store.list(BUILDERS)) await admit(raw as StoredBuilder);
    })();
    return hydrated;
  };

  /** Every verb that names a workspace comes through here, so the origin rule is read once for all of them. */
  const entryOf = async (id: string, origin?: Caller): Promise<LiveWorkspace> => {
    await ready();
    const entry = live.get(id);
    // A workspace this host does not hold and one outside the caller's tree read alike to a thread: telling the two
    // apart is how a thread walks what else stands here.
    if (!entry || entry.creating) {
      if (scopeOf(origin) !== undefined) throw notFoundRefusal(noWorkspaceRefusal());
      throw new Error(`${noWorkspaceRefusal()}: ${id}`);
    }
    refuseRelayed(entry.record, origin);
    return entry;
  };
  /** Which rows a caller reaches, for the verbs that name a thread rather than a workspace: the thread tree, then
   * the kind rule on the row's workspace, so a request relayed from a machine still drives only kinds that take
   * one. Neither the project rule nor the workspace tree is read here: a child on a fresh copy reaches its lead on
   * the workspace the person made, which the workspace rule alone would hide from it. */
  const reachesRow = (row: { threadId?: string; workspaceId: string }, caller: Caller | undefined): boolean => {
    if (!drivesThread(row.threadId, caller)) return false;
    const record = live.get(row.workspaceId)?.record;
    return record === undefined || drives(record, caller);
  };
  /** Every session verb that names a thread comes through here, as the verbs naming a workspace come through
   * entryOf: the entry the row stands on, or nothing when the caller is a thread the row is out of reach for, so
   * the verb answers absence and no sentence says which rule hid the row. A caller that is no thread reads the
   * workspace as every verb naming one does. */
  const entryOfRow = async (row: { threadId?: string; workspaceId: string }, origin: Caller | undefined): Promise<LiveWorkspace | undefined> => {
    if (scopeOf(origin) === undefined) return entryOf(row.workspaceId, origin);
    await ready();
    const entry = live.get(row.workspaceId);
    return entry === undefined || entry.creating || !reachesRow(row, origin) ? undefined : entry;
  };
  /** Whether a thread of the caller's tree stands on that workspace, which is what lets a child list and read the
   * transcript of the workspace its lead runs on; a caller that is no thread reads workspaces by their own rule. */
  const treeStandsOn = (workspaceId: string, caller: Caller | undefined): boolean =>
    scopeOf(caller) !== undefined && [...sessions.values()].some(s => s.view.workspaceId === workspaceId && reachesRow(s.view, caller));

  /** The create itself, one stage report per awaited step. The hostname is set inside the fork, before the daemon
   * is asked and before the workspace is listed or reachable, so no shell can open under the guest's boot name. */
  /** Where a fork lands: the word the person typed, else the place a fork last landed on. This host's own provider is
   * a place with no id, which is what every fork before joined computers existed stood on. */
  /** The computers a project can live on, by the row each carries in the places table: this computer, the ones
   * joined to it and the providers. A host wired without places holds the two it has anyway, so a project can be
   * recorded before anybody joins a computer. */
  const computerRows = async (): Promise<{ id: string; name: string }[]> => {
    const rows = placeDoor === undefined ? [{ id: HERE_PLACE_ID, name: hostname() }] : (await placeDoor.list(clock.now())).map(p => ({ id: p.id, name: p.name }));
    // The provider this host forks on is a computer a project can live on whether or not the places table lists it:
    // a host wired without places holds no table at all, and one whose door has not heard of its provider yet
    // still forks there.
    return rows.some(r => r.id === places.wired) ? rows : [...rows, { id: places.wired, name: places.wired }];
  };

  /** What a sentence calls a computer: the name its row carries, the id where this host holds no row for it. */
  const nameOfComputer = (computer: string, rows: readonly { id: string; name: string }[]): string => rows.find(r => r.id === computer)?.name ?? computer;

  /** The image a workspace forks when nobody named a project image: the head of this host's own, or nothing where
   * this host has sealed none yet. */
  const imageHeadOrNone = async (): Promise<string | undefined> => goldenHead(await copyOf(await imagePlace("default"), "default"))?.snapshotId;

  /** The same, for every road that cannot go on without one. */
  const imageHead = async (): Promise<string> => {
    const head = await imageHeadOrNone();
    if (head === undefined) throw new Error(NO_IMAGE_YET);
    return head;
  };

  /** Where a workspace of a project lands, as a place: this computer and the provider this host forks on carry no
   * place id, and every other computer is the place it is. */
  const landingPlace = async (computer: string): Promise<{ placeId?: string }> => {
    const lands = workspaceLands(computer, places.wired);
    return lands.at === "place" ? placeDoorOf().placeFor(lands.place) : {};
  };

  const createStaged = async (o: CreateWorkspaceOptions, project: ProjectView, id: string, report: StageReport, spawned?: ThreadScope, landed?: () => void): Promise<CreatedWorkspace> => {
    // Where this fork lands is the project's computer and nothing else: one workspace is one project's copy, so
    // no flag and no default place has a say in it.
    const { placeId } = await landingPlace(project.computer);
    await placeRefuses(placeId);
    const at = await landingBackend(placeId);
    // What this project's computer mounts into every workspace of it, off the road that landed the project there.
    // Where this project's computer keeps its memory, off that computer's own road, read again here because the
    // road can answer it now: a record filled at boot while that computer had said nothing about itself carries
    // whatever could be worked out then, and the folder a workspace mounts has to be the one the computer holds.
    // The record is put right the first time a workspace of it is made, so the two can never disagree again.
    const road = projectLanding(landingKind(project.computer, at));
    const landingOn = (await landingDeps(project.computer)).deps;
    // Why no workspace of this project can be made on that computer at all, before a machine is asked for or a
    // record written: a create that read the refusal later left a workspace record behind for a fork that never
    // happened.
    const refused = road.refusal(project, landingOn);
    if (refused !== undefined) throw Object.assign(new Error(refused), { kind: "invalid" });
    const said = road.places({ project, memoryKey: project.memoryKey, deps: landingOn });
    if (said.memoryDir !== project.memoryDir) await rememberProject({ ...project, memoryDir: said.memoryDir });
    const binds = road.workspaceBinds(projectHeld(project.id));
    // A project whose checkout the add left on that computer: this workspace takes its own copy of it, mounted at
    // the path the project has inside, so the seed and the install the add paid for are there and nothing is
    // cloned again. A project the computer keeps in an image carries it in the image instead. On a computer that
    // clones at the add, a project with no checkout was refused above by that road's own refusal; a project at a
    // provider has neither, and cloneProject clones it inside the fork.
    const copy = project.checkout === undefined ? undefined : { from: project.checkout, at: project.path };
    // A computer that keeps no image is forked from none: the workspace is a copy of that computer itself, so no
    // image is read, no copy of one is built there ahead of the fork, and the record names none the way a copy of
    // a folder here does.
    const fromImage = keepsImages(at);
    // What this workspace forks: the image the add built for this project where it built one, since that image
    // already holds the clone and its dependencies; else, at a place that is not the image's own, that place's
    // current copy of the image, built there first when it holds none, and everywhere else the snapshot asked for.
    const golden = fromImage ? await copyForFork(o.golden ?? project.image?.snapshotId ?? (await imageHead()), placeId, (where, rate) => report("fork-requested", copyFirstLine(where, o.name, rate))) : "";
    const inherited = fromImage ? (await imageOf(golden)).version?.size : undefined;
    const record: WorkspaceRecord = {
      id,
      name: o.name,
      kind: "cloud",
      machineId: "",
      phase: "running",
      golden,
      createdAt: new Date().toISOString(),
      project: project.id,
      spec: {
        ...(o.envs !== undefined ? { envs: o.envs } : {}),
        ...(o.labels !== undefined ? { labels: o.labels } : {}),
        ...(o.engine === true ? { engine: true } : {}),
        // What this project's own computer mounts into every workspace of it: its memory folder on a computer that
        // holds one, nothing where the project's memory rides the image. Kept on the record, so a wake mounts what
        // the create mounted.
        ...(binds.length > 0 ? { binds } : {}),
        ...(copy !== undefined ? { copy } : {}),
      },
      ...(o.idleWindowMs !== undefined ? { idleWindowMs: o.idleWindowMs } : {}),
      ...(placeId !== undefined ? { place: placeId } : {}),
      size: {
        cpu: o.cpu ?? inherited?.cpu ?? at.pricing.defaultSize.cpu,
        memMb: o.memMb ?? inherited?.memMb ?? at.pricing.defaultSize.memMb,
      },
      firstLife: true,
      // Written before the machine is asked for: the cap counts machines under a root off these two fields, so a
      // fork that is still landing already holds its place and two forks at once cannot both pass the count.
      ...treeOf(spawned),
      ...(o.parent !== undefined ? { parentWorkspaceId: o.parent } : {}),
      // The branch this copy starts from, kept because a bring back measures against it long after the parent may
      // have moved on or gone to sleep; nothing reads the parent's machine for it again.
      ...(project.base !== undefined ? { base: project.base } : {}),
      // A fork a thread asked for stores no switch of its own: it carries the tree it belongs to, and the switch is
      // read off that tree's root wherever it is asked for, so one workspace holds the answer for the whole tree.
      ...(spawned === undefined && o.agents !== undefined ? { agents: agentsFrom(undefined, o.agents) } : {}),
    };
    // Only an asked size is checked: the golden's own is what it was built at, whatever the provider offers today.
    if (namesSize(o) && !offeredSize(at.capabilities.sizes, record.size)) {
      throw Object.assign(new Error(refusalLine(sizeRefusal(sizeWord(record.size), at.capabilities.sizes), SIZE_PICK_FIX)), { kind: "invalid" });
    }
    const bind = (m: Machine): void => {
      record.machineId = m.id;
      attach(record, m).creating = true;
      // The record is in the live map from here, so the place the guard took for it is handed back in the same
      // step: one fork counts as one from the reservation through to the machine being ready, never as two while
      // it boots. A create that never binds hands its place back in the caller's finally instead.
      landed?.();
    };
    const notices: string[] = [];
    const asked = record.size;
    // The computer the fork lands on, by the name its own row carries: the place a person picked, else the
    // provider word this host's machines wear, which is what every other surface names a fork's home by.
    const where = placeId === undefined ? places.wired : placeDoorOf().nameOf(placeId);
    report("fork-requested", startingLine(record.name, where));
    try {
      await fork(record, bind, undefined, report, false);
    } catch (e) {
      // A slot for work beats a builder kept for one more change: at the cap one kept builder of this setup is
      // stopped and the fork tried again, the next one only on the next refusal. A held or foreign builder is
      // never touched, and a refusal with none left to stop is turned into words that name the slots' holders.
      if (!isCapRefusal(e)) throw e;
      let refusal: unknown = e;
      let made = false;
      await refreshBuilders();
      for (const x of [...builders.values()].filter(x => (x.life === "own" || x.life === "reusable") && x.record.sealed !== undefined)) {
        const stopped = `Stopped the builder kept from image v${x.record.sealed!.version} to make room at the machine cap.`;
        graceTimers.get(x.record.id)?.();
        graceTimers.delete(x.record.id);
        await killUntilGone(backend, x.builder.machine, opts.killConfirm);
        await forgetBuilder(x.record.id);
        notices.push(stopped);
        console.warn(`workspace ${record.id}: ${stopped.charAt(0).toLowerCase()}${stopped.slice(1, -1)} (${x.record.id})`);
        report("fork-requested", `${startingLine(record.name, where)} again`, { notice: stopped });
        try {
          await fork(record, bind, undefined, report, false);
          made = true;
          break;
        } catch (again) {
          if (!isCapRefusal(again)) throw again;
          refusal = again;
        }
      }
      if (!made) {
        // A create still in flight holds its slot; the one being refused never bound a machine, so it cannot name itself.
        const holding = [...live.values()].filter(w => holdsSlot(w.record)).map(w => w.record.name);
        const line = machineCapRefusal(holding, [...builders.values()].map(x => x.record.name));
        throw Object.assign(new Error(line, { cause: refusal }), { kind: "concurrency", ...(typeof (refusal as WspError).status === "number" ? { status: (refusal as WspError).status } : {}) });
      }
    }
    const entry = live.get(id)!;
    // A computer that would not fork at the size asked for says so on the handle, and the create's own answer is
    // where a person reads it: the record already holds the size that computer actually gave.
    if (entry.machine.notice !== undefined) notices.push(entry.machine.notice);
    // A workspace whose computer serves its daemon is asked nothing here: there is no route to mint and no daemon
    // inside to answer, so the create says nothing about either rather than printing a note about a port nothing
    // listens on.
    let fault: string | undefined;
    if (servedByItsComputer(entry) === undefined && (entry.machine.previewUrl !== undefined || entry.machine.daemonAnswers !== undefined)) {
      // The route and the daemon are two questions, and the create asks them apart: minting is what the app and
      // the first client will dial, and a mint that fails is its own line rather than a verdict on the guest.
      if (entry.machine.previewUrl !== undefined) {
        try {
          await until(entry.ws.daemonReach(), Date.now() + lifecycleOf(entry).budgets.daemonAnswersMs, "preview route");
          report("preview-route", "Preview route to the daemon minted.");
        } catch (e) {
          report("preview-route", "No preview route to the daemon.", { notice: `preview route for ${entry.machine.id} not minted (${e instanceof Error ? e.message : String(e)})` });
        }
      }
      // A daemon that does not answer is reported, not fatal: the workspace exists either way, and the status check
      // keeps asking and names a zombie. Asked the way the wake and the poll ask, so a machine reached without a
      // route is asked here too rather than left with no word at all.
      fault = await pingDaemon(entry);
      report("daemon-answering", fault === undefined ? "Daemon answered." : "Daemon did not answer.", { notice: fault });
      void syncDaemon(entry);
    }
    if (placeId === undefined) {
      // A guest whose daemon is silent may not serve exec yet either, and would spend the exec budget on top of the daemon's.
      if (fault !== undefined) console.warn(`workspace ${record.id}: memory not read: the daemon did not answer`);
      else if ((await readMemory(record, entry.machine, at.capabilities.sizes)) && (record.size.cpu !== asked.cpu || record.size.memMb !== asked.memMb)) {
        const line = sizeGotLine(asked, record.size, namesSize(o));
        notices.push(line);
        console.warn(`workspace ${record.id}: ${line}`);
      }
    }
    // The project goes in before the workspace is ready: a copy without the work in it is not a workspace of that
    // project, so a clone that fails ends the create and the machine goes with it.
    await moduleOf(record.kind).landProject(entry, project, report);
    await writeDaemonRoots(entry);
    await persist(record);
    // The place a fork landed on is where the next one lands when nobody says.
    await placeDoor?.markUsed(placeId);
    delete entry.creating;
    report("ready", CREATE_READY);
    const v = view(record);
    bus.emit({ type: "workspace.created", workspace: v });
    return notices.length > 0 ? { ...v, notice: notices.join(" ") } : v;
  };

  /** The name a workspace takes from what was typed: the space around it is no part of a name. The fork and the
   * rename both read it here, so a name is never stored with spaces a person would have to type back for `--in`. */
  const nameGiven = (name: string): string => name.trim();
  /** Names whose fork is between its check and its first machine: held here so two forks asked for together cannot both land. */
  const forking = new Set<string>();
  /** Why a fork of this name is refused, or nothing when the name is free: one entry holds it, whatever it is doing
   * (a delete in flight says so), or a fork of it is under way. A name never names two workspaces, and a fork and a
   * delete of one name never interleave. */
  const nameRefusal = (name: string): string | undefined => {
    if (nameGiven(name) === "") return BLANK_NAME_REFUSAL;
    const entry = [...live.values()].find(e => e.record.name === name);
    if (entry !== undefined) return entry.deleting ? nameDeletingRefusal(name) : nameTakenRefusal(name);
    return forking.has(name) ? nameTakenRefusal(name) : undefined;
  };

  /** The port base the next copy on this computer takes, out of the bases every record here already holds. A
   * computer whose copies each get a network of their own hands out none: the ports inside one are its own. */
  const portBaseHere = (): number | undefined => {
    const capabilities = backendOfKind("local").capabilities;
    if (!capabilities.copies || capabilities.ownNetwork) return undefined;
    return nextPortBase([...live.values()].flatMap(e => (e.record.portBase !== undefined ? [e.record.portBase] : [])));
  };

  /** The copy road: every piece of work on a project on the computer the host runs on, the first included, is a
   * copy of the folder at a sibling path with a port base of its own, which is what makes two pieces of work on
   * one project two checkouts on two branches rather than two names for one working tree, and what keeps an agent
   * out of the person's own folder from the first wsp new. The machine is this computer, and its phase is running
   * with auto-nap off from the start: a machine wsp does not run neither naps nor wakes. */
  const recordExisting = async (recorded: ProjectView, o: CreateWorkspaceOptions, caller: Caller | undefined, parent?: LiveWorkspace, landed?: () => void): Promise<WorkspaceView> => {
    const n = nameGiven(o.name);
    refuseRecording(n, caller);
    // The workspace is a copy of the folder and forks nothing, so the words a fork takes have nothing to act on
    // here: they are refused in one sentence rather than taken and ignored.
    const forkWords = [o.golden !== undefined ? "--from" : "", o.cpu !== undefined || o.memMb !== undefined ? "--size" : "", o.engine === true ? "--engine" : ""].filter(w => w !== "");
    if (forkWords.length > 0) throw Object.assign(new Error(copyTakesNone(recorded.name, forkWords)), { kind: "invalid" });
    const refusal = nameRefusal(n);
    if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
    // Read once this create is allowed, as the fork road reads it: nothing is asked of a parent's machine for a
    // request its own refusal was going to stop.
    const project = await startedFrom(recorded, parent);
    const mine = backendOfKind("local");
    const copy = await moduleOf("local").makeCopy(project, { slug: folderSlug(n), ...(project.base !== undefined ? { base: project.base } : {}) });
    const portBase = portBaseHere();
    const machine = await mine.get(LOCAL_MACHINE_ID);
    const record: WorkspaceRecord = {
      id: `ws_${randomBytes(4).toString("hex")}`,
      name: n,
      kind: "local",
      machineId: machine.id,
      phase: "running",
      golden: "",
      createdAt: new Date().toISOString(),
      project: project.id,
      copy,
      portBase,
      ...treeOf(scopeOf(caller)),
      ...(o.agents !== undefined ? { agents: agentsFrom(undefined, o.agents) } : {}),
      ...(o.parent !== undefined ? { parentWorkspaceId: o.parent } : {}),
      ...(project.base !== undefined ? { base: project.base } : {}),
      spec: {},
      size: mine.pricing.defaultSize,
      firstLife: false,
      idleWindowMs: null,
    };
    attach(record, machine);
    // In the live map from here, so the record holds the place under the root the guard took for it.
    landed?.();
    try {
      await moduleOf("local").landProject(live.get(record.id)!, project, () => {});
      // The copy sits beside the person's folder, outside the daemon's home root, so the daemon is told about it
      // here as the clone road tells it about a checkout: without this every file, diff and push op on a workspace
      // of this kind is refused for a path outside the root.
      await writeDaemonRoots(live.get(record.id)!);
      await persist(record);
    } catch (e) {
      // A copy whose record never landed is a folder nobody can name: it goes with the create that made it.
      live.delete(record.id);
      await moduleOf("local").dropCopy(copy).catch(() => {});
      throw e;
    }
    const v = view(record);
    bus.emit({ type: "workspace.created", workspace: v });
    return v;
  };

  const workspaces: Runtime["workspaces"] = {
    async landing(o, origin) {
      await ready();
      const project = await projectsDoor.resolve(o.project, origin);
      const computer = project.computer;
      const kind = kindForComputer(computer);
      if (copiesFolder(kind)) return { name: placeName(HERE_PLACE_ID), capabilities: backendOfKind(kind).capabilities };
      const { placeId } = await landingPlace(computer);
      const at = await landingBackend(placeId);
      return { ...(placeId !== undefined ? { place: placeId } : {}), name: placeName(placeId ?? places.wired), capabilities: at.capabilities };
    },

    async create(opts, origin) {
      await ready();
      const asked = scopeOf(origin);
      // A thread forks the image its own workspace's project runs and names none.
      if (asked !== undefined && opts.golden !== undefined) throw Object.assign(new Error(spawnGoldenRefusal(asked.threadId)), { kind: "invalid" });
      // A create a thread asked for is a child of the workspace that thread runs on and of no other, named or not:
      // a thread's workspaces are its own tree, nothing it makes stands beside it as a sibling of the person's, and
      // a workspace it names is one whose branch it may not read.
      const bornOf = asked === undefined ? opts.parent : asked.workspaceId;
      const o = { ...opts, name: nameGiven(opts.name), ...(bornOf !== undefined ? { parent: bornOf } : {}) };
      const project = await projectsDoor.resolve(o.project, origin);
      // The project's computer decides which road this create takes, off the one table that says whether a kind
      // copies a folder on this computer or forks an image; the origin rule is then read on that kind.
      const kind = kindForComputer(project.computer);
      // The same rule and the same sentence the verb that sets the switch on a workspace that exists reads, so a
      // create on a computer whose agents could not drive this host is refused rather than given a dead switch.
      if (o.agents?.spawn === true && !agentsMayDrive(kind)) throw Object.assign(new Error(agentsKindRefusal(kind)), { kind: "invalid" });
      // Read before anything is asked of a machine: the project rule refuses a thread naming another project here,
      // as the same reading refuses it every workspace of one. A computer that copies its folders takes no relayed
      // request at all and says so in its own words below.
      const copies = copiesFolder(kind);
      if (!copies) refuseRelayed({ kind, name: o.name, project: project.id }, origin);
      // A child of another workspace starts where that workspace is now, not where the project starts. A parent
      // this host does not hold, and one whose own create has not finished, are refused rather than dropped, since
      // a create that dropped it would land as somebody's root; the branch itself is read off the parent's machine
      // below, once this create is allowed.
      const parent = o.parent === undefined ? undefined : live.get(o.parent);
      if (o.parent !== undefined && (parent === undefined || parent.creating === true)) throw Object.assign(new Error(noParentWorkspaceLine(o.parent)), { kind: "invalid" });
      // A child is a second checkout of its parent's project on the branch that parent is on, so a parent holding
      // another project has no branch this child could start from and land its work back in.
      if (parent !== undefined && parent.record.project !== project.id) {
        throw Object.assign(new Error(parentProjectRefusal(parent.record.name, projectHeld(parent.record.project).name, project.name)), { kind: "invalid" });
      }
      // The place under the root is taken here, with no await between the count and the taking, and handed back in
      // the finally below however this create ends: the record it becomes is what holds it from then on. A copy on
      // this computer is a child in the tree as a fork is, so it takes the same place.
      const freePlace = spawnGuard("fork", origin);
      const spawned = scopeOf(origin);
      // A thread's fork carries the switch of the workspace it was asked from, and nothing the caller says: the
      // caps are the person's, and a fork naming its own would be the agents act by another road.
      if (spawned !== undefined && o.agents !== undefined) {
        freePlace();
        throw new Error(spawnActRefusal(spawned.threadId, "agents"));
      }
      if (copies) {
        try {
          return await recordExisting(project, o, origin, parent, freePlace);
        } finally {
          freePlace();
        }
      }
      const refusal = nameRefusal(o.name);
      if (refusal !== undefined) {
        freePlace();
        throw Object.assign(new Error(refusal), { kind: "conflict" });
      }
      forking.add(o.name);
      const id = `ws_${randomBytes(4).toString("hex")}`;
      const began = clock.now();
      // Who asked rides every stage from the first, which is emitted before the fork has a record: the stream's
      // tree rule has nothing to read until then, so a thread watching its own fork boot would see it start midway.
      const askedBy = spawned !== undefined ? { threadId: spawned.threadId, rootThreadId: spawned.rootThreadId } : undefined;
      const report: StageReport = (stage, message, said) => {
        bus.emit({
          type: "workspace.creating",
          workspaceId: id,
          name: o.name,
          stage,
          message,
          elapsedMs: clock.now() - began,
          ...(said?.notice !== undefined ? { notice: said.notice } : {}),
          ...(said?.detail !== undefined ? { detail: said.detail } : {}),
          ...(askedBy !== undefined ? { askedBy } : {}),
        });
      };
      try {
        // Read inside the try, so a parent that did not answer gives the name and the slot back the way every
        // other end of this create does, and after the guard, so what a thread may do is decided before anything
        // is asked of a machine.
        return await createStaged(o, await startedFrom(project, parent), id, report, spawned, freePlace);
      } catch (e) {
        // A machine already forked goes with the failed create, so the retry forks a fresh one; one the provider
        // will not part with keeps its record instead, since a machine nobody records bills unseen.
        const entry = live.get(id);
        let kept: LiveWorkspace | undefined;
        if (entry !== undefined) {
          const gone = await unfork(entry).then(() => true, (k: unknown) => isMissing(k));
          if (gone) live.delete(id);
          else {
            kept = entry;
            delete entry.creating;
            await persist(entry.record).catch((p: unknown) => console.warn(`workspace ${id} not stored: ${p instanceof Error ? p.message : String(p)}`));
            console.warn(`workspace ${id} failed to create and its machine ${entry.machine.id} would not stop; the record stays for wsp delete`);
          }
        }
        // The id dies with a failed create, so nothing could ever retry under its key.
        await store.delete(CREATES, `workspace/${id}`);
        report("failed", e instanceof Error ? e.message : String(e));
        if (kept !== undefined) bus.emit({ type: "workspace.created", workspace: view(kept.record) });
        throw e;
      } finally {
        forking.delete(o.name);
        freePlace();
      }
    },

    async get(id, origin) {
      return view((await entryOf(id, origin)).record);
    },

    async agents(id, patch, origin) {
      spawnGuard("agents", origin);
      const entry = await entryOf(id, origin);
      // The same rule the create that names the switch reads, off the one table of what each kind's machines are:
      // a kind whose agents could not drive this host is refused the switch rather than given one that does nothing.
      if (patch.spawn === true && !agentsMayDrive(entry.record.kind)) throw new Error(agentsKindRefusal(entry.record.kind));
      const next = agentsFrom(entry.record.agents, patch);
      entry.record.agents = next;
      await persist(entry.record);
      bus.emit({ type: "workspace.agents", workspaceId: id, agents: next });
      return view(entry.record);
    },

    async list(origin) {
      await ready();
      return listedFor(origin).map(e => view(e.record));
    },

    async resolve(ref, origin) {
      await ready();
      const scope = scopeOf(origin);
      const rows = scope === undefined ? held() : listedFor(origin);
      // The whole of an id, then the whole of a name, as a thread's own reference does: a name names one workspace at
      // most, since the create and the rename both refuse a name another already holds, and a word that is one is
      // that workspace whatever else it starts. Only a word that is neither reaches the prefix, where enough of an
      // id is the way round quoting a name with spaces and a word that starts two is refused with both ids.
      const exact = rows.find(e => e.record.id === ref) ?? rows.find(e => e.record.name === ref);
      const started = exact === undefined && ref.length >= ID_PREFIX_MIN ? rows.filter(e => e.record.id.startsWith(ref)) : [];
      if (started.length > 1) throw new Error(idPrefixRefusal(ref, started.map(e => e.record.id)));
      const entry = exact ?? started[0];
      if (entry === undefined) {
        if (scope !== undefined) throw notFoundRefusal(noWorkspaceRefusal(ref));
        // A computer somebody joined is a place, and a place is no workspace: the word is answered with the road to
        // one there rather than with absence, since the person typed the name of something this host does hold.
        const place = (await placeDoor?.find(ref)) ?? [];
        if (place.length > 0) throw notFoundRefusal(refusalLine(placeNotAWorkspaceLine(place[0]!.name), placeNotAWorkspaceFix(place[0]!.name)));
        throw notFoundRefusal(noWorkspaceRefusal(ref));
      }
      refuseRelayed(entry.record, origin);
      return view(entry.record);
    },

    async nap(id, origin) {
      spawnGuard("pause", origin);
      refusePauseless(await entryOf(id, origin), "be paused");
      return napWith(id);
    },

    async wake(id, origin) {
      const entry = await entryOf(id, origin);
      await copyBlocked(entry);
      if (entry.waking) return entry.waking;
      if (entry.record.phase === "gone") {
        const left = await recoverGone(entry);
        if (left === undefined) throw new Error(goneRefusal("wake", entry.record.gone));
        // A record that left gone for napping is a machine the provider holds paused: the wake goes on and resumes it.
        if (left === "running") return view(entry.record);
      }
      if (entry.napping) await entry.napping.catch(() => {});
      // A wake nobody should need is the one sign the provider paused the machine on its own, or lost it, and a wake of
      // a machine the provider runs would be refused with its words: one read settles any, and the record follows the fact.
      if (entry.record.phase === "running") {
        let answer: string | undefined;
        const read = await entry.machine.state().catch((e: unknown) => {
          if (!isMissing(e)) return "running";
          answer = providerSaid(e);
          return "gone";
        });
        if (read === "gone" && settled(await settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), ...(answer !== undefined ? { answer } : {}) })))) {
          throw new Error(goneRefusal("wake", entry.record.gone));
        }
        if (read === "paused") await adoptPause(entry);
      } else if (await runsUnderNapping(entry)) await adoptRunning(entry);
      // A running workspace has nothing to wake, whatever its kind; only a real resume asks the machine for one.
      if (entry.record.phase === "running") return view(entry.record);
      refusePauseless(entry, "be woken");
      entry.waking = (async () => {
        // The stop the person pulls from the row. It aborts the provider call the ask is on rather than walking away
        // from one that keeps running: an abandoned resume would go on to run its cap out, write its line back onto
        // a row that reads Paused, and leave a second lifecycle wake beside the next one.
        const stop = new AbortController();
        entry.wakeStop = stop;
        const stopped = (): boolean => stop.signal.aborted;
        /** Resolves as its promise does, or at once when the stop is pulled; only the wait between two asks needs
         * this, since the abort ends an ask on its own. */
        const orStopped = <T>(p: Promise<T>): Promise<T | "stopped"> =>
          stopped()
            ? Promise.resolve("stopped" as const)
            : Promise.race([p, new Promise<"stopped">(resolve => stop.signal.addEventListener("abort", () => resolve("stopped"), { once: true }))]);
        const began = clock.now();
        // How the backend has the host ask again after a resume its provider did not take; none means once.
        const asks = lifecycleOf(entry).budgets.resumeAsks;
        const wakeAsks = asks === undefined ? 1 : wakeAsksIn(asks.forMs, asks.everyMs);
        try {
          delete entry.deleteSaid;
          entry.record.phase = "waking";
          await persist(entry.record);
          await emitStatus(entry, "napping");
          // Ask 1 is the person's wake; every ask after it is the host's own, once a cadence apart, so a provider
          // that comes back inside its own outage wakes the machine without the person having to try again. The
          // record stays waking between two asks: nothing about the machine changed, only who is asking.
          // Set when the read before an ask found the machine already up: that ask sends no second resume and the
          // engine's wake goes straight to the guest check, first life ending there as on any other road.
          let landed = false;
          for (let ask = 1; ; ask++) {
            try {
              const result = await entry.ws.wake({ landed });
              if (stopped()) throw new Error(WAKE_STOPPED);
              followMachine(entry);
              delete entry.record.wakeRefused;
              await persist(entry.record);
              bus.emit({ type: "workspace.woken", workspaceId: id, machineId: entry.record.machineId, resurrected: result.resurrected });
              if (result.reason !== undefined) console.warn(`wake of ${id}: ${result.reason}`);
              await emitStatus(entry, reachOf(entry), result.reason);
              return view(entry.record);
            } catch (e) {
              if (!stopped() && e instanceof ResumeUnansweredError && ask < wakeAsks) {
                entry.wakeAsk = { ask, of: wakeAsks };
                delete entry.wakeSaid;
                await emitStatus(entry, "napping");
                // The cadence is wall time from the wake's start, so the half hour of asking is half an hour: a
                // resume that sat on its cap for half the minute leaves half a minute to wait, and one that ran
                // longer than the cadence is asked again at once.
                if ((await orStopped(sleeps(Math.max(0, began + ask * asks!.everyMs - clock.now())))) !== "stopped") {
                  // The retry reads the machine before it asks: a call that hung at the provider can land in the
                  // minute since, and a resume is worth sending only while the machine still reads paused.
                  landed = tookTheResume(await readsState(entry.machine));
                  continue;
                }
              }
              // The provider would not resume it for the whole of the asking: the record carries the road out until
              // something replaces the machine, since nothing about it changes on its own from here.
              const gaveUp = !stopped() && e instanceof ResumeUnansweredError ? wakeGaveUpLine(ask, clock.now() - began) : undefined;
              if (gaveUp !== undefined) entry.record.wakeRefused = gaveUp;
              // A stop leaves the machine where the abort found it: paused, until the late read says otherwise.
              if (stopped()) entry.ws.notePaused();
              entry.record.phase = entry.ws.currentPhase;
              await persist(entry.record);
              delete entry.wakeAsk;
              const words = stopped() ? WAKE_STOPPED : (gaveUp ?? (e instanceof Error ? e.message : String(e)));
              await emitStatus(entry, "napping", words);
              armLateRead(entry);
              throw stopped() ? new Error(WAKE_STOPPED) : gaveUp !== undefined ? new Error(gaveUp) : e;
            }
          }
        } finally {
          delete entry.wakeStop;
          delete entry.wakeSaid;
          delete entry.wakeAsk;
          delete entry.waking;
        }
      })();
      return entry.waking;
    },

    async stopWake(id, origin) {
      const entry = await entryOf(id, origin);
      const waking = entry.waking;
      entry.wakeStop?.abort();
      await waking?.catch(() => {});
      return view(entry.record);
    },

    async upgrade(id, origin) {
      const entry = await entryOf(id, origin);
      refuseCannot(entry, "replacesMachine", "have its machine replaced");
      await entry.ws.upgrade();
      followMachine(entry);
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      return view(entry.record);
    },

    async updateImage(id, origin) {
      const entry = await entryOf(id, origin);
      refuseCannot(entry, "replacesMachine", "move to a newer image");
      const manifest = await goldenManifestOf(entry.record.golden);
      const head = goldenHead(manifest);
      const project = (await store.get(PROJECT_GOLDENS, entry.record.golden)) as ProjectGolden | undefined;
      const refusal = imageMoveRefusal(entry.record.name, workspaceState({ phase: entry.record.phase }), { knownVersion: head !== undefined, projectImage: project !== undefined });
      if (refusal !== null) throw Object.assign(new Error(refusal), { kind: "conflict" });
      // The refusal covers an image no manifest knows, so both are there by the time the move runs.
      const to = head!;
      const was = entry.record.golden;
      const from = manifest!.versions.find(v => v.snapshotId === was);
      if (to.snapshotId === was) return { workspace: view(entry.record), moved: false, kept: [] };
      // The archive is what lands and --recursive-unlink cannot merge, so which of the image's own files the fork
      // keeps is settled here, off the machine that is still running, before anything is replaced.
      const plan = await imageMovePlan(entry.machine, from, to);
      // The fork reads the record, so the new image is named before the machine is replaced; the vault carries the
      // work across. A move that throws puts the record back, so a retry forks what the
      // workspace is actually running.
      entry.record.golden = to.snapshotId;
      try {
        await entry.ws.upgrade(undefined, { drop: plan.drop.map(path => `${GUEST_HOME}/${path}`) });
      } catch (e) {
        entry.record.golden = was;
        throw e;
      }
      followMachine(entry);
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      await emitStatus(entry, reachOf(entry), `moved from image v${from?.version ?? "?"} to v${to.version}`);
      return { workspace: view(entry.record), moved: true, kept: plan.kept, ...(plan.fallback ? { fallback: true } : {}) };
    },

    async rebuild(id, origin) {
      const entry = await entryOf(id, origin);
      refuseCannot(entry, "replacesMachine", "be rebuilt");
      if (entry.waking) await entry.waking.catch(() => {});
      if ((await recoverGone(entry)) !== undefined) return view(entry.record);
      const old = entry.record.machineId;
      const vaulted = (await store.getBlob(VAULTS, id)) !== undefined;
      await entry.ws.rebuild();
      followMachine(entry);
      delete entry.record.wakeRefused;
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      const reason = `rebuilt: ${old} replaced by ${entry.record.machineId}, ${vaulted ? "nap-time vault imported" : "no vault to import"}`;
      console.warn(`rebuild of ${id}: ${reason}`);
      await emitStatus(entry, reachOf(entry), reason);
      return view(entry.record);
    },

    async rename(id, typed, origin) {
      const entry = await entryOf(id, origin);
      const name = nameGiven(typed);
      if (entry.record.name === name) return view(entry.record);
      const refusal = nameRefusal(name);
      if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
      entry.record.name = name;
      await persist(entry.record);
      await store.put(WORKSPACE_NAMES, id, { workspaceId: id, name, project: entry.record.project } satisfies NamedWorkspace);
      bus.emit({ type: "workspace.renamed", workspaceId: id, name });
      return view(entry.record);
    },

    async look(id, look, origin) {
      const entry = await entryOf(id, origin);
      putLook(entry.record, "theme", look.theme);
      putLook(entry.record, "glyph", look.glyph);
      await persist(entry.record);
      bus.emit({ type: "workspace.look", workspaceId: id, theme: entry.record.theme ?? null, glyph: entry.record.glyph ?? null });
      return view(entry.record);
    },

    async snapshot(id, origin) {
      const entry = await entryOf(id, origin);
      refuseCannot(entry, "diskSnapshots", "be snapshotted");
      const { name } = entry.record;
      // The snapshot is the whole disk and carries the project in it, which is the one the workspace was made for.
      const held = projectHeld(entry.record.project);
      const project: WorkspaceProject = { name: held.name, dest: held.path, importedAt: held.createdAt };
      const projects = [project];
      if (entry.record.phase !== "running") throw new Error(`${name} is ${entry.record.phase}; only a running machine can be snapshotted`);
      await syncDisk(entry.machine);
      const disk = await diskUse(entry.machine);
      const createdAt = new Date(clock.now()).toISOString();
      const snapshotId = await entry.ws.checkpoint(projectSnapshotName(templateHostId, project.name, createdAt.replace(/[:.]/g, "-"))).catch((e: unknown) => {
        if (e instanceof NotFirstLifeError) throw e;
        const said = snapshotRefusedLine(name, answerOf(e), disk);
        console.warn(said);
        const { kind, status } = e as { kind?: unknown; status?: unknown };
        throw Object.assign(new Error(said), kind !== undefined ? { kind } : {}, status !== undefined ? { status } : {});
      });
      const image = await imageOf(entry.record.golden);
      const golden: ProjectGolden = {
        snapshotId,
        projects,
        golden: image.golden,
        ...(image.version !== undefined ? { version: image.version.version } : {}),
        workspaceId: id,
        workspaceName: name,
        createdAt,
        ...(entry.record.place !== undefined ? { place: entry.record.place } : {}),
      };
      await store.put(PROJECT_GOLDENS, snapshotId, golden);
      return golden;
    },

    async updateDaemon(id, origin) {
      const entry = await entryOf(id, origin);
      if (servedByItsComputer(entry) !== undefined) {
        throw new Error(placeServesDaemonLine(entry.record.name, computerOf(entry)));
      }
      const deploy = moduleOf(entry.record.kind).deployDaemon;
      if (deploy === undefined) throw new Error("this runtime cannot deploy a daemon; the host wires the bundle");
      if (entry.record.phase !== "running") throw new Error(`wake ${entry.record.name} before updating its daemon`);
      await deployDaemonOn(entry, deploy);
    },

    async delete(id, origin) {
      spawnGuard("delete", origin);
      const entry = await entryOf(id, origin);
      if (entry.deleting) return entry.deleting;
      entry.deleting = (async () => {
        try {
          delete entry.deleteSaid;
          endSessions(id, DELETED_REASON);
          // A machine wsp never forked reads running whatever is asked of it, so only a forked one is read back.
          if (!kindWords(entry.record.kind).driven) {
            await entry.machine.kill().catch((e: unknown) => {
              if (!isMissing(e)) throw e;
            });
          } else {
            await unfork(entry).catch((e: unknown) => {
              if (!(e instanceof MachineAliveError)) throw e;
              const line = deleteRefusedLine(entry.record.name, e.machineId, e.state);
              entry.deleteSaid = { phase: entry.record.phase, line };
              console.warn(line);
              throw Object.assign(new Error(line), { kind: e.kind });
            });
          }
          await drop(id);
        } finally {
          delete entry.deleting;
        }
      })();
      return entry.deleting;
    },

    async forget(id, origin) {
      const entry = await entryOf(id, origin);
      const kind = entry.record.kind;
      if (!kindWords(kind).driven) throw Object.assign(new Error(forgetUndrivenRefusal(entry.record.name, machineWord(kind))), { kind: "conflict" });
      const state = await readGone(backendFor(entry.record), entry.machine.id);
      if (state !== "gone") {
        throw Object.assign(new Error(`${entry.record.name}'s machine ${entry.machine.id} is still ${state}; pause it or delete it at the provider first`), { kind: "conflict" });
      }
      endSessions(id, DELETED_REASON);
      await drop(id);
    },

    async touch(id, origin) {
      await entryOf(id, origin);
      idle.touch(id);
    },

    async restartDaemon(id, origin) {
      const entry = await entryOf(id, origin);
      const start = moduleOf(entry.record.kind).restartDaemon;
      if (start === undefined) throw new Error(`${entry.record.name}'s daemon runs on ${machineWord(entry.record.kind)}, which this host does not hold the process of`);
      await start(entry);
      // The poll's last measurement is of the daemon that is gone, and the next one is a poll away: the row would
      // go on saying no daemon for that long over a daemon this host has just watched start. Dropped rather than
      // replaced with a claim, so the row falls back to what this kind's road says and the next poll measures.
      polledReach.delete(entry.record.id);
      await pushStatus(entry);
    },

    async exec(id, cmd, o, origin) {
      const entry = await entryOf(id, origin);
      await copyBlocked(entry);
      return entry.machine.exec(cmd, o);
    },

    async execStream(id, argv, cwd, origin) {
      const entry = await entryOf(id, origin);
      await copyBlocked(entry);
      const { adapter } = adapterFor(entry);
      // Only the socket or the machine going away ends a command; a build may outlive the deadline a harness turn gets.
      const ranIn = await threadFolder(entry, { cwd });
      const inner = execFactoryFor(entry, { idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY })(inFolder(ranIn, argv.map(shellQuote).join(" ")), { env: { ...adapter.env } });
      let endWith: (reason: string) => void = () => {};
      const ended = new Promise<{ reason: string }>(resolve => {
        endWith = reason => resolve({ reason });
      });
      const running = {
        workspaceId: id,
        end: (reason: string): void => {
          endWith(reason);
          inner.kill();
        },
      };
      execs.add(running);
      // The inner poll loop notices the kill one poll late; the reason reaches the reader as soon as it is known.
      const lines = async function* (): AsyncGenerator<string> {
        const it = inner.lines[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await Promise.race([it.next(), ended]);
            if ("reason" in next) throw new Error(next.reason);
            if (next.done) return;
            yield next.value;
          }
        } finally {
          execs.delete(running);
        }
      };
      return { ...inner, lines: lines(), exited: Promise.race([inner.exited, ended.then(() => null)]), ...(ranIn !== undefined ? { ranIn } : {}) };
    },

    async bringBack({ workspaceId, title, body }, origin) {
      spawnGuard("bring_back", origin);
      const entry = await entryOf(workspaceId, origin);
      await copyBlocked(entry);
      const cwd = checkoutOf(entry.record);
      // The branch this copy started from, off its own record: for a child that is the branch its parent was on at
      // the fork, which is the code it was cut from and so where its work goes back, and nothing is asked of the
      // parent's machine, so a child whose parent has gone to sleep brings its work back without a wake nobody
      // named. A record written before that fact was kept reads the branch its project starts from, as it did.
      const base = entry.record.base ?? projectHeld(entry.record.project).base;
      const against = base === undefined ? {} : { base };
      return withDaemon(entry, async ask => {
        const push = GitPushReply.parse(await ask({ op: "git.push", cwd, ...against }));
        const asked = { op: "git.pr", cwd, ...against, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
        // The push has landed by here, so nothing the pull request half says makes this a failed bring back: the
        // branch is on the remote either way and the two halves are answered apart. A machine with no signed-in
        // command line for the host is the note it always was; any other refusal rides beside the push as its own,
        // which the verb above prints under the push lines and then exits on.
        const opened = await ask(asked).catch((e: unknown) => {
          const said = e instanceof Error ? e.message : String(e);
          return isNoHostCli(e) ? { note: said } : { refused: said };
        });
        const half = opened as { note?: string; refused?: string };
        const apart = half.note !== undefined ? { note: half.note } : half.refused !== undefined ? { refused: half.refused } : { pr: GitPrReply.parse(opened).pr };
        return { branch: push.branch, base: push.base, ahead: push.ahead, uncommitted: push.uncommitted, stat: push.stat, ...apart };
      });
    },

    async daemonReach(id, origin) {
      const entry = await entryOf(id, origin);
      return moduleOf(entry.record.kind).daemonRoad(entry);
    },

    async daemonChannel(id, onEvent, origin) {
      const entry = await entryOf(id, origin);
      await copyBlocked(entry);
      const served = servedByItsComputer(entry);
      return served === undefined ? ownDaemonChannel(entry, onEvent) : servedChannel(entry, served, onEvent, WORKSPACE_FRAMES);
    },

    async guestChannel(id, onEvent) {
      const entry = await entryOf(id);
      const served = servedByItsComputer(entry);
      return served === undefined ? ownDaemonChannel(entry, onEvent) : servedChannel(entry, served, onEvent, GUEST_ROAD_FRAMES);
    },

    async servedByItsComputer(id, origin) {
      return servedByItsComputer(await entryOf(id, origin)) !== undefined;
    },

    async watchSys(id, fn, origin) {
      const entry = await entryOf(id, origin);
      const kind = entry.record.kind;
      if (readingRoad(kind, "metrics") !== "host") throw new Error(`${machineWord(kind)} reads its own load over its daemon link, not from this host`);
      if (local?.sysSamples === undefined) throw new Error("this host reads nothing of the computer it runs on");
      return local.sysSamples(fn);
    },

    async portReach(id, port, origin) {
      const entry = await entryOf(id, origin);
      await copyBlocked(entry);
      const reach = await entry.ws.portReach(port);
      return { url: reach.url, expiresAt: reach.expiresAt };
    },

    async portProbe(id, port, origin) {
      const entry = await entryOf(id, origin);
      await copyBlocked(entry);
      const reach = await entry.ws.portReach(port);
      // A followed redirect would refetch without the token or the edge's cookies and report the edge's 401 for a page the frame loads fine.
      const res = await fetch(reach.url, { redirect: "manual", signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS) });
      const body = await readBodyUpTo(res, PORT_PROBE_BODY_CAP);
      if (res.status === 401) await entry.ws.remintPortReach(port);
      return { status: res.status, body };
    },

    async originRefusal(id, origin) {
      await ready();
      return refusalFor(live.get(id)?.record, origin);
    },

    seenBy(event, origin) {
      const scope = scopeOf(origin);
      if (scope === undefined) return true;
      const asked = askerOf(event);
      if (asked !== undefined) return asked.threadId === scope.threadId || asked.rootThreadId === scope.rootThreadId;
      const id = workspaceIdOf(event);
      const record = id === undefined ? undefined : live.get(id)?.record;
      if (record === undefined) return false;
      // An event about a thread is that thread's tree's, whatever workspace it names: the stream shows exactly what
      // the listing and the transcript show, a lead's turn to the child on its copy included, and hides the rest,
      // so a row cannot be read going by. An event with no thread is about the workspace and reads its rule.
      const thread = (event as { threadId?: unknown }).threadId;
      if (typeof thread === "string") return reachesRow({ threadId: thread, workspaceId: record.id }, origin);
      return refusalFor(record, origin) === undefined;
    },
  };

  /** One probe per harness per machine per TTL, a failed one included and one in flight shared: a binary that does
   * not answer costs one exec, not one per composer mount. */
  const catalogs = new Map<string, { at: number; catalog: Promise<HarnessCatalog> }>();
  const catalogOn = (table: HarnessCatalog, entry: LiveWorkspace, adapter: HarnessAdapter): Promise<HarnessCatalog> => {
    const machine = entry.machine;
    const forMachine = (c: HarnessCatalog): HarnessCatalog => workspaceAccess(c, entry.record.kind);
    const known: HarnessCatalog = {
      ...table,
      steers: adapter.steers,
      renames: adapter.renameSession !== undefined,
      images: adapter.attachments !== undefined,
      ...(adapter.mcpServers === true ? { mcpServers: true } : {}),
      ...(adapter.movesAccess === true ? { movesAccess: true } : {}),
      ...(adapter.screenCommands !== undefined ? { screenCommands: [...adapter.screenCommands] } : {}),
    };
    if (adapter.probeCatalog === undefined) return Promise.resolve(forMachine(known));
    const key = `${machine.id}:${table.harness}`;
    const hit = catalogs.get(key);
    const now = clock.now();
    if (hit !== undefined && now - hit.at < CATALOG_TTL_MS) return hit.catalog.then(forMachine);
    const catalog = adapter
      .probeCatalog(command => machine.exec(command, { timeoutMs: CATALOG_PROBE_TIMEOUT_MS }).then(res => res.stdout))
      // A binary that named why it described nothing keeps the table's lists and lends the footer its words.
      .then(
        answer => (answer === null ? known : catalogRefused(answer) ? { ...known, refusal: answer.refused } : catalogFromProbe(known, answer)),
        (e: unknown) => {
          // The lists a start is checked against are then wsp's own, which refuse a model the binary there takes.
          console.warn(`${table.harness} on ${machine.id}: the probe of the agent failed (${e instanceof Error ? e.message : String(e)}); wsp's built-in list answers until the next probe`);
          return known;
        },
      );
    catalogs.set(key, { at: now, catalog });
    return catalog.then(forMachine);
  };

  /** One title read per harness session per machine per TTL, a failed one included and one in flight shared: the
   * clients reload the index on every session event and each reload must not cost an exec. `failed` holds from a
   * read that failed until one answers, so a store that fails every window is said once. */
  const titleReads = new Map<string, { at: number; done: Promise<void>; live: boolean; failed: boolean }>();
  /** Asks the harness what it calls a row's session and keeps the answer on every row that shares it, so the title
   * a client folds a thread by follows a rename made inside the harness. `force` reads past the TTL: a turn has just
   * ended, which is when the harness writes its own title. Nothing happens while the machine cannot be asked, or
   * when the harness has no title for the session: the rows keep the last one read rather than losing it to a nap.
   */
  const refreshTitle = (view: SessionView, force: boolean): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || unreachedOf(entry) !== undefined || adapters[view.harness] === undefined) return Promise.resolve();
    const key = `${entry.machine.id}:${sessionId}`;
    const hit = titleReads.get(key);
    const now = clock.now();
    if (hit !== undefined && (hit.live || (!force && now - hit.at < SESSION_TITLE_TTL_MS))) return hit.done;
    // The adapter is built after the window is checked, so a refresh inside it costs nothing at all.
    const read = adapterFor(entry, view.harness).adapter.sessionTitle;
    if (read === undefined) return Promise.resolve();
    const pending: { at: number; done: Promise<void>; live: boolean; failed: boolean } = { at: now, live: true, done: Promise.resolve(), failed: hit?.failed ?? false };
    // The read is started inside a promise and never on this stack: an adapter that refuses the id throws where it
    // builds its command (the codex guard does), and one row's store read may never cost the listing or the turn
    // that asked for it. Nothing here rejects, so both callers may leave it unawaited.
    pending.done = Promise.resolve()
      .then(() => read(sessionId, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout)))
      // The window opens when the store answered, before the answer is kept: a row that shows the title is a read
      // that is over, so a listing that sees one waits on nothing.
      .finally(() => {
        pending.at = clock.now();
        pending.live = false;
      })
      .then(
        async title => {
          pending.failed = false;
          if (title === null) return;
          // A title in the harness's own store is the person's rename inside it or the one the harness itself made
          // for them, and both outrank anything we would generate; only the opening words, which codex writes there
          // at a thread's start, are the seed again, and a seed is no news to a row that already carries a name.
          for (const s of sessions.values()) {
            if (s.view.workspaceId !== entry.record.id || s.view.claudeSessionId !== sessionId) continue;
            const source = storedTitleSource(title, s.view.prompt);
            if (source === "seed" && sourceOf(s.view) !== "seed") continue;
            s.view.harnessTitle = title;
            s.view.titleSource = source;
          }
          await persistSessions(entry.record.id);
        },
        (e: unknown) => {
          if (!pending.failed) console.warn(noTitleLogLine(sessionId, entry.record.id, providerSaid(e)));
          pending.failed = true;
        },
      );
    titleReads.set(key, pending);
    return pending.done;
  };

  /** Where a row's title came from; a row written before provenance was recorded, and one with no title at all,
   * read as the words its opening turn seeded the thread with. */
  const sourceOf = (view: SessionView): TitleSource => view.titleSource ?? "seed";
  /** Every turn of one thread, whatever harness session each of them ran under. */
  const rowsOn = (threadId: string): SessionView[] => [...sessions.values()].filter(s => s.view.threadId === threadId).map(s => s.view);
  /** Where the thread's title came from, over all its turns: a person's name on any of them is the thread's, since
   * the fold reads the latest turn's title and a resume writes a row of its own. */
  const threadSource = (threadId: string): TitleSource => {
    let source: TitleSource = "seed";
    for (const view of rowsOn(threadId)) {
      if (sourceOf(view) === "person") return "person";
      if (sourceOf(view) === "auto") source = "auto";
    }
    return source;
  };
  /** The title a new turn of an existing thread carries in: the newest turn that has one. A resume writes a fresh
   * row, and the fold titles the thread by the latest, so a thread that is not seeded again here loses its name. */
  const carriedTitle = (threadId: string): Pick<SessionView, "harnessTitle" | "titleSource"> => {
    const titled = rowsOn(threadId)
      .filter(v => v.harnessTitle !== undefined)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (titled?.harnessTitle === undefined) return {};
    return { harnessTitle: titled.harnessTitle, titleSource: sourceOf(titled) };
  };

  /** Writes a thread's name into the harness's own store, so `claude --resume` and codex's own list say what the app
   * says. The name stands here whatever the store answers: a harness that keeps no name of a person's does nothing,
   * and a store that refused says so in the log once. */
  const nameInHarness = (view: SessionView, title: string): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return Promise.resolve();
    const write = adapterFor(entry, view.harness).adapter.renameSession;
    if (write === undefined) return Promise.resolve();
    // Started inside a promise and never on this stack, as the store read is: an adapter that refuses the id throws
    // where it builds its command, and naming a thread may never cost the turn that asked for it.
    return Promise.resolve()
      .then(() => write(sessionId, title, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout)))
      .then(
        wrote => {
          if (wrote.kind === "failed") console.warn(noNameWriteLogLine(sessionId, entry.record.id, wrote.error));
        },
        (e: unknown) => console.warn(noNameWriteLogLine(sessionId, entry.record.id, e instanceof Error ? e.message : String(e))),
      );
  };

  /** The threads whose one title question has been asked, so a harness that answered nothing is not asked again at
   * the next turn's start. In memory only: a host that started again asks once more, which is not a loop. */
  const titlesAsked = new Set<string>();
  /** Asks the harness for a name for the thread whose first turn just started, from the opening turn alone, once per
   * thread and only while the thread still carries the words its opening turn seeded it with. A person's name, given
   * here or found in the harness's own store, is never replaced: it is read before the question goes out and again
   * when the answer lands, since a rename can happen while the harness is thinking. The answer is written back into
   * the harness's store, so its own UI shows the same name.
   */
  const makeTitle = async (view: SessionView): Promise<void> => {
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (threadId === undefined || entry === undefined || titlesAsked.has(threadId)) return;
    if (view.prompt === undefined || threadSource(threadId) !== "seed") return;
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return;
    const { harness, adapter } = adapterFor(entry, view.harness);
    if (adapter.titleFor === undefined) return;
    titlesAsked.add(threadId);
    const table = harnessCatalog(harness);
    const model = smallestModel(table === undefined ? undefined : await catalogOn(table, entry, adapter));
    const title = await adapter.titleFor(
      { opening: view.prompt, ...(model !== undefined ? { model } : {}) },
      command => entry.machine.exec(command, { timeoutMs: TITLE_MAKE_TIMEOUT_MS }).then(res => res.stdout),
    );
    if (title === null) {
      console.warn(noMadeTitleLogLine(threadId, entry.record.id, "the harness answered with no title"));
      return;
    }
    if (threadSource(threadId) === "person") return;
    for (const row of sessions.values()) {
      if (row.view.threadId === threadId) {
        row.view.harnessTitle = title;
        row.view.titleSource = "auto";
      }
    }
    await persistSessions(entry.record.id);
    await nameInHarness(view, title);
  };

  /** Which rows a refresh asks about: the newest turn of each harness session, newest first and no more than the cap. */
  const titleRows = (rows: readonly SessionView[]): SessionView[] => {
    const newest = new Map<string, SessionView>();
    for (const view of [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
      if (view.claudeSessionId !== undefined && !newest.has(view.claudeSessionId)) newest.set(view.claudeSessionId, view);
    }
    return [...newest.values()].slice(0, SESSION_TITLE_REFRESH_MAX);
  };

  /** The mark goes on the way out, never into the cache: a start and a list share one cached table. */
  const markDefault = (c: HarnessCatalog): HarnessCatalog => ({ ...c, ...(c.harness === DEFAULT_AGENT.id ? { isDefault: true } : {}) });

  /**
   * The turn's images on the road its adapter declared, imagesBlocked having already turned away what cannot go. An
   * inline adapter is handed the bytes and nothing lands anywhere, so there is no folder to answer with. A file
   * adapter is handed paths inside this send's own folder under the thread's images dir: two sends on one thread
   * would otherwise write the same paths and the first turn would be handed the second's picture, since the landing
   * happens before either turn is registered. The folder travels the same signed-URL road an import takes, since the
   * exec body holds 16 KB, and the caller removes it when the turn it was sent for ends.
   */
  const landImages = async (
    entry: LiveWorkspace,
    road: AttachmentRoad | undefined,
    dir: string,
    images: readonly ImageAttachment[],
  ): Promise<{ images: TurnImage[]; dir?: string }> => {
    if (images.length === 0 || road === undefined) return { images: [] };
    if (road === "inline") return { images: images.map(({ mediaType, bytes }) => ({ mediaType, bytes })) };
    const landed = images.map((image, index) => ({ ...image, path: imagePathIn(dir, index, image.mediaType) }));
    await importInto(entry.machine, tarOf(landed.map(i => ({ path: i.path, mode: 0o600, content: Buffer.from(i.bytes, "base64") }))), "/", { overlay: true });
    return { images: landed.map(({ mediaType, bytes, path }) => ({ mediaType, bytes, path })), dir };
  };

  /** Takes one send's images off the machine once the turn they were sent for is over, whatever it came to: the
   * harness read them at its start and nothing reads them again, so a thread that sends a screenshot and then runs
   * twenty text turns is not still holding it. A machine that is gone or asleep keeps the folder, and the thread's
   * own dir goes with the thread. */
  const dropImages = (entry: LiveWorkspace, dir: string): void => {
    void entry.machine.exec(`rm -rf ${shellQuote(dir)}`, { timeoutMs: INLINE_EXEC_MS }).catch((e: unknown) => {
      console.warn(`images for a finished turn not removed from ${entry.record.id}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  /** The adapter for a harness on this workspace's current machine; unnamed means the runtime's default. `turnEnv` is
   * what only a turn's own launch carries, laid over the machine's login environment: every kind answers with that
   * environment through its one module, so a variable put on here reaches a launch on every kind of machine and is
   * written nowhere else. `waiting` is the turn's own reading of whether it is waiting on something outside its own
   * process, a person's answer to a prompt or a command it started in the background, which its stream's idle clock
   * reads; absent on every road that is not a turn. It is handed beside the limits and never as one, so the turn
   * road goes on handing the factory none and runs under the turn's own. `servers` is the values the MCP servers'
   * definitions read by name, which only a turn's agent starts servers with, under the machine's own environment. */
  const adapterFor = (entry: LiveWorkspace, named?: string, turnEnv?: Readonly<Record<string, string>>, waiting?: TurnWaiting, servers: Readonly<Record<string, string>> = {}): { harness: string; adapter: HarnessAdapter } => {
    const harness = named ?? DEFAULT_AGENT.id;
    const factory = adapters[harness];
    if (!factory) throw new Error(noAdapterLine(harness, Object.keys(adapters)));
    const kind = moduleOf(entry.record.kind);
    const vault = opts.vault?.() ?? {};
    return {
      harness,
      adapter: factory({
        machine: entry.machine,
        workspaceId: entry.record.id,
        execStream: execFactoryFor(entry, undefined, waiting),
        home: id => kind.home(entry, id),
        env: { ...servers, ...kind.env(entry, harness), ...turnEnv },
        ...((): { projectKey?: string } => {
          const key = kind.memoryKey(entry, harness);
          return key !== undefined ? { projectKey: key } : {};
        })(),
        signInRefusal: signInRefusalLine({ kind: entry.record.kind }),
        vault,
        loginStands: id => kind.loginStands(entry, id),
      }),
    };
  };

  /** Whether any row of the thread is running, the harness holding it or not: a start writes its row before the turn
   * reaches the machine, and that row is one, so this is the test for whether the thread is spoken for. turnRuns is
   * the same test keyed by workspace. */
  const threadRuns = (threadId: string): boolean => [...sessions.values()].some(s => s.view.threadId === threadId && s.view.status === "running");
  /** The thread's row whose turn is still reaching the machine, if it has one; there is never more than one. */
  const launchingOn = (threadId: string): { turnId: string; launch: Promise<void> } | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.launch !== undefined) return { turnId: s.turnId, launch: s.launch };
    }
    return undefined;
  };

  type LiveSession = { view: SessionView; turnId: string; handle: SessionHandle; turnLive?: TurnLive };
  const runningOn = (threadId: string): LiveSession | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.view.status === "running" && s.handle !== undefined) return s as LiveSession;
    }
    return undefined;
  };
  /** The latest row of a thread, by its runtime id, across every workspace: a thread is named from anywhere. */
  const latestOn = (threadId: string): SessionView | undefined => {
    let latest: SessionView | undefined;
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && (latest === undefined || (s.view.startedAt ?? 0) >= (latest.startedAt ?? 0))) latest = s.view;
    }
    return latest;
  };
  /** The thread a request came out of, by the token that request's own launch environment carries: the row holding
   * that token beside its session id. Every token this host knows it minted into one turn's launch, so one no row
   * carries names a turn the caller is not, and it is refused rather than read as the person, which would send a
   * builder's report where nobody is waiting for it. */
  const threadOfToken = (token: string): string => {
    // Only a row still running answers: a turn the runtime ended from this side (a nap, a stop, a restart it could
    // not re-open) never reaches the exit that drops its token, and a token whose turn is over names nobody.
    for (const s of sessions.values()) if (s.turnToken === token && s.view.status === "running" && s.view.threadId !== undefined) return s.view.threadId;
    throw new Error(NO_SUCH_TURN);
  };
  /** Every thread the tree under this one holds, whether or not anything on it is running: read off the parent each
   * row carries, level by level, so a thread that spawned a thread that spawned a thread is all of it. */
  const treeUnder = (threadId: string): string[] => {
    const found: string[] = [];
    let front = [threadId];
    for (let steps = sessions.size + 1; steps > 0 && front.length > 0; steps--) {
      const next = [...new Set([...sessions.values()].map(x => x.view).filter(v => v.threadId !== undefined && v.parentThreadId !== undefined && front.includes(v.parentThreadId)).map(v => v.threadId!))].filter(id => !found.includes(id) && id !== threadId);
      found.push(...next);
      front = next;
    }
    return found;
  };
  /** Which threads a thread's own token reaches: every thread of its own tree, the lead that started it, the ones
   * beside it under that lead and the ones under itself, on whatever workspace each runs, read off the root every
   * row carries. Two trees on one workspace neither read nor drive each other, the person's own thread beside a
   * lead included, and anything crossing between them goes through the person. A caller that is no thread reaches
   * every thread this host holds; a row with no thread of its own is in nobody's tree and is hidden from every
   * thread. This sits beside the workspace rule rather than inside it: the tree, not the workspace, is what a
   * thread's token reaches for threads. */
  const drivesThread = (threadId: string | undefined, caller: Caller | undefined): boolean => {
    const scope = scopeOf(caller);
    if (scope === undefined) return true;
    return threadId !== undefined && rootOf(threadId) === scope.rootThreadId;
  };
  /** What a thread is called, by the one rule every listing reads it by: its own rows folded, so a thread named in
   * another thread's row reads there exactly as it reads in the sidebar. */
  const threadTitle = (threadId: string): string => {
    const rows = [...sessions.values()].map(x => x.view).filter(v => v.threadId === threadId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return foldThreads(rows)[0]?.title ?? threadWord(threadId);
  };

  /** The prompt each thread is stopped on, whole, by thread id. The row carries the lead as a line; a thread whose
   * own call is waiting behind this one has to draw the question and answer it, so the question itself is kept here
   * for as long as it stands open. */
  const leadAsks = new Map<string, PermissionAsk>();

  /** The thread one running turn's calls are stopped behind, when one of them is a wsp call that follows another
   * thread to the end of its turn and that thread has an open prompt. A call that opened its own thread is behind
   * the whole tree under the caller, so a chain of agents waiting on each other names the one question at the
   * bottom of it: answering that is what moves any of them. */
  const stoppedBehind = (s: { view: SessionView; calls?: Map<string, { toolName: string; input: string }> }): ThreadWaitingOn | undefined => {
    const caller = s.view.threadId;
    if (caller === undefined || s.calls === undefined) return undefined;
    for (const call of s.calls.values()) {
      const follows = threadsFollowed(call);
      if (follows === undefined) continue;
      const behind: string[] = "opened" in follows ? treeUnder(caller) : [...sessions.values()].map(x => x.view.threadId).filter((id): id is string => id !== undefined && follows.named.some(ref => id.startsWith(ref)));
      for (const threadId of behind) {
        const prompt = leadAsks.get(threadId);
        if (prompt === undefined || threadId === caller) continue;
        const asked = [...sessions.values()].find(x => x.view.threadId === threadId && x.view.status === "running");
        if (asked === undefined) continue;
        return { threadId, workspaceId: asked.view.workspaceId, sessionId: asked.view.id, title: threadTitle(threadId), prompt: { ...prompt, options: [...prompt.options] } };
      }
    }
    return undefined;
  };

  /** Stops every running turn on the tree under a thread, deepest first, and answers with the threads it stopped. */
  const stopUnder = async (threadId: string, caller: Caller | undefined): Promise<string[]> => {
    const stopped: string[] = [];
    for (const child of treeUnder(threadId).reverse()) {
      const row = latestOn(child);
      if (row === undefined || row.status !== "running") continue;
      const outcome = await sessionsApi.interrupt(row.id, caller).catch((e: unknown) => {
        console.warn(`thread ${threadWord(child)} was not stopped with its root: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      if (outcome?.outcome === "accepted") stopped.push(child);
    }
    return stopped;
  };
  /** What the thread's start registered, kept by every turn on it: the targets, the thread that named them and the
   * road it named them from. */
  const notifyOn = (threadId: string): { notify: readonly string[]; by?: ThreadScope; road?: WorkspaceOrigin } | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.notify !== undefined) {
        return { notify: s.notify, ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}), ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}) };
      }
    }
    return undefined;
  };
  /** Whether a row can be told anything at all: it has a session to resume. A thread whose workspace went while its
   * builder worked has none, and the report must not go with it. The one predicate both roads read, the check before
   * a line is addressed and the send that carries it. */
  const tellable = (row: SessionView | undefined): row is SessionView => row?.claudeSessionId !== undefined;
  /** Every thread these targets lead to through the notify registrations: a thread's end tells its targets, and each
   * of those ends tells its own. Walked as a set, since two targets may lead to one thread and a chain that already
   * loops would otherwise be walked forever. */
  const notifyReach = (from: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = from.filter(target => target !== NOTIFY_ME);
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(notifyOn(at)?.notify ?? []).filter(target => target !== NOTIFY_ME));
    }
    return seen;
  };
  /** Lines for a parent whose workspace could not take a start when the child ended (napping, or the nap that ended
   * the child), sent when that workspace wakes; in memory only, so a host restart during the nap drops them. */
  const heldLines = new Map<string, { from: string; notify: string; text: string; by?: ThreadScope; road?: WorkspaceOrigin; fell?: () => void }[]>();
  /** Who the lines off a row are delivered as: the thread that registered its targets and the road it registered
   * them from, read off the row that holds both so the two never drift apart. */
  const tellAs = (s: { notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin }): { by?: ThreadScope; road?: WorkspaceOrigin } => ({
    ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}),
    ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}),
  });
  /** The line into the parent thread as a send would go: steered into its running turn, or queued behind it, which
   * is what a parent still in its own reply tail gets, since the send road waits for that process rather than
   * refusing. It goes under the thread that named the target, so the switch on that thread's workspace and the
   * tree rule are read at delivery and not at registration alone; a line a person registered goes as the person's,
   * which is what every row written before the scope rode beside the targets carries. A parent with no session to
   * resume, and a start that door refuses, drop the line with a warning and call the line's own `fell`, which tells
   * the person the report is there; the child's end must not fail on either. */
  const deliver = (line: { from: string; notify: string; text: string; by?: ThreadScope; road?: WorkspaceOrigin; fell?: () => void }): void => {
    const { from, notify, text, by, road, fell = () => {} } = line;
    const parent = latestOn(notify);
    if (!tellable(parent)) {
      console.warn(`thread ${from.slice(0, 8)} ended, but thread ${notify.slice(0, 8)} has no session to tell`);
      fell();
      return;
    }
    const phase = live.get(parent.workspaceId)?.record.phase;
    if (phase !== undefined && sendRefusal(workspaceState({ phase })) !== null) {
      // The line keeps the road that tells the person: a wake is minutes or hours later, and one the door refuses
      // then falls away exactly as one refused now does, once for the turn that ended.
      heldLines.set(parent.workspaceId, [...(heldLines.get(parent.workspaceId) ?? []), line]);
      return;
    }
    // The road the targets were named from is read again here, where the line starts a turn: a device the person
    // paired may not start one, by the same list both doors read, so a row an older host wrote under that road
    // falls away to the person rather than starting a turn a paired socket could not.
    if (road === "paired" && !DEVICE_OPS.includes("sessions.start")) {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line was registered from a paired computer, which starts no turn on thread ${notify.slice(0, 8)}`);
      fell();
      return;
    }
    // The caller this start runs under: the thread that registered the targets where one did, and the road it
    // registered them from. A line nobody but the person registered carries neither and goes as theirs, which is
    // what every row written before the road rode beside the targets holds.
    const asWho: Caller | undefined = by === undefined ? road : { origin: road ?? "here", by };
    sessionsApi.start(parent.workspaceId, { prompt: text, harness: parent.harness, resume: parent.claudeSessionId, startedBy: "agent" }, asWho).catch((e: unknown) => {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      fell();
    });
  };
  // A wake or a rebuild (of a gone or zombie machine) puts the workspace back to running: the held lines go now.
  for (const type of ["workspace.woken", "workspace.upgraded"] as const) {
    bus.on(type, e => {
      if (e.type !== type) return;
      const lines = heldLines.get(e.workspaceId) ?? [];
      heldLines.delete(e.workspaceId);
      for (const l of lines) deliver(l);
    });
  }
  /** The one line an ending turn sends where its thread's start said: into a thread, or nowhere further for me, whom
   * the recorded event reaches. Recorded before the turn's session.done, since a follower ends there; the person's
   * own row for a line the target's door refused is the exception, since that answer comes after the start it made. */
  const notifyEnd = (s: { view: SessionView; turnId: string }, notify: readonly string[], named: { by?: ThreadScope; road?: WorkspaceOrigin }, result: TurnResult): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    // A target whose thread has gone by now cannot be told, and its report must not go with it: the person is told
    // instead, once, however many targets fell away.
    const reachable = notify.filter(target => target === NOTIFY_ME || tellable(latestOn(target)));
    const targets = reachable.length === notify.length ? notify : [...new Set([...reachable, NOTIFY_ME])];
    let toldThePerson = targets.includes(NOTIFY_ME);
    // The same road for a line the target's own door refused, which the start answers only after this loop is over:
    // a workspace whose switch went off after the registration, or a thread that left the tree that named it.
    const fell = (): void => {
      if (toldThePerson) return;
      toldThePerson = true;
      record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: NOTIFY_ME, text: notifyLine(threadId, result, "tail") });
    };
    for (const target of targets) {
      // A thread reads its child's line as a message and acts on it, so it gets the report whole; the person reads
      // it as a row beside every other, so theirs stays one line.
      const text = notifyLine(threadId, result, target === NOTIFY_ME ? "tail" : "whole");
      record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: target, text });
      if (target !== NOTIFY_ME) deliver({ from: threadId, notify: target, text, ...named, fell });
    }
  };
  /** Settles a running row whose process the runtime ended or lost before the harness's own session.end: to the reply
   * it held, whose line already went, or failed with `cutLine` as the parent's word when it never replied. The
   * session.end carries `reason` either way. The one rule for both roads, the runtime's end() and the restart load. */
  const settleCut = (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive }, reason: string, cutLine: (endedAt: number) => string): void => {
    const reply = s.turnLive?.reply;
    const endedAt = Date.now();
    s.view.status = reply ?? "failed";
    s.view.endedAt = endedAt;
    // A prompt the turn was stopped on goes with it, on this road as on the harness's own exit: nothing can answer
    // one whose process is gone, and a settled row still carrying it would read as waiting on a person forever.
    delete s.view.asking;
    if (s.view.threadId !== undefined) leadAsks.delete(s.view.threadId);
    if (reply === undefined && s.notify !== undefined) notifyEnd(s, s.notify, tellAs(s), { status: "failed", error: cutLine(endedAt) });
    record({ type: "session.end", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId: s.view.threadId, exitCode: null, sawResult: reply !== undefined, reason });
  };
  /** Recorded once the harness took the line, so the row sits where the turn could first see it. */
  const recordSteer = (s: { view: SessionView; turnId: string }, handleId: string, o: { prompt: string; requestId?: string }): void => {
    record({
      type: "session.steer",
      workspaceId: s.view.workspaceId,
      sessionId: s.view.claudeSessionId ?? handleId,
      turnId: s.turnId,
      ...(s.view.threadId !== undefined ? { threadId: s.view.threadId } : {}),
      prompt: o.prompt,
      ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
      // Read off the row the turn writes its open prompt on: a message that joined a turn stopped on one waits for
      // the person as the turn does, and the caller says so rather than going quiet until the prompt is answered.
      ...(s.view.asking !== undefined ? { waiting: true } : {}),
    });
  };

  /** What a turn is once its harness session exists: the one road from the harness's events to the transcript, the
   * index, the bus and the row, whether the session was launched here or re-opened on the machine after a restart.
   * A re-opened turn's run is read from its first byte, so what the transcript already holds for this turn is
   * counted first and read past in silence: a delta is recorded once however many hosts read the run it came from. */
  const runTurn = (t: {
    entry: LiveWorkspace;
    view: SessionView;
    /** The thread this turn runs on, which every row the runtime writes carries. */
    threadId: string;
    turnId: string;
    notify?: readonly string[];
    /** The thread that named those targets, where a thread named them: the line their end delivers starts the
     * target's turn under it, so the rules that let it name them are read again when the line goes. */
    notifyBy?: ThreadScope;
    /** And the road they were named from, read at delivery beside the thread, so a caller that may start no
     * process on the target's workspace gets none started for it a turn later. */
    notifyRoad?: WorkspaceOrigin;
    /** The token this turn was launched with, kept on its row while the turn runs so a request out of it can name
     * this thread. */
    turnToken?: string;
    /** The device this turn's launch environment carries into the machine, taken away at the exit beside the turn
     * token: the two are one turn's identity and they end together. */
    scopeDeviceId?: string;
    outcome: SessionStartOutcome;
    /** What this turn's own session.start row carries, for the road that still has to write it. */
    opening: { prompt: string; requestId?: string; afterCut?: boolean; title?: string; attachments?: readonly ImageRecord[] };
    /** The harness session this turn resumes, so the row it takes over keeps who opened the thread and with what. */
    resume?: string;
    /** What the row already knows of this turn's reply: a re-opened turn whose result landed before the restart is
     * still working, and reads as such until the run's own result line comes round again. */
    turnLive?: TurnLive;
    /** The folder this turn's images landed in on the machine, removed when the turn ends however it ends; absent on
     * a turn that landed none, whose harness read them inline or which carried none at all. */
    imagesDir?: string;
    /** The box the turn's own exec stream reads to know it is waiting on something outside its own process: flipped
     * while a permission prompt of this turn stands open, and while its harness reports a command or a subagent it
     * started still running, so the turn's idle clock does not run out under a question nobody has answered yet nor
     * under a quiet watch on work the turn started. Absent on a road that hands the adapter no stream of its own. */
    waiting?: { on: boolean };
    open: (onEvent: (event: AdapterEvent) => void) => HarnessSession;
  }): SessionHandle => {
    const { entry, view, threadId, turnId, opening, outcome, notify, notifyBy, notifyRoad, turnToken, scopeDeviceId } = t;
    const workspaceId = entry.record.id;
    const written = transcripts.get(workspaceId) ?? [];
    /** The last row this turn wrote of a kind: the transcript holds every workspace's rows in the order they were
     * written, so a live turn's are at its tail. */
    const lastOf = <T extends SessionEvent["type"]>(type: T): Extract<SessionEvent, { type: T }> | undefined => {
      for (let i = written.length - 1; i >= 0; i--) {
        const e = written[i]!;
        if (e.type === type && e.turnId === turnId) return e as Extract<SessionEvent, { type: T }>;
      }
      return undefined;
    };
    // How many of this turn's lines are written, from the stamp the last surviving one carries rather than from how
    // many survive: the transcript is capped per workspace and drops its oldest rows, so counting them would read a
    // turn whose head has been evicted as shorter than it was and write its tail a second time.
    const deltasWritten = lastOf("session.delta")?.line ?? 0;
    // The reply and its line to the parent go together, so one gate stands for both.
    const recordedReply = lastOf("session.done")?.result.status;
    let replyRecorded = recordedReply !== undefined;
    // A turn with a line or a reply already written had its start written too, whether or not the cap still holds it:
    // a second start row at the tail of the transcript would sit after the work it opened.
    let startRecorded = deltasWritten > 0 || replyRecorded || lastOf("session.start") !== undefined;
    let deltas = deltasWritten;
    let replaying = deltasWritten;
    let ended = false;
    // The reply's status, held while the process still runs. Shared with this turn's session-map entry so runningOn
    // and the persisted row read it whether the harness emits its result synchronously in start() (before the entry
    // exists) or later from its stream.
    const turnLive: TurnLive = t.turnLive ?? {};
    /** The permission prompts of this turn nobody has answered. The harness is blocked on every one of them, so this
     * map is what the thread is waiting on, and it holds for as long as the turn lives. */
    const open = new Map<string, PermissionAsk>();
    /** Whether the harness reports work this turn started still running in the background. Beside the open prompts
     * because the two say the same thing about the turn: it is waiting on something its own process is not doing. */
    let tasksRunning = false;
    /** The tool calls of this turn the harness has not answered yet: what the agent is inside right now. A wsp call
     * among them that follows another thread is what can leave this turn stopped on a question it never asked. */
    const calls = new Map<string, { toolName: string; input: string }>();
    /** The harness's own answer road, once the turn is open; a prompt raised inside start() is answered through it
     * too, since it may stand for hours past the synchronous run that raised it. */
    let answerAsk: HarnessSession["answer"];

    /** The spans of this turn that went on a person rather than on work: closed ones added up, and the moment the
     * span still running began. The harness counts wall time from launch to result, so these are what its figure has
     * to give back before a reader is told how long the turn worked. */
    let waited = 0;
    let waitingSince: number | undefined;
    /** What the turn has spent on the person by now, the open span included, so a result that lands under a prompt
     * still standing counts the same as one that lands after it closed. */
    const waitedSoFar = (): number => waited + (waitingSince === undefined ? 0 : clock.now() - waitingSince);

    /** The one expression that says the turn is waiting on something outside its own process, which its stream's
     * idle clock touches on every poll: a prompt of its own nobody has answered, or work it started that the harness
     * says is still running. */
    const readsWaiting = (): void => {
      if (t.waiting !== undefined) t.waiting.on = open.size > 0 || tasksRunning;
    };

    /** Everything that moves when a prompt of this turn opens or closes, by the protocol's one rule for which open
     * prompt leads: what the row says the thread is waiting on, the question itself for a thread waiting behind
     * this one, whether the turn is blocked on a person, and the clock on how long it has been. Written on every
     * open and close, so the sidebar, the command line, the turn's idle clock and its settled figure read one fact. */
    const readsOpen = (): void => {
      const lead = leadAsk(open.values());
      if (lead === undefined) {
        delete view.asking;
        leadAsks.delete(threadId);
      } else {
        view.asking = askingLine(lead);
        leadAsks.set(threadId, lead);
      }
      readsWaiting();
      if (open.size > 0) waitingSince ??= clock.now();
      else if (waitingSince !== undefined) {
        waited += clock.now() - waitingSince;
        waitingSince = undefined;
      }
      void persistSessions(workspaceId);
    };

    /** The ask as clients read it: the harness's slug for a mode option carries no words of its own, and the words
     * for one live in the harness table beside the picker's, so they are lent here rather than in the adapter. */
    const named = (ask: PermissionAsk): PermissionOption[] => {
      const modes = harnessCatalog(view.harness)?.permissionModes ?? [];
      return ask.options.map(o =>
        o.effect === "mode" && o.mode !== undefined ? { ...o, label: permissionModeOptionLabel(modes.find(m => m.value === o.mode)?.label ?? o.mode) } : { ...o },
      );
    };

    /** The row that says a prompt is closed. Both the harness's own close and the runtime ending the turn under it
     * come through here: a turn cut from this side never reaches the adapter's close, and a row left open would keep
     * offering options that answer nothing. */
    const closeAsk = (askId: string, outcome: PermissionOutcome, optionId?: string): void => {
      if (!open.has(askId)) return;
      open.delete(askId);
      readsOpen();
      record({
        type: "session.permission.closed",
        workspaceId,
        sessionId: view.claudeSessionId ?? view.id,
        turnId,
        threadId,
        askId,
        outcome,
        ...(optionId !== undefined ? { optionId } : {}),
      });
    };

    /** Every prompt still waiting, closed as going with its turn; the caller is ending the turn. */
    const closeOpenAsks = (): void => {
      for (const askId of [...open.keys()]) closeAsk(askId, "cancelled");
    };

    /** The one place a pick becomes an outcome and the line the agent reads as the call's result. Only a person picks,
     * so a deny is always the person's and says so. */
    const answer = async (askId: string, o: { optionId: string }): Promise<SessionAnswerResult["outcome"]> => {
      const held = open.get(askId);
      if (held === undefined) return "gone";
      // One pick may name several options: a question that takes more than one answer sends them as one id.
      const option = pickedOptions(held.options, o.optionId)?.[0];
      if (option === undefined) return "no-option";
      // A turn that raised a prompt has the road that raised it; with none there is nothing left to answer it.
      if (answerAsk === undefined) return "gone";
      const outcome: PermissionOutcome = option.effect === "deny" ? "denied" : "allowed";
      return (await answerAsk(askId, { optionId: o.optionId, outcome, denyMessage: PERMISSION_DENIED_LINE })) === "answered" ? "answered" : "gone";
    };

    const forward = (event: AdapterEvent): void => {
      if (ended) return;
      const sessionId = event.sessionId;
      switch (event.type) {
        case "session.start": {
          view.claudeSessionId = sessionId;
          if (event.cwd !== undefined) view.cwd = event.cwd;
          if (event.model !== undefined) view.model = event.model;
          entry.record.claudeSessionId = sessionId;
          void persist(entry.record);
          void persistSessions(workspaceId);
          // The harness keys its store by the id it just announced, so a name given at the start is written now;
          // a CLI that already took it at launch is told the same name twice, which is what keeps this one road.
          if (opening.title !== undefined && !startRecorded) void nameInHarness(view, opening.title);
          // One turn is one start row however often the harness announces itself.
          if (startRecorded) return;
          startRecorded = true;
          record({
            type: "session.start",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            prompt: opening.prompt,
            ...(opening.requestId !== undefined ? { requestId: opening.requestId } : {}),
            ...(opening.afterCut === true ? { afterCut: true } : {}),
            ...(opening.attachments !== undefined ? { attachments: [...opening.attachments] } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
            ...(view.permissionMode !== undefined ? { permissionMode: view.permissionMode } : {}),
            agent: view.harness,
            ...(event.tools !== undefined ? { tools: event.tools } : {}),
            ...(event.harness !== undefined ? { harness: event.harness } : {}),
          });
          // The thread is named now, from its opening words, so a builder's row reads what it is about seconds
          // after it starts rather than after an hour-long turn. Asked here and not before the harness announced
          // its session: the store is read first, since what the harness already calls the session is a person's
          // and a thread that has one is never asked, and the answer is written back under that same id. This sits
          // under the one start row a turn writes, so a re-opened run, whose row the host that launched it wrote,
          // returns above and asks nothing.
          if (sourceOf(view) === "seed") {
            void refreshTitle(view, false)
              .then(() => makeTitle(view))
              .catch((e: unknown) => console.warn(noMadeTitleLogLine(threadId, workspaceId, e instanceof Error ? e.message : String(e))));
          }
          return;
        }
        case "turn.delta":
          if (event.kind === "tool_use" && event.toolUseId !== undefined && event.toolName !== undefined) calls.set(event.toolUseId, { toolName: event.toolName, input: event.text });
          else if (event.kind === "tool_result" && event.toolUseId !== undefined) calls.delete(event.toolUseId);
          if (replaying > 0) {
            replaying--;
            return;
          }
          record({
            type: "session.delta",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            line: ++deltas,
            kind: event.kind,
            text: event.text,
            ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
            ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
          });
          return;
        case "turn.done": {
          // A reply already written stands, and the gate comes before the status is taken: what the run says on the
          // way round again is the reply this turn already gave, and nothing later may overwrite it.
          if (replyRecorded) {
            replyRecorded = false;
            turnLive.reply ??= recordedReply;
            return;
          }
          // The reply is in, but the row stays running until session.end (the process exited): the harness can
          // keep working past its result, and a row read as completed here lets a send start a second agent in the
          // same worktree. The result is held and applied at the exit below.
          turnLive.reply = event.result.status;
          // The harness counts wall time from launch to result, prompts included, so the spans the turn stood on a
          // person ride out with it and every reader takes them off one figure rather than guessing at them.
          const onThePerson = waitedSoFar();
          const result: TurnResult = onThePerson > 0 ? { ...event.result, waitedMs: onThePerson } : event.result;
          // The cause rides the row too, since a refused turn did none of the work: what a thread is read as having
          // run is decided off the rows, and the result itself lives only in the transcript.
          if (result.refusal !== undefined) view.refusal = result.refusal;
          // So does what the turn cost, added to what the row's earlier turns cost: a resumed turn takes over the
          // row it resumes, and a listing has to answer what a thread spent without reading anyone's transcript.
          if (result.costUsd !== undefined) view.costUsd = (view.costUsd ?? 0) + result.costUsd;
          void persistSessions(workspaceId);
          if (notify !== undefined) notifyEnd({ view, turnId }, notify, tellAs(t), result);
          record({ type: "session.done", workspaceId, sessionId, turnId, threadId, result });
          return;
        }
        case "turn.tasks":
          // The harness's own word on the work this turn started: while any of it runs the turn is working, whatever
          // its agent has already said, so the idle clock is held the way an open prompt holds it.
          tasksRunning = event.running > 0;
          readsWaiting();
          return;
        case "permission.ask": {
          const ask = { ...event.ask, options: named(event.ask) };
          // The turn stops here until an option comes back. Nothing else closes it: a person who was away for an
          // hour comes back to the question they were asked, rather than to an agent that was denied and told to
          // ask for a mode that does not ask.
          open.set(ask.askId, ask);
          readsOpen();
          record({ type: "session.permission", workspaceId, sessionId, turnId, threadId, ...ask, options: [...ask.options] });
          return;
        }
        case "permission.close":
          closeAsk(event.askId, event.outcome, event.optionId);
          return;
        case "session.end":
          // A prompt the harness left open goes with its process: nothing can answer it now, and a row left open
          // would leave the thread reading as waiting on a person forever.
          closeOpenAsks();
          // The process exited: the turn is over now, so the row takes the reply's status here (synchronously,
          // before the event is recorded, so a waiter woken by it reads the settled row, not the running one).
          if (turnLive.reply !== undefined) view.status = turnLive.reply;
          view.endedAt = Date.now();
          record({
            type: "session.end",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            exitCode: event.exitCode,
            sawResult: event.sawResult,
          });
          return;
      }
    };

    idle.hold(workspaceId);
    let started: HarnessSession;
    try {
      started = t.open(forward);
    } catch (e) {
      idle.release(workspaceId);
      throw e;
    }
    started.finished.then(
      () => idle.release(workspaceId),
      () => idle.release(workspaceId),
    );
    answerAsk = started.answer?.bind(started);
    const handleId = started.localId;
    // A row that already has an id keeps it: a re-opened turn is named by the harness's own session, which is not
    // always the id the row was keyed by, and a client holding the row must not see it change under a restart. The
    // turn's own id is the exception, the one the start road keyed this row by while the turn was still reaching the
    // machine, and it gives way to the harness's here: an id does move under a client inside that window, which is
    // safe only because every client keys a thread by its threadId, through foldThreads and through the wait alike.
    if (view.id === "" || view.id === turnId) view.id = handleId;
    const rowId = view.id;
    // A resumed turn takes over the row of the turn it resumes; the row keeps saying who opened the thread and
    // with what, since every client titles the thread by the row's prompt. Later turns live in the transcript.
    const resumed = t.resume !== undefined ? sessions.get(handleId)?.view : undefined;
    if (resumed !== undefined) {
      view.startedBy = resumed.startedBy ?? view.startedBy;
      if (resumed.prompt !== undefined) view.prompt = resumed.prompt;
      // What the row cost is every turn that ran on it, so the earlier turns' figure carries into the row this one
      // takes over; a listing reads the row, not the transcript.
      if (resumed.costUsd !== undefined) view.costUsd = resumed.costUsd;
    }

    /** A pick made while this turn runs, taken by the harness: the row carries the mode the turn is now at. */
    const setAccess = async (mode: string): Promise<"set" | "refused" | "gone"> => {
      const outcome = await started.setAccess!(mode);
      if (outcome === "set") view.permissionMode = mode;
      return outcome;
    };

    const handle: SessionHandle = {
      id: rowId,
      workspaceId,
      finished: started.finished,
      turnId,
      outcome,
      view: () => ({ ...view }),
      interrupt: () => started.interrupt(),
      ...(started.steer !== undefined ? { steer: (prompt: string) => started.steer!(prompt) } : {}),
      ...(started.answer !== undefined ? { answer } : {}),
      ...(started.setAccess !== undefined ? { setAccess } : {}),
    };
    const end = (reason: string): void => {
      if (ended || view.status !== "running") return;
      // Before `ended` shuts the forward road: the interrupt below reaches the harness, whose own close would then
      // be dropped, so the rows and the waits are ended here.
      closeOpenAsks();
      ended = true;
      settleCut({ view, turnId, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}), turnLive }, reason, () => reason);
      void persistSessions(workspaceId);
      void started.interrupt().catch(() => {});
    };
    // One row per turn, never two: the key the start road held this turn under goes as the harness's own takes over.
    if (turnId !== rowId) sessions.delete(turnId);
    sessions.set(rowId, { view, turnId, calls, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}), ...(turnToken !== undefined ? { turnToken } : {}), ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}), handle, end, turnLive, ...(started.run !== undefined ? { run: started.run } : {}), ...(started.pid !== undefined ? { pid: started.pid } : {}) });
    void persistSessions(workspaceId);
    /** The turn's process is over: its status settles, its token stops naming anything, and the harness's own title
     * for the session is read again, since it writes one as the turn settles. */
    const settled = (status: TurnStatus): void => {
      const row = sessions.get(rowId);
      if (row !== undefined && row.turnToken === turnToken) delete row.turnToken;
      // The process is gone, so the token in its environment names nothing that can be asked for anything: it is
      // taken away here, the one exit both the reply road and the failure road reach.
      if (scopeDeviceId !== undefined) {
        void deviceDoor.revoke(scopeDeviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (!ended) view.status = status;
      view.endedAt ??= Date.now();
      // A pick this turn did not take landed on the thread's record alone; the row says it from here on, since
      // every client folds the thread's access off the row and the next turn runs at the record's.
      const kept = threadRecords.get(threadId)?.permissionMode;
      if (kept !== undefined) view.permissionMode = kept;
      // The turn is over: its own calls follow nobody now, and nobody waiting behind it is waiting any more.
      calls.clear();
      leadAsks.delete(threadId);
      void persistSessions(workspaceId);
      // Only a turn that ended on its own: a turn this host ended is one whose workspace is going away under it,
      // and the harness's own store for it goes with the machine, so the read would reach a machine that is being
      // taken down and say so in the log for every thread on it.
      if (!ended) void refreshTitle(view, true);
      if (t.imagesDir !== undefined) dropImages(entry, t.imagesDir);
    };
    // The reload a client runs on session.end shares that read rather than starting a second.
    started.finished.then(
      result => settled(result.status),
      () => settled("failed"),
    );
    return handle;
  };

  /** Every harness run on one workspace's machine that this host does not hold, ended. Read after the rows are in
   * and every one that could be re-opened has been, so what is left is a run no thread here will ever read: the host
   * that launched it went down under it, or its own row could not be re-opened and was settled. The runs this host
   * holds are named to the machine rather than found there, so a turn this host is reading is never ended by its own
   * sweep. Best effort: a machine that will not answer keeps its runs, and the next connect asks again. */
  const sweepRuns = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running") return;
    // Nothing can be asked about a machine held by a stand-in, so nothing is: a computer that is away and a host
    // started without its provider key both leave the runs where they are rather than saying so at every start.
    if (isHeldAway(entry.record.id)) return;
    const sweep = execFactoryFor(entry).sweep;
    if (sweep === undefined) return;
    const held: string[] = [];
    for (const s of sessions.values()) {
      if (s.view.workspaceId === entry.record.id && s.view.status === "running" && s.run !== undefined) held.push(s.run);
    }
    const swept = await sweep(held).catch((e: unknown) => {
      console.warn(`the runs on ${entry.record.id} were left as they are: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
    if (swept.length > 0) console.warn(sweptRunsLogLine(entry.record.id, swept));
  };

  /** What re-opening a turn the store left running came to. `attached` is a reader on the run again and the thread
   * goes on; `gone` is the machine's own answer that it no longer holds the run, the one answer that ends the turn;
   * `unreached` is a machine that said nothing for the whole reach window, which says nothing about the run, so the
   * row is left running for the poll that watches machines to settle if the machine really is away; `cannot` is a
   * run this host has no road to at all, and the row reads as a turn the restart cut. */
  type Reopened = "attached" | "gone" | "unreached" | "cannot";

  /** A turn the store left running, re-opened where it runs. The machine still holds the run and its whole output,
   * so the events this host missed reach it as the run's own lines and the thread goes on running to its reply.
   * `cannot` covers a row with no run recorded (a host from before this road, or a harness whose runs die with it),
   * no workspace or no machine running under it, no adapter for its harness in this process, and a handle that is
   * not one this host could have launched. */
  const reattach = async (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; turnToken?: string; scopeDeviceId?: string }): Promise<Reopened> => {
    const { view, run } = s;
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (run === undefined || threadId === undefined || entry === undefined || entry.record.phase !== "running") return "cannot";
    const cannot = (words: string): "cannot" => {
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} cannot be re-opened: ${words}`);
      return "cannot";
    };
    let adapter: HarnessAdapter;
    // As on the start road: the re-opened stream reads this while the turn it attached to is stopped on a question.
    const waiting = { on: false };
    try {
      adapter = adapterFor(entry, view.harness, undefined, () => waiting.on).adapter;
    } catch (e: unknown) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    const open = adapter.attach?.bind(adapter);
    if (open === undefined) return "cannot";
    // The harness may start reading the run the moment it is opened, which is before the row that records those
    // lines exists, so what arrives first is held and handed to the row's own forward in order once it does.
    const held: AdapterEvent[] = [];
    let sink: ((event: AdapterEvent) => void) | undefined;
    let opened: HarnessSession | "gone";
    try {
      opened = await open({
        run,
        sessionId: view.claudeSessionId ?? view.id,
        startedAt: view.startedAt ?? Date.now(),
        ...(view.model !== undefined ? { model: view.model } : {}),
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
        onEvent: event => (sink === undefined ? void held.push(event) : sink(event)),
      });
    } catch (e: unknown) {
      // Nothing answered about the run, so nothing is known about it: the turn is left exactly as it was.
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} was left running: ${e instanceof Error ? e.message : String(e)}`);
      return "unreached";
    }
    if (opened === "gone") return "gone";
    try {
      runTurn({
        entry,
        view,
        threadId,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.notifyBy !== undefined ? { notifyBy: s.notifyBy } : {}),
        ...(s.notifyRoad !== undefined ? { notifyRoad: s.notifyRoad } : {}),
        // The token this turn was launched with is still in the process this attach reached, so the row that answers
        // for it takes it back; a token this host had never minted would be one nobody can answer for.
        ...(s.turnToken !== undefined ? { turnToken: s.turnToken } : {}),
        // The device that turn was launched with is still in the process this attach reached, so the row that
        // answers for it takes it back and its exit is what hands it over.
        ...(s.scopeDeviceId !== undefined ? { scopeDeviceId: s.scopeDeviceId } : {}),
        ...(s.turnLive !== undefined ? { turnLive: s.turnLive } : {}),
        outcome: "started",
        waiting,
        opening: { prompt: view.prompt ?? "" },
        open: forward => {
          sink = forward;
          for (const event of held.splice(0)) forward(event);
          return opened as HarnessSession;
        },
      });
    } catch (e: unknown) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    return "attached";
  };

  const sessionsApi: Runtime["sessions"] = {
    async start(workspaceId, opened, origin) {
      await ready();
      // The thread this start lands in is read before the workspace is: a send into a thread of the caller's tree
      // reaches it on whatever workspace it runs, and only a start that opens a thread is a workspace act.
      const named = opened.thread === undefined ? undefined : latestOn(opened.thread);
      if (opened.thread !== undefined && named?.workspaceId !== workspaceId) throw new Error(`no thread ${opened.thread} on this workspace`);
      // Read again where the thread becomes this send's to run: the id it must resume may not exist yet. A send that
      // names a thread resumes that thread's own session, so a session named beside the thread is checked against
      // it below, once the caller is known to drive the thread, and never taken in its place.
      let resume = opened.thread !== undefined ? named?.claudeSessionId : opened.resume;
      const found = named?.threadId !== undefined ? { threadId: named.threadId, unstamped: false } : threadOf(workspaceId, resume);
      const threadId = found.threadId;
      // A message into a thread that already has turns is a send; anything else opens one, and only one of those
      // two is what a thread's own token is capped on. Read before the machine is asked for anything. The thread's
      // record answers before its rows, since the rows are capped and the record is not.
      const opens = !threadRecords.has(threadId) && rowsOn(threadId).length === 0;
      // A send goes into a thread the caller drives, read on the thread it lands in rather than on how it was
      // named, so a harness session id given as resume reaches no more than the thread id would. The sentence says
      // back what the caller said and never the thread behind it, since a refusal that named it would hand a
      // guest the thread id of every session id it tried.
      const reached = opens ? await entryOf(workspaceId, origin) : await entryOfRow({ threadId, workspaceId }, origin);
      if (reached === undefined) throw new Error(`no thread ${opened.thread ?? resume} on this workspace`);
      const entry = reached;
      if (found.unstamped) stampLegacy(workspaceId, threadId);
      if (opened.thread !== undefined && opened.resume !== undefined && threadHolding(workspaceId, opened.resume) !== threadId) throw new Error(resumeNotOfThreadLine(opened.resume, opened.thread));
      // What a thread already carries decides two of this send's picks, and it is read after the reading above, so
      // a caller that cannot drive the thread learns nothing about it. A thread keeps its agent: the turn runs on
      // the harness its record names, and a request naming another is refused rather than resuming that thread's
      // harness session under an agent that never wrote it. Its access is its own the same way, so a mode named on
      // a send is dropped and sessions.access is the one road that changes what a thread may touch; the access the
      // thread runs at is then read off its record below, as a send that named none has always read it.
      const carried: Pick<ThreadRecord, "harness"> | undefined = opens ? undefined : (threadRecords.get(threadId) ?? latestOn(threadId));
      if (carried !== undefined && opened.harness !== undefined && opened.harness !== carried.harness) throw new Error(threadRunsOnLine(carried.harness, opened.harness));
      // A start that names no agent runs the one the last thread on this project used, so the command line, the
      // composer and a tool all open the next thread on the agent the work is being done with. A remembered agent
      // this host has no adapter for drops through to the default, as a remembered access pick does: the memory is
      // the project's and the adapters are this host's.
      const heldProject = projectHeld(entry.record.project);
      const remembered = heldProject.lastAgent !== undefined && adapters[heldProject.lastAgent] !== undefined ? heldProject.lastAgent : undefined;
      const o = { ...opened, ...(carried !== undefined ? { harness: carried.harness } : opened.harness === undefined && remembered !== undefined ? { harness: remembered } : {}) };
      if (carried !== undefined) delete o.permissionMode;
      if (opened.thread !== undefined) delete o.resume;
      const refuse = (): void => {
        const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
        if (refusal !== null) throw new Error(refusal);
      };
      refuse();
      // A blocked computer refuses a new turn but never a message joining one still running there, so a busy thread asks once it frees.
      let cleared = !threadRuns(threadId);
      if (cleared) await copyBlocked(entry);
      const title = o.title === undefined ? undefined : titleLine(o.title);
      if (title === "") throw new Error(EMPTY_TITLE_LINE);
      spawnGuard(opens ? "thread_new" : "send", origin);
      // The tree this thread sits in, written on its first row and read off it by every later turn: a thread a
      // person opened is its own root, and one a thread opened hangs under that thread's root.
      const spawnedBy = opens ? scopeOf(origin) : undefined;
      const tree = opens
        ? treeOf(spawnedBy)
        : { ...(parentOf(threadId) !== undefined ? { parentThreadId: parentOf(threadId)! } : {}), ...(rootOf(threadId) !== threadId ? { rootThreadId: rootOf(threadId) } : {}) };
      // me is the caller: the thread this request came out of when its token says it came out of one, and the person
      // when there is no token, which is every road that is not a turn. A target named twice is one target, since a
      // list says who is told and not how often.
      const asked =
        o.notify === undefined
          ? undefined
          : [...new Set(o.notify.map(target => (target === NOTIFY_ME && o.turnToken !== undefined ? threadOfToken(o.turnToken) : target)))];
      // The threads a start may name as targets: the ones the caller drives, every thread of its own tree, so a
      // notify reaches no thread a send could not and the line it delivers is one the caller could have sent by
      // hand. A thread of another tree reads as no thread at all, so a guest cannot tell a foreign thread from
      // none. The one crossing this keeps is the shim's own `--notify me`, which is the caller itself.
      for (const target of asked ?? []) {
        if (target === NOTIFY_ME) continue;
        const on = latestOn(target);
        if (on === undefined || !reachesRow(on, origin)) throw new Error(`no thread ${target} to notify`);
        if (target === threadId) throw new Error("a thread cannot notify itself");
        // Each end would start the next turn on the other thread with no one sending anything, so the chain is
        // walked whole; it is a lead and its builders, so it is short.
        if (notifyReach(notifyOn(target)?.notify ?? []).has(threadId)) {
          throw new Error(`thread ${target.slice(0, 8)} already notifies this thread; a cycle would run forever`);
        }
      }
      const registered = notifyOn(threadId);
      const notify = asked ?? registered?.notify;
      // Who named these targets, kept beside them: a start out of a thread carries that thread's scope, so the line
      // its end delivers starts the target's turn under it; one the person made carries none and goes as theirs. A
      // send into a thread takes what the thread's opener registered, this beside the targets themselves.
      const notifyBy = asked === undefined ? registered?.by : scopeOf(origin);
      // And the road they were named from, beside the thread: the line's own start reads the same rules the
      // registration did, so a road that may not start a process on the target's workspace does not get one
      // started for it a turn later.
      const notifyRoad = asked === undefined ? registered?.road : roadOf(origin);
      const turnToken = randomBytes(16).toString("hex");
      // The token this turn's own agent drives this host with, and the address it dials: a device of this host's,
      // scoped to this thread and taken away when the turn's process exits, so a token read out of a machine after
      // the turn opens nothing. Minted only where the person turned the switch on and only where this host knows an
      // address the turn can reach it at, since a token with nowhere to go is one more secret for nothing.
      const reach = agentsReach(entry);
      const scoped =
        agentsOf(entry.record)?.spawn === true && reach !== undefined
          ? await deviceDoor.mint(`thread ${threadWord(threadId)}`, { kind: "thread", threadId, workspaceId, rootThreadId: tree.rootThreadId ?? threadId }, Date.now(), moduleOf(entry.record.kind).turnRoad)
          : undefined;
      const dropScope = (): void => {
        if (scoped !== undefined) void deviceDoor.revoke(scoped.deviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      };
      // The one refusal left that comes after the mint, since the launch environment is what it is given: a harness
      // this host has no adapter for hands the token back rather than leaving it standing until a restart.
      let built: { harness: string; adapter: HarnessAdapter };
      // Flipped while a permission prompt of this turn stands open: the stream the adapter is about to launch reads
      // it, and the row the turn opens writes it, so a turn stopped on a question is not read as a quiet one.
      const waiting = { on: false };
      try {
        built = adapterFor(
          entry,
          o.harness,
          {
            [TURN_TOKEN_ENV]: turnToken,
            // The key beside the address and the token: the turn's own wsp pins it before it sends the token, so
            // a relay carrying the bytes reads nothing and a directory answer naming another host is refused.
            ...(scoped !== undefined && reach !== undefined
              ? { [HOST_URL_ENV]: reach.url, [HOST_TOKEN_ENV]: scoped.deviceToken, ...(placeDoor === undefined ? {} : { [HOST_KEY_ENV]: placeDoor.hostKey() }) }
              : {}),
          },
          () => waiting.on,
          // A name no catalog row declares is one an MCP server's definition reads, which only the environment carries.
          serverValuesOf(opts.vault?.() ?? {}),
        );
      } catch (e) {
        dropScope();
        throw e;
      }
      const { harness, adapter } = built;
      // The wsp tools ride the launch on a workspace whose agents may spawn, for a harness that takes servers with
      // one: the guest's own config is the golden's and says nothing about this host. A harness that takes none is
      // refused where a caller named servers and left alone here, since the person asked for a thread, not for tools.
      const mcpServers =
        scoped !== undefined && reach?.wsp !== undefined && adapter.mcpServers === true
          ? { [MCP_SERVER_NAME]: reach.wsp, ...o.mcpServers }
          : o.mcpServers;
      const records = (o.attachments ?? []).map(imageRecord);
      const blocked = imagesBlocked(records, adapter.attachments, harness) ?? mcpServersBlocked(o.mcpServers, adapter.mcpServers, harness);
      if (blocked !== null) {
        dropScope();
        throw new Error(blocked);
      }
      const turnId = randomUUID();
      // The thread's row is written here, before anything is asked of the machine: the harness's own lists, the
      // folder and the images all sit between this line and the launch, and they are seconds. A thread no row holds
      // is a thread nothing can be waited on, so a wait fired the moment after a detached start would find nothing
      // to wait for. Only where the thread has none of its own: a thread whose turn is running already has the row
      // a wait waits on, and a second would be the one every client folds the thread's state, folder and times off
      // while it holds none of them. So a send that finds the thread taken holds nothing until the thread is free,
      // and holds its row from then to the launch. The row carries what is known now; the picks and the folder land
      // on it below, and the harness's own facts as the turn answers.
      const view: SessionView = {
        id: turnId,
        workspaceId,
        harness,
        status: "running",
        startedBy: o.startedBy ?? "person",
        threadId,
        ...tree,
        prompt: o.prompt,
        startedAt: Date.now(),
        ...(title !== undefined ? { harnessTitle: title, titleSource: "person" as const } : carriedTitle(threadId)),
        ...(resume !== undefined ? { claudeSessionId: resume } : {}),
        ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
      };
      let launched!: () => void;
      const launch = new Promise<void>(r => (launched = r));
      let held = false;
      const hold = (): void => {
        if (held || threadRuns(threadId)) return;
        // The thread is this send's to run, and the session it resumes is the one the thread's latest turn ran as:
        // a send that arrived while that turn was still launching read none, since the harness names its session
        // only after it is up.
        resume = o.resume ?? latestOn(threadId)?.claudeSessionId ?? resume;
        held = true;
        // The row that says the thread is spoken for also says who its turns tell: a send into the thread reads the
        // opener's notify off its rows, and inside the launch window this is the only one.
        sessions.set(turnId, { view, turnId, launch, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}) });
      };
      hold();
      let outcome: SessionStartOutcome = "started";
      let images: TurnImage[] = [];
      let imagesDir: string | undefined;
      let landed = (o.attachments?.length ?? 0) === 0;
      // This send's own folder on the machine, named by the request id it minted: the landing runs before any turn is
      // registered, so two sends arriving together both pass the wait, and a folder they shared would leave the first
      // turn holding the second's picture.
      const sendDir = turnImagesDir(threadId, o.requestId, randomUUID());
      // Every road out of the window between the row above and runTurn is in here, since the row that says this
      // thread is working and the images this send put on the machine both belong to a turn that does not exist on
      // any of them: a refusal after a trip, a start that never opened. A steer leaves by returning and holds
      // neither: a send steers only a turn that was running when it looked, before it held the thread or landed a
      // thing.
      let handedOver = false;
      let failure: string | undefined;
      try {
        const table = harnessCatalog(harness);
        // Checked against the binary's own lists, the ones the composer shows for this workspace.
        const catalog = table === undefined ? undefined : await catalogOn(table, entry, adapter);
        // A remembered access, the thread's own then the workspace's, read against the list in front of us: this send
        // may be on a harness whose modes are not the ones that pick belongs to, and a mode this one does not take is
        // a pick that does not apply here, not a send to refuse. An access this send NAMED is still refused, by
        // startPicks, in the same words.
        const picked = o.permissionMode === undefined && catalog !== undefined ? await pickedAccess(workspaceId) : undefined;
        const picksFor = (session: string | undefined): StartPicks => {
          const access = o.permissionMode ?? (catalog === undefined ? undefined : listedPick(catalog.permissionModes, accessOf(workspaceId, threadId, session) ?? picked));
          return startPicks(catalog, { ...o, permissionMode: access }, session === undefined);
        };
        // A pick the lists do not carry is refused here, before this send waits on anything; the picks themselves
        // are decided below the loop, against the session this send turns out to resume.
        picksFor(resume);
        const folder = await threadFolder(entry, o);
        // Two processes on one harness session corrupt its transcript, so a thread runs one turn at a time. Nothing
        // below this loop may await: the wait ends the moment no turn is running, and every line from there to
        // runTurn, which registers this one, is one synchronous run. The images land inside it for that reason, once
        // the thread is this send's, and the workspace is checked again after them, since landing them is a trip to
        // the machine and the row this send holds keeps every other send behind it meanwhile. Sends are taken as they
        // reach this loop, which is the order their trips finish and not always the order they arrived.
        for (;;) {
          const running = runningOn(threadId);
          if (running === undefined) {
            // A turn of this thread another send is still carrying to the machine has no harness to steer or to wait
            // out yet, so this one waits for the moment it has one or is given up, and looks again.
            const launching = launchingOn(threadId);
            if (launching !== undefined && launching.turnId !== turnId) {
              if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
              outcome = "queued";
              await launching.launch;
              refuse();
              cleared = false;
              continue;
            }
            if (!cleared) {
              cleared = true;
              await copyBlocked(entry);
              continue;
            }
            hold();
            if (landed) break;
            landed = true;
            ({ images, dir: imagesDir } = await landImages(entry, adapter.attachments, sendDir, o.attachments ?? []));
            refuse();
            continue;
          }
          // A turn that has already answered takes no message, however well its harness steers: the words would
          // land after the reply the caller read. The send waits for that process to exit and runs as the thread's
          // next turn; nothing here is ever refused for being in the way.
          const steer = running.turnLive?.reply === undefined && adapter.steers ? running.handle.steer : undefined;
          if (steer !== undefined && (await steer(o.prompt)) === "accepted") {
            recordSteer(running, running.handle.id, o);
            return { ...running.handle, outcome: "steered" };
          }
          if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
          outcome = "queued";
          await running.handle.finished.catch(() => {});
          refuse();
          cleared = false;
        }
        const picks = picksFor(resume);
        const cwd = (resume !== undefined ? folderOf(workspaceId, resume) : undefined) ?? folder;
        const afterCut = resume !== undefined && cutBefore(workspaceId, threadId);
        // What the trips above settled, onto the row the start wrote: the reads that decide them are behind us, so
        // none of them can be answered from the row they are about. Written before adapter.start, so events that
        // fire synchronously inside start() land on the same view.
        Object.assign(view, picks, cwd !== undefined ? { cwd } : {}, resume !== undefined ? { claudeSessionId: resume } : {});
        const handle = runTurn({
          entry,
          view,
          threadId,
          turnId,
          ...(notify !== undefined ? { notify } : {}),
          ...(notifyBy !== undefined ? { notifyBy } : {}),
          ...(notifyRoad !== undefined ? { notifyRoad } : {}),
          turnToken,
          outcome,
          ...(scoped !== undefined ? { scopeDeviceId: scoped.deviceId } : {}),
          opening: { prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}), ...(afterCut ? { afterCut } : {}), ...(title !== undefined ? { title } : {}), ...(records.length > 0 ? { attachments: records } : {}) },
          ...(imagesDir !== undefined ? { imagesDir } : {}),
          ...(resume !== undefined ? { resume } : {}),
          waiting,
          open: onEvent =>
            adapter.start({
              prompt: o.prompt,
              ...(resume !== undefined ? { resume } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...picks,
              ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...(mcpServers !== undefined ? { mcpServers } : {}),
              onEvent,
            }),
        });
        handedOver = true;
        // The thread's record, written at its first turn from what that turn runs at, once the turn is under way so a
        // launch that never opened leaves none; a thread from before the record existed gets one here too, off what
        // its rows said this turn runs at, so it is read the one way from now on. Persisted with the row as the turn
        // announces itself and at its end.
        if (!threadRecords.has(threadId)) threadRecords.set(threadId, { workspaceId, harness, ...(picks.permissionMode !== undefined ? { permissionMode: picks.permissionMode } : {}) });
        launched();
        // The turn is running; what the record failed to remember must not read as a start that failed.
        await rememberAgent(heldProject, harness).catch((e: unknown) => console.warn(`the agent for ${heldProject.name} was not remembered: ${e instanceof Error ? e.message : String(e)}`));
        if (resume === undefined) await rememberTarget(entry.record).catch((e: unknown) => console.warn(`last target for ${workspaceId} not remembered: ${e instanceof Error ? e.message : String(e)}`));
        return handle;
      } catch (e: unknown) {
        failure = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (!handedOver) {
          // The turn never reached a machine, so nothing out there is holding this token: it goes now rather than
          // standing until a host restart.
          dropScope();
          if (held) {
            sessions.delete(turnId);
            // Whoever the row told this thread was working must not be left waiting for a turn that never opened, so
            // its end goes out. On the bus alone and not through record: no turn ran, and a transcript that held an
            // end with no start behind it would be read as the thread's latest turn by every reader that folds those
            // rows, which is what the reply, the read and the wait itself all come off. Nothing goes out where the
            // road out named no reason, which is the message the thread's running turn took instead, nor where the
            // thread is still working: the turn that is running is the one a wait here is waiting on.
            if (failure !== undefined && !threadRuns(threadId)) {
              bus.emit({ type: "session.end", workspaceId, sessionId: view.id, turnId, threadId, exitCode: null, sawResult: false, reason: failure, at: Date.now() });
            }
          }
          // After the row is gone and its end is out, so a send that waited on it finds the thread as it now is.
          launched();
        }
        if (!handedOver && imagesDir !== undefined) dropImages(entry, imagesDir);
      }
    },

    async list(workspaceId, origin) {
      await ready();
      // A listing that names a workspace refuses like any other verb naming one, unless a thread of the caller's
      // tree stands there; a listing of them all leaves out the rows the caller may not reach, as workspaces.list
      // leaves out the workspaces.
      if (workspaceId !== undefined && !treeStandsOn(workspaceId, origin)) refuseNamed(workspaceId, origin);
      const all = [...sessions.values()].filter(s => reachesRow(s.view, origin));
      const held = workspaceId === undefined ? all : all.filter(s => s.view.workspaceId === workspaceId);
      const rows = held.map(s => s.view);
      // A refresh is where a rename made inside the harness reaches us: nothing on this side changed. A row that
      // already carries a title is answered from the index and its read goes out unawaited, so a wedged guest
      // costs the listing nothing and the rename lands on the next refresh, which is the window the TTL promises.
      // A row with none blocks, so a thread is titled on the first listing that sees it.
      const asked = titleRows(rows).map(view => ({ first: view.harnessTitle === undefined, done: refreshTitle(view, false) }));
      await Promise.all(asked.filter(a => a.first).map(a => a.done));
      // The turn's process and what its calls are stopped behind ride the answer and never the row itself: both are
      // this host's to know while the turn runs, and a pid written down outlives the process it named while a wait
      // written down outlives the question it was on.
      return held.map(s => {
        const behind = s.view.status === "running" ? stoppedBehind(s) : undefined;
        return {
          ...s.view,
          ...(s.view.status === "running" && s.pid !== undefined ? { pid: s.pid } : {}),
          ...(behind !== undefined ? { waitingOn: behind } : {}),
        };
      });
    },

    async history(workspaceId, origin) {
      await ready();
      // A thread reads the transcript of a workspace its tree stands on, its lead's included, and of its own tree's
      // workspaces; any other it names reads as every workspace verb reads it, so it learns nothing by asking.
      if (!treeStandsOn(workspaceId, origin)) await entryOf(workspaceId, origin);
      return (transcripts.get(workspaceId) ?? []).filter(e => drivesThread(e.threadId, origin)).map(e => ({ ...e }));
    },

    async interrupt(sessionId, origin) {
      await ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      // One absence for every row a thread cannot reach, wherever it stands: a sentence about the workspace would
      // tell a thread which of the two rules hid the row.
      if ((await entryOfRow(s.view, origin)) === undefined) return { outcome: "not-found" };
      // A thread's agents spawned a tree under it, and a stop on the thread is a stop on the tree: the children go
      // first, so nothing under a stopped lead is left working for a thread that is no longer reading. The lead
      // itself may already be over, which is an answer and not a reason to leave its builders running. A child
      // that stops its lead stops its siblings and itself with it, and may never read the answer.
      const under = s.view.threadId === undefined ? [] : await stopUnder(s.view.threadId, origin);
      const answered = (outcome: SessionInterruptOutcome): SessionInterruptResult => ({ outcome, ...(under.length > 0 ? { under } : {}) });
      if (s.view.status !== "running" || s.handle === undefined) return answered("not-running");
      await s.handle.interrupt();
      // The harness resolves finished only after session.end, so accepted means the turn is over on the transcript too.
      await s.handle.finished.catch(() => {});
      return answered("accepted");
    },

    async steer(sessionId, o, origin) {
      await ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
      if (s.handle.steer === undefined) return { outcome: "unsupported" };
      const outcome = await s.handle.steer(o.prompt);
      if (outcome !== "accepted") return { outcome };
      recordSteer(s, sessionId, o);
      return { outcome: "accepted" };
    },

    async answer(sessionId, o, origin) {
      await ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      if (s.handle?.answer === undefined) return { outcome: s.handle === undefined ? "gone" : "unsupported" };
      return { outcome: await s.handle.answer(o.askId, { optionId: o.optionId }) };
    },

    async access(sessionId, permissionMode, origin) {
      await ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      const { harness, adapter } = adapterFor(entry, s.view.harness);
      const table = harnessCatalog(harness);
      // Checked against the list the picker showed, so a mode this CLI does not take is refused in the same words a
      // start refuses it with rather than travelling to the machine as a request it will not answer.
      if (table !== undefined) startPicks(await catalogOn(table, entry, adapter), { permissionMode }, false);
      // The pick lands on the thread's record whatever the turn running now does with it: this is the one road that
      // changes a thread's access, and the thread's next turn runs at it. The thread's latest row says the same, as
      // every client folds the access off that row; a running turn's row moves where the harness took the pick,
      // and otherwise as the turn ends, so no row says a mode the thread's next turn will not run at.
      const threadId = s.view.threadId;
      const running = threadId === undefined ? (s.view.status === "running" && s.handle !== undefined ? (s as LiveSession) : undefined) : runningOn(threadId);
      const latest = threadId === undefined ? s.view : (latestOn(threadId) ?? s.view);
      const landed = (): void => {
        if (threadId !== undefined) threadRecords.set(threadId, { ...(threadRecords.get(threadId) ?? { workspaceId: s.view.workspaceId, harness: s.view.harness }), permissionMode });
        if (latest.status !== "running") latest.permissionMode = permissionMode;
        void persistSessions(s.view.workspaceId);
      };
      if (latest.status !== "running") {
        landed();
        return { outcome: "set" };
      }
      // A CLI that refused a mode its own list carries is one that will not take it on a turn already under way and
      // whose adapter had no way to stand in for it, as is one that takes none at all: the turn keeps its mode and
      // the pick stands for the next turn, which is what unsupported tells the composer to say. A turn whose process
      // this host does not hold, still launching or re-opened without one, is one the pick cannot reach.
      const outcome = running === undefined ? "gone" : running.handle.setAccess === undefined ? "refused" : await running.handle.setAccess(permissionMode);
      landed();
      return { outcome: outcome === "set" ? "set" : outcome === "refused" ? "unsupported" : "not-running" };
    },

    async rename(sessionId, title, origin) {
      await ready();
      const named = title.trim();
      if (named === "") throw new Error(EMPTY_TITLE_LINE);
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const harnessSessionId = s.view.claudeSessionId;
      const entry = await entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "rename", entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      await copyBlocked(entry);
      const write = adapterFor(entry, s.view.harness).adapter.renameSession;
      if (write === undefined) return { outcome: "unsupported" };
      // The store is keyed by the harness's own id, so a thread whose harness never announced one has nothing to name.
      if (harnessSessionId === undefined) return { outcome: "no-session" };
      const wrote = await write(harnessSessionId, named, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout));
      // A store that refused the write says nothing about which sessions it has, so its own line travels as the answer.
      if (wrote.kind === "failed") return { outcome: "failed", error: wrote.error };
      if (wrote.kind === "no-session") return { outcome: "no-session" };
      // Every turn of the thread shares the harness's session, and the fold reads the latest turn's title. The name
      // is the person's, so a title the harness is still thinking about is thrown away when it lands.
      for (const row of sessions.values()) {
        if (row.view.workspaceId === entry.record.id && row.view.claudeSessionId === harnessSessionId) {
          row.view.harnessTitle = named;
          row.view.titleSource = "person";
        }
      }
      await persistSessions(entry.record.id);
      return { outcome: "renamed" };
    },

    async forget(threadId, origin) {
      await ready();
      const held = [...sessions].filter(([, s]) => s.view.threadId === threadId);
      const record = threadRecords.get(threadId);
      const workspaceId = held[0]?.[1].view.workspaceId ?? record?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // The same absence a name nothing holds gets: a sentence of its own would tell a thread of another tree that
      // the thread it named is there, and the refusal past this gate says its turn ran.
      if ((await entryOfRow({ threadId, workspaceId }, origin)) === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // A record is written once a turn was handed over, so a thread with a record and no row left is one whose
      // turns ran and fell off the index cap; the rows alone would read it as a thread that never ran.
      if (threadRan(held.map(([, s]) => s.view)) || (held.length === 0 && record !== undefined)) throw Object.assign(new Error(threadForgetRefusal(threadId)), { kind: "conflict" });
      for (const [id] of held) sessions.delete(id);
      threadRecords.delete(threadId);
      // Spliced rather than replaced: a turn of another thread on this workspace holds the array itself, and its
      // rows would go to a copy nothing reads.
      const events = transcripts.get(workspaceId) ?? [];
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.threadId === threadId) events.splice(i, 1);
      await persistSessions(workspaceId);
      await flushTranscript(workspaceId);
    },
  };

  const builderView = (r: BuilderRecord, b: LiveBuilder): GoldenBuilderView => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt,
    size: r.size,
    ...(r.streamUrl !== undefined ? { screen: { streamUrl: r.streamUrl } } : {}),
    sealable: b.sealable,
    ...(r.import !== undefined ? { recipeHash: r.import.recipeHash } : {}),
    ...(r.import?.recipe !== undefined ? { recipe: r.import.recipe } : {}),
    ...(b.life === "foreign" ? { foreignOwner: b.builder.machine.labels?.[OWNER_LABEL] ?? "" } : {}),
    ...(b.life === "held" && r.heldBy !== undefined ? { heldBy: r.heldBy } : {}),
    ...(r.building === true ? { building: true } : {}),
    ...(r.sealed !== undefined ? { sealed: r.sealed } : {}),
  });

  /** One timer per kept builder, so the grace ends on time inside a process; the sweep is the road across processes. */
  const graceTimers = new Map<string, () => void>();
  const armGrace = (id: string, sealedAt: string): void => {
    graceTimers.get(id)?.();
    const left = Math.max(0, GRACE_MS - (clock.now() - Date.parse(sealedAt)));
    graceTimers.set(id, clock.schedule(() => {
      graceTimers.delete(id);
      void expireGrace().catch((e: unknown) => console.warn(`grace sweep failed: ${e instanceof Error ? e.message : String(e)}`));
    }, left, { unref: true }));
  };
  /** True while a kept builder's window is still open by our clock. */
  const inWindow = (sealedAt: string): boolean => {
    const ageMs = clock.now() - Date.parse(sealedAt);
    return !Number.isNaN(ageMs) && ageMs < GRACE_MS;
  };
  let expiring: Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> | undefined;
  /** Stops every kept builder whose window is over, each on its own: a kill that fails is reported and the record
   * kept for the next sweep. A builder another process holds is that process's to stop. One pass at a time: two
   * timers falling due together, or a timer beside a sweep, must not both kill and forget the same builder. */
  const expireGrace = (): Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> => (expiring ??= expireGraceNow().finally(() => (expiring = undefined)));
  const expireGraceNow = async (): Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> => {
    await refreshBuilders();
    const reaped: ReapedMachine[] = [];
    const failed: ReapFailure[] = [];
    for (const b of [...builders.values()]) {
      if (b.record.sealed === undefined || !(b.life === "own" || b.life === "reusable") || inWindow(b.record.sealed.at)) continue;
      try {
        await gone.stop(backend, b.builder.machine);
      } catch (e) {
        failed.push({ id: b.record.id, message: `could not stop: ${e instanceof Error ? e.message : String(e)}; stays recorded, retried next sweep` });
        continue;
      }
      graceTimers.get(b.record.id)?.();
      graceTimers.delete(b.record.id);
      await forgetBuilder(b.record.id);
      reaped.push({ id: b.record.id, builder: true, reason: "grace", ageMs: clock.now() - Date.parse(b.record.sealed.at) });
    }
    return { reaped, failed };
  };

  /** Marks the record as this process's, now; the sweep and the heartbeat timer refresh it and close() clears it. */
  let beat: (() => void) | undefined;
  let closed = false;
  let ticking: Promise<void> | undefined;
  const arm = (): void => {
    if (closed || beat !== undefined) return;
    beat = clock.schedule(
      () => {
        beat = undefined;
        ticking = tick();
      },
      HEARTBEAT_MS,
      { unref: true },
    );
  };
  // One failed write costs one beat, never the timer: the hold is what keeps other processes off the builder.
  const tick = async (): Promise<void> => {
    const own = [...builders.values()].filter(x => x.life === "own");
    for (const b of own) {
      await hold(b).catch((e: unknown) => console.warn(`heartbeat for builder ${b.record.id} not written: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (own.length > 0) arm();
  };
  // The record is written whatever the runtime's state, so a prepare that finishes after close() leaves a finished
  // record and not a placeholder; the hold stamp and its timer are this process's and stop with it. A caller that
  // closes while a prepare still runs leaves the placeholder unheld until its stages finish; none does today.
  const hold = async (b: LiveBuilder): Promise<void> => {
    // A record forgotten while a heartbeat was in flight must not come back: the write is skipped for a builder no longer live.
    if (builders.get(b.record.id) !== b) return;
    if (!closed) b.record.heldBy = { host: hostId, pid: process.pid, heartbeat: new Date().toISOString() };
    await store.put(BUILDERS, b.record.id, b.record);
    if (!closed) arm();
  };

  /** A record wearing another state file's label, or held by another live process, is listed and nothing else;
   * acting on it by id would touch a machine that is not this process's to touch. */
  const refuseUntouchable = (entry: LiveBuilder): void => {
    if (entry.life === "foreign") throw new Error(`${entry.record.id} wears another setup's owner label (${entry.builder.machine.labels?.[OWNER_LABEL]}); it is never sealed or reached from here`);
    if (entry.life === "held") throw new Error(`${entry.record.id} is in use by another wsp process (pid ${entry.record.heldBy?.pid}); it is never sealed or reached from here`);
    if (entry.record.building) throw new Error(`${entry.record.id} is still being prepared; it is never sealed or reached until its stages finish`);
  };

  const forgetBuilder = async (id: string): Promise<void> => {
    builders.delete(id);
    await store.delete(BUILDERS, id);
  };

  /** What a stopped build does with the record of the machine its rollback tried to take: only a machine the provider
   * answers gone for GONE_READS reads in a row loses its record. One that outlived the kill, or one the provider
   * could not be asked about, keeps it, since a machine still running that nothing points at bills until somebody
   * lists the account by hand; a kept record is what the next build attaches to and what the doctor sweeps. */
  const forgetIfGone = async (entry: LiveBuilder, at: MachineBackend): Promise<void> => {
    const gone = await readGone(at, entry.record.id).then(
      state => state === "gone",
      () => false,
    );
    if (gone) await forgetBuilder(entry.record.id);
  };

  /** The listener one build's stages ride out on. `on` is the computer the build runs on, which is what a gap in a
   * link is matched against; `named` is whether the frames carry it, since only a copy's build is a thing that
   * computer's row reports. */
  const stageOf =
    (name: string, on?: string, named = false) =>
    (stage: GoldenStage, detail?: string, step?: GoldenStep, left?: readonly string[]) => {
      const place = named ? on : undefined;
      const frame: StageFrame = { name, stage, ...(detail !== undefined ? { detail } : {}), ...(step !== undefined ? { step } : {}), ...(left !== undefined && left.length > 0 ? { left: [...left] } : {}) };
      // The three words a build's stages end on; past one of them nothing of this build is asking that computer
      // anything, so a gap in its link is no longer this build's to report.
      if (on !== undefined) {
        if (stage === "ready" || stage === "sealed" || stage === "failed") stageAt.delete(copyKey(on, name));
        else stageAt.set(copyKey(on, name), { place: on, name, named, frame });
      }
      bus.emit({ ...frame, type: "golden.stage", ...(place !== undefined ? { place } : {}) });
    };
  /** The backend a place id resolves to: a provider row, or a joined computer whose backend this host has heard. */
  const backendAt = (place: string): MachineBackend => {
    const at = places.backend(place) ?? placeDoor?.backendOf(place);
    if (at === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(place, places.list())), { kind: "missing" });
    return at;
  };
  /** The place a word names, as the golden roads key it: a provider's id, or the id a joined computer's copies are
   * filed under, with the backend a builder there is made on. A joined computer's backend is asked of the computer
   * the first time and read off its record after. This computer is never built into, so its own name is refused
   * rather than read as the provider this host forks on, which a fork's road reads it as. */
  const placeAt = async (word: string): Promise<{ place: string; at: MachineBackend }> => {
    const own = places.backend(word);
    if (own !== undefined) return { place: word, at: own };
    if (placeDoor === undefined) return { place: word, at: backendAt(word) };
    let placeId: string | undefined;
    try {
      ({ placeId } = await placeDoor.placeFor(word));
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { kind: "missing" });
    }
    if (placeId === undefined) throw conflict(placeBuildsNoImageLine(word));
    return { place: placeId, at: await placeDoor.forkingBackend(placeId) };
  };
  /** The backend a fork lands on, gated before any machine is asked for: a joined computer that forks nowhere refuses
   * with its doctor's reason, and a place that forks nothing refuses with NO_PROVIDER_LINE when no place here runs
   * workspaces, else naming the places that do, so nobody is sent to a provider they do not need. */
  const landingBackend = async (placeId: string | undefined): Promise<MachineBackend> => {
    // The first fork on a joined computer is where this host learns what that computer forks with; every road after
    // it reads the answer off the place's record.
    if (placeId !== undefined) await placeDoorOf().forkingBackend(placeId);
    const at = backendOfKind("cloud", placeId);
    if (!forksNoMachines(at.capabilities)) return at;
    const running = (await buildPlaces()).map(r => r.name);
    throw conflict(running.length === 0 ? NO_PROVIDER_LINE : placeForksNothingPickLine(placeName(placeId ?? places.wired), running));
  };
  const placeName = (place: string): string => placeDoor?.nameOf(place) ?? place;
  /** Where the image's own seal stands: the place the record names, or the provider this host forks on for a record
   * sealed before places. The manifest there is the one wsp init built and updates. */
  const imagePlace = async (name: string): Promise<string> => (await recordOf(name))?.place ?? places.wired;
  /** Every place an image can be built at: the provider rows that fork, and the joined computers whose daemon runs
   * workspaces, this computer left out since it is never forked into. */
  const buildPlaces = async (): Promise<{ place: string; name: string; backend: MachineBackend }[]> => {
    const rows: { place: string; name: string; backend: MachineBackend }[] = [];
    for (const id of places.list()) {
      const at = places.backend(id);
      if (at !== undefined && !forksNoMachines(at.capabilities)) rows.push({ place: id, name: id, backend: at });
    }
    if (placeDoor === undefined) return rows;
    for (const view of await placeDoor.list(clock.now())) {
      if (!isJoinedComputer(view)) continue;
      const at = await placeDoor.forkingBackend(view.id).catch(() => undefined);
      if (at !== undefined) rows.push({ place: view.id, name: view.name, backend: at });
    }
    return rows;
  };

  /** How a copy of the image is planned off the record. The runtime writes no recipe of its own, so a host that
   * wired none builds no copy anywhere, and every road that needs one says so in the one sentence. */
  const copyRecipeOrThrow = (): ((image: SealedImage) => Promise<GoldenRecipe> | GoldenRecipe) => {
    const compose = opts.copyRecipe;
    if (compose === undefined) throw new Error(NO_COPY_RECIPE);
    return compose;
  };

  /** The recipe a golden road builds from: the one the call names, else the one the runtime was wired with. A host
   * serving the app names it per call, since the init job's recipe is answered while the runtime already serves. */
  const recipeOrThrow = (named?: GoldenRecipe): GoldenRecipe => {
    const recipe = named ?? opts.goldenRecipe;
    if (!recipe) throw new Error("this runtime has no golden recipe; the host wires one (setup + smoke) before the wizard can run");
    return recipe;
  };

  const builderLabels = (extra: Record<string, string> | undefined): Record<string, string> => ({ ...extra, [WSP_LABEL]: "1", [BUILDER_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString() });

  /** The hold begins the moment the machine exists: a held placeholder is on the store before any stage runs, so
   * another process over it (a second host, wspx) never reads this machine as lost. */
  const recordingCreates = (
    b: MachineBackend,
    name: string,
    imp: Pick<GoldenImport, "recipeHash" | "recipe"> | undefined,
    made: (placeholder: LiveBuilder) => void,
    stop: { signal: AbortSignal | undefined; began: (creating: Promise<Machine>) => void } | undefined,
    place: string,
  ): MachineBackend => ({
    ...b,
    create: spec => {
      if (stop?.signal?.aborted) return Promise.reject(new PrepareStoppedError());
      // Handed out before the provider is called, so a stop that lands inside the call waits for the machine it returns.
      const creating = Promise.resolve().then(async () => {
        const machine = observed(await b.create(spec));
        const asked = { cpu: spec.cpu ?? backend.pricing.defaultSize.cpu, memMb: spec.memMb ?? backend.pricing.defaultSize.memMb };
        const record: BuilderRecord = {
          id: machine.id,
          name,
          kind: spec.kind,
          baseTemplate: spec.template ?? "",
          setupSha: "",
          // The keyed create restamps the label after this spec was built; the machine carries the stamp the provider got.
          createdAt: machine.labels?.[CREATED_AT_LABEL] ?? spec.labels?.[CREATED_AT_LABEL] ?? new Date().toISOString(),
          size: asked,
          firstLife: true,
          building: true,
          ...(machine.streamUrl !== undefined ? { streamUrl: machine.streamUrl } : {}),
          ...(imp !== undefined ? { import: { recipeHash: imp.recipeHash, ...(imp.recipe !== undefined ? { recipe: imp.recipe } : {}), applied: [], smoke: "true" } } : {}),
          place,
        };
        const placeholder: LiveBuilder = { record, builder: { machine, kind: spec.kind, baseTemplate: record.baseTemplate, setupSha: "", createdAt: record.createdAt, firstLife: true, size: asked }, sealable: true, life: "own" };
        builders.set(machine.id, placeholder);
        made(placeholder);
        await hold(placeholder);
        return machine;
      });
      stop?.began(creating);
      return creating;
    },
  });

  /** The finished builder replaces its placeholder on the record and stays this process's own. */
  const settleBuilder = async (name: string, builder: Builder, placeholder: LiveBuilder | undefined, place: string): Promise<LiveBuilder> => {
    const record: BuilderRecord = {
      id: builder.machine.id,
      name,
      kind: builder.kind,
      baseTemplate: builder.baseTemplate,
      setupSha: builder.setupSha,
      createdAt: placeholder?.record.createdAt ?? builder.createdAt,
      size: builder.size,
      firstLife: true,
      ...(builder.machine.streamUrl !== undefined ? { streamUrl: builder.machine.streamUrl } : {}),
      ...(builder.import !== undefined ? { import: builder.import } : {}),
      ...(builder.base !== undefined ? { base: builder.base } : {}),
      place,
    };
    const entry: LiveBuilder = placeholder ?? { record, builder, sealable: true, life: "own" };
    entry.record = record;
    entry.builder = builder;
    builders.set(record.id, entry);
    await hold(entry);
    return entry;
  };

  /** What the host owns after a seal. The image's own seal writes the record afresh, wherever it ran: the recipe hash
   * the builder carried, the small recipe it was planned from, the logins the seal stamped, the vault it took, their
   * one hash, and the place it stands at. A copy's seal moves nothing of the record; only the copy is recorded,
   * under the hash the record already has. Either way the version carries that hash, so a copy says for itself what
   * it was built from. */
  const recordSeal = async (place: string, name: string, entry: LiveBuilder, recipe: GoldenRecipe, result: SealResult, copy: SealedImage | undefined): Promise<SealResult> => {
    // A copy is stamped with the record it was composed from, never with the record as it stands now: a cut that
    // landed while the copy built leaves it stale, which is what makes the next build there happen.
    let hash = copy?.hash;
    if (copy === undefined) {
      const digest = entry.builder.import?.recipeHash ?? "";
      const vault: SealedVault | undefined =
        result.vault === undefined
          ? undefined
          : { sha256: result.vault.sha256, bytes: result.vault.tar.length, paths: result.vault.paths, held: result.vault.held, takenAt: result.version.createdAt };
      const pins = recipePins(entry.builder.import?.recipe ?? { ticks: [] }, id => catalogIdOfRow({ id }) ?? id);
      hash = imageHash(digest, vault?.sha256, pins);
      const image: SealedImage = {
        name,
        version: result.version.version,
        hash,
        recipeHash: digest,
        ...(recipe.source !== undefined ? { recipe: recipe.source } : {}),
        pins,
        logins: result.version.logins ?? [],
        sealedAt: result.version.createdAt,
        sealedFrom: hostId,
        ...(vault !== undefined ? { vault } : {}),
        ...(result.version.usedBytes !== undefined ? { usedBytes: result.version.usedBytes } : {}),
        place,
      };
      const replaced = (await store.get(IMAGES, name)) as SealedImage | undefined;
      if (result.vault !== undefined) await store.putBlob(IMAGE_VAULTS, vaultKey(name, result.version.version), result.vault.tar);
      await store.put(IMAGES, name, image);
      // No version's sign-ins in the clear outlive the record that named that version, whatever the cut did with
      // its snapshot: the record names one version, and the blob of the one it replaced goes with it.
      if (replaced !== undefined && replaced.version !== result.version.version) await store.deleteBlob(IMAGE_VAULTS, vaultKey(name, replaced.version));
    }
    if (hash === undefined) return result;
    const version: GoldenVersion = { ...result.version, imageHash: hash };
    return { ...result, version, manifest: { ...result.manifest, versions: result.manifest.versions.map(v => (v.version === version.version ? version : v)) } };
  };

  /** Snapshot, smoke fork, manifest. A kept builder stays recorded with the version it was saved as and its grace
   * armed; every other road drops the record, so a machine that outlived its kills is exactly what reap sweeps.
   * `copy` is the record a copy's build was composed from: the record stays as it is, the copy is stamped with that
   * record's hash and the frames name the place. */
  const sealEntry = async (entry: LiveBuilder, keep: boolean, logins?: GoldenLogin[], copy?: SealedImage): Promise<SealResult> => {
    const recipe = recipeOrThrow(entry.recipe);
    const name = entry.record.name;
    // The place this builder was made at, where its seal is filed.
    const place = entry.record.place ?? places.wired;
    const prior = await copyOf(place, name);
    const at = backendAt(place);
    try {
      const result = await claiming(`smoke/${entry.record.id}`, b =>
        sealGolden(entry.builder, {
          backend: observing(b),
          smoke: recipe.smoke,
          ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
          ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
          ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
          labels: { ...recipe.labels, [WSP_LABEL]: "1", [SMOKE_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
          onStage: stageOf(name, place, copy !== undefined),
          ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
          ...(opts.snapshotRetryMs !== undefined ? { snapshotRetryMs: opts.snapshotRetryMs } : {}),
          ...(logins !== undefined ? { logins } : {}),
          // Only the image's own seal reads the vault off its builder: a copy's builder was given the record's
          // vault and re-exporting it there would record a second one for the same image.
          ...(copy === undefined && recipe.vaultPaths !== undefined ? { vaultPaths: recipe.vaultPaths } : {}),
          keepBuilder: keep,
          name,
          hostId: templateHostId,
        }),
        at,
      );
      const stamped = await recordSeal(place, name, entry, recipe, result, copy);
      await putCopy(place, name, stamped.manifest);
      const snapshot = entry.builder.import?.recipe;
      if (snapshot !== undefined) await putCopyRecipe(place, name, stamped.version.version, snapshot);
      // The seal stands whatever the mark does: a default that could not be written is a later fork's to ask about.
      if (copy === undefined && name === "default") await placeDoor?.markDefaultIfNone(place).catch((e: unknown) => console.warn(`the default place was not marked at the seal: ${e instanceof Error ? e.message : String(e)}`));
      if (result.builderKept) {
        entry.record.sealed = { at: new Date(clock.now()).toISOString(), version: result.version.version };
        entry.life = "own";
        await hold(entry);
        armGrace(entry.record.id, entry.record.sealed.at);
      } else {
        await forgetBuilder(entry.record.id);
      }
      return stamped;
    } catch (e) {
      // A builder the provider refused to snapshot and still has is untouched, so its record stays for the next attach.
      if (e instanceof SnapshotFailedError && e.builderState !== "gone") throw e;
      // sealGolden consumes the builder on every other road but a refusal; a refused
      // builder can never seal and under a two-machine cap must not outlive it.
      if (e instanceof NotFirstLifeError) await killUntilGone(at, entry.builder.machine, opts.killConfirm);
      await forgetIfGone(entry, at);
      throw e;
    }
  };

  /** Deletes what a version's forks boot from. The template goes first: the provider refuses to delete a snapshot
   * while a template stands on it, and a template already gone is no failure. The sealed vault is not this
   * function's: a manifest counts its own place's versions, and the record's blob is keyed by the record's, so
   * only the seal that replaces a version may take that version's blob. */
  const dropImage = async (v: GoldenVersion, at: MachineBackend = backend): Promise<void> => {
    if (v.templateId !== undefined) {
      await templatesOf(at)?.delete(v.templateId).catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
    }
    await at.deleteSnapshot(v.snapshotId);
  };

  const golden: Runtime["golden"] = {
    async build(o) {
      await ready();
      const { name, ...build } = o;
      const key = name ?? "default";
      const prior = await copyOf(places.wired, key);
      const result = await claiming(`golden/${key}`, b =>
        buildGolden({
          ...build,
          backend: b,
          name: key,
          hostId: templateHostId,
          labels: { ...build.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
        }),
      );
      await putCopy(places.wired, key, result.manifest);
      return { manifest: result.manifest, version: result.version };
    },
    async get(name) {
      await ready();
      const key = name ?? "default";
      return copyOf(await imagePlace(key), key);
    },

    async buildPlace(word) {
      await ready();
      const runs = (place: string, at: MachineBackend): { place: string; name: string; backend: MachineBackend } => {
        const name = placeName(place);
        if (forksNoMachines(at.capabilities)) throw Object.assign(new PlaceForksNowhereError(`${name} forks no machines, so your image cannot be built there`), { kind: "conflict" });
        return { place, name, backend: at };
      };
      // A rebuild seals over the record, so building it anywhere else would move the image's home.
      const target = (await recordOf("default")) !== undefined ? await imagePlace("default") : word;
      if (target !== undefined) {
        const { place, at } = await placeAt(target);
        return runs(place, at);
      }
      // The default place first, since it is where every fork that names none lands; where it runs no workspaces, the
      // one other place that does. None at all and more than one are each their own refusal: the run does not guess.
      const marked = (await placeDoor?.defaultPlace()) ?? {};
      try {
        return marked.placeId === undefined ? runs(places.wired, backendAt(places.wired)) : runs(marked.placeId, await placeDoor!.forkingBackend(marked.placeId));
      } catch (e) {
        // Only a place that runs no workspaces is passed over. A link down or a frame unanswered on the place the
        // person marked is theirs to read, with that place's name in it, never a build sent somewhere else.
        if (!(e instanceof PlaceForksNowhereError)) throw e;
      }
      const running = await buildPlaces();
      if (running.length === 0) throw conflict(NO_BUILD_PLACE_LINE);
      if (running.length > 1) throw conflict(buildPlaceAskLine(running.map(r => r.name)));
      return running[0]!;
    },

    async prepare(o) {
      await ready();
      const recipe = recipeOrThrow(o?.recipe);
      const name = o?.name ?? "default";
      const signal = o?.signal;
      const { deployDaemon, smoke, import: imp, ...size } = recipe;
      void smoke;
      // A seal over a standing record files it where the builder was made, so the image's own build goes to the
      // record's place whatever was asked, and only a copy is built anywhere else.
      const asked = o?.copy !== true && (await recordOf(name)) !== undefined ? await imagePlace(name) : o?.place;
      const { place, at } = asked === undefined ? { place: places.wired, at: backendAt(places.wired) } : await placeAt(asked);
      // Per place as well as per name: a copy building at one place and the image building at another are two
      // prepares of one golden, and neither is the other's to join.
      const preparingKey = copyKey(place, name);
      const active = preparing.get(preparingKey);
      if (active !== undefined) {
        if (active.hash === imp?.recipeHash) return active.promise;
        throw new Error(`a builder named ${name} is still being prepared for a different recipe; wait for it to finish, then run again`);
      }
      const stage = stageOf(name, place, o?.copy === true);
      const run = claiming(`builder/${preparingKey}`, async b => {
        await refreshBuilders();
        // A builder with a seal still in it carrying the same ticks is attached to instead of
        // booting a second one, whichever process made it; the stages skip on its
        // ledger. A stale, foreign or held record is never reused, and a recipe with no
        // import never attaches: nothing says which ticks the builder carries. The
        // building check is a second wall: the join above holds it in this process,
        // life does across processes.
        const same = imp === undefined ? undefined : [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.building !== true && x.record.sealed === undefined && x.record.name === name && (x.record.place ?? places.wired) === place && x.record.import?.recipeHash === imp.recipeHash);
        // The machine this prepare has, attached to or made. A stop kills a made one by its recorded id and drops the
        // record; an attached one still has a seal in it and maybe an earlier run's sign-ins, so its hold is released and
        // its record stays reusable.
        let mine: LiveBuilder | undefined;
        let creating: Promise<Machine> | undefined;
        let stopping: Promise<PrepareStoppedError> | undefined;
        const warn = (what: string) => (e: unknown) => console.warn(`${what}: ${e instanceof Error ? e.message : String(e)}`);
        const stop = async (): Promise<PrepareStoppedError> => {
          // A create still in flight lands first: a stop that gave up sooner would leak the machine it returns.
          await creating?.catch(() => {});
          if (mine === undefined) return new PrepareStoppedError();
          const id = mine.record.id;
          if (mine === same) {
            delete mine.record.heldBy;
            mine.life = "reusable";
            await store.put(BUILDERS, id, mine.record).catch(warn(`hold on builder ${id} not released; it ages out in ${HELD_TTL_MS / 60_000} minutes`));
            return new PrepareStoppedError(id, { kept: true });
          }
          try {
            await killUntilGone(at, mine.builder.machine, opts.killConfirm);
          } catch (e) {
            return new PrepareStoppedError(id, { left: e instanceof Error ? e.message : String(e) });
          }
          await forgetBuilder(id).catch(warn(`record of builder ${id} not dropped; the machine is gone and the next load drops it`));
          return new PrepareStoppedError(id);
        };
        let wake: () => void = () => {};
        const stopped = new Promise<void>(r => {
          wake = r;
        });
        const onAbort = (): void => {
          stopping ??= stop().finally(wake);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        // Once a stop has begun its word is the answer, whatever the work did meanwhile: the work runs on against a
        // machine that is going or released, and neither its result nor its rejection reaches the caller.
        const raced = async <T>(work: Promise<T>): Promise<T> => {
          await Promise.race([work.then(() => {}, () => {}), stopped]);
          if (stopping !== undefined) throw await stopping;
          return work;
        };
        const attach = async (same: LiveBuilder, ledger: GoldenImport): Promise<GoldenBuilderView> => {
          try {
            stage("creating", ALREADY_APPLIED);
            stage("deploying-daemon", ALREADY_APPLIED);
            const applied = await applyGoldenImport(same.builder.machine, { import: ledger, setup: recipe.setup, ...(same.record.import !== undefined ? { ledger: same.record.import } : {}), onStage: stage });
            // A complete ledger only re-imports the volatile files, and that never fails the apply, so this no-op is what
            // proves the machine outlived the earlier process.
            const alive = await same.builder.machine.exec("true");
            if (alive.exitCode !== 0) throw new Error(`the builder answered exit ${alive.exitCode} to a no-op; it is not serving`);
            // A stop that came while the apply ran released the hold; nothing here takes it back.
            if (stopping !== undefined) throw await stopping;
            same.record.import = applied.ledger;
            same.life = "own";
            same.recipe = recipe;
            await hold(same);
          } catch (e) {
            if (stopping !== undefined) throw e;
            // Same road as a fresh builder that fails its stages: the machine goes, the person starts over.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(at, same.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await forgetIfGone(same, at);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          return builderView(same.record, same);
        };
        const fresh = async (): Promise<GoldenBuilderView> => {
          let builder: Builder;
          try {
            builder = await prepareBuilder({
              backend: recordingCreates(b, name, imp, p => (mine = p), { signal, began: c => (creating = c) }, place),
              ...size,
              ...(o?.kind !== undefined ? { kind: o.kind } : {}),
              ...(deployDaemon !== undefined ? { deployDaemon } : {}),
              ...(imp !== undefined ? { import: imp } : {}),
              labels: builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // prepareBuilder tried to kill the machine on its way out; the placeholder goes only where it is gone. After a stop the record is the stop's.
            if (mine !== undefined && stopping === undefined) await forgetIfGone(mine, at);
            throw e;
          }
          // A last exec that outran the kill must not leave a finished record for a machine the stop is killing.
          if (stopping !== undefined) throw await stopping;
          const entry = await settleBuilder(name, builder, mine, place);
          entry.recipe = recipe;
          return builderView(entry.record, entry);
        };
        try {
          if (same && imp) {
            mine = same;
            return await raced(attach(same, imp));
          }
          return await raced(fresh());
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }, at).finally(() => preparing.delete(preparingKey));
      preparing.set(preparingKey, { hash: imp?.recipeHash, promise: run });
      return run;
    },

    async seal(builderId, o) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      refuseUntouchable(entry);
      // A builder built from a recipe is what an update can land on; a bare one has no recipe to diff.
      return sealEntry(entry, o?.keepBuilder !== false && entry.record.import?.recipe !== undefined, o?.logins);
    },

    async recipe(name) {
      await ready();
      const key = name ?? "default";
      const place = await imagePlace(key);
      const manifest = await copyOf(place, key);
      if (manifest === undefined) return undefined;
      return copyRecipeOf(place, key, manifest.head);
    },

    async upgrade(o) {
      await ready();
      const recipe = recipeOrThrow(o.recipe);
      const name = o.name ?? "default";
      // The update lands where the image's own seal stands, on that place's backend.
      const place = await imagePlace(name);
      const prior = await copyOf(place, name);
      const head = goldenHead(prior);
      if (head === undefined) throw new Error(`no golden named "${name}" to update; wsp init builds one`);
      const at = backendAt(place);
      const stage = stageOf(name, place);
      // The head's digest, whose pins the rows the delta leaves alone keep on the next version's record.
      const previousRecipe = await copyRecipeOf(place, name, head.version);
      // Past its window a kept builder is never used, running or not: it is stopped here and the update forks; one
      // the pass could not stop is named so the person knows it still bills. Inside the window, it is suspended for
      // the update's length: the record loses `sealed` and gains `building` before the first exec, so neither the
      // timer nor a sweep stops the machine mid-stage, and a process that dies here leaves a record the next one
      // stops as unfinished; the seal re-arms the window.
      const swept = await expireGrace();
      for (const f of swept.failed) stage("creating", `an earlier kept builder ${f.id}: ${f.message}`);
      await refreshBuilders();
      const kept = [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.name === name && (x.record.place ?? places.wired) === place && x.record.sealed?.version === head.version && inWindow(x.record.sealed.at));
      let entry: LiveBuilder | undefined;
      if (kept !== undefined) {
        graceTimers.get(kept.record.id)?.();
        graceTimers.delete(kept.record.id);
        delete kept.record.sealed;
        kept.record.building = true;
        await store.put(BUILDERS, kept.record.id, kept.record);
        const alive = await kept.builder.machine.exec("true").then(r => r.exitCode === 0, () => false);
        if (!alive) {
          // A machine that does not answer may still bill: it is killed until the provider says gone, then forgotten.
          await killUntilGone(at, kept.builder.machine, opts.killConfirm);
          await forgetBuilder(kept.record.id);
        } else {
          stage("creating", `your builder from v${head.version}, kept since the save`);
          try {
            const applied = await applyDelta(kept.builder.machine, o.delta, { setup: recipe.setup, previousSmoke: head.smoke.cmd, previousBase: head.base, ...(head.missingTools !== undefined ? { previousMissing: head.missingTools } : {}), ...(head.leftBehind !== undefined ? { previousLeftBehind: head.leftBehind } : {}), ...(previousRecipe !== undefined ? { previousRecipe } : {}), onStage: stage });
            const setupSha = nextSetupSha(head.setupSha, recipe.setup, o.delta.import);
            kept.record.import = applied.ledger;
            kept.record.setupSha = setupSha;
            delete kept.record.building;
            // The builder was sealed as the head, so the version it seals next descends from the head's snapshot.
            kept.builder = { ...kept.builder, import: applied.ledger, setupSha, parentSnapshotId: head.snapshotId, retired: o.delta.retiredOnImage };
            kept.life = "own";
            await hold(kept);
          } catch (e) {
            // Same road as a fresh builder that fails its stages: the machine goes, the golden stays as it was.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(at, kept.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await forgetIfGone(kept, at);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          entry = kept;
        }
      }
      const road = entry !== undefined ? "builder" : "fork";
      entry ??= await claiming(
        `builder/${name}`,
        async b => {
          let placeholder: LiveBuilder | undefined;
          let builder: Builder;
          try {
            builder = await upgradeBuilder({
              backend: recordingCreates(b, name, o.delta.import, p => (placeholder = p), undefined, place),
            head,
            delta: o.delta,
              setup: recipe.setup,
              ...(previousRecipe !== undefined ? { previousRecipe } : {}),
              ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
              ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
              ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
              labels: builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // upgradeBuilder tried the kill on its way out; the placeholder goes only where the machine is gone.
            if (placeholder !== undefined) await forgetIfGone(placeholder, at);
            throw e;
          }
          return settleBuilder(name, builder, placeholder, place);
        },
        at,
      );
      entry.recipe = recipe;
      // The update keeps the golden's disk, so what was signed in stays signed in: the caller passes the previous
      // version's outcomes, with the rows it re-imported as copies rewritten.
      const sealed = await sealEntry(entry, true, o.logins);
      let manifest = sealed.manifest;
      let previousDropped = false;
      let builderKept = sealed.builderKept;
      // A version with workspaces still on it stays for them: a rebuild boots them from its image, which the provider
      // would delete under a template's forks (they hold no dependency on it).
      const standing = forkedFrom(head.snapshotId);
      if (o.keepPrevious === false) {
        if (standing.length > 0) {
          console.warn(`golden ${name} v${head.version} kept: ${standing.join(", ")} still on it`);
        } else {
          // A snapshot with live forks under it cannot be deleted (409 on Solari): the builder forked from it goes
          // first, window or not.
          if (road === "fork" && builderKept) {
            graceTimers.get(entry.record.id)?.();
            graceTimers.delete(entry.record.id);
            await killUntilGone(at, entry.builder.machine, opts.killConfirm);
            await forgetBuilder(entry.record.id);
            builderKept = false;
          }
          try {
            await dropImage(head, at);
            manifest = { ...manifest, versions: manifest.versions.filter(v => v.version !== head.version) };
            await putCopy(place, name, manifest);
            await dropCopyRecipe(place, name, head.version);
            previousDropped = true;
          } catch (e) {
            console.warn(`golden ${name} v${head.version} kept: its snapshot was not deleted (${e instanceof Error ? e.message : String(e)})`);
          }
        }
      }
      return { manifest, version: sealed.version, road, previousDropped, builderKept };
    },


    async builderReach(builderId) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      refuseUntouchable(entry);
      const reach = await refreshPreviewToken(entry.builder.machine, DAEMON_PORT, entry.reach);
      entry.reach = reach;
      const daemonToken = await daemonTokenOf(entry.builder.machine);
      return { url: reach.url, expiresAt: reach.expiresAt, ...(daemonToken !== undefined ? { daemonToken } : {}) };
    },

    async builders() {
      await ready();
      return [...builders.values()].map(b => builderView(b.record, b));
    },

    async kill(builderId) {
      await ready();
      await refreshBuilders();
      const entry = builders.get(builderId);
      // A machine of this setup no builder record claims: a seal's smoke fork whose rollback could not reach the
      // provider. Only this state file's own builder or smoke fork is taken, by the labels the create stamped, so
      // neither another host's machine nor a workspace of this one is ever killed here; a provider that cannot be
      // read keeps its own reason, which is what a caller retrying reads.
      if (!entry) {
        const machine = await backend.get(builderId).catch((e: unknown) => {
          if (isMissing(e)) return undefined;
          throw e;
        });
        const labels = machine?.labels;
        const mine = labels?.[OWNER_LABEL] === owner && (labels[BUILDER_LABEL] === "1" || labels[SMOKE_LABEL] === "1");
        if (!mine || machine === undefined) throw new Error(`no such builder: ${builderId}`);
        await killUntilGone(backend, machine, opts.killConfirm);
        return;
      }
      // A record its dead holder left mid-setup is stopped here as the sweep would stop it; only seal and reach need finished stages.
      if (entry.life === "foreign" || entry.life === "held") refuseUntouchable(entry);
      await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
      await forgetBuilder(builderId);
    },

    async storage() {
      await ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      return snapshotStorage(await backend.listSnapshots(), backend.pricing.snapshotStorage, { hostId: templateHostId, recorded: await recordedImages(), now: clock.now() });
    },

    async orphans() {
      await ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const read = { hostId: templateHostId, recorded: await recordedImages(), now: clock.now() };
      const rows = await backend.listSnapshots();
      const snapshots = splitByOwner(rows, read);
      const templates = templatesOf(backend);
      const listed = templates === undefined ? [] : await templates.list();
      const promoted = splitByOwner(listed, read);
      const bytesOf = (part: readonly SnapshotRow[]): number => part.reduce((n, r) => n + r.sizeBytes, 0);
      const totalBytes = bytesOf(rows);
      const freedBytes = bytesOf(snapshots.orphans);
      const pricing = backend.pricing.snapshotStorage;
      return {
        snapshots: snapshots.orphans,
        templates: promoted.orphans,
        freedBytes,
        savesUsdPerMonth: snapshotMonthlyUsd(totalBytes, pricing) - snapshotMonthlyUsd(totalBytes - freedBytes, pricing),
        others: { snapshots: snapshots.foreign, templates: promoted.foreign },
      };
    },

    async deleteOrphans() {
      const plan = await golden.orphans();
      if (plan === undefined) return undefined;
      const deleted: OrphansDeleted = { snapshots: [], templates: [], failed: [] };
      // The plan names templates only on a backend that has them, so the road exists wherever the loop runs.
      const templates = templatesOf(backend);
      const named = (row: SnapshotRow | TemplateRow): { id: string; name?: string } => ({ id: row.id, ...(row.name !== undefined ? { name: row.name } : {}) });
      if (templates !== undefined) {
        for (const t of plan.templates) {
          try {
            await templates.delete(t.id);
            deleted.templates.push(t);
          } catch (e) {
            deleted.failed.push({ ...named(t), message: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      for (const row of plan.snapshots) {
        try {
          await backend.deleteSnapshot(row.id);
          deleted.snapshots.push(row);
        } catch (e) {
          // A snapshot the provider already lost is gone either way, which is what the caller asked for.
          if (isMissing(e)) {
            deleted.snapshots.push(row);
            continue;
          }
          deleted.failed.push({ ...named(row), message: e instanceof Error ? e.message : String(e) });
        }
      }
      return deleted;
    },

    async retention(name) {
      await ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const manifest = await copyOf(places.wired, name ?? "default");
      if (manifest === undefined) return undefined;
      return retentionPlan(manifest, await backend.listSnapshots(), forkedFrom, backend.pricing.snapshotStorage);
    },

    async prune(name) {
      const key = name ?? "default";
      const plan = await golden.retention(key);
      const dropped: GoldenVersion[] = [];
      const failed: { version: number; message: string }[] = [];
      if (plan === undefined) return { dropped, failed };
      for (const v of plan.drop) {
        try {
          await dropImage(v);
        } catch (e) {
          // A snapshot the provider already lost is gone either way; its version goes with it.
          if (!isMissing(e)) {
            failed.push({ version: v.version, message: e instanceof Error ? e.message : String(e) });
            continue;
          }
        }
        const manifest = (await copyOf(places.wired, key))!;
        await putCopy(places.wired, key, { ...manifest, versions: manifest.versions.filter(x => x.version !== v.version) });
        await dropCopyRecipe(places.wired, key, v.version);
        dropped.push(v);
      }
      return { dropped, failed };
    },

    async rollback(version, name) {
      const key = name ?? "default";
      const missing = (message: string) => Object.assign(new Error(message), { kind: "missing" });
      const prior = await copyOf(places.wired, key);
      if (!prior) throw missing(`no golden named "${key}"`);
      let next: GoldenManifest;
      try {
        next = rollbackGolden(prior, version);
      } catch (e) {
        throw missing(e instanceof Error ? e.message : String(e));
      }
      await putCopy(places.wired, key, next);
      return next;
    },

    async promote(name) {
      await ready();
      const templates = templatesOf(backend);
      if (templates === undefined) return undefined;
      const key = name ?? "default";
      const manifest = await copyOf(places.wired, key);
      const rows: GoldenPromotion[] = [];
      for (const v of manifest?.versions ?? []) {
        if (v.templateId !== undefined) continue;
        try {
          const { templateId, sharing } = await promoteVersion(templates, v.snapshotId, goldenName(templateHostId, key, v.version));
          const current = await copyOf(places.wired, key);
          if (current === undefined) throw new Error(`golden ${key} was dropped while its versions were being promoted`);
          await putCopy(places.wired, key, { ...current, versions: current.versions.map(x => (x.version === v.version ? { ...x, templateId } : x)) });
          rows.push({ golden: key, version: v.version, templateId, ...(sharing !== undefined ? { sharing } : {}) });
        } catch (e) {
          rows.push({ golden: key, version: v.version, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return rows;
    },

    async projects() {
      await ready();
      return (await store.list(PROJECT_GOLDENS)).map(projectGoldenOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async removeProject(snapshotId) {
      await ready();
      const stored = await store.get(PROJECT_GOLDENS, snapshotId);
      if (stored === undefined) throw notFoundRefusal(noProjectImageLine(snapshotId));
      const projectGolden = projectGoldenOf(stored);
      const standing = forkedFrom(snapshotId);
      if (standing.length > 0) throw conflict(projectImageInUseRefusal(snapshotId, standing));
      const at = backendAt(projectGolden.place ?? places.wired);
      const read = await snapshotUntilGone(at, snapshotId, opts.killConfirm).catch((e: unknown) => {
        const { kind, status } = e as { kind?: unknown; status?: unknown };
        throw Object.assign(new Error(projectImageRefusedLine(snapshotId, answerOf(e))), kind !== undefined ? { kind } : {}, status !== undefined ? { status } : {});
      });
      if (read.verdict === "listed") throw new Error(projectImageStillListedLine(snapshotId, read.graceMs));
      await store.delete(PROJECT_GOLDENS, snapshotId);
      return { projectGolden, alreadyGone: read.verdict === "missing" };
    },

  };

  /** The sizes a place's provider reports for the snapshots named, keyed by id; empty where it has no listing or
   * would not answer, since a size nobody read is left absent rather than guessed. */
  const snapshotSizes = async (at: MachineBackend, ids: readonly string[]): Promise<Map<string, number>> => {
    if (ids.length === 0 || !at.capabilities.snapshotListing || at.listSnapshots === undefined) return new Map();
    const rows = await at.listSnapshots().catch(() => []);
    return new Map(rows.filter(r => ids.includes(r.id)).map(r => [r.id, r.sizeBytes]));
  };

  /** The copy each place holds of this golden, newest version per place, with the record's hash it was built at. */
  const copiesOf = async (name: string): Promise<SealedImageCopy[]> => {
    const rows: { place: string; head: GoldenVersion }[] = [];
    for (const key of await store.keys(GOLDENS)) {
      const parts = copyKeyParts(key);
      if (parts.name !== name) continue;
      const head = goldenHead((await store.get(GOLDENS, key)) as GoldenManifest | undefined);
      if (head !== undefined) rows.push({ place: parts.place ?? places.wired, head });
    }
    const copies: SealedImageCopy[] = [];
    for (const { place, head } of rows) {
      const at = places.backend(place) ?? placeDoor?.backendOf(place);
      const sizes = at === undefined ? new Map<string, number>() : await snapshotSizes(at, [head.snapshotId]);
      copies.push({
        place,
        version: head.version,
        ...(head.imageHash !== undefined ? { hash: head.imageHash } : {}),
        snapshotId: head.snapshotId,
        ...(head.templateId !== undefined ? { templateId: head.templateId } : {}),
        builtAt: head.createdAt,
        ...(sizes.has(head.snapshotId) ? { sizeBytes: sizes.get(head.snapshotId)! } : {}),
      });
    }
    return copies.sort((a, b) => (a.place === places.wired ? -1 : b.place === places.wired ? 1 : a.place.localeCompare(b.place)));
  };

  const conflict = (message: string): Error => Object.assign(new Error(message), { kind: "conflict" });

  /** Every project golden, oldest first, with its size off the listing of the place each record names: one listing
   * per place, and none for a place this host no longer holds. */
  const projectImagesSized = async (): Promise<SealedProjectImage[]> => {
    const projects = await golden.projects();
    const sizes = new Map<string, number>();
    for (const place of new Set(projects.map(p => p.place ?? places.wired))) {
      let at: MachineBackend;
      try {
        at = backendAt(place);
      } catch {
        continue;
      }
      for (const [id, bytes] of await snapshotSizes(at, projects.filter(p => (p.place ?? places.wired) === place).map(p => p.snapshotId))) sizes.set(id, bytes);
    }
    return projects.map(p => (sizes.has(p.snapshotId) ? { ...p, sizeBytes: sizes.get(p.snapshotId)! } : p));
  };

  const image: Runtime["image"] = {
    async get(name) {
      await ready();
      const key = name ?? "default";
      return {
        image: (await recordOf(key)) ?? null,
        copies: await copiesOf(key),
        projects: await projectImagesSized(),
      };
    },

    async vault(name) {
      await ready();
      const key = name ?? "default";
      const record = await recordOf(key);
      if (record === undefined) throw conflict(`this host owns no image named ${key} yet; wsp init seals one`);
      if (record.vault === undefined) throw conflict(`${key} v${record.version} was sealed before its sign-ins were held, so there is nothing to export; cut the next version to hold them`);
      const tar = await store.getBlob(IMAGE_VAULTS, vaultKey(key, record.version));
      if (tar === undefined) throw conflict(`the vault of ${key} v${record.version} is not on this computer any more; cut the next version to take it again`);
      return { image: record, tar };
    },

    async build(o) {
      await ready();
      const name = o.name ?? "default";
      const { place, at } = await placeAt(o.place);
      const where = placeName(place);
      if (!buildsImages(at.capabilities)) throw refusal(placeBuildsNoImageLine(where), COPY_BUILD_FIX.noCopy, "conflict");
      const record = await recordOf(name);
      if (record === undefined) throw refusal(`this host owns no image named ${name} yet`, COPY_BUILD_FIX.noImage, "conflict");
      if (record.recipe === undefined) throw refusal(`${name} v${record.version} was sealed before the image record kept the recipe it was built from, so no other place can build it`, COPY_BUILD_FIX.noRecipe, "conflict");
      if (copyAsksSignIns(record) && o.force !== true) {
        throw refusal(`${name} v${record.version} holds no sign-ins, so a copy at ${where} would ask for every one of them again`, COPY_BUILD_FIX.noVault, "conflict");
      }
      const held = goldenHead(await copyOf(place, name));
      // The same rule the line under Settings > Image reads, so a copy is never current in one place and stale in
      // the other. A place already standing on the record is answered with what it holds: a fork there asks this
      // before it builds, and a second ask must cost nothing.
      if (held !== undefined && copyIsCurrent(record, { hash: held.imageHash })) {
        const standing = (await copiesOf(name)).find(c => c.place === place);
        if (standing === undefined) throw new Error(`${where} holds ${name} v${held.version} and no copy of it was recorded there`);
        return { copy: standing, built: false };
      }
      // Every refusal above is this call's own, so a second caller is told the same thing about its own `force`
      // rather than inheriting a build it would have refused; what is joined is the build itself.
      const key = copyKey(place, name);
      const running = copyBuilds.get(key);
      o.starting?.();
      if (running !== undefined) return running;
      const run = buildCopy({ place, where, at, name, record, ...(o.signal !== undefined ? { signal: o.signal } : {}) })
        .catch((e: unknown) => {
          // Not every road out of a build frames its failure, and a building frame left standing reads building for
          // good on the row and the card and is put back by the computer's next link.
          if (copyRows.get(place)?.stopped === false) frameStopped(place, name, placeAway(place) || isPlaceAbsent(e) ? placeWentAwayLine(where) : e);
          throw e;
        })
        .finally(() => copyBuilds.delete(key));
      copyBuilds.set(key, run);
      return run;
    },

    async keepCurrent(place, name) {
      const key = name ?? "default";
      // A computer that is not connected owes nothing now: a fork there builds its copy. Read before anything is
      // composed or framed, so no row says a build stopped that never started, and read again on a failure, since
      // the link going mid-ask is a laptop sleeping.
      const before = copyRows.get(place);
      try {
        await ready();
        if ((await recordOf(key)) === undefined || placeAway(place)) return;
        // A place that builds no copy at all owes none: a provider that forks nothing, a computer that keeps no disk.
        const { at } = await placeAt(place);
        if (!buildsImages(at.capabilities)) return;
        // A build joined here may have been sealing an older record; the copy it leaves is stamped with the record
        // it was built from, so it reads stale against the record as it stands now and is built once more.
        for (;;) {
          const built = await image.build({ place, name: key });
          const record = await recordOf(key);
          if (record === undefined || copyIsCurrent(record, built.copy)) return;
        }
      } catch (e) {
        // A build that already framed its stop has said it; a refusal before any build is said here, and stands
        // until the next build there takes the row over.
        const now = copyRows.get(place);
        if (now !== before && now?.stopped === true) return;
        if (rowSaysFailure(place, e)) frameStopped(place, key, e);
      }
    },
  };

  /** One copy built at one place: the record's vault landed on a fresh builder there and sealed under the record's
   * hash. Called once every refusal has passed and only while no build for the same place and name is in flight. */
  const buildCopy = async (o: { place: string; where: string; at: MachineBackend; name: string; record: SealedImage; signal?: AbortSignal }): Promise<SealedImageBuilt> => {
    const { place, where, at, name, record } = o;
    // Read before the blob and before a builder is asked for: a record with no path list cannot have its archive
    // judged anywhere, and an archive carrying a member the seal never asked for boots nothing here.
    if (record.vault !== undefined && record.vault.held === undefined) throw conflict(vaultUnlistedRefusal(name, record.version));
    const tar = record.vault === undefined ? undefined : await store.getBlob(IMAGE_VAULTS, vaultKey(name, record.version));
    if (record.vault !== undefined && tar === undefined) throw conflict(`the vault of ${name} v${record.version} is not on this computer any more; cut the next version to take it again`);
    if (tar !== undefined && record.vault?.held !== undefined) {
      try {
        refuseForeignMembers("import", tar, record.vault.held);
      } catch (e) {
        throw conflict(e instanceof Error ? e.message : String(e));
      }
    }
    const recipe = await copyRecipeOrThrow()(record);
    const view = await golden.prepare({ name, place, copy: true, recipe, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    const entry = builders.get(view.id);
    if (entry === undefined) throw new Error(`the builder ${view.id} prepared at ${where} left no record here; nothing was sealed`);
    const stage = stageOf(name, place, true);
    try {
      // The person's sign-ins land before the seal and after everything the recipe installs, so the copy holds
      // what the builder at the wired place held and no sign-in is run here.
      if (tar !== undefined) {
        stage("uploading-files", `the image's sign-ins, ${fmtBytes(tar.length)}`);
        await importImageVault(entry.builder.machine, tar);
      }
    } catch (e) {
      await killUntilGone(at, entry.builder.machine, opts.killConfirm).catch(() => {});
      await forgetIfGone(entry, at);
      stage("failed", e instanceof Error ? e.message : String(e));
      throw e;
    }
    const sealed = await sealEntry(entry, false, record.logins, record);
    const copy = (await copiesOf(name)).find(c => c.place === place);
    if (copy === undefined) throw new Error(`${where} sealed ${name} v${sealed.version.version} and no copy of it was recorded there`);
    return { copy, built: true };
  };

  /** The image whose head, at the place its own seal stands, is this snapshot: the one a fork's copy is looked up by.
   * Nothing for a project golden or a version that is no longer the head. */
  const imageHeadNamed = async (snapshotId: string): Promise<string | undefined> => {
    for (const raw of await store.list(IMAGES)) {
      const image = raw as SealedImage;
      if (goldenHead(await copyOf(image.place ?? places.wired, image.name))?.snapshotId === snapshotId) return image.name;
    }
    return undefined;
  };

  /** The snapshot a fork names at the place it lands on. A place that is not the image's own forks its own copy: the
   * one a build running there seals, which the create waits for, or the one standing there on the record. A caller
   * that can say so before anything bills has a place holding no current copy build one first, through the same
   * build a press starts; everywhere else the snapshot asked for goes through as it is. */
  const copyForFork = async (golden: string, placeId: string | undefined, announce?: (where: string, rateUsdPerHour: number) => void): Promise<string> => {
    const place = placeId ?? places.wired;
    const name = await imageHeadNamed(golden);
    if (name === undefined || place === (await imagePlace(name))) return golden;
    if (announce === undefined) {
      const built = await copyBuilds.get(copyKey(place, name))?.catch(() => undefined);
      if (built !== undefined) return built.copy.snapshotId;
    }
    const record = await recordOf(name);
    if (record === undefined) return golden;
    const held = goldenHead(await copyOf(place, name));
    if (held !== undefined && copyIsCurrent(record, { hash: held.imageHash })) return held.snapshotId;
    if (announce === undefined) return golden;
    const { at } = await placeAt(place);
    if (!buildsImages(at.capabilities)) return golden;
    const starting = (): void => announce(placeName(place), at.pricing.rateUsdPerHour(at.pricing.defaultSize));
    return (await image.build({ place, name, starting })).copy.snapshotId;
  };

  /** The import road onto a fork: the plan, what was consented, the pack, the upload in parts, the landing at the
   * path and the agents' state keyed to it there. */
  const copyImport = async (entry: LiveWorkspace, o: ProjectImportOptions, report: ImportReport): Promise<ImportLanded> => {
    const plan = await o.bundler.plan();
    report("planned", `${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}${plan.repo ? " and the repository" : ""}; ${plural(plan.secrets.length, "secret-shaped file")}; ${plural(plan.excluded.length, "cache")} left behind.`);
    const carry = new Set(o.carry ?? []);
    const rewrite = new Set(o.rewrite ?? []);
    const rewriting = plan.secrets.flatMap(s => (s.rewrite !== undefined && rewrite.has(s.path) ? [{ path: s.path, ...s.rewrite }] : []));
    const rewritten = new Set(rewriting.map(r => r.path));
    const carried = plan.secrets.filter(s => carry.has(s.path) && !rewritten.has(s.path)).map(s => s.path);
    const cut = plan.secrets.filter(s => !carry.has(s.path) && !rewritten.has(s.path)).map(s => s.path);
    const clauses = [
      ...(carried.length > 0 ? [`carrying ${carried.join(", ")}`] : []),
      ...(rewriting.length > 0 ? [`rewriting ${rewriting.map(r => `${r.path}${r.urls.length > 0 ? ` to ${r.urls.join(", ")}` : ""}${r.drop.length > 0 ? ` without ${r.drop.join(", ")}` : ""}`).join(", ")}`] : []),
      ...(carried.length === 0 && rewriting.length === 0 ? ["no secret-shaped file travels"] : []),
      cut.length === 0 ? "nothing cut" : `cut ${cut.join(", ")}`,
    ].join("; ");
    const named = new Set(o.agents ?? []);
    const readable = plan.agents.filter(a => a.error === undefined);
    const unreadable = plan.agents.filter(a => a.error !== undefined);
    const travelling = readable.filter(a => named.has(a.agent));
    const staying = readable.filter(a => !named.has(a.agent));
    const withCount = (a: ProjectPlan["agents"][number]): string => `${a.name} (${plural(a.sessions, "session")})`;
    const notes = [
      ...(plan.agents.length === 0 ? [] : travelling.length === 0 ? ["No agent sessions travel"] : [`Sessions travel for ${travelling.map(withCount).join(", ")}`]),
      ...(travelling.length > 0 && staying.length > 0 ? [`${staying.map(a => a.name).join(", ")} ${staying.length === 1 ? "stays" : "stay"}`] : []),
      ...unreadable.map(a => `${a.name} could not be read (${a.error})`),
    ];
    const agentsLine = notes.length === 0 ? "" : ` ${notes.join("; ")}.`;
    report("consented", `${plan.secrets.length === 0 ? "No secret-shaped files." : `${clauses.charAt(0).toUpperCase()}${clauses.slice(1)}.`}${agentsLine}`);
    report("packing", `Packing ${plural(plan.files - cut.length, "file")}.`);
    const packed = await o.bundler.pack(carry, rewrite);
    let state: PackedState | undefined;
    if (travelling.length > 0) {
      const present = await agentsOnMachine(entry.machine, travelling.map(a => a.agent));
      const homes = guestAgentHomes();
      state = await o.bundler.packState({
        dest: o.dest,
        agents: travelling.map(a => {
          const home = homes[a.agent];
          if (home === undefined) throw new Error(`${a.agent} is not an agent the catalog knows`);
          return { agent: a.agent, home, present: present.has(a.agent) };
        }),
      });
    }
    report("uploading", `Uploading ${fmtBytes(packed.tar.length)}.`, { bytes: 0, total: packed.tar.length });
    const { parts } = await landBundle(entry.machine, packed.tar, o.dest, {
      ...(o.replace !== undefined ? { replace: o.replace } : {}),
      tmpDir: moduleOf(entry.record.kind).scratch(entry),
      timeoutMs: 600_000,
      onPart: p => report("uploading", `Part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, { bytes: p.bytes, total: p.total }),
      onLanding: () => report("landing", `Landing at ${o.dest}.`),
    });
    const nameOf = (id: string): string => plan.agents.find(a => a.agent === id)?.name ?? id;
    const agents = [...(state?.agents ?? [])];
    const outcomes = (): string => agents.map(a => `${nameOf(a.agent)} ${outcomeWords(a)}`).join(", ");
    if (state !== undefined && (agents.some(a => a.files > 0) || state.merges.length > 0)) {
      const files = agents.reduce((n, a) => n + a.files, 0);
      const what = [...(files > 0 ? [plural(files, "session file")] : []), ...(state.merges.length > 0 ? ["the rows to merge"] : [])].join(" and ");
      report("uploading", `Uploading ${what}, ${fmtBytes(state.tar.length)}.`, { bytes: 0, total: state.tar.length });
      await importInto(entry.machine, state.tar, "/", {
        overlay: true,
        tmpDir: moduleOf(entry.record.kind).scratch(entry),
        timeoutMs: 600_000,
        onPart: p => report("uploading", `Part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, { bytes: p.bytes, total: p.total }),
      });
      if (state.merges.length > 0) {
        report("landing", `Merging rows into ${state.merges.map(m => nameOf(m.agent)).join(", ")}.`);
        for (const m of state.merges) {
          const at = agents.findIndex(a => a.agent === m.agent);
          if (at >= 0) agents[at] = await mergeOnMachine(entry.machine, m.script, agents[at]!);
        }
      }
      report("landing", `Landing sessions: ${outcomes()}.`);
    }
    return {
      result: { dest: o.dest, files: packed.files, bytes: packed.bytes, parts, cut: packed.cut, rewritten: packed.rewritten, agents, project: projectOf(o.dest, packed.bytes) },
      done: `${plural(packed.files, "file")}, ${fmtBytes(packed.bytes)}, landed at ${o.dest}${parts > 1 ? ` in ${parts} parts` : ""}${agents.length > 0 ? `; sessions: ${outcomes()}` : ""}.`,
    };
  };

  /** The seed half of an add, which the host wires because it reads a folder of the person's: a runtime without it
   * records a folder as a project on this computer and clones a repo anywhere else, and a folder seeding another
   * computer is refused rather than sent unread. */
  const seedWiring = (): SeedWiring => {
    if (opts.seed === undefined) throw new Error(NO_SEED_WIRING);
    return opts.seed;
  };

  /** Which landing road a computer takes, off what the computer is rather than off its id: the computer the app
   * runs on copies the folder beside itself, a computer whose daemon says where it keeps checkouts clones onto
   * that disk, and everything else is a provider, where a project lives in an image. */
  const landingKind = (computer: string, at: MachineBackend | undefined): ProjectLanding["kind"] =>
    copiesFolder(kindForComputer(computer)) ? "mac" : at?.projects !== undefined ? "box" : "provider";

  /** What a landing road may ask of this runtime, for one computer: a short-lived machine of that computer's image
   * to clone, seed and install in, the road that puts the seed archive on it, the snapshot a project image is, and
   * where that computer and this Mac keep what a project needs. */
  const landingDeps = async (computer: string): Promise<{ deps: LandingDeps; at: MachineBackend | undefined; placeId: string | undefined }> => {
    const { placeId } = await landingPlace(computer);
    // A computer this host cannot read a backend for holds nothing of a project: the record still stands, as it
    // did before this road existed, and the road that would have to fork there says so itself when it is asked.
    const at = await landingBackend(placeId).catch(() => undefined);
    const deps: LandingDeps = {
      async worker(o) {
        const forking = await landingBackend(placeId);
        // A computer that keeps no image is worked in a copy of its own directories, the same machine a workspace
        // there is; only a provider names an image to fork, and the add read which one once.
        const golden = o.from === "" ? undefined : await copyForFork(o.from, placeId);
        const spec: MachineSpec = {
          kind: "sandbox",
          ...(golden !== undefined ? { fromSnapshot: golden } : {}),
          // On a computer somebody joined this machine clones and installs with that computer's shared home
          // bound in, as a workspace there does, so it reads the same order and the same knobs; this Mac and the
          // provider this host forks on answer no place and keep the order an image is sealed with.
          envs: { ...loginEnvOn(placeId) },
          // A machine whose disk becomes an image is a builder, which is what keeps the computer's own logins out
          // of it; one that only clones onto the computer is not, since the clone reads those logins.
          labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString(), ...(o.image ? { [BUILDER_LABEL]: "1" } : {}) },
          ...(o.binds.length > 0 ? { binds: [...o.binds] } : {}),
          // Nothing waits on a person here: an add that died leaves no machine running for hours.
          onIdle: "kill",
        };
        return forking.create(spec);
      },
      stop: async machine => gone.stop(await landingBackend(placeId), machine),
      land: async (machine, path, bytes) => void (await landBytes(machine, path, bytes)),
      // A first-life fork of the image: the one snapshot road, the same the project goldens take.
      checkpoint: async (machine, name) => {
        await syncDisk(machine);
        return machine.snapshot(name, { firstLife: true });
      },
      scratch: () => GUEST_TMP,
      ...(at?.projects !== undefined ? { projectsDir: at.projects } : {}),
      // One command on the computer itself, where that computer runs any: how the folder wsp keeps for a project
      // there is taken away again. A provider answers none, and this Mac's own road runs nothing outside a
      // workspace, so both leave it absent and the roads there never ask.
      ...(at?.onComputer === undefined ? {} : { onComputer: at.onComputer.bind(at) }),
      imageHead: () => imageHeadOrNone(),
      // Where Claude Code keeps its projects on this computer, which is the memory folder of a project worked in
      // place here; read the way every other road on this computer reads that store.
      macStateHome: local?.home("claude") ?? "",
      // The name this wsp holds for that computer, read the way a fork's own line reads it.
      computerName: placeName(computer),
      now: () => clock.now(),
    };
    return { deps, at, placeId };
  };

  /** A computer somebody joined that this host cannot reach right now holds nothing of a project: the sentence is
   * that computer's own absent one, said before anything is made or removed. Read apart from the deps above
   * because a computer with no backend at all is what this Mac looks like to a host with no provider key, and a
   * folder here is still a project. */
  const readableComputer = async (at: MachineBackend | undefined, placeId: string | undefined): Promise<void> => {
    if (at === undefined && placeId !== undefined) await landingBackend(placeId);
  };

  /** Recording, reading and dropping a project, the four acts that keep the projects map and the store together.
   * Named apart from the door below so the create and the landing can resolve a project without reaching through
   * the public object. */
  const projectsDoor = {
    /** What a seed of a folder on this computer would carry, with the ticks a choice remembered for that folder
     * leaves on it. Nothing is read whole and nothing leaves this computer: the menu is git's own listing of what
     * it ignores, one size pass and the agent's memory folder. */
    async seedPlan(source: string): Promise<SeedPlan> {
      await ready();
      const folder = folderNamed(source);
      const plan = await seedWiring().plan(folder);
      const remembered = (await store.get(SEED_CHOICES, folder)) as SeedChoice | undefined;
      if (remembered === undefined) return plan;
      return { ...plan, remembered: true, files: plan.files.map(f => ({ ...f, ticked: f.kind !== "never" && remembered.files.includes(f.path) })) };
    },

    async add(o: { source: string; on?: string; name?: string; base?: string; seed?: SeedChoice }, origin?: Caller): Promise<ProjectView & { notice?: string }> {
      await ready();
      // A project is this computer's to record: the folder and the computer named are read here, and a machine
      // that asked would be naming paths on a computer it cannot see.
      refuseRecording(o.source, origin);
      const rows = await computerRows();
      const clones = rows.filter(r => kindWords(kindForComputer(r.id)).projectSources.includes("git")).map(r => r.name);
      const kind = sourceKind(o.source);
      if (kind === "computer") throw new Error(ADD_IS_A_COMPUTER_LINE);
      const source: ProjectSource = projectSourceOf(o.source, kind, kind === "folder" ? folderNamed(o.source) : undefined);
      // No --on: a folder is worked here, and a repo needs the computer that clones it, since this computer never
      // does. The kind table says which computers those are.
      const computer = o.on === undefined ? (kind === "folder" ? HERE_PLACE_ID : undefined) : (rows.find(r => r.id === o.on || r.name === o.on)?.id ?? undefined);
      if (computer === undefined) {
        if (o.on === undefined) throw new Error(noComputerForSourceLine(o.source, clones));
        throw new Error(noSuchPlaceRefusal(o.on, rows.map(r => r.name)));
      }
      const computerKind = kindForComputer(computer);
      const takes = kindWords(computerKind).projectSources;
      if (!takes.includes(source.kind)) throw new Error(source.kind === "folder" ? folderOnCopyRefusal(nameOfComputer(computer, rows)) : gitOnThisMacRefusal);
      const held = [...projectsHeld.values()].find(p => p.computer === computer && sameSource(p.source, source));
      if (held !== undefined) throw Object.assign(new Error(sameSourceRefusal(held.name, nameOfComputer(computer, rows))), { kind: "conflict" });
      // A folder here is a project only if it is the top of a git repo: a workspace of it starts on a branch, and
      // a folder with no git in it has none.
      if (source.kind === "folder" && !(await isRepoHere(source.path))) throw new Error(`${source.path} ${NOT_A_REPO_LINE}`);
      const { deps, at, placeId } = await landingDeps(computer);
      await readableComputer(at, placeId);
      const road = projectLanding(landingKind(computer, at));
      // What the source resolves to on this computer: the remote whichever computer holds the project will clone,
      // and, for a folder here, the menu of what a seed of it would carry.
      const module = projectSource(source.kind);
      const resolved = await module.resolve(source, {
        // A folder is seeded only onto a computer that clones it; the computer the app runs on copies it beside
        // itself and reads nothing of it but its own remote.
        seeding: road.kind !== "mac",
        seedPlan: folder => projectsDoor.seedPlan(folder),
        folderRemote: folder => remoteHere(folder),
      });
      // Nothing of the person's folder leaves this computer unasked: a seed onto a computer that clones needs the
      // choice they made off the menu, and the road that copies the folder here seeds nothing at all.
      const seeding = resolved.seed !== undefined && road.kind !== "mac";
      if (seeding && o.seed === undefined) throw Object.assign(new Error(seedChoiceNeeded(source.kind === "folder" ? source.path : o.source)), { kind: "invalid" });
      const name = o.name ?? resolved.name;
      const id = `pr_${randomBytes(4).toString("hex")}`;
      const path = road.path({ name, source });
      // The key the agent's memory sits under, fixed here and never recomputed: the folder's own key where a folder
      // on this computer seeded the project, so the memory it already has is the memory it keeps, else the key of
      // the path on the computer holding it.
      const memoryKey = resolved.seed?.memory?.key ?? claudeProjectKey(source.kind === "folder" ? source.path : path);
      const places = road.places({ project: { id, name, path, source }, memoryKey, deps });
      const project: ProjectView = {
        id,
        name,
        computer,
        source,
        path,
        remote: resolved.remote,
        defaultBranch: resolved.defaultBranch,
        memoryKey,
        memoryDir: places.memoryDir,
        // The branch a workspace of this project starts on: the one they named, and otherwise none, which the
        // clone reads as the remote's own default. The branch a seed's unpushed commits were on is never this: a
        // branch the remote has never seen is nothing a clone can ask for, so those commits land on a branch of
        // their own after the clone and the record stays on the branch the remote has.
        ...(o.base !== undefined ? { base: o.base } : {}),
        createdAt: new Date(clock.now()).toISOString(),
      };
      const began = clock.now();
      const report = (stage: ProjectAddStage, message: string): void => {
        bus.emit({ type: "project.add", projectId: project.id, computer, stage, message, elapsedMs: clock.now() - began });
      };
      // Work runs on the computer when the add has something of the person's to put there, which is a seed: the
      // clone, the files they ticked, the install and, on a provider, the image every workspace of the project
      // forks. A repo the computer can clone by itself is recorded here and cloned by the workspace's own create,
      // which is what it did before this road existed.
      const keep = async (landed: Landed): Promise<ProjectView & { notice?: string }> => {
        // The notice is what the person is told about this add, not a field of the project: the record is written
        // once here with the schema's own fields, so it is taken off before anything is stored or emitted.
        const { notice: _said, ...fields } = landed;
        const recorded: ProjectView = { ...project, ...fields };
        await rememberProject(recorded);
        // Kept under the folder as this host resolved it, which is the word the next menu is looked up by.
        if (o.seed?.remember === true && source.kind === "folder") await store.put(SEED_CHOICES, source.path, o.seed);
        bus.emit({ type: "project.added", project: recorded });
        return recorded;
      };
      const seed = seeding && resolved.seed !== undefined && o.seed !== undefined ? { plan: resolved.seed, choice: o.seed } : undefined;
      if (!road.landsAtAdd({ seeding: seed !== undefined })) return keep({});
      report("planned", addingProjectLine(project.name, source, seed !== undefined));
      try {
        const packed = seed === undefined ? undefined : await seedWiring().pack(seed);
        // A login inside a folder they ticked stays on this computer: said as the pack finds it, so the terminal
        // watching the add reads it there and the answer's notice is the tool door's copy of the same fact.
        if (packed !== undefined && packed.left.length > 0) report("seeding", leftBehindLine(packed.left));
        const landed = await road.land(
          {
            project,
            source: module,
            ...(seed !== undefined && packed !== undefined ? { seed: { tar: packed.tar, choice: seed.choice, plan: seed.plan } } : {}),
            report,
          },
          deps,
        );
        const recorded = await keep(landed);
        // The one sentence about where the project is, which every door reads from here: the terminal prints this
        // stage and says nothing of its own after it, so the fact is said once.
        report("done", addedProjectOn(recorded, nameOfComputer(computer, rows)));
        // What landed and is not what they asked for, each in its own sentence: the commits a computer's git
        // refused, and a login found inside a folder they ticked, which the pack leaves here. Both are theirs to
        // know about on an add that otherwise stands.
        const notices = [...(landed.notice !== undefined ? [landed.notice] : []), ...(packed !== undefined && packed.left.length > 0 ? [leftBehindLine(packed.left)] : [])];
        return notices.length === 0 ? recorded : { ...recorded, notice: notices.join("; ") };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },

    async list(): Promise<ProjectView[]> {
      await ready();
      return [...projectsHeld.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async computers(): Promise<{ id: string; name: string }[]> {
      await ready();
      return computerRows();
    },

    async resolve(ref: string, origin?: Caller): Promise<ProjectView> {
      await ready();
      const all = [...projectsHeld.values()];
      const found = all.find(p => p.id === ref) ?? all.find(p => p.name === ref);
      // A thread works on the project its own workspace holds: every other word reads as absent here, so a word
      // that names another project and one that names nothing are one sentence and neither says what else stands.
      // A thread whose workspace this host no longer holds works on none, so every word reads the same for it.
      const scope = scopeOf(origin);
      if (scope !== undefined) {
        const mine = projectOfScope(scope);
        if (found === undefined || mine === undefined || found.id !== mine) throw notFoundRefusal(bareNoSuchProjectLine(ref));
        return found;
      }
      if (found === undefined) throw notFoundRefusal(noSuchProjectLine(ref, all.map(p => p.name)));
      return found;
    },

    async remove(id: string, origin?: Caller): Promise<{ said: string }> {
      await ready();
      spawnGuard("delete", origin);
      const project = await projectsDoor.resolve(id);
      const standing = [...live.values()].filter(e => e.record.project === project.id).map(e => e.record.name);
      if (standing.length > 0) throw Object.assign(new Error(projectInUseRefusal(project.name, standing)), { kind: "conflict" });
      const { deps, at, placeId } = await landingDeps(project.computer);
      await readableComputer(at, placeId);
      // What the add made on that computer goes before the record does, so a computer that cannot be reached
      // keeps both and the person can say it again when it is back. The sentence is the road's: it is true
      // differently on a computer of theirs, at a provider and here.
      const said = await projectLanding(landingKind(project.computer, at)).remove(project, deps);
      projectsHeld.delete(project.id);
      await store.delete(PROJECTS, project.id);
      bus.emit({ type: "project.removed", projectId: project.id });
      return { said };
    },
  };

  const projects: Runtime["projects"] = {
    add: projectsDoor.add,
    seedPlan: projectsDoor.seedPlan,
    list: projectsDoor.list,
    computers: projectsDoor.computers,
    resolve: projectsDoor.resolve,
    remove: projectsDoor.remove,
    async import(o, origin) {
      spawnGuard("import", origin);
      const entry = await entryOf(o.workspaceId, origin);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "import", entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      await copyBlocked(entry);
      const began = clock.now();
      const report: ImportReport = (stage, message, progress) => {
        bus.emit({ type: "project.import", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      try {
        const kind = moduleOf(entry.record.kind);
        const landed = await kind.import(entry, o, report);
        // The workspace's own project is its record's; a folder landed beside it is browsable too, and neither is
        // written onto the record, which names one project and nothing else.
        await kind.roots(entry, [...new Set([projectHeld(entry.record.project).path, landed.result.dest])]);
        report("done", landed.done);
        return landed.result;
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    async export(o, origin) {
      spawnGuard("export", origin);
      const entry = await entryOf(o.workspaceId, origin);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "export", entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      await copyBlocked(entry);
      const began = clock.now();
      const report = (stage: ProjectExportStage, message: string, progress?: { bytes: number; total: number }): void => {
        bus.emit({ type: "project.export", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      const downloading = (what: string) => (p: { bytes: number; total: number }): void => report("downloading", `${what}: ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, p);
      const scratch = mkdtempSync(join(tmpdir(), "wsp-exported-"));
      // Where the listing writes the filtered copy of a store an agent keeps for every project, mirroring the homes.
      const onMachine = guestTmpPath("wsp-state");
      let listed = false;
      try {
        const homes = guestAgentHomes();
        const listing = stateListing(homes, o.source, onMachine, o.agents);
        const at = await o.lander.probe(o.dest);
        if (at !== undefined && o.replace !== true) throw destExists(o.dest, at.files);
        report("packing", `Packing ${o.source} on the machine.`);
        const archive = join(scratch, "folder.tgz");
        const folder = await exportFolder(entry.machine, o.source, o.lander.caches, archive, { timeoutMs: 600_000, onProgress: downloading("The folder") });
        let found = { exitCode: 0, stdout: "", stderr: "" };
        if (listing !== "") {
          listed = true;
          found = await entry.machine.run(listing, { deadlineMs: LISTING_DEADLINE_MS });
        }
        if (found.exitCode !== 0) throw new Error(`could not look for agent state on the machine: ${found.stderr.slice(-200)}`);
        const { paths: present, unread } = parseStateListing(found.stdout);
        let state: LandRequest["state"];
        if (present.length > 0) {
          report("packing", `Packing the agents' state for it on the machine.`);
          const stateArchive = join(scratch, "state.tgz");
          // A copy travels at the path it mirrors under the scratch root, so the archive is the homes as the project alone left them.
          const groups = [
            { root: "/", paths: present.filter(p => !underProject(p, onMachine)) },
            { root: onMachine, paths: present.filter(p => underProject(p, onMachine)) },
          ].filter(g => g.paths.length > 0);
          await exportPathsInto(entry.machine, groups, stateArchive, { timeoutMs: 600_000, onProgress: downloading("Agent state") });
          state = { archive: stateArchive, homes, ...(o.agents !== undefined ? { agents: o.agents } : {}) };
        }
        report("landing", `Landing at ${o.dest}.`);
        const landed = await o.lander.land({ source: o.source, dest: o.dest, replace: o.replace === true, archive, ...(state !== undefined ? { state } : {}), ...(unread.length > 0 ? { unread } : {}) });
        const outcomes = landed.agents.map(homeOutcome);
        const caches = folder.excluded.length === 0 ? "" : `; ${plural(folder.excluded.length, "cache")} left behind`;
        report("done", `${plural(landed.files, "file")}, ${fmtBytes(landed.bytes)}, landed at ${o.dest}${caches}; ${outcomes.length === 0 ? "no agent sessions for it on the machine" : `sessions: ${outcomes.join(", ")}`}.`);
        return { dest: o.dest, files: landed.files, bytes: landed.bytes, excluded: folder.excluded, agents: landed.agents.map(({ name: _name, ...a }) => a) };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        if (listed) await entry.machine.exec(`rm -rf ${shellQuote(onMachine)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };

  /** Why a machine cannot be asked anything at all this tick: it stands on a computer that is not connected. Every
   * road to it, the provider read included, rides that computer's link, so the row says so rather than reading a
   * silence as a machine that died. */
  const awayLine = (record: WorkspaceRecord): string | undefined => {
    const at = workspacePlace(record);
    if (at === undefined || placeDoor === undefined || placeDoor.link(at) !== undefined) return undefined;
    return absentComputer(placeDoor.nameOf(at), null).sentence;
  };

  /** A nap, a pause the poll adopts or a gone verdict moves the phase, and the sentence was about the phase it left. */
  const deleteLine = (e: LiveWorkspace): string | undefined => (e.deleteSaid?.phase === e.record.phase ? e.deleteSaid.line : undefined);

  const status = createStatusTracker({
    store,
    records: async () => {
      await ready();
      return held().map(e => ({
        ...view(e.record),
        size: e.record.size,
        // The rate follows the machine's kind: a local workspace's backend prices it at zero, so no cost line rides its row.
        rateUsdPerHour: backendFor(e.record).pricing.rateUsdPerHour(e.record.size),
        generation: e.generation,
        // The wake's own line while one is in flight, and the words it left behind once its asking ran out: the poll
        // builds every status from the record, so a row that carried only what was pushed would fall silent between
        // two asks and forget the rebuild road at the next tick. A delete the provider sat on outranks both.
        // A pause the provider refused stays on the row as long as it stands, for the same reason.
        ...(deleteLine(e) ?? e.wakeSaid ?? e.record.wakeRefused ?? napRefusedReason(e)) !== undefined ? { reason: (deleteLine(e) ?? e.wakeSaid ?? e.record.wakeRefused ?? napRefusedReason(e))! } : {},
        ...(e.wakeAsk !== undefined ? { wakeAsk: e.wakeAsk } : {}),
        ...(e.record.phase === "running" && idle.idleAt(e.record.id) !== undefined ? { idleAt: idle.idleAt(e.record.id)! } : {}),
        ...(awayLine(e.record) !== undefined ? { away: awayLine(e.record)! } : {}),
        ...(unreachedOf(e) !== undefined ? { unreached: unreachedOf(e)! } : {}),
        ...(moduleOf(e.record.kind).hasDaemon(e) ? { daemonReach: () => moduleOf(e.record.kind).daemonRoad(e) } : {}),
        ...(e.machine.daemonAnswers !== undefined ? { daemonAnswers: e.machine.daemonAnswers.bind(e.machine) } : {}),
        providerState: () => e.machine.state(),
        ...(e.machine.metrics !== undefined ? { metrics: e.machine.metrics.bind(e.machine) } : {}),
        // A machine the poll last found unreachable is not asked what it is: over ssh that read is a dial of its
        // own, so a box that is off would pay one every tick beside the dial the reach already makes.
        ...(e.machine.facts !== undefined && reachOf(e) !== "unreachable" ? { facts: e.machine.facts.bind(e.machine) } : {}),
        exec: (cmd, o) => e.machine.exec(cmd, o),
      }));
    },
    emit: e => bus.emit(e),
    on: (type, l) => bus.on(type, l),
    // Every tick, not every change: this is where the runtime learns what its machines' reach actually is, and a
    // machine parked in one state is the case both readers of it exist for.
    onPolled: statuses => {
      for (const s of statuses) {
        const entry = live.get(s.id);
        if (entry === undefined || s.machineId !== entry.machine.id) continue;
        if (s.phase === "running") polledReach.set(s.id, { machineId: s.machineId, reach: s.reach.state });
        else polledReach.delete(s.id);
        reviveDaemon(entry, s.reach.state);
        offerDaemonAgain(entry, s);
        readVersionAgain(entry, s);
      }
    },
    ...(opts.status !== undefined ? { defaults: opts.status } : {}),
    clock,
  });

  /** A workspace machine of this setup's that no record claims is recorded again, never killed: its record was lost
   * (a store the machine outlived), and it bills until a person can see and delete it. The row is confirmed with one
   * get(), so a row the listing lags on after a kill is skipped; a create in flight elsewhere is left its minute. A
   * row the provider would not confirm (a failed read, a state that is neither running nor paused) is claimed in
   * `known` all the same, so the engine spares it this sweep and the next one records it: a kill never rides on one read. */
  const adoptLost = async (listing: ListedMachine[], known: Set<string>, failed: ReapFailure[]): Promise<AdoptedMachine[]> => {
    const adopted: AdoptedMachine[] = [];
    const now = Date.now();
    for (const row of listing) {
      if (known.has(row.id) || !lostWorkspace(row, owner, now)) continue;
      let machine: Machine;
      try {
        machine = observed(await backend.get(row.id));
      } catch (e) {
        if (isMissing(e)) continue;
        known.add(row.id);
        failed.push({ id: row.id, message: `not recorded: ${e instanceof Error ? e.message : String(e)}; retried next sweep` });
        continue;
      }
      const state = machine.seen?.state ?? (await machine.state());
      if (state !== "running" && state !== "paused") {
        known.add(row.id);
        continue;
      }
      // A stamped id another machine now holds is a body a rebuild or a wake replaced and failed to stop: the engine kills it.
      const stamped = row.labels[WORKSPACE_LABEL];
      if (stamped !== undefined && live.has(stamped)) continue;
      const id = stamped ?? `ws_${randomBytes(4).toString("hex")}`;
      // The name a person typed here outranks the one the fork stamped: the label is what the machine was forked
      // under, and no provider road updates it.
      const kept = stamped === undefined ? undefined : ((await store.get(WORKSPACE_NAMES, stamped)) as NamedWorkspace | undefined);
      const named = kept?.name ?? row.labels[NAME_LABEL];
      // A workspace is one project's copy, so a machine whose project this host cannot name is not a workspace
      // here: it is reported rather than recorded, and the sweep's own --older-than is the road that ends it.
      if (kept?.project === undefined || !projectsHeld.has(kept.project)) {
        known.add(row.id);
        failed.push({ id: row.id, message: `not recorded: this host holds no project for it, and a workspace is one project's copy; it is a machine of yours still running` });
        continue;
      }
      const bornAt = row.labels[CREATED_AT_LABEL];
      const record: WorkspaceRecord = {
        id,
        name: named !== undefined && nameRefusal(named) === undefined ? named : row.id,
        kind: "cloud",
        project: kept.project,
        machineId: row.id,
        phase: state === "paused" ? "napping" : "running",
        golden: row.labels[GOLDEN_LABEL] ?? goldenHead(await golden.get())?.snapshotId ?? "",
        createdAt: bornAt !== undefined && !Number.isNaN(Date.parse(bornAt)) ? bornAt : new Date().toISOString(),
        spec: { labels: row.labels },
        size: sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize),
        firstLife: false,
        ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
      };
      const entry = attach(record, machine);
      await persist(record);
      if (record.phase === "running") void syncDaemon(entry);
      bus.emit({ type: "workspace.created", workspace: view(record) });
      await emitStatus(entry, record.phase === "running" ? reachOf(entry) : "napping", RECORD_RESTORED);
      adopted.push({ id: row.id, workspaceId: id, name: record.name, phase: record.phase });
    }
    return adopted;
  };

  // Sets run one after another: two clients patching different fields at once would otherwise each read the record
  // before the other's write and the later write would drop the earlier field.
  let preferenceWrites: Promise<unknown> = Promise.resolve();
  // Read once, here, and stamped on every read: a state file that holds an older labs cannot outvote the environment.
  const labs = labsFromEnv(opts.env ?? process.env);
  /** The record is kept whether or not the folder goes; a folder that stays is said on the reply. */
  const iconsForgotten = (): string | undefined => {
    const icons = opts.serverIcons;
    if (icons === undefined) return undefined;
    try {
      icons.forget();
      return undefined;
    } catch (e) {
      // Node's own words carry the code before and the call and path after: "EACCES: permission denied, rmdir '/x'".
      const said = e instanceof Error ? e.message.replace(/^[A-Z]+: /, "").replace(/, \w+ '[^']*'$/, "") : String(e);
      return serverIconsLeftLine(homeShortened(icons.folder, homedir()), said);
    }
  };
  const preferences: Runtime["preferences"] = {
    get: async () => ({ ...preferencesFrom(await store.get(PREFERENCES, PREFERENCES_ID)), labs }),
    set: patch => {
      const write = preferenceWrites.then(async () => {
        const next = applyPreferencesPatch(await preferences.get(), patch);
        await store.put(PREFERENCES, PREFERENCES_ID, next);
        const notice = patch.serverIcons === false ? iconsForgotten() : undefined;
        bus.emit({ type: "preferences.changed", preferences: next });
        return notice === undefined ? { preferences: next } : { preferences: next, notice };
      });
      preferenceWrites = write.catch(() => undefined);
      return write;
    },
  };

  const iconsOn = async (): Promise<boolean> => (await preferences.get()).serverIcons;
  const agentsRead = agentsReads<Caller>({
    reader: opts.agentsReader,
    places: () => placeDoor,
    workspace: async (id, origin) => {
      const entry = await entryOf(id, origin);
      const project = projectHeld(entry.record.project);
      return { name: entry.record.name, phase: entry.record.phase, local: isLocalWorkspace(entry.record), machine: entry.machine, project: { id: project.id, name: project.name, path: checkoutOf(entry.record) } };
    },
    // A project's folder on the computer holding it: the checkout the add left there, else where it already sits.
    projects: async placeId => (await ready(), [...projectsHeld.values()].filter(p => p.computer === placeId).map(p => ({ id: p.id, name: p.name, path: p.checkout ?? p.path }))),
    ...(opts.agentsActs !== undefined ? { acts: opts.agentsActs } : {}),
    ...(opts.skillsActs !== undefined ? { skills: opts.skillsActs } : {}),
    ...(opts.serversActs !== undefined ? { servers: opts.serversActs } : {}),
    latestOn: async () => (await preferences.get()).agentVersions,
    // The person's switch is read at every ask, so turning it off stops the next one.
    ...(opts.serverIcons !== undefined ? { icons: { folder: opts.serverIcons.folder, icon: async (host, refresh) => ((await iconsOn()) ? opts.serverIcons!.icon(host, refresh, iconsOn) : null), forget: () => opts.serverIcons!.forget() } satisfies ServerIcons } : {}),
    // The target's own daemon: this computer's, a joined computer's over the link it holds, or a workspace's by the
    // road its kind answers, which is the one reading every pane takes.
    channel: async (target, onEvent, origin) => {
      if ("workspaceId" in target) return workspaces.daemonChannel(target.workspaceId, onEvent, origin);
      if (target.placeId === HERE_PLACE_ID) return channelOver(await localRoad(), THIS_COMPUTER, onEvent);
      const onLink = placeDoor?.channel(target.placeId, onEvent);
      if (onLink === undefined) throw new Error(absentComputer(placeDoor?.nameOf(target.placeId) ?? target.placeId, null).sentence);
      return onLink;
    },
    changed: target => bus.emit({ type: "agents.changed", ...(target !== undefined ? { target } : {}) }),
    relayed: () => backend.capabilities.callbackRelay,
    now: () => clock.now(),
  });
  bus.on("workspace.deleted", e => {
    if (e.type === "workspace.deleted") agentsRead.forget(e.workspaceId);
  });

  return {
    events: bus,
    backend,
    workspaces,
    projects,
    sessions: sessionsApi,
    devices: deviceDoor,
    ...(placeDoor !== undefined ? { places: placeDoor } : {}),
    hereChannel: async onEvent => channelOver(await localRoad(), THIS_COMPUTER, onEvent),
    agents: agentsRead,
    preferences,
    status: {
      ...status,
      // Which workspaces this caller is served is decided here, after the probes, off the same reading the other
      // listing and every verb take: a record dropped while the probes ran leaves both lists at once, so nothing a
      // person is shown is denied by the next line they type.
      list: async (o, origin) => {
        const rows = await status.list(o);
        const shown = new Set(listedFor(origin).map(e => e.record.id));
        return rows.filter(row => shown.has(row.id));
      },
      // A cost read answers for a workspace this host no longer holds, which is why the rule for a named id is read
      // here rather than through entryOf, which refuses an id it does not know.
      history: async (workspaceId, origin) => {
        refuseNamed(workspaceId, origin);
        return status.history(workspaceId);
      },
    },
    harnesses: {
      list: async (workspaceId, origin) => {
        // Only a harness with an adapter can run a turn; the rest of the table waits for one.
        const table = HARNESS_CATALOGS.filter(c => c.harness in adapters);
        if (workspaceId === undefined) return table.map(markDefault);
        const entry = await entryOf(workspaceId, origin);
        // A record answers what its threads start at whether or not its machine is up; only the rest of the lists
        // waits on the binary, so a picker on a paused workspace still reads the access its next thread would run.
        if (entry.record.phase !== "running") return table.map(c => markDefault(workspaceAccess(c, entry.record.kind)));
        return Promise.all(table.map(c => catalogOn(c, entry, adapterFor(entry, c.harness).adapter).then(markDefault)));
      },
    },
    golden,
    image,
    owner: async () => {
      await ready();
      return owner;
    },
    reap: async (olderThanMs, say) => {
      if (say !== undefined) sayStops = say;
      await ready();
      await refreshBuilders();
      // A stale record can never seal; stopping it is the only thing that ends its bill. A reusable one no
      // process is using dies at six hours by our createdAt label, or at once when no age can be read: every
      // get(id) on it resets the provider's rolling idle timer (measured), so the kill it was created with
      // never fires while a host is up. Own builders get their heartbeat here, so other processes leave them be.
      const failed: ReapFailure[] = [];
      const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      const grace = await expireGrace().catch((e: unknown) => {
        failed.push({ message: `grace sweep: ${messageOf(e)}` });
        return { reaped: [], failed: [] };
      });
      const reaped: ReapedMachine[] = grace.reaped;
      failed.push(...grace.failed);
      const now = Date.now();
      for (const b of [...builders.values()]) {
        if (b.life === "own") await hold(b);
        const bornAt = Date.parse(b.builder.machine.labels?.[CREATED_AT_LABEL] ?? b.record.createdAt);
        const ageMs = Number.isNaN(bornAt) ? undefined : now - bornAt;
        const expired = b.life === "reusable" && (ageMs === undefined || ageMs >= BUILDER_IDLE_MS);
        if (b.life !== "stale" && !expired) continue;
        try {
          await gone.stop(backend, b.builder.machine);
        } catch (e) {
          failed.push({ id: b.record.id, message: `could not stop: ${messageOf(e)}; stays recorded, retried next sweep` });
          continue;
        }
        await forgetBuilder(b.record.id);
        reaped.push(
          b.life === "stale"
            ? { id: b.record.id, builder: true, reason: b.record.building === true ? "unfinished" : "recorded" }
            : { id: b.record.id, builder: true, reason: "expired", ...(ageMs !== undefined ? { ageMs } : {}) },
        );
      }
      const knownIds = (): string[] => [...live.values()].flatMap(e => [e.record.machineId, e.machine.id]).concat([...builders.keys()], [...inflight], reaped.map(r => r.id), gone.ids());
      const result = (swept: ReapResult, adopted: AdoptedMachine[]): SweepResult => {
        const allFailed = failed.concat(swept.failed ?? []);
        return { reaped: reaped.concat(swept.reaped), spared: swept.spared, ...(allFailed.length > 0 ? { failed: allFailed } : {}), ...(adopted.length > 0 ? { adopted } : {}) };
      };
      // One listing serves both halves of the sweep: the machines recorded again, then what the engine kills or spares.
      let listing: ListedMachine[];
      try {
        listing = await backend.list();
      } catch (e) {
        failed.push({ message: messageOf(e) });
        return result({ reaped: [], spared: [] }, []);
      }
      // A recorded machine the listing lacks is read once: the listing is best effort, so only the read decides, and a
      // read that finds the machine gone settles its record here rather than at the next poll or verb.
      const listed = new Set(listing.map(row => row.id));
      for (const entry of [...live.values()]) {
        if (entry.creating || entry.napping || entry.waking || entry.deleting) continue;
        if (isAbsentMachine(entry.machine)) {
          await rereadHeld(entry.record.id, "sweep").catch((e: unknown) => void failed.push({ message: messageOf(e) }));
          continue;
        }
        // A machine the listing still carries under a record marked gone is read once: the read is what decides,
        // and one that says running gives the record its machine back.
        if (listed.has(entry.record.machineId)) {
          if (entry.record.phase === "gone") await recoverGone(entry);
          continue;
        }
        if (entry.record.phase === "gone") continue;
        let answer: string | undefined;
        const read = await entry.machine.state().catch((e: unknown) => {
          if (!isMissing(e)) return undefined;
          answer = providerSaid(e);
          return "gone";
        });
        if (read === "gone") await adoptGone(entry, goneWords(entry.record.machineId, { by: "sweep", at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
      }
      const claimed = new Set(knownIds());
      const adopted = await adoptLost(listing, claimed, failed);
      try {
        return result(await reap({ backend, owner, listing, stop: m => gone.stop(backend, m), knownIds: () => [...knownIds(), ...claimed], ...(olderThanMs !== undefined ? { olderThanMs } : {}) }), adopted);
      } catch (e) {
        failed.push({ message: messageOf(e) });
        return result({ reaped: [], spared: [] }, adopted);
      }
    },
    close: async () => {
      idle.close();
      // What this host started on a machine finishes before it lets that machine go: the boot fires a daemon sync
      // at every running workspace without waiting for it, and a write landing after the close is this process
      // touching a computer it no longer holds. Each sync is a read and a write, so the wait is milliseconds.
      await Promise.allSettled([...daemonSyncs.values()]);
      // The turns running on machines are not ended: each leads a process group on its own machine and its log is
      // there to be read again, so what this host lets go of is the reading of them, which is what holds this
      // process open after its last line.
      for (const stop of [...machineReading]) stop();
      machineReading.clear();
      await local?.close?.();
      await placeDoor?.close();
      closed = true;
      beat?.();
      beat = undefined;
      for (const cancel of graceTimers.values()) cancel();
      graceTimers.clear();
      gone.close();
      await ticking;
      // A clean exit frees its builders at once; a crash leaves the heartbeat to age and the pid to die.
      for (const b of [...builders.values()].filter(b => b.life === "own" && b.record.heldBy !== undefined)) {
        delete b.record.heldBy;
        await store.put(BUILDERS, b.record.id, b.record);
      }
      for (const id of [...transcriptTimers.keys()]) void flushTranscript(id);
      await Promise.all([...transcriptFlushes.values(), ...indexFlushes.values()]);
    },
  };
}
