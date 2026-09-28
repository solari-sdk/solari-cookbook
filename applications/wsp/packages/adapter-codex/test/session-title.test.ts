// SPDX-License-Identifier: AGPL-3.0-only
// The db is built with the columns of the real thread index measured on
// codex-cli 0.153.0 (~/.codex/state_5.sqlite, table threads): title is NOT
// NULL and carries the thread's opening words, name is null until the person
// names the thread.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRenameWrite } from "@wsp/protocol";
import { parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "../src/session-title.js";

const THREAD = "01a079b6-6f04-7f73-84d6-40e9e6885ffd";
const SCHEMA = "create table threads (id text primary key, rollout_path text not null, cwd text not null, title text not null, name text);";
const run = promisify(execFile);

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A CODEX_HOME with one state db per version named, each seeded with the rows given. */
async function codexHome(dbs: Record<string, string[]>): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "wsp-codex-title-"));
  homes.push(home);
  for (const [name, rows] of Object.entries(dbs)) {
    await run("sqlite3", [join(home, name), [SCHEMA, ...rows].join("\n")]);
  }
  return home;
}

const row = (id: string, title: string, name: string | null): string =>
  `insert into threads (id, rollout_path, cwd, title, name) values ('${id}', 'sessions/r.jsonl', '/root/work', '${title}', ${name === null ? "null" : `'${name}'`});`;

/** The command as the guest runs it: one bash line, its stdout read the way the adapter reads it. */
const titleOf = async (home: string, threadId: string): Promise<string | null> =>
  parseSessionTitle((await run("bash", ["-c", sessionTitleCommand({ home, threadId })])).stdout);

describe("the title Codex keeps for a thread", () => {
  it("is the title its index derived from the thread's opening words", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", null)] });
    expect(await titleOf(home, THREAD)).toBe("say hi");
  });

  it("is the name the person gave the thread once it has one", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", "the codex thread")] });
    expect(await titleOf(home, THREAD)).toBe("the codex thread");
  });

  it("comes out of the highest schema version, not the last name in the folder", async () => {
    const home = await codexHome({
      "state_5.sqlite": [row(THREAD, "old schema", null)],
      "state_10.sqlite": [row(THREAD, "live schema", null)],
    });
    expect(await titleOf(home, THREAD)).toBe("live schema");
  });

  it("is nothing when the index has no such thread, and nothing when the home has no state db", async () => {
    const home = await codexHome({ "state_5.sqlite": [row("01a079b6-bba9-77d1-8eed-a6f11fd839b4", "another thread", null)] });
    expect(await titleOf(home, THREAD)).toBeNull();
    expect(await titleOf(await codexHome({}), THREAD)).toBeNull();
  });

  it("survives a name holding a quote and a newline, which is why the row comes back as JSON", async () => {
    const home = await codexHome({ "state_5.sqlite": [`insert into threads (id, rollout_path, cwd, title, name) values ('${THREAD}', 'r', '/root', 'x', 'it''s' || char(10) || 'here');`] });
    expect(await titleOf(home, THREAD)).toBe("it's\nhere");
  });

  it("refuses a thread id that is not a plain slug, so nothing rides into the query unquoted", () => {
    expect(() => sessionTitleCommand({ home: "/root/.codex", threadId: "x' or '1'='1" })).toThrow(/plain slug/);
    expect(sessionTitleCommand({ home: "/root/it's here", threadId: THREAD })).toContain(String.raw`cd '/root/it'\''s here'`);
  });
});

/** A folder holding a `codex` that answers whatever the test wants, first on PATH: what is under test is a shell
 * line, so the binary it runs has to be a real one. */
function fakeCodex(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-codex-bin-"));
  homes.push(root);
  const bin = join(root, "codex");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return root;
}

describe("the title Codex makes for a thread", () => {
  it("runs the question as a read-only turn with the prompt on stdin, and reads the answer off the last agent message", async () => {
    const seen = join(mkdtempSync(join(tmpdir(), "wsp-codex-seen-")), "seen");
    const bin = fakeCodex(
      `{ printf '%s\\n' "$*"; cat; } > ${seen}\n` +
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking"}}' '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Seed thread titles here"}}'`,
    );
    const prompt = "Name it. It's a thread's own \"words\"; nothing else.";
    const command = titleForCommand({ home: "/root/.codex", prompt, model: "gpt-5.2" });
    const { stdout } = await run("bash", ["-c", command], { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: tmpdir() } });
    expect(parseTitleFor(stdout)).toBe("Seed thread titles here");
    const [argv, ...rest] = readFileSync(seen, "utf8").split("\n");
    expect(argv).toContain(`sandbox_mode="read-only"`);
    expect(argv).toContain(`approval_policy="never"`);
    expect(argv).toContain("-m gpt-5.2");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(rest.join("\n").trim()).toBe(prompt);
  });

  it("runs under the session's own CODEX_HOME, which a guest exec would not carry", () => {
    expect(titleForCommand({ home: "/root/it's here", prompt: "name it" })).toContain(String.raw`CODEX_HOME='/root/it'\''s here'`);
  });

  it("reads no title out of a turn that failed, said nothing, or explained itself over several lines", () => {
    expect(parseTitleFor('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')).toBeNull();
    expect(parseTitleFor("")).toBeNull();
    expect(parseTitleFor('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Here it is:\\nA title"}}')).toBeNull();
    expect(parseTitleFor('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Seed thread titles here"}}')).toBe("Seed thread titles here");
  });
});

