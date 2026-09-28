// SPDX-License-Identifier: AGPL-3.0-only
// The recipe verb: which rule decides the ticks, flipping one row by id,
// weighing the histories by project, and the table the printout draws.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeRecipe, type HistoryCache } from "@wsp/collect";
import { LOGIN_CHOICES, Recipe, type LoginChoice, type RecipeCustomRow } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { applySets, carriedOver, parseSet, parseSets, parseSignIn, runRecipe, runScan, type RecipeIo } from "../src/recipe-command.js";
import type { ScanRow } from "../src/scan.js";
import { applyRecipe, withCatalogAgents } from "../src/init-recipe.js";
import { signInItems } from "../src/init-pick.js";
import { historyCache, loadRecipe, saveSmallRecipe } from "../src/recipe-file.js";
import { BASE_GROUP, HERE_GROUP, PROJECT_GROUP, USED_GROUP } from "../src/init-table.js";
import { allRows, commandTableLines, recipeAnswer, recipePrintout } from "../src/recipe-answer.js";
import { RECIPE } from "./init-fixture.js";
import { claudeLine, fakeHost, HOME } from "./recipe-fixture.js";

/** The screens read this computer for whose login a copy would carry; a home with nothing in it names none. */
const HOME_HERE = "/home/nobody";

const PROJ = `${HOME}/proj`;
const OTHER = `${HOME}/other`;

/** Claude Code and Java 21 on this computer; the agent's own sessions ran node, gh and go past the floor, and
 * pulumi, which the catalog does not carry. Java is installed and was never run. */
const laptop = (over: { platform?: "darwin" | "linux" } = {}) =>
  fakeHost({
    ...over,
    which: ["claude", "java"],
    files: {
      "~/.claude/settings.json": "{}",
      "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", PROJ, ["node --version", "gh pr view", "gh pr checks", "gh run list"]), claudeLine("s1", PROJ, ["pulumi -q"])].join("\n"),
      "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", PROJ, ["gh pr list", "gh pr merge", "node build.js"]),
      "~/.claude/projects/-Users-dev-other/s3.jsonl": claudeLine("s3", OTHER, ["go build ./...", "go test ./...", "go vet ./..."]),
      "~/.claude/projects/-Users-dev-other/s4.jsonl": claudeLine("s4", OTHER, ["go build ./...", "go mod tidy"]),
      // The project's own manifests, which say what it takes to build whatever the histories ran.
      [`${PROJ}/compose.yaml`]: "services:\n  db:\n    image: postgres\n",
      [`${PROJ}/Cargo.toml`]: '[package]\nname = "x"\n',
      [`${PROJ}/.github/workflows/ci.yml`]: "jobs:\n  build:\n    steps:\n      - uses: actions/setup-dotnet@v4\n",
    },
  });

const quiet: RecipeIo = { log: () => {}, note: () => {} };
const collect = (): RecipeIo & { logs: string[]; notes: string[] } => {
  const logs: string[] = [];
  const notes: string[] = [];
  return { logs, notes, log: l => logs.push(l), note: l => notes.push(l) };
};
const at = () => new Date("2026-09-06T03:00:00Z");

/** A tap formula this Mac's Homebrew has, as the scan lists it, and the recipe row the collector files it under. */
const DISKBLOOM: ScanRow = { id: "brew/zingzy/tap/diskbloom", name: "zingzy/tap/diskbloom", manager: "brew", group: "Homebrew formulae", install: "brew install zingzy/tap/diskbloom", check: "brew list --versions zingzy/tap/diskbloom", size: 4 * 1024 * 1024, version: "0.1.0" };
const TAP_ROW = "tools/brew/zingzy/tap/diskbloom";

/** A package apt has on a Linux computer: no row of its own, since nothing reads an apt road off one. */
const DIRENV: ScanRow = { id: "apt/direnv", name: "direnv", manager: "apt", group: "apt packages", install: "export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq direnv", check: "dpkg -s 'direnv'", size: 9 * 1024 * 1024 };

