// SPDX-License-Identifier: AGPL-3.0-only
// What wsp init does with the collector's manifest: which rows start ticked,
// what a login defaults to, the recipe file (the same list with the person's
// ticks, saved next to the state so golden v2 is a re-run of it), and the
// golden recipe the ticked rows add up to.
import { basename, dirname, join } from "node:path";
import { writeOwn } from "@wsp/own-file";
import { LOGIN_CHOICES, type Manifest, type ManifestEntry, type Rung } from "@wsp/collect";
import { CATALOG_AGENTS, catalogEntry, catalogIdOfRow, catalogToolFor, guestEnv, hasLogin, loginIdOf, loginRow, loginSignIn, loginStatePaths, mintsToken } from "@wsp/catalog";
import { CATALOG_PREFIX, agentOwning, diffRecipes, isMcpRow, isTap, neverCopied, packageOf, parseMcpId, rowRoad, type BrewTable, type RecipeDigest } from "@wsp/engine";
import { Recipe, SIGN_IN_ANSWERS, type LoginChoice, type RecipeRow } from "@wsp/protocol";
import type { GoldenImport, GoldenRecipe, Machine } from "@wsp/runtime";
import type { Keys } from "./cli.js";
import { GUEST_ENVS } from "./doctor.js";
import { outsideRow } from "./recipe-file.js";
import { FISH_FILE, SH_FILE } from "./init-secrets.js";
export { loadRecipe, outsideCatalog, outsideRowsOf, pinsOf, saveSmallRecipe, smallRecipePath, withPins, withTicksOf } from "./recipe-file.js";

export const RUNG_TITLE: Record<Rung, string> = {
  identity: "Identity",
  shell: "Shell",
  toolchains: "Toolchains",
  tools: "Tools",
  agents: "Agents",
  logins: "Sign-ins",
};

/** The plan's note when every path of a row is refused by name, asked of the same rule the pack asks with the
 * same answer about what is on disk (`isDir`: true, false, or undefined when the path is not there). */
export function refusedNote(e: ManifestEntry, isDir: (rel: string) => boolean | undefined): string | undefined {
  if (e.rung === "tools" || e.paths.length === 0 || !e.paths.every(p => p.startsWith("~/"))) return undefined;
  const notes = e.paths.map(p => neverCopied(e, p.slice(2), isDir(p.slice(2))));
  return notes.every(n => n !== undefined) ? notes[0] : undefined;
}

/** The manifest with the plan's own reason written onto every row the pack would refuse whole, so the screen
 * locks it up front instead of taking a tick the pack throws away; every other row is left as it was. */
export function lockRefused(manifest: Manifest, isDir: (rel: string) => boolean | undefined): Manifest {
  return {
    ...manifest,
    entries: manifest.entries.map(e => {
      const note = e.reason === undefined ? refusedNote(e, isDir) : undefined;
      return note === undefined ? e : { ...e, default: "skip", reason: note };
    }),
  };
}

/** The tools rows without a package an agent on the Agents screen installs itself: one tool, one row, one install. */
export function withoutAgentTools(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const agents = new Set(entries.filter(e => e.rung === "agents").map(e => e.id));
  return entries.filter(e => {
    const agent = e.rung === "tools" ? agentOwning(e.id) : undefined;
    return agent === undefined || !agents.has(`agents/${agent}`);
  });
}

/** The command a CLI login is for, from the catalog tool its row is filed under; an agent's login follows its agent row instead (see loginShown). */
function loginBin(e: ManifestEntry): string | undefined {
  const entry = loginRow(agentName(e))?.entry;
  return entry?.kind === "tool" ? entry.bin : undefined;
}

/** The command a tools row puts on PATH, when a road installs the row: the catalog's answer, else the road's, else the package's name. */
function rowBin(t: ManifestEntry, brew: BrewTable): string | undefined {
  const planned = rowRoad(t, brew);
  if (planned === undefined) return undefined;
  const pkg = packageOf(t);
  return catalogToolFor(pkg)?.bin ?? planned.bin ?? pkg.slice(pkg.lastIndexOf("/") + 1);
}

/** What brings a command no tools row lists: its catalog entry, ticked under Tools. */
function brings(bin: string): string {
  const entry = catalogToolFor(bin);
  return entry !== undefined ? `tick ${entry.name} under Tools to bring it` : `installing ${bin} brings it`;
}

