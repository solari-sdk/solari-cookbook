// SPDX-License-Identifier: AGPL-3.0-only
// Hermes keeps every session in one SQLite database; an assistant message's
// tool_calls column is a JSON list of function calls. The database is read
// through the sqlite3 command in read-only mode, one query for the columns
// this needs.
import type { Host } from "../host.js";
import { type Call, type HistoryReader, isRecord, stampOf, tryJson } from "./reader.js";

const QUERY = "select session_id, tool_calls from messages where tool_calls is not null";
/** The same rows with the folder each session ran in; a database without the sessions table falls back to QUERY. */
const QUERY_WITH_CWD = "select m.session_id, m.tool_calls, s.cwd from messages m left join sessions s on s.id = m.session_id where m.tool_calls is not null";

export function hermesCall(session: string, name: string, args: unknown, folder?: string): Call {
  const arg = isRecord(args) ? args : {};
  const where = folder !== undefined ? { folder } : {};
  if (name === "terminal" && typeof arg["command"] === "string") return { session, ...where, kind: "shell", line: arg["command"] };
  return { session, ...where, kind: "other", name };
}

/** The calls in one row's tool_calls JSON. */
export function hermesCalls(session: string, toolCalls: unknown, folder?: string): Call[] {
  const list = typeof toolCalls === "string" ? tryJson(toolCalls) : toolCalls;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => {
    const fn = isRecord(item) && isRecord(item["function"]) ? item["function"] : undefined;
    if (fn === undefined || typeof fn["name"] !== "string") return [];
    const args = typeof fn["arguments"] === "string" ? tryJson(fn["arguments"]) : fn["arguments"];
    return [hermesCall(session, fn["name"], args, folder)];
  });
}

export const hermesReader: HistoryReader = {
  // One database is one file: it is read whole or not at all, so its own stamp says whether any session in it moved.
  async files(host, root) {
    const stamped = await stampOf(host, root);
    return stamped === undefined ? [] : [stamped];
  },
  async *read(host: Host, _root: string, file: string): AsyncIterable<Call> {
    const out = (await host.exec.run("sqlite3", ["-readonly", "-json", file, QUERY_WITH_CWD])) ?? (await host.exec.run("sqlite3", ["-readonly", "-json", file, QUERY]));
    if (out === undefined) throw new Error(`${file} could not be read with sqlite3`);
    const rows = out.trim() === "" ? [] : tryJson(out);
    if (!Array.isArray(rows)) throw new Error(`${file}: sqlite3 returned no JSON`);
    for (const row of rows) {
      if (!isRecord(row) || typeof row["session_id"] !== "string") continue;
      yield* hermesCalls(row["session_id"], row["tool_calls"], typeof row["cwd"] === "string" ? row["cwd"] : undefined);
    }
  },
};
