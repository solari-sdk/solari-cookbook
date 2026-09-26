// SPDX-License-Identifier: AGPL-3.0-only
// The one composition the seal and a copy's build both read: the same rows,
// the same import, the same envs, and the one difference a copy makes, which
// is that every sign-in is skipped because the vault already holds it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest, ManifestEntry } from "@wsp/collect";
import type { Recipe, SealedImage } from "@wsp/protocol";
import { brewTableFor, copyGoldenRecipe, copyRows, planGoldenRecipe, wantsBrew } from "../src/image-recipe.js";
import { ROOT, sourceFiles } from "../../protocol/test/source-files.js";
import { readFileSync } from "node:fs";
import { answeredRows, defaultAnswers, manifestFor } from "../src/init-recipe.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

/** The laptop the fixture describes, with the files its rows name actually there: the plan reads this computer, so
 * a row whose path is missing plans nothing and the two plans would agree for the wrong reason. */
function laptop(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n");
  writeFileSync(join(home, ".zshrc"), "export PS1='$ '\n");
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(home, ".codex", "auth.json"), '{"token":"not-a-real-token"}\n');
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: not-a-real-token\n");
}

/** The recipe that laptop's seal was planned from: the fixture's own, with Codex on so its login row has a tool, and
 * both sign-ins answered copy, as the screens left them at the seal. A copy's build has to put those answers back to
 * skip itself; a plan that read the record's answers as they stand would carry the person's logins twice. */
const SMALL: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true, signIn: "copy" as const } : r.id === "gh" ? { ...r, signIn: "copy" as const } : r)) };

const RECORD: SealedImage = {
  name: "default",
  version: 1,
  hash: "a".repeat(64),
  recipeHash: "h1",
  recipe: SMALL,
  logins: [{ name: "codex", state: "copied" }],
  sealedAt: "2026-09-12T00:00:00.000Z",
  sealedFrom: "laptop",
  vault: { sha256: "b".repeat(64), bytes: 400, paths: 2, takenAt: "2026-09-12T00:00:00.000Z" },
};

