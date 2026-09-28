// SPDX-License-Identifier: AGPL-3.0-only
// The laptop half of the sign-in callback relay and of the localhost forwards.
// One daemon link per running workspace (and the init builder), and one per
// computer this host holds as a place, for sign-in callbacks only and only
// while a sign-in there runs: a browser.open from the guest is shown by the app
// (opened here only when autoOpen says so), and the flow's callback port is
// listened on locally and tunnelled back over that link for a bounded window.
// A local URL the guest printed forwards its port the same way, one per port,
// until it sees no traffic for a while. The URL is never logged.

import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { PassThrough } from "node:stream";
import { DaemonEvent, LOOPBACK, callbackPortOf, hostOf, isHttpUrl, isJoinedComputer, isLoopback, type AgentsTarget, type DaemonReachView, type ForwardEvent, type GoldenBuilderView, type PortForward } from "@wsp/protocol";
import { plumbTunnel, realClock, tunnelFrame, type Clock, type DaemonChannel, type EventUnion, type Runtime, type SignInForward } from "@wsp/runtime";
import { DAEMON_CONNECT_TIMEOUT_MS, connectDaemonSocket, type ConnectOptions, type DaemonSocket } from "./doctor.js";
import type { GuestDoor } from "./guest.js";

export type UrlOpener = (url: string) => Promise<boolean>;

/** The command this computer opens a page with; the sign-in hand-off prints it for the person to run. */
export function openerCommand(os: NodeJS.Platform = platform()): string {
  return os === "darwin" ? "open" : os === "win32" ? "explorer" : "xdg-open";
}

