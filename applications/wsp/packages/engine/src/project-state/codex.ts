// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { jsonlCwdStep, mergeScript } from "./merge.js";
import { pyData } from "./py.js";
import { movedOr, rewriteCwd, underHome, type MovedState, type ProjectStateResolver } from "./resolver.js";
import { countRows, inTransaction, movedColumn, pathParams, projectRows, readOnly, runUpdate, sqliteFilter, sqliteMergeStep, underPath, type ProjectTable } from "./sqlite.js";

const SESSIONS_DIR = "sessions";
const SESSIONS = `/${SESSIONS_DIR}/`;
const INDEX = "state_5.sqlite";
const ROOTS = [INDEX, SESSIONS_DIR];
/** The index is one file every project's threads sit in; these are the project's rows of it. */
const THREADS: ProjectTable = { table: "threads", where: underPath("cwd") };
const INDEXED_ROLLOUTS = `select rollout_path from ${THREADS.table} where ${THREADS.where} order by rollout_path`;

/** The rollout under this home: rollout_path is absolute on the machine that wrote it, so only its tail past sessions/ carries over. */
function rolloutUnder(home: string, recorded: string): string | undefined {
  const i = recorded.lastIndexOf(SESSIONS);
  return i < 0 ? undefined : underHome(home, SESSIONS_DIR, recorded.slice(i + SESSIONS.length));
}

/** The rollouts present under this home among the ones the index recorded, and how many it recorded that are not:
 * archived outside sessions/, or gone. */
function rolloutsUnder(home: string, recorded: readonly string[]): { files: string[]; skipped: number } {
  const files = new Set<string>();
  let skipped = 0;
  for (const r of recorded) {
    const f = rolloutUnder(home, r);
    if (f !== undefined && existsSync(f)) files.add(f);
    else skipped++;
  }
  return { files: [...files], skipped };
}

export const codexResolver: ProjectStateResolver = {
  agent: "codex",
  carry: "transcript-only",
  states: ["thread index", "rollout transcript"],
  roots: ROOTS,
  shared: { store: INDEX, filter: sqliteFilter([THREADS]) },
  async move(home, from, to) {
    const moved: MovedState[] = [];
    const index = join(home, INDEX);
    const params = pathParams(from, to);
    const indexed = inTransaction(index, d => {
      const rollouts = d.prepare(INDEXED_ROLLOUTS).all({ $from: from }).map(r => String(r.rollout_path));
      const threads = runUpdate(d, { sql: `update threads set cwd = ${movedColumn("cwd")} where ${underPath("cwd")}`, params });
      return { rollouts, threads };
    });
    if (indexed === undefined) return moved;
    const rollouts = rolloutsUnder(home, indexed.rollouts);
    if (indexed.threads > 0) moved.push({ state: "thread index", files: [index], changed: indexed.threads, ...(rollouts.skipped > 0 ? { skipped: rollouts.skipped } : {}) });
    const files: string[] = [];
    let changed = 0;
    for (const f of rollouts.files) {
      const n = await rewriteCwd(f, from, to, line => line.payload);
      if (n > 0) {
        files.push(f);
        changed += n;
      }
    }
    if (changed > 0) moved.push({ state: "rollout transcript", files, changed });
    return moved;
  },
  sessions: async (home, path) => countRows(join(home, INDEX), `select count(*) as n from threads where ${underPath("cwd")}`, { $from: path }),
  entries: async (home, path) => rolloutsUnder(home, readOnly(join(home, INDEX), d => d.prepare(INDEXED_ROLLOUTS).all({ $from: path }).map(r => String(r.rollout_path))) ?? []).files,
  // COPY is the filtered index the shared store's step has already written: it holds this project's threads alone,
  // so the rollouts to pull are every one it names.
  listing: home => [
    `con = sqlite3.connect("file:" + urllib.parse.quote(COPY) + "?mode=ro", uri=True)`,
    "try:",
    `    indexed = con.execute(${pyData("select rollout_path from threads order by rollout_path")}).fetchall()`,
    "finally:",
    "    con.close()",
    "for (rollout,) in indexed:",
    `    cut = rollout.rfind(${pyData(SESSIONS)}) if isinstance(rollout, str) else -1`,
    "    if cut >= 0:",
    `        say(os.path.join(${pyData(join(home, SESSIONS_DIR))}, rollout[cut + ${SESSIONS.length}:]))`,
  ],
  async merge(home, from, to, guestHome) {
    // Only a thread whose rollout travelled (the ones entries names) is listed on the machine; a row without its file would open nothing there.
    const threads = projectRows(join(home, INDEX), THREADS, from).filter(r => rolloutsUnder(home, [String(r["rollout_path"])]).files.length > 0);
    if (threads.length === 0) return undefined;
    const rows = threads.map(r => ({ ...r, cwd: movedOr(r["cwd"] ?? null, from, to), rollout_path: rolloutUnder(guestHome, String(r["rollout_path"])) ?? null }));
    // The landed rollouts still carry this computer's cwd: the skeleton they moved through had no index to name them.
    return mergeScript(from, to, [
      jsonlCwdStep(rows.map(r => String(r.rollout_path)), "payload"),
      sqliteMergeStep(join(guestHome, INDEX), [{ table: "threads", key: ["id"], set: ["cwd", "rollout_path"], rows }]),
    ]);
  },
};
