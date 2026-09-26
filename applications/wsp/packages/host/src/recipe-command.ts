// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file and
// printed as one table, with the rule that decided the ticks named on the
// command line and single rows flipped by id. Names and counts only; the
// histories are read here and nothing of them leaves.
import { existsSync } from "node:fs";
import { THREAD_AGENTS, agentName, catalogEntry, readsRowRoad } from "@wsp/catalog";
import { type AgentHistory, type HistoryCache, type HistoryProgress, type Host, computeRecipe, unknownCommands } from "@wsp/collect";
import { LOGIN_CHOICES, RECIPE_TICKS, addAlreadyHereFix, addAlreadyHereLine, customRows, plural, thisComputer, usageRefusal, type Recipe, type RecipeCustomRow, type RecipeHistory, type LoginChoice, type RecipeTick, type ToolPin } from "@wsp/protocol";
import { loadRecipe, outsideRow, outsideRowsOf, ownRowIdOf, ownRowOf, pinsOf, saveSmallRecipe, withPins } from "./recipe-file.js";
import { customFromFlags, customFromScan, withCustom, withoutCustom } from "./recipe-custom.js";
import { recipeAnswer, recipeScan, type RecipeAnswer, type RecipeScan } from "./recipe-answer.js";
import { candidatesLine } from "./init-table.js";
import type { ScanRow } from "./scan.js";

/** What an agent's history here came to, the words a spinner's line and the app's reading row both carry. */
export function historyWord(h: RecipeHistory): string {
  switch (h.state) {
    case "read":
      return `${plural(h.sessions, "session")}, ${plural(h.calls, "tool call")}`;
    case "empty":
      return "no history here";
    case "unreadable":
      return "history is here but could not be read";
    case "no-reader":
      return "no reader for its history yet";
    default: {
      const _exhaustive: never = h.state;
      return _exhaustive;
    }
  }
}

/** One line per agent: what its history here said. */
export function historyLine(h: RecipeHistory): string {
  return `${agentName(h.agent)}: ${historyWord(h)}`;
}

/** One line while an agent's store is read: how far through its own session files the read is, so a first run on a
 * computer with hundreds of them counts them off instead of sitting on a bare spinner. */
export function historyProgressLine(p: HistoryProgress): string {
  return `${agentName(p.agent)}: reading session ${p.read} of ${p.files}`;
}

/** What a `--set` word says: the row it names and the tick it is to have. Only the word's shape is judged here; which
 * row the id names is answered once the file and this computer have been read, since a catalog row, a row the file
 * already carries outside the catalog and a package a manager here has are all rows a word may name. */
export function parseSet(word: string): { id: string; on: boolean } {
  const eq = word.indexOf("=");
  const id = eq < 0 ? word : word.slice(0, eq);
  const value = eq < 0 ? "" : word.slice(eq + 1);
  if (value !== "on" && value !== "off") throw usageRefusal(`--set takes <id>=on or <id>=off, and got ${JSON.stringify(word)}.`, "Write the row id, an equals sign, then on or off.");
  return { id, on: value === "on" };
}

/** The ticks the `--set` words ask for, later words winning over earlier ones. */
export function parseSets(words: readonly string[]): Map<string, boolean> {
  return new Map(words.map(parseSet).map(({ id, on }) => [id, on]));
}

/** The recipe with the asked-for rows flipped; every other row keeps the rule's tick. */
export function applySets(recipe: Recipe, sets: ReadonlyMap<string, boolean>): Recipe {
  if (sets.size === 0) return recipe;
  return { ...recipe, rows: recipe.rows.map(r => (sets.has(r.id) ? { ...r, on: sets.get(r.id) === true } : r)) };
}

export function isRecipeTick(word: string): word is RecipeTick {
  return (RECIPE_TICKS as readonly string[]).includes(word);
}

/** The catalog row and the word a `--signin` says of it. A word the row cannot take is not refused here: the
 * sign-ins screen falls back to the first word that row does take, which is where that rule lives. */
