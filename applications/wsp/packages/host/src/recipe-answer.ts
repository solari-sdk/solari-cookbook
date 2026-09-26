// SPDX-License-Identifier: AGPL-3.0-only
// What `wsp recipe` and `wsp recipe scan` answer with: the rows the shared
// table renderer builds, plus what only these two verbs know, which is what to
// do about each row and why. The rows, their groups, their words and the heavy
// rule all come from init-table, so the verbs and the wizard's screens can
// never say different things about the same recipe; nothing here draws a
// second table of catalog rows.
import { CATALOG_AGENTS, CATALOG_TOOLS, keysIdOf, livesOnComputer, loginIdOf, loginRow, mintsToken, signsInByDefault, hasLogin } from "@wsp/catalog";
import { type CommandCount, type Platform, floorApplies } from "@wsp/collect";
import { RecipeCustomRow, RecipeTick, ToolPin, alsoTitle, customRows, fmtBytes, type Recipe } from "@wsp/protocol";
import { z } from "zod";
import { table } from "./init-layout.js";
import { FLOOR_LINE, GROUP_ORDER, USED_GROUP, recipeTable, tableLines, totalsLine, type TableRow } from "./init-table.js";
import type { ScanRow } from "./scan.js";
import { signInFor, signInWords } from "./signin-table.js";

/** How many of the uncatalogued commands the printout shows: enough to see the shape of the person's work. */
export const COMMANDS_SHOWN = 12;

/** One catalog row as an answer carries it: the shared renderer's row, named field by field so a client reading
 * this over MCP has a shape and not a table of text. */
export const RecipeAnswerRow = z.object({
  /** The catalog id, the same word `--set` takes; for this computer's tools row outside the catalog, the collector's
   * id; for an added row, the id `--add` gave it. */
  id: z.string(),
  kind: z.enum(["agent", "tool", "custom"]),
  name: z.string(),
  on: z.boolean(),
  /** On the image whatever is ticked, so nothing can turn it off. */
  base: z.boolean(),
  /** Which of the renderer's groups it reads under. */
  group: z.enum(GROUP_ORDER),
  why: z.string(),
  /** What its install downloads, when the catalog measured it. */
  size: z.number().int().nonnegative().optional(),
  /** Big enough to put to the person before anything is built. */
  heavy: z.boolean(),
  /** Why wsp cannot drive this agent yet; absent on every other row. */
  note: z.string().optional(),
  /** What the last seal installed for this row; absent on a row no seal has read. */
  pin: ToolPin.optional(),
});
export type RecipeAnswerRow = z.infer<typeof RecipeAnswerRow>;

export const RecipeCommand = z.object({ name: z.string(), calls: z.number().int().nonnegative(), sessions: z.number().int().nonnegative() });
export type RecipeCommand = z.infer<typeof RecipeCommand>;

const rowOf = (r: TableRow): RecipeAnswerRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  on: r.on,
  base: r.base,
  group: r.group,
  why: r.why,
  ...(r.size !== undefined ? { size: r.size } : {}),
  heavy: r.heavy,
  ...(r.note !== undefined ? { note: r.note } : {}),
  ...(r.pin !== undefined ? { pin: r.pin } : {}),
});

/** The agents and the tools as the shared renderer groups and orders them, which is the order both screens draw. */
export const answerRows = (recipe: Recipe): { agents: RecipeAnswerRow[]; tools: RecipeAnswerRow[] } => ({
  agents: recipeTable(recipe, CATALOG_AGENTS).map(rowOf),
  tools: recipeTable(recipe, CATALOG_TOOLS).map(rowOf),
});

export const RecipeAnswer = z.object({
  /** Which rule decided the ticks; absent on a recipe that names none, as the wizard's own do. */
  tick: RecipeTick.optional(),
  /** When the recipe was read off this computer, ISO 8601. */
  at: z.string(),
  /** Where the recipe file sits. */
  out: z.string(),
  agents: z.array(RecipeAnswerRow),
  tools: z.array(RecipeAnswerRow),
  /** Every ticked row the catalog measured, added up. */
  totalBytes: z.number().int().nonnegative(),
  /** The ticked rows the renderer calls heavy, biggest first: the ones to put to the person before the build. */
  heavy: z.array(RecipeAnswerRow),
  /** The commands the agents ran here that no catalog row carries, most-run first. */
  commands: z.array(RecipeCommand),
  /** The rows this recipe installs that the catalog has none for, as the file carries them. */
  custom: z.array(RecipeCustomRow),
});
export type RecipeAnswer = z.infer<typeof RecipeAnswer>;