/** The scan the verb is handed, recording what it was asked so a test can say whether the managers were read. */
const also = (rows: readonly ScanRow[] = [DISKBLOOM]) => {
  const asked: (readonly RecipeCustomRow[])[] = [];
  return { asked, alsoHere: async (recipe: readonly RecipeCustomRow[]) => { asked.push(recipe); return rows; } };
};
const rowOf = (recipe: Recipe, id: string) => recipe.rows.find(r => r.id === id);

describe("wsp recipe", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const outPath = (): string => join(dir, "state", "recipe.json");

  it("ticks what the agents ran and leaves a tool that is only installed off, saying so for each row", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-used-"));
    const out = outPath();
    const table = await runRecipe(laptop(), { out }, quiet, at);
    const row = (id: string) => allRows(table).find(r => r.id === id)!;
    expect(table.tick).toBe("used");
    // Node is off the floor now, so it is a row like any other: this computer's one call is under the floor.
    expect(row("node")).toMatchObject({ on: false, why: "below the floor, 1 command in 1 session", base: false, group: USED_GROUP });
    expect(row("gh")).toMatchObject({ on: true, why: "5 commands in 2 sessions", group: USED_GROUP });
    expect(row("java")).toMatchObject({ on: false, why: "installed here, never used", group: HERE_GROUP, size: 613280230 });
    // A tool the catalog ships on but nobody here ran is off under this rule; only use ticks a row.
    expect(row("curl")).toMatchObject({ on: true, why: "always on the image", base: true });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).tick).toBe("used");
  });

  it("--engine marks the file so every workspace from the image gets the place's engine, and the mark stands through later runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-engine-"));
    const out = outPath();
    await runRecipe(laptop(), { out }, quiet, at);
    expect(loadRecipe(out).engine).toBeUndefined();
    await runRecipe(laptop(), { out, engine: true }, quiet, at);
    expect(loadRecipe(out).engine).toBe(true);
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(loadRecipe(out).engine).toBe(true);
    expect(rowOf(loadRecipe(out), "java")?.on).toBe(true);
  });

  it("flips one row by its catalog id, keeps the flip in the file and prints its size", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-set-"));
    const out = outPath();
    await runRecipe(laptop(), { out }, quiet, at);
    const flipped = await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(allRows(flipped).find(r => r.id === "java")).toMatchObject({ on: true });
    expect(flipped.heavy.map(r => r.id)).toContain("java");
    expect(recipePrintout(flipped).find(l => l.includes("Java 21"))).toMatch(/^● {2}Java 21\s+installed\s+installed here, never used\s+585 MB$/);
    // The flip is in the file, so a later --set adds to it instead of starting over.
    const second = await runRecipe(laptop(), { out, set: ["go=on"] }, quiet, at);
    expect(allRows(second).filter(r => r.on).map(r => r.id)).toEqual(expect.arrayContaining(["java", "go", "gh"]));
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).rows.find(r => r.id === "java")?.on).toBe(true);
  });

  it("a named rule decides every row on a --set run too, and only this run's flips sit over it", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-rule-wins-"));
    const out = outPath();
    await runRecipe(laptop(), { out }, quiet, at);
    const under = await runRecipe(laptop(), { out, tick: "installed", set: ["go=on"] }, quiet, at);
    expect(under.tick).toBe("installed");
    expect(allRows(under).find(r => r.id === "java")).toMatchObject({ on: true, why: "installed here, never used" });
    expect(allRows(under).find(r => r.id === "gh")).toMatchObject({ on: false, why: "5 commands in 2 sessions" });
    expect(allRows(under).find(r => r.id === "go")).toMatchObject({ on: true });
    // The file now says the rule that really decided it, so the next run inherits the truth.
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toMatchObject({ tick: "installed" });
  });

  it("a pin a build recorded on the file stands through a flip and through a run that names a rule: it is a fact about the golden, not a tick", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-pin-"));
    const out = outPath();
    await runRecipe(laptop(), { out }, quiet, at);
    const pin = { tag: "v2.86.0", sha256: "b".repeat(64) };
    const saved = Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    saveSmallRecipe(out, { ...saved, rows: saved.rows.map(r => (r.id === "gh" ? { ...r, pin } : r)) });
    const written = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(rowOf(written(), "gh")?.pin).toEqual(pin);
    await runRecipe(laptop(), { out, tick: "installed" }, quiet, at);
    expect(rowOf(written(), "gh")?.pin).toEqual(pin);
    expect(written().rows.filter(r => r.pin !== undefined).map(r => r.id)).toEqual(["gh"]);
  });

  it("re-decides every row when a rule input is named and lets the file stand otherwise", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-carry-"));
    const out = outPath();
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    // No rule input: what is in the file stands, so an earlier flip is still there.
    expect(allRows(await runRecipe(laptop(), { out }, quiet, at)).find(r => r.id === "java")).toMatchObject({ on: true });
    // A rule input re-decides, so the flip goes.
    expect(allRows(await runRecipe(laptop(), { out, tick: "used" }, quiet, at)).find(r => r.id === "java")).toMatchObject({ on: false });
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(allRows(await runRecipe(laptop(), { out, projects: [PROJ] }, quiet, at)).find(r => r.id === "java")).toMatchObject({ on: false });
  });

  it("reads each session file once and takes the rest from the cache beside the state, on the write verb and on the scan", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cache-"));
    const out = outPath();
    const cache = (): HistoryCache => historyCache(join(dir, "state", "state.json"));
    const first = laptop();
    const one = await runRecipe(first, { out, cache: cache() }, quiet, at);
    expect(first.reads.filter(r => r.endsWith(".jsonl")).length).toBe(4);

    const again = laptop();
    const two = await runRecipe(again, { out, cache: cache() }, quiet, at);
    expect(again.reads.filter(r => r.endsWith(".jsonl"))).toEqual([]);
    expect(two).toEqual(one);

    // The scan reads the same histories through the same cache, so a scan after a recipe opens nothing either.
    const scanned = laptop();
    await runScan(scanned, { cache: cache() }, quiet, at);
    expect(scanned.reads.filter(r => r.endsWith(".jsonl"))).toEqual([]);
  });

  it("--project reads that folder's own manifests too: what it takes to build is on whatever the rule decided, in its own group", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-project-"));
    const out = outPath();
    const io = collect();
    const answer = await runRecipe(laptop(), { out, projects: [PROJ], tick: "used" }, io, at);
    // The names the catalog has no row for are in no table, so the run says them.
    expect(io.notes).toContain(`${PROJ}: Not in the catalog: dotnet (.github/workflows/ci.yml sets up dotnet)`);
    const saved = Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    // Nothing here ever ran docker and the used rule leaves it off; the folder's compose file puts it on and says which file asked.
    expect(rowOf(saved, "docker")).toMatchObject({ on: true, source: { kind: "project", why: "compose.yaml needs Docker" } });
    // Rust is not on the floor, so the table shows it under its own group with the file that asked.
    expect(allRows(answer).find(r => r.id === "rust")).toMatchObject({ on: true, group: PROJECT_GROUP, why: "Cargo.toml needs Rust" });
    // Docker is no row of the floor's, so the folder's own need is what puts it on, in the project's own group.
    expect(allRows(answer).find(r => r.id === "docker")).toMatchObject({ on: true, group: "Your project needs" });
    // The manifests add to the rule, they do not stand in for it: a row no manifest named is still the rule's call.
    expect(rowOf(saved, "go")).toMatchObject({ on: false });
    // A folder whose manifests name nothing the catalog carries leaves every tick to the rule.
    const other = await runRecipe(laptop(), { out: join(dir, "other.json"), projects: [OTHER], tick: "used" }, quiet, at);
    expect(allRows(other).find(r => r.id === "rust")).toMatchObject({ on: false });
  });

  it("lets the rule decide a catalog row the saved file never carried, instead of dropping it to off", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-grown-"));
    const out = outPath();
    const first = await runRecipe(laptop(), { out }, quiet, at);
    expect(allRows(first).find(r => r.id === "gh")).toMatchObject({ on: true });
    // The catalog grew a row since the file was written: strip it and flip something else.
    const saved = Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    writeFileSync(out, JSON.stringify({ ...saved, rows: saved.rows.filter(r => r.id !== "gh") }));
    const after = await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(allRows(after).find(r => r.id === "gh")).toMatchObject({ on: true, why: "5 commands in 2 sessions" });
    expect(allRows(after).find(r => r.id === "java")).toMatchObject({ on: true });
  });

  it("writes the sign-in answer a --signin names, keeps it across a later flip, and refuses a word or a row it does not know", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-signin-"));
    const out = outPath();
    const signed = await runRecipe(laptop(), { out, signin: ["claude=machine", "gh=copy"] }, quiet, at);
    expect(allRows(signed).length).toBeGreaterThan(0);
    const saved = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(saved().rows.find(r => r.id === "claude")?.signIn).toBe("machine");
    expect(saved().rows.find(r => r.id === "gh")?.signIn).toBe("copy");
    // A flip run keeps the answers already given; they are the person's, not the rule's.
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(saved().rows.find(r => r.id === "claude")?.signIn).toBe("machine");
    expect(parseSignIn("hermes=key")).toEqual({ id: "hermes", choice: "key" });
    // A recipe is the whole answer, so the word that leaves a sign-in to first use is one a recipe can name too.
    expect(parseSignIn("gcloud=later")).toEqual({ id: "gcloud", choice: "later" });
    expect(() => parseSignIn("claude=maybe")).toThrow("--signin takes <id>=copy|machine|later|key|skip");
    expect(() => parseSignIn("clawd=copy")).toThrow('the catalog has no row called "clawd"');
    // A word a row cannot take is not refused here: the sign-ins screen falls back to the first word it takes.
    expect(parseSignIn("gh=key")).toEqual({ id: "gh", choice: "key" });
  });

  it("keeps a sign-in answer through a run that names a rule: the answer is the person's and no rule decides it", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-signin-carry-"));
    const out = outPath();
    const answers = () => {
      const saved = Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
      return saved.rows.flatMap(r => (r.signIn === undefined ? [] : [[r.id, r.signIn]]));
    };
    await runRecipe(laptop(), { out, signin: ["claude=machine", "gh=copy"] }, quiet, at);
    expect(answers()).toEqual([["claude", "machine"], ["gh", "copy"]]);
    // A rule input re-decides every tick; it has nothing to say about a sign-in, so nothing of it is lost.
    await runRecipe(laptop(), { out, tick: "installed" }, quiet, at);
    expect(answers()).toEqual([["claude", "machine"], ["gh", "copy"]]);
    await runRecipe(laptop(), { out, projects: [PROJ] }, quiet, at);
    expect(answers()).toEqual([["claude", "machine"], ["gh", "copy"]]);
    // This run's own word wins over the one in the file.
    const last = await runRecipe(laptop(), { out, tick: "used", signin: ["gh=machine"] }, quiet, at);
    expect(allRows(last).find(r => r.id === "gh")?.id).toBe("gh");
    expect(answers()).toEqual([["claude", "machine"], ["gh", "machine"]]);
  });

  it("leaves a recipe that names no rule naming none when the file stands, so its rows are not read as used", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-untagged-"));
    const out = outPath();
    // What the wizard writes: the blended rule, and no tick field at all.
    const wizard = await computeRecipe(laptop(), { threadAgents: ["claude"], now: at });
    expect(wizard.tick).toBeUndefined();
    saveSmallRecipe(out, wizard);
    const flipped = await runRecipe(laptop(), { out, set: ["go=on"] }, quiet, at);
    expect(flipped.tick).toBeUndefined();
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).tick).toBeUndefined();
    // An installed row cannot be said never to have been used under a rule that never read a use.
    expect(allRows(flipped).find(r => r.id === "claude")).toMatchObject({ why: "used here, 4 sessions" });
    expect(allRows(flipped).find(r => r.id === "go")).toMatchObject({ on: true });
    // Naming a rule is what stamps one on.
    expect((await runRecipe(laptop(), { out, tick: "used" }, quiet, at)).tick).toBe("used");
  });



  it("carries the rows --add names into the file, keeps an earlier run's, and offers none of them a sign-in", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-add-"));
    const out = outPath();
    const custom = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom;
    await runRecipe(laptop(), { out, add: ["just=brew install just"] }, quiet, at);
    expect(custom()).toEqual([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v 'just'", why: "added by the agent" }]);
    // A rule input re-decides every tick; the rows outside the catalog are the file's and stand through it.
    await runRecipe(laptop(), { out, tick: "installed", add: ["ruff=uv tool install ruff"], addCheck: ["ruff=ruff --version"] }, quiet, at);
    expect(custom()?.map(r => r.id)).toEqual(["just", "ruff"]);
    expect(custom()?.find(r => r.id === "ruff")?.check).toBe("ruff --version");
    // The install is the whole row: no catalog row appears for it and no sign-in is ever offered.
    expect(custom()?.every(r => !("signIn" in r))).toBe(true);
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [] }), Recipe.parse(JSON.parse(readFileSync(out, "utf8")))), new Map(), "darwin", HOME_HERE).items.map(i => i.id)).not.toContain("logins/just");
    await expect(runRecipe(laptop(), { out, add: ["just"] }, quiet, at)).rejects.toThrow('--add takes <id>=<command>, and got "just".');
  });

  it("keeps the wizard's ticks on this computer's tools rows outside the catalog through every run, rule or none, and hands them to the wizard beside the added rows and the pins", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-outside-"));
    const out = outPath();
    const tap = { id: "tools/brew/zingzy/tap/diskbloom", kind: "tool" as const, on: true, source: { kind: "installed" as const, paths: [], bin: true }, pin: { tag: "v0.1.0", sha256: "a".repeat(64) } };
    const tsx = { id: "tools/npm/tsx", kind: "tool" as const, on: false, source: { kind: "installed" as const, paths: [], bin: true } };
    saveSmallRecipe(out, { version: 1, at: at().toISOString(), histories: [], rows: [tap, tsx] });
    const rows = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).rows;
    await runRecipe(laptop(), { out, tick: "installed" }, quiet, at);
    expect(rows().filter(r => r.id.startsWith("tools/"))).toEqual([tap, tsx]);
    const table = await runRecipe(laptop(), { out, set: ["java=off"] }, quiet, at);
    expect(rows().filter(r => r.id.startsWith("tools/"))).toEqual([tap, tsx]);
    // The table is the catalog's: it draws none of them, and the file keeps them.
    expect(allRows(table).some(r => r.id === tap.id)).toBe(false);
    expect(carriedOver(out, () => {})).toEqual({ custom: [], ticks: new Map([[tap.id, true], [tsx.id, false]]), pins: new Map([[tap.id, tap.pin]]) });
  });

  it("the table shows what the last seal installed beside a row that carries a pin, in the protocol's words, and draws no such column when no row does", () => {
    const pinned: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "gh" ? { ...r, pin: { tag: "v2.86.0", sha256: "b".repeat(64) } } : r.id === "yq" ? { ...r, pin: { tag: "4.44.1-1", latest: true as const } } : r)) };
    const answer = recipeAnswer(pinned, "/tmp/recipe.json");
    expect(answer.tools.find(r => r.id === "gh")?.pin).toEqual({ tag: "v2.86.0", sha256: "b".repeat(64) });
    expect(answer.tools.find(r => r.id === "tmux")).not.toHaveProperty("pin");
    const lines = recipePrintout(answer);
    expect(lines.find(l => l.includes("GitHub CLI"))).toMatch(/ v2\.86\.0$/);
    expect(lines.find(l => l.includes(" yq "))).toMatch(/ 4\.44\.1-1, installs latest$/);
    expect(recipePrintout(recipeAnswer(RECIPE, "/tmp/recipe.json")).some(l => l.includes("installs latest"))).toBe(false);
  });

  it("says so and rewrites the file when the recipe already there cannot be read, rather than refusing to run", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-unreadable-"));
    const out = outPath();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "{ not json");
    const io = collect();
    const table = await runRecipe(laptop(), { out, add: ["just=brew install just"] }, io, at);
    expect(io.notes.find(l => l.includes("could not be read"))).toContain("its ticks, sign-in answers and added rows go with it");
    expect(allRows(table).length).toBeGreaterThan(0);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom?.map(r => r.id)).toEqual(["just"]);
  });

  it("refuses a --set word that is not <id>=on or <id>=off, and one whose id names no row of any of the three kinds", async () => {
    expect(() => parseSet("java")).toThrow("--set takes <id>=on or <id>=off");
    expect(() => parseSet("java=yes")).toThrow("--set takes <id>=on or <id>=off");
    expect(parseSets(["java=on", "java=off"]).get("java")).toBe(false);
    expect(applySets({ version: 1, at: "x", histories: [], rows: [] }, new Map([["java", true]])).rows).toEqual([]);
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-set-unknown-"));
    const out = outPath();
    await expect(runRecipe(laptop(), { out, set: ["jaava=on"], alsoHere: also().alsoHere }, quiet, at)).rejects.toThrow('"jaava" is no catalog row and no row of');
    await expect(runRecipe(laptop(), { out, set: ["jaava=on"], alsoHere: also().alsoHere }, quiet, at)).rejects.toThrow("no package a manager on this Mac has that id");
    expect(existsSync(out)).toBe(false);
  });

  it("ticks a package one of this Mac's own managers has by the id the scan gives it, as its own row under the collector's id, and drops an added row an earlier version left for the same package", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-own-row-"));
    const out = outPath();
    const file = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    const scan = also();
    // The file as a version before this one left it: an added row for the tap formula, which runs brew install on
    // the image and fails there, since the formula has no Linux bottle.
    const byHand = { kind: "custom" as const, id: DISKBLOOM.id, name: DISKBLOOM.name, install: [DISKBLOOM.install], check: DISKBLOOM.check, why: "added by the agent" };
    saveSmallRecipe(out, { version: 1, at: at().toISOString(), histories: [], rows: [], custom: [byHand] });
    const table = await runRecipe(laptop(), { out, set: [`${DISKBLOOM.id}=on`], alsoHere: scan.alsoHere }, quiet, at);
    // The scan is asked what the file already installs by another hand, as the Also on this Mac screen asks it.
    expect(scan.asked).toEqual([[byHand]]);
    expect(file().rows.find(r => r.id === TAP_ROW)).toEqual({ id: TAP_ROW, kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } });
    expect(file().custom).toEqual([]);
    // The row is the recipe's, not the catalog's table's: the printed table draws catalog rows alone.
    expect(allRows(table).some(r => r.id === TAP_ROW)).toBe(false);
    // The same word off unticks the row it wrote, and the row's own id reaches it without the managers being read.
    await runRecipe(laptop(), { out, set: [`${DISKBLOOM.id}=off`], alsoHere: also().alsoHere }, quiet, at);
    expect(file().rows.find(r => r.id === TAP_ROW)?.on).toBe(false);
    const none = also();
    await runRecipe(laptop(), { out, set: [`${TAP_ROW}=on`], alsoHere: none.alsoHere }, quiet, at);
    expect(none.asked).toEqual([]);
    expect(file().rows.find(r => r.id === TAP_ROW)?.on).toBe(true);
  });

  it("ticks a package whose manager brings no row of its own (apt) as an added row with the scan's install line, and an untick takes that row away", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-apt-"));
    const out = outPath();
    const file = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    const scan = also([DIRENV]);
    await runRecipe(laptop({ platform: "linux" }), { out, set: [`${DIRENV.id}=on`], alsoHere: scan.alsoHere }, quiet, at);
    // The build reads no road off an apt row, so a row under the collector's id would install nothing: the tick
    // writes the line the scan read instead, which is what the Also screen writes for the same package.
    expect(file().rows.some(r => r.id === "tools/apt/direnv")).toBe(false);
    expect(file().custom).toEqual([{ kind: "custom", id: DIRENV.id, name: "direnv", install: [DIRENV.install], check: DIRENV.check, manager: "apt", size: DIRENV.size, why: "installed on this computer by apt" }]);
    await runRecipe(laptop({ platform: "linux" }), { out, set: [`${DIRENV.id}=off`], alsoHere: also([DIRENV]).alsoHere }, quiet, at);
    expect(file().custom).toEqual([]);
  });

  it("refuses an --add for a package one of this Mac's managers already has, by the scan's id or the package's own name, and names the --set word that ticks it instead", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-add-here-"));
    const out = outPath();
    const points = `Tick it with --set ${DISKBLOOM.id}=on.`;
    await expect(runRecipe(laptop(), { out, add: [`${DISKBLOOM.id}=${DISKBLOOM.install}`], alsoHere: also().alsoHere }, quiet, at)).rejects.toThrow(points);
    await expect(runRecipe(laptop(), { out, add: [`${DISKBLOOM.name}=${DISKBLOOM.install}`], alsoHere: also().alsoHere }, quiet, at)).rejects.toThrow(points);
    expect(existsSync(out)).toBe(false);
    // A tool neither the catalog carries nor a manager here has is still a row of its own.
    await runRecipe(laptop(), { out, add: ["cuda=apt-get install -y cuda"], alsoHere: also().alsoHere }, quiet, at);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom?.map(r => r.id)).toEqual(["cuda"]);
  });

  it("ticks what is installed under installed, and what the catalog ships on under default", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-rules-"));
    const installed = await runRecipe(laptop(), { out: outPath(), tick: "installed" }, quiet, at);
    expect(allRows(installed).find(r => r.id === "java")).toMatchObject({ on: true, why: "installed here, never used" });
    expect(allRows(installed).find(r => r.id === "gh")).toMatchObject({ on: false, why: "5 commands in 2 sessions" });
    const byDefault = await runRecipe(laptop(), { out: outPath(), tick: "default" }, quiet, at);
    expect(allRows(byDefault).find(r => r.id === "gh")).toMatchObject({ on: true });
    expect(allRows(byDefault).find(r => r.id === "java")).toMatchObject({ on: false });
  });

  it("holds an agent this host cannot open a thread on off, whatever its history said", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-agents-"));
    const table = await runRecipe(laptop(), { out: outPath() }, quiet, at);
    expect(allRows(table).find(r => r.id === "claude")).toMatchObject({ on: true, kind: "agent" });
    for (const id of ["codex", "gemini", "opencode", "pi", "hermes"]) expect(allRows(table).find(r => r.id === id), id).toMatchObject({ on: false });
  });

  it("weighs the histories by the folders --project names, so another project's tools do not count", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-project-"));
    const all = await runRecipe(laptop(), { out: outPath() }, quiet, at);
    expect(allRows(all).find(r => r.id === "go")).toMatchObject({ on: true });
    const one = await runRecipe(laptop(), { out: outPath(), projects: [PROJ] }, quiet, at);
    expect(allRows(one).find(r => r.id === "go")).toMatchObject({ on: false, why: "in the catalog, on request" });
    expect(allRows(one).find(r => r.id === "gh")).toMatchObject({ on: true });
  });

  it("ends with the commands the agents ran that no catalog row carries, most-run first", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmds-"));
    const table = await runRecipe(laptop(), { out: outPath() }, quiet, at);
    expect(table.commands.map(c => c.name)).toContain("pulumi");
    expect(table.commands.map(c => c.name)).not.toContain("node");
    expect(table.commands.map(c => c.name)).not.toContain("go");
    expect(commandTableLines(table.commands)[0]).toBe("Commands your agents ran that the catalog does not carry:");
    expect(commandTableLines(table.commands).join("\n")).toContain("pulumi");
  });

  it("prints the wizard's own two tables and the reading lines apart from them", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-print-"));
    const io = collect();
    const table = await runRecipe(laptop(), { out: outPath() }, io, at);
    for (const line of recipePrintout(table)) io.log(line);
    expect(io.notes[0]).toBe("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
    expect(io.notes).toContain("Claude Code: 4 sessions, 13 tool calls");
    // The shared renderer's lines, which is what the wizard's screens draw: one row per entry, its own totals line.
    expect(io.logs[0]).toBe("Agents");
    expect(io.logs).toContain("Tools");
    expect(io.logs.filter(l => l.startsWith("On: "))).toHaveLength(2);
    expect(io.logs.find(l => l.includes("Java 21"))).toMatch(/^○ {2}Java 21\s+installed\s+installed here, never used\s+585 MB$/);
    expect(table.heavy.every(r => r.on && r.heavy)).toBe(true);
  });
});
