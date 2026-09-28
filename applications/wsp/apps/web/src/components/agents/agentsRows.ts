// SPDX-License-Identifier: AGPL-3.0-only
// What every kind of row shares, pure: the words, the act a row or a detail
// offers, what decides whether an act can be taken where the list stands, the
// sign-in roads, and the lines under the list. Each kind's own rows, detail
// and acts are its module under kinds/.
import { LogInIcon, PencilIcon, XIcon, type LucideIcon } from "lucide-react";
import { agentName, catalogEntry, hasLogin, loginIdOf, mintsToken, serverSignInRoad } from "@wsp/catalog";
import { outcomeWord } from "../../settings/places.js";
import { agentOfRow, type AgentRow, type AgentsProject, type AgentsReport, type AgentsTarget, type McpRow, type PageReach, type PlaceProvisionRow, type SealedImage, type ServerAdd, type ServerToolsAnswer, type SignInRoad, type SkillHit, type SkillPreview, type SkillRow } from "@wsp/protocol";

/** Where the report was read, which decides which acts a row offers: this computer, a joined box, a fork at a cloud
 * (a copy, so every act is the image's), a cloud's own page (the image's rows), or a task standing on a box, whose
 * acts are that box's page's. */
export type AgentsWhere = "here" | "box" | "fork" | "provider" | "box-task";

