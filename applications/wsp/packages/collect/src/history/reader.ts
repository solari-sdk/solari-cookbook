// SPDX-License-Identifier: AGPL-3.0-only
// One reader per session store format. A reader names its agent's own session
// files, each with the stamp that says whether it changed, and turns one of
// them into tool calls and nothing else: a shell line is handed to the
// command parser and dropped, any other tool is a name. No line, argument or
// result an agent saw is kept or returned.
import type { Host } from "../host.js";

interface CallBase {
  session: string;
  /** The folder the session ran in, as its own store records it; a format that records none leaves it off, and a
   * recipe weighed against named folders then counts nothing from it. */
  folder?: string;
}

export type Call = (CallBase & { kind: "shell"; line: string }) | (CallBase & { kind: "other"; name: string });

export interface HistoryFile {
  /** Absolute path of one file the reader can read calls from. */
  path: string;
  /** What says the file has not changed since it was last read. */
  stamp: string;
}

export interface HistoryReader {
  /** The files under root (absolute: a directory of transcripts or one database file) that hold sessions. Empty
   * when the root is not there. */
  files(host: Host, root: string): Promise<HistoryFile[]>;
  /** Every tool call in one of those files, keyed by the top-level session it belongs to. A throw when the file is
   * there and cannot be read. */
  read(host: Host, root: string, file: string): AsyncIterable<Call>;
}

/** What a file's stamp cannot see: the code that turns it into buckets. A finished session file's stamp never moves
 * again, so a cache keyed on the stamp alone would hand back an older parser's counts forever. Bump this when
 * commands.ts, tally.ts or a reader changes what a bucket comes to; history.test.ts goes red until you do. */
export const PARSE_VERSION = 1;

/** The file with the stamp a cache compares: its modification time and its size, so a rewrite that keeps either one
 * is still read again. Nothing when the path is not a file. */
export async function stampOf(host: Host, path: string): Promise<HistoryFile | undefined> {
  const st = await host.fs.stat(path);
  return st === undefined || st.kind !== "file" ? undefined : { path, stamp: `${st.mtimeMs}:${st.bytes}` };
}

/** Every jsonl file under root the reader keeps a session for, stamped, in the order the walk found them. The one
 * walk both jsonl formats take: a file the session rule has no answer for is not a transcript and is left out. */
export async function jsonlFiles(host: Host, root: string, session: (file: string) => string | undefined): Promise<HistoryFile[]> {
  const out: HistoryFile[] = [];
  for (const file of await host.fs.walk(root)) {
    if (!file.endsWith(".jsonl") || session(file) === undefined) continue;
    const stamped = await stampOf(host, file);
    if (stamped !== undefined) out.push(stamped);
  }
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The file's name without its directory or extension. */
export function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