/** Both tables' rows in the order they are drawn, for a caller that wants the whole recipe in one list. */
export const allRows = (a: Pick<RecipeAnswer, "agents" | "tools">): RecipeAnswerRow[] => [...a.agents, ...a.tools];

/** The ticked rows worth a question, biggest first. */
export const heavyRows = <T extends { on: boolean; heavy: boolean; size?: number }>(rows: readonly T[]): T[] => rows.filter(r => r.on && r.heavy).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

/** What the ticked rows add up to on the machine, of the ones the catalog measured. */
export const totalBytes = (rows: readonly RecipeAnswerRow[]): number => rows.reduce((n, r) => n + (r.on ? (r.size ?? 0) : 0), 0);

/** The recipe as the verb and the MCP tool answer with it. */
export function recipeAnswer(recipe: Recipe, out: string, commands: readonly CommandCount[] = []): RecipeAnswer {
  const { agents, tools } = answerRows(recipe);
  const all = [...agents, ...tools];
  return {
    ...(recipe.tick !== undefined ? { tick: recipe.tick } : {}),
    at: recipe.at,
    out,
    agents,
    tools,
    totalBytes: totalBytes(all),
    heavy: heavyRows(all),
    commands: commands.map(c => ({ name: c.name, calls: c.calls, sessions: c.sessions })),
    custom: [...customRows(recipe)],
  };
}

/** A row as the shared renderer draws one: every field it needs is on the row already, so the verbs draw the same
 * table the wizard's screens draw and add only the column each of them knows. */
export const drawn = (r: RecipeAnswerRow): TableRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  on: r.on,
  base: r.base,
  group: r.group,
  why: r.why,
  ...(r.size !== undefined ? { size: r.size } : {}),
  heavy: r.heavy,
  ...(r.note !== undefined ? { note: r.note } : {}),
  ...(r.pin !== undefined ? { pin: r.pin } : {}),
});

/** What sits under the Tools table's totals: the floor, once, when the rule the recipe went on weighs use. */
export const floorLines = (tick: RecipeTick | undefined): string[] => (floorApplies(tick) ? [FLOOR_LINE] : []);

/** The two tables the shared renderer draws, each under its title with its own totals line, the floor under the tools. */
export function answerTables(a: Pick<RecipeAnswer, "tick" | "agents" | "tools">, depth: number): string[] {
  return ([["Agents", a.agents, "agents"] as const, ["Tools", a.tools, "tools"] as const]).flatMap(([title, rows, noun], i) => {
    const table = rows.map(drawn);
    return [...(i > 0 ? [""] : []), title, ...tableLines(table, depth), totalsLine(table, noun), ...(noun === "tools" ? floorLines(a.tick) : [])];
  });
}

export const COMMANDS_TITLE = "Commands your agents ran that the catalog does not carry:";

/** What this person works with that no catalog row installs, most-run first. */
export function commandTableLines(commands: readonly RecipeCommand[], shown = COMMANDS_SHOWN): string[] {
  if (commands.length === 0) return [COMMANDS_TITLE, "  none"];
  const rows = commands.slice(0, shown);
  return [
    COMMANDS_TITLE,
    ...table([["command", "calls", "sessions"], ...rows.map(c => [c.name, String(c.calls), String(c.sessions)])], ["left", "right", "right"]).map(l => `  ${l}`),
    ...(commands.length > rows.length ? [`  and ${commands.length - rows.length} more`] : []),
  ];
}

/** Everything the recipe verb and the MCP tool print: the two tables, the rows an agent added among the tools, then
 * the commands. */
