// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { homedir, networkInterfaces, platform } from "node:os";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { CREATED_AT_LABEL, HOST_LABEL, SMOKE_LABEL, WSP_LABEL, agentHomes, type ProvisionPlan } from "@wsp/engine";
import { API_UNAUTHORIZED, BOOT_SCRIPT, DEFAULT_PORT, DEVICE_OPS, deviceHeldRefusal, DEFAULT_WS_PORT, PAIR_CODE_TTL_MS, PLACES_WORDS, PLACE_PORT_OFFSET, REQUEST_BODY_MAX_BYTES, REQUEST_BODY_NOT_JSON, REQUEST_BODY_TOO_LARGE, REQUEST_NOT_AN_OBJECT, WILDCARD, WS_PATH, authority, crossOriginRefusal, doorPortHeldLine, isLoopback, isObjectFrame, joinAddressOf, servedHostname, noSuchPlaceRefusal, recordRestoredLine, peerAddress, relayUrlOf, scopeOf, type BootPayload, type DoctorLineEvent, type Caller, type PlaceDoorView, type ProjectImportResult, type ProjectPlan, type ProjectView, type WorkspaceView, kindForComputer, nameTheProjectLine, copiesFolder } from "@wsp/protocol";
import { sshHostsIn } from "./ssh-hosts.js";
import { LOOPBACK, describeAge, goldenHead, serveRuntime, threadOf, tokenDigest, type AdmittedDevices, type CreatedWorkspace, type GoldenBuilderView, type GoldenVersion, type InitDoor, type PlaceBackHolder, type PlaceDoctor, type PlaceDoorControl, type ProjectBundler, type ProjectImportOptions, type ReapedMachine, type RestartDoor, type Runtime, type RuntimeServer, type SparedMachine } from "@wsp/runtime";
import { computerDoctor } from "./doctor.js";
import { advertiseWord, hereUrl, reachAddresses, type HereAt } from "./pairing.js";
import { NO_PROJECT_YET } from "./verbs.js";
import { accountHere, publicHostname } from "./relay-link.js";
import { wspHome } from "./hosts.js";
import { nodeHost, readGhosttyConfig } from "@wsp/collect";
import { closeStandInGuests } from "./fake-guest.js";
import { hostFolders } from "./host-folders.js";
import { projectBundler } from "./project-bundle.js";
import { imageExporter } from "./image.js";
import { projectLander } from "./project-export.js";
import { alsoHere } from "./scan.js";
import { guestCli } from "./guest-cli.js";
import { guestMcp, hereMcp } from "./guest-mcp.js";
import { guestDoor } from "./guest.js";
import { runningWsp } from "./mcp-install.js";
import { startCallbackRelay, systemOpener, type UrlOpener } from "./relay.js";
import { NO_PROVIDER } from "./providers.js";
import type { ReleaseWatch } from "./release.js";
import { describeStorage, noProviderStorageLine } from "./storage.js";
import { VERSION } from "./version.js";

// The enriched status now lives in @wsp/runtime (every client reads one
// implementation); re-exported so host consumers keep their imports.
export type { ReachState, ReachStatus, WorkspaceStatus } from "@wsp/runtime";

export interface HostOptions {
  runtime: Runtime;
  /** The built web app: index.html plus its assets. */
  webDir: string;
  /** HTTP port for the app (0 picks a free one). Default DEFAULT_PORT. */
  port?: number;
  /** Port for serveRuntime's WS (0 picks a free one). Default DEFAULT_WS_PORT. */
  wsPort?: number;
  /** The address both servers bind. Default LOOPBACK; anything else serves a page that pairs for a device token of
   * its own. No page on any address carries the host's token, and every JSON route asks for a token. */
  listen?: string;
  /** The address the person named with --advertise. It leads the addresses a computer you own is told to dial,
   * since somebody who names an address has said which one the other end can reach; what this computer answers on
   * follows it, so a word that turns out to be wrong is not the only road back. */
  advertise?: string;
  /** Filled with the runtime socket's loopback address once it binds, for the runtime this host serves to hand a
   * turn on this computer: the same value the guest door hands a session. */
  here?: HereAt;
  /** Auth token for the runtime WS; generated when omitted. */
  authToken?: string;
  /** Envs baked into a workspace created from the JSON route, given the golden version it forks. */
  workspaceEnvs?: (golden: GoldenVersion) => Record<string, string>;
  probeTimeoutMs?: number;
  /** Receives one line per machine a sweep killed, one per running machine the first sweep left alone, and one when a sweep fails;
   * also one per sign-in page opened, per port forwarded, refused or closed, and per frame the runtime refused. */
  log?: (line: string) => void;
  /** Opens a guest tool's sign-in URL on this computer; the platform opener by default (the desktop app passes its own). */
  openUrl?: UrlOpener;
  /** Whether a workspace's sign-in page opens here without a click; off by default, the app shows it instead. */
  autoOpen?: (workspaceId: string, url: string, port?: number) => boolean;
  /** The line logged when a sign-in page arrives and nothing opens, given the workspace name and the page's hostname. */
  openLine?: (workspace: string, hostname: string, url: string) => string;
  /** The saved recipe file, read for the terminal font its ticks name. */
  recipePath?: string;
  /** The state file this host serves, named in the boot object so the page scopes its memory to it. */
  statePath?: string;
  /** The init job on this computer, served to the app as the init.* ops and the init.job events; absent, they are refused. */
  init?: InitDoor;
  /** Whether the door a computer you own dials is bound as this host starts. Open when a joined computer is on
   * record: it dials the port its place file names, and a laptop coming back must find that port there. */
  door?: "closed" | "open";
  /** The line said the first time the door binds, so a person reads about the firewall prompt where they asked. */
  doorLine?: (line: string) => void;
  /** The forwards over ssh that land on the door: handed the door as this host holds it, and let go before it closes. */
  back?: Pick<PlaceBackHolder, "door" | "close">;
  /** What the doctor's computer road reads on this host beside the runtime, for the places.doctor op; absent, the
   * op is refused and no computer this host holds is proved from here. */
  doctor?: HostDoctorReaders;
  /** The provider row this host is wired to, read off the environment it picked its module out of. The row that
   * holds no machine asks no account anything, so this start lists no snapshots and says so. */
  provider?: string;
  /** What this host knows of the account's own computers, for the door a computer with no code comes in by: the
   * key it trusts to sign an admission and the listing its heartbeat reads back. Without it device.auth is
   * refused, which is what a host on no account answers. */
  admitted?: AdmittedDevices;
  /** The reading of the newest release this host serves as release.get and release.check; started once the host
   * serves and stopped with it. Absent, both ops are refused. */
  release?: ReleaseWatch;
  /** How this host restarts itself for host.restart; absent, the op is refused. */
  restart?: RestartDoor;
}

