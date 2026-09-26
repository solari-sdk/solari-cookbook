// SPDX-License-Identifier: AGPL-3.0-only
// Each fixture is the tree an agent left after one headless scratch run, as
// measured on 2026-09-05; the move runs against it and the tree is compared
// byte for byte with what the agent needs at the new path.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { ProjectCarry } from "@wsp/protocol";
import { PROJECT_STATE_RESOLVERS, agentHome, agentHomes, countProjectState, guestAgentHomes, insideFolder, moveProjectState, parseMergeOutput, parseStateListing, resolveProjectPath, stateListing, storeCopy, underHome, underProject, type MergeOutput, type ProjectStateResolver, type UnreadStore } from "../src/project-state/index.js";
import { mergeScript } from "../src/project-state/merge.js";
import { rewriteJsonl } from "../src/project-state/resolver.js";
import { PY_PREAMBLE } from "../src/project-state/py.js";

/** The built engine, for a test whose move has to run in a process of its own. */
const ENGINE_DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const FROM = "/private/tmp/wsp-r212/proj/b_2.x";
const TO = "/root/work/b_2.x";
const OTHER = "/Users/me/other";
// A session run in a folder under the project moves with it; a sibling sharing the prefix does not.
const FROM_SUB = `${FROM}/sub`;
const TO_SUB = `${TO}/sub`;
const DECOY = `${FROM}-old`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const scratch = (): string => {
  const r = mkdtempSync(join(tmpdir(), "wsp-t221-"));
  roots.push(r);
  return r;
};

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const lines = (...l: string[]): string => l.join("\n") + "\n";

/** Every regular file under dir by relative path, text files as their bytes, sqlite files by their rows. */
function tree(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    out[relative(dir, abs)] = /\.(sqlite|db)$/.test(e.name) ? rows(abs) : readFileSync(abs, "utf8");
  }
  return out;
}
function rows(db: string): Record<string, unknown[]> {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const out: Record<string, unknown[]> = {};
    const tables = d.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[];
    for (const { name } of tables) out[name] = d.prepare(`select * from "${name}" order by 1, 2`).all().map(r => ({ ...r }));
    return out;
  } finally {
    d.close();
  }
}
function seed(db: string, schema: string, inserts: readonly [string, readonly (string | number | null)[]][]): void {
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(schema);
    for (const [sql, params] of inserts) d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
}

const resolverFor = (agent: string): ProjectStateResolver => {
  const r = PROJECT_STATE_RESOLVERS.get(agent);
  if (r === undefined) throw new Error(`no resolver for ${agent}`);
  return r;
};

// --- Claude Code ------------------------------------------------------------------------------------------------------

const claudeUser = (cwd: string) => `{"type":"user","cwd":"${cwd}","sessionId":"S1","version":"2.1.257","message":{"role":"user","content":"hi"}}`;
const claudeAssistant = (cwd: string) => `{"type":"assistant","cwd":"${cwd}","sessionId":"S1","message":{"role":"assistant","content":[]}}`;
const claudeSummary = `{"type":"summary","summary":"a scratch run","leafUuid":"u1"}`;
const claudeTail = `{"type":"user","cwd":"${FROM}","sessionId":"S1"`;
const claudeSub = (cwd: string) => `{"type":"user","cwd":"${cwd}","sessionId":"S1","isSidechain":true,"message":{"role":"user","content":"look"}}`;

function claudeHome(root: string): string {
  const home = join(root, "claude");
  const key = join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x");
  write(join(key, "S1.jsonl"), [claudeUser(FROM), claudeAssistant(FROM), claudeSummary, claudeTail].join("\n"));
  write(join(key, "S1", "subagents", "agent-a1.jsonl"), lines(claudeSub(FROM)));
  write(join(key, "S1", "tool-results", "t1.txt"), "ls output\n");
  write(join(key, "memory", "MEMORY.md"), "notes\n");
  write(join(home, "projects", "-Users-me-other", "S2.jsonl"), lines(claudeUser(OTHER)));
  write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub", "S3.jsonl"), lines(claudeUser(FROM_SUB)));
  write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-old", "S4.jsonl"), lines(claudeUser(DECOY)));
  write(join(home, "sessions", "4242.json"), `{"pid":4242,"cwd":"${FROM}"}\n`);
  write(join(home, "history.jsonl"), lines(`{"display":"hi","project":"${FROM}"}`));
  return home;
}
const claudeAfter = (key: string): Record<string, unknown> => ({
  [`projects/${key}/S1.jsonl`]: [claudeUser(TO), claudeAssistant(TO), claudeSummary, claudeTail].join("\n"),
  [`projects/${key}/S1/subagents/agent-a1.jsonl`]: lines(claudeSub(TO)),
  [`projects/${key}/S1/tool-results/t1.txt`]: "ls output\n",
  [`projects/${key}/memory/MEMORY.md`]: "notes\n",
  "projects/-Users-me-other/S2.jsonl": lines(claudeUser(OTHER)),
  [`projects/${key}-sub/S3.jsonl`]: lines(claudeUser(TO_SUB)),
  "projects/-private-tmp-wsp-r212-proj-b-2-x-old/S4.jsonl": lines(claudeUser(DECOY)),
  "sessions/4242.json": `{"pid":4242,"cwd":"${FROM}"}\n`,
  "history.jsonl": lines(`{"display":"hi","project":"${FROM}"}`),
});

