// SPDX-License-Identifier: AGPL-3.0-only
// The one table both wsp recipe and wsp init's second screen draw: which rows
// it makes of a recipe, the order they come in, what each says about why it is
// on and what it costs, and the styles the columns take at each colour depth.
import { CATALOG, type CatalogEntry } from "@wsp/catalog";
import type { Recipe } from "@wsp/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { GREY, grey } from "../src/init-layout.js";
import { HEAVY_BYTES } from "@wsp/collect";
import { ADDED_GROUP, BASE_GROUP, CATALOG_GROUP, FLOOR_LINE, GROUP_LABEL, GROUP_ORDER, HERE_GROUP, PROJECT_GROUP, USED_GROUP, groupTotal, recipeTable, sizeCell, sizeText, tableLines, totalsLine, whyCell, type TableRow } from "../src/init-table.js";
import { RECIPE } from "./init-fixture.js";

/** A few catalog entries, in the catalog's own order. */
const slice = (...ids: string[]): CatalogEntry[] => CATALOG.filter(e => ids.includes(e.id));
const used = (id: string, sessions: number, calls: number): Recipe["rows"][number] => ({ id, kind: "tool", on: true, source: { kind: "used", sessions, calls } });
const installed = (id: string, kind: "agent" | "tool" = "tool"): Recipe["rows"][number] => ({ id, kind, on: true, source: { kind: "installed", paths: [], bin: true } });
const with_ = (...rows: Recipe["rows"]): Recipe => ({ ...RECIPE, rows: [...RECIPE.rows.filter(r => !rows.some(n => n.id === r.id)), ...rows] });
const shape = (rows: readonly TableRow[]): string[][] => rows.map(r => [r.on ? "on" : "off", r.name, r.why, sizeText(r)]);

