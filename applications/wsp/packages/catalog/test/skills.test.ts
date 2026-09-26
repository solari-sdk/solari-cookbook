// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, CLAUDE_PLUGIN_SKILLS, CODEX_TOML, OPENCODE_JSON, SHARED_SKILLS, SKILL_NAME, WSP_SKILL_NAME, XDG_SHARED_SKILLS, catalogEntry, isSystemSkill, ownSkillFolder, skillsDirOf, type AgentEntry } from "../src/index.js";

describe("the folders each agent loads skills from", () => {
  it("every agent names its own folder under the home first, and project folders relative to the project", () => {
    for (const a of CATALOG_AGENTS) {
      expect(skillsDirOf(a), a.id).toMatch(/^~\/\S+\/skills$/);
      for (const r of a.skillRoots.user) expect(r.dir.startsWith("~/"), `${a.id} ${r.dir}`).toBe(true);
      for (const r of a.skillRoots.project) expect(r.dir.startsWith("/") || r.dir.startsWith("~"), `${a.id} ${r.dir}`).toBe(false);
    }
    // No agent's own folder is a shared one: ~/.agents/skills and the XDG ~/.config/agents/skills are each read by
    // several agents and carry no one of them, so a skill installed for one agent never lands where others read it.
    for (const shared of [SHARED_SKILLS, XDG_SHARED_SKILLS]) expect(CATALOG_AGENTS.map(skillsDirOf)).not.toContain(shared);
    expect(XDG_SHARED_SKILLS).toBe("~/.config/agents/skills");
  });

  it("Claude Code's plugin index names the skill folders of its user-scoped plugins only", () => {
    const index = JSON.stringify({
      version: 2,
      plugins: {
        "a@m": [{ scope: "user", installPath: "/h/.claude/plugins/cache/m/a/1/" }, { scope: "project", projectPath: "/p", installPath: "/h/.claude/plugins/cache/m/a/2" }],
        "b@m": [{ scope: "user", installPath: "relative/path" }],
      },
    });
    expect(CLAUDE_PLUGIN_SKILLS.roots(index)).toEqual(["/h/.claude/plugins/cache/m/a/1/skills"]);
    expect(CLAUDE_PLUGIN_SKILLS.roots("not json")).toEqual([]);
  });
});

describe("a server its file switches off", () => {
  it("reads OpenCode's enabled false and Codex's enabled = false as off, and every other server as on", () => {
    const opencode = OPENCODE_JSON.read(JSON.stringify({ mcp: { a: { type: "local", command: ["x"], enabled: false }, b: { type: "remote", url: "https://b.example" } } }), "/h");
    expect(opencode.map(s => [s.name, s.disabled])).toEqual([["a", true], ["b", undefined]]);
    const codex = CODEX_TOML.read('[mcp_servers.a]\ncommand = "x"\nenabled = false\n\n[mcp_servers.b]\ncommand = "y"\nenabled = true\n', "/h");
    expect(codex.map(s => [s.name, s.disabled])).toEqual([["a", true], ["b", undefined]]);
  });
});

describe("the skills wsp writes itself", () => {
  it("are the one on the person's computer and the one on a machine wsp made, and no other", () => {
    expect(isSystemSkill(WSP_SKILL_NAME)).toBe(true);
    expect(isSystemSkill(SKILL_NAME)).toBe(true);
    expect(isSystemSkill("wsp-review")).toBe(false);
    expect(isSystemSkill("pdf")).toBe(false);
  });
});

describe("where an install puts a skill for each agent", () => {
  const agent = (id: string): AgentEntry => catalogEntry(id) as AgentEntry;
  it("gives an agent that reads the shared folder nothing of its own, and the rest their own folder and how it takes one", () => {
    expect(ownSkillFolder(agent("claude"), false)).toEqual({ dir: "~/.claude/skills", lands: "link" });
    expect(ownSkillFolder(agent("gemini"), false)).toEqual({ dir: "~/.gemini/skills", lands: "copy" });
    for (const id of ["codex", "opencode", "pi"]) expect(ownSkillFolder(agent(id), false), id).toBeUndefined();
    expect(ownSkillFolder(agent("claude"), true)).toEqual({ dir: ".claude/skills", lands: "link" });
    expect(ownSkillFolder(agent("pi"), true)).toBeUndefined();
    expect(ownSkillFolder(agent("hermes"), true)).toBeUndefined();
  });
});
