// SPDX-License-Identifier: AGPL-3.0-only
// The screens of wsp init on the catalog: the agents (the six, ticked when
// used on this computer and wsp can run their threads), what they need (the whole
// table of agents and tools, one row each with its size, over the totals and
// the disk line), and the sign-ins and keys (a login listed with where its
// sign-in happens, keys ticked to copy, and the wsp tools
// offered to each agent here whose config the catalog knows). The recipe is
// the state: catalog ids with a tick each; the collector's rows follow it.
import type { Readable, Writable } from "node:stream";
import { CATALOG_AGENTS, CATALOG_TOOLS, MCP_AGENTS, catalogEntry, type AgentEntry, type CatalogEntry, type Size, type ToolEntry, agentName as catalogName, sizeBytes } from "@wsp/catalog";
import { LOGIN_CHOICES, withProject, type LoginChoice, type Manifest, type ManifestEntry, type Platform, type ProjectScan, floorApplies } from "@wsp/collect";
import { estimateDisk, isMcpRow, NO_ACTIVE_LOGIN, parseMcpId, plural, type BrewTable, type DiskEstimate } from "@wsp/engine";
import { CLOUD_SETUP_WORDS, SIGN_IN_ANSWERS, copyNamesLogin, customRows, fmtBytes, initShownScreens, initStepCounter, loginsHereLine, signInChoice, signInChoices, thisComputer, wspToolsRowId, type Recipe, type RecipeCustomRow, type RecipeRow } from "@wsp/protocol";
import { copiedLogin } from "./init-import.js";
import { mcpConfigFile } from "./mcp-install.js";
import { GUTTER, card, colourDepth, isTTY, table, textPrompt } from "./init-layout.js";
import { agentName, applyRecipe, comingRows, defaultAnswers, initialChoice, isTickable, loginEntryId, loginShown, loginTool, rowsHere } from "./init-recipe.js";
import { alsoGroupLine, alsoItems, alsoTitle, alsoTop, buildLine, scannedTicks, withScanned } from "./init-also.js";
import { outsideCatalog } from "./recipe-file.js";
import { answerOf, rungSelect, type Choice, type FooterLine, type RungAnswer, type RungSelectResult, type SelectItem } from "./init-select.js";
import { BASE_GROUP, FLOOR_LINE, PROJECT_GROUP, agentRows, candidatesLine, groupTotal, recipeTable, sizeCell, totalsLine, whyCell, type TableRow, UNKNOWN_SIZE } from "./init-table.js";
import { diskHead, diskTone } from "./init-weight.js";
import { asksThePerson, hasLogin, keyEnvOf, livesOnComputer, loginWords, mintsToken, signInFor, type SignIn } from "./signin-table.js";
import type { ScanRow } from "./scan.js";

/** The screens of a run, in order, with the one sentence each opens with; the build comes after them. */
export const AGENTS_TITLE = "Agents";
export const AGENTS_TOP = "Which agents go on the image";
export const TOOLS_TITLE = "Tools";
export const TOOLS_TOP = "Tools from your usage";
export const SIGN_INS_TITLE = "Sign-ins";
export const SIGN_INS_TOP = "How sign-ins reach the machine";
export const wspTitle = (platform: Platform): string => `wsp for your agents on ${thisComputer(platform)}`;
export const WSP_TOP = "Add wsp's MCP server and skill to the agents installed here, so they can drive your workspaces";
/** The first screen's own question when no folder was named on the command line; nothing has to answer it. */
export const PROJECT_QUESTION = "Which project are you bringing first?";
const projectHint = (platform: Platform): string => `optional; a folder on ${thisComputer(platform)}, read for what its own files say it needs`;

const rowOf = (recipe: Recipe, id: string): RecipeRow | undefined => recipe.rows.find(r => r.id === id);
/** Whether the recipe found the entry on this computer. */
const installedHere = (recipe: Recipe, id: string): boolean => rowOf(recipe, id)?.source.kind === "installed";

/** The recipe with one kind's catalog rows ticked as a screen left them: a row the recipe had keeps its source, an
 * entry it never named gets a row on the catalog's own evidence, so a tick on a fresh computer is kept. This
 * computer's tools rows outside the catalog are the Also screen's, so neither table screen touches their ticks. */