describe("the table of what travels", () => {
  it("one row per catalog entry: the tick, why it is here in this computer's own words, and the size its install downloads", () => {
    expect(shape(recipeTable(with_(used("go", 3, 40)), slice("ripgrep", "claude", "go")))).toEqual([
      ["on", "ripgrep", "always on the image", "4 MB"],
      ["on", "Go", "40 commands in 3 sessions", "239 MB"],
      ["on", "Claude Code", "installed here, never used", "208 MB"],
    ]);
    // An agent this computer has run says how much; one it has never run says that, and one it does not have says that.
    const histories = [{ agent: "claude", state: "read" as const, sessions: 151, calls: 4000 }];
    expect(shape(recipeTable({ ...RECIPE, histories }, slice("claude", "codex")))).toEqual([
      ["on", "Claude Code", "used here, 151 sessions", "208 MB"],
      ["off", "Codex", "not installed here", "455 MB"],
    ]);
    // A row the recipe never named falls to the catalog's own evidence.
    expect(shape(recipeTable({ ...RECIPE, rows: [] }, slice("go", "ripgrep")))).toEqual([
      ["on", "ripgrep", "always on the image", "4 MB"],
      ["off", "Go", "in the catalog, on request", "239 MB"],
    ]);
    expect(recipeTable(RECIPE, slice("gh"))[0]).toMatchObject({ name: "GitHub CLI", group: HERE_GROUP, heavy: false });
    expect(recipeTable(RECIPE, slice("gh"))[0]!.size).toBe(42188962);
    expect(shape(recipeTable(RECIPE, slice("op")))).toEqual([["off", "1Password CLI", "in the catalog, on request", "41 MB"]]);
  });

  it("a row under the floor says so beside its counts, a heavy row against its own, and the footer names the floor once", () => {
    const why = (r: Recipe["rows"][number]): string => recipeTable(with_(r), slice(r.id))[0]!.why;
    expect(why(used("wrangler", 1, 2))).toBe("below the floor, 2 commands in 1 session");
    expect(why(used("wrangler", 2, 6))).toBe("6 commands in 2 sessions");
    expect(why(used("java", 3, 5))).toBe("heavy, below the floor, 5 commands in 3 sessions");
    expect(why(used("java", 4, 30))).toBe("30 commands in 4 sessions");
    expect(FLOOR_LINE).toBe("on when used in 2 sessions and 5 commands; heavy rows 3 and 20");
    // Under a rule that never weighs use there is no floor to be below, so the counts stand alone.
    const under = (tick: Recipe["tick"]): string => recipeTable({ ...with_(used("wrangler", 1, 2)), ...(tick !== undefined ? { tick } : {}) }, slice("wrangler"))[0]!.why;
    expect(under("installed")).toBe("2 commands in 1 session");
    expect(under("default")).toBe("2 commands in 1 session");
    expect(under("used")).toBe("below the floor, 2 commands in 1 session");
    expect(under(undefined)).toBe("below the floor, 2 commands in 1 session");
  });

  it("a row the agent added is its own group after the installed ones, on, with the install line as its why", () => {
    const custom = [
      { kind: "custom" as const, id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" },
      { kind: "custom" as const, id: "cuda", name: "cuda", install: ["apt-get install -y cuda"], check: "command -v cuda", size: 2_000_000_000, why: "used in ml" },
    ];
    const rows = recipeTable({ ...with_(installed("gh")), custom }, slice("ripgrep", "gh", "go"));
    expect(shape(rows)).toEqual([
      ["on", "ripgrep", "always on the image", "4 MB"],
      ["on", "GitHub CLI", "installed here, never used", "40 MB"],
      ["on", "cuda", "apt-get install -y cuda", "1.9 GB"],
      ["on", "just", "brew install just", "size unknown"],
      ["off", "Go", "in the catalog, on request", "239 MB"],
    ]);
    expect(rows[2]).toMatchObject({ id: "cuda", kind: "custom", group: ADDED_GROUP, base: false, heavy: true });
    // A custom row without a size is the one kind the totals cannot count.
    expect(totalsLine(rows)).toBe("On: 4 rows, 1.9 GB, 1 of unknown size");
    expect(GROUP_LABEL[ADDED_GROUP]).toBe("added");
    // The agents table never carries one, and a recipe with none draws no such row.
    expect(recipeTable({ ...RECIPE, custom }, slice("claude")).map(r => r.id)).toEqual(["claude"]);
    expect(recipeTable(RECIPE, slice("ripgrep", "gh", "go")).some(r => r.group === ADDED_GROUP)).toBe(false);
  });

  it("an agent wsp cannot drive says so on its row, and the one it can says nothing", () => {
    expect(recipeTable(RECIPE, slice("claude"))[0]!.note).toBeUndefined();
    expect(recipeTable(RECIPE, slice("codex"))[0]!.note).toBeUndefined();
    expect(recipeTable(RECIPE, slice("gemini"))[0]!.note).toBe("installs, but wsp cannot run its threads yet");
  });

  it("the groups come in one order and the heavy rows first inside their own", () => {
    const rows = recipeTable(with_(installed("codex", "agent"), used("go", 3, 40), used("wrangler", 4, 9)), slice("ripgrep", "gh", "claude", "codex", "go", "wrangler"));
    expect(rows.map(r => r.group)).toEqual([BASE_GROUP, USED_GROUP, USED_GROUP, HERE_GROUP, HERE_GROUP, HERE_GROUP]);
    // Codex is over 300 MB, so it comes before the two lighter rows its group holds.
    expect(rows.map(r => r.name)).toEqual(["ripgrep", "Go", "Cloudflare Wrangler", "Codex", "Claude Code", "GitHub CLI"]);
    expect(rows.filter(r => r.heavy).map(r => r.name)).toEqual(["Codex"]);
    expect(HEAVY_BYTES).toBe(300 * 1024 * 1024);
    expect(GROUP_ORDER).toEqual(["Always on the image", "Your project needs", "You use these", "Installed here, never used", "Added by your agent", "Also in the catalog"]);
  });

  it("a row the project's own files asked for is its own group, first after the base, and its why line is the file that asked", () => {
    const project = (id: string, why: string): Recipe["rows"][number] => ({ id, kind: "tool", on: true, source: { kind: "project", why } });
    const rows = recipeTable(with_(project("go", "go.mod needs Go"), used("wrangler", 4, 9), installed("yq")), slice("ripgrep", "go", "wrangler", "yq"));
    expect(rows.map(r => r.group)).toEqual([BASE_GROUP, PROJECT_GROUP, USED_GROUP, HERE_GROUP]);
    expect(shape(rows)).toEqual([
      ["on", "ripgrep", "always on the image", "4 MB"],
      ["on", "Go", "go.mod needs Go", "239 MB"],
      ["on", "Cloudflare Wrangler", "9 commands in 4 sessions", "239 MB"],
      ["on", "yq", "installed here, never used", "14 MB"],
    ]);
    // A floor row the project also named stays in the base: it installs whatever anyone ticks.
    expect(recipeTable(with_(project("git", "the project is a git repository")), slice("git"))[0]).toMatchObject({ group: BASE_GROUP, why: "always on the image" });
    expect(GROUP_LABEL[PROJECT_GROUP]).toBe("project");
  });

  it("the totals: what comes, what it downloads, and how many sizes the catalog does not have", () => {
    expect(totalsLine(recipeTable(with_(used("go", 3, 40)), slice("ripgrep", "claude", "go")), "tools")).toBe("On: 3 tools, 452 MB");
    expect(totalsLine(recipeTable({ ...RECIPE, rows: [] }, slice("claude", "go", "ripgrep")))).toBe("On: 1 row, 4 MB");
    expect(totalsLine(recipeTable(with_(used("op", 1, 1)), slice("op", "ripgrep")))).toBe("On: 2 rows, 45 MB");
    expect(totalsLine([])).toBe("On: 0 rows, 0 B");
    // A group's header carries the same two facts over its own rows, the base counted as rows and not as ticks.
    expect(groupTotal(recipeTable(with_(used("go", 3, 40)), slice("ripgrep", "go")).filter(r => r.base))).toBe("1  4 MB");
    expect(groupTotal(recipeTable(with_(used("go", 3, 40), used("wrangler", 1, 1)), slice("go", "wrangler")))).toBe("2 of 2  479 MB");
    expect(groupTotal(recipeTable({ ...RECIPE, rows: [] }, slice("go", "java")))).toBe("0 of 2  0 B");
  });

  it("as text: the tick, the name, the why column, and the size flush right, each column as wide as its widest cell", () => {
    expect(tableLines(recipeTable(with_(used("go", 3, 40)), slice("ripgrep", "claude", "go")), 1)).toEqual([
      "●  ripgrep      base       always on the image           4 MB",
      "●  Go           used       40 commands in 3 sessions   239 MB",
      "●  Claude Code  installed  installed here, never used  208 MB",
    ]);
    expect(tableLines(recipeTable({ ...RECIPE, rows: [] }, slice("go")), 1)).toEqual(["○  Go  catalog    in the catalog, on request  239 MB"]);
    expect(tableLines([], 1)).toEqual([]);
  });

  it("the why column takes a style per group from 256 colours up, and the group's word instead at 16", () => {
    // styleText reads FORCE_COLOR at each call, so the accent is on for this test alone.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    onTestFinished(() => {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    });
    const rows = recipeTable(with_(installed("codex", "agent"), used("go", 3, 40)), slice("ripgrep", "claude", "codex", "go", "java"));
    const painted = rows.map(r => whyCell(r, 8)).map(c => c.paint!(c.text));
    const opener = painted.map(p => p.slice(0, p.indexOf("m") + 1));
    // Four groups, four styles: what this computer ran in the accent, the rest down the grey ramp.
    expect(new Set(opener).size).toBe(4);
    expect(rows.map(r => r.group)).toEqual([BASE_GROUP, USED_GROUP, HERE_GROUP, HERE_GROUP, CATALOG_GROUP]);
    expect(opener).toEqual(["\x1b[38;5;239m", "\x1b[36m", "\x1b[38;5;247m", "\x1b[38;5;247m", "\x1b[38;5;243m"]);
    expect(whyCell(rows[4]!, 8).paint!("x")).toBe(grey(GREY.mid, "x"));
    // At 16 colours the group's word carries what the shade cannot, in a column of its own.
    expect(rows.map(r => whyCell(r, 4).text)).toEqual([
      "base       always on the image",
      "used       40 commands in 3 sessions",
      "installed  installed here, never used",
      "installed  installed here, never used",
      "catalog    in the catalog, on request",
    ]);
    expect(rows.every(r => whyCell(r, 4).paint === undefined)).toBe(true);
    expect(GROUP_LABEL[BASE_GROUP]).toBe("base");
  });

  it("a heavy size is drawn a step brighter than the rest, and only where there are shades for it", () => {
    const [codex, claude] = recipeTable(with_(installed("codex", "agent")), slice("codex", "claude"));
    expect(sizeCell(codex!, 8).paint!("455 MB")).toBe(grey(GREY.bright, "455 MB"));
    expect(sizeCell(claude!, 8).paint).toBeUndefined();
    expect(sizeCell(codex!, 4)).toEqual({ text: "455 MB" });
  });
});