export function parseSignIn(word: string): { id: string; choice: LoginChoice } {
  const eq = word.indexOf("=");
  const id = eq < 0 ? word : word.slice(0, eq);
  const choice = eq < 0 ? "" : word.slice(eq + 1);
  if (!(LOGIN_CHOICES as readonly string[]).includes(choice)) throw usageRefusal(`--signin takes <id>=${LOGIN_CHOICES.join("|")}, and got ${JSON.stringify(word)}.`, `Write the row id, an equals sign, then one of ${LOGIN_CHOICES.join(", ")}.`);
  if (catalogEntry(id) === undefined) throw usageRefusal(`--signin ${word}: the catalog has no row called ${JSON.stringify(id)}.`, "Run wsp recipe scan to read the rows this computer offers.");
  return { id, choice: choice as LoginChoice };
}

/** The sign-in answers the `--signin` words ask for, later words winning over earlier ones. */
export function parseSignIns(words: readonly string[]): Map<string, LoginChoice> {
  return new Map(words.map(parseSignIn).map(({ id, choice }) => [id, choice]));
}

/** The recipe with the asked-for sign-in answers written on; every other row keeps the answer it had. */
export function applySignIns(recipe: Recipe, answers: ReadonlyMap<string, LoginChoice>): Recipe {
  if (answers.size === 0) return recipe;
  return { ...recipe, rows: recipe.rows.map(r => (answers.has(r.id) ? { ...r, signIn: answers.get(r.id)! } : r)) };
}

export interface RecipeInput {
  /** Where the recipe file lives; it is read for the ticks a `set` adds to, and rewritten. */
  out: string;
  /** Which rule decides every tick; the file's own rule, else `used`. */
  tick?: RecipeTick;
  /** `<id>=on` or `<id>=off`, repeatable: applied over the rule, on top of the ticks already in the file. */
  set?: readonly string[];
  /** `<id>=<one of LOGIN_CHOICES>`, repeatable: what happens to that row's sign-in. */
  signin?: readonly string[];
  /** `<id>=<install command>`, repeatable: a tool the catalog does not carry, added to the file beside the rows. */
  add?: readonly string[];
  /** `<id>=<command that exits 0 once it is there>` for an added row; without one the id on PATH is the check. */
  addCheck?: readonly string[];
  /** Marks the recipe so every workspace from its image gets the place's container engine through the fenced
   * socket. Once in the file it stands through every later run; editing the file is how it comes off. */
  engine?: boolean;
  /** What the added rows say they are for; the agent's own words. */
  why?: string;
  /** Folders to weigh the histories against, absolute: only sessions that ran in one of them count. */
  projects?: readonly string[];
  /** Keeps what each session file came to, so a second run reads only the histories that changed. */
  cache?: HistoryCache;
  /** What else a package manager on this computer has, as the Also screen reads it. Handed in as it is to the
   * scan, since the reader reaches the engine and the MCP server may not. Both a `--set` word naming a package and
   * an `--add` word are answered against it. Without it nothing is here, so a `--set` no catalog row and no row of
   * the file answers is refused, and an `--add` is taken as a row of its own: only a package the scan lists is a
   * row already, and an unread manager lists none. */
  alsoHere?: (recipe: readonly RecipeCustomRow[]) => Promise<readonly ScanRow[]>;
}

export interface RecipeIo {
  /** The table and the file's path: what a caller reads as the answer. */
  log(line: string): void;
  /** Progress while this computer is read; never part of the answer. */
  note(line: string): void;
}

const QUIET: RecipeIo = { log: () => {}, note: () => {} };

/** This computer's recipe with the ticks the file already carries written back on, row by row: a row the file names
 * keeps the tick it was left with, and a row it does not name (the catalog grew since it was written) keeps the
 * rule's own; the rule is the file's, so the ticks and the words beside them come from the same one. Unlike the
 * wizard's rule, the file is not the authority on rows it lacks. Sign-in answers do not travel here: they are the
 * person's under every rule, so savedSignIns carries them. */