/** The two readings the doctor's computer road needs of the host it runs on: what the vault holds right now, read
 * at the ask rather than copied, and the recipe this computer holds planned for a computer somebody owns. The plan
 * is the host's own place wiring's, so the recipe job and this road cannot read this computer two ways; a host
 * whose wiring plans none leaves the step saying so. */
export interface HostDoctorReaders {
  vault(): Readonly<Record<string, string>>;
  plan?(): Promise<ProvisionPlan | { noRecipe: string }>;
}

/** The roads to a workspace and its project that the app's routes and wsp init share, so a workspace made without a
 * host is the one the app would have made. */
export interface WorkspaceRoads {
  /** Forks the golden's head into a new workspace, with the envs and labels the app's own create gives it. The
   * caller is who asked, so a route reached with a thread's own token is held to what that thread may do. */
  createWorkspace(name: string, caller?: Caller, project?: string): Promise<CreatedWorkspace>;
  /** Records a project, the road every workspace starts from: a folder on this computer, or a repo a computer
   * clones when `on` names one. */
  addProject(source: string, on?: string, caller?: Caller): Promise<ProjectView>;
  /** Makes this computer the one local workspace, as the app's own This computer row does; it forks nothing and
   * needs no golden, so it is the one road into an empty state. */
  /** Reads a folder on this computer as the app's import dialog reads it; nothing is packed or uploaded. */
  planProject(source: string): Promise<ProjectPlan>;
  /** Lands that folder on a workspace's machine through the bundler the app's import goes through. */
  importProject(opts: Omit<ProjectImportOptions, "bundler">): Promise<ProjectImportResult>;
}

export interface HostHandle extends WorkspaceRoads {
  port: number;
  wsPort: number;
  authToken: string;
  /** Takes one device's token away and cuts the sockets it held, the same road the op takes: what the heartbeat's
   * reconcile of the account's own listing comes through, so a device the account dropped goes as one revoked at
   * the terminal goes. */
  revokeDevice(id: string): Promise<boolean>;
  /** A pairing code whose device is read as the owner: what wsp init mints for the browser it opens, through the
   * handle it holds as it makes the first workspace, so the person who ran init never meets a pair screen. */
  hereCode(): Promise<string>;
  /** The door a computer you own dials: opened on the first ask and held open for this host's life, since a place
   * file on another computer names its port for good. */
  door: PlaceDoorControl & { close(): Promise<void>; port(): number | undefined };
  close(): Promise<void>;
}

/** What this host answers about the door a computer you own dials: where it is, and nothing about the key proved
 * there, which the runtime reads off the pair its place door signs with. */
type DoorAt = Omit<PlaceDoorView, "hostKey"> & { backPort?: number };

/** Orphan sweep period after the one at start. Matches the age a stray
 * workspace machine must reach before reap treats it as abandoned. */
export const REAP_INTERVAL_MS = 10 * 60_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The ticked shell row's font from the saved recipe; nothing when the file is missing, unreadable or names none. */
function terminalFontOf(recipePath: string | undefined): string | undefined {
  if (recipePath === undefined) return undefined;
  try {
    const data = JSON.parse(readFileSync(recipePath, "utf8")) as { entries?: { rung?: unknown; bring?: unknown; font?: unknown }[] };
    const row = data.entries?.find(e => e.rung === "shell" && e.bring === true && typeof e.font === "string" && e.font !== "");
    return row?.font as string | undefined;
  } catch {
    return undefined;
  }
}

