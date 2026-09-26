// SPDX-License-Identifier: AGPL-3.0-only
// The bundle's trip home against fake homes on this computer and archives shaped like the ones a machine packs:
// the folder lands beside its destination and moves in one rename, the agents' state is keyed to it here.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { guestAgentHomes, tarOf, type TarEntry } from "@wsp/engine";
import { stateEntryRefusal, storeUnreadLine } from "@wsp/protocol";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { projectLander } from "../src/project-export.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// The lander's scratch home goes under the OS temp directory, which every process here shares; this file lists its own.
const TEMP = mkdtempSync(join(tmpdir(), "wsp-export-test-"));
process.env["TMPDIR"] = TEMP;
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wsp-export-"));
  dirs.push(d);
  return d;
};
/** An archive as it reaches the lander: a file on this computer, the way the runtime streams it off the machine. */
const archived = (tar: Buffer): string => {
  const file = join(scratch(), "archive.tgz");
  writeFileSync(file, tar);
  return file;
};
const put = (root: string, rel: string, text: string | Buffer): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** Every regular file under dir by relative path with its text; sqlite files by their thread rows. */
const snapshot = (dir: string): Record<string, unknown> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const abs = join(e.parentPath, e.name);
        return [relative(dir, abs), e.name.endsWith(".sqlite") || e.name.endsWith(".db") ? rows(abs) : readFileSync(abs, "utf8")];
      }),
  );
