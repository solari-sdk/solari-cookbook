// SPDX-License-Identifier: AGPL-3.0-only
// Resilient client for the in-VM daemon over a Solari previewUrl. The edge
// idle-sweeps quiet connections (~30s) and browsers cannot protocol-ping, so
// liveness is an app-level ping op; every (re)connect re-subscribes and
// rescans the inbox because events pushed during a gap are gone for good.

import { DaemonEvent, linkBackoffMs, MachineErrorKind, type DaemonLinkStatus } from "@wsp/protocol";
import WebSocket from "ws";
import { openFrame, SEAL_REFUSAL, type Seal } from "@wsp/keys";

export interface ReachOptions {
  /** Solari previewUrl (https, pt_token already embedded) or a ws:// url in tests. One of this and socket. */
  previewUrl?: string;
  /** A socket that is already open and already authenticated by the road that opened it: the link a place dialled
   * out on. Nothing redials it, since only that computer can open one, and a close is the end of this reach. */
  socket?: WebSocket;
  /** The daemon's own token, sent as the first frame on every dial; never in the URL. Not read on a socket, whose
   * handshake was the auth. */
  token?: string;
  onEvent: (e: DaemonEvent) => void;
  /** Fires on every transition; reauth-needed and dead are terminal. */
  onStatus?: (s: DaemonLinkStatus) => void;
  heartbeatMs?: number;
  /** The seal a place link agreed in its handshake: every frame this reach sends goes out inside it and every
   * frame it reads is opened with it, so whoever carries the bytes reads nothing and writes nothing. Absent on
   * every road that is not a place link, which is dialled with a token over the provider's own route. */
  seal?: Seal;
  /** The wait before each re-dial; the link rule's unless a test pins one. A dial that keeps failing is made again
   * for as long as this link is held, since only the daemon's own word ends anything running behind it. */
  backoffMs?: (attempt: number) => number;
}

export interface ReachStats {
  pingsSent: number;
  pongsReceived: number;
  reconnects: number;
}