/** JSON fit for an inline script: the font family comes from a config file, so `<` and the line terminators JSON allows
 * but a script does not are written as escapes, and no value can end the script or the page. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function loadPage(webDir: string, boot: BootPayload): string {
  const path = join(webDir, "index.html");
  if (!existsSync(path)) throw new Error(`web app not built: ${path} is missing (pnpm --filter @wsp/web build)`);
  const html = readFileSync(path, "utf8");
  // The dev default apps/web/index.html ships is swapped for the real boot object, so the page carries exactly one
  // inline script. Written through a function, since a token or a path may hold what a replacement string reads.
  if (!BOOT_SCRIPT.test(html)) throw new Error(`${path} has no window.__WSP__ boot line to replace`);
  return html.replace(BOOT_SCRIPT, () => `<script>window.__WSP__ = ${inlineJson(boot)};</script>`);
}

/** Whether the connector forwarded this request, rather than a process on the computer this host runs on: what
 * cloudflared puts on everything it carries. Either header on its own is enough, since the cost of reading a
 * request as forwarded when it was not is a pairing code, and the cost the other way is the page's token. Nobody
 * talks their way in with a header either: a process that can already reach this loopback port is on this
 * computer, and adding them only takes the token away from itself. */
function throughConnector(req: IncomingMessage): boolean {
  return req.headers["cf-connecting-ip"] !== undefined || req.headers["cf-ray"] !== undefined;
}

/** Whether a request reached this host over the road it serves its own workspaces' guests on: a process on the
 * computer this host runs on, dialling the loopback the guest tool server and the guest command line dial once the
 * guest door has read which workspace the token was minted for. A token scoped to a thread is minted into one turn
 * and comes back by that road alone, so one arriving by any other is a copy carried out of a machine and names
 * nobody here. A request on the door's listener is never that road whatever its peer, since a reverse forward
 * into the door lands from the loopback too. The one home of that rule: the socket door and the JSON routes both
 * read this, so neither can stay open while the other closes. */
function ownRoad(req: IncomingMessage, door: WeakSet<Socket>): boolean {
  return !door.has(req.socket) && !throughConnector(req) && isLoopback(peerAddress(req.socket.remoteAddress));
}

/** Where a request came from: the address the connector names for the peer it carried, else the socket's own peer.
 * Cloudflare writes that header over any a client sends, but a box on the door or on the main port of a host bound
 * beyond loopback writes every header it sends, so the header is read only off a loopback peer the door did not
 * let in, and only when it is an address. */
function peerOf(req: IncomingMessage, door: WeakSet<Socket>): string {
  const peer = peerAddress(req.socket.remoteAddress);
  const carried = req.headers["cf-connecting-ip"];
  return typeof carried === "string" && isIP(carried) !== 0 && !door.has(req.socket) && isLoopback(peer) ? carried : peer;
}

/** The name in the Host header, without the port an authority carries: what the request asked for, which is not
 * what this host bound. A request naming nothing has no name here, and everything below reads that as not here. */
function hostnameAsked(req: IncomingMessage): string | undefined {
  return servedHostname(`http://${req.headers.host ?? ""}`);
}

/** Whether a request may write here or open a socket: one carrying no Origin is a tool on this computer, a daemon
 * link or a place join, and is what it always was; one carrying an Origin is a page, and a page drives only the
 * host it was served by. Hostnames and not ports, since the page on the app's port dials the runtime's. */
function originAllows(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === "") return true;
  const from = servedHostname(origin);
  const at = hostnameAsked(req);
  return from !== undefined && at !== undefined && from === at;
}

/** The token an Authorization header carries, or nothing when it carries none in the one scheme this host takes.
 * A bearer never rides the URL here, where a proxy log would keep it. */
function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendAsset(res: ServerResponse, webDir: string, path: string): boolean {
  const file = resolvePath(webDir, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length });
  res.end(body);
  return true;
}

function describeLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  return ` (${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(" ")})`;
}

function describeCost(rateUsdPerHour: number, ageMs: number | undefined): string {
  const rate = `$${rateUsdPerHour.toFixed(2)}/h`;
  return ageMs === undefined ? rate : `${rate} (about $${((Math.max(0, ageMs) / 3_600_000) * rateUsdPerHour).toFixed(2)} so far)`;
}

function kindOf(labels: Record<string, string> | undefined, builder: boolean): string {
  if (builder) return "builder";
  return labels?.[SMOKE_LABEL] === "1" ? "smoke fork" : "workspace";
}

function describeReaped(r: ReapedMachine): string {
  const kind = kindOf(r.labels, r.builder);
  if (r.reason === "recorded") return `reap: stopping ${r.id}: your earlier builder from this setup; a builder cannot be sealed after a restart`;
  if (r.reason === "unfinished") return `reap: stopping ${r.id}: your earlier builder from this setup; its setup never finished`;
  if (r.reason === "expired" && r.ageMs === undefined) return `reap: stopping ${r.id}: your earlier builder from this setup, age unknown; a kept builder with no readable age is stopped at once`;
  if (r.reason === "expired") return `reap: stopping ${r.id}: your earlier builder from this setup, ${describeAge(r.ageMs)}; a kept builder is stopped at six hours`;
  if (r.reason === "grace") return `reap: stopping ${r.id}: the builder kept after the save for one more change; its ten-minute window is over`;
  const why = r.reason === "own" ? `${kind} from this setup that no record claims` : `${kind} with no owner`;
  return `reap: stopping ${r.id}${describeLabels(r.labels)}: ${why}, ${describeAge(r.ageMs)}`;
}

