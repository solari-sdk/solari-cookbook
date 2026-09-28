// SPDX-License-Identifier: AGPL-3.0-only
// The daemon's listening ports into the browser pane's server list. Shape
// from t3code useDiscoveredLocalServers.ts PreviewableServer (commit
// 57a66608). The ports.watch reply seeds the set and port.open/port.close keep
// it current; the runtime's PortOpenEvent/PortCloseEvent (workspace-scoped)
// fold the same way. processName is the daemon's /proc/<pid>/comm read, null
// when it could not read one.
import type { DaemonEvent, EventUnion } from "@wsp/protocol";
import { loopbackUrl } from "../browser/url.js";
import type { PreviewableServer } from "./view-model.js";

export interface KnownPort {
  readonly port: number;
  readonly pid: number | null;
  readonly process: string | null;
}

/** ports.watch's reply payload. */
export interface PortsSnapshot {
  readonly ports: ReadonlyArray<{ readonly port: number; readonly pid?: number | null; readonly process?: string | null }>;
}

type PortEvent =
  | Extract<DaemonEvent, { type: "port.open" | "port.close" }>
  | Extract<EventUnion, { type: "port.open" | "port.close" }>;

export function applyPortsSnapshot(snapshot: PortsSnapshot): KnownPort[] {
  const byPort = new Map<number, KnownPort>();
  for (const p of snapshot.ports) if (!byPort.has(p.port)) byPort.set(p.port, { port: p.port, pid: p.pid ?? null, process: p.process ?? null });
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Folds one port event; a re-open of a known port keeps the first pid, a close of an unknown port is a no-op. */
export function applyPortEvent(ports: ReadonlyArray<KnownPort>, event: PortEvent): KnownPort[] {
  switch (event.type) {
    case "port.open":
      if (ports.some(p => p.port === event.port)) return [...ports];
      return [...ports, { port: event.port, pid: event.pid ?? null, process: event.process ?? null }].sort((a, b) => a.port - b.port);
    case "port.close":
      return ports.filter(p => p.port !== event.port);
    default: {
      const _exhaustive: never = event;
      return [...ports];
    }
  }
}

/** What is known about a port that stopped listening, from the close event that said so. */
export interface StoppedPort {
  readonly port: number;
  readonly pid: number | null;
  readonly process: string | null;
  readonly command: string | null;
  readonly exited: boolean | null;
  /** The daemon's clock at the close, for the sentence. */
  readonly at: string | null;
  /** This computer's clock when the close arrived; the moved window is measured on it, not the guest's. */
  readonly seenAt: number;
  /** Another port the same process opened within the window after this one stopped. */
  readonly movedTo: number | null;
}

export const MOVED_WINDOW_MS = 60_000;

/** Folds one port event into the stopped ports; hands the same map back when nothing changed. */
export function applyStoppedEvent(stopped: ReadonlyMap<number, StoppedPort>, event: PortEvent, nowMs: number): ReadonlyMap<number, StoppedPort> {
  switch (event.type) {
    case "port.close": {
      const next = new Map(stopped);
      next.set(event.port, {
        port: event.port,
        pid: event.pid ?? null,
        process: event.process ?? null,
        command: event.command ?? null,
        exited: event.exited ?? null,
        at: event.at ?? null,
        seenAt: nowMs,
        movedTo: null,
      });
      return next;
    }
    case "port.open": {
      let next: Map<number, StoppedPort> | null = null;
      for (const s of stopped.values()) {
        if (s.port === event.port) (next ??= new Map(stopped)).delete(s.port);
        else if (event.process !== undefined && s.process === event.process && nowMs - s.seenAt <= MOVED_WINDOW_MS) {
          (next ??= new Map(stopped)).set(s.port, { ...s, movedTo: event.port });
        }
      }
      return next ?? stopped;
    }
    default: {
      const _exhaustive: never = event;
      return stopped;
    }
  }
}

/** The line above a frame whose port stopped listening; clock renders the daemon's timestamp in the person's zone. */
export function stoppedSentence(port: number, stopped: StoppedPort | undefined, clock: (iso: string) => string): string {
  let out = `:${port} stopped listening`;
  if (stopped === undefined) return out;
  if (stopped.at !== null) out += ` at ${clock(stopped.at)}`;
  const holder = stopped.command ?? stopped.process;
  const pid = stopped.pid !== null ? `pid ${stopped.pid}` : null;
  const who = holder !== null ? (pid !== null ? `${holder} (${pid})` : holder) : pid;
  if (who !== null) {
    out += `, held by ${who}`;
    if (stopped.exited === true) out += ", which exited";
    else if (stopped.exited === false) out += ", which is still running";
  }
  if (stopped.movedTo !== null) out += `, now on :${stopped.movedTo}`;
  return out;
}

export interface PreviewableServersInput {
  readonly ports: ReadonlyArray<KnownPort>;
  /** The minted preview route for a port, when the browser has one; else the loopback url is the target. */
  readonly reachUrl?: (port: number) => string | undefined;
}

export function toPreviewableServers(input: PreviewableServersInput): PreviewableServer[] {
  return input.ports.map(p => {
    const requestedUrl = loopbackUrl(p.port);
    return {
      host: "localhost",
      port: p.port,
      url: input.reachUrl?.(p.port) ?? requestedUrl,
      processName: p.process,
      pid: p.pid,
      terminal: null,
      source: "scanner",
      requestedUrl,
    };
  });
}