export function withSavedTicks(computed: Recipe, saved: Recipe): Recipe {
  const on = new Map(saved.rows.map(r => [r.id, r.on]));
  return { ...computed, rows: computed.rows.map(r => (on.has(r.id) ? { ...r, on: on.get(r.id) === true } : r)) };
}

/** The sign-in answers a saved recipe carries. No rule decides one: `computeRecipe` never writes a `signIn`, so a
 * run that lets the rule decide every tick would drop the person's answers on the floor if these did not travel. */
export function savedSignIns(saved: Recipe | undefined): Map<string, LoginChoice> {
  return new Map((saved?.rows ?? []).flatMap((r): [string, LoginChoice][] => (r.signIn === undefined ? [] : [[r.id, r.signIn]])));
}

/** The recipe already at this path, or nothing when there is none. A file nobody can read is about to be rewritten
 * anyway, so what it held is named rather than the run stopping: the ticks, the sign-in answers and the rows it
 * added all go with it, and saying so is better than a run that refuses to write anything. */
export function readSaved(out: string, note: (line: string) => void): Recipe | undefined {
  if (!existsSync(out)) return undefined;
  try {
    return loadRecipe(out);
  } catch (e) {
    note(`${out} could not be read (${e instanceof Error ? e.message : String(e)}); it is rewritten, and its ticks, sign-in answers and added rows go with it.`);
    return undefined;
  }
}

/** What a recipe already at this path carries that no rule on this computer decides: the rows an agent added, the
 * ticks on this computer's tools rows the catalog does not carry, and the pins the last seal recorded, which the
 * file shows until the next seal writes its own. Both writers of that file, the recipe verb and the wizard, read it
 * through readSaved, so neither writes over what the other put there. */
export function carriedOver(out: string, log: (line: string) => void): { custom?: RecipeCustomRow[]; ticks: Map<string, boolean>; pins: Map<string, ToolPin> } {
  const saved = readSaved(out, log);
  return { ...(saved?.custom === undefined ? {} : { custom: saved.custom }), ticks: new Map(outsideRowsOf(saved).map(r => [r.id, r.on])), pins: pinsOf(saved?.rows) };
}

/** Whether the run named something the rule reads, so the rule decides every row again rather than the file standing. */
const namesRule = (input: RecipeInput): boolean => input.tick !== undefined || (input.projects ?? []).length > 0;

/** Which row a `--set` word's id names, and the package it named when it named one. Three ids reach a row: a catalog
 * row's own, a row the file already carries outside the catalog, and a package a manager on this computer has, by the
 * id the scan gives it. That last one is the Also screen's row: its tick lands on the collector's id for the package,
 * so the build installs it by the road the plan resolves rather than by a line of its own. */
export function setTarget(id: string, saved: Recipe | undefined, scan: readonly ScanRow[]): { id: string; pkg?: ScanRow } | undefined {
  if (catalogEntry(id) !== undefined || outsideRowsOf(saved).some(r => r.id === id)) return { id };
  const pkg = scan.find(r => r.id === id);
  return pkg === undefined ? undefined : { id: ownRowIdOf(pkg), pkg };
}

/** The recipe with a row of its own for each of these packages, off and found here, so the tick has a row to land
 * on: the recipe verb's side of the wizard's withOutsideRows, which reads the collector's manifest this verb has
 * not got. A package the recipe already carries a row for is left as it is. */
export function withOwnRows(recipe: Recipe, pkgs: readonly ScanRow[]): Recipe {
  const rows = [...new Set(pkgs.flatMap(p => (ownRowOf(recipe, p) === undefined ? [ownRowIdOf(p)] : [])))].map(id => outsideRow(id));
  return rows.length === 0 ? recipe : { ...recipe, rows: [...recipe.rows, ...rows] };
}