describe("claude resolver", () => {
  it("renames the dashed directories of the root and a sub-folder session, rewrites cwd on every transcript line, and leaves a sibling and every other byte alone", async () => {
    const home = claudeHome(scratch());
    const moved = await resolverFor("claude").move(home, FROM, TO);
    expect(tree(home)).toEqual(claudeAfter("-root-work-b-2-x"));
    expect(existsSync(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x"))).toBe(false);
    expect(existsSync(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub"))).toBe(false);
    const root = join(home, "projects", "-root-work-b-2-x");
    const sub = join(home, "projects", "-root-work-b-2-x-sub");
    expect(moved).toEqual([
      { state: "session transcripts", files: [root, join(root, "S1.jsonl"), join(root, "S1", "subagents", "agent-a1.jsonl"), sub, join(sub, "S3.jsonl")], changed: 6 },
      { state: "auto memory", files: [join(root, "memory")], changed: 1 },
    ]);
  });

  it("moves a directory with no transcript only when its key is the project's own", async () => {
    const home = join(scratch(), "claude");
    write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x", "memory", "MEMORY.md"), "notes\n");
    write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub", "memory", "MEMORY.md"), "sub or sibling, no way to tell\n");
    await resolverFor("claude").move(home, FROM, TO);
    expect(Object.keys(tree(home)).sort()).toEqual(["projects/-private-tmp-wsp-r212-proj-b-2-x-sub/memory/MEMORY.md", "projects/-root-work-b-2-x/memory/MEMORY.md"]);
  });

  it("finds nothing when the project never ran there", async () => {
    const home = claudeHome(scratch());
    const before = tree(home);
    expect(await resolverFor("claude").move(home, "/Users/me/never", TO)).toEqual([]);
    expect(tree(home)).toEqual(before);
  });

  it("refuses to move onto a directory that already exists rather than merge into it", async () => {
    const home = claudeHome(scratch());
    write(join(home, "projects", "-root-work-b-2-x", "S9.jsonl"), lines(claudeUser(TO)));
    const before = tree(home);
    await expect(resolverFor("claude").move(home, FROM, TO)).rejects.toThrow(/already exists/);
    expect(tree(home)).toEqual(before);
  });
});

// --- Pi ---------------------------------------------------------------------------------------------------------------

const piHeader = (cwd: string) => `{"type":"session","version":3,"id":"s1","timestamp":"2026-09-05T21:56:00.000Z","cwd":"${cwd}"}`;
const piMessage = `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-05T21:56:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`;

function piHome(root: string): string {
  const home = join(root, "pi");
  write(join(home, "sessions", "--private-tmp-wsp-r212-proj-b_2.x--", "2026-09-05T21-56-00-000Z_s1.jsonl"), lines(piHeader(FROM), piMessage));
  write(join(home, "sessions", "--Users-me-other--", "2026-09-05T21-50-00-000Z_s0.jsonl"), lines(piHeader(OTHER), piMessage));
  write(join(home, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-sub--", "2026-09-05T21-57-00-000Z_s2.jsonl"), lines(piHeader(FROM_SUB), piMessage));
  write(join(home, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-old--", "2026-09-05T21-40-00-000Z_s3.jsonl"), lines(piHeader(DECOY), piMessage));
  write(join(home, "trust.json"), `{"${FROM}":true}\n`);
  return home;
}

describe("pi resolver", () => {
  it("renames the double-dashed directories of the root and a sub-folder session and rewrites the header cwd", async () => {
    const home = piHome(scratch());
    const moved = await resolverFor("pi").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "sessions/--root-work-b_2.x--/2026-09-05T21-56-00-000Z_s1.jsonl": lines(piHeader(TO), piMessage),
      "sessions/--root-work-b_2.x-sub--/2026-09-05T21-57-00-000Z_s2.jsonl": lines(piHeader(TO_SUB), piMessage),
      "sessions/--private-tmp-wsp-r212-proj-b_2.x-old--/2026-09-05T21-40-00-000Z_s3.jsonl": lines(piHeader(DECOY), piMessage),
      "sessions/--Users-me-other--/2026-09-05T21-50-00-000Z_s0.jsonl": lines(piHeader(OTHER), piMessage),
      "trust.json": `{"${FROM}":true}\n`,
    });
    const root = join(home, "sessions", "--root-work-b_2.x--");
    const sub = join(home, "sessions", "--root-work-b_2.x-sub--");
    expect(moved).toEqual([
      { state: "sessions", files: [root, join(root, "2026-09-05T21-56-00-000Z_s1.jsonl"), sub, join(sub, "2026-09-05T21-57-00-000Z_s2.jsonl")], changed: 4 },
    ]);
  });

  it("keeps dots and underscores, dashes colons and backslashes, as measured", async () => {
    const home = join(scratch(), "pi");
    const cwd = "C:\\Users\\me\\a_b.c";
    write(join(home, "sessions", "--C--Users-me-a_b.c--", "x.jsonl"), lines(JSON.stringify({ type: "session", cwd })));
    await resolverFor("pi").move(home, cwd, "/home/me/a_b.c");
    expect(tree(home)).toEqual({ "sessions/--home-me-a_b.c--/x.jsonl": lines(JSON.stringify({ type: "session", cwd: "/home/me/a_b.c" })) });
  });
});

// --- Codex ------------------------------------------------------------------------------------------------------------

const codexMeta = (cwd: string) => `{"timestamp":"2026-09-05T21:58:00.000Z","type":"session_meta","payload":{"id":"t1","timestamp":"2026-09-05T21:58:00.000Z","cwd":"${cwd}","originator":"codex_exec","cli_version":"0.153.0"}}`;
const codexItem = `{"timestamp":"2026-09-05T21:58:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`;
const codexTurn = (cwd: string) => `{"timestamp":"2026-09-05T21:58:00.200Z","type":"turn_context","payload":{"cwd":"${cwd}","approval_policy":"never","model":"gpt-5"}}`;
const codexEvent = `{"timestamp":"2026-09-05T21:58:01.000Z","type":"event_msg","payload":{"type":"error","message":"401"}}`;
const CODEX_SCHEMA = "create table threads (id text primary key, rollout_path text not null, cwd text not null, archived integer not null default 0, updated_at integer not null default 0)";

function codexHome(root: string): string {
  const home = join(root, "codex");
  const t1 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
  const t2 = join(home, "sessions", "2026", "09", "04", "rollout-2026-09-04T10-00-00-t2.jsonl");
  const t3 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl");
  const t4 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-01-00-t4.jsonl");
  write(t1, lines(codexMeta(FROM), codexItem, codexTurn(FROM), codexEvent));
  write(t2, lines(codexMeta(OTHER), codexItem, codexTurn(OTHER)));
  write(t3, lines(codexMeta(FROM_SUB), codexItem, codexTurn(FROM_SUB)));
  write(t4, lines(codexMeta(DECOY), codexItem, codexTurn(DECOY)));
  seed(join(home, "state_5.sqlite"), CODEX_SCHEMA, [
    ["insert into threads values (?, ?, ?, 0, 1)", ["t1", t1, FROM]],
    ["insert into threads values (?, ?, ?, 0, 2)", ["t2", t2, OTHER]],
    ["insert into threads values (?, ?, ?, 0, 3)", ["t3", t3, FROM_SUB]],
    ["insert into threads values (?, ?, ?, 0, 4)", ["t4", t4, DECOY]],
  ]);
  write(join(home, "config.toml"), `[projects."${FROM}"]\ntrust_level = "trusted"\n`);
  return home;
}

describe("codex resolver", () => {
  it("updates threads.cwd for the root and a sub-folder thread and rewrites cwd in their rollouts, leaving rollout_path and the sibling alone", async () => {
    const home = codexHome(scratch());
    const t1 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const t2 = join(home, "sessions", "2026", "09", "04", "rollout-2026-09-04T10-00-00-t2.jsonl");
    const t3 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl");
    const t4 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-01-00-t4.jsonl");
    const moved = await resolverFor("codex").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "sessions/2026/09/05/rollout-2026-09-05T21-58-00-t1.jsonl": lines(codexMeta(TO), codexItem, codexTurn(TO), codexEvent),
      "sessions/2026/09/04/rollout-2026-09-04T10-00-00-t2.jsonl": lines(codexMeta(OTHER), codexItem, codexTurn(OTHER)),
      "sessions/2026/09/05/rollout-2026-09-05T22-00-00-t3.jsonl": lines(codexMeta(TO_SUB), codexItem, codexTurn(TO_SUB)),
      "sessions/2026/09/05/rollout-2026-09-05T22-01-00-t4.jsonl": lines(codexMeta(DECOY), codexItem, codexTurn(DECOY)),
      "state_5.sqlite": {
        threads: [
          { id: "t1", rollout_path: t1, cwd: TO, archived: 0, updated_at: 1 },
          { id: "t2", rollout_path: t2, cwd: OTHER, archived: 0, updated_at: 2 },
          { id: "t3", rollout_path: t3, cwd: TO_SUB, archived: 0, updated_at: 3 },
          { id: "t4", rollout_path: t4, cwd: DECOY, archived: 0, updated_at: 4 },
        ],
      },
      "config.toml": `[projects."${FROM}"]\ntrust_level = "trusted"\n`,
    });
    expect(moved).toEqual([
      { state: "thread index", files: [join(home, "state_5.sqlite")], changed: 2 },
      { state: "rollout transcript", files: [t1, t3], changed: 4 },
    ]);
  });

  it("finds nothing in a home with no index and no rollouts", async () => {
    const home = join(scratch(), "codex");
    write(join(home, "config.toml"), "");
    expect(await resolverFor("codex").move(home, FROM, TO)).toEqual([]);
  });

  it("counts the indexed rollouts it could not reach: one archived outside sessions/ and one whose file is gone move their rows and nothing else", async () => {
    const home = join(scratch(), "codex");
    const t1 = join("sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    write(join(home, t1), lines(codexMeta(FROM), codexItem));
    write(join(home, "archived_sessions", "rollout-2026-09-01T10-00-00-t7.jsonl"), lines(codexMeta(FROM), codexItem));
    seed(join(home, "state_5.sqlite"), CODEX_SCHEMA, [
      ["insert into threads values (?, ?, ?, 0, 1)", ["t1", join(home, t1), FROM]],
      ["insert into threads values (?, ?, ?, 1, 2)", ["t7", join(home, "archived_sessions", "rollout-2026-09-01T10-00-00-t7.jsonl"), FROM]],
      ["insert into threads values (?, ?, ?, 0, 3)", ["t8", join(home, "sessions", "2026", "09", "02", "rollout-gone-t8.jsonl"), FROM_SUB]],
      ["insert into threads values (?, ?, ?, 0, 4)", ["t2", join(home, "sessions", "x", "rollout-t2.jsonl"), OTHER]],
    ]);
    const moved = await resolverFor("codex").move(home, FROM, TO);
    expect(moved).toEqual([
      { state: "thread index", files: [join(home, "state_5.sqlite")], changed: 3, skipped: 2 },
      { state: "rollout transcript", files: [join(home, t1)], changed: 1 },
    ]);
    expect(tree(home)).toMatchObject({ "archived_sessions/rollout-2026-09-01T10-00-00-t7.jsonl": lines(codexMeta(FROM), codexItem) });
    const all = await resolverFor("codex").move(codexHome(scratch()), FROM, TO);
    expect(all[0]).not.toHaveProperty("skipped");
  });

  it("reads only the rollouts the index names, under this home even when rollout_path was recorded under another", async () => {
    const home = join(scratch(), "codex");
    const t1 = join("sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const orphan = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T23-00-00-t9.jsonl");
    write(join(home, t1), lines(codexMeta(FROM), codexItem, codexTurn(FROM)));
    write(orphan, lines(codexMeta(FROM), codexItem));
    seed(join(home, "state_5.sqlite"), CODEX_SCHEMA, [["insert into threads values (?, ?, ?, 0, 1)", ["t1", join("/Users/me/.codex", t1), FROM]]]);
    const moved = await resolverFor("codex").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      [t1]: lines(codexMeta(TO), codexItem, codexTurn(TO)),
      "sessions/2026/09/05/rollout-2026-09-05T23-00-00-t9.jsonl": lines(codexMeta(FROM), codexItem),
      "state_5.sqlite": { threads: [{ id: "t1", rollout_path: join("/Users/me/.codex", t1), cwd: TO, archived: 0, updated_at: 1 }] },
    });
    expect(moved).toEqual([
      { state: "thread index", files: [join(home, "state_5.sqlite")], changed: 1 },
      { state: "rollout transcript", files: [join(home, t1)], changed: 2 },
    ]);
  });
});

// --- Hermes -----------------------------------------------------------------------------------------------------------

const HERMES_SCHEMA = "create table sessions (id text primary key, cwd text, git_repo_root text, message_count integer); create table messages (id integer primary key, session_id text, content text)";

function hermesHome(root: string): string {
  const home = join(root, "hermes");
  seed(join(home, "state.db"), HERMES_SCHEMA, [
    ["insert into sessions values (?, ?, ?, 2)", ["20260906_033144_55e3e2", FROM, FROM]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_030000_aaaaaa", OTHER, OTHER]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_034000_bbbbbb", FROM, null]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_035000_cccccc", FROM_SUB, FROM]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_036000_dddddd", DECOY, DECOY]],
    ["insert into messages values (1, ?, 'hi')", ["20260906_033144_55e3e2"]],
    ["insert into messages values (2, ?, 'there')", ["20260906_033144_55e3e2"]],
    ["insert into messages values (3, ?, 'other')", ["20260906_030000_aaaaaa"]],
  ]);
  write(join(home, "sessions", "request_dump_20260906_033144_55e3e2_1.json"), "{}\n");
  return home;
}

describe("hermes resolver", () => {
  it("updates cwd and git_repo_root on the rows at the path or under it, leaving the sibling alone", async () => {
    const home = hermesHome(scratch());
    const moved = await resolverFor("hermes").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "state.db": {
        sessions: [
          { id: "20260906_030000_aaaaaa", cwd: OTHER, git_repo_root: OTHER, message_count: 1 },
          { id: "20260906_033144_55e3e2", cwd: TO, git_repo_root: TO, message_count: 2 },
          { id: "20260906_034000_bbbbbb", cwd: TO, git_repo_root: null, message_count: 1 },
          { id: "20260906_035000_cccccc", cwd: TO_SUB, git_repo_root: TO, message_count: 1 },
          { id: "20260906_036000_dddddd", cwd: DECOY, git_repo_root: DECOY, message_count: 1 },
        ],
        messages: [
          { id: 1, session_id: "20260906_033144_55e3e2", content: "hi" },
          { id: 2, session_id: "20260906_033144_55e3e2", content: "there" },
          { id: 3, session_id: "20260906_030000_aaaaaa", content: "other" },
        ],
      },
      "sessions/request_dump_20260906_033144_55e3e2_1.json": "{}\n",
    });
    expect(moved).toEqual([{ state: "sessions", files: [join(home, "state.db")], changed: 3 }]);
  });
});