function withTicks(recipe: Recipe, kind: RecipeRow["kind"], entries: readonly CatalogEntry[], on: (id: string) => boolean): Recipe {
  const rows = recipe.rows.map(r => (r.kind === kind && !outsideCatalog(r) ? { ...r, on: on(r.id) } : r));
  const missing = entries.filter(e => !rows.some(r => r.id === e.id)).map((e): RecipeRow => {
    const bytes = sizeBytes(e.size);
    return { id: e.id, kind: e.kind, on: on(e.id), source: { kind: "popular", sessions: e.source.sessions, images: e.source.images }, ...(bytes !== undefined ? { size: bytes } : {}) };
  });
  return { ...recipe, rows: [...rows, ...missing] };
}

/** The recipe with the agents rows ticked as the screen left them. */
export function withAgents(recipe: Recipe, on: ReadonlySet<string>): Recipe {
  return withTicks(recipe, "agent", CATALOG_AGENTS, id => on.has(id));
}

/** The recipe with the tools rows ticked as the list left them; a floor row stays on, since the base installs it
 * anyway, and a row an agent added is on by being on the recipe, so leaving it unticked takes it off. */
export function withTools(recipe: Recipe, on: ReadonlySet<string>): Recipe {
  const floor = new Set(CATALOG_TOOLS.filter(e => e.floor).map(e => e.id));
  const custom = customRows(recipe).filter(c => on.has(c.id));
  return { ...withTicks(recipe, "tool", CATALOG_TOOLS, id => floor.has(id) || on.has(id)), ...(recipe.custom !== undefined ? { custom } : {}) };
}

/** The recipe with the agents and the tools ticked as the table screen left them. */
export function withPicked(recipe: Recipe, on: ReadonlySet<string>): Recipe {
  return withAgents(withTools(recipe, on), on);
}

/** The catalog ids a recipe ticks, agents or tools. */
export const ticked = (recipe: Recipe, kind: RecipeRow["kind"]): Set<string> => new Set(recipe.rows.filter(r => r.kind === kind && r.on).map(r => r.id));

/** The collector's rows the recipe ticks, as the build would take them before anyone answers, and the bytes they upload. */
function rowsFor(manifest: Manifest, recipe: Recipe, brew: BrewTable): { rows: ManifestEntry[]; bytes: number } {
  const applied = applyRecipe(manifest, recipe);
  const { ticks } = defaultAnswers(applied, brew);
  const rows = applied.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  return { rows, bytes: rows.reduce((n, e) => n + e.bytes, 0) };
}

/** What the recipe costs on the builder's disk: the collector's rows it ticks, sized as the build would size them. */
export function pickEstimate(manifest: Manifest, recipe: Recipe, brew: BrewTable): DiskEstimate {
  const { rows, bytes } = rowsFor(manifest, recipe, brew);
  return estimateDisk(rows, bytes, brew, customRows(recipe));
}

/** The Disk line, loud in its weight's colour: the one loud element on the screen. The parts behind the total stay
 * off it, since every row above says its own size. A provider that gives a builder no disk figure has no room to
 * be over, so the line carries the total and no colour. */
export function diskFooter(est: DiskEstimate, builderDiskGb?: number): FooterLine {
  const tone = builderDiskGb === undefined ? undefined : diskTone(est.total, est.room);
  return { text: `Disk: ${diskHead(est, builderDiskGb)}`, ...(tone !== undefined ? { tone } : {}) };
}

/** An agent's two detail lines: whether this computer has it and what its config brings, then what it installs there. */
function agentDetail(recipe: Recipe, manifest: Manifest, a: AgentEntry, platform: Platform): string[] {
  const own = manifest.entries.find(e => e.rung === "agents" && agentName(e) === a.id);
  const config = own !== undefined && own.bytes > 0 ? `; its config (${fmtBytes(own.bytes)}) comes along` : "";
  const computer = thisComputer(platform);
  const here = installedHere(recipe, a.id) ? `on ${computer}${config}` : `not on ${computer}; try it on the machine, nothing here changes`;
  return [here, sizeLine(a.size)];
}

/** What a row costs on the machine, in the one phrasing every row uses: the catalog's bytes with the day they were
 * measured, or the plan's words for a row nobody measured. */
function sizeLine(size: Size): string {
  return "bytes" in size ? `about ${fmtBytes(size.bytes)} installed on the machine (measured ${size.on})` : UNKNOWN_SIZE;
}

