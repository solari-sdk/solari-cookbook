// SPDX-License-Identifier: AGPL-3.0-only
// The registry: one reader per session store format the catalog names. An
// agent whose entry names no history has no reader and reads as none. One
// store is read file by file so a cache can skip the files that have not
// changed since the last run.
import { CATALOG_AGENTS, type AgentEntry, type HistoryFormat } from "@wsp/catalog";
import type { RecipeHistory } from "@wsp/protocol";
import { type Host, expand } from "../host.js";
import { claudeReader } from "./claude.js";
import { codexReader } from "./codex.js";
import type { HistoryCache } from "./cache.js";
import { hermesReader } from "./hermes.js";
import type { HistoryReader } from "./reader.js";
import { type HistoryBucket, type Usage, reduceCalls, usageOf } from "./tally.js";

export const HISTORY_READERS: Readonly<Record<HistoryFormat, HistoryReader>> = {
  "claude-jsonl": claudeReader,
  "codex-rollout": codexReader,
  "hermes-sqlite": hermesReader,
};

export interface AgentHistory extends RecipeHistory {
  usage: Usage;
}

const EMPTY: Usage = { sessions: 0, calls: 0, commands: new Map(), installs: new Map(), tools: new Map() };

export interface StoreOptions {
  /** Absolute folders the counts are weighed against: only sessions that ran at one of them or inside it count. */
  folders?: readonly string[];
  /** Keeps what each session file came to, so only the files that changed are read again. */
  cache?: HistoryCache;
  /** Told as each of the store's files lands, so a spinner can count them off. */
  onFile?: (read: number, files: number) => void;
}

/** What one agent's store came to. Every session file is either taken from the cache, when its stamp says it has
 * not changed, or read; the folders are weighed after the merge, so one cache serves a run for any project. */
export async function readStore(host: Host, reader: HistoryReader, root: string, opts: StoreOptions = {}): Promise<Usage> {
  const files = await reader.files(host, root);
  const buckets: HistoryBucket[] = [];
  for (const [i, f] of files.entries()) {
    const kept = opts.cache?.get(f.path, f.stamp);
    if (kept === undefined) {
      const read = await reduceCalls(reader.read(host, root, f.path));
      opts.cache?.set(f.path, f.stamp, read);
      buckets.push(...read);
    } else buckets.push(...kept);
    opts.onFile?.(i + 1, files.length);
  }
  return usageOf(buckets, opts.folders);
}

/** How far through one agent's session files a read is. */
export interface HistoryProgress {
  /** The catalog id of the agent whose store is being read. */
  agent: string;
  /** How many of its session files are read, and how many it has. */
  read: number;
  files: number;
}

export interface HistoryOptions {
  /** Told each agent's history as it is read, with the counts it kept. */
  onAgent?: (h: AgentHistory) => void;
  /** Absolute folders the counts are weighed against: only sessions that ran at one of them or inside it count. */
  folders?: readonly string[];
  /** Keeps what each session file came to between runs, so a second run reads only what changed. */
  cache?: HistoryCache;
  /** Told how far through each agent's session files the read is, as each file lands. */
  onProgress?: (p: HistoryProgress) => void;
}

/** What each agent's session store on this computer says it used, read-only. A store that is there but cannot be
 * read is said so and counts nothing; a format with no reader is said so too. */
export async function readHistories(host: Host, agents: readonly AgentEntry[] = CATALOG_AGENTS, opts: HistoryOptions = {}): Promise<AgentHistory[]> {
  const { onAgent, folders, cache, onProgress } = opts;
  const out: AgentHistory[] = [];
  for (const a of agents) {
    let h: AgentHistory;
    if (a.history === undefined) h = { agent: a.id, state: "no-reader", sessions: 0, calls: 0, usage: EMPTY };
    else {
      try {
        const usage = await readStore(host, HISTORY_READERS[a.history.format], expand(host, a.history.root), {
          ...(folders !== undefined ? { folders } : {}),
          ...(cache !== undefined ? { cache } : {}),
          ...(onProgress !== undefined ? { onFile: (read, files) => onProgress({ agent: a.id, read, files }) } : {}),
        });
        h = { agent: a.id, state: usage.sessions === 0 ? "empty" : "read", sessions: usage.sessions, calls: usage.calls, usage };
      } catch {
        h = { agent: a.id, state: "unreadable", sessions: 0, calls: 0, usage: EMPTY };
      }
    }
    onAgent?.(h);
    out.push(h);
  }
  cache?.save();
  return out;
}

export { type Call, type HistoryFile, type HistoryReader, PARSE_VERSION } from "./reader.js";
export { type HistoryCache, fileHistoryCache } from "./cache.js";
export { commandNames, commandWords, installNames, installsIn, splitCommands, withoutHeredocs, type Install } from "./commands.js";
export { type Count, type HistoryBucket, type Usage, HEAVY_BYTES, HEAVY_USED_FLOOR, USED_FLOOR, inFolders, installKey, installedName, isHeavy, meetsUsedFloor, reduceCalls, usageOf } from "./tally.js";
export { claudeCall, claudeReader, claudeSession } from "./claude.js";
export { codexCall, codexReader } from "./codex.js";
export { hermesCall, hermesCalls, hermesReader } from "./hermes.js";