describe("the recipe a copy at another place is built from", () => {
  let dir: string;
  let home: string;
  let statePath: string;
  const readers = () => ({
    collect: async (): Promise<Manifest> => FIXTURE,
    home,
    platform: "linux" as const,
    statePath,
      });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-copy-recipe-"));
    home = join(dir, "home");
    statePath = join(dir, "state.json");
    mkdirSync(home, { recursive: true });
    laptop(home);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The seal's own plan for the same laptop and the same recipe, with the sign-ins answered as the screens would
   * leave them: what a copy is measured against. */
  const sealPlan = () => {
    const manifest = manifestFor({ manifest: FIXTURE }, SMALL);
    const { ticks, choices } = defaultAnswers(manifest, new Map());
    return planGoldenRecipe({ rows: answeredRows(manifest, ticks, choices), small: SMALL, home, platform: "linux", brew: new Map(), secrets: new Map() });
  };

  it("sets every sign-in row to skip and leaves every other row's answer as the record left it", () => {
    const rows = copyRows(FIXTURE, { ...RECORD, recipe: SMALL }, { home, brew: new Map() });
    const logins = rows.filter(e => e.rung === "logins");
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every(e => e.choice === "skip" && e.bring !== true)).toBe(true);
    // The agents and tools the record's recipe ticks are ticked here, untouched by the sign-ins going.
    const ticked = new Set(rows.filter(e => e.bring).map(e => e.id));
    expect(ticked).toContain("agents/claude");
    expect(ticked).toContain("agents/codex");
    expect(ticked).toContain("tools/brew/gh");
  });

  it("ticks the tool a sign-in needs, even where the record's recipe carries that tool off", () => {
    // The seal ticks gh's row because its login was answered copy; the small recipe records the answer and not the
    // tick, so a copy that read the rows as written would land the login on a machine with no gh on it.
    const withoutTool: Recipe = { ...SMALL, rows: SMALL.rows.map(r => (r.id === "gh" ? { ...r, on: false } : r)) };
    const rows = copyRows(FIXTURE, { ...RECORD, recipe: withoutTool }, { home, brew: new Map() });
    const ticked = new Set(rows.filter(e => e.bring).map(e => e.id));
    expect(ticked).toContain("tools/brew/gh");
    // The sign-in itself is still skipped: the vault holds it.
    expect(rows.find(e => e.id === "logins/gh")).toMatchObject({ choice: "skip" });
    expect(ticked).not.toContain("logins/gh");
  });

  it("carries the same rows and envs as the seal's own plan, and only the sign-ins differ", async () => {
    const copy = await copyGoldenRecipe(RECORD, readers());
    const seal = sealPlan();
    expect(copy.envs).toEqual(seal.recipe.envs);
    expect(copy.source).toEqual(SMALL);
    const ticksOf = (digest: { ticks: { id: string }[] } | undefined) => (digest?.ticks ?? []).map(t => t.id).filter(id => !id.startsWith("logins/"));
    expect(ticksOf(copy.import?.recipe)).toEqual(ticksOf(seal.import.recipe));
    // The seal carries the sign-in rows it was answered with; the copy carries none, since the vault holds them.
    expect((seal.import.recipe?.ticks ?? []).some(t => t.id.startsWith("logins/"))).toBe(true);
    expect((copy.import?.recipe?.ticks ?? []).some(t => t.id.startsWith("logins/"))).toBe(false);
  });

  it("a copy installs by the record's pins: a pinnable row takes the pin's version over what this computer runs now, a latest row carries the mark and no version", () => {
    // This computer moved tsx on since the seal; the record pinned the version the seal installed.
    const here: Manifest = { entries: FIXTURE.entries.map(e => (e.id === "tools/npm/tsx" ? { ...e, version: "4.2.0" } : e)) };
    const small: Recipe = { ...SMALL, rows: [...SMALL.rows, { id: "tools/npm/tsx", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } }] };
    const pins = [{ id: "tools/npm/tsx", tag: "4.1.0", road: "npm" }, { id: "gh", tag: "2.86.0", road: "brew", latest: true as const }];
    const rows = copyRows(here, { ...RECORD, recipe: small, pins }, { home, brew: new Map() });
    expect(rows.find(e => e.id === "tools/npm/tsx")).toMatchObject({ bring: true, version: "4.1.0", pin: { tag: "4.1.0" } });
    expect(rows.find(e => e.id === "tools/brew/gh")).toMatchObject({ bring: true, pin: { tag: "2.86.0", latest: true } });
    expect(rows.find(e => e.id === "tools/brew/gh")).not.toHaveProperty("version");
    const copy = planGoldenRecipe({ rows, small, home, platform: "linux", brew: new Map(), secrets: new Map() });
    expect(copy.import.tools.find(t => t.id === "tools/npm/tsx")?.cmd).toContain("npm install -g tsx@4.1.0");
    // The seal on this computer today would install what it runs: the copy is the record's, not this computer's.
    const applied = manifestFor({ manifest: here }, small);
    const { ticks, choices } = defaultAnswers(applied, new Map());
    const seal = planGoldenRecipe({ rows: answeredRows(applied, ticks, choices), small, home, platform: "linux", brew: new Map(), secrets: new Map() });
    expect(seal.import.tools.find(t => t.id === "tools/npm/tsx")?.cmd).toContain("npm install -g tsx@4.2.0");
    // A record sealed before pins were read pins nothing, and the copy plans as this computer stands.
    expect(copyRows(here, { ...RECORD, recipe: small }, { home, brew: new Map() }).find(e => e.id === "tools/npm/tsx")).toMatchObject({ version: "4.2.0" });
    // The small recipe goes on the record without the pins an earlier seal wrote on it: the record's own pins stand beside it.
    const written: Recipe = { ...small, rows: small.rows.map(r => (r.id === "gh" ? { ...r, pin: { tag: "v2.86.0", sha256: "b".repeat(64) } } : r)) };
    expect(planGoldenRecipe({ rows, small: written, home, platform: "linux", brew: new Map(), secrets: new Map() }).recipe.source).toEqual(small);
  });

  it("the record's pins are keyed by the catalog id, so a copy planned on a computer whose row for the tool carries another id still installs the pin: the tool here by npm at a newer version, or gone from here and installed by the catalog's bare row", () => {
    const pins = [{ id: "wrangler", tag: "4.1.0", road: "npm" }];
    const small: Recipe = { ...SMALL, rows: [...SMALL.rows, { id: "wrangler", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 } }] };
    const plan = (rows: ManifestEntry[]) => planGoldenRecipe({ rows, small, home, platform: "linux", brew: new Map(), secrets: new Map() }).import.tools;
    // Sealed where the catalog's bare row installed it; this computer has it by npm now, at a newer version.
    const byNpm: Manifest = { entries: [...FIXTURE.entries, { rung: "tools", id: "tools/npm/wrangler", label: "wrangler", group: "npm globals", paths: [], bytes: 0, default: "bring", version: "4.3.0" }] };
    const here = copyRows(byNpm, { ...RECORD, recipe: small, pins }, { home, brew: new Map() });
    expect(here.find(e => e.id === "tools/npm/wrangler")).toMatchObject({ bring: true, version: "4.1.0", pin: { tag: "4.1.0" } });
    expect(here.some(e => e.id === "tools/catalog/wrangler")).toBe(false);
    expect(plan(here).find(t => t.id === "tools/npm/wrangler")?.cmd).toContain("npm install -g wrangler@4.1.0");
    // Sealed where this computer had it by npm; the tool is gone from here, so the catalog's bare row installs it, at the pin.
    const gone = copyRows(FIXTURE, { ...RECORD, recipe: small, pins }, { home, brew: new Map() });
    expect(gone.find(e => e.id === "tools/catalog/wrangler")).toMatchObject({ bring: true, version: "4.1.0", pin: { tag: "4.1.0" } });
    expect(plan(gone).find(t => t.id === "tools/catalog/wrangler")?.cmd).toContain("npm install -g wrangler@4.1.0");
    // A row outside the catalog is known by its own id on the one computer that has it, and matches on that.
    const tap: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", paths: [], bytes: 0, default: "bring", linux: "unknown" };
    const outside = copyRows({ entries: [...FIXTURE.entries, tap] }, { ...RECORD, recipe: { ...small, rows: [...small.rows, { id: tap.id, kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } }] }, pins: [{ id: tap.id, tag: "v0.1.0", sha256: "a".repeat(64), road: "release" }] }, { home, brew: new Map() });
    expect(outside.find(e => e.id === tap.id)).toMatchObject({ bring: true, version: "v0.1.0", pin: { tag: "v0.1.0", sha256: "a".repeat(64) } });
  });

  it("carries no login's own file off this computer and reads no Keychain for one", async () => {
    const copy = await copyGoldenRecipe(RECORD, readers());
    const files = copy.import?.recipe?.files ?? [];
    // The person's own files and their agents' config travel as they do on the seal; what a sign-in row alone
    // names does not, and neither does any value a Keychain read would have put beside it.
    expect(files.map(f => f.path)).toContain("~/.zshrc");
    expect(files.map(f => f.path)).toContain("~/.claude");
    expect(files.some(f => f.id.startsWith("logins/"))).toBe(false);
    expect(files.some(f => f.path.startsWith("~/.config/gh"))).toBe(false);
    // The same laptop planned by the seal, where the sign-ins were answered copy, does carry them: the difference
    // is the answer this module writes and nothing else.
    const sealed = sealPlan().import.recipe?.files ?? [];
    expect(sealed.some(f => f.id.startsWith("logins/"))).toBe(true);
    expect(sealed.some(f => f.path.startsWith("~/.config/gh"))).toBe(true);
  });

  it("a record sealed without the recipe it was built from has nothing to build a copy from", async () => {
    const { recipe: _recipe, ...bare } = RECORD;
    await expect(copyGoldenRecipe(bare, readers())).rejects.toThrow(/sealed without the recipe/);
  });

  it("reads Homebrew only where a formula row is here, and a brew that will not answer leaves the plan standing", async () => {
    const asked: string[] = [];
    const copy = await copyGoldenRecipe(RECORD, {
      ...readers(),
      brew: async () => {
        asked.push("brew");
        throw new Error("brew is not on this computer");
      },
    });
    // The fixture has formula rows, so it is read; it failed, and the plan stands on the measured table.
    expect(asked).toEqual(["brew"]);
    expect((copy.import?.recipe?.ticks ?? []).map(t => t.id)).toContain("agents/claude");

    asked.length = 0;
    await copyGoldenRecipe(RECORD, {
      ...readers(),
      collect: async () => ({ entries: FIXTURE.entries.filter(e => !e.id.startsWith("tools/brew/")) }),
      brew: async () => {
        asked.push("brew");
        return new Map();
      },
    });
    expect(asked).toEqual([]);
  });
});