export interface LoginTool {
  /** The command the login is for. */
  bin: string;
  /** The tools row that puts it on the machine, when this computer has one. */
  row?: ManifestEntry;
  /** Whether the command lands on the machine with the ticks as they stand. */
  coming: boolean;
  /** When it is not coming: why, and what brings it. */
  why?: string;
}

/** Whether the command a CLI login needs is coming with the ticks so far; undefined for a login that follows an agent. */
export function loginTool(e: ManifestEntry, manifest: Manifest, coming: ReadonlySet<string>, brew: BrewTable): LoginTool | undefined {
  const bin = e.rung === "logins" ? loginBin(e) : undefined;
  if (bin === undefined) return undefined;
  const rows = manifest.entries.filter(t => t.rung === "tools" && rowBin(t, brew) === bin);
  const row = rows.find(r => coming.has(r.id)) ?? rows.find(isTickable) ?? rows[0];
  if (row === undefined) return { bin, coming: false, why: `${bin} is not coming: no row lists it; ${brings(bin)}` };
  if (!isTickable(row)) return { bin, row, coming: false, why: `${bin} is not coming: its tool row cannot come (${row.reason})` };
  if (!coming.has(row.id)) return { bin, row, coming: false, why: `${bin} is not coming: its tool row is unticked; copy or sign in ticks it` };
  return { bin, row, coming: true };
}

/** Every login answered copy or sign in ticks the row of the command it needs, when that row can come; the rows ticked, by label. */
export function tickLoginTools(manifest: Manifest, choices: ReadonlyMap<string, string>, ticks: Set<string>, brew: BrewTable): string[] {
  const added: string[] = [];
  for (const e of manifest.entries) {
    const choice = e.rung === "logins" ? choices.get(e.id) : undefined;
    if (choice === undefined || choice === "skip") continue;
    const tool = loginTool(e, manifest, ticks, brew);
    if (tool?.row === undefined || tool.coming || !isTickable(tool.row)) continue;
    ticks.add(tool.row.id);
    added.push(tool.row.label);
  }
  return added;
}

export function isTickable(e: ManifestEntry): boolean {
  return !(e.default === "skip" && e.reason !== undefined);
}

/** A row answered rather than ticked: a login (copy, sign in, skip) or a credential-shaped row (copy, skip). */
export function hasChoices(e: ManifestEntry): boolean {
  return e.rung === "logins" || e.consent === true;
}

export function initialTicks(e: ManifestEntry): boolean {
  if (!isTickable(e)) return false;
  if (e.required) return true;
  return e.bring ?? e.default === "bring";
}

/** The answer a login takes when no copy from this computer can carry it: its only road is then a browser, which
 * waits on the person, so it is left to the first time the tool is needed on a workspace. The one home for that rule,
 * read by the screens' default below and by every row a run flips because the copy it wanted cannot happen here. */
export const WITHOUT_A_COPY: LoginChoice = "later";

/** A login that cannot be copied (a reason, or a skip default) goes where WITHOUT_A_COPY says; signing in during the
 * build is the answer to move it to. A saved answer wins over both. */
export function initialChoice(e: ManifestEntry): LoginChoice {
  // A credential-shaped row copies only on a saved copy answer; a tick alone, or an answer it never offered, is skip.
  if (e.consent === true) return e.choice === "copy" ? "copy" : "skip";
  if (e.choice !== undefined) return e.choice;
  // A tool that mints its token on this computer has one road and it is not a machine's, so an unanswered row of
  // its own opens there rather than on a sign-in nobody would ever run.
  const signIn = loginSignIn(e.id);
  if (signIn !== undefined && mintsToken(signIn)) return "token";
  if (!isTickable(e)) return WITHOUT_A_COPY;
  if (e.bring !== undefined) return e.bring ? "copy" : WITHOUT_A_COPY;
  return e.default === "bring" ? "copy" : WITHOUT_A_COPY;
}

/** The catalog entry a login row belongs to, by the login id it is filed under; a row the catalog does not know is its own. */
export function loginEntryId(e: ManifestEntry): string {
  return loginRow(agentName(e))?.entry.id ?? agentName(e);
}