// --- Gemini -----------------------------------------------------------------------------------------------------------

const geminiRegistry = (path: string) => JSON.stringify({ projects: { [path]: "b_2.x", [OTHER]: "other", [`${path}/sub`]: "sub", [DECOY]: "b_2.x-old" } }, null, 2) + "\n";
const geminiChat = `{"sessionId":"a1b2c3d4-0000","projectHash":"9d0b5e0f","startTime":"2026-09-05T21:59:00.000Z","messages":[]}\n`;

function geminiHome(root: string): string {
  const home = join(root, "gemini");
  write(join(home, "projects.json"), geminiRegistry(FROM));
  write(join(home, "tmp", "b_2.x", ".project_root"), FROM);
  write(join(home, "tmp", "b_2.x", "chats", "session-2026-09-05T21-59-a1b2c3d4.jsonl"), geminiChat);
  write(join(home, "history", "b_2.x", ".project_root"), FROM + "\n");
  write(join(home, "tmp", "other", ".project_root"), OTHER);
  write(join(home, "tmp", "sub", ".project_root"), FROM_SUB);
  write(join(home, "tmp", "b_2.x-old", ".project_root"), DECOY);
  write(join(home, "trustedFolders.json"), `{"${FROM}":"TRUST_FOLDER"}\n`);
  return home;
}

describe("gemini resolver", () => {
  it("rewrites the registry keys of the root and a sub-folder and their .project_root files, keeping slugs, the chat and the sibling", async () => {
    const home = geminiHome(scratch());
    const moved = await resolverFor("gemini").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "projects.json": geminiRegistry(TO),
      "tmp/b_2.x/.project_root": TO,
      "tmp/b_2.x/chats/session-2026-09-05T21-59-a1b2c3d4.jsonl": geminiChat,
      "history/b_2.x/.project_root": TO + "\n",
      "tmp/other/.project_root": OTHER,
      "tmp/sub/.project_root": TO_SUB,
      "tmp/b_2.x-old/.project_root": DECOY,
      "trustedFolders.json": `{"${FROM}":"TRUST_FOLDER"}\n`,
    });
    expect(moved).toEqual([
      { state: "project registry", files: [join(home, "projects.json")], changed: 2 },
      { state: "project temp dir", files: [join(home, "tmp", "b_2.x", ".project_root"), join(home, "tmp", "sub", ".project_root")], changed: 2 },
      { state: "shell history", files: [join(home, "history", "b_2.x", ".project_root")], changed: 1 },
    ]);
  });

  // The move runs in a process of its own under a file size cap, so whatever writes the registry is killed by
  // SIGXFSZ partway through the bytes: the registry must then be the old one whole or the new one whole.
  it.skipIf(!existsSync(ENGINE_DIST))("leaves the registry old or new, never half, when its write is killed partway", () => {
    const home = geminiHome(scratch());
    const many = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`/Users/me/p${i}`, `slug-${i}`]));
    const old = `${JSON.stringify({ projects: { [FROM]: "b_2.x", ...many } }, null, 2)}\n`;
    writeFileSync(join(home, "projects.json"), old);
    const script = `const { PROJECT_STATE_RESOLVERS } = await import(${JSON.stringify(ENGINE_DIST)}); await PROJECT_STATE_RESOLVERS.get("gemini").move(process.argv[1], process.argv[2], process.argv[3]);`;
    const run = spawnSync("/bin/sh", ["-c", 'ulimit -f 512; exec "$0" --input-type=module -e "$1" "$2" "$3" "$4"', process.execPath, script, home, FROM, TO], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    const left = readFileSync(join(home, "projects.json"), "utf8");
    expect([old, old.replace(JSON.stringify(FROM), JSON.stringify(TO))]).toContain(left);
    expect(readdirSync(home).filter(n => n.startsWith(".wsp-"))).toEqual([]);
  });

  it("moves the registry alone when the project never opened a shell", async () => {
    const home = geminiHome(scratch());
    rmSync(join(home, "history"), { recursive: true });
    const moved = await resolverFor("gemini").move(home, FROM, TO);
    expect(moved.map(m => m.state)).toEqual(["project registry", "project temp dir"]);
  });

  it("refuses a destination the registry already knows", async () => {
    const home = geminiHome(scratch());
    write(join(home, "projects.json"), JSON.stringify({ projects: { [FROM]: "b_2.x", [TO]: "b_2.x-1" } }));
    await expect(resolverFor("gemini").move(home, FROM, TO)).rejects.toThrow(/already exists/);
  });

  it("finds nothing when the registry does not know the path", async () => {
    const home = geminiHome(scratch());
    expect(await resolverFor("gemini").move(home, "/Users/me/never", TO)).toEqual([]);
  });
});

// --- OpenCode ---------------------------------------------------------------------------------------------------------

const HASH = "9f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
const OPENCODE_SCHEMA = [
  "create table project (id text primary key, worktree text not null, vcs text, name text, sandboxes text, time_created integer)",
  "create table project_directory (project_id text not null, directory text not null, primary key (project_id, directory))",
  "create table session (id text primary key, project_id text not null, directory text not null, title text)",
  "create table message (id text primary key, session_id text not null, role text)",
  "create table part (id text primary key, message_id text not null, text text)",
].join(";");
const OPENCODE_MESSAGES = {
  message: [
    { id: "msg_1", session_id: "ses_1", role: "user" },
    { id: "msg_2", session_id: "ses_2", role: "user" },
  ],
  part: [
    { id: "prt_1", message_id: "msg_1", text: "hi" },
    { id: "prt_2", message_id: "msg_2", text: "loose" },
  ],
};

function opencodeHome(root: string): string {
  const home = join(root, "opencode");
  seed(join(home, "opencode.db"), OPENCODE_SCHEMA, [
    ["insert into project values (?, ?, 'git', 'b_2.x', ?, 1)", [HASH, FROM, `["${FROM}-copy"]`]],
    ["insert into project values ('global', '/', null, null, '[]', 0)", []],
    ["insert into project values ('deadbeef', ?, 'git', 'b_2.x-old', '[]', 2)", [DECOY]],
    ["insert into project_directory values (?, ?)", [HASH, FROM]],
    ["insert into project_directory values (?, ?)", [HASH, FROM_SUB]],
    ["insert into project_directory values ('deadbeef', ?)", [DECOY]],
    ["insert into project_directory values ('global', ?)", ["/Users/me/scratch"]],
    ["insert into session values ('ses_1', ?, ?, 'first')", [HASH, FROM]],
    ["insert into session values ('ses_2', 'global', ?, 'loose')", ["/Users/me/scratch"]],
    ["insert into session values ('ses_3', ?, ?, 'deeper')", [HASH, FROM_SUB]],
    ["insert into session values ('ses_4', 'deadbeef', ?, 'sibling')", [DECOY]],
    ["insert into message values ('msg_1', 'ses_1', 'user')", []],
    ["insert into message values ('msg_2', 'ses_2', 'user')", []],
    ["insert into part values ('prt_1', 'msg_1', 'hi')", []],
    ["insert into part values ('prt_2', 'msg_2', 'loose')", []],
  ]);
  return home;
}

describe("opencode resolver", () => {
  it("updates project.worktree, project_directory and session.directory at the path or under it and clears sandboxes", async () => {
    const home = opencodeHome(scratch());
    const moved = await resolverFor("opencode").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "opencode.db": {
        project: [
          { id: HASH, worktree: TO, vcs: "git", name: "b_2.x", sandboxes: "[]", time_created: 1 },
          { id: "deadbeef", worktree: DECOY, vcs: "git", name: "b_2.x-old", sandboxes: "[]", time_created: 2 },
          { id: "global", worktree: "/", vcs: null, name: null, sandboxes: "[]", time_created: 0 },
        ],
        project_directory: [
          { project_id: HASH, directory: TO },
          { project_id: HASH, directory: TO_SUB },
          { project_id: "deadbeef", directory: DECOY },
          { project_id: "global", directory: "/Users/me/scratch" },
        ],
        session: [
          { id: "ses_1", project_id: HASH, directory: TO, title: "first" },
          { id: "ses_2", project_id: "global", directory: "/Users/me/scratch", title: "loose" },
          { id: "ses_3", project_id: HASH, directory: TO_SUB, title: "deeper" },
          { id: "ses_4", project_id: "deadbeef", directory: DECOY, title: "sibling" },
        ],
        ...OPENCODE_MESSAGES,
      },
    });
    expect(moved).toEqual([
      { state: "project", files: [join(home, "opencode.db")], changed: 1 },
      { state: "project directories", files: [join(home, "opencode.db")], changed: 2 },
      { state: "sessions", files: [join(home, "opencode.db")], changed: 2 },
    ]);
  });
});

// --- the core ---------------------------------------------------------------------------------------------------------

describe("project path rules", () => {
  it("a path is under the project at the root or inside it, never a sibling sharing the prefix; a trailing slash is not part of the key", () => {
    expect(underProject("/a/proj", "/a/proj")).toBe(true);
    expect(underProject("/a/proj/src/deep", "/a/proj")).toBe(true);
    expect(underProject("/a/proj2", "/a/proj")).toBe(false);
    expect(underProject("/a", "/a/proj")).toBe(false);
    expect(resolveProjectPath("/a/proj/")).toBe("/a/proj");
  });

  it("a name a machine's own archive carried stays inside the home, and a name that only starts with two dots is a folder", () => {
    // The one lexical containment rule, read by the resolvers that build a path from an index row or a registry
    // slug and by the lander that copies what they name: a second copy of it read `..cache` as a climb.
    expect(insideFolder("sessions/a.jsonl")).toBe(true);
    expect(insideFolder("..cache")).toBe(true);
    expect(insideFolder("a/..cache/b")).toBe(true);
    expect(insideFolder("..")).toBe(false);
    expect(insideFolder(join("..", "out"))).toBe(false);
    expect(insideFolder("")).toBe(false);
    expect(insideFolder("/etc/passwd")).toBe(false);

    // And through the road the resolvers take it by: a rollout row or a slug that climbs names nothing.
    expect(underHome("/root/.codex", "sessions", "a.jsonl")).toBe("/root/.codex/sessions/a.jsonl");
    expect(underHome("/root/.codex", "sessions", "../../../../etc/passwd")).toBeUndefined();
    expect(underHome("/root/.gemini", "..cache")).toBe("/root/.gemini/..cache");
    expect(underHome("/root/.gemini")).toBeUndefined();
  });
});