/** The recipe source in words with its counts, for a tool's detail pane. */
function sourceLine(e: ToolEntry, r: RecipeRow | undefined, platform: Platform): string {
  switch (r?.source.kind) {
    case "project":
      return r.source.why;
    case "installed":
      return r.source.bin ? `installed on ${thisComputer(platform)}` : `on ${thisComputer(platform)}: ${r.source.paths.join(", ")}`;
    case "used":
      return `your agents used it in ${plural(r.source.sessions, "session")} (${plural(r.source.calls, "call")})`;
    default: {
      const images = r?.source.kind === "popular" ? r.source.images : e.source.images;
      return `${images === 0 ? "in no lab image" : `ships in ${plural(images, "lab image")}`}; ${e.defaultOn ? "on by default in the catalog" : "on request"}`;
    }
  }
}

/** An added row's two detail lines: the lines that install it, and the command that says it is there. */
function customDetail(c: RecipeCustomRow): string[] {
  return [`installs with ${c.install.join("; ")}`, `checked with ${c.check}`];
}

/** A tool's two detail lines: where its tick came from with the counts, then what the build does with it. */
function toolDetail(recipe: Recipe, here: ReadonlySet<string>, e: ToolEntry, platform: Platform): string[] {
  const r = rowOf(recipe, e.id);
  const size = sizeLine(e.size);
  const build = e.floor ? "part of the base on every machine" : here.has(e.id) ? size : `${size}; no row here; installed by its ${e.installRoad.road} road`;
  const source = sourceLine(e, r, platform);
  return [e.floor ? `${source}; on every machine` : source, build];
}

/** The groups of the sign-ins screen, in order. */
export const AGENT_LOGINS = "Agents";
export const CLI_LOGINS = "Developer CLIs";
export const MCP_LOGINS = "MCP servers from your agents' configs";

export interface SignInScreen {
  items: SelectItem[];
  /** Every row's answer before anyone moves it. */
  initial: Map<string, LoginChoice>;
}

/** The agents an MCP row belongs to: a server's own; for the mcp-remote row, every agent with a server here. */
export function mcpAgents(e: ManifestEntry, manifest: Manifest): string[] {
  const own = parseMcpId(e.id)?.agent;
  if (own !== undefined) return [own];
  return [...new Set(manifest.entries.flatMap(s => parseMcpId(s.id)?.agent ?? []))];
}

/** An MCP row that carries a secret is shown once an agent it belongs to is ticked. */
function mcpShown(e: ManifestEntry, manifest: Manifest, coming: ReadonlySet<string>): boolean {
  return isMcpRow(e) && e.consent === true && mcpAgents(e, manifest).some(a => coming.has(`agents/${a}`));
}

/** Where an MCP server sits, in the words the row shows: the agent whose config holds it, or the agents whose
 * sign-ins mcp-remote saved. */
function mcpWhy(e: ManifestEntry, manifest: Manifest): string {
  const own = parseMcpId(e.id)?.agent;
  if (own !== undefined) return `in ${catalogName(own)}'s config`;
  const agents = mcpAgents(e, manifest).map(catalogName);
  return agents.length === 0 ? "saved by mcp-remote" : `sign-ins mcp-remote saved for ${agents.join(", ")}`;
}

/** The answers a login row can take: a copy when there is something here to copy, an API key when the tool reads one,
 * and always skip. A catalog flow that runs on the machine without stopping on the person is offered both ways: left
 * to the first time the tool is needed there, which is the default, or run during the build, which is the opt-in.
 * A tool that mints a token on this computer is offered that and never a copy, since nothing of such a login is on
 * a machine to copy; a login that lives on the computer that runs the workspaces is signed in there once, so the
 * build never runs it and no file of it travels. The row's own road leads, since a row whose saved answer is no
 * longer offered opens on the first word it can take. */
export function choicesFor(e: ManifestEntry, s: SignIn, platform: Platform): Choice[] {
  const token = mintsToken(s);
  const onComputer = livesOnComputer(s);
  const allowed = new Set<string>(["skip"]);
  if (!token && !onComputer && (e.paths.length > 0 || e.bytes > 0)) allowed.add("copy");
  if (token) allowed.add("token");
  if (onComputer) allowed.add("later");
  if (hasLogin(s) && !asksThePerson(s) && !onComputer) {
    allowed.add("machine");
    allowed.add("later");
  }
  if (keyEnvOf(s) !== undefined) allowed.add("key");
  const offered = signInChoices(platform).filter(c => allowed.has(c.value));
  return token ? [...offered.filter(c => c.value === "token"), ...offered.filter(c => c.value !== "token")] : offered;
}

