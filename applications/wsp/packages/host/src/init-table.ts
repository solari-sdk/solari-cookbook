// SPDX-License-Identifier: AGPL-3.0-only
// The one table of what a recipe moves: every catalog agent and tool as a row
// with its tick, why it is here in the words the person's own machine gives,
// and the size its install downloads. wsp recipe prints it as text; wsp init's
// agents and tools screens are the same rows as a list.
import { CATALOG, CATALOG_AGENTS, runsThreads, type CatalogEntry, sizeBytes } from "@wsp/catalog";
import { HEAVY_USED_FLOOR, USED_FLOOR, type ProjectScan, floorApplies, isHeavy, meetsUsedFloor } from "@wsp/collect";
import { customRows, fmtBytes, pinWords, plural, type Recipe, type RecipeCustomRow, type RecipeRow, type ToolPin } from "@wsp/protocol";
import { GREY, GUTTER, accent, grey } from "./init-layout.js";
import type { Cell } from "./init-select.js";

/** The groups a row falls in, in reading order: what always comes, what this computer's agents ran, what is here
 * and unused, what an agent added outside the catalog, and the rest of the catalog. */
export const BASE_GROUP = "Always on the image";
export const PROJECT_GROUP = "Your project needs";
export const USED_GROUP = "You use these";
export const HERE_GROUP = "Installed here, never used";
export const ADDED_GROUP = "Added by your agent";
export const CATALOG_GROUP = "Also in the catalog";
export type Group = typeof BASE_GROUP | typeof PROJECT_GROUP | typeof USED_GROUP | typeof HERE_GROUP | typeof ADDED_GROUP | typeof CATALOG_GROUP;
/** The project's own needs come first after the base: a repo that will not build without a tool outranks anything
 * this computer happens to have. */
export const GROUP_ORDER = [BASE_GROUP, PROJECT_GROUP, USED_GROUP, HERE_GROUP, ADDED_GROUP, CATALOG_GROUP] as const;
/** The one word that stands for a group where colour cannot say it. */
export const GROUP_LABEL: Record<Group, string> = { [BASE_GROUP]: "base", [PROJECT_GROUP]: "project", [USED_GROUP]: "used", [HERE_GROUP]: "installed", [ADDED_GROUP]: "added", [CATALOG_GROUP]: "catalog" };
/** The one line under the table that says when use ticks a row, so a row reading "below the floor" can be placed. */
export const FLOOR_LINE = `on when used in ${plural(USED_FLOOR.sessions, "session")} and ${plural(USED_FLOOR.calls, "command")}; heavy rows ${HEAVY_USED_FLOOR.sessions} and ${HEAVY_USED_FLOOR.calls}`;
/** What a row reads where the catalog has measured no size. */
export const UNKNOWN_SIZE = "size unknown";

const TICK_ON = "●";
const TICK_OFF = "○";
const LABEL_WIDTH = Math.max(...Object.values(GROUP_LABEL).map(l => l.length));

/** One row of the table: a catalog entry with what the recipe made of it, or a row an agent added outside the catalog. */
export interface TableRow {
  id: string;
  kind: CatalogEntry["kind"] | RecipeCustomRow["kind"];
  name: string;
  on: boolean;
  /** Always on the image: on the machine whatever is ticked, so nothing can turn it off. */
  base: boolean;
  group: Group;
  /** Why it is here, with the counts behind it. */
  why: string;
  /** What its install downloads, where the catalog measured it. */
  size?: number;
  heavy: boolean;
  /** Why wsp cannot drive this agent yet; absent on every other row. */
  note?: string;
  /** What the last seal installed for this row, as the recipe file carries it; absent on a row no seal has read. */
  pin?: ToolPin;
}

/** How many sessions of this agent the recipe read on this computer. */
const sessionsOf = (recipe: Recipe, id: string): number => recipe.histories.find(h => h.agent === id)?.sessions ?? 0;