export function recipePrintout(answer: RecipeAnswer, depth = 1): string[] {
  return [...answerTables(answer, depth), "", ...commandTableLines(answer.commands)];
}

// --- the scan: every option, with what an agent should do about each ------------------------------------------

/** What that section says when nothing looked, which is not the same answer as nothing being found. */
export const NOT_SCANNED = "nothing looked for them here";

export const RecipeAdvice = z.object({
  /** What to do without asking: `on` or `off` for a tick row, one of the sign-in words for a sign-in row. */
  value: z.string(),
  /** Why, in one line, so an agent can put the few rows worth a question and apply the rest. */
  why: z.string(),
});
export type RecipeAdvice = z.infer<typeof RecipeAdvice>;

export const RecipeScanRow = RecipeAnswerRow.extend({ recommended: RecipeAdvice });
export type RecipeScanRow = z.infer<typeof RecipeScanRow>;

export const RecipeScanSignIn = z.object({
  id: z.string(),
  name: z.string(),
  /** What signing in there runs, or why there is nothing to run. */
  signIn: z.string(),
  recommended: RecipeAdvice,
});
export type RecipeScanSignIn = z.infer<typeof RecipeScanSignIn>;

export const RecipeScanAlso = z.object({
  /** Whether anything looked at all, so a reader tells empty from unscanned. */
  scanned: z.boolean(),
  managers: z.array(z.object({ manager: z.string(), rows: z.array(z.object({ id: z.string(), install: z.string(), size: z.number().int().nonnegative().optional() })) })),
});
export type RecipeScanAlso = z.infer<typeof RecipeScanAlso>;

export const RecipeScan = z.object({
  tick: RecipeTick,
  at: z.string(),
  agents: z.array(RecipeScanRow),
  tools: z.array(RecipeScanRow),
  totalBytes: z.number().int().nonnegative(),
  heavy: z.array(RecipeScanRow),
  alsoHere: RecipeScanAlso,
  commands: z.array(RecipeCommand),
  signIns: z.array(RecipeScanSignIn),
});
export type RecipeScan = z.infer<typeof RecipeScan>;

/** What to do with a row without asking, and why: the rule's own tick, with the one thing that makes a row worth a
 * question said in the same line, and on an agent held off because wsp cannot run its threads, that too, since its
 * own why alone would argue for on. Nothing else here is a delta. */
export function tickAdvice(row: RecipeAnswerRow): RecipeAdvice {
  const size = row.size;
  if (row.on) return { value: "on", why: row.heavy && size !== undefined ? `${row.why}; ${fmtBytes(size)} on the machine, worth a question` : row.why };
  return { value: "off", why: row.note !== undefined && row.group === USED_GROUP ? `${row.why}; ${row.note}` : row.why };
}

/** What to do with a row's sign-in without asking: key files beside a login come first, since key brings them and
 * still leaves the login itself to run on the machine, so it gets what either other word gets alone; then a browser
 * or device login runs on the machine, anything else that exists only here travels by copy, and the rest is skipped. */
export function signInAdvice(id: string): RecipeAdvice {
  const s = signInFor(loginIdOf(id));
  if (mintsToken(s)) return { value: "token", why: `${s.mint} runs here and the token is set on every turn; nothing of it is on any machine` };
  if (livesOnComputer(s)) return { value: "later", why: "it signs in once on the computer that runs the workspaces, never on a machine of its own" };
  if (loginRow(keysIdOf(id)) !== undefined) return { value: "key", why: "no sign-in there produces its keys, so they travel and it still signs in on the machine" };
  if (signsInByDefault(s)) return { value: "machine", why: "a browser sign-in the machine finishes; nothing of it is copied" };
  if (hasLogin(s) || (s.kind !== "shell" && s.sources.length > 0)) return { value: "copy", why: "nothing there produces it, so what is here travels" };
  return { value: "skip", why: "nothing to sign in to and nothing here to bring" };
}

/** The scan's own rows grouped under the manager that has them, in the order the scanner found them; nothing
 * having looked is not the same answer as nothing having been found, so an absent list says so. */