/** A header's counts: how its rows answered, in the choice order, in short words. */
export function signInGroupLine(items: readonly SelectItem[], a: RungAnswer): string {
  const values = [...new Set(items.flatMap(i => (i.choices ?? []).map(c => c.value)))];
  return LOGIN_CHOICES.filter(c => values.includes(c))
    .map(c => `${items.filter(i => answerOf(i, a.answers) === c).length} ${SIGN_IN_ANSWERS[c].short}`)
    .join(GUTTER);
}

/** The sign-ins screen's rows: everything the machine has to be signed in to, one row each with the choice it starts on.
 * The agents' own logins first, then the developer CLIs, then the MCP servers the agents' configs carry auth for.
 * A row whose command is not coming, or that the catalog locked out, is here with its reason and skip as its only
 * answer, so nothing on the screen is silent. */
export function signInItems(manifest: Manifest, brew: BrewTable, platform: Platform, home: string): SignInScreen {
  const coming = comingRows(manifest);
  const shown = manifest.entries.filter(e => (e.rung === "logins" && loginShown(e, manifest, coming)) || mcpShown(e, manifest, coming));
  const items: SelectItem[] = [];
  const initial = new Map<string, LoginChoice>();
  const only = (id: string, label: string, group: string, why: string, detail: string[]): void => {
    items.push({ id, label, group, why, detail, choices: [signInChoice("skip", platform)] });
    initial.set(id, "skip");
  };
  const mcp = shown.filter(e => e.rung !== "logins");
  const logins = shown.filter(e => e.rung === "logins");
  const agentLogin = (e: ManifestEntry): boolean => catalogEntry(loginEntryId(e))?.kind === "agent";
  for (const e of [...logins.filter(agentLogin), ...logins.filter(x => !agentLogin(x))]) {
    const group = agentLogin(e) ? AGENT_LOGINS : CLI_LOGINS;
    const s = signInFor(agentName(e));
    const where = e.paths.length > 0 ? e.paths.join(", ") : "nothing to copy here";
    if (!isTickable(e)) {
      only(e.id, e.label, group, where, [e.reason ?? "", "this one is left alone"]);
      continue;
    }
    const tool = loginTool(e, manifest, coming, brew);
    if (tool !== undefined && !tool.coming) {
      only(e.id, e.label, group, `${tool.bin} is not coming`, [tool.why ?? "", where]);
      continue;
    }
    // A tool signed in as one account at a time copies the login it is in use as here; the answer and the detail
    // both name it, so nobody has to guess which of two logins the machine would come up under. With none in use
    // here a copy would land a file the machine holds no token for, so the answer is not offered and the detail
    // says why; the sign-in on the machine and the skip are what such a row is left with.
    const login = copiedLogin(e, platform, home);
    const choices = choicesFor(e, s, platform)
      .filter(c => c.value !== "copy" || login === undefined || login.carries !== undefined)
      .map(c => (c.value === "copy" && login?.carries !== undefined ? { ...c, label: copyNamesLogin(c.label, login.carries) } : c));
    const choice = initialChoice(e);
    initial.set(e.id, choices.some(c => c.value === choice) ? choice : (choices[0]?.value as LoginChoice));
    items.push({
      id: e.id,
      label: e.label,
      group,
      why: where,
      choices,
      detail: [hasLogin(s) ? loginWords(s) : (s.kind !== "shell" ? (s.note ?? "") : ""), asksThePerson(s) ? CLOUD_SETUP_WORDS.screen.asksYou : "", login === undefined ? "" : login.carries === undefined ? NO_ACTIVE_LOGIN : loginsHereLine(login.carries, login.left), e.detail ?? "", where],
    });
  }
  for (const e of mcp) {
    const why = mcpWhy(e, manifest);
    if (!isTickable(e)) {
      only(e.id, e.label, MCP_LOGINS, why, [e.reason ?? "", e.detail ?? ""]);
      continue;
    }
    const choices = signInChoices(platform).filter(c => c.value === "copy" || c.value === "skip");
    initial.set(e.id, initialChoice(e) === "copy" ? "copy" : "skip");
    items.push({
      id: e.id,
      label: e.label,
      group: MCP_LOGINS,
      why,
      choices,
      detail: [e.detail ?? "", e.paths.length > 0 ? `its token is in ${e.paths.join(", ")}` : "its token is in the agent's own config"],
    });
  }
  return { items, initial };
}