/** The rename as the guest runs it: one bash line, its stdout read the way the adapter reads it. */
const renameTo = async (home: string, threadId: string, title: string): Promise<SessionRenameWrite> =>
  parseRename((await run("bash", ["-c", renameCommand({ home, threadId, title })])).stdout);

/** The name column as sqlite holds it, read past the adapter's own precedence. */
const nameOf = async (home: string, db: string, threadId: string): Promise<string> =>
  (await run("sqlite3", [join(home, db), `select coalesce(name, '<null>') from threads where id = '${threadId}';`])).stdout.trim();

describe("naming a Codex thread from wsp", () => {
  it("sets the name column the CLI's own rename writes, leaving the derived title where it is, and the read gives it back", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", null)] });
    expect(await renameTo(home, THREAD, "the name he typed in wsp")).toEqual({ kind: "written" });
    expect(await nameOf(home, "state_5.sqlite", THREAD)).toBe("the name he typed in wsp");
    expect((await run("sqlite3", [join(home, "state_5.sqlite"), `select title from threads where id = '${THREAD}';`])).stdout.trim()).toBe("say hi");
    expect(await titleOf(home, THREAD)).toBe("the name he typed in wsp");
  });

  it("names the thread in the highest schema version, the db the read picks too", async () => {
    const home = await codexHome({
      "state_5.sqlite": [row(THREAD, "old schema", null)],
      "state_10.sqlite": [row(THREAD, "live schema", null)],
    });
    expect(await renameTo(home, THREAD, "the live name")).toEqual({ kind: "written" });
    expect(await nameOf(home, "state_10.sqlite", THREAD)).toBe("the live name");
    expect(await nameOf(home, "state_5.sqlite", THREAD)).toBe("<null>");
  });

  it("keeps a name holding a quote and a newline, and takes one over an earlier one", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", "an older name")] });
    expect(await renameTo(home, THREAD, "it's\nhere")).toEqual({ kind: "written" });
    expect(await titleOf(home, THREAD)).toBe("it's\nhere");
  });

  it("says no session only when the index answered and holds no such thread; a home with no index at all is a failure naming it", async () => {
    const home = await codexHome({ "state_5.sqlite": [row("01a079b6-bba9-77d1-8eed-a6f11fd839b4", "another thread", null)] });
    expect(await renameTo(home, THREAD, "the name")).toEqual({ kind: "no-session" });
    expect(await nameOf(home, "state_5.sqlite", "01a079b6-bba9-77d1-8eed-a6f11fd839b4")).toBe("<null>");
    expect(await renameTo(await codexHome({}), THREAD, "the name")).toEqual({ kind: "failed", error: "no codex thread index on the machine" });
    expect(await renameTo(join(tmpdir(), "wsp-codex-nowhere"), THREAD, "the name")).toEqual({ kind: "failed", error: "no codex home on the machine" });
  });

  it("says failed with sqlite's own line when the index refused the write, never that the thread is not there", async () => {
    // The index is there and the table is not what the write expects, which is what a refused write looks like from
    // here: sqlite3 stops at the first error, so changes() never runs and its message is all the machine gives.
    const home = mkdtempSync(join(tmpdir(), "wsp-codex-title-"));
    homes.push(home);
    await run("sqlite3", [join(home, "state_5.sqlite"), "create table other (id text);"]);
    const wrote = await renameTo(home, THREAD, "the name");
    expect(wrote.kind).toBe("failed");
    expect(wrote.kind === "failed" ? wrote.error : "").toContain("no such table: threads");
  });

  it("refuses a thread id that is not a plain slug, and a name that closes the SQL string lands as its own bytes", async () => {
    expect(() => renameCommand({ home: "/root/.codex", threadId: "x' or '1'='1", title: "x" })).toThrow(/plain slug/);
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", null)] });
    expect(await renameTo(home, THREAD, "'); drop table threads; --")).toEqual({ kind: "written" });
    expect(await titleOf(home, THREAD)).toBe("'); drop table threads; --");
  });

  it("reads the rows changed as the answer, and a stdout it does not know as a failure carrying what was said", () => {
    expect(parseRename("changed 1\n")).toEqual({ kind: "written" });
    expect(parseRename("changed 0\n")).toEqual({ kind: "no-session" });
    expect(parseRename("failed database is locked\n")).toEqual({ kind: "failed", error: "database is locked" });
    expect(parseRename("")).toEqual({ kind: "failed", error: "the machine said nothing about the write" });
    expect(parseRename("Error: attempt to write a readonly database\n")).toEqual({ kind: "failed", error: "Error: attempt to write a readonly database" });
  });
});
