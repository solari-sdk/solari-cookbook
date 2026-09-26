// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer, inlined at build time from the
// one file in the repo, so the MCP server's instructions and the skill an
// install writes cannot drift apart.
/// <reference path="./markdown.d.ts" />
import text from "../../../skills/wsp/SKILL.md";
import { THREAD_AGENTS, WSP_SKILL_NAME } from "@wsp/catalog";

export const SKILL_NAME = WSP_SKILL_NAME;

export const WSP_SKILL: string = text;

/** The section whose opening paragraph is the condensed walkthrough the instructions carry; the numbered steps and
 * the exact lines to watch for stay in the skill, which is too long to be a server's instructions. */
export const SETUP_HEADING = "## Setting a person up from nothing";

/** The section the instructions carry whole, its opening paragraph and every rule line: what a machine can do at
 * once and what wastes it, which a caller holding only the tools has nowhere else to read. */
export const RULES_HEADING = "## Running work on a workspace well";

/** The verbs table an agent reads, and the section holding the one verb that blocks, which is a shell script's. A
 * verb whose row sits in the wrong one of these teaches the wrong road, so the parity test pins where each is. */
export const VERBS_HEADING = "## Verbs and tools";
export const SHELL_HEADING = "### For a shell script";

/** What a caller holding only the tools cannot read off them: where the whole procedure lives, and that the setup
 * verbs are on the command line alone, so a caller with a shell should reach for that instead. */
const BEYOND_THE_TOOLS =
  "The steps, with the exact line to run and what to watch for after each, are in the wsp skill, which `wsp mcp install --agent <id>` writes into this agent's skills folder; when you have a shell prefer the `wsp` command line, since `wsp init` and `wsp up` are the command line's alone.";

/** The lines from `from` up to the next blank line or heading, trimmed and joined as one paragraph. */
function paragraph(lines: readonly string[], from: number): string {
  const body: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#")) break;
    if (line.trim() === "") {
      if (body.length > 0) break;
      continue;
    }
    body.push(line.trim());
  }
  return body.join(" ");
}

/** The `- ` lines of the section beginning at `from`, up to the next section. */
function bullets(lines: readonly string[], from: number): string[] {
  const body: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) body.push(line);
  }
  return body;
}

/** The agents a thread runs on, from the adapter registry, so the instructions promise no agent the host refuses. */
export function agentsLine(agents: readonly string[]): string {
  return `The agents this host runs threads on, the only values run and fork take as agent: ${agents.join(", ")}.`;
}

/** The MCP server's instructions: the skill's opening paragraph, then the setup walkthrough's, the agents the host
 * has adapters for, the line that points back at the skill and the command line, and the rules for running work on
 * a machine, one line each as the skill writes them. The frontmatter and the title line are not part of it. */
export function instructionsOf(skill: string, agents: readonly string[]): string {
  const lines = skill.split("\n");
  let start = 0;
  if (lines[0] === "---") {
    start = lines.indexOf("---", 1) + 1;
    if (start === 0) throw new Error("the skill's frontmatter never closes");
  }
  const title = lines.findIndex((line, at) => at >= start && line.startsWith("# "));
  const opening = paragraph(lines, title === -1 ? start : title + 1);
  if (opening === "") throw new Error("the skill has no opening paragraph before its first section");
  const heading = lines.indexOf(SETUP_HEADING);
  if (heading === -1) throw new Error(`the skill has no ${SETUP_HEADING} section`);
  const walkthrough = paragraph(lines, heading + 1);
  if (walkthrough === "") throw new Error(`${SETUP_HEADING} has no opening paragraph`);
  const rules = lines.indexOf(RULES_HEADING);
  if (rules === -1) throw new Error(`the skill has no ${RULES_HEADING} section`);
  const lead = paragraph(lines, rules + 1);
  const written = bullets(lines, rules + 1);
  if (lead === "" || written.length === 0) throw new Error(`${RULES_HEADING} has no rules`);
  return [[opening, walkthrough, agentsLine(agents), BEYOND_THE_TOOLS, lead].join(" "), ...written].join("\n");
}

export const INSTRUCTIONS: string = instructionsOf(WSP_SKILL, THREAD_AGENTS);
