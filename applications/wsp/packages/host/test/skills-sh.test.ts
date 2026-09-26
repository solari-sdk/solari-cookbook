// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsSearchEmptyRefusal, type AgentsReport } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { addedLine, removedLine, shownText, skillHitLines, skillRowLines } from "../src/verbs.js";
import { capped, checkSkillFiles, getSkill, searchSkills, skillArchive, skillPreview, type SkillsFetch } from "../src/skills-sh.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A skills.sh that answers from a table by path and keeps every address asked. */
function fake(answers: Record<string, { status?: number; body: unknown }>): { fetch: SkillsFetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: SkillsFetch = async url => {
    asked.push(url);
    const hit = answers[new URL(url).pathname + new URL(url).search] ?? answers[new URL(url).pathname];
    if (hit === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body), { status: hit.status ?? 200 });
  };
  return { fetch, asked };
}

const SKILL_MD = "---\nname: pdf\ndescription: Read and fill PDF forms\n---\n# pdf\n\nUse it.\n";
const pdf = { files: [{ path: "SKILL.md", contents: SKILL_MD }, { path: "scripts/fill.py", contents: "print('x')\n" }, { path: "reference.md", contents: "ref\n" }], hash: "h" };

describe("skills.sh, asked by this host alone", () => {
  it("searches by the query and limit it is given, and never sends an empty query", async () => {
    const hit = { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 200826 };
    const { fetch, asked } = fake({ "/api/search?q=pdf+forms&limit=20": { body: { query: "pdf forms", skills: [hit], count: 1 } } });
    expect(await searchSkills(fetch, " pdf forms ", 20)).toEqual([hit]);
    expect(asked).toEqual(["https://skills.sh/api/search?q=pdf+forms&limit=20"]);
    await expect(searchSkills(fetch, "   ", 20)).rejects.toThrow(skillsSearchEmptyRefusal);
    expect(asked).toHaveLength(1);
  });

  it("says in a sentence when skills.sh refuses, is not found or answers a shape it does not read", async () => {
    const { fetch } = fake({ "/api/search": { status: 500, body: "oops" }, "/api/download/a/b/c": { body: { nope: true } } });
    await expect(searchSkills(fetch, "x", 5)).rejects.toThrow("skills.sh answered 500.");
    await expect(getSkill(fetch, "a/b/missing")).rejects.toThrow("skills.sh has no skill a/b/missing.");
    await expect(getSkill(fetch, "a/b/c")).rejects.toThrow("skills.sh answered something this wsp does not read.");
    const down: SkillsFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND skills.sh");
    };
    await expect(searchSkills(down, "x", 5)).rejects.toThrow("skills.sh did not answer: getaddrinfo ENOTFOUND skills.sh");
  });

  it("stops reading an answer the moment it runs past its cap, whatever length it claims", async () => {
    let pulled = 0;
    const endless: SkillsFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: c => {
            pulled += 1;
            c.enqueue(new Uint8Array(64 * 1024).fill(32));
          },
        }),
      );
    await expect(searchSkills(endless, "x", 5)).rejects.toThrow("skills.sh answered over 1 MB, which is not read.");
    expect(pulled).toBeLessThan(40);
    const claims: SkillsFetch = async () => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } });
    await expect(getSkill(claims, "a/b/c")).rejects.toThrow("skills.sh answered over 12 MB, which is not read.");
    await expect(capped(new Response(new Uint8Array(64 * 1024 + 1)), 64 * 1024, "Google")).rejects.toThrow("Google answered over 64 KB, which is not read.");
  });

  it("reads a skill by its owner, repo and name, and refuses an id of any other shape before asking", async () => {
    const { fetch, asked } = fake({ "/api/download/anthropics/skills/pdf": { body: pdf } });
    const got = await getSkill(fetch, "anthropics/skills/pdf");
    expect(got.name).toBe("pdf");
    expect(got.files.map(f => f.path).sort()).toEqual(["SKILL.md", "reference.md", "scripts/fill.py"]);
    for (const bad of ["anthropics/skills", "a/b/c/d", "../b/c", "a/../c", "a/b/..", "a/b/Pdf Forms", "a/b/-x", "a/b/c%2F..", "a b/c/d"]) {
      await expect(getSkill(fetch, bad), bad).rejects.toThrow(`${bad} is not a skill skills.sh names; it reads <owner>/<repo>/<skill>.`);
    }
    expect(asked).toEqual(["https://skills.sh/api/download/anthropics/skills/pdf"]);
  });

  it("follows a redirect that stays on skills.sh and refuses one to another host without asking it", async () => {
    const hits: string[] = [];
    const listen = (handle: (url: string) => { status: number; location?: string; body?: string }): Promise<{ server: Server; origin: string }> =>
      new Promise(resolve => {
        const server = createServer((req, res) => {
          hits.push(`${req.headers.host}${req.url}`);
          const a = handle(req.url ?? "");
          res.writeHead(a.status, a.location === undefined ? {} : { location: a.location });
          res.end(a.body ?? "");
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
      });
    const other = await listen(() => ({ status: 200, body: JSON.stringify({ skills: [] }) }));
    const stand = await listen(url =>
      url.startsWith("/api/search?q=same") ? { status: 302, location: "/api/answer" } : url.startsWith("/api/answer") ? { status: 200, body: JSON.stringify({ skills: [] }) } : { status: 302, location: `${other.origin}/api/search?q=x` },
    );
    try {
      // skills.sh's own address points at the stand-in, the options the host passes kept as they are.
      const fetch: SkillsFetch = (url, init) => globalThis.fetch(url.replace("https://skills.sh", stand.origin), init);
      expect(await searchSkills(fetch, "same", 5)).toEqual([]);
      await expect(searchSkills(fetch, "away", 5)).rejects.toThrow(`skills.sh sent the ask on to ${other.origin}/api/search?q=x, which is not skills.sh, so it was not followed.`);
      expect(hits.some(h => h.startsWith(new URL(other.origin).host))).toBe(false);
    } finally {
      stand.server.close();
      other.server.close();
    }
  });

  it("previews the first 64 KB of the SKILL.md and says the whole size", () => {
    expect(skillPreview(new TextEncoder().encode(SKILL_MD))).toEqual({ text: SKILL_MD, size: SKILL_MD.length });
    const long = "é".repeat(40_000);
    const shown = skillPreview(new TextEncoder().encode(long));
    expect(shown.size).toBe(80_000);
    expect(new TextEncoder().encode(shown.text).length).toBeLessThanOrEqual(64 * 1024);
    // Cut on a whole character, never half of one.
    expect(shown.text).not.toContain("\ufffd");
  });
});