/** The package a manager on this computer already has under an `--add` word's id, by that id or by the package's own
 * name: such a package is a row of its own, and a second row for it is a second install. */
const scannedFor = (row: RecipeCustomRow, scan: readonly ScanRow[]): ScanRow | undefined => scan.find(r => r.id === row.id || r.name === row.id);

/** What the scan reads; it decides nothing, so it names no recipe file. */
export interface ScanInput {
  /** Folders to weigh the histories by, absolute. */
  projects?: readonly string[];
  /** Keeps what each session file came to, so a second scan reads only the histories that changed. */
  cache?: HistoryCache;
  /** What else a package manager on this computer has. Handed in rather than imported: the scanner reaches the
   * engine for its sizes and its road lines, and the MCP server may not, so its caller decides whether it runs.
   * Absent, the scan says nothing looked rather than that nothing was found. */
  alsoHere?: (recipe: readonly RecipeCustomRow[]) => Promise<readonly ScanRow[]>;
}

/** Reads this computer once and answers with every option it offers and what to do about each. No recipe and no
 * answer is written, so a caller can run it before the person has decided anything; the cache of what the session
 * files came to is, since reading them all again on the next call is what this is not for. The rule is `used`: the
 * recommendation is what the person's own agents reach for, and every other row is there to be turned on knowingly. */
