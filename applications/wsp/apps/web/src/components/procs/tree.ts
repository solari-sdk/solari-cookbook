// SPDX-License-Identifier: AGPL-3.0-only
// The process table's order: a tree by ppid, siblings sorted by the chosen
// column, and on the computer the host runs on the threads of this workspace
// first, each one the tree its own process leads. A filter keeps that shape
// rather than flattening it: a match is shown under its parents, so a row
// whose command is twenty characters of the same flags is still told apart by
// what started it.
import { CATALOG_AGENTS } from "@wsp/catalog";
import { byProcColumn, type ProcEntry, type ProcSort } from "@wsp/protocol";

export type { ProcSort };

/** One thread of this workspace and the process the host started for it, which that thread's tree is rooted at. */
export interface ProcThread {
  threadId: string;
  title: string;
  pid: number;
}

export interface ProcRow {
  proc: ProcEntry;
  depth: number;
}

/** One thread's own tree: the process the host started for it and everything under it. */
export interface ProcThreadTree {
  thread: ProcThread;
  rows: ProcRow[];
}

/** What the pane draws: this workspace's threads first, then everything else the machine is running. A process
 * under a thread's tree is in no other, so the rows can be counted by adding the two up. */
export interface ProcTable {
  threads: ProcThreadTree[];
  rest: ProcRow[];
}

const hit = (p: ProcEntry, needle: string): boolean => [String(p.pid), p.comm, p.cmdline, p.user].some(s => s.toLowerCase().includes(needle));

/**
 * The table for one snapshot: `threads` are the trees this workspace's own threads lead, in the order they were
 * given, and `rest` is every other process on the machine, nested by parent. A thread whose process is not in the
 * snapshot has no tree. Under a filter a process is shown when it matches or something under it does, which is what
 * keeps a match's parents above it.
 */
export function procTable(procs: readonly ProcEntry[], sort: ProcSort, filter: string, threads: readonly ProcThread[] = []): ProcTable {
  const needle = filter.trim().toLowerCase();
  const pids = new Set(procs.map(p => p.pid));
  const children = new Map<number, ProcEntry[]>();
  const roots: ProcEntry[] = [];
  for (const p of procs) {
    if (p.ppid === p.pid || !pids.has(p.ppid)) roots.push(p);
    else {
      const list = children.get(p.ppid);
      if (list) list.push(p);
      else children.set(p.ppid, [p]);
    }
  }
  const kidsOf = (pid: number): ProcEntry[] => children.get(pid) ?? [];

  /** The rows for one forest, with a set of pids that belong to somebody else's tree left out of it whole. Each
   * scope marks its own keepers: a process is drawn when it matches or something under it does, so a parent stands
   * above its match and a tree whose only match was claimed elsewhere is not drawn for an empty reason. */
  const rowsOf = (heads: readonly ProcEntry[], skip: ReadonlySet<number>): ProcRow[] => {
    const keep = new Set<number>();
    const mark = (p: ProcEntry): boolean => {
      if (skip.has(p.pid)) return false;
      // Every child is read, never short-circuited: each one that stays has to be marked for the walk below.
      const under = kidsOf(p.pid).map(mark).includes(true);
      const stays = under || needle === "" || hit(p, needle);
      if (stays) keep.add(p.pid);
      return stays;
    };
    for (const head of heads) mark(head);
    const out: ProcRow[] = [];
    const walk = (list: readonly ProcEntry[], depth: number): void => {
      for (const proc of [...list].sort(byProcColumn(sort))) {
        if (!keep.has(proc.pid)) continue;
        out.push({ proc, depth });
        walk(kidsOf(proc.pid), depth + 1);
      }
    };
    walk(heads, 0);
    return out;
  };

  const byPid = new Map(procs.map(p => [p.pid, p]));
  const claimed = new Set<number>();
  const claim = (p: ProcEntry): void => {
    claimed.add(p.pid);
    for (const kid of kidsOf(p.pid)) claim(kid);
  };
  const trees: ProcThreadTree[] = [];
  for (const thread of threads) {
    const head = byPid.get(thread.pid);
    // A thread whose process already sits inside an earlier thread's tree is drawn there and not a second time.
    if (head === undefined || claimed.has(head.pid)) continue;
    const rows = rowsOf([head], claimed);
    // Claimed whether or not the filter left anything of it: what a filter hid here is hidden, not moved into the
    // rest of the machine. A thread with nothing left under a filter drops its heading with its rows.
    claim(head);
    if (rows.length > 0) trees.push({ thread, rows });
  }
  const rest = rowsOf(roots, claimed);
  return { threads: trees, rest };
}

/** The harness pieces the daemon can name: itself, the shells behind its ptys (by the tab's title) and an agent by the command its catalog entry puts on PATH. */
export function procLabel(p: ProcEntry, daemonPid: number, terminalTitles: ReadonlyMap<string, string>): string | null {
  if (p.pid === daemonPid) return "daemon";
  if (p.pty !== undefined) {
    const title = terminalTitles.get(p.pty);
    return title !== undefined ? `terminal ${title}` : "terminal";
  }
  if (CATALOG_AGENTS.some(a => a.bin === p.comm)) return "agent";
  return null;
}
