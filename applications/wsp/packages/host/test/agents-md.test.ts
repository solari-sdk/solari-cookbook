// SPDX-License-Identifier: AGPL-3.0-only
// The section wsp keeps in a project's own instructions to agents: what it
// says, that a second write replaces it instead of adding another, and that
// what the person wrote around it is never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECTION_BEGIN, SECTION_END, placeSections, projectDocPaths, removeSections, sectionText, withSection, withoutSection } from "../src/agents-md.js";
import { SKILL_NAME } from "../src/skill.js";
import { CLI_VERBS } from "../src/verbs.js";

const entryOf = (id: string) => CATALOG_AGENTS.find(a => a.id === id)!;

describe("the wsp section a project's instructions carry", () => {
  it("says what wsp is, the skill by the folder name it carries everywhere, and the three verbs to reach for first, each as the verb table has it, between the two markers", () => {
    const text = sectionText();
    expect(text.startsWith(`${SECTION_BEGIN}\n## wsp\n`)).toBe(true);
    expect(text.endsWith(SECTION_END)).toBe(true);
    expect(text).toContain("wsp runs cloud machines called workspaces");
    expect(text).toContain(`under \`${SKILL_NAME}\` in your agent's own`);
    expect(text).toContain("skills folder; read it before opening a thread, sending into one, or setting anyone up on wsp.");
    const named = text.split("\n").filter(l => l.startsWith("- `wsp "));
    expect(named).toEqual(["threads", "run", "send"].map(name => {
      const verb = CLI_VERBS.find(v => v.name === name)!;
      return `- \`wsp ${verb.name}\` ${verb.about}`;
    }));
  });

  it("one text for every agent: no agent's own skill path is in it, so it cannot be false for the next agent that reads it", () => {
    expect(sectionText()).not.toContain("~/");
  });

  it("a second write replaces the section where it stands and adds no other; the lines around it stay byte for byte", () => {
    const mine = "# myrepo\n\nRun the gate before you push.\n";
    const once = withSection(mine, sectionText());
    expect(once).toBe(`${mine}${sectionText()}\n`);
    expect(withSection(once, sectionText())).toBe(once);
    const older = `${SECTION_BEGIN}\n## wsp\n\nwhat an older wsp wrote here.\n${SECTION_END}`;
    const changed = withSection(`${mine}${older}\n\n## After\n\nMine too.\n`, sectionText());
    expect(changed).toBe(`${mine}${sectionText()}\n\n## After\n\nMine too.\n`);
    expect(changed.split(SECTION_BEGIN)).toHaveLength(2);
    const after = `${once}\n## After\n\nMine too.\n`;
    expect(withSection(after, sectionText())).toBe(after);
  });

  it("a file that has none takes the section after what it holds, one that ends without a newline gets one, and an empty one is the section alone", () => {
    expect(withSection(undefined, sectionText())).toBe(`${sectionText()}\n`);
    expect(withSection("", sectionText())).toBe(`${sectionText()}\n`);
    expect(withSection("no newline", sectionText())).toBe(`no newline\n${sectionText()}\n`);
  });

  it("taking the section out leaves the rest of the file byte for byte, and a file that never had one is left alone", () => {
    const mine = "# myrepo\n\nRun the gate before you push.\n";
    expect(withoutSection(withSection(mine, sectionText()))).toBe(mine);
    const between = `${mine}${sectionText()}\n\n## After\n\nMine too.\n`;
    expect(withoutSection(between)).toBe(`${mine}\n## After\n\nMine too.\n`);
    expect(withoutSection(mine)).toBeUndefined();
  });

  it("a file whose end marker somebody deleted is repaired by the next write, never given a second begin marker", () => {
    const mine = "# myrepo\n\nRun the gate before you push.\n";
    // With no end marker the file itself says wsp's section runs to its last byte, so the repair claims that far
    // and lines put under the stray marker go with it; only what sits above it is the person's for certain.
    const damaged = `${mine}${SECTION_BEGIN}\n## wsp\n\nhalf a section, the end marker gone.\n\n## After\n\nMine too.\n`;
    const repaired = withSection(damaged, sectionText());
    expect(repaired).toBe(`${mine}${sectionText()}\n`);
    expect(repaired.split(SECTION_BEGIN)).toHaveLength(2);
    expect(withoutSection(damaged)).toBe(mine);
    expect(withoutSection(`${SECTION_BEGIN}\nno end marker\n`)).toBe("");
  });
});

describe("the section on disk, in the files each agent reads", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "wsp-agents-md-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("every agent takes AGENTS.md and Claude Code takes CLAUDE.md beside it, the catalog naming the files", () => {
    expect(projectDocPaths(entryOf("claude"), project)).toEqual([join(project, "AGENTS.md"), join(project, "CLAUDE.md")]);
    for (const agent of CATALOG_AGENTS.filter(a => a.id !== "claude")) expect(projectDocPaths(agent, project), agent.id).toEqual([join(project, "AGENTS.md")]);
  });

  it("writes the section into each file, twice over leaves one, and the person's own lines stay", () => {
    const mine = "# myrepo\n\nRun the gate before you push.\n";
    writeFileSync(join(project, "AGENTS.md"), mine);
    expect(placeSections(entryOf("claude"), project)).toEqual([join(project, "AGENTS.md"), join(project, "CLAUDE.md")]);
    const once = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(once.startsWith(mine)).toBe(true);
    placeSections(entryOf("claude"), project);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(once);
    expect(once.split(SECTION_BEGIN)).toHaveLength(2);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe(`${sectionText()}\n`);
  });

  it("removing gives the file back as it was, drops a file that held nothing else, and says which files held one", () => {
    const mine = "# myrepo\n\nRun the gate before you push.\n";
    writeFileSync(join(project, "AGENTS.md"), mine);
    placeSections(entryOf("claude"), project);
    expect(removeSections(entryOf("claude"), project)).toEqual([join(project, "AGENTS.md"), join(project, "CLAUDE.md")]);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(mine);
    expect(existsSync(join(project, "CLAUDE.md"))).toBe(false);
    expect(removeSections(entryOf("claude"), project)).toEqual([]);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(mine);
  });

  it("a file somebody else wrote is left as it is, and a folder with no files at all takes the section in new ones", () => {
    const theirs = "# theirs\n";
    writeFileSync(join(project, "AGENTS.md"), theirs);
    expect(removeSections(entryOf("codex"), project)).toEqual([]);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(theirs);
    const empty = mkdtempSync(join(tmpdir(), "wsp-agents-md-empty-"));
    mkdirSync(join(empty, "sub"));
    expect(placeSections(entryOf("codex"), join(empty, "sub"))).toEqual([join(empty, "sub", "AGENTS.md")]);
    expect(readFileSync(join(empty, "sub", "AGENTS.md"), "utf8")).toContain(SECTION_END);
    rmSync(empty, { recursive: true, force: true });
  });
});