export function groupOf(e: CatalogEntry, r: RecipeRow | undefined, sessions: number): Group {
  if (e.kind === "tool" && e.floor) return BASE_GROUP;
  if (e.kind === "agent") return r?.source.kind === "installed" ? (sessions > 0 ? USED_GROUP : HERE_GROUP) : CATALOG_GROUP;
  switch (r?.source.kind) {
    case "project":
      return PROJECT_GROUP;
    case "used":
      return USED_GROUP;
    case "installed":
      return HERE_GROUP;
    default:
      return CATALOG_GROUP;
  }
}

/** The why column: the counts this computer gave, in the plainest words each group has, and where the rule weighs
 * use and the use is under the floor its size sets, that too, so a row that is off can be read and flipped knowingly. */
function whyLine(e: CatalogEntry, r: RecipeRow | undefined, sessions: number, size: number | undefined, tick: Recipe["tick"]): string {
  const group = groupOf(e, r, sessions);
  if (group === BASE_GROUP) return "always on the image";
  if (r?.source.kind === "project") return r.source.why;
  if (e.kind === "agent") return group === USED_GROUP ? `used here, ${plural(sessions, "session")}` : group === HERE_GROUP ? "installed here, never used" : "not installed here";
  if (r?.source.kind === "used") {
    const counts = `${plural(r.source.calls, "command")} in ${plural(r.source.sessions, "session")}`;
    if (!floorApplies(tick) || meetsUsedFloor(r.source, size)) return counts;
    return `${isHeavy(size) ? "heavy, below the floor" : "below the floor"}, ${counts}`;
  }
  if (group === HERE_GROUP) return "installed here, never used";
  return e.defaultOn ? "in the catalog, on by default" : "in the catalog, on request";
}

/** A row an agent added: on, since it is on the recipe at all, with the lines that install it as its why. */
function customTableRow(c: RecipeCustomRow): TableRow {
  return { id: c.id, kind: c.kind, name: c.name, on: true, base: false, group: ADDED_GROUP, why: c.install.join("; "), ...(c.size !== undefined ? { size: c.size } : {}), heavy: isHeavy(c.size) };
}

/** Every catalog entry as a row: the recipe's tick and source where it named one, the catalog's own evidence where
 * it did not; grouped by why it is here, the heavy rows first inside their group. The rows an agent added are
 * tools, so they join a table that draws tools and never the agents table. */
export function recipeTable(recipe: Recipe, catalog: readonly CatalogEntry[] = CATALOG): TableRow[] {
  const added = catalog.some(e => e.kind === "tool") ? customRows(recipe).map(customTableRow) : [];
  const rows = catalog.map((e): TableRow => {
    const r = recipe.rows.find(x => x.id === e.id);
    const base = e.kind === "tool" && e.floor;
    const size = r?.size ?? sizeBytes(e.size);
    const sessions = e.kind === "agent" ? sessionsOf(recipe, e.id) : 0;
    return {
      id: e.id,
      kind: e.kind,
      name: e.name,
      on: base || r?.on === true,
      base,
      group: groupOf(e, r, sessions),
      why: whyLine(e, r, sessions, size, recipe.tick),
      ...(size !== undefined ? { size } : {}),
      heavy: isHeavy(size),
      ...(e.kind === "agent" && !runsThreads(e.id) ? { note: "installs, but wsp cannot run its threads yet" } : {}),
      ...(r?.pin !== undefined ? { pin: r.pin } : {}),
    };
  });
  return GROUP_ORDER.flatMap(g => {
    const group = [...rows, ...added].filter(r => r.group === g);
    return [...group.filter(r => r.heavy), ...group.filter(r => !r.heavy)];
  });
}

/** The agents screen's rows: the ticked first, then by sessions here, the rest as the table orders them, so the agent
 * wsp drives sits on top and the cursor starts on it. The tools screen keeps the table's own heavy-first order. */
export function agentRows(recipe: Recipe): TableRow[] {
  return recipeTable(recipe, CATALOG_AGENTS).sort((a, b) => Number(b.on) - Number(a.on) || sessionsOf(recipe, b.id) - sessionsOf(recipe, a.id));
}

/** The names a project asked for that the catalog carries no row for, each with the file that asked; nothing when it
 * named none. One sentence, drawn by the recipe verb and by the wizard's card alike. */
