// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { SEED_ROWS, seedInstallsFor, seedRowFor } from "../src/seed.js";

describe("the row a path git ignores lands on", () => {
  it("reads a local env file as configuration that travels", () => {
    const found = seedRowFor(".env.local", false);
    expect(found?.row.id).toBe("next");
    expect(found?.kind).toBe("config");
  });

  it("reads an install directory as one the computer rebuilds", () => {
    expect(seedRowFor("node_modules", true)).toMatchObject({ kind: "rebuilt", row: { id: "node" } });
  });

  it("reads a database file as data", () => {
    expect(seedRowFor("dev.db", false)).toMatchObject({ kind: "data", row: { id: "databases" } });
  });

  it("reads a login as one that never travels, before any ecosystem's own rule", () => {
    expect(seedRowFor(".git-credentials", false)).toMatchObject({ kind: "never", row: { id: "logins" } });
    // auth.json under a tool's folder is the tool's login, not a config file the agents row would carry.
    expect(seedRowFor(".config/glab/auth.json", false)).toMatchObject({ kind: "never", row: { id: "logins" } });
  });

  it("hides the metadata the operating system leaves in a folder", () => {
    expect(seedRowFor(".DS_Store", false)?.kind).toBe("junk");
    expect(seedRowFor("components/.DS_Store", false)?.kind).toBe("junk");
  });

  it("answers nothing for a path no row names, and for a sample env file the catalog does not claim", () => {
    expect(seedRowFor(".next-mock", true)).toBeUndefined();
    expect(seedRowFor("docs", true)).toBeUndefined();
    expect(seedRowFor(".env.example", false)).toBeUndefined();
    expect(seedRowFor(".env.sample", false)).toBeUndefined();
  });

  it("asks for a directory where the pattern names one", () => {
    expect(seedRowFor("dist", true)).toMatchObject({ kind: "rebuilt", row: { id: "node" } });
    // A source file called dist is a file somebody wrote, whatever it is named.
    expect(seedRowFor("dist", false)).toBeUndefined();
  });

  it("matches a pattern with a slash at a segment boundary and nowhere else", () => {
    expect(seedRowFor("config/master.key", false)).toMatchObject({ kind: "config", row: { id: "rails" } });
    expect(seedRowFor("myconfig/master.key", false)).toMatchObject({ kind: "config", row: { id: "certificates" } });
  });
});

describe("the rows themselves", () => {
  it("carry one id each", () => {
    expect(new Set(SEED_ROWS.map(r => r.id)).size).toBe(SEED_ROWS.length);
  });

  it("each judge their own examples, and no earlier row takes one first", () => {
    for (const row of SEED_ROWS) {
      for (const [kind, examples] of Object.entries(row.examples)) {
        for (const example of examples) {
          const dir = (row.patterns[kind as keyof typeof row.patterns] ?? []).some(p => p.endsWith("/"));
          const found = seedRowFor(example, dir);
          expect(found, `${row.id} ${kind} ${example}`).toBeDefined();
          expect([found?.row.id, found?.kind], `${row.id} ${kind} ${example}`).toEqual([row.id, kind]);
        }
      }
    }
  });
});

describe("the install a project's own root picks", () => {
  it("answers one per ecosystem in catalog order", () => {
    expect(seedInstallsFor(["package-lock.json", "Cargo.lock"]).map(i => i.install.run)).toEqual(["npm ci", "cargo fetch --locked"]);
  });

  it("takes the first lockfile a row lists that is there, so one ecosystem installs once", () => {
    expect(seedInstallsFor(["pnpm-lock.yaml", "package-lock.json"]).map(i => i.install.run)).toEqual(["npm ci"]);
  });

  it("takes bun's text lockfile, and a root carrying both of bun's installs once", () => {
    expect(seedInstallsFor(["bun.lock"]).map(i => i.install.run)).toEqual(["bun install --frozen-lockfile"]);
    expect(seedInstallsFor(["bun.lock", "bun.lockb"]).map(i => i.install.run)).toEqual(["bun install --frozen-lockfile"]);
  });

  it("answers nothing for a root with no lockfile on any row", () => {
    expect(seedInstallsFor(["package.json", "README.md"])).toEqual([]);
  });
});
