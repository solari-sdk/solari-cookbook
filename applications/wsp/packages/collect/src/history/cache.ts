// SPDX-License-Identifier: AGPL-3.0-only
// What each session file came to last time, kept in one JSON so a second run
// reads only the files that changed: a Mac with a hundred and fifty sessions
// spends more than a minute reading them all, and every wsp init and every
// wsp recipe pays it again. A file is trusted while its stamp and the parse
// version behind its counts both match, and nothing but names and counts is
// written, as everything downstream of a reader is.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PARSE_VERSION } from "./reader.js";
import type { HistoryBucket } from "./tally.js";

/** The counts kept for one file. A run that reads the file again replaces them whole; nothing merges. */
export interface HistoryCache {
  /** The buckets kept for this file when its stamp still matches, or nothing when it has to be read again. */
  get(path: string, stamp: string): readonly HistoryBucket[] | undefined;
  set(path: string, stamp: string, buckets: readonly HistoryBucket[]): void;
  /** Writes what this run asked about, when anything changed. A file nothing asked about is dropped, so a session
   * that is gone leaves with it and a run that reads a subset of the agents pays for the rest once. */
  save(): void;
}

const Bucket = z.object({
  session: z.string(),
  folder: z.string().optional(),
  calls: z.number().int().nonnegative(),
  commands: z.record(z.number().int().nonnegative()),
  installs: z.record(z.number().int().nonnegative()),
});

/** Version 1 and nothing else is read: a file this version does not know is one whole re-read, never half-trusted counts.
 * `parse` is that same rule for the code that filled the buckets, which a file's stamp cannot see. */
const CacheFile = z.object({ version: z.literal(1), parse: z.literal(PARSE_VERSION), files: z.record(z.object({ stamp: z.string(), buckets: z.array(Bucket) })) });
type CacheFile = z.infer<typeof CacheFile>;

type Entry = CacheFile["files"][string];

/** The file's entries, or none when there is no file, it cannot be read, or its shape is not this version's. */
function read(path: string): Map<string, Entry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
  const r = CacheFile.safeParse(parsed);
  return r.success ? new Map(Object.entries(r.data.files)) : new Map();
}

export function fileHistoryCache(path: string): HistoryCache {
  const stored = read(path);
  const kept = new Map<string, Entry>();
  let changed = false;
  return {
    get(file, stamp) {
      const e = stored.get(file);
      if (e === undefined || e.stamp !== stamp) return undefined;
      kept.set(file, e);
      return e.buckets;
    },
    set(file, stamp, buckets) {
      kept.set(file, { stamp, buckets: [...buckets] });
      changed = true;
    },
    save() {
      if (!changed && kept.size === stored.size) return;
      const out: CacheFile = { version: 1, parse: PARSE_VERSION, files: Object.fromEntries(kept) };
      mkdirSync(dirname(path), { recursive: true });
      // Write-through with rename, as the state file beside it does: a wsp init and an MCP scan over one state folder
      // otherwise leave a torn file, which reads as no cache and costs the whole read this one exists to remove.
      const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(out)}\n`);
      renameSync(tmp, path);
    },
  };
}
