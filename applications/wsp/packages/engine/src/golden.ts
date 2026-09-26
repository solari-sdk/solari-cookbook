// SPDX-License-Identifier: AGPL-3.0-only
// Golden images in two halves so the scripted pipeline and the first-run
// wizard share one road: prepareBuilder boots a fresh machine and installs the
// harness (nothing personal on it yet); sealGolden snapshots it, proves the
// snapshot boots by smoke-testing a fork, and appends a manifest version.
// Between the halves a person may sit on the builder's live screen for as
// long as they like, as long as nobody pauses it (snapshot-fresh rule).

import { createHash } from "node:crypto";
import { NEVER_IN_IMAGE, ROAD_STEPS } from "@wsp/catalog";
import { ALREADY_APPLIED, DISK_SYNC_LINE, MCP_ID_PREFIX, credentialOnBuilderLine, diskUnsettledLine, SAVING_IMAGE_LINE, SNAPSHOT_GONE_REASON, fmtBytes, goldenHead, goldenImage, machineLeftLine, snapshotAttemptLine, snapshotFailedLine, snapshotProgressLine, snapshotStageLine, templateFailedLine, templateStatusLine, templateWaitedLine, pinsReadLine, type GoldenBaseTool, type GoldenLeftBehind, type GoldenLogin, type GoldenManifest, type GoldenMissingTool, type GoldenRetired, type GoldenStage, type GoldenStep, type GoldenVersion, type BuilderReading, type ProviderAnswer, type RecipeDigest, type ToolPin } from "@wsp/protocol";
import { nameOf, rungOf } from "./golden-diff.js";
import { AGENT_INSTALLERS, NODE_PATH_LINE, TOOLS_PATH, type AgentInstall, type LoginShell, type NodeInstall, type ShellInstall, type SkippedPath, type ToolInstall } from "./golden-import.js";
import { PRELUDE } from "./dotfiles-presets.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { DiskSyncError, diskUnsettled, syncDisk } from "./disk-sync.js";
import { MIB, closing, freeBytes, freeNote, guardDeadlineMs, guarded, installTools, pinRead, plural, reasonOf, sweepCaches, usedBytes, withRecordedPins, type ToolResult } from "./golden-tools.js";
import { installBase } from "./golden-base.js";
import { applyMcp, mcpTally, type McpPlan, type McpResult } from "./golden-mcp.js";
import { BROWSER_SHIM_PATH, applyMachineContext, type ContextResult } from "./machine-context.js";
import type { Machine, MachineBackend, MachineKind, MachineState, TemplateRow } from "./machine.js";
import { isAccountRefusal, isMissing, NotFirstLifeError } from "./errors.js";
import { BUILDER_LABEL, CREATED_AT_LABEL, SMOKE_LABEL } from "./labels.js";
import { goldenName } from "./snapshot-names.js";
import { recipeOwnedFiles } from "./recipe-owned.js";
import { exportImageVault, presentPaths, type ImageVault } from "./image-vault.js";
import { importInto } from "./vault.js";

export { goldenHead, type GoldenLeftBehind, type GoldenLogin, type GoldenManifest, type GoldenMissingTool, type GoldenStage, type GoldenVersion };

/** `left` names the machines the stage made and could not remove; only a failure that tried to clean up carries it. */
export type StageListener = (stage: GoldenStage, detail?: string, step?: GoldenStep, left?: readonly string[]) => void;

/** How long to wait for the provider to report a killed machine gone before
 * killing again; KILL_ASKS rounds, then the caller fails. Tests shrink both. */
export interface KillConfirm {
  graceMs?: number;
  pollMs?: number;
}

/** How long a delete is read back for when the caller names no window. */
export const KILL_GRACE_MS = 30_000;

/** A machine that answered KILL_ASKS kills with a success status and is still there.
 * Typed so the wizard can say "still billing, reap it" rather than "try again". */