function rows(db: string): unknown[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const table = (d.prepare("select name from sqlite_master where type = 'table' order by name").get() as { name: string }).name;
    return d.prepare(`select * from "${table}" order by 1`).all().map(r => ({ ...r }));
  } finally {
    d.close();
  }
}
const CODEX_SCHEMA = "create table threads (id text primary key, rollout_path text not null, cwd text not null, archived integer not null default 0, updated_at integer not null default 0)";
function sqlite(schema: string, inserts: readonly [string, readonly (string | number)[]][]): Buffer {
  const file = join(scratch(), "db.sqlite");
  const d = new DatabaseSync(file);
  try {
    d.exec(schema);
    for (const [sql, params] of inserts) d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
  return readFileSync(file);
}

const SOURCE = "/root/work/proj";
const claudeKey = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");
const session = (id: string, cwd: string): string => `{"type":"user","cwd":"${cwd}","sessionId":"${id}"}\n{"type":"assistant","cwd":"${cwd}","sessionId":"${id}"}\n`;
const rollout = (cwd: string): string => `{"timestamp":"2026-09-06T01:00:00.000Z","type":"session_meta","payload":{"id":"t1","cwd":"${cwd}"}}\n`;

/** The folder as the machine tars it: rooted at the folder, with an exec bit and an empty directory. */
const folderTar = (): Buffer =>
  tarOf([
    { path: "./src", mode: 0o755, dir: true },
    { path: "./src/index.ts", mode: 0o644, content: "export const a = 1;\n" },
    { path: "./bin/run.sh", mode: 0o755, content: "#!/bin/sh\necho run\n" },
    { path: "./.env", mode: 0o600, content: "TOKEN=x\n" },
    { path: "./really-empty", mode: 0o755, dir: true },
  ]);

/** The agents' state as the machine tars it at the guest's root: Claude Code with a session, tool results
 * and memory for the folder plus another project's session; Codex with its index naming a rollout under sessions/
 * and one archived elsewhere; Hermes with a row and no file; Pi with nothing for the folder. */
function stateTar(extra: TarEntry[] = []): Buffer {
  const codexIndex = sqlite(CODEX_SCHEMA, [
    ["insert into threads values (?, ?, ?, 0, 1)", ["t1", "/root/.codex/sessions/2026/09/06/rollout-t1.jsonl", SOURCE]],
    ["insert into threads values (?, ?, ?, 1, 2)", ["t7", "/root/.codex/archived_sessions/rollout-t7.jsonl", SOURCE]],
    ["insert into threads values (?, ?, ?, 0, 3)", ["t2", "/root/.codex/sessions/2026/09/06/rollout-t2.jsonl", "/root/other"]],
  ]);
  const hermes = sqlite("create table sessions (id text primary key, cwd text, git_repo_root text)", [["insert into sessions values (?, ?, ?)", ["h1", SOURCE, SOURCE]]]);
  return tarOf([
    { path: `root/.claude-cfg/projects/${claudeKey(SOURCE)}/S1.jsonl`, mode: 0o644, content: session("S1", SOURCE) },
    { path: `root/.claude-cfg/projects/${claudeKey(SOURCE)}/S1/tool-results/t1.txt`, mode: 0o644, content: "out\n" },
    { path: `root/.claude-cfg/projects/${claudeKey(SOURCE)}/memory/MEMORY.md`, mode: 0o644, content: "machine notes\n" },
    { path: "root/.claude-cfg/projects/-root-other/S2.jsonl", mode: 0o644, content: session("S2", "/root/other") },
    { path: "root/.codex/state_5.sqlite", mode: 0o644, content: codexIndex },
    { path: "root/.codex/sessions/2026/09/06/rollout-t1.jsonl", mode: 0o644, content: rollout(SOURCE) },
    { path: "root/.codex/sessions/2026/09/06/rollout-t2.jsonl", mode: 0o644, content: rollout("/root/other") },
    { path: "root/.hermes/state.db", mode: 0o644, content: hermes },
    { path: "root/.pi/agent/sessions/--root-other--/s.jsonl", mode: 0o644, content: `{"type":"session","cwd":"/root/other"}\n` },
    ...extra,
  ]);
}

/** Homes on this computer: Claude Code already holds another project and an older copy of S1 for the destination;
 * Codex holds its own index and a rollout of its own. */
function macHomes(dest: string): Record<string, string> {
  const root = scratch();
  const homes = Object.fromEntries(["claude", "codex", "hermes", "pi", "gemini", "opencode"].map(a => [a, join(root, a)]));
  put(homes["claude"]!, "projects/-Users-me-other/S9.jsonl", session("S9", "/Users/me/other"));
  put(homes["claude"]!, `projects/${claudeKey(dest)}/S1.jsonl`, `{"type":"user","cwd":"${dest}","sessionId":"S1","stale":true}\n`);
  put(homes["claude"]!, `projects/${claudeKey(dest)}/S0.jsonl`, session("S0", dest));
  put(homes["claude"]!, "history.jsonl", `{"display":"hi"}\n`);
  put(homes["codex"]!, "state_5.sqlite", sqlite(CODEX_SCHEMA, [["insert into threads values (?, ?, ?, 0, 1)", ["m1", `${homes["codex"]}/sessions/2026/09/01/rollout-m1.jsonl`, "/Users/me/other"]]]));
  put(homes["codex"]!, "sessions/2026/09/01/rollout-m1.jsonl", rollout("/Users/me/other"));
  return homes;
}

describe("projectLander", () => {
  it("probe says nothing for a free path, the file count for a folder, one for a file", async () => {
    const root = scratch();
    put(root, "here/a.txt", "a");
    put(root, "here/sub/b.txt", "b");
    const lander = projectLander({});
    expect(await lander.probe(join(root, "none"))).toBeUndefined();
    expect(await lander.probe(join(root, "here"))).toEqual({ files: 2 });
    expect(await lander.probe(join(root, "here/a.txt"))).toEqual({ files: 1 });
  });

  it("lands the folder at the path with its parents made, the exec bit and the empty directory, and keys the agents' state to it in the homes here as an overlay: same paths overwritten, everything else kept, shared stores untouched", async () => {
    const root = scratch();
    const dest = join(root, "code", "proj");
    const real = `${realpathSync(root)}/code/proj`;
    const homes = macHomes(real);
    const before = { claude: snapshot(homes["claude"]!), codex: snapshot(homes["codex"]!) };
    const lander = projectLander(homes);
    const landed = await lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(stateTar()), homes: guestAgentHomes() } });
    expect(landed.files).toBe(3);
    expect(landed.bytes).toBe(Buffer.byteLength("export const a = 1;\n") + Buffer.byteLength("#!/bin/sh\necho run\n") + Buffer.byteLength("TOKEN=x\n"));
    expect(readFileSync(join(dest, "src/index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(statSync(join(dest, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, "really-empty")).isDirectory()).toBe(true);
    expect(readdirSync(join(root, "code"))).toEqual(["proj"]);
    expect(landed.agents).toEqual([
      { agent: "claude", name: "Claude Code", files: 3, bytes: Buffer.byteLength(session("S1", real)) + 4 + 14, outcome: "moved", sessions: 1 },
      { agent: "codex", name: "Codex", files: 1, bytes: Buffer.byteLength(rollout(real)), outcome: "transcript-only", sessions: 2, skipped: 1 },
      { agent: "hermes", name: "Hermes Agent", files: 0, bytes: 0, outcome: "nothing", sessions: 1 },
    ]);
    const key = join(homes["claude"]!, "projects", claudeKey(real));
    expect(snapshot(homes["claude"]!)).toEqual({
      ...before.claude,
      [`projects/${claudeKey(real)}/S1.jsonl`]: session("S1", real),
      [`projects/${claudeKey(real)}/S1/tool-results/t1.txt`]: "out\n",
      [`projects/${claudeKey(real)}/memory/MEMORY.md`]: "machine notes\n",
    });
    expect(existsSync(join(key, "S0.jsonl"))).toBe(true);
    expect(existsSync(join(homes["claude"]!, "projects", "-root-other"))).toBe(false);
    expect(snapshot(homes["codex"]!)).toEqual({ ...before.codex, "sessions/2026/09/06/rollout-t1.jsonl": rollout(real) });
    expect(existsSync(join(homes["hermes"]!))).toBe(false);
    expect(existsSync(join(homes["pi"]!))).toBe(false);
    expect(readdirSync(tmpdir()).filter(n => n.startsWith("wsp-home-"))).toEqual([]);
  });

  it("a store the listing could not read on the machine is a report row of its own naming the store and why, in catalog order, and nothing of that agent lands", async () => {
    const root = scratch();
    const dest = join(root, "code", "proj");
    const real = `${realpathSync(root)}/code/proj`;
    const homes = macHomes(real);
    const before = snapshot(homes["codex"]!);
    const lander = projectLander(homes);
    // The state archive holds no Hermes home at all: the listing named nothing from it once its store would not open.
    const state = tarOf([{ path: `root/.claude-cfg/projects/${claudeKey(SOURCE)}/S1.jsonl`, mode: 0o644, content: session("S1", SOURCE) }]);
    const landed = await lander.land({
      source: SOURCE,
      dest,
      replace: false,
      archive: archived(folderTar()),
      state: { archive: archived(state), homes: guestAgentHomes() },
      unread: [{ agent: "hermes", store: "/root/.hermes/state.db", why: "file is not a database" }],
    });
    expect(landed.agents).toEqual([
      { agent: "claude", name: "Claude Code", files: 1, bytes: Buffer.byteLength(session("S1", real)), outcome: "moved", sessions: 1 },
      { agent: "hermes", name: "Hermes Agent", files: 0, bytes: 0, outcome: "failed", error: storeUnreadLine("/root/.hermes/state.db", "file is not a database") },
    ]);
    expect(existsSync(homes["hermes"]!)).toBe(false);
    expect(snapshot(homes["codex"]!)).toEqual(before);
  });

  it("refuses an existing destination with kind exists, naming it and its files, leaves it and the homes as they were, and replaces it when told to", async () => {
    const root = scratch();
    const dest = join(root, "proj");
    put(dest, "old.txt", "old");
    put(dest, "sub/older.txt", "older");
    const homes = macHomes(dest);
    const before = snapshot(homes["claude"]!);
    const lander = projectLander(homes);
    await expect(lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(stateTar()), homes: guestAgentHomes() } })).rejects.toMatchObject({
      kind: "exists",
      message: `${dest} already exists on this computer with 2 files; export with replace to overwrite it`,
    });
    expect(readFileSync(join(dest, "old.txt"), "utf8")).toBe("old");
    expect(snapshot(homes["claude"]!)).toEqual(before);
    expect(readdirSync(root).filter(n => n.startsWith("proj.wsp-in-"))).toEqual([]);
    const landed = await lander.land({ source: SOURCE, dest, replace: true, archive: archived(folderTar()) });
    expect(landed).toEqual({ files: 3, bytes: expect.any(Number), agents: [] });
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("TOKEN=x\n");
  });

  it("a failed extraction leaves nothing at the destination or beside it", async () => {
    const root = scratch();
    const dest = join(root, "proj");
    await expect(projectLander({}).land({ source: SOURCE, dest, replace: false, archive: archived(Buffer.from("not an archive")) })).rejects.toThrow(/extracting the archive/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("a state archive that cannot be opened leaves nothing at the destination, no scratch home, and the homes as they were, so the same run lands on retry", async () => {
    const root = scratch();
    const dest = join(root, "proj");
    const homes = macHomes(`${realpathSync(root)}/proj`);
    const before = snapshot(homes["claude"]!);
    const lander = projectLander(homes);
    await expect(lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(Buffer.from("not an archive")), homes: guestAgentHomes() } })).rejects.toThrow(/extracting the archive/);
    expect(readdirSync(root)).toEqual([]);
    expect(snapshot(homes["claude"]!)).toEqual(before);
    expect(readdirSync(tmpdir()).filter(n => n.startsWith("wsp-home-"))).toEqual([]);
    const landed = await lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(stateTar()), homes: guestAgentHomes() } });
    expect(landed.files).toBe(3);
    expect(landed.agents.map(a => [a.agent, a.outcome])).toEqual([["claude", "moved"], ["codex", "transcript-only"], ["hermes", "nothing"]]);
  });

  describe("an archive that reaches out of the folder", () => {
    it("a .. entry is refused, nothing lands beside the destination and the staging directory is gone", async () => {
      const root = scratch();
      const dest = join(root, "proj");
      const tar = tarOf([{ path: "./ok.txt", mode: 0o644, content: "ok\n" }, { path: "../evil.txt", mode: 0o644, content: "evil\n" }]);
      await expect(projectLander({}).land({ source: SOURCE, dest, replace: false, archive: archived(tar) })).rejects.toThrow(/extracting the archive/);
      expect(readdirSync(root)).toEqual([]);
    });

    it("an absolute entry loses its leading slash and lands inside the folder, nothing at the absolute path", async () => {
      const root = scratch();
      const dest = join(root, "proj");
      const outside = join(scratch(), "abs");
      put(outside, "evil.txt", "evil\n");
      const archive = join(scratch(), "abs.tgz");
      const made = spawnSync("tar", ["-P", "-czf", archive, join(outside, "evil.txt")]);
      expect(made.status).toBe(0);
      rmSync(outside, { recursive: true, force: true });
      const landed = await projectLander({}).land({ source: SOURCE, dest, replace: false, archive });
      expect(landed.files).toBe(1);
      expect(existsSync(join(outside, "evil.txt"))).toBe(false);
      expect(readFileSync(join(dest, outside, "evil.txt"), "utf8")).toBe("evil\n");
      expect(readdirSync(root)).toEqual(["proj"]);
    });

    it("a state archive whose expected home is a link is refused whole, before a resolver runs, and the folder it points at is untouched", async () => {
      const root = scratch();
      const dest = join(root, "proj");
      // The agent store on this computer, as the archive would reach it: the landing must leave it byte for byte.
      const real = `${realpathSync(root)}/proj`;
      const homes = macHomes(real);
      const before = snapshot(homes["claude"]!);
      const tar = tarOf([
        { path: "root/.codex/state_5.sqlite", mode: 0o644, content: "x" },
        { path: "root/.claude-cfg", target: homes["claude"]! },
      ]);
      await expect(projectLander(homes).land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(tar), homes: guestAgentHomes() } })).rejects.toThrow(
        stateEntryRefusal("root/.claude-cfg", "a link"),
      );
      expect(snapshot(homes["claude"]!)).toEqual(before);
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(tmpdir()).filter(n => n.startsWith("wsp-home-"))).toEqual([]);
    });

    it("a state archive holding an entry that is no file and no folder is refused the same way", async () => {
      const root = scratch();
      const packed = scratch();
      mkdirSync(join(packed, "root/.codex"), { recursive: true });
      expect(spawnSync("mkfifo", [join(packed, "root/.codex/pipe")]).status).toBe(0);
      writeFileSync(join(packed, "root/.codex/state_5.sqlite"), "x");
      const archive = join(scratch(), "fifo.tgz");
      expect(spawnSync("tar", ["-czf", archive, "-C", packed, "root"]).status).toBe(0);
      await expect(projectLander(macHomes(join(root, "proj"))).land({ source: SOURCE, dest: join(root, "proj"), replace: false, archive: archived(folderTar()), state: { archive, homes: guestAgentHomes() } })).rejects.toThrow(
        stateEntryRefusal(join("root", ".codex", "pipe"), "a fifo"),
      );
      expect(readdirSync(root)).toEqual([]);
    });

    it("a home that reaches out of the folder the archive was opened in fails that agent's row alone, and the rest lands", async () => {
      const root = scratch();
      const dest = join(root, "proj");
      const real = `${realpathSync(root)}/proj`;
      const homes = macHomes(real);
      const before = snapshot(homes["codex"]!);
      // Four levels up from a scratch home's own root is the folder every scratch home is made in; a store standing
      // there is one this landing must not be pointed at, whatever the homes list says.
      const outside = join(tmpdir(), ".codex-outside");
      mkdirSync(outside, { recursive: true });
      try {
        const landed = await projectLander(homes).land({
          source: SOURCE,
          dest,
          replace: false,
          archive: archived(folderTar()),
          state: { archive: archived(stateTar()), homes: { ...guestAgentHomes(), codex: `root/../../${basename(outside)}` } },
        });
        expect(landed.files).toBe(3);
        expect(landed.agents.map(a => [a.agent, a.outcome])).toEqual([["claude", "moved"], ["codex", "failed"], ["hermes", "nothing"]]);
        expect(landed.agents.find(a => a.agent === "codex")).toMatchObject({ error: stateEntryRefusal(`root/../../${basename(outside)}`, "a path out of the folder it was opened in") });
        expect(snapshot(homes["codex"]!)).toEqual(before);
        expect(readdirSync(outside)).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("a rollout the machine's own index names outside the home it travelled in is neither rewritten there nor copied home", async () => {
      const root = scratch();
      const dest = join(root, "proj");
      const real = `${realpathSync(root)}/proj`;
      const homes = macHomes(real);
      // A file standing for one of this computer's own, at the path the index's dot-dot climb lands on: four levels
      // up from <scratch>/root/.codex/sessions/ is the folder every scratch home is made in.
      const loot = join(tmpdir(), "wsp-export-loot.jsonl");
      writeFileSync(loot, rollout(SOURCE));
      try {
        const index = sqlite(CODEX_SCHEMA, [["insert into threads values (?, ?, ?, 0, 1)", ["t1", `/root/.codex/sessions/../../../../${basename(loot)}`, SOURCE]]]);
        const landed = await projectLander(homes).land({
          source: SOURCE,
          dest,
          replace: false,
          archive: archived(folderTar()),
          state: { archive: archived(tarOf([{ path: "root/.codex/state_5.sqlite", mode: 0o644, content: index }])), homes: guestAgentHomes() },
        });
        // The row it named is one the landing skipped, so nothing of codex's state came home.
        expect(landed.agents.map(a => [a.agent, a.outcome])).toEqual([["codex", "nothing"]]);
        expect(landed.agents[0]).toMatchObject({ files: 0, bytes: 0 });
        expect(readFileSync(loot, "utf8")).toBe(rollout(SOURCE));
        expect(snapshot(homes["codex"]!)[basename(loot)]).toBeUndefined();
      } finally {
        rmSync(loot, { force: true });
      }
    });

    it("a file through a link that points out of the folder is refused, the link's target untouched, nothing at or beside the destination", async () => {
      const root = scratch();
      const dest = join(root, "proj");
      const outside = scratch();
      const tar = tarOf([
        { path: "./ok.txt", mode: 0o644, content: "ok\n" },
        { path: "./out", target: outside },
        { path: "./out/evil.txt", mode: 0o644, content: "evil\n" },
      ]);
      await expect(projectLander({}).land({ source: SOURCE, dest, replace: false, archive: archived(tar) })).rejects.toThrow(/extracting the archive/);
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(root)).toEqual([]);
    });
  });

  it("a destination that is not an absolute path is refused before anything is read", async () => {
    const lander = projectLander({});
    await expect(lander.probe("code/proj")).rejects.toThrow(/absolute path, got code\/proj/);
    await expect(lander.land({ source: SOURCE, dest: "code/proj", replace: false, archive: archived(folderTar()) })).rejects.toThrow(/absolute path, got code\/proj/);
    expect(existsSync("code")).toBe(false);
  });

  it("a destination spelled with a trailing slash, as the wire carries it, lands at the folder itself with its state keyed to that path", async () => {
    const root = scratch();
    const dest = `${join(root, "code", "proj")}/`;
    const real = `${realpathSync(root)}/code/proj`;
    const homes = macHomes(real);
    const lander = projectLander(homes);
    const landed = await lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(stateTar()), homes: guestAgentHomes() } });
    expect(landed.files).toBe(3);
    expect(readdirSync(join(root, "code"))).toEqual(["proj"]);
    expect(readFileSync(join(root, "code", "proj", "src/index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(landed.agents.map(a => [a.agent, a.outcome])).toEqual([["claude", "moved"], ["codex", "transcript-only"], ["hermes", "nothing"]]);
    expect(readdirSync(join(homes["claude"]!, "projects")).sort()).toEqual([claudeKey(real), "-Users-me-other"].sort());
    expect(readFileSync(join(homes["claude"]!, "projects", claudeKey(real), "S1.jsonl"), "utf8")).toBe(session("S1", real));
    expect(await lander.probe(dest)).toEqual({ files: 3 });
    await expect(lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()) })).rejects.toMatchObject({ kind: "exists", message: `${join(root, "code", "proj")} already exists on this computer with 3 files; export with replace to overwrite it` });
  });

  it("agents named narrow whose state comes home; an agent whose store cannot be read is failed with the reason and the others still land", async () => {
    const root = scratch();
    const dest = join(root, "proj");
    const real = `${realpathSync(root)}/proj`;
    const homes = macHomes(real);
    const lander = projectLander(homes);
    const narrowed = await lander.land({ source: SOURCE, dest, replace: false, archive: archived(folderTar()), state: { archive: archived(stateTar()), homes: guestAgentHomes(), agents: ["claude"] } });
    expect(narrowed.agents.map(a => a.agent)).toEqual(["claude"]);
    expect(existsSync(join(homes["codex"]!, "sessions/2026/09/06"))).toBe(false);
    const broken = await lander.land({
      source: SOURCE,
      dest: join(root, "again"),
      replace: false,
      archive: archived(folderTar()),
      state: { archive: archived(stateTar([{ path: "root/.local/share/opencode/opencode.db", mode: 0o644, content: "not a database\n" }])), homes: guestAgentHomes() },
    });
    expect(broken.agents.map(a => [a.agent, a.outcome])).toEqual([
      ["claude", "moved"],
      ["codex", "transcript-only"],
      ["opencode", "failed"],
      ["hermes", "nothing"],
    ]);
    expect(broken.agents[2]).toMatchObject({ files: 0, bytes: 0, sessions: 0, error: expect.stringMatching(/not a database/) });
  });
});