export const AGENTS_LIST_WORDS = {
  section: "Agents, MCP servers and skills",
  readAgain: "Read again",
  readAgo: (span: string): string => `read ${span} ago`,
  paused: "paused",
  away: "away",
  back: (to: string): string => `Back to ${to}`,
  groupAndSort: "Group and sort",
  groupBy: "Group by",
  sortBy: "Sort by",
  name: "Name",
  of: (shown: number, all: number): string => `${shown} of ${all}`,
  nothingMatches: (q: string): string => `Nothing matches "${q}".`,
  openComputer: (computer: string): string => `Open ${computer} in Settings`,
  signedIn: "signed in",
  connected: "connected",
  checking: "checking",
  failed: "failed",
  noSignInNeeded: "no sign-in needed",
  keyFromEnvironment: "key from the environment",
  needsSignIn: "needs sign-in",
  yourKey: "your key",
  notChecked: "not checked",
  notInstalled: "not installed",
  signIn: "Sign in",
  cancel: "Cancel",
  update: "Update",
  install: "Install",
  uninstall: "Uninstall",
  remove: "Remove",
  turnOn: "Turn on",
  turnOff: "Turn off",
  reconnect: "Reconnect",
  addTools: "Add the wsp tools",
  listTools: "List tools",
  check: "Check",
  checkStarts: (computer: string): string => `Check starts it on ${computer}`,
  viewTools: "View tools",
  listing: "Listing",
  toolsOf: (name: string): string => `Tools of ${name}`,
  toolsCount: (n: number): string => `${n} ${n === 1 ? "tool" : "tools"}`,
  holdsSignIn: (agent: string): string => `${agent} holds the sign-in`,
  keepsSignIn: (agent: string): string => `${agent} keeps this server's sign-in, so wsp cannot list its tools yet.`,
  signInToSee: "sign in to see its tools",
  notListed: "not listed yet",
  editImage: "Edit image",
  /** Why Edit image is held on a fork: the image is edited from its cloud's page, which a host with no key for it has
   * none of. */
  editImageHeld: "This host holds no key for its cloud",
  waitingOnYou: "waiting on you",
  openInTerminal: "Open in terminal",
  open: "Open",
  openPage: "Open the page",
  finishInBrowser: "Finish in your browser",
  landedAddress: "The address your browser landed on",
  pageStaysHere: (computer: string): string => `Its page returns to localhost, which wsp does not carry back to ${computer} yet. Run this in a terminal on ${computer}:`,
  runInTerminal: "Run in your terminal",
  pasteToken: "Paste the token",
  pasteKey: "Paste the key",
  save: "Save",
  toolsHereOnly: "a thread there is handed the wsp tools with every turn",
  /** Why an act whose road is a later build stands held. */
  notYet: "not in this wsp yet",
  status: "Status",
  version: "Version",
  latest: (v: string): string => `latest ${v}`,
  pins: (v: string): string => `recipe pins ${v}`,
  installedAt: "Installed at",
  latestLabel: "Latest",
  madeBy: "Made by",
  license: "License",
  homepage: "Homepage",
  repo: "Repository",
  viaShim: (app: string): string => `via a shim from ${app}`,
  fromPanel: "from a task's own panel",
  wspTools: "wsp tools",
  notAdded: "not added",
  threads: "Threads",
  threadsInWsp: "in wsp",
  threadsNotYet: "not yet in wsp",
  description: "Description",
  path: "Path",
  parameters: "Parameters",
  required: "required",
  shared: "shared",
  command: "Command",
  url: "URL",
  environment: "Environment",
  headers: "Headers",
  configLocation: "Config location",
  tools: "Tools",
  recipe: "Recipe",
  inRecipe: "yes",
  notInRecipe: "not in the recipe",
  roads: { device: "device code", code: "pasted code", token: "token", key: "key", terminal: "in a terminal" } satisfies Record<Exclude<SignInRoad, "none">, string>,
  own: "by you, not by wsp",
  shim: "through a shim",
  ownHold: "installed by you, not by wsp",
  shimHold: "runs through a shim wsp does not touch",
  onPage: (computer: string): string => `on ${computer}'s page`,
  startsOnce: "starts the server once",
  on: "on",
  alwaysOn: "always on",
  keptCurrent: "wsp keeps it current on every start",
  inRepo: "in the repo",
  livesInRepo: (path: string): string => `lives in the repo at ${path}`,
  fromPlugin: "from a plugin, turn the plugin off instead",
  noReader: "This wsp reads no agents report yet.",
  copy: "Copy",
  off: "off",
  addSkill: "Add a skill",
  searchSkillsSh: "Search skills on skills.sh",
  skillsSh: "skills.sh",
  typeToSearch: "Type a name or a topic to find a skill.",
  noHits: (q: string): string => `skills.sh has nothing for "${q}".`,
  installed: "installed",
  installName: (name: string): string => `Install ${name}`,
  installing: "Installing",
  source: "Source",
  installs: "Installs",
  agents: "Agents",
  where: "Where",
  global: "Global",
  readsShared: "reads the shared skills folder, so it has the skill anyway",
  alreadyOn: (computer: string): string => `already on ${computer}`,
  firstOf: (shown: number, all: number): string => `shows the first ${shown} KB of ${all} KB`,
  removeTitle: (name: string): string => `Remove ${name}?`,
  removeBody: (computer: string): string => `Its folder and every link to it leave ${computer}.`,
  leavesFiles: (files: readonly string[], computer: string): string => `It leaves ${files.join(" and ")} on ${computer}.`,
  noSwitch: (agent: string): string => `${agent} turns a server off per folder, in its own /mcp`,
  addServer: "Add an MCP server",
  agent: "Agent",
  serverName: "Name",
  reachedBy: "Reached by",
  byCommand: "Command",
  byAddress: "Address",
  variables: "Variables",
  addVariable: "Add a variable",
  addHeader: "Add a header",
  value: "value",
  removePair: (name: string): string => (name === "" ? "Remove this line" : `Remove ${name}`),
  addServerGo: "Add server",
  adding: "Adding",
  twoPairsOneName: (road: "command" | "address"): string => (road === "command" ? "Two variables have the same name; keep one of them." : "Two headers have the same name; keep one of them."),
  projectLeft: (project: string, computer: string): string => `${project} is no longer on ${computer}; pick where it goes.`,
  noServerAgents: (computer: string): string => `No agent on ${computer} keeps MCP servers in a file wsp writes.`,
} as const;