export class MachineAliveError extends Error {
  readonly kind = "machineAlive" as const;
  constructor(
    readonly machineId: string,
    readonly state: MachineState,
  ) {
    super(`machine ${machineId} is still ${state} after three kills; it bills until reap or a kill by hand takes`);
    this.name = "MachineAliveError";
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How often the seal asks for the snapshot the provider refused with its 502, and how long it waits between asks. */
export const SNAPSHOT_ATTEMPTS = 3;
export const SNAPSHOT_RETRY_MS = 60_000;

/** The snapshot was refused on every attempt the seal was willing to make, or the builder stopped reading running
 * between them, or the provider would not say. Typed so the wizard's words follow what the provider said: only a
 * builder it answers 404 for is gone at the provider's hand; every other one is left as it was. */
export class SnapshotFailedError extends Error {
  readonly kind = "snapshotFailed" as const;
  constructor(
    readonly machineId: string,
    readonly attempts: number,
    readonly answer: ProviderAnswer,
    readonly builderState: BuilderReading,
    /** Why the builder went unread: the GET's own failure. */
    readonly readError?: string,
  ) {
    super(snapshotFailedLine(attempts, answer, builderState, readError));
    this.name = "SnapshotFailedError";
  }
}

/** The builder holds a file a sign-in leaves behind, read off it before the snapshot. Typed as a failure that
 * leaves the builder, the way a refused snapshot does: nothing on it was touched. */
export class CredentialOnBuilderError extends Error {
  readonly kind = "credentialOnBuilder" as const;
  constructor(readonly paths: readonly string[]) {
    super(credentialOnBuilderLine(paths));
    this.name = "CredentialOnBuilderError";
  }
}

const isSnapshotRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "snapshotUnavailable";
/** The provider's answer as the failure line reports it. A refusal carries its status; a failure that came with none
 * (a job the far side failed, a link that dropped) is reported as the provider's 500, since the provider's side is
 * where it stopped. */
export const answerOf = (e: unknown): ProviderAnswer => {
  const { status, requestId } = e as { status?: number; requestId?: string };
  return { status: status ?? (isSnapshotRefusal(e) ? 502 : 500), message: messageOf(e), ...(requestId !== undefined ? { requestId } : {}), at: new Date().toISOString() };
};
/** What the provider says the machine is now, one read: a 404 reads as gone, any other failed read as unread with its reason. */
const readState = async (machine: Machine): Promise<{ state: BuilderReading; readError?: string }> => {
  try {
    return { state: await machine.state() };
  } catch (e) {
    return isMissing(e) ? { state: "gone" } : { state: "unread", readError: messageOf(e) };
  }
};

/** How many reads in a row must answer gone before a kill is done, and how often the kill is asked. Measured
 * 2026-09-26: the gateway's copies disagreed call to call, and seven of eleven machines wsp had read gone once kept
 * running; at that skew twelve reads and three asks let fewer than one delete in sixty say gone wrongly. */
export const GONE_READS = 12;
export const KILL_ASKS = 3;

/** The provider's kill acknowledges the request, not the machine's death: a live
 * wizard run reported its seal done and the builder was still running 25 minutes
 * later, so a kill is only done once the machine reads gone GONE_READS times in a
 * row. The copies disagree per call, not per second, so those reads follow each
 * other straight away; one that reads the machine alive after a gone one means the
 * ask went to a copy that never held it, and the kill is asked again at once. */
export async function killUntilGone(backend: MachineBackend, machine: Machine, confirm: KillConfirm = {}): Promise<void> {
  await readBackGone(backend, machine, confirm);
}

/** One read of a machine: the state it answered, and the handle it came on when the provider found it. */
export interface Sighting {
  state: MachineState;
  machine?: Machine;
}

/** One call per read: a second call for the state can land on the other copy and read gone. */
const readOnce = (backend: MachineBackend, id: string): Promise<Sighting> =>
  backend
    .get(id)
    .then(async machine => ({ state: machine.seen?.state ?? (await machine.state()), machine }))
    .catch((e: unknown) => (isMissing(e) ? { state: "gone" as const } : Promise.reject(e)));

/** Whether the provider still has a machine, asking nothing of it: gone once GONE_READS reads in a row answer gone,
 * else the first read that found it, with its handle. A failed read that is not a 404 rejects. */
export async function sightMachine(backend: MachineBackend, id: string): Promise<Sighting> {
  for (let gone = 0; gone < GONE_READS; gone++) {
    const seen = await readOnce(backend, id);
    if (seen.state !== "gone") return seen;
  }
  return { state: "gone" };
}

/** The state sightMachine answers, for a caller that needs no handle. */
export const readGone = async (backend: MachineBackend, id: string): Promise<MachineState> => (await sightMachine(backend, id)).state;

/** One background round: whether the first kill was sent already, and whether the watch is still open. */
interface WatchRound {
  asked: boolean;
  live: () => boolean;
}

/** killUntilGone's rule. Under a watch's round it resolves false as soon as the watch closes, sends nothing after,
 * and holds no timer that keeps the process open. */
async function readBackGone(backend: MachineBackend, machine: Machine, confirm: KillConfirm, round?: WatchRound): Promise<boolean> {
  const live = round?.live ?? (() => true);
  const graceMs = confirm.graceMs ?? KILL_GRACE_MS;
  const pollMs = confirm.pollMs ?? 1_000;
  let alive: MachineState = "running";
  for (let attempt = 0; attempt < KILL_ASKS; attempt++) {
    if (!live()) return false;
    if (attempt > 0 || round?.asked !== true)
      await machine.kill().catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
    const deadline = Date.now() + graceMs;
    let gone = 0;
    do {
      if (!live()) return false;
      const { state } = await readOnce(backend, machine.id);
      if (state === "gone") {
        if (++gone >= GONE_READS) return true;
        continue;
      }
      alive = state;
      if (gone > 0) break;
      await new Promise(r => {
        const timer = setTimeout(r, pollMs);
        if (round !== undefined) timer.unref?.();
      });
    } while (Date.now() < deadline || gone > 0);
  }
  throw new MachineAliveError(machine.id, alive);
}

/** How long a background stop whose read-back ended with the machine still there waits before asking again. */
export const GONE_RETRY_MS = 60_000;

export interface GoneWatchOptions {
  confirm?: KillConfirm;
  retryMs?: number;
  warn?: (line: string) => void;
}

/** Stops for the sweeps that never wait on a machine. A stop resolves once the provider takes the first ask, so a
 * failure to ask still reaches the sweep; killUntilGone's rule reads it back behind that, and asks again every
 * retryMs for as long as the machine is still there, until the watch closes or the provider refuses the account. */
export class GoneWatch {
  private readonly watching = new Map<string, Promise<void>>();
  private readonly wakers = new Set<() => void>();
  private closed = false;

  constructor(private readonly opts: GoneWatchOptions = {}) {}

  async stop(backend: MachineBackend, machine: Machine): Promise<void> {
    await machine.kill().catch((e: unknown) => {
      if (!isMissing(e)) throw e;
    });
    if (this.closed || this.watching.has(machine.id)) return;
    this.watching.set(machine.id, this.untilGone(backend, machine).finally(() => this.watching.delete(machine.id)));
  }

  /** Machines asked to stop that have not yet read gone. */
  ids(): string[] {
    return [...this.watching.keys()];
  }

  /** Resolves once every machine watched now has read gone, been given up on, or had its round cut by close(); a
   * request already sent when close() ran still lands. */
  async settled(): Promise<void> {
    await Promise.all([...this.watching.values()]);
  }

  close(): void {
    this.closed = true;
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  private async untilGone(backend: MachineBackend, machine: Machine): Promise<void> {
    const retryMs = this.opts.retryMs ?? GONE_RETRY_MS;
    const warn = this.opts.warn ?? console.warn;
    for (let asked = 0; !this.closed; asked++) {
      try {
        const gone = await readBackGone(backend, machine, this.opts.confirm ?? {}, { asked: asked === 0, live: () => !this.closed });
        if (gone && asked > 0) warn(`machine ${machine.id} read gone after asking again`);
        return;
      } catch (e) {
        if (isAccountRefusal(e)) {
          warn(`${messageOf(e)}; not asked again, the next start's sweep stops machine ${machine.id}`);
          return;
        }
        warn(`${messageOf(e)}; asking again in ${Math.round(retryMs / 1000)} s`);
      }
      if (this.closed) return;
      await new Promise<void>(resolve => {
        const wake = (): void => {
          clearTimeout(timer);
          this.wakers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, retryMs);
        timer.unref?.();
        this.wakers.add(wake);
      });
    }
  }
}

/** What a snapshot's delete came to once read back: gone off the listing, already lost at the provider, or still
 * listed when the window it was read for ran out. */
export type SnapshotDeleted = { verdict: "deleted" | "missing" } | { verdict: "listed"; graceMs: number };

/** A snapshot's delete is read back the way a machine's kill is, under the same window: the listing is best-effort
 * and may still hold an id the delete took, so it is read until the id leaves, and a read that fails counts as one
 * that still holds it. A backend with no listing answers on the DELETE alone; a refusal other than missing throws. */
export async function snapshotUntilGone(backend: MachineBackend, snapshotId: string, confirm: KillConfirm = {}): Promise<SnapshotDeleted> {
  try {
    await backend.deleteSnapshot(snapshotId);
  } catch (e) {
    if (isMissing(e)) return { verdict: "missing" };
    throw e;
  }
  const list = backend.capabilities.snapshotListing ? backend.listSnapshots : undefined;
  if (list === undefined) return { verdict: "deleted" };
  const graceMs = confirm.graceMs ?? KILL_GRACE_MS;
  const deadline = Date.now() + graceMs;
  do {
    const rows = await list.call(backend).catch(() => undefined);
    if (rows !== undefined && !rows.some(r => r.id === snapshotId)) return { verdict: "deleted" };
    await new Promise(r => setTimeout(r, confirm.pollMs ?? 1_000));
  } while (Date.now() < deadline);
  return { verdict: "listed", graceMs };
}

/** The template calls of a backend whose capabilities say it has them, or nothing: the one read of that flag, so a
 * backend without templates keeps every version on its snapshot on every road. */
export function templatesOf(backend: MachineBackend): Templates | undefined {
  if (!backend.capabilities.templates) return undefined;
  const { promoteSnapshot, getTemplate, listTemplates, deleteTemplate } = backend;
  if (promoteSnapshot === undefined || getTemplate === undefined || listTemplates === undefined || deleteTemplate === undefined) return undefined;
  return {
    promote: (snapshotId, name) => promoteSnapshot.call(backend, snapshotId, name),
    get: id => getTemplate.call(backend, id),
    list: () => listTemplates.call(backend),
    delete: id => deleteTemplate.call(backend, id),
  };
}

export interface Templates {
  promote(snapshotId: string, name: string): Promise<string>;
  get(id: string): Promise<TemplateRow>;
  list(): Promise<TemplateRow[]>;
  delete(id: string): Promise<void>;
}

/** How long a promoted template may read building before the seal gives up (a promotion reads ready at once per the
 * provider's reference; the wait covers a slower day), and how often it is read. Tests shrink both. */
export const TEMPLATE_READY_MS = 5 * 60_000;
export const TEMPLATE_POLL_MS = 3_000;

export interface TemplateWait {
  readyMs?: number;
  pollMs?: number;
  /** Each read of the template, in the promoting stage's words. */
  onStatus?: (line: string) => void;
}

/** Reads the template until the provider says ready. A failed template or one still building at the deadline is an
 * error with the provider's words: forks would have nothing durable to boot from. */
export async function awaitTemplate(templates: Templates, templateId: string, wait: TemplateWait): Promise<void> {
  const readyMs = wait.readyMs ?? TEMPLATE_READY_MS;
  const start = Date.now();
  for (;;) {
    const row = await templates.get(templateId);
    wait.onStatus?.(templateStatusLine(row.status));
    if (row.status === "ready") return;
    if (row.status === "failed") throw new Error(templateFailedLine(templateId, row.error));
    if (Date.now() - start >= readyMs) throw new Error(templateWaitedLine(templateId, row.status, readyMs));
    await new Promise(r => setTimeout(r, wait.pollMs ?? TEMPLATE_POLL_MS));
  }
}

/** A fresh template for a version, promoted from its snapshot and ready: the one promote road, for the seal and the
 * doctor alike. A template names no source snapshot, so none the provider already holds under the name is ever taken
 * as this version's; the listing is read only to say how many carry the name already, and a listing the provider
 * will not give leaves the count out. The provider's 404 on the promote is its word that the snapshot is gone. A
 * template whose wait fails or runs out is deleted before the failure is thrown, so nothing stands on the snapshot
 * unrecorded. */
export async function promoteVersion(templates: Templates, snapshotId: string, name: string, wait: TemplateWait = {}): Promise<{ templateId: string; sharing?: number }> {
  const sharing = await templates.list().then(rows => rows.filter(t => t.name === name).length, () => undefined);
  let templateId: string;
  try {
    templateId = await templates.promote(snapshotId, name);
  } catch (e) {
    throw isMissing(e) ? new Error(SNAPSHOT_GONE_REASON) : e;
  }
  try {
    await awaitTemplate(templates, templateId, wait);
  } catch (e) {
    await templates.delete(templateId).catch(() => {});
    throw e;
  }
  return { templateId, ...(sharing !== undefined ? { sharing } : {}) };
}

/** The provider built-in templates a backend that names none of its own boots from; they are kind-specific
 * (Solari answers TemplateKindMismatch otherwise). */
const DEFAULT_TEMPLATE: Record<MachineKind, string> = { sandbox: "base", desktop: "default" };

/** What a machine of this kind boots from: the caller's word, else the image the backend names, else the built-in. */
const baseTemplateOf = (backend: MachineBackend, kind: MachineKind, named?: string): string => named ?? backend.baseTemplates?.[kind] ?? DEFAULT_TEMPLATE[kind];

/** The root disk every builder and fork asks for on this provider, where it asks for one at all: a container takes
 * no disk request, so the create carries no field rather than a figure from another provider's cap. */
const diskAsked = (backend: MachineBackend): { diskGb?: number } => {
  const diskGb = backend.pricing.builderDiskGb;
  return diskGb === undefined ? {} : { diskGb };
};

/** How long a builder may sit with no API activity before it is killed. Whether
 * a live noVNC stream counts as activity is unmeasured, so this covers a person
 * reading docs on the builder screen; a forgotten builder costs under $1 at
 * Starter rates over this window. */
export const BUILDER_IDLE_MS = 6 * 60 * 60_000;

export interface MachineSize {
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface PrepareBuilderOptions extends MachineSize {
  backend: MachineBackend;
  /** Default sandbox (the wizard shows a terminal on it); desktop streams a display instead. */
  kind?: MachineKind;
  baseTemplate?: string;
  /** Host-owned step (the daemon bundle lives outside the engine); skipped when
   * absent. A returned string is reported as the deploying-daemon detail. */
  deployDaemon?: (machine: Machine) => Promise<void | string>;
  /** Harness install; its sha is recorded in the manifest. */
  setup: string;
  /** The person's files, agents and tools: files after the daemon, agents with the harness, tools last. */
  import?: GoldenImport;
  /** The upload's transport; tests inject one. */
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** A first-life machine with the harness installed, waiting to be sealed. */
export interface Builder {
  readonly machine: Machine;
  readonly kind: MachineKind;
  readonly baseTemplate: string;
  readonly setupSha: string;
  readonly createdAt: string;
  /** False once the machine has ever been resumed; sealGolden refuses it then. */
  readonly firstLife: boolean;
  /** What the provider built, read back after create (it may clamp the request); the sealed version records it. */
  readonly size: { cpu: number; memMb: number };
  /** What of the recipe is on this machine; absent when it was built without an import. */
  readonly import?: ImportLedger;
  /** The golden snapshot this builder descends from, so the version it seals records its parent; absent on a fresh machine. */
  readonly parentSnapshotId?: string;
  /** The base tools' versions read on this machine after the base stage, or on the golden it was forked from. */
  readonly base?: GoldenBaseTool[];
  /** What this machine carries that its recipe no longer asks for, carried from the version it was forked from;
   * absent on a fresh machine, whose recipe asks for everything on it. */
  readonly retired?: GoldenRetired[];
}

// --- golden import: the person's files, tools and agents on the builder ------

/** An rc file the pack shipped without its secret exports: where it lands under the guest home and the names it lost. */
export interface CutNames {
  path: string;
  names: string[];
}

export interface PackedFiles {
  tar: Buffer;
  /** The archive's size, what the upload moves. */
  bytes: number;
  /** What the archive holds once extracted, what the guest disk has to take on top. */
  unpacked: number;
  skipped: SkippedPath[];
  /** The rc files stripped at pack time, so the checklist names what to set from what actually left. */
  cut: CutNames[];
  /** Commands the rc files call that the image does not have, once each; the pack defined each as a silent no-op. */
  silenced: string[];
  /** What became of each Mac path the copied files carried, once each: repointed at the image, or out of the file
   * where the image has no such place. */
  macPaths: string[];
  /** How many files the archive holds. */
  files?: number;
  /** The paths left out of the archive because the same bytes already stand where they would land, home-relative
   * and answered by the road that asked; empty where the pack was asked nothing, which is the image. */
  stood?: string[];
  /** The skips a fork should know about, stamped on the sealed version: a hook whose script did not travel. */
  leftBehind?: GoldenLeftBehind[];
}

/** One file staged for that computer as the archive would carry it: where it lands under the home there, and the
 * digest of the bytes after the pack's own rewrites, which is what would stand at that path once it landed. */
export interface StagedFile {
  dest: string;
  digest: string;
}

/** Asked of the pack between its rewrites and the archive by a road that can read the computer the files are going
 * to: the staged paths to leave out, because the same bytes are already there. Nothing is asked on the road to an
 * image, which has no computer to ask and packs every staged file. */
export type LeaveOut = (staged: readonly StagedFile[]) => Promise<readonly string[]>;

/** Builds the archive off this computer. A caller that can read the far side hands it the one question the pack
 * can answer and it cannot: which of the staged files need not travel at all. */
export type PackFiles = (leaveOut?: LeaveOut) => Promise<PackedFiles>;

export interface GoldenImport {
  /** Identifies the ticks this plan came from; a builder carrying the same hash needs nothing re-applied. */
  recipeHash: string;
  /** The parts behind recipeHash; recorded on the builder so a later run can say what changed. */
  recipe?: RecipeDigest;
  /** Absent when no file was ticked. `pack` reads this computer and builds the archive; it runs on applying-setup. */
  files?: {
    /** Files and secrets that will be packed; zero when every ticked path is gone from this computer. */
    count: number;
    rungs: Record<string, number>;
    bytes: number;
    /** Ticked paths the plan set aside (missing on disk, a private key), reported before packing. */
    skipped: SkippedPath[];
    /** Where each planned path lands under the guest's home, with the row it came from: the image extracts the
     * archive whole and needs none of it, a computer somebody owns lands them one at a time and answers a row each. */
    lands: readonly { id: string; label: string; dest: string }[];
    /** Builds the archive. */
    pack: PackFiles;
    /** The planned files a tool rewrites while it runs, `~`-relative: they never decide the hash, so an
     * attach uploads the latest copy again. Absent when none was ticked. */
    volatile?: { paths: string[]; pack: PackFiles };
  };
  /** The person's login shell and its frameworks, put on the machine before the files land. */
  shell?: ShellInstall;
  tools: ToolInstall[];
  /** Runs once before the agents when a ticked agent's engines floor may be above the base image's Node. */
  node?: NodeInstall;
  agents: AgentInstall[];
  /** Ticked agents the plan set aside (no installer, no pinned Node); they count as ticked and land in the result. */
  skippedAgents?: { id: string; name: string; note: string }[];
  /** Ticked tools the plan set aside (no Linux bottle, a macOS app); they land in the result with the installs. */
  skippedTools?: { id: string; label: string; note: string }[];
  /** Ticked tools the base stage already put on every golden; they land in the result as installed, with the planner's note. */
  baseTools?: { id: string; label: string; note: string }[];
  /** The MCP servers to keep in or take out of each agent's config once it is on the machine; absent when no row is one. */
  mcp?: McpPlan;
  /** Called once per prepare that ran anything; a re-run that skipped every stage has nothing to report. */
  onResult?: (result: ImportResult) => void;
  /** Called when a pass that reports no result wrote the machine context, so the saved result can take the write's
   * outcome in place of the one the build recorded. */
  onContext?: (outcome: Pick<ImportResult, "context" | "contextFailure">) => void;
}

export type ImportStage = "applying-setup" | "uploading-files" | "installing-tools" | "installing-harness" | "installing-mcp";

export interface ImportLedger {
  recipeHash: string;
  recipe?: RecipeDigest;
  applied: ImportStage[];
  /** The version checks of the agents that installed, joined; the seal runs this on the fork. */
  smoke: string;
  /** The tools the tools stage did not put on the image, skipped or failed, and why; absent when every tool installed.
   * The seal stamps it on the version. */
  missingTools?: GoldenMissingTool[];
  /** The rc calls the pack silenced, once each; absent when every call has a command behind it. The seal stamps it on the version. */
  silenced?: string[];
  /** What the login shell printed to stderr on its first interactive start after the files landed, as the version records it; absent when it started quiet. */
  shellNoise?: string;
  /** What the pack left off the image and why; absent when everything ticked travelled. The seal stamps it on the version. */
  leftBehind?: GoldenLeftBehind[];
}

export interface AgentResult {
  id: string;
  name: string;
  outcome: "installed" | "failed" | "skipped";
  note?: string;
  ms?: number;
  /** What the agent installed, read back once its version check passed; absent when the read printed nothing. */
  pin?: ToolPin;
}

export interface ImportResult {
  recipeHash: string;
  files?: { bytes: number; skipped: SkippedPath[]; cut?: CutNames[] };
  /** The Homebrew checkout the formulae installed under, when the tools stage put one on the machine. */
  homebrew?: { tag: string; commit: string };
  tools: ToolResult[];
  agents: AgentResult[];
  mcp?: McpResult[];
  /** Only on an update: the rows it took out of the recipe and left on the image. */
  retired?: GoldenRetired[];
  /** The base stage's outcomes on a fresh builder; an update's fork carries its golden's. */
  base?: ToolResult[];
  /** The machine context each installed agent got, or why it did not; absent when no stage ran. */
  context?: ContextResult[];
  /** Why no machine context was written, when the probe or the upload failed; context is empty then. */
  contextFailure?: string;
}

export interface ApplyImportOptions {
  import?: GoldenImport;
  setup: string;
  /** What the base stage did on this builder, so a floor row that did not land is in the result with the person's tools. */
  base?: ToolResult[];
  /** Stages this builder already carries; those for the same recipe hash are skipped. */
  ledger?: ImportLedger;
  /** Only on an update: the rows the recipe stopped asking for, so the result names what the image still carries. */
  retired?: GoldenRetired[];
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** Extraction needs the archive and its contents at once, plus what the agents install after. */
const UPLOAD_HEADROOM = 256 * MIB;
/** The Claude installer peaks near 410 MB (measured 2026-09-02); an agent does not start under this. */
const AGENTS_DISK_FLOOR = 800 * MIB;
const AGENT_TIMEOUT_S = 900;
const SHELL_TIMEOUT_S = 300;
/** A harness-stage install under the guard, with every road's network lines ahead of it: the setup line, the Node
 * floor and the agents' installers type the bare curl the road table's function defines, and may type any manager. */
const guardedHarness = (script: string): string => guarded([...ROAD_STEPS.script.env, script].join("\n"), AGENT_TIMEOUT_S);
const SHELL_CHECK_S = 60;

/** One start of the login shell the way the app's pty runs it, a login shell (profile.d puts the tools on PATH before
 * the rc files) and interactive (the rc files are read): what it prints to stderr is what the person sees before the
 * first prompt. The guest exec has no HOME, so the prelude sets it. */
const shellCheck = (shell: LoginShell): string => `${PRELUDE}\nTERM=xterm-256color ${shell} -lic true </dev/null || true`;

/** Runs the import stages and the harness on a builder, skipping what the
 * ledger says is already there for the same recipe. Files and upload fail the
 * build; each tool and agent fails alone and is named in the stage detail. */
export async function applyGoldenImport(machine: Machine, opts: ApplyImportOptions): Promise<{ ledger: ImportLedger; result: ImportResult }> {
  const stage = opts.onStage ?? (() => {});
  const imp = opts.import ?? { recipeHash: "", tools: [], agents: [] };
  const prior = opts.ledger?.recipeHash === imp.recipeHash ? opts.ledger : undefined;
  const recipe = imp.recipe ?? prior?.recipe;
  const ledger: ImportLedger = {
    recipeHash: imp.recipeHash,
    applied: [...(prior?.applied ?? [])],
    smoke: prior?.smoke ?? "true",
    ...(recipe !== undefined ? { recipe } : {}),
    ...(prior?.missingTools !== undefined ? { missingTools: prior.missingTools } : {}),
    ...(prior?.silenced !== undefined ? { silenced: prior.silenced } : {}),
    ...(prior?.shellNoise !== undefined ? { shellNoise: prior.shellNoise } : {}),
    ...(prior?.leftBehind !== undefined ? { leftBehind: prior.leftBehind } : {}),
  };
  const result: ImportResult = { recipeHash: imp.recipeHash, tools: [], agents: [], ...(opts.base !== undefined ? { base: opts.base } : {}), ...(opts.retired !== undefined ? { retired: opts.retired } : {}) };
  const done = (s: ImportStage): boolean => ledger.applied.includes(s);
  const mark = (s: ImportStage): void => {
    if (!done(s)) ledger.applied.push(s);
  };
  const only = opts.import === undefined;
  let ran = false;
  const upload = async (packed: PackedFiles, label: string): Promise<void> => {
    const free = await freeBytes(machine);
    const need = packed.bytes + packed.unpacked + UPLOAD_HEADROOM;
    if (free.kind === "unknown") {
      stage("uploading-files", `free disk unknown (${free.reason}); uploading ${fmtBytes(packed.bytes)} anyway`);
    } else if (need > free.bytes) {
      throw new Error(`your files need ${fmtBytes(packed.bytes)} packed and ${fmtBytes(packed.unpacked)} unpacked, plus ${fmtBytes(UPLOAD_HEADROOM)} of headroom, but the machine has ${fmtBytes(free.bytes)} free`);
    }
    const t0 = Date.now();
    const { parts } = await importInto(machine, packed.tar, "/root", {
      overlay: true,
      timeoutMs: 300_000,
      onPart: p => {
        if (p.parts > 1) stage("uploading-files", `part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}`);
      },
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    stage("uploading-files", closing(`${label}${fmtBytes(packed.bytes)}${parts > 1 ? ` in ${parts} parts` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, await freeNote(machine)));
  };

  if (!only) {
    if (done("uploading-files")) {
      stage("applying-setup", ALREADY_APPLIED);
      const volatile = imp.files?.volatile;
      if (volatile === undefined) {
        stage("uploading-files", ALREADY_APPLIED);
      } else {
        // A volatile file is not in the hash, so the builder may hold an older copy; the latest one goes up again. The
        // saved result stands: no rc file is volatile, so the cuts and installs it lists are still what the builder has.
        // A re-import that fails leaves a builder that is still the same golden with an older copy: it is reported,
        // never failed, since the caller kills a builder whose stages fail.
        try {
          const packed = await volatile.pack();
          stage("uploading-files", `${volatile.paths.length} volatile file${volatile.paths.length === 1 ? "" : "s"}, ${fmtBytes(packed.bytes)}`);
          await upload(packed, `${volatile.paths.join(", ")} re-imported, `);
        } catch (e) {
          stage("uploading-files", `${volatile.paths.join(", ")} not re-imported: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (!imp.files || imp.files.count === 0) {
      const notes = (imp.files?.skipped ?? []).map(s => `${s.path} (${s.note})`);
      stage("applying-setup", notes.length > 0 ? `nothing left to pack; skipped ${notes.join(", ")}` : "nothing ticked");
      stage("uploading-files", "nothing to upload");
      // No pack ran, so nothing is known about cuts; a reader falls back to the recipe's own names.
      result.files = { bytes: 0, skipped: imp.files?.skipped ?? [] };
      delete ledger.leftBehind;
      mark("applying-setup");
      mark("uploading-files");
    } else {
      const rungs = Object.entries(imp.files.rungs).map(([r, n]) => `${r} ${n}`).join(", ");
      stage("applying-setup", `${imp.files.count} file${imp.files.count === 1 ? "" : "s"}: ${rungs}`);
      const packed = await imp.files.pack();
      packed.skipped = [...imp.files.skipped, ...packed.skipped];
      if (packed.leftBehind !== undefined && packed.leftBehind.length > 0) ledger.leftBehind = packed.leftBehind;
      else delete ledger.leftBehind;
      const notes = packed.skipped.map(s => `${s.path} (${s.note})`);
      const silenced = packed.silenced.length > 0 ? `; silenced in the shell: ${packed.silenced.join(", ")}` : "";
      const macPaths = packed.macPaths.length > 0 ? `; Mac paths: ${packed.macPaths.join(", ")}` : "";
      stage("applying-setup", `${fmtBytes(packed.bytes)} packed${notes.length > 0 ? `; skipped ${notes.join(", ")}` : ""}${silenced}${macPaths}`);
      if (packed.silenced.length > 0) ledger.silenced = packed.silenced;
      else delete ledger.silenced;
      mark("applying-setup");
      // The frameworks clone into empty homes, so the shell goes on before the files land; the upload's mark covers it.
      if (imp.shell !== undefined) {
        const { shell, frameworks, cmd } = imp.shell;
        const named = frameworks.join(", ");
        stage("applying-setup", `${shell}: installing${named !== "" ? `, with ${named}` : ""}`);
        const res = await machine.run(guarded(cmd, SHELL_TIMEOUT_S), { deadlineMs: guardDeadlineMs(SHELL_TIMEOUT_S), onLine: line => stage("applying-setup", `${shell}: ${line}`) });
        if (res.exitCode === 0) stage("applying-setup", closing(`${shell} installed as the login shell${named !== "" ? `; ${named} reinstalled` : ""}`, await freeNote(machine)));
        else stage("applying-setup", `${shell} step failed, chsh skipped: ${reasonOf(res, SHELL_TIMEOUT_S)}`);
      }

      stage("uploading-files", fmtBytes(packed.bytes));
      ran = true;
      await upload(packed, "");
      result.files = { bytes: packed.bytes, skipped: packed.skipped, cut: packed.cut };
      mark("uploading-files");
    }
  }

  const harnessRan = !done("installing-harness");
  if (!harnessRan) {
    stage("installing-harness", ALREADY_APPLIED);
  } else {
    stage("installing-harness");
    const res = await machine.run(guardedHarness(opts.setup), { deadlineMs: guardDeadlineMs(AGENT_TIMEOUT_S), onLine: line => stage("installing-harness", line) });
    if (res.exitCode !== 0) throw new Error(`golden setup failed: ${reasonOf(res, AGENT_TIMEOUT_S)}`);
    if (!only) {
      ran = true;
      const node = imp.node !== undefined ? await installNode(machine, imp.node, stage) : undefined;
      for (const a of imp.skippedAgents ?? []) result.agents.push({ id: a.id, name: a.name, outcome: "skipped", note: a.note });
      for (const [i, agent] of imp.agents.entries()) {
        const t0 = Date.now();
        if (node?.failed !== undefined && agent.node !== undefined && agent.node > node.haveMajor) {
          result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: node.failed, ms: 0 });
          continue;
        }
        const free = await freeBytes(machine);
        if (free.kind === "free" && free.bytes < AGENTS_DISK_FLOOR) {
          result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: `${fmtBytes(free.bytes)} free, keeping ${fmtBytes(AGENTS_DISK_FLOOR)} free`, ms: 0 });
          continue;
        }
        stage("installing-harness", `${agent.name} (${i + 1}/${imp.agents.length})`);
        const install = await machine.run(guardedHarness(`${NODE_PATH_LINE}\n${agent.install}`), { deadlineMs: guardDeadlineMs(AGENT_TIMEOUT_S), onLine: line => stage("installing-harness", `${agent.name}: ${line}`) });
        const check = install.exitCode === 0 ? await machine.run(`${NODE_PATH_LINE}\n${agent.smoke}`, { deadlineMs: 60_000 }) : install;
        const pin = check.exitCode === 0 && agent.pin?.read !== undefined ? pinRead((await machine.exec(`${NODE_PATH_LINE}\nexport PATH=${TOOLS_PATH}:$PATH\n${agent.pin.read}`, { timeoutMs: INLINE_EXEC_MS })).stdout, agent.pin.fixed) : undefined;
        const ms = Date.now() - t0;
        if (check.exitCode === 0) result.agents.push({ id: agent.id, name: agent.name, outcome: "installed", ms, ...(pin !== undefined ? { pin } : {}) });
        else result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: reasonOf(check, AGENT_TIMEOUT_S), ms });
      }
      if (ledger.recipe !== undefined) ledger.recipe = withRecordedPins(ledger.recipe, result.agents);
      const installed = imp.agents.filter(a => result.agents.some(r => r.id === a.id && r.outcome === "installed"));
      const failed = result.agents.filter(r => r.outcome === "failed");
      // A golden with an agent missing is not sealed: the person ticked it, and the hand-off would open a terminal
      // on a machine without it. All-skipped is the same refusal with the plan's reasons.
      if (failed.length > 0 || (result.agents.length > 0 && installed.length === 0)) {
        imp.onResult?.(result);
        const header = failed.length > 0 ? `${failed.length === 1 ? "an agent" : `${failed.length} agents`} did not install, so nothing is sealed:` : "no agent installed, so there is nothing to seal:";
        throw new Error([header, ...result.agents.filter(r => r.outcome !== "installed").map(a => `${a.name}: ${a.note ?? "unknown reason"}`)].join("\n"));
      }
      ledger.smoke = joinSmoke(installed.map(a => a.smoke));
      const summary = result.agents.length === 0 ? "no agent ticked" : summarizeAgents(result.agents);
      const pinned = result.agents.filter(a => a.pin !== undefined);
      const wordsOf = (id: string): string | undefined => imp.agents.find(a => a.id === id)?.pin?.words;
      const pins = pinsReadLine(
        pinned.filter(a => a.pin!.latest !== true).map(a => ({ name: a.name, tag: a.pin!.tag })),
        pinned.filter(a => a.pin!.latest === true).map(a => ({ name: a.name, tag: a.pin!.tag, ...(wordsOf(a.id) !== undefined ? { words: wordsOf(a.id)! } : {}) })),
      );
      stage("installing-harness", imp.agents.length > 0 || node !== undefined ? closing(summary, pins, await sweepCaches(machine), await freeNote(machine)) : summary);
    }
    mark("installing-harness");
  }

  const toolsRan = !only && !done("installing-tools");
  if (!only) {
    if (!toolsRan) {
      stage("installing-tools", ALREADY_APPLIED);
    } else {
      for (const t of imp.skippedTools ?? []) result.tools.push({ id: t.id, label: t.label, outcome: "skipped", note: t.note });
      for (const t of imp.baseTools ?? []) result.tools.push({ id: t.id, label: t.label, outcome: "installed", note: t.note });
      if (imp.tools.length === 0) {
        stage("installing-tools", "nothing ticked");
      } else {
        ran = true;
        const tools = await installTools(machine, imp.tools, stage);
        result.tools.push(...tools.tools);
        if (tools.homebrew !== undefined) result.homebrew = tools.homebrew;
        if (ledger.recipe !== undefined) ledger.recipe = withRecordedPins(ledger.recipe, tools.tools);
      }
      const missing = missingToolsOf([...(result.base ?? []), ...result.tools]);
      if (missing.length > 0) ledger.missingTools = missing;
      else delete ledger.missingTools;
      mark("installing-tools");
    }
    // What the person sees before the first prompt: the rc files call tools and agents, so the shell starts once
    // everything that installs is on the machine, and only on a pass that changed it.
    let shellLine: string | undefined;
    if (imp.shell !== undefined && (ran || harnessRan)) {
      const res = await machine.run(guarded(shellCheck(imp.shell.shell), SHELL_CHECK_S), { deadlineMs: guardDeadlineMs(SHELL_CHECK_S) });
      const noise = res.exitCode === 124 ? [reasonOf(res, SHELL_CHECK_S)] : res.stderr.split("\n").filter(l => l.trim() !== "");
      if (noise.length === 0) {
        shellLine = `${imp.shell.shell} starts quiet`;
        delete ledger.shellNoise;
      } else {
        ledger.shellNoise = res.exitCode === 124 ? noise[0]! : `${noise[0]}, ${plural(noise.length, "line")}`;
        shellLine = `shell noise: ${ledger.shellNoise}`;
      }
    }
    // The edit runs on every pass that has a plan: an attach re-uploads the volatile ~/.claude.json, which brings every
    // laptop definition back as it was. It is idempotent and touches only the servers the plan names. It does not count
    // as a run for the result: on an attach the saved result from the build stands, tools and agents included.
    let edited = false;
    let servers: string | undefined;
    if (imp.mcp !== undefined) {
      edited = true;
      result.mcp = await applyMcp(machine, imp.mcp, stage, result.tools);
      servers = mcpTally(result.mcp);
    } else if (done("installing-mcp")) {
      stage("installing-mcp", ALREADY_APPLIED);
    } else {
      stage("installing-mcp", "none configured");
    }
    // The stage is applied once the context is on the machine, so an attach after a failed write runs it again.
    const contextWasOn = done("installing-mcp");
    if (harnessRan || ran || edited || !contextWasOn) {
      // After the tools, so the document can name what did not install.
      const context = await applyMachineContext(machine, { result: withSkippedStages(result, ledger, imp, { tools: toolsRan, harness: harnessRan }), ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}) });
      result.context = context.context;
      if (context.failure !== undefined) result.contextFailure = context.failure;
      else mark("installing-mcp");
      // A refused rewrite over a document that landed leaves the saved result true: the machine still holds it.
      if (!ran && (context.failure === undefined || !contextWasOn)) imp.onContext?.({ context: context.context, ...(context.failure !== undefined ? { contextFailure: context.failure } : {}) });
      // The stage's last detail is what the terminal keeps as its end line, so the servers' tally and the shell's first start ride with the context.
      stage("installing-mcp", closing(servers, shellLine, `machine context: ${context.summary}`));
    }
    if (ran || edited) {
      // A builder whose exec died (a full disk did it once) would be sealed and handed off answering nothing.
      const answer = await machine.exec("echo ok", { timeoutMs: INLINE_EXEC_MS });
      if (answer.exitCode !== 0 || answer.stdout.trim() !== "ok") {
        imp.onResult?.(result);
        throw new Error(`the machine stopped answering commands after the installs (exit ${answer.exitCode}); nothing is sealed`);
      }
    }
  }
  if (!only && ran && imp.onResult) imp.onResult(result);
  return { ledger, result };
}

/** The Node step, once: kept when the guest's major already meets the floor,
 * else the pinned release; a failed install names itself and fails only the
 * agents whose floor the guest's Node does not meet. */
async function installNode(machine: Machine, node: NodeInstall, stage: StageListener): Promise<{ haveMajor: number; failed?: string }> {
  stage("installing-harness", `Node for ${node.agents.join(", ")}`);
  const res = await machine.run(guardedHarness(node.cmd), { deadlineMs: guardDeadlineMs(AGENT_TIMEOUT_S), onLine: line => stage("installing-harness", `Node: ${line}`) });
  const have = /NODE_HAVE v(\d+)/.exec(res.stdout)?.[1];
  const haveMajor = have === undefined ? 0 : Number(have);
  const kept = /NODE_KEPT (v\S+)/.exec(res.stdout)?.[1];
  const got = /NODE_INSTALLED (v\S+)/.exec(res.stdout)?.[1];
  if (res.exitCode === 0 && kept !== undefined) {
    stage("installing-harness", `Node ${kept} kept; ${node.agents.join(", ")} run on it`);
    return { haveMajor };
  }
  if (res.exitCode === 0 && got !== undefined) {
    stage("installing-harness", `Node ${got} installed for ${node.agents.join(", ")} (the base had v${haveMajor})`);
    return { haveMajor: Number(got.slice(1).split(".")[0]) };
  }
  const failed = `Node ${node.version} did not install: ${reasonOf({ ...res, stdout: res.stdout.split("\n").filter(l => !l.startsWith("NODE_")).join("\n") }, AGENT_TIMEOUT_S)}`;
  stage("installing-harness", failed);
  return { haveMajor, failed };
}

function missingToolsOf(tools: readonly ToolResult[]): GoldenMissingTool[] {
  return tools.flatMap(t => (t.outcome === "installed" ? [] : [{ id: t.id, name: t.label, outcome: t.outcome, note: t.note ?? "no reason recorded" }]));
}

/** A stage this pass skipped has no outcomes in the result, but what it left off the machine is known: the ledger
 * keeps the tools, the plan the agents and files it set aside. The context's facts read this, the report the result. */
function withSkippedStages(result: ImportResult, ledger: ImportLedger, imp: GoldenImport, ran: { tools: boolean; harness: boolean }): ImportResult {
  return {
    ...result,
    tools: ran.tools ? result.tools : (ledger.missingTools ?? []).map(m => ({ id: m.id, label: m.name, outcome: m.outcome, note: m.note })),
    agents: ran.harness ? result.agents : (imp.skippedAgents ?? []).map(a => ({ id: a.id, name: a.name, outcome: "skipped" as const, note: a.note })),
    ...(result.files === undefined && imp.files !== undefined ? { files: { bytes: 0, skipped: imp.files.skipped } } : {}),
  };
}

function summarizeAgents(agents: AgentResult[]): string {
  const ok = agents.filter(a => a.outcome === "installed").map(a => a.name);
  const bad = agents.filter(a => a.outcome === "failed").map(a => `${a.name} failed (${a.note})`);
  const aside = agents.filter(a => a.outcome === "skipped").map(a => `${a.name} skipped (${a.note})`);
  return [ok.length > 0 ? `${ok.join(", ")} installed` : "", ...bad, ...aside].filter(s => s !== "").join("; ");
}

/** An updated version's sha chains the version it came from with what the delta ran, so it names both. */
export function nextSetupSha(previous: string, setup: string, imp: GoldenImport): string {
  return createHash("sha256").update(`${previous}\n${setupShaOf(setup, imp)}`).digest("hex");
}

/** Pins which installers ran: the harness line and every agent's. */
function setupShaOf(setup: string, imp: GoldenImport | undefined): string {
  const h = createHash("sha256").update(setup);
  if (imp?.node !== undefined) h.update(`\n${imp.node.cmd}`);
  for (const a of imp?.agents ?? []) h.update(`\n${a.install}`);
  return h.digest("hex");
}

export interface SealGoldenOptions extends MachineSize {
  backend: MachineBackend;
  /** Runs on a fork of the fresh snapshot; a non-zero exit means no version is sealed. */
  smoke: string;
  smokeTimeoutMs?: number;
  manifest?: GoldenManifest;
  onStage?: StageListener;
  killConfirm?: KillConfirm;
  /** How each sign-in asked of the builder ended; stamped on the version as given. */
  logins?: GoldenLogin[];
  /** Leave the builder running after the snapshot (snapshotting does not end first-life, measured), so one more
   * change can re-snapshot it. When the account cap refuses the smoke fork beside it, the builder is killed first
   * and the fork tried once more, as a seal without this option does. */
  keepBuilder?: boolean;
  /** How long the seal waits between snapshot attempts the provider refused (tests shrink it). */
  snapshotRetryMs?: number;
  /** The golden the version belongs to, which names its template; the store's default key when absent. */
  name?: string;
  /** The host sealing it, in lowercase letters and digits, which names its template too. */
  hostId: string;
  /** How long the seal waits for the promoted template to read ready, and how often it reads (tests shrink both). */
  templateWait?: Pick<TemplateWait, "readyMs" | "pollMs">;
  /** Absolute guest paths to archive off the builder before the snapshot: the sign-in state and the secrets files.
   * Absent, no vault is taken, which is what a copy's own build wants: its vault is already the record's. */
  vaultPaths?: readonly string[];
  /** The vault archive's trip off the builder takes this; the global fetch when absent (tests inject one). */
  fetch?: typeof globalThis.fetch;
}

export interface SealResult {
  manifest: GoldenManifest;
  version: GoldenVersion;
  /** True when keepBuilder was asked and the builder is still running. */
  builderKept: boolean;
  /** The archive and its hash when vaultPaths was given; a path missing on the builder is silently not in it. */
  vault?: ImageVault;
}

export interface BuildGoldenOptions extends MachineSize {
  backend: MachineBackend;
  setup: string;
  smoke: string;
  kind?: MachineKind;
  baseTemplate?: string;
  manifest?: GoldenManifest;
  smokeTimeoutMs?: number;
  onStage?: StageListener;
  /** The golden being built, which names the version's template; the store's default key when absent. */
  name?: string;
  /** The host building it, in lowercase letters and digits, which names the template too. */
  hostId: string;
}

export interface ForkOverrides extends MachineSize {
  kind?: MachineKind;
}

/** Always explicit: a create that names no size gets the provider's own
 * default (2048 MB on Solari), which is not what the pricing default assumes. */
function sizeAsked(backend: MachineBackend, o: MachineSize, inherit?: { cpu: number; memMb: number }): { cpu: number; memMb: number } {
  return {
    cpu: o.cpu ?? inherit?.cpu ?? backend.pricing.defaultSize.cpu,
    memMb: o.memMb ?? inherit?.memMb ?? backend.pricing.defaultSize.memMb,
  };
}

function envSpec(o: MachineSize) {
  return {
    ...(o.envs ? { envs: o.envs } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
  };
}

/** The provider's word on what it built, falling back to the request where it has none. */
async function sizeBuilt(machine: Machine, asked: { cpu: number; memMb: number }): Promise<{ cpu: number; memMb: number }> {
  const shape = await machine.describe?.().catch(() => undefined);
  return { cpu: shape?.cpu ?? asked.cpu, memMb: shape?.memMb ?? asked.memMb };
}

/** The stage listener with the stage it last named kept beside it, so a rollback's own line lands on that stage. */
function staged(onStage: StageListener | undefined): { stage: StageListener; current: () => GoldenStage | undefined } {
  let current: GoldenStage | undefined;
  const told = onStage ?? (() => {});
  return {
    stage: (name, detail, step, left) => {
      if (name !== "failed") current = name;
      told(name, detail, step, left);
    },
    current: () => current,
  };
}

export async function prepareBuilder(opts: PrepareBuilderOptions): Promise<Builder> {
  const { stage, current } = staged(opts.onStage);
  const kind = opts.kind ?? "sandbox";
  const baseTemplate = baseTemplateOf(opts.backend, kind, opts.baseTemplate);

  stage("creating", `${kind} from ${baseTemplate}`);
  // A builder that idle-pauses resumes not first-life, so its seal would 502 and
  // consume it anyway; killing on idle loses the same work but fails loud and free.
  const asked = sizeAsked(opts.backend, opts);
  // Taken before the create, so the age a person reads matches the createdAt label the sweep ages by.
  const createdAt = new Date().toISOString();
  const machine = await opts.backend.create({
    kind,
    template: baseTemplate,
    onIdle: "kill",
    idleTimeoutMs: BUILDER_IDLE_MS,
    ...diskAsked(opts.backend),
    ...asked,
    ...envSpec(opts),
  });
  try {
    const size = await sizeBuilt(machine, asked);
    stage("deploying-daemon");
    // The floor goes on before the daemon: the deploy's own steps type the tools it puts there.
    const base = await installBase(machine, stage);
    const deployed = opts.deployDaemon ? await opts.deployDaemon(machine) : undefined;
    const detail = closing(base.line, typeof deployed === "string" ? deployed : undefined, await freeNote(machine));
    if (detail !== "") stage("deploying-daemon", detail);
    const applied = await applyGoldenImport(machine, {
      setup: opts.setup,
      base: base.tools,
      onStage: stage,
      ...(opts.import !== undefined ? { import: opts.import } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    stage("ready");
    return {
      machine,
      kind,
      baseTemplate,
      setupSha: setupShaOf(opts.setup, opts.import),
      createdAt,
      firstLife: true,
      size,
      base: base.versions,
      ...(opts.import !== undefined ? { import: applied.ledger } : {}),
    };
  } catch (e) {
    // Nothing records this machine yet, so one that survives here is said on the stage's own block and named to
    // whoever can kill it again; the failure's line stays the failure's own.
    const left: string[] = [];
    await killUntilGone(opts.backend, machine).catch((k: unknown) => {
      const at = current();
      if (at !== undefined) stage(at, machineLeftLine(messageOf(k)));
      left.push(machine.id);
    });
    stage("failed", messageOf(e), undefined, left);
    throw e;
  }
}

const isCapRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "concurrency";

// Sequenced for a two-machine cap: unless the builder is kept, it dies before
// the smoke fork boots, so the seal itself never holds more than one machine.
export async function sealGolden(builder: Builder, opts: SealGoldenOptions): Promise<SealResult> {
  const { stage, current } = staged(opts.onStage);
  const smoke = builder.import?.smoke ?? opts.smoke;

  const prior = opts.manifest?.versions ?? [];
  const versionNum = (prior[prior.length - 1]?.version ?? 0) + 1;
  // One name for the version: the snapshot is taken under it and the template is promoted under it, and the host in
  // it is the only mark a snapshot can carry (the provider takes no metadata on one).
  const name = goldenName(opts.hostId, opts.name ?? "default", versionNum);
  let snapshotId: string | undefined;
  let templateId: string | undefined;
  let builderAlive = true;
  let fork: Machine | undefined;
  const templates = templatesOf(opts.backend);
  const kill = (m: Machine) => killUntilGone(opts.backend, m, opts.killConfirm);
  const forkSpec = () => ({
    kind: builder.kind,
    ...goldenImage({ snapshotId: snapshotId!, ...(templateId !== undefined ? { templateId } : {}) }).spec,
    ...diskAsked(opts.backend),
    ...sizeAsked(opts.backend, opts, builder.size),
    ...envSpec(opts),
  });
  const retryMs = opts.snapshotRetryMs ?? SNAPSHOT_RETRY_MS;
  // Read before the snapshot is asked for, off the disk the snapshot takes, and before the try: a builder whose
  // files cannot be read is left as the person set it up, the way a refused snapshot leaves it.
  // A sign-in never sits in an image: a credential file left on the builder would ride into every fork of it, and
  // inside Claude Code a helper key file outranks the token the vault hands each turn. Read before anything else,
  // so a builder that holds one is left exactly as the person set it up.
  const held = await presentPaths(builder.machine, NEVER_IN_IMAGE);
  if (held.length > 0) throw new CredentialOnBuilderError(held);
  const owned = builder.import?.recipe === undefined ? undefined : await recipeOwnedFiles(builder.machine, builder.import.recipe);
  // The person's logins as the sign-in and secrets stages left them, read off the same disk the snapshot takes and
  // under the same rule as the owned files: a builder whose vault cannot be read is left as the person set it up.
  const vault =
    opts.vaultPaths === undefined
      ? undefined
      : await exportImageVault(builder.machine, opts.vaultPaths, {
          ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
          // A provider that mints no signed URL hands the archive back through the one call every backend has; the
          // image vault is credential files and two secrets files, which that road can carry.
          ...(opts.backend.capabilities.signedUrls ? {} : { readRoad: "exec" as const }),
        });
  // A snapshot that failed changed nothing on the builder, so every failure here is typed as one that leaves it:
  // the provider's 502 is asked again while it still reads the builder running, and any other failure (a job the
  // far side failed, a link that went under the frame naming the job, a link the wait for the job did not bring
  // back) is said once with the builder's state beside it. Only a resumed machine's refusal is another kind of
  // failure, and it passes as itself.
  const takeSnapshot = async (): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await builder.machine.snapshot(name, { firstLife: builder.firstLife }, { onProgress: p => stage("snapshotting", snapshotProgressLine(p.bytes, p.total)) });
      } catch (e) {
        if (e instanceof NotFirstLifeError) throw e;
        const answer = answerOf(e);
        const read = await readState(builder.machine);
        if (!isSnapshotRefusal(e) || read.state !== "running" || attempt >= SNAPSHOT_ATTEMPTS) throw new SnapshotFailedError(builder.machine.id, attempt, answer, read.state, read.readError);
        stage("snapshotting", snapshotAttemptLine(attempt, SNAPSHOT_ATTEMPTS, answer, read.state, retryMs));
        await new Promise(r => setTimeout(r, retryMs));
      }
    }
  };
  try {
    stage("snapshotting", DISK_SYNC_LINE);
    const left = await syncDisk(builder.machine);
    if (diskUnsettled(left)) stage("snapshotting", diskUnsettledLine(left));
    const used = await usedBytes(builder.machine);
    stage("snapshotting", snapshotStageLine(used));
    snapshotId = await takeSnapshot();
    if (opts.keepBuilder !== true) {
      await kill(builder.machine);
      builderAlive = false;
    }
    // The template is what forks boot from, so the smoke proves it and not the snapshot behind it.
    if (templates !== undefined) {
      stage("promoting", SAVING_IMAGE_LINE);
      templateId = (await promoteVersion(templates, snapshotId, name, { ...opts.templateWait, onStatus: line => stage("promoting", line) })).templateId;
    }

    stage("smoke-forking", smoke);
    try {
      fork = await opts.backend.create(forkSpec());
    } catch (e) {
      if (!builderAlive || !isCapRefusal(e)) throw e;
      stage("smoke-forking", `${smoke}; the account is at its machine cap, so the builder is not kept`);
      await kill(builder.machine);
      builderAlive = false;
      fork = await opts.backend.create(forkSpec());
    }
    const smokeRes = await fork.run(smoke, { deadlineMs: opts.smokeTimeoutMs ?? 120_000, onLine: line => stage("smoke-forking", line) });
    if (smokeRes.exitCode !== 0) {
      throw new Error(
        `golden smoke failed (exit ${smokeRes.exitCode}) for ${JSON.stringify(smoke)}: ${smokeRes.stderr.slice(-500)}`,
      );
    }
    // The stage's last detail is what the terminal keeps as its end line, so the tally follows the agents' output.
    stage("smoke-forking", smokeTally(smoke));
    // Read on the fork, which is the image: forks of this version get BROWSER only when the shim is there.
    const browserShim = (await fork.exec(`test -x ${BROWSER_SHIM_PATH}`, { timeoutMs: INLINE_EXEC_MS })).exitCode === 0;
    // The image is proven by now; a fork that outlives its kills is a leak to
    // name, not a reason to throw the person's setup away.
    let leak: string | undefined;
    await kill(fork).catch((k: unknown) => {
      leak = messageOf(k);
    });

    const version: GoldenVersion = {
      version: versionNum,
      snapshotId,
      ...(templateId !== undefined ? { templateId } : {}),
      baseTemplate: builder.baseTemplate,
      kind: builder.kind,
      setupSha: builder.setupSha,
      ...(builder.parentSnapshotId !== undefined ? { parentSnapshotId: builder.parentSnapshotId } : {}),
      createdAt: new Date().toISOString(),
      smoke: { cmd: smoke, exitCode: smokeRes.exitCode },
      size: builder.size,
      browserShim,
      ...(opts.logins !== undefined ? { logins: opts.logins } : {}),
      ...(builder.import?.missingTools !== undefined ? { missingTools: builder.import.missingTools } : {}),
      ...(builder.import?.silenced !== undefined ? { silenced: builder.import.silenced } : {}),
      ...(builder.import?.shellNoise !== undefined ? { shellNoise: builder.import.shellNoise } : {}),
      ...(builder.import?.leftBehind !== undefined ? { leftBehind: builder.import.leftBehind } : {}),
      ...(builder.base !== undefined ? { base: builder.base } : {}),
      ...(builder.retired !== undefined && builder.retired.length > 0 ? { retired: builder.retired } : {}),
      ...(owned !== undefined ? { owned } : {}),
      ...(used !== undefined ? { usedBytes: used } : {}),
    };
    const kept = builderAlive ? "; builder kept for one more change" : "";
    stage("sealed", leak === undefined ? `v${versionNum}${kept}` : `v${versionNum}${kept}; ${leak}`);
    return { manifest: { head: versionNum, versions: [...prior, version] }, version, builderKept: builderAlive, ...(vault !== undefined ? { vault } : {}) };
  } catch (e) {
    const detail = messageOf(e);
    // A rollback the provider would not take leaves a machine billing: the refusal goes on the stage's own block and
    // the machine is named to whoever can kill it again; the failure's line stays the failure's own.
    const left: string[] = [];
    const leaked = (machine: Machine) => (k: unknown) => {
      const at = current();
      if (at !== undefined) stage(at, machineLeftLine(messageOf(k)));
      left.push(machine.id);
    };
    // A refused snapshot changed nothing on the builder, whether the provider refused it, the backend refused a
    // resumed machine or the guest's sync failed: it is left as the person set it up, and whoever holds the record
    // decides what becomes of it.
    if (builderAlive && !(e instanceof MachineAliveError) && !(e instanceof SnapshotFailedError) && !(e instanceof NotFirstLifeError) && !(e instanceof DiskSyncError)) await kill(builder.machine).catch(leaked(builder.machine));
    if (fork) await kill(fork).catch(leaked(fork));
    // A template that read ready and then lost its smoke goes first: the provider refuses to delete a snapshot while
    // a template stands on it.
    if (templateId !== undefined) await templates?.delete(templateId).catch(() => {});
    if (snapshotId !== undefined) await opts.backend.deleteSnapshot(snapshotId).catch(() => {});
    stage("failed", detail, undefined, left);
    throw e;
  }
}

// --- golden update: the recipe delta on a fork of the golden, or on the kept builder --

/** What changed between the recipe a golden was built from and the recipe now:
 * rows to apply, planned like a first build and hashed as the whole new
 * recipe, and the rows it stops asking for. */
export interface GoldenDelta {
  import: GoldenImport;
  /** The rows this delta takes out of the recipe. Nothing is taken off the image for them; this is what the run
   * says it is doing, so it names only what changed now. */
  retired: GoldenRetired[];
  /** Every row the next version's image carries that its recipe does not ask for: this delta's, plus the ones the
   * version being updated already carried, less any this delta installs again. What the version records, which is
   * a longer list than the run's words and must not be read as them. */
  retiredOnImage: GoldenRetired[];
}

export interface ApplyDeltaOptions {
  setup: string;
  /** The smoke of the version being updated; removed agents leave it, added ones join it. */
  previousSmoke: string;
  /** The tools missing from the version being updated; those the delta neither retires nor plans again stay missing. */
  previousMissing?: readonly GoldenMissingTool[];
  /** What the version being updated left off its image; the rows the delta neither removes nor plans again keep their notes. */
  previousLeftBehind?: readonly GoldenLeftBehind[];
  /** The base tools read on the version being updated; a version sealed before they existed has none and is refused. */
  previousBase: readonly GoldenBaseTool[] | undefined;
  /** The digest the version being updated was sealed with, whose pins the rows this delta leaves alone keep. */
  previousRecipe?: RecipeDigest;
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** A version without the base tools never ran them, so a delta on it would report covered rows it does not have. */
function refusePreFloor(base: readonly GoldenBaseTool[] | undefined, which: string): asserts base is readonly GoldenBaseTool[] {
  if (base === undefined) throw new Error(`${which} was sealed before the base tools existed and cannot take an update; run wsp init and pick the rebuild`);
}

const SMOKE_JOIN = " && ";
/** The agents' version checks as one command for the fork; none is `true`, so the fork still boots and runs. */
function joinSmoke(checks: readonly string[]): string {
  return checks.length === 0 ? "true" : checks.join(SMOKE_JOIN);
}
function smokeChecks(smoke: string): string[] {
  return smoke.split(SMOKE_JOIN).filter(p => p !== "true");
}

/** The version checks of what is on the image after the delta: the previous
 * smoke without the removed agents', joined with the added agents'. */
export function nextSmoke(previous: string, removed: readonly string[], added: string): string {
  const parts = smokeChecks(previous).filter(p => !removed.includes(p));
  for (const p of smokeChecks(added)) if (!parts.includes(p)) parts.push(p);
  return joinSmoke(parts);
}

/** What a passed smoke proved, for the stage's end line: each check's agent, named by the installer table the
 * check came from; a check the table does not know is shown as itself. */
export function smokeTally(smoke: string): string {
  const checks = smokeChecks(smoke);
  if (checks.length === 0) return "no agent to check; the fork booted";
  const names = checks.map(c => Object.values(AGENT_INSTALLERS).find(i => i.smoke === c)?.name ?? c);
  return `${plural(checks.length, "agent")} ${checks.length === 1 ? "answers" : "answer"}: ${names.join(", ")}`;
}

/** The recipe rows a delta addresses: what it retires and what it plans again, tools and agents alike. */
function touchedBy(delta: GoldenDelta): Set<string> {
  return new Set([...delta.retired, ...delta.import.tools, ...(delta.import.skippedTools ?? []), ...delta.import.agents, ...(delta.import.skippedAgents ?? [])].map(t => t.id));
}

/** What an updated image is missing: the previous version's missing tools the delta neither retired nor planned again,
 * then what this delta's tools stage skipped or failed. A retired tool leaves the list; the recipe stopped asking
 * for it, so a fork has nothing to explain. */
export function nextMissing(previous: readonly GoldenMissingTool[], delta: GoldenDelta, fresh: readonly GoldenMissingTool[]): GoldenMissingTool[] {
  const touched = touchedBy(delta);
  return [...previous.filter(p => !touched.has(p.id)), ...fresh];
}

/** The pins the version being updated recorded, on the ticks this delta left alone: a row the delta did not run
 * still stands on the image at what that version installed, so the next record says what a copy installs for it. */
export function carriedPins(digest: RecipeDigest, previous: RecipeDigest, touched: ReadonlySet<string>): RecipeDigest {
  const was = new Map(previous.ticks.map(t => [t.id, t.pin]));
  return { ...digest, ticks: digest.ticks.map(t => { const pin = was.get(t.id); return t.pin === undefined && !touched.has(t.id) && pin !== undefined ? { ...t, pin } : t; }) };
}

/** What an updated image is without: the previous version's notes for rows the delta neither retired nor planned
 * again, then what this delta's pack left behind. */
export function nextLeftBehind(previous: readonly GoldenLeftBehind[], delta: GoldenDelta, fresh: readonly GoldenLeftBehind[]): GoldenLeftBehind[] {
  const touched = touchedBy(delta);
  return [...previous.filter(p => !touched.has(p.id)), ...fresh];
}


/** Runs the delta through the import stages. Nothing is taken off the machine:
 * a row the recipe dropped keeps its bytes and rides the version's retired
 * list, so the update only ever adds. The files and upload fail the update as
 * they fail a build; each tool and agent fails alone. */
export async function applyDelta(machine: Machine, delta: GoldenDelta, opts: ApplyDeltaOptions): Promise<{ ledger: ImportLedger; result: ImportResult }> {
  refusePreFloor(opts.previousBase, "this golden");
  const stage = opts.onStage ?? (() => {});
  const retired = delta.retired;
  if (retired.length > 0) stage("applying-setup", `${plural(retired.length, "row")} left on the image, retired: ${retired.map(r => r.name).join(", ")}`);
  // The stages report only when one of them ran; a delta that only retires rows still has them to report.
  const report = delta.import.onResult;
  let reported = false;
  const imp: GoldenImport = { ...delta.import, ...(report !== undefined ? { onResult: (r: ImportResult) => { reported = true; report(r); } } : {}) };
  const applied = await applyGoldenImport(machine, {
    import: imp,
    setup: opts.setup,
    onStage: stage,
    ...(retired.length > 0 ? { retired } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  const result = applied.result;
  if (!reported && retired.length > 0) report?.(result);
  // A retired agent is still on the image, but the recipe stopped asking for it, so its check leaves the smoke:
  // the next version is only ever held to what its own recipe claims. The rung decides, never the id's last
  // segment: a tools row may end in an agent's name and must not take that agent's check with it.
  const gone = retired.flatMap(r => {
    const installer = rungOf(r.id) === "agents" && !r.id.startsWith(MCP_ID_PREFIX) ? AGENT_INSTALLERS[nameOf(r.id)] : undefined;
    return installer !== undefined ? [installer.smoke] : [];
  });
  applied.ledger.smoke = nextSmoke(opts.previousSmoke, gone, applied.ledger.smoke);
  const missing = nextMissing(opts.previousMissing ?? [], delta, applied.ledger.missingTools ?? []);
  if (missing.length > 0) applied.ledger.missingTools = missing;
  else delete applied.ledger.missingTools;
  const left = nextLeftBehind(opts.previousLeftBehind ?? [], delta, applied.ledger.leftBehind ?? []);
  if (left.length > 0) applied.ledger.leftBehind = left;
  else delete applied.ledger.leftBehind;
  if (opts.previousRecipe !== undefined && applied.ledger.recipe !== undefined) applied.ledger.recipe = carriedPins(applied.ledger.recipe, opts.previousRecipe, touchedBy(delta));
  return { ledger: applied.ledger, result };
}

export interface UpgradeBuilderOptions extends MachineSize {
  backend: MachineBackend;
  /** The version being updated; the fork boots from its image at its size and kind. */
  head: GoldenVersion;
  delta: GoldenDelta;
  setup: string;
  /** The digest the head was sealed with; its pins ride onto the rows the delta leaves alone. */
  previousRecipe?: RecipeDigest;
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** Forks the golden into a fresh first-life machine and applies the delta on
 * it: a builder to seal as the next version. The fork carries the daemon and
 * everything the recipe already put there, so nothing but the delta runs. */
export async function upgradeBuilder(opts: UpgradeBuilderOptions): Promise<Builder> {
  refusePreFloor(opts.head.base, `golden v${opts.head.version}`);
  const { stage, current } = staged(opts.onStage);
  const kind = opts.head.kind ?? "sandbox";
  stage("creating", `fork of golden v${opts.head.version}`);
  const asked = sizeAsked(opts.backend, opts, opts.head.size);
  const createdAt = new Date().toISOString();
  const machine = await opts.backend.create({
    kind,
    ...goldenImage(opts.head).spec,
    onIdle: "kill",
    idleTimeoutMs: BUILDER_IDLE_MS,
    ...diskAsked(opts.backend),
    ...asked,
    ...envSpec(opts),
  });
  try {
    const size = await sizeBuilt(machine, asked);
    const applied = await applyDelta(machine, opts.delta, {
      setup: opts.setup,
      previousSmoke: opts.head.smoke.cmd,
      previousBase: opts.head.base,
      ...(opts.head.missingTools !== undefined ? { previousMissing: opts.head.missingTools } : {}),
      ...(opts.head.leftBehind !== undefined ? { previousLeftBehind: opts.head.leftBehind } : {}),
      ...(opts.previousRecipe !== undefined ? { previousRecipe: opts.previousRecipe } : {}),
      onStage: stage,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    stage("ready");
    return {
      machine,
      kind,
      baseTemplate: opts.head.baseTemplate,
      setupSha: nextSetupSha(opts.head.setupSha, opts.setup, opts.delta.import),
      createdAt,
      firstLife: true,
      size,
      import: applied.ledger,
      parentSnapshotId: opts.head.snapshotId,
      base: [...opts.head.base],
      retired: opts.delta.retiredOnImage,
    };
  } catch (e) {
    const left: string[] = [];
    await killUntilGone(opts.backend, machine).catch((k: unknown) => {
      const at = current();
      if (at !== undefined) stage(at, machineLeftLine(messageOf(k)));
      left.push(machine.id);
    });
    stage("failed", messageOf(e), undefined, left);
    throw e;
  }
}

/** The scripted pipeline: prepare then seal, no one in between. */
export async function buildGolden(
  opts: BuildGoldenOptions,
): Promise<{ manifest: GoldenManifest; version: GoldenVersion }> {
  const { backend, setup, smoke, kind, baseTemplate, manifest, smokeTimeoutMs, onStage, labels, name, hostId, ...size } = opts;
  const builder = await prepareBuilder({
    backend,
    setup,
    ...size,
    labels: { ...labels, [BUILDER_LABEL]: "1" },
    ...(kind !== undefined ? { kind } : {}),
    ...(baseTemplate !== undefined ? { baseTemplate } : {}),
    ...(onStage !== undefined ? { onStage } : {}),
  });
  return sealGolden(builder, {
    backend,
    smoke,
    ...size,
    labels: { ...labels, [SMOKE_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
    ...(manifest !== undefined ? { manifest } : {}),
    ...(smokeTimeoutMs !== undefined ? { smokeTimeoutMs } : {}),
    ...(onStage !== undefined ? { onStage } : {}),
    ...(name !== undefined ? { name } : {}),
    hostId,
  });
}

export async function forkGolden(
  backend: MachineBackend,
  manifest: GoldenManifest,
  overrides: ForkOverrides = {},
): Promise<Machine> {
  const head = goldenHead(manifest);
  if (!head) throw new Error(`manifest head ${manifest.head} has no version entry`);
  return backend.create({
    kind: overrides.kind ?? head.kind ?? "sandbox",
    ...goldenImage(head).spec,
    ...diskAsked(backend),
    ...sizeAsked(backend, overrides, head.size),
    ...envSpec(overrides),
  });
}

export function rollback(manifest: GoldenManifest, version: number): GoldenManifest {
  if (!manifest.versions.some(v => v.version === version)) {
    throw new Error(`rollback target v${version} not in manifest`);
  }
  return { ...manifest, head: version };
}
