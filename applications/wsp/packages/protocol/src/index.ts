// The typed contract every client speaks: workspace/session views, the event
// union fanned out by the runtime, and the wire types for both servers (the
// runtime's serveRuntime and the in-VM daemon). The daemon is a binary that
// imports nothing of node's, so these schemas are the one home of the shapes
// it answers in and the suite in packages/daemon holds it to them. A few
// readings of a machine are parsed here too (ps-time.ts): the runtime and the
// daemon both read them and neither may import the other, so this package is
// the only home a second copy cannot grow beside.

import { z } from "zod";
import { AgentSignInState, AgentsChangedEvent, AgentsTarget, ServerAdd, ServerAsk } from "./agents-report.js";
import { DEFAULT_PLACE_PORT } from "./app-ports.js";
import { HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LABS_ENV, TURN_TOKEN_ENV } from "./env.js";
import { ImageAttachment, ImageRecord } from "./attachments.js";
import { fmtBytes, fmtBytesOfTotal, isoSeconds, KNOWN_HOSTS, nameList, openingTitle, PLACE_INSTALL, PLACE_LEAVE_LINE, plural, thisComputer, THIS_COMPUTER, threadWord, titleLine } from "./format.js";
import { InitJob, InitJobEvent, InitAgent, InitKeys, InitNeedsYou, InitNeedsYouEvent, InitRoad, InitScreenId, LoginChoice, LoginState, SIGN_IN_CODE_MAX } from "./init-job.js";
import type { FsListReply as WireFsListReply } from "./generated/FsListReply.js";
import { rootsPathIn } from "./project-path.js";
import { ReleaseChangedEvent } from "./release.js";
import { shellQuote } from "./shell-quote.js";
import { WorkspaceGlyph, WorkspaceLook, WorkspaceTheme } from "./workspace-look.js";
import { isLocalWorkspace } from "./workspace-state.js";

/** The one rule for a URL a guest may hand to the laptop: http or https in any
 * case, no whitespace or control characters, at most HTTP_URL_MAX bytes, and
 * it parses (so a hostname can always be read from it without throwing). The
 * machine is the untrusted side, so the host and the app apply it too. The
 * daemon carries a copy (it must not bundle this package); a test pins the two
 * equal. */
export const HTTP_URL_RE = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i;
export const HTTP_URL_MAX = 8192;
/** The most bytes one exec request body may carry, the backend's wrapper included: the provider answers 413 Payload
 * Too Large above 16 KiB (a 17,176 byte launch body was refused on 2026-09-06). Anything larger goes to the guest in
 * more than one exec or through an upload. */
export const EXEC_BODY_MAX = 16 * 1024;
/** The thread token and the turn token a guest session opens with; the daemon relays both and reads neither. */
export const GUEST_TOKEN_MAX = 512;
/** Words in one guest command line, and the length of the folder it runs in. */
export const GUEST_ARGV_MAX = 256;
export const GUEST_CWD_MAX = 4096;
/** How much of a detached command's output one poll exec reads; a full read is followed by another at once. */
export const EXEC_CHUNK_BYTES = 262_144;
/** How long a turn may do nothing at all before the runtime cuts it: no byte on its stream, no message from the
 * person, and no work in the process tree it started. It is the one rule that ends a turn the harness left hanging:
 * a fixed wall clock cut a build that was still working at 15 minutes on 2026-09-06. */
export const TURN_IDLE_MS = 10 * 60_000;
/** How hard the process tree a turn started has to be working for the turn to count as alive while it prints
 * nothing: ticks per second, where a tick is 10 ms of CPU or a megabyte of I/O anything the turn started moved. Five
 * percent of one core clears it, which a vitest batch or a packager does many times over; a harness process waking
 * on its own timers stays under it, so a turn nothing is working on is still cut at TURN_IDLE_MS. */
export const TURN_WORK_TICKS_PER_S = 5;
/** How long a thread sits idle before the sidebar folds it out of that workspace's shelf into its Archived group.
 * The fold reads the thread's own last activity, so a thread that takes a new turn leaves the archive by itself and
 * there is no archived flag anywhere to set or clear. */
export const THREAD_ARCHIVE_MS = 24 * 60 * 60_000;
/** The longest one turn may run however much it prints, a safety cap only; a per-workspace setting is a follow-up. */
export const TURN_WALL_MS = 6 * 60 * 60_000;
/** How long a harness gets to exit on its own after the result its turn ended on, before the runtime ends it and its
 * tree. Long enough for the harness to flush its own session store and go, short enough that a machine running turns
 * all day never carries more than the one it is on: seven finished turns' processes were found alive on one guest,
 * the oldest fourteen hours past its reply, and the box read load 25 while idle (2026-09-08). */
export const RUN_EXIT_MS = 10_000;
/** How long a turn's process gets to go on the graceful signal before its group is killed, on either road: what the
 * guest's reap waits between its TERM and its KILL, and what a host gives the turns on this computer as it stops. */
export const RUN_STOP_MS = 2_000;
/** How long a road to a machine keeps being dialled while nothing answers before it is called down. The one rule
 * every link this project holds reads, which is why it lives here: the host's dial of a machine's daemon and its
 * re-dial after a drop, the post that launches or re-opens a turn's run, and the browser's link to a workspace.
 * Measured 2026-09-12: one resolver dropped the name of a machine's edge for about three minutes at a time while
 * the machines behind it went on running and their processes went on working, so a name that will not resolve is
 * worth a minute of asking. */
export const LINK_RETRY_WINDOW_MS = 60_000;

/** The wait before dial `attempt`, half a second doubling to ten, with up to a quarter second of jitter so the
 * turns of one machine do not all come back at the same instant after a blip. */
export function linkBackoffMs(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250);
}

/** The close code a host sends the clients on its own socket as it stops: the socket did not break under them, the
 * host let it go, so a command waiting on a turn says the host is restarting rather than that the turn failed. */
export const HOST_STOPPING_CLOSE = 4001;
export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > HTTP_URL_MAX || !HTTP_URL_RE.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Every folder a turn's paths are built from is held to this: absolute, made of what a path is made of, and
 * never walking up out of itself. A machine can answer with anything, and what it answers lands in a mount and
 * in the commands a turn runs there, so a home carrying a semicolon, a quote, a backtick, a glob or a `..` is
 * refused at the one door rather than quoted or resolved at each of twenty places (the paths are quoted too;
 * this is what keeps a machine from deciding what those paths mean). A space is a path on macOS and stays
 * allowed, and a name that begins with a dot is a name. The one rule, read by the wire schemas here and by the
 * ssh read. */
export function isPlainPath(path: string): boolean {
  if (!path.startsWith("/") || !/^[A-Za-z0-9 ._+@:,/-]+$/.test(path) || path.includes("//")) return false;
  return !path.split("/").some(part => part === "." || part === "..");
}

/** A name under a folder the reader already holds, never a path of its own: the far side joins one of these onto
 * a folder here, so a leading slash, an empty part and a part that walks up out of it are refused at the wire
 * rather than resolved at the other end. The one rule, read by the wire schema here and by the daemon's own. */
export function isUnderPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some(part => part === "" || part === "." || part === "..");
}

/** The host of a URL that passed isHttpUrl (with its port, without userinfo), or undefined when it does not parse: never throws. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A callback port the laptop can bind without root; the host refuses anything else before it listens. */
export const RelayPort = z.number().int().min(1024).max(65535);

/** Hosts a sign-in's redirect comes back to on the machine itself; anything else is a page the person finishes. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A sign-in URL's redirect_uri as a URL, or nothing when it carries none and when either fails to parse. */
function redirectOf(url: string): URL | undefined {
  try {
    const redirect = new URL(url).searchParams.get("redirect_uri");
    return redirect === null ? undefined : new URL(redirect);
  } catch {
    return undefined;
  }
}

/** Whether a sign-in's page comes back to the machine that asked for it: its redirect_uri names a loopback host,
 * port or no port (aws registers http://127.0.0.1/oauth/callback bare and binds its port at the time). This is what
 * tells the two roads apart, since a page that returns to the machine hands the person nothing to carry back. */
export function redirectsToMachine(url: string): boolean {
  const target = redirectOf(url);
  return target !== undefined && LOOPBACK_HOSTS.has(target.hostname);
}

/** Which port on the machine that redirect names, for the forward to bind here: the daemon reads it to name the port
 * on a browser.open. Absent when the page does not come back to the machine at all, when the redirect names no
 * explicit port, or when the port is one this computer could not bind. */
export function callbackPortOf(url: string): number | undefined {
  const target = redirectOf(url);
  if (target === undefined || !LOOPBACK_HOSTS.has(target.hostname) || target.port === "") return undefined;
  const port = Number(target.port);
  return RelayPort.safeParse(port).success ? port : undefined;
}

/** A guest port the host forwards to this computer's loopback (localhost:<port>
 * here reaches the workspace's listener). The host holds them; the app lists
 * them and stops them. name is what the app shows: the workspace's, or the
 * builder's, since a builder's forwards carry the builder id. kind says why the
 * port is open: url, a link the workspace printed, which the app offers to
 * open; callback, a sign-in flow's redirect, which the app names and never
 * dials (a bare request would end the flow). */
export const PortForward = z.object({ workspaceId: z.string(), port: RelayPort, startedAt: z.string(), name: z.string(), kind: z.enum(["url", "callback"]) });
export type PortForward = z.infer<typeof PortForward>;

// --- backend capabilities ----------------------------------------------------

export const WorkspaceSize = z.object({ cpu: z.number(), memMb: z.number() });
export type WorkspaceSize = z.infer<typeof WorkspaceSize>;

/** What the cloud setup modal opens on: which keys the host holds (their presence, never a value), the agents on this
 * computer the agent road can start, the price of the machine the build boots, and the init job when one is running
 * or over. */
export const InitSetup = z.object({
  keys: InitKeys,
  /** The provider whose key the setup's own key step asks for, by the word WSP_PROVIDER holds: the one this host
   * forks on where it reads a key, else the one a key alone would wire. Absent where no key would wire anything,
   * which is a host set up for a provider that reads none. The step reads its held state out of `keys` by this
   * word rather than by a provider's name. */
  keyProvider: z.string().optional(),
  /** This computer's home directory, so a field can show a real path of the person's as its example. */
  home: z.string(),
  agents: z.array(InitAgent),
  /** What a machine costs at the place the build boots on, and the disk that place gives a builder where it caps
   * one; null where no place here runs workspaces, so there is no image to build and nothing to price. */
  pricing: z.object({ size: WorkspaceSize, rateUsdPerHour: z.number(), builderDiskGb: z.number().positive().optional() }).nullable(),
  /** The place the build boots on: the one the ask named, else the default place; absent with `pricing` null. */
  place: z.object({ id: z.string(), name: z.string() }).optional(),
  /** The provider this host forks on, under the word its machines are stamped with: where every workspace it makes
   * lands, and what `wsp up --provider` moves. A run beside this host reads it to say so where the provider it was
   * given is another one. Absent on a host of an earlier build, which says nothing about where it forks. */
  forksOn: z.string().optional(),
  /** Why no build can start here, in the runtime's one sentence for it: no place runs workspaces, or several do and
   * none is the default. Present exactly when `pricing` is null, so the sheet and the command line read the same
   * refusal. */
  buildRefusal: z.string().optional(),
  job: InitJob.nullable(),
});
export type InitSetup = z.infer<typeof InitSetup>;

/** One size a create may ask for, with what it costs awake. */
export const MachineSizeOffer = WorkspaceSize.extend({ rateUsdPerHour: z.number() });
export type MachineSizeOffer = z.infer<typeof MachineSizeOffer>;

/** How a provider pauses a machine. memory: a pause keeps the processes and every byte they hold. disk: a pause is a
 * stop and a snapshot, and the wake is a boot that starts nothing the machine was running. */
export const PauseMode = z.enum(["memory", "disk"]);
export type PauseMode = z.infer<typeof PauseMode>;

/** Honest per-backend feature flags; the UI degrades based on these, never on probing. */
export const Capabilities = z.object({
  /** What a fork of an image comes up as: on a provider whose images hold memory the processes are still running,
   * and on one whose images hold only a disk it boots cold and wsp starts the agents on it again. The provider
   * table publishes it; no verb reads it, since each verb reads the one road its own move needs. */
  liveCloneForks: z.boolean(),
  /** Absent: the machine cannot be paused, and the runtime refuses a nap and a wake. The app reads the value for its
   * words; the runtime reads only whether it is there. */
  pauseMode: PauseMode.optional(),
  /** The provider replaces a machine with a fresh fork of the image behind it and the workspace goes on, its
   * vaulted files carried over: the one road a rebuild and an image move both take, since both throw a machine away
   * and hand its workspace another. False where nothing forks: this computer, a machine reached over ssh, a host with
   * no provider. Whether the replacement comes up with the processes still running is liveCloneForks, which says
   * nothing about whether one may stand in at all. */
  replacesMachine: z.boolean(),
  previewUrls: z.boolean(),
  signedUrls: z.boolean(),
  /** A daemon link exists, so sign-in URLs a guest tool opens land in the laptop's browser and the
   * callback port is forwarded back; false means the person finishes sign-ins by copy and paste. */
  callbackRelay: z.boolean(),
  /** The provider copies a running machine's disk into an image it keeps, which is what a version and a project
   * golden are sealed as and what a fork boots from. False where the disk is the person's own and nothing copies it
   * (this computer, a machine reached over ssh). Which life the copy may be taken from is snapshotsAnyLife.
   * Whether a fork of that image comes up with the processes still running is liveCloneForks and says nothing about
   * whether one can be taken. */
  diskSnapshots: z.boolean(),
  /** The backend keeps images at all: a template or a snapshot a fork can boot from, whether it built them or
   * pulled them. False on a computer somebody joined, where a workspace is a copy of that computer's own
   * directories and of one checkout on it, so a fork names no image, nothing is pulled and nothing is built. */
  images: z.boolean(),
  /** The copy may be taken from a machine that was paused and woken, not only from one that never was. False where
   * the provider refuses a resumed machine (Solari answers 502 and consumes the builder), which is the one reason a
   * builder that woke can no longer be sealed. Read wherever the golden road asks whether a builder still has a
   * seal in it, so that question is the provider's and never the road's; meaningless where diskSnapshots is false. */
  snapshotsAnyLife: z.boolean(),
  /** The provider lists every snapshot on the account with its size, so storage can be counted and priced. */
  snapshotListing: z.boolean(),
  /** The provider promotes a snapshot to a template that survives its own restarts, so a sealed version is recorded
   * as one and forked from it; false keeps every version on its snapshot. */
  templates: z.boolean(),
  /** Every size a create may ask for; a create that names another is refused with this list. A create that names
   * none takes the golden's size, which need not be on it. */
  sizes: z.array(MachineSizeOffer),
  /** The machine is the person's own, kept: its files, its sign-ins and its git checkouts outlive every turn, and
   * wsp neither made it nor throws it away. False on a fork wsp made, where a turn that wrecks the disk costs a
   * rebuild and nothing else. Whether the access picker names the machine on the pick that asks nothing reads this;
   * what a thread with no access word runs at is the kind's own row, read through workspaceAccess. */
  kept: z.boolean(),
  /** The computer makes a workspace as a copy of itself with the project inside. A Linux box and a provider fork
   * yes; the computer the app runs on yes, by copying the project folder to a path of its own; a machine reached
   * over ssh and a host with no provider no. */
  copies: z.boolean(),
  /** A copy gets its own network, its own localhost and its own ports. A Linux box and a provider fork yes; the
   * computer the app runs on no, so its copies share its ports and the row says so. The one flag the row and the
   * port base read. */
  ownNetwork: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** Where a workspace of one project would land: the row it stands on where that is a computer this host holds, the
 * computer's name as the runtime words it, and what that computer offers. The reply of workspaces.landing, read
 * ahead of a create by the command line and by every row of that project in the app, which takes its words about a
 * copy's ports and its state word's pause mode off these flags. */
export const WorkspaceLanding = z.object({ place: z.string().optional(), name: z.string(), capabilities: Capabilities });
export type WorkspaceLanding = z.infer<typeof WorkspaceLanding>;

/** Whether this host forks no machine at all: the provider module a keyless host wires offers no size, so the roads
 * that would fork one answer NO_PROVIDER_LINE instead of sending the person back to an init that seals nothing. The
 * one place that reading is made, so nothing above the provider module asks whether there is a key. */
export function forksNoMachines(capabilities: { sizes: readonly MachineSizeOffer[] }): boolean {
  return capabilities.sizes.length === 0;
}

/** Whether a place can build a copy of the image at all: it has to fork a builder and then copy that builder's disk
 * into something a fork can stand on. A computer somebody joined does neither, and nor does a host with no provider
 * key. The one place that reading is made, so the refusal and any road that offers the build read one rule. */
export function buildsImages(capabilities: Pick<Capabilities, "diskSnapshots"> & { sizes: readonly MachineSizeOffer[] }): boolean {
  return !forksNoMachines(capabilities) && capabilities.diskSnapshots;
}

/** Whether a request asks for a size at all: a create naming none takes the golden's own size, and so never reads
 * the list of sizes the provider offers. */
export function namesSize(asked: Partial<WorkspaceSize> | undefined): boolean {
  return asked?.cpu !== undefined || asked?.memMb !== undefined;
}

// --- views -----------------------------------------------------------------

/** pausing: the runtime is stashing the vault and asking the provider to pause; a send is refused from here on.
 * gone: the provider no longer knows the machine (deleted behind wsp, or expired); nothing bills and nothing
 * runs until a rebuild puts a fresh fork under the record or the workspace is deleted. */
export const WorkspacePhase = z.enum(["running", "pausing", "napping", "waking", "gone"]);
export type WorkspacePhase = z.infer<typeof WorkspacePhase>;

/** Backend vocabulary: a napping workspace's machine reads "paused" here.
 * Phase is the product word, machine state the provider word; clients render
 * phase and use machineState only for divergence (starting, gone). */
export const MachineState = z.enum(["starting", "running", "paused", "gone"]);
export type MachineState = z.infer<typeof MachineState>;

/** slow: the edge answered late or 502'd while the machine runs (a provider slow
 * spell, measured: 502 after 5 to 11 s with an open socket to the same guest
 * still working); it is not no-daemon (a prompt 502) and not unreachable (silence).
 * zombie: the provider reports the machine running, reach has been slow or
 * unreachable for minutes, and a bounded exec probe failed too; the guest is
 * dead behind a live control plane (measured twice at rest). Phase stays
 * running; status.reason carries the timings; workspaces.rebuild is the way out. */
export const ReachState = z.enum(["reachable", "no-daemon", "unreachable", "napping", "unsupported", "gone", "slow", "zombie"]);
export type ReachState = z.infer<typeof ReachState>;

export const ReachStatus = z.object({
  state: ReachState,
  url: z.string().optional(),
  expiresAt: z.number().optional(),
  /** The probe never left this computer (no DNS, no network), so nothing was learnt about the machine: state is the
   * last word the row showed, and the computer is offline. */
  offline: z.boolean().optional(),
});
export type ReachStatus = z.infer<typeof ReachStatus>;

/** The reach as every door outside the app's own socket shows it: the state, and whether the probe even left this
 * computer. Picked rather than omitted, so a field added to the reach is not handed over by having been forgotten:
 * the route the status carries is the provider's minted bearer with an hour on it, and only the app dials it. */
export const ReachView = ReachStatus.pick({ state: true, offline: true });
export type ReachView = z.infer<typeof ReachView>;

/** What a browser needs to dial a workspace's daemon: the minted preview route
 * (edge token embedded, hourly expiry) and the daemon token the host minted at
 * start and wrote to the guest, sent as the socket's first frame, never in the
 * URL. No daemonToken means no daemon on that machine. */
export const DaemonReachView = z.object({
  url: z.string(),
  expiresAt: z.number(),
  daemonToken: z.string().optional(),
});
export type DaemonReachView = z.infer<typeof DaemonReachView>;

/** The same minted route for any other guest port, as a browser frames it. The
 * daemon token stays off this view: it opens the daemon's socket, not a page. */
export const PortReachView = DaemonReachView.omit({ daemonToken: true });
export type PortReachView = z.infer<typeof PortReachView>;

/** What the host saw fetching a guest port's route once, as a browser's frame
 * does: the status and the start of the body. A frame on another origin can
 * read neither, so the pane asks for this to explain a refusal (a dev server's
 * host check, the edge) instead of showing a white page. */
export const PortProbeView = z.object({ status: z.number().int(), body: z.string() });
export type PortProbeView = z.infer<typeof PortProbeView>;

/** One project a workspace holds: the folder the bundle landed at, named by its last segment, when the bundle landed
 * and, where the import measured it, its size in bytes. Added by an import, inherited by every fork of a project
 * golden. */
export const WorkspaceProject = z.object({ name: z.string(), dest: z.string(), importedAt: z.string(), size: z.number().int().nonnegative().optional() });
export type WorkspaceProject = z.infer<typeof WorkspaceProject>;

/** What a path git ignores is to a seed of the folder it sits in, as the catalog's own rows judge it: config
 * travels, rebuilt is what the computer makes again, data is a database, never is a login that does not leave this
 * computer whatever is ticked, and unknown is a path no row names. The catalog's junk kind reaches no menu, so it
 * is not here. */
export const SeedKind = z.enum(["config", "rebuilt", "data", "never", "unknown"]);
export type SeedKind = z.infer<typeof SeedKind>;

/** One row of the seed menu: a path git ignores in the folder, relative to it and collapsed to the directory where
 * the whole directory is ignored, with its size, the catalog row and kind that judged it, and whether it starts
 * ticked. */
export const SeedFile = z.object({
  path: z.string(),
  dir: z.boolean(),
  bytes: z.number().int().nonnegative(),
  kind: SeedKind,
  /** The catalog row's id and name; absent on unknown. */
  row: z.object({ id: z.string(), name: z.string() }).optional(),
  ticked: z.boolean(),
});
export type SeedFile = z.infer<typeof SeedFile>;

/** What seeding a project from this folder would carry, for the person to read before anything leaves this
 * computer. Nothing here is a file's content: the plan is names, sizes and counts. */
export const SeedPlan = z.object({
  /** The folder on this computer, resolved. */
  source: z.string(),
  /** The remote the computer clones, origin's URL; null where the folder has none, which refuses the add. */
  remote: z.string().nullable(),
  /** The branch the folder is on, and the branch the remote's own HEAD names. */
  branch: z.string(),
  defaultBranch: z.string().nullable(),
  /** Commits on the branch the remote does not have, with the commit they start from; null when there are none. */
  unpushed: z.object({ commits: z.number().int(), base: z.string() }).nullable(),
  /** Changed or untracked files that stay on this computer: the menu says how many and the seed carries none. */
  uncommitted: z.number().int().nonnegative(),
  /** Claude Code's memory folder for this folder here, with the key it sits under; null where there is none. */
  memory: z.object({ key: z.string(), files: z.number().int(), bytes: z.number().int() }).nullable(),
  files: z.array(SeedFile),
  /** The ticks came from a choice remembered for this folder rather than from the catalog's own defaults. */
  remembered: z.boolean(),
});
export type SeedPlan = z.infer<typeof SeedPlan>;

/** What the person chose off the menu: the paths that travel, the memory folder, the unpushed commits as a patch,
 * and whether the choice is kept for the next add of this folder. */
export const SeedChoice = z.object({
  files: z.array(z.string()),
  memory: z.boolean(),
  commits: z.boolean(),
  remember: z.boolean().optional(),
});
export type SeedChoice = z.infer<typeof SeedChoice>;

/** How far an add has got. In order: planned, the folder read or the remote resolved; cloning, on the computer;
 * seeding, the chosen files landed there; installing, the lockfile's own install run once; imaging, the machine
 * snapshotted as the project's image, which only a provider computer does; done. failed ends one that threw. */
export const ProjectAddStage = z.enum(["planned", "cloning", "seeding", "installing", "imaging", "done", "failed"]);
export type ProjectAddStage = z.infer<typeof ProjectAddStage>;

/** Where a project's code comes from, as the computer it lives on sees it: a folder that computer holds, or a repo
 * it clones. Which of the two a computer takes is its kind's own row (projectSources), so no road guesses. */
export const ProjectSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: z.string() }),
  z.object({ kind: z.literal("git"), url: z.string() }),
  /** owner/repo on a host whose signed-in command line the computer's image carries: the clone goes through that
   * command, so a private repo needs no key of the person's on the box. */
  z.object({ kind: z.literal("github"), repo: z.string() }),
  z.object({ kind: z.literal("gitlab"), repo: z.string() }),
]);
export type ProjectSource = z.infer<typeof ProjectSource>;

/** A project: one computer, one source that computer can see, and the branch a workspace of it starts on. Its own
 * record, not a folder inside a workspace: a workspace is a copy of this computer with this project in it. */
export const ProjectView = z.object({
  id: z.string(),
  /** The folder's name, or the repo's last word without .git; --name overrides. */
  name: z.string(),
  /** An id off places.list: this computer, a computer somebody joined, or a provider account. */
  computer: z.string(),
  source: ProjectSource,
  /** Where the checkout sits inside a workspace of it: the folder itself on this computer, and under the folder
   * the landing road for that computer names where the computer cloned it. Written once at the add. */
  path: z.string(),
  /** The remote the computer cloned, or the seed folder's own origin: written once at the add and never read again
   * to decide anything, so a remote renamed later changes nothing about a project that already stands. */
  remote: z.string(),
  /** The branch the remote's HEAD named at the add. */
  defaultBranch: z.string(),
  /** The value of every agent's project key variable in every workspace of this project: the seed folder's own key
   * on this Mac when it was seeded from one, else the key of the path on the computer. It is fixed at the add, so a
   * project's memory and sessions key on the project rather than on wherever its checkout sits. */
  memoryKey: z.string(),
  /** Where the project's memory lives on the computer holding it, which every workspace of it reads: the folder
   * itself on this Mac, a folder of wsp's own on a computer that clones. */
  memoryDir: z.string(),
  /** Where the checkout sits on the computer holding it, outside every workspace of it: a folder of wsp's own on
   * a computer that cloned it there, which every workspace of the project takes its own copy of. Absent where the
   * computer keeps the project inside an image instead, and where the project is worked where it already sits. */
  checkout: z.string().optional(),
  /** What the seed carried, once, where the source was a folder on this computer. */
  seeded: z
    .object({
      files: z.number().int(),
      /** The bytes of the files that were ticked, which is the sum the menu showed; never the archive's own size,
       * which is bigger and is nobody's question. */
      bytes: z.number().int(),
      /** What the memory did, in one word: landed on that computer, kept because the agent there already had its
       * own for this project and no memory is ever written over, or none travelled at all. */
      memory: z.enum(["landed", "kept", "none"]),
      /** How many files the memory folder held, the menu's own count; absent where none travelled. */
      memoryFiles: z.number().int().optional(),
      commits: z.number().int(),
      at: z.string(),
    })
    .optional(),
  /** What the install ran and how long it took, once; absent where no catalog row named an install for this repo. */
  installed: z.object({ row: z.string(), command: z.string(), at: z.string(), seconds: z.number() }).optional(),
  /** On a provider computer: the project image every workspace of this project forks from. */
  image: z.object({ snapshotId: z.string(), builtAt: z.string(), lockfileSha: z.string().optional() }).optional(),
  /** The branch a new workspace starts on; absent is the remote's default branch, read at the clone. */
  base: z.string().optional(),
  createdAt: z.string(),
  /** The agent the last thread on this project used; what run and the composer default to. */
  lastAgent: z.string().optional(),
});
export type ProjectView = z.infer<typeof ProjectView>;

/** The project a workspace holds, joined onto the view by the runtime from the record's project id: what every row
 * that names a workspace's project reads, without a second fetch of the projects list. */
export const ProjectRef = ProjectView.pick({ id: true, name: true, path: true, computer: true });
export type ProjectRef = z.infer<typeof ProjectRef>;

/** What a workspace's machine is: cloud, a fork wsp made at a provider, local, this computer itself, or ssh, a
 * machine of the person's own that wsp only reaches. A missing kind reads cloud, since every record written before
 * local workspaces existed was one. The one fact every road that varies by machine kind reads; nothing switches on
 * it outside the backend registry. */
export const WorkspaceKind = z.enum(["cloud", "local", "ssh"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

/** Which machine a daemon's own cpu, memory and process readings describe. Wider than WorkspaceKind by one: a
 * computer somebody joined is a place and no workspace of its own, and its daemon still reads that box for the
 * person sitting at it. */
export const DaemonKind = z.enum([...WorkspaceKind.options, "place"]);
export type DaemonKind = z.infer<typeof DaemonKind>;

/** Where a request to a workspace verb came from: here, this computer's own app, CLI or MCP; relayed from a
 * machine wsp runs; or paired, a computer of the person's own that holds a device token of this host. A local
 * workspace is driven by `here` alone and starts a process for nothing else, since a command, a thread or a shell
 * pane on it runs under the person's own login on this computer. The host stamps the word off the road a request
 * arrived on, so nothing a client sends decides it. */
export const WorkspaceOrigin = z.enum(["here", "relayed", "paired"]);
export type WorkspaceOrigin = z.infer<typeof WorkspaceOrigin>;

/** What a token scoped to one thread names: the thread whose turn holds it, the workspace that thread runs on, and
 * the thread at the top of the tree that thread was spawned under, which is the thread itself when a person opened
 * it. The host mints the scope; nothing a client says on the wire can make or widen one. */
export const ThreadScope = z.object({
  kind: z.literal("thread"),
  threadId: z.string(),
  workspaceId: z.string(),
  rootThreadId: z.string(),
});
export type ThreadScope = z.infer<typeof ThreadScope>;

/** Who an event is on behalf of, taken off the scope that asked so the two cannot drift: the thread and the root of
 * its tree. An event about work that has no record yet carries this, since the reading that hides a workspace from
 * a caller has nothing to read until the record exists. */
export const EventAsker = ThreadScope.pick({ threadId: true, rootThreadId: true });
export type EventAsker = z.infer<typeof EventAsker>;

/** Where a request reached the host from, as every verb takes it: the road alone, or the road with the thread a
 * machine's turn sent it out of. A bare word is one of the three roads and says nothing about who; the object is a
 * socket the host authed on a thread scoped token, and the scope is the host's own reading of that token, never
 * the client's. Read it through `roadOf` and `scopeOf` so no verb decides for itself what the shape means. */
export type Caller = WorkspaceOrigin | { origin: WorkspaceOrigin; by: ThreadScope };

/** Which road a caller came in by. */
export const roadOf = (caller: Caller | undefined): WorkspaceOrigin | undefined => (typeof caller === "string" ? caller : caller?.origin);

/** The thread a caller is, when it is one. */
export const scopeOf = (caller: Caller | undefined): ThreadScope | undefined => (typeof caller === "string" ? undefined : caller?.by);

/** What a workspace lets the agents inside it do to this host. Absent on the record means off: an agent that asks
 * for a thread or a machine is refused, which is what every workspace made before this switch existed answers. */
export const WorkspaceAgents = z.object({
  /** Whether a turn on this workspace gets a token into the host at all. */
  spawn: z.boolean(),
  /** How many machines may stand at once under one root thread, counted off the records. */
  maxMachines: z.number().int().min(0),
  /** How deep the tree under a root thread may go: 1 is the root's own children and no further. */
  maxDepth: z.number().int().min(1),
});
export type WorkspaceAgents = z.infer<typeof WorkspaceAgents>;

/** What a workspace's switch reads as when nobody has set one: agents drive nothing. */
export const AGENTS_OFF: WorkspaceAgents = { spawn: false, maxMachines: 0, maxDepth: 1 };

/** What a workspace's switch takes when a person turns it on and names no numbers. Three machines is what one root
 * thread's builders need and few enough that a runaway is a bill a person notices, and one level is the tree the
 * app draws without indenting twice. */
export const AGENTS_ON: WorkspaceAgents = { spawn: true, maxMachines: 3, maxDepth: 1 };

/** Which road made a workspace's copy on a computer that copies by directory: a directory clone of the project
 * folder or a git worktree of it. Every workspace on such a computer is a copy, from the first piece of work on. */
export const CopyRoad = z.enum(["clonefile", "worktree"]);
export type CopyRoad = z.infer<typeof CopyRoad>;

/** The one home of the word for a folder worked where it sits, which no workspace is any more: the copy verb still
 * answers it when asked for it, and nothing asks; a record carrying it is refused at boot in one sentence. */
export const IN_PLACE_ROAD = "in-place";
/** What the copy verb may answer as its road: the two a record keeps, and the word above, kept on the wire so the
 * daemon's contract stands while every host asks for a copy. */
export const CopyVerbRoad = z.enum([...CopyRoad.options, IN_PLACE_ROAD]);

/** What rode along in the copy: everything the folder held that git ignores, so the dependencies are there and a
 * build runs at once; the config files alone, so the dependencies install first; or nothing. */
export const Carried = z.enum(["deps-and-config", "config-only", "nothing"]);
export type Carried = z.infer<typeof Carried>;

/** One copy as the daemon binary's copy verb is asked for it. The size line rides rather than living in the
 * daemon: the number is the host's to change in one place, and a copy asked for by a test names a small one to
 * take the fallback road. */
export const CopyAsk = z.object({
  from: z.string(),
  to: z.string(),
  /** The ref the copy is reset to; the folder's default branch when absent. */
  base: z.string().optional(),
  /** Directories removed after the copy so they rebuild at the new path. */
  exclude: z.array(z.string()),
  /** Apparent size above which the directory clone is not taken. */
  sizeLineBytes: z.number().int().nonnegative(),
  /** A road named outright; the verb's own pick when absent. */
  road: CopyRoad.optional(),
});
export type CopyAsk = z.infer<typeof CopyAsk>;

/** What the daemon binary's copy verb printed, read back by the host and kept on the workspace's record as
 * `copy`. */
export const CopyReport = z.object({
  road: CopyVerbRoad,
  path: z.string(),
  base: z.string(),
  branch: z.string(),
  fetched: z.boolean(),
  carried: Carried,
  excluded: z.array(z.string()),
  /** The rows the exclusion left standing and why: a path it could not walk without following a link, so nothing
   * under it was removed. Absent where every row it was given went. */
  skipped: z.array(z.string()).optional(),
  bytes: z.number().int().nonnegative(),
  ms: z.number().int().nonnegative(),
  fellBack: z.string().optional(),
});
export type CopyReport = z.infer<typeof CopyReport>;

/** What a workspace on a computer that copies by directory is made of: the road that made the copy, where it
 * landed, what it stands on and what rode along. Absent on a fork and on a box snapshot, whose project arrives by
 * the runtime's own road. */
export const ProjectCopy = CopyReport.pick({ path: true, base: true, branch: true, carried: true, fellBack: true }).extend({
  road: CopyRoad,
  /** The project folder the copy was taken from: what a worktree's remove needs and what the row names. */
  source: z.string(),
});
export type ProjectCopy = z.infer<typeof ProjectCopy>;

/** The switch a patch leaves on the record, the one rule both roads that set one read: every key the patch does not
 * name keeps what the record holds, so turning it off and on again does not throw the caps away, and a workspace
 * that never had one takes the defaults for the caps nobody named. */
export function agentsFrom(held: WorkspaceAgents | undefined, patch: Partial<WorkspaceAgents>): WorkspaceAgents {
  return { ...(held ?? (patch.spawn === true ? AGENTS_ON : AGENTS_OFF)), ...patch };
}

export const WorkspaceView = z.object({
  id: z.string(),
  name: z.string(),
  machineId: z.string(),
  phase: WorkspacePhase,
  /** cloud, a provider fork, or local, this computer; absent reads cloud (every record from before local existed). */
  kind: WorkspaceKind.optional(),
  /** Snapshot id of the image this workspace forks from: a golden version's, or a project golden's; empty on a local
   * workspace, which forks from no image. */
  golden: z.string(),
  createdAt: z.string(),
  /** The one project this workspace was made for, joined from its record's project id. A workspace holds exactly
   * one; the computer it runs on is that project's. */
  project: ProjectRef,
  /** The folder a thread or a command starts in when no project does, the last branch of the runtime's default folder
   * rule: the kind's own (the work folder on this computer). Absent where the kind names none and the machine's own
   * home is where the shell lands (a fork, a machine over ssh). Published so a client shows what the runtime will do. */
  folder: z.string().optional(),
  /** The machine's own home, where its shell shortens paths to `~`: /root on a fork, the person's home on this
   * computer, the login's on a machine over ssh once it has answered. Absent where the kind has not read one. */
  home: z.string().optional(),
  /** Claude session id of the last session, so the next send can --resume it. */
  claudeSessionId: z.string().optional(),
  /** Present when the machine streams a display (desktop kind); sandbox machines are headless. */
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** With phase gone: the provider's words when it stopped knowing the machine; every refusal quotes them. */
  gone: z.string().optional(),
  /** The theme a person gave this workspace; absent is none, and the sidebar keeps its own surface. */
  theme: WorkspaceTheme.optional(),
  /** The glyph a person picked for this workspace; absent is none, and the state dot stands alone. */
  glyph: WorkspaceGlyph.optional(),
  /** One line for the machine's row while the runtime is doing something to the machine's daemon, or why the last
   * attempt failed; absent whenever there is nothing to say. Not persisted: it says what this process is doing. */
  daemonNote: z.string().optional(),
  /** When the last nap stored a vault of this machine's files, ISO; absent where no nap ever stored one. What a
   * rebuild would restore, so it is what says how old the restored files would be. */
  vaultedAt: z.string().optional(),
  /** Why the last nap could not store a fresh vault, in the words that name the export's size and the cap; absent
   * once a nap stores one. Persisted, unlike the nap's own status line: the files stay unbacked until the next nap
   * stores one, so every row keeps saying it rather than the person having to have seen the nap. */
  vaultRefused: z.string().optional(),
  /** What this machine answered when the daemon was last offered to it and it refused: which machine said so, when
   * it said it, and the sentence naming what it has not got. Persisted, unlike the daemon note: a compiler is a
   * person's to install on their own machine, so the row keeps saying it rather than the person having to have
   * been watching the one host start that tried. The stamp is what leaves such a machine alone between attempts;
   * cleared by a deploy that gets past the machine's own checks. */
  daemonRefusedAt: z.object({ machineId: z.string(), at: z.string(), why: z.string() }).optional(),
  /** Why the last wake gave up: the host asked the provider for half an hour and the machine never came back, in the
   * words that also name the rebuild road. Persisted, unlike the wake's own status line, since the machine stays
   * unreachable until something replaces it; cleared by a wake that lands and by the rebuild. */
  wakeRefused: z.string().optional(),
  /** What the agents on this workspace may ask of this host; absent is off, which every workspace reads as until a
   * person turns it on. */
  agents: WorkspaceAgents.optional(),
  /** The thread that forked this workspace, and the thread at the top of that thread's tree; absent on every
   * workspace a person made. The root is what the machine cap counts against. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The workspace this one was forked out of, by id; absent on every workspace that is not a fork of another. A
   * child holds the same project as its parent and starts on the branch the parent was on, and its work goes back
   * into that branch. */
  parentWorkspaceId: z.string().optional(),
  /** The place a fork lives on, by id; absent on a fork at the host's own provider and on every workspace that is
   * not a fork. The command line and the app show its name after the workspace's. */
  place: z.string().optional(),
  /** What this workspace's copy of its project is made of, on a computer that makes a workspace by copying the
   * project folder: the road, the path, the base and the folder it came from. Absent on a fork, whose project
   * arrives by the runtime's own road. */
  copy: ProjectCopy.optional(),
  /** The port an app that reads PORT binds in this workspace, on a computer whose copies share its network.
   * Absent where a copy has a network of its own. */
  portBase: z.number().int().positive().optional(),
  /** Which provider this workspace's machine was forked at, by the id that provider's own module carries in a
   * registry (`solari`, `box`, `docker`): the host's own where it forked the machine, and the joined computer's
   * own offer where `place` names one, so the two fields cannot disagree about where a machine lives. The runtime
   * stamps it; absent on every kind wsp does not fork, whose machine is the person's own, and on a place this host
   * has not yet heard what it forks with. A row names this where it would otherwise have only the provider's
   * opaque id for the machine. */
  provider: z.string().optional(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/** What a machine that already existed before wsp says about itself, read off the machine at every status poll: the
 * operating system as its maker names it with its version, how long it has been up, and the folder its commands
 * start in. A fork wsp made carries none; its image and size say what it is. */
export const MachineFacts = z.object({ os: z.string(), uptimeMs: z.number(), folder: z.string() });
export type MachineFacts = z.infer<typeof MachineFacts>;

/** WorkspaceView enriched with what the rail and meta panel render live. */
export const WorkspaceStatus = WorkspaceView.extend({
  machineState: MachineState,
  reach: ReachStatus,
  size: WorkspaceSize,
  /** Awake burn rate for this size; 0 never appears here (napping costs ride the cost event). */
  rateUsdPerHour: z.number(),
  facts: MachineFacts.optional(),
  /** Why the runtime pushed this status outside the poll: a wake that had to retry or replace the machine, or "idle 20 min". */
  reason: z.string().optional(),
  /** Which ask a wake the provider has not taken is on, of the ones the host will make; absent unless the host is
   * asking again on its own. The numbers ride, never a sentence: the row and the Machine tab read the same
   * `wakeAskingAgainLine` at different lengths, and a line built here would fit one of them and be cut in the other. */
  wakeAsk: z.object({ ask: z.number(), of: z.number() }).optional(),
  /** Epoch ms when the runtime's idle policy naps this workspace; absent while napping, held by a running session, or with auto-nap off. */
  idleAt: z.number().optional(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

/** Every field of a workspace's view that a door outside the app's own status socket hands over: the record's own
 * facts, and nothing the provider minted. Picked rather than omitted, so a route added to the view later is not
 * handed over by having been forgotten, which is how the display stream rode these doors until now. */
const WORKSPACE_OUT = {
  id: true, name: true, machineId: true, phase: true, kind: true, golden: true, createdAt: true, project: true, folder: true, home: true,
  claudeSessionId: true, gone: true, theme: true, glyph: true, daemonNote: true, daemonRefusedAt: true, vaultedAt: true, vaultRefused: true, wakeRefused: true,
  agents: true, parentThreadId: true, rootThreadId: true, parentWorkspaceId: true, place: true, provider: true, copy: true, portBase: true,
} as const;

/** A workspace as every verb answers with it: the view without the display stream a desktop machine carries, which
 * is the provider's own route with its own bearer on it. A relayed caller drives every cloud record and an agent's
 * transcript leaves the computer, so no door but the app's status socket hands one over. */
export const WorkspaceOut = WorkspaceView.pick(WORKSPACE_OUT);
export type WorkspaceOut = z.infer<typeof WorkspaceOut>;

/** A workspace as the command line and the MCP tool list it: the same fields with what the rail reads live beside
 * them, and the reach without the route it carries, since a table needs the state word and nothing that opens a
 * machine. Parsing a status through it is what drops the routes; the app's own socket still gets both. */
export const WorkspaceListing = WorkspaceStatus.pick({ ...WORKSPACE_OUT, machineState: true, size: true, rateUsdPerHour: true, reason: true, idleAt: true, facts: true }).extend({ reach: ReachView });
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

/** What moving a workspace onto a newer image came to: the workspace as it now stands, whether a machine was
 * actually replaced, and which of the files the image's own recipe writes into home this workspace had changed, so
 * its copies travelled instead of the new image's. `moved` is false for a workspace already on the newest version,
 * which is answered untouched and whose empty `kept` means nothing was judged rather than nothing was changed.
 * `fallback` is the image it stood on listing no files of its own, which is every image sealed before they were
 * recorded: nothing was left to the new image and the whole home came across. */
export const UpgradeResult = z.object({ workspace: WorkspaceView, moved: z.boolean(), kept: z.array(z.string()), fallback: z.boolean().optional() });
export type UpgradeResult = z.infer<typeof UpgradeResult>;

export const SessionStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Who asked the runtime for the turn: a person in the app, the command line on this computer, or a local agent
 * through the MCP server. All are clients of one host; the sidebar shows which one opened a thread. */
export const SessionOrigin = z.enum(["person", "cli", "agent"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

/** Where a thread's title came from, the one rule that decides whether a new one may replace it: seed is the opening
 * turn's own words, here or in the harness's own store, auto the one title the harness was asked for as the first turn
 * started, person a name the person gave the thread here or inside the harness. Auto replaces a seed and nothing else;
 * a person's name is never replaced. */
export const TitleSource = z.enum(["seed", "auto", "person"]);
export type TitleSource = z.infer<typeof TitleSource>;

/** What the agent refused a turn for, where it named a cause wsp knows: the word every door reads to class the
 * failure, since the sentence is the agent's and no door may read a reason out of its words. Adding a cause is an
 * entry here and its road on the client that shows one. */
export const TurnRefusal = z.enum(["sign-in"]);
export type TurnRefusal = z.infer<typeof TurnRefusal>;

/** What picking one option on a permission prompt does to the tool call in front of it: run it, refuse it, or run it
 * and leave the rest of the turn in another access mode, which is how a harness offers "and stop asking about
 * edits". answer is none of the three: the call in front of it only asks the person something, and the pick is what
 * it answers with. The runtime hands the option's id back to the adapter, which turns it into whatever its CLI
 * takes. */
export const PermissionEffect = z.enum(["allow", "deny", "mode", "answer"]);
export type PermissionEffect = z.infer<typeof PermissionEffect>;

export const PermissionOption = z.object({
  id: z.string(),
  label: z.string(),
  effect: PermissionEffect,
  /** The access mode the rest of the turn runs in when this option is picked; set on the mode effect only. */
  mode: z.string().optional(),
});
export type PermissionOption = z.infer<typeof PermissionOption>;

/** How a permission prompt ended. allowed and denied are a person's pick. cancelled is the prompt going with its
 * turn: a stop, or a harness that withdrew the question. unanswered is only ever read back off a transcript written
 * while wsp still denied a prompt on a clock of its own; nothing closes one that way now. */
export const PermissionOutcome = z.enum(["allowed", "denied", "unanswered", "cancelled"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcome>;

/** One permission prompt as the wire carries it, with no say in whose turn raised it: the tool it wants to run,
 * what it wants to run it on, and the options a person may pick. The prompt's own fields and nothing else, so the
 * row a transcript records and the question a thread waiting behind another thread draws are one shape. */
const permissionPrompt = {
  /** What sessions.answer names this prompt by; unique inside its turn. */
  askId: z.string(),
  toolName: z.string(),
  /** The tool_use this prompt is about, so the row sits with the call it belongs to; absent where the harness
   * named none. */
  toolUseId: z.string().optional(),
  /** The tool call that launched the agent this prompt came from; absent on every prompt the thread's own agent
   * raised. The row sits inside that agent's own fold and says which of them is asking. */
  parentToolUseId: z.string().optional(),
  /** The tool's input as the harness sent it, JSON, the same text a tool_use delta carries. */
  input: z.string(),
  /** The harness's own one phrase for the call (a file name, a command); absent where it named none. */
  detail: z.string().optional(),
  options: z.array(PermissionOption),
};

export const ThreadPrompt = z.object(permissionPrompt);
export type ThreadPrompt = z.infer<typeof ThreadPrompt>;

/** What one thread is stopped behind when the thread itself was asked nothing: the thread whose open prompt its own
 * running call is waiting on, that thread's turn as sessions.answer names it, and the question whole, so the caller
 * draws it and answers it where the person is already reading. A thread carrying this is waiting on a person as
 * surely as one carrying a prompt of its own, and the answer ends both waits at once. */
export const ThreadWaitingOn = z.object({
  threadId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  /** What that thread is called, by the one title rule foldThreads reads, so the caller names it the way every
   * other surface does rather than by an id nobody recognises. */
  title: z.string(),
  prompt: ThreadPrompt,
});
export type ThreadWaitingOn = z.infer<typeof ThreadWaitingOn>;

export const SessionView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  status: SessionStatus,
  /** Who opened the thread this row belongs to: a resumed turn takes over the row of the turn it resumes and keeps
   * its answer. Absent on rows written before provenance was recorded; foldThreads reads those as a person's. */
  startedBy: SessionOrigin.optional(),
  claudeSessionId: z.string().optional(),
  /** The thread this turn belongs to, as the runtime stamps its events; rows sharing one are one sidebar thread. */
  threadId: z.string().optional(),
  /** The thread that opened this row's thread, when an agent inside another thread did; absent on every thread a
   * person or the command line opened. rootThreadId is the top of that tree, which the machine cap counts against;
   * a row carrying a parent always carries one. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The turn that opened this row's thread; a resumed turn keeps it, and its own prompt rides its session.start
   * event, so the title every client derives from a row never follows the latest send. */
  prompt: z.string().optional(),
  /** What the harness itself calls this row's session, read from the harness's own store on the machine: the title
   * it generated, or the person's rename inside it. Absent on a harness that keeps none, and until one is read. */
  harnessTitle: z.string().optional(),
  /** Where harnessTitle came from; absent on a row written before provenance was recorded and on one with no title
   * at all, both of which read as seed. */
  titleSource: TitleSource.optional(),
  /** Ms epoch, runtime clock; endedAt is unset while the session runs. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the harness runs in: the start request's until the harness announces its own. A resume of this
   * session runs here whatever folder it asks for, since the CLI keys the session to it; the shell folder the
   * agent's tool calls move rides the delta events instead. */
  cwd: z.string().optional(),
  /** What the agent refused this turn for, where it named a cause wsp knows, off the turn's own result: a refused
   * turn did none of the work it was asked for, so a row carrying this is a turn that ran nothing. Absent on every
   * turn the agent worked on, however it ended. */
  refusal: TurnRefusal.optional(),
  /** What the turns that ran on this row have cost together, as each result reported it; absent where no turn of it
   * has ended and on a harness that reports no figure, which is not the same as nothing spent. It rides the row so
   * a listing can say what a thread spent without anyone reading its transcript. */
  costUsd: z.number().optional(),
  /** What the session runs with, as the harness's own slugs: the start request's model until the harness announces
   * its own; effort as requested, since the CLI never echoes it, and the permission mode the thread is at, which is
   * the start's until an access pick moves it, on the running turn or for the next one. */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  contextWindow: z.string().optional(),
  /** The lead of the permission prompt this turn has open and nobody has answered, as askingLine writes it;
   * absent on a turn waiting on nobody. The harness is stopped on the question while it stands, so this is the one
   * fact that says a thread is waiting on the person rather than working. */
  asking: z.string().optional(),
  /** The thread this turn's own running call is stopped behind, when that thread has a prompt open and nobody has
   * answered it. The harness here is working, but nothing it is doing can finish until a person answers somewhere
   * else, so a row carrying this is waiting on the person too. Absent on every turn blocked on nobody. Beside the
   * pid and for the same reason, it is never written down: it is read off two live turns, and a wait written down
   * outlives the question it was on. */
  waitingOn: ThreadWaitingOn.optional(),
  /** The process this turn leads on the computer the host runs on, where the turn runs there: the pid the Processes
   * pane heads this thread's tree with. Absent on a turn running on another machine, whose pids are not this
   * computer's, and on a turn that is over. It is never written down: a pid outlives nothing, and the computer is
   * free to hand it to a stranger the moment the turn ends. */
  pid: z.number().int().optional(),
});
export type SessionView = z.infer<typeof SessionView>;

/** One sidebar thread as every client lists it: the turns sharing a threadId (a row stamped none is its own),
 * titled by what the harness calls the latest turn's session and by the opening turn's words where it calls it
 * nothing, in the state and times of the latest, with the opening turn's provenance, always filled in. id is the
 * fold key, the runtime's thread id or the lone row's id; sessionId is the latest turn's row id, what a stop
 * interrupts; claudeSessionId is the latest turn's harness id, what a send resumes. */
export const ThreadView = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  workspaceId: z.string(),
  harness: z.string(),
  startedBy: SessionOrigin,
  status: SessionStatus,
  title: z.string(),
  sessionId: z.string(),
  claudeSessionId: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the latest turn's harness runs in, as SessionView.cwd; absent when no turn recorded one. */
  cwd: z.string().optional(),
  turns: z.number().int().positive(),
  /** Whether any turn of this thread ever did work, as threadRan reads the rows: false is a launch that never got
   * going, the thread a forget removes. */
  ran: z.boolean(),
  /** The opening turn's parent and root, so a listing draws the tree a root thread spawned without reading rows. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The latest turn's open permission prompt, as SessionView.asking carries it; what threadState reads. */
  asking: z.string().optional(),
  /** The thread the latest turn is stopped behind, as SessionView.waitingOn carries it; threadState reads this too,
   * since a thread that cannot move until a question elsewhere is answered is not working. */
  waitingOn: ThreadWaitingOn.optional(),
  /** What this thread has cost: its rows' figures added up. Absent where no row of it carries one. */
  costUsd: z.number().optional(),
  /** The latest turn's process on the computer the host runs on, as SessionView.pid carries it. */
  pid: z.number().int().optional(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** The thread a turn's row belongs to: the runtime's thread id, else the row's own, since a row the runtime stamped
 * no thread on is a thread of one turn. The one rule for grouping rows by thread. */
export const threadKeyOf = (session: SessionView): string => session.threadId ?? session.id;

/** Whether a turn of these rows ever did any work: one is still working, or one announced a harness session and
 * ended for something other than a refusal. Announcing is not enough on its own, since both CLIs announce their
 * session before they learn they have no sign-in, and a refused turn did none of the work it was asked for. A
 * thread with no such turn never got going, so nothing of it was written down anywhere and dropping it loses none. */
export function threadRan(turns: ReadonlyArray<Pick<SessionView, "claudeSessionId" | "status" | "refusal">>): boolean {
  return turns.some(turn => turn.status === "running" || (turn.claudeSessionId !== undefined && turn.refusal === undefined));
}

/** Folds the session index into threads, in the order each thread's first turn appears. The one place a row from
 * before provenance was recorded is read as a person's; clients print the answer and never decide it. */
export function foldThreads(sessions: ReadonlyArray<SessionView>): ThreadView[] {
  const byThread = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = threadKeyOf(session);
    const turns = byThread.get(key);
    if (turns === undefined) byThread.set(key, [session]);
    else turns.push(session);
  }
  return [...byThread].map(([id, turns]) => {
    const first = turns[0]!;
    const latest = turns[turns.length - 1]!;
    const spent = threadCost(turns);
    // The one title rule every client reads: the harness's own name for the session the next send resumes wins, so
    // a rename made inside the harness shows here, and the opening turn's first sentence stands until one is read.
    const title = latest.harnessTitle !== undefined ? titleLine(latest.harnessTitle) : first.prompt !== undefined ? openingTitle(first.prompt) : first.claudeSessionId ?? first.id;
    return {
      id,
      ...(first.threadId !== undefined ? { threadId: first.threadId } : {}),
      workspaceId: first.workspaceId,
      harness: first.harness,
      startedBy: first.startedBy ?? "person",
      status: latest.status,
      title,
      sessionId: latest.id,
      ...(latest.claudeSessionId !== undefined ? { claudeSessionId: latest.claudeSessionId } : {}),
      ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
      ...(latest.endedAt !== undefined ? { endedAt: latest.endedAt } : {}),
      ...(latest.cwd !== undefined ? { cwd: latest.cwd } : {}),
      ...(latest.asking !== undefined ? { asking: latest.asking } : {}),
      ...(latest.waitingOn !== undefined ? { waitingOn: latest.waitingOn } : {}),
      ...(latest.pid !== undefined ? { pid: latest.pid } : {}),
      turns: turns.length,
      ran: threadRan(turns),
      ...(first.parentThreadId !== undefined ? { parentThreadId: first.parentThreadId } : {}),
      ...(first.rootThreadId !== undefined ? { rootThreadId: first.rootThreadId } : {}),
      ...(spent !== undefined ? { costUsd: spent } : {}),
    };
  });
}

/** What a thread has cost: the figures its rows carry, added up; undefined where not one of them reported a
 * figure, which no reader may take for nothing spent. */
function threadCost(turns: ReadonlyArray<Pick<SessionView, "costUsd">>): number | undefined {
  const said = turns.filter(turn => turn.costUsd !== undefined);
  return said.length === 0 ? undefined : said.reduce((sum, turn) => sum + turn.costUsd!, 0);
}

// --- harness catalog (what the composer's pickers may offer) -------------------

/** One value a harness's CLI accepts for a picker, as the CLI spells it; the label is what the picker shows. */
export const HarnessOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  /** What a picker's button says once this option is picked, where the label says more than a button has room for
   * (a mode named after the machine it touches); the menu row keeps the label. Absent, the button says the label. */
  short: z.string().optional(),
});
export type HarnessOption = z.infer<typeof HarnessOption>;

/** A model, with the subset of the catalog's efforts and context windows it takes; a list absent means all of them,
 * empty means the model takes none and the composer hides that section for it. */
export const HarnessModel = HarnessOption.extend({
  efforts: z.array(z.string()).optional(),
  /** The effort this model runs at when a turn names none, where the binary reports one per model rather than one
   * for the harness; read through effortsFor, which falls back to the catalog's own mark. */
  defaultEffort: z.string().optional(),
  contextWindows: z.array(z.string()).optional(),
});
export type HarnessModel = z.infer<typeof HarnessModel>;

export const HarnessCatalogSource = z.enum(["harness", "table"]);
export type HarnessCatalogSource = z.infer<typeof HarnessCatalogSource>;

/** Where wsp keeps the control one of a CLI's screen-only commands stands for: its sign-in road, the composer's model
 * and access pickers, wsp's own settings and docs. The composer's line for the command is written per control. */
export const ScreenControl = z.enum(["sign-in", "model", "access", "settings", "docs"]);
export type ScreenControl = z.infer<typeof ScreenControl>;
/** A command of a CLI that works only in its own interactive terminal, by name without its slash, and the wsp control
 * that serves the same intent. */
export const ScreenCommand = z.object({ name: z.string(), control: ScreenControl });
export type ScreenCommand = z.infer<typeof ScreenCommand>;

/** What one harness's CLI takes at launch. A list is empty when the CLI has no such flag or its values are open,
 * and the composer hides that picker; sessions.start refuses a value a non-empty list does not carry and passes any
 * value through where the list is empty. source says whether the binary on the workspace's machine answered or the
 * runtime's table stood in, and version is the binary's, else that harness's own table pin. */
export const HarnessCatalog = z.object({
  harness: z.string(),
  label: z.string(),
  source: HarnessCatalogSource,
  version: z.string().nullable(),
  models: z.array(HarnessModel),
  /** Older models the CLI still runs by name, which the composer keeps under a fold at the end of the model menu; a
   * start takes one as it takes a model above. Read models and these together through everyModel. Absent is none. */
  legacyModels: z.array(HarnessModel).optional(),
  /** Whether the binary's own answer names its legacy models too, as Codex's model/list does, so one a live answer
   * leaves out is one it no longer runs; absent, the answer is the binary's current set and legacy models run by name. */
  legacyListed: z.boolean().optional(),
  efforts: z.array(HarnessOption),
  contextWindows: z.array(HarnessOption),
  permissionModes: z.array(HarnessOption),
  /** Whether a running turn of this harness takes a message (sessions.steer); false where the runtime's table alone
   * answers, since only the adapter on a machine knows. The composer picks send-now's road from this before the click. */
  steers: z.boolean(),
  /** Whether a person's name for one of this harness's sessions survives in the harness's own store (sessions.rename);
   * false where the runtime's table alone answers, since only the adapter on a machine knows. Read it through
   * keepsRename, which reads a table row as no answer rather than as a no. */
  renames: z.boolean(),
  /** Whether a message to this harness may carry an image; false where the runtime's table alone answers, since only
   * the adapter on a machine knows. Read it through readsImages, which reads a table row as no answer rather than as
   * a no: the composer offers the picker and the runtime answers with the agent's name if it turns out to read none. */
  images: z.boolean(),
  /** Whether wsp can hand this harness's launch an MCP server. Unlike the three above this is decided by the
   * adapter in this host and by no binary on a machine, so the table's own row is the answer and a caller may read
   * it before any workspace exists; a runtime test pins every row to its adapter's declaration. Read it through
   * takesMcpServers: absent is a no, since a catalog from before the field was declared knew of no such road. */
  mcpServers: z.boolean().optional(),
  /** This CLI's commands that work only in its own terminal, which a headless turn answers are not available. Like
   * mcpServers this is the adapter's own declaration and no binary's, so a table row is the answer and a client reads
   * it before any machine exists; absent is none. The composer lists none of them and sends nothing for one. */
  screenCommands: z.array(ScreenCommand).optional(),
  /** Whether an access picked while a turn of this harness runs reaches that turn. The adapter in this host declares
   * it, as with mcpServers, so the picker says what a pick does to the turn in front of the person before the pick
   * rather than under the box after it. Read it through movesRunningAccess: absent is a no. */
  movesAccess: z.boolean().optional(),
  /** Set on the harness a start without one runs, so a client can pick its list without the catalog package. */
  isDefault: z.boolean().optional(),
  /** Why the binary described nothing, in its own adapter's words, when it ran and refused for a reason it can name
   * (no sign-in); absent when it simply did not answer, and on a catalog the binary filled. */
  refusal: z.string().optional(),
  /** The slug of the cheapest model this harness offers, the one a thread's title is asked of; it rides the row so a
   * harness added to the table names its own. Absent where the harness offers no model of its own, and the title
   * question runs on whatever the CLI would run without one. */
  smallModel: z.string().optional(),
  /** The access a thread starts at on a kind whose row asks: the mode whose tools reach the person as a prompt where
   * this CLI can ask one (Claude Code's default over its control stream), else the narrowest mode that still lets a
   * turn work, for a CLI with no road to ask (codex exec runs non-interactively, so its sandbox is the whole
   * answer). Which kinds those are is the kind table's, not this row's: workspaceAccess marks one of these two.
   * Absent on a harness whose CLI takes no access mode at all. */
  keptMode: z.string().optional(),
  /** This CLI's mode that runs every tool without asking anyone, as it spells it, and what a thread starts at on
   * every other kind. A picker on a machine the person owns names that machine on this one, since picking it hands
   * that computer over for the turn. Absent on a harness whose CLI has no such mode. */
  bypassMode: z.string().optional(),
});
export type HarnessCatalog = z.infer<typeof HarnessCatalog>;

/** An MCP server as every agent's config names it and as a launch may carry it: the program and its arguments, run
 * over stdio. The catalog's config writers, the adapters that hand a server to a turn and the install that writes
 * one into a config file all read this shape, and none of them may import another, so it lives here. */
export interface McpServerSpec {
  command: string;
  args: readonly string[];
}

/** What a start that names MCP servers for a harness whose adapter renders none for its CLI is refused with. The
 * servers cannot be dropped quietly: a thread launched without them looks like an agent that ignored the tools it
 * was told to call, which is the whole fault the cloud setup's own thread had. */
export function noMcpServersLine(harness: string): string {
  return `${harness} takes no MCP server with a launch, so its thread would run without them; open the thread on an agent that takes them`;
}

/** Why these servers cannot go to this agent's thread, or null when they can. Every road that hands a launch a
 * server asks this before a machine is asked for anything: the caller that picks the agent, and the runtime again
 * before the turn. `takes` is the adapter's own declaration. */
export function mcpServersBlocked(servers: Readonly<Record<string, McpServerSpec>> | undefined, takes: true | undefined, harness: string): string | null {
  if (servers === undefined || Object.keys(servers).length === 0) return null;
  return takes === true ? null : noMcpServersLine(harness);
}

/** Whether a rename of one of this harness's sessions is kept in its own store, as far as this catalog knows. The
 * answer is the adapter's on the machine, so a row the runtime's table stood in for is not a no: a client offers the
 * rename and the runtime answers unsupported if the adapter turns out to carry no write. */
export function keepsRename(catalog: HarnessCatalog | null | undefined): boolean {
  return catalog === null || catalog === undefined || catalog.source === "table" || catalog.renames;
}

/** Whether a message to this harness may carry an image, as far as this catalog knows. The answer is the adapter's on
 * the machine, so a row the runtime's table stood in for is not a no: the client offers the picker and the runtime
 * refuses in the agent's name if the adapter turns out to read none. */
export function readsImages(catalog: HarnessCatalog | null | undefined): boolean {
  return catalog === null || catalog === undefined || catalog.source === "table" || catalog.images;
}

/** Whether wsp can hand this harness's launch an MCP server. Unlike the three above, a table row is the answer and
 * not a stand-in: this is decided by the adapter in this host and by no binary, so a caller may read it before any
 * machine exists. Absent is a no, which is a catalog from before the field was declared. */
export function takesMcpServers(catalog: Pick<HarnessCatalog, "mcpServers"> | null | undefined): boolean {
  return catalog?.mcpServers === true;
}

/** Whether an access picked while a turn runs reaches that turn on this harness. The adapter's own declaration, like
 * takesMcpServers; absent is a no, which is a catalog from before the field was declared, and a pick then waits for
 * the person's next message. */
export function movesRunningAccess(catalog: Pick<HarnessCatalog, "movesAccess"> | null | undefined): boolean {
  return catalog?.movesAccess === true;
}

/** Whatever carries a harness's screen-only commands: the catalog itself, or a caller that holds the list alone. */
export interface ScreenCommandsHolder {
  readonly screenCommands?: ReadonlyArray<ScreenCommand>;
}

/** The commands of this harness that work only in its CLI's own terminal; none for a catalog from before the field. */
export function screenCommandsOf(catalog: ScreenCommandsHolder | null | undefined): ReadonlyArray<ScreenCommand> {
  return catalog?.screenCommands ?? NO_SCREEN_COMMANDS;
}

const NO_SCREEN_COMMANDS: ReadonlyArray<ScreenCommand> = [];

/** The screen-only command a message would hand the CLI, or null. Only a slash that opens the whole message is a
 * command to the CLI; anywhere else it reads the words as text, so this reads the first word alone. */
export function screenCommandTyped(catalog: ScreenCommandsHolder | null | undefined, prompt: string): ScreenCommand | null {
  const name = /^\/(\S+)/.exec(prompt.trim())?.[1];
  if (name === undefined) return null;
  return screenCommandsOf(catalog).find(c => c.name === name) ?? null;
}

/** The option a list marks as its default, if one is: what an unpicked picker shows and an unnamed start runs. */
export function markedDefault<T extends HarnessOption>(options: ReadonlyArray<T>): T | undefined {
  return options.find(o => o.isDefault === true);
}

function narrowed(all: ReadonlyArray<HarnessOption>, subset: ReadonlyArray<string> | undefined): HarnessOption[] {
  return subset === undefined ? [...all] : all.filter(o => subset.includes(o.value));
}

/** The efforts a model takes: its own subset of the catalog's, in the catalog's order, else all of them, with the
 * one this pick runs at when a turn names none marked. The picked model's own default wins where the binary named
 * one, and the catalog's mark stands only for a model that names none, so the mark is the default of this pick and
 * not of the harness. A model that names a default its own list does not carry marks nothing, as a catalog whose
 * binary does. This is the one rule for that: the composer's effort picker and startPicks both read it. */
export function effortsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  const options = narrowed(catalog.efforts, model?.efforts);
  const own = model?.defaultEffort;
  if (own === undefined) return options;
  return options.map(({ isDefault: _harness, ...rest }) => (rest.value === own ? { ...rest, isDefault: true } : rest));
}

/** Every model a start may name: the catalog's current ones, then its legacy ones. */
export function everyModel(catalog: HarnessCatalog): HarnessModel[] {
  return [...catalog.models, ...(catalog.legacyModels ?? [])];
}

/** The model a pick names, as the catalog knows it; a slug the catalog does not list still counts, named by itself. */
export function modelOf(catalog: HarnessCatalog, value: string | undefined): HarnessModel | null {
  if (value === undefined) return null;
  return everyModel(catalog).find(m => m.value === value) ?? { value, label: value };
}

/** None without a model: the window rides the model as a suffix, so there is nothing to offer it on. */
export function contextWindowsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return model === null ? [] : narrowed(catalog.contextWindows, model.contextWindows);
}

/** The picks a start names, as sessions.start carries them. */
export interface StartPicks {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/**
 * A remembered pick read against the list in front of us: the value where that list carries it, nothing where it
 * does not. Every reader of a pick kept for later needs this and there is one rule for all of them, because a pick
 * is remembered per workspace while the lists belong to a harness and no two harnesses share one (claude's access
 * modes and codex's are disjoint sets, as are their models and efforts). A pick the resolved harness does not take
 * is not a request to refuse: it is a pick that does not apply here, so it is dropped and that list's own default
 * runs. startPicks refuses a value a caller NAMED, which is a different thing and stays an error.
 */
export function listedPick(options: ReadonlyArray<HarnessOption>, value: string | undefined): string | undefined {
  return value !== undefined && options.some(o => o.value === value) ? value : undefined;
}

const optionWords = (options: ReadonlyArray<HarnessOption>): string => options.map(o => `${o.label} (${o.value})`).join(", ");

function listed(subject: string, word: string, options: ReadonlyArray<HarnessOption>, value: string | undefined, legacy: ReadonlyArray<HarnessOption> = []): void {
  if (value === undefined || options.some(o => o.value === value) || legacy.some(o => o.value === value)) return;
  const older = legacy.length === 0 ? "" : `; legacy: ${optionWords(legacy)}`;
  const said = options.length === 0 ? `${subject} takes no ${word}` : `${word} "${value}" is not one ${subject} takes; one of: ${optionWords(options)}${older}`;
  throw Object.assign(new Error(said), { offered: options.length });
}

function checkedAgainst(catalog: HarnessCatalog, picks: StartPicks, model: string | undefined): void {
  if (catalog.models.length > 0) listed(catalog.harness, "model", catalog.models, picks.model, catalog.legacyModels);
  const chosen = modelOf(catalog, model);
  if (catalog.efforts.length > 0) listed(chosen?.efforts !== undefined ? chosen.label : catalog.harness, "effort", effortsFor(catalog, chosen), picks.effort);
  if (catalog.permissionModes.length > 0) listed(catalog.harness, "access mode", catalog.permissionModes, picks.permissionMode);
}

/** The picks a start runs with, checked against the catalog: a value a list does not carry is refused naming the
 * list in the composer's words, and a list the CLI leaves empty (no such flag, or open values) takes any value. A
 * start that opens a thread without a model runs the one the catalog marks default, and without an effort the one
 * effortsFor marks for that model, so every door runs what the composer shows; a resume keeps the thread's own.
 * Without a catalog (a harness the runtime has no table row for) every value passes and no default is filled. Only
 * the three picks come out, whatever else rides in. */
export function startPicks(catalog: HarnessCatalog | undefined, picks: StartPicks, opensThread: boolean): StartPicks {
  const model = picks.model ?? (opensThread && catalog !== undefined ? markedDefault(catalog.models)?.value : undefined);
  if (catalog !== undefined) checkedAgainst(catalog, picks, model);
  const effort = picks.effort ?? (opensThread && catalog !== undefined ? markedDefault(effortsFor(catalog, modelOf(catalog, model)))?.value : undefined);
  // The access is filled in like the other two, so what the picker shows is what the CLI is told: an unnamed access
  // used to reach the adapter as nothing, which every adapter here reads as its own skip-everything flag. On a
  // machine the person owns that turned the picker's Default into bypass behind their back. The mark is on the
  // catalog a workspace answered with, which workspaceAccess placed against that workspace's kind.
  const permissionMode = picks.permissionMode ?? (opensThread && catalog !== undefined ? markedDefault(catalog.permissionModes)?.value : undefined);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}

// --- session events (the wire form of adapter-port.ts's AdapterEvent) ------

/** What one piece of a turn's stream is. `note` is the harness's own line about itself, a warning about the
 * person's configuration among them: not the agent's words, not a call, and never the turn's verdict, so a reader
 * prints it as an aside and the word failed stays for a call that failed and for a turn that did. */
export const DeltaKind = z.enum(["text", "thinking", "note", "tool_use", "tool_result"]);
export type DeltaKind = z.infer<typeof DeltaKind>;

export const TurnStatus = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const TurnResult = z.object({
  status: TurnStatus,
  durationMs: z.number().optional(),
  /** How much of durationMs the turn spent stopped on a permission prompt nobody had answered. The harness's own
   * figure is wall time from launch to result, so a turn that asked and waited counts the person's minutes as its
   * own; this is what every reader takes off it. Absent on a turn nothing of it waited on. */
  waitedMs: z.number().optional(),
  costUsd: z.number().optional(),
  usage: z.record(z.unknown()).optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  /** Set only on a turn the agent refused outright for a cause wsp knows; the status is failed with it. */
  refusal: TurnRefusal.optional(),
});
export type TurnResult = z.infer<typeof TurnResult>;

const sessionScope = {
  workspaceId: z.string(),
  sessionId: z.string(),
  /** Ms epoch from the runtime clock when it recorded the event; the adapter has no clock of its own. */
  at: z.number().optional(),
  /** Minted by the runtime per sessions.start. The Claude session id repeats across --resume, so it
   * cannot split a transcript into turns; this can. */
  turnId: z.string().optional(),
  /** Minted by the runtime at a start without resume and kept by every start that resumes into it, so a
   * transcript folds into threads where it changes. Absent on transcripts from before it: those are one thread. */
  threadId: z.string().optional(),
};

/** What the CLI announces about itself in system/init, beyond model and tools. */
export const SessionHarness = z.object({
  slashCommands: z.array(z.string()).optional(),
  permissionMode: z.string().optional(),
  agents: z.array(z.string()).optional(),
});
export type SessionHarness = z.infer<typeof SessionHarness>;

export const SessionStartEvent = z.object({
  type: z.literal("session.start"),
  ...sessionScope,
  /** The user's turn; set by the runtime (the adapter never sees it) so a replayed transcript shows it. */
  prompt: z.string().optional(),
  /** The images the person's message carried, as records: their type, their weight and their name, never their
   * pixels, which reach the harness and nothing else. Absent on a turn that carried none. */
  attachments: z.array(ImageRecord).optional(),
  /** The id the client minted for the sessions.start that opened this turn, stamped by the runtime; absent when the
   * client sent none. Two clients sending the same text at the same moment are told apart by this, not the prompt. */
  requestId: z.string().optional(),
  /** Set when the thread's previous turn ended with no exit code and no result (a deadline, a host restart, a nap
   * that ended it), so clients say the harness resumes a transcript that may be missing context; absent otherwise. */
  afterCut: z.literal(true).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  /** The access this turn ran at, as the harness's own slug; the runtime's pick, not the CLI's echo. It rides the
   * row so a resume past the session index cap still reads what the thread was opened at rather than falling back
   * to the adapter's unnamed default. Absent on a turn from before it was recorded. */
  permissionMode: z.string().optional(),
  /** The agent this turn ran on, by the id SessionView.harness carries: the thread's own record stamped on its
   * transcript, beside the access and for the same cap, so a thread whose rows fell off the index still says which
   * agent it runs on. Absent on a turn from before it was recorded. */
  agent: z.string().optional(),
  tools: z.array(z.string()).optional(),
  harness: SessionHarness.optional(),
});

export const SessionDeltaEvent = z.object({
  type: z.literal("session.delta"),
  ...sessionScope,
  kind: DeltaKind,
  text: z.string(),
  /** The harness's own id for the message this piece of text belongs to, and the one home of the rule every reader
   * of text follows: append to the message you have open, open another where this changes. That is what tells the
   * reply an agent gave while a background command ran from the reply it gave when that command woke it, which the
   * harness sends as two messages and every reader used to glue into one. Absent on a row written before the stamp
   * existed and on every kind a harness names no message for, which append as they always did. */
  messageId: z.string().optional(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  isError: z.boolean().optional(),
  /** The tool call of this turn that launched the agent this line came from; absent on every line the thread's own
   * agent wrote. A harness runs its subagents on the session that spawned them, so their lines arrive among the
   * parent's and this is the only thing that tells them apart. */
  parentToolUseId: z.string().optional(),
  /** The agent's tool shell folder after this tool_use, present only when the call moved it (a cd, or a file written
   * in a folder beside the one followed so far); the panes follow it while the harness folder stays put. */
  cwd: z.string().optional(),
  /** Where this line sits in its turn, counting from one; not to be confused with `seq`, which the bus stamps on the
   * wire and the transcript never carries. A host that re-opens a running turn reads the run's output from its first
   * byte, and this is how it knows how much of it is already written: the transcript is capped per workspace and
   * drops its oldest rows, so how many of a turn's rows survive says nothing about how many there were. Absent on a
   * row written before the stamp existed. */
  line: z.number().int().positive().optional(),
});

export const SessionDoneEvent = z.object({
  type: z.literal("session.done"),
  ...sessionScope,
  result: TurnResult,
});

export const SessionEndEvent = z.object({
  type: z.literal("session.end"),
  ...sessionScope,
  exitCode: z.number().nullable(),
  sawResult: z.boolean(),
  /** Set when the runtime ended the session itself (a nap, a delete, a machine gone at the provider) rather than the harness exiting. */
  reason: z.string().optional(),
});

/** A message the person sent into the turn while it ran; stamped by the runtime once the harness took it, so a
 * replayed transcript shows it where the turn saw it. No session.start comes with it: the turn is the same one. */
export const SessionSteerEvent = z.object({
  type: z.literal("session.steer"),
  ...sessionScope,
  prompt: z.string(),
  /** The id the client minted for the sessions.steer, as on session.start. */
  requestId: z.string().optional(),
  /** Set where the turn this message joined was stopped on a permission prompt nobody had answered when it landed:
   * the message is in and the turn takes it up once the person answers, which is what the caller says rather than
   * waiting in silence. */
  waiting: z.boolean().optional(),
});
export type SessionSteerEvent = z.infer<typeof SessionSteerEvent>;

/** Pushed once when a start finds the thread's turn running and a harness that takes no message mid-turn, so the
 * caller can say it is waiting before the start's reply comes; not a session event, never in history. */
export const SessionQueuedEvent = z.object({
  type: z.literal("session.queued"),
  workspaceId: z.string(),
  threadId: z.string(),
  prompt: z.string(),
  /** The id the client minted for the sessions.start that waits. */
  requestId: z.string().optional(),
});
export type SessionQueuedEvent = z.infer<typeof SessionQueuedEvent>;

/** The word a start's notify carries to mean the caller: the thread the request came out of when it came out of one,
 * and otherwise the person who ran it. */
export const NOTIFY_ME = "me";

/** The host a turn on a machine drives, off its own environment: the address the launch put there, the token
 * beside it and the fingerprint of the key that host proves. Nothing unless the address and the token are there,
 * since an address with no token opens nothing and a token with no address names no host. The pair goes ahead of
 * every host a computer holds on its own, under only what a line names: it is the identity the launch handed the
 * turn, and the machine's own state file is a path nothing serves. The key is read here and refused where the aim
 * is made, so a launch that named an address and a token and no key is told so rather than silently aiming at the
 * computer the turn happens to run on. */
export function hostFromEnv(env: Readonly<Record<string, string | undefined>>): { url: string; token: string; hostKey?: string } | undefined {
  const url = env[HOST_URL_ENV]?.trim();
  const token = env[HOST_TOKEN_ENV]?.trim();
  const hostKey = env[HOST_KEY_ENV]?.trim();
  if (url === undefined || url === "" || token === undefined || token === "") return undefined;
  return { url, token, ...(hostKey === undefined || hostKey === "" ? {} : { hostKey }) };
}

/** Where a machine's daemon bundle is unpacked, and the wsp command that rides in it: one file, the whole bundled
 * command, so a turn on any machine with a daemon can drive this host with no install of its own. Named here
 * because the host stages the file and the runtime builds the launch that runs it, and neither may import the
 * other's rule. */
export const GUEST_DAEMON_DIR = "/root/wsp-daemon";
/** The command sits in the bundle as npm lays the published package out, its package.json beside a dist folder and
 * its own assets beside those, because the bin reads its own version through that file (`../package.json` from the
 * bin) and announces it in every MCP handshake; a client refuses a server that names none. Named as a folder
 * rather than as the bin alone, since the daemon binary the bundle carries rides in that package's assets and the
 * command reads it there the way an installed copy reads its own. */
export const wspPackageIn = (dir: string): string => `${dir}/wsp`;
export const wspBinIn = (dir: string): string => `${wspPackageIn(dir)}/dist/bin.js`;
export const GUEST_WSP_BIN = wspBinIn(GUEST_DAEMON_DIR);
/** The wsp a process inside a fork runs, and the one word a launch names it by: two lines the deploy writes onto
 * the machine's PATH, handing the whole line to the daemon binary beside them, which carries it to the host over
 * the socket the host already holds to this machine's daemon. The binary's own path is not named here: it sits in
 * the bundle under one folder per chip, and only the machine says which chip it is. */
export const GUEST_WSP_PATH = "/usr/local/bin/wsp";

/** The token a client puts on its requests, off its own environment; nothing when it is not running inside a turn. */
export function turnTokenOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = env[TURN_TOKEN_ENV];
  return token === undefined || token === "" ? undefined : token;
}

/** The turn ended and its one line (notifyLine) went where the thread's start said: into the named thread as a send
 * would go, steered or queued, or, for me, to the person, whom the CLI and the app tell from this event. One row per
 * target, so a start that named two threads is two rows. Recorded in the ending thread's transcript, before its
 * session.done, so the line's source is visible and a follower that ends on the done still sees it. */
export const SessionNotifyEvent = z.object({
  type: z.literal("session.notify"),
  ...sessionScope,
  /** The thread the line went to, or NOTIFY_ME. */
  notify: z.string(),
  text: z.string(),
});
export type SessionNotifyEvent = z.infer<typeof SessionNotifyEvent>;


/** One permission prompt the harness raised, relayed into the chat as its own row. The prompt blocks the turn until
 * sessions.answer names an option or the turn itself ends, so the row is what the thread is waiting on for as long
 * as the turn lives. */
export const SessionPermissionEvent = z.object({
  type: z.literal("session.permission"),
  ...sessionScope,
  ...permissionPrompt,
});
export type SessionPermissionEvent = z.infer<typeof SessionPermissionEvent>;

/** The prompt above is closed and the turn moved on. One of these lands for every session.permission, so a
 * transcript never leaves a row waiting on an answer that was given while nobody was reading. */
export const SessionPermissionClosedEvent = z.object({
  type: z.literal("session.permission.closed"),
  ...sessionScope,
  askId: z.string(),
  outcome: PermissionOutcome,
  /** The option that closed it, on a person's pick; absent on the runtime's own deny and on a cancel. */
  optionId: z.string().optional(),
});
export type SessionPermissionClosedEvent = z.infer<typeof SessionPermissionClosedEvent>;

/** The events sessions.history replays: what a chat transcript folds. */
export const SessionEvent = z.discriminatedUnion("type", [
  SessionStartEvent,
  SessionDeltaEvent,
  SessionDoneEvent,
  SessionEndEvent,
  SessionSteerEvent,
  SessionNotifyEvent,
  SessionPermissionEvent,
  SessionPermissionClosedEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Every type a session event carries, read off the union itself: a client telling a session event from the rest of
 * the bus asks this rather than keeping a list of its own, which one added event leaves quietly short. */
export const SESSION_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set(SessionEvent.options.map(o => o.shape.type.value));

/** Whether one event off the bus is a session's, narrowed: the one test every reader that folds a thread's events
 * out of the whole channel makes, so none of them keeps a list or a cast of its own. */
export const isSessionEvent = (e: { type: string }): e is SessionEvent => SESSION_EVENT_TYPES.has(e.type as SessionEvent["type"]);

// --- workspace / port / inbox events ----------------------------------------

/** A machine this runtime now has: a create that landed, or a record the sweep restored from the provider's
 * listing. Readers that meter the machine (the awake stretch, the auto-nap window) take it as the machine coming
 * up, so a change to a record a client already holds is never this event. */
export const WorkspaceCreatedEvent = z.object({ type: z.literal("workspace.created"), workspace: WorkspaceView });
/** The awaited steps of a create in the order the runtime reaches them; `failed` ends a create that threw. */
export const WorkspaceCreateStage = z.enum(["fork-requested", "hostname-set", "preview-route", "daemon-answering", "project-cloned", "ready", "failed"]);
export type WorkspaceCreateStage = z.infer<typeof WorkspaceCreateStage>;
/** Whether a line of a create's log is the step the create is waiting on, rather than a note on a step it already
 * took. A surface with one line for the whole create shows the last of these, so a cosmetic step's verdict never
 * stands where the create's state belongs. Takes the word a line carries, since the image build's own lines share
 * that log and are steps like any other. */
export const creationAwaits = (stage: string): boolean => stage !== "hostname-set";
/** Progress of one create, from the first request to ready or failed: the id the workspace will carry, its name, one
 * plain sentence per stage, the time since the create began, and a notice when a step did something worth reading
 * (a kept builder was stopped to make room at the machine cap). */
export const WorkspaceCreatingEvent = z.object({
  type: z.literal("workspace.creating"),
  workspaceId: z.string(),
  name: z.string(),
  stage: WorkspaceCreateStage,
  message: z.string(),
  elapsedMs: z.number(),
  notice: z.string().optional(),
  /** What the machine answered this step with, for the line's title: a guest's refusal is evidence a person may
   * need and never a sentence written at them, so no surface draws it as one. */
  detail: z.string().optional(),
  /** The thread this fork was asked for by, from the first stage: a create streams stages before the workspace has
   * a record, so the stream's tree rule reads who asked off the event rather than off a record that is not there
   * yet. Absent where a person asked for the machine. */
  askedBy: EventAsker.optional(),
});
export type WorkspaceCreatingEvent = z.infer<typeof WorkspaceCreatingEvent>;
/** found is set when the provider had already paused the machine and this host only followed it: the awake
 * stretch ended at the last instant the meter saw the machine awake, not at this event. */
export const WorkspaceNappedEvent = z.object({ type: z.literal("workspace.napped"), workspaceId: z.string(), found: z.boolean().optional() });
export const WorkspaceWokenEvent = z.object({
  type: z.literal("workspace.woken"),
  workspaceId: z.string(),
  machineId: z.string(),
  /** True when the paused machine had vanished and a fresh golden fork replaced it. */
  resurrected: z.boolean(),
});
/** The machine was replaced by a fresh golden fork carrying the vault: an
 * upgrade under a new size, or a rebuild of a zombie. Clients re-dial reach. */
export const WorkspaceUpgradedEvent = z.object({
  type: z.literal("workspace.upgraded"),
  workspaceId: z.string(),
  machineId: z.string(),
});
/** A person named the workspace: its record alone changed, and every client puts the name on the row it holds. The
 * machine was not touched, so nothing that meters it reads this. */
export const WorkspaceRenamedEvent = z.object({ type: z.literal("workspace.renamed"), workspaceId: z.string(), name: z.string() });
/** A person set the workspace's theme or its glyph: the record alone changed, and both facts travel whole so a
 * client never has to merge one key into what it holds. null on either is none picked. */
export const WorkspaceLookEvent = z.object({
  type: z.literal("workspace.look"),
  workspaceId: z.string(),
  theme: WorkspaceTheme.nullable(),
  glyph: WorkspaceGlyph.nullable(),
});
/** A person changed what the agents on a workspace may ask of this host. The whole switch travels, so a client
 * never merges one key into what it holds; nothing about the machine changed. */
export const WorkspaceAgentsEvent = z.object({ type: z.literal("workspace.agents"), workspaceId: z.string(), agents: WorkspaceAgents });
export const WorkspaceDeletedEvent = z.object({ type: z.literal("workspace.deleted"), workspaceId: z.string() });
/** The provider stopped knowing the machine: the workspace's phase is gone from here until a rebuild or a delete.
 * Sessions on it ended, the rate is 0, the idle window is dropped; reason carries the provider's words. */
export const WorkspaceGoneEvent = z.object({
  type: z.literal("workspace.gone"),
  workspaceId: z.string(),
  machineId: z.string(),
  reason: z.string(),
});

export const WorkspaceStatusEvent = z.object({ type: z.literal("workspace.status"), status: WorkspaceStatus });

/** Awake-time cost tick. Computed locally from size and elapsed running time
 * (provider billing API integration is a later plan); zero rate while napping. */
export const WorkspaceCostEvent = z.object({
  type: z.literal("workspace.cost"),
  workspaceId: z.string(),
  phase: WorkspacePhase,
  /** Current burn: the size's awake rate while running, 0 while napping. */
  rateUsdPerHour: z.number(),
  /** Total awake milliseconds behind accruedUsd since metering began; carried across host restarts. */
  awakeMs: z.number(),
  /** The awake time so far billed stretch by stretch at the rate that held over each, so a machine replaced or a
   * wake never re-prices what came before it. */
  accruedUsd: z.number(),
  at: z.string(),
});
export type WorkspaceCostEvent = z.infer<typeof WorkspaceCostEvent>;

export const PortOpenEvent = z.object({
  type: z.literal("port.open"),
  workspaceId: z.string(),
  port: z.number(),
  pid: z.number().optional(),
  /** The listener's /proc/<pid>/comm; absent when the pid or its comm is unreadable. */
  process: z.string().optional(),
});
/** Who held the port when it closed, from the watcher's last row for it; at is the daemon's clock. */
const portCloseDetail = {
  pid: z.number().optional(),
  process: z.string().optional(),
  /** The holder's argv joined by spaces, from /proc/<pid>/cmdline; the daemon reads at most 512 bytes of it and a cut argv ends with an ellipsis. */
  command: z.string().optional(),
  /** Whether the holder's pid was gone when the close was seen; absent without a pid. */
  exited: z.boolean().optional(),
  at: z.string().optional(),
};
export const PortCloseEvent = z.object({ type: z.literal("port.close"), workspaceId: z.string(), port: z.number(), ...portCloseDetail });
export const InboxFileEvent = z.object({
  type: z.literal("inbox.file"),
  workspaceId: z.string(),
  path: z.string(),
  bytes: z.number(),
});

// --- project bundle: a folder on this computer landed on a workspace -----------

/** How the collector's credential pass decided a file is secret-shaped: by name, by owner-only mode, by the key
 * names in it, by a PEM header, by a URL with a password in it, by a gitleaks hit, by the catalog, by secret-shaped
 * exports, or by git history. */
export const CredentialSignal = z.enum(["name", "mode", "keys", "pem", "url", "gitleaks", "catalog", "exports", "history"]);
export type CredentialSignal = z.infer<typeof CredentialSignal>;
/** How a repository config lands when its rewrite is accepted: `urls` as they then read, their userinfo removed,
 * and `drop` the config keys (http.extraheader carrying an Authorization header) whose lines are left out. */
export const ProjectRewrite = z.object({ urls: z.array(z.string()), drop: z.array(z.string()) });
export type ProjectRewrite = z.infer<typeof ProjectRewrite>;
/** A secret-shaped file in the folder, by path relative to it; it travels only when the import names it in carry,
 * or in rewrite when `rewrite` is offered: then it lands rewritten as described, and the machine's own login (gh's)
 * is the credential there. Offered only when the rewrite removes every secret shape the file has. */
export const ProjectSecret = z.object({ path: z.string(), bytes: z.number(), signals: z.array(CredentialSignal), rewrite: ProjectRewrite.optional() });
export type ProjectSecret = z.infer<typeof ProjectSecret>;
/** How an agent's state for the folder travels by file: `moves` when the files carry every key and the resolver
 * re-keys them to the new path so the agent resumes there, `transcript-only` when the rows in a shared store that
 * hold or find the sessions stay behind and only the files travel, if there are any. */
export const ProjectCarry = z.enum(["moves", "transcript-only"]);
export type ProjectCarry = z.infer<typeof ProjectCarry>;
/** One agent whose home on this computer holds sessions for the folder, by catalog id: the count, the bytes of the
 * state files that would travel and the carry answer. An agent whose store could not be read keeps its row with
 * `error` saying why and zero sessions; it never travels. */
export const ProjectAgent = z.object({ agent: z.string(), name: z.string(), sessions: z.number(), bytes: z.number(), carry: ProjectCarry, error: z.string().optional() });
export type ProjectAgent = z.infer<typeof ProjectAgent>;
/** What a project import would carry, for the person to read before anything is packed: the files and their bytes,
 * the secret-shaped ones, the caches left behind (relative paths), the paths named but not carried, with why, and the
 * agents with sessions for the folder. */
export const ProjectPlan = z.object({
  /** The folder on this computer, absolute. */
  source: z.string(),
  /** Whether the folder has a .git; the repository travels whole when it does. */
  repo: z.boolean(),
  /** Regular files that would travel, the secret-shaped ones counted. */
  files: z.number(),
  bytes: z.number(),
  secrets: z.array(ProjectSecret),
  excluded: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), note: z.string() })),
  agents: z.array(ProjectAgent),
});
export type ProjectPlan = z.infer<typeof ProjectPlan>;
/** The steps of one import in order; `failed` ends one that threw. */
export const ProjectImportStage = z.enum(["planned", "consented", "packing", "uploading", "landing", "done", "failed"]);
export type ProjectImportStage = z.infer<typeof ProjectImportStage>;
/** Progress of one import: one plain sentence per stage, the time since it began, and on uploading the bytes sent so
 * far of the archive's total. */
export const ProjectImportEvent = z.object({
  type: z.literal("project.import"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectImportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectImportEvent = z.infer<typeof ProjectImportEvent>;
/** What became of one agent the import named: `moved` when the agent is on the machine and its module re-keyed every
 * file to dest, or merged its rows into its store there; `transcript-only` when it is on the machine but only its
 * files landed and the rows in its shared store that list them are still to come; `carried` when it is not there so
 * the files landed as they were, `nothing` when no file of its travelled, `failed` when the move raised and nothing of
 * that agent landed, or the merge on the machine failed after its files did; files and bytes are what landed. */
export const ProjectAgentOutcome = z.enum(["moved", "transcript-only", "carried", "nothing", "failed"]);
export type ProjectAgentOutcome = z.infer<typeof ProjectAgentOutcome>;
/** `sessions` is how many the files hold when the trip counted them; `skipped` is how many sessions the agent's own
 * index named whose transcript was not under its home (Codex keeps archived ones elsewhere), so their rows moved
 * and nothing else did. `rows` is what the merge on the machine inserted or updated in the agent's store, once it
 * ran; `note` says why the rows still wait when they could not be merged yet (the agent has not made its store
 * there), or what the merge kept as the machine had it rather than as carried. */
export const ProjectAgentResult = z.object({
  agent: z.string(),
  files: z.number(),
  bytes: z.number(),
  outcome: ProjectAgentOutcome,
  sessions: z.number().optional(),
  skipped: z.number().optional(),
  error: z.string().optional(),
  rows: z.number().optional(),
  note: z.string().optional(),
});
export type ProjectAgentResult = z.infer<typeof ProjectAgentResult>;
/** What landed: the path on the machine, the files and bytes extracted there, the upload parts, the secret-shaped
 * paths that were cut because the import did not name them, the ones that landed rewritten as the plan offered,
 * each named agent's outcome, and the project the workspace now holds, so a client shows the folder in its list the
 * moment the host answers rather than waiting for the machine to say anything about it. */
export const ProjectImportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), parts: z.number(), cut: z.array(z.string()), rewritten: z.array(z.string()), agents: z.array(ProjectAgentResult), project: WorkspaceProject });
export type ProjectImportResult = z.infer<typeof ProjectImportResult>;
/** The steps of one export in order; `failed` ends one that threw. */
export const ProjectExportStage = z.enum(["packing", "downloading", "landing", "done", "failed"]);
export type ProjectExportStage = z.infer<typeof ProjectExportStage>;
/** Progress of one export, the bundle's trip home: one plain sentence per stage, the time since it began, and on
 * downloading the bytes received so far of the archive's total. `source` is the folder on the machine, `dest` where
 * it lands on this computer. */
export const ProjectExportEvent = z.object({
  type: z.literal("project.export"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectExportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectExportEvent = z.infer<typeof ProjectExportEvent>;
/** What came home: the folder on this computer, the files and bytes landed there, the cache roots left behind on
 * the machine (relative paths), and each agent whose state for the folder was found on the machine with what became
 * of it here: `moved` when its module keyed every file to dest, `transcript-only` when the files landed but the rows
 * in its shared store here do not list them yet, `nothing` when it had no file to bring, `failed` with the reason. */
export const ProjectExportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), excluded: z.array(z.string()), agents: z.array(ProjectAgentResult) });
export type ProjectExportResult = z.infer<typeof ProjectExportResult>;

// --- a computer's folders, as a folder picker browses them --------------------

/** One folder on a computer the host holds. `repo` is a folder git tracks, which a picker marks. */
export const HostFolder = z.object({
  path: z.string(),
  repo: z.boolean(),
  /** On a repo found by a repos listing: the branch its checkout is on, absent on a detached head. */
  branch: z.string().optional(),
  /** On a repo found by a repos listing: when git last wrote to it, in ms, which the list is sorted by. */
  touchedAt: z.number().optional(),
});
export type HostFolder = z.infer<typeof HostFolder>;
/** One level of a computer's disk, this one's or a box's: the folder listed, the roots every level is browsed from
 * (that computer's home folder and each of its projects' folders), the folders directly inside it, and how many
 * were left out for being hidden. No web picker can hand a page a path, so this is what a browser tab has instead of
 * the desktop shell's dialog, and the only way to see a box's folders at all. */
export const HostFolderListing = z.object({
  dir: z.string(),
  roots: z.array(z.string()),
  folders: z.array(HostFolder),
  /** Folders whose name starts with a dot, counted rather than listed unless the ask said to list them. */
  hidden: z.number().int(),
});
export type HostFolderListing = z.infer<typeof HostFolderListing>;

// --- the person's own terminal config, as the terminal pane applies it --------

export const TerminalScheme = z.enum(["light", "dark"]);
export type TerminalScheme = z.infer<typeof TerminalScheme>;
const channel = z.number().int().min(0).max(255);
export const TerminalRgb = z.object({ r: channel, g: channel, b: channel });
export type TerminalRgb = z.infer<typeof TerminalRgb>;
/** Ghostty's cursor-style words, which libghostty takes as its default cursor style. */
export const TerminalCursorStyle = z.enum(["block", "bar", "underline", "block_hollow"]);
export type TerminalCursorStyle = z.infer<typeof TerminalCursorStyle>;
/** The keys of a Ghostty config the terminal pane honours, read off this computer with Ghostty's own lookup order
 * and its theme resolved for one scheme. Only what the files set is here: an absent key leaves the pane's default.
 * `files` is every config and theme file read, in load order; empty when the person has no Ghostty config. Every
 * key but `backgroundBlur` is applied; that one is served for the record, since the blur is the desktop window's
 * own material and a browser tab has none. */
export const TerminalConfig = z.object({
  files: z.array(z.string()),
  /** The primary face first, then the fallbacks the file names after it. */
  fontFamily: z.array(z.string()),
  fontSize: z.number().positive().optional(),
  /** The theme the file names for the scheme asked for, as it names it. */
  theme: z.string().optional(),
  background: TerminalRgb.optional(),
  foreground: TerminalRgb.optional(),
  /** Palette entries 0 to 15; null where the files set none. */
  palette: z.array(TerminalRgb.nullable()).length(16),
  selectionBackground: TerminalRgb.optional(),
  cursorColor: TerminalRgb.optional(),
  cursorStyle: TerminalCursorStyle.optional(),
  cursorStyleBlink: z.boolean().optional(),
  windowPaddingX: z.object({ left: z.number().min(0), right: z.number().min(0) }).optional(),
  windowPaddingY: z.object({ top: z.number().min(0), bottom: z.number().min(0) }).optional(),
  /** 1 is opaque; under 1 the pane paints its background over whatever sits behind it. */
  backgroundOpacity: z.number().min(0).max(1).optional(),
  /** Ghostty's blur intensity; 0 is none, true in the file is 20. Read and served, not applied by the pane. */
  backgroundBlur: z.number().int().min(0).optional(),
});
export type TerminalConfig = z.infer<typeof TerminalConfig>;

// --- preferences (the person's view of the app, kept on the host so every client agrees) ---

/** Which side of the stylesheet the page draws: the computer's own, or one side pinned. */
export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Which body the sidebar draws: every workspace and its threads, or Spaces, one workspace at a time. */
export const SidebarMode = z.enum(["list", "spaces"]);
export type SidebarMode = z.infer<typeof SidebarMode>;

/** Where the terminal pane's text size comes from before a zoom moves it: the app's own size, or the size the person's Ghostty file names. */
export const TerminalSizeSource = z.enum(["app", "file"]);
export type TerminalSizeSource = z.infer<typeof TerminalSizeSource>;

/** The last target: the workspace a thread was last started on. A workspace holds one project, so the workspace
 * is the whole of the answer. */
export const PreferencesTarget = z.object({ workspace: z.string() }).strict();
export type PreferencesTarget = z.infer<typeof PreferencesTarget>;

/** One record on the host's state; the desktop app and a browser tab on the same host read and write this one. sidebarWidth
 * absent is the sidebar's own default; terminalZoom is the pixels a workspace's panes add to the base size, by workspace id. */
/** The glyphs a project can wear in the sidebar and the switcher; the app maps each word to its drawing. */
export const ProjectIcon = z.enum(["folder", "code", "terminal", "globe", "rocket", "box", "database", "server", "cpu", "zap", "flame", "leaf", "star", "heart", "book", "music", "camera", "gamepad", "shield", "wrench"]);
export type ProjectIcon = z.infer<typeof ProjectIcon>;
/** The hues a project's glyph can take; the app maps each word to a colour of its own theme. */
export const ProjectHue = z.enum(["neutral", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"]);
export type ProjectHue = z.infer<typeof ProjectHue>;
/** How one project is drawn: its glyph and its hue, each the default where absent. */
export const ProjectLook = z.object({ icon: ProjectIcon.optional(), hue: ProjectHue.optional() }).strict();
export type ProjectLook = z.infer<typeof ProjectLook>;
/** The glyphs a computer can wear on the Computers page; the app maps each word to its drawing. */
export const ComputerIcon = z.enum(["laptop", "desktop", "server", "cloud", "cpu", "drive", "container", "home"]);
export type ComputerIcon = z.infer<typeof ComputerIcon>;
export const ComputerLook = z.object({ icon: ComputerIcon }).strict();
export type ComputerLook = z.infer<typeof ComputerLook>;

/** A theme's id, one per side. The shape is checked here; which ids exist is the app's registry, which reads an id it
 * does not know as that side's default, so a theme added later needs nothing from the host. */
export const ThemeId = z.string().min(1);
/** Each side's theme before a person picks one. */
const THEME_PICK_DEFAULTS = { lightTheme: "paper", darkTheme: "graphite" } as const;

export const Preferences = z.object({
  theme: ThemePreference,
  /** Each side's pick. Defaulted rather than required, so a record from a host older than the picks still parses on the
   * wire and does not blank every other preference. */
  lightTheme: ThemeId.default(THEME_PICK_DEFAULTS.lightTheme),
  darkTheme: ThemeId.default(THEME_PICK_DEFAULTS.darkTheme),
  sidebarMode: SidebarMode,
  sidebarWidth: z.number().int().positive().optional(),
  terminalSize: TerminalSizeSource,
  terminalZoom: z.record(z.string(), z.number().int()),
  /** The access mode the composer last picked in a workspace, by workspace id, in the harness's own slug. It is on
   * this record rather than in one browser's storage because the host reads it too: a thread opened with no access
   * named runs at the person's last pick for that workspace, whichever client or CLI opened it. Keyed by workspace
   * alone, as the composer's other picks are, so it is read through listedPick: a workspace's threads may run on
   * either harness and their mode lists are disjoint, and a pick the harness in front of us does not take drops to
   * that harness's own default rather than refusing the send. */
  access: z.record(z.string(), z.string()),
  /** The workspace a thread was last started on anywhere: where a new thread asked for from nowhere goes. Absent
   * until the first start. */
  target: PreferencesTarget.optional(),
  /** How each project is drawn, by project id; kept here so every screen that opens this wsp draws it the same. */
  projectLook: z.record(z.string(), ProjectLook),
  /** How each computer is drawn, by place id. Defaulted rather than required, so a record from a host that kept no
   * icons still parses on the wire and does not blank every other preference. */
  computerLook: z.record(z.string(), ComputerLook).default({}),
  /** Whether the host asks Google for each remote MCP server's icon by its host name. On unless the person turns it
   * off; defaulted so a record from a host older than the switch reads as on. */
  serverIcons: z.boolean().default(true),
  /** Whether the host asks each agent's vendor for its newest version. On unless the person turns it off, and
   * WSP_UPDATE_CHECK=0 in the host's environment stops it whatever this says; defaulted as serverIcons is. */
  agentVersions: z.boolean().default(true),
  /** Whether the surfaces still being worked on are offered at all. The host stamps it from its own environment at
   * every read, so no client sets it and nothing a state file holds can turn it on. */
  labs: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

/** Whether labs is on in an environment: LABS_ENV set to exactly 1, and nothing else counts. */
export const labsFromEnv = (env: Record<string, string | undefined>): boolean => env[LABS_ENV] === "1";

/** What preferences.set takes: any of the record's fields but labs, which is the host's to say; a null sidebarWidth
 * clears it back to the default, terminalZoom and access name only the workspaces they move, a null entry dropping
 * that workspace's zoom or pick, and a null target clears the last target. Strict, so a field this record dropped
 * is refused rather than written into a state file nothing reads. */
export const PreferencesPatch = Preferences.omit({ labs: true })
  .partial()
  .extend({
    sidebarWidth: z.number().int().positive().nullable().optional(),
    terminalZoom: z.record(z.string(), z.number().int().nullable()).optional(),
    access: z.record(z.string(), z.string().nullable()).optional(),
    projectLook: z.record(z.string(), ProjectLook.nullable()).optional(),
    computerLook: z.record(z.string(), ComputerLook.nullable()).optional(),
    target: PreferencesTarget.nullable().optional(),
  })
  .strict();
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", ...THEME_PICK_DEFAULTS, sidebarMode: "list", terminalSize: "app", terminalZoom: {}, access: {}, projectLook: {}, computerLook: {}, serverIcons: true, agentVersions: true, labs: false };

/** The record as stored, over the defaults; a record that does not parse (an older or a hand-edited state file) reads as the defaults. */
export function preferencesFrom(stored: unknown): Preferences {
  const parsed = Preferences.partial().safeParse(stored ?? {});
  return parsed.success ? applyPreferencesPatch(DEFAULT_PREFERENCES, parsed.data) : DEFAULT_PREFERENCES;
}

/** The record with the patch's fields over it. The one merge rule, read by the host that keeps the record and the client
 * that paints ahead of the host's answer, so both land on the same record. */
export function applyPreferencesPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const sidebarWidth = patch.sidebarWidth === undefined ? current.sidebarWidth : patch.sidebarWidth;
  const perWorkspace = <T,>(kept: Record<string, T>, moved: Record<string, T | null> | undefined): Record<string, T> => {
    const next = { ...kept };
    for (const [workspaceId, value] of Object.entries(moved ?? {})) {
      if (value === null) delete next[workspaceId];
      else next[workspaceId] = value;
    }
    return next;
  };
  const target = patch.target === undefined ? current.target : patch.target;
  return {
    theme: patch.theme ?? current.theme,
    lightTheme: patch.lightTheme ?? current.lightTheme,
    darkTheme: patch.darkTheme ?? current.darkTheme,
    sidebarMode: patch.sidebarMode ?? current.sidebarMode,
    terminalSize: patch.terminalSize ?? current.terminalSize,
    terminalZoom: perWorkspace(current.terminalZoom, patch.terminalZoom),
    access: perWorkspace(current.access, patch.access),
    projectLook: perWorkspace(current.projectLook, patch.projectLook),
    computerLook: perWorkspace(current.computerLook, patch.computerLook),
    serverIcons: patch.serverIcons ?? current.serverIcons,
    agentVersions: patch.agentVersions ?? current.agentVersions,
    labs: current.labs,
    ...(sidebarWidth === null || sidebarWidth === undefined ? {} : { sidebarWidth }),
    ...(target === null || target === undefined ? {} : { target }),
  };
}

/** What a set that turned server icons off answers when their folder would not go: the record is kept all the same. */
export const serverIconsLeftLine = (folder: string, reason: string): string =>
  `Server icons are off, but ${folder} could not be deleted: ${reason}. Delete it by hand.`;

/** The host's record changed, by any client; every socket gets the whole record. */
export const PreferencesChangedEvent = z.object({ type: z.literal("preferences.changed"), preferences: Preferences });
export type PreferencesChangedEvent = z.infer<typeof PreferencesChangedEvent>;

// --- desktop shell bridge (preload to page) -----------------------------------

/** One installed font file the desktop shell hands the page for its terminal, registered under the family the file names. */
export interface LocalFontFace {
  family: string;
  weight: 400 | 700;
  style: "normal" | "italic";
  data: ArrayBuffer;
}

/** The one inline script the page carries, as the host writes the boot object into it and as a reader finds that
 * object again: the whole script element, with the object as its one group. Nothing else the host serves carries
 * this line, so finding it is the whole reading of whether a page came off a wsp host. */
export const BOOT_SCRIPT = /<script>window\.__WSP__ = ([^<]*);<\/script>/;

/** The boot object of a page a host served, or nothing where the page carries no such line, a line no wsp host
 * wrote, or one that does not parse. */
export function bootLineOf(html: string): BootPayload | undefined {
  const found = BOOT_SCRIPT.exec(html);
  if (found === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(found[1]!);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as BootPayload).wsPath !== "string") return undefined;
    return parsed as BootPayload;
  } catch {
    return undefined;
  }
}

/** What the host writes into the page's one inline script as window.__WSP__ before serving it. */
export interface BootPayload {
  /** The runtime's own port, inlined only on the loopback page beside the token's digest; a page served beyond
   * loopback carries none and dials the origin it came from at wsPath. */
  wsPort?: number;
  /** The sha256 of the host's own token, hex, inlined only on the loopback page: the desktop shell compares it to the
   * digest of the token file beside the state and sends nothing, so a page a squatter serves on the lock's port
   * cannot learn the token by being read. The token itself is never in any page: a browser here dials with a
   * device token wsp init or wsp host pair let it in with, and the shell hands its page the file's over the bridge. */
  tokenHash?: string;
  /** The path on this page's own origin the runtime WebSocket answers on, which is the one road a client reaching
   * the host through an ssh forward or a tunnel hostname has. */
  wsPath: string;
  /** True when this page was served on the computer the host runs on, which is the page's one reading of being at
   * home: false is a host on another computer, whose page pairs for a device token of its own. */
  paired: boolean;
  /** The release this host is, which is the release this page is: a desktop shell attached to a host it did not
   * start reads it to tell whether the two halves were built apart. */
  version: string;
  /** The family the person's terminal draws with, when the saved recipe ticks its row; the terminal pane defaults to it. */
  terminalFont?: string;
  /** The state file this host serves; the page keeps what it remembers (the workspace open last) under it. A page
   * served beyond loopback carries none, so every stranger's page remembers under one empty slot. */
  statePath?: string;
}

/** One row of a context menu as the page hands it to the desktop shell, which builds the native menu from it. An item
 * that cannot run right now is shown dimmed with its refusal as the hover text; rows of different groups are parted by
 * a separator. shortcut is the label the page shows, accelerator the same chord in Electron's spelling. */
export interface ContextMenuItem {
  id: string;
  label: string;
  group: string;
  enabled: boolean;
  refusal?: string;
  /** What a row that can run says on hover, where the label leaves something out a person would want before pressing
   * it. The two are one slot, read refusal first: a row is either dimmed with a reason or live with a word about
   * what it does, never both, which is the reading every button in the app already makes. */
  hint?: string;
  shortcut?: string;
  accelerator?: string;
  destructive?: boolean;
  /** A row that marks a state, drawn with a check when true; a row with no mark at all leaves this out. */
  checked?: boolean;
}

// --- hosts the desktop window can move between --------------------------------

/** One host on the account as the desktop lists it, by the alias wsp's command line names the same record by: never
 * the token. */
export interface HostListing {
  alias: string;
  url: string;
}

/** The hosts as the window shows them: the word for the app's own computer, which host the window is on (null for
 * that computer), and every saved host. */
export interface HostsView {
  here: string;
  current: string | null;
  hosts: HostListing[];
}

/** How a host move ended: done, or refused in the host's own words. */
export type HostOutcome = { ok: true } | { ok: false; error: string };

/** How the shell's fetch or open of a release's bundle ended: done, or refused in one line the page shows as it is. */
export type BundleOutcome = { ok: true } | { ok: false; error: string };

/** The class the desktop preload puts on the html element when the window has no title bar of its own: the app's
 * header row is the window's frame, the traffic lights sit in it and the sidebar shows the window's frosted glass. */
export const DESKTOP_MAC_CLASS = "desktop-mac";

/** A key press the desktop shell took from its own menu and handed to the page, spelled the way a keyboard event
 * spells it, so the page's one keybinding table answers it. */
export interface ShellChord {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** What the desktop shell's preload puts on window.wsp; a browser tab has none of it. */
export interface DesktopBridge {
  /** The release this shell is, so a page served by a host of another one can say which half is behind. Absent on
   * a shell from before the bridge carried it, which is older than any page that reads this. */
  readonly version?: string;
  /** The words over Get on this shell's platform, from the shell's own bundle row; absent where none is built. */
  readonly bundleHover?: string;
  /** The installed faces for a family and its Nerd Font variants, from this computer's font directories. */
  localFonts(family: string): Promise<LocalFontFace[]>;
  /** The system folder picker; the absolute path chosen, or nothing when it was dismissed. */
  pickFolder(): Promise<string | undefined>;
  /** The absolute path of a file or folder dropped on the window from the desktop, which the page itself cannot
   * read; nothing on a page served by a host somewhere else, which is handed no path from this computer. */
  droppedPath(file: File): string | undefined;
  /** The native context menu at the pointer, built from the items; resolves with the chosen item's id, or null when it was dismissed. */
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** Photographs the page as it is now and keeps it under this workspace, replacing what that workspace held. Asked
   * for as the person leaves a workspace, while the page still shows it. */
  capturePreview(workspaceId: string): Promise<void>;
  /** The last photograph taken of this workspace, as a data url, or nothing when none was taken. */
  workspacePreview(workspaceId: string): Promise<string | undefined>;
  /** Whether a terminal holds focus, so the chords the shell's menu would zoom the window on stand aside for it. */
  setTerminalFocus(focused: boolean): void;
  /** A chord the shell stood aside from, for the page's keybindings to answer; returns the unsubscribe. */
  onShellChord(handler: (chord: ShellChord) => void): () => void;
  /** The theme the page draws, so the window's frame, glass and traffic-light bar follow it. */
  setTheme(theme: ThemePreference): void;
  /** A build waits on the person: the shell shows a system notification while its window has no focus, and nothing
   * while it has, since the page already says it. The page decides nothing about focus; the shell owns that. */
  needsYou(need: InitNeedsYou): void;
  /** A click on that notification, after the shell has raised its window: the page opens the build screen. Returns
   * the unsubscribe. */
  onNeedsYouOpen(handler: () => void): () => void;
  /** The device token the shell holds for the host that served this page, when the window is on a host somewhere
   * else; nothing on the app's own host, whose page carries its own token. The token never rides in the page. */
  hostToken(): Promise<string | undefined>;
  /** The saved hosts and which one the window is on. */
  hosts(): Promise<HostsView>;
  /** Puts the window on a saved host, or on the app's own computer for null. */
  switchHost(alias: string | null): Promise<HostOutcome>;
  /** Downloads this release's bundle for this computer from the repo's release and keeps it only where its sha256
   * matches the one GitHub publishes. The version is all the page hands over; the shell builds every URL itself. */
  getBundle(ask: { version: string }): Promise<BundleOutcome>;
  /** Opens the bundle the last getBundle kept and quits the app, so the new one is never swapped in under a
   * running host. */
  quitAndOpen(): Promise<BundleOutcome>;
}

// --- golden image (manifest, interactive builder, build stages) ---------------

export const MachineKind = z.enum(["sandbox", "desktop"]);
export type MachineKind = z.infer<typeof MachineKind>;

export const GoldenLogin = z.object({ name: z.string(), state: LoginState });
export type GoldenLogin = z.infer<typeof GoldenLogin>;
/** A tool the builder's import did not put on the image: set aside at plan or install time, or failed to install,
 * with the reason it gave. Forks of the version are missing it. `id` is the recipe row's, the key the machine's own
 * record of what did not install is kept by. */
export const GoldenMissingTool = z.object({ id: z.string(), name: z.string(), outcome: z.enum(["skipped", "failed"]), note: z.string() });
export type GoldenMissingTool = z.infer<typeof GoldenMissingTool>;
/** A path the pack left off the image, by the recipe row it belongs to and why: a hook whose script is not a plain
 * file under home. Forks of the version run without it. */
export const GoldenLeftBehind = z.object({ id: z.string(), path: z.string(), note: z.string() });
export type GoldenLeftBehind = z.infer<typeof GoldenLeftBehind>;
/** One base tool's command with the version read on the builder after the base stage. */
export const GoldenBaseTool = z.object({ name: z.string(), version: z.string() });
export type GoldenBaseTool = z.infer<typeof GoldenBaseTool>;
/** A row an update took out of the recipe. An update never takes anything off the image: the bytes stay where the
 * version before it put them and the row is recorded here, so the lineage says what a fork still carries but the
 * recipe no longer asks for. A row ticked again later leaves this list at the version that re-installs it. */
export const GoldenRetired = z.object({ id: z.string(), name: z.string() });
export type GoldenRetired = z.infer<typeof GoldenRetired>;

/** One file the recipe wrote into the image's home: where it sits under the guest home and the sha256 of the bytes
 * the builder had when the version sealed. The upgrade reads it to tell a file a fork never touched, whose new copy
 * comes with the new image, from one the fork changed, which travels. */
export const RecipeOwnedFile = z.object({
  path: z.string(),
  sha256: z.string(),
  /** The recipe marks this row volatile: a tool rewrites it as it runs, or the machine renders it. Its bytes differ
   * on any fork that has run anything, so an upgrade carries the fork's copy and never names it as a person's edit. */
  volatile: z.boolean().optional(),
});
export type RecipeOwnedFile = z.infer<typeof RecipeOwnedFile>;

/** One sealed image. `kind` is the machine kind the snapshot was taken from and
 * therefore restores as; entries sealed before kind was recorded were all
 * sandboxes, so readers treat a missing kind as sandbox. */
export const GoldenVersion = z.object({
  version: z.number(),
  snapshotId: z.string(),
  /** The durable template the seal, or wsp doctor after it, promoted the snapshot to; forks boot from it. Absent on
   * a backend without templates and on versions sealed before templates were recorded, whose forks boot from the
   * snapshot, which the provider may lose. */
  templateId: z.string().optional(),
  baseTemplate: z.string(),
  kind: MachineKind.optional(),
  setupSha: z.string(),
  createdAt: z.string(),
  smoke: z.object({ cmd: z.string(), exitCode: z.number() }),
  /** What the provider built the builder at; forks of this version inherit it unless told otherwise. */
  size: WorkspaceSize.optional(),
  /** The browser shim was on the machine when it was sealed, so its forks can be told BROWSER; versions sealed before it existed have no flag and get none. */
  browserShim: z.boolean().optional(),
  /** The sign-ins the builder was asked for and how each ended, so the app can say what a fork carries. */
  logins: z.array(GoldenLogin).optional(),
  /** Every tool the import skipped or failed to install, by name with the cause and reason, so a workspace can say why
   * one is missing; absent when every tool installed or the version was sealed before this was recorded. */
  missingTools: z.array(GoldenMissingTool).optional(),
  /** Commands the carried rc files call that the image does not have, each defined as a silent no-op in the file's
   * guard block so the shell comes up quiet; absent when every call has a command behind it. */
  silenced: z.array(z.string()).optional(),
  /** What the login shell printed to stderr when the builder started it interactively after the files landed, first
   * line and line count; absent when it started quiet or no shell row was ticked. */
  shellNoise: z.string().optional(),
  /** What the pack left off the image and why, by row and path; absent when everything ticked travelled or the version
   * was sealed before this was recorded. */
  leftBehind: z.array(GoldenLeftBehind).optional(),
  /** The snapshot the builder that sealed this version descends from: an update's head. Absent on a version built
   * from a fresh machine, and on versions sealed before this was recorded. */
  parentSnapshotId: z.string().optional(),
  /** Every base tool's command with the version read after the base stage on the builder this version descends from.
   * Absent on a version sealed before the base tools existed; its forks never ran them, so an update is refused. */
  base: z.array(GoldenBaseTool).optional(),
  /** Every row on this version's image that its recipe no longer asks for, carried from the version before it.
   * Absent when the recipe asks for everything the image carries. */
  retired: z.array(GoldenRetired).optional(),
  /** Every file this version's recipe wrote into the guest home, hashed on the builder at seal. Absent on a version
   * sealed before the manifest existed and on one built from no recipe; a fork of such a version upgrades under the
   * old rule, its whole home landing over the new image. */
  owned: z.array(RecipeOwnedFile).optional(),
  /** The builder's disk in use when the snapshot was taken, bytes; absent on versions sealed before it was recorded. */
  usedBytes: z.number().int().nonnegative().optional(),
  /** The image record's hash this copy of the version was built at; absent on a version sealed before records
   * existed, which no record matches. A manifest is one place's copies, so this is the copy's hash. */
  imageHash: z.string().length(64).optional(),
});
export type GoldenVersion = z.infer<typeof GoldenVersion>;

export const GoldenManifest = z.object({ head: z.number(), versions: z.array(GoldenVersion) });
export type GoldenManifest = z.infer<typeof GoldenManifest>;

/** The sealed version a manifest's head names, or nothing: a manifest without one has no golden to serve or fork. */
export function goldenHead(manifest: GoldenManifest | undefined): GoldenVersion | undefined {
  return manifest?.versions.find(v => v.version === manifest.head);
}

/** What a fork of a version boots from and the lineage's word for it: the durable template once one is recorded,
 * the snapshot until then. The one rule for every road that creates from a version and every row that says whether
 * the version survives the provider losing its snapshot store; a durable version gets no word, since a word every
 * row wears says nothing. */
export function goldenImage(v: Pick<GoldenVersion, "snapshotId" | "templateId">): { spec: { template: string } | { fromSnapshot: string }; marks: readonly "volatile"[] } {
  return v.templateId !== undefined ? { spec: { template: v.templateId }, marks: [] } : { spec: { fromSnapshot: v.snapshotId }, marks: ["volatile"] };
}

/** What a build recorded a row installed: the version, read back off the builder once the row ran (a release's tag,
 * a package's version), and the archive's sha256 where the road hashed one. `latest` marks a row whose road installs
 * the current version wherever it runs, so the version is what that seal got and not what a copy is fixed to. The
 * one shape for the recipe row that carries it, the collector's row, the catalog road that installs at it, the tick
 * the seal writes and the record's pins. */
export const ToolPin = z.object({ tag: z.string().min(1), sha256: z.string().min(1).optional(), latest: z.literal(true).optional() });
export type ToolPin = z.infer<typeof ToolPin>;

/** What a golden is built from, as its builder records it: every ticked row
 * with its login answer, tool pin and install road, and every planned path
 * with a digest of the bytes that travel. Two recipes with equal digests build
 * the same golden; the hash a builder carries is this object's, so a later run
 * can say what changed instead of only that something did. */
export const RecipeDigest = z.object({
  ticks: z.array(
    z.object({
      id: z.string(),
      choice: LoginChoice.optional(),
      /** The version the row installs: the laptop's, or the one its road reads for it (a tap formula's release tag). */
      version: z.string().optional(),
      /** A tools row's install road by name, and the sha256 of the lines that road runs before any recorded pin: a
       * road that installs differently under the same id is a changed row. */
      road: z.string().optional(),
      installer: z.string().optional(),
      /** The version the row installed, as the build that ran it read back and stamped here; a copy planned from
       * the record installs at it. It never enters the recipe hash: the recipe that asked is the same recipe. */
      pin: ToolPin.optional(),
    }),
  ),
  /** The computer's login shell by name, when a shell row is ticked: it decides which shell the machine logs into. */
  login: z.string().optional(),
  /** A volatile entry (its tool rewrites it, or it is a Keychain value the machine gets rendered) is recorded but never hashed. */
  files: z.array(z.object({ id: z.string(), path: z.string(), dest: z.string(), digest: z.string(), volatile: z.boolean().optional() })),
});
export type RecipeDigest = z.infer<typeof RecipeDigest>;

/** Where a recipe row's tick comes from: the project the recipe was written for names it in its own manifests (with
 * the line saying which file said so), the entry is on this computer (what was found: its config paths and whether
 * its command is on PATH), the agents' session histories on this computer used it (in how many sessions, how many
 * calls), or nothing local says anything and the catalog's own evidence decides. */
export const RecipeSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), why: z.string().min(1) }),
  z.object({ kind: z.literal("installed"), paths: z.array(z.string()), bin: z.boolean() }),
  z.object({ kind: z.literal("used"), sessions: z.number().int().nonnegative(), calls: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("popular"), sessions: z.number().int().nonnegative(), images: z.number().int().nonnegative() }),
]);
export type RecipeSource = z.infer<typeof RecipeSource>;

/** One catalog entry in a recipe: ticked or not, why, its size on the machine when the catalog measured one, and
 * the sign-in answer the person or the agent that wrote the recipe gave; absent, the wizard's default stands. A tools
 * row this computer has that the catalog does not carry (a formula, a manager's global) is a row too, under the
 * collector's own id (`tools/<manager>/<package>`), so the file and the screens tick it like any other. */
export const RecipeRow = z.object({
  /** The catalog id, or the collector's row id for a tools row outside the catalog. */
  id: z.string().min(1),
  kind: z.enum(["agent", "tool"]),
  on: z.boolean(),
  source: RecipeSource,
  size: z.number().int().nonnegative().optional(),
  signIn: LoginChoice.optional(),
  /** What the last seal installed for this row, written after the build for `wsp recipe` to show; the next seal
   * reads its own and writes it over. A copy installs by the record's pins, never by these. */
  pin: ToolPin.optional(),
});
export type RecipeRow = z.infer<typeof RecipeRow>;

/** What one agent's session history on this computer gave: read with these counts, empty, there but unreadable, or
 * no reader for its format yet. Names and counts only; nothing a session held travels. */
export const RecipeHistory = z.object({
  agent: z.string().min(1),
  state: z.enum(["read", "empty", "unreadable", "no-reader"]),
  sessions: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export type RecipeHistory = z.infer<typeof RecipeHistory>;

/** Which rule decided every tick in a recipe: what the person's agents used on this computer, what is installed on
 * it, or the catalog's own default. `wsp recipe --tick` names one; a recipe written without one (the wizard's
 * screens) carries none and its rows say for themselves where each tick came from. */
export const RecipeTick = z.enum(["used", "installed", "default"]);
export type RecipeTick = z.infer<typeof RecipeTick>;
/** The words `--tick` takes, in the order the help lists them. */
export const RECIPE_TICKS: readonly RecipeTick[] = RecipeTick.options;

/** A tool the recipe carries that the catalog does not, because an agent added it for the person's own projects:
 * the lines that install it, run as given on the builder after every catalog road, and one command that exits 0
 * once it is there. Nothing here is ever offered a sign-in: the install is the whole row. */
export const RecipeCustomRow = z.object({
  kind: z.literal("custom"),
  id: z.string().min(1),
  name: z.string().min(1),
  install: z.array(z.string().min(1)).min(1),
  check: z.string().min(1),
  /** The package manager the lines call, when the row came off a scan of one: the build brings that manager onto
   * the machine before the row runs. A row nobody named a manager for runs on what the base and the ticks left. */
  manager: z.string().min(1).optional(),
  /** Bytes on the machine, when whoever added the row measured one. */
  size: z.number().int().nonnegative().optional(),
  why: z.string().min(1),
});
export type RecipeCustomRow = z.infer<typeof RecipeCustomRow>;

/** The small recipe: catalog ids with a tick each and the source of that tick, written by wsp recipe from this
 * computer (or by hand, or by a local agent), read by wsp init --recipe, the app's pick screen and the import
 * of a project. Among them this computer's own tools rows the catalog does not carry, under the collector's ids, and
 * beside them the rows an agent added for tools the catalog has none for. Names, ticks and install lines only: never
 * a path's content, never a key. */
export const Recipe = z.object({
  version: z.literal(1),
  /** When it was written, ISO 8601. */
  at: z.string().min(1),
  /** The rule that decided the ticks, when one was named; a later --set keeps it, so the table reads the same. */
  tick: RecipeTick.optional(),
  histories: z.array(RecipeHistory),
  rows: z.array(RecipeRow),
  /** Rows outside the catalog, added on purpose; a recipe written before they existed carries none. */
  custom: z.array(RecipeCustomRow).optional(),
  /** Every workspace from this image gets the place's container engine through the fenced socket, as `wsp new
   * --engine` gives one; absent is none unless the create asks. */
  engine: z.boolean().optional(),
});
export type Recipe = z.infer<typeof Recipe>;

/** The custom rows a recipe carries: the one reading of a recipe that has none. */
export function customRows(recipe: Pick<Recipe, "custom">): readonly RecipeCustomRow[] {
  return recipe.custom ?? [];
}

/** What a row added without a check of its own is checked with: its command on PATH. */
export function commandCheck(bin: string): string {
  return `command -v ${shellQuote(bin)}`;
}

/** The why on a row an agent added without saying more. */
export const ADDED_BY_AGENT = "added by the agent";

/** The live machine a person sets up before sealing it as a golden. It is not
 * a workspace and never appears in the rail; `screen` is present when the
 * machine streams a display (desktop kind). */
export const GoldenBuilderView = z.object({
  id: z.string(),
  name: z.string(),
  kind: MachineKind,
  createdAt: z.string(),
  /** What the provider built, so a builder left running can be priced. */
  size: z.object({ cpu: z.number(), memMb: z.number() }),
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** True while a seal can still be taken from this builder: the machine has never been paused, resumed or
   * restored, or the place it stands on copies a disk from any life of a machine. */
  sealable: z.boolean().optional(),
  /** The recipe this builder carries; a prepare with the same hash attaches to it instead of booting. */
  recipeHash: z.string().optional(),
  /** The parts behind recipeHash; absent on a builder recorded without them. */
  recipe: RecipeDigest.optional(),
  /** The owner label on the machine when it names another state file; absent when it is this one's or the provider reports none. */
  foreignOwner: z.string().optional(),
  /** The other live wsp process using this builder, when there is one; such a builder is listed and left alone. */
  heldBy: z.object({ host: z.string(), pid: z.number(), heartbeat: z.string() }).optional(),
  /** True while its stages still run in the process that holds it; left this way by a dead process, it can never seal. */
  building: z.boolean().optional(),
  /** Set once the builder was saved as this golden version and kept running for a short window, so one more
   * change re-snapshots it instead of forking; the sweep stops it when the window ends. */
  sealed: z.object({ at: z.string(), version: z.number() }).optional(),
});
export type GoldenBuilderView = z.infer<typeof GoldenBuilderView>;

export const GoldenStage = z.enum([
  "creating",
  "deploying-daemon",
  "applying-setup",
  "uploading-files",
  "installing-harness",
  "installing-tools",
  "installing-mcp",
  "ready",
  "snapshotting",
  "promoting",
  "smoke-forking",
  "sealed",
  "failed",
]);
export type GoldenStage = z.infer<typeof GoldenStage>;

/** The install step a frame belongs to, within its stage: what the step is called and the one line a person reads
 * for what it runs. A reader's clock for the step starts at the first frame naming it and stops at the first without. */
export const GoldenStep = z.object({ label: z.string(), command: z.string() });
export type GoldenStep = z.infer<typeof GoldenStep>;

/** Progress of a golden prepare or seal, keyed by golden name; `detail` is
 * free text for a progress line (the failure message on `failed`). */
export const GoldenStageEvent = z.object({
  type: z.literal("golden.stage"),
  name: z.string(),
  stage: GoldenStage,
  detail: z.string().optional(),
  step: GoldenStep.optional(),
  /** The machines this stage made and could not remove, because the provider could not be reached: they bill until
   * something takes them, so a client that can retry the kill retries it rather than reading the stage as over. */
  left: z.array(z.string()).optional(),
  /** The place a copy is being built at, when the stage is a copy's and not the wired provider's. */
  place: z.string().optional(),
});
export type GoldenStageEvent = z.infer<typeof GoldenStageEvent>;
// --- the image: the record the host owns, its vault and the copies built from it ---

/** What the sign-in stages left on the builder, archived at the seal: never the bytes on the wire, only their hash
 * and size. */
export const SealedVault = z.object({
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  /** How many guest paths the archive names; zero means the seal had nothing to hold and the copy will ask for sign-ins again. */
  paths: z.number().int().nonnegative(),
  /** The guest paths the seal archived, absolute, which every member of the archive is judged against before a copy
   * imports it. Absent on a record sealed before the list was kept, and such a record builds no copy. */
  held: z.array(z.string()).optional(),
  takenAt: z.string(),
});
export type SealedVault = z.infer<typeof SealedVault>;

/** One row's pin as the record keeps it: the row by the id that names its tool on every computer (the catalog id
 * where the catalog carries the tool, else the row's own id, which is the same on the computer that has it), what
 * it installed, and the road it took, so a reader can say in the road's words why a latest row is one. */
export const SealedPin = ToolPin.extend({ id: z.string().min(1), road: z.string().optional() });
export type SealedPin = z.infer<typeof SealedPin>;

/** The pins a sealed digest carries, one per tick that recorded one, in id order: what the record keeps beside the
 * recipe and what its hash covers. `key` is the id a row is known by across computers, the caller's catalog rule;
 * without one a tick keeps its own id. */
export function recipePins(digest: Pick<RecipeDigest, "ticks">, key: (id: string) => string = id => id): SealedPin[] {
  return digest.ticks
    .flatMap((t): SealedPin[] => (t.pin === undefined ? [] : [{ id: key(t.id), ...t.pin, ...(t.road !== undefined ? { road: t.road } : {}) }]))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The image the host owns: what every copy is built from. One per golden name. */
export const SealedImage = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  /** sha256 over the recipe hash, the vault's sha256 and the pins; two copies with this hash were built from the same thing. */
  hash: z.string().length(64),
  recipeHash: z.string(),
  /** The small recipe as it stood at the seal, so a later edit of recipe.json changes no copy until the next
   * version. Absent on a record backfilled from a golden sealed before records existed, and on one sealed by a
   * road that carried no small recipe: a copy of such a record is refused, since there is nothing to build from. */
  recipe: Recipe.optional(),
  /** What each row installed at the seal, read back off the builder: a copy installs these versions, and a row
   * marked latest installs the current one and is named as such. Absent on a record sealed before pins were read. */
  pins: z.array(SealedPin).optional(),
  logins: z.array(GoldenLogin),
  sealedAt: z.string(),
  /** This computer's name at the seal, for the screen's "sealed from". */
  sealedFrom: z.string(),
  /** Absent on a record backfilled from a golden sealed before vaults existed: its copies ask for sign-ins again. */
  vault: SealedVault.optional(),
  /** The builder's disk in use at the snapshot, in bytes; absent on a version sealed before it was read. */
  usedBytes: z.number().int().nonnegative().optional(),
  /** The place the image's own seal stands at, by the id its copies are filed under: a joined computer's id or a
   * provider's. Absent on a record sealed before places, which stands at the provider the host forks on. */
  place: z.string().optional(),
});
export type SealedImage = z.infer<typeof SealedImage>;

/** One place's built copy of one version: the provider's artifact and when it was made. */
export const SealedImageCopy = z.object({
  place: z.string(),
  /** The version this place's own manifest gave the copy. Each place numbers its own, so a second place's first
   * copy is its v1 whatever version of the record it was built from; the hash is what says which record that was. */
  version: z.number().int().positive(),
  /** The record's hash when this copy was built; absent on a copy sealed before hashes, which no record matches. */
  hash: z.string().length(64).optional(),
  snapshotId: z.string(),
  templateId: z.string().optional(),
  builtAt: z.string(),
  /** From the provider's snapshot listing where it has one; absent elsewhere, never guessed. */
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type SealedImageCopy = z.infer<typeof SealedImageCopy>;

/** What a build at a place came to: the copy that place holds now, and whether this call built it. A place already
 * standing on the record is answered with its copy and `built: false` rather than refused, so a fork there and a
 * person typing the line twice both get the copy they asked for. */
export const SealedImageBuilt = z.object({ copy: SealedImageCopy, built: z.boolean() });
export type SealedImageBuilt = z.infer<typeof SealedImageBuilt>;

/** What an export wrote on this computer. */
export const SealedImageExport = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), hash: z.string().length(64) });
export type SealedImageExport = z.infer<typeof SealedImageExport>;

/** The shortest passphrase an export is sealed to; a shorter one is refused before anything is read. */
export const IMAGE_PASSPHRASE_MIN = 12;

/** A sealed vault's header, one line of JSON a reader parses before anything else: it says how the bytes behind it
 * are keyed and carries the record in the plain, so an import can show what a file holds before asking for the
 * passphrase. The header's own bytes are the cipher's additional data, so an edited header fails to open. */
export const SealedVaultHeader = z.object({
  format: z.literal("wsp-vault-1"),
  cipher: z.literal("aes-256-gcm"),
  to: z.enum(["passphrase", "key"]),
  /** scrypt salt (passphrase) or HKDF salt (key), base64. */
  salt: z.string(),
  nonce: z.string(),
  /** The sender's ephemeral X25519 public key, base64, on `to: "key"` only. */
  ephemeral: z.string().optional(),
  image: SealedImage,
});
export type SealedVaultHeader = z.infer<typeof SealedVaultHeader>;

/** The detail a golden.stage frame carries for a step the builder already holds; a reader closes the step at once and charges it no time. */
export const ALREADY_APPLIED = "already applied";
/** Recipe rows under the agents rung that are MCP servers, not agents: `agents/mcp/<agent>/<name>`. The collector writes them, the engine's import reads them. */
export const MCP_ID_PREFIX = "agents/mcp/";
/** Recipe rows under the agents rung: `agents/<agent>`, the MCP servers' rows among them. */
const AGENTS_PREFIX = "agents/";
/** The agent an agents-rung row names, or nothing for an MCP server's row and for every other rung: the one rule
 * for that rung, beside packageOf for the tools rung. */
export const agentOfRow = (e: { id: string }): string | undefined => (e.id.startsWith(AGENTS_PREFIX) && !e.id.startsWith(MCP_ID_PREFIX) ? e.id.slice(AGENTS_PREFIX.length) : undefined);
/** Where a manager's rows sit under the tools rung: what every id of its packages starts with. It lives here, not
 * beside the engine's other row prefixes, because the collector writes these ids and cannot import the engine. */
export const toolRowPrefix = (manager: string): string => `tools/${manager}/`;
/** The id of a tools row a manager lists, the one spelling of it: what the collector writes for one, and what a scan
 * row of the same manager and package stands for. */
export const toolRowId = (manager: string, pkg: string): string => `${toolRowPrefix(manager)}${pkg}`;
/** Recipe rows under the tools rung that name a Homebrew formula. */
export const BREW_ID_PREFIX = toolRowPrefix("brew");
/** The package a tools row names: what follows its manager in the id (a tap formula keeps its slashes). Beside the
 * prefix above for the same reason: the collector writes these ids and cannot import the engine. */
export const packageOf = (e: { id: string }): string => e.id.split("/").slice(2).join("/");

/** Where the event sits in its runtime's stream: one counter per runtime process, monotonic from 1, so a client that
 * lost its socket can ask events.subscribe for everything after the last one it saw. Absent on events from an older
 * runtime and on sessions.history replies, which a client reads whole. */
const sequenced = { seq: z.number().int().positive().optional() };

/** The host opened or closed a forward; the runtime relays these to the app's socket and emits none itself. */
export const ForwardOpenEvent = z.object({ type: z.literal("forward.open"), forward: PortForward });
export const ForwardCloseEvent = z.object({ type: z.literal("forward.close"), workspaceId: z.string(), port: RelayPort });
export type ForwardEvent = z.infer<typeof ForwardOpenEvent> | z.infer<typeof ForwardCloseEvent>;

/** What a computer joining this host passes through when the host installs the agent on it over ssh, in order.
 * One list for the line a terminal prints and the rows the app draws, so neither invents a step the other has not
 * got. */
export const PlaceAddStep = z.enum(["connect", "host-key", "reach", "wsp", "service", "join", "provision"]);
export type PlaceAddStep = z.infer<typeof PlaceAddStep>;

/** What each step reads as while it runs. The note beside it carries what the computer answered (its system, the
 * node it got), which is the step's own to say and never a second sentence about it. */
export const PLACE_ADD_WORDS: Record<PlaceAddStep, string> = {
  connect: "connecting over ssh",
  "host-key": `remembering the box's host key in ${KNOWN_HOSTS}`,
  reach: "checking it can reach this computer",
  wsp: "installing wsp",
  service: "starting the agent",
  join: "waiting for it to connect to this computer",
  provision: "installing agents, tools, skills and servers",
};

/** Where the app's sheet says a step differently from the line a terminal prints. The host the app runs on need not
 * be a Mac, so the computer it runs on is this computer in both. `done` is read once a step is finished, where a
 * line under a check would otherwise say the wait it was in rather than the state it reached. */
export const PLACE_ADD_SHEET_WORDS: Partial<Record<PlaceAddStep, { word?: string; done?: string }>> = {
  "host-key": { word: `keeps the box's host key in ${KNOWN_HOSTS} here` },
  reach: { done: "reaches this computer" },
  wsp: { word: `installing wsp under ${PLACE_INSTALL.folder}` },
  service: { word: `starting the agent as ${PLACE_INSTALL.service}` },
  join: { done: "connected to this computer" },
};

/** The word the app's sheet draws for a step in the state it is in. */
export function placeAddSheetWord(step: PlaceAddStep, state: "running" | "done"): string {
  const said = PLACE_ADD_SHEET_WORDS[step];
  return (state === "done" ? said?.done : undefined) ?? said?.word ?? PLACE_ADD_WORDS[step];
}

/** The kind a places.add refusal carries when the ssh login itself did not stand or the word typed names no login:
 * the one case where checking the user, the address or the key is the fix. */
export const PLACE_LOGIN_REFUSED_KIND = "login";

/** How far the install on one computer has got, keyed by the id the request was answered with, so two installs at
 * once are two lists. A step that is running is the one with a spinner; one that is done carries its note. */
export const PlaceStageEvent = z.object({
  type: z.literal("place.stage"),
  addId: z.string(),
  step: PlaceAddStep,
  state: z.enum(["running", "done", "failed"]),
  note: z.string().optional(),
  /** The computer the step ran on, carried by the steps of a job on a computer this host already holds: a reader
   * that acts on a step rather than printing it needs the row and not the stream it rode. */
  placeId: z.string().optional(),
  /** On a recipe job's done step, how many of its rows failed: the job is done once every row has an outcome. */
  failed: z.number().int().nonnegative().optional(),
});
export type PlaceStageEvent = z.infer<typeof PlaceStageEvent>;

/** One install over ssh as the host keeps it while it runs and for a while after, so a window opened later, or the
 * same one after a reload, reads the steps and the refusal the window that asked read. `said` and `fix` are the
 * refusal's two halves; `kind` is the one it was stamped with. */
export const PlaceAddJob = z.object({
  addId: z.string(),
  address: z.string(),
  sshPort: z.number().int().optional(),
  startedAt: z.string(),
  state: z.enum(["running", "done", "failed"]),
  steps: z.array(z.object({ step: PlaceAddStep, state: z.enum(["running", "done", "failed"]), note: z.string().optional() })),
  said: z.string().optional(),
  fix: z.string().optional(),
  kind: z.string().optional(),
  /** The computer the add made, once it joined. */
  placeId: z.string().optional(),
});
export type PlaceAddJob = z.infer<typeof PlaceAddJob>;

/** The job with one more step said, the one rule the host and the app both keep it by: the step's line replaced
 * where it stands, the job done once the computer joined, failed once a step failed. The recipe that runs on
 * behind a join rides the same stream and is the computer's row's to say, not the add's. */
export function withPlaceStage(job: PlaceAddJob, e: Pick<PlaceStageEvent, "step" | "state" | "note" | "placeId">): PlaceAddJob {
  if (e.step === "provision") return job;
  const line = { step: e.step, state: e.state, ...(e.note !== undefined ? { note: e.note } : {}) };
  const at = job.steps.findIndex(s => s.step === e.step);
  const steps = at === -1 ? [...job.steps, line] : job.steps.map((s, i) => (i === at ? line : s));
  if (e.step === "join" && e.state === "done") return { ...job, steps, state: "done", ...(e.placeId !== undefined ? { placeId: e.placeId } : {}) };
  if (e.state === "failed") return { ...job, steps, state: "failed", ...(job.said === undefined && e.note !== undefined ? { said: e.note } : {}) };
  return { ...job, steps };
}

/** One line of the doctor's computer road as the host that holds that computer's link says it, keyed by the id the
 * terminal minted for its own run: a road's lines ride the events channel to whoever asked for them, under the
 * stream they were said on. A host source's event and no member of the runtime's own union: it carries no sequence,
 * nothing retains it, and a socket that comes back later is not replayed it. */
export const DoctorLineEvent = z.object({
  type: z.literal("doctor.line"),
  doctorId: z.string(),
  line: z.string(),
  stream: z.enum(["out", "err"]),
});
export type DoctorLineEvent = z.infer<typeof DoctorLineEvent>;

export const PlaceKind = z.enum(["computer", "provider"]);
export type PlaceKind = z.infer<typeof PlaceKind>;

/** What the computers table calls one row's kind, which is finer than PlaceKind by one: the computer the host runs
 * on is named as its owner names it, a computer somebody joined is a box, and a provider account is a cloud. The
 * one table, so the command line's KIND column and the app read one word per row. */
export function computerKindWord(place: Pick<PlaceView, "id" | "kind">, platform: "darwin" | "linux"): string {
  if (place.id === HERE_PLACE_ID) return thisComputer(platform);
  return place.kind === "provider" ? "cloud" : "box";
}

/** A forward over the ssh login from a port on that computer's own loopback to this host's door, held by this host
 * for a computer that cannot reach it any other way: its link dials `http://127.0.0.1:<boxPort>`. The door's end is
 * read off the running host at each standing, never saved: a restarted host's door can sit on another port. */
export const PlaceBack = z.object({
  boxPort: z.number().int().min(1).max(65535),
});
export type PlaceBack = z.infer<typeof PlaceBack>;

/** How a computer this host holds is reached, off the road it was added on. `ssh` is the login the host logs in
 * as, which is also what a person types in their own terminal; `from` is where its last link dialled in from; `back`
 * is the forward it dials back through where it reaches this host no other way. A row with neither `ssh` nor `from`
 * is a computer that joined with a code and has never linked. */
export const PlaceRoad = z.object({
  ssh: z.string().max(300).optional(),
  from: z.string().max(300).optional(),
  back: PlaceBack.optional(),
});
export type PlaceRoad = z.infer<typeof PlaceRoad>;

/** What one dial of a computer came to: when it was dialled, whether anything answered, how long the frame that
 * answered took, and what the road said when nothing did (ssh's own line on the ssh road). The one shape the
 * answer is written in, so the button that asks and the row that keeps it read one thing. */
export const PlaceDialled = z.object({
  at: z.string(),
  answered: z.boolean(),
  roundTripMs: z.number().int().nonnegative().optional(),
  said: z.string().max(2000).optional(),
});
export type PlaceDialled = z.infer<typeof PlaceDialled>;

/** The project a workspace on a computer you own is made with: a checkout on that computer, copied once for this
 * workspace and mounted read-write at `at` inside, the project's real path. The copy is the workspace's own from
 * the moment it is made: the checkout can be fetched, switched or built in and no workspace already made from it
 * sees any of it. Absent is a workspace of the computer with no project in it. */
export const WorkspaceCopy = z.object({
  from: z.string().min(1).refine(isPlainPath, "an absolute path on the computer"),
  at: z.string().min(1).refine(isPlainPath, "an absolute path inside the workspace"),
});
export type WorkspaceCopy = z.infer<typeof WorkspaceCopy>;

/** How a computer makes a workspace's copy of a checkout: reflink shares blocks with it, snapshot is a btrfs
 * subvolume snapshot of it, plain writes every byte and takes the time that takes. */
export const CopyWord = z.enum(["reflink", "snapshot", "plain"]);
export type CopyWord = z.infer<typeof CopyWord>;


/** One login the computer running a workspace keeps outside every one of them and mounts into this one at
 * `target`, read-write: signed in once on that computer, so a refresh inside any workspace there is the
 * computer's own refresh rather than a copy going stale. `source` is a file under that computer's own logins
 * directory, which its daemon says where it is and refuses a create that names anything else. */
export const MachineShare = z.object({
  source: z.string().min(1).refine(isPlainPath, "an absolute path on the computer"),
  target: z.string().min(1).refine(isPlainPath, "an absolute path inside the workspace"),
});
export type MachineShare = z.infer<typeof MachineShare>;

/** One folder the computer running a workspace mounts into it: the source on the computer, the path it lands at
 * inside, and whether the workspace may write through it. Unlike a share, which is one file of a login, this is a
 * folder both sides keep working in, which is what makes one project's memory the same memory in every workspace
 * of it on that computer. */
export const MachineBind = z.object({
  source: z.string().min(1).refine(isPlainPath, "an absolute path on the computer"),
  target: z.string().min(1).refine(isPlainPath, "an absolute path inside the workspace"),
  readOnly: z.boolean().optional(),
});
export type MachineBind = z.infer<typeof MachineBind>;

/** What a row of the recipe job puts on a computer you own: a tool or agent installed, a file of the person's own
 * landed in an agent's home there, or an MCP server written into an agent's config. */
export const PlaceProvisionKind = z.enum(["tool", "file", "server"]);
export type PlaceProvisionKind = z.infer<typeof PlaceProvisionKind>;

/** What each kind of row is called where a count of them is read. One table, so the row's word, the line a job
 * opens with and the log on that computer cannot name the same rows three ways. */
export const PROVISION_KIND_WORDS: Record<PlaceProvisionKind, string> = { tool: "tool", file: "file", server: "MCP server" };

/** A count of rows by kind as a person reads it, the kinds with none left out: `9 tools, 3 files, 5 MCP servers`.
 * Nothing but tools reads as it did before there was anything else. */
export function provisionCountWord(counts: Partial<Record<PlaceProvisionKind, number>>): string {
  const said = PlaceProvisionKind.options.flatMap(kind => ((counts[kind] ?? 0) > 0 ? [plural(counts[kind]!, PROVISION_KIND_WORDS[kind])] : []));
  return said.length === 0 ? plural(0, PROVISION_KIND_WORDS.tool) : said.join(", ");
}

/** What one row of the recipe came to on a computer you own. `present` is a row the computer already had at the
 * version asked, so nothing ran for it; `skipped` waited on a row that did not land, or was set aside by the plan. */
export const PlaceProvisionRow = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  outcome: z.enum(["installed", "present", "failed", "skipped"]),
  /** What this row puts there; absent reads as a tool, which is what every row was before files and servers had rows. */
  kind: PlaceProvisionKind.optional(),
  note: z.string().optional(),
  ms: z.number().int().nonnegative().optional(),
});
export type PlaceProvisionRow = z.infer<typeof PlaceProvisionRow>;

/** The rows of a job counted by kind, for the word above. */
export function provisionCounts(rows: readonly PlaceProvisionRow[]): Partial<Record<PlaceProvisionKind, number>> {
  const counts: Partial<Record<PlaceProvisionKind, number>> = {};
  for (const r of rows) {
    const kind = r.kind ?? "tool";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** The recipe on a computer you own, as the job that puts its rows there stands: `running` while rows are going on,
 * `done` once every row has an outcome (failed rows included), `stopped` when the job itself ended before its rows
 * did, with why in `said`. */
export const PlaceProvision = z.object({
  state: z.enum(["running", "done", "stopped"]),
  /** The stream its steps ride as place.stage events: the add's own id at a join, a fresh one at an update. */
  addId: z.string().min(1),
  /** The recipe's own `at` stamp, so the row can say which recipe it was made from. */
  recipeAt: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  rows: z.array(PlaceProvisionRow),
  /** While running: the row under way and its place in the run. */
  at: z.object({ label: z.string(), index: z.number().int().positive(), of: z.number().int().positive() }).optional(),
  said: z.string().optional(),
});
export type PlaceProvision = z.infer<typeof PlaceProvision>;

/** One row of wsp places: a computer of the person's own, this computer itself, or the provider this host forks on. */
export const PlaceView = z.object({
  id: z.string(),
  kind: PlaceKind,
  name: z.string(),
  /** The name the person gave this computer, a Mac's own "zingzy's MacBook Pro", drawn where the machine name is
   * not; absent where the computer keeps none. */
  label: z.string().optional(),
  default: z.boolean(),
  /** A computer: what it reported last. */
  os: z.string().optional(),
  shape: WorkspaceSize.optional(),
  diskFreeBytes: z.number().int().optional(),
  /** The engine a project's own containers run on there. Absent on a place that has never said what it is. */
  engine: z.enum(["none", "docker", "podman"]).optional(),
  /** How a workspace's copy of a project is made there, as that computer last reported it. Absent on a place
   * that runs no workspaces and on one that has never said. */
  copies: CopyWord.optional(),
  present: z.boolean().optional(),
  joinedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  daemonVersion: z.number().int().optional(),
  /** The catalog ids of the agents that computer found on itself, as it last reported them. */
  agents: z.array(z.string()).optional(),
  /** What each of those agents answered its own version flag with, as that computer last reported it. */
  agentVersions: z.record(z.string()).optional(),
  /** One word per reported agent for whether a turn there needs a sign-in first, off that computer's last report and
   * any sign-in this host ran there since. Absent on a computer whose daemon is older than the logins list the word
   * is read from, which is unknown rather than none. */
  signIns: z.record(AgentSignInState).optional(),
  /** Where that computer keeps the logins every workspace on it shares, off what its backend last said. What the
   * sign-in on that computer points the tool's own store at, and what a create there shares in. Absent on a
   * computer that has not said yet and on a provider, which holds no file of this person's. */
  logins: z.string().optional(),
  /** A provider: its hourly rate for the default size. */
  rateUsdPerHour: z.number().optional(),
  /** Every size a workspace here may be asked for, each with this place's own rate for it, read off the backend
   * this host holds for the row. Absent on a place that offers no pick of its own, which is every computer the
   * person owns. A picker reads the row it is under, never one provider's list against another's prices. */
  sizes: z.array(MachineSizeOffer).optional(),
  /** How many forks run there and how many more a create can take now, by forkRoom; a napping fork runs nothing and
   * takes no room, and the workspace list is where it is counted. Absent on a place that forks nowhere. */
  forks: z.object({ running: z.number().int(), room: z.number().int() }).optional(),
  /** Whether a workspace can be forked here at all: a provider, or a computer somebody joined, which boots the
   * image or it is not joined at all. False is the computer the app itself runs on, which runs threads in its own
   * local mode and is never forked into. The one fact wsp new reads to decide which road a place takes, so no
   * line outside this list switches on a place's kind. */
  takesForks: z.boolean().optional(),
  /** Where the host expects that computer: the ssh login it was installed over, and the address its last link
   * dialled in from. A computer joined by typing a code has no login here, so the address is all there is. */
  road: PlaceRoad.optional(),
  /** The folder a turn there starts in and how long that computer had been up, as it last reported them, and when
   * that report was taken. Kept on the row so a computer that stopped answering reads what it last was rather than
   * nothing at all. The stamp is the uptime's: it grows while the computer is up, so it is dated by the report it
   * was read in and not by the last frame this host saw, which can be hours later. */
  home: z.string().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  reportedAt: z.string().optional(),
  /** What the last dial of this computer got. Kept on the row, so the answer stands after the window is closed
   * and opened again rather than living only in the button that asked. */
  dialled: PlaceDialled.optional(),
  /** Why nothing runs inside a copy there, off that computer's last report: its link stays up for the acts that
   * need no copy running. Absent while it runs workspaces. */
  blocked: z.string().optional(),
  /** The copy of the image at this place while it is not standing: the stage sentence while a build runs there, the
   * reason after one stopped there. Absent once the copy stands, and on a place nothing was ever built at. */
  build: z.string().optional(),
  /** Set when `build` is the reason a build there stopped rather than the stage of one running. */
  buildStopped: z.boolean().optional(),
  /** Whether a copy of the image can stand here at all, by buildsImages over this place's own capabilities. Absent on
   * a joined computer that has not yet said what it forks with. */
  buildsImages: z.boolean().optional(),
  /** The recipe on this computer: what is being put on it, then what stands and what failed. Absent on a provider,
   * on this computer itself, and on a computer nothing has provisioned yet. */
  provision: PlaceProvision.optional(),
});
export type PlaceView = z.infer<typeof PlaceView>;

/** What one dial of a computer answers: what came back, the sentence the slot that asked says it in, and the row as
 * it now stands, since the host writes the answer on the record. The one home for the shape, so the door that
 * answers it and the client that parses it cannot spell it two ways. */
export const PlaceDial = z.object({
  dialled: PlaceDialled,
  line: z.string(),
  place: PlaceView,
});
export type PlaceDial = z.infer<typeof PlaceDial>;

/** What places.update answers: the daemon half where the computer was behind and absent where it already ran this
 * wsp's daemon; the recipe job started after it, as it stands when the reply goes out; and, where no job started,
 * why. */
export const PlaceUpdateReply = z.object({
  name: z.string().min(1),
  daemon: z
    .object({
      from: z.number().int(),
      to: z.number().int(),
      road: z.enum(["link", "ssh"]),
      at: z.string(),
      kept: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  provision: PlaceProvision.optional(),
  said: z.string().optional(),
});
export type PlaceUpdateReply = z.infer<typeof PlaceUpdateReply>;

/** The id the computer the host runs on carries in that list. It is a place like every other, and the one nothing
 * was installed on, so both sides of the wire read the same word for it. */
export const HERE_PLACE_ID = "here";

/** Which computer a workspace stands on, by place id: a workspace forked on a joined computer carries that
 * computer's id on its record. Undefined for everything on this computer or at a provider. Written once because
 * the host asks it to know whether anything can be asked of the machine, and the app asks it to know which row of
 * the places table a workspace belongs to. */
export function workspacePlace(view: Pick<WorkspaceView, "place">): string | undefined {
  return view.place;
}

/** What one row of the places list holds of the person's money: the spend it has taken since the first of the
 * month, over every workspace that stood on it in that month, deleted ones included, and what it is burning right
 * now over the ones still there. How many workspaces that is, the caller counts off its own list. */
export const PlaceSpend = z.object({ place: z.string(), monthUsd: z.number(), rateUsdPerHour: z.number() });
export type PlaceSpend = z.infer<typeof PlaceSpend>;

/** Which row of the places list a workspace stands on, by id: the computer its record names, this computer for a
 * workspace that is this computer, and for a fork the provider its record was stamped with. A fork written before
 * records carried that word stands at the first provider row, which is where a host that forks at one provider put
 * it. Nothing for a workspace whose row this list does not hold, a stamped fork included: a provider that has been
 * removed takes its money off the list with it, and standing its workspaces on whatever provider is left would put
 * one provider's spend on another's row.
 *
 * The one reading, so the settings table, the sidebar's rows and the host's own spend fold cannot disagree about
 * which row a workspace belongs to. */
export function workspacePlaceId(view: Pick<WorkspaceView, "kind" | "machineId" | "place" | "provider">, places: readonly Pick<PlaceView, "id" | "kind">[]): string | undefined {
  const named = workspacePlace(view);
  if (named !== undefined) return places.find(p => p.id === named)?.id;
  if (isLocalWorkspace(view)) return places.find(p => p.id === HERE_PLACE_ID)?.id ?? places[0]?.id;
  const providers = places.filter(p => p.kind === "provider");
  return view.provider === undefined ? providers[0]?.id : providers.find(p => p.id === view.provider)?.id;
}

/** A computer you own finished its join, with the address it dialled from as `ws` reported it. The view carries
 * what it said about itself, so the sheet fills its row off this one event. */
export const PlaceJoinedEvent = z.object({ type: z.literal("place.joined"), place: PlaceView, from: z.string() });
export const PlacePresentEvent = z.object({ type: z.literal("place.present"), placeId: z.string(), from: z.string() });
/** `said` is the runtime's own reason where it has one, as for a box whose kernel can no longer boot the image. */
export const PlaceAbsentEvent = z.object({ type: z.literal("place.absent"), placeId: z.string(), said: z.string().optional() });
export const PlaceRemovedEvent = z.object({ type: z.literal("place.removed"), placeId: z.string() });
/** The four as one type, so the host's door and the app's fold read one shape. */
export type PlaceEvent = z.infer<typeof PlaceJoinedEvent> | z.infer<typeof PlacePresentEvent> | z.infer<typeof PlaceAbsentEvent> | z.infer<typeof PlaceRemovedEvent>;

/** A project was recorded, so every client's list follows without a refetch. */
export const ProjectAddedEvent = z.object({ type: z.literal("project.added"), project: ProjectView });
export type ProjectAddedEvent = z.infer<typeof ProjectAddedEvent>;

/** How far one add has got, one event per stage, so a client watching an add reads the clone, the seed and the
 * install as they happen rather than waiting on one reply. */
export const ProjectAddEvent = z.object({
  type: z.literal("project.add"),
  projectId: z.string(),
  computer: z.string(),
  stage: ProjectAddStage,
  message: z.string(),
  elapsedMs: z.number(),
});
export type ProjectAddEvent = z.infer<typeof ProjectAddEvent>;

/** A project's record was dropped. */
export const ProjectRemovedEvent = z.object({ type: z.literal("project.removed"), projectId: z.string() });
export type ProjectRemovedEvent = z.infer<typeof ProjectRemovedEvent>;

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatingEvent.extend(sequenced),
  WorkspaceCreatedEvent.extend(sequenced),
  WorkspaceNappedEvent.extend(sequenced),
  WorkspaceWokenEvent.extend(sequenced),
  WorkspaceUpgradedEvent.extend(sequenced),
  WorkspaceRenamedEvent.extend(sequenced),
  WorkspaceLookEvent.extend(sequenced),
  WorkspaceAgentsEvent.extend(sequenced),
  WorkspaceDeletedEvent.extend(sequenced),
  WorkspaceGoneEvent.extend(sequenced),
  WorkspaceStatusEvent.extend(sequenced),
  WorkspaceCostEvent.extend(sequenced),
  SessionStartEvent.extend(sequenced),
  SessionDeltaEvent.extend(sequenced),
  SessionDoneEvent.extend(sequenced),
  SessionEndEvent.extend(sequenced),
  SessionSteerEvent.extend(sequenced),
  SessionNotifyEvent.extend(sequenced),
  SessionPermissionEvent.extend(sequenced),
  SessionPermissionClosedEvent.extend(sequenced),
  SessionQueuedEvent.extend(sequenced),
  PortOpenEvent.extend(sequenced),
  PortCloseEvent.extend(sequenced),
  InboxFileEvent.extend(sequenced),
  GoldenStageEvent.extend(sequenced),
  ForwardOpenEvent.extend(sequenced),
  ForwardCloseEvent.extend(sequenced),
  ProjectAddedEvent.extend(sequenced),
  ProjectAddEvent.extend(sequenced),
  ProjectRemovedEvent.extend(sequenced),
  ProjectImportEvent.extend(sequenced),
  ProjectExportEvent.extend(sequenced),
  PreferencesChangedEvent.extend(sequenced),
  ReleaseChangedEvent.extend(sequenced),
  InitJobEvent.extend(sequenced),
  InitNeedsYouEvent.extend(sequenced),
  PlaceStageEvent.extend(sequenced),
  PlaceJoinedEvent.extend(sequenced),
  PlacePresentEvent.extend(sequenced),
  PlaceAbsentEvent.extend(sequenced),
  PlaceRemovedEvent.extend(sequenced),
  AgentsChangedEvent.extend(sequenced),
]);
export type EventUnion = z.infer<typeof EventUnion>;

/** What events.subscribe answers before it pushes anything. seq is the newest sequence the runtime has issued (0
 * before its first event): the cursor a client that has seen no event yet resubscribes from. stream names the
 * runtime process that issued it; sequences from two streams never compare, so a client that stored one and sees
 * another treats the reply as a gap whatever else it says. gap: the `after` sent is not a cursor into this stream
 * (the runtime no longer retains it, or it came with another stream id), nothing was replayed, and a client that
 * folds events must refetch sessions.history. */
export const EventsSubscribeReply = z.object({
  seq: z.number().int().nonnegative(),
  stream: z.string().optional(),
  gap: z.literal(true).optional(),
});
export type EventsSubscribeReply = z.infer<typeof EventsSubscribeReply>;

// --- daemon wire protocol (ws://0.0.0.0:7070, auth frame first, 4401 on anything else) ---

/** Client-side health of a daemon link. opening: a link that has never been open is being dialled, so nothing is
 * coming back yet and nothing may be promised back. connecting: a link that was open once is being dialled again.
 * unanswered: a link that has never been open and whose first-answer bound has passed, so what it dials is not
 * answering and the person is owed what to do instead of a wait. reauth-needed: the daemon refused the token the
 * host sent. A browser link holds no token of its own, so it opens a channel again and the host dials with the one
 * it holds now; the host's own link stops there. refused: the door answered the upgrade with a status, so no retry
 * at the usual pace opens anything; the link holds this until a dial gets past the door, and retries at the ceiling.
 * dead is terminal. The host's own link reports neither opening nor unanswered, as it reports no refusal: no person
 * reads its words. */
export const DaemonLinkStatus = z.enum(["opening", "connecting", "live", "reauth-needed", "refused", "unanswered", "dead"]);
export type DaemonLinkStatus = z.infer<typeof DaemonLinkStatus>;

const reqId = z.union([z.string(), z.number()]);

/** The first frame on every daemon socket, the URL carries no token: answered {id, ok} then daemon.hello, or
 * the socket closes 4401 with one sentence of reason. Anything else first, or nothing, closes the same way.
 * A peer that sends more than a few KiB before this frame passes is closed 4401 too, so a client sends nothing
 * more until it is answered. port scopes the socket to one guest port: only tunnel ops on that port and ping are
 * answered, everything else is refused with code forbidden. */
export const DaemonAuthRequest = z.object({
  id: reqId,
  op: z.literal("auth"),
  token: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type DaemonAuthRequest = z.infer<typeof DaemonAuthRequest>;

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** A schema kept for a parse, held to the type the protocol crate writes for the same frame: where the two differ
 * in any field, the build fails rather than the parse drifting from the wire. */
type Held<T extends true> = T;

// Replies carry no op, so each files/diff op has its own reply schema here
// instead of a discriminated union; DaemonOkResponse stays the loose envelope.

export const FsEntryType = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryType>;
/** name is the entry's own name in the listed directory; size is 0 for
 * anything but a file; mtime is epoch milliseconds. */
export const FsEntry = z.object({ name: z.string(), type: FsEntryType, size: z.number(), mtime: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;
/** total counts the directory's entries after filtering; truncated means
 * entries holds only the first cap of them. */
export const FsListReply = z.object({ entries: z.array(FsEntry), truncated: z.boolean(), total: z.number() });
export type FsListReply = WireFsListReply;
type FsListReplyHeld = Held<Same<z.infer<typeof FsListReply>, FsListReply>>;

export const FsReadEncoding = z.enum(["utf8", "base64"]);
export type FsReadEncoding = z.infer<typeof FsReadEncoding>;
/** size is the whole file's byte length; content holds at most the first 2 MiB. */
export const FsReadReply = z.object({ content: z.string(), size: z.number(), truncated: z.boolean() });
export type FsReadReply = z.infer<typeof FsReadReply>;

/** Porcelain v2 branch header: head is "(detached)" off a branch, oid
 * "(initial)" before the first commit; ahead/behind are 0 without an upstream. */
export const GitBranch = z.object({
  oid: z.string(),
  head: z.string(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
});
export type GitBranch = z.infer<typeof GitBranch>;
/** xy is the two-letter porcelain code ("??" untracked, "!!" ignored, "." for
 * an unchanged side); origPath is set for renames and copies. */
export const GitStatusEntry = z.object({ xy: z.string(), path: z.string(), origPath: z.string().optional() });
export type GitStatusEntry = z.infer<typeof GitStatusEntry>;
/** root is the working tree's top-level directory, absolute on the guest. */
export const GitStatusReply = z.object({ branch: GitBranch, entries: z.array(GitStatusEntry), root: z.string() });
export type GitStatusReply = z.infer<typeof GitStatusReply>;

/** branch: working tree against the merge-base with the default branch;
 * unstaged: working tree against the index; staged: index against HEAD. */
export const GitDiffScope = z.enum(["branch", "unstaged", "staged"]);
export type GitDiffScope = z.infer<typeof GitDiffScope>;
export const GitDiffFile = z.object({ path: z.string(), patch: z.string() });
export type GitDiffFile = z.infer<typeof GitDiffFile>;
/** base is the ref the branch scope diffed against (null for other scopes);
 * truncated means the 2 MiB patch budget cut files or a patch short. */
export const GitDiffReply = z.object({ base: z.string().nullable(), files: z.array(GitDiffFile), truncated: z.boolean() });
export type GitDiffReply = z.infer<typeof GitDiffReply>;

/** One live or exited pty the daemon still holds; exited ones stay until pty.kill. */
export const PtyListEntry = z.object({ id: z.string(), pid: z.number(), cols: z.number(), rows: z.number(), exited: z.boolean() });
export type PtyListEntry = z.infer<typeof PtyListEntry>;
export const PtyListReply = z.object({ ptys: z.array(PtyListEntry) });
export type PtyListReply = z.infer<typeof PtyListReply>;

export const ProcSignal = z.enum(["TERM", "KILL"]);
export type ProcSignal = z.infer<typeof ProcSignal>;

/** One process as /proc/[pid] shows it. cpu is its busy share of one core
 * over the interval (a threaded process can pass 100); rss in bytes;
 * startedAt epoch milliseconds; cmdline the first 200 bytes with the NULs as
 * spaces, empty for a kernel thread; pty names the daemon pty whose shell
 * this is. The environment never travels: it holds tokens. */
export const ProcEntry = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  state: z.string(),
  comm: z.string(),
  cmdline: z.string(),
  cpu: z.number(),
  rss: z.number(),
  startedAt: z.number(),
  pty: z.string().optional(),
});
export type ProcEntry = z.infer<typeof ProcEntry>;

/** Which column a list of processes is ordered by: what is spending the cpu, or what is holding the memory. */
export type ProcSort = "cpu" | "mem";

/** Processes heaviest first on that column, ties broken by pid so one snapshot always lays out the same way. The
 * app's pane sorts each set of siblings by this and the command line's own list reads it flat; a second copy of the
 * rule is how the two would come to disagree about which process is the busiest. */
export const byProcColumn =
  (sort: ProcSort) =>
  (a: ProcEntry, b: ProcEntry): number => {
    const d = sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss;
    return d !== 0 ? d : a.pid - b.pid;
  };

/** cwd is null when unreadable; ports are the TCP ports this pid listens on;
 * children are the pids whose parent it is, as of the last snapshot. */
export const ProcInspectReply = z.object({
  pid: z.number().int(),
  cwd: z.string().nullable(),
  ports: z.array(z.number().int()),
  /** Absent where the machine's own processes module cannot count them: this computer reads its processes with ps,
   * which has no thread column on macOS. */
  threads: z.number().int().optional(),
  children: z.array(z.number().int()),
});
export type ProcInspectReply = z.infer<typeof ProcInspectReply>;

/** How much of a command's output one exec op carries back, stdout and stderr together. Past it the reply says
 * truncated and the rest is dropped: the road is a WebSocket frame and a turn that cats a log would otherwise put
 * the machine's whole disk through it. */
export const EXEC_OUTPUT_MAX = 2 * 1024 * 1024;

/** How long an exec frame that named no deadline of its own gets. Every caller on the host's side names one; this
 * is what bounds a frame that did not, so nothing runs without end on a computer somebody owns. */
export const EXEC_TIMEOUT_DEFAULT_MS = 20_000;

/** The longest an exec frame may ask for, which is the cap the daemon holds its own timer to. A caller with a
 * command that can run longer launches it detached and polls it instead. */
export const EXEC_TIMEOUT_MAX_MS = 600_000;

/** The exit code a command killed at its deadline answers with, on every road wsp runs one: the shell's own word
 * for it, so a caller reads one number whether the command was launched detached on a guest or run by an exec op
 * on a place. One home, since the two roads' guards are compared against each other in tests. */
export const EXEC_DEADLINE_EXIT = 124;

/** One command on this machine, for a host driving it over a link it did not open: `bash -c`, in the daemon's own
 * root and environment, with the bytes for its stdin where the caller has any. The byte road a daemon token, a
 * roots file and a project part take on a machine whose backend mints no signed URL. */
export const DaemonExecRequest = z.object({
  id: reqId,
  op: z.literal("exec"),
  cmd: z.string().max(EXEC_BODY_MAX),
  timeoutMs: z.number().int().positive().max(EXEC_TIMEOUT_MAX_MS).optional(),
  /** Bytes for the command's stdin, base64; absent closes stdin at once. */
  stdin: z.string().optional(),
});
export type DaemonExecRequest = z.infer<typeof DaemonExecRequest>;

export const DaemonExecReply = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean() });
export type DaemonExecReply = z.infer<typeof DaemonExecReply>;

/** What a guest session carries: the tool server's JSON-RPC messages, or one command line and its streams. */
export const GuestKind = z.enum(["mcp", "cli"]);
export type GuestKind = z.infer<typeof GuestKind>;

export const DaemonRequest = z.discriminatedUnion("op", [
  /** machineId, on these seven and on no other op of this road: the workspace the pty belongs to, on a daemon
   * that runs workspaces. A workspace on a computer somebody owns runs no daemon of its own, so the daemon of
   * the computer holding it opens the shell inside that workspace's namespaces, in the folder the frame names,
   * which is absolute and is asked for, since that daemon has no working directory inside a workspace. Without
   * one the pty is the daemon's own computer's, which is every machine wsp forked; every later op on that pty
   * names the same workspace, and one that names another, or none, is answered no such pty. */
  z.object({
    id: reqId,
    op: z.literal("pty.create"),
    cols: z.number().optional(),
    rows: z.number().optional(),
    shell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    machineId: z.string().optional(),
  }),
  z.object({ id: reqId, op: z.literal("pty.attach"), ptyId: z.string(), machineId: z.string().optional() }),
  /** This socket's listeners off that pty, the mirror of pty.attach: a pane that closed stops the bytes of its
   * own pty on a socket that many panes share. */
  z.object({ id: reqId, op: z.literal("pty.detach"), ptyId: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.write"), ptyId: z.string(), data: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.resize"), ptyId: z.string(), cols: z.number(), rows: z.number(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.kill"), ptyId: z.string(), machineId: z.string().optional() }),
  /** With a workspace named, that workspace's ptys alone; without one, this daemon's own alone. */
  z.object({ id: reqId, op: z.literal("pty.list"), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("ports.watch") }),
  z.object({ id: reqId, op: z.literal("manifest.get") }),
  z.object({
    id: reqId,
    op: z.literal("manifest.record"),
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().optional(),
  }),
  z.object({ id: reqId, op: z.literal("manifest.restartScript") }),
  z.object({ id: reqId, op: z.literal("inbox.watch") }),
  z.object({ id: reqId, op: z.literal("inbox.rescan") }),
  /** Streams sys.sample events to this socket every two seconds until it
   * closes. One sampler serves every subscriber and stops with the last one;
   * the first sample lands one interval after the reply, since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("sys.watch") }),
  /** Streams proc.snapshot events to this socket every two seconds until
   * proc.unwatch or the socket closes. The daemon reads /proc only while some
   * socket watches; the first snapshot lands one interval after the reply,
   * since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("proc.watch") }),
  z.object({ id: reqId, op: z.literal("proc.unwatch") }),
  /** One process in depth, replied as a ProcInspectReply; this is the only op
   * that scans /proc/net, and only for that pid's sockets. */
  z.object({ id: reqId, op: z.literal("proc.inspect"), pid: z.number().int().positive() }),
  /** Sends the signal. pid 1, the daemon and the daemon's parent are refused
   * with code forbidden; a pid that is gone answers not-found. */
  z.object({ id: reqId, op: z.literal("proc.kill"), pid: z.number().int().positive(), signal: ProcSignal }),
  z.object({ id: reqId, op: z.literal("ping") }),
  /** Lists one directory's direct children, each request under its own entry
   * cap. Paths are relative to the daemon's home root (HOME unless started
   * with --root) or absolute inside it or an imported project folder named in
   * DAEMON_ROOTS_PATH; anything resolving outside every root, through .. or a
   * symlink, is refused with code outside-root. gitignore hides .git and the
   * entries git would ignore.
   *
   * machineId, on these seven and on no other op of this road: the workspace the frame is for, on a daemon that
   * runs workspaces. A workspace on a computer somebody owns runs no daemon of its own, so the daemon of the
   * computer holding it answers for it: the path then names the folder as that workspace sees it, a file is read
   * through the workspace's own rootfs and a git operation runs inside the workspace, in its namespaces and its
   * cgroup. Without one the path is resolved under the daemon's own roots, which is every other machine. A daemon
   * that runs no workspace answers the missing refusal for any machineId. */
  z.object({
    id: reqId,
    op: z.literal("fs.list"),
    path: z.string(),
    gitignore: z.boolean().optional(),
    machineId: z.string().optional(),
  }),
  z.object({ id: reqId, op: z.literal("fs.read"), path: z.string(), encoding: FsReadEncoding.optional(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("git.status"), cwd: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("git.diff"), cwd: z.string(), scope: GitDiffScope, path: z.string().optional(), machineId: z.string().optional() }),
  /** Pushes the branch the checkout is on to its remote and answers a GitPushReply. The base branch itself is
   * refused: wsp makes no branch and pushes none of the branch the work started from. Without a base the
   * checkout's own default branch is read, which is what a project recorded without one was cloned at. */
  z.object({ id: reqId, op: z.literal("git.push"), cwd: z.string(), base: z.string().optional(), machineId: z.string().optional() }),
  /** Opens the branch's pull request against the base through the git host's own signed-in command line, or
   * answers with the one already open. Refused with code no-host-cli where that command line is not there. */
  z.object({ id: reqId, op: z.literal("git.pr"), cwd: z.string(), base: z.string().optional(), title: z.string().optional(), body: z.string().optional(), machineId: z.string().optional() }),
  /** Where the branch's pull request stands, read back through that same command line. */
  z.object({ id: reqId, op: z.literal("git.prState"), cwd: z.string(), machineId: z.string().optional() }),
  /** Replies with a HostFolderListing: one level of folders on the computer this daemon runs on, for the folder
   * picker of a computer somebody owns. The roots are the home of the login the daemon runs as and each of
   * `projects` the home does not hold; `dir` absent lists the home, and so does a folder inside the roots that is
   * gone. A path outside the roots, a relative one, or one through a symlink that leaves them is refused with code
   * outside-root. Folders only, one level, `repo` where the folder holds .git; the dot-named ones are counted and
   * listed only when `hidden`. `repos` answers every repo under the roots instead, as this computer's repos listing
   * does: REPO_DEPTH folders deep and REPO_CAP of them at most, walking into no repo, no link, no dot-named folder and
   * nothing in CACHE_DIRS, each with its branch and when git last wrote there, most recent first. No file is read
   * but a repo's HEAD. */
  z.object({ id: reqId, op: z.literal("fs.folders"), dir: z.string().optional(), hidden: z.boolean().optional(), repos: z.boolean().optional(), projects: z.array(z.string()).optional() }),
  /** One laptop-side connection to a guest loopback port, for the sign-in
   * callback forward. The daemon dials 127.0.0.1 then ::1 (a Node 22 tool
   * binds [::1] only). data is base64; the reply to tunnel.open comes after
   * the guest accepted. */
  z.object({ id: reqId, op: z.literal("tunnel.open"), tunnelId: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ id: reqId, op: z.literal("tunnel.write"), tunnelId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("tunnel.close"), tunnelId: z.string() }),
  DaemonExecRequest,
  /** Sweeps wsp off this computer and answers what it took, then the agent exits: the one op whose handler belongs
   * to the link a place opened and not to the daemon's own switch. */
  z.object({ id: reqId, op: z.literal("place.leave") }),
  /** A process inside this machine opens a guest session: the tool server, or one command line. The daemon relays
   * it up the socket the host holds and reads nothing of what rides here; the token is the thread's, and the host
   * is what reads it. Sent on the inbound road alone, since no guest runs on a computer somebody owns. */
  z.object({
    id: reqId,
    op: z.literal("guest.open"),
    kind: GuestKind,
    /** The thread's token off WSP_HOST_TOKEN, "" when the launch carried none; the host reads it, the daemon never does. */
    token: z.string().max(GUEST_TOKEN_MAX),
    turnToken: z.string().max(GUEST_TOKEN_MAX).optional(),
    argv: z.array(z.string()).max(GUEST_ARGV_MAX),
    cwd: z.string().max(GUEST_CWD_MAX),
  }),
  /** One message from the guest process on the session its socket opened. */
  z.object({ id: reqId, op: z.literal("guest.send"), message: z.unknown() }),
  /** The host asks to be handed every guest session this daemon opens; the last socket to ask is where they go. */
  z.object({ id: reqId, op: z.literal("guest.watch") }),
  /** The host's answer on a session, and the host ending one; both are refused on a socket that never watched. */
  z.object({ id: reqId, op: z.literal("guest.reply"), session: z.string(), message: z.unknown() }),
  z.object({ id: reqId, op: z.literal("guest.close"), session: z.string(), error: z.string().optional() }),
  /** The daemon this host deploys, landed on the computer the link runs on and started in place of the one running
   * there. The parts arrive as machine.putBytes's do, in seq order under one upload id on one socket; the part
   * marked last is checked against sha256, moved over the binary the unit starts and answered, and then the agent
   * ends so whatever supervises it starts the new one. Nothing on that computer is swept: the workspaces' records
   * stay on its disk and the daemon that comes up reads them again.
   *
   * The other link op, and for the same reason: a binary is bytes and never a command line, since a command sits in
   * a world readable /proc/<pid>/cmdline while it runs. */
  z.object({
    id: reqId,
    op: z.literal("place.update"),
    uploadId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    seq: z.number().int().min(0),
    last: z.boolean(),
    data: z.string(),
    /** Lowercase hex sha256 of the whole binary, carried on every part and read on the last: a binary that landed
     * short would otherwise be moved over the one the unit starts, and Restart=always would loop on it. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

/** The reply to guest.open: the id both sides name the session by. Every other guest op answers the empty ok. */
export const GuestOpenReply = z.object({ session: z.string() });
export type GuestOpenReply = z.infer<typeof GuestOpenReply>;

/** What a cli session's messages carry: text for one of the two streams, then the code the line ended with. A tool
 * server session carries the harness's own JSON-RPC, which has no shape of ours. */
export const GuestCliMessage = z.union([
  z.object({ stream: z.enum(["out", "err"]), text: z.string() }),
  z.object({ exit: z.number().int() }),
]);
export type GuestCliMessage = z.infer<typeof GuestCliMessage>;

// --- machines over a place link -------------------------------------------
//
// One computer drives another computer's machines: every call the engine's
// MachineBackend and Machine interfaces carry, as a frame on the link the
// place opened. The data shapes live here rather than in the engine because
// they are the wire and the interface at once, and two copies of a spec would
// drift the day a field is added on one side.

/** What keeps the daemon running on a machine: the guest's own service manager, or the machine's boot itself on a
 * guest that has none (a container, whose PID 1 is the only thing that outlives an exec). */
export const DaemonSupervisor = z.enum(["systemd", "entrypoint"]);
export type DaemonSupervisor = z.infer<typeof DaemonSupervisor>;

export const MachineSpec = z.object({
  kind: MachineKind,
  template: z.string().optional(),
  fromSnapshot: z.string().optional(),
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  /** Root disk in GiB; the provider default applies when absent (Solari: 4, and 20 is its cap). */
  diskGb: z.number().optional(),
  envs: z.record(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  /** What the provider does when the machine sits idle past its window; the provider default (Solari: pause)
   * applies when absent. */
  onIdle: z.enum(["pause", "kill"]).optional(),
  /** Rolling idle window before onIdle fires; the provider default (Solari: 30 min documented) applies when absent. */
  idleTimeoutMs: z.number().optional(),
  /** One per create attempt: the provider answers a repeat of the same request under it with the machine it already
   * booted. Minted fresh after a kill, since a replay names the dead machine (measured 2026-09-04). */
  idempotencyKey: z.string().optional(),
  /** The machine gets the place's container engine through its daemon's fenced socket, so a project's own docker
   * compose runs inside it and sees its own containers alone; a place with no engine refuses the create. Absent is
   * no socket. */
  engine: z.boolean().optional(),
  /** The project this workspace is made with, on a computer the person owns. */
  copy: WorkspaceCopy.optional(),
  /** The logins that computer holds for every workspace on it, mounted into this one. Absent shares none. */
  shares: z.array(MachineShare).optional(),
  /** Folders on the computer bound into the workspace at create, read-write unless the bind says otherwise: a
   * project's memory folder rides this, so every workspace of one project reads and writes the same memory on the
   * computer holding it. A bind whose source is not a directory the computer holds is refused there. */
  binds: z.array(MachineBind).optional(),
});
export type MachineSpec = z.infer<typeof MachineSpec>;

export const ExecResult = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });
export type ExecResult = z.infer<typeof ExecResult>;

/** The provider's own view of a machine's size and birth. Solari's resume can rebuild a VM on a fresh host at
 * default size while keeping the id, so a wake compares the size against what was created. createdAt moves to the
 * resume time on every Solari resume (measured), healthy or not: record it, never judge by it. */
export const MachineShape = z.object({
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  /** The root disk the provider granted, in GiB; a dropped or misspelled disk field boots the default and says
   * nothing else. */
  diskGb: z.number().optional(),
  createdAt: z.string().optional(),
  /** What the machine has written since it booted, where the backend can read that off the disk itself rather than
   * through df inside, which on a container reads the box's whole disk. */
  usedBytes: z.number().int().nonnegative().optional(),
});
export type MachineShape = z.infer<typeof MachineShape>;

/** The history the runtime hands a snapshot: whether this machine was ever resumed. The fact is the record's; the
 * rule about it, if the provider has one, is the backend's. */
export const MachineLife = z.object({ firstLife: z.boolean() });
export type MachineLife = z.infer<typeof MachineLife>;

/** The route this host takes to one guest port. On a backend whose capabilities say previewUrls it is a public URL
 * with the provider's token embedded, the token standalone, and its expiry in epoch ms as the provider sets it; on
 * one that says otherwise it is a route only the computer holding the backend can take, with no token and an expiry
 * at the end of the machine's life. */
export const PreviewReach = z.object({ url: z.string(), token: z.string(), expiresAt: z.number() });
export type PreviewReach = z.infer<typeof PreviewReach>;

/** One snapshot as the provider lists it; sizeBytes is what storage is billed on. */
export const SnapshotRow = z.object({
  id: z.string(),
  /** The name the snapshot was taken under, which is where wsp's owner mark rides; absent on a backend whose
   * listing carries none. */
  name: z.string().optional(),
  sizeBytes: z.number(),
  createdAt: z.string().optional(),
  /** The snapshot this one was taken under, as the provider chains them; null at a root. */
  parent: z.string().nullable().optional(),
});
export type SnapshotRow = z.infer<typeof SnapshotRow>;

/** One template as the provider reports it: a promoted snapshot reads ready at once, a built one moves from
 * building to ready or failed, with the provider's reason only on failed. */
export const TemplateRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["building", "ready", "failed"]),
  error: z.string().optional(),
  /** When the provider says it was promoted or built; absent on a built-in and on a backend that reports none. It
   * is what gives a template the same grace a snapshot gets before anything may call it an orphan. */
  createdAt: z.string().optional(),
});
export type TemplateRow = z.infer<typeof TemplateRow>;

/** How the provider bills snapshot storage: the free GB shared by every snapshot on the account, the price of each
 * GB-month past them, and the day billing starts. */
export const SnapshotStoragePricing = z.object({ freeGb: z.number(), usdPerGbMonth: z.number(), billedFrom: z.string() });
export type SnapshotStoragePricing = z.infer<typeof SnapshotStoragePricing>;

export const LifecycleBudgets = z.object({
  /** How many times a wake may resume the machine and check it before a fresh fork replaces it. Each attempt after
   * the first is a pause and a resume; a provider that bills starts declares 1. */
  wakeAttempts: z.number().int().min(1),
  /** How long the guest's daemon gets to answer once the machine reads running, after a fork and after a resume
   * alike, before the runtime says it did not. */
  daemonAnswersMs: z.number().positive(),
  /** How the host keeps asking after a resume the provider did not take: once every everyMs of wall time from the
   * first ask, for forMs. Absent, the host asks once and stops. */
  resumeAsks: z.object({ everyMs: z.number(), forMs: z.number() }).optional(),
});
export type LifecycleBudgets = z.infer<typeof LifecycleBudgets>;

/** One machine as a backend lists it; size comes off the listing itself, since a per-machine read would reset that
 * machine's idle timer. */
export const MachineListRow = z.object({ id: z.string(), state: MachineState, labels: z.record(z.string()), size: WorkspaceSize.optional() });
export type MachineListRow = z.infer<typeof MachineListRow>;

/** The engine's own error kinds, carried on a refused frame so a container the place's daemon lost reads missing on
 * the host exactly as it reads on this computer. `absent` is the link's own: the place is not connected. */
export const MachineErrorKind = z.enum(["concurrency", "plan", "missing", "conflict", "snapshotUnavailable", "transient", "auth", "unknown", "absent"]);
export type MachineErrorKind = z.infer<typeof MachineErrorKind>;

/** What a backend says about itself once, when a link opens. Pricing carries its numbers and not its function: the
 * client answers rateUsdPerHour from the matching offer in capabilities.sizes, and 0 where none matches, which is
 * every size on a computer the person owns. Lifecycle carries budgets alone; a provider whose backstop is pushed
 * cannot be served over a link yet, and none that can be is. */
export const BackendFacts = z.object({
  /** The id of the row this computer serves, off the one table of what a joined computer can offer. What a fork
   * standing there was forked by: the computer says it, since which kinds there are is the computer's own to know
   * and the host that drives it reads a backend and never a kind. */
  offer: z.string(),
  capabilities: Capabilities,
  pricing: z.object({ defaultSize: WorkspaceSize, snapshotStorage: SnapshotStoragePricing, builderDiskGb: z.number().optional() }),
  lifecycle: z.object({ budgets: LifecycleBudgets }).optional(),
  baseTemplates: z.object({ sandbox: z.string(), desktop: z.string() }).optional(),
  /** Where this computer keeps the logins every workspace on it shares, absolute; absent from a backend that
   * shares none, which is every provider, since a machine somebody else runs holds no file of this person's. */
  logins: z.string().min(1).refine(isPlainPath, "an absolute path on the computer").optional(),
  /** Where this computer keeps the project checkouts it holds and each project's own memory, absolute; absent from
   * a backend that keeps none, which is every provider, where a project lives in an image instead. */
  projects: z.string().min(1).refine(isPlainPath, "an absolute path on the computer").optional(),
});
export type BackendFacts = z.infer<typeof BackendFacts>;

/** One machine as the place hands it over: the handle's fields, and which optional roads the handle carries, so the
 * client builds a machine whose optional methods are present exactly where the place's are. Where a fork dials the
 * host is not among them: the place's answer names the place, and a fork on it dials the address the host
 * advertises. */
export const MachineHandle = z.object({
  id: z.string(),
  kind: MachineKind,
  streamUrl: z.string().optional(),
  labels: z.record(z.string()).optional(),
  seen: z.object({ state: MachineState, createdAt: z.string().optional() }).optional(),
  replayed: z.boolean().optional(),
  daemonSupervisor: DaemonSupervisor.optional(),
  /** One sentence on a create whose size the computer would not give as asked, naming what it gave instead. The
   * handle carries the size itself nowhere, so this is the whole of what the person is told, said once. */
  notice: z.string().optional(),
  roads: z.object({ previewUrl: z.boolean(), daemonAnswers: z.boolean(), putBytes: z.boolean(), describe: z.boolean(), facts: z.boolean(), metrics: z.boolean() }),
});
export type MachineHandle = z.infer<typeof MachineHandle>;

/** What the computer holding a backend has left for one more machine. memRoomMb is the backend's share of the
 * memory less what its live machines (running and paused alike, a frozen container keeps its memory) are allowed;
 * diskFreeBytes is the filesystem under the daemon's root; images are the wsp images it holds. */
export const PlaceCapacity = z.object({
  cores: z.number(),
  memMb: z.number(),
  memRoomMb: z.number(),
  /** The most one machine's memory limit may name on this computer, which is what a fork of any bigger size is
   * clamped to. The room a fork takes is not the room the whole computer has, and the rule that says so is the
   * backend's own, so the number travels rather than the rule. */
  machineMemMb: z.number(),
  /** What the machines on this computer hold of it right now, summed over the ones that are not stopped: the cores
   * their quotas name and the memory their caps name. Absent from a backend that counts neither, which is what the
   * room line reads before it says anything. */
  cpuTaken: z.number().optional(),
  memTakenMb: z.number().optional(),
  diskFreeBytes: z.number(),
  images: z.array(z.object({ id: z.string(), name: z.string().optional(), sizeBytes: z.number() })),
  machines: z.object({ running: z.number(), paused: z.number() }),
});
export type PlaceCapacity = z.infer<typeof PlaceCapacity>;

/** How many more forks a place takes: the memory rule, and the disk rule where an image is there to measure by.
 * One function, read by the command line's table and the app's place row. */
export function forkRoom(c: Pick<PlaceCapacity, "memRoomMb" | "diskFreeBytes">, memMb: number, imageBytes: number | undefined): number {
  const byMemory = Math.floor(c.memRoomMb / memMb);
  const byDisk = imageBytes === undefined || imageBytes === 0 ? Number.POSITIVE_INFINITY : Math.floor(c.diskFreeBytes / imageBytes);
  return Math.max(0, Math.min(byMemory, byDisk));
}

/** Raw bytes per putBytes frame: 4 MiB is 5.4 MiB of base64 in one JSON frame, small enough that a pty stream on
 * the same link is not held behind it for long, large enough that a daemon bundle goes in one or two. */
export const MACHINE_PUT_PART_BYTES = 4 * 1024 * 1024;

export const MachineLinkRequest = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("machine.backend") }),
  z.object({ id: reqId, op: z.literal("machine.capacity") }),
  z.object({ id: reqId, op: z.literal("machine.checkKey") }),
  z.object({ id: reqId, op: z.literal("machine.create"), spec: MachineSpec }),
  z.object({ id: reqId, op: z.literal("machine.get"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.list"), labels: z.record(z.string()).optional() }),
  z.object({ id: reqId, op: z.literal("machine.exec"), machineId: z.string(), cmd: z.string().max(EXEC_BODY_MAX), timeoutMs: z.number().int().positive().optional() }),
  z.object({ id: reqId, op: z.literal("machine.pause"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.resume"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.kill"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.state"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.describe"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.facts"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.metrics"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.daemonAnswers"), machineId: z.string(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ id: reqId, op: z.literal("machine.previewUrl"), machineId: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ id: reqId, op: z.literal("machine.downloadUrl"), machineId: z.string(), path: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.uploadUrl"), machineId: z.string(), path: z.string() }),
  /** One part of a file. data is base64 of at most MACHINE_PUT_PART_BYTES raw bytes; parts of one uploadId arrive in
   * seq order on one socket; the part marked last lands the whole file through the backend's own byte road. The
   * upload id is a name, never a path: the far side keeps a file under it while the parts arrive, so anything that
   * could climb out of that folder is refused here, where the shape is read. */
  z.object({
    id: reqId,
    op: z.literal("machine.putBytes"),
    machineId: z.string(),
    path: z.string(),
    uploadId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    seq: z.number().int().min(0),
    last: z.boolean(),
    data: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type MachineLinkRequest = z.infer<typeof MachineLinkRequest>;

// One reply schema per reply, as the files and diff ops have; an op not listed answers the bare ok envelope.
export const MachineBackendReply = BackendFacts;
export const MachineCapacityReply = PlaceCapacity;
export const MachineHandleReply = z.object({ machine: MachineHandle });
export const MachineListReply = z.object({ machines: z.array(MachineListRow) });
export const MachineExecReply = z.object({ result: ExecResult });
export const MachineStateReply = z.object({ state: MachineState });
export const MachineShapeReply = z.object({ shape: MachineShape });
/** One workspace as the computer running it reads it, in one frame: the sizes its cgroup was written with, what it
 * holds of them now, and where its processes, its files and its address are. Every figure is read at the moment of
 * the ask rather than sampled, so a row drawn from it is true of that moment and of no moment since; a workspace
 * that is not running carries the sizes and the paths and none of the live figures. cpuUsageUsec is the processor
 * time the workspace has spent since it booted, so a rate is the difference between two readings. */
export const MachineReading = z.object({
  state: MachineState,
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  memBytes: z.number().int().nonnegative().optional(),
  cpuUsageUsec: z.number().int().nonnegative().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  procs: z.number().int().nonnegative().optional(),
  /** How long the computer running it has seen it do nothing on its own: no byte through a published port and no
   * command run in it. Counted from its boot, so one nothing has asked anything of reads its whole life. Absent
   * from a workspace that is not running, and from a computer that cannot say. */
  quietForMs: z.number().int().nonnegative().optional(),
  address: z.string().optional(),
  cgroup: z.string(),
  upper: z.string(),
});
export type MachineReading = z.infer<typeof MachineReading>;
export const MachineReadingReply = z.object({ reading: MachineReading });
export const MachineFactsReply = z.object({ facts: MachineFacts });
export const MachineAnswersReply = z.object({ answers: z.boolean() });
/** The route on the place's own loopback; the host turns it into a route of its own with a forward. */
export const MachineReachReply = z.object({ reach: PreviewReach });
export const MachineUrlReply = z.object({ url: z.string() });

/** What an op meant for the link a computer opened to its host answers on any other socket: the leave op, which
 * takes this computer out of a wsp, and every machine op, which drives the Docker daemon behind it. One sentence,
 * since it is one rule: a client holding this daemon's token is a client on this machine, and a client on this
 * machine neither un-joins it nor forks on it. */
export const NOT_ON_THIS_ROAD = "not on this road";

/** What a create naming a template or a snapshot is refused with on a computer somebody joined, and what a road
 * above answers for a saved image there without asking: a workspace on such a computer is made from that
 * computer's own directories and a copy of a checkout on it, so there is nothing to pull and nothing to build. */
export const NO_IMAGES_HERE = "this computer keeps no images: a workspace here is a copy of the computer itself";

/** What a fork is refused with when the place it lands on answers that it holds no copy of the snapshot named. A
 * fork builds the copy it needs only of the image's current version, so this is an older version or a project's
 * image named at a place it was never built at. */
export const placeHoldsNoImageLine = (place: string, image: string): string =>
  `${place} holds no copy of ${image}; a fork there builds a copy first only of your image's current version`;

/** What a remove of a place that still holds forks is refused with: the machines are the person's to delete, and a
 * place taken out from under them would leave containers nothing here can name. */
export const placeHoldsForksRefusal = (place: string, names: readonly string[]): string =>
  `${place} still holds ${names.length === 1 ? "a fork" : `${names.length} forks`} (${names.join(", ")}); delete them first, then wsp remove ${place}`;

/** What a remove of a place that still holds projects is refused with: a project is one computer's, so taking the
 * computer out would leave records standing on a place nothing here can name again. The forks go first, since a
 * workspace of a project is a machine on that computer, and the projects themselves after. */
export const placeHoldsProjectsRefusal = (place: string, names: readonly string[]): string =>
  `${place} still holds ${names.length === 1 ? "a project" : `${names.length} projects`} (${names.join(", ")}); wsp projects remove each of them first, then wsp remove ${place}`;

/** What a fork aimed at a place this host no longer holds a record for is refused with. Every computer on the
 * list forks, so the only way to reach this is a record that went between the word being read and the fork being
 * asked for: a remove, or a store another process wrote. */
export const placeForksNowhereLine = (place: string): string => `${place} is no longer a place in this wsp, so nothing forks there`;

/** What a verb aimed at the bare computer a place is, rather than at a workspace forked on it, is refused with. A
 * place holds its facts and its forks; the forks are the workspaces, so the refusal names the computer and the one
 * road to a workspace there. */
export const placeNotAWorkspaceLine = (place: string): string => `${place} is a computer you joined, not a workspace; its forks are the workspaces`;
export const placeNotAWorkspaceFix = (place: string): string => `Fork one there: wsp new <name> --on ${place}.`;

/** What a caller asking for the road to a workspace's own daemon is told, where that workspace runs none: a
 * workspace on a computer somebody owns is that computer's directories under the computer's own daemon, and that
 * daemon answers its files and its git through the host. Said rather than a route minted to a port nothing listens
 * on, which is what the panes and the relay read before. */
export const placeServesDaemonLine = (workspace: string, computer: string): string =>
  `${workspace} has no daemon of its own: ${computer} answers its files and git through this host`;

/** What a watch of the ports or of the load is refused with on a workspace whose computer answers its daemon
 * frames: both readings are that whole computer's, and one workspace reading them would read another workspace's
 * listeners and load as its own. A pane asks for both on every link it opens and takes a refusal of either. */
export const placeWatchesItselfLine = (computer: string): string =>
  `${computer} watches its own ports and load, which are that computer's rather than one workspace's`;

/** What a watch, read or signal of processes is refused with on a workspace whose computer answers its daemon
 * frames: that daemon acts on any pid on the computer, the computer's own and every other workspace's, so none of
 * them goes up its link from one workspace's channel. The Processes pane shows it in place of the table. */
export const forkProcsUnreadLine = (workspace: string, computer: string): string =>
  `${workspace}'s processes on ${computer} are not readable from here yet`;

/** What every other op is refused with on that workspace's channel: the frames that computer's daemon answers
 * inside the workspace they name are its shells, its files and its git, and every other op there runs on the
 * computer itself. */
export const forkOpRefusedLine = (op: string, workspace: string, computer: string): string =>
  `${computer} answers ${workspace}'s shells, files and git from here, not ${op}`;

/** What a person asking for a second workspace on the computer the app itself runs on is told. Its local mode is
 * one workspace, the one it already has; every other workspace is forked at a place. */
export const localRunsOneLine = (workspace: string): string => `${THIS_COMPUTER} is already a workspace, ${workspace}, the only one it can be`;
export const localRunsOneFix = (workspace: string): string => `Use ${workspace}, or name a place that forks: wsp places.`;

/** What a computer's kernel must have before wsp runs workspaces on it, asked in this order so the reason a person
 * reads is the first thing missing rather than the last. `read` answers a file's text or nothing when it is not
 * there; `euid` is the effective user the check runs as. Nothing here touches a disk: the two sides that ask (the
 * daemon on the box, and the join typed at it) each read their own files and share this one rule, so what the
 * doctor says and what a create does cannot part ways. */
export function workspacesBlockedBy(at: { platform: string; read: (path: string) => string | undefined; euid?: number }): string | undefined {
  if (at.platform !== "linux") return "wsp runs workspaces on a Linux computer";
  const controllers = at.read(CGROUP_CONTROLLERS_PATH);
  if (controllers === undefined) {
    return "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1";
  }
  const has = new Set(controllers.split(/\s+/));
  for (const wanted of ["memory", "cpu"]) if (!has.has(wanted)) return `this computer's cgroup root offers no ${wanted} controller, which wsp needs to run workspaces here`;
  const filesystems = at.read(PROC_FILESYSTEMS_PATH);
  if (filesystems === undefined || !filesystems.split(/\s+/).includes("overlay")) {
    return "this computer's kernel has no overlay filesystem, which a workspace here reads this computer's own directories through";
  }
  if (at.euid !== 0) return "wsp runs workspaces on this computer as root, and this daemon is not root";
  return undefined;
}

/** The two files that check reads, named once so the daemon and the host ask the same kernel the same question. */
export const CGROUP_CONTROLLERS_PATH = "/sys/fs/cgroup/cgroup.controllers";
export const PROC_FILESYSTEMS_PATH = "/proc/filesystems";

/** What a join of a computer whose kernel cannot boot the image is refused with, in the one sentence the daemon's
 * own doctor named the reason in. A computer that cannot boot your image is not a place, so the join stops here
 * and nothing is written on it. */
export const placeCannotBootLine = (place: string, reason?: string): string =>
  reason === undefined ? `${place} cannot run wsp workspaces, so it cannot be a place` : `${place} cannot run wsp workspaces: ${reason.replace("this computer", "it")}`;

/** The same sentence off a computer's own report, or nothing while it runs workspaces: one reading for the join's
 * refusal, the row, and every act that runs inside a copy there. */
export const placeBlocked = (place: string, report: Pick<PlaceReport, "runsWorkspaces" | "workspacesBlocked">): string | undefined =>
  report.runsWorkspaces ? undefined : placeCannotBootLine(place, report.workspacesBlocked);

/** The word a computer's row carries while its doctor says it cannot run workspaces. */
export const PLACE_BLOCKED_WORD = "can't run threads";

/** The one sentence a login that is not root reads when it tries to join a Linux computer. The daemon there is a
 * system service under /etc/systemd/system, so a plain account cannot install it and nothing is written before
 * this is said. */
export const PLACE_NEEDS_ROOT_LINE = "joining a Linux computer needs root, since wsp installs its daemon as a system service; log in as root or use sudo";

/** What a word that names no place this host holds is refused with, naming the ones it does. */
export const noSuchPlaceRefusal = (word: string, held: readonly string[]): string => `no place named ${word}; you have ${held.join(", ")}`;

/** Whether a word names this place: the id the wire keys it by, or the name a person types. The one reading every
 * road that takes a place word makes, so a list, a frame and a typed word cannot disagree about which place. */
export const namesPlace = (place: { id: string; name: string }, word: string): boolean => word === place.id || word === place.name;

/** Whether a row is a computer somebody joined to this wsp: a computer, and not the one the host runs on, whose
 * files and threads are that host's own. The one reading, so the road that runs on the link, the road at the
 * terminal and the list of places a fork could stand on cannot disagree about which rows are those computers. */
export const isJoinedComputer = (place: { id: string; kind: string }): boolean => place.kind === "computer" && place.id !== HERE_PLACE_ID;

/** What a build of the image at a place that cannot take one is refused with: a copy needs a builder forked there
 * and that builder's disk copied, and a computer somebody joined does neither. */
export const placeBuildsNoImageLine = (place: string): string =>
  `${place} takes no copy of your image: a copy is built by forking a machine there and copying its disk, and ${place} does neither`;

/** The two rooms the member rule is read in: the seal that takes the archive off a builder on the person's own
 * place, and the import that lands it on a copy somewhere else. */
export type VaultRoad = "seal" | "import";

/** What a vault archive is refused with: where the reading stopped, why, and what that refusal did, which is not
 * the same on the two roads. The archive is refused whole, since a builder that wrote one member nobody asked for
 * wrote every other member too. */
export const vaultMemberRefusal = (road: VaultRoad, member: string, why: string): string =>
  `the image's sign-in archive is refused at ${member}: ${why}; ${road === "seal" ? "the seal is refused and no version is recorded" : "nothing of it was imported"}`;

/** What a copy is refused with for a record whose vault kept no path list: sealed before the record held which
 * paths its sign-ins live at, so no other place can tell a member the seal asked for from one it did not. */
export const vaultUnlistedRefusal = (name: string, version: number): string =>
  `${name} v${version} was sealed before its record kept which paths its sign-ins live at, so no other place can check its archive against them; cut the next version`;

export const DaemonErrorCode = z.enum([
  "unsupported",
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "not-a-git-repo",
  "bad-request",
  "forbidden",
  /** No command line for the git host the remote names is on the machine, so the pull request waits; the push
   * itself landed, which is why a client reads this one as a note beside the push and not as a failure. */
  "no-host-cli",
]);
export type DaemonErrorCode = z.infer<typeof DaemonErrorCode>;

export const DaemonOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** code is set by the files and diff ops so clients can branch on the refusal
 * without matching message text; older ops send the message alone. */
export const DaemonErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  code: DaemonErrorCode.optional(),
  /** Set by the machine ops alone, so a backend's own error keeps its meaning across the link: a container the
   * place's daemon lost reads missing on the host exactly as it reads on the computer holding it. */
  kind: MachineErrorKind.optional(),
  status: z.number().int().optional(),
});
export const DaemonResponse = z.union([DaemonOkResponse, DaemonErrorResponse]);
export type DaemonResponse = z.infer<typeof DaemonResponse>;

/** One reading of the guest: cpu is busy time over the interval across all
 * cores (0 to 100), load1 the one-minute load average, mem and disk in bytes
 * (mem used is total minus available; disk is the filesystem under the
 * daemon's root), at epoch milliseconds. */
export const SysSample = z.object({
  type: z.literal("sys.sample"),
  cpu: z.number(),
  load1: z.number(),
  mem: z.object({ used: z.number(), total: z.number() }),
  disk: z.object({ used: z.number(), total: z.number() }),
  at: z.number(),
});
export type SysSample = z.infer<typeof SysSample>;

/** One reading of the computer the host runs on, pushed on a client's own socket rather than through the event
 * stream: it is a tick of a live figure, not a thing that happened, so nothing replays it to a socket that comes
 * back. Named apart from the daemon's own sys.sample because these two arrive on different sockets and a client
 * that reads both must not mistake one for the other. */
export const WorkspaceSysEvent = z.object({ type: z.literal("workspace.sys"), workspaceId: z.string(), sample: SysSample });
export type WorkspaceSysEvent = z.infer<typeof WorkspaceSysEvent>;

/** Every process the daemon read this tick. daemon is its own pid, so a
 * client can name it; total counts /proc entries, procs holds at most the
 * first thousand of them by pid. */
export const ProcSnapshot = z.object({
  type: z.literal("proc.snapshot"),
  at: z.number(),
  daemon: z.number().int(),
  total: z.number().int(),
  procs: z.array(ProcEntry),
});
export type ProcSnapshot = z.infer<typeof ProcSnapshot>;

/** The content of every daemon this project has deployed, oldest first, one entry per version: the last one is
 * what a deploy installs today, so appending the sha the host's daemon-content test prints is the whole of
 * cutting a new version. The three cut before the record existed have no sha to name. */
const UNRECORDED = "";
const DAEMON_CONTENTS = [
  UNRECORDED,
  UNRECORDED,
  UNRECORDED,
  "b749121a659b9c45b07285ee0f4e95f15aae26ddbc1bcba75745e83c2ae032c6",
  "b0b88a03c649769e0676ca38eaa5035825b71302c97a2858dcf8eb57131288be",
  "cae44a68bd72d81717b52a71c3890da918025cbd0d071db884102936e5cf4345",
  "c5c3b15cad1b45ed110b072a18d0d895f661c489f73828de78a3b9f3589f05c6",
  "f90fd16f8e5d15707cda18e58524da66fb6ed6b890632fff90d396792dc5604d",
  "9ebea6a49390fd5b1af911f413e77c3e46db091812b55b41515e881e93433292",
  "da0d618fd27965a77c8c15e389fea39c8f3ae691326af0212a8f1c62b9c8499f",
  "cbfe733de05765b706c3ff4d08aa62ee188258771dd3b02011633716fad62a48",
  "12eac7cd2f4b90f9064279a1ea3b3169d24e34c30279f5c19d046252e2d5ec66",
  "877eda4200afad3842bedad0e49d6efc942ef1ef3ea7181af22f9e726d72b669",
  "206d96d53b9734c3dce0e84bf11d5455e210b2419b6c9572748ebf69861afca5",
  "6875c912371aadfb9947191e4d887b9fb6576ed57d0268de91811a6d3ac4f4cd",
  "4c81908db0c4d29e74f00ddd5513e94137f01afeb39b9afbed242368be6097c6",
  "0ad3a1c3e98d5b75bf94d610b9e166a7ad1bb5e79ee7ab4905d6b738fb5eded9",
  "01030623497a43f044916ca27731dbfa4c92c6b82765a9e9dbd6426d69b1ee4e",
  "a6ae68d8af502a8a5ecf9795ca11ca0b9b12cda2792e45eee3376c7e4d57917b",
  "055dcf11b2a17e8959ab3a6246c2d17f89eb3837c59b31d3a8138c6dc7b6c322",
  "09e441a435678290871e210158d5f8fef3b43b307c5ec917086a201583c037a5",
  "386b54104e2a8abf8f45f9a35fe767971b72d5d00da68c4d8ae0aa9630b7cc6d",
  "9ff538bbfca0ac4e03ca8c822afd47b630dd21cec17ec929192ddc6ae6f10ce6",
  "14b4b9c0ccad20d544fa123841592c6438f735405f97a88957dafe4c39f47e8b",
  "ad9341f55ebc6a724a35b9febb11f7ca5cf5133a90d7a631bf39cf9a496657ac",
  "cebb929363226a20c057702cfe24235fa2f24749c70355539f5bab4b3bcfd3da",
  "bbdd3b1dc7fb73b04d5986128d099e11a723d777bd1a3c7cddd14819f1ee8cfc",
  "35236ee3220f12db35f3307812b2d2ea8c8762f8910e656d9d57a44bb599b0e3",
  "372241b199d0b23db89c2618409d8edf611bc5f29811fdaffca813ec2b283295",
  "5bb58cbade0b5be39242aa419feaa7e24d82a291271d6d83a2488799005fd5a0",
  "fdfbebe6ae5c0ff581df732222b76b6540a2e4d226c5381878e125499f55180c",
  "87e30b445d1e815a4dc336b35924ed061bc30374ad7f490ec3fefb4f194b6c0f",
  "e527369ddf63dcc38642a26caca0cd2f72f50e9be8b06f76d7cb7c93c349d826",
  "352699bc2434f5b1dc84d46026499662abf3bbcc4bc701736150a90042f79368",
  "0bec2f8329f6e46772d072acb082a83a943fe87ed31f2a83df3295069d1f6243",
  "5ef12ef8bf31cdb5ebbdd7ef56113fc447876b63dbabd073752a802491db5fab",
  "e0134bee72be55ed8349d11a9e656b61ee20ba55472be25546f0809763f99d9c",
  "9a92c0f6248b0182e5f5f7ad02c2d6e54b0809513171a390927d63bc3ee00e70",
  "46fe3b809d1bcc82d0dc644d8f300672cb72ae63c99668f6c1be1c75aa71a3f4",
  "87a461ca21eb894d129e0d692bcbdf56f1134d6160a0e84fe52692ed36f317cd",
  "8308517d14718d8b82e1e129f1e48a8a511aa9fdaae26b60c900b6280fa85051",
  "a51cf26e554a02935fda02942869ddd7251b41e84625e500336c7ce171a4d667",
  "c2f00944a79a850450b11b4610b93ac4894b7da39282755a9bfef55776a11dff",
  "c1fba7f2f77da32e75e8099b3ffd8bb36c0dbddfe88b0f018a2e59ac0e3b6905",
  "b9025a75a5b7f55164be73f60b2fd9f64510f74ad17d8fb24b18af168587899f",
  "022f1786d1aca054624bb042955dbbde64ecb4c974e918bbe95cf53e5d29cf0b",
  "e84a3a735fac175e251581fc61e29cd446e38142fb4579cae50cdaf30d63b858",
  "ed2fb414194ec877f031cb6a09e7869b4727132e25768eca2da581c8b902a0d1",
  "4453f856251c047172490b84c8502f74b6a1d25744f6878a382ac32fe45f2c46",
  "4605e734f4735405ddefd0478583032757ca8ad0b2dc8ce9a14e92789c2800a0",
  "52dc451ba47d583759687b0d9c8b5f3dc1d9f820ca25dc1e030e1268cc2b5157",
  "eb6eb2701b4edafd3f62e17ab032313660bafbfe80ce973bd56a56c86662aff8",
  "2b992e451cd69dbf08eac12f8c1208a1b01cf1a5a36319bc4875a08e387ae05f",
  "7deddf539fb438f49cc68e299e5d3e08413202f7325a73d7d815a532ac1e96c7",
  "1e3ca55474038b943e69a5a91ddf720df24e9f8a5fff8aa05028527cbb0605f2",
  "863d552bfaeeff40212778a4f175bf821f8ff5cdd7829e6922866bf70dcdbe5e",
  "376bdbce753a06ef57dfdda1e50f1cb761a728538dd85851db285168e4d1e568",
  "c1d414a8d13ee7070d1df56f82b7230bb53bed51b8b2d43c4bc39a864c5b5489",
  "cec7af13cc254d8325bf77409aedc4daeb072d5dc0413b58aaf45f8428698721",
  "b1c827b22fbdade28b749f72899b610723d5f312e339e9546552da14840013c1",
  "7324cbd1f27eb8983b8ea302c3cd32a629a4eedae7e0d46458acca37440baf88",
  "b83b671323ccc59fe9daa43da46dede2d640451c5b4f0c8e64ae2eef149ba694",
  "5b5db8f843457bfac71002bb4741d98f0f98bfe11579e7891c1a0955c39eed0f",
  "e10ddc035c5a0fb57b8b591da1fa220023e836e7c7598022c19d852e747bab46",
  "e6eb64e2466dfa2eca9448ea2aabfe82223c2897276663698a1184a16774145d",
  "361aa8997cc132755f0835ada745b05c7eee7faf20e67d14fa606971c5157441",
  "2c9896b832aebaccaf1b4f2c69ffba662e0a8b7f5748fc359313f8aff46a3b2a",
  "673d1f56aa3159a41d1b55b3b17c306628912a793cabc7d0208d2a4b937f07af",
  "311811170de5296b4e25d8b3bc6e46035a9c5fc13f6430d8ae9314be8d9815f9",
  "4202fe729182d82873c035271bb091be1fce798422a5349d9430e773567246a9",
  "dacb3a6c014686cff3aa977b424725f7270d200c3d42239b8467e94487593eb2",
  "4faf16035d8608562f0cfa8d463a7dc8b38830944b43002b9544697bb9c1dcd9",
  "83b228f3e824311abc08d0ff81538122bc5a0028655198ef6abba17f7daeaf0c",
  "ba2f7c6846cfc3d7ce66ff15f554d8b87dc20f5683931777d244e142709815dc",
  "de414be04f6f1b5142c2e5e718f4acd0a0526558dc96bed3a02b31f7acd924ba",
  "15f43fcf51b6d460b6e1acfa2ed0ce279a6645647834a10174bd9d249c2b2e6e",
  "7a1d4e70b470d3f404c987c4300756615bfca9f904f0ef12e74f26497775d72d",
  "c76e7e2a3b9a767beaa281b973a409e1bc8869969255fa6c9fdeb6211b38ce3d",
  "be3d9077764035f8bf2b96ab6b50c018017046ec74a30827404f64752ef19bdf",
];

/** The daemon's protocol version, carried in its hello, so a client can tell what a machine's daemon answers
 * before asking, and a host can tell that a machine's daemon is behind the one it would deploy. It moves whenever
 * an op is added or widened and whenever anything a deploy installs changes, because a live machine keeps the
 * daemon it has until the version it announces is behind this one. A hello without one is version 1: every daemon
 * deployed before the field existed, which has the pty, ports, manifest, inbox, fs, git and tunnel ops and no sys
 * or proc ops. Version 3 browses the imported project folders named in DAEMON_ROOTS_PATH beside its home.
 * Version 4 starts from a script that sets the guest PATH itself. Version 5 fetches its Node through the catalog's
 * curl function. Version 6 puts itself last for the kernel's memory killer and starts every shell it opens at the
 * work score instead. Version 7 picks the road to the listening ports by platform, so the same daemon serves them
 * on a Linux guest and on the person's own Mac. Version 8 runs under a systemd unit that restarts it, so a
 * daemon the kernel kills comes back on its own. Version 9 reads the utilisation and the processes it serves
 * through a module per kind of machine, and answers a watch only once that module has read the machine, so a
 * pane is refused where it would otherwise wait for a stream that never comes. Version 10 keeps a DISPLAY the
 * caller names on a pty it opens, so a sign-in whose page must return to the machine can be handed a browser to
 * find there. Version 11 serves a machine reached over ssh, which reads the load and the processes of the machine
 * it runs on the way a fork does; the same daemon under the person's own login there, with every path it keeps
 * under their home. Version 12 asks the prefix it would compile against for the headers themselves, so a machine
 * where an installer symlinked a foreign node into that prefix builds node-pty instead of failing on it. Version
 * 13 asks those headers which major they are and compiles against them only when the node that will load the
 * result agrees, so an older Node's headers left in the prefix send node-gyp after the right ones instead of
 * building against the API another Node declared. Version 14 reads the environment a provider could not hand a
 * fork at create off a file under /etc the unit may lack, so a backend that lands it there hands the daemon its
 * keys without touching anything else on the machine. Version 15 is deployed by a script whose guards end it
 * themselves, so a machine with no service manager and an npm install that failed stop at the line that found
 * them instead of leaving the rest to run. Version 16 starts by the node the deploy compiled its native modules
 * under, kept in the daemon's own folder, rather than by whatever a PATH the machine owns names at the moment of
 * the start: a machine restored onto another one names a different node there, or none, and none is a start that
 * fails every second for the life of the machine. Version 17 answers an exec op and can dial a host of its own: a
 * computer somebody joined as a place opens the socket outward, proves itself on the ed25519 key that host learned
 * at the join, and then serves that socket exactly as it serves an inbound one, so every command the host already
 * sends a machine rides one frame on the link and no runtime road learns a second transport. It also loads its
 * native pty module at the first terminal rather than at its own import, so a machine where nothing built that
 * module serves every other op instead of refusing to start. Version 18 finds that native module where a packaged
 * command carries it: the command bundles node-pty rather than requiring it, and a bundled CommonJS module arrives
 * with a default export and no named one, so a daemon running inside the packaged command opened no terminal at
 * all until this. Version 20 takes every option as a flag,
 * one per option, reads its ports, load, processes and pty modes off one /proc root, logs its samplers' starts and
 * stops, and builds a place's report and sweep off the home it is pointed at, so a test suite drives it as a binary
 * and the words and numbers it answers with are the protocol's, held in one fixture set. Version 21 takes
 * --runtime-root, where a place's daemon keeps the layers and the workspaces it runs itself. Version 22 is one
 * static binary, built from the Rust sources under daemon/ for each chip a machine can be: the deploy lands the two
 * Linux builds and keeps the one uname names, the unit and the supervisor start it by its path with one set of
 * flags, a computer joined as a place runs the same binary under its login's own manager, this computer's
 * workspace spawns it, and the guest keeps no node, no npm install and no native module for the daemon; the wsp
 * command beside it still runs on the node the machine carries. The binary also answers a plain HTTP request 426,
 * as the host's status probe reads a daemon by. Version 23 commits a workspace's upper directory to the layer store
 * as a snapshot, names a snapshot's chain as a template, and naps a workspace by stopping it: the processes go,
 * the upper directory stays as the saved layer, and the wake boots it again on the same address and forwards.
 * Version 24 makes the daemon the workspace manager on a joined computer: its report says whether it runs
 * workspaces here rather than whether it holds a Docker, and the install writes the wsp-workspace AppArmor profile
 * where the box takes it, so what a deploy leaves for a workspace to isolate under changed. Version 25 serves a
 * fenced engine socket into a workspace that asked for one: a proxy over the box's own Docker or podman socket that
 * labels every create with the workspace, filters every listing by it, refuses what would reach the box, and joins
 * a container's published port to the workspace's loopback; a create names the socket with the new engine field.
 * Version 26 stops a build whose libseccomp is not linked statically, so the Linux daemon is one static binary that
 * names no shared library; a binary that did was installed once and its container init called address zero.
 * Version 27 answers machine.snapshot with a job and machine.snapshotJob with how far it has got, so a layer that
 * takes minutes to write waits on no one frame; the layer is a plain tar, the shape carries the bytes the workspace
 * wrote, and a snapshot's failure is the job's own refusal. Version 28 runs every exec behind the workspace's
 * seccomp filter: a process an exec started ran with none while the init ran behind one, and now loads the same
 * filter before its command, or the exec is refused. Version 29 keeps one form per layer on a box: the unpacked
 * tree forks mount, with the blob dropped once its unpack is whole, so an image costs its size once; a layer's
 * bytes in a snapshot row, an image row and the swept count are what the tree's files hold, and the sweep at the
 * daemon's start drops any blob it finds beside its tree. Version 30 asks a machine for the service manager its
 * daemon would be held up by before a byte lands on it, rather than inside the install: the deploy script carries
 * that check no longer, and a machine wsp did not build is turned away with nothing written on it. Version 31 lets a
 * place say which life a copy may be taken from: a provider whose snapshot is the disk as it stands answers
 * snapshotsAnyLife and a builder that woke there is sealed, where one that answers only its first life still refuses
 * after a restart. Version 32 holds every workspace on a computer somebody keeps to a size that leaves that
 * computer a core and the smaller of half its memory and a gigabyte, a spec that names no size included: the
 * create answers the size it gave and one sentence saying so, the record holds that size, and the capacity says
 * what the workspaces there hold of the computer. Version 33 answers a client on the computer itself the listing of
 * the workspaces it holds and one reading of any of them, both read-only and both on the road that dials in; the
 * reading carries the sizes as applied, the memory and processor time off the cgroup, the uptime, the process
 * count, the address and the two paths, where the metrics op before it read two of those and replied with none.
 * Version 34 takes the daemon its host deploys over the link it already holds, where a computer once kept whatever
 * daemon it joined on: the parts of the binary arrive under one upload id with the sha256 of the whole, the last is
 * checked against it, moved over the file the unit starts with the old one kept beside it, and answered, and the
 * agent then ends so its supervisor starts what landed. Nothing is swept, so the workspaces' records stay on the
 * box and the daemon that comes up reads them again. Version 35 carries the daemon binary in the bundle where the
 * wsp command riding beside it reads one, under that command's own assets and one folder per chip, and writes the
 * unit, the supervisor script and the AppArmor profile inside the arm for the chip the machine says it is: the
 * binary a machine runs and the one a computer's own join looks for are one file, at one path, under one rule.
 * Version 36 relays a guest session: a process inside the machine opens one on the daemon over loopback with the
 * daemon's own token, and the daemon carries it up the socket the host already holds, so the wsp an agent runs
 * there needs no address of this host, no TLS and no node. The binary answers that word itself, and the deploy
 * writes a two-line shim onto the machine's PATH, in the same arm as the unit, that hands it the line.
 * Version 37 answers no op differently: the contract fixture a reply is held to no longer names a provider nothing
 * can serve, and a fixture's bytes are in the sha whatever they say. Version 38 answers nothing new either: this
 * record holds every Rust source under crates, test code included, so two cases added beside the place link's
 * agent parsing and the pty's cwd move it while the binary a guest runs is the one version 37 named.
 * Version 39 holds a joined computer out of idle sleep no longer: the hold that watched the place file is gone and
 * the file carries no field for it, so a computer sleeps on its own schedule while it is joined.
 * Version 40 dials a host at an https address: the link turns one into wss as the protocol does and speaks TLS
 * through rustls with the root certificates baked into the binary, since a box may carry no certificate store of
 * its own. It is the one road to a host that sits on a laptop behind a home router, which is the first address
 * such a host writes into every place file, and until now the link refused it and the box never dialled back.
 * Version 41 is the same binary as version 40: what this record hashes changed, not what a deploy installs. A
 * crate's tests/ folder is out of the sha, so test-only work stops cutting a version and no machine reads itself
 * as behind over cases it would never run.
 * Version 42 holds a guest session open across a host that went: the daemon keeps the frame each session opened
 * with and names every session it holds to whatever socket asks to watch next, so a host that restarted picks them
 * back up instead of closing the first message it cannot place, and a session nobody has watched for ten minutes
 * ends to its guest with one sentence, so the process inside the machine prints it and exits rather than waiting
 * for the life of the workspace.
 * Version 43 names the run of the daemon that opened a guest session: every opened frame carries a marker minted
 * once per start, so the host tells a session it still holds from a session of the same name on a machine that
 * was rebuilt under it, whose names count from the start again. Without it a guest carrying no turn token, running
 * the same line from the same folder under the same token, was glued to the earlier session's output.
 * Version 44 gives a workspace on a computer you own its project as a copy made once for it: a btrfs snapshot where
 * the checkout is a subvolume, a reflink copy where the disk shares blocks, a plain copy everywhere else with its
 * time said in the create's notice, chosen by asking the disk and never by a filesystem's name or id, bound into the
 * workspace at the project's own path before the runtime starts and unmounted deepest first at stop. The place report
 * carries the word for what the computer's disk can do, so the computers row says it. Before this a workspace shared
 * its project through an overlay whose lower directory the box could change under it, which the kernel leaves
 * undefined.
 * Version 45 lets a machine specification name shares: files the computer keeps outside every workspace under the
 * daemon's logins directory and binds into each workspace at a target path, so a login signed in once on the computer
 * is the same file in every workspace there and a refresh in one is the computer's refresh; a share whose source sits
 * outside that directory is refused at create.
 * Version 46 makes a workspace on a computer you own out of the computer itself: its system directories under overlays
 * with an upper per workspace, its home shared read-write with the daemon's own files hidden, the engine's data
 * hidden, the project bound at its path; a box pulls no image and keeps no layer store, and the snapshot and template
 * operations leave its wire. The root moves to /wsp so no upper sits under a lower the kernel would refuse.
 * Version 47 adds the copy verb the Mac host runs as a child: a directory clone of a project folder at a sibling path
 * in one call, a git worktree where a clone cannot work, then the two rules that make the copy a clean checkout with
 * its ignored files kept; the capabilities say whether a computer copies and whether a copy gets its own network,
 * which is how the row knows this Mac shares ports.
 * Version 48 lets a machine specification name binds: folders on the computer bound into a workspace at create,
 * read-write or read-only, refused where the source is not a directory on the computer; the runtime binds a project's
 * memory folder this way so every workspace of the project on that computer reads and writes the one memory, keyed on
 * the project and not on a path.
 * Version 49 makes a workspace on a box awake or stopped and nothing else: pause stops it with SIGTERM to its cgroup
 * after a real quiet window read off its published ports and its commands, and the reading carries how long it has
 * been quiet; a service bound to loopback inside answers through the published port; a create the box has no room for
 * is refused in one sentence naming the quietest workspace; root inside drops the standard capability list and sees
 * empty files over the box's secrets, its ssh keys and the engine's paths; the compose project is named per workspace.
 * Version 50 adds the git road out of a workspace: a push of the branch the copy is on with a refusal to push the
 * base, the pull request opened or found through the signed-in host command line on the computer and its state read
 * back, three operations behind one trait with one module per host.
 * Version 51 gives a workspace on a box the box's tools and a daemon that answers for it: the box's Homebrew prefix and
 * every install root the recipe lands outside the overlaid trees are bound read-only into the workspace's rootfs, and the
 * place daemon serves a workspace's git, file and exec operations with the workspace's checkout as the working directory,
 * so nothing runs a daemon inside a workspace and the init's supervisor lookup is gone.
 * Version 52 refuses a bind whose destination is one of the trees the rootfs takes from the computer, the box's /root
 * and every shared tool root whether present on the computer yet or not, or sits under one, at the create, so a
 * workspace's copy or folder bind can never leave its mount point on the computer's own home.
 * Version 53 puts the provision folder and wsp's own folder whole on the list a leave sweeps, in the daemon and in the
 * protocol with a fixture that holds the two equal, and reads the landed list before the folder goes so wsp's own landed
 * files leave with it and the folders they emptied are pruned; a bring back reports its push half first, the branch, the
 * ahead count and the diffstat, and a gh that is present but not signed in reads as the note beside the landed push,
 * while a push refused for want of a credential says so in the person's words with the command only the person can run.
 * Version 54 adds two optional fields to the place report: each agent's version as the daemon read it, and the relative paths of the files under the logins directory. A host on 53 reads a 54 report as before; a 53 daemon's report reads on a 54 host as today, with no version and no sign-in word.
 * Version 55 reads the agents it reports, and their versions, on the tools PATH the workspaces and the presence read use
 * before the unit's own, so an agent installed by Homebrew or by its own installer is on the report; and the boot records
 * the computer's own paths of the mount points it made for file shares under the computer's trees, so the stop and the
 * remove take them off when no other running workspace shares the target and nothing of a workspace's mounts stays on
 * the computer's own home.
 * Version 56 writes the mount points a boot makes into the create's own claim before anything is mounted, and the record
 * carries them at the end, so a create that fails between the point and its record leaves the points to the open's sweep
 * of unfinished claims and nothing of a workspace's mounts stays on the computer's own home.
 * Version 57 reads the mount points a neighbouring boot has claimed and not yet recorded, so two workspaces sharing one
 * login that boot at the same moment both own its point and the last one to go takes it off, and writes every record,
 * claim and network file to a sibling and renames it into place, so a daemon that dies inside a write leaves no torn
 * file for the next open to refuse, which takes a dead create's torn claim away instead.
 * Version 58 writes the process manifest to a sibling and renames it into place through the same writer every file the
 * runtime crate writes takes, so a daemon that dies inside the write leaves the manifest it had or none, never a torn
 * one the next start refuses.
 * Version 59 binds a socket in each running workspace's own wsp folder that answers a guest's ping, open and send and no
 * other op, so a process inside a box workspace reaches the host's guest door without a token of the box's, writes the
 * wsp word into the workspace's own upper, and opens a shell inside a workspace's namespaces for the terminal pane, held
 * beside the daemon's own ptys and answered to no other workspace.
 * Version 60 links only to a host it has proven, taking the second frame after the first is verified and its own prove
 * sent, seals every frame of the link at both ends so whoever carries it reads and writes nothing, resolves no command
 * through a folder a workspace can write, and holds a token of its own machine's rather than one every machine shares.
 * Version 61 bounds the guest bytes in flight per workspace on a place and per daemon inside a fork, queued and unsent
 * alike, and refuses a frame past the cap with a sentence of its own while the session stays open.
 * Version 62 prints its two kernel knob lines only on Linux and nothing on a Mac start, closes the guest door of a
 * workspace whose init died on its own by watching the init's pidfd and running the stop road, and stops redialling
 * a host that refused its place under a signature over the pinned key.
 * Version 63 counts the bytes a client buffers behind the WebSocket upgrade against the same pre-auth cap as the
 * bytes after it, so nothing rides the upgrade past the door unweighed.
 * Version 64 opens every path under a workspace's rootfs beneath it by descriptor with no link followed, covers the box
 * root's startup files with the workspace's own copies, lets a workspace read under /etc, /var and /srv only what an
 * allowlist names, and skips a linked row at the copy's exclude rather than removing outside the copy.
 * Version 65 fences the engine socket byte by byte: the client-to-engine copy is bounded to the framed body, a volume
 * names no box path, a volume attaches only to the workspace that made it, the bind allowlist lives where a workspace
 * cannot write and every source resolves beneath the rootfs, an engine container joins a per-workspace network, and
 * the daemon's and the engine's ports are closed at the gateway.
 * Version 66 makes every bind under a workspace's rootfs receive-only through a descriptor reopened after the bind,
 * so a workspace on a box boots again: versions 64 and 65 refused every create with EINVAL at the shared home's bind.
 * Version 67 gives a workspace's pty and exec on a box the recipe's knobs and a PATH with the prefix's bin ahead of
 * the home's, so a thread runs the tools the recipe put under the prefix rather than the old copies under the home.
 * Version 68 names, in a pane's create reply, the process its pid is, so a reader of the workspace's pty knows which
 * environment that pid carries; the pane's shell starts from the workspace's own environment as before.
 * Version 69 keeps the fence's connection to the engine open until the engine answers, so a forwarded request is
 * never cancelled into a bodiless 499, and lets a workspace on a box with a refusing input chain dial its own box.
 * Version 70 counts a workspace's sessions and connections at its socket and measures a frame before parsing it, so
 * one workspace cannot run its box daemon out of memory, and the leave removes its owned files by directory handle.
 * Version 72 drops a copied folder's worktree records before the copy's checkout, so a copy of a repo whose base
 * branch one of its own worktrees holds lands on that branch.
 * Version 73 answers fs.folders, one level of a box's folders or every repo on it, for a project added from a box.
 * Version 74 removes a directory clone by renaming it to a hidden sibling and removing that in a process of its own,
 * so a delete answers at once, sweeps any such sibling a stop cut short at start and on the next copy made or
 * removed beside that project, and refuses to remove a path that is not a copy of the project it names.
 * Version 75 takes back what a failed ssh add put on a box: before the add lands anything it asks which of its paths already exist, and after a failed deploy it removes only what this add wrote, stops a unit this add started, and leaves the box as it found it when another add took it meanwhile.
 * Version 76 answers as 75 does: a directory clone's removal takes the copy's own path off the shape check, and a test pins that a path with a trailing slash sets aside the link it names.
 * Version 77 forwards a guest's `wsp mcp` to the running host over the daemon's link, so a thread's MCP server needs no host process of its own on the machine.
 * Version 78 changes no behaviour: the pty broker's cases moved to a test binary of their own, and the file they left is hashed.
 * Version 79 changes no behaviour: every wire type in the protocol crate derives the TypeScript the protocol package re-exports, which moves the crate's sources and the lock. */
export const DAEMON_VERSION = DAEMON_CONTENTS.length;

/** sha256 of what a deploy installs on a guest and this record can hold: the Rust sources and manifests the binary
 * is built from, the lock that pins its dependencies, the C library the Linux builds link and its pinned release,
 * the contract fixtures its words and numbers are held to (the version itself left out of them, since it is this
 * record), the scripts the host writes beside it, DAEMON_ROOTS_PATH and the work-score line. The host's
 * daemon-content test recomputes it and fails when that content moved and this record did not, so changed content
 * cannot reach nobody: a start script gained a PATH line under an unchanged version once and every machine already
 * running kept the old one. Left out: every file under a crate's tests/ folder, which is built for a test run
 * and no deploy installs, so test-only work cuts no version for a binary nobody's machine would read as new; an
 * inline #[cfg(test)] module stays hashed, since the file carrying it ships. Left out too: the rest of this file,
 * which the binary reads only through the fixtures; hashing the protocol whole would turn every edit to it into a
 * redeploy of every machine. */
export const DAEMON_CONTENT_SHA = DAEMON_CONTENTS[DAEMON_CONTENTS.length - 1]!;

/** The file on the guest naming the imported project folders, one absolute path per line: the runtime writes it
 * when a project lands, the daemon reads it on every files and diff op and browses those folders beside its home.
 * The guest's home is /root, so this is rootsPathIn answered there; the value is hashed into DAEMON_CONTENT_SHA. */
export const DAEMON_ROOTS_PATH = rootsPathIn("/root");

/** The shape the records in a state file are written in. Any change to the schema of a stored record cuts this
 * number, so a host at the older number refuses the file instead of reading a record in a form it does not know:
 * several builds of wsp name one state file on a computer, and the one that wrote it last decides what is in it.
 * 2 since a project's seeded row changed whole: one word for what its memory did where it held two flags, the
 * memory folder's own file count beside it, and `bytes` now the sum the menu showed for the ticked files where it
 * was the size of the archive they travelled in, which is bigger, so the two numbers do not compare. */
export const STATE_SHAPE = 2;

/** What a save records about the wsp that wrote the file, apart from the records themselves: the shape those
 * records are in, the build that wrote them and when. A file with none was written before this record existed. */
export const StateShape = z.object({
  shape: z.number().int(),
  /** What the build calls itself: the version a released wsp prints, or the program's own name where it has none,
   * which is what a person would have to run again. */
  wsp: z.string(),
  /** The daemon that wsp deploys, which is the other half of what a build is. */
  daemon: z.number().int(),
  /** The binary it ran from, which is the one thing that says which of the builds on this computer wrote the file. */
  bin: z.string(),
  at: z.string(),
});
export type StateShape = z.infer<typeof StateShape>;

/** How a sentence names the build that wrote a state file. */
export const stateWriterWords = (wrote: StateShape): string => `${wrote.bin} (wsp ${wrote.wsp}, daemon ${wrote.daemon})`;

/** The version a hello announces, 1 when it carries none. */
export function daemonVersionOf(hello: { version?: number }): number {
  return hello.version ?? 1;
}

/** The one word a place's row says while this wsp deploys a newer daemon than that computer runs, and nothing
 * while it is level or ahead or has never reported. Both sides of the figure are already on the wire: the place
 * sends its own version in every report and this host's is the record above, so nothing is asked for it. Read by
 * `wsp places`, by the places table and by the doctor, so the three cannot word it three ways. */
export function placeDaemonBehind(place: { daemonVersion?: number }): string | undefined {
  const version = place.daemonVersion;
  return version === undefined || version >= DAEMON_VERSION ? undefined : `daemon ${version}, host ${DAEMON_VERSION}`;
}

/** The line that moves a place onto this wsp's daemon, which is the fix half of every sentence about a place that
 * is behind. */
export const placeUpdateLine = (name: string): string => `wsp add ${name} --update`;

/** What the doctor says about one place that is behind: the word above and the line that answers it. */
export const placeBehindLine = (name: string, word: string): string => `${name} is behind: ${word}; ${placeUpdateLine(name)} puts this wsp's daemon on it`;

/** The refusal an update gets on a place already running the daemon this wsp deploys. */
export const placeCurrentLine = (name: string, version: number): string => `${name} already runs daemon ${version}, which is the one this wsp deploys`;

/** What a computer whose recipe is still being put on says to whoever asked for a workspace there, or for a second
 * run of the job: the row under way where the job has reached one, and the two roads to the rest of the answer. */
export const placeProvisioningLine = (name: string, at?: { label: string; index: number; of: number }): string =>
  `${name} is still being set up${at === undefined ? "" : ` (${at.label}, ${at.index} of ${at.of})`}; wsp computers shows it, and a workspace there can be made once it is done`;

/** What a join or an update says when this computer holds no recipe to put on anything: nothing was installed, and
 * the two lines that write one and then put it on. */
export const placeNoRecipeLine = (name: string, path: string): string =>
  `${name} got no agents or tools: this computer has no recipe at ${path}. wsp recipe writes one; wsp add ${name} --update then puts it on ${name}`;

/** What a computer that reported no home folder for its login gets instead of the recipe: every path the job would
 * build comes off that home, so there is nothing to build one from. Said where the no-recipe line is said. */
export const placeNoHomeLine = (name: string): string =>
  `${name} got no agents or tools: it reported no home folder for its login, so nothing on it could be reached`;

/** The row's word for the recipe on a computer: what is under way, or what stands. Empty for a computer nothing
 * has provisioned, which is every provider and this computer itself. Read by wsp computers and by the app's row,
 * so the two cannot word it two ways. */
export function provisionWord(p: PlaceProvision | undefined): string {
  if (p === undefined) return "";
  if (p.state === "stopped") return `stopped: ${p.said ?? "no reason recorded"}`;
  if (p.state === "running") return p.at === undefined ? "setting up" : `setting up ${p.at.index}/${p.at.of}: ${p.at.label}`;
  const failed = p.rows.filter(r => r.outcome === "failed");
  // What the rows put there, not the word row: a row is the recipe's own word and nobody reading this screen has
  // seen a recipe.
  return failed.length === 0 ? `${provisionCountWord(provisionCounts(p.rows))} ready` : `${failed.length} of ${p.rows.length} failed: ${nameList(failed.map(r => r.label))}`;
}

/** The lines a terminal prints once a job is over: what installed by name, how many rows were already there, then
 * every row that failed or was set aside with its reason, and what stopped the job where one did. */
export function provisionLines(name: string, p: PlaceProvision): string[] {
  const of = (outcome: PlaceProvisionRow["outcome"]): PlaceProvisionRow[] => p.rows.filter(r => r.outcome === outcome);
  const installed = of("installed");
  const present = of("present");
  const tally = [
    installed.length === 0 ? "nothing installed" : `${installed.length} installed: ${nameList(installed.map(r => r.label))}`,
    ...(present.length > 0 ? [`${present.length} already there`] : []),
  ];
  return [
    `${name}: ${tally.join(", ")}`,
    ...of("failed").map(r => `  x ${r.label}: ${r.note ?? "no reason recorded"}`),
    ...of("skipped").map(r => `  - ${r.label}: ${r.note ?? "set aside"}`),
    ...(p.said === undefined ? [] : [`${name}: ${p.said}`]),
  ];
}

/** One line of the job's own log on a computer you own: the time it was written, in UTC to the second, then the
 * line. Every line that log takes carries one, so what each part of a run took is read off the computer's own log
 * afterwards rather than timed while it happens. */
export const provisionLogLine = (at: number, line: string): string => `${isoSeconds(at)} ${line}`;

/** What the round that lands the person's agent files packed on this computer: the paths the recipe planned, then
 * what the pack counted where it asked that computer first, the files already standing there at the same bytes and
 * the files the archive holds, and what that archive weighs. A pack that asked nothing says its bytes alone. */
export const provisionPackedLine = (paths: number, p: { bytes: number; files?: number; stood?: number }): string => {
  const counted = p.files === undefined || p.stood === undefined ? "" : `${plural(p.stood, "file")} ${p.stood === 1 ? "stands" : "stand"} there already, ${plural(p.files, "file")} packed, `;
  return `packed on this computer: ${plural(paths, "path")}, ${counted}${fmtBytes(p.bytes)}`;
};

/** What one part of that archive came to on the way over: the bytes it carried, and the pieces the road cut it
 * into where the bytes travel on one exec frame each, which is how a computer you own is reached. */
export const provisionShippedLine = (p: { part: number; parts: number; bytes: number; total: number; pieces?: number }): string => {
  const took = p.pieces === undefined ? "" : ` in ${plural(p.pieces, "piece")}`;
  return p.parts === 1 ? `shipped: ${fmtBytes(p.total)}${took}` : `shipped part ${p.part} of ${p.parts}: ${fmtBytesOfTotal(p.bytes, p.total)}${took}`;
};

/** What the run on that computer walked once the archive was there: every file of the person's copy, each read
 * against what stands at its path. */
export const provisionLandedLine = (files: number): string => `landed: ${plural(files, "file")} walked on that computer`;

/** What the list beside the job holds for the servers round: one key per server wsp wrote into an agent's own
 * file there. */
export const provisionListReadLine = (keys: number): string => `list read: ${plural(keys, "server key")}`;

/** What the pack left out of the copy for a computer you own, one line per path and reason, as the job says it. */
export const provisionSkippedLine = (path: string, note: string): string => `${path}: ${note}`;

/** What the servers round wrote into the agents' own files on that computer, of the servers the recipe names. */
export const provisionServersLine = (written: number, servers: number): string =>
  `servers merged: ${written} of ${plural(servers, "server")} written into the agents' own files`;

/** The refusal an update gets where this wsp holds no daemon built for the chip that computer said it is. */
export const placeNoChipLine = (name: string, platform: string, arch: string): string =>
  `${name} says it is ${platform} ${arch}, and this wsp carries no daemon built for it`;

export const DaemonEvent = z.discriminatedUnion("type", [
  /** The first frame after the auth reply: root is the
   * absolute directory every fs.* and git.* path must resolve inside, so a
   * client can build absolute paths for pickers, pins and session starts.
   * version is DAEMON_VERSION as the daemon was built; absent on version 1. */
  z.object({ type: z.literal("daemon.hello"), root: z.string(), version: z.number().int().optional() }),
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.exit"),
    ptyId: z.string(),
    exitCode: z.number(),
    signal: z.number().optional(),
  }),
  /** loopback: bound to 127.0.0.1 or ::1 only, so the preview edge (which dials eth0) cannot reach it. */
  z.object({
    type: z.literal("port.open"),
    port: z.number(),
    pid: z.number().optional(),
    process: z.string().optional(),
    loopback: z.boolean().optional(),
  }),
  z.object({ type: z.literal("port.close"), port: z.number(), ...portCloseDetail }),
  z.object({ type: z.literal("inbox.file"), path: z.string(), bytes: z.number() }),
  /** Broadcast on pty.attach (current state) and afterwards only on change.
   * mode mirrors the slave termios ICANON bit ("line" when set), echo mirrors
   * ECHO; foreground is the comm of the foreground process group leader, ""
   * when unreadable. There is no request op: clients only listen. */
  z.object({
    type: z.literal("pty.mode"),
    ptyId: z.string(),
    mode: z.enum(["line", "raw"]),
    echo: z.boolean(),
    foreground: z.string(),
  }),
  /** A guest tool asked for a browser (through the BROWSER or xdg-open shim).
   * Pushed to every authed socket; clients show it and open it on a click.
   * http(s) only: the machine is the untrusted side. port is the localhost
   * port in the URL's redirect_uri when it carries one. */
  z.object({ type: z.literal("browser.open"), url: z.string().refine(isHttpUrl, "http or https URL"), port: RelayPort.optional() }),
  /** A loopback listener appeared around a browser.open whose URL named no
   * port: the flow's callback, for the host to forward. */
  z.object({ type: z.literal("callback.port"), port: RelayPort }),
  z.object({ type: z.literal("tunnel.data"), tunnelId: z.string(), data: z.string() }),
  /** The guest side closed; the laptop connection ends after any data before it. */
  z.object({ type: z.literal("tunnel.end"), tunnelId: z.string() }),
  /** A pty printed, or a tool asked to open, a plain http URL on a local host
   * with an explicit port (http://localhost:8123/, 127.0.0.1:8123): the port a
   * person would click. Only the port travels; the host forwards it here. */
  z.object({ type: z.literal("localhost.url"), port: RelayPort }),
  SysSample,
  ProcSnapshot,
  /** A process inside the machine opened a guest session. Pushed to the socket that sent guest.watch alone, never
   * broadcast: the host is the only reader of the token it carries. */
  z.object({
    type: z.literal("guest.opened"),
    session: z.string(),
    /** The run of the machine's daemon that named this session. Session names count from the start on every run,
     * so a machine rebuilt under this host hands it a name it may still hold; this and the name together are what
     * a session already open here is told from a new one of the same name. */
    life: z.string(),
    kind: GuestKind,
    token: z.string(),
    turnToken: z.string().optional(),
    argv: z.array(z.string()),
    cwd: z.string(),
    /** The workspace the session was opened inside, on a daemon that runs workspaces: the listener the session
     * arrived on is what names it, never anything the guest said, so a session of one workspace can never read as
     * another's. Absent on a daemon inside a machine, where the machine is the one this host dialled. */
    machineId: z.string().optional(),
  }),
  /** One message on a session, travelling either way: a guest's up to the watcher, the host's answer back down.
   * The workspace is the opened frame's, as on every frame a place daemon relays for a session. */
  z.object({ type: z.literal("guest.message"), session: z.string(), message: z.unknown(), machineId: z.string().optional() }),
  /** The session ended; this reaches whichever side did not end it. */
  z.object({ type: z.literal("guest.closed"), session: z.string(), error: z.string().optional(), machineId: z.string().optional() }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// --- runtime wire protocol (serveRuntime) ------------------------------------

/** What a single-use ticket opens the next socket for: `connect`, another client of the person's own, or `relay`,
 * the road a machine's requests reach this host by. The purpose is what a socket's origin is read off, so a relayed
 * socket is one this host minted a relay ticket for and nothing a client says on the wire can make one. */
export const TicketPurpose = z.enum(["connect", "relay"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

/** Where a socket redeeming a ticket of each purpose reached the host from, named for every purpose there is. The
 * host stamps this over whatever the client's own frames say, so a purpose that names none would be a socket whose
 * origin its holder decides: the door refuses one rather than falling back to the wire, and a purpose added later
 * has to say what it is here before any socket may redeem it. */
export const TICKET_ORIGIN: Record<TicketPurpose, WorkspaceOrigin> = { connect: "here", relay: "relayed" };

/** How a device this host admitted through the account got in: the computer it is on the relay, the key it proved
 * and the key that signed its admission. The public key is kept because a device admitted here may itself sign the
 * admission of the next one, and the fingerprint because a revoke is remembered by the key rather than by the id a
 * relay mints afresh at every sign-in. Nothing secret: a public key and two fingerprints. */
export const DeviceVia = z.object({
  kind: z.literal("account"),
  /** The id that device has on the relay, which is what a listing of the account's computers names it by. */
  relayDeviceId: z.string(),
  fingerprint: z.string(),
  publicKey: z.string(),
  /** The fingerprint of the key whose admission let it in. */
  admittedBy: z.string(),
});
export type DeviceVia = z.infer<typeof DeviceVia>;

/** A computer that redeemed a pairing code and holds a token of its own, as devices.list answers and wsp host devices
 * prints it. The token is never here: the host keeps only its hash, so a listing can leak nothing that opens a
 * socket. */
export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** When this device last authed. Set by the redeem that minted it and moved by every later auth frame, never by
   * a JSON route reading the same token, so a listing says when the computer last dialled rather than last asked. */
  lastSeenAt: z.string(),
  /** What this device may do, when it is not a computer of the person's: a token the host minted into one turn's
   * environment, which drives only the tree that turn's thread is in. Absent is a paired computer, which drives
   * everything this host holds. */
  scope: ThreadScope.optional(),
  /** Set on the browser wsp init opened on the computer the host runs on: its code was minted by init itself, so
   * the device is read as the owner on the socket and the JSON routes alike, and is still listed and revoked like
   * every other. Absent is a computer or a browser that took a code from wsp host pair. */
  here: z.literal(true).optional(),
  /** How this device got in, where it did not redeem a pairing code: the account both computers are signed in to.
   * Absent is a code, so one record, one listing and one revoke answer for both roads. */
  via: DeviceVia.optional(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** How long a pairing code stands before the host forgets it: long enough to read off one screen and type into
 * another, short enough that a code left in a terminal buffer is worth nothing by the time anyone reads it. */
export const PAIR_CODE_TTL_MS = 10 * 60_000;

/** How many characters a pairing code is, out of the 32 the alphabet holds: 40 bits, single use and ten minutes
 * long, which no reachable host answers enough guesses of. */
export const PAIR_CODE_LENGTH = 8;

/** A pairing code as every screen shows it: the alphabet's letters in two halves, which is how a person reads one
 * across a room. The one grouping, so the sheet that shows a code and the field that takes one agree. */
export function shownPairCode(code: string): string {
  const letters = code.replace(/-/g, "").toUpperCase().slice(0, PAIR_CODE_LENGTH);
  const half = Math.ceil(PAIR_CODE_LENGTH / 2);
  return letters.length <= half ? letters : `${letters.slice(0, half)}-${letters.slice(half)}`;
}


/** A pairing code as the host takes it, whichever screen it was copied off: the letters alone, upper case. A
 * person copies the code they can read, so the dash the screens put in it is one this reading takes back out. */
export const sentPairCode = (shown: string): string => shown.replace(/-/g, "").toUpperCase();

/** The symbols a pairing code is written in: the digits and the letters, less the four that a person reading one
 * screen and typing into another confuses (I, L, O, U). Thirty-two of them, so each character is five bits and a
 * random byte masked to five bits is uniform. */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** What this wsp knows about the account it is on, read off this computer's own records alone: the relay is never
 * asked for it, so the row draws at once and draws the same whether or not the relay is up. Signed in is a record
 * on disk; the name beside it is the one the relay gave when the sign-in was approved, which a relay that names
 * none leaves absent, and then the state word alone is the answer. */
export const AccountView = z.object({
  signedIn: z.boolean(),
  login: z.string().optional(),
});
export type AccountView = z.infer<typeof AccountView>;

/** The refusal a socket let in on a ticket gets for reading the account: who this wsp is signed in to is read at
 * the terminal of the computer it runs on, as the devices and the places are. */
export const ACCOUNT_TICKET_REFUSAL = "a socket let in on a ticket cannot see the account this host is signed in to; run wsp login on the computer the host runs on";

/** The relay wsp signs in to when a person names none: the one this project runs, opt in as every account road is,
 * and the only address the lines carry by default. Another relay is named on the line that signs in. */
export const DEFAULT_RELAY = "https://relay.singhi.me";

/** What one computer already on the account signs for another: the key it admits, its own key, and the moment.
 * The relay stores these bytes and can make none of them, since it holds no device's private key; every host
 * verifies the signature itself against the keys it already trusts. `issuedAt` travels and is stored as the
 * string it was signed with, byte for byte, since the transcript is built from that spelling. */
export const Admission = z.object({
  device: z.string(),
  by: z.string(),
  issuedAt: z.string(),
  signature: z.string(),
});
export type Admission = z.infer<typeof Admission>;

/** One computer on the account as a host reads it off its heartbeat's reply: which key it proves and which
 * admissions were signed for it. The signature rides along; the fingerprints alone would prove nothing. */
export const AccountDevice = z.object({
  id: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  admissions: z.array(Admission.omit({ device: true })),
});
export type AccountDevice = z.infer<typeof AccountDevice>;

/** What the account's devices are as the last heartbeat listed them, and nothing when this host has heard no list
 * at all: an absent list is unknown and never empty, so a relay that is down, one that answers an older shape and
 * a beat that was refused admit nobody new and revoke nobody. */
export const AccountDevices = z.object({ devices: z.array(AccountDevice) });

/** What a device signs to prove it may come in through the account: the key admitted, the key that signed for it
 * and the moment, built by one function so the wsp that signs and the host that verifies cannot drift. The host
 * is not inside it: one admission stands at every host on the account whose trust the signer already has, which
 * is what saves a person a code per host. */
export function deviceAdmissionTranscript(device: string, by: string, issuedAt: string): Uint8Array {
  return new TextEncoder().encode(`wsp device admission v1\n${device}\n${by}\n${issuedAt}\n`);
}

/** The refusal a device.auth gets that this host will not admit: a key the account's listing does not hold, an
 * admission signed by nobody it trusts, or a signature that does not stand. One sentence for all of them, since a
 * caller that cannot come in learns nothing from which check caught it, and it names the road in: a computer
 * already on the account signs this one's key. */
export const DEVICE_AUTH_REFUSAL =
  "this host admits a computer on the account only on an admission signed by a key it already trusts; run wsp login to read this computer's id on a computer that is already in, then wsp login <id> there, and dial again";

/** The refusal a device this host revoked gets when it dials again through the account: the key is remembered, so
 * an admission it still holds admits it nowhere here. A code from the host's own terminal is the way back. */
export const DEVICE_REVOKED_REFUSAL = "this host took this computer's token away; it is admitted through the account no longer, and wsp host pair on the host is the way back in";

/** The refusal a device.auth gets from a host that is on no account: nothing there names the keys it would trust,
 * so pairing with a code is the whole road to it. */
export const DEVICE_ACCOUNT_UNSERVED = "this host is on no account, so it admits no computer through one; run wsp host link on the computer it runs on to put it on yours";

/** What a computer reads when the host it dialled answered device.auth with its own request schema's refusal: a
 * host of an older wsp, whose door knows no road in for a computer on the account. Told apart from a refusal of this build by
 * the kind on the frame, which an older host's schema refusal carries none of, so a token this computer never sent
 * is never read as one that was taken away. */
export const deviceAuthOldHostLine = (where: string): string =>
  `the host at ${where} runs an older wsp, whose door does not know how a computer on the account comes in; update wsp on that computer and run wsp up there again`;

/** The refusal wsp login gives a word that carries no key: every word wsp login prints carries the fingerprint of
 * the key being admitted, so a word without one was written by hand or cut in half, and nothing is posted. */
export const LOGIN_NO_KEY_REFUSAL = "that word names no key for the computer signing in, so nothing here could say which key it would be admitting; run wsp login there again and copy the whole word it prints";

/** The refusal for a host that keeps no records of its own to read an account from, which a bare runtime does not. */
export const ACCOUNT_UNSERVED = "this host keeps no account records; wsp up serves them";

/** The refusal a socket that is not the host's own gets for asking to mint a pairing code: a code lets a stranger
 * in, so only the process holding the host token, on this computer, may hand one out. */
export const PAIR_ISSUE_REFUSAL = "only a socket holding this host's own token may mint a pairing code; run wsp host pair on the computer the host runs on";

/** The refusal a redeemed code that this host is not holding gets: spent, expired, or never minted read the same,
 * so guessing tells a caller nothing about which. */
export const PAIR_CODE_REFUSAL = "that pairing code is not one this host is waiting for; run wsp host pair on the host for a fresh one";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the device ops, whether the ticket
 * was the road a machine's requests arrive by or another client's. Who may drive this host is handed out at the
 * terminal of the computer it runs on, and read and taken away there or from a computer paired with it. */
export const DEVICES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the devices paired with this host; run wsp host devices on the computer the host runs on";

/** The refusal the JSON routes answer with when a request carries no token this host takes: reaching the port,
 * the loopback one included, names nobody, since another login on the same computer reaches it too. */
export const API_UNAUTHORIZED = "this route needs a token in an Authorization header, the host's own from the token file beside its state or a paired device's; run wsp host pair on the computer the host runs on for one";

/** The refusal a write route and a browser's upgrade answer with when the page that sent them was loaded at
 * another name than the one this host was reached at. A page may only drive the host it was served by, and the
 * hostname is the whole of the reading: a page on the app's port dialling the runtime's is the same page. */
export function crossOriginRefusal(origin: string, host: string): string {
  return `this request came from ${origin} and this host was reached at ${host}; the page and its socket open from the address the host answers at`;
}

/** A frame the page sends a daemon through the host: the daemon's own op and params, no id. The host numbers
 * frames on its socket to the daemon and hands the daemon's answer back under the request that carried the frame,
 * so a page's ids never reach a machine. auth is refused: the host sent the auth frame when it opened the channel. */
export const DaemonFrame = z.object({ op: z.string().refine(op => op !== "auth", "the host authenticates the channel") }).passthrough();
export type DaemonFrame = z.infer<typeof DaemonFrame>;

export const DaemonOpenReply = z.object({ channel: z.string() });
export type DaemonOpenReply = z.infer<typeof DaemonOpenReply>;
/** The daemon's reply as it sent it; id is the host's number on its own socket and means nothing to the page. */
export const DaemonSendReply = z.object({ reply: DaemonResponse });
export type DaemonSendReply = z.infer<typeof DaemonSendReply>;

/** What the host pushes to the one socket that opened a channel. Never on the event bus, never sequenced, never
 * replayed: a pty chunk is not history. event is the daemon's frame untouched; the page validates it against
 * DaemonEvent as it always did, since a daemon of another version may push a type this host does not know and
 * the host acts on none of them. daemon.closed says the daemon socket ended without the page asking: code and
 * reason are the WebSocket close the host saw, 4401 with the daemon's sentence when it refused the token. */
export const DaemonChannelEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.event"), channel: z.string(), event: z.object({ type: z.string() }).passthrough() }),
  z.object({ type: z.literal("daemon.closed"), channel: z.string(), code: z.number().int(), reason: z.string() }),
]);
export type DaemonChannelEvent = z.infer<typeof DaemonChannelEvent>;

/** What the host pushes to the one socket that opened a guest session on it: the session's messages, then its end,
 * with the host's sentence when it ended the session for a reason. The same two frames a machine's daemon hands its
 * guest, less the session id a socket holding one session has no use for, so one client reads both roads. */
export const HereGuestEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("guest.message"), message: z.unknown() }),
  z.object({ type: z.literal("guest.closed"), error: z.string().optional() }),
]);
export type HereGuestEvent = z.infer<typeof HereGuestEvent>;

// --- places: a computer you own, joined by dialling this host ---------------

/** How many bytes each side's challenge is. Thirty-two: a nonce is what keeps a signature from being replayed, and
 * a birthday collision on it has to be out of reach for the life of a key, not for the life of one link. */
export const PLACE_LINK_NONCE_BYTES = 32;

/** The decoded byte length of a base64 string, worked out from the string itself: this package is bundled into the
 * browser, so nothing here decodes through Buffer. */
function base64Bytes(text: string): number {
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - pad;
}

/** How long the base64 of so many bytes is, its padding counted: what bytes cost on a road that carries them as
 * text, read by the schemas below and by whoever bounds a frame by what its bytes take to cross. */
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

const base64 = (bytes: number) =>
  z
    .string()
    .max(base64Length(bytes))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine(text => text.length % 4 === 0 && base64Bytes(text) === bytes, `must be ${bytes} bytes, base64`);

export const PlaceNonce = base64(PLACE_LINK_NONCE_BYTES);
/** An ed25519 public key as SPKI DER, base64: 44 bytes. */
export const PlacePublicKey = base64(44);
/** An ed25519 signature, base64: 64 bytes. */
export const PlaceSignature = base64(64);
/** An X25519 public key as its raw 32 bytes, base64: what each end of a link sends to agree the key every frame
 * after the handshake is sealed under. Fresh per attempt and never held past the socket. */
export const PlaceEphemeral = base64(32);

/** The engine a project's own containers would run on: Docker first, then podman, else none. The one rule both
 * the host's own-machine report and the node agent's read off their own PATH check. */
export type PlaceEngine = "none" | "docker" | "podman";
export const engineWord = (hasDocker: boolean, hasPodman: boolean): PlaceEngine => (hasDocker ? "docker" : hasPodman ? "podman" : "none");

/** How many agents one computer may report: the list and the version map keyed by it are held to one number, and
 * the daemon's own deserialiser holds them to the same one. */
const AGENTS_REPORTED_MAX = 32;

/** What a place says about itself on every link, and once at join. Read by the host into the place record and the
 * workspace recorded on it; nothing here is trusted for paths until isPlainPath has read it. */
export const PlaceReport = z.object({
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "linux"]),
  arch: z.string().max(32),
  os: z.string().max(200),
  shape: WorkspaceSize,
  diskFreeBytes: z.number().int().nonnegative().optional(),
  /** HOME, USER, PATH and each harness's store variable, as the ssh read records them. */
  login: z.record(z.string()),
  /** Whether this computer's own daemon runs workspaces here: cgroup v2 with the controllers a cap needs, an
   * overlay, and root. What decides whether the place forks at all, where the docker field once did. */
  runsWorkspaces: z.boolean(),
  /** When it does not, the one kernel reason, in the daemon's own words. */
  workspacesBlocked: z.string().optional(),
  /** The engine a project's own containers would run on here; "none" until the person installs one. */
  engine: z.enum(["none", "docker", "podman"]),
  /** How this computer makes a workspace's copy of a checkout. Absent where the computer runs no workspaces. */
  copies: CopyWord.optional(),
  /** How long that computer had been up when it wrote this report. Kept on the record so a row can say what the
   * computer last was rather than nothing while it is not answering. */
  uptimeMs: z.number().int().nonnegative().optional(),
  daemonVersion: z.number().int().nonnegative(),
  /** The loopback port the place's own daemon bound, for the forward the panes ride. */
  daemonPort: z.number().int().min(1).max(65535).optional(),
  /** The line that runs wsp on this place, word by word, for the tools a turn's agent is given later. */
  wsp: z.array(z.string()).min(1),
  /** The catalog ids of the agents found on that computer's own login PATH, for the line the person reads as it
   * joins. Capped because it lands in a sentence, not in a list a person scrolls. */
  agents: z.array(z.string().max(32)).max(AGENTS_REPORTED_MAX),
  /** What each of those agents answered its own version flag with, by the same catalog id: the first line of
   * `<bin> --version`, as the computer said it. Absent on a computer whose agents have not been read yet. Under
   * the same cap as the list it is keyed by, since zod counts an object's keys nowhere else. */
  agentVersions: z
    .record(z.string().max(64))
    .refine(said => Object.keys(said).length <= AGENTS_REPORTED_MAX, `at most ${AGENTS_REPORTED_MAX} agents`)
    .optional(),
  /** The files under that computer's logins directory, each named under it: what a sign-in there wrote and every
   * workspace on it shares. Absent from a report a daemon older than this field sent, which is unknown and not
   * none; a name that walks out of that folder is refused, since the host joins it onto a folder of its own. */
  logins: z.array(z.string().max(200).refine(isUnderPath, "a name under a folder")).max(64).optional(),
  /** Which of the host's addresses this link reached; the address a turn on the place is told to dial back. */
  dialed: z.string().refine(isHttpUrl, "http or https URL"),
});
export type PlaceReport = z.infer<typeof PlaceReport>;

/** The first frame of a joining place: the key it will prove and the two public values that agree the seal.
 * Nothing of the person's rides it, since nothing has proved who is on the other end yet: the code it spends and
 * the report it carries go in the prove, inside the seal. Answered with PlaceJoinReply; the socket then continues
 * with place.prove as an auth would. */
export const PlaceJoinRequest = z.object({
  id: reqId,
  op: z.literal("place.join"),
  publicKey: PlacePublicKey,
  nonce: PlaceNonce,
  /** Absent from a computer running a wsp older than the seal, which the host refuses in its own sentence rather
   * than reading a frame it cannot answer. */
  ephemeral: PlaceEphemeral.optional(),
});
export type PlaceJoinRequest = z.infer<typeof PlaceJoinRequest>;
export const PlaceJoinReply = z.object({
  placeId: z.string(),
  hostPublicKey: PlacePublicKey,
  nonce: PlaceNonce,
  signature: PlaceSignature,
  ephemeral: PlaceEphemeral,
  /** What the primary computer calls itself, which is what the joined computer shows a person from then on. */
  hostName: z.string().min(1).max(200),
});
export type PlaceJoinReply = z.infer<typeof PlaceJoinReply>;

/** The token a join's own window was given, on the reply to its prove: the one thing of the person's a join
 * takes back, and it rides inside the seal now that the reply to frame one no longer carries it. */
export const PlaceJoinDevice = z.object({ deviceId: z.string(), deviceToken: z.string().min(1) });
export type PlaceJoinDevice = z.infer<typeof PlaceJoinDevice>;

/** The first frame of a place that already joined: names itself and challenges the host. */
export const PlaceAuthRequest = z.object({ id: reqId, op: z.literal("place.auth"), placeId: z.string().max(64), nonce: PlaceNonce, ephemeral: PlaceEphemeral.optional() });
export type PlaceAuthRequest = z.infer<typeof PlaceAuthRequest>;
export const PlaceAuthReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature, ephemeral: PlaceEphemeral });
export type PlaceAuthReply = z.infer<typeof PlaceAuthReply>;

/** What a host puts on its refusal of that frame when it holds no place by the id it named: its own key and a
 * signature over the refusal transcript. A place verifies it against the key it pinned at join and takes the long
 * wait on it, since nothing changes until a person acts; a refusal carrying neither, or one the pinned key did not
 * make, is a frame anybody who answers at the address can send and costs that computer no wait of its own. */
export const PlaceAuthRefusal = z.object({ hostPublicKey: PlacePublicKey, signature: PlaceSignature });
export type PlaceAuthRefusal = z.infer<typeof PlaceAuthRefusal>;

/** The second frame, and the first one sealed: the place's answer to the host's nonce and its report as it stands
 * now. A join's prove carries the code it spends and the window it wants too, which is where they cross now that
 * the host has proved itself and nothing of the person's may travel before it. After this the socket is the place
 * link and carries daemon frames only. */
export const PlaceProveRequest = z.object({
  id: reqId,
  op: z.literal("place.prove"),
  signature: PlaceSignature,
  report: PlaceReport,
  /** A join's own: the code this computer spends, and the window it also wants a token for. Absent on a relink,
   * which spends nothing, and on a join typed in a terminal, which wants no window. */
  code: z.string().max(64).optional(),
  client: z.object({ name: z.string().min(1).max(200) }).optional(),
});
export type PlaceProveRequest = z.infer<typeof PlaceProveRequest>;

/** What both sides sign, built by one function so they cannot drift: the role of the signer, the place id, the two
 * nonces and the two ephemerals, the challenged party's first in each pair. The host signs the transcript the
 * place challenged it with and the place signs the host's, so neither side's signature can be replayed back at it
 * as the other's; the ephemerals are inside it, so the key the two ends agree is one both signatures cover and a
 * carrier that swapped either of them has signed nothing. */
export function placeLinkTranscript(role: "host" | "place", placeId: string, challenge: string, answer: string, ephemerals: { challenger: string; answerer: string }): Uint8Array {
  return new TextEncoder().encode(`wsp place link v2\n${role}\n${placeId}\n${challenge}\n${answer}\n${ephemerals.challenger}\n${ephemerals.answerer}\n`);
}

/** What a host signs to refuse a place at its first frame, built by one function so the two sides cannot drift:
 * the place id it named, the nonce it challenged with and the sentence it is refused by. The nonce is inside, so
 * one dial's refusal cannot be replayed at the next; the sentence is inside, so it cannot be bent to another. */
export function placeRefusalTranscript(placeId: string, placeNonce: string, sentence: string): Uint8Array {
  return new TextEncoder().encode(`wsp place refusal v1\n${placeId}\n${placeNonce}\n${sentence}\n`);
}

/** What stands where a place id stands for a client's seal: a client is no place and holds no record here, so the
 * word is the same on both ends and rides the transcript and the key derivation exactly as a place id does. */
export const SEAL_CLIENT = "client";

/** The first frame of a client that holds the fingerprint of this host's key: its nonce and its half of the key
 * agreement, before the code or the token it came to send. Answered with SealOpenReply, after which every frame
 * this socket carries either way is sealed under the key both ends agreed. */
export const SealOpenRequest = z.object({ id: reqId, op: z.literal("seal.open"), nonce: PlaceNonce, ephemeral: PlaceEphemeral });
export type SealOpenRequest = z.infer<typeof SealOpenRequest>;

/** The host's answer: the key it proves, its nonce, its half of the agreement and its signature over the same
 * transcript a place challenges it with, the client's word in the place id's slot. The client refuses before it
 * sends anything of the person's unless the fingerprint is the one it pinned and the signature stands. */
export const SealOpenReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature, ephemeral: PlaceEphemeral });
export type SealOpenReply = z.infer<typeof SealOpenReply>;

/** The first frame of a computer coming in through the account, inside the seal the frame above agreed: the key it
 * proves, what to call it in the listing, and its signature over the bytes the host challenged it with, which are
 * the same bytes a joined computer signs at place.prove. Answered with `{ deviceId, deviceToken }`, as a redeem is,
 * and the socket is that device from then on. */
export const DeviceAuthRequest = z.object({
  id: reqId,
  op: z.literal("device.auth"),
  publicKey: PlacePublicKey,
  name: z.string().min(1).max(200),
  signature: PlaceSignature,
});
export type DeviceAuthRequest = z.infer<typeof DeviceAuthRequest>;

/** The refusal a client gets from a host that holds no key of its own to prove: a runtime served without the
 * place wiring, which is a runtime in a test rather than any host a person starts. */
export const SEAL_UNSERVED = "this host holds no key to prove itself with; the host that serves the app wires one";

/** What separates the two halves of the one token a join line carries. Neither half can hold it: a code is
 * written in PAIR_CODE_ALPHABET with the dash the screens group it with, and a fingerprint is base64. */
export const JOIN_TOKEN_MARK = ".";

/** The one word a person copies off a join line: the single-use code and the fingerprint of the key the host will
 * prove, as one string, so a join stays two things to copy and the screens keep the fields they have. */
export const joinToken = (code: string, hostKey: string): string => `${shownPairCode(code)}${JOIN_TOKEN_MARK}${hostKey}`;

/** The same token read back on the computer being joined, whichever road it came by: a person's paste, the flag,
 * or the file an install over ssh landed. The code is taken as any screen's code is taken; the fingerprint is left
 * exactly as it was written, since its own alphabet is case sensitive. A token that carries no fingerprint answers
 * none, and the caller refuses rather than dialling. */
export function readJoinToken(typed: string): { code: string; hostKey?: string } {
  const trimmed = typed.trim();
  const at = trimmed.indexOf(JOIN_TOKEN_MARK);
  if (at === -1) return { code: sentPairCode(trimmed) };
  const hostKey = trimmed.slice(at + 1).trim();
  const code = sentPairCode(trimmed.slice(0, at));
  return hostKey === "" ? { code } : { code, hostKey };
}

/** The refusal a join gets for a line that named no key: every line wsp add prints carries one, so a line without
 * one was written by hand or cut in half on its way over. Nothing is dialled. */
export const JOIN_NO_KEY_REFUSAL = "that join line names no key for the host, so this computer cannot tell which host it is joining; run wsp add on the host again and copy the whole code it prints";

/** The refusal a join gets when the host at that address proved a key that is not the one the join line named:
 * something answered where the host was expected. Nothing of this computer's went to it. */
export const joinKeyRefusal = (url: string): string => `the host at ${url} proved a key the join line did not name, so it is not the host that printed that line; nothing was sent to it`;

/** The one word a person copies off wsp host pair, which is the join line's token under the name the pairing road
 * reads it by: the code and the fingerprint of the key the host will prove, so a client pins that key before it
 * spends the code. `readJoinToken` reads both roads' tokens, since they are one shape. */
export const pairToken = joinToken;

/** The refusal a dial gets when whatever answered at that address did not prove the key this computer holds that
 * host to, whether it proved another one or signed nothing this computer could verify: it is not that host,
 * whichever check caught it, and no token of this computer's went to it. */
export const pairKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer holds for it, so it is not that host; nothing was sent to it`;

/** The refusal a line gets for aiming at a host it holds no key for: a record somebody edited by hand, or a turn
 * launched by a host older than this one. `where` names which. */
export const hostNoKeyLine = (where: string): string =>
  `${where} names a host and no key for it, so this computer cannot tell which host it would be sending its token to; run wsp hosts to read the account's hosts again`;

/** What `hostNoKeyLine` names when the aim came out of the environment a turn was launched with rather than out of
 * a record a person named. */
export const LAUNCHED_WITH = "the launch this turn started with";

/** The refusal a join whose code this host is not holding gets. Spent, expired and never minted read the same, so
 * guessing tells a caller nothing about which; the words differ from a pairing code's only in naming the verb that
 * mints this one, since a person joining a computer never typed wsp host pair. */
export const PLACE_CODE_REFUSAL = "that join code is not one this host is waiting for; run wsp add on the host for a fresh one";

/** The refusal for a word two computers on this host answer to: ids tell them apart, and the person picks one.
 * `typed` is the word that was written, since more than one word names a computer and each says its own back. A
 * relink cannot take another computer's name, so two by one name are two a person joined under one word, and
 * every road that resolves a word reads this one sentence. */
export const twoPlacesRefusal = (typed: string, ids: readonly string[]): string =>
  `${typed}: this host holds ${ids.length} places by that name; name one by its id (${ids.join(", ")}).`;

/** The refusal a join from a computer whose wsp seals no link gets: every frame of a link after the handshake
 * travels inside a key the two ends agree, and a computer that cannot agree one would send its code and its
 * report where the carrier reads them. */
export const PLACE_UNSEALED_JOIN_REFUSAL = "that computer's wsp is older than this host and seals no link; update wsp there and join again";

/** The refusal a place gets for proving itself with a key the host does not hold for it. A key that moved is a
 * computer re-joined somewhere else or a place file copied off it, and neither is this place. */
export const PLACE_KEY_REFUSAL = "that place's key does not match the one this host learned at join; wsp remove it here and join it again";

/** The refusal a place that names an id this host holds none of gets: removed here, or a state file that is not
 * the one it joined. */
export const PLACE_UNKNOWN_REFUSAL = "this host holds no place by that id; join it with a code from wsp add";

/** The refusal a joining computer prints when the host at that address could not prove the key this computer
 * learned at join, so nothing of this computer's went to it. */
export const hostKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer learned at join; nothing was sent to it`;

/** What a remove says about a place that was not linked when it ran: the records here are gone and the agent on
 * that computer is not, since nothing could reach it to sweep. */
export const placeStillInstalledLine = (name: string): string => `${name} is off this host, but the agent on it is still installed; run ${PLACE_LEAVE_LINE} on that computer when it is back`;


/** What a place that is connected but has never said which port its daemon bound is refused with: a pane needs
 * that port to carry to, and only that computer knows it. */
export const placeNoDaemonPortLine = (name: string): string => `${name} is connected but has not said which port its daemon is on, so nothing can carry a pane to it yet; it says so on its next link`;

/** What an install is refused with when the computer took the agent and never dialled back: the join landed, so
 * the computer belongs to this wsp, and what is missing is a road from it to here. */
export const placeNoLinkLine = (name: string): string => `${name} took the agent and has not dialled this host yet; check that it can reach this computer on the address it was given, and wsp places shows it the moment it does`;

/** What a stage reads while the computer it is running on has no link: the requests behind it are held until that
 * computer opens a socket again, and a stage with no line of its own reads as one that stopped. */
export const placeDialBackLine = (name: string): string => `waiting for ${name} to dial back`;

/** Why a build on a joined computer stopped when that computer's link went and it never dialled back in time. */
export const placeWentAwayLine = (name: string): string => `${name} went away before the build finished`;

/** The refusal wsp add over ssh gets on a host that wired no installer: the road that puts the agent on a computer
 * is the host command's, so a runtime served without one holds no way onto a machine it has never met. */
export const NO_PLACE_INSTALLER = "this host cannot install the agent on a computer over ssh; run wsp add with no argument for the line to type on that computer";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the place ops: which computers a
 * person's wsp runs on, and taking one back out, is handed out and taken away at the terminal of the computer the
 * host runs on and nowhere else. */
export const PLACES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the places this host holds; run wsp places on the computer the host runs on";

/** The refusal for a daemon channel that named both a workspace and a computer, or neither: a channel is one
 * daemon's, and which one is the caller's to say. */
export const DAEMON_OPEN_ONE_OF = "daemon.open opens a channel to one daemon: name the workspace or the place, not both";

/** Where a computer you own dials this wsp: the port the door answers on and every address it can be reached at.
 * A host that already binds beyond this computer answers its own port and opens nothing. */
export const PlaceDoorView = z.object({
  port: z.number().int().min(1).max(65535),
  /** `http://<address>:<port>` for every address this computer answers on that leaves it, loopback left out. */
  addresses: z.array(z.string().url()).min(1),
  /** The fingerprint of the key this host proves at a join, for the token the join line carries: what tells the
   * computer being joined that the host answering at one of those addresses is the one that printed the line. */
  hostKey: z.string().min(1).max(200),
  /** The relay hostname as an https address, when the host is linked to a relay. */
  relay: z.string().url().optional(),
});
export type PlaceDoorView = z.infer<typeof PlaceDoorView>;

/** One line a computer you own joins this host by, as joinRoads writes it: the address it dials, the whole command
 * typed there, and the note for the relay's address, which answers only while the host is linked. */
export const JoinRoad = z.object({ url: z.string().url(), line: z.string().min(1), note: z.string().optional() });
export type JoinRoad = z.infer<typeof JoinRoad>;

/** What places.mint answers: a fresh code, written into every line this host can be joined by, and when it stops
 * working. The code is the one wsp add prints, off the same mint and the same expiry. */
export const JoinMint = z.object({ joins: z.array(JoinRoad).min(1), expiresAt: z.string().datetime() });
export type JoinMint = z.infer<typeof JoinMint>;

/** A computer the person's own ssh already knows, offered where a computer is added over ssh: a Host block of their
 * ssh config, or a name their known_hosts holds. Only host, hostname, user and port words are taken from what those
 * files name, so a key file an Include reaches yields nothing. */
export const SshHostSuggestion = z.object({
  alias: z.string().min(1).max(300),
  hostName: z.string().max(300).optional(),
  user: z.string().max(300).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  from: z.enum(["config", "known_hosts"]),
});
export type SshHostSuggestion = z.infer<typeof SshHostSuggestion>;

/** The git hosts a person's ssh knows for pushing, never a computer to add: hidden from the ssh hosts offered, with
 * every subdomain of each. */
export const GIT_FORGE_HOSTS: readonly string[] = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "sr.ht", "ssh.dev.azure.com", "vs-ssh.visualstudio.com"];

/** Whether a host name is one of GIT_FORGE_HOSTS or under one. */
export function isGitForge(host: string): boolean {
  const name = host.toLowerCase();
  return GIT_FORGE_HOSTS.some(forge => name === forge || name.endsWith(`.${forge}`));
}

/** The refusal a socket that is not the host's own gets for minting a join code: the code lets a computer in, so
 * only this computer's own window may ask, as wsp add on its terminal does. */
export const MINT_JOIN_REFUSAL = "only a socket holding this host's own token may mint a join code; run wsp add on the computer the host runs on";

/** The refusal for reading the person's ssh hosts on any socket but this computer's own window: which computers
 * they reach is theirs, and a paired device, a relayed socket or a thread learns none of it. */
export const SSH_HOSTS_REFUSAL = "only a socket holding this host's own token may read the ssh hosts on this computer; open wsp on the computer the host runs on";

/** The refusal a socket let in on a ticket gets for opening the door computers you own dial: the same rule the
 * device and place ops read, since the door is who may reach this wsp. */
export const PLACE_DOOR_REFUSAL = "a socket let in on a ticket cannot open the door computers you own dial; run wsp add on the computer the host runs on";

/** The refusal for a host that serves no such door at all: wsp up serves one, a bare runtime does not. */
export const PLACE_DOOR_UNSERVED = "this host opens no door for computers you own; wsp up serves one";

/** A refusal in two halves: what happened, which the app draws in the destructive ink, and what to do about it,
 * which it draws in the foreground ink. One shape, so every screen that refuses reads the same way. */
export const TwoPartRefusal = z.object({ what: z.string(), fix: z.string() });
export type TwoPartRefusal = z.infer<typeof TwoPartRefusal>;

export const JOIN_ADDRESS_LINE: TwoPartRefusal = {
  what: "That is not an address.",
  fix: `Type it as the other screen shows it, like 192.168.1.20:${DEFAULT_PLACE_PORT}.`,
};

/** How long the code on the Add a computer sheet is good for, said in the words beside it. */
export const CODE_GOOD_LINE = "the code is good for 10 minutes";
export const CODE_EXPIRED_LINE = "the code expired; press New code";

/** What the sheet says when somebody else already holds the door's port: a fixed port, since the place file on the
 * other computer names it for good, so a fallback port would be a computer that can never dial back. */
export const doorPortHeldLine = (port: number): string =>
  `port ${port} is held by another program on this computer, so no computer you own can reach this wsp; free it and open Add a computer again`;

/** What a computer joined as a place keeps about the wsp it belongs to, in the file the join writes and the agent
 * reads on every attempt: the id its host knows it by, the addresses to dial in order, the host's public key pinned
 * at that join, and where its own private key is. The shape and the two readings of it live here because the join
 * writes it on one side of the wire and the agent reads it on the other. */
export interface PlaceFile {
  placeId: string;
  name: string;
  /** What the wsp this computer joined calls itself, learned at the join: the one word the joined computer shows. */
  hostName: string;
  /** LAN address first, the host's tunnel hostname after it; dialled in this order on every attempt. */
  hostUrls: string[];
  hostPublicKey: string;
  keyPath: string;
  joinedAt: string;
}

/** The mode the place file and the private key beside it are kept at: the person's own and nobody else's. A key any
 * account on that computer could read is a key that joins their wsp for them. */
export const PLACE_FILE_MODE = 0o600;

/** The place file a text holds, or nothing when that text is not one. A file that is there and is not one reads the
 * same as none: the one road that writes it is wsp join, and anything else there is not a place to dial with. */
export function parsePlaceFile(text: string): PlaceFile | undefined {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }
  const f = held as PlaceFile | undefined;
  const ok =
    typeof f === "object" &&
    f !== null &&
    typeof f.placeId === "string" &&
    typeof f.name === "string" &&
    typeof f.hostName === "string" &&
    Array.isArray(f.hostUrls) &&
    f.hostUrls.every(u => typeof u === "string") &&
    typeof f.hostPublicKey === "string" &&
    typeof f.keyPath === "string";
  return ok ? f : undefined;
}

/** The text the file holds, which parsePlaceFile reads back. */
export const placeFileText = (file: PlaceFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** The refusal a second join on one computer gets: a place file is the one wsp this computer belongs to. */
export const ALREADY_JOINED_LINE = `this computer is already a place in a wsp; ${PLACE_LEAVE_LINE} first`;

const RuntimeOp = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  /** Mints a one time code another computer redeems for a device token of its own. Answers `{ code, expiresAt }`.
   * Only on a socket holding the host's own token, and never on one let in by a ticket. `here` marks the code wsp
   * init mints for the browser it opens on this computer, whose device is then read as the owner. */
  z.object({ id: reqId, op: z.literal("pair.issue"), here: z.literal(true).optional() }),
  /** Spends a code for this computer's own token, as the first frame of a socket nothing has authed. Answers
   * `{ deviceId, deviceToken }` once, and the socket is authed as that device from then on. */
  z.object({ id: reqId, op: z.literal("pair.redeem"), code: z.string().max(64), name: z.string().max(200) }),
  /** Agrees the key this socket is sealed under, as its first frame and before the code or the token it came to
   * send. Answered with a SealOpenReply; it is a door frame read before auth, as a redeem is, and no token names
   * anybody who may send it. */
  SealOpenRequest,
  /** The other first frame a computer with no code sends, inside the seal: it proves a key the account admitted
   * rather than spending a code. A door frame read before auth, as a redeem is. */
  DeviceAuthRequest,
  /** What this wsp knows about the account it is signed in to, off this computer's own records. Answers
   * `{ account }`. Only on the person's own road, never on one let in by a ticket. */
  z.object({ id: reqId, op: z.literal("account.get") }),
  /** Every paired device, for the host token and for a device's own socket alike. */
  z.object({ id: reqId, op: z.literal("devices.list") }),
  /** Takes a device's token away and cuts the sockets holding it, for the host token and for a paired device's
   * own socket alike, whichever device is named. */
  z.object({ id: reqId, op: z.literal("devices.revoke"), deviceId: z.string() }),
  /** The first frame of a computer joining as a place: spends a join code for a record holding its key. Answered
   * with a PlaceJoinReply, and the socket then sends place.prove as an authed one would. */
  PlaceJoinRequest,
  /** The first frame of a place that already joined, answered with a PlaceAuthReply. */
  PlaceAuthRequest,
  /** The second frame of either road: once it verifies, this socket stops being a client's and is the place link. */
  PlaceProveRequest,
  /** Every place this host holds: this computer, the computers joined to it, and the provider it forks on, beside
   * every add over ssh still running and the last that finished. Answers `{ places: PlaceView[], adds: PlaceAddJob[] }`. */
  z.object({ id: reqId, op: z.literal("places.list") }),
  /** Puts the daemon this host deploys on one place where it is behind, over the link it holds or over the ssh road
   * the install used, waits for that computer to dial back running it, and then runs the recipe on it. The
   * workspaces on it are kept. `addId` is the stream the recipe's own steps ride, so a caller that minted one reads
   * them from the first row. Answers a PlaceUpdateReply. */
  z.object({ id: reqId, op: z.literal("places.update"), placeId: z.string(), addId: z.string().optional() }),
  /** Takes a place back out: sweeps wsp off that computer over its link, drops the workspaces standing on it and
   * the place record. Answers `{ removed, swept, note? }`. */
  z.object({ id: reqId, op: z.literal("places.remove"), placeId: z.string() }),
  /** Runs the doctor's computer road here, for a computer this host holds the link to: the six steps against that
   * link, and every line of them pushed as a doctor.line event under `doctorId` to the sockets subscribed to
   * events. The id is the caller's own, minted before the request, since the first line is said before the reply
   * lands. Answers `{ code }` once the road printed its last line. The person's own road only, as every other
   * place op is. */
  z.object({ id: reqId, op: z.literal("places.doctor"), placeId: z.string(), doctorId: z.string().max(64), project: z.string().max(200).optional() }),
  /** Dials one computer once, now: a frame over the link it holds, or a login over the road it was added on when
   * it holds none. Answers a PlaceDial: what came back, the sentence to say it in, and the row with the answer
   * written on it, so a window opened later reads the same thing. Nothing is installed and nothing is left
   * running either way. */
  z.object({ id: reqId, op: z.literal("places.dial"), placeId: z.string() }),
  /** A sign-in run at a terminal on one computer landed, as the tool's own status there said: the host notes the
   * file that agent's shared login writes, as the app's own sign-in does, so the listing says signed in before
   * that computer next reports. Answers `{}`. The person's own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.loginLanded"), placeId: z.string(), agent: z.string() }),
  /** Opens the door computers you own dial, when this host binds loopback alone, and answers where it is; a host
   * already bound beyond loopback answers its own port and opens nothing. Answers a PlaceDoorView. The person's
   * own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.door") }),
  /** Mints a join code and answers a JoinMint: every line a computer you own can join this host by, off the door's
   * addresses and the relay's, and when the code expires. The code lets a stranger in, so only a socket holding the
   * host's own token may ask, as for pair.issue. */
  z.object({ id: reqId, op: z.literal("places.mint") }),
  /** Answers `{ hosts: SshHostSuggestion[] }`: the ssh config's hosts first, then known_hosts, less the computers
   * already added over ssh. Only a socket holding the host's own token may ask. */
  z.object({ id: reqId, op: z.literal("places.sshHosts") }),
  /** Puts the agent on a Linux computer over ssh and joins it, `address` naming it as user@host or as an alias
   * from the person's ssh config, which is dialled through that block: the host logs in as the person's own ssh would,
   * installs node and wsp there, starts the agent under that login's own service manager and waits for it to dial
   * back. Answers `{ addId, place: PlaceView }` once it has dialled; the steps ride place.stage events carrying the
   * same addId. */
  z.object({
    id: reqId,
    op: z.literal("places.add"),
    /** The stream the steps of this install ride, minted by whoever asked: the steps start before the reply names
     * the place, so a caller that wants to draw them has to know which are its own before it asks. */
    addId: z.string().max(64).optional(),
    address: z.string().max(200),
    name: z.string().max(200).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    keyPath: z.string().max(1024).optional(),
    /** The host key the person confirmed or pinned for a computer this one has never dialled. The install refuses
     * before a byte of wsp's leaves this computer where it is absent and the client holds no key of its own, so a
     * caller that sends none meets the same wall as one that sends a wrong one. */
    hostKey: z.string().max(200).optional(),
  }),
  /** Replies with an EventsSubscribeReply, then pushes events on this socket. With `after`, the seq of the last event
   * this client saw, every retained event past it is pushed first, oldest first, before anything live; `stream` is
   * the id that came with that seq, so a runtime that is not the one that issued it answers gap instead. */
  z.object({
    id: reqId,
    op: z.literal("events.subscribe"),
    after: z.number().int().nonnegative().optional(),
    stream: z.string().optional(),
  }),
  /** Replies with a WorkspaceStatus[] snapshot and keeps the runtime's status
   * poller + cost ticker running while this socket lives; the events ride the
   * events.subscribe channel. */
  z.object({ id: reqId, op: z.literal("status.subscribe") }),
  /** Replies with a WorkspaceListing[] snapshot and keeps nothing running: the one shot a command line or a tool
   * takes to read a state, since a WorkspaceView carries neither the provider's word for the machine nor the daemon
   * reach and the state word turns on both. The listing is the status without the minted route, which only the app's
   * own socket needs, and the snapshot costs one reach probe per machine and no exec probe. */
  z.object({ id: reqId, op: z.literal("status.list") }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.create"),
    /** A project image by snapshot id; absent takes the head of the project's computer's own image. A create a
     * thread asked for names none and is refused where it does: it takes the image its own workspace's project
     * runs, which is the only image a thread reaches. */
    golden: z.string().optional(),
    /** The project this workspace is made for, by id or by name. Its computer is where the workspace lands. */
    project: z.string(),
    name: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
    envs: z.record(z.string()).optional(),
    labels: z.record(z.string()).optional(),
    /** What the agents on the new workspace may ask of this host; absent is off, and a key left out takes the default. */
    agents: WorkspaceAgents.partial().optional(),
    /** Auto-nap window for this workspace; absent takes the runtime default (20 min), null turns it off. */
    idleWindowMs: z.number().nullable().optional(),
    /** The workspace this one is forked out of, by id: a child of it, holding the same project and starting on the
     * branch that workspace is on right now where the remote has that branch. A workspace of another project is
     * refused, since a child starts on its parent's branch. A create a thread asked for is a child of the thread's
     * own workspace whether or not this names one, and a workspace it names here is not read. */
    parent: z.string().optional(),
    /** The workspace gets the place's container engine through the fenced socket; absent takes the image's recipe. */
    engine: z.boolean().optional(),
  }),
  /** Where a workspace of this project would land and what that computer offers. Replies with
   * { place?, name, capabilities }, `place` absent where the landing is the provider this host forks on. Refused
   * before any machine is asked for where that computer forks nothing: with NO_PROVIDER_LINE when no place here runs
   * workspaces, else naming the places that do. The one gate a create runs, read ahead so the refusal comes in one
   * sentence before any stage is streamed. */
  z.object({ id: reqId, op: z.literal("workspaces.landing"), project: z.string() }),
  /** Every workspace this caller may drive. Replies with { workspaces }. */
  z.object({ id: reqId, op: z.literal("workspaces.list") }),
  /** The workspace a person's word names, by id or by name, off the same reading workspaces.list serves: a name no
   * workspace here carries is refused as absent, and one this caller may not drive by the rule that hides it, so a
   * verb never denies a workspace the listing just showed. Replies with { workspace }. */
  z.object({ id: reqId, op: z.literal("workspaces.resolve"), ref: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.get"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.nap"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.wake"), workspaceId: z.string() }),
  /** Starts another daemon for a workspace whose daemon this host owns as a child of its own process, replacing
   * one that is not running. The one kind that has such a daemon is the workspace that is this computer; every
   * other kind's daemon lives on a machine this host does not hold the process of, and is refused here. Replies
   * `{}` once the new daemon has listened. */
  z.object({ id: reqId, op: z.literal("workspaces.restartDaemon"), workspaceId: z.string() }),
  /** Stops a wake that is asking the provider again on its own and replies with the record it leaves behind. */
  z.object({ id: reqId, op: z.literal("workspaces.stopWake"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.upgrade"), workspaceId: z.string() }),
  /** Moves a workspace onto the golden's head version: a fresh fork of the newer image carrying this workspace's
   * files across. The person asks for it; nothing moves a machine they are working on.
   * Refused (kind "conflict") for a workspace forked from a project golden, whose disk the move would throw away. */
  z.object({ id: reqId, op: z.literal("workspaces.updateImage"), workspaceId: z.string() }),
  /** Names the workspace and replies with its fresh { workspace }. The name is unique on this host, so one another
   * workspace holds, one a fork is landing under and a blank one are refused (kind "conflict"); a name the workspace
   * already carries comes back untouched. Threads running on the machine are untouched. */
  z.object({ id: reqId, op: z.literal("workspaces.rename"), workspaceId: z.string(), name: z.string() }),
  /** Sets the workspace's look and replies with its fresh { workspace }. A key left out keeps that fact as it is and
   * null clears it, so the colour picker and the icon picker each send their own without reading the other's. The
   * record alone changes: nothing on the machine is touched. */
  z.object({ id: reqId, op: z.literal("workspaces.look"), workspaceId: z.string() }).extend(WorkspaceLook.shape),
  /** Pushes the branch the workspace's copy is on and opens or finds its pull request, and replies with a
   * BringBackResult. The base is the branch its parent was on at the fork for a child, whatever that parent does
   * after, and the project's own base otherwise; the base branch itself is refused, since work leaves a workspace
   * as a branch of its own. */
  z.object({ id: reqId, op: z.literal("workspaces.bringBack"), workspaceId: z.string(), title: z.string().optional(), body: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("workspaces.delete"), workspaceId: z.string() }),
  /** Turns the workspace's agents switch on or off and names its caps. Every key left out keeps what the record
   * holds, so the two flags a person gives on one line never clear the third. */
  z.object({ id: reqId, op: z.literal("workspaces.agents"), workspaceId: z.string() }).extend(WorkspaceAgents.partial().shape),
  /** Drops a workspace whose machine the provider no longer has: the record, its transcripts and its sessions leave the
   * store and workspace.deleted follows, once twelve reads in a row find the machine gone; nothing is asked of the
   * machine. Refused with the reason (kind "conflict") while any read still finds it: pause it or delete it at the provider first. */
  z.object({ id: reqId, op: z.literal("workspaces.forget"), workspaceId: z.string() }),
  /** Snapshots the workspace's disk as a project golden and replies with { projectGolden }. Refused when the workspace
   * is not running, holds no project, or its machine is not first-life (kind "notFirstLife"). The guest freezes for
   * about three seconds and keeps its first life. */
  z.object({ id: reqId, op: z.literal("workspaces.snapshot"), workspaceId: z.string() }),
  /** Replies with { projectGoldens: ProjectGolden[] }, every project golden this runtime took, newest last. */
  z.object({ id: reqId, op: z.literal("projectGoldens.list") }),
  /** Deletes a project golden's snapshot at the provider of the place its record names and replies with a
   * ProjectGoldenRemoved once the listing no longer holds it; the record leaves last. Refused while any workspace
   * stands on it, whatever its phase (kind "conflict"), and for an id no project golden holds (kind "not-found"). */
  z.object({ id: reqId, op: z.literal("projectGoldens.remove"), snapshotId: z.string() }),
  /** A person acted in the workspace through a road the runtime cannot see (typed into
   * a terminal over the browser's daemon link); the idle countdown starts over. */
  z.object({ id: reqId, op: z.literal("workspaces.touch"), workspaceId: z.string() }),
  /** Opens a channel to the workspace's daemon and replies with a DaemonOpenReply. The host dials the road the
   * workspace's kind answers with and sends its own token as the first frame. Refused with kind "refused" when the
   * door answered the upgrade with anything but 101 (the sentence carries the status and the body's first line),
   * with kind "reauth" when the daemon took the upgrade and closed 4401 on the token, and with the runtime's own
   * sentence and no kind when the machine has no road or no daemon yet, or the dial failed or timed out.
   *
   * With `placeId` in place of `workspaceId` the channel is to the daemon on a computer the person owns, over the
   * link that computer is holding: nothing is dialled, and it is refused where that computer is not connected.
   * HERE_PLACE_ID names the computer the host runs on, whose own daemon is dialled. One of the two, never both. */
  z.object({ id: reqId, op: z.literal("daemon.open"), workspaceId: z.string().optional(), placeId: z.string().optional() }),
  /** The wsp command's forwarder on this computer opening a guest session on this host itself, one hop shorter
   * than a machine's: the same frame a guest sends its daemon, plus the environment the line was typed in, which
   * a tool reads values off by name. Served only on a socket the host's own token opened, which is who the session
   * is, so the token the frame carries is not read; one session per socket, and only the tool server. Replies with
   * a GuestOpenReply, then pushes HereGuestEvent frames on this socket. */
  z.object({
    id: reqId,
    op: z.literal("guest.open"),
    kind: GuestKind,
    token: z.string().max(GUEST_TOKEN_MAX),
    turnToken: z.string().max(GUEST_TOKEN_MAX).optional(),
    argv: z.array(z.string()).max(GUEST_ARGV_MAX),
    cwd: z.string().max(GUEST_CWD_MAX),
    env: z.record(z.string()).optional(),
  }),
  /** One message on the guest session this socket opened. */
  z.object({ id: reqId, op: z.literal("guest.send"), message: z.unknown() }),
  /** Pushes WorkspaceSysEvent frames for this workspace on this socket, one per poll tick, until the socket goes.
   * The one road for a workspace whose kind reads its Live rows in the host rather than off a daemon; refused for
   * every other kind, which reads them over its own daemon link with sys.watch. Replies `{}`. */
  z.object({ id: reqId, op: z.literal("sys.subscribe"), workspaceId: z.string() }),
  /** Sends one frame down a channel this socket opened and replies with a DaemonSendReply carrying the daemon's own
   * answer, ok or not. Refused (ok false, no kind) when the channel is not this socket's or died before the daemon
   * answered. */
  z.object({ id: reqId, op: z.literal("daemon.send"), channel: z.string(), frame: DaemonFrame }),
  /** Closes a channel this socket opened; no daemon.closed follows a close the page asked for. */
  z.object({ id: reqId, op: z.literal("daemon.close"), channel: z.string() }),
  /** Starts a turn and replies with a SessionStartResult. On a thread whose turn is still running the runtime never
   * starts a second one on the session: the message joins the running turn when the harness steers (the reply names
   * that turn), and otherwise waits for it to end before starting. */
  z.object({
    id: reqId,
    op: z.literal("sessions.start"),
    workspaceId: z.string(),
    prompt: z.string(),
    harness: z.string().optional(),
    resume: z.string().optional(),
    /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness never
     * announced a session takes the message as a first turn on that same thread. Refused when the workspace has no
     * thread with that id. */
    thread: z.string().optional(),
    /** The folder the thread starts in, absolute; it wins over project and the rule. Absent leaves the runtime's
     * default folder rule (projectFor, then the kind's own folder) to say. */
    cwd: z.string().optional(),
    /** Values from the harness's catalog for the workspace (harnesses.list), refused with that list on a miss. A
     * start that opens a thread without a model runs the one the catalog marks default, so the app, the command line
     * and the MCP server run the same model; an absent effort or mode leaves the CLI's own. */
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    contextWindow: z.string().optional(),
    /** Absent reads as person: the app never sends it, the command line sends cli, the MCP server sends agent. */
    startedBy: SessionOrigin.optional(),
    /** Minted by the client per send and echoed on the turn's session.start, so the client knows which start is its own. */
    requestId: z.string().optional(),
    /** Who the end of every turn on the thread this start opens is told, each a thread id or NOTIFY_ME: registered on
     * the thread, and each target gets one line (a session.notify event per target in this thread's transcript).
     * Refused when a target names no thread, and refused when one names the thread this start opens. */
    notify: z.array(z.string()).min(1).optional(),
    /** The TURN_TOKEN_ENV of the turn this request came out of, when it came out of one: what NOTIFY_ME is resolved
     * against. Refused when no turn on this host carries it, since a token nothing carries names a turn the caller
     * is not. */
    turnToken: z.string().optional(),
    /** The name the thread is opened under, as a person's: it stands in every client at once, the harness is told it
     * too so its own UI says the same, and no generated title ever replaces it. Refused when it is blank. */
    title: z.string().optional(),
    /** The images the message carries, in the order the person added them; refused with imagesRefusal's line over the
     * caps, and refused naming the agent before the machine is asked when that agent's adapter reads no image. */
    attachments: z.array(ImageAttachment).optional(),
  }),
  /** Replies with { harnesses: HarnessCatalog[] }, one per harness the runtime knows. With a workspace, the lists come
   * from the binaries on its machine where they answer; without one, from the runtime's table. */
  z.object({ id: reqId, op: z.literal("harnesses.list"), workspaceId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("sessions.list"), workspaceId: z.string().optional() }),
  /** Replies with the workspace's persisted SessionEvent[] (oldest first, capped by the runtime). */
  z.object({ id: reqId, op: z.literal("sessions.history"), workspaceId: z.string() }),
  /** Asks the harness to stop the session's running turn; replies with a SessionInterruptResult. */
  z.object({ id: reqId, op: z.literal("sessions.interrupt"), sessionId: z.string() }),
  /** Sends a message into the session's running turn; replies with a SessionSteerResult. Takes the runtime's session
   * id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.steer"), sessionId: z.string(), prompt: z.string(), requestId: z.string().optional() }),
  /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's id and one of its
   * options; replies with a SessionAnswerResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.answer"), sessionId: z.string(), askId: z.string(), optionId: z.string() }),
  /** Puts the session's running turn into another access mode from its next tool call on; replies with a
   * SessionAccessResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.access"), sessionId: z.string(), permissionMode: z.string() }),
  /** Names the session's harness session in the harness's own store and keeps the name on the thread's rows; replies
   * with a SessionRenameResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.rename"), sessionId: z.string(), title: z.string() }),
  /** Drops a thread no turn ever ran on: its rows and its transcript rows go and nothing is asked of the machine.
   * Takes the runtime's thread id, the one the rows carry, not a session id; refused with threadForgetRefusal's
   * sentence once a turn reached the agent. */
  z.object({ id: reqId, op: z.literal("sessions.forget"), threadId: z.string() }),
  z.object({ id: reqId, op: z.literal("golden.get"), name: z.string() }),
  /** Replies with the backend's Capabilities; the UI gates features on these. */
  z.object({ id: reqId, op: z.literal("capabilities.get") }),
  /** Boots a fresh builder for golden `name`; replies with a GoldenBuilderView.
   * Progress rides golden.stage events on the events channel. */
  z.object({ id: reqId, op: z.literal("golden.prepare"), name: z.string(), kind: MachineKind.optional() }),
  /** Snapshots the builder, smoke-tests a fork, appends a manifest version;
   * replies with { manifest, version }. The builder is consumed either way. */
  z.object({ id: reqId, op: z.literal("golden.seal"), builderId: z.string() }),
  /** Replies with { lineage: SnapshotLineage } for golden `name` (default "default"). */
  z.object({ id: reqId, op: z.literal("snapshots.list"), name: z.string().optional() }),
  /** Replies with { storage: SnapshotStorage | null }: every snapshot on the account by count, size and monthly
   * cost; null on a backend whose capabilities lack snapshotListing. */
  z.object({ id: reqId, op: z.literal("snapshots.storage") }),
  /** Replies with { points: WorkspaceCostEvent[] }: the workspace's cost ticks since metering began, across host
   * restarts, folded to the ticks where the rate changed plus the newest (appendCostPoint); empty before the first tick. */
  z.object({ id: reqId, op: z.literal("cost.history"), workspaceId: z.string() }),
  /** Replies with { places: PlaceSpend[] }: one row per place this host holds anything metered for, with what it
   * has taken since the first of the month and what it burns now. Refused on a socket let in on a ticket, as the
   * places list itself is: what a person's computers cost is that person's computer's to answer. */
  z.object({ id: reqId, op: z.literal("cost.spend") }),
  /** Moves the golden's head to a version already in its manifest; replies with a
   * SnapshotRollbackResult. A version outside the manifest fails with kind "missing". */
  z.object({ id: reqId, op: z.literal("snapshots.rollback"), version: z.number(), name: z.string().optional() }),
  /** Replies with { reach: PortReachView } for one guest port, cached per port
   * while fresh. A port outside the daemon's listening set still mints: the
   * user may have typed it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portReach"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replies with { probe: PortProbeView }: one fetch of the port's minted route
   * from the host, redirects unfollowed, the body read up to a cap. A 401 remints
   * the port's route before the reply, so the next portReach carries a fresh
   * token. Refused when the route cannot be fetched at all; the frame is the
   * only truth then. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portProbe"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replaces the workspace's machine with a fresh golden fork, imports the
   * nap-time vault if one exists, and kills the old machine whatever it
   * reports. Replies with the WorkspaceView on its new machine; id and name
   * are kept. The way out of a zombie reach state. */
  z.object({ id: reqId, op: z.literal("workspaces.rebuild"), workspaceId: z.string() }),
  /** Replies with { forwards: PortForward[] }, the host's open forwards; empty when no host holds any. */
  z.object({ id: reqId, op: z.literal("forwards.list") }),
  /** Closes one forward; refused when none is open on that workspace and port. */
  z.object({ id: reqId, op: z.literal("forwards.stop"), workspaceId: z.string(), port: RelayPort }),
  /** Runs one command on the workspace's machine the way a harness turn is launched: detached, as the same user,
   * with the environment the harness adapter exports for a turn. argv is the command word by word; the runtime
   * quotes each for the machine's shell, so a word stays one word. Replies { execId } once launched, then pushes
   * ExecEvent frames to this socket only: exec.output per line, exec.exit last. The socket closing ends the
   * command, and so does the machine going away under it (deleted, paused, or unanswering: exec.exit then carries
   * the reason as its error); nothing else does, there is no deadline. cwd is the folder the command runs in, absolute;
   * absent, the folder the workspace's kind names, as a harness turn's is. The reply carries that folder back as its
   * own cwd, absent only where the kind names none and the machine's own home is where the shell landed. */
  z.object({ id: reqId, op: z.literal("workspaces.exec"), workspaceId: z.string(), argv: z.array(z.string()).min(1), cwd: z.string().optional() }),
  /** Replies with { listing: HostFolderListing }: one level of this computer's own folders, for the picker a browser
   * tab has instead of the desktop shell's dialog. `dir` absent lists the first root and a folder inside the roots
   * that is gone does the same; a path outside them is refused. `hidden` lists the hidden folders too, which are
   * otherwise only counted. `repos` answers every git repo under the roots instead of one level, most recent
   * first. `on` is the id of the computer whose folders are listed, off places.list: absent or this computer's is
   * this computer's; a computer you joined answers through its own daemon over its link, with its login's home and
   * its projects' folders as the roots; a provider keeps no computer and is refused. */
  z.object({ id: reqId, op: z.literal("host.folders"), dir: z.string().optional(), hidden: z.boolean().optional(), repos: z.boolean().optional(), on: z.string().optional() }),
  /** Replies with { config: TerminalConfig }: the person's Ghostty config on the computer running the host, read
   * again on every ask so a saved change reaches the next terminal opened; `scheme` picks the theme of a
   * light:...,dark:... value and is dark when absent. */
  z.object({ id: reqId, op: z.literal("host.terminalConfig"), scheme: TerminalScheme.optional() }),
  /** Replies with { report: AgentsReport }: the agents, skills and MCP servers standing on one computer or workspace,
   * read as the login the computer was added with and never as root. Nothing is started: no server is spawned and no
   * login file is read, only whether one is there. A napping workspace is not woken; it answers the last report read
   * while it ran, marked stale, or refuses where there is none. A cloud account's row is refused, since nothing stands
   * there between forks. */
  z.object({ id: reqId, op: z.literal("agents.read"), target: AgentsTarget }),
  /** Replies with { answer: ServerToolsAnswer }: one MCP server of one agent's config there, started once as that
   * login with its own command and variables, or asked once over its address, for its tools and its sign-in. Only on
   * the person's ask, under a deadline, the answer kept for an hour unless `refresh`. A server whose sign-in the
   * harness holds brings no list, only the harness's word where its words were measured; no login file is read. */
  z.object({ id: reqId, op: z.literal("servers.tools"), target: AgentsTarget, agent: z.string(), name: z.string(), refresh: z.boolean().optional() }),
  /** Replies with { icon: string | null }: a remote MCP server's icon by its host (the report's `transport.host`) as a
   * data url, asked of Google's favicon service by this host alone and kept 30 days, `refresh` asking again. Null
   * where there is none, where the host is an address or a private name, and always while the person's
   * `serverIcons` preference is off, when nothing is asked. */
  z.object({ id: reqId, op: z.literal("servers.icon"), host: z.string().min(1).max(260), refresh: z.boolean().optional() }),
  /** Replies with { signInId } once the agent's own sign-in runs in a pty there, as that computer's login, or joins
   * the one already running for that agent there, one per agent per target; its progress is pushed as agents.signIn
   * events to the sockets following it alone, which is what a page and its code are for, and the sign-in stops when
   * the last of them goes. Refused for a row that asks the person to pick, which runs in their terminal, for a row
   * whose login is a token or key this host keeps, and for a name holding a control character. */
  z.object({ id: reqId, op: z.literal("agents.signIn"), target: AgentsTarget, agent: z.string() }),
  /** The same for one MCP server of that agent's config, by the harness's own command for it. */
  z.object({ id: reqId, op: z.literal("servers.signIn"), target: AgentsTarget, agent: z.string(), name: z.string() }),
  /** Types what a sign-in's page handed back into that sign-in's own pty, with the Enter the person would press. */
  z.object({ id: reqId, op: z.literal("agents.signInCode"), signInId: z.string(), code: z.string().min(1) }),
  /** Stops a sign-in this socket started or joined, killing its pty for everyone following it. */
  z.object({ id: reqId, op: z.literal("agents.signInStop"), signInId: z.string() }),
  /** Replies with { line: SignInLine }: the sign-in, or one server's with `name`, as the line the person's own
   * terminal runs there over its daemon channel. */
  z.object({ id: reqId, op: z.literal("agents.signInLine"), target: AgentsTarget, agent: z.string(), name: z.string().optional() }),
  /** Writes the agent's token or key into this host's vault, the variable its row names, checked against the shape
   * the row says the tool prints; only on the host's own socket. Replies with nothing of it. */
  z.object({ id: reqId, op: z.literal("agents.key"), agent: z.string(), key: z.string().min(1) }),
  /** Replies with { file }: the wsp server written into that agent's own config on this computer, the entry an
   * install writes, with the wsp skill beside it. Refused on any other computer. */
  z.object({ id: reqId, op: z.literal("agents.addTools"), target: AgentsTarget, agent: z.string() }),
  /** Replies with { skills: SkillHit[] }: skills.sh searched by this host, the one caller of it; an empty query is
   * refused, since skills.sh refuses it. */
  z.object({ id: reqId, op: z.literal("skills.search"), q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
  /** Replies with { preview: SkillPreview }: a skill's SKILL.md off skills.sh by its `<owner>/<repo>/<skill>`, read
   * by this host and nothing installed. */
  z.object({ id: reqId, op: z.literal("skills.get"), skill: z.string() }),
  /** Replies with { preview: SkillPreview }: the SKILL.md of one skill there, by its name, the project's skill of that
   * name with `project`. */
  z.object({ id: reqId, op: z.literal("skills.preview"), target: AgentsTarget, name: z.string(), project: z.boolean().optional() }),
  /** Replies with { added: SkillAdded }: a skill off skills.sh put into the shared skills folder there, the project's
   * with `project`, with a link or a copy in the folder of each agent named that does not read that folder. Every
   * path in the download is checked first, the files land 0644 as that computer's login, and nothing in them runs. */
  z.object({ id: reqId, op: z.literal("skills.add"), target: AgentsTarget, skill: z.string(), agents: z.array(z.string()).optional(), project: z.boolean().optional() }),
  /** Replies with { removed: string[] }: every folder of that skill there and every link to it, gone. The skill wsp
   * writes and a plugin's are refused. */
  z.object({ id: reqId, op: z.literal("skills.remove"), target: AgentsTarget, name: z.string(), project: z.boolean().optional() }),
  /** Replies with { paths: string[] }: that skill turned off or on there, its SKILL.md renamed SKILL.md.off or back
   * in each of its folders. The skill wsp writes, a plugin's and a project's are refused. */
  z.object({ id: reqId, op: z.literal("skills.toggle"), target: AgentsTarget, name: z.string(), project: z.boolean().optional(), on: z.boolean() }),
  /** Replies with { file }: one MCP server written into that agent's own config there, the project's with `project`,
   * as that computer's login: a command with its arguments and variables, or an address with its headers. The values
   * go into that file and nowhere else; a name already there is refused rather than written over. */
  z.object({ id: reqId, op: z.literal("servers.add"), target: AgentsTarget, ...ServerAdd.shape }),
  /** Replies with { file }: that one server's entry taken out of that agent's config there, in the scope it was read
   * from, every other line of the file as it was. */
  z.object({ id: reqId, op: z.literal("servers.remove"), target: AgentsTarget, ...ServerAsk.shape }),
  /** Replies with { file }: that one server turned off or on in that agent's config there, by the switch the agent
   * itself reads; refused for an agent that keeps no such switch per server. */
  z.object({ id: reqId, op: z.literal("servers.toggle"), target: AgentsTarget, ...ServerAsk.shape, on: z.boolean() }),
  /** Replies with { setup: InitSetup }: the cloud setup as the modal opens on it, the init job included when one runs.
   * `on` prices the build at that place instead of the default one, by the name or id wsp places lists; once the
   * image stands, every build is priced at the image's own place whatever `on` says. */
  z.object({ id: reqId, op: z.literal("init.get"), on: z.string().optional() }),
  /** Saves keys into the wsp home's .env on the computer running the host: the provider key, put to that provider
   * before anything is written and saved under the variable its own module reads, and an agent's API key by the
   * sign-in row it answers, saved under the variable that agent's sign-in declares. `provider` is the word
   * WSP_PROVIDER holds for the provider the key belongs to, and naming one picks it; absent, the key goes to the
   * provider this host already forks on. Replies with { setup: InitSetup }, which says a key is held and never says
   * what it is. */
  z.object({ id: reqId, op: z.literal("init.keys"), provider: z.string().max(64).optional(), key: z.string().optional(), rows: z.record(z.string()).optional() }),
  /** Starts the init job on the road named, an agent's harness on the agent road; replies with { job: InitJob } and
   * every change after rides init.job events. One job runs at a time; a second start while one runs is refused. The
   * terminal road takes its answers from the recipe beside the state, which wsp init wrote from its own screens, and
   * is refused when there is none there. */
  z.object({ id: reqId, op: z.literal("init.start"), road: InitRoad, harness: z.string().optional(), on: z.string().optional() }),
  /** Answers one screen: the rows ticked, the answers chosen; replies with { job: InitJob }, its screens recomputed
   * and its step moved to the next. */
  z.object({ id: reqId, op: z.literal("init.answer"), screen: InitScreenId, ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Moves the job to a screen the person went back to, so a setup shut there reopens there; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.step"), at: z.number().int().nonnegative() }),
  /** Keeps what a step has ticked, picked or typed and not sent, so a setup shut mid-step reopens on it; replies
   * with { job: InitJob }. `at` is a screen's id or the build question's own step; a step the job does not have is
   * refused. An empty draft is an answer of its own: a step whose every tick was taken off comes back with none on. */
  z.object({ id: reqId, op: z.literal("init.draft"), at: z.string().min(1).max(64), ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Runs a sign-in that ran out or failed again on the machine while the build goes on; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.retry"), tool: z.string() }),
  /** Writes the recipe as answered and starts the build; replies with { job: InitJob } at once, the build riding on.
   * `yes` skips the sign-ins on the machine, as wsp init --yes does: a caller that asked for no waiting gets none.
   * `on` is the place the image is built on, by the name or id wsp places lists; absent takes the default place.
   * `on` is read for the first build alone: once the image stands, every build goes to the image's own place, so
   * no caller can move it.
   * `rebuild` seals the next version from a fresh machine rather than from the image plus the changes, which is the
   * question a run at a terminal is asked; absent takes whichever road the changes call for. */
  z.object({ id: reqId, op: z.literal("init.build"), firstWorkspace: z.string().optional(), importFolder: z.string().optional(), yes: z.boolean().optional(), on: z.string().optional(), rebuild: z.boolean().optional() }),
  /** Types the code a sign-in's page handed back into the tool waiting for it on the machine, as the person would at
   * that terminal; replies with { job: InitJob }. The code is never logged, kept or carried on the view. Refused when
   * no sign-in for that tool is waiting for one. */
  z.object({ id: reqId, op: z.literal("init.signInCode"), tool: z.string(), code: z.string().min(1).max(SIGN_IN_CODE_MAX) }),
  /** Stops the job where it is: a thread interrupted, a builder killed; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.cancel") }),
  /** Replies with { preferences: Preferences }: the record on this host's state, the defaults until a client set something. */
  z.object({ id: reqId, op: z.literal("preferences.get") }),
  /** Lands the patch on the record, keeps it, pushes preferences.changed to every socket and replies with
   * { preferences: Preferences, notice? }, the notice a sentence on what the set kept but could not finish. */
  z.object({ id: reqId, op: z.literal("preferences.set"), patch: PreferencesPatch }),
  /** Replies with { release: ReleaseView }: the newest release as this host last read it, asking nobody. */
  z.object({ id: reqId, op: z.literal("release.get") }),
  /** Asks GitHub again unless the last ask was under ten minutes ago and replies with { release: ReleaseView }; a
   * changed view is pushed to every socket as release.changed. */
  z.object({ id: reqId, op: z.literal("release.check") }),
  /** Replies { ok } and then restarts this host on the files it was installed from, by the road it came up on;
   * refused where that road would not bring it back. The socket closes on the host's stopping code. */
  z.object({ id: reqId, op: z.literal("host.restart") }),
  /** Records a project: one word, which is a folder on this computer or a repo url a computer clones, and the
   * computer it lives on. Replies with { project, notice? }; refused with the three forms when the word names
   * none of them, and refused naming the project when that source is already recorded on that computer. */
  z.object({
    id: reqId,
    op: z.literal("projects.add"),
    source: z.string(),
    on: z.string().optional(),
    name: z.string().optional(),
    base: z.string().optional(),
    /** What the person chose off the seed menu; required where the source is a folder on this computer and that
     * folder is seeding a computer that clones, since nothing of theirs leaves this computer unasked. */
    seed: SeedChoice.optional(),
  }),
  /** Replies with { plan: SeedPlan } for a folder on this computer: what a seed of it would carry, read off git's
   * own ignore listing and one size pass. No file's content is read and nothing leaves this computer. */
  z.object({ id: reqId, op: z.literal("project.seed.plan"), source: z.string() }),
  /** Every project this host holds. Replies with { projects }. */
  z.object({ id: reqId, op: z.literal("projects.list") }),
  /** The project a word names, by id or by name. Replies with { project }. */
  z.object({ id: reqId, op: z.literal("projects.resolve"), ref: z.string() }),
  /** Drops a project's record; refused while a workspace of it stands, naming the workspaces. Replies with {}. */
  z.object({ id: reqId, op: z.literal("projects.remove"), projectId: z.string() }),
  /** Replies with { plan: ProjectPlan } for a folder on this computer; nothing is read into memory or uploaded. */
  z.object({ id: reqId, op: z.literal("project.plan"), source: z.string() }),
  /** Packs the folder and lands it at `dest` on the workspace's machine; progress rides project.import events and the
   * reply is { imported: ProjectImportResult }. `carry` names the secret-shaped paths from the plan that may travel as
   * they are; `rewrite` names the ones the plan offered a rewrite for, which land rewritten as offered and win over
   * carry; every other secret-shaped file is cut and named. `agents` names the plan's agents whose state for the
   * folder travels; nothing of an agent not named is read. An existing `dest` is refused (kind "exists") unless `replace`. */
  z.object({
    id: reqId,
    op: z.literal("project.import"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    carry: z.array(z.string()).optional(),
    rewrite: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** The bundle's trip home: tars `source` on the workspace's machine with the bundle's cache exclusions and the
   * agent state keyed to it, lands the folder at `dest` on this computer and the state in the agents' homes here,
   * keyed to `dest`; progress rides project.export events and the reply is { exported: ProjectExportResult }.
   * `agents` narrows whose state comes home, by catalog id; absent, every agent with sessions for the folder does.
   * An existing `dest` is refused (kind "exists", the message naming it and how many files it holds) unless
   * `replace`; nothing is read from the machine before that check. */
  z.object({
    id: reqId,
    op: z.literal("project.export"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** Replies with { view: SealedImageView }. */
  z.object({ id: reqId, op: z.literal("image.get"), name: z.string().optional() }),
  /** Builds this host's image at `place` from the record: prepare there, import the vault, seal. Replies with
   * { build: SealedImageBuilt }; progress rides golden.stage frames carrying `place`. A place that already holds a
   * copy built from this record is answered with that copy and `built: false`, so asking twice costs nothing.
   * Refused (kind "missing") when no place of that name is held, and (kind "conflict") when the place is the one
   * this host forks on, when the place builds no copy at all, when no record exists, when the record was sealed
   * without the recipe it was built from, and when the record holds no vault and `force` is not set. */
  z.object({ id: reqId, op: z.literal("image.build"), place: z.string().min(1), name: z.string().optional(), force: z.boolean().optional() }),
  /** Writes the record and the vault, sealed to the passphrase, to `dest` on this computer. Replies with
   * { exported: SealedImageExport }. The passphrase is never logged and never kept. */
  z.object({ id: reqId, op: z.literal("image.export"), dest: z.string().min(1), passphrase: z.string().min(IMAGE_PASSPHRASE_MIN).max(256), name: z.string().optional() }),
]);

/** Every request carries where it reached the host from: here, this computer's own app, CLI or MCP, or relayed from
 * a machine. It rides the envelope beside the id rather than each op, so a verb added later carries it without
 * saying so. Absent reads here, and today every client on this computer is here in practice. */
export const RuntimeRequest = z.intersection(RuntimeOp, z.object({ origin: WorkspaceOrigin.optional() }));

/** Every op this host answers, read off the table itself rather than written out beside it, so an op added later
 * cannot be missing from the reading that decides which of them a thread may send. */
export const RUNTIME_OPS: readonly string[] = RuntimeOp.options.map(o => o.shape.op.value);

/** The request fields above that carry a secret: a key, a token, a code, a passphrase, or a record of logins or
 * environment values a person puts keys into. A new field that carries one is added here, beside its schema. */
export const SECRET_REQUEST_FIELDS: readonly string[] = ["token", "key", "rows", "code", "passphrase", "env", "envs", "headers"];

/** The secret values a request frame carries, read one level into a record and no deeper: a record of logins is as
 * deep as a secret field goes, and the frame may be a stranger's. */
export function requestSecrets(frame: unknown): string[] {
  if (typeof frame !== "object" || frame === null) return [];
  return SECRET_REQUEST_FIELDS.flatMap(field => {
    const v = (frame as Record<string, unknown>)[field];
    return typeof v === "string" ? [v] : typeof v === "object" && v !== null ? Object.values(v).filter((x): x is string => typeof x === "string") : [];
  });
}

/** The ops a socket holding a thread's own token may send, and the whole of them: the door is shut and these are
 * the openings, so an op added later reaches no thread until somebody puts it here on purpose. A thread opens
 * threads and forks machines under its own root and reads the tree it is in; every reach into a workspace is
 * refused again by the tree rule, and every act by the guard, so this list is the outer door and not the only one.
 * What is deliberately not here: the image, whose manifest holds every version's snapshot and every sign-in sealed
 * into it, since a fork takes the image its own workspace's project runs and names none; sealing that image and
 * rolling its snapshots, the project goldens, the person's keys and their init, their preferences, their folders,
 * importing and exporting a folder, every road that hands out or takes away access to this host, the two roads that
 * move a running turn's access mode or answer a permission prompt, which are the person's guard on an agent and not
 * an agent's to lift, and the daemon channel, which carries the panes a person types into while a thread drives its
 * workspace through workspaces.exec and the session ops. */
export const THREAD_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.list",
  "status.subscribe",
  // Read ahead of every fork for whether this host forks at all and at which sizes, so the refusal for a host that
  // mints nothing comes in one sentence before any stage is streamed; the wsp command asks it under any token.
  "capabilities.get",
  "workspaces.landing",
  "workspaces.create",
  "workspaces.list",
  // Every verb a thread runs names its workspace as a person does, so the door that reads a name is open to the
  // same tokens the list is: the tree rule refuses the names outside it here exactly as it hides them there.
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.touch",
  "workspaces.wake",
  "workspaces.exec",
  // A thread's work leaves its workspace the one way any work does, as a branch on the project's remote: the tree
  // rule refuses every workspace but its own, and the guard reads the switch as it does for a fork.
  "workspaces.bringBack",
  "harnesses.list",
  "sessions.start",
  "sessions.list",
  "sessions.history",
  "sessions.interrupt",
  "sessions.steer",
  "sessions.rename",
];

/** The ops a computer the person paired may send with no role of its own, and the whole of them, for the reason
 * THREAD_OPS is a list: a deny list would let every op added later through by having been forgotten. Read at both
 * doors, the socket and the JSON routes, so a route added later is held by the op it stands for, and a route that
 * names none is held outright. What is here is listing, reading, watching and the management of wsp's own machines
 * and records, which touch no process and no computer of the person's and write this disk only where wsp's own
 * copies land: workspaces.create on a project here runs the copy verb and puts the copy beside the person's
 * folder, open by the owner's ruling. What is not: every op that starts or puts a hand on a process (a start, a
 * steer, a stop, an answer, an access change, a command, a bring back, a pane, and a thread's rename, which runs a
 * shell on the workspace's machine and writes the person's agent session file), every op that adds, changes,
 * dials, sweeps or lands a binary on a computer of the person's or clones onto one, every op that writes keys,
 * builds or seals an image, runs the sign-ins or costs money, and every op that reads or writes this computer's
 * disk outside wsp's own folders. The daemon channel's send and close ride a channel a refused open never gave
 * this socket. A role of the person's is where this list widens, per device. */
export const DEVICE_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.subscribe",
  "status.list",
  "capabilities.get",
  "ticket.issue",
  "places.list",
  "account.get",
  "devices.list",
  "devices.revoke",
  "workspaces.landing",
  "workspaces.create",
  "workspaces.list",
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.nap",
  "workspaces.wake",
  "workspaces.stopWake",
  "workspaces.restartDaemon",
  "workspaces.upgrade",
  "workspaces.updateImage",
  "workspaces.rename",
  "workspaces.look",
  "workspaces.agents",
  "workspaces.delete",
  "workspaces.forget",
  "workspaces.snapshot",
  "workspaces.touch",
  "workspaces.portReach",
  "workspaces.portProbe",
  "workspaces.rebuild",
  "projects.list",
  "projects.resolve",
  "projects.remove",
  "projectGoldens.list",
  "projectGoldens.remove",
  "sys.subscribe",
  "harnesses.list",
  "sessions.list",
  "sessions.history",
  "sessions.forget",
  "golden.get",
  "image.get",
  "snapshots.list",
  "snapshots.storage",
  "snapshots.rollback",
  "cost.history",
  "cost.spend",
  "forwards.list",
  "forwards.stop",
  "preferences.get",
  "preferences.set",
  "release.get",
  "release.check",
  "host.terminalConfig",
  "init.get",
];

/** The one sentence a thread's own token is refused an op with. It names the op rather than guessing why a caller
 * wanted it: the reasons are on the acts, and this is the door saying the op is not a thread's at all. */
export function threadOpRefusal(op: string, threadId: string): string {
  return `${op} is not a thread's to ask for; the token this request came in on is thread ${threadWord(threadId)} on a machine, which opens threads and forks machines under its own root and reads that tree`;
}

/** The workspace an event is about, for the one reading every door that hides a workspace from a caller shares: the
 * id on the event itself, else the id of the record or the status it carries. An event that names none is about
 * this host rather than about any workspace, which is why a caller that may see only its own tree is sent none. */
export function workspaceIdOf(event: unknown): string | undefined {
  const e = event as { workspaceId?: unknown; workspace?: { id?: unknown }; status?: { id?: unknown }; forward?: { workspaceId?: unknown } };
  for (const found of [e.workspaceId, e.workspace?.id, e.status?.id, e.forward?.workspaceId]) if (typeof found === "string") return found;
  return undefined;
}

/** The thread an event is on behalf of, beside the reading above and for the same door: an event about a workspace
 * that has no record yet is nobody's by the reading above, so the caller it was asked for by is named on it. */
export function askerOf(event: unknown): EventAsker | undefined {
  const asked = (event as { askedBy?: { threadId?: unknown; rootThreadId?: unknown } }).askedBy;
  if (typeof asked?.threadId !== "string" || typeof asked.rootThreadId !== "string") return undefined;
  return { threadId: asked.threadId, rootThreadId: asked.rootThreadId };
}
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

/** What a workspaces.exec pushes to the socket that asked. exitCode is null when the command was ended without
 * one (the socket closed or the launch failed); error says which. */
export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exec.output"), execId: z.string(), text: z.string() }),
  z.object({ type: z.literal("exec.exit"), execId: z.string(), exitCode: z.number().int().nullable(), error: z.string().optional() }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

export const RuntimeOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** `kind` carries a typed failure when the runtime has one (engine WspError
 * kinds such as "concurrency", or "notFirstLife" from a refused seal). */
export const RuntimeErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  kind: z.string().optional(),
  /** What to do about it, when the refusal was made with one; `error` already ends with it. */
  fix: z.string().optional(),
});
export const RuntimeResponse = z.union([RuntimeOkResponse, RuntimeErrorResponse]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;

// --- session interrupt (what a stop button gets back) -------------------------

/** accepted: the harness was told to stop and the turn ends with status interrupted.
 * not-running: the turn had already ended, so there was nothing to stop.
 * not-found: this runtime holds no such session (sessions live in memory; a restart forgets them).
 * None of these is an error reply: a stop button has nothing to recover from. */
export const SessionInterruptOutcome = z.enum(["accepted", "not-running", "not-found"]);
export type SessionInterruptOutcome = z.infer<typeof SessionInterruptOutcome>;
export const SessionInterruptResult = z.object({
  outcome: SessionInterruptOutcome,
  /** The threads under this one that were running and were stopped with it, by id: a root thread and the tree its
   * agents spawned stop as one, since a lead left standing while its builders are cut is neither state. Absent
   * where the thread spawned none that were running. */
  under: z.array(z.string()).optional(),
});
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;

// --- session steer (what send-now on a queued row gets back) -------------------

/** accepted: the harness took the message into the running turn and a session.steer event carries it.
 * not-running: the turn had ended, or had not started, when the message was offered; the caller starts a turn instead.
 * unsupported: the session's harness takes no message mid-turn (its catalog says steers: false).
 * not-found: this runtime holds no such session. None is an error reply. */
export const SessionSteerOutcome = z.enum(["accepted", "not-running", "unsupported", "not-found"]);
export type SessionSteerOutcome = z.infer<typeof SessionSteerOutcome>;
export const SessionSteerResult = z.object({ outcome: SessionSteerOutcome });
export type SessionSteerResult = z.infer<typeof SessionSteerResult>;

// --- session access (what a pick made while a turn runs gets back) ---------------------

/** The thread's record takes the mode on every answer but not-found, so its next turn runs at it whichever comes
 * back. set: the thread is at the mode now; on a running turn from its next tool call and on the prompt it was
 * stopped on where that mode answers one, a harness whose CLI takes the change only at launch set too by its
 * adapter answering that turn's prompts itself; on a thread between turns, from its next turn. unsupported: the
 * turn running now takes no access change and nothing could stand in for it, so it keeps the mode it started at
 * and the next turn runs at the pick. not-running: the running turn's process is gone before the pick reached it.
 * not-found: this runtime holds no such session. None is an error reply, as a mode the harness's own list does not
 * carry is. */
export const SessionAccessOutcome = z.enum(["set", "not-running", "unsupported", "not-found"]);
export type SessionAccessOutcome = z.infer<typeof SessionAccessOutcome>;
export const SessionAccessResult = z.object({ outcome: SessionAccessOutcome });
export type SessionAccessResult = z.infer<typeof SessionAccessResult>;

// --- session answer (what picking an option on a relayed permission prompt gets back) --

/** answered: the harness took the answer and the tool call it blocks ran or was refused as the option says, and a
 * session.permission.closed event carries it. gone: no such prompt is open on that session, so it was answered
 * already, withdrawn by the harness, or its turn is over; the row closes on that event, not on this reply.
 * unsupported: the session's harness raises no prompt this host can answer. not-found: this runtime holds no such
 * session. no-option: the prompt is open and carries no option by that id. None is an error reply. */
export const SessionAnswerOutcome = z.enum(["answered", "gone", "unsupported", "not-found", "no-option"]);
export type SessionAnswerOutcome = z.infer<typeof SessionAnswerOutcome>;
export const SessionAnswerResult = z.object({ outcome: SessionAnswerOutcome });
export type SessionAnswerResult = z.infer<typeof SessionAnswerResult>;

// --- session rename (what a name a person typed came to in the harness's store) -

/** renamed: the harness's store took the name, in the field the harness itself writes, and the thread's rows carry
 * it. unsupported: the session's harness keeps no name of a person's, so nothing was written and nothing would have
 * survived its next turn. no-session: the store answered and holds no such session, or the harness never announced
 * one for this thread. failed: the store was there and refused the write, and `error` is the line the machine gave
 * for it. not-found: this runtime holds no such session. None is an error reply. */
export const SessionRenameOutcome = z.enum(["renamed", "unsupported", "no-session", "failed", "not-found"]);
export type SessionRenameOutcome = z.infer<typeof SessionRenameOutcome>;
export const SessionRenameResult = z.object({ outcome: SessionRenameOutcome, error: z.string().optional() });
export type SessionRenameResult = z.infer<typeof SessionRenameResult>;

// --- session start (how the turn the caller asked for came to be) --------------

/** started: a turn of its own began. steered: the thread's turn was running and took the message mid-way, so
 * session is that turn and a session.steer event carries the message. queued: the thread's turn was running and could
 * not take a message, so this start waited for it to end and then began. The reply comes back once the turn began.
 * turnId is the turn's, as its events carry it: a follower keys on it, since the thread's earlier turns share the
 * session row. */
export const SessionStartOutcome = z.enum(["started", "steered", "queued"]);
export type SessionStartOutcome = z.infer<typeof SessionStartOutcome>;
export const SessionStartResult = z.object({ session: SessionView, outcome: SessionStartOutcome, turnId: z.string() });
export type SessionStartResult = z.infer<typeof SessionStartResult>;

// --- snapshot lineage (golden manifest as the rollback UI reads it) -----------

/** Every sealed version of one golden and the head new forks use. head is null
 * while the golden has never been sealed. The manifest is the truth here, never
 * a backend snapshot listing (list() is best-effort). */
export const SnapshotLineage = z.object({
  name: z.string(),
  head: z.number().nullable(),
  versions: z.array(GoldenVersion),
});
export type SnapshotLineage = z.infer<typeof SnapshotLineage>;

/** A workspace's disk with its project loaded, snapshotted so forks start a task with the project in place and no
 * upload. `golden` is the snapshot of the golden version at the root of its lineage, whatever it was forked from, so the
 * Lineage section lists it under that version; `version` is that version's number when a manifest knows the snapshot. */
export const ProjectGolden = z.object({
  snapshotId: z.string(),
  /** Every project on the disk when it was taken, oldest import first: a snapshot is the whole machine, so a fork of
   * it starts with all of them. The snapshot is named after the one the default folder rule would start a thread in. */
  projects: z.array(WorkspaceProject),
  golden: z.string(),
  version: z.number().int().optional(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  createdAt: z.string(),
  /** The place whose provider holds the snapshot; absent on one taken before places, which is the wired provider's. */
  place: z.string().optional(),
});
export type ProjectGolden = z.infer<typeof ProjectGolden>;

/** What a project golden's removal answers: the record that left, and whether the provider had already lost the
 * snapshot rather than deleting it now. */
export const ProjectGoldenRemoved = z.object({ projectGolden: ProjectGolden, alreadyGone: z.boolean() });
export type ProjectGoldenRemoved = z.infer<typeof ProjectGoldenRemoved>;

/** A project golden as the image view lists it: the record, and its size where the place's provider lists one. */
export const SealedProjectImage = ProjectGolden.extend({ sizeBytes: z.number().optional() });
export type SealedProjectImage = z.infer<typeof SealedProjectImage>;

/** What Settings > Image and `wsp image` draw: the record, every copy at every place, the project goldens under it.
 * Beside ProjectGolden because it carries them; the rest of the image shapes sit with the golden ones above. */
export const SealedImageView = z.object({
  image: SealedImage.nullable(),
  copies: z.array(SealedImageCopy),
  projects: z.array(SealedProjectImage),
});
export type SealedImageView = z.infer<typeof SealedImageView>;

/** One part of the listing: how many snapshots and what they hold. */
export const SnapshotGroup = z.object({ count: z.number(), bytes: z.number() });
export type SnapshotGroup = z.infer<typeof SnapshotGroup>;

/** Every snapshot on the account as the provider bills it: a snapshot is a full disk image, the free GB are shared
 * by all of them, and the rest costs usdPerGbMonth from billedFrom. Sizes come from the provider's snapshot
 * listing, never from a machine's requested disk. The three groups split that sum by who made each snapshot, since
 * the account is shared and the bill is not. */
export const SnapshotStorage = z.object({
  count: z.number(),
  totalBytes: z.number(),
  freeGb: z.number(),
  usdPerGbMonth: z.number(),
  billedFrom: z.string(),
  monthlyUsd: z.number(),
  /** This host's and in use: a golden version, a project golden or a live workspace names it, or this host took it
   * inside the grace a seal needs before the manifest records it. */
  kept: SnapshotGroup,
  /** This host's mark on the name and nothing names the id: what wsp doctor offers to delete. */
  orphans: SnapshotGroup,
  /** No mark of this host: another host's or a person's own, never touched. */
  others: SnapshotGroup,
});
export type SnapshotStorage = z.infer<typeof SnapshotStorage>;

/** Rollback only moves head. Workspaces already forked keep their machines and
 * image; the field says so on the wire so no client reads it as a fleet change. */
export const SnapshotRollbackResult = z.object({
  lineage: SnapshotLineage,
  existingWorkspaces: z.literal("untouched"),
});
export type SnapshotRollbackResult = z.infer<typeof SnapshotRollbackResult>;

/** The create's own answer: the workspace, and what the runtime had to do to make room for it (a builder kept
 * after a save, stopped at the machine cap), so the person who asked reads why. Absent when nothing was stopped. */
export const WorkspaceCreateResult = z.object({ workspace: WorkspaceView, notice: z.string().optional() });
export type WorkspaceCreateResult = z.infer<typeof WorkspaceCreateResult>;

export { needsYouLine, threadState, threadStateWord, threadWordOf, waitingLine, type ThreadState } from "./thread-state.js";
export { MCP_SERVER_NAME, threadsFollowed } from "./wsp-tools.js";
export { type AbsentComputer, type AwayWord, absentComputer, actionRefusal, daemonSilent, ownDaemonDown, START_DAEMON_WORD, agentsKindRefusal, agentsMayDrive, awayMsOf, composerHeldLine, computerOffline, deleteNotice, onDeleteOf, goneRefusal, COMPUTER_LEFT, notAnsweringYet, screenCommandLine, type ImageMoveInput, imageMoveRefusal, isBilling, isLocalWorkspace, turnSpendWord, type KindReading, kindWords, readingRoad, type ReadingRoad, type MachineOnDelete, machineWord, needsRebuild, FORGET_NEEDS_GONE, goneRoadRefusal, reachShown, SEND_BLOCK_WORDS, type SendBlock, sendRefusal, signInRefusalLine, signInRoad, type SendRefusalKind, servesReading, workspaceAccess, WORKSPACE_KIND_WORDS, workspaceKind, type WorkspaceKindWords, workspaceState, type WorkspaceState, type WorkspaceStateInput, whereWord, workspaceStateLine, workspaceStateOf, workspaceWord, type AbsentRoad, type AbsentRoadInput, absentRoad, BACK_OVER_SSH, backUrl, dialsBackWord, linkedOver, lastKnown, REPORTED_WORD, placeDialLine, placeNoDialLine, placeDialRoad, sshRoadOf, type PlaceDialRoad } from "./workspace-state.js";
export * from "./agents-report.js";
export * from "./exit.js";
export * from "./format.js";
export { psCpuSeconds } from "./ps-time.js";
export { compareVersions } from "./semver.mjs";
export { IMAGES_AFTER_TURN, IMAGES_MAX, IMAGE_ACCEPT, IMAGE_MAX_BYTES, IMAGE_MAX_WORDS, IMAGE_TYPES, IMAGE_TYPE_WORDS, ImageAttachment, ImageRecord, imageBytes, imageLine, imagePathIn, imageRecord, imageTypeOf, imagesBlocked, imagesRefusal, noImagesLine, notAFileLine, notAnImageLine, threadImagesDir, turnImagesDir } from "./attachments.js";
export * from "./oom.js";
export { accruedAt, appendCostPoint, COST_HISTORY_CAP, monthStart, rateAt, spentSince } from "./cost-history.js";
export { leadAsk, openAsk, ThreadMessage, threadMessages, threadReplyRows, threadResult, ThreadVoice } from "./thread-read.js";
export { inFolder, shellLine, shellQuote } from "./shell-quote.js";
export {
  DEFAULT_THEME,
  INK_FLOOR,
  LOOK_PARTS,
  SIDE_INK,
  THEME_GRAIN_STEPS,
  THEME_HARMONIES,
  THEME_MAX_DOTS,
  THEME_MIN_OPACITY,
  THEME_PRESETS,
  WORD_FLOOR,
  ThemeDot,
  ThemeHarmony,
  ThemeMode,
  WORKSPACE_GLYPHS,
  WorkspaceGlyph,
  WorkspaceLook,
  WorkspaceTheme,
  applyPreset,
  contrastRatio,
  cycleHarmony,
  dotColour,
  effectiveOpacity,
  harmoniesOf,
  harmonyDots,
  harmonySize,
  hslToRgb,
  isPreset,
  moveFirstDot,
  opacityCap,
  resizeDots,
  rgbToHsl,
  snapGrain,
  themeInk,
  themeScheme,
  type LookPart,
  type Rgb,
  type ThemePreset,
} from "./workspace-look.js";
export { claudeMemoryDir, claudeProjectKey, copyPathFor, folderName, folderSlug, hiddenFolder, parentFolderName, placeDaemonPaths, placeOwnedPaths, placeProvisionPaths, probePath, rootsPathIn, sshDaemonPaths, standInMachinePath, standInRecordsPath, underProject, workFolderIn, type FolderMachine } from "./project-path.js";
export * from "./bring-back.js";
export * from "./daemon-contract.js";
export * from "./projects.js";
export { defaultSeedChoice, leftBehindLine, neverTravelsLine, noRemoteLine, notInTheMenuLine, SEED_DIR, SEED_MEMORY_DIR, SEED_PATCH, seedBytes, seedChoiceFrom, seedCommitsLandedLine, seedCommitsLostLine, seedConsentLines, seedingLine, seedMenuRows, seedRowWords, seedSummaryLines } from "./project-seed.js";
export { agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, importConsented, importRequest, secretOffer, type ImportAnswers, type ProjectImportRequest } from "./project-import.js";
export { addressFromHash, appHash, openingHash, pairingCodeOf, workspaceHash, type AppAddress } from "./app-address.js";
export * from "./app-ports.js";
export * from "./release.js";
export * from "./init-job.js";
export { catalogRefused, endAfterResult, endRun, PERMISSION_ALLOW, PERMISSION_DENY } from "./adapter-port.js";
export { LAUNCH_ENV, SCOPED_MCP_ARG, FAKE_AS_ENV, FAKE_RECORDS_ENV, FAKE_ROOT_ENV, FORWARD_ENV, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LABS_ENV, PERSON_HOME_ENV, RELEASE_API_ENV, TURN_TOKEN_ENV, UPDATE_CHECK_ENV, WEB_DIR_ENV } from "./env.js";
export type { AdapterAttachOptions, AdapterEvent, AttachmentRoad, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, HarnessCatalogModelProbe, HarnessCatalogProbe, HarnessCatalogRefusal, PermissionAsk, SessionRenameWrite, SessionRenamer, SessionTitleMaker, SessionTitleReader, TitleTurn, TurnImage } from "./adapter-port.js";
