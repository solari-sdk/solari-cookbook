// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace port directory that outlives any mounted pane. Ports arrive
// over the workspace's own daemon link (terminal/wiring.ts feeds it): the
// ports.watch reply seeds the set and the daemon's port.open/port.close pushes
// keep it current; the runtime stream's port events fold the same way. The
// fold itself is adapt/ports.ts; this holds the result and tells React.
import { useSyncExternalStore } from "react";
import { applyPortEvent, applyPortsSnapshot, applyStoppedEvent, type KnownPort, type PortsSnapshot, type StoppedPort } from "../adapt/ports.js";
import type { ProtocolEvent } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";

export class WorkspacePorts {
  #ports: KnownPort[] = [];
  #stopped: ReadonlyMap<number, StoppedPort> = new Map();
  #seeded = false;
  #fns = new Set<() => void>();
  #now: () => number;

  /** The clock is read on each event, not captured, so a test's fake timers reach the moved window. */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  feedEvent(e: ProtocolEvent): void {
    if (e.type !== "port.open" && e.type !== "port.close") return;
    this.#adopt(applyPortEvent(this.#ports, e), applyStoppedEvent(this.#stopped, e, this.#now()));
  }

  /** What the last close said about a port that is not listening; unset once it listens again. */
  stopped(port: number): StoppedPort | undefined {
    return this.#stopped.get(port);
  }

  /** False until the daemon has said anything about ports: an empty directory then means unknown, not silent. */
  seeded(): boolean {
    return this.#seeded;
  }

  /**
   * Adopts the daemon's full listening set from a ports.watch reply. Anything
   * that is not an array of {port} rows is ignored so a bad reply cannot empty
   * a directory the pushes built.
   */
  syncPorts(reply: unknown): void {
    const rows = snapshotRows(reply);
    if (rows === null) return;
    this.#adopt(applyPortsSnapshot({ ports: rows }));
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** Sorted by port; the same array until the set changes. */
  ports(): KnownPort[] {
    return this.#ports;
  }

  #adopt(next: KnownPort[], stopped: ReadonlyMap<number, StoppedPort> = this.#stopped): void {
    const first = !this.#seeded;
    this.#seeded = true;
    const same = sameDirectory(this.#ports, next);
    if (!first && same && stopped === this.#stopped) return;
    if (!same) this.#ports = next;
    this.#stopped = stopped;
    for (const fn of this.#fns) fn();
  }
}

function sameDirectory(a: ReadonlyArray<KnownPort>, b: ReadonlyArray<KnownPort>): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i]!;
    return p.port === q.port && p.pid === q.pid && p.process === q.process;
  });
}

function snapshotRows(reply: unknown): PortsSnapshot["ports"] | null {
  if (!Array.isArray(reply)) return null;
  const rows: { port: number; pid: number | null; process: string | null }[] = [];
  for (const row of reply) {
    if (typeof row !== "object" || row === null || !("port" in row)) return null;
    const { port, pid, process } = row as { port: unknown; pid?: unknown; process?: unknown };
    if (typeof port !== "number") return null;
    rows.push({ port, pid: typeof pid === "number" ? pid : null, process: typeof process === "string" ? process : null });
  }
  return rows;
}

// --- registry: workspaceId → WorkspacePorts -----------------------------------

const registry = new Map<string, WorkspacePorts>();

export function getBrowser(workspaceId: string): WorkspacePorts {
  let d = registry.get(workspaceId);
  if (!d) {
    d = new WorkspacePorts();
    registry.set(workspaceId, d);
  }
  return d;
}

/** Test isolation: forget every workspace's directory. */
export function resetBrowsers(): void {
  registry.clear();
}

export function useWorkspacePorts(workspaceId: string): KnownPort[] {
  return useSyncExternalStore(
    fn => getBrowser(workspaceId).onChange(fn),
    () => getBrowser(workspaceId).ports(),
  );
}

export function useStoppedPort(workspaceId: string, port: number | null): StoppedPort | undefined {
  return useSyncExternalStore(
    fn => getBrowser(workspaceId).onChange(fn),
    () => (port === null ? undefined : getBrowser(workspaceId).stopped(port)),
  );
}

export function useWorkspacePortsSeeded(workspaceId: string): boolean {
  return useSyncExternalStore(
    fn => getBrowser(workspaceId).onChange(fn),
    () => getBrowser(workspaceId).seeded(),
  );
}

function route(e: ProtocolEvent): void {
  if (e.type === "port.open" || e.type === "port.close") getBrowser(e.workspaceId).feedEvent(e);
  else if (e.type === "workspace.deleted") registry.delete(e.workspaceId);
}

// Fed from the store's api rather than a mounted pane: a port that closes
// while the user is on another surface must not still read as listening.
let unbind: (() => void) | null = null;
useStore.subscribe((s, prev) => {
  if (s.api === prev.api) return;
  unbind?.();
  unbind = s.api ? s.api.subscribe(route) : null;
});
