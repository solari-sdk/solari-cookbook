// SPDX-License-Identifier: AGPL-3.0-only
// The Also screen: what it draws from a scan, what a tick writes
// into the recipe, and what an untick takes away again.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { MIB } from "@wsp/catalog";
import type { Recipe } from "@wsp/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { alsoGroupLine, alsoItems, alsoTitle, alsoTop, buildLine, scannedTicks, withScanned } from "../src/init-also.js";
import { ownRowOf } from "../src/recipe-file.js";
import type { Manifest, ManifestEntry } from "@wsp/collect";
import { rungSelect } from "../src/init-select.js";
import { customFromScan } from "../src/recipe-custom.js";
import type { ScanRow } from "../src/scan.js";

/** The scan row as a recipe row, for the computer these tests read: a Mac, whose own words the screens keep. */
const customFromScanAt = (row: ScanRow) => customFromScan(row, "darwin");

const bare: Recipe = { version: 1, at: "2026-09-06T03:00:00Z", histories: [], rows: [] };

const scan: ScanRow[] = [
  { id: "brew/just", name: "just", manager: "brew", group: "Homebrew formulae", install: "brew install just", check: "command -v just", size: 4 * MIB },
  { id: "brew/llvm", name: "llvm", manager: "brew", group: "Homebrew formulae", install: "brew install llvm", check: "command -v llvm", size: 2048 * MIB },
  { id: "brew/pandoc", name: "pandoc", manager: "brew", group: "Homebrew formulae", install: "brew install pandoc", check: "command -v pandoc", size: 600 * MIB },
  { id: "npm/turbo", name: "turbo", manager: "npm", group: "npm globals", install: "npm install -g turbo", check: "command -v turbo", version: "2.5.0" },
];

