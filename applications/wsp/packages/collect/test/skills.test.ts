// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSkills, skillFrontmatter, skillMdFrontmatter, skillRoots } from "../src/detect/skills.js";
import type { Host } from "../src/host.js";
import { nodeHost } from "../src/live-host.js";
import { agentHome } from "./agent-home.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): { host: Host; home: string; project: string; runs: string[][] } {
  const root = mkdtempSync(join(tmpdir(), "wsp-skills-"));
  roots.push(root);
  const { home, project } = agentHome(root);
  const live = nodeHost();
  const runs: string[][] = [];
  const host: Host = { ...live, home, exec: { ...live.exec, run: (cmd, args, o) => (runs.push([cmd, ...args]), live.exec.run(cmd, args, o)) } };
  return { host, home, project, runs };
}

describe("the skills on a computer", () => {
  it("lists every skill once by name with every folder it lives in, links and copies, and whose own folder each is", async () => {
    const { host, runs } = fixture();
    const read = await detectSkills(host, await skillRoots(host));
    expect(read.refused).toEqual([]);
    // One command for every folder, however many skills they hold.
    expect(runs).toHaveLength(1);
    expect(read.skills.map(s => [s.name, s.scope])).toEqual([
      ["frontend-design", "plugin"],
      ["pdf", "user"],
      ["plan", "user"],
      ["review", "user"],
      ["sql", "user"],
    ]);
    const pdf = read.skills.find(s => s.name === "pdf")!;
    expect(pdf.description).toBe("Read and fill PDF forms");
    expect(pdf.paths).toEqual([
      { path: "~/.claude/skills/pdf", agent: "claude", linkTo: "~/.agents/skills/pdf" },
      { path: "~/.codex/skills/pdf", agent: "codex" },
      { path: "~/.agents/skills/pdf" },
      { path: "~/.pi/agent/skills/pdf", agent: "pi", linkTo: "~/.agents/skills/pdf" },
    ]);
    expect(read.skills.find(s => s.name === "sql")!.paths.map(p => p.agent)).toEqual(["gemini", "opencode"]);
    expect(read.skills.find(s => s.name === "review")!.description).toBe("Review a diff");
    expect(read.skills.find(s => s.name === "plan")!.paths).toEqual([{ path: "~/.hermes/skills/software-development/plan", agent: "hermes" }]);
    expect(read.skills.find(s => s.name === "frontend-design")!.paths[0]).toMatchObject({ path: "~/.claude/plugins/cache/official/frontend/abc123/skills/frontend-design", agent: "claude" });
  });

  it("leaves out dot folders, folders with no SKILL.md, a skill's own inner examples and a project's plugin", async () => {
    const { host } = fixture();
    const names = (await detectSkills(host, await skillRoots(host))).skills.map(s => s.name);
    for (const never of ["hidden", "cached", "notes", "inner", "project-only"]) expect(names).not.toContain(never);
  });

  it("reads a folder whose SKILL.md was renamed SKILL.md.off as that skill turned off there, through a link too", async () => {
    const { host, home } = fixture();
    const shared = join(home, ".agents/skills/memo");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "SKILL.md"), "---\nname: memo\ndescription: Keep notes\n---\nbody\n");
    symlinkSync(shared, join(home, ".claude/skills/memo"));
    renameSync(join(shared, "SKILL.md"), join(shared, "SKILL.md.off"));
    const memo = (await detectSkills(host, await skillRoots(host))).skills.find(s => s.name === "memo")!;
    expect(memo.description).toBe("Keep notes");
    expect(memo.paths).toEqual([
      { path: "~/.claude/skills/memo", agent: "claude", linkTo: "~/.agents/skills/memo", off: true },
      { path: "~/.agents/skills/memo", off: true },
    ]);
    // A folder holding both is on: an agent loads the SKILL.md it finds.
    writeFileSync(join(shared, "SKILL.md"), "---\nname: memo\n---\n");
    const again = (await detectSkills(host, await skillRoots(host))).skills.find(s => s.name === "memo")!;
    expect(again.paths.every(p => p.off === undefined)).toBe(true);
  });

  it("reads a SKILL.md saved with CRLF line ends as the node reader reads it", async () => {
    const { host, home } = fixture();
    const text = "---\r\nname: memo\r\ndescription: Keep notes\r\n---\r\nbody\r\n";
    mkdirSync(join(home, ".agents/skills/memo"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/memo/SKILL.md"), text);
    const memo = (await detectSkills(host, await skillRoots(host))).skills.find(s => s.name === "memo")!;
    expect(memo.description).toBe("Keep notes");
    expect(memo.description).toBe(skillMdFrontmatter(text).description);
  });

  it("keys a skill by its folder's name, so a SKILL.md naming another skill stands as its own row", async () => {
    const { host, home } = fixture();
    mkdirSync(join(home, ".agents/skills/cool-tool"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/cool-tool/SKILL.md"), "---\nname: pdf\ndescription: Not the real one\n---\n");
    const skills = (await detectSkills(host, await skillRoots(host))).skills;
    expect(skills.find(s => s.name === "cool-tool")!.paths).toEqual([{ path: "~/.agents/skills/cool-tool" }]);
    expect(skills.find(s => s.name === "pdf")!.paths.map(p => p.path)).not.toContain("~/.agents/skills/cool-tool");
  });

  it("a workspace adds its project's own folders as project skills, each naming the project", async () => {
    const { host, project } = fixture();
    const read = await detectSkills(host, await skillRoots(host, { projects: [{ id: "pr_app", name: "app", path: project }] }));
    const app = { id: "pr_app", name: "app", path: "~/code/app" };
    expect(read.skills.filter(s => s.scope === "project").map(s => [s.name, s.paths, s.project])).toEqual([
      ["deploy", [{ path: "~/code/app/.claude/skills/deploy", agent: "claude" }], app],
      ["lint", [{ path: "~/code/app/.agents/skills/lint", agent: "codex" }], app],
    ]);
  });

  it("a computer's projects each add their folders, and one name in two projects is two rows, one per project", async () => {
    const { host, home, project } = fixture();
    const other = join(home, "code", "www");
    mkdirSync(join(other, ".claude/skills/deploy"), { recursive: true });
    writeFileSync(join(other, ".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Ship www\n---\n");
    const read = await detectSkills(host, await skillRoots(host, { projects: [{ id: "pr_app", name: "app", path: project }, { id: "pr_www", name: "www", path: other }] }));
    const deploys = read.skills.filter(s => s.name === "deploy");
    expect(deploys.map(s => [s.project?.name, s.description, s.paths.map(p => p.path)])).toEqual([
      ["app", "Deploy the app", ["~/code/app/.claude/skills/deploy"]],
      ["www", "Ship www", ["~/code/www/.claude/skills/deploy"]],
    ]);
    expect(read.skills.filter(s => s.scope !== "project").every(s => s.project === undefined)).toBe(true);
  });

  it("an answer cut short is a refusal, and a read that failed is one, never a short list said as whole", async () => {
    const { host } = fixture();
    const cut: Host = { ...host, exec: { ...host.exec, run: async (cmd, args, o) => (await host.exec.run(cmd, args, o))?.replace(/\x1eEND\n$/, "") } };
    expect((await detectSkills(cut, await skillRoots(host))).refused).toEqual(["skills: the answer was cut short, so the list is not whole"]);
    const failed: Host = { ...host, exec: { ...host.exec, run: async () => undefined } };
    expect(await detectSkills(failed, await skillRoots(host))).toEqual({ skills: [], refused: ["skills: the folders could not be read"] });
  });

  it("reads a frontmatter's plain, quoted, folded and continued values", () => {
    expect(skillFrontmatter('name: "a b"\ndescription: >-\n  one\n  two\nother: x')).toEqual({ name: "a b", description: "one two" });
    expect(skillFrontmatter("name: c\ndescription: starts here\n  and goes on")).toEqual({ name: "c", description: "starts here and goes on" });
    expect(skillFrontmatter("title: none")).toEqual({});
    expect(skillFrontmatter("name: pdf\nname: memo")).toEqual({ name: "pdf", names: 2 });
  });

  it("reads the name key however YAML spells it, and nothing past the closing ---", () => {
    expect(skillMdFrontmatter("---\nname: pdf\n---\n").name).toBe("pdf");
    expect(skillMdFrontmatter("---\nname: \"pdf\"\n---\n").name).toBe("pdf");
    expect(skillMdFrontmatter("---\nname: 'pdf'\n---\n").name).toBe("pdf");
    expect(skillMdFrontmatter("---\ndescription: none\n---\n").name).toBeUndefined();
    expect(skillMdFrontmatter("---\ndescription: none\n---\nname: pdf\n").name).toBeUndefined();
    expect(skillMdFrontmatter("---\nname : pdf\n---\n").name).toBe("pdf");
    expect(skillMdFrontmatter('---\n"name": pdf\n---\n').name).toBe("pdf");
    expect(skillMdFrontmatter("---\n'name': pdf\n---\n").name).toBe("pdf");
    expect(skillMdFrontmatter("---\nname: pdf # the pdf skill\n---\n").name).toBe("pdf");
    expect(skillMdFrontmatter('---\nname: "pdf" # quoted\n---\n').name).toBe("pdf");
    expect(skillMdFrontmatter("---\nname: a#b\n---\n").name).toBe("a#b");
    expect(skillMdFrontmatter("---\nname: 'it''s'\ndescription: \"say \\\"hi\\\"\"\n---\n")).toEqual({ name: "it's", description: 'say "hi"' });
    expect(skillMdFrontmatter("---\nnamed: pdf\n  name: memo\n---\n").name).toBeUndefined();
    expect(skillMdFrontmatter('---\nname: pdf\n"name": memo\n---\n')).toEqual({ name: "pdf", names: 2 });
    expect(skillMdFrontmatter("---\nname: pdf\nname : memo\n---\n")).toEqual({ name: "pdf", names: 2 });
    expect(skillMdFrontmatter('---\nname: pdf\n"name" : memo\n---\n')).toEqual({ name: "pdf", names: 2 });
    expect(skillMdFrontmatter("---\nname: pdf\n'name' : memo\n---\n")).toEqual({ name: "pdf", names: 2 });
    expect(skillMdFrontmatter("---\nname: # c\n---\n")).toEqual({});
  });
});