describe("rewriteJsonl", () => {
  it("a rewrite that fails leaves the file as it was and no .wsp-move beside it, whether the file is missing or an edit throws", async () => {
    const dir = scratch();
    const missing = join(dir, "missing.jsonl");
    // The failure lands while the write stream is still opening, so the temp file's fate is a thread-pool race; many rounds catch it.
    for (let i = 0; i < 300; i++) {
      await expect(rewriteJsonl(missing, () => true)).rejects.toThrow(/ENOENT/);
      expect(existsSync(`${missing}.wsp-move`)).toBe(false);
    }
    const file = join(dir, "s.jsonl");
    const text = lines(JSON.stringify({ cwd: FROM }), JSON.stringify({ cwd: OTHER }));
    write(file, text);
    await expect(rewriteJsonl(file, () => { throw new Error("bad line"); })).rejects.toThrow("bad line");
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(existsSync(`${file}.wsp-move`)).toBe(false);
  });
});

describe("moveProjectState", () => {
  it("registers each module under its own catalog agent, naming only measured rows of that entry", () => {
    expect(PROJECT_STATE_RESOLVERS.size).toBeGreaterThan(0);
    for (const [id, r] of PROJECT_STATE_RESOLVERS) {
      expect(r.agent).toBe(id);
      const entry = CATALOG_AGENTS.find(a => a.id === id);
      if (entry === undefined) throw new Error(`${id} is not a catalog agent`);
      const measured = entry.projectState.filter(s => s.status === "measured").map(s => s.state);
      expect(r.states.length, id).toBeGreaterThan(0);
      for (const s of r.states) expect(measured, `${id} ${s}`).toContain(s);
      expect(ProjectCarry.options, id).toContain(r.carry);
    }
  });

  it("walks every catalog agent: two present move, the four absent report nothing", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const pi = piHome(root);
    const gemini = join(root, "gemini-empty");
    mkdirSync(gemini);
    const report = await moveProjectState({ from: FROM, to: TO, homes: { claude, pi, gemini, codex: join(root, "no-such-home") } });
    expect(report.map(r => [r.agent, r.outcome])).toEqual([
      ["claude", "moved"],
      ["codex", "nothing"],
      ["gemini", "nothing"],
      ["opencode", "nothing"],
      ["pi", "moved"],
      ["hermes", "nothing"],
      ["crush", "transcript-only"],
      ["qwen", "transcript-only"],
      ["goose", "transcript-only"],
      ["amp", "transcript-only"],
    ]);
    expect(tree(claude)).toEqual(claudeAfter("-root-work-b-2-x"));
    expect(Object.keys(tree(pi))).toContain("sessions/--root-work-b_2.x--/2026-09-05T21-56-00-000Z_s1.jsonl");
    expect(report[0]).toMatchObject({ outcome: "moved", moved: [{ state: "session transcripts" }, { state: "auto memory" }] });
  });

  it("reports a catalog agent without a module as transcript-only and never touches its home", async () => {
    const root = scratch();
    const home = hermesHome(root);
    const before = tree(home);
    const report = await moveProjectState({ from: FROM, to: TO, homes: { newagent: home } }, [...CATALOG_AGENTS, { id: "newagent" }]);
    expect(report.find(r => r.agent === "newagent")).toEqual({ agent: "newagent", outcome: "transcript-only" });
    expect(report.filter(r => r.outcome === "transcript-only").map(r => r.agent)).toEqual([...CATALOG_AGENTS.filter(a => !PROJECT_STATE_RESOLVERS.has(a.id)).map(a => a.id), "newagent"]);
    expect(tree(home)).toEqual(before);
  });

  it("keys on the real path: a symlinked destination resolves before the dashed key is built", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    mkdirSync(join(root, "real", "work", "b_2.x"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const real = realpathSync(join(root, "real", "work", "b_2.x"));
    const report = await moveProjectState({ from: FROM + "/", to: join(root, "link", "work", "b_2.x"), homes: { claude } });
    expect(report[0]).toMatchObject({ agent: "claude", outcome: "moved" });
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(Object.keys(tree(claude))).toContain(`projects/${key}/S1.jsonl`);
    expect(JSON.parse((tree(claude)[`projects/${key}/S1.jsonl`] as string).split("\n")[0]!).cwd).toBe(real);
  });

  it("does nothing when the machine mirrors the old path", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const before = tree(claude);
    mkdirSync(join(root, "real", "proj"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const report = await moveProjectState({ from: join(root, "link", "proj"), to: join(root, "real", "proj"), homes: { claude } });
    expect(report.every(r => r.outcome === "nothing")).toBe(true);
    expect(tree(claude)).toEqual(before);
  });

  it("reports one agent's failure and still moves the others", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const hermes = join(root, "hermes");
    write(join(hermes, "state.db"), "not a database\n");
    const report = await moveProjectState({ from: FROM, to: TO, homes: { claude, hermes } });
    expect(report.find(r => r.agent === "hermes")).toMatchObject({ outcome: "failed", error: expect.stringMatching(/not a database/) });
    expect(report.find(r => r.agent === "claude")).toMatchObject({ outcome: "moved" });
  });
});

// --- sessions per agent -----------------------------------------------------------------------------------------------

/** Runs one agent's listing the way the machine does: the command stateListing builds, in a shell, with `into` the
 * directory on the machine the filtered copies are written under. */
function runListing(agent: string, home: string, path: string, into = scratch()): { exit: number; paths: string[]; unread: UnreadStore[]; err: string } {
  const r = spawnSync("bash", ["-c", stateListing({ [agent]: home }, path, into, [agent])], { encoding: "utf8" });
  return { exit: r.status ?? -1, ...parseStateListing(r.stdout), err: r.stderr };
}
/** The python3 source of one agent's listing, off the command the machine would run. */
function listingSource(agent: string, home: string, path: string, into: string): string {
  const command = stateListing({ [agent]: home }, path, into, [agent]);
  const opens = "set -e\npython3 -c '";
  return command.slice(opens.length, -1).replaceAll(String.raw`'\''`, "'");
}
/** The peak resident memory of the python3 a listing runs, in MB, beside the paths it named: the script is exec'd
 * inside a wrapper that reads its own rusage once it ends, since no one spelling of time(1) is on both platforms. */
