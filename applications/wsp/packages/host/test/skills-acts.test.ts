// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectSkills, nodeHost, skillRoots, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { noSuchSkillRefusal, pluginSkillRefusal, projectSkillOffRefusal, systemSkillRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, type AgentHome } from "../../collect/test/agent-home.js";
import type { SkillsFetch } from "../src/skills-sh.js";
import { skillsActs } from "../src/skills-acts.js";
import { runHere } from "../src/target-road.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): AgentHome & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-skills-acts-"));
  roots.push(root);
  const at = agentHome(root);
  writeFileSync(join(at.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  chmodSync(join(at.bin, "runuser"), 0o755);
  return { ...at, root };
}

function here(at: AgentHome): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home, ...o?.env } }) } };
}

/** A computer's road that runs every line in bash with the fixture's home and PATH, stdin included, keeping each
 * line; a root daemon's probe is answered as a Linux box running as root whose home ada owns. `bytes` lands a file
 * where a workspace's machine would, for the road that has no stdin. */
function road(at: AgentHome, o: { root?: boolean; bytes?: boolean; dropStdin?: boolean } = {}): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[]; outs: string[] } {
  const lines: string[] = [];
  const outs: string[] = [];
  const env = { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home };
  const machine = {
    id: "m_road",
    uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
    putBytes: async (path: string, bytes: Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
    exec: (cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult> => {
      lines.push(cmd);
      if (o.bytes === true && opts?.stdin !== undefined) return Promise.reject(new Error("this road carries no stdin"));
      if (o.root === true && cmd.startsWith("uname -s;")) return Promise.resolve({ exitCode: 0, stdout: ["Linux", "0", "root", "ada", "1", "/root", "/usr/bin:/bin", ""].join("\n"), stderr: "" });
      return new Promise(resolve => {
        const child = execFile("/bin/bash", ["-c", cmd], { env, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (e, stdout, stderr) => {
          outs.push(String(stdout));
          resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout: String(stdout), stderr: String(stderr) });
        });
        child.stdin?.end(opts?.stdin === undefined || o.dropStdin === true ? undefined : Buffer.from(opts.stdin));
      });
    },
  };
  return { machine, lines, outs };
}

const MARK = "RAN";
const SKILL_MD = "---\nname: memo\ndescription: Keep notes\n---\n# memo\n\nWrite it down.\n";
function skillsSh(at: AgentHome, skillMd = SKILL_MD): { fetch: SkillsFetch; asked: string[] } {
  const asked: string[] = [];
  const files = [
    { path: "SKILL.md", contents: skillMd },
    // A script that would leave a mark if anything ran it.
    { path: "scripts/setup.sh", contents: `#!/bin/sh\ntouch ${join(at.home, MARK)}\n` },
  ];
  const fetch: SkillsFetch = async url => {
    asked.push(url);
    const path = new URL(url).pathname;
    if (path === "/api/download/acme/skills/memo") return new Response(JSON.stringify({ files, hash: "h" }));
    if (path === "/api/download/acme/skills/wsp") return new Response(JSON.stringify({ files: [{ path: "SKILL.md", contents: "---\nname: wsp\n---\n" }], hash: "h" }));
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
  return { fetch, asked };
}

const skillsOf = async (host: Host, project?: string) => (await detectSkills(host, await skillRoots(host, project === undefined ? {} : { projects: [{ id: "pr_app", name: "app", path: project }] }))).skills;
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("installing a skill off skills.sh", () => {
  it("lands it once in the shared folder at 0644, links it for an agent that links and copies it for one that copies, and runs nothing", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const added = await acts.add({ kind: "here" }, { skill: "acme/skills/memo", agents: ["claude", "gemini", "codex"] });
    expect(added).toEqual({ path: "~/.agents/skills/memo", agents: [{ agent: "claude", path: "~/.claude/skills/memo" }, { agent: "gemini", path: "~/.gemini/skills/memo" }] });
    const shared = join(at.home, ".agents/skills/memo");
    expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(mode(join(shared, "SKILL.md"))).toBe(0o644);
    expect(mode(join(shared, "scripts/setup.sh"))).toBe(0o644);
    expect(mode(join(shared, "scripts"))).toBe(0o755);
    expect(readlinkSync(join(at.home, ".claude/skills/memo"))).toBe("../../.agents/skills/memo");
    expect(lstatSync(join(at.home, ".gemini/skills/memo")).isSymbolicLink()).toBe(false);
    expect(mode(join(at.home, ".gemini/skills/memo/scripts/setup.sh"))).toBe(0o644);
    expect(existsSync(join(at.home, MARK))).toBe(false);
    // Codex reads the shared folder, so the reader finds the one skill in every folder that holds it.
    const memo = (await skillsOf(here(at))).find(s => s.name === "memo")!;
    expect(memo.paths.map(p => p.path).sort()).toEqual(["~/.agents/skills/memo", "~/.claude/skills/memo", "~/.gemini/skills/memo"]);
  });

  it("refuses a skill already there and writes nothing over it", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    await acts.add({ kind: "here" }, { skill: "acme/skills/memo", agents: [] });
    writeFileSync(join(at.home, ".agents/skills/memo/SKILL.md"), "mine\n");
    await expect(acts.add({ kind: "here" }, { skill: "acme/skills/memo", agents: [] })).rejects.toThrow("memo is already at ~/.agents/skills/memo, so nothing was installed.");
    expect(readFileSync(join(at.home, ".agents/skills/memo/SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("with no agents named links it for each agent whose own folder's home is there", async () => {
    const at = fixture();
    rmSync(join(at.home, ".gemini"), { recursive: true, force: true });
    const added = await skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here" }, { skill: "acme/skills/memo" });
    expect(added.agents.map(a => a.agent)).toEqual(["claude", "hermes"]);
    expect(existsSync(join(at.home, ".gemini"))).toBe(false);
  });

  it("puts a project's skill in the project's folders, from a workspace", async () => {
    const at = fixture();
    const added = await skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { skill: "acme/skills/memo", agents: ["claude"], project: true });
    expect(added).toEqual({ path: "~/code/app/.agents/skills/memo", agents: [{ agent: "claude", path: "~/code/app/.claude/skills/memo" }] });
    expect(readlinkSync(join(at.project, ".claude/skills/memo"))).toBe("../../.agents/skills/memo");
    await expect(skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here" }, { skill: "acme/skills/memo", project: true })).rejects.toThrow("A project's skill goes in from a workspace of that project, or from its computer's page.");
  });

  it("refuses a download whose SKILL.md names another skill, or one that claims the name wsp keeps", async () => {
    const at = fixture();
    await expect(skillsActs({ fetch: skillsSh(at, "---\nname: pdf\n---\n").fetch, here: () => here(at) }).add({ kind: "here" }, { skill: "acme/skills/memo" })).rejects.toThrow("memo was not installed: its SKILL.md names it pdf, not memo.");
    await expect(skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here" }, { skill: "acme/skills/wsp" })).rejects.toThrow("wsp is the name of the skill wsp writes, so nothing was installed.");
    expect(existsSync(join(at.home, ".agents/skills/memo"))).toBe(false);
    expect(existsSync(join(at.home, ".agents/skills/wsp"))).toBe(false);
  });

  it("refuses a project install when the project's skills folder is a link out of it, and writes nothing through it", async () => {
    const at = fixture();
    const away = join(at.root, "away");
    mkdirSync(away, { recursive: true });
    rmSync(join(at.project, ".agents/skills"), { recursive: true, force: true });
    symlinkSync(away, join(at.project, ".agents/skills"));
    await expect(skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { skill: "acme/skills/memo", agents: ["claude"], project: true })).rejects.toThrow(
      `memo was not installed: ~/code/app/.agents/skills is a link to ${away}, out of the project.`,
    );
    expect(existsSync(join(away, "memo"))).toBe(false);
    expect(lstatSync(join(at.project, ".claude/skills/memo"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("on a box whose daemon is root, every write runs as the owner of the home through runuser", async () => {
    const at = fixture();
    const { machine, lines } = road(at, { root: true });
    await skillsActs({ fetch: skillsSh(at).fetch }).add({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` } }, { skill: "acme/skills/memo", agents: ["claude"] });
    expect(existsSync(join(at.home, ".agents/skills/memo/SKILL.md"))).toBe(true);
    const writes = lines.filter(l => l.includes("tar "));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^runuser -u 'ada' -- bash -c /);
  });

  it("an archive that never arrived lands nothing and leaves no half a skill behind", async () => {
    const at = fixture();
    const { machine } = road(at, { dropStdin: true });
    await expect(skillsActs({ fetch: skillsSh(at).fetch }).add({ kind: "box", machine, login: { HOME: at.home } }, { skill: "acme/skills/memo", agents: ["claude"] })).rejects.toThrow(/^memo was not installed: /);
    expect(existsSync(join(at.home, ".agents/skills/memo"))).toBe(false);
    expect(lstatSync(join(at.home, ".claude/skills/memo"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("on a workspace's machine, which takes no stdin, the archive is staged by its byte road first", async () => {
    const at = fixture();
    const { machine, lines } = road(at, { bytes: true });
    await skillsActs({ fetch: skillsSh(at).fetch }).add({ kind: "machine", machine }, { skill: "acme/skills/memo", agents: [] });
    expect(mode(join(at.home, ".agents/skills/memo/SKILL.md"))).toBe(0o644);
    expect(lines.some(l => l.includes("/tmp/wsp-land-"))).toBe(true);
    expect(lines.filter(l => l.startsWith("rm -rf -- '/tmp/wsp-land-"))).toHaveLength(1);
  });
});

describe("a skill's SKILL.md, turning it off and on, and removing it", () => {
  it("previews an installed skill's SKILL.md and a skills.sh skill's before install, the first 64 KB with the size", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const pdf = await acts.preview({ kind: "here" }, { name: "pdf" });
    expect(pdf.text).toContain("name: pdf");
    // The folder the row shows as the skill's own, the first that is no link.
    expect(pdf.size).toBe(readFileSync(join(at.home, ".codex/skills/pdf/SKILL.md")).length);
    expect(await acts.get("acme/skills/memo")).toEqual({ text: SKILL_MD, size: SKILL_MD.length });
    await expect(acts.preview({ kind: "here" }, { name: "nope" })).rejects.toThrow("There is no skill named nope there.");
  });

  it("turns a user skill off by renaming its SKILL.md where it really lives, and on again", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const off = await acts.toggle({ kind: "here" }, { name: "pdf", on: false });
    expect(off.paths.sort()).toEqual(["~/.agents/skills/pdf", "~/.codex/skills/pdf"]);
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md.off"))).toBe(true);
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md"))).toBe(false);
    const pdf = (await skillsOf(here(at))).find(s => s.name === "pdf")!;
    expect(pdf.paths.every(p => p.off === true)).toBe(true);
    // Its preview still reads, off.
    expect((await acts.preview({ kind: "here" }, { name: "pdf" })).text).toContain("name: pdf");
    await acts.toggle({ kind: "here" }, { name: "pdf", on: true });
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md"))).toBe(true);
    expect((await skillsOf(here(at))).find(s => s.name === "pdf")!.paths.some(p => p.off === true)).toBe(false);
  });

  it("holds the skill wsp writes and a plugin's always on, and a project's skill from turning off", async () => {
    const at = fixture();
    mkdirSync(join(at.home, ".claude/skills/wsp"), { recursive: true });
    writeFileSync(join(at.home, ".claude/skills/wsp/SKILL.md"), "---\nname: wsp\n---\n");
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    await expect(acts.toggle({ kind: "here" }, { name: "wsp", on: false })).rejects.toThrow(systemSkillRefusal("wsp"));
    await expect(acts.remove({ kind: "here" }, { name: "wsp" })).rejects.toThrow(systemSkillRefusal("wsp"));
    await expect(acts.toggle({ kind: "here" }, { name: "frontend-design", on: false })).rejects.toThrow(pluginSkillRefusal("frontend-design"));
    await expect(acts.remove({ kind: "here" }, { name: "frontend-design" })).rejects.toThrow(pluginSkillRefusal("frontend-design"));
    await expect(acts.toggle({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "deploy", project: true, on: false })).rejects.toThrow(projectSkillOffRefusal("deploy", "~/code/app/.claude/skills/deploy"));
    expect(existsSync(join(at.home, ".claude/skills/wsp/SKILL.md"))).toBe(true);
    expect(existsSync(join(at.project, ".claude/skills/deploy/SKILL.md"))).toBe(true);
  });

  it("removes every folder of a skill and every link to it, and leaves a folder a link points to outside the skill folders", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const removed = await acts.remove({ kind: "here" }, { name: "pdf" });
    expect(removed.removed.sort()).toEqual(["~/.agents/skills/pdf", "~/.claude/skills/pdf", "~/.codex/skills/pdf", "~/.pi/agent/skills/pdf"]);
    for (const p of [".agents/skills/pdf", ".claude/skills/pdf", ".codex/skills/pdf", ".pi/agent/skills/pdf"]) expect(lstatSync(join(at.home, p), { throwIfNoEntry: false }), p).toBeUndefined();
    // A skill the person keeps in their own checkout, linked in: the link goes, the checkout stays.
    const own = join(at.home, "dev/notes-skill");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: notes\n---\n");
    symlinkSync(own, join(at.home, ".claude/skills/notes"));
    expect((await acts.remove({ kind: "here" }, { name: "notes" })).removed).toEqual(["~/.claude/skills/notes"]);
    expect(existsSync(join(own, "SKILL.md"))).toBe(true);
  });

  it("holds a skill under a linked folder between its skills folder and itself: Remove and Turn off refuse it and touch nothing", async () => {
    const at = fixture();
    const checkout = join(at.root, "checkout");
    mkdirSync(join(checkout, "mine"), { recursive: true });
    writeFileSync(join(checkout, "mine/SKILL.md"), "---\nname: mine\n---\n");
    writeFileSync(join(checkout, "work.txt"), "mine\n");
    symlinkSync(checkout, join(at.home, ".claude/skills/category"));
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const held = `mine sits under ~/.claude/skills/category, a link to ${checkout}, so its files belong to that checkout and wsp leaves them as they are.`;
    await expect(acts.remove({ kind: "here" }, { name: "mine" })).rejects.toThrow(held);
    await expect(acts.toggle({ kind: "here" }, { name: "mine", on: false })).rejects.toThrow(held);
    expect(readFileSync(join(checkout, "mine/SKILL.md"), "utf8")).toContain("name: mine");
    expect(existsSync(join(checkout, "work.txt"))).toBe(true);
  });

  it("acts on a skill whose skills folder is itself a link, or sits under one, as the person's own", async () => {
    for (const linked of [".claude", ".claude/skills"]) {
      const at = fixture();
      const dots = join(at.root, "dotfiles", linked);
      mkdirSync(dirname(dots), { recursive: true });
      renameSync(join(at.home, linked), dots);
      symlinkSync(dots, join(at.home, linked));
      const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
      const review = join(at.root, "dotfiles/.claude/skills/review");
      expect((await acts.toggle({ kind: "here" }, { name: "review", on: false })).paths, linked).toEqual(["~/.claude/skills/review"]);
      expect(existsSync(join(review, "SKILL.md.off")), linked).toBe(true);
      expect((await acts.remove({ kind: "here" }, { name: "review" })).removed, linked).toEqual(["~/.claude/skills/review"]);
      expect(existsSync(review), linked).toBe(false);
      expect(lstatSync(join(at.home, linked)).isSymbolicLink(), linked).toBe(true);
    }
  });

  it("skips a project's skills folder that is a link, or sits under one inside the project: not listed, not removed, not previewed", async () => {
    const at = fixture();
    rmSync(join(at.project, ".agents/skills"), { recursive: true, force: true });
    symlinkSync("../../../.claude/skills", join(at.project, ".agents/skills"));
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const project = (await skillsOf(here(at), at.project)).filter(s => s.scope === "project");
    expect(project.map(s => s.name)).toEqual(["deploy"]);
    await expect(acts.remove({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "review", project: true })).rejects.toThrow(noSuchSkillRefusal("review"));
    await expect(acts.toggle({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "review", project: true, on: false })).rejects.toThrow(noSuchSkillRefusal("review"));
    await expect(acts.preview({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "review", project: true })).rejects.toThrow(noSuchSkillRefusal("review"));
    expect(existsSync(join(at.home, ".claude/skills/review/SKILL.md"))).toBe(true);

    rmSync(join(at.project, ".agents/skills"));
    symlinkSync("../../..", join(at.project, ".agents/skills"));
    writeFileSync(join(at.home, ".fake-secret"), "sk-ant-x-not-a-key\n");
    symlinkSync("../../.fake-secret", join(at.project, "SKILL.md"));
    expect((await skillsOf(here(at), at.project)).filter(s => s.scope === "project").map(s => s.name)).toEqual(["deploy"]);
    await expect(acts.preview({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "app", project: true })).rejects.toThrow(noSuchSkillRefusal("app"));
    await expect(acts.remove({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "app", project: true })).rejects.toThrow(noSuchSkillRefusal("app"));
    expect(existsSync(at.project)).toBe(true);

    rmSync(join(at.project, ".agents/skills"));
    renameSync(join(at.project, ".claude"), join(at.root, "claude-dir"));
    symlinkSync(join(at.root, "claude-dir"), join(at.project, ".claude"));
    expect((await skillsOf(here(at), at.project)).filter(s => s.scope === "project")).toEqual([]);
    await expect(acts.remove({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { name: "deploy", project: true })).rejects.toThrow(noSuchSkillRefusal("deploy"));
    expect(existsSync(join(at.root, "claude-dir/skills/deploy/SKILL.md"))).toBe(true);
  });

  it("groups by folder name, so a SKILL.md naming another skill or wsp neither joins nor hides behind that row", async () => {
    const at = fixture();
    for (const [dir, name] of [["cool-tool", "pdf"], ["imposter", "wsp"]] as const) {
      mkdirSync(join(at.home, ".agents/skills", dir), { recursive: true });
      writeFileSync(join(at.home, ".agents/skills", dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    expect((await acts.remove({ kind: "here" }, { name: "cool-tool" })).removed).toEqual(["~/.agents/skills/cool-tool"]);
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md"))).toBe(true);
    expect((await acts.remove({ kind: "here" }, { name: "imposter" })).removed).toEqual(["~/.agents/skills/imposter"]);
  });

  it("refuses to preview a SKILL.md that is a link out of the skills folders, and reads a big one only to its cap", async () => {
    const at = fixture();
    const secret = join(at.root, "secret.txt");
    writeFileSync(secret, "sk-ant-x-not-a-key\n");
    mkdirSync(join(at.home, ".claude/skills/leak"), { recursive: true });
    symlinkSync(secret, join(at.home, ".claude/skills/leak/SKILL.md"));
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    await expect(acts.preview({ kind: "here" }, { name: "leak" })).rejects.toThrow("The SKILL.md of leak at ~/.claude/skills/leak is a link out of the skills folders, so it is not read.");
    // A link that stays inside the skills folders reads.
    rmSync(join(at.home, ".claude/skills/leak/SKILL.md"));
    symlinkSync(join(at.home, ".agents/skills/pdf/SKILL.md"), join(at.home, ".claude/skills/leak/SKILL.md"));
    expect((await acts.preview({ kind: "here" }, { name: "leak" })).text).toContain("name: pdf");
    const big = `---\nname: big\n---\n${"x".repeat(3 * 1024 * 1024)}`;
    mkdirSync(join(at.home, ".agents/skills/big"), { recursive: true });
    writeFileSync(join(at.home, ".agents/skills/big/SKILL.md"), big);
    const { machine, outs } = road(at);
    const shown = await acts.preview({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` } }, { name: "big" });
    expect(shown.size).toBe(big.length);
    expect(shown.text.length).toBe(64 * 1024);
    expect(Math.max(...outs.map(o => o.length))).toBeLessThanOrEqual(2 * 1024 * 1024 + 64);
  });

  it("refuses to turn off a skill when nothing was renamed: a link alone, or a folder already holding SKILL.md.off", async () => {
    const at = fixture();
    const own = join(at.home, "dev/notes-skill");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: notes\n---\n");
    symlinkSync(own, join(at.home, ".claude/skills/notes"));
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    await expect(acts.toggle({ kind: "here" }, { name: "notes", on: false })).rejects.toThrow("notes is a link to ~/dev/notes-skill at ~/.claude/skills/notes, whose files wsp does not change, so nothing was turned off.");
    expect(existsSync(join(own, "SKILL.md"))).toBe(true);
    mkdirSync(join(at.home, ".agents/skills/both"), { recursive: true });
    writeFileSync(join(at.home, ".agents/skills/both/SKILL.md"), "---\nname: both\n---\n");
    writeFileSync(join(at.home, ".agents/skills/both/SKILL.md.off"), "old\n");
    await expect(acts.toggle({ kind: "here" }, { name: "both", on: false })).rejects.toThrow("both was not turned off: ~/.agents/skills/both already holds a SKILL.md.off, so nothing was renamed.");
    expect(readFileSync(join(at.home, ".agents/skills/both/SKILL.md.off"), "utf8")).toBe("old\n");
  });
});

describe("a line on this computer", () => {
  it("that runs past its time is killed with every process it started", async () => {
    const at = fixture();
    const pidFile = join(at.root, "pid");
    const started = Date.now();
    const res = await runHere(at.home, `sleep 30 & echo $! > ${pidFile}; wait`, undefined, 300);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.exitCode).not.toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await new Promise(r => setTimeout(r, 100));
    const left = alive();
    if (left) process.kill(pid, "SIGKILL");
    expect(left).toBe(false);
  });
});