/** Runs the platform opener and reports whether it exited clean. */
export function systemOpener(os: NodeJS.Platform = platform()): UrlOpener {
  const cmd = openerCommand(os);
  return url =>
    new Promise(resolve => {
      const child = spawn(cmd, [url], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", code => resolve(code === 0));
    });
}

export interface RelayOptions {
  runtime: Runtime;
  /** Opens an http(s) URL on this computer; used only when autoOpen says so. */
  openUrl: UrlOpener;
  /** Whether a browser.open from this target opens without a click. Off by
   * default: the app shows the page and the person opens it. A flow started
   * from the TUI is the case that turns it on (the caller decides). Asked once
   * per event, right before openUrl runs, so a caller that clears its arm
   * inside openUrl is one-shot without a race. Given the callback port when
   * the page names one, so a caller that declines can keep that page for a
   * later click. */
  autoOpen?: (targetId: string, url: string, port?: number) => boolean;
  /** The one line logged when a page arrives and nothing opens, given the workspace name and the URL's hostname; the TUI supplies its own. */
  openLine?: (workspace: string, hostname: string, url: string) => string;
  /** One line per open, forward, refusal and close; never the URL. */
  log: (line: string) => void;
  /** Where a guest session on one of these machines is served. Absent leaves the guest road off: this link is the
   * one socket the host holds into a running workspace, so nothing else is there to watch for one. */
  guest?: GuestDoor;
  builder?: GoldenBuilderView;
  clock?: Clock;
  /** A forward whose port the guest was never seen listening on closes after this. Default 3 min. */
  windowMs?: number;
  /** No callback forward lives longer than this, listener or not. Default 15 min. */
  capMs?: number;
  /** A forward for a printed local URL closes after this long with no connection and no bytes. Default 10 min. */
  idleMs?: number;
  connect?: (opts: ConnectOptions) => Promise<DaemonSocket>;
  /** First redial pause after a link drops; doubles per failed attempt up to 30 s. Default 2 s. */
  retryMs?: number;
  /** Laptop addresses to listen on; both loopback families by default. Tests bind one so the fake guest can hold the other. */
  listenHosts?: string[];
  /** A fraction in [0, 1) added to each redial wait (up to half again), so links through one edge do not redial in lockstep. */
  jitter?: () => number;
  /** Also holds a link to each computer this host holds as a place, over the socket that computer opened, and hands
   * the runtime's sign-ins the forward for theirs. The host's own relay; init's builder relay leaves it off. */
  places?: boolean;
}

/** callback: a sign-in flow's redirect port, one per workspace and one more per sign-in running there, keyed on the guest listener's life.
 * url: a port a printed local URL named, one per port per workspace, kept while traffic flows. */
export type ForwardKind = "callback" | "url";

export interface ForwardView {
  targetId: string;
  port: number;
  kind: ForwardKind;
  /** The guest has been seen listening on the port; a callback forward then lives until that listener closes or the cap. */
  listener: boolean;
  expiresAt: number;
}

export interface CallbackRelay {
  forwards(): ForwardView[];
  /** The open forwards as the app lists them. */
  list(): PortForward[];
  /** Closes one forward from the app; false when none is open there. */
  stop(targetId: string, port: number): boolean;
  /** Hears every forward opened or closed, for the app's socket. */
  on(fn: (e: ForwardEvent) => void): () => void;
  close(): Promise<void>;
}

/** Below this the laptop would need root; no measured tool uses one. */
export const RELAY_MIN_PORT = 1024;
/** Floor for a forward with no listener spotted; a spotted listener keys the window on its own lifetime. */
export const RELAY_WINDOW_MS = 3 * 60_000;
export const RELAY_CAP_MS = 15 * 60_000;
/** A url forward with no connection and no bytes for this long is one nobody is using. */
export const FORWARD_IDLE_MS = 10 * 60_000;
/** url forwards per workspace: the machine names the ports, so its say over this computer's loopback is bounded. */
export const FORWARD_MAX_PER_TARGET = 16;
/** The longest pause between redials of a dropped daemon link, before jitter. */
export const REDIAL_CEILING_MS = 30_000;
/** A callback that lands while the link is down waits this long for it: the longest jittered redial pause plus the dial's
 * budget, so the redial that starts inside every hold also lands inside it. */
export const CALLBACK_HOLD_MS = REDIAL_CEILING_MS * 1.5 + DAEMON_CONNECT_TIMEOUT_MS;
/** How long the harness has to answer a landed address carried to it. */
export const DELIVER_MS = 10_000;
/** A callback is a GET whose head is a few hundred bytes; a held socket that sends more is not one. */
export const CALLBACK_HOLD_MAX_BYTES = 64 * 1024;
/** The most of a harness's status line a refusal quotes back to the panel. */
const QUOTE_MAX = 120;
/** Held callback connections per forward; a browser opens a handful per host, a page probing loopback opens many. */
export const CALLBACK_HOLD_MAX_CONNS = 8;

interface Target {
  id: string;
  name: string;
  /** What the lines call the far end: a workspace, or a computer this host holds as a place. */
  noun: "workspace" | "computer";
  /** The forwards this link opens. A place's daemon watches the whole computer, and every workspace on it too, so a
   * printed local URL there is no one sign-in's and is never carried here. */
  kinds: readonly ForwardKind[];
  /** Whether the guest sessions on the far end are this link's. A place's are its workspaces', each on its own link. */
  guests: boolean;
  /** Whether a callback forward opens only while a sign-in on the far end runs, and closes when the last one ends. Anything
   * on a computer that can post to its daemon's socket could otherwise hold a port on this computer's loopback. */
  armedBySignIn: boolean;
  /** How this link reaches the daemon answering for the target: a dial of the machine's own daemon, or the
   * channel the runtime holds over the link of the computer that answers for a workspace. */
  open(o: { onEvent: (event: Record<string, unknown>) => void; onEventError: (error: unknown) => void }): Promise<DaemonSocket>;
  /** Whether the ports the daemon on the far end watches are this target's own. A workspace whose computer
   * answers for it has none: the ports that daemon sees are the whole computer's, and forwarding them here would
   * carry another workspace's listener to this computer's loopback. */
  ownPorts: boolean;
  /** The workspace as the computer answering for it names it on every frame it relays up, where the far end
   * answers for more than one; what tells this target's sessions from another workspace's on the one link. */
  machineId?: string;
}

interface Link {
  target: Target;
  sock?: DaemonSocket;
  /** What the guest listens on, from the ports.watch reply and the port events after it. */
  ports: Set<number>;
  stopped: boolean;
  wake?: () => void;
  done: Promise<void>;
  /** Frames waiting for the next socket, in the order they were asked for. The edge sweeps a quiet connection at
   * about thirty seconds and the link redials under it; a guest session streaming rows across that gap would
   * otherwise lose them, and its exit frame with them, and the process on the machine would wait for good. */
  waiting: ((sock: DaemonSocket | undefined) => void)[];
  /** The sign-ins on this target that hold a forward from the relay, each with the port its page returns to. */
  signIns: Set<SignIn>;
  /** Tunnels carrying one landed address each, by id, while their answer comes back. */
  replays: Map<string, Socket>;
}

interface SignIn {
  /** The callback port of the page this sign-in armed, which a landed address must name. */
  page?: number;
  ended: boolean;
}

interface Held {
  cancel: () => void;
  /** What the browser sent so far; put back on the socket when it is plumbed. */
  chunks: Buffer[];
  bytes: number;
  onData: (d: Buffer) => void;
}

interface Forward {
  target: Target;
  port: number;
  kind: ForwardKind;
  listener: boolean;
  /** A url forward across a nap: the idle time it had left, restored at the wake. */
  paused?: number;
  /** What brought the workspace back, for the line when its port no longer listens ("the wake", "it moved to a new machine"). */
  pausedBack?: string;
  /** One line per stretch: set when a refusal is logged, cleared when a connection gets through (or the link returns). */
  unreachableLogged?: boolean;
  unansweredLogged?: boolean;
  servers: Server[];
  conns: Map<string, Socket>;
  /** Callback connections that arrived while the link was down, kept until the redial lands or their wait ends. */
  held: Map<Socket, Held>;
  startedAt: number;
  expiresAt: number;
  cancel: () => void;
}

function badGateway(sentence: string): string {
  const body = `${sentence}\n`;
  return `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
}

/** What a guest session is answered with when the link it rode went between the ask and the answer. */
export const linkDownLine = (workspace: string): string => `${workspace}: the daemon link is down`;

/** What a laptop connection hears when the guest side refused the tunnel. */
function refusedResponse(f: Forward): string {
  return badGateway(
    f.kind === "url"
      ? `localhost:${f.port} on this computer is forwarded to workspace ${f.target.name}, but nothing there answered on port ${f.port}.`
      : `The sign-in callback reached this computer, but nothing on ${f.target.noun} ${f.target.name} answered on port ${f.port}.`,
  );
}

/** What a held callback hears when its wait ends without a link, its forward closes first, or the hold is full. */
function heldResponse(f: Forward, what: string): string {
  return badGateway(`The sign-in callback reached this computer while ${f.target.noun} ${f.target.name} was reconnecting, ${what}. Start the sign-in again.`);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1_000)} s`;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/** One channel the runtime holds, as the link road drives it: a refusal comes back as a throw, the way the dial's
 * own op does, and the beats are nobody's, since a channel over a computer's link has no edge to stay awake under. */
function daemonSocketOver(channel: DaemonChannel): DaemonSocket {
  let open = true;
  void channel.closed.then(() => (open = false));
  return {
    op: async (op, extra = {}) => {
      const reply = await channel.send({ op, ...extra });
      if (reply.ok !== true) throw new Error(String((reply as { error?: unknown }).error ?? `${op} was refused`));
      return reply;
    },
    close: () => channel.close(),
    closed: channel.closed.then(({ code }) => code),
    beats: 0,
    get open() {
      return open;
    },
  };
}

function portsOf(rows: unknown): number[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => (r as { port?: unknown }).port).filter((p): p is number => typeof p === "number");
}

export function startCallbackRelay(o: RelayOptions): CallbackRelay {
  const rt = o.runtime;
  const clock = o.clock ?? realClock;
  const windowMs = o.windowMs ?? RELAY_WINDOW_MS;
  const capMs = o.capMs ?? RELAY_CAP_MS;
  const idleMs = o.idleMs ?? FORWARD_IDLE_MS;
  const connect = o.connect ?? connectDaemonSocket;
  const retryMs = o.retryMs ?? 2_000;
  const listenHosts = o.listenHosts ?? [LOOPBACK, "::1"];
  const autoOpen = o.autoOpen ?? (() => false);
  const openLine = o.openLine ?? ((workspace: string, hostname: string) => `${workspace}: a sign-in page for ${hostname} is ready; open it from the app`);
  const jitter = o.jitter ?? Math.random;
  /** Forwards whose binds are in flight, by target, kind and port, so a second ask for the same port joins the first. */
  const binding = new Map<string, Promise<void>>();
  const links = new Map<string, Link>();
  /** callback forwards by target and port: one per target, and one more for each sign-in running there. */
  const forwards = new Map<string, Forward>();
  /** url forwards by target and port. */
  const urlForwards = new Map<string, Forward>();
  const listeners = new Set<(e: ForwardEvent) => void>();
  let seq = 0;
  let closed = false;
  const detaches: (() => void)[] = [];

  const on = (fn: (e: ForwardEvent) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  // Whether this host forwards ports at all, which is the wired backend's own answer. The links below are not that
  // question: they are the one socket this host holds into each running workspace, and the guest road rides them,
  // so a host whose backend forwards nothing still holds them where a guest door was given.
  const forwarding = rt.backend.capabilities.callbackRelay;
  const holdsWorkspaces = forwarding || o.guest !== undefined;
  if (!holdsWorkspaces && o.places !== true) return { forwards: () => [], list: () => [], stop: () => false, on, close: async () => {} };
  const workspaceKinds: readonly ForwardKind[] = forwarding ? ["callback", "url"] : [];

  const urlKey = (targetId: string, port: number): string => `${targetId}:${port}`;
  const allForwards = (targetId: string): Forward[] => {
    const out: Forward[] = [];
    for (const f of [...forwards.values(), ...urlForwards.values()]) if (f.target.id === targetId) out.push(f);
    return out;
  };
  const forwardOn = (targetId: string, port: number): Forward | undefined => allForwards(targetId).find(f => f.port === port);
  const viewOf = (f: Forward): PortForward => ({ workspaceId: f.target.id, port: f.port, startedAt: new Date(f.startedAt).toISOString(), name: f.target.name, kind: f.kind });
  const emit = (e: ForwardEvent): void => {
    for (const fn of listeners) fn(e);
  };

  const sleep = (ms: number, link: Link): Promise<void> =>
    new Promise(resolve => {
      const cancel = clock.schedule(resolve, ms, { unref: true });
      link.wake = () => {
        cancel();
        resolve();
      };
    });

  // --- forwards -------------------------------------------------------------

  const closeForward = (f: Forward, why: string): void => {
    const open = f.kind === "callback" ? forwards : urlForwards;
    const key = urlKey(f.target.id, f.port);
    if (open.get(key) !== f) return;
    open.delete(key);
    f.cancel();
    for (const c of f.conns.values()) c.destroy();
    f.conns.clear();
    for (const [c, h] of f.held) {
      h.cancel();
      c.end(heldResponse(f, `but its forward on port ${f.port} closed (${why})`));
    }
    f.held.clear();
    for (const s of f.servers) s.close();
    o.log(`${f.target.name}: stopped forwarding localhost:${f.port} (${why})`);
    emit({ type: "forward.close", workspaceId: f.target.id, port: f.port });
  };

  /** Traffic keeps a url forward alive; a callback forward's window is the guest listener's, not its traffic. */
  const touch = (f: Forward): void => {
    if (f.kind === "url") f.expiresAt = clock.now() + idleMs;
  };

  /** A spotted listener keys the window on its lifetime (the cap remains); without one, the floor. */
  const sawListener = (f: Forward): void => {
    if (f.listener) return;
    f.listener = true;
    f.expiresAt = f.startedAt + capMs;
  };

  const arm = (f: Forward): void => {
    const wait = Math.max(0, f.expiresAt - clock.now());
    f.cancel = clock.schedule(
      () => {
        if (clock.now() < f.expiresAt) arm(f);
        else if (f.kind === "url") closeForward(f, `no traffic for ${minutes(idleMs)}`);
        else closeForward(f, f.listener ? `open for ${minutes(capMs)}, the cap` : `no listener on the ${f.target.noun} within ${minutes(windowMs)}`);
      },
      wait,
      { unref: true },
    );
  };

  const listen = (host: string, port: number, onConn: (c: Socket) => void): Promise<Server | NodeJS.ErrnoException> =>
    new Promise(resolve => {
      const server = createServer(onConn);
      server.once("error", (e: NodeJS.ErrnoException) => resolve(e));
      try {
        server.listen(port, host, () => {
          server.unref();
          resolve(server);
        });
      } catch (e) {
        resolve(e as NodeJS.ErrnoException);
      }
    });

  const plumb = (f: Forward, sock: DaemonSocket, c: Socket): void => {
    plumbTunnel((op, params) => sock.op(op, params), c, {
      port: f.port,
      conns: f.conns,
      tunnelId: `t${++seq}`,
      touched: () => touch(f),
      opened: () => {
        f.unreachableLogged = false;
        f.unansweredLogged = false;
      },
      refused: socket => {
        // The browser was redirected here, so it gets an answer it can show, not a reset.
        socket.end(refusedResponse(f));
        // A tab left open retries every second: one line per stretch, not per connection.
        if (f.unansweredLogged) return;
        f.unansweredLogged = true;
        o.log(
          f.kind === "url"
            ? `${f.target.name}: a connection to localhost:${f.port} here reached the workspace but nothing there answered on port ${f.port}`
            : `${f.target.name}: the sign-in callback on port ${f.port} reached this computer but nothing on the ${f.target.noun} answered`,
        );
      },
    });
  };

  /** A redirect that lands inside the redial wait would otherwise die with a 502; it waits for the link or the hold's end.
   * The socket keeps reading meanwhile (a paused one never sees the browser leave), so its bytes are kept here. */
  const hold = (f: Forward, c: Socket): void => {
    if (f.held.size >= CALLBACK_HOLD_MAX_CONNS) {
      c.end(heldResponse(f, `and ${CALLBACK_HOLD_MAX_CONNS} connections were already waiting for it`));
      return;
    }
    const h: Held = {
      chunks: [],
      bytes: 0,
      onData: d => {
        h.bytes += d.length;
        if (h.bytes > CALLBACK_HOLD_MAX_BYTES) {
          f.held.delete(c);
          h.cancel();
          c.destroy();
          return;
        }
        h.chunks.push(d);
      },
      cancel: () => {},
    };
    h.cancel = clock.schedule(
      () => {
        f.held.delete(c);
        c.end(heldResponse(f, `and the daemon link did not come back within ${seconds(CALLBACK_HOLD_MS)}`));
        o.log(`${f.target.name}: a sign-in callback held on localhost:${f.port} for ${seconds(CALLBACK_HOLD_MS)} found no daemon link; start the sign-in again`);
      },
      CALLBACK_HOLD_MS,
      { unref: true },
    );
    f.held.set(c, h);
    c.on("data", h.onData);
    const gone = (): void => {
      if (f.held.delete(c)) h.cancel();
    };
    c.on("end", gone);
    c.on("close", gone);
    if (f.unreachableLogged) return;
    f.unreachableLogged = true;
    o.log(`${f.target.name}: a sign-in callback reached localhost:${f.port} here while the daemon link is down; holding it until the link is back`);
  };

  /** Never throws: an event from the machine must not end the host process. */
  const forward = async (link: Link, port: number, kind: ForwardKind): Promise<void> => {
    const { target } = link;
    const sock = link.sock;
    if (!sock) return;
    if (!Number.isInteger(port) || port < RELAY_MIN_PORT || port > 65535) {
      o.log(`${target.name}: not forwarding port ${port} (outside ${RELAY_MIN_PORT}..65535)`);
      return;
    }
    // A port already forwarded for this target, by either kind, reaches the guest already. A sign-in whose
    // callback port a printed URL already forwarded rides that url forward, which lives by its idle clock
    // rather than the guest listener's, and gets no sign-in line of its own.
    if (forwardOn(target.id, port)) return;
    // The in-flight map, not the forwards map: a second ask for the same port joins the bind,
    // and the forward that works stays in place until the newcomer's servers are listening.
    const key = `${target.id}:${kind}:${port}`;
    const joined = binding.get(key) ?? binding.get(`${target.id}:${kind === "url" ? "callback" : "url"}:${port}`);
    if (joined !== undefined) return joined;
    // url binds in flight count too: a burst of events in one tick must not all pass the cap before any lands.
    const inFlight = [...binding.keys()].filter(k => k.startsWith(`${target.id}:url:`)).length;
    if (kind === "url" && allForwards(target.id).filter(f => f.kind === "url").length + inFlight >= FORWARD_MAX_PER_TARGET) {
      o.log(`${target.name}: not forwarding localhost:${port}; ${FORWARD_MAX_PER_TARGET} ports are already forwarded for this workspace, stop one first`);
      return;
    }
    let bound: () => void = () => {};
    binding.set(key, new Promise<void>(r => (bound = r)));
    try {
      await bind(link, sock, port, kind);
    } finally {
      binding.delete(key);
      bound();
    }
  };

  /** The bind behind forward, once it is this port's one ask in flight. */
  const bind = async (link: Link, sock: DaemonSocket, port: number, kind: ForwardKind): Promise<void> => {
    const { target } = link;
    const startedAt = clock.now();
    const f: Forward = { target, port, kind, listener: false, servers: [], conns: new Map(), held: new Map(), startedAt, expiresAt: startedAt + (kind === "url" ? idleMs : windowMs), cancel: () => {} };
    // The link at connection time, not at bind time: a forward outlives a redial, and a url forward a nap too.
    const onConn = (c: Socket): void => {
      // A browser that resets the socket with the reply unread must not become an uncaught error here.
      c.on("error", () => {});
      const live = links.get(target.id)?.sock;
      if (live === undefined) {
        if (kind === "callback") {
          hold(f, c);
          return;
        }
        c.end(refusedResponse(f));
        if (!f.unreachableLogged) {
          f.unreachableLogged = true;
          o.log(`${target.name}: a connection to localhost:${port} here found the workspace unreachable`);
        }
        return;
      }
      plumb(f, live, c);
    };
    // Both families: a browser resolves localhost to either, and the guest listener may be on one only.
    // A refusal on either is a port this computer already uses; a missing family (no IPv6) is not.
    const results = await Promise.all(listenHosts.map(h => listen(h, port, onConn)));
    for (const r of results) if (!(r instanceof Error)) f.servers.push(r);
    const inUse = results.some(r => r instanceof Error && r.code === "EADDRINUSE");
    if (inUse || f.servers.length === 0) {
      for (const s of f.servers) s.close();
      const first = results.find(r => r instanceof Error) as NodeJS.ErrnoException | undefined;
      const why = inUse ? "already in use on this computer" : `could not listen: ${first?.message ?? "unknown"}`;
      o.log(`${target.name}: port ${port} is ${why}; ${kind === "url" ? "localhost:" + port + " here will not reach the workspace" : "the sign-in callback is not forwarded"}`);
      return;
    }
    if (closed || link.sock !== sock || forwardOn(target.id, port)) {
      for (const s of f.servers) s.close();
      return;
    }
    if (kind === "url") {
      urlForwards.set(urlKey(target.id, port), f);
      arm(f);
      o.log(`${target.name}: forwarding localhost:${port} on this computer to the workspace (closes after ${minutes(idleMs)} without traffic)`);
    } else {
      const held = heldPorts(link);
      for (const previous of callbacksOf(target.id)) if (!held.has(previous.port)) closeForward(previous, `port ${port} replaces it`);
      forwards.set(urlKey(target.id, port), f);
      if (link.ports.has(port)) sawListener(f);
      arm(f);
      o.log(`${target.name}: forwarding localhost:${port} on this computer to the ${target.noun} for the sign-in callback (while the ${target.noun} listens, ${minutes(capMs)} at most)`);
    }
    emit({ type: "forward.open", forward: viewOf(f) });
  };

  /** Hands every frame waiting on this link the socket that just landed, or nothing when the link has stopped for
   * good; they were asked for in this order and they go out in it. */
  const woke = (link: Link, sock: DaemonSocket | undefined): void => {
    for (const waiter of link.waiting.splice(0)) waiter(sock);
  };

  /** One frame down to a machine's daemon. A link between sockets holds it until the next one lands rather than
   * failing, since a guest session's rows and its exit frame ride this road and the machine sees no redial; a link
   * that has stopped answers in one sentence. The sessions on a stopped link stand where the machine is coming
   * back, so what that sentence costs is the one frame, not the session. */
  const downward = async (link: Link, op: string, params: Record<string, unknown>): Promise<unknown> => {
    const sock = link.sock ?? (link.stopped ? undefined : await new Promise<DaemonSocket | undefined>(hand => link.waiting.push(hand)));
    if (sock === undefined) throw new Error(linkDownLine(link.target.name));
    return sock.op(op, params);
  };

  const heldPorts = (link: Link): Set<number> => new Set([...link.signIns].flatMap(s => (s.page !== undefined ? [s.page] : [])));
  const callbacksOf = (targetId: string): Forward[] => allForwards(targetId).filter(f => f.kind === "callback");

  /** A sign-in's end closes the forward on its page's port, unless another sign-in there holds that port; on a target
   * armed only by sign-ins, the last one's end closes them all. */
  const release = (link: Link, s: SignIn): void => {
    s.ended = true;
    link.signIns.delete(s);
    if (links.get(link.target.id) !== link) return;
    const held = heldPorts(link);
    const all = link.target.armedBySignIn && link.signIns.size === 0;
    for (const f of callbacksOf(link.target.id)) if (!held.has(f.port) && (all || f.port === s.page)) closeForward(f, "the sign-in ended");
  };

  const tryForward = (link: Link, port: number, kind: ForwardKind): void => {
    if (!link.target.kinds.includes(kind)) return;
    forward(link, port, kind).catch((e: unknown) => o.log(`${link.target.name}: not forwarding port ${port} (${e instanceof Error ? e.message : String(e)})`));
  };

  // --- links ----------------------------------------------------------------

  const onEvent = (link: Link, raw: Record<string, unknown>): void => {
    // The machine is the untrusted side: only http(s) ever reaches an opener, whatever the daemon sent.
    if (raw["type"] === "browser.open" && !isHttpUrl(raw["url"])) {
      o.log(`${link.target.name}: ignored a sign-in page that is not an http(s) link`);
      return;
    }
    const parsed = DaemonEvent.safeParse(raw);
    if (!parsed.success) {
      // A relay event that fails the wire shape (a port outside 1024..65535, say) is dropped with a line, never acted on.
      // A guest's open is here because the process inside the machine is waiting on it and hears nothing when it goes.
      if (raw["type"] === "browser.open" || raw["type"] === "callback.port" || raw["type"] === "localhost.url" || raw["type"] === "guest.opened") o.log(`${link.target.name}: ignored a malformed ${String(raw["type"])} event from the ${link.target.noun}`);
      return;
    }
    const e = parsed.data;
    if ((e.type === "browser.open" || e.type === "callback.port") && link.target.armedBySignIn && link.signIns.size === 0) {
      o.log(`${link.target.name}: ignored ${e.type === "browser.open" ? "a sign-in page" : "a callback port"} from the ${link.target.noun}; no sign-in runs there`);
      return;
    }
    switch (e.type) {
      case "port.open": {
        link.ports.add(e.port);
        const f = forwards.get(urlKey(link.target.id, e.port));
        if (f !== undefined) sawListener(f);
        return;
      }
      case "port.close": {
        link.ports.delete(e.port);
        const f = forwards.get(urlKey(link.target.id, e.port));
        if (f?.listener === true) closeForward(f, `the ${link.target.noun} stopped listening`);
        return;
      }
      case "browser.open":
        if (autoOpen(link.target.id, e.url, e.port)) {
          const returns = e.port !== undefined ? "; it returns to the machine on its own" : "";
          void o.openUrl(e.url).then(ok =>
            o.log(ok ? `${link.target.name}: opened a sign-in page in your browser${returns}` : `${link.target.name}: could not open your browser for a sign-in page`),
          );
        } else {
          // isHttpUrl parsed the URL already; the second wall for a guest that skipped the socket.
          const host = hostOf(e.url);
          if (host === undefined) {
            o.log(`${link.target.name}: ignored a sign-in page that is not an http(s) link`);
            return;
          }
          o.log(openLine(link.target.name, host, e.url));
        }
        // The forward arms now, so the port is ready by the time the person clicks.
        if (e.port !== undefined) tryForward(link, e.port, "callback");
        return;
      case "callback.port":
        tryForward(link, e.port, "callback");
        return;
      case "localhost.url":
        tryForward(link, e.port, "url");
        return;
      case "guest.opened":
      case "guest.message":
      case "guest.closed":
        // A computer that answers for many workspaces names the one each session was opened inside; a session of
        // another workspace is that workspace's link to hand over, and this one never opens or ends it.
        if (!link.target.guests || (link.target.machineId !== undefined && e.machineId !== link.target.machineId)) return;
        o.guest?.event({ workspaceId: link.target.id, request: (op, params) => downward(link, op, params) }, e);
        return;
      case "tunnel.data":
      case "tunnel.end":
        // One counter mints every tunnel id here, so a frame belongs to at most one forward and the first that
        // holds it is the one it is for.
        for (const fw of allForwards(link.target.id)) if (tunnelFrame(fw.conns, e, () => touch(fw))) return;
        tunnelFrame(link.replays, e);
        return;
      default:
        return;
    }
  };

  const run = async (link: Link): Promise<void> => {
    let attempt = 0;
    while (!link.stopped) {
      let sock: DaemonSocket | undefined;
      try {
        // The daemon pushes to a socket the moment it has authed it, which is before this dial resolves and before
        // the link is holding it. An event acted on in that gap reaches a link with no socket: a sign-in page
        // opened and its callback port was never forwarded, with no line saying so. Events wait here instead, for
        // this dial alone, and are acted on in arrival order once the link is up.
        const early: Record<string, unknown>[] = [];
        let recorded = false;
        const cannotHandle = (e: unknown): void =>
          o.log(`${link.target.name}: an event from the ${link.target.noun} could not be handled (${e instanceof Error ? e.message : String(e)})`);
        /** The one road every event from this machine takes, live or out of the queue, so a throw from a hook this
         * relay's caller owns says so and the link lives rather than tearing down the socket the event arrived on.
         * The catch is here and not in the connect the dial happened to use, since that road is the caller's too. */
        const deliver = (raw: Record<string, unknown>): void => {
          try {
            onEvent(link, raw);
          } catch (e) {
            cannotHandle(e);
          }
        };
        sock = await link.target.open({
          onEvent: raw => {
            if (recorded) deliver(raw);
            else early.push(raw);
          },
          onEventError: cannotHandle,
        });
        if (link.stopped) {
          sock.close();
          return;
        }
        // Starts the daemon's port watcher (its listener heuristic reads it) and seeds what the guest listens on now.
        if (link.target.ownPorts) {
          const watched = await sock.op("ports.watch");
          link.ports = new Set(portsOf(watched["ports"]));
        }
        // And takes the guest sessions on this machine, which go to the last socket that asked for them. A daemon
        // deployed before the road existed answers that it has no such op, and the guests there keep the command
        // that rides in its bundle.
        if (o.guest !== undefined && link.target.guests) await sock.op("guest.watch").catch(() => undefined);
        if (link.stopped) {
          sock.close();
          return;
        }
        // The link holds the socket only once it has watched, and the frames held across the redial go out on it
        // then: a frame that took it during the two round trips above would reach a socket the daemon does not yet
        // hand this machine's sessions to, and come back refused as not the watcher.
        link.sock = sock;
        woke(link, sock);
        attempt = 0;
        resume(link, sock);
        // After resume, not before: a forward a queued event opens ahead of it reads to resume as a forward that
        // outlived a dial, and the person is told the link is back on a link that was never away. Nothing queued on
        // a fresh dial is lost by the wait, since the daemon pushes the port events only to a socket that has asked
        // for them and the watch reply is what seeds those.
        recorded = true;
        for (const raw of early) deliver(raw);
        await sock.closed;
        // Every forward stays bound here across the redial; only its tunnels died with the socket.
        for (const f of allForwards(link.target.id)) {
          for (const c of f.conns.values()) c.destroy();
          f.conns.clear();
        }
      } catch {
        sock?.close();
      }
      link.sock = undefined;
      attempt++;
      if (!link.stopped) {
        const base = Math.min(REDIAL_CEILING_MS, retryMs * 2 ** (attempt - 1));
        await sleep(Math.round(base * (1 + jitter() / 2)), link);
      }
    }
  };

  /** After ports.watch on a fresh socket. A redial keeps every forward with its clocks as they ran; a callback forward
   * closes only when the listener it was keyed on is gone, and the callbacks it held ride the new link. url forwards
   * paused by a nap pick their idle clock back up, or close when the workspace no longer listens on the port. One line per link. */
  const resume = (link: Link, sock: DaemonSocket): void => {
    const all = allForwards(link.target.id);
    if (all.length === 0) return;
    const kept: number[] = [];
    let back: string | undefined;
    for (const f of all) {
      f.unreachableLogged = false;
      if (f.kind === "callback") {
        if (f.listener && !link.ports.has(f.port)) {
          closeForward(f, `the ${link.target.noun} stopped listening while the daemon link was down`);
          continue;
        }
        if (link.ports.has(f.port)) sawListener(f);
        for (const [c, h] of f.held) {
          h.cancel();
          c.off("data", h.onData);
          c.pause();
          for (const d of h.chunks.reverse()) c.unshift(d);
          plumb(f, sock, c);
        }
        f.held.clear();
      } else if (f.paused !== undefined) {
        back = f.pausedBack;
        if (!link.ports.has(f.port)) {
          closeForward(f, `not listening on the workspace after ${f.pausedBack}`);
          continue;
        }
        f.expiresAt = clock.now() + f.paused;
        delete f.paused;
        delete f.pausedBack;
        arm(f);
      }
      kept.push(f.port);
    }
    const how = back === undefined ? "the daemon link is back" : back === "the wake" ? "awake again" : "back on a new machine";
    if (kept.length > 0) o.log(`${link.target.name}: ${how}; ${kept.map(p => `localhost:${p}`).join(", ")} still forwarded`);
  };

  const add = (target: Target): void => {
    if (closed || links.has(target.id)) return;
    const link: Link = { target, ports: new Set(), stopped: false, done: Promise.resolve(), waiting: [], replays: new Map(), signIns: new Set() };
    link.done = run(link);
    links.set(target.id, link);
  };

  /** why closes the callback forward; url forwards pause across a nap or a new machine (their servers stay
   * bound here, the idle clock stops) and close for good only when the workspace or the host goes. */
  const drop = (id: string, why: string, urls: "pause" | "close", back = "the wake"): Promise<void> => {
    // The sessions on this machine outlive the link where a machine is coming back: the next socket to watch is
    // named every session the machine still holds, and the door answers those down the link that named them
    // rather than running what they opened a second time. A workspace that is gone and a host that is closing are
    // the two ends nothing comes back from, and the rows go with them. Before the link is looked for, since a
    // workspace deleted while it napped holds none and its sessions are the workspace's rather than the link's.
    if (urls === "close") o.guest?.closeAll(id);
    const link = links.get(id);
    if (!link) return Promise.resolve();
    links.delete(id);
    link.stopped = true;
    woke(link, undefined);
    for (const f of allForwards(id)) {
      if (f.kind === "callback" || urls === "close") {
        closeForward(f, why);
        continue;
      }
      for (const c of f.conns.values()) c.destroy();
      f.conns.clear();
      if (f.paused === undefined) {
        f.cancel();
        f.paused = Math.max(0, f.expiresAt - clock.now());
        f.pausedBack = back;
      }
    }
    link.sock?.close();
    link.wake?.();
    return link.done;
  };

  /** A machine with a daemon of its own: the link is one dial of it, beaten to stay alive under the edge's sweep
   * of quiet sockets, and every port it watches is that machine's own. */
  const dialled = (id: string, name: string, reach: () => Promise<DaemonReachView>): Target => ({
    id,
    name,
    noun: "workspace",
    kinds: workspaceKinds,
    guests: true,
    armedBySignIn: false,
    ownPorts: true,
    open: async at => {
      const road = await reach();
      if (road.daemonToken === undefined) throw new Error("no daemon token");
      return connect({ url: road.url, token: road.daemonToken, ...at });
    },
  });

  /** A workspace whose computer answers its daemon frames: the link is the channel the runtime holds over that
   * computer's own link, so nothing is dialled and nothing is beaten, and the sessions on it are told apart by
   * the workspace the computer stamps on every frame it relays. */
  const servedTarget = (id: string, name: string, machineId: string): Target => ({
    id,
    name,
    noun: "workspace",
    kinds: workspaceKinds,
    guests: true,
    armedBySignIn: false,
    machineId,
    ownPorts: false,
    open: async at => daemonSocketOver(await rt.workspaces.guestChannel(id, at.onEvent)),
  });

  /** The target for one running workspace, on whichever of the two roads its own runtime says it is on. */
  const addWorkspace = (w: { id: string; name: string; machineId: string }): void => {
    if (closed || !holdsWorkspaces || links.has(w.id)) return;
    void rt.workspaces.servedByItsComputer(w.id).then(
      served => add(served ? servedTarget(w.id, w.name, w.machineId) : dialled(w.id, w.name, () => rt.workspaces.daemonReach(w.id))),
      () => {},
    );
  };

  /** A computer this host holds as a place: the link is a channel over the socket that computer opened, so nothing is
   * dialled, and what it carries here is a sign-in's callback and nothing else. */
  const placeTarget = (id: string, name: string): Target => ({
    id,
    name,
    noun: "computer",
    kinds: ["callback"],
    guests: false,
    armedBySignIn: true,
    ownPorts: true,
    open: async at => {
      const channel = rt.places?.channel(id, at.onEvent);
      if (channel === undefined) throw new Error(`${name} is not connected`);
      return daemonSocketOver(channel);
    },
  });

  const addPlace = (id: string, name: string): void => {
    if (o.places === true) add(placeTarget(id, name));
  };

  /** One landed address carried to the port the target's sign-in page returns to, as the one request a browser there
   * would have made, for a sign-in whose port this computer could not listen on. Only the outcome is logged. */
  const deliver = async (link: Link, signIn: SignIn, landed: string): Promise<void> => {
    const { target } = link;
    if (signIn.ended) throw new Error(`the sign-in on ${target.name} has ended; start it again`);
    let url: URL | undefined;
    try {
      url = new URL(landed.trim());
    } catch {
      url = undefined;
    }
    if (url === undefined || url.protocol !== "http:" || !isLoopback(url.hostname)) throw new Error("that is not an address on localhost: paste the address your browser landed on");
    const port = Number(url.port);
    if (signIn.page === undefined || port !== signIn.page) throw new Error(`that address is on port ${url.port || "80"}, not the port the sign-in's page returns to`);
    const sock = link.sock;
    if (sock === undefined) throw new Error(linkDownLine(target.name));
    const tunnelId = `t${++seq}`;
    const answer = new PassThrough();
    link.replays.set(tunnelId, answer as unknown as Socket);
    const status = new Promise<string>((resolve, reject) => {
      let head = "";
      let settled = false;
      const cancel = clock.schedule(() => reject(new Error(`the sign-in on ${target.name} did not answer within ${seconds(DELIVER_MS)}`)), DELIVER_MS, { unref: true });
      const done = (line: string): void => {
        settled = true;
        cancel();
        resolve(line);
      };
      answer.on("data", (d: Buffer) => {
        if (settled) return;
        head += d.toString("latin1");
        const at = head.indexOf("\r\n");
        if (at >= 0 && at <= CALLBACK_HOLD_MAX_BYTES) return done(head.slice(0, at));
        if (head.length <= CALLBACK_HOLD_MAX_BYTES) return;
        settled = true;
        head = "";
        cancel();
        reject(new Error(`the sign-in on ${target.name} answered the address with more than ${CALLBACK_HOLD_MAX_BYTES / 1024} KB before its status line`));
      });
      answer.on("end", () => {
        if (!settled) done(head.split("\r\n")[0] ?? "");
      });
    });
    // A deadline that passes while the open is still in flight is read below, not left unhandled.
    status.catch(() => undefined);
    try {
      await sock.op("tunnel.open", { tunnelId, port });
      const request = `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
      await sock.op("tunnel.write", { tunnelId, data: Buffer.from(request).toString("base64") });
      const line = await status;
      const code = Number(line.split(" ")[1]);
      if (!(code >= 200 && code < 400)) throw new Error(`the sign-in on ${target.name} answered the address with ${line === "" ? "nothing" : line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX)}...` : line}`);
      o.log(`${target.name}: carried the address your browser landed on to port ${port} for the sign-in`);
    } catch (e) {
      o.log(`${target.name}: the address your browser landed on did not reach port ${port}`);
      throw e;
    } finally {
      link.replays.delete(tunnelId);
      void sock.op("tunnel.close", { tunnelId }).catch(() => undefined);
    }
  };

  const callbackLink = (target: AgentsTarget): Link | undefined => {
    const link = links.get("workspaceId" in target ? target.workspaceId : target.placeId);
    return link !== undefined && link.target.kinds.includes("callback") ? link : undefined;
  };

  /** What one sign-in on a target is handed: the forward for the page it saw, the road for a landed address, and its
   * end, which closes that forward. */
  const openSignIn = (target: AgentsTarget): SignInForward | undefined => {
    const link = callbackLink(target);
    if (link === undefined) return undefined;
    const id = link.target.id;
    const signIn: SignIn = { ended: false };
    link.signIns.add(signIn);
    return {
      arm: async url => {
        const port = callbackPortOf(url);
        if (port === undefined || signIn.ended || links.get(id) !== link) return false;
        signIn.page = port;
        await forward(link, port, "callback");
        if (signIn.ended) {
          release(link, signIn);
          return false;
        }
        return forwardOn(id, port) !== undefined;
      },
      deliver: landed => deliver(link, signIn, landed),
      close: () => {
        if (!signIn.ended) release(link, signIn);
      },
    };
  };

  /** The workspace was named: every row and every log line for it reads the name it carries now. The link's target
   * and a url forward's are two objects once that forward has outlived a nap, so both are named, and each open
   * forward is announced again so a client's row follows without waiting for the next open or close. */
  const rename = (id: string, name: string): void => {
    const link = links.get(id);
    if (link) link.target.name = name;
    for (const f of allForwards(id)) {
      f.target.name = name;
      emit({ type: "forward.open", forward: viewOf(f) });
    }
  };

  const onRuntimeEvent = (e: EventUnion): void => {
    switch (e.type) {
      case "workspace.created":
        if (e.workspace.phase === "running") addWorkspace(e.workspace);
        return;
      case "workspace.woken":
      case "workspace.upgraded":
        // A fresh machine or a fresh edge route: redial through a new reach.
        void drop(e.workspaceId, e.type === "workspace.woken" ? "the workspace woke" : "the workspace moved to a new machine", "pause", e.type === "workspace.woken" ? "the wake" : "it moved to a new machine").then(() =>
          rt.workspaces.get(e.workspaceId).then(addWorkspace, () => {}),
        );
        return;
      case "workspace.renamed":
        rename(e.workspaceId, e.name);
        return;
      case "workspace.napped":
        void drop(e.workspaceId, "the workspace napped", "pause");
        return;
      case "workspace.gone":
        // The forwards wait like a nap's: a rebuild lands as workspace.upgraded and redials them.
        void drop(e.workspaceId, "the machine is gone", "pause", "the rebuild");
        return;
      case "workspace.deleted":
        void drop(e.workspaceId, "the workspace was deleted", "close");
        return;
      case "place.joined":
        if (isJoinedComputer(e.place)) addPlace(e.place.id, e.place.name);
        return;
      case "place.present": {
        // The link redials on its own clock; a computer that is back is dialled now.
        const link = links.get(e.placeId);
        if (link !== undefined) link.wake?.();
        else if (rt.places !== undefined) addPlace(e.placeId, rt.places.nameOf(e.placeId));
        return;
      }
      case "place.removed":
        void drop(e.placeId, "the computer was removed", "close");
        return;
      default:
        return;
    }
  };

  detaches.push(rt.events.on("*", onRuntimeEvent));
  void rt.workspaces.list().then(
    list => {
      for (const w of list) if (w.phase === "running") addWorkspace(w);
    },
    () => {},
  );
  if (o.builder !== undefined && holdsWorkspaces) {
    const b = o.builder;
    add(dialled(b.id, `${b.name} (builder)`, () => rt.golden.builderReach(b.id)));
  }
  if (o.places === true) {
    void rt.places?.list(clock.now()).then(
      rows => {
        for (const p of rows) if (isJoinedComputer(p)) addPlace(p.id, p.name);
      },
      () => {},
    );
    detaches.push(rt.agents.forwards({ reaches: target => callbackLink(target) !== undefined, open: openSignIn }));
  }

  const every = (): Forward[] => [...forwards.values(), ...urlForwards.values()];

  return {
    forwards: () => every().map(f => ({ targetId: f.target.id, port: f.port, kind: f.kind, listener: f.listener, expiresAt: f.expiresAt })),
    list: () => every().map(viewOf),
    stop: (targetId, port) => {
      const f = forwardOn(targetId, port);
      if (!f) return false;
      closeForward(f, "stopped from the app");
      return true;
    },
    on,
    close: async () => {
      closed = true;
      for (const un of detaches) un();
      // Every session this door holds, not only those of a linked workspace: one that napped holds no link.
      o.guest?.closeAll();
      await Promise.all([...links.keys()].map(id => drop(id, "the host is closing", "close")));
    },
  };
}