/** A login that belongs to an agent is only offered when that agent comes along. */
export function loginShown(e: ManifestEntry, manifest: Manifest, ticks: ReadonlySet<string>): boolean {
  if (e.rung !== "logins") return true;
  const agent = manifest.entries.find(a => a.rung === "agents" && agentName(a) === loginEntryId(e));
  return agent === undefined || ticks.has(agent.id);
}

/** The agents and tools rows that come along as the manifest stands: what the login rows are judged against. */
export function comingRows(manifest: Manifest): Set<string> {
  return new Set(manifest.entries.filter(e => (e.rung === "agents" || e.rung === "tools") && initialTicks(e)).map(e => e.id));
}

export interface Answers {
  ticks: Set<string>;
  choices: Map<string, string>;
}

/** The answers a fresh screen starts with; `coming` is what earlier screens ticked, else every tools and agents row's default. */
export function defaultAnswers(manifest: Manifest, brew: BrewTable, coming: ReadonlySet<string> = comingRows(manifest)): Answers {
  const shown = manifest.entries.filter(e => loginShown(e, manifest, coming));
  // A login whose command is not coming starts at skip; a saved answer stands, and ticks the command's row instead (tickLoginTools).
  const choiceOf = (e: ManifestEntry): LoginChoice => (e.rung === "logins" && e.choice === undefined && e.bring === undefined && loginTool(e, manifest, coming, brew)?.coming === false ? "skip" : initialChoice(e));
  return {
    // A saved recipe keeps its ticks: a login it brought as a sign-in on the machine stays ticked, as the run that saved it had it;
    // a credential-shaped row is ticked only by its copy answer.
    ticks: new Set(shown.filter(e => (e.rung === "logins" ? e.bring ?? (choiceOf(e) === "copy") : hasChoices(e) ? initialChoice(e) === "copy" : initialTicks(e))).map(e => e.id)),
    choices: new Map(shown.filter(hasChoices).map(e => [e.id, choiceOf(e)])),
  };
}

/** Every catalog agent as a row, the collector's where it found one here and a bare one otherwise, with a bare login
 * row beside it where the catalog has a sign-in for it, so the agent can be ticked for the machine and signed in
 * there. A bare row has nothing to copy and starts off; the recipe decides its tick. */
export function withCatalogAgents(manifest: Manifest): Manifest {
  const has = (rung: Rung, name: string): boolean => manifest.entries.some(e => e.rung === rung && agentName(e) === name);
  const bare = (rung: Rung, id: string, label: string): ManifestEntry => ({ rung, id, label, paths: [], bytes: 0, default: "skip" });
  const added = CATALOG_AGENTS.flatMap(a => [
    ...(has("agents", a.id) ? [] : [bare("agents", `agents/${a.id}`, a.name)]),
    ...(has("logins", loginIdOf(a.id)) || loginRow(loginIdOf(a.id)) === undefined ? [] : [{ ...bare("logins", `logins/${loginIdOf(a.id)}`, `${a.name} login`), group: "Agent logins" }]),
  ]);
  return added.length === 0 ? manifest : { ...manifest, entries: [...manifest.entries, ...added] };
}

export function isLoginChoice(v: unknown): v is LoginChoice {
  return LOGIN_CHOICES.includes(v as LoginChoice);
}

/** This computer's tools rows the catalog does not carry, as rows of the small recipe under the collector's own id,
 * so the file and the Also screen tick them like any other row and the build installs each by the road
 * the plan resolves for it: off until one ticks it, found here as its source. A tap itself, a row locked off with a
 * reason and a row no road installs get none: nothing installs the first, nobody can tick the second, and a tick on
 * the third would do nothing. A row the recipe already carries is left as it is. */
export function withOutsideRows(recipe: Recipe, manifest: Manifest, brew: BrewTable): Recipe {
  const named = new Set(recipe.rows.map(r => r.id));
  const rows = manifest.entries.flatMap((e): RecipeRow[] => {
    if (e.rung !== "tools" || named.has(e.id) || catalogIdOfRow(e) !== undefined || isTap(e) || !isTickable(e) || rowRoad(e, brew) === undefined) return [];
    return [outsideRow(e.id, e.paths)];
  });
  return rows.length === 0 ? recipe : { ...recipe, rows: [...recipe.rows, ...rows] };
}