/** Compact counts the way skills.sh draws them: 3.6M, 201K, 12. */
export const compactCount = (n: number): string => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export interface RowAct {
  readonly id: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  /** Why it is held where the reason is a fact the row does not show. */
  readonly hover?: string;
  /** Neutral at rest and the danger ink under the pointer: an act after which something does not come back. */
  readonly destructive?: boolean;
  /** The road it takes; absent, the act is held. */
  readonly run?: () => void;
  /** Its road is running: the label says so beside a spinner. */
  readonly busy?: boolean;
  /** Taken from a row it leaves the list standing, as nothing follows it to watch. */
  readonly inPlace?: boolean;
  /** An act after which something does not come back asks once first, in these words. */
  readonly confirm?: { readonly title: string; readonly body: string };
}

/** One server's tools as its last ask stands: running, answered, or refused by the host. */
export interface ToolsState {
  readonly listing: boolean;
  readonly answer?: ServerToolsAnswer;
  readonly error?: string;
}

/** Each server's tools on this target, and the road that asks for them. */
export interface ServerTools {
  of(row: McpRow): ToolsState | undefined;
  list(row: McpRow, refresh?: boolean): void;
}

/** How a Sign in goes where it was pressed: run in a watched pty on that computer, a token or key pasted into this
 * host's vault under the line that mints it, a line the person runs in their terminal, or typed into a task's own
 * terminal on this computer. Worked out here off the report and the catalog, so every row reads one rule. */
export type SignInStart =
  | { readonly kind: "run"; readonly agent: string; readonly server?: string; readonly finish?: ServerFinish; readonly pastes?: boolean }
  | { readonly kind: "vault"; readonly agent: string; readonly mint?: string; readonly word: "token" | "key" }
  | { readonly kind: "copy"; readonly line: string; readonly why?: string }
  | { readonly kind: "terminal"; readonly line: string };

/** How a server's sign-in finishes: in the browser, where the harness takes the redirect itself on this computer or
 * over the host's callback relay, or by the address the browser landed on pasted back. */
export type ServerFinish = "callback" | "address";

/** A sign-in as its detail draws it while it stands. */
export type SignInFlow =
  | { readonly kind: "run"; readonly state: "running" | "waiting" | "failed"; readonly finish?: ServerFinish; readonly pastes?: boolean; readonly url?: string; readonly code?: string; readonly paste?: boolean; readonly said?: string }
  | { readonly kind: "vault"; readonly agent: string; readonly mint?: string; readonly word: "token" | "key"; readonly saving?: boolean; readonly refused?: string }
  | { readonly kind: "copy"; readonly line: string; readonly why?: string };

/** What a sign-in draws under the detail's acts, with the roads it takes from there. */
export interface FlowView {
  readonly flow: SignInFlow;
  readonly code: (code: string) => void;
  readonly save: (key: string) => void;
}

/** A document a detail draws under its facts, as its read stands: reading, read, or refused by the host. */
export interface DocState {
  readonly reading: boolean;
  readonly preview?: SkillPreview;
  readonly error?: string;
}

/** A search of skills.sh as it stands for one query. */
export interface SkillSearch {
  readonly reading: boolean;
  readonly hits?: readonly SkillHit[];
  readonly error?: string;
}

/** What an install is picked to take: the agents to put the skill in and the project it goes in, else the home. */
export interface SkillPicks {
  readonly agents: readonly string[];
  readonly project?: ProjectPick;
}

/** The skills road of one target: a SKILL.md read for its preview, skills.sh searched and read by the host, a skill
 * installed, turned off or on, removed; each by its key (a row's `scope:name`, a hit's id), what is running and why
 * the last ask was refused. */
export interface SkillActs {
  previewOf(row: SkillRow): DocState | undefined;
  loadPreview(row: SkillRow): void;
  remoteOf(id: string): DocState | undefined;
  loadRemote(id: string): void;
  searchOf(q: string): SkillSearch | undefined;
  search(q: string): void;
  picksOf(id: string): SkillPicks | undefined;
  setPicks(id: string, picks: SkillPicks): void;
  toggle(row: SkillRow, on: boolean): void;
  remove(row: SkillRow): void;
  add(id: string, agents: readonly string[], project: AgentsProject | undefined): void;
  busyOf(key: string): boolean;
  refusedOf(key: string): string | undefined;
}