const WSP_TOOLS = wspToolsRowId("");
/** The agent a wsp tools row is for; nothing for any other row on the screen. */
export const wspToolsAgent = (id: string): string | undefined => (id.startsWith(WSP_TOOLS) ? id.slice(WSP_TOOLS.length) : undefined);

/** The wsp tools screen's rows: one per agent on this computer whose config the catalog can place the wsp MCP server in, whatever
 * its tick for the machine. The file the tick writes reads under the row; an agent this computer has run threads
 * with starts on, since it is the one that would use the server. */
export function wspToolsItems(recipe: Recipe, home: string): { items: SelectItem[]; initial: Set<string> } {
  const items = MCP_AGENTS.filter(a => installedHere(recipe, a.id)).map((a): SelectItem => ({
    id: wspToolsRowId(a.id),
    label: a.name,
    detail: [`writes ${mcpConfigFile(a, home).tilde}`],
  }));
  const used = new Set(recipe.histories.filter(h => h.sessions > 0).map(h => wspToolsRowId(h.agent)));
  return { items, initial: new Set(items.filter(i => used.has(i.id)).map(i => i.id)) };
}

// --- the screens ------------------------------------------------------------

/** The table as a screen's rows: the size in the second column, why it is here in the middle, and the detail saying
 * what the build does with it. The tools screen groups them by why; the agents screen is one flat list. */
export function tableItems(rows: readonly TableRow[], recipe: Recipe, manifest: Manifest, depth: number, grouped: boolean, platform: Platform): SelectItem[] {
  const here = rowsHere(manifest.entries);
  const custom = new Map(customRows(recipe).map(c => [c.id, c]));
  return rows.map((row): SelectItem => {
    const e = row.kind === "custom" ? undefined : catalogEntry(row.id);
    const c = custom.get(row.id);
    const detail = e !== undefined ? (e.kind === "agent" ? agentDetail(recipe, manifest, e, platform) : toolDetail(recipe, here, e, platform)) : c !== undefined ? customDetail(c) : [];
    return {
      id: row.id,
      label: row.name,
      why: whyCell(row, depth),
      hint: sizeCell(row, depth),
      detail: [...(row.note !== undefined ? [row.note] : []), ...detail],
      ...(row.base ? { lock: "on" as const } : grouped ? { group: row.group } : {}),
    };
  });
}

export interface TableScreenOptions {
  title: string;
  top: string;
  /** The section counter shown after the title ("2/5"). */
  counter: string;
  rows: readonly TableRow[];
  recipe: Recipe;
  manifest: Manifest;
  /** Grouped by why the row is here, the base rows as bullets under the title; a flat list otherwise. */
  grouped: boolean;
  platform: Platform;
  /** Rebuilt from the ticks under the rows: what comes, what it downloads, and the disk it leaves. */
  footer: (ticks: ReadonlySet<string>) => FooterLine[];
  input?: Readable;
  output?: Writable;
}

/** A screen that is the table itself: every row with its size, space turning one on or off, the totals under them. */
export function tableScreen(o: TableScreenOptions): Promise<RungSelectResult> {
  const byId = new Map(o.rows.map(r => [r.id, r]));
  return rungSelect({
    title: o.title,
    top: o.top,
    counter: o.counter,
    items: tableItems(o.rows, o.recipe, o.manifest, colourDepth(isTTY(o.output)), o.grouped, o.platform),
    initial: new Set(o.rows.filter(r => r.on).map(r => r.id)),
    // Three lines: an agent wsp cannot drive yet says so above its own two.
    detailLines: 3,
    lockedTitle: BASE_GROUP,
    groupLine: (items, a) => groupTotal(items.flatMap(i => byId.get(i.id) ?? []).map(r => ({ ...r, on: r.base || a.ticks.has(r.id) }))),
    footer: a => o.footer(a.ticks),
    ...(o.input ? { input: o.input } : {}),
    ...(o.output ? { output: o.output } : {}),
  });
}

// --- the flow ------------------------------------------------------------------

/** What the folder asked for, in the card the question leaves behind: a row per catalog tool with the file that
 * asked, then the names the catalog carries no row for. */