/** The collector's rows with the recipe's ticks written on: an agents or tools row is on when its catalog row is,
 * a tools row the catalog does not carry when the recipe's row under its own id is, off when the recipe has no such
 * row; an MCP row follows its agent; a saved sign-in answer lands on the login row it names. Every other row keeps
 * its default. A ticked catalog tool this computer has no row for gets a bare row, the floor's aside, so the build
 * installs it by its catalog road; the bare rows of an earlier pass are made anew, so an untick takes its row away.
 * The recipe's pins are what the last seal recorded and land on no row: the image's own cut reads latest again. */
export function applyRecipe(manifest: Manifest, recipe: Recipe): Manifest {
  const on = new Set(recipe.rows.filter(r => r.on).map(r => r.id));
  const answers = new Map<string, LoginChoice>(recipe.rows.flatMap(r => (r.signIn === undefined ? [] : [[`logins/${loginIdOf(r.id)}`, r.signIn]])));
  const own = manifest.entries.filter(e => !e.id.startsWith(CATALOG_PREFIX));
  const here = new Set(own.map(catalogIdOfRow));
  const bare = recipe.rows.flatMap((r): ManifestEntry[] => {
    const e = catalogEntry(r.id);
    if (!r.on || here.has(r.id) || e?.kind !== "tool" || e.floor) return [];
    return [{ rung: "tools", id: `${CATALOG_PREFIX}${e.id}`, label: e.name, group: "Catalog", paths: [], bytes: 0, default: "skip", linux: "yes", bring: true }];
  });
  return {
    ...manifest,
    entries: [
      ...own.map(e => {
        if (isMcpRow(e)) {
          const agent = parseMcpId(e.id)?.agent;
          return { ...e, bring: initialTicks(e) && (agent === undefined || catalogEntry(agent)?.kind !== "agent" || on.has(agent)) };
        }
        const id = catalogIdOfRow(e);
        if (id !== undefined || e.rung === "tools") return { ...e, bring: on.has(id ?? e.id) };
        const answer = e.rung === "logins" ? answers.get(e.id) : undefined;
        return answer === undefined ? e : { ...e, choice: answer };
      }),
      ...bare,
    ],
  };
}

/** The catalog ids this computer has a collector row for. */
export function rowsHere(entries: readonly ManifestEntry[]): Set<string> {
  return new Set(entries.flatMap(e => catalogIdOfRow(e) ?? []));
}

/** The manifest a run reads the recipe against: the catalog's bare rows joined to this computer's, the recipe
 * applied. The screens as data, the run itself and a copy's build read it here, so a tick lands on the same rows
 * wherever it was made. */
export function manifestFor(reading: { manifest: Manifest }, recipe: Recipe): Manifest {
  return applyRecipe(withCatalogAgents(reading.manifest), recipe);
}

export function recipePath(statePath: string): string {
  return join(dirname(statePath), "golden-recipe.json");
}

/** The small recipe with the login answers written on: a row whose login rows were answered carries the word they
 * add up to, a row nobody answered carries none. The ticks are the recipe's own, as the screens left them. */
export function recipeWithAnswers(recipe: Recipe, choices: ReadonlyMap<string, string>): Recipe {
  return {
    ...recipe,
    rows: recipe.rows.map(r => {
      const { signIn: _signIn, ...rest } = r;
      const answer = choices.get(`logins/${loginIdOf(r.id)}`);
      return { ...rest, ...(isLoginChoice(answer) ? { signIn: answer } : {}) };
    }),
  };
}

/** The collector's rows as the screens left them: every row with its tick, and on each row that took an answer the
 * word it got. The one reading of ticks and answers the build, the MCP plan and the saved recipe share. */
export function answeredRows(manifest: Manifest, ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string>): ManifestEntry[] {
  return manifest.entries.map(e => {
    const choice = choices.get(e.id);
    return { ...e, bring: ticks.has(e.id), ...(isLoginChoice(choice) ? { choice } : {}) };
  });
}

/** The rows as the screens left them, beside the state. The file holds every login answer and the detail of every
 * definition the collector read, so it goes through the one writer for the owner's files, as every other file
 * beside the state does. */
export function saveRecipe(path: string, manifest: Manifest, ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string> = new Map()): void {
  writeOwn(dirname(path), basename(path), `${JSON.stringify({ entries: answeredRows(manifest, ticks, choices) }, null, 2)}\n`);
}

