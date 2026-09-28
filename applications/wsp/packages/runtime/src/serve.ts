// Protocol server over WS. Auth model: the long-lived authToken travels only
// in an `auth` frame on an already-open socket (never in a URL, where it would
// land in logs); a computer that is not this one redeems a one-time pairing
// code as the first frame of a socket and holds a device token of its own
// afterwards; anything else that needs to authenticate a NEW socket uses a
// 5-minute single-use ticket minted over an authed socket (`ticket.issue`) and
// redeemed as `?ticket=...` on the next connect.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ACCOUNT_TICKET_REFUSAL,
  absentComputer,
  ACCOUNT_UNSERVED,
  AUTH_DEADLINE_MS,
  DAEMON_AUTH_DEADLINE_PASSED,
  DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  PRE_AUTH_MAX_BYTES,
  DEVICES_TICKET_REFUSAL,
  DOCTOR_UNSERVED,
  doctorRowRefusal,
  doctorRunningLine,
  HOST_STOPPING_CLOSE,
  isJoinedComputer,
  HostFolderListing,
  placeBehindLine,
  placeDaemonBehind,
  providerFoldersRefusal,
  LOOPBACK,
  PAIR_CODE_REFUSAL,
  PAIR_CODE_TTL_MS,
  PAIR_ISSUE_REFUSAL,
  AGENTS_KEY_REFUSAL,
  DEVICE_ACCOUNT_UNSERVED,
  DEVICE_AUTH_REFUSAL,
  DEVICE_REVOKED_REFUSAL,
  deviceAdmissionTranscript,
  PLACES_TICKET_REFUSAL,
  noSignInRefusal,
  SIGN_IN_LINE_REFUSAL,
  HOST_RESTART_TICKET_REFUSAL,
  HOST_NO_RESTART_LINE,
  HERE_PLACE_ID,
  DAEMON_OPEN_ONE_OF,
  PLACE_CODE_REFUSAL,
  PLACE_DOOR_REFUSAL,
  PLACE_DOOR_UNSERVED,
  PLACE_UNKNOWN_REFUSAL,
  noSuchPlaceRefusal,
  RELAY_TICKET_REFUSAL,
  REQUEST_NOT_AN_OBJECT,
  RuntimeRequest,
  SEAL_CLIENT,
  SEAL_UNSERVED,
  THREAD_OPS,
  DEVICE_OPS,
  peerAddress,
  SCOPED_TOKEN_ROAD_REFUSAL,
  TICKET_ORIGIN,
  UNAUTHORIZED,
  WS_PATH,
  WorkspaceListing,
  WorkspaceOut,
  threadOpRefusal,
  deviceHeldRefusal,
  isObjectFrame,
  joinRoads,
  joinToken,
  MINT_JOIN_REFUSAL,
  SSH_HOSTS_REFUSAL,
  issuesLine,
  redacted,
  markedCut,
  requestSecrets,
  RUNTIME_OPS,
  type AccountDevice,
  type AccountView,
  type DeviceView,
  type DoctorLineEvent,
  type ExecEvent,
  type SealedImage,
  type SealedImageExport,
  type ForwardEvent,
  type PlaceAuthRefusal,
  type PlaceDoorView,
  type PlaceView,
  type PortForward,
  type SshHostSuggestion,
  type ReleaseChangedEvent,
  type ReleaseView,
  type Caller,
  type ThreadScope,
  type WorkspaceOrigin,
  type WorkspaceView,
  guestNoKindLine,
  guestNoSessionLine,
  guestSessionHeldLine,
  hereGuestRefusal,
  type HereGuestEvent,
  TURN_TOKEN_ENV,
} from "@wsp/protocol";
import type { DaemonChannel } from "./daemon-channel.js";
import { NO_DEVICE_DOOR, safeEqual, threadOf, type DeviceDoor, type HeldDevice } from "./devices.js";
import { NO_PLACE_DOOR, type PlaceDoor } from "./places.js";
import { keyFingerprint, openFrame, verifyPlaceBytes, type Seal } from "@wsp/keys";
import type { HostFolders, HostTerminalConfig, InitDoor, ProjectBundler, ProjectLander, Runtime } from "./runtime.js";

/** The port forwards a host holds, as the app lists and stops them. The
 * runtime keeps none itself: the host that owns the daemon links supplies this. */
export interface ForwardsSource {
  list(): PortForward[];
  /** True when a forward was open on that workspace and port and is now closed. */
  stop(workspaceId: string, port: number): boolean;
  on(fn: (e: ForwardEvent) => void): () => void;
}

/** The address a host binds when nobody names another and the path the runtime answers upgrades on, both the
 * protocol's own rule; re-exported so the host and its tests keep reading them off the server they start. */
export { LOOPBACK, WS_PATH } from "@wsp/protocol";

export interface ServeOptions {
  port: number;
  authToken: string;
  host?: string;
  /** Every HTTP server whose upgrades of WS_PATH this runtime answers too, beside its own port, so one address and
   * one port carry the page and the protocol. An upgrade of any other path is refused rather than left hanging.
   * More than one because the host serves the page twice: on the person's own loopback port and on the door a
   * computer they own dials, and both carry the one protocol. */
  attach?: HttpServer | HttpServer[];
  /** Whether a browser's upgrade may open a socket here, read off the request's own headers by the host that
   * serves the page: a page drives only the host it was served by. Without it every upgrade is taken, which is
   * what a runtime served with no page in front of it means. */
  originAllowed?: (req: IncomingMessage) => boolean;
  /** Whether a request reached this host over the road it serves its own workspaces' guests on, read off the
   * request by the host that serves this runtime, whose `ownRoad` holds that rule and why a scoped token is held
   * to it. Without it every road is the host's own, which is what a runtime served with no host in front of it
   * means. */
  ownRoad?: (req: IncomingMessage) => boolean;
  /** Where a socket came from, as the app shows it beside a computer that joined, read by the host that serves this
   * runtime, which knows which of its roads carry a peer's address for it. Without it, the socket's own peer. */
  peerOf?: (req: IncomingMessage) => string;
  /** The door computers you own dial, when the host that serves this runtime opens one; without it places.door is
   * refused rather than answering a port nothing listens on. */
  door?: PlaceDoorControl;
  /** Where paired computers and their unspent codes are kept; without it the pairing ops are refused and the host
   * token is the only way in. */
  devices?: DeviceDoor;
  /** How the host reads the account it is signed in to; without it account.get is refused, since the runtime keeps
   * no records of its own. */
  account?: AccountDoor;
  /** What the host knows of the account's own computers, for the one door a device with no code comes in by;
   * without it device.auth is refused, which is what a host on no account answers. */
  admitted?: AdmittedDevices;
  ticketTtlMs?: number;
  pairTtlMs?: number;
  /** How long a socket that has not been let in yet has to send its first frame, the protocol's own number unless
   * a test shortens it. */
  authDeadlineMs?: number;
  /** Injectable clock for ticket-expiry tests. */
  now?: () => number;
  forwards?: ForwardsSource;
  /** How a folder on this computer is read for project.plan and project.import; without it both are refused. */
  projects?: (source: string) => ProjectBundler;
  /** How a folder from a machine lands on this computer for project.export; without it the op is refused. */
  landing?: ProjectLander;
  /** How this computer's own folders are listed for host.folders, the picker a browser tab has instead of the
   * desktop shell's dialog; without it the op is refused. */
  folders?: HostFolders;
  /** How the person's terminal config is read off this computer for host.terminalConfig; without it the op is refused. */
  terminalConfig?: HostTerminalConfig;
  /** The init job the host runs on this computer, for the init.* ops and the init.job events; without it the ops are refused. */
  init?: InitDoor;
  /** The doctor's computer road as this host runs it, for places.doctor and the doctor.line events; without it the
   * op is refused, since the road is the host's own and the runtime holds none of what it reads. */
  doctor?: PlaceDoctor;
  /** The hosts the person's ssh already knows on this computer, less the computers the rows given were added as,
   * for places.sshHosts; without it the op answers none. */
  sshHosts?: (places: readonly PlaceView[]) => Promise<SshHostSuggestion[]>;
  /** The host's reading of the newest release, for release.get, release.check and the release.changed events;
   * without it both ops are refused. */
  release?: ReleaseDoor;
  /** How this host restarts itself on the files it was installed from, for host.restart; without it the op is refused. */
  restart?: RestartDoor;
  /** How an export of the image is sealed and written on this computer; without it image.export is refused. The
   * runtime hands over the record and the vault's bytes and never touches a file or a passphrase itself. */
  imageExport?: ImageExporter;
  /** The tool server the wsp command's forwarder on this computer opens on this host, as guest.open; without it
   * that op is refused, which is what a runtime served with no host in front of it answers. */
  here?: GuestKindModule;
  /** Takes one line per refused frame: the op, the kind and the sentence's first line, never the request itself. */
  log?: (line: string) => void;
}

/** What a kind's module is handed when a guest session opens: what the guest asked for, the environment its verbs
 * run under, and the two ways back to it. The host's guest door hands one for a process inside a machine, and this
 * socket for the wsp command's forwarder on this computer. */
export interface GuestOpening {
  argv: readonly string[];
  cwd: string;
  /** The pair a verb reads its host and its token off, as a turn's own launch leaves them, plus the turn's token;
   * on a session this computer's forwarder opened, the environment its line was typed in as well. */
  env: Record<string, string>;
  reply(message: unknown): void;
  close(error?: string): void;
}

/** One open session, as the door talks to it. */
export interface GuestSession {
  message(message: unknown): void;
  /** The guest's end went, or the workspace did: whatever this session holds open is dropped. A link that drops
   * and redials is neither, and the session stands across it. */
  close(): void;
}

/** A kind of guest session: the tool server, or one command line. */
export interface GuestKindModule {
  open(opening: GuestOpening): GuestSession;
}

/** How the runtime asks the host who this wsp is signed in to. The host owns the records; the runtime owns who may
 * read them. */
export interface AccountDoor {
  read(): Promise<AccountView>;
}

