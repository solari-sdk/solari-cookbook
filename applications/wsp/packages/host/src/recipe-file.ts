// SPDX-License-Identifier: AGPL-3.0-only
// Where the small recipe and the cache of what the session histories came to
// live on this computer, and how the recipe is read and written. Nothing here
// reaches past the catalog, the protocol and the collector, so the MCP server
// can write a recipe without the runtime or the engine coming with it.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { catalogEntry, loginIdOf } from "@wsp/catalog";
import { type HistoryCache, fileHistoryCache } from "@wsp/collect";
import { issuesLine, Recipe, toolRowId, type RecipeRow, type ToolPin } from "@wsp/protocol";

/** Where the small recipe lives, beside the saved manifest: what wsp recipe writes and wsp init --recipe reads. */
export function smallRecipePath(statePath: string): string {
  return join(dirname(statePath), "recipe.json");
}

/** What each of the agents' session files came to, beside the state: the one place that path is decided, so the
 * wizard, the recipe verb and the MCP tools all read and rewrite the same cache and none of them reads a session
 * file another already read. */
export function historyCache(statePath: string): HistoryCache {
  return fileHistoryCache(join(dirname(statePath), "history-cache.json"));
}

/** The small recipe wsp recipe wrote (or a person or an agent did), checked against the protocol's shape. */
export function loadRecipe(path: string): Recipe {
  if (!existsSync(path)) throw new Error(`no recipe at ${path}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = Recipe.safeParse(data);
  if (r.success) return r.data;
  throw new Error(`${path}: invalid recipe: ${issuesLine(r.error.issues)}`);
}

/** What the file at `path` is right now, for telling a recipe that arrived from one that was already there: its size
 * and the nanosecond of its last write, or nothing when no file is there. A recipe beside the state is not proof
 * that a caller's own write landed, since the first launch writes one and so does wsp recipe; a caller that waits
 * for a write takes this first and waits for it to change. */
export function recipeStamp(path: string): string | undefined {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.size}:${s.mtimeNs}`;
  } catch {
    return undefined;
  }
}

export function saveSmallRecipe(path: string, recipe: Recipe): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`);
}

/** The pins a list of rows carries, by id: a recipe's rows by catalog id, a manifest's entries by row id. */
export function pinsOf(rows: readonly { id: string; pin?: ToolPin }[] | undefined): Map<string, ToolPin> {
  return new Map((rows ?? []).flatMap((r): [string, ToolPin][] => (r.pin === undefined ? [] : [[r.id, r.pin]])));
}

/** Whether a recipe row is a tools row the catalog does not carry, filed under the collector's own id: this
 * computer's formula or global, ticked by the file or the person and by no rule. */
export const outsideCatalog = (r: Pick<RecipeRow, "id">): boolean => catalogEntry(r.id) === undefined;

/** The rows of a recipe outside the catalog, in the recipe's order; none of a recipe that is not there. */
export const outsideRowsOf = (recipe: Pick<Recipe, "rows"> | undefined): RecipeRow[] => (recipe?.rows ?? []).filter(outsideCatalog);

/** A tools row the catalog does not carry as a row of the small recipe: under the collector's own id, off until
 * something ticks it, found here as its source. Both hands that write one, the wizard's screens and the recipe
 * verb, make it here, so a row's shape does not depend on which of them wrote it. */
export const outsideRow = (id: string, paths: readonly string[] = []): RecipeRow => ({ id, kind: "tool", on: false, source: { kind: "installed", paths: [...paths], bin: true } });

/** The row id a package a manager here lists has in a recipe: the collector's id for that manager and
 * package. The one rule the Also screen and the recipe verb both tick such a package by. */
export const ownRowIdOf = (pkg: { manager: string; name: string }): string => toolRowId(pkg.manager, pkg.name);

/** The recipe's own row for such a package, when it carries one. */
export const ownRowOf = (recipe: Pick<Recipe, "rows"> | undefined, pkg: { manager: string; name: string }): RecipeRow | undefined =>
  outsideRowsOf(recipe).find(r => r.id === ownRowIdOf(pkg));

/** The recipe with no pin on any row: the ask alone, as the record keeps it beside the pins the seal read. */
export function withoutPins(recipe: Recipe): Recipe {
  return { ...recipe, rows: recipe.rows.map(r => { const { pin: _pin, ...rest } = r; return rest; }) };
}

/** The recipe with these pins written on the rows they name; every other row keeps what it had. */
export function withPins(recipe: Recipe, pins: ReadonlyMap<string, ToolPin>): Recipe {
  if (pins.size === 0) return recipe;
  return { ...recipe, rows: recipe.rows.map(r => (pins.has(r.id) ? { ...r, pin: pins.get(r.id)! } : r)) };
}

/** This computer's recipe with a saved one's ticks and answers written on, by id: a row the saved one lacks is off
 * and unanswered, and a saved catalog row this computer's recipe does not carry follows them as it was saved, since
 * its catalog road installs it anywhere. A saved row outside the catalog that this computer has no row of its own
 * for does not: only the computer that has the tool knows how it installs, so the caller says it was left out. The
 * added rows (`custom`) are the saved recipe's own: nothing on this computer decides them. The saved pins are what
 * an earlier seal got and come along on no row: this cut reads its own. */
export function withTicksOf(here: Recipe, saved: Recipe): Recipe {
  const rows = new Map(saved.rows.map(r => [r.id, r]));
  const ids = new Set(here.rows.map(r => r.id));
  return {
    ...here,
    ...(saved.custom !== undefined ? { custom: saved.custom } : {}),
    rows: [
      ...here.rows.map(r => {
        const { signIn: _signIn, ...rest } = r;
        const s = rows.get(r.id);
        return { ...rest, on: s?.on === true, ...(s?.signIn === undefined ? {} : { signIn: s.signIn }) };
      }),
      ...saved.rows.filter(r => !ids.has(r.id) && !outsideCatalog(r)).map(r => { const { pin: _pin, ...rest } = r; return rest; }),
    ],
  };
}
