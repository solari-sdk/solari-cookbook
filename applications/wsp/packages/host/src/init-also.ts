// SPDX-License-Identifier: AGPL-3.0-only
// Also on this computer: the tools a package manager here could install on the
// image, grouped by manager, every row off until it is ticked; with no such
// tool the screen is not shown at all, by the protocol's rule. A tick on a
// package this computer's collector listed as a tools row ticks that row in
// the recipe, so the build installs it by the road the plan resolves (a tap
// formula from its release, pinned); a tick on any other package writes a row
// the catalog does not carry, with the manager's own install line. Unticking
// takes either away again, so the screen and the recipe say the same thing on
// a second pass.
import { styleText } from "node:util";
import { ROAD_MODULES } from "@wsp/catalog";
import type { Manifest, Platform } from "@wsp/collect";
import { toolInstallsFor, type BrewTable } from "@wsp/engine";
import { fmtBytes, customRows, installedHereLine, installsByLine, leftOutLine, thisComputer, type Recipe, type RecipeCustomRow } from "@wsp/protocol";
import { GUTTER } from "./init-layout.js";
import type { RungAnswer, SelectItem } from "./init-select.js";
import { sizeTone } from "./init-weight.js";
import { ownRowIdOf, ownRowOf } from "./recipe-file.js";
import { customFromScan, withCustom, withoutCustom } from "./recipe-custom.js";
import type { ScanRow } from "./scan.js";

/** The screen's title is the protocol's, since the `wsp recipe scan` section carries the same one. */
export { alsoTitle } from "@wsp/protocol";

export const alsoTop = (platform: Platform): string => `What else ${thisComputer(platform)} brings`;

/** What the build does with a scanned package that has a row of its own: the road in its words with the line the
 * step runs, or the plan's reason for setting it aside; nothing for a package with no such row, whose custom row runs
 * the manager's line as given. */
export function buildLine(manifest: Manifest, row: ScanRow, brew: BrewTable): string | undefined {
  const id = ownRowIdOf(row);
  const e = manifest.entries.find(x => x.id === id);
  if (e === undefined) return undefined;
  const plan = toolInstallsFor([{ ...e, bring: true }], brew);
  const step = plan.installs.find(t => t.id === id);
  const skipped = plan.skipped.find(t => t.id === id);
  return step !== undefined ? installsByLine(ROAD_MODULES[step.manager].words, step.shown ?? step.cmd) : skipped !== undefined ? leftOutLine(skipped.note) : undefined;
}

/** One row per scanned tool, grouped by its manager, with its size here. A heavy size takes its weight's colour, the
 * one hue on the row. The detail says what the build does: for a package with a row of its own, `build`'s line for
 * it and that it is on this computer; for any other, the manager's install line and that it runs after the catalog. */
export function alsoItems(rows: readonly ScanRow[], recipe: Recipe, platform: Platform, build: (row: ScanRow) => string | undefined = () => undefined): SelectItem[] {
  return rows.map(r => {
    const tone = sizeTone(r.size);
    const road = ownRowOf(recipe, r) !== undefined ? build(r) : undefined;
    const detail = road !== undefined ? [road, installedHereLine(platform, r.version)] : [r.install, r.version === undefined ? "installs on the machine after everything in the catalog" : `${r.version} here; installs on the machine after everything in the catalog`];
    return {
      id: r.id,
      label: r.name,
      group: r.group,
      hint: { text: r.size === undefined ? "size unknown" : fmtBytes(r.size), ...(tone !== undefined ? { paint: (padded: string) => styleText(tone, padded) } : {}) },
      detail,
    };
  });
}

/** A manager's header: how many of its rows are ticked and what they weigh here, as the tools screen counts its own. */
export function alsoGroupLine(rows: readonly ScanRow[]): (items: readonly SelectItem[], a: RungAnswer) => string {
  const by = new Map(rows.map(r => [r.id, r]));
  return (items, a) => {
    const on = items.filter(i => a.ticks.has(i.id));
    const bytes = on.reduce((n, i) => n + (by.get(i.id)?.size ?? 0), 0);
    return `${on.length} of ${items.length}${GUTTER}${fmtBytes(bytes)}`;
  };
}

/** The recipe with the screen's ticks on it: a scanned package with a row of its own is that row ticked or not; every
 * other ticked scan row is a custom row of its own, and a custom row an earlier pass of this screen added and nobody
 * ticked this time is gone. So is a custom row an earlier run wrote for a package that has a row of its own now: the
 * screen offered that package as its own row, and keeping both would install it twice. Rows from anywhere else are
 * left alone. */
export function withScanned(recipe: Recipe, rows: readonly ScanRow[], ticks: ReadonlySet<string>, platform: Platform): Recipe {
  const own = new Map(rows.flatMap(r => { const o = ownRowOf(recipe, r); return o === undefined ? [] : [[o.id, ticks.has(r.id)] as const]; }));
  const added = rows.filter(r => ticks.has(r.id) && !own.has(ownRowIdOf(r))).map((r): RecipeCustomRow => customFromScan(r, platform));
  const rowsOn = recipe.rows.map(r => {
    const on = own.get(r.id);
    return on === undefined ? r : { ...r, on };
  });
  return withCustom(withoutCustom({ ...recipe, rows: rowsOn }, new Set(rows.map(r => r.id))), added);
}

/** The scan rows the recipe already ticks, by their row id: what the screen starts ticked. A package with a row of its
 * own follows that row's tick; any other is ticked when the recipe carries its custom row. */
export function scannedTicks(recipe: Recipe, rows: readonly ScanRow[]): Set<string> {
  const carried = new Set(customRows(recipe).map(c => c.id));
  return new Set(rows.filter(r => ownRowOf(recipe, r)?.on ?? carried.has(r.id)).map(r => r.id));
}