export function projectNote(scan: ProjectScan): string[] {
  if (scan.rows.length === 0 && scan.candidates.length === 0) return [`Nothing in ${scan.dir} named a tool the catalog carries.`];
  const candidates = candidatesLine(scan);
  return [...table(scan.rows.map(n => [n.name, n.why])), ...(candidates === undefined ? [] : [candidates])];
}

/** What the card says when the answer names no folder that is there. */
export const noFolderNote = (folder: string): string => `There is no folder at ${folder}; nothing was read.`;

export interface PickOptions {
  /** The collector's rows, every catalog agent among them. */
  manifest: Manifest;
  recipe: Recipe;
  brew: BrewTable;
  /** The first screen: the agents, or the sign-ins on, when a recipe file already decided the rest. */
  from: "agents" | "logins";
  /** The person's home, where an agent's config is read for the wsp tools rows. */
  home: string;
  /** The computer the screens are reading, which is what they call it. */
  platform: Platform;
  /** The disk the provider gives a builder, where it gives a figure; the Disk footer names no cap without one. */
  builderDiskGb?: number;
  /** What the package managers here could put on the image: the rows of the Also screen. With none, that screen is
   * not shown. */
  scan?: readonly ScanRow[];
  /** The project folder named on the command line, already weighed into the recipe; absent, the run asks for one
   * before the first screen. */
  project?: string;
  /** Reads one project folder's own manifests for what it needs; nothing when there is no folder there. */
  scanProject(folder: string): Promise<ProjectScan | undefined>;
  input: Readable;
  output: Writable;
}

export interface Picked {
  recipe: Recipe;
  /** Every shown login row's answer. */
  logins: Map<string, LoginChoice>;
  /** The agents on this computer whose config gets the wsp MCP server, by catalog id. */
  wspTools: Set<string>;
}

export type Screen = "agents" | "tools" | "also" | "logins" | "wsp";

/** What each screen draws as the recipe stands, built once per pass of the walk: the shown check and the screen's own
 * draw read these same rows, so the counter can never count a screen that is not drawn or draw one it did not count.
 * Built again after every answer, since an answer can take a later screen's rows away. */
interface ScreenRows {
  agents: TableRow[];
  tools: TableRow[];
  also: SelectItem[];
  logins: SignInScreen;
  wsp: { items: SelectItem[]; initial: Set<string> };
}
function screenRows(o: PickOptions, recipe: Recipe): ScreenRows {
  return {
    agents: agentRows(recipe),
    tools: recipeTable(recipe, CATALOG_TOOLS),
    also: alsoItems(o.scan ?? [], recipe, o.platform, row => buildLine(o.manifest, row, o.brew)),
    logins: signInItems(applyRecipe(o.manifest, recipe), o.brew, o.platform, o.home),
    wsp: wspToolsItems(recipe, o.home),
  };
}

/** Which of the run's screens are shown, by the protocol's rule, over the rows each would draw; the counter over
 * each title counts these and the build after them. */
function shownScreens(screens: readonly Screen[], rows: ScreenRows): Screen[] {
  const items: Record<Screen, readonly unknown[]> = { agents: rows.agents, tools: rows.tools, also: rows.also, logins: rows.logins.items, wsp: rows.wsp.items };
  return initShownScreens(screens.map(id => ({ id, items: items[id] }))).map(s => s.id);
}

/** The recipe with the answered folder's needs ticked and a card naming them; an empty answer leaves it as it was,
 * and a folder that is not there is said so rather than read as a project that needs nothing. */
async function askProject(o: PickOptions, recipe: Recipe): Promise<Recipe | "cancel"> {
  const answer = await textPrompt({ message: PROJECT_QUESTION, hint: projectHint(o.platform), input: o.input, output: o.output });
  if (typeof answer === "symbol") return "cancel";
  const folder = answer.trim();
  if (folder === "") return recipe;
  const scan = await o.scanProject(folder);
  card(PROJECT_GROUP, scan === undefined ? [noFolderNote(folder)] : projectNote(scan), o.output);
  return scan === undefined ? recipe : withProject(recipe, scan);
}

/** The screens in order, esc stepping back one, so back from the screen after one that is not shown lands on the
 * last one shown; the recipe carries the ticks and the answers between them. */