function describeSpared(m: SparedMachine): string {
  const kind = kindOf(m.labels, m.builder);
  const cost = describeCost(m.rateUsdPerHour, m.ageMs);
  if (m.whose === "foreign") {
    return `reap: left alone ${m.id}: ${kind} from another wsp setup (owner ${m.owner}), ${describeAge(m.ageMs)}, ${cost}; kill it from the Solari console if it is yours and forgotten`;
  }
  const who = m.whose === "own" ? `${kind} from this setup that no record claims` : `${kind} with no owner`;
  // An own workspace is recorded once its create grace is over; an own builder or smoke fork is killed then.
  if (m.whose === "own" && kind === "workspace") return `reap: left alone ${m.id}: ${who}, ${describeAge(m.ageMs)}, ${cost}; recorded once it is ${describeAge(m.backstopMs)} unless a record claims it first`;
  const claim = m.whose === "own" ? " unless a record claims it first" : "";
  const then = m.ageMs === undefined ? "never reaped by this host" : `reaped once it is ${describeAge(m.backstopMs)}${claim}`;
  return `reap: left alone ${m.id}: ${who}, ${describeAge(m.ageMs)}, ${cost}; ${then}`;
}

/** A builder from an earlier run that can still be sealed is claimed, so the sweep never names it; the person still sees what bills. */
function describeKept(b: GoldenBuilderView, rateUsdPerHour: number): string {
  const ageMs = Date.now() - Date.parse(b.createdAt);
  return `reap: left alone ${b.id}: your earlier builder from this setup, still sealable, ${describeAge(ageMs)}, ${describeCost(rateUsdPerHour, ageMs)}; reuse it with wsp init, or it is stopped at six hours`;
}

/** A builder kept after its save is claimed, so the sweep never names it; the person still sees what bills and why. */
function describeSealed(b: GoldenBuilderView, sealed: { at: string; version: number }, rateUsdPerHour: number): string {
  const ageMs = Date.now() - Date.parse(b.createdAt);
  const since = describeAge(Date.now() - Date.parse(sealed.at)).replace(/ old$/, "");
  return `reap: left alone ${b.id}: your builder saved as image v${sealed.version}, kept ${since} since the save and holding one of the account's machine slots, ${describeCost(rateUsdPerHour, ageMs)}; wsp init updates your image on it, or it is stopped ten minutes after the save`;
}

/** Kills what this host owns and nothing claims, says which machines it is stopping and
 * why, and on the first sweep names the running machines it left alone. */
