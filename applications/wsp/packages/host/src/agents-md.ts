// SPDX-License-Identifier: AGPL-3.0-only
// The section wsp keeps in a project's own instructions to agents: the markers
// that bound it, the one text inside them, and the rewrite that replaces the
// section already there or appends a first one. Everything outside the markers
// is the person's and travels through byte for byte. Which files an agent
// reads is the catalog entry's own fact.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEntry } from "@wsp/catalog";
import { SKILL_NAME } from "./skill.js";
import { CLI_VERBS } from "./verbs.js";

/** The lines that bound wsp's own section; an HTML comment, so every markdown reader shows the text and not these. */
export const SECTION_BEGIN = "<!-- wsp:begin -->";
export const SECTION_END = "<!-- wsp:end -->";

/** The verbs the section names, in the order an agent reaches for them: what is running, a thread on one of them,
 * the next turn of that thread. Named against the verb table, so the section cannot promise a verb wsp dropped. */
const FIRST_VERBS = ["threads", "run", "send"] as const;

/** The one text the section carries: what wsp is, the skill by the folder name every agent keeps it under, and the
 * three verbs. One file holds this section and several agents read it, so it names no agent's own skill path. */
export function sectionText(): string {
  const verbs = FIRST_VERBS.map(name => {
    const verb = CLI_VERBS.find(v => v.name === name);
    if (verb === undefined) throw new Error(`no wsp verb ${name} for the ${SECTION_BEGIN} section`);
    return `- \`wsp ${verb.name}\` ${verb.about}`;
  });
  return [
    SECTION_BEGIN,
    "## wsp",
    "",
    "wsp runs cloud machines called workspaces, forked in seconds from the image this computer sealed, each with",
    "coding agents working inside it as threads. Whatever you run on one shows in the person's app, and they can read",
    `and answer any thread. The wsp skill is installed on this computer under \`${SKILL_NAME}\` in your agent's own`,
    "skills folder; read it before opening a thread, sending into one, or setting anyone up on wsp.",
    "",
    "The three to reach for first:",
    "",
    ...verbs,
    SECTION_END,
  ].join("\n");
}

/** Where the section begins and ends in a file, or nothing when the file has none. A begin marker whose end marker
 * somebody deleted bounds a section that runs to the end of the file, so the next write repairs the file in place
 * rather than leaving the stray marker and opening a second section under it. */
function bounds(text: string): { from: number; to: number } | undefined {
  const from = text.indexOf(SECTION_BEGIN);
  if (from === -1) return undefined;
  const end = text.indexOf(SECTION_END, from);
  if (end === -1) return { from, to: text.length };
  const to = end + SECTION_END.length;
  return { from, to: text[to] === "\n" ? to + 1 : to };
}

/** The file with the section in it: the one already there replaced where it stands, or a new one after what the
 * file holds. A file that ends without a newline gets one, so the markers open a line of their own. */
export function withSection(text: string | undefined, section: string): string {
  const had = text === undefined ? undefined : bounds(text);
  if (text !== undefined && had !== undefined) return `${text.slice(0, had.from)}${section}\n${text.slice(had.to)}`;
  const base = text === undefined || text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${section}\n`;
}

/** The file without the section, the rest of it byte for byte; nothing when it had no section. */
export function withoutSection(text: string): string | undefined {
  const had = bounds(text);
  return had === undefined ? undefined : `${text.slice(0, had.from)}${text.slice(had.to)}`;
}

/** The agent's instruction files under `project`, absolute, in the order the catalog entry names them. */
export function projectDocPaths(entry: AgentEntry, project: string): string[] {
  return entry.projectDocs.map(doc => join(project, doc));
}

/** Writes the section into each of the agent's instruction files under `project`, creating one that is not there
 * and replacing a section that is. Answers with the files, absolute. */
export function placeSections(entry: AgentEntry, project: string): string[] {
  const section = sectionText();
  return projectDocPaths(entry, project).map(path => {
    writeFileSync(path, withSection(existsSync(path) ? readFileSync(path, "utf8") : undefined, section));
    return path;
  });
}

/** Takes the section out of each of the agent's instruction files under `project`, leaving what else they hold.
 * A file that held nothing but the section goes with it. Answers with the files it came out of. */
export function removeSections(entry: AgentEntry, project: string): string[] {
  return projectDocPaths(entry, project).filter(path => {
    if (!existsSync(path)) return false;
    const rest = withoutSection(readFileSync(path, "utf8"));
    if (rest === undefined) return false;
    if (rest === "") rmSync(path);
    else writeFileSync(path, rest);
    return true;
  });
}