/** The servers road of one target: a server added, whose values the form alone holds until the host takes them,
 * and one entry's rows removed or turned off or on, each by the entry's key, with what is running and why the last
 * ask was refused. */
export interface ServerActs {
  add(ask: ServerAdd, project: AgentsProject | undefined): Promise<unknown>;
  remove(key: string, rows: readonly McpRow[]): void;
  toggle(key: string, rows: readonly McpRow[], on: boolean): void;
  busyOf(key: string): boolean;
  refusedOf(key: string): string | undefined;
}

/** The key a skill's own state is kept under: a project's skill by its project too, since two projects may each keep
 * one of a name. */
export const skillKey = (row: Pick<SkillRow, "scope" | "name" | "project">): string => `${row.scope}:${row.project === undefined ? "" : `${row.project.id}:`}${row.name}`;

/** Where an act on one row goes: a computer's read covers all its projects, so an act on a project's row names that
 * project; a workspace names its own. */
export const rowTarget = (target: AgentsTarget, project: AgentsProject | undefined): AgentsTarget => ("placeId" in target && project !== undefined ? { placeId: target.placeId, project: project.id } : target);

/** Whether a row lives in that project's folder. */
export const inProject = (row: { readonly scope: string; readonly project?: AgentsProject }, project: AgentsProject): boolean => row.scope === "project" && row.project?.id === project.id;

/** The value of the pick that puts an add in the home rather than in a project, whose values are the projects' ids. */
export const HOME_PICK = "home";

/** A project an add is pointed at: its id, which is what resolves it, and its name as it read when picked, which is
 * what a line says once it has left the computer. */
export interface ProjectPick {
  readonly id: string;
  readonly name: string;
}

/** The pick a value of where makes: none for the home, else the project the report has by that id. */
export const pickOf = (report: AgentsReport | null, value: string): ProjectPick | undefined => {
  const project = report?.projects?.find(p => p.id === value);
  return project === undefined ? undefined : { id: project.id, name: project.name };
};

/** Where an add goes, resolved against the report as it stands: the options (the home, then each project by name
 * with its folder; none where the report covers no project and nothing was picked), the project picked, and, where
 * that project has left, the line that says so, while the add is held. */
export interface WhereNow {
  readonly options: readonly PickOption[];
  readonly value: string;
  readonly project?: AgentsProject;
  readonly lost?: string;
}