async function sweepOrphans(rt: Runtime, log: (line: string) => void, listSpared: boolean): Promise<void> {
  try {
    const { reaped, spared, failed, adopted } = await rt.reap(undefined, line => log(`reap: ${line}`));
    for (const a of adopted ?? []) log(recordRestoredLine(a.id, a.name, a.workspaceId));
    for (const r of reaped) log(describeReaped(r));
    if (listSpared) for (const m of spared) log(describeSpared(m));
    // Each failure names its own verb (could not stop, not recorded); the host adds the machine and nothing else.
    for (const f of failed ?? []) log(f.id !== undefined ? `reap: ${f.id}: ${f.message}` : `reap: sweep failed: ${f.message}`);
  } catch (e) {
    log(`reap: sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

class NoGoldenError extends Error {
  constructor() {
    super("no image yet; run wsp init first");
  }
}

/** `homes` is where each agent keeps its sessions on this computer, what the bundler carries beside a folder. */
export function workspaceRoads(rt: Runtime, homes: Readonly<Record<string, string>>, opts: Pick<HostOptions, "workspaceEnvs"> = {}): WorkspaceRoads & { bundlerFor(source: string): ProjectBundler } {
  // One bundler road for the app's import op and the handle's own: a folder is read and packed the same either way.
  const bundlerFor = (source: string) => projectBundler(source, homes);
  return {
    bundlerFor,
    addProject: (source, on, caller) => rt.projects.add({ source, ...(on !== undefined ? { on } : {}) }, caller),
    createWorkspace: async (name, caller, named) => {
      // A workspace is one project's copy. A road that names none takes the only project there is and refuses in
      // the same sentence the command line uses when there are several.
      const all = await rt.projects.list(caller);
      // A road that names none is forking, so the projects it can mean are the ones on a computer that forks: a
      // folder here is copied, never forked, and is never what a fork was asked for.
      const held = named === undefined ? all.filter(p => !copiesFolder(kindForComputer(p.computer))) : all;
      const project = named === undefined ? held[0] : held.find(p => p.id === named || p.name === named);
      if (project === undefined || (named === undefined && held.length !== 1)) throw new Error(held.length === 0 ? NO_PROJECT_YET : nameTheProjectLine(held.map(p => p.name)));
      const head = goldenHead(await rt.golden.get());
      // A copy of a folder here forks nothing, so it needs no image; every other computer's copy does.
      if (!head && !copiesFolder(kindForComputer(project.computer))) throw new NoGoldenError();
      return rt.workspaces.create(
        {
          project: project.id,
          // A thread forks the image its own workspace's project runs and is refused where it names one, so the
          // head this host holds rides only the person's own create.
          ...(head !== undefined && scopeOf(caller) === undefined ? { golden: head.snapshotId } : {}),
          name,
          ...(opts.workspaceEnvs !== undefined && head !== undefined ? { envs: opts.workspaceEnvs(head) } : {}),
          labels: { [WSP_LABEL]: "1", [HOST_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
        },
        caller,
      );
    },
    planProject: source => bundlerFor(source).plan(),
    importProject: o => rt.projects.import({ ...o, bundler: bundlerFor(o.source) }),
  };
}

/** The JSON routes by the op each stands for on the socket, so the door a paired device meets here is the door it
 * meets there: a route added later names its op on this table and is held by the same list, and until it does a
 * paired device is refused it by its own name. */
export const ROUTE_OPS: Readonly<Record<string, string>> = {
  "GET /api/workspaces": "status.list",
  "POST /api/workspaces": "workspaces.create",
};

/** What a caller is refused a route with, or nothing: a computer the person paired is held to the list of ops a
 * device may send, read by the op the route stands for and answered in the sentence the socket answers with. A
 * route with no op of its own is shut to such a device, so a route added later cannot be forgotten open. */
export function routeRefusal(route: string, caller: Caller | undefined): string | undefined {
  if (caller !== "paired") return undefined;
  const op = ROUTE_OPS[route];
  return op !== undefined && DEVICE_OPS.includes(op) ? undefined : deviceHeldRefusal(op ?? route);
}

/** A request's body as fields to read, or the status and the sentence the route answers instead: past the cap, no
 * JSON at all, or JSON of another shape. The one reading a route takes a body through, so no route reads a field
 * off a null and none of the three arrives as an exception the catch-all prints back to whoever sent it. */
async function readJsonBody(req: IncomingMessage): Promise<{ body: Record<string, unknown> } | { status: number; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > REQUEST_BODY_MAX_BYTES) return { status: 413, error: REQUEST_BODY_TOO_LARGE };
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return { status: 400, error: REQUEST_BODY_NOT_JSON };
  }
  return isObjectFrame(parsed) ? { body: parsed } : { status: 400, error: REQUEST_NOT_AN_OBJECT };
}

/** Where a computer you own is told to dial this host, in the order its link tries them: the address the person
 * named with --advertise first, since somebody who names one has said which one the other end can reach, and what
 * this computer answers on after it, so a word that turns out to be wrong is not the only road back. The named word
 * is read the one way an address a person types is read; a word that is no address is left out rather than handed
 * to a box as one. A named address on this computer's own loopback is handed out here and refused by name at the
 * install, which is the one road that knows whether the computer being joined is this one: filtering it here would
 * drop it before anybody could be told it reaches nothing. */
export function doorAddresses(bound: string, port: number, advertise?: string, interfaces?: ReturnType<typeof networkInterfaces>): string[] {
  const named = joinAddressOf(advertiseWord(advertise) ?? "");
  const own = reachAddresses(bound, interfaces).map(address => `http://${authority(address, port)}`);
  return [...(named === undefined ? [] : [named]), ...own.filter(at => at !== named)];
}

export async function startHost(opts: HostOptions): Promise<HostHandle> {
  const rt = opts.runtime;
  const authToken = opts.authToken ?? randomBytes(24).toString("base64url");
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2500;
  const webDir = resolvePath(opts.webDir);
  const log = opts.log ?? (() => {});

  const homes = agentHomes(homedir());
  const { bundlerFor, addProject, createWorkspace, planProject, importProject } = workspaceRoads(rt, homes, opts);

  const address = opts.listen ?? LOOPBACK;
  // Reaching the loopback port is not being the person: another login on this computer reaches it too. The loopback
  // page carries the digest of the token for the shell to compare and never the token; beyond it the page pairs
  // for a device token first. Every JSON route asks for a token on every address.
  const boundHere = isLoopback(address);
  let rtServer: RuntimeServer;
  const here: HereAt = opts.here ?? {};
  // The guest door opens with the relay, ahead of the runtime socket whose port the loopback address names, so a
  // session that arrives in between waits for the bind rather than reading a host with no loopback.
  let bound!: () => void;
  const binding = new Promise<void>(done => (bound = done));

  // The wsp a process inside a machine runs, served here: the tool server and the command line, on the link the
  // relay below holds into that machine. The socket and its port are read at each call because the relay starts
  // ahead of them, and a session's verbs dial this host's own loopback rather than the address it advertises.
  const statePath = opts.statePath;
  const guest =
    statePath === undefined
      ? undefined
      : guestDoor({
          authorize: token => rtServer.authorize(token),
          hostUrl: () => binding.then(() => here.url),
          kinds: { mcp: guestMcp(statePath), cli: guestCli(statePath, runningWsp()) },
        });
  // Before the runtime socket: the app lists and stops the relay's forwards through it.
  const relay = startCallbackRelay({
    runtime: rt,
    openUrl: opts.openUrl ?? systemOpener(),
    log,
    places: true,
    ...(guest !== undefined ? { guest } : {}),
    ...(opts.autoOpen !== undefined ? { autoOpen: opts.autoOpen } : {}),
    ...(opts.openLine !== undefined ? { openLine: opts.openLine } : {}),
  });

  // Rendered per request: wsp init saves the recipe while a host may already be serving.
  // `here` is false on the door a computer you own dials: that page is the pairing screen and carries nothing of
  // this computer, neither the token's digest nor the state file's path nor the runtime's own port, whatever the
  // address this host bound says. The loopback page writes the port first, where the desktop shell's probe reads it.
  const page = (here: boolean): string => {
    const terminalFont = terminalFontOf(opts.recipePath);
    return loadPage(webDir, {
      ...(here ? { wsPort: rtServer.port, tokenHash: tokenDigest(authToken) } : {}),
      wsPath: WS_PATH,
      paired: here,
      version: VERSION,
      ...(terminalFont !== undefined ? { terminalFont } : {}),
      ...(here && opts.statePath !== undefined ? { statePath: opts.statePath } : {}),
    });
  };

  /** Who a request to the JSON routes is, or nothing when it is nobody: the token in an Authorization header and
   * nothing else, on the loopback port as on every other, since reaching a port on this computer is what any login
   * here can do. The runtime server owns the one reading of a token, and a token scoped to a thread names that
   * thread here exactly as it does on a socket, so the routes are no wider a road into this host than the protocol
   * is. The browser wsp init let in holds a device token read as the owner, here as on the socket. */
  const callerOf = async (req: IncomingMessage): Promise<{ caller?: Caller } | undefined> => {
    const who = await rtServer.authorize(bearerOf(req.headers.authorization));
    if (who === undefined) return undefined;
    if (who.kind !== "device" || who.device.here === true) return {};
    const thread = threadOf(who.device);
    // A device the person paired is that computer on these routes exactly as it is on a socket: the road is the
    // host's own word here too, so the rule about what it may start on a workspace of this computer is one rule.
    if (thread === undefined) return { caller: "paired" };
    return ownRoad(req, doorSockets) ? { caller: { origin: thread.road, by: thread.by } } : undefined;
  };

  const handler = (hereFor: (req: IncomingMessage) => boolean) => (req: IncomingMessage, res: ServerResponse) => {
    const here = hereFor(req);
    const sendPage = (): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(here));
    };
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      // Before the body is read and before anyone is named: a write asked for by a page at another name changes
      // nothing here, whatever token it carries.
      if (req.method !== "GET" && req.method !== "HEAD" && !originAllows(req)) {
        sendJson(res, 403, { error: crossOriginRefusal(req.headers.origin ?? "", req.headers.host ?? "") });
        return;
      }
      if (req.method === "GET" && path === "/") {
        sendPage();
        return;
      }
      const who = path.startsWith("/api/") ? await callerOf(req) : {};
      if (who === undefined) {
        sendJson(res, 401, { error: API_UNAUTHORIZED });
        return;
      }
      // Before dispatch, by the op the route stands for: a paired device is held to the same list on both doors.
      const held = routeRefusal(`${req.method} ${path}`, who.caller);
      if (held !== undefined) {
        sendJson(res, 401, { error: held });
        return;
      }
      if (req.method === "GET" && path === "/api/workspaces") {
        // A listing, not the app's own socket, so it joins the listing doors' run of probes and not the one a
        // sidebar row's word rides.
        sendJson(res, 200, { workspaces: await rt.status.list({ probeTimeoutMs, reader: "table" }, who.caller) });
        return;
      }
      if (req.method === "POST" && path === "/api/workspaces") {
        const read = await readJsonBody(req);
        if (!("body" in read)) {
          sendJson(res, read.status, { error: read.error });
          return;
        }
        const body = read.body;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          sendJson(res, 400, { error: "a workspace needs a name" });
          return;
        }
        let created: CreatedWorkspace;
        try {
          created = await createWorkspace(name, who.caller, typeof body.project === "string" ? body.project : undefined);
        } catch (e) {
          if (!(e instanceof NoGoldenError)) throw e;
          sendJson(res, 409, { error: e.message });
          return;
        }
        const { notice, ...workspace } = created;
        sendJson(res, 200, { workspace, ...(notice !== undefined ? { notice } : {}) });
        return;
      }
      if (req.method === "GET" && sendAsset(res, webDir, path)) return;
      // The app records what a person is reading in the address, and a person types and pastes addresses: a GET
      // naming no route of this host and no file of the bundle is the app itself, which reads the address it opened
      // on. A path carrying an extension or ending in a slash asked for a file that is not there and stays a miss,
      // so a script that moved never answers as a page.
      if (req.method === "GET" && !path.startsWith("/api/") && extname(path) === "" && !path.endsWith("/")) {
        sendPage();
        return;
      }
      sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
    })().catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  };

  // What the host bound is not the whole of who can reach it: a relay tunnel lands on that same loopback port, and
  // the request is what tells the two apart rather than the address both arrive at. The name the request asked for
  // decides beside them: a page whose hostname was pointed at this loopback port is not this computer.
  const server = createServer(handler(req => boundHere && !throughConnector(req) && isLoopback(hostnameAsked(req) ?? "")));

  // The door a computer you own dials: a second listener on the wildcard, built from the same request handler with
  // the page's digest and ports withheld, whose upgrades reach the one runtime. Its port is fixed rather than
  // stepped over, since the place file on the other computer names it for good and a fallback port could never be
  // dialled.
  // Zero asks the operating system for any free port, and the offset above it would be a privileged one, so that
  // pair stays zero, which is the rule the app's own port pair already reads.
  const asked = opts.port ?? DEFAULT_PORT;
  const doorPort = asked === 0 ? 0 : asked + PLACE_PORT_OFFSET;
  const doorServer = createServer(handler(() => false));
  // macOS lets a wildcard bind share a port another process holds on the loopback address, and a dial there reaches
  // that process, so the door holds the loopback itself; Linux refuses both binds together and the wildcard alone.
  const doorLoopback = platform() === "linux" ? undefined : createServer(handler(() => false));
  const doorListeners = doorLoopback === undefined ? [doorServer] : [doorServer, doorLoopback];
  // Held per socket rather than read off the port, so a socket the door let in stays the door's after it closes.
  const doorSockets = new WeakSet<Socket>();
  // An upgraded socket is no connection its listener ends on close, and the close waits on it while it stands.
  const doorOpen = new Set<Socket>();
  for (const listener of doorListeners)
    listener.on("connection", socket => {
      doorSockets.add(socket);
      doorOpen.add(socket);
      socket.once("close", () => doorOpen.delete(socket));
    });
  let doorAt: number | undefined;
  let doorOpening: Promise<DoorAt> | undefined;
  /** Where a person is told to dial, with the relay's own name beside it when a connector is carrying this host.
   * The key proved at that door is the runtime's to name, so it is not here. */
  const viewOf = (at: number, bound: string): DoorAt => {
    const relay = publicHostname(opts.statePath ?? "");
    return {
      port: at,
      addresses: doorAddresses(bound, at, opts.advertise),
      ...(relay === undefined ? {} : { relay: relayUrlOf(relay) }),
      // Only the door's own listener: on a host bound beyond loopback a forward would land on the main port, where a
      // loopback peer is the owner's road.
      ...(boundHere ? { backPort: at } : {}),
    };
  };
  const openDoor = async (): Promise<DoorAt> => {
    // A host that already answers beyond this computer needs no second listener: it names its own port instead.
    if (!boundHere) return viewOf(port, address);
    if (doorAt !== undefined) return viewOf(doorAt, WILDCARD);
    doorOpening ??= (async () => {
      let at = doorPort;
      try {
        await listenOn(doorServer, doorPort, WILDCARD);
        const bound = doorServer.address();
        at = typeof bound === "object" && bound !== null ? bound.port : doorPort;
        if (doorLoopback !== undefined) await listenOn(doorLoopback, at, LOOPBACK).catch(async (e: unknown) => {
          await closeServer(doorServer);
          throw e;
        });
      } catch (e) {
        doorOpening = undefined;
        throw (e as NodeJS.ErrnoException).code === "EADDRINUSE" ? new Error(doorPortHeldLine(at)) : e;
      }
      doorAt = at;
      // Said on a Mac alone: it is the application firewall's prompt, and no other computer here shows one.
      if (platform() === "darwin") opts.doorLine?.(PLACES_WORDS.sheet.firewall);
      return viewOf(at, WILDCARD);
    })();
    return doorOpening;
  };

  // The doctor's computer road runs on this process because this is the one holding that computer's link: a run at
  // a terminal reads present off the map of links its own process holds, which holds none while a host serves. Its
  // lines go to whoever subscribed as they are said, under the id the caller minted.
  const readers = opts.doctor;
  const doctorLines = new Set<(e: DoctorLineEvent) => void>();
  const doctor: PlaceDoctor | undefined =
    readers === undefined
      ? undefined
      : {
          on: fn => {
            doctorLines.add(fn);
            return () => void doctorLines.delete(fn);
          },
          run: async req => {
            const say = (line: string, stream: "out" | "err"): void => {
              for (const fn of [...doctorLines]) fn({ type: "doctor.line", doctorId: req.doctorId, line, stream });
            };
            const rows = (await rt.places?.list(Date.now())) ?? [];
            const row = rows.find(place => place.id === req.placeId);
            if (row === undefined) throw new Error(noSuchPlaceRefusal(req.placeId, rows.map(place => place.name)));
            const asks = (question: string): Promise<never> => Promise.reject(new Error(`${question.split("\n")[0]}: the doctor's road on a host asks nobody`));
            const code = await computerDoctor(
              rt,
              { log: line => say(line, "out"), error: line => say(line, "err"), ask: asks, askSecret: asks },
              row,
              {
                vault: readers.vault,
                ...(readers.plan !== undefined ? { plan: readers.plan.bind(readers) } : {}),
                ...(req.project !== undefined ? { project: req.project } : {}),
              },
            );
            return { code };
          },
        };

  // The runtime answers upgrades of WS_PATH on the server above as well as on its own port, so a client that
  // reached the app through one forwarded port has the protocol on that same port.
  try {
    rtServer = await serveRuntime(rt, {
      port: opts.wsPort ?? DEFAULT_WS_PORT,
      host: address,
      attach: [server, ...doorListeners],
      originAllowed: originAllows,
      ownRoad: req => ownRoad(req, doorSockets),
      peerOf: req => peerOf(req, doorSockets),
      door: { open: openDoor },
      devices: rt.devices,
      authToken,
      forwards: relay,
      projects: bundlerFor,
      landing: projectLander(homes),
      imageExport: imageExporter,
      folders: hostFolders(() => rt.workspaces.list()),
      terminalConfig: { read: scheme => readGhosttyConfig(nodeHost(), scheme) },
      sshHosts: async places => sshHostsIn(join(homedir(), ".ssh"), places),
      // Read at every ask rather than once at start: a sign-in taken at the terminal while the app stands open is
      // on the next read, and the read is two small files on this computer.
      account: { read: async () => accountHere(opts.statePath, wspHome()) },
      ...(opts.admitted !== undefined ? { admitted: opts.admitted } : {}),
      ...(opts.init !== undefined ? { init: opts.init } : {}),
      ...(doctor !== undefined ? { doctor } : {}),
      log,
      ...(statePath !== undefined ? { here: hereMcp(statePath, alsoHere) } : {}),
      ...(opts.release !== undefined ? { release: opts.release } : {}),
      ...(opts.restart !== undefined ? { restart: opts.restart } : {}),
    });
  } catch (e) {
    bound();
    await relay.close();
    throw e;
  }
  here.url = hereUrl(address, rtServer.port);
  bound();
  try {
    page(boundHere);
  } catch (e) {
    await relay.close();
    await rtServer.close();
    throw e;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? DEFAULT_PORT, address, resolve);
    });
  } catch (e) {
    await relay.close();
    await rtServer.close();
    throw e;
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? DEFAULT_PORT);

  // A sweep that outlives its period (a slow provider listing) must not be
  // joined by the next one: two sweeps would race to kill the same machines.
  let sweeping: Promise<void> | undefined;
  const sweep = (listSpared: boolean): Promise<void> =>
    (sweeping ??= sweepOrphans(rt, log, listSpared).finally(() => (sweeping = undefined)));
  await sweep(true);
  for (const b of await rt.golden.builders()) {
    if (b.foreignOwner !== undefined) log(`reap: left alone ${b.id}: recorded builder wearing another setup's owner label (${b.foreignOwner}); never touched by this host`);
    else if (b.heldBy !== undefined) log(`reap: left alone ${b.id}: your earlier builder from this setup, in use by another wsp process (pid ${b.heldBy.pid}); never touched by this host`);
    else if (b.building === true) log(`reap: left alone ${b.id}: your earlier builder from this setup; its setup never finished; the next sweep stops it`);
    else if (b.sealed !== undefined) log(describeSealed(b, b.sealed, rt.backend.pricing.rateUsdPerHour(b.size)));
    else if (b.sealable === true) log(describeKept(b, rt.backend.pricing.rateUsdPerHour(b.size)));
  }
  // No provider, no request: a host with no key has no account to list and says that where the line would be.
  if (opts.provider === NO_PROVIDER) log(noProviderStorageLine(opts.statePath));
  else {
    try {
      const storage = await rt.golden.storage();
      if (storage !== undefined && storage.count > 0) log(describeStorage(storage));
    } catch (e) {
      log(`storage: snapshot listing failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const reapTimer = setInterval(() => void sweep(false), REAP_INTERVAL_MS);
  opts.release?.start();

  // A door that cannot bind is a computer that cannot dial in, not a host that will not serve: the person reads
  // who holds the port and everything else on this computer goes on working.
  if (opts.door === "open") await openDoor().catch((e: unknown) => log(e instanceof Error ? e.message : String(e)));
  opts.back?.door(async () => (await openDoor()).backPort);

  return {
    port,
    wsPort: rtServer.port,
    authToken,
    revokeDevice: id => rtServer.revokeDevice(id),
    hereCode: async () => (await rt.devices.issue({ now: Date.now(), ttlMs: PAIR_CODE_TTL_MS, here: true })).code,
    door: {
      open: openDoor,
      port: () => doorAt,
      close: async () => {
        if (doorAt === undefined) return;
        doorAt = undefined;
        doorOpening = undefined;
        const closing = doorListeners.filter(listener => listener.listening).map(closeServer);
        for (const socket of doorOpen) socket.destroy();
        await Promise.all(closing);
      },
    },
    addProject,
    createWorkspace,
    planProject,
    importProject,
    close: async () => {
      // First: a forward remade while the door closes would open it again.
      opts.back?.close();
      clearInterval(reapTimer);
      opts.release?.close();
      await relay.close();
      // The runtime first: the sockets it holds on WS_PATH are this server's connections, and closing them here is
      // what sends a waiting client the stopping code instead of cutting the socket under it.
      await rtServer.close();
      for (const held of [...doorListeners, server]) {
        held.closeAllConnections();
        if (held.listening) await closeServer(held);
      }
      // Last: with the servers gone nothing can record another event, so the
      // flush this waits on is the final word in the store.
      await rt.close();
      // A stand-in provider's machines are daemons this process spawned, and a child outlives the parent that
      // spawned it: a lab whose host was stopped left one per machine running on the person's computer.
      await closeStandInGuests();
    },
  };
}
