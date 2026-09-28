// SPDX-License-Identifier: AGPL-3.0-only
// What Codex itself calls a thread, read from the thread index in CODEX_HOME:
// state_<schema version>.sqlite, table threads, one row per thread id (the
// catalog's measured row for codex). Two columns name a thread: title, which
// the CLI fills from the thread's opening words and never leaves null, and
// name, which stays null until the person names the thread, so name wins where
// it has one, and a rename from here writes that same column. Measured on
// codex-cli 0.153.0 against state_5.sqlite.

import { generatedTitle, shellQuote } from "@wsp/protocol";
import type { SessionRenameWrite } from "@wsp/protocol";
import { buildCommand, buildEnv, slug } from "./command.js";

/**
 * One shell line for the guest: the thread's row as JSON, out of the highest-versioned state db (the file name
 * carries the schema version, so a codex upgrade moves it). The names are sorted inside CODEX_HOME on the number
 * after the underscore, so state_10 beats state_5 and a home whose own path holds an underscore cannot confuse the
 * field. Read-only, so a running codex keeps its write lock, and json_object rather than printed columns, since a
 * name may hold whatever character a separator would use. Nothing on stdout when the machine has no sqlite3, no
 * state db or no such row, which reads as no title.
 */
export function sessionTitleCommand(options: { home: string; threadId: string }): string {
  const query = `select json_object('name', name, 'title', title) from threads where id = '${slug("threadId", options.threadId)}' limit 1;`;
  return (
    `command -v sqlite3 > /dev/null 2>&1 || exit 0; ` +
    `cd ${shellQuote(options.home)} 2>/dev/null || exit 0; ` +
    `d=$(ls -1 state_*.sqlite 2>/dev/null | sort -t_ -k2,2n | tail -n 1); [ -n "$d" ] || exit 0; ` +
    `sqlite3 -readonly "$d" ${shellQuote(query)} 2>/dev/null; true`
  );
}

/** The thread's name where the person gave it one, else the title the CLI derived; null when the row is missing or both are blank. */
export function parseSessionTitle(stdout: string): string | null {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    for (const column of ["name", "title"] as const) {
      const title = (typeof row[column] === "string" ? (row[column] as string) : "").trim();
      if (title !== "") return title;
    }
    return null;
  }
  return null;
}

/**
 * One shell line for the guest that asks the CLI itself to name a thread: a plain turn on the question, in the same
 * shape every codex turn on a workspace runs in, so the prompt travels on stdin and the flags stay in one place. It
 * runs read-only rather than with the sandbox off, since the answer is one line of words and nothing it could write
 * belongs to the thread it names, and under the same CODEX_HOME as a session, which a guest exec would not carry.
 */
export function titleForCommand(options: { home: string; prompt: string; model?: string; baseEnv?: Readonly<Record<string, string | undefined>> }): string {
  const env = buildEnv({ base: options.baseEnv, home: options.home });
  const exports = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
  return `export ${exports}; ${buildCommand({ prompt: options.prompt, permissionMode: "read-only", ...(options.model === undefined ? {} : { model: options.model }) })}`;
}

/** The title out of the turn's events: the last agent message, sanitized; null when the turn failed, said nothing or
 * said something that is not a title. */
export function parseTitleFor(stdout: string): string | null {
  let text: string | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.type === "agent_message" && typeof row.text === "string") text = row.text;
  }
  return text === undefined ? null : generatedTitle(text);
}

/** A SQL string literal: single quotes around it, and an embedded quote doubled, which is sqlite's own escape. */
const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** How long the write waits for a running codex to let go of the db before it gives up; a rename is a person waiting. */
const BUSY_MS = 5_000;

/** The words the write answers with on stdout: the rows the update changed, or the reason nothing was written. */
const CHANGED = "changed";
const FAILED = "failed";

/**
 * One shell line for the guest: the thread's name column set, the column the TUI's own rename writes, in the
 * highest-versioned state db the read picks too. The db is the running codex's, so the write waits out its lock
 * rather than failing at once, and `changes()` comes back on stdout so a row that is not there is not read as a
 * write. The wait is the `.timeout` dot command and not the pragma of the same name, which would print its own
 * value onto that stdout. Measured on sqlite3 3.40.1: the CLI stops at the first error, so a refused update never
 * reaches `changes()` and prints its own message on stderr instead; that message is what a failure carries, since a
 * lock that never came free says nothing about which threads the index has.
 */
export function renameCommand(options: { home: string; threadId: string; title: string }): string {
  const query =
    `update threads set name = ${sqlText(options.title)} where id = '${slug("threadId", options.threadId)}'; ` +
    `select '${CHANGED} ' || changes();`;
  return (
    `command -v sqlite3 > /dev/null 2>&1 || { echo '${FAILED} sqlite3 is not on the machine'; exit 0; }; ` +
    `cd ${shellQuote(options.home)} 2>/dev/null || { echo '${FAILED} no codex home on the machine'; exit 0; }; ` +
    `d=$(ls -1 state_*.sqlite 2>/dev/null | sort -t_ -k2,2n | tail -n 1); ` +
    `[ -n "$d" ] || { echo '${FAILED} no codex thread index on the machine'; exit 0; }; ` +
    `e=$(sqlite3 -cmd ${shellQuote(`.timeout ${BUSY_MS}`)} "$d" ${shellQuote(query)} 2>&1) && printf '%s\n' "$e" || printf '%s %s\n' ${FAILED} "$e"`
  );
}

/** What the write came to: the rows the update changed, a zero being a thread the index does not hold, and anything
 * else the reason nothing was written, in the words the machine used. */
export function parseRename(stdout: string): SessionRenameWrite {
  const said = stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
  const changed = said.find(line => line.startsWith(`${CHANGED} `));
  if (changed !== undefined) return Number.parseInt(changed.slice(CHANGED.length + 1), 10) > 0 ? { kind: "written" } : { kind: "no-session" };
  const failed = said.find(line => line.startsWith(`${FAILED} `));
  return { kind: "failed", error: failed !== undefined ? failed.slice(FAILED.length + 1) : said.join("; ") || "the machine said nothing about the write" };
}