function listingPeak(agent: string, home: string, path: string, into: string): { peakMb: number; paths: string[] } {
  const wrapper = [
    "import resource, sys",
    "exec(compile(sys.stdin.read(), \"listing\", \"exec\"), {})",
    // ru_maxrss is kilobytes on linux and bytes on darwin.
    'sys.stderr.write(str(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024)))',
  ].join("\n");
  const r = spawnSync("python3", ["-c", wrapper], { input: listingSource(agent, home, path, into), encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`the listing failed (exit ${r.status}): ${r.stderr}`);
  return { peakMb: Number(r.stderr), paths: r.stdout.split("\n").filter(l => l !== "") };
}

/** The store shape the cold review measured on: one Hermes store holding two projects with `per` messages of 2 KB
 * each, a session in a folder under the project, and the sibling sharing the project's prefix. The 8 KB page fits
 * two of those rows, so the store on disk is about twice the project's own slice. */
function sharedHermesStore(root: string, per: number): string {
  const home = join(root, "hermes-shared");
  const db = join(home, "state.db");
  mkdirSync(home, { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec("pragma page_size = 8192");
    d.exec(HERMES_SCHEMA);
    const body = "m".repeat(2048);
    const session = d.prepare("insert into sessions values (?, ?, ?, ?)");
    const message = d.prepare("insert into messages (session_id, content) values (?, ?)");
    d.exec("begin");
    for (const [id, cwd, n] of [["a1", FROM, per], ["a2", FROM_SUB, 1], ["b1", OTHER, per], ["o1", DECOY, 1]] as const) {
      session.run(id, cwd, cwd, n);
      for (let i = 0; i < n; i++) message.run(id, body);
    }
    d.exec("commit");
  } finally {
    d.close();
  }
  return home;
}

/** Where a module's shared store is copied to for a trip: the store's own path under the scratch root. */
function copyOf(agent: string, home: string, into: string): string {
  const shared = resolverFor(agent).shared;
  if (shared === undefined) throw new Error(`${agent} keeps no store for every project`);
  return storeCopy(into, home, shared.store);
}

describe("the listing the machine runs", () => {
  it("each module names the paths under its home it reads, and the store it keeps for every project is one of them", () => {
    expect(Object.fromEntries([...PROJECT_STATE_RESOLVERS.values()].map(r => [r.agent, r.roots]))).toEqual({
      claude: ["projects"],
      codex: ["state_5.sqlite", "sessions"],
      gemini: ["projects.json", "tmp", "history"],
      hermes: ["state.db"],
      opencode: ["opencode.db"],
      pi: ["sessions"],
    });
    expect(Object.fromEntries([...PROJECT_STATE_RESOLVERS.values()].flatMap(r => (r.shared === undefined ? [] : [[r.agent, r.shared.store]])))).toEqual({
      codex: "state_5.sqlite",
      gemini: "projects.json",
      hermes: "state.db",
      opencode: "opencode.db",
    });
    for (const r of PROJECT_STATE_RESOLVERS.values()) {
      for (const root of r.roots) expect(root, r.agent).not.toMatch(/^\/|\.\./);
      if (r.shared !== undefined) expect(r.roots, r.agent).toContain(r.shared.store);
    }
  });

  it("brings down the project's own entries and a filtered copy of each store kept for every project, never another project's, from a home holding four", () => {
    const root = scratch();
    const into = scratch();
    const claude = claudeHome(root);
    expect(runListing("claude", claude, FROM, into)).toEqual({
      exit: 0,
      err: "",
      unread: [],
      paths: [join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x"), join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub")],
    });
    const pi = piHome(root);
    expect(runListing("pi", pi, FROM, into).paths).toEqual([
      join(pi, "sessions", "--private-tmp-wsp-r212-proj-b_2.x--"),
      join(pi, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-sub--"),
    ]);
    const codex = codexHome(root);
    expect(runListing("codex", codex, FROM, into).paths).toEqual([
      copyOf("codex", codex, into),
      join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl"),
      join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl"),
    ]);
    const gemini = geminiHome(root);
    expect(runListing("gemini", gemini, FROM, into).paths).toEqual([
      copyOf("gemini", gemini, into),
      join(gemini, "tmp", "b_2.x"),
      join(gemini, "history", "b_2.x"),
      join(gemini, "tmp", "sub"),
    ]);
    const hermes = hermesHome(root);
    expect(runListing("hermes", hermes, FROM, into).paths).toEqual([copyOf("hermes", hermes, into)]);
    const opencode = opencodeHome(root);
    expect(runListing("opencode", opencode, FROM, into).paths).toEqual([copyOf("opencode", opencode, into)]);
  });

  it("Codex: the copy of the index holds the project's threads alone and the store on the machine is not touched", () => {
    const root = scratch();
    const into = scratch();
    const home = codexHome(root);
    const before = tree(home);
    expect(runListing("codex", home, FROM, into).exit).toBe(0);
    expect(rows(copyOf("codex", home, into))).toEqual({
      threads: [
        { id: "t1", rollout_path: join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl"), cwd: FROM, archived: 0, updated_at: 1 },
        { id: "t3", rollout_path: join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl"), cwd: FROM_SUB, archived: 0, updated_at: 3 },
      ],
    });
    expect(tree(home)).toEqual(before);
  });

  it("Hermes: the copy of the store holds the project's sessions and their messages alone", () => {
    const root = scratch();
    const into = scratch();
    const home = hermesHome(root);
    const before = tree(home);
    expect(runListing("hermes", home, FROM, into).exit).toBe(0);
    expect(rows(copyOf("hermes", home, into))).toEqual({
      sessions: [
        { id: "20260906_033144_55e3e2", cwd: FROM, git_repo_root: FROM, message_count: 2 },
        { id: "20260906_034000_bbbbbb", cwd: FROM, git_repo_root: null, message_count: 1 },
        { id: "20260906_035000_cccccc", cwd: FROM_SUB, git_repo_root: FROM, message_count: 1 },
      ],
      messages: [
        { id: 1, session_id: "20260906_033144_55e3e2", content: "hi" },
        { id: 2, session_id: "20260906_033144_55e3e2", content: "there" },
      ],
    });
    expect(tree(home)).toEqual(before);
  });

  it("OpenCode: the copy of the store holds the project's rows in every table, its sessions' messages and their parts alone", () => {
    const root = scratch();
    const into = scratch();
    const home = opencodeHome(root);
    const before = tree(home);
    expect(runListing("opencode", home, FROM, into).exit).toBe(0);
    expect(rows(copyOf("opencode", home, into))).toEqual({
      project: [{ id: HASH, worktree: FROM, vcs: "git", name: "b_2.x", sandboxes: `["${FROM}-copy"]`, time_created: 1 }],
      project_directory: [{ project_id: HASH, directory: FROM }, { project_id: HASH, directory: FROM_SUB }],
      session: [{ id: "ses_1", project_id: HASH, directory: FROM, title: "first" }, { id: "ses_3", project_id: HASH, directory: FROM_SUB, title: "deeper" }],
      message: [{ id: "msg_1", session_id: "ses_1", role: "user" }],
      part: [{ id: "prt_1", message_id: "msg_1", text: "hi" }],
    });
    expect(tree(home)).toEqual(before);
  });

  it("Gemini: the copy of the registry holds the project's keys alone, in the shape the agent writes", () => {
    const root = scratch();
    const into = scratch();
    const home = geminiHome(root);
    const before = tree(home);
    expect(runListing("gemini", home, FROM, into).exit).toBe(0);
    expect(readFileSync(copyOf("gemini", home, into), "utf8")).toBe(JSON.stringify({ projects: { [FROM]: "b_2.x", [FROM_SUB]: "sub" } }, null, 2) + "\n");
    expect(tree(home)).toEqual(before);
  });

  it("a second trip through the same scratch root writes the copy again rather than into the one already there", () => {
    const root = scratch();
    const into = scratch();
    const home = hermesHome(root);
    const first = runListing("hermes", home, FROM, into);
    const copied = rows(copyOf("hermes", home, into));
    expect(runListing("hermes", home, FROM, into)).toEqual(first);
    expect(rows(copyOf("hermes", home, into))).toEqual(copied);
  });

  it("a store whose schema holds a virtual table is filtered all the same: its own create makes the shadow tables", () => {
    const root = scratch();
    const into = scratch();
    const home = join(root, "hermes");
    seed(join(home, "state.db"), "create table sessions (id text primary key, cwd text, git_repo_root text, message_count integer); create virtual table notes using fts5(body); create table messages (id integer primary key, session_id text, content text)", [
      ["insert into sessions values (?, ?, ?, 1)", ["s1", FROM, FROM]],
      ["insert into sessions values (?, ?, ?, 1)", ["s2", OTHER, OTHER]],
      ["insert into notes values ('a note')", []],
    ]);
    expect(runListing("hermes", home, FROM, into)).toMatchObject({ exit: 0, paths: [copyOf("hermes", home, into)], unread: [] });
    const d = new DatabaseSync(copyOf("hermes", home, into), { readOnly: true });
    try {
      expect(d.prepare("select * from sessions order by id").all().map(r => ({ ...r }))).toEqual([{ id: "s1", cwd: FROM, git_repo_root: FROM, message_count: 1 }]);
      expect(Number((d.prepare("select count(*) as n from notes").get() as { n: number | bigint }).n)).toBe(0);
    } finally {
      d.close();
    }
  });

  it("the filter streams the project's slice into the copy: peak memory stays a fraction of the rows it writes", () => {
    const into = scratch();
    const home = sharedHermesStore(scratch(), 120_000);
    const run = listingPeak("hermes", home, FROM, into);
    expect(run.paths).toEqual([copyOf("hermes", home, into)]);
    const copied = new DatabaseSync(copyOf("hermes", home, into), { readOnly: true });
    try {
      const count = (table: string): number => Number((copied.prepare(`select count(*) as n from ${table}`).get() as { n: number | bigint }).n);
      expect(count("sessions")).toBe(2);
      expect(count("messages")).toBe(120_001);
    } finally {
      copied.close();
    }
    // 120001 rows of 2 KB is a 246 MB slice: fetchall of it peaked at 277.75 MB on this box, the fetchmany loop at 20.75 MB.
    expect(run.peakMb).toBeLessThan(64);
  }, 600_000);

  it("names nothing at all for a path no agent ran in, for a store the agent has not made and for a home that is not there", () => {
    const root = scratch();
    const into = scratch();
    const claude = claudeHome(root);
    const never = "/Users/me/never";
    expect(runListing("claude", claude, never, into).paths).toEqual([]);
    expect(runListing("pi", piHome(root), never, into).paths).toEqual([]);
    expect(runListing("codex", codexHome(root), never, into).paths).toEqual([]);
    expect(runListing("gemini", geminiHome(root), never, into).paths).toEqual([]);
    expect(runListing("hermes", hermesHome(root), never, into).paths).toEqual([]);
    expect(runListing("opencode", opencodeHome(root), never, into).paths).toEqual([]);
    // A home the agent made but never wrote its store in: its sessions tree is not the answer for the project.
    const bare = join(root, "codex-bare");
    write(join(bare, "sessions", "2026", "09", "05", "rollout-other.jsonl"), lines(codexMeta(OTHER)));
    expect(runListing("codex", bare, FROM, into).paths).toEqual([]);
    for (const agent of ["claude", "pi", "codex", "gemini", "hermes", "opencode"]) expect(runListing(agent, join(root, `${agent}-gone`), FROM, into).paths, agent).toEqual([]);
    // The sibling sharing the project's prefix is its own project, named only when it is the one asked for.
    expect(runListing("claude", claude, DECOY, into).paths).toEqual([join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x-old")]);
  });

  it("a source spelled with a trailing slash or a dot segment, as the wire carries it, names the same paths", () => {
    const claude = claudeHome(scratch());
    const into = scratch();
    const plain = runListing("claude", claude, FROM, into).paths;
    expect(plain).toHaveLength(2);
    expect(runListing("claude", claude, `${FROM}/`, into).paths).toEqual(plain);
    expect(runListing("claude", claude, `${FROM}/./`, into).paths).toEqual(plain);
  });

  it("a store on the machine it cannot read brings nothing from that home at all, and names the store and why in its place", () => {
    const root = scratch();
    const into = scratch();
    const homes: Record<string, string> = {};
    const codex = (homes["codex"] = codexHome(root));
    write(join(codex, "state_5.sqlite"), "not a database\n");
    // Never the index and never the sessions/ tree beside it, which holds every other project's rollouts.
    expect(runListing("codex", codex, FROM, into)).toEqual({
      exit: 0,
      err: "",
      paths: [],
      unread: [{ agent: "codex", store: join(codex, "state_5.sqlite"), why: "file is not a database" }],
    });
    const gemini = (homes["gemini"] = geminiHome(root));
    write(join(gemini, "projects.json"), "{ not json\n");
    const registry = runListing("gemini", gemini, FROM, into);
    // Never the registry and never the whole of tmp/ and history/, which hold every other project's chats.
    expect(registry.paths).toEqual([]);
    expect(registry.unread).toMatchObject([{ agent: "gemini", store: join(gemini, "projects.json") }]);
    expect(registry.unread[0]!.why).toMatch(/Expecting property name/);
    const hermes = (homes["hermes"] = hermesHome(root));
    write(join(hermes, "state.db"), "not a database\n");
    expect(runListing("hermes", hermes, FROM, into)).toEqual({
      exit: 0,
      err: "",
      paths: [],
      unread: [{ agent: "hermes", store: join(hermes, "state.db"), why: "file is not a database" }],
    });
    const opencode = (homes["opencode"] = opencodeHome(root));
    write(join(opencode, "opencode.db"), "not a database\n");
    expect(runListing("opencode", opencode, FROM, into).unread).toEqual([{ agent: "opencode", store: join(opencode, "opencode.db"), why: "file is not a database" }]);
    // Nor a half written copy under the scratch root, which the trip would have pulled at the store's own path.
    for (const [agent, home] of Object.entries(homes)) expect(existsSync(copyOf(agent, home, into)), agent).toBe(false);
  });

  it("every listing and the merge open with the one preamble, so the rule for a path at the project or under it is defined once", () => {
    const definitions = (script: string): number => script.split("def under(").length - 1;
    const into = scratch();
    for (const r of PROJECT_STATE_RESOLVERS.values()) {
      const script = listingSource(r.agent, join("/root", `.${r.agent}`), FROM, into);
      expect(script.startsWith(PY_PREAMBLE), r.agent).toBe(true);
      expect(definitions(script), r.agent).toBe(1);
    }
    const merge = mergeScript(FROM, TO, []);
    expect(merge.startsWith(PY_PREAMBLE)).toBe(true);
    expect(definitions(merge)).toBe(1);
  });

  it("stateListing runs one python3 per agent with a home and a module, narrows to the agents named and refuses an id the catalog does not know", () => {
    const homes = guestAgentHomes();
    const into = scratch();
    const runs = (command: string): number => command.split("\npython3 -c '").length - 1;
    const command = stateListing(homes, FROM, into);
    expect(command.startsWith("set -e\npython3 -c '")).toBe(true);
    expect(runs(command)).toBe(PROJECT_STATE_RESOLVERS.size);
    const carried = (value: string): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    for (const [id, home] of Object.entries(homes)) expect(command.includes(carried(home)), id).toBe(PROJECT_STATE_RESOLVERS.has(id));
    expect(command).toContain(carried(FROM));
    for (const r of PROJECT_STATE_RESOLVERS.values()) if (r.shared !== undefined) expect(command).toContain(carried(storeCopy(into, homes[r.agent]!, r.shared.store)));
    expect(runs(stateListing(homes, FROM, into, ["pi", "claude"]))).toBe(2);
    expect(runs(stateListing({ claude: "/x/.claude" }, FROM, into))).toBe(1);
    expect(stateListing({}, FROM, into)).toBe("");
    expect(() => stateListing(homes, FROM, into, ["claude", "codx"])).toThrow(`no agent called codx; the catalog knows ${CATALOG_AGENTS.map(a => a.id).join(", ")}`);
  });
});

describe("sessions", () => {
  it("counts every agent's sessions at the path or under it: never a sibling sharing the prefix, another project or a subagent transcript", async () => {
    const root = scratch();
    expect(await resolverFor("claude").sessions(claudeHome(root), FROM)).toBe(2);
    expect(await resolverFor("pi").sessions(piHome(root), FROM)).toBe(2);
    expect(await resolverFor("codex").sessions(codexHome(root), FROM)).toBe(2);
    expect(await resolverFor("hermes").sessions(hermesHome(root), FROM)).toBe(3);
    expect(await resolverFor("gemini").sessions(geminiHome(root), FROM)).toBe(1);
    expect(await resolverFor("opencode").sessions(opencodeHome(root), FROM)).toBe(2);
  });

  it("counts one for a sub-folder alone and nothing for a path no agent ran in or an empty home", async () => {
    const root = scratch();
    const homes = { claude: claudeHome(root), pi: piHome(root), codex: codexHome(root), hermes: hermesHome(root), gemini: geminiHome(root), opencode: opencodeHome(root) };
    expect(await resolverFor("claude").sessions(homes.claude, FROM_SUB)).toBe(1);
    expect(await resolverFor("codex").sessions(homes.codex, FROM_SUB)).toBe(1);
    for (const [agent, home] of Object.entries(homes)) {
      expect(await resolverFor(agent).sessions(home, "/Users/me/never"), agent).toBe(0);
      const empty = join(root, `${agent}-empty`);
      mkdirSync(empty);
      expect(await resolverFor(agent).sessions(empty, FROM), agent).toBe(0);
    }
  });

  it("a Claude Code directory holding memory alone is zero sessions", async () => {
    const home = join(scratch(), "claude");
    write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x", "memory", "MEMORY.md"), "notes\n");
    expect(await resolverFor("claude").sessions(home, FROM)).toBe(0);
  });
});

describe("entries", () => {
  it("names the files holding the project's state alone: keyed directories whole, indexed rollouts, slug directories; never a shared index or another project's", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const key = join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x");
    expect(await resolverFor("claude").entries(claude, FROM)).toEqual([
      join(key, "S1.jsonl"),
      join(key, "S1", "subagents", "agent-a1.jsonl"),
      join(key, "S1", "tool-results", "t1.txt"),
      join(key, "memory", "MEMORY.md"),
      join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub", "S3.jsonl"),
    ]);
    const pi = piHome(root);
    expect(await resolverFor("pi").entries(pi, FROM)).toEqual([
      join(pi, "sessions", "--private-tmp-wsp-r212-proj-b_2.x--", "2026-09-05T21-56-00-000Z_s1.jsonl"),
      join(pi, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-sub--", "2026-09-05T21-57-00-000Z_s2.jsonl"),
    ]);
    const codex = codexHome(root);
    expect(await resolverFor("codex").entries(codex, FROM)).toEqual([
      join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl"),
      join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl"),
    ]);
    const gemini = geminiHome(root);
    expect(await resolverFor("gemini").entries(gemini, FROM)).toEqual([
      join(gemini, "history", "b_2.x", ".project_root"),
      join(gemini, "tmp", "b_2.x", ".project_root"),
      join(gemini, "tmp", "b_2.x", "chats", "session-2026-09-05T21-59-a1b2c3d4.jsonl"),
      join(gemini, "tmp", "sub", ".project_root"),
    ]);
    expect(await resolverFor("hermes").entries(hermesHome(root), FROM)).toEqual([]);
    expect(await resolverFor("opencode").entries(opencodeHome(root), FROM)).toEqual([]);
    for (const [agent, home] of [["claude", claude], ["pi", pi], ["codex", codex], ["gemini", gemini]] as const) expect(await resolverFor(agent).entries(home, "/Users/me/never"), agent).toEqual([]);
  });
});

const bytesOf = (files: readonly string[]): number => files.reduce((n, f) => n + statSync(f).size, 0);

describe("countProjectState", () => {
  it("lists each agent whose home holds sessions for the folder with its catalog name, in catalog order, skipping absent homes and agents with none", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const pi = piHome(root);
    const gemini = join(root, "gemini-empty");
    mkdirSync(gemini);
    const rows = await countProjectState(FROM, { claude, pi, gemini, codex: join(root, "no-such-home") });
    expect(rows).toEqual([
      { agent: "claude", name: "Claude Code", sessions: 2, bytes: bytesOf(await resolverFor("claude").entries(claude, FROM)), carry: "moves" },
      { agent: "pi", name: "Pi", sessions: 2, bytes: bytesOf(await resolverFor("pi").entries(pi, FROM)), carry: "moves" },
    ]);
    expect(rows[0]!.bytes).toBeGreaterThan(rows[1]!.bytes);
    const rows2 = await countProjectState(FROM, { codex: codexHome(root), gemini: geminiHome(root), hermes: hermesHome(root), opencode: opencodeHome(root) });
    expect(rows2.map(r => [r.agent, r.sessions, r.carry, r.bytes > 0])).toEqual([
      ["codex", 2, "transcript-only", true],
      ["gemini", 1, "transcript-only", true],
      ["opencode", 2, "transcript-only", false],
      ["hermes", 3, "transcript-only", false],
    ]);
  });

  it("keys on the real path and skips a catalog agent with no module, whose home it never opens", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    mkdirSync(join(root, "real", "proj"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const real = realpathSync(join(root, "real", "proj"));
    write(join(claude, "projects", real.replace(/[^A-Za-z0-9]/g, "-"), "S7.jsonl"), lines(claudeUser(real)));
    const hermes = hermesHome(root);
    const before = tree(hermes);
    const rows = await countProjectState(join(root, "link", "proj") + "/", { claude, newagent: hermes }, [...CATALOG_AGENTS, { id: "newagent", name: "New" }]);
    expect(rows).toEqual([{ agent: "claude", name: "Claude Code", sessions: 1, bytes: expect.any(Number), carry: "moves" }]);
    expect(tree(hermes)).toEqual(before);
  });

  it("an agent whose store cannot be read keeps its row with the reason, and the other agents are still counted", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const opencode = join(root, "opencode");
    write(join(opencode, "opencode.db"), "not a database\n");
    const rows = await countProjectState(FROM, { claude, opencode, pi: piHome(root) });
    expect(rows).toEqual([
      { agent: "claude", name: "Claude Code", sessions: 2, bytes: expect.any(Number), carry: "moves" },
      { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "transcript-only", error: expect.stringMatching(/not a database/) },
      { agent: "pi", name: "Pi", sessions: 2, bytes: expect.any(Number), carry: "moves" },
    ]);
  });

  it("agentHomes places every registered agent's home under the given home directory", () => {
    const homes = agentHomes("/Users/me");
    expect(Object.keys(homes)).toEqual(CATALOG_AGENTS.map(a => a.id));
    expect(homes["claude"]).toBe("/Users/me/.claude");
    expect(homes["opencode"]).toBe("/Users/me/.local/share/opencode");
    expect(homes["pi"]).toBe("/Users/me/.pi/agent");
    const guest = guestAgentHomes();
    expect(Object.keys(guest)).toEqual(CATALOG_AGENTS.map(a => a.id));
    expect(guest["claude"]).toBe("/root/.claude-cfg");
    expect(guest["codex"]).toBe("/root/.codex");
  });

  it("one harness's home under a home directory is one rule, read by every kind whose machine answers with a home", () => {
    // The folder the person's own store variable names wins, else the catalog's, and an id the catalog does not
    // carry gets a folder of its own name rather than nothing.
    expect(agentHome("/Users/me", "claude")).toBe("/Users/me/.claude");
    expect(agentHome("/Users/me", "claude", { CLAUDE_CONFIG_DIR: "/Users/me/.claude-cfg" })).toBe("/Users/me/.claude-cfg");
    expect(agentHome("/root", "codex")).toBe("/root/.codex");
    expect(agentHome("/root", "nobody")).toBe("/root/.nobody");
  });
});

// --- the merge on the machine -----------------------------------------------------------------------------------------
// The rows an agent keeps in a store shared with other projects cannot land as files, so the module emits a script the
// machine runs: here python3 runs it over a fake machine home that already holds another project's rows.

const mergeFor = (agent: string): NonNullable<ProjectStateResolver["merge"]> => {
  const merge = resolverFor(agent).merge;
  if (merge === undefined) throw new Error(`${agent} has no merge`);
  return merge.bind(resolverFor(agent));
};

/** Runs the script as the runtime does on the machine: python3 over a file, the last stdout line as the result. */
function runMerge(script: string): { exit: number; out: MergeOutput | undefined; err: string } {
  const file = join(scratch(), "merge.py");
  writeFileSync(file, script);
  const r = spawnSync("python3", [file], { encoding: "utf8" });
  let out: MergeOutput | undefined;
  try {
    out = parseMergeOutput(r.stdout);
  } catch {
    out = undefined;
  }
  return { exit: r.status ?? -1, out, err: r.stderr };
}

/** A machine's Codex home after the overlay landed: its own thread for another project, and the project's rollouts
 * as they left this computer, cwd unrewritten because the skeleton had no index to name them. */
function codexGuest(root: string): string {
  const guest = join(root, "guest-codex");
  const t2 = join(guest, "sessions", "2026", "09", "04", "rollout-2026-09-04T10-00-00-t2.jsonl");
  write(t2, lines(codexMeta(OTHER), codexItem, codexTurn(OTHER)));
  write(join(guest, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl"), lines(codexMeta(FROM), codexItem, codexTurn(FROM), codexEvent));
  write(join(guest, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl"), lines(codexMeta(FROM_SUB), codexItem, codexTurn(FROM_SUB)));
  seed(join(guest, "state_5.sqlite"), CODEX_SCHEMA, [["insert into threads values (?, ?, ?, 0, 7)", ["t2", t2, OTHER]]]);
  return guest;
}

describe("merge on the machine", () => {
  it("Codex: the project's thread rows land in the machine's index at the machine paths, the landed rollouts get their cwd, the machine's own rows stay, a thread whose rollout never travelled is not listed, and a second run changes nothing", async () => {
    const root = scratch();
    const mac = codexHome(root);
    const guest = codexGuest(root);
    seed(join(mac, "state_5.sqlite"), "", [["insert into threads values ('t5', ?, ?, 1, 5)", [join(mac, "archived_sessions", "rollout-2026-09-01T09-00-00-t5.jsonl"), FROM]]]);
    const before = tree(mac);
    const script = await mergeFor("codex")(mac, FROM, TO, guest);
    if (script === undefined) throw new Error("no script");
    expect(runMerge(script)).toEqual({ exit: 0, out: { merged: 2, kept: 0 }, err: "" });
    const t1 = join(guest, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const t2 = join(guest, "sessions", "2026", "09", "04", "rollout-2026-09-04T10-00-00-t2.jsonl");
    const t3 = join(guest, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl");
    const after = {
      "sessions/2026/09/04/rollout-2026-09-04T10-00-00-t2.jsonl": lines(codexMeta(OTHER), codexItem, codexTurn(OTHER)),
      "sessions/2026/09/05/rollout-2026-09-05T21-58-00-t1.jsonl": lines(codexMeta(TO), codexItem, codexTurn(TO), codexEvent),
      "sessions/2026/09/05/rollout-2026-09-05T22-00-00-t3.jsonl": lines(codexMeta(TO_SUB), codexItem, codexTurn(TO_SUB)),
      "state_5.sqlite": {
        threads: [
          { id: "t1", rollout_path: t1, cwd: TO, archived: 0, updated_at: 1 },
          { id: "t2", rollout_path: t2, cwd: OTHER, archived: 0, updated_at: 7 },
          { id: "t3", rollout_path: t3, cwd: TO_SUB, archived: 0, updated_at: 3 },
        ],
      },
    };
    expect(tree(guest)).toEqual(after);
    expect(runMerge(script)).toEqual({ exit: 0, out: { merged: 0, kept: 2 }, err: "" });
    expect(tree(guest)).toEqual(after);
    expect(tree(mac)).toEqual(before);
  });

  it("Codex: a rollout line that is not UTF-8 passes through byte for byte while the cwd lines around it are rewritten", async () => {
    const root = scratch();
    const mac = codexHome(root);
    const guest = codexGuest(root);
    const t1 = join(guest, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const raw = Buffer.concat([Buffer.from('{"type":"raw","data":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]);
    appendFileSync(t1, raw);
    const script = await mergeFor("codex")(mac, FROM, TO, guest);
    expect(runMerge(script!)).toEqual({ exit: 0, out: { merged: 2, kept: 0 }, err: "" });
    expect(readFileSync(t1)).toEqual(Buffer.concat([Buffer.from(lines(codexMeta(TO), codexItem, codexTurn(TO), codexEvent)), raw]));
  });

  it("Codex: a thread the machine already lists keeps its own columns and gets only cwd and rollout_path", async () => {
    const root = scratch();
    const mac = codexHome(root);
    const guest = codexGuest(root);
    const t1 = join(guest, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    seed(join(guest, "state_5.sqlite"), "", [["insert into threads values ('t1', ?, ?, 1, 9)", ["/Users/me/.codex/sessions/2026/09/05/rollout-2026-09-05T21-58-00-t1.jsonl", FROM]]]);
    const script = await mergeFor("codex")(mac, FROM, TO, guest);
    expect(runMerge(script!).out).toEqual({ merged: 2, kept: 0 });
    expect((tree(guest)["state_5.sqlite"] as Record<string, unknown[]>)["threads"]).toEqual([
      { id: "t1", rollout_path: t1, cwd: TO, archived: 1, updated_at: 9 },
      expect.objectContaining({ id: "t2" }),
      expect.objectContaining({ id: "t3" }),
    ]);
  });

  it("a machine without the store waits and gets no store; a store whose table lacks a column fails and is left as it was", async () => {
    const root = scratch();
    const mac = codexHome(root);
    const empty = join(root, "guest-empty");
    mkdirSync(empty);
    const script = await mergeFor("codex")(mac, FROM, TO, empty);
    expect(runMerge(script!)).toEqual({ exit: 0, out: { waiting: `no ${join(empty, "state_5.sqlite")} on the machine` }, err: "" });
    expect(tree(empty)).toEqual({});
    const old = join(root, "guest-old");
    seed(join(old, "state_5.sqlite"), "create table threads (id text primary key, rollout_path text not null, cwd text not null)", [["insert into threads values ('t2', 'x', ?)", [OTHER]]]);
    const before = tree(old);
    const run = runMerge((await mergeFor("codex")(mac, FROM, TO, old))!);
    expect(run.exit).toBe(1);
    expect(run.out).toBeUndefined();
    expect(run.err).toMatch(/no column named archived|has no column named archived/);
    expect(tree(old)).toEqual(before);
  });

  it("Hermes: the sessions at the path or under it land with cwd and git_repo_root moved, a null root stays null, their messages land under the machine's own ids, the machine's rows and messages stay", async () => {
    const root = scratch();
    const mac = hermesHome(root);
    const guest = join(root, "guest-hermes");
    seed(join(guest, "state.db"), HERMES_SCHEMA, [
      ["insert into sessions values (?, ?, ?, 1)", ["20260906_030000_aaaaaa", "/root/other", "/root/other"]],
      ["insert into messages values (1, ?, 'theirs')", ["20260906_030000_aaaaaa"]],
    ]);
    const script = await mergeFor("hermes")(mac, FROM, TO, guest);
    expect(runMerge(script!)).toEqual({ exit: 0, out: { merged: 5, kept: 0 }, err: "" });
    const after = {
      "state.db": {
        sessions: [
          { id: "20260906_030000_aaaaaa", cwd: "/root/other", git_repo_root: "/root/other", message_count: 1 },
          { id: "20260906_033144_55e3e2", cwd: TO, git_repo_root: TO, message_count: 2 },
          { id: "20260906_034000_bbbbbb", cwd: TO, git_repo_root: null, message_count: 1 },
          { id: "20260906_035000_cccccc", cwd: TO_SUB, git_repo_root: TO, message_count: 1 },
        ],
        messages: [
          { id: 1, session_id: "20260906_030000_aaaaaa", content: "theirs" },
          { id: 2, session_id: "20260906_033144_55e3e2", content: "hi" },
          { id: 3, session_id: "20260906_033144_55e3e2", content: "there" },
        ],
      },
    };
    expect(tree(guest)).toEqual(after);
    expect(runMerge(script!).out).toEqual({ merged: 0, kept: 5 });
    expect(tree(guest)).toEqual(after);
  });

  it("Hermes: a session whose messages the machine already holds keeps them as they are, even when this computer has more", async () => {
    const root = scratch();
    const mac = hermesHome(root);
    const guest = join(root, "guest-hermes");
    seed(join(guest, "state.db"), HERMES_SCHEMA, [
      ["insert into sessions values (?, ?, ?, 1)", ["20260906_033144_55e3e2", TO, TO]],
      ["insert into messages values (7, ?, 'edited here')", ["20260906_033144_55e3e2"]],
    ]);
    expect(runMerge((await mergeFor("hermes")(mac, FROM, TO, guest))!).out).toEqual({ merged: 2, kept: 3 });
    expect((tree(guest)["state.db"] as Record<string, unknown[]>)["messages"]).toEqual([{ id: 7, session_id: "20260906_033144_55e3e2", content: "edited here" }]);
  });

  it("OpenCode: the project row keeps its id and takes the machine path with sandboxes cleared, its directories, sessions, messages and parts land, the global project and its sessions stay", async () => {
    const root = scratch();
    const mac = opencodeHome(root);
    const guest = join(root, "guest-opencode");
    seed(join(guest, "opencode.db"), OPENCODE_SCHEMA, [
      ["insert into project values (?, '/root/elsewhere/b_2.x', 'git', 'b_2.x', ?, 5)", [HASH, `["/root/elsewhere/b_2.x-copy"]`]],
      ["insert into project values ('global', '/', null, null, '[]', 0)", []],
      ["insert into project_directory values ('global', '/root/scratch')", []],
      ["insert into session values ('ses_9', 'global', '/root/scratch', 'theirs')", []],
      ["insert into message values ('msg_9', 'ses_9', 'user')", []],
      ["insert into part values ('prt_9', 'msg_9', 'theirs')", []],
    ]);
    const script = await mergeFor("opencode")(mac, FROM, TO, guest);
    expect(runMerge(script!)).toEqual({ exit: 0, out: { merged: 7, kept: 0 }, err: "" });
    const after = {
      "opencode.db": {
        project: [
          { id: HASH, worktree: TO, vcs: "git", name: "b_2.x", sandboxes: "[]", time_created: 5 },
          { id: "global", worktree: "/", vcs: null, name: null, sandboxes: "[]", time_created: 0 },
        ],
        project_directory: [
          { project_id: HASH, directory: TO },
          { project_id: HASH, directory: TO_SUB },
          { project_id: "global", directory: "/root/scratch" },
        ],
        session: [
          { id: "ses_1", project_id: HASH, directory: TO, title: "first" },
          { id: "ses_3", project_id: HASH, directory: TO_SUB, title: "deeper" },
          { id: "ses_9", project_id: "global", directory: "/root/scratch", title: "theirs" },
        ],
        message: [
          { id: "msg_1", session_id: "ses_1", role: "user" },
          { id: "msg_9", session_id: "ses_9", role: "user" },
        ],
        part: [
          { id: "prt_1", message_id: "msg_1", text: "hi" },
          { id: "prt_9", message_id: "msg_9", text: "theirs" },
        ],
      },
    };
    expect(tree(guest)).toEqual(after);
    expect(runMerge(script!).out).toEqual({ merged: 0, kept: 7 });
    expect(tree(guest)).toEqual(after);
  });

  it("Gemini: the registry keys for the root and the sub-folder land with their slugs, the landed .project_root files get the machine path, the machine's own key stays; a machine without a registry gets one", async () => {
    const root = scratch();
    const mac = geminiHome(root);
    const guest = join(root, "guest-gemini");
    write(join(guest, "projects.json"), JSON.stringify({ projects: { "/root/other": "other" } }, null, 2) + "\n");
    write(join(guest, "tmp", "other", ".project_root"), "/root/other");
    write(join(guest, "tmp", "b_2.x", ".project_root"), FROM);
    write(join(guest, "tmp", "b_2.x", "chats", "session-2026-09-05T21-59-a1b2c3d4.jsonl"), geminiChat);
    write(join(guest, "history", "b_2.x", ".project_root"), FROM + "\n");
    write(join(guest, "tmp", "sub", ".project_root"), FROM_SUB);
    const script = await mergeFor("gemini")(mac, FROM, TO, guest);
    expect(runMerge(script!)).toEqual({ exit: 0, out: { merged: 2, kept: 0 }, err: "" });
    const after = {
      "projects.json": JSON.stringify({ projects: { "/root/other": "other", [TO]: "b_2.x", [TO_SUB]: "sub" } }, null, 2) + "\n",
      "tmp/other/.project_root": "/root/other",
      "tmp/b_2.x/.project_root": TO,
      "tmp/b_2.x/chats/session-2026-09-05T21-59-a1b2c3d4.jsonl": geminiChat,
      "history/b_2.x/.project_root": TO + "\n",
      "tmp/sub/.project_root": TO_SUB,
    };
    expect(tree(guest)).toEqual(after);
    expect(runMerge(script!).out).toEqual({ merged: 0, kept: 2 });
    expect(tree(guest)).toEqual(after);
    const bare = join(root, "guest-bare");
    expect(runMerge((await mergeFor("gemini")(mac, FROM, TO, bare))!).out).toEqual({ merged: 2, kept: 0 });
    expect(tree(bare)).toEqual({ "projects.json": JSON.stringify({ projects: { [TO]: "b_2.x", [TO_SUB]: "sub" } }, null, 2) + "\n" });
  });

  it("Gemini: a slug another path on the machine already owns fails naming it, and the registry is left as it was", async () => {
    const root = scratch();
    const mac = geminiHome(root);
    const guest = join(root, "guest-gemini");
    const registry = JSON.stringify({ projects: { "/root/other/b_2.x": "b_2.x" } }) + "\n";
    write(join(guest, "projects.json"), registry);
    const run = runMerge((await mergeFor("gemini")(mac, FROM, TO, guest))!);
    expect(run).toEqual({ exit: 1, out: undefined, err: `slug b_2.x already belongs to /root/other/b_2.x in ${join(guest, "projects.json")}\n` });
    expect(tree(guest)).toEqual({ "projects.json": registry });
  });

  it("Gemini: a destination the machine already maps to its own slug keeps that slug and counts kept with a note; its own chats stay listed", async () => {
    const root = scratch();
    const mac = geminiHome(root);
    const guest = join(root, "guest-gemini");
    write(join(guest, "projects.json"), JSON.stringify({ projects: { [TO]: "proj" } }, null, 2) + "\n");
    write(join(guest, "tmp", "proj", ".project_root"), TO);
    write(join(guest, "tmp", "proj", "chats", "session-2026-09-06T01-00-ffffffff.jsonl"), geminiChat);
    write(join(guest, "tmp", "b_2.x", ".project_root"), FROM);
    write(join(guest, "tmp", "b_2.x", "chats", "session-2026-09-05T21-59-a1b2c3d4.jsonl"), geminiChat);
    write(join(guest, "tmp", "sub", ".project_root"), FROM_SUB);
    const script = await mergeFor("gemini")(mac, FROM, TO, guest);
    const note = `the machine already lists ${TO} as proj, so that slug stays and the carried chats under tmp/b_2.x are not listed there`;
    expect(runMerge(script!)).toEqual({ exit: 0, out: { merged: 1, kept: 1, note }, err: "" });
    const after = {
      "projects.json": JSON.stringify({ projects: { [TO]: "proj", [TO_SUB]: "sub" } }, null, 2) + "\n",
      "tmp/proj/.project_root": TO,
      "tmp/proj/chats/session-2026-09-06T01-00-ffffffff.jsonl": geminiChat,
      "tmp/b_2.x/.project_root": TO,
      "tmp/b_2.x/chats/session-2026-09-05T21-59-a1b2c3d4.jsonl": geminiChat,
      "tmp/sub/.project_root": TO_SUB,
    };
    expect(tree(guest)).toEqual(after);
    expect(runMerge(script!).out).toEqual({ merged: 0, kept: 2, note });
    expect(tree(guest)).toEqual(after);
  });

  it("Gemini: a later key's slug conflict fails before any marker of an earlier key is rewritten", async () => {
    const root = scratch();
    const mac = geminiHome(root);
    const guest = join(root, "guest-gemini");
    const registry = JSON.stringify({ projects: { "/root/other/sub": "sub" } }) + "\n";
    write(join(guest, "projects.json"), registry);
    write(join(guest, "tmp", "b_2.x", ".project_root"), FROM);
    const run = runMerge((await mergeFor("gemini")(mac, FROM, TO, guest))!);
    expect(run).toEqual({ exit: 1, out: undefined, err: `slug sub already belongs to /root/other/sub in ${join(guest, "projects.json")}\n` });
    expect(tree(guest)).toEqual({ "projects.json": registry, "tmp/b_2.x/.project_root": FROM });
  });

  it("a home with no row for the path emits no script; the agents whose files carry every key have no merge", async () => {
    const root = scratch();
    for (const [agent, home] of [["codex", codexHome(root)], ["hermes", hermesHome(root)], ["opencode", opencodeHome(root)], ["gemini", geminiHome(root)]] as const) {
      expect(await mergeFor(agent)(home, "/Users/me/never", TO, "/root/x"), agent).toBeUndefined();
      const empty = join(root, `${agent}-empty`);
      mkdirSync(empty);
      expect(await mergeFor(agent)(empty, FROM, TO, "/root/x"), agent).toBeUndefined();
    }
    expect(resolverFor("claude").merge).toBeUndefined();
    expect(resolverFor("pi").merge).toBeUndefined();
  });

  it("the script's result is its last line; anything else is an error naming what came back", () => {
    expect(parseMergeOutput('noise\n{"merged": 2, "kept": 1}\n')).toEqual({ merged: 2, kept: 1 });
    expect(parseMergeOutput('{"waiting": "no store"}')).toEqual({ waiting: "no store" });
    expect(parseMergeOutput('{"merged": 0, "kept": 1, "note": "kept as it was"}')).toEqual({ merged: 0, kept: 1, note: "kept as it was" });
    expect(() => parseMergeOutput("Traceback\n")).toThrow(/Traceback/);
    expect(() => parseMergeOutput("")).toThrow(/nothing/);
    expect(() => parseMergeOutput('{"merged": "x"}')).toThrow(/merged/);
  });
});
