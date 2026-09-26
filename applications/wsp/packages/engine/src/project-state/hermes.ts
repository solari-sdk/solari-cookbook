// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { mergeScript } from "./merge.js";
import { movedOr, type ProjectStateResolver } from "./resolver.js";
import { countRows, movedColumn, pathParams, sharedTables, sqliteFilter, sqliteMergeStep, underPath, updateRows, type SharedTable } from "./sqlite.js";

const DB = "state.db";
const AT_PATH = `${underPath("cwd")} or ${underPath("git_repo_root")}`;
const AT_PATH_IDS = `select id from sessions where ${AT_PATH}`;
/** The whole store is one file every project's sessions sit in; these are the project's rows of it. A message's id is
 * an autoincrement integer, its own on each computer, so a session's messages land whole or not at all. */
const TABLES: readonly SharedTable[] = [
  { table: "sessions", where: AT_PATH, key: ["id"], set: ["cwd", "git_repo_root"], move: (r, from, to) => ({ ...r, cwd: movedOr(r["cwd"] ?? null, from, to), git_repo_root: movedOr(r["git_repo_root"] ?? null, from, to) }) },
  { table: "messages", where: `session_id in (${AT_PATH_IDS})`, by: "session_id", drop: ["id"], move: r => r },
];

export const hermesResolver: ProjectStateResolver = {
  agent: "hermes",
  carry: "transcript-only",
  states: ["sessions"],
  roots: [DB],
  shared: { store: DB, filter: sqliteFilter(TABLES) },
  async move(home, from, to) {
    const db = join(home, DB);
    const [changed = 0] = updateRows(db, [{
      sql: `update sessions set cwd = ${movedColumn("cwd")}, git_repo_root = ${movedColumn("git_repo_root")} where ${AT_PATH}`,
      params: pathParams(from, to),
    }]) ?? [];
    return changed > 0 ? [{ state: "sessions", files: [db], changed }] : [];
  },
  sessions: async (home, path) => countRows(join(home, DB), `select count(*) as n from sessions where ${AT_PATH}`, { $from: path }),
  entries: async () => [],
  async merge(home, from, to, guestHome) {
    const tables = sharedTables(join(home, DB), TABLES, from, to);
    return tables === undefined ? undefined : mergeScript(from, to, [sqliteMergeStep(join(guestHome, DB), tables)]);
  },
};