export function agentName(e: ManifestEntry): string {
  return e.id.split("/").at(-1) ?? e.id;
}

/** What differs between the recipe a builder carries and this run's, in the
 * person's words: a row ticked or unticked, a login answer or tool pin changed,
 * a file added, gone or changed. A row whose tick changed is named once; the
 * files that came or went with it are not listed again. */
export function recipeChanges(from: RecipeDigest, to: RecipeDigest, manifest: Manifest): string[] {
  const label = (id: string): string => manifest.entries.find(e => e.id === id)?.label ?? id;
  const word = (choice: string | undefined): string => (isLoginChoice(choice) ? SIGN_IN_ANSWERS[choice].short : (choice ?? "ticked"));
  const out: string[] = [];
  const noted = new Set<string>();
  const was = new Map(from.ticks.map(t => [t.id, t]));
  const now = new Map(to.ticks.map(t => [t.id, t]));
  // Why a tool installs differently under the same version is the diff's to say; this only names the rows.
  const moved = new Map(diffRecipes(from, to).tools.flatMap(t => (t.why === undefined ? [] : [[t.id, t.why]])));
  for (const [id, t] of now) {
    const b = was.get(id);
    const why = moved.get(id);
    if (b === undefined) out.push(`${label(id)} ticked`);
    else if (b.choice !== t.choice) out.push(`${label(id)} now ${word(t.choice)}`);
    else if (b.version !== t.version) out.push(`${label(id)} now ${t.version ?? "unpinned"}`);
    else if (why !== undefined) out.push(`${label(id)}: ${why}`);
    else continue;
    noted.add(id);
  }
  for (const id of was.keys()) {
    if (now.has(id)) continue;
    out.push(`${label(id)} unticked`);
    noted.add(id);
  }
  // Volatile entries are recorded, never hashed, so they never made the hash differ and are not named.
  const had = new Map(from.files.filter(f => f.volatile !== true).map(f => [f.path, f]));
  const has = new Map(to.files.filter(f => f.volatile !== true).map(f => [f.path, f]));
  for (const [path, f] of has) {
    if (noted.has(f.id)) continue;
    const b = had.get(path);
    if (b === undefined) out.push(`${path} added`);
    else if (b.digest !== f.digest || b.dest !== f.dest) out.push(`${path} changed`);
  }
  for (const [path, f] of had) if (!has.has(path) && !noted.has(f.id)) out.push(`${path} gone`);
  return out;
}

/** What the builder runs. The harness line and smoke are bare: the import
 * carries every ticked agent with its own installer and version check, and
 * the builder's seal smokes the ones that installed. Nothing ticked means a
 * bare machine that still has to fork and boot to seal. The envs are every
 * guest's plus the state home variable each ticked agent's entry asks for. No
 * key and no token is among them: a sign-in never sits in an image, and the
 * vault sets both in the environment of each turn instead. */
export function goldenRecipeFor(
  bring: readonly ManifestEntry[],
  hooks: { deployDaemon?: (machine: Machine) => Promise<void | string>; import?: GoldenImport; source?: Recipe } = {},
): GoldenRecipe {
  const envs: Record<string, string> = { ...GUEST_ENVS };
  for (const e of bring) {
    const agent = e.rung === "agents" ? catalogEntry(agentName(e)) : undefined;
    if (agent?.kind !== "agent") continue;
    Object.assign(envs, guestEnv(agent));
  }
  return {
    setup: "true",
    smoke: "true",
    envs,
    vaultPaths: vaultPathsFor(bring),
    ...(hooks.source !== undefined ? { source: hooks.source } : {}),
    ...(hooks.deployDaemon !== undefined ? { deployDaemon: hooks.deployDaemon } : {}),
    ...(hooks.import !== undefined ? { import: hooks.import } : {}),
  };
}

/** What the seal archives off the builder as the image vault: where each row that can sign in keeps its login on the
 * machine, whether the sign-in was copied here or run there, and the two files the secrets step writes. Each path
 * once, in the order the rows come. */
export function vaultPathsFor(bring: readonly ManifestEntry[]): string[] {
  const entries = bring.flatMap(e => {
    const row = loginRow(agentName(e));
    return row === undefined ? [] : [row.entry];
  });
  return [...new Set([...entries.flatMap(loginStatePaths), SH_FILE, FISH_FILE])];
}
