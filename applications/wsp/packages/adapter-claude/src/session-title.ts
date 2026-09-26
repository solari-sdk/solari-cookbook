// SPDX-License-Identifier: AGPL-3.0-only
// What Claude Code itself calls a session, read from the session file it keeps
// under CLAUDE_CONFIG_DIR/projects/<folder key>/<session id>.jsonl. Two record
// kinds carry a title, both one-line objects beside the message lines:
// {"type":"ai-title","aiTitle":...} is the one the CLI generates, and
// {"type":"custom-title","customTitle":...} the one the person typed when they
// renamed the session. Measured on 2.1.263: both are re-appended at every turn
// boundary, and the last ai-title of a renamed session sat one line AFTER its
// last custom-title, so the newest record does not decide it; the person's
// rename wins wherever in the file it sits.

import { generatedTitle, shellQuote } from "@wsp/protocol";
import type { SessionRenameWrite } from "@wsp/protocol";
import { buildEnv } from "./landmines.js";

const AI_TITLE = '"type":"ai-title"';
const CUSTOM_TITLE = '"type":"custom-title"';

/**
 * One shell line for the guest: the last record of each kind from the session's file, in whichever project folder
 * holds it (the folder key is the session's path, which the caller does not know), the freshest file first where a
 * moved project left the id under two keys. Two greps rather than one, so the newest of each kind comes back
 * whatever order the CLI wrote them in, and the whole file rather than its tail, since a title record sits wherever
 * the session's last turn ended. Nothing on stdout when there is no such file, which reads as no title.
 */
export function sessionTitleCommand(options: { configDir: string; sessionId: string }): string {
  const file = `${shellQuote(`${options.configDir}/projects`)}/*/${shellQuote(`${options.sessionId}.jsonl`)}`;
  return (
    `f=$(ls -1td ${file} 2>/dev/null | head -n 1); [ -n "$f" ] || exit 0; ` +
    `grep -F ${shellQuote(CUSTOM_TITLE)} "$f" | tail -n 1; ` +
    `grep -F ${shellQuote(AI_TITLE)} "$f" | tail -n 1; true`
  );
}

/** The title the records name, the person's rename beating the generated one; null when neither is there or both are blank. */
export function parseSessionTitle(stdout: string): string | null {
  let generated: string | undefined;
  let renamed: string | undefined;
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
    const record = value as Record<string, unknown>;
    if (record.type === "custom-title" && typeof record.customTitle === "string") renamed = record.customTitle;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") generated = record.aiTitle;
  }
  for (const candidate of [renamed, generated]) {
    const title = (candidate ?? "").trim();
    if (title !== "") return title;
  }
  return null;
}

/**
 * One shell line for the guest that asks the CLI itself to name a thread: a print-mode turn on the question, with
 * the prompt on stdin rather than in the argv (a brief's excerpt would hit the kernel's per-argument cap) and the
 * whole answer as one JSON object. --safe-mode leaves the person's own customizations out of a question, their
 * SessionStart hooks, CLAUDE.md, skills, plugins and MCP servers, and leaves auth alone; no tool is allowed either,
 * since the answer is one line of words and a tool call would cost a turn of its own. Never --bare, whatever else
 * it skips: its auth is strictly ANTHROPIC_API_KEY, with OAuth and the keychain never read (measured on 2.1.263:
 * with no key in the environment, a --bare question against a signed-in store answers "Failed to authenticate"
 * where a --safe-mode question against that same store answers the title), so on a computer whose person signed in
 * rather than exported a key every title question came back an error while their own turns ran. The same
 * environment as a session, the login's config dir included, so the question reads the sign-in a turn there reads
 * and never runs as a nested Claude Code.
 */
export function titleForCommand(options: { prompt: string; model?: string; baseEnv?: Readonly<Record<string, string | undefined>> }): string {
  const env = buildEnv({ base: options.baseEnv });
  const exports = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
  const clean = `unset \${!CLAUDE_CODE_@} CLAUDECODE FORCE_CODE_TERMINAL; export ${exports}`;
  const claude = ["claude -p", "--safe-mode", "--output-format json", "--allowed-tools ''", ...(options.model === undefined ? [] : [`--model ${shellQuote(options.model)}`])].join(" ");
  return `cd ~ && ${clean}; printf '%s' ${shellQuote(options.prompt)} | ${claude}`;
}

/** The title out of the print-mode answer: its result field, sanitized; null when the CLI errored, answered nothing
 * or answered something that is not a title. */
export function parseTitleFor(stdout: string): string | null {
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
    const answer = value as Record<string, unknown>;
    if (answer.type !== "result" || answer.is_error === true) continue;
    if (typeof answer.result !== "string") continue;
    return generatedTitle(answer.result);
  }
  return null;
}

/** The three words the write answers with on stdout, one per line: the append landed, no file of that id under the
 * config dir, or the shell's own message for an append that did not run. */
const WROTE = "wrote";
const NO_SESSION = "no-session";
const FAILED = "failed";

/**
 * One shell line for the guest: the custom-title record appended to the session's file, the same record `/rename`
 * inside the CLI appends (measured on 2.1.263: the keys in this order, one line, nothing else touched), in whichever
 * project folder holds the session, the freshest first as the read picks it. A file whose last line was left half
 * written by a crash takes a newline first, so the record is never swallowed by it. The glob is the store's answer,
 * so no file of that id is no session; an append that could not run says so with the shell's own line, since a full
 * disk or a read-only mount says nothing about which sessions the store has.
 */
export function renameCommand(options: { configDir: string; sessionId: string; title: string }): string {
  const file = `${shellQuote(`${options.configDir}/projects`)}/*/${shellQuote(`${options.sessionId}.jsonl`)}`;
  const record = JSON.stringify({ type: "custom-title", customTitle: options.title, sessionId: options.sessionId });
  return (
    `f=$(ls -1td ${file} 2>/dev/null | head -n 1); [ -n "$f" ] || { echo ${NO_SESSION}; exit 0; }; ` +
    `[ -z "$(tail -c 1 "$f")" ] || printf '\n' >> "$f" 2>/dev/null; ` +
    `e=$({ printf '%s\n' ${shellQuote(record)} >> "$f"; } 2>&1) && echo ${WROTE} || printf '%s %s\n' ${FAILED} "$e"`
  );
}

/** What the write came to, in the words the line printed; a stdout with none of them is a failure with what it said,
 * since a write nobody confirmed may not read as a session that is not there. */
export function parseRename(stdout: string): SessionRenameWrite {
  const lines = stdout.split("\n").map(line => line.trim());
  if (lines.includes(WROTE)) return { kind: "written" };
  if (lines.includes(NO_SESSION)) return { kind: "no-session" };
  const said = lines.filter(line => line !== "");
  const failed = said.find(line => line.startsWith(`${FAILED} `));
  return { kind: "failed", error: failed !== undefined ? failed.slice(FAILED.length + 1) : said.join("; ") || "the machine said nothing about the write" };
}
