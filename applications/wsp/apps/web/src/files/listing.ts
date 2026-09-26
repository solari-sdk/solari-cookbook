// SPDX-License-Identifier: AGPL-3.0-only
// One directory listing per folder, shared by the tree, the breadcrumb menus
// and the composer's folder picker: each folder is fetched the first time
// something asks for it and again on demand, under the daemon's per-folder
// cap. The last good listing of a folder stays up through a refresh or a
// failed one.
import { useCallback, useSyncExternalStore } from "react";
import { fsList } from "../terminal/daemon-fs.js";
import type { TerminalWire } from "../terminal/link.js";
import { toProjectEntries, type ProjectEntry } from "./entries.js";
import { useDaemonWire } from "./wire.js";

export interface LevelState {
  readonly entries: ProjectEntry[] | null;
  /** The daemon cut this folder at its cap; total says how many it holds. */
  readonly truncated: boolean;
  readonly total: number;
  readonly isPending: boolean;
  readonly error: string | null;
}

export type Levels = ReadonlyMap<string, LevelState>;

const IDLE: LevelState = { entries: null, truncated: false, total: 0, isPending: false, error: null };

class WorkspaceListing {
  #levels = new Map<string, LevelState>();
  #snapshot: Levels = new Map();
  #fns = new Set<() => void>();
  #inFlight = new Map<string, Promise<void>>();

  levels(): Levels {
    return this.#snapshot;
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** Fetches a folder nobody asked for yet; a folder already known or in flight is left alone. */
  ensure(wire: TerminalWire, dir: string): void {
    if (this.#levels.has(dir)) return;
    void this.load(wire, dir);
  }

  load(wire: TerminalWire, dir: string): Promise<void> {
    const pending = this.#inFlight.get(dir);
    if (pending) return pending;
    const current = this.#levels.get(dir) ?? IDLE;
    this.#set(dir, { ...current, isPending: true });
    const run = fsList(wire, dir, { gitignore: true })
      .then(reply => {
        this.#set(dir, { entries: toProjectEntries(reply, dir), truncated: reply.truncated, total: reply.total, isPending: false, error: null });
      })
      .catch((e: unknown) => {
        this.#set(dir, { ...(this.#levels.get(dir) ?? IDLE), isPending: false, error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        this.#inFlight.delete(dir);
      });
    this.#inFlight.set(dir, run);
    return run;
  }

  #set(dir: string, next: LevelState): void {
    this.#levels.set(dir, next);
    this.#snapshot = new Map(this.#levels);
    for (const fn of this.#fns) fn();
  }
}

const registry = new Map<string, WorkspaceListing>();

function listingFor(workspaceId: string): WorkspaceListing {
  let l = registry.get(workspaceId);
  if (!l) {
    l = new WorkspaceListing();
    registry.set(workspaceId, l);
  }
  return l;
}

/** Test isolation: forget every workspace's listing. */
export function resetListings(): void {
  registry.clear();
}

export interface WorkspaceListingHandle {
  readonly levels: Levels;
  /** Asks for a folder the first time; safe to call from an effect on every render. */
  readonly ensure: (dir: string) => void;
  readonly refresh: (dir: string) => void;
}

export function useWorkspaceListing(workspaceId: string): WorkspaceListingHandle {
  const wire = useDaemonWire(workspaceId);
  const listing = listingFor(workspaceId);
  const levels = useSyncExternalStore(
    fn => listing.onChange(fn),
    () => listing.levels(),
  );
  const ensure = useCallback((dir: string) => { if (wire) listing.ensure(wire, dir); }, [wire, listing]);
  const refresh = useCallback((dir: string) => { if (wire) void listing.load(wire, dir); }, [wire, listing]);
  return { levels, ensure, refresh };
}