/** What the door reads of the account this host is on. The host owns the heartbeat that learns it and the file the
 * key was written in; the runtime owns which of it admits a computer. */
export interface AdmittedDevices {
  /** The key this host trusts to sign an admission because the computer that put this host on the account holds
   * it, as the link recorded it. Nothing when this host is on no account, which is what refuses device.auth. */
  signer(): { fingerprint: string; publicKey: string } | undefined;
  /** The account's computers as the last explicit listing said, and nothing when this host has heard none: absent
   * is unknown and never empty, so a relay that is down or a beat that was refused admits nobody new. */
  list(): readonly AccountDevice[] | undefined;
  /** One more beat, for a key the listing does not hold yet; bounded by the host, so a stranger on the tunnel
   * cannot make this host call its relay once per attempt. */
  refresh(): Promise<void>;
}

/** How the runtime asks the host for the door computers a person owns dial. The host owns the listener; the runtime
 * owns who may ask for it. */
export interface PlaceDoorControl {
  /** Opens the door if it is shut and answers where it is; a host already bound beyond loopback answers its own
   * port and opens nothing. The key proved there is not the host's to say: the place door holds the pair, and the
   * runtime puts its fingerprint on the view it serves. `backPort` is the door's port on this computer's loopback
   * where the door is a listener of its own, which is what a forward over ssh may land on; it stays on this side. */
  open(): Promise<Omit<PlaceDoorView, "hostKey"> & { backPort?: number }>;
}

/** How the runtime asks the host to prove one computer it holds the link to. `run` walks the road and answers what
 * the line exits with; `on` is the source its lines arrive on, the shape the init door's own has, so they ride the
 * events channel without entering the runtime's ring: no sequence, nothing retained, no replay to a socket that
 * comes back. */
export interface PlaceDoctor {
  run(req: { placeId: string; doctorId: string; project?: string }): Promise<{ code: number }>;
  on(fn: (e: DoctorLineEvent) => void): () => void;
}

/** How the runtime asks the host for the newest release. The host owns the ask, its cadence and the file it keeps;
 * `on` is a host source like the init door's, so its events carry no sequence and are not replayed. */
export interface ReleaseDoor {
  get(): ReleaseView;
  check(): Promise<ReleaseView>;
  on(fn: (e: ReleaseChangedEvent) => void): () => void;
}

/** How the runtime asks the host to restart. The host owns how, by the road it came up on; `refusal` is why that
 * road would not bring it back, and nothing where it does. `restart` is called once the reply is sent. */
export interface RestartDoor {
  refusal?: string;
  restart(): Promise<void>;
}

/** Seals the vault to the passphrase and writes it at `dest` on the computer the host runs on. */
export type ImageExporter = (o: { image: SealedImage; tar: Buffer; dest: string; passphrase: string }) => Promise<SealedImageExport>;

/** Who a token names: this host's own process, or one paired computer. Every road in reads it from one function, so
 * a road cannot be opened wider than the others by accident. */
export type Authed = { kind: "host" } | { kind: "device"; device: HeldDevice };

export interface RuntimeServer {
  port: number;
  /** Who the bearer token of an HTTP request names, or nothing when it names nobody. The JSON routes the host
   * serves beyond loopback gate on this, so the WebSocket and those routes read one token store. */
  authorize(token: string | undefined): Promise<Authed | undefined>;
  /** Takes one device's token away and cuts the sockets it held, which is what the op does: the host's heartbeat
   * reconcile comes through here, so a device the account dropped goes exactly as a revoke at the terminal goes. */
  revokeDevice(id: string): Promise<boolean>;
  close(): Promise<void>;
}

interface Ticket {
  purpose: keyof typeof TICKET_ORIGIN;
  expiresAt: number;
  /** Whether the socket that minted this one was a computer the person paired: a ticket carries the road of the
   * socket that asked for it, since a second socket is no way around what the first one's road may do. */
  paired: boolean;
}

/** The name the one guest session a socket may hold goes by in its open's reply. */
const HERE_GUEST_SESSION = "here";

/** How long a stopping host waits for a client to answer its close frame before the socket is cut. A client that is
 * inside a synchronous stretch answers only when its loop turns: measured on a 2 vCPU box with a test run beside it,
 * a client blocking in 250 ms stretches answered in 161 ms at the median and 289 ms at the worst, so a grace at the
 * old 250 ms cut the common loaded case and sent it back the words of a host that vanished. */
const STOP_GRACE_MS = 1_000;

function bundlerFrom(opts: ServeOptions): (source: string) => ProjectBundler {
  return source => {
    if (opts.projects === undefined) throw new Error("this runtime cannot read folders on this computer");
    return opts.projects(source);
  };
}

function landerFrom(opts: ServeOptions): () => ProjectLander {
  return () => {
    if (opts.landing === undefined) throw new Error("this runtime cannot write folders on this computer");
    return opts.landing;
  };
}

function foldersFrom(opts: ServeOptions): () => HostFolders {
  return () => {
    if (opts.folders === undefined) throw new Error("this runtime cannot browse the folders on this computer");
    return opts.folders;
  };
}

function imageExportFrom(opts: ServeOptions): () => ImageExporter {
  return () => {
    if (opts.imageExport === undefined) throw new Error("this runtime cannot write an export on this computer");
    return opts.imageExport;
  };
}

function initFrom(opts: ServeOptions): () => InitDoor {
  return () => {
    if (opts.init === undefined) throw new Error("this runtime has no init job; the host that serves the app wires one");
    return opts.init;
  };
}

function releaseFrom(opts: ServeOptions): () => ReleaseDoor {
  return () => {
    if (opts.release === undefined) throw new Error("this runtime does not read the newest release");
    return opts.release;
  };
}

function terminalConfigFrom(opts: ServeOptions): () => HostTerminalConfig {
  return () => {
    if (opts.terminalConfig === undefined) throw new Error("this runtime cannot read the terminal config on this computer");
    return opts.terminalConfig;
  };
}

const DECLARED_OPS = new Set(RUNTIME_OPS);
/** More secret values than any real frame carries (a record of logins, an environment); past it the sentence is not
 * scanned at all, since each value is one pass over the line on the host's own thread. */
const SCANNED_SECRETS = 256;

/** The log line of one refused frame: an op the protocol declares, else `frame`, since the frame may be a stranger's;
 * the kind; and the sentence's first line with the request's secrets blanked, then cut. Blanked before the cut, since
 * a cut through a secret would leave its head where the blanking no longer matches it. */
function refusedLine(frame: unknown, payload: Record<string, unknown>, said?: string): string {
  const asked = isObjectFrame(frame) ? frame["op"] : undefined;
  const op = typeof asked === "string" && DECLARED_OPS.has(asked) ? asked : "frame";
  const kind = typeof payload["kind"] === "string" ? payload["kind"] : "none";
  const secrets = [...new Set(requestSecrets(frame))];
  if (secrets.length > SCANNED_SECRETS) return `refused ${op} kind=${kind}: (sentence withheld, ${secrets.length} secret values)`;
  const text = said ?? String(payload["error"]);
  const end = text.indexOf("\n");
  const first = redacted(end === -1 ? text : text.slice(0, end), secrets);
  return `refused ${op} kind=${kind}: ${markedCut(first)}`;
}

/** Every workspace a verb answers with goes through here on its way out. The record's view holds the display stream
 * the provider minted for a desktop machine, and this door answers a relayed machine and an agent's transcript as
 * well as the app; the app reads that stream off the status its own socket subscribes to, which is untouched. */
const handed = (workspace: WorkspaceView): WorkspaceOut => WorkspaceOut.parse(workspace);

