// SPDX-License-Identifier: AGPL-3.0-only
// Every wsp process imports the engine, and node:sqlite prints an
// ExperimentalWarning the moment it loads, so the binding may load only when
// a sqlite-backed agent's state actually moves.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const warnings: string[] = [];
process.on("warning", w => warnings.push(`${w.name}: ${w.message}`));
const settle = (): Promise<void> => new Promise(r => setImmediate(r));
const sqliteWarnings = (): string[] => warnings.filter(w => /ExperimentalWarning: SQLite/.test(w));

describe("importing the engine", () => {
  it("prints no ExperimentalWarning, and a move on a sqlite-backed home still works", async () => {
    const { PROJECT_STATE_RESOLVERS } = await import("../src/index.js");
    await settle();
    expect(sqliteWarnings()).toEqual([]);

    const home = mkdtempSync(join(tmpdir(), "wsp-t221-import-"));
    roots.push(home);
    mkdirSync(home, { recursive: true });
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(join(home, "state.db"));
    d.exec("create table sessions (id text primary key, cwd text, git_repo_root text)");
    d.prepare("insert into sessions values ('s1', '/old/p', '/old/p')").run();
    d.close();
    const hermes = PROJECT_STATE_RESOLVERS.get("hermes");
    if (hermes === undefined) throw new Error("no hermes module");
    expect(await hermes.move(home, "/old/p", "/new/p")).toEqual([{ state: "sessions", files: [join(home, "state.db")], changed: 1 }]);
    await settle();
    expect(sqliteWarnings()).toHaveLength(1);
  });
});