describe("the install path rule", () => {
  const good = [{ path: "SKILL.md", contents: SKILL_MD }];
  const refused = (files: { path: unknown; contents: unknown }[], name = "pdf"): string => {
    try {
      checkSkillFiles(name, files);
    } catch (e) {
      return (e as Error).message;
    }
    return "accepted";
  };

  it("refuses the whole skill on the first path that could land outside its folder", () => {
    for (const path of ["../x", "/etc/x", "a/../../x", "C:\\x", "c:/x", "a\\b", "a//b", "./x", "a/./b", "a/", ""]) {
      expect(refused([...good, { path, contents: "x" }]), JSON.stringify(path)).toBe(`pdf was not installed: the download names ${JSON.stringify(path)}, which is not a plain path inside the skill.`);
    }
    expect(refused([...good, { path: "a\0b", contents: "x" }])).toMatch(/not a plain path inside the skill/);
    expect(refused([...good, { path: "a\nb", contents: "x" }])).toMatch(/not a plain path inside the skill/);
    expect(refused([...good, { path: `${"a".repeat(256)}/b`, contents: "x" }])).toMatch(/not a plain path inside the skill/);
  });

  it("refuses a folder or file a version control tool reads its config from, in any case", () => {
    for (const path of [".git/config", ".GIT/config", "docs/.Git/HEAD", ".hg/hgrc", "a/.HG/hgrc", ".svn/entries", ".bzr/branch.conf", ".jj/repo", ".gitmodules", "sub/.GitModules", ".g\u200cit/config"]) {
      expect(refused([...good, { path, contents: "[core]\n\tfsmonitor = touch x\n" }]), JSON.stringify(path)).toBe(`pdf was not installed: the download names ${JSON.stringify(path)}, which a version control tool reads its config from.`);
    }
    expect(refused([...good, { path: ".github/workflows/ci.yml", contents: "x" }, { path: ".gitignore", contents: "x" }])).toBe("accepted");
    for (const path of ["_darcs/prefs/defaults", ".pijul/config", ".SL/config", "a/.Pijul/x"]) {
      expect(refused([...good, { path, contents: "x" }]), path).toBe(`pdf was not installed: the download names ${JSON.stringify(path)}, which a version control tool reads its config from.`);
    }
  });

  it("refuses a folder laid out as a git folder under any name, in any case: HEAD with objects and refs, or with commondir", () => {
    const repo = (at: string, head: string, rest: string[]) => [
      { path: `${at}${head}`, contents: "ref: refs/heads/main\n" },
      { path: `${at}config`, contents: "[core]\n\tbare = false\n\tworktree = .\n\tfsmonitor = touch x\n" },
      ...rest.map(r => ({ path: `${at}${r}`, contents: "x" })),
    ];
    for (const [at, head, rest] of [
      ["", "HEAD", ["objects/info/x", "refs/heads/x"]],
      ["sub/", "HEAD", ["objects/info/x", "refs/heads/x"]],
      ["sub/", "head", ["Objects/info/x", "REFS/heads/x"]],
      ["", "HEAD", ["commondir"]],
      ["a/b/", "Head", ["CommonDir"]],
    ] as const) {
      const where = at === "" ? "the skill's own folder" : at.slice(0, -1);
      expect(refused([...good, ...repo(at, head, [...rest])]), `${at}${head}`).toBe(`pdf was not installed: ${where} is laid out as a git folder, whose config git runs commands from.`);
    }
    expect(refused([...good, { path: "HEAD", contents: "x" }, { path: "refs/x", contents: "x" }])).toBe("accepted");
    expect(refused([...good, { path: "a/HEAD", contents: "x" }, { path: "objects/x", contents: "x" }, { path: "refs/x", contents: "x" }])).toBe("accepted");
  });

  it("refuses a SKILL.md whose name is not the folder's, and the name wsp keeps for its own skill", () => {
    expect(refused([{ path: "SKILL.md", contents: "---\nname: memo\n---\n" }])).toBe("pdf was not installed: its SKILL.md names it memo, not pdf.");
    expect(refused([{ path: "SKILL.md", contents: "# no frontmatter\n" }])).toBe("pdf was not installed: its SKILL.md names no name, where it must say pdf.");
    expect(refused([{ path: "SKILL.md", contents: "---\nname: pdf\nname: memo\n---\n" }])).toBe("pdf was not installed: its SKILL.md has more than one name line, which agents read apart.");
    expect(refused([{ path: "SKILL.md", contents: "---\nname: memo\nname: pdf\n---\n" }])).toBe("pdf was not installed: its SKILL.md has more than one name line, which agents read apart.");
    for (const name of ["wsp", "wsp-machine"]) expect(refused([{ path: "SKILL.md", contents: `---\nname: ${name}\n---\n` }], name), name).toBe(`${name} is the name of the skill wsp writes, so nothing was installed.`);
  });

  it("refuses a skill name that is not a plain name", () => {
    for (const name of ["..", ".", "Pdf", "a b", "-x", "a/b", "a".repeat(65)]) expect(refused(good, name), name).toBe(`${name} is not a plain skill name, so nothing was installed.`);
  });

  it("caps the count, each file and the whole, and needs a SKILL.md at the root", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.md`, contents: "x" }));
    expect(refused([...good, ...many])).toBe("pdf was not installed: it has 201 files, over the 200 a skill may have.");
    expect(refused([...good, { path: "big.bin", contents: "x".repeat(1024 * 1024 + 1) }])).toBe("pdf was not installed: big.bin is over 1 MB.");
    const six = Array.from({ length: 6 }, (_, i) => ({ path: `p${i}.md`, contents: "x".repeat(1024 * 1024) }));
    expect(refused([...good, ...six])).toBe("pdf was not installed: it is over 5 MB in all.");
    expect(refused([{ path: "docs/SKILL.md", contents: "x" }])).toBe("pdf was not installed: it has no SKILL.md at its root.");
    expect(refused([...good, { path: "SKILL.md", contents: "again" }])).toBe("pdf was not installed: the download names SKILL.md twice.");
    expect(refused([...good, { path: "a", contents: "x" }, { path: "a/b", contents: "y" }])).toBe("pdf was not installed: the download names a as a file and as a folder.");
    expect(refused([...good, { path: "x", contents: 7 }])).toBe("skills.sh answered something this wsp does not read.");
  });

  it("builds an archive of regular files at 0644 in folders at 0755, which tar unpacks with no executable bit", () => {
    const files = checkSkillFiles("pdf", [...good, { path: "scripts/fill.py", contents: "#!/usr/bin/env python3\nprint(1)\n" }]);
    const root = mkdtempSync(join(tmpdir(), "wsp-skill-tar-"));
    roots.push(root);
    const tgz = join(root, "skill.tgz");
    writeFileSync(tgz, skillArchive(files));
    execFileSync("/bin/bash", ["-c", `umask 022; mkdir out && tar --no-same-owner -xzf ${tgz} -C out`], { cwd: root });
    for (const f of ["SKILL.md", "scripts/fill.py"]) expect(statSync(join(root, "out", f)).mode & 0o777, f).toBe(0o644);
    expect(statSync(join(root, "out", "scripts")).mode & 0o777).toBe(0o755);
    const listed = execFileSync("tar", ["-tvzf", tgz]).toString();
    expect(listed).not.toMatch(/^l/m);
  });
});

describe("what a skills verb prints of skills.sh's text", () => {
  it("drops control characters and escape sequences, keeping newlines and tabs", () => {
    const hostile = "# pdf\n\tUse it.\x1b]52;c;cm0gLXJmIH4=\x07\x1b]0;title\x07\x1b]8;;https://evil.test\x1b\\click\x1b]8;;\x1b\\\r\x9b2J\x00end";
    const text = shownText({ text: hostile, size: hostile.length });
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(text.startsWith("# pdf\n\tUse it.")).toBe(true);
    expect(text.endsWith("end")).toBe(true);
    const lines = skillHitLines([{ id: "a/b/c\x1b[2J", source: "a/b", skillId: "c", name: "c\x1b]0;x\x07", installs: 1 }]).join("\n");
    expect(lines).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it("prints a folder name and a link target in the skills table without their escapes or line breaks", () => {
    const report: AgentsReport = {
      target: { placeId: "local" },
      home: "/home/me",
      user: "me",
      readAt: new Date(0).toISOString(),
      refused: ["box\x1b]0;x\x07: /home/me/.claude\x9b2J could not be read"],
      agents: [],
      servers: [],
      skills: [
        { name: "pdf\x1b]0;owned\x07\x1b[2J", scope: "user" as const, paths: [{ path: "~/.claude/skills/pdf\x1b[31m\nfake  user  ~/x", linkTo: "/opt/s\x1b]52;c;cm0gLXJmIH4=\x07\r\x9b2J" }] },
        { name: "lint", scope: "project" as const, project: { id: "p1", name: "web\x1b[2J\tapp", path: "~/web" }, paths: [{ path: "~/web/.claude/skills/lint" }] },
      ],
    };
    const lines = skillRowLines(report);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(lines[1]).toContain("pdf]0;owned[2J");
    expect(lines[1]).toContain("pdf[31m fake  user  ~/x");
    expect(lines[2]).toContain("project web[2J app");
    expect(lines[3]).toContain("refused: box]0;x: /home/me/.claude2J could not be read");
  });

  it("prints the folders skills add and skills remove answer without their escapes or line breaks", () => {
    const added = addedLine("a/b/pdf", { path: "~/.agents/skills/pdf\x1b]0;x\x07", agents: [{ agent: "claude", path: "~/.claude/skills/pdf\x9b2J\nfake" }] });
    const removed = removedLine("pdf\x1b[2J", ["~/.claude/skills/pdf\x1b]52;c;eA==\x07", "~/.agents/skills/pdf\r\n"]);
    for (const line of [added, removed]) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(added).toContain("~/.claude/skills/pdf2J fake");
  });
});