export function candidatesLine(scan: ProjectScan): string | undefined {
  return scan.candidates.length === 0 ? undefined : `Not in the catalog: ${scan.candidates.map(n => `${n.name} (${n.why})`).join(", ")}`;
}

/** A row's size, or that the catalog has none for it. */
export const sizeText = (r: TableRow): string => (r.size === undefined ? UNKNOWN_SIZE : fmtBytes(r.size));

/** The style each group's why column takes from 256 colours up: what this computer ran in the accent, the rest down
 * the ramp. */
const PAINT: Record<Group, (s: string) => string> = {
  [BASE_GROUP]: s => grey(GREY.dim, s),
  [PROJECT_GROUP]: accent,
  [USED_GROUP]: accent,
  [HERE_GROUP]: s => grey(GREY.bright, s),
  [ADDED_GROUP]: accent,
  [CATALOG_GROUP]: s => grey(GREY.mid, s),
};

/** The why column: coloured by its group from 256 colours up, and under that the group's word ahead of it, since a
 * 16-colour terminal has no shade to spare. */
export function whyCell(r: TableRow, depth: number): Cell {
  if (depth >= 8) return { text: r.why, paint: PAINT[r.group] };
  return { text: `${GROUP_LABEL[r.group].padEnd(LABEL_WIDTH)}${GUTTER}${r.why}` };
}

/** The size column: heavy rows a step brighter than the rest, so weight is seen before it is read. */
export function sizeCell(r: TableRow, depth: number): Cell {
  return { text: sizeText(r), ...(r.heavy && depth >= 8 ? { paint: (s: string) => grey(GREY.bright, s) } : {}) };
}

/** What the ticked rows come to: how many, what they download, and how many of them the catalog has no size for. */
export function totalsLine(rows: readonly TableRow[], noun = "rows"): string {
  const on = rows.filter(r => r.on);
  const bytes = on.reduce((n, r) => n + (r.size ?? 0), 0);
  const unknown = on.filter(r => r.size === undefined).length;
  return `On: ${plural(on.length, noun.replace(/s$/, ""))}, ${fmtBytes(bytes)}${unknown > 0 ? `, ${unknown} of unknown size` : ""}`;
}

/** The rows of one group with their total: "You use these  3 of 7  1.2 GB". */
export function groupTotal(rows: readonly TableRow[]): string {
  const free = rows.filter(r => !r.base);
  const on = rows.filter(r => r.on);
  const bytes = on.reduce((n, r) => n + (r.size ?? 0), 0);
  const count = free.length === 0 ? String(rows.length) : `${free.filter(r => r.on).length} of ${free.length}`;
  return `${count}${GUTTER}${fmtBytes(bytes)}`;
}

/** The pin column: what the last seal installed, in the protocol's words; empty on a row no seal has read. */
export const pinText = (r: TableRow): string => (r.pin === undefined ? "" : pinWords(r.pin));

/** The table as lines of text: the tick, the name, why it is here, the size flush right, and, once any row carries
 * one, what the last seal installed; each column as wide as its widest cell. The tick takes the accent when the row comes. */
export function tableLines(rows: readonly TableRow[], depth: number): string[] {
  const cells = rows.map(r => ({ row: r, why: whyCell(r, depth), size: sizeCell(r, depth), pin: pinText(r) }));
  const width = (of: (c: (typeof cells)[number]) => string): number => Math.max(0, ...cells.map(of).map(t => t.length));
  const name = width(c => c.row.name);
  const why = width(c => c.why.text);
  const size = width(c => c.size.text);
  const pinned = cells.some(c => c.pin !== "");
  const paint = (c: Cell, padded: string): string => c.paint?.(padded) ?? padded;
  return cells.map(c => {
    const tick = c.row.on ? (depth > 1 ? accent(TICK_ON) : TICK_ON) : TICK_OFF;
    return [tick, c.row.name.padEnd(name), paint(c.why, c.why.text.padEnd(why)), paint(c.size, c.size.text.padStart(size)), ...(pinned ? [c.pin] : [])].join(GUTTER).trimEnd();
  });
}