export async function serveRuntime(rt: Runtime, opts: ServeOptions): Promise<RuntimeServer> {
  const bundler = bundlerFrom(opts);
  const lander = landerFrom(opts);
  const folders = foldersFrom(opts);
  const terminalConfig = terminalConfigFrom(opts);
  const release = releaseFrom(opts);
  const init = initFrom(opts);
  const imageExport = imageExportFrom(opts);
  if (!opts.authToken) throw new Error("serveRuntime refuses to start without an auth token");
  const now = opts.now ?? Date.now;
  const ticketTtlMs = opts.ticketTtlMs ?? 300_000;
  const pairTtlMs = opts.pairTtlMs ?? PAIR_CODE_TTL_MS;
  const tickets = new Map<string, Ticket>();
  /** The computers a doctor's road is running on right now, so a second one on the same computer is refused rather
   * than making a second workspace there. One set for this host, since the road is the host's and not a socket's. */
  const doctoring = new Set<string>();
  /** The restart this host is already going through, so asks that overlap start one. */
  let restarting: Promise<void> | undefined;
  const devices = (): DeviceDoor => {
    if (opts.devices === undefined) throw new Error(NO_DEVICE_DOOR);
    return opts.devices;
  };
  /** The one mint a join code comes from, whichever op asks: one store and one expiry for wsp add and the app. */
  const issueCode = (here: boolean): Promise<{ code: string; expiresAt: number }> => devices().issue({ now: now(), ttlMs: pairTtlMs, ...(here ? { here: true } : {}) });
  const places = (): PlaceDoor => {
    if (rt.places === undefined) throw new Error(NO_PLACE_DOOR);
    return rt.places;
  };

  /** One level of folders on a computer this host holds, read by that computer's own daemon over the link it opened,
   * with the folder of every project recorded there beside its login's home as the roots. A provider keeps no
   * computer to browse and is refused before anything is asked. */
  const placeFolders = async (placeId: string, asked: { dir?: string; hidden?: boolean; repos?: boolean }, origin: Caller | undefined): Promise<HostFolderListing> => {
    const rows = await places().list(now());
    const row = rows.find(place => place.id === placeId);
    if (row === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(placeId, rows.map(place => place.name))), { kind: "usage" });
    if (!isJoinedComputer(row)) throw Object.assign(new Error(providerFoldersRefusal(row.name)), { kind: "usage" });
    const report = await places().reportOf(row.id);
    const behind = report === undefined ? undefined : placeDaemonBehind(report);
    if (behind !== undefined) throw new Error(placeBehindLine(row.name, behind));
    const link = places().channel(row.id, () => {});
    if (link === undefined) throw new Error(absentComputer(row.name, null).sentence);
    try {
      const projects = (await rt.projects.list(origin)).filter(p => p.computer === row.id).flatMap(p => (p.checkout === undefined ? [] : [p.checkout]));
      const reply = await link.send({ op: "fs.folders", ...asked, projects });
      if (reply.ok !== true) throw new Error(reply.error);
      return HostFolderListing.parse(reply);
    } finally {
      link.close();
    }
  };

  /** Who a token names. The one reading: the auth frame, a socket that just redeemed a code and the HTTP routes the
   * host guards all come through here, so no road can be widened without widening every road. */
  const whoIs = async (token: string): Promise<Authed | undefined> => {
    if (safeEqual(token, opts.authToken)) return { kind: "host" };
    if (opts.devices === undefined) return undefined;
    const device = await opts.devices.match(token);
    return device === undefined ? undefined : { kind: "device", device };
  };

  /** Every live socket a device holds, so revoking that device cuts them rather than leaving a token that is gone
   * still driving the host until the client happens to redial. */
  const held = new Set<{ deviceId: string; cut: () => void }>();

  /** The one road a device is taken away by: the record, then whatever the caller wants said, then the sockets it
   * held. The op and the host's own reconcile of the account's listing both come through here, so a device the
   * account dropped goes exactly as one revoked at the terminal goes. */
  const revokeDevice = async (id: string, answer?: (revoked: boolean) => void): Promise<boolean> => {
    const revoked = await devices().revoke(id);
    answer?.(revoked);
    for (const socket of [...held]) if (socket.deviceId === id) socket.cut();
    return revoked;
  };

  const originAllowed = opts.originAllowed ?? ((): boolean => true);
  /** The host's own reading of the road a request arrived on, the rule and its reason on that host's `ownRoad`.
   * Named apart from the `ownRoad()` a socket carries below, which says what that socket is rather than where its
   * bytes came from. */
  const dialledHere: (req: IncomingMessage) => boolean = opts.ownRoad ?? (() => true);
  const wss = new WebSocketServer({ host: opts.host ?? LOOPBACK, port: opts.port, verifyClient: (info: { req: IncomingMessage }) => originAllowed(info.req) });
  const attachTo = opts.attach === undefined ? [] : Array.isArray(opts.attach) ? opts.attach : [opts.attach];
  const attached = attachTo.length === 0 ? undefined : new WebSocketServer({ noServer: true });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!originAllowed(req)) {
      // Before the handshake, so no frame of this socket is ever read. The listener goes on before the write for
      // the same reason the refusal below carries one: a peer that resets here would otherwise end the process.
      socket.on("error", () => socket.destroy());
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return;
    }
    if (new URL(req.url ?? "/", "ws://localhost").pathname !== WS_PATH) {
      // The listener goes on before the write. A peer that resets right after its upgrade raises an error on this
      // raw socket, and an unhandled one ends the process, so on a host bound beyond loopback a stranger who
      // knocks on the wrong path and hangs up could stop it. This is what the ws library does for its own refusals.
      socket.on("error", () => socket.destroy());
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return;
    }
    attached!.handleUpgrade(req, socket, head, ws => attached!.emit("connection", ws, req));
  };
  for (const server of attachTo) server.on("upgrade", onUpgrade);

  const onConnection = (ws: WebSocket, req: IncomingMessage): void => {
    const url = new URL(req.url ?? "/", "ws://localhost");
    // Where this socket came from, as the app shows it beside a computer that just joined.
    const from = opts.peerOf?.(req) ?? peerAddress(req.socket.remoteAddress);
    // A frame wrong at the wire is an error event on this socket, and one nobody listens for is thrown out of the
    // library's read, ending a process with no handler. The library has begun closing the socket when it emits;
    // terminating spares the wait on a peer that sent such bytes to answer the close.
    ws.on("error", (e: Error) => {
      console.warn(`socket from ${from} dropped on a wire fault: ${e.message}`);
      ws.terminate();
    });
    const ticketParam = url.searchParams.get("ticket");
    let authed = false;
    // What this socket is, decided when it is let in and never again: the ticket it redeemed says whether its
    // requests reached the host from a machine. Origin rides the wire from the client, so a socket that lied about
    // it would drive what only this computer may; the host stamps the road's own answer over what arrives. A ticket
    // whose purpose the table does not answer for is refused at the door rather than let in on the client's word.
    let stamped: WorkspaceOrigin | undefined;
    /** Set when this socket is a computer the person paired: its own token opened it, or the ticket it redeemed
     * was minted by one. The road every verb below is handed, so what a paired computer may start here is the
     * runtime's one rule and never this client's word. Beside `stamped` rather than in it, since a paired computer
     * is still one of the person's own for the doors `ownRoad` guards and only what it starts changes. */
    let pairedRoad = false;
    if (ticketParam !== null) {
      const ticket = tickets.get(ticketParam);
      tickets.delete(ticketParam); // single-use, spent even when expired
      const origin = ticket === undefined ? undefined : TICKET_ORIGIN[ticket.purpose];
      if (ticket === undefined || origin === undefined || now() > ticket.expiresAt) {
        ws.close(4401, UNAUTHORIZED);
        return;
      }
      stamped = origin;
      pairedRoad = ticket.paired;
      authed = true;
    }

    // Who this socket is once it is let in: the host's own process, or the paired computer whose token it sent.
    // A ticket redeemed at the door is the host's own road, so a socket that came in that way counts as the host.
    let me: Authed | undefined = authed ? { kind: "host" } : undefined;
    /** The thread this socket is, when its token was one the host minted into a turn's launch. */
    let by: ThreadScope | undefined;
    // Whether this socket is one of the person's own rather than the road a machine's requests arrive by. Who may
    // reach this host is never a machine's to hand out, list or take away, and it is the same rule a ticket is. A
    // function rather than a constant: a thread scoped token is read at the auth frame, after this socket was let
    // in, and it always sets the stamp, whichever road its turn runs on.
    const ownRoad = (): boolean => stamped === undefined;
    /** Set while an unauthed socket's first frame is being decided, so a second frame cannot race past the door. */
    let deciding = false;
    /** Set between a place's first frame and its prove: which place answered, and the bytes its signature must
     * cover. While it is set the only frame this socket may send is that prove. */
    let proving: { placeId: string; expect: Uint8Array } | undefined;
    /** Set once a place proved and this socket became its link. The listener goes with it, and this is read before
     * anything else besides: it is the one place a mistake would let a runtime frame from a place be read as a
     * client's, so the door both stops listening and refuses to read. */
    let handedOver = false;
    /** Set once a place's first frame has been answered: every frame this socket sends from then on is sealed
     * under the key both ends agreed, and every frame it reads is opened with it. A carrier holding the bytes
     * reads nothing and writes nothing into what follows. */
    let seal: Seal | undefined;
    /** Set at a native client's seal.open: the bytes that socket's own signature must cover, which is the same
     * transcript a joined computer answers at place.prove. Read by device.auth alone, so a device proves the key
     * it is admitted under over this socket's own handshake and not over bytes it chose. */
    let sealExpect: Uint8Array | undefined;

    const detaches: (() => void)[] = [];
    /** The daemon links this socket holds open, by the id it was answered with. A channel is never reachable from
     * another socket, so a page cannot drive a machine by guessing an id another page was given. */
    const channels = new Map<string, DaemonChannel>();
    /** The workspaces this socket already reads this computer's own figures for. */
    const watchedSys = new Set<string>();
    /** The sign-ins this socket started or joined: the only ones it may type a code into or stop. */
    const signIns = new Set<string>();
    detaches.push(() => {
      for (const ch of channels.values()) ch.close();
      channels.clear();
    });
    /** The guest session this socket opened on the host itself, while it stands. */
    let guest: GuestSession | undefined;
    detaches.push(() => {
      const held = guest;
      guest = undefined;
      held?.close();
    });
    let bound: { deviceId: string; cut: () => void } | undefined;
    ws.on("close", () => {
      for (const un of detaches) un();
      detaches.length = 0;
      if (bound !== undefined) held.delete(bound);
    });

    /** The wire bytes a socket nobody has let in yet has sent, counted as its socket delivers them rather than as
     * frames assemble, so a frame the peer never finishes is held to the same cap. Both numbers and both
     * sentences are the daemon's own, imported rather than spelled again, so the machine's door and this one
     * cannot drift apart; a socket through the door keeps the library's own ceiling. */
    let sentBeforeAuth = 0;
    const beforeAuth = (chunk: Buffer): void => {
      sentBeforeAuth += chunk.length;
      if (sentBeforeAuth <= PRE_AUTH_MAX_BYTES) return;
      throughDoor();
      ws.close(4401, DAEMON_PRE_AUTH_BYTES_EXCEEDED);
    };
    const byDeadline = authed
      ? undefined
      : setTimeout(() => {
          throughDoor();
          ws.close(4401, DAEMON_AUTH_DEADLINE_PASSED);
        }, opts.authDeadlineMs ?? AUTH_DEADLINE_MS);
    // A deadline nobody is waiting on holds no process open.
    byDeadline?.unref();
    /** Takes both limits off, the moment this socket is through the door: its auth frame passed, it redeemed a
     * pairing code, or a place's first frame was answered. */
    function throughDoor(): void {
      req.socket.off("data", beforeAuth);
      clearTimeout(byDeadline);
    }
    if (!authed) {
      req.socket.on("data", beforeAuth);
      detaches.push(throughDoor);
    }

    /** Remembers the socket under the device that authed it, so a revoke can cut it, and takes the road off that
     * device: both roads a device comes in by, the auth frame and a redeem, pass here, so neither is a way around
     * the stamp. */
    const bind = (device: DeviceView): void => {
      // The browser wsp init let in is the owner's own window, so its socket takes the person's road.
      pairedRoad = device.scope === undefined && device.here !== true;
      me = { kind: "device", device };
      bound = { deviceId: device.id, cut: () => ws.close(4401, UNAUTHORIZED) };
      held.add(bound);
    };

    const send = (payload: Record<string, unknown>): void => {
      if (ws.readyState !== ws.OPEN) return;
      const text = JSON.stringify(payload);
      ws.send(seal === undefined ? text : seal.seal(text));
    };
    const answering =
      (frame: () => unknown) =>
      (payload: Record<string, unknown>, said?: string): void => {
        send(payload);
        if (payload["ok"] === false) opts.log?.(refusedLine(frame(), payload, said));
      };

    const onMessage = (raw: unknown): void => {
      if (handedOver) return;
      void (async () => {
        let parsed: unknown;
        // Every reply to this frame goes through here, so a refusal is logged against the request it answers.
        const send = answering(() => parsed);
        try {
          // A frame that does not open under the key both ends agreed, and a frame sent in the clear after the
          // seal began, are both a carrier writing into this link rather than the computer on the other end.
          parsed = JSON.parse(openFrame(seal, raw));
        } catch {
          send({ id: null, ok: false, error: "invalid json" });
          if (!authed) ws.close(4401, UNAUTHORIZED);
          return;
        }
        // Ahead of every read of the frame's fields: a null frame has none, and reading one off it throws past every
        // door below and out of this handler, where nothing catches it.
        if (!isObjectFrame(parsed)) {
          send({ id: null, ok: false, error: REQUEST_NOT_AN_OBJECT });
          if (!authed) ws.close(4401, UNAUTHORIZED);
          return;
        }
        // The door for a socket holding a thread's own token, read off the op's name before its own shape is: shut,
        // with the ops a thread may send as the openings. A deny list would let every op added later through by
        // having been forgotten, which is how the golden, the keys and the person's own init were reachable from a
        // machine. Ahead of the schema so an op that is not a thread's is refused by name whatever it carries.
        const asked = (parsed as { op?: unknown }).op;
        const askedId = (parsed as { id?: string | number }).id ?? null;
        if (by !== undefined && (typeof asked !== "string" || !THREAD_OPS.includes(asked))) {
          send({ id: askedId, ok: false, error: threadOpRefusal(typeof asked === "string" ? asked : "that frame", by.threadId) });
          return;
        }
        // The door for a computer the person paired, read the same way and in the same place: shut, with the ops
        // such a device may send as the openings, until a role of the person's opens more, and ahead of the schema
        // so a held op is refused by name whatever it carries. The JSON routes read the same list by the op each
        // route stands for, so neither door is wider than the other.
        const asPaired = pairedRoad && stamped !== "relayed";
        if (asPaired && (typeof asked !== "string" || !DEVICE_OPS.includes(asked))) {
          send({ id: askedId, ok: false, error: deviceHeldRefusal(typeof asked === "string" ? asked : "that frame") });
          return;
        }
        const req2 = RuntimeRequest.safeParse(parsed);
        if (!req2.success) {
          send({ id: (parsed as { id?: string | number }).id ?? null, ok: false, error: req2.error.message }, issuesLine(req2.error.issues));
          if (!authed) ws.close(4401, UNAUTHORIZED);
          return;
        }
        const msg = req2.data;

        if (!authed) {
          const refuse = (error: string, signed?: PlaceAuthRefusal): void => {
            send({ id: msg.id, ok: false, error, kind: "auth", ...signed });
            ws.close(4401, UNAUTHORIZED);
          };
          // The second frame of a place's handshake, and the only frame this socket may send once its first one was
          // answered: anything else is a socket asking for a second identity.
          if (proving !== undefined) {
            if (msg.op !== "place.prove") return refuse(UNAUTHORIZED);
            const { placeId, expect } = proving;
            proving = undefined;
            // The door reads the signature and the report this frame carries, and answers the report it will take
            // or the one sentence to refuse with: this door holds neither rule of its own.
            const proved = await places()
              .prove(placeId, msg, expect, from, now())
              .catch((e: unknown) => ({ refusal: e instanceof Error ? e.message : String(e) }));
            if ("refusal" in proved) return refuse(proved.refusal);
            // From here no frame from this socket is read as a client's request: the listener goes before the
            // reply, and the reply goes before the place door sends anything, so the place has its own serve on
            // by then. The socket stops being read first and is read again once the link's own listener stands:
            // the computer sends its hello the moment the reply lands, and a frame that arrived between the two
            // listeners would be a frame nobody unsealed, leaving the counters a frame apart and the next one
            // closing the link.
            handedOver = true;
            ws.pause();
            ws.off("message", onMessage);
            // The token a join asked for its own window rides this reply, inside the seal: it is the person's and
            // crosses only once the host has proved its key.
            send({ id: msg.id, ok: true, ...(proved.device === undefined ? {} : { device: proved.device }) });
            await places().attach(placeId, ws, proved.report, from, now(), seal);
            return;
          }
          if (deciding) return refuse(UNAUTHORIZED);
          deciding = true;
          if (msg.op === "seal.open") {
            // A native client pinning this host's key before it sends the code or the token it came with. A second
            // one on the same socket is a socket asking to agree a second key, which would leave the counters of
            // the first behind: one key per socket, as one identity per socket.
            if (seal !== undefined) return refuse(UNAUTHORIZED);
            if (rt.places === undefined) return refuse(SEAL_UNSERVED);
            const opened = places().answerChallenge(SEAL_CLIENT, msg.nonce, msg.ephemeral);
            if (opened === undefined) return refuse(UNAUTHORIZED);
            // The client proves nothing back: it holds no key this host learned, and the token or the code it
            // sends next inside the seal is what names it. The gate opens for that frame.
            deciding = false;
            send({ id: msg.id, ok: true, nonce: opened.nonce, hostPublicKey: opened.hostPublicKey, signature: opened.signature, ephemeral: opened.ephemeral });
            seal = opened.seal;
            sealExpect = opened.expect;
            return;
          }
          if (msg.op === "place.join" || msg.op === "place.auth") {
            // A computer joining or dialling back in. The door answers its challenge and says which bytes the next
            // frame must sign; a key or a report this host cannot work with refuses in the door's own words. One
            // key per socket holds here too: a link's own agreement would replace the one a client already has.
            if (seal !== undefined) return refuse(UNAUTHORIZED);
            let opened:
              | { reply: Record<string, unknown>; expect: Uint8Array; seal: Seal; notice?: string }
              | { refusal: string; signed: PlaceAuthRefusal }
              | undefined;
            try {
              opened = msg.op === "place.join" ? await places().join(msg, from, now()) : await places().auth(msg, now());
            } catch (e) {
              return refuse(e instanceof Error ? e.message : String(e));
            }
            // A join's code that is not one this host is holding; the door says nothing more about it.
            if (opened === undefined) return refuse(PLACE_CODE_REFUSAL);
            // A place this host holds no record of: the door's sentence with the door's own signature over it.
            if ("refusal" in opened) return refuse(opened.refusal, opened.signed);
            const placeId = msg.op === "place.join" ? String(opened.reply["placeId"]) : msg.placeId;
            proving = { placeId, expect: opened.expect };
            // The gate opens for exactly one more frame, which the branch above holds to place.prove.
            deciding = false;
            throughDoor();
            send({ id: msg.id, ok: true, ...opened.reply, ...(opened.notice !== undefined ? { notice: opened.notice } : {}) });
            // The reply carries the host's own half of the agreement, so it is the last frame of this socket that
            // travels in the clear; from here the prove and everything after it are sealed.
            seal = opened.seal;
            return;
          }
          if (msg.op === "place.prove") return refuse(UNAUTHORIZED);
          if (msg.op === "pair.redeem") {
            // A runtime with no device door, and a store that failed, both read as a code this host is not
            // holding: the caller is unauthenticated, so one refusal for every reason tells it nothing.
            const paired = await Promise.resolve()
              .then(() => devices().redeem(msg.code, msg.name, now()))
              .catch(() => undefined);
            if (paired === undefined) return refuse(PAIR_CODE_REFUSAL);
            authed = true;
            throughDoor();
            bind(paired.device);
            send({ id: msg.id, ok: true, deviceId: paired.deviceId, deviceToken: paired.deviceToken });
            return;
          }
          if (msg.op === "device.auth") {
            // A computer on the account, coming in with no code. The four checks in order, and one sentence for
            // every way the first three fail: a caller this host will not admit learns nothing from which caught
            // it. The revoked key is the one that answers for itself, since only a device that proved the key it
            // holds reaches that check.
            const account = opts.admitted;
            const signer = account?.signer();
            if (account === undefined || signer === undefined || opts.devices === undefined) return refuse(DEVICE_ACCOUNT_UNSERVED);
            // Inside the seal and over this socket's own handshake: a frame that agreed no key carries a signature
            // that could have been made for any socket at all.
            if (sealExpect === undefined) return refuse(UNAUTHORIZED);
            const fingerprint = keyFingerprint(msg.publicKey);
            const listed = (): AccountDevice | undefined => account.list()?.find(device => device.fingerprint === fingerprint);
            let row = listed();
            if (row === undefined) {
              // A key the listing does not hold may be one approved a moment ago, and a host that has heard no
              // listing at all has heard nothing about anybody: one more beat, bounded by the host that beats.
              await account.refresh().catch(() => undefined);
              row = listed();
            }
            if (row === undefined) return refuse(DEVICE_AUTH_REFUSAL);
            const admitted = await Promise.resolve()
              .then(async () => {
                // The keys this host trusts: the one the computer that linked it holds, and every device it
                // admitted through the account, whose public key it saw at that admission. Never one off the wire.
                const here = await devices().list();
                const keyOf = (by: string): string | undefined =>
                  by === signer.fingerprint ? signer.publicKey : here.find(device => device.via?.kind === "account" && device.via.fingerprint === by)?.via?.publicKey;
                for (const admission of row.admissions) {
                  const key = keyOf(admission.by);
                  if (key === undefined) continue;
                  if (verifyPlaceBytes(key, deviceAdmissionTranscript(fingerprint, admission.by, admission.issuedAt), admission.signature)) return admission.by;
                }
                return undefined;
              })
              .catch(() => undefined);
            if (admitted === undefined) return refuse(DEVICE_AUTH_REFUSAL);
            if (!verifyPlaceBytes(msg.publicKey, sealExpect, msg.signature)) return refuse(DEVICE_AUTH_REFUSAL);
            // A device this host took away: remembered by its key, since the same key signing in again is given a
            // fresh id on the relay while the admission bytes it holds stay bytes that verify.
            const refused = await devices()
              .refuses(fingerprint)
              .catch(() => true);
            if (refused) return refuse(DEVICE_REVOKED_REFUSAL);
            const device = await Promise.resolve()
              .then(() => devices().admitAccount(msg.name, { kind: "account", relayDeviceId: row.id, fingerprint, publicKey: msg.publicKey, admittedBy: admitted }, now()))
              .catch(() => undefined);
            if (device === undefined) return refuse(DEVICE_AUTH_REFUSAL);
            authed = true;
            throughDoor();
            bind(device.device);
            send({ id: msg.id, ok: true, deviceId: device.deviceId, deviceToken: device.deviceToken });
            return;
          }
          if (msg.op !== "auth") return refuse(UNAUTHORIZED);
          const who = await whoIs(msg.token).catch(() => undefined);
          if (who === undefined) return refuse(UNAUTHORIZED);
          // Ahead of the bind and the last seen below, so a copy refused here leaves nothing of itself behind.
          if (who.kind === "device" && who.device.scope !== undefined && !dialledHere(req)) return refuse(SCOPED_TOKEN_ROAD_REFUSAL);
          authed = true;
          throughDoor();
          if (who.kind === "device") {
            bind(who.device);
            // A token the host minted into a turn's launch carries the road that turn runs on, stamped here over
            // anything the client's own frames say: a machine's is relayed, so every rule written for a relayed
            // request holds for it, and a turn on this computer's is here. Either way the stamp is set, which is
            // what keeps every door below that asks for the person's own road shut to a thread.
            const thread = threadOf(who.device);
            if (thread !== undefined) {
              stamped = thread.road;
              by = thread.by;
            }
            // The auth frame and a redeem are the two roads that move a device's last seen; a JSON route reading
            // the same token must not, or every request beyond loopback would rewrite the whole state file.
            void opts.devices?.seen(who.device.id, now()).catch(() => undefined);
          } else me = who;
          send({ id: msg.id, ok: true });
          return;
        }

        // What every verb below is handed as where this request came from: the road the door stamped over the wire,
        // and beside it the thread whose token opened this socket, which is the host's own reading and never the
        // client's. A socket nothing stamped and no device opened carries the word its client sent, as it always did.
        // The paired word stands above the `here` a connect ticket carries, since a ticket never widens the road of
        // the socket that minted it; a relay ticket's word is stricter still and stays, whoever minted it.
        const road = asPaired ? "paired" : (stamped ?? msg.origin);
        const origin: Caller | undefined = by !== undefined && road !== undefined ? { origin: road, by } : road;
        try {
          switch (msg.op) {
            case "auth":
              send({ id: msg.id, ok: true });
              return;
            case "pair.issue": {
              // A code lets a stranger in, so only the process that already holds this host's own token, over a
              // socket no machine's requests arrive on, may mint one.
              if (!ownRoad() || me?.kind !== "host") {
                send({ id: msg.id, ok: false, error: PAIR_ISSUE_REFUSAL });
                return;
              }
              // The fingerprint of the key this host proves travels beside the code, so the computer taking it
              // holds this host to that key before it spends it. A runtime wired with no place door proves none
              // and answers the code alone, which the line that asked refuses to print in its own words.
              const hostKey = rt.places?.hostKey();
              const { code, expiresAt } = await issueCode(msg.here === true);
              send({ id: msg.id, ok: true, code, expiresAt, ...(hostKey === undefined ? {} : { hostKey }) });
              return;
            }
            case "pair.redeem":
              // The door above spends a code; a socket already through it is asking for a second identity.
              send({ id: msg.id, ok: false, error: PAIR_CODE_REFUSAL });
              return;
            case "device.auth":
              // The door above admits a computer on the account; this socket is already somebody.
              send({ id: msg.id, ok: false, error: DEVICE_AUTH_REFUSAL });
              return;
            case "seal.open":
              // The door above agrees the key, before this socket said who it is; one is agreed per socket and
              // this one is already through.
              send({ id: msg.id, ok: false, error: UNAUTHORIZED });
              return;
            case "place.join":
            case "place.auth":
            case "place.prove":
              // The door above is where a place proves itself; a socket already through it is asking for a second
              // identity, and this host holds one identity per socket.
              send({ id: msg.id, ok: false, error: PLACE_UNKNOWN_REFUSAL });
              return;
            case "places.list":
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, places: await places().list(now()), adds: places().adds() });
              return;
            case "places.update": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, ...(await places().update(msg.placeId, msg.addId)) });
              return;
            }
            case "places.remove": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, ...(await places().remove(msg.placeId)) });
              return;
            }
            case "places.dial": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, ...(await places().dial(msg.placeId, now())) });
              return;
            }
            case "places.loginLanded": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              await places().loginLanded(msg.placeId, msg.agent);
              send({ id: msg.id, ok: true });
              return;
            }
            case "places.doctor": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              if (opts.doctor === undefined) {
                send({ id: msg.id, ok: false, error: DOCTOR_UNSERVED });
                return;
              }
              const rows = await places().list(now());
              const row = rows.find(place => place.id === msg.placeId);
              if (row === undefined) {
                send({ id: msg.id, ok: false, error: noSuchPlaceRefusal(msg.placeId, rows.map(place => place.name)), kind: "usage" });
                return;
              }
              // The road makes a workspace on a computer somebody joined and reads the tools inside it: the row for
              // the computer this host runs on and a provider's row are proved where the line was typed, so they
              // are refused here rather than failing at the first step of a road they were never for.
              if (!isJoinedComputer(row)) {
                send({ id: msg.id, ok: false, error: doctorRowRefusal(row.name), kind: "usage" });
                return;
              }
              if (doctoring.has(row.id)) {
                send({ id: msg.id, ok: false, error: doctorRunningLine(row.name), kind: "conflict" });
                return;
              }
              doctoring.add(row.id);
              try {
                const { code } = await opts.doctor.run({ placeId: row.id, doctorId: msg.doctorId, ...(msg.project !== undefined ? { project: msg.project } : {}) });
                send({ id: msg.id, ok: true, code });
              } finally {
                doctoring.delete(row.id);
              }
              return;
            }
            case "places.door": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACE_DOOR_REFUSAL });
                return;
              }
              if (opts.door === undefined) {
                send({ id: msg.id, ok: false, error: PLACE_DOOR_UNSERVED });
                return;
              }
              // Where to dial is the host's, the key answered there is the place door's own: one view, so a line
              // built from it cannot name an address without the key that will answer at it.
              const { backPort: _loopback, ...view } = await opts.door.open();
              send({ id: msg.id, ok: true, door: { ...view, hostKey: places().hostKey() } });
              return;
            }
            case "places.mint": {
              if (!ownRoad() || me?.kind !== "host") {
                send({ id: msg.id, ok: false, error: MINT_JOIN_REFUSAL });
                return;
              }
              if (opts.door === undefined) {
                send({ id: msg.id, ok: false, error: PLACE_DOOR_UNSERVED });
                return;
              }
              // The key and the door before the code, so a host that cannot answer a join leaves no code minted.
              const hostKey = places().hostKey();
              const door = await opts.door.open();
              const { code, expiresAt } = await issueCode(false);
              send({ id: msg.id, ok: true, joins: joinRoads(joinToken(code, hostKey), door.addresses, door.relay), expiresAt: new Date(expiresAt).toISOString() });
              return;
            }
            case "places.sshHosts": {
              if (!ownRoad() || me?.kind !== "host") {
                send({ id: msg.id, ok: false, error: SSH_HOSTS_REFUSAL });
                return;
              }
              const rows = rt.places === undefined ? [] : await rt.places.list(now());
              send({ id: msg.id, ok: true, hosts: opts.sshHosts === undefined ? [] : await opts.sshHosts(rows) });
              return;
            }
            case "places.add": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              // The addresses the computer being installed on is to dial are the door's own reading, asked for here
              // rather than read a second time inside the door: a host that opens none could never be dialled back.
              if (opts.door === undefined) {
                send({ id: msg.id, ok: false, error: PLACE_DOOR_UNSERVED });
                return;
              }
              const at = await opts.door.open();
              const added = await places().add(
                {
                  ...(msg.addId !== undefined ? { addId: msg.addId } : {}),
                  address: msg.address,
                  ...(msg.name !== undefined ? { name: msg.name } : {}),
                  ...(msg.sshPort !== undefined ? { sshPort: msg.sshPort } : {}),
                  ...(msg.keyPath !== undefined ? { keyPath: msg.keyPath } : {}),
                  ...(msg.hostKey !== undefined ? { hostKey: msg.hostKey } : {}),
                  hostUrls: [...at.addresses, ...(at.relay === undefined ? [] : [at.relay])],
                  ...(at.backPort !== undefined ? { doorPort: at.backPort } : {}),
                  ...(at.relay !== undefined ? { relay: at.relay } : {}),
                },
                now(),
              );
              send({ id: msg.id, ok: true, ...added });
              return;
            }
            case "account.get": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: ACCOUNT_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              if (opts.account === undefined) {
                send({ id: msg.id, ok: false, error: ACCOUNT_UNSERVED });
                return;
              }
              send({ id: msg.id, ok: true, account: await opts.account.read() });
              return;
            }
            case "devices.list":
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: DEVICES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, devices: await devices().list() });
              return;
            case "devices.revoke": {
              // A paired computer takes any device's token away, its own included: the laptop is where a person
              // looks to see who holds a token to their box. A ticket's socket still cannot, whoever minted it.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: DEVICES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              // The reply goes between the record and the cut, so a device that revoked itself reads the answer
              // before its own socket goes.
              await revokeDevice(msg.deviceId, revoked => send({ id: msg.id, ok: true, revoked }));
              return;
            }
            case "ticket.issue": {
              if (stamped !== undefined) {
                send({ id: msg.id, ok: false, error: RELAY_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              const ticket = randomBytes(24).toString("base64url");
              const expiresAt = now() + ticketTtlMs;
              tickets.set(ticket, { purpose: msg.purpose, expiresAt, paired: pairedRoad });
              send({ id: msg.id, ok: true, ticket, expiresAt });
              return;
            }
            case "events.subscribe": {
              // Replay is read and the listener attached in one synchronous step, so no event falls between them.
              const { stream, head, events, gap } = rt.events.since(msg.after, msg.stream);
              // An event about a workspace this caller may not drive never reaches it, replayed or live: a socket
              // that may not read a workspace's rows may not read its turns going by either. Read through the
              // runtime's one rule, so what a listing hides and what the stream hides cannot come apart.
              const pass = (e: unknown): void => {
                if (rt.workspaces.seenBy(e, origin)) send(e as Record<string, unknown>);
              };
              detaches.push(rt.events.on("*", pass));
              if (opts.forwards) detaches.push(opts.forwards.on(pass));
              if (opts.init) detaches.push(opts.init.on(pass));
              if (opts.doctor) detaches.push(opts.doctor.on(pass));
              if (opts.release) detaches.push(opts.release.on(pass));
              send({ id: msg.id, ok: true, seq: head, stream, ...(gap ? { gap: true } : {}) });
              for (const e of events) pass(e);
              return;
            }
            case "status.subscribe":
              // Watch before the snapshot so no change falls between them;
              // socket close releases the watcher via detaches.
              detaches.push(rt.status.watch());
              send({ id: msg.id, ok: true, statuses: await rt.status.list(undefined, origin) });
              return;
            case "status.list": {
              // The provider is asked only where a reach failed: a bare list asks it for every machine, and every
              // such ask resets the provider's idle timer, so a caller listing in a loop would keep them all awake.
              // No exec probe either, so the wait is one reach probe; the poller keeps the zombie verdict. The run
              // of probes this read joins is the listing doors' own, so an agent listing in a loop cannot spend the
              // silence the person's sidebar row is waiting out.
              const statuses = await rt.status.list({ reconcile: "on-failure", zombieProbe: false, reader: "table" }, origin);
              // Through the schema, so the route the reach carries is dropped rather than remembered about: it is
              // the provider's minted bearer, and this door answers a person's terminal and an agent's transcript.
              send({ id: msg.id, ok: true, statuses: statuses.map(s => WorkspaceListing.parse(s)) });
              return;
            }
            case "workspaces.create": {
              const { id, op, origin: _sent, ...rest } = msg;
              void op;
              const { notice, ...workspace } = await rt.workspaces.create(rest, origin);
              send({ id, ok: true, workspace: handed(workspace), ...(notice !== undefined ? { notice } : {}) });
              return;
            }
            case "workspaces.landing":
              send({ id: msg.id, ok: true, ...(await rt.workspaces.landing({ project: msg.project }, origin)) });
              return;
            case "workspaces.list":
              send({ id: msg.id, ok: true, workspaces: (await rt.workspaces.list(origin)).map(handed) });
              return;
            case "workspaces.resolve":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.resolve(msg.ref, origin)) });
              return;
            case "workspaces.get":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.get(msg.workspaceId, origin)) });
              return;
            case "workspaces.nap":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.nap(msg.workspaceId, origin)) });
              return;
            case "workspaces.wake":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.wake(msg.workspaceId, origin)) });
              return;
            case "workspaces.stopWake":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.stopWake(msg.workspaceId, origin)) });
              return;
            case "workspaces.restartDaemon":
              await rt.workspaces.restartDaemon(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.upgrade":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.upgrade(msg.workspaceId, origin)) });
              return;
            case "workspaces.updateImage": {
              const moved = await rt.workspaces.updateImage(msg.workspaceId, origin);
              send({ id: msg.id, ok: true, workspace: handed(moved.workspace), moved: moved.moved, kept: moved.kept, ...(moved.fallback === true ? { fallback: true } : {}) });
              return;
            }
            case "workspaces.rename":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.rename(msg.workspaceId, msg.name, origin)) });
              return;
            case "workspaces.look":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.look(msg.workspaceId, { ...(msg.theme !== undefined ? { theme: msg.theme } : {}), ...(msg.glyph !== undefined ? { glyph: msg.glyph } : {}) }, origin)) });
              return;
            case "workspaces.agents": {
              const { id, op, workspaceId, origin: _sent, ...patch } = msg;
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.agents(workspaceId, patch, origin)) });
              return;
            }
            case "workspaces.bringBack": {
              const brought = await rt.workspaces.bringBack(
                { workspaceId: msg.workspaceId, ...(msg.title !== undefined ? { title: msg.title } : {}), ...(msg.body !== undefined ? { body: msg.body } : {}) },
                origin,
              );
              send({ id: msg.id, ok: true, ...brought });
              return;
            }
            case "workspaces.delete":
              await rt.workspaces.delete(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.forget":
              await rt.workspaces.forget(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.snapshot":
              send({ id: msg.id, ok: true, projectGolden: await rt.workspaces.snapshot(msg.workspaceId, origin) });
              return;
            case "projects.add": {
              const { notice, ...project } = await rt.projects.add({ source: msg.source, ...(msg.on !== undefined ? { on: msg.on } : {}), ...(msg.name !== undefined ? { name: msg.name } : {}), ...(msg.base !== undefined ? { base: msg.base } : {}), ...(msg.seed !== undefined ? { seed: msg.seed } : {}) }, origin);
              send({ id: msg.id, ok: true, project, ...(notice !== undefined ? { notice } : {}) });
              return;
            }
            case "projects.list":
              send({ id: msg.id, ok: true, projects: await rt.projects.list(origin) });
              return;
            case "projects.resolve":
              send({ id: msg.id, ok: true, project: await rt.projects.resolve(msg.ref, origin) });
              return;
            case "projects.remove":
              send({ id: msg.id, ok: true, ...(await rt.projects.remove(msg.projectId, origin)) });
              return;
            case "projectGoldens.list":
              send({ id: msg.id, ok: true, projectGoldens: await rt.golden.projects() });
              return;
            case "projectGoldens.remove":
              send({ id: msg.id, ok: true, ...(await rt.golden.removeProject(msg.snapshotId)) });
              return;
            case "workspaces.touch":
              await rt.workspaces.touch(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "daemon.open": {
              const channel = randomBytes(6).toString("hex");
              // The daemon pushes its hello right after the auth reply, so frames that land before the open reply is
              // written wait here and go out after it: a page hears a channel's id before anything arrives on it.
              let queued: Record<string, unknown>[] | null = [];
              const onEvent = (event: Record<string, unknown>): void => {
                if (queued !== null) queued.push(event);
                else send({ type: "daemon.event", channel, event });
              };
              let ch: DaemonChannel;
              if (msg.placeId !== undefined) {
                // A computer the person owns is driven from this host's own terminal and its own window, the same
                // gate every other places op reads; the channel rides the link that computer opened, or dials this
                // computer's own daemon where the place is this one.
                if (msg.workspaceId !== undefined) throw new Error(DAEMON_OPEN_ONE_OF);
                if (!ownRoad()) {
                  send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                  return;
                }
                if (msg.placeId === HERE_PLACE_ID) ch = await rt.hereChannel(onEvent);
                else {
                  const onLink = places().channel(msg.placeId, onEvent);
                  if (onLink === undefined) throw new Error(absentComputer(places().nameOf(msg.placeId), null).sentence);
                  ch = onLink;
                }
              } else {
                if (msg.workspaceId === undefined) throw new Error(DAEMON_OPEN_ONE_OF);
                // The same gate every workspace verb reads: a socket that may not drive this workspace is refused
                // here. Which road the frames take is the runtime's own reading, dial or link, and not this door's.
                ch = await rt.workspaces.daemonChannel(msg.workspaceId, onEvent, origin);
              }
              // The page left while the dial was in flight; the machine keeps no socket for a tab that is gone.
              if (ws.readyState !== ws.OPEN) {
                ch.close();
                return;
              }
              channels.set(channel, ch);
              void ch.closed.then(({ code, reason }) => {
                // Still ours means the page did not ask for this close, so it is told; a close it asked for is silent.
                if (channels.get(channel) !== ch) return;
                channels.delete(channel);
                send({ type: "daemon.closed", channel, code, reason });
              });
              send({ id: msg.id, ok: true, channel });
              const held = queued;
              queued = null;
              for (const event of held) send({ type: "daemon.event", channel, event });
              return;
            }
            case "daemon.send": {
              const ch = channels.get(msg.channel);
              if (ch === undefined) throw new Error("no such daemon channel on this socket");
              // The host reads none of the frame and none of the answer: the page validates what it asked for.
              send({ id: msg.id, ok: true, reply: await ch.send(msg.frame) });
              return;
            }
            case "daemon.close": {
              const ch = channels.get(msg.channel);
              if (ch === undefined) throw new Error("no such daemon channel on this socket");
              channels.delete(msg.channel);
              ch.close();
              send({ id: msg.id, ok: true });
              return;
            }
            case "guest.open": {
              // The session's tools dial this host as whoever it names, so it is the owner's own socket or nothing:
              // a paired computer and a thread each have their own road to the tools, under their own token.
              if (me?.kind !== "host" || !ownRoad()) {
                send({ id: msg.id, ok: false, error: hereGuestRefusal, kind: "auth" });
                return;
              }
              if (opts.here === undefined) throw new Error(guestNoKindLine(msg.kind));
              if (guest !== undefined) throw new Error(guestSessionHeldLine);
              if (msg.kind !== "mcp") throw new Error(guestNoKindLine(msg.kind));
              // The reply goes first: the client reads nothing until its open is answered.
              send({ id: msg.id, ok: true, session: HERE_GUEST_SESSION });
              let ended = false;
              const session = opts.here.open({
                argv: msg.argv,
                cwd: msg.cwd,
                env: { ...msg.env, ...(msg.turnToken !== undefined ? { [TURN_TOKEN_ENV]: msg.turnToken } : {}) },
                reply: message => {
                  if (!ended) send({ type: "guest.message", message } satisfies HereGuestEvent);
                },
                close: error => {
                  if (ended) return;
                  ended = true;
                  guest = undefined;
                  send({ type: "guest.closed", ...(error !== undefined ? { error } : {}) } satisfies HereGuestEvent);
                },
              });
              if (ended) session.close();
              else guest = session;
              return;
            }
            case "guest.send": {
              if (guest === undefined) throw new Error(guestNoSessionLine);
              guest.message(msg.message);
              send({ id: msg.id, ok: true });
              return;
            }
            case "sys.subscribe": {
              // One subscription per workspace per socket: a person opening the pane a second time reads the same
              // stream, and the sampler behind it stays the one thing reading this computer.
              if (watchedSys.has(msg.workspaceId)) {
                send({ id: msg.id, ok: true });
                return;
              }
              const workspaceId = msg.workspaceId;
              watchedSys.add(workspaceId);
              const detach = await rt.workspaces.watchSys(workspaceId, sample => send({ type: "workspace.sys", workspaceId, sample }), origin).catch((e: unknown) => {
                watchedSys.delete(workspaceId);
                throw e;
              });
              // The page left while the first reading was in flight; nothing keeps sampling for a socket that is gone.
              if (ws.readyState !== ws.OPEN) {
                detach();
                return;
              }
              detaches.push(detach);
              send({ id: msg.id, ok: true });
              return;
            }
            case "sessions.start": {
              const handle = await rt.sessions.start(msg.workspaceId, {
                prompt: msg.prompt,
                ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
                ...(msg.resume !== undefined ? { resume: msg.resume } : {}),
                ...(msg.thread !== undefined ? { thread: msg.thread } : {}),
                ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
                ...(msg.model !== undefined ? { model: msg.model } : {}),
                ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
                ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
                ...(msg.contextWindow !== undefined ? { contextWindow: msg.contextWindow } : {}),
                ...(msg.startedBy !== undefined ? { startedBy: msg.startedBy } : {}),
                ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
                ...(msg.notify !== undefined ? { notify: msg.notify } : {}),
                ...(msg.turnToken !== undefined ? { turnToken: msg.turnToken } : {}),
                ...(msg.title !== undefined ? { title: msg.title } : {}),
                ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
              }, origin);
              send({ id: msg.id, ok: true, session: handle.view(), outcome: handle.outcome, turnId: handle.turnId });
              return;
            }
            case "harnesses.list":
              send({ id: msg.id, ok: true, harnesses: await rt.harnesses.list(msg.workspaceId, origin) });
              return;
            case "sessions.list":
              send({ id: msg.id, ok: true, sessions: await rt.sessions.list(msg.workspaceId, origin) });
              return;
            case "sessions.history":
              send({ id: msg.id, ok: true, events: await rt.sessions.history(msg.workspaceId, origin) });
              return;
            case "sessions.interrupt":
              send({ id: msg.id, ok: true, ...(await rt.sessions.interrupt(msg.sessionId, origin)) });
              return;
            case "sessions.answer":
              send({ id: msg.id, ok: true, ...(await rt.sessions.answer(msg.sessionId, { askId: msg.askId, optionId: msg.optionId }, origin)) });
              return;
            case "sessions.access":
              send({ id: msg.id, ok: true, ...(await rt.sessions.access(msg.sessionId, msg.permissionMode, origin)) });
              return;
            case "sessions.rename":
              send({ id: msg.id, ok: true, ...(await rt.sessions.rename(msg.sessionId, msg.title, origin)) });
              return;
            case "sessions.forget":
              await rt.sessions.forget(msg.threadId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "sessions.steer":
              send({ id: msg.id, ok: true, ...(await rt.sessions.steer(msg.sessionId, { prompt: msg.prompt, ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}) }, origin)) });
              return;
            case "golden.get":
              send({ id: msg.id, ok: true, manifest: await rt.golden.get(msg.name) });
              return;
            case "capabilities.get":
              send({ id: msg.id, ok: true, capabilities: rt.backend.capabilities });
              return;
            case "golden.prepare":
              send({
                id: msg.id,
                ok: true,
                builder: await rt.golden.prepare({ name: msg.name, ...(msg.kind !== undefined ? { kind: msg.kind } : {}) }),
              });
              return;
            case "golden.seal":
              send({ id: msg.id, ok: true, ...(await rt.golden.seal(msg.builderId)) });
              return;
            case "snapshots.list": {
              const name = msg.name ?? "default";
              const manifest = await rt.golden.get(name);
              send({ id: msg.id, ok: true, lineage: { name, head: manifest?.head ?? null, versions: manifest?.versions ?? [] } });
              return;
            }
            case "snapshots.storage":
              send({ id: msg.id, ok: true, storage: (await rt.golden.storage()) ?? null });
              return;
            case "cost.history":
              send({ id: msg.id, ok: true, points: await rt.status.history(msg.workspaceId, origin) });
              return;
            case "cost.spend":
              // What the person's computers and providers have cost them is read on the same road their list is:
              // a socket let in on a ticket sees neither.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, places: await rt.status.spend((await rt.places?.list(now())) ?? []) });
              return;
            case "snapshots.rollback": {
              const name = msg.name ?? "default";
              const manifest = await rt.golden.rollback(msg.version, name);
              send({
                id: msg.id,
                ok: true,
                lineage: { name, head: manifest.head, versions: manifest.versions },
                existingWorkspaces: "untouched",
              });
              return;
            }
            case "image.get":
              send({ id: msg.id, ok: true, view: await rt.image.get(msg.name) });
              return;
            case "image.build":
              send({
                id: msg.id,
                ok: true,
                build: await rt.image.build({
                  place: msg.place,
                  ...(msg.name !== undefined ? { name: msg.name } : {}),
                  ...(msg.force !== undefined ? { force: msg.force } : {}),
                }),
              });
              return;
            case "image.export": {
              const { image, tar } = await rt.image.vault(msg.name);
              send({ id: msg.id, ok: true, exported: await imageExport()({ image, tar, dest: msg.dest, passphrase: msg.passphrase }) });
              return;
            }
            case "workspaces.portReach":
              send({ id: msg.id, ok: true, reach: await rt.workspaces.portReach(msg.workspaceId, msg.port, origin) });
              return;
            case "workspaces.portProbe":
              send({ id: msg.id, ok: true, probe: await rt.workspaces.portProbe(msg.workspaceId, msg.port, origin) });
              return;
            case "workspaces.rebuild":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.rebuild(msg.workspaceId, origin)) });
              return;
            case "forwards.list": {
              const shown: PortForward[] = [];
              for (const f of opts.forwards?.list() ?? []) if ((await rt.workspaces.originRefusal(f.workspaceId, origin)) === undefined) shown.push(f);
              send({ id: msg.id, ok: true, forwards: shown });
              return;
            }
            case "forwards.stop": {
              const refusal = await rt.workspaces.originRefusal(msg.workspaceId, origin);
              if (refusal !== undefined) throw new Error(refusal);
              if (!opts.forwards?.stop(msg.workspaceId, msg.port)) throw new Error(`nothing is forwarding localhost:${msg.port} for that workspace`);
              send({ id: msg.id, ok: true });
              return;
            }
            case "workspaces.exec": {
              const stream = await rt.workspaces.execStream(msg.workspaceId, msg.argv, msg.cwd, origin);
              const execId = randomBytes(6).toString("hex");
              let running = true;
              detaches.push(() => {
                if (running) stream.teardown();
              });
              const push = (e: ExecEvent): void => send(e);
              // The folder rides the reply, so the client prints where the command ran instead of restating the rule.
              send({ id: msg.id, ok: true, execId, ...(stream.ranIn !== undefined ? { cwd: stream.ranIn } : {}) });
              void (async () => {
                let error: string | undefined;
                try {
                  for await (const text of stream.lines) push({ type: "exec.output", execId, text });
                } catch (e) {
                  error = e instanceof Error ? e.message : String(e);
                }
                const exitCode = await stream.exited;
                running = false;
                push({ type: "exec.exit", execId, exitCode, ...(error !== undefined ? { error } : {}) });
              })();
              return;
            }
            case "host.folders": {
              const asked = { ...(msg.dir !== undefined ? { dir: msg.dir } : {}), ...(msg.hidden !== undefined ? { hidden: msg.hidden } : {}), ...(msg.repos === true ? { repos: true } : {}) };
              if (msg.on === undefined || msg.on === HERE_PLACE_ID) {
                // Only this computer's own window walks the whole disk: a paired or relayed device, or a thread on any
                // machine, stays inside the home folder and the projects.
                send({ id: msg.id, ok: true, listing: await folders().list({ ...asked, wide: road === "here" && by === undefined }) });
                return;
              }
              // Another computer's disk is read over the link it holds, which is the places road: the host's own.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, listing: await placeFolders(msg.on, asked, origin) });
              return;
            }
            case "agents.read":
              // What stands on the person's computers is a places read: never a machine's or a relayed ticket's to take.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL });
                return;
              }
              send({ id: msg.id, ok: true, report: await rt.agents.read(msg.target, origin) });
              return;
            case "servers.tools":
              // Starting a server on one of the person's computers is theirs alone, as every places act is.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL });
                return;
              }
              send({ id: msg.id, ok: true, answer: await rt.agents.tools(msg.target, { agent: msg.agent, name: msg.name, ...(msg.refresh !== undefined ? { refresh: msg.refresh } : {}) }, origin) });
              return;
            case "servers.icon":
              // Google is asked by this host for the person's own windows alone: a ticket or a device draws the glyph.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, icon: await rt.agents.serversIcon(msg.host, msg.refresh) });
              return;
            case "agents.signIn":
            case "servers.signIn": {
              // A sign-in on one of the person's computers is theirs alone, and its page and code go to the sockets
              // following it and to no other: they are what finishes that login.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              let queued: Record<string, unknown>[] | null = [];
              const emit = (event: Record<string, unknown>): void => {
                if (queued !== null) queued.push(event);
                else if (ws.readyState === ws.OPEN) send(event);
              };
              const ask = msg.op === "servers.signIn" ? { agent: msg.agent, server: msg.name } : { agent: msg.agent };
              const { signInId, leave } = await rt.agents.signIn(msg.target, ask, emit, origin);
              if (signIns.has(signInId)) {
                leave();
                send({ id: msg.id, ok: true, signInId });
                return;
              }
              signIns.add(signInId);
              detaches.push(leave);
              if (ws.readyState !== ws.OPEN) {
                leave();
                return;
              }
              send({ id: msg.id, ok: true, signInId });
              const held = queued;
              queued = null;
              for (const event of held) send(event);
              return;
            }
            case "agents.signInCode":
            case "agents.signInStop":
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              if (!signIns.has(msg.signInId)) {
                send({ id: msg.id, ok: false, error: noSignInRefusal, kind: "usage" });
                return;
              }
              if (msg.op === "agents.signInCode") await rt.agents.signInCode(msg.signInId, msg.code);
              else rt.agents.signInStop(msg.signInId);
              send({ id: msg.id, ok: true });
              return;
            case "agents.signInLine":
              // It carries paths and commands only, and only the host's own command line runs one.
              if (!ownRoad() || me?.kind !== "host") {
                send(ownRoad() ? { id: msg.id, ok: false, error: SIGN_IN_LINE_REFUSAL } : { id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, line: await rt.agents.signInLine(msg.target, { agent: msg.agent, ...(msg.name !== undefined ? { server: msg.name } : {}) }, origin) });
              return;
            case "agents.key":
              // A token crosses this socket into the vault, so only the host's own process may send one, as a
              // pairing code is only minted there.
              if (!ownRoad() || me?.kind !== "host") {
                send({ id: msg.id, ok: false, error: AGENTS_KEY_REFUSAL });
                return;
              }
              await rt.agents.key(msg.agent, msg.key);
              send({ id: msg.id, ok: true });
              return;
            case "agents.addTools":
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              send({ id: msg.id, ok: true, ...(await rt.agents.addTools(msg.target, msg.agent, origin)) });
              return;
            case "skills.search":
            case "skills.get":
            case "skills.preview":
            case "skills.add":
            case "skills.remove":
            case "skills.toggle": {
              // skills.sh is asked by this host alone, and a skill on one of the person's computers is theirs to change.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              const skill = (ask: { name: string; project?: boolean }) => ({ name: ask.name, ...(ask.project !== undefined ? { project: ask.project } : {}) });
              if (msg.op === "skills.search") send({ id: msg.id, ok: true, skills: await rt.agents.skillsSearch(msg.q, msg.limit) });
              else if (msg.op === "skills.get") send({ id: msg.id, ok: true, preview: await rt.agents.skillsGet(msg.skill) });
              else if (msg.op === "skills.preview") send({ id: msg.id, ok: true, preview: await rt.agents.skillsPreview(msg.target, skill(msg), origin) });
              else if (msg.op === "skills.add") {
                const ask = { skill: msg.skill, ...(msg.agents !== undefined ? { agents: msg.agents } : {}), ...(msg.project !== undefined ? { project: msg.project } : {}) };
                send({ id: msg.id, ok: true, added: await rt.agents.skillsAdd(msg.target, ask, origin) });
              } else if (msg.op === "skills.remove") send({ id: msg.id, ok: true, ...(await rt.agents.skillsRemove(msg.target, skill(msg), origin)) });
              else send({ id: msg.id, ok: true, ...(await rt.agents.skillsToggle(msg.target, { ...skill(msg), on: msg.on }, origin)) });
              return;
            }
            case "servers.add":
            case "servers.remove":
            case "servers.toggle": {
              // A server in an agent's config on one of the person's computers is theirs to change, and the values an
              // add carries go into that file or the vault, never into an answer.
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              if (msg.op === "servers.add") {
                const { id: _id, op: _op, target, ...ask } = msg;
                send({ id: msg.id, ok: true, ...(await rt.agents.serversAdd(target, ask, origin)) });
                return;
              }
              const ask = { agent: msg.agent, name: msg.name, ...(msg.scope !== undefined ? { scope: msg.scope } : {}) };
              if (msg.op === "servers.remove") send({ id: msg.id, ok: true, ...(await rt.agents.serversRemove(msg.target, ask, origin)) });
              else send({ id: msg.id, ok: true, ...(await rt.agents.serversToggle(msg.target, { ...ask, on: msg.on }, origin)) });
              return;
            }
            case "host.terminalConfig":
              send({ id: msg.id, ok: true, config: await terminalConfig().read(msg.scheme) });
              return;
            case "init.get":
              send({ id: msg.id, ok: true, setup: await init().get(msg.on === undefined ? {} : { on: msg.on }) });
              return;
            case "init.keys":
              send({ id: msg.id, ok: true, setup: await init().keys({ ...(msg.provider !== undefined ? { provider: msg.provider } : {}), ...(msg.key !== undefined ? { key: msg.key } : {}), ...(msg.rows !== undefined ? { rows: msg.rows } : {}) }) });
              return;
            case "init.start":
              send({ id: msg.id, ok: true, job: await init().start({ road: msg.road, ...(msg.harness !== undefined ? { harness: msg.harness } : {}), ...(msg.on !== undefined ? { on: msg.on } : {}) }) });
              return;
            case "init.answer":
              send({ id: msg.id, ok: true, job: await init().answer({ screen: msg.screen, ...(msg.ticks !== undefined ? { ticks: msg.ticks } : {}), ...(msg.answers !== undefined ? { answers: msg.answers } : {}) }) });
              return;
            case "init.step":
              send({ id: msg.id, ok: true, job: await init().step({ at: msg.at }) });
              return;
            case "init.draft":
              send({ id: msg.id, ok: true, job: await init().draft({ at: msg.at, ...(msg.ticks !== undefined ? { ticks: msg.ticks } : {}), ...(msg.answers !== undefined ? { answers: msg.answers } : {}) }) });
              return;
            case "init.retry":
              send({ id: msg.id, ok: true, job: await init().retry({ tool: msg.tool }) });
              return;
            case "init.build":
              send({ id: msg.id, ok: true, job: await init().build({ ...(msg.firstWorkspace !== undefined ? { firstWorkspace: msg.firstWorkspace } : {}), ...(msg.importFolder !== undefined ? { importFolder: msg.importFolder } : {}), ...(msg.yes !== undefined ? { yes: msg.yes } : {}), ...(msg.on !== undefined ? { on: msg.on } : {}), ...(msg.rebuild !== undefined ? { rebuild: msg.rebuild } : {}) }) });
              return;
            case "init.signInCode":
              send({ id: msg.id, ok: true, job: await init().signInCode({ tool: msg.tool, code: msg.code }) });
              return;
            case "init.cancel":
              send({ id: msg.id, ok: true, job: await init().cancel() });
              return;
            case "preferences.get":
              send({ id: msg.id, ok: true, preferences: await rt.preferences.get() });
              return;
            case "preferences.set":
              send({ id: msg.id, ok: true, ...(await rt.preferences.set(msg.patch)) });
              return;
            case "release.get":
              send({ id: msg.id, ok: true, release: release().get() });
              return;
            case "release.check":
              send({ id: msg.id, ok: true, release: await release().check() });
              return;
            case "host.restart": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: HOST_RESTART_TICKET_REFUSAL, kind: "ticket" });
                return;
              }
              if (opts.restart === undefined) throw new Error(HOST_NO_RESTART_LINE);
              if (opts.restart.refusal !== undefined) throw new Error(opts.restart.refusal);
              send({ id: msg.id, ok: true });
              // A second ask while the first is closing the host would close it twice and start two successors.
              // A restart that failed leaves this host serving, so the next ask may try again.
              restarting ??= opts.restart.restart().catch((e: unknown) => {
                restarting = undefined;
                opts.log?.(`host.restart failed: ${e instanceof Error ? e.message : String(e)}`);
              });
              return;
            }
            case "project.seed.plan":
              send({ id: msg.id, ok: true, plan: await rt.projects.seedPlan(msg.source) });
              return;
            case "project.plan":
              send({ id: msg.id, ok: true, plan: await bundler(msg.source).plan() });
              return;
            case "project.import": {
              const { workspaceId, source, dest, replace, carry, rewrite, agents } = msg;
              send({ id: msg.id, ok: true, imported: await rt.projects.import({ workspaceId, source, dest, replace, carry, rewrite, agents, bundler: bundler(source) }, origin) });
              return;
            }
            case "project.export": {
              const { workspaceId, source, dest, replace, agents } = msg;
              send({ id: msg.id, ok: true, exported: await rt.projects.export({ workspaceId, source, dest, replace, agents, lander: lander() }, origin) });
              return;
            }
          }
        } catch (e) {
          const { kind, fix } = e as { kind?: unknown; fix?: unknown };
          send({
            id: msg.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            ...(typeof kind === "string" ? { kind } : {}),
            ...(typeof fix === "string" ? { fix } : {}),
          });
        }
      })();
    };
    ws.on("message", onMessage);
  };

  wss.on("connection", onConnection);
  attached?.on("connection", onConnection);

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
  const servers = attached === undefined ? [wss] : [wss, attached];
  const clients = (): WebSocket[] => servers.flatMap(server => [...server.clients]);

  return {
    port,
    authorize: async token => (token === undefined || token === "" ? undefined : whoIs(token)),
    revokeDevice,
    close: async () => {
      for (const server of attachTo) server.off("upgrade", onUpgrade);
      // The socket did not break under a client, the host let it go: the close code is what tells a command waiting
      // on a turn that its turn goes on. A client that does not answer the frame is cut, so a stop stays bounded.
      for (const client of clients()) client.close(HOST_STOPPING_CLOSE, "stopping");
      const cut = setTimeout(() => {
        for (const client of clients()) client.terminate();
      }, STOP_GRACE_MS);
      try {
        await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))));
      } finally {
        clearTimeout(cut);
      }
    },
  };
}