export async function pickScreens(o: PickOptions): Promise<Picked | "cancel"> {
  const scan = o.scan ?? [];
  const screens: readonly Screen[] = o.from === "agents" ? ["agents", "tools", "also", "logins", "wsp"] : ["logins", "wsp"];
  let recipe = o.recipe;
  if (o.from === "agents" && o.project === undefined) {
    const asked = await askProject(o, recipe);
    if (asked === "cancel") return "cancel";
    recipe = asked;
  }
  let logins = new Map<string, LoginChoice>();
  // What the sign-ins and the wsp tools screens were left on, so esc back onto them shows the answers again, as the
  // recipe shows the ticks; undefined until the screen has been answered once, since an empty set is an answer of its own.
  let wspTicks: Set<string> | undefined;
  let wspTools = new Set<string>();
  const streams = { input: o.input, output: o.output };
  let i = 0;
  for (;;) {
    const rows = screenRows(o, recipe);
    const shown = shownScreens(screens, rows);
    if (i >= shown.length) break;
    const screen = shown[i]!;
    const counter = initStepCounter(i + 1, shown.length + 1);
    const step = (r: RungSelectResult): void => {
      i += r.kind === "next" ? 1 : -1;
    };
    switch (screen) {
      case "agents": {
        const r = await tableScreen({
          title: AGENTS_TITLE,
          top: AGENTS_TOP,
          counter,
          rows: rows.agents,
          recipe,
          manifest: o.manifest,
          grouped: false,
          platform: o.platform,
          footer: ticks => [totalsLine(recipeTable(withAgents(recipe, ticks), CATALOG_AGENTS), "agents")],
          ...streams,
        });
        if (r.kind === "cancel") return "cancel";
        recipe = withAgents(recipe, r.ticks);
        step(r);
        break;
      }
      case "tools": {
        const r = await tableScreen({
          title: TOOLS_TITLE,
          top: TOOLS_TOP,
          counter,
          rows: rows.tools,
          recipe,
          manifest: o.manifest,
          grouped: true,
          platform: o.platform,
          footer: ticks => {
            const next = withTools(recipe, ticks);
            return [totalsLine(recipeTable(next, CATALOG_TOOLS), "tools"), ...(floorApplies(recipe.tick) ? [{ text: FLOOR_LINE }] : []), diskFooter(pickEstimate(o.manifest, next, o.brew), o.builderDiskGb)];
          },
          ...streams,
        });
        if (r.kind === "cancel") return "cancel";
        recipe = withTools(recipe, r.ticks);
        step(r);
        break;
      }
      case "also": {
        // The Disk line follows the ticks here too: these are the heavy rows, and they are what the boot check reads.
        const r = await rungSelect({
          title: alsoTitle(o.platform),
          top: alsoTop(o.platform),
          counter,
          items: rows.also,
          initial: scannedTicks(recipe, scan),
          groupLine: alsoGroupLine(scan),
          footer: a => [diskFooter(pickEstimate(o.manifest, withScanned(recipe, scan, a.ticks, o.platform), o.brew), o.builderDiskGb)],
          ...streams,
        });
        if (r.kind === "cancel") return "cancel";
        recipe = withScanned(recipe, scan, r.ticks, o.platform);
        step(r);
        break;
      }
      case "logins": {
        const s = rows.logins;
        const answers = new Map([...s.initial].map(([id, choice]): [string, LoginChoice] => [id, logins.get(id) ?? choice]));
        const r = await rungSelect({
          title: SIGN_INS_TITLE,
          top: SIGN_INS_TOP,
          counter,
          items: s.items,
          initial: new Set(),
          answers,
          detailLines: 3,
          groupLine: signInGroupLine,
          ...streams,
        });
        if (r.kind === "cancel") return "cancel";
        logins = new Map([...answers].map(([id, choice]): [string, LoginChoice] => [id, (r.answers.get(id) as LoginChoice) ?? choice]));
        step(r);
        break;
      }
      case "wsp": {
        const w = rows.wsp;
        const initial = wspTicks === undefined ? w.initial : new Set([...wspTicks].filter(id => w.items.some(i => i.id === id)));
        const r = await rungSelect({ title: wspTitle(o.platform), top: WSP_TOP, counter, items: w.items, initial, ...streams });
        if (r.kind === "cancel") return "cancel";
        wspTicks = new Set(r.ticks);
        wspTools = new Set([...r.ticks].flatMap(id => wspToolsAgent(id) ?? []));
        step(r);
        break;
      }
      default: {
        const _exhaustive: never = screen;
        return _exhaustive;
      }
    }
    if (i < 0) i = 0;
  }
  return { recipe, logins, wspTools };
}