describe("the Also screen", () => {
  it("draws one row per tool under its manager, with the install line and the size measured here", () => {
    const items = alsoItems(scan, bare, "darwin");
    expect(items.map(i => i.group)).toEqual(["Homebrew formulae", "Homebrew formulae", "Homebrew formulae", "npm globals"]);
    expect(items[0]).toMatchObject({ id: "brew/just", label: "just", hint: { text: "4 MB" } });
    expect(items[0]!.detail[0]).toBe("brew install just");
    expect(items[3]!.detail[0]).toBe("npm install -g turbo");
    expect(items[3]!.detail[1]).toContain("2.5.0 here");
  });

  it("a scanned package this computer's collector listed as a tools row is that row: the tick lands on it, not on a custom row, its detail says what the build does with it, and an untick turns it off again", () => {
    const tap: ManifestEntry = { rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" };
    const manifest: Manifest = { entries: [tap, { rung: "tools", id: "tools/brew/just", label: "just", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" }] };
    const table = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], bytes: 4 * MIB, macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const own = (id: string, on: boolean): Recipe["rows"][number] => ({ id, kind: "tool", on, source: { kind: "installed", paths: [], bin: true } });
    const recipe: Recipe = { ...bare, rows: [own(tap.id, false), own("tools/brew/just", false)] };
    const diskbloom: ScanRow = { id: "brew/zingzy/tap/diskbloom", name: "zingzy/tap/diskbloom", manager: "brew", group: "Homebrew formulae", install: "brew install zingzy/tap/diskbloom", check: "brew list --versions zingzy/tap/diskbloom", size: 4 * MIB, version: "0.1.0" };
    const rows = [...scan, diskbloom];
    expect(ownRowOf(recipe, diskbloom)?.id).toBe(tap.id);
    expect(ownRowOf(recipe, scan[0]!)?.id).toBe("tools/brew/just");
    expect(ownRowOf(recipe, scan[1]!)).toBeUndefined();
    // What the build does: the release road for the tap formula the table names, Homebrew for the formula, nothing for a package with no row.
    expect(buildLine(manifest, diskbloom, table)).toBe("installs from its release: the v0.1.0 release of github.com/Zingzy/diskbloom");
    expect(buildLine(manifest, diskbloom, new Map())).toBe("left out of the build: no Linux bottle known");
    expect(buildLine(manifest, scan[0]!, table)).toBe("installs with Homebrew: brew install just");
    expect(buildLine(manifest, scan[1]!, table)).toBeUndefined();
    const items = alsoItems(rows, recipe, "darwin", r => buildLine(manifest, r, table));
    expect(items.find(i => i.id === diskbloom.id)!.detail).toEqual(["installs from its release: the v0.1.0 release of github.com/Zingzy/diskbloom", "installed on this Mac, 0.1.0"]);
    expect(items.find(i => i.id === diskbloom.id)!.hint).toEqual({ text: "4 MB" });
    // A package with no row of its own keeps the screen's words for a custom row.
    expect(items.find(i => i.id === "brew/llvm")!.detail).toEqual(["brew install llvm", "installs on the machine after everything in the catalog"]);
    // A tick on it ticks the recipe's row and writes no custom row; the row stays off until then; an untick turns it off again.
    expect(scannedTicks(recipe, rows)).toEqual(new Set());
    const ticked = withScanned(recipe, rows, new Set([diskbloom.id, "brew/llvm"]), "darwin");
    expect(ticked.rows.find(r => r.id === tap.id)?.on).toBe(true);
    expect(ticked.rows.find(r => r.id === "tools/brew/just")?.on).toBe(false);
    expect(ticked.custom?.map(c => c.id)).toEqual(["brew/llvm"]);
    expect(scannedTicks(ticked, rows)).toEqual(new Set([diskbloom.id, "brew/llvm"]));
    const unticked = withScanned(ticked, rows, new Set(), "darwin");
    expect(unticked.rows.find(r => r.id === tap.id)?.on).toBe(false);
    expect(unticked.custom).toEqual([]);
  });

  it("a custom row an earlier run wrote for a package that now has a row of its own is stale: the screen starts unticked and drops it on the first pass, and a tick installs the package once, by its own row", () => {
    const tap = "tools/brew/zingzy/tap/diskbloom";
    const own = (on: boolean): Recipe["rows"][number] => ({ id: tap, kind: "tool", on, source: { kind: "installed", paths: [], bin: true } });
    const diskbloom: ScanRow = { id: "brew/zingzy/tap/diskbloom", name: "zingzy/tap/diskbloom", manager: "brew", group: "Homebrew formulae", install: "brew install zingzy/tap/diskbloom", check: "brew list --versions zingzy/tap/diskbloom", size: 4 * MIB };
    const stale = customFromScanAt(diskbloom);
    const recipe: Recipe = { ...bare, rows: [own(false)], custom: [stale, { kind: "custom", id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", why: "added by the agent" }] };
    const rows = [...scan, diskbloom];
    expect(scannedTicks(recipe, rows)).toEqual(new Set());
    const untouched = withScanned(recipe, rows, new Set(), "darwin");
    expect(untouched.rows.find(r => r.id === tap)?.on).toBe(false);
    expect(untouched.custom?.map(c => c.id)).toEqual(["cuda"]);
    const ticked = withScanned(recipe, rows, new Set([diskbloom.id]), "darwin");
    expect(ticked.rows.find(r => r.id === tap)?.on).toBe(true);
    expect(ticked.custom?.map(c => c.id)).toEqual(["cuda"]);
  });

  it("says so when nothing here measured a size", () => {
    expect(alsoItems(scan, bare, "darwin")[3]!.hint).toEqual({ text: "size unknown" });
  });

  it("colours a heavy row's size by weight and leaves a small one plain", () => {
    // styleText reads FORCE_COLOR at each call, so colour is on for this test alone.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    onTestFinished(() => {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    });
    const items = alsoItems(scan, bare, "darwin");
    const paint = (i: number): ((padded: string) => string) | undefined => (typeof items[i]!.hint === "object" ? items[i]!.hint.paint : undefined);
    // The paint runs on the padded cell, so a colour never changes the column's width.
    expect(paint(0)).toBeUndefined();
    expect(paint(1)!("2 GB")).toBe("\x1b[31m2 GB\x1b[39m");
    expect(paint(2)!("600 MB")).toBe("\x1b[93m600 MB\x1b[39m");
    expect(paint(3)).toBeUndefined();
  });

  it("a manager's header counts its ticked rows and what they weigh here", () => {
    const items = alsoItems(scan, bare, "darwin");
    const brew = items.filter(i => i.group === "Homebrew formulae");
    const line = alsoGroupLine(scan);
    expect(line(brew, { ticks: new Set(), answers: new Map() })).toBe("0 of 3  0 B");
    expect(line(brew, { ticks: new Set(["brew/just", "brew/llvm"]), answers: new Map() })).toBe("2 of 3  2 GB");
  });

  it("starts every row off: nothing here goes on the image unasked", () => {
    expect(scannedTicks(bare, scan)).toEqual(new Set());
  });

  it("writes a ticked row into the recipe as a row of its own, with the install, the check and the size", () => {
    const recipe = withScanned(bare, scan, new Set(["brew/just"]), "darwin");
    expect(recipe.custom).toEqual([
      { kind: "custom", id: "brew/just", name: "just", install: ["brew install just"], check: "command -v just", manager: "brew", size: 4 * MIB, why: "installed on this Mac by brew" },
    ]);
    expect(scannedTicks(recipe, scan)).toEqual(new Set(["brew/just"]));
  });

  it("keeps a row somebody added by hand under a name a manager also lists, and ticks only the scanned rows it wrote", () => {
    const both: ScanRow[] = [
      { id: "uv/ruff", name: "ruff", manager: "uv", group: "uv and pipx tools", install: "uv tool install ruff", check: "command -v ruff" },
      { id: "pipx/ruff", name: "ruff", manager: "pipx", group: "uv and pipx tools", install: "pipx install ruff", check: "command -v ruff" },
    ];
    const byHand = { kind: "custom" as const, id: "ruff", name: "ruff", install: ["uv tool install ruff --python 3.12"], check: "command -v ruff", why: "used in wsp" };
    const recipe = withScanned({ ...bare, custom: [byHand] }, both, new Set(["uv/ruff"]), "darwin");
    expect(recipe.custom).toEqual([byHand, { kind: "custom", id: "uv/ruff", name: "ruff", install: ["uv tool install ruff"], check: "command -v ruff", manager: "uv", why: "installed on this Mac by uv" }]);
    expect(scannedTicks(recipe, both)).toEqual(new Set(["uv/ruff"]));
    // A second pass over the same screen leaves the hand-written row where it was.
    expect(withScanned(recipe, both, new Set(), "darwin").custom).toEqual([byHand]);
  });

  it("takes a row away again when the screen is left with it unticked, and leaves rows from anywhere else alone", () => {
    const added = withScanned({ ...bare, custom: [{ kind: "custom", id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", why: "added by the agent" }] }, scan, new Set(["brew/just"]), "darwin");
    expect(added.custom?.map(r => r.id)).toEqual(["cuda", "brew/just"]);
    const cleared = withScanned(added, scan, new Set(), "darwin");
    expect(cleared.custom?.map(r => r.id)).toEqual(["cuda"]);
  });
});

describe("the screen as a terminal draws it", () => {
  function streams() {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, rows: 30 });
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    return { input, output, text: () => stripVTControlCharacters(chunks.join("")), raw: () => chunks.join("") };
  }
  const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));

  it("draws a header per manager with what is ticked, every row off, the heavy sizes in their tone, and the install line under the cursor", async () => {
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    onTestFinished(() => {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    });
    const o = streams();
    const done = rungSelect({ title: alsoTitle("darwin"), top: alsoTop("darwin"), counter: "3/6", items: alsoItems(scan, bare, "darwin"), initial: new Set(), groupLine: alsoGroupLine(scan), input: o.input, output: o.output });
    await settle();
    // Down to the first row under the first manager, so the detail pane is that row's.
    o.input.write("\x1b[B\x1b[B");
    await settle();
    const t = o.text();
    expect(t).toContain("Also on this Mac  3/6");
    expect(t).toContain("Homebrew formulae");
    expect(t).toContain("npm globals");
    expect(t).toContain("0 of 3  0 B");
    expect(t).toContain("You can change this later.");
    expect(t).toContain("brew install just");
    // Red for the row past a gigabyte, orange for the one in the middle tier; the small row and the unmeasured one carry no hue.
    expect(o.raw()).toContain("\x1b[31m");
    expect(o.raw()).toContain("\x1b[93m");
    o.input.write("\x1b");
    await done;
  });
});
