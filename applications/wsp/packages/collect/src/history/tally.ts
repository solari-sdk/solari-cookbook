// SPDX-License-Identifier: AGPL-3.0-only
import { MIB, catalogToolFor } from "@wsp/catalog";
import { underProject } from "@wsp/protocol";
import { commandNames, installNames, type Install } from "./commands.js";
import type { Call } from "./reader.js";

export interface Count {
  sessions: number;
  calls: number;
}

/** Over this a row is heavy: it is weighed against the heavy floor and put to the person before a build. */
export const HEAVY_BYTES = 300 * MIB;
/** The least use that ticks a tool on its own: one session is a look, and a handful of commands is a try. */
export const USED_FLOOR: Count = { sessions: 2, calls: 5 };
/** A heavy row costs more to be wrong about, so it takes more use to earn its place. */
export const HEAVY_USED_FLOOR: Count = { sessions: 3, calls: 20 };

export const isHeavy = (size: number | undefined): boolean => size !== undefined && size > HEAVY_BYTES;

/** Whether this much use ticks a tool of this size: at or over the floor its weight sets. */
export function meetsUsedFloor(c: Count, size: number | undefined): boolean {
  const floor = isHeavy(size) ? HEAVY_USED_FLOOR : USED_FLOOR;
  return c.sessions >= floor.sessions && c.calls >= floor.calls;
}

/** What one agent's histories ran, as names with how many sessions and how many calls each; nothing else is kept. */
export interface Usage {
  sessions: number;
  calls: number;
  commands: Map<string, Count>;
  /** Keyed by installKey (`brew gh`, `npm agent-browser`). */
  installs: Map<string, Count>;
  /** The catalog tools the commands and installs stand for, by id; a session counts once per tool however often it ran it. */
  tools: Map<string, Count>;
}

interface Seen {
  sessions: Set<string>;
  calls: number;
}

class Tally {
  private readonly seen = new Map<string, Seen>();

  add(name: string, session: string, calls: number): void {
    let s = this.seen.get(name);
    if (s === undefined) {
      s = { sessions: new Set(), calls: 0 };
      this.seen.set(name, s);
    }
    s.sessions.add(session);
    s.calls += calls;
  }

  /** Most sessions first, then most calls, then by name. */
  counts(): Map<string, Count> {
    const rows = [...this.seen].map(([name, s]) => [name, { sessions: s.sessions.size, calls: s.calls }] as const);
    rows.sort((a, b) => b[1].sessions - a[1].sessions || b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return new Map(rows);
  }
}

/** How an install is keyed in a Usage and in a cached bucket, and the package name back out of that key: written
 * once here, since a bucket read from the cache is the same key and the tool it stands for is looked up from it. */
export const installKey = (i: Install): string => `${i.via} ${i.name}`;
export const installedName = (key: string): string => key.slice(key.indexOf(" ") + 1);

/** What one session came to in one file: the counts the recipe keeps of it, and all a cache stores. Names and
 * counts only, as everything downstream of a reader is. */
export interface HistoryBucket {
  session: string;
  /** The folder the session ran in, when its store records one; the recipe weighs the bucket by it. */
  folder?: string;
  /** Every tool call of that session in that file, the ones no name came out of included. */
  calls: number;
  /** Command name to how often it ran. */
  commands: Record<string, number>;
  /** installKey to how often an installer was asked for it. */
  installs: Record<string, number>;
}

/** Whether a bucket counts when the recipe is weighed against named folders: its session ran at one of them or
 * inside it. A bucket whose store records no folder counts for nothing, since nothing says it is this project's. */
export function inFolders(where: { folder?: string }, folders: readonly string[]): boolean {
  const folder = where.folder;
  return folder !== undefined && folders.some(f => underProject(folder, f));
}

/** Reduces one file's calls to names and counts, one bucket per session and folder in it; shell lines are read for
 * their command words here and dropped. The catalog tools the names stand for are not decided here: they are looked
 * up when the buckets are merged, so a catalog that grew since a bucket was cached still decides its tools. */
export async function reduceCalls(calls: AsyncIterable<Call>): Promise<HistoryBucket[]> {
  const buckets = new Map<string, HistoryBucket>();
  for await (const c of calls) {
    const key = `${c.session}\u0000${c.folder ?? ""}`;
    let b = buckets.get(key);
    if (b === undefined) {
      b = { session: c.session, ...(c.folder !== undefined ? { folder: c.folder } : {}), calls: 0, commands: {}, installs: {} };
      buckets.set(key, b);
    }
    b.calls += 1;
    switch (c.kind) {
      case "shell":
        for (const name of commandNames(c.line)) b.commands[name] = (b.commands[name] ?? 0) + 1;
        for (const i of installNames(c.line)) {
          const k = installKey(i);
          b.installs[k] = (b.installs[k] ?? 0) + 1;
        }
        break;
      case "other":
        break;
      default: {
        const _exhaustive: never = c;
        return _exhaustive;
      }
    }
  }
  return [...buckets.values()];
}

/** Every bucket of one agent's store added up. With `folders`, only the buckets whose session ran at one of them or
 * inside it are counted. */
export function usageOf(buckets: readonly HistoryBucket[], folders?: readonly string[]): Usage {
  const sessions = new Set<string>();
  let total = 0;
  const commands = new Tally();
  const installs = new Tally();
  const tools = new Tally();
  const tool = (name: string, session: string, calls: number): void => {
    const t = catalogToolFor(name);
    if (t !== undefined) tools.add(t.id, session, calls);
  };
  for (const b of buckets) {
    if (folders !== undefined && !inFolders(b, folders)) continue;
    sessions.add(b.session);
    total += b.calls;
    for (const [name, calls] of Object.entries(b.commands)) {
      commands.add(name, b.session, calls);
      tool(name, b.session, calls);
    }
    for (const [key, calls] of Object.entries(b.installs)) {
      installs.add(key, b.session, calls);
      tool(installedName(key), b.session, calls);
    }
  }
  return { sessions: sessions.size, calls: total, commands: commands.counts(), installs: installs.counts(), tools: tools.counts() };
}