export function whereNow(report: AgentsReport | null, pick: ProjectPick | undefined, computer: string): WhereNow {
  const projects = [...(report?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const options = projects.length === 0 && pick === undefined ? [] : [{ value: HOME_PICK, label: AGENTS_LIST_WORDS.global }, ...projects.map(p => ({ value: p.id, label: p.name, fact: p.path }))];
  if (pick === undefined) return { options, value: HOME_PICK };
  const project = projects.find(p => p.id === pick.id);
  return project === undefined ? { options, value: pick.id, lost: AGENTS_LIST_WORDS.projectLeft(pick.name, computer) } : { options, value: pick.id, project };
}

/** One option of a pick, by its name with a fact beside it. */
export interface PickOption {
  readonly value: string;
  readonly label: string;
  readonly fact?: string;
}

/** The sign-ins and writes a list on one target takes, by the row's id. */
export interface AgentActs {
  flowOf(rowId: string): SignInFlow | undefined;
  start(rowId: string, start: SignInStart): void;
  /** Ends a running sign-in on the host and drops what it drew. */
  cancel(rowId: string): void;
  code(rowId: string, code: string): void;
  save(rowId: string, key: string): void;
  addTools(agent: string): void;
  adding(agent: string): boolean;
}

/** What decides the acts: where the report was read, the computer a task on a box defers to, the away word every act
 * is held with while the computer is not answering or the task is paused, and the one road that exists before the
 * acts' own builds: Edit image. */
export interface RowsContext {
  readonly where: AgentsWhere;
  readonly computer?: string;
  readonly heldWhy?: string | null;
  readonly editImage?: () => void;
  readonly tools?: ServerTools;
  readonly acts?: AgentActs;
  readonly skills?: SkillActs;
  readonly servers?: ServerActs;
  /** Types a line into a terminal of the task on this computer, for a sign-in only the person can finish. */
  readonly typeInTerminal?: (line: string) => void;
  /** The computer as the manager's lines name it; the manager fills it in. */
  readonly on?: string;
  /** Where a sign-in page that returns to localhost reaches, as the host said on the report. */
  readonly reach?: PageReach;
}

/** Why no act on the list can be taken: the computer is away, the task is paused, or the acts are another page's. */
export const heldReason = (ctx: RowsContext): string | undefined => ctx.heldWhy ?? (ctx.where === "box-task" && ctx.computer !== undefined ? AGENTS_LIST_WORDS.onPage(ctx.computer) : undefined);

export const holdAll = (acts: RowAct[], ctx: RowsContext): RowAct[] => {
  const why = heldReason(ctx);
  return why === undefined ? acts : acts.map(({ run: _run, busy: _busy, ...act }) => ({ ...act, hover: why }));
};

/** Whether the rows are a copy of the image, so every act is the image's. */
export const onImage = (ctx: RowsContext): boolean => ctx.where === "fork" || ctx.where === "provider";

/** The one act a copy of the image offers: editing the image every copy is made from. */
export const editImageAct = (ctx: RowsContext): RowAct => ({ id: "edit-image", label: AGENTS_LIST_WORDS.editImage, icon: PencilIcon, ...(ctx.editImage === undefined ? { hover: AGENTS_LIST_WORDS.editImageHeld } : { run: ctx.editImage }) });

/** An act whose road is a later build: drawn where it will stand, held with the reason. */
export const notYet = (id: string, label: string, icon: LucideIcon, over: Partial<RowAct> = {}): RowAct => ({ id, label, icon, hover: AGENTS_LIST_WORDS.notYet, ...over });

/** How an agent's Sign in goes where the list stands; nothing for an agent with no sign-in. */
export function agentSignInStart(row: AgentRow, ctx: RowsContext): SignInStart | undefined {
  const signIn = catalogEntry(row.id)?.signIn;
  if (row.signInRoad === "token") return { kind: "vault", agent: row.id, word: "token", ...(signIn !== undefined && mintsToken(signIn) ? { mint: signIn.mint } : {}) };
  if (row.signInRoad === "key") return { kind: "vault", agent: row.id, word: "key" };
  if (row.signInRoad === "terminal") {
    if (ctx.typeInTerminal !== undefined && signIn !== undefined && hasLogin(signIn)) return { kind: "terminal", line: signIn.login };
    return { kind: "copy", line: ctx.where === "box" && ctx.computer !== undefined ? `wsp add ${ctx.computer} --sign-in ${row.id}` : `wsp agents signin ${row.id}` };
  }
  return row.signInRoad === "none" ? undefined : { kind: "run", agent: row.id, ...(row.signInRoad === "code" ? { pastes: true } : {}) };
}

/** How one server's Sign in goes: its harness's own command in a watched pty, or the line the person runs where
 * that command's page cannot come back. */
export function serverSignInStart(row: McpRow, ctx: RowsContext): SignInStart | undefined {
  const road = serverSignInRoad(row.agent, row.name, ctx.reach ?? "none");
  if (road === undefined) return undefined;
  if (road.kind === "pty") return { kind: "run", agent: row.agent, server: row.name, finish: road.finish === "callback" ? "callback" : "address", pastes: true };
  return { kind: "copy", line: road.line, ...(road.why === "callback" ? { why: AGENTS_LIST_WORDS.pageStaysHere(ctx.computer ?? "that computer") } : {}) };
}

/** Whether a watched sign-in is still going, so its act is Cancel. */
const runningFlow = (flow: SignInFlow | undefined): boolean => flow?.kind === "run" && flow.state !== "failed";

/** The Sign in act for one row, Cancel while its run goes, and the flow it drew while one stands. */
export function signInAct(id: string, start: SignInStart | undefined, ctx: RowsContext): { act: RowAct; flow?: FlowView } {
  const acts = ctx.acts;
  const flow = acts?.flowOf(id);
  const view = flow === undefined || acts === undefined ? {} : { flow: { flow, code: (code: string) => acts.code(id, code), save: (key: string) => acts.save(id, key) } };
  if (runningFlow(flow) && acts !== undefined) return { act: { id: "cancel", label: AGENTS_LIST_WORDS.cancel, icon: XIcon, run: () => acts.cancel(id), inPlace: true }, ...view };
  const run = start === undefined ? undefined : start.kind === "terminal" ? (ctx.typeInTerminal === undefined ? undefined : () => ctx.typeInTerminal!(start.line)) : acts === undefined ? undefined : () => acts.start(id, start);
  return { act: { id: "sign-in", label: AGENTS_LIST_WORDS.signIn, icon: LogInIcon, ...(run === undefined ? {} : { run }) }, ...view };
}

/** Whether a sign-in waits on the person: its row says so in place of its state. */
export const waitingFlow = (flow: FlowView | undefined): boolean => flow?.flow.kind === "run" && flow.flow.state === "waiting";

/** The agents a skill or a server is set up for, their names joined for a hover. */
export const agentNames = (agents: readonly string[]): string => agents.map(agentName).join(", ");

/** One line under the list: the reader that could not answer and why, or a recipe row that is not on the machine. */
export interface RefusedLine {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
}

/** The report's refusals, one line per reader. Each reads `<reader>: <reason>`; a line with no reader stands as a
 * sentence of its own. */
export function refusedLines(refused: readonly string[]): RefusedLine[] {
  return refused.map((line, at) => {
    const split = line.indexOf(": ");
    if (split <= 0) return { id: `refused-${at}`, label: line };
    const reader = line.slice(0, split);
    return { id: `refused-${at}`, label: reader.charAt(0).toUpperCase() + reader.slice(1), value: line.slice(split + 2) };
  });
}

/** What the recipe meant to put beside the agents and did not: an agent, a skill file or a server whose row failed
 * or was set aside, which the report cannot show since it is not on the machine. */
export function recipeMissLines(rows: readonly PlaceProvisionRow[]): RefusedLine[] {
  return rows.flatMap(row => {
    if (row.outcome !== "failed" && row.outcome !== "skipped") return [];
    if (row.kind !== "file" && row.kind !== "server" && agentOfRow(row) === undefined) return [];
    return [{ id: `recipe-${row.id}`, label: row.label, value: outcomeWord(row)! }];
  });
}

/** Whether the report is the last one read while the task ran, so nothing it offers can be done now. */
export const pausedReport = (report: AgentsReport | null): boolean => report?.stale === "napping";

/** A cloud's page reads no machine, since nothing stands there between forks: its rows are the agents the image was
 * sealed with, at the versions the seal pinned, signed in where the seal carried the login. */
export function imageAgentsReport(image: SealedImage, placeId: string): AgentsReport {
  const agents: AgentRow[] = (image.pins ?? []).flatMap(pin => {
    if (catalogEntry(pin.id)?.kind !== "agent") return [];
    const login = image.logins.find(l => l.name === loginIdOf(pin.id))?.state;
    return [{ id: pin.id, name: agentName(pin.id), installed: true, version: pin.tag, road: "wsp", signIn: login === "signed-in" || login === "copied" ? "signed-in" : "unknown", signInRoad: "none", wspTools: false }];
  });
  return { target: { placeId }, home: "", user: "", readAt: image.sealedAt, agents, skills: [], servers: [], refused: [] };
}