export interface DaemonReach {
  /** Resolves after the first successful connect + subscribe + rescan; rejects on 4401. */
  readonly ready: Promise<void>;
  request(op: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(): DaemonLinkStatus;
  stats(): ReachStats;
  close(): void;
}

/** previewUrl → dialable ws(s) url; the edge's pt_token rides along, ours never does. */
export function daemonWsUrl(previewUrl: string): string {
  const url = new URL(previewUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

const DEFAULT_HEARTBEAT_MS = 10_000;

interface Pending {
  resolve: (m: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

export function connectDaemon(opts: ReachOptions): DaemonReach {
  if (opts.previewUrl === undefined && opts.socket === undefined) throw new Error("connectDaemon needs a previewUrl to dial or an open socket to take over");
  if (opts.previewUrl !== undefined && opts.token === undefined) throw new Error("connectDaemon needs the daemon's token to dial a previewUrl");
  const url = opts.previewUrl === undefined ? "" : daemonWsUrl(opts.previewUrl);
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const backoff = opts.backoffMs ?? linkBackoffMs;

  let ws: WebSocket | null = null;
  let closed = false;
  let nextId = 1;
  let attempt = 0;
  let connections = 0;
  let awaitingPong = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  const pending = new Map<number, Pending>();
  const stats: ReachStats = { pingsSent: 0, pongsReceived: 0, reconnects: 0 };

  let status!: DaemonLinkStatus;
  function setStatus(s: DaemonLinkStatus): void {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  }

  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {}); // a caller that never awaits ready must not crash the process

  function send(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return Promise.reject(new Error("daemon unreachable"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const text = JSON.stringify({ id, op, ...params });
      sock.send(opts.seal === undefined ? text : opts.seal.seal(text));
    });
  }

  function flushPending(reason: string): void {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    awaitingPong = false;
  }

  function startHeartbeat(sock: WebSocket): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (awaitingPong) {
        sock.terminate(); // no ack within a full beat: the socket is half-dead
        return;
      }
      awaitingPong = true;
      stats.pingsSent++;
      send("ping").then(
        () => {
          stats.pongsReceived++;
          awaitingPong = false;
        },
        () => {}, // the close handler owns recovery
      );
    }, heartbeatMs);
  }

  function handleMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      // A frame that does not open under the key both ends agreed is a carrier writing into the link: the socket
      // is cut and the link redials, rather than a frame nobody proved being read as the computer's own.
      msg = JSON.parse(openFrame(opts.seal, raw)) as Record<string, unknown>;
    } catch {
      if (opts.seal !== undefined) ws?.close(1002, SEAL_REFUSAL);
      return;
    }
    const id = msg["id"];
    if (typeof id === "number" && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      if (msg["ok"] === true) p.resolve(msg);
      else p.reject(refused(msg));
      return;
    }
    const parsed = DaemonEvent.safeParse(msg);
    if (parsed.success) opts.onEvent(parsed.data);
  }

  /** A refused frame as the caller's error. The fields the daemon answers with ride along, so a refusal keeps its
   * meaning on the computer that asked: a machine the far side lost reads missing here, and the code a files or git
   * frame was refused with is what tells a checkout with no remote from a computer with no signed-in gh. */
  function refused(msg: Record<string, unknown>): Error {
    const kind = MachineErrorKind.safeParse(msg["kind"]);
    const status = msg["status"];
    const code = msg["code"];
    return Object.assign(new Error(String(msg["error"] ?? "daemon error")), {
      ...(kind.success ? { kind: kind.data } : {}),
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof code === "string" ? { code } : {}),
    });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    // A socket somebody else opened cannot be opened again from here: the place dials this host, so the link ending
    // is this reach ending, and the place's own redial is what brings the next one.
    if (opts.socket !== undefined) {
      setStatus("dead");
      readyReject(new Error("the place's link closed")); // no-op once ready resolved
      return;
    }
    setStatus("connecting");
    attempt++;
    retryTimer = setTimeout(dial, backoff(attempt));
  }

  async function ritual(sock: WebSocket): Promise<void> {
    try {
      // The auth frame is the dial's; a socket the far side opened proved itself by the handshake that opened it.
      if (opts.previewUrl !== undefined) await send("auth", { token: opts.token });
      await send("ports.watch");
      await send("inbox.watch");
      await send("inbox.rescan");
    } catch {
      return; // connection died mid-ritual; the close handler redials
    }
    if (ws !== sock || closed) return;
    attempt = 0;
    connections++;
    stats.reconnects = connections - 1;
    startHeartbeat(sock);
    setStatus("live");
    readyResolve();
  }

  function dial(): void {
    if (closed) return;
    setStatus("connecting");
    const sock = new WebSocket(url);
    ws = sock;
    sock.addEventListener("open", () => void ritual(sock));
    sock.addEventListener("message", ev => handleMessage(ev.data));
    sock.addEventListener("error", () => {}); // a close event always follows
    sock.addEventListener("close", ev => {
      if (ws !== sock) return; // an already-replaced socket
      stopHeartbeat();
      flushPending("connection lost");
      if (closed) return;
      if (ev.code === 4401) {
        // The host owns the token it sent; a guest refusing it will refuse the same one again.
        setStatus("reauth-needed");
        readyReject(new Error(`daemon rejected token (4401 ${String(ev.reason)})`)); // no-op once ready resolved
        return;
      }
      scheduleReconnect();
    });
  }

  /** A socket already open: the same listeners a dial installs, and the ritual as soon as the loop turns. A
   * socket handed over paused is read again here, once this listener stands, so no frame the other end sent in
   * the gap is lost. */
  function take(sock: WebSocket): void {
    ws = sock;
    sock.addEventListener("message", ev => handleMessage(ev.data));
    sock.resume();
    sock.addEventListener("error", () => {});
    sock.addEventListener("close", () => {
      if (ws !== sock) return;
      stopHeartbeat();
      flushPending("connection lost");
      if (closed) return;
      scheduleReconnect();
    });
    void ritual(sock);
  }

  if (opts.socket !== undefined) take(opts.socket);
  else dial();

  return {
    ready,
    request: send,
    status: () => status,
    stats: () => ({ ...stats }),
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopHeartbeat();
      flushPending("client closed");
      ws?.close(1000);
      setStatus("dead");
      readyReject(new Error("client closed")); // no-op once ready resolved
    },
  };
}
