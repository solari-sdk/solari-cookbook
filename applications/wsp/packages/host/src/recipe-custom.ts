// SPDX-License-Identifier: AGPL-3.0-only
// The rows a recipe carries that the catalog does not: how `wsp recipe --add`
// and the MCP recipe tool read them and how they join a recipe, and how a
// package the scan found becomes one; the table draws them under their own
// group. The install line runs as given, so nothing here rewrites one; a row
// outside the catalog is never offered a sign-in. Nothing here reaches the
// engine: the MCP server reads these rules and may not.
import type { Platform } from "@wsp/collect";
import { ADDED_BY_AGENT, commandCheck, customRows, thisComputer, usageRefusal, type Recipe, type RecipeCustomRow } from "@wsp/protocol";
import type { ScanRow } from "./scan.js";

/** `<id>=<value>`, split at the first equals; both sides have to be there. */
export function parsePair(flag: string, spec: string): { id: string; value: string } {
  const at = spec.indexOf("=");
  const id = at < 0 ? "" : spec.slice(0, at).trim();
  const value = at < 0 ? "" : spec.slice(at + 1).trim();
  if (id === "" || value === "") throw usageRefusal(`${flag} takes <id>=<command>, and got ${JSON.stringify(spec)}.`, `Write it as ${flag} <id>="<command>", the id first and the command it runs behind the equals sign.`);
  return { id, value };
}

export interface AddFlags {
  /** `<id>=<install command>`, one per row; repeated ids are one row, the last line winning. */
  add: readonly string[];
  /** `<id>=<command that exits 0 when installed>`; a row without one is checked with its id on PATH. */
  addCheck?: readonly string[];
  /** What the rows say they are for; the agent's own words, or that it added them. */
  why?: string;
}

/** The rows the flags name, in the order they were given. A check for an id nobody added is an error, since the
 * command it would guard never runs. */
export function customFromFlags(flags: AddFlags): RecipeCustomRow[] {
  const checks = new Map((flags.addCheck ?? []).map(spec => {
    const { id, value } = parsePair("--add-check", spec);
    return [id, value];
  }));
  const rows = new Map<string, RecipeCustomRow>();
  for (const spec of flags.add) {
    const { id, value } = parsePair("--add", spec);
    rows.set(id, { kind: "custom", id, name: id, install: [value], check: checks.get(id) ?? commandCheck(id), why: flags.why ?? ADDED_BY_AGENT });
  }
  for (const id of checks.keys()) if (!rows.has(id)) throw usageRefusal(`--add-check ${id}: nothing was added under that id.`, `Add the row first with --add ${id}="<command>", or name a row this line already adds.`);
  return [...rows.values()];
}

/** The recipe with these rows on it: a row already there under the same id is replaced, the rest keep their order. */
export function withCustom(recipe: Recipe, rows: readonly RecipeCustomRow[]): Recipe {
  const added = new Map(rows.map(r => [r.id, r]));
  const kept = customRows(recipe).map(r => added.get(r.id) ?? r);
  const known = new Set(kept.map(r => r.id));
  return { ...recipe, custom: [...kept, ...rows.filter(r => !known.has(r.id))] };
}

/** The recipe with the added rows under these ids gone. What both hands that tick a package by its own row do to a
 * custom row for the same package: two rows for one package are two installs, and the row's own road is the one the
 * plan resolves. */
export function withoutCustom(recipe: Recipe, ids: ReadonlySet<string>): Recipe {
  return { ...recipe, custom: customRows(recipe).filter(r => !ids.has(r.id)) };
}

/** A scan row as a recipe row. The id is the scan row's own, the manager and the package: two managers can carry
 * one name (uv and pipx both list ruff), and two rows under one id would be two installs, two digest ticks and one
 * check for both. The name is the package alone, which is what the screen and the table read. */
export function customFromScan(row: ScanRow, platform: Platform): RecipeCustomRow {
  return {
    kind: "custom",
    id: row.id,
    name: row.name,
    install: [row.install],
    check: row.check,
    manager: row.manager,
    ...(row.size !== undefined ? { size: row.size } : {}),
    why: `installed on ${thisComputer(platform)} by ${row.manager}`,
  };
}