export function alsoHereOf(rows: readonly ScanRow[] | undefined): RecipeScanAlso {
  if (rows === undefined) return { scanned: false, managers: [] };
  const managers = new Map<string, { manager: string; rows: { id: string; install: string; size?: number }[] }>();
  for (const r of rows) {
    const group = managers.get(r.group) ?? { manager: r.group, rows: [] };
    group.rows.push({ id: r.id, install: r.install, ...(r.size !== undefined ? { size: r.size } : {}) });
    managers.set(r.group, group);
  }
  return { scanned: true, managers: [...managers.values()] };
}

/** Every option this computer offers, read once: the agents and tools with the rule's tick and what to do about
 * each, the tools outside the catalog a manager here has, the commands the catalog does not carry, and the sign-in
 * each ticked row brings. Nothing is written. */
export function recipeScan(recipe: Recipe, commands: readonly CommandCount[] = [], alsoHere?: readonly ScanRow[]): RecipeScan {
  const { agents, tools } = answerRows(recipe);
  const withAdvice = (rows: readonly RecipeAnswerRow[]): RecipeScanRow[] => rows.map(r => ({ ...r, recommended: tickAdvice(r) }));
  const all = [...withAdvice(agents), ...withAdvice(tools)];
  const on = all.filter(r => r.on);
  return {
    tick: recipe.tick ?? "used",
    at: recipe.at,
    agents: withAdvice(agents),
    tools: withAdvice(tools),
    totalBytes: totalBytes(all),
    heavy: heavyRows(all),
    alsoHere: alsoHereOf(alsoHere),
    commands: commands.map(c => ({ name: c.name, calls: c.calls, sessions: c.sessions })),
    signIns: on.flatMap((r): RecipeScanSignIn[] => {
      const s = signInFor(loginIdOf(r.id));
      if (s.kind === "shell") return [];
      return [{ id: r.id, name: r.name, signIn: signInWords(s), recommended: signInAdvice(r.id) }];
    }),
  };
}

export const SIGN_INS_TITLE = "Sign-ins the ticked rows bring:";

export function signInTableLines(rows: readonly RecipeScanSignIn[]): string[] {
  if (rows.length === 0) return [SIGN_INS_TITLE, "  none"];
  return [SIGN_INS_TITLE, ...table([["id", "sign in", "do"], ...rows.map(r => [r.id, r.signIn, r.recommended.value])]).map(l => `  ${l}`)];
}

/** What the section on tools outside the catalog says: the rows by manager, or that nothing looked for them. */
export function alsoHereLines(also: RecipeScanAlso, platform: Platform): string[] {
  const title = alsoTitle(platform);
  if (!also.scanned) return [title, `  ${NOT_SCANNED}`];
  if (also.managers.length === 0) return [title, "  none"];
  return [
    title,
    ...also.managers.flatMap(m => [`  ${m.manager}`, ...table(m.rows.map(r => [r.id, r.install, r.size === undefined ? "size unknown" : fmtBytes(r.size)]), ["left", "left", "right"]).map(l => `    ${l}`)]),
  ];
}

/** The whole scan on the terminal: the two tables with what to do beside each row, the tools outside the catalog,
 * the commands, the sign-ins. */
export function scanPrintout(s: RecipeScan, platform: Platform, depth = 1): string[] {
  return [
    ...adviceTables(s, depth),
    "",
    ...alsoHereLines(s.alsoHere, platform),
    "",
    ...commandTableLines(s.commands),
    "",
    ...signInTableLines(s.signIns),
  ];
}

/** The shared renderer's lines with the do column beside them, the floor under the tools. */
export function adviceTables(s: RecipeScan, depth: number): string[] {
  return ([["Agents", s.agents, "agents"] as const, ["Tools", s.tools, "tools"] as const]).flatMap(([title, rows, noun], i) => {
    const table = rows.map(drawn);
    const lines = tableLines(table, depth);
    const width = Math.max(0, ...lines.map(l => l.length));
    return [...(i > 0 ? [""] : []), title, ...lines.map((l, n) => `${l.padEnd(width)}  ${rows[n]!.recommended.value}`), totalsLine(table, noun), ...(noun === "tools" ? floorLines(s.tick) : [])];
  });
}