export async function runScan(host: Host, input: ScanInput = {}, io: RecipeIo = QUIET, now?: () => Date): Promise<RecipeScan> {
  io.note("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const histories: AgentHistory[] = [];
  const recipe = await computeRecipe(host, {
    tick: "used",
    threadAgents: THREAD_AGENTS,
    ...(input.cache !== undefined ? { cache: input.cache } : {}),
    ...(input.projects !== undefined && input.projects.length > 0 ? { folders: input.projects } : {}),
    ...(now !== undefined ? { now } : {}),
    onHistory: h => {
      histories.push(h);
      io.note(historyLine(h));
    },
    // The rows a folder asked for are in the table under their own group; the names the catalog has no row for are
    // nowhere else, so they are said here rather than dropped.
    onProject: scan => {
      const line = candidatesLine(scan);
      if (line !== undefined) io.note(`${scan.dir}: ${line}`);
    },
  });
  const alsoHere = input.alsoHere !== undefined ? await input.alsoHere(customRows(recipe)) : undefined;
  return recipeScan(recipe, unknownCommands(histories), alsoHere);
}

/** Reads this computer, writes the recipe and answers with the table. The file is the state: a run that names a rule
 * input (`tick` or `projects`) lets the rule decide every tick again, and any other run keeps what the file already
 * says and puts this run's flips on top. A row the file never carried always takes the rule's answer. Sign-in
 * answers stand through every run, whatever the rule: nothing but the person decides one. */
export async function runRecipe(host: Host, input: RecipeInput, io: RecipeIo = QUIET, now?: () => Date): Promise<RecipeAnswer> {
  const sets = parseSets(input.set ?? []);
  // The shape of every word is judged before this computer is read: a line that cannot be parsed costs no scan.
  const added = customFromFlags({ add: input.add ?? [], ...(input.addCheck !== undefined ? { addCheck: input.addCheck } : {}), ...(input.why !== undefined ? { why: input.why } : {}) });
  const saved = readSaved(input.out, io.note);
  // What this computer's package managers have, read only when a word needs it: which row a `--set` word that
  // names no catalog row and no row of the file names, and whether an `--add` word names a package that is a row.
  const needsScan = added.length > 0 || [...sets.keys()].some(id => setTarget(id, saved, []) === undefined);
  const here = needsScan && input.alsoHere !== undefined ? await input.alsoHere(saved === undefined ? [] : customRows(saved)) : [];
  for (const row of added) {
    const already = scannedFor(row, here);
    if (already !== undefined) throw usageRefusal(addAlreadyHereLine(host.platform, row.id), addAlreadyHereFix(already.id));
  }
  const looked = input.alsoHere !== undefined ? `, and no package a manager on ${thisComputer(host.platform)} has that id` : "";
  const targets = [...sets].map(([id, on]) => {
    const target = setTarget(id, saved, here);
    if (target === undefined) throw usageRefusal(`--set ${id}=${on ? "on" : "off"}: ${JSON.stringify(id)} is no catalog row and no row of ${input.out} outside the catalog${looked}.`, "Run wsp recipe scan to read the rows this computer offers.");
    return { ...target, on };
  });
  // A package whose road the build cannot read off a row of its own is ticked as an added row carrying the scan's
  // install line, the road the Also screen takes for it; every other word names a row the recipe carries.
  const asAdded = targets.flatMap(t => (t.pkg !== undefined && !readsRowRoad(t.pkg.manager) ? [{ pkg: t.pkg, on: t.on }] : []));
  const asRow = targets.filter(t => t.pkg === undefined || readsRowRoad(t.pkg.manager));
  const ticks = new Map(asRow.map(t => [t.id, t.on]));
  const packages = asRow.flatMap(t => (t.pkg === undefined ? [] : [t.pkg]));
  // The file's answers first, this run's words over them; a word never given leaves the file's answer standing.
  const signIns = new Map([...savedSignIns(saved), ...parseSignIns(input.signin ?? [])]);
  // The rule this run goes on: the one named, else the one the file was written under, else `used` on a first run.
  // A file that names none is the wizard's, whose rule is the blended one, so computeRecipe is left to decide.
  const named = input.tick ?? saved?.tick;
  const rule = named !== undefined ? { tick: named } : saved !== undefined ? {} : { tick: "used" as const };
  io.note("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const histories: AgentHistory[] = [];
  const computed = await computeRecipe(host, {
    ...rule,
    threadAgents: THREAD_AGENTS,
    ...(input.cache !== undefined ? { cache: input.cache } : {}),
    ...(input.projects !== undefined && input.projects.length > 0 ? { folders: input.projects } : {}),
    ...(now !== undefined ? { now } : {}),
    onHistory: h => {
      histories.push(h);
      io.note(historyLine(h));
    },
    // The rows a folder asked for are in the table under their own group; the names the catalog has no row for are
    // nowhere else, so they are said here rather than dropped.
    onProject: scan => {
      const line = candidatesLine(scan);
      if (line !== undefined) io.note(`${scan.dir}: ${line}`);
    },
  });
  const base = saved !== undefined && !namesRule(input) ? withSavedTicks(computed, saved) : computed;
  // The rows outside the catalog are the file's, not this computer's: an earlier run's stand, so --add adds up, and
  // the wizard's ticks on this computer's own formulae and globals are kept, since no rule here reads those rows.
  // They join the rows before the flips, so a --set reaches one of them as it reaches a catalog row.
  // The pins the builds recorded are facts about the golden, not ticks: they stand through every rule.
  const carried = withCustom({ ...base, rows: [...base.rows, ...outsideRowsOf(saved)], ...(saved !== undefined ? { custom: [...customRows(saved)] } : {}) }, [...added, ...asAdded.filter(x => x.on).map(x => customFromScan(x.pkg, host.platform))]);
  const decided = applySignIns(applySets(withOwnRows(carried, packages), ticks), signIns);
  // A package ticked as its own row keeps no added row of an earlier run beside it: the row's road installs it once.
  // An untick of a package that has no such row takes its added row away, which is what its tick wrote.
  const engine = input.engine === true || saved?.engine === true;
  const recipe = { ...withPins(withoutCustom(decided, new Set([...packages.map(p => p.id), ...asAdded.filter(x => !x.on).map(x => x.pkg.id)])), pinsOf(saved?.rows)), ...(engine ? { engine: true } : {}) };
  saveSmallRecipe(input.out, recipe);
  return recipeAnswer(recipe, input.out, unknownCommands(histories));
}