describe("the one reading of whether this computer needs Homebrew read", () => {
  const withBrew = FIXTURE;
  const without: Manifest = { entries: FIXTURE.entries.filter(e => !e.id.startsWith("tools/brew/")) };

  it("is a brew row of this computer's own, and nothing else", () => {
    expect(wantsBrew(withBrew)).toBe(true);
    expect(wantsBrew(without)).toBe(false);
  });

  it("reads brew only then, answers an empty table where brew will not answer, and never asks twice", async () => {
    const asked: string[] = [];
    const table = new Map([["gh", { name: "gh", fullName: "gh", deps: [], macosOnly: false }]]);
    expect(await brewTableFor(withBrew, async () => (asked.push("read"), table))).toBe(table);
    expect(asked).toEqual(["read"]);
    // A computer with no brew row of its own is not read at all, and a brew that throws leaves an empty table
    // rather than failing the plan it was asked for.
    expect([...(await brewTableFor(without, async () => (asked.push("read again"), table)))]).toEqual([]);
    expect([...(await brewTableFor(withBrew, async () => { throw new Error("brew info failed"); }))]).toEqual([]);
    // A caller with no reader at all, which is every road that was handed none.
    expect([...(await brewTableFor(withBrew, undefined))]).toEqual([]);
    expect(asked).toEqual(["read"]);
  });

  it("is the reading the planner for a computer you own takes, so neither road reads this Mac its own way", () => {
    // The predicate lives once: a second copy is what let the two roads drift on which computer needs brew.
    const copies = sourceFiles().filter(rel => rel !== join("packages", "host", "src", "image-recipe.ts") && /entries\.some\([^)]*BREW_ID_PREFIX/.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});
