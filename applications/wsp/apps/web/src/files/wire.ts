// SPDX-License-Identifier: AGPL-3.0-only
// The per-workspace daemon wire the files, diff and process surfaces call
// fs.*, git.* and proc.* over, and the daemon's hello as it announced itself:
// the root every path must resolve inside, so pickers, pins and session
// starts are built absolute, and the version that says which ops it answers.
// terminal/wiring.ts provides both alongside the terminal model, so they ride
// the same socket; a test provides fakes. A daemon older than this app is the
// runtime's to replace, not this app's: nothing here starts or watches one.
import { useSyncExternalStore } from "react";
import type { TerminalWire } from "../terminal/link.js";

export interface DaemonHello {
  root: string;
  version: number;
}

const wires = new Map<string, TerminalWire>();
const hellos = new Map<string, DaemonHello>();
const fns = new Set<() => void>();

function notify(): void {
  for (const fn of fns) fn();
}

export function provideDaemonWire(workspaceId: string, wire: TerminalWire | null): void {
  if (wire) wires.set(workspaceId, wire);
  else wires.delete(workspaceId);
  notify();
}

export function provideDaemonHello(workspaceId: string, hello: DaemonHello | null): void {
  if (hello !== null) hellos.set(workspaceId, hello);
  else hellos.delete(workspaceId);
  notify();
}

export function getDaemonWire(workspaceId: string): TerminalWire | null {
  return wires.get(workspaceId) ?? null;
}

export function getDaemonRoot(workspaceId: string): string | null {
  return hellos.get(workspaceId)?.root ?? null;
}

export function getDaemonVersion(workspaceId: string): number | null {
  return hellos.get(workspaceId)?.version ?? null;
}

function subscribe(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

export function useDaemonWire(workspaceId: string): TerminalWire | null {
  return useSyncExternalStore(subscribe, () => getDaemonWire(workspaceId));
}

/** null until the daemon's hello arrived on this workspace's link. */
export function useDaemonRoot(workspaceId: string): string | null {
  return useSyncExternalStore(subscribe, () => getDaemonRoot(workspaceId));
}

/** null until the daemon's hello arrived on this workspace's link. */
export function useDaemonVersion(workspaceId: string): number | null {
  return useSyncExternalStore(subscribe, () => getDaemonVersion(workspaceId));
}

