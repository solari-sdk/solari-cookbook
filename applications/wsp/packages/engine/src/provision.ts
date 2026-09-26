// SPDX-License-Identifier: AGPL-3.0-only
// The recipe on a computer somebody owns. The image road builds a layer and
// forks it; a computer you joined has no layer, so the same planned steps run
// on the computer itself: the floor first, then every ticked row the computer
// does not already satisfy, then the machine context. Nothing here knows how
// the computer is reached: it drives a Machine, which for a box is that
// computer over the link its daemon holds.
import { ROAD_MODULES } from "@wsp/catalog";
import { agentOfRow, plural, presentElsewhereLine, provisionServersLine, provisionSkippedLine, shellQuote, type PlaceProvisionRow } from "@wsp/protocol";
import { markersOf, pagedReads } from "./exec-detached.js";
import { installBase } from "./golden-base.js";
import { TOOLS_PATH, agentSteps, pathLine, type SkippedPath, type ToolInstall } from "./golden-import.js";
import type { McpPlan } from "./golden-mcp.js";
import { installTools, type ToolResult } from "./golden-tools.js";
import type { GoldenImport, ImportResult, PackFiles } from "./golden.js";
import { applyMachineContext } from "./machine-context.js";
import type { Machine } from "./machine.js";
import { closeAgentFiles, oncePathsOf, provisionFiles, type OwnedPaths, type ProvisionLanding } from "./provision-files.js";
import { provisionMcp } from "./provision-mcp.js";

/** What the recipe comes to on a computer you own, in run order: the node step, the agents after it, the tools by
 * their roads, the rows outside the catalog last, each with the `after` chain the tools plan gave it. The floor is
 * not here: installBase reads what the computer has and runs its own steps first. */
export interface ProvisionPlan {
  recipeAt: string;
  /** The one PATH every script of this job exports, chosen when the plan was made: the probe list for a computer
   * somebody owns, whose home every workspace on it writes, and the tools PATH for a machine wsp forked. */
  path: string;
  /** The folder of wsp's own every manager installs under on a computer somebody owns, told to each of them on
   * the same line as that PATH; absent for a machine wsp forked, whose home is root's alone. */
  prefix?: string;
  steps: readonly ToolInstall[];
  /** Rows set aside before anything ran, with the plan's reason each. */
  skipped: readonly { id: string; label: string; note: string }[];
  /** The person's own agent files: where each ticked path lands in an agent's home on the computer, and the
   * archive read off this computer when the job runs. Absent when the recipe carries none. */
  files?: { lands: readonly ProvisionLanding[]; pack: PackFiles };
  /** The MCP servers the recipe names, per agent and config format; absent when no row is a server. */
  mcp?: McpPlan;
}

/** What the job says as it goes: a line, the row under way, and a row's outcome the moment it has one. */
export type ProvisionStage = (detail: string, at?: { label: string; index: number; of: number }, row?: PlaceProvisionRow) => void;

/** The plan off a golden import: the agents as steps of the one tools loop, then the tools, and the import's own
 * set-aside rows as the plan's. The files, the shell and the MCP servers of that import are not put on a computer
 * somebody lives on; what installs is what this plan carries. */
export function provisionPlanOf(imp: GoldenImport, recipeAt: string, path: string, prefix?: string): ProvisionPlan {
  const agents = agentSteps({ installs: imp.agents, skipped: [], ...(imp.node !== undefined ? { node: imp.node } : {}) }, undefined, path, prefix);
  const files = imp.files;
  const once = onceDests(imp);
  return {
    recipeAt,
    path,
    ...(prefix !== undefined ? { prefix } : {}),
    steps: [...agents, ...imp.tools],
    skipped: [
      ...(imp.skippedAgents ?? []).map(a => ({ id: a.id, label: a.name, note: a.note })),
      ...(imp.skippedTools ?? []).map(t => ({ id: t.id, label: t.label, note: t.note })),
    ],
    ...(files !== undefined && files.lands.length > 0 ? { files: { lands: oncePerDest(files.lands).map(l => (once.has(l.dest) ? { ...l, once: true as const } : l)), pack: files.pack } } : {}),
    ...(imp.mcp !== undefined ? { mcp: imp.mcp } : {}),
  };
}

/** Which of the recipe's destinations land once rather than on every run: the file an agent keeps its own MCP
 * servers in, and a path on an agent's own row the recipe marks volatile, which is a file that agent rewrites as it
 * runs. From the first landing on, what is in such a file is the agent's, and what the recipe has to say about it is
 * its server keys. A login's own file is not one of them: a token this computer refreshed is still the recipe's to
 * carry to that computer. */
function onceDests(imp: GoldenImport): Set<string> {
  const home = imp.mcp?.guestHome;
  const configs = (imp.mcp?.agents ?? []).flatMap(a => a.scopes.flatMap(s => s.files)).flatMap(f => (home !== undefined && f.startsWith(`${home}/`) ? [f.slice(home.length + 1)] : []));
  const rewritten = (imp.recipe?.files ?? []).flatMap(f => (f.volatile === true && agentOfRow(f) !== undefined ? [f.dest] : []));
  return new Set([...configs, ...rewritten]);
}

/** One entry per destination, the first row that named it: a file the recipe names on more than one row (an
 * agent's config is its own row and its servers' too) is one file on that computer and answers with one row. */
const oncePerDest = (lands: readonly ProvisionLanding[]): ProvisionLanding[] => lands.filter((l, at) => lands.findIndex(o => o.dest === l.dest) === at);

/** What the plan puts on a computer, by kind, for the line a job opens with and the header of its log there. */
export function provisionCountsOf(plan: ProvisionPlan): { tool: number; file: number; server: number } {
  return {
    tool: plan.steps.length,
    file: plan.files?.lands.length ?? 0,
    server: (plan.mcp?.agents ?? []).reduce((n, a) => n + a.aside.length + a.scopes.reduce((k, s) => k + s.keep.length + s.drop.length, 0), 0),
  };
}

/** What the presence read prints for a step the computer already satisfies: the marker and the step's place in the
 * read, since an id is a custom row's own free text and can carry the space this line is read back on. */
const PRESENT = "wsp-present";

/** The tests one step must pass to count as already there: its road's own presence read where the road has one
 * and its check otherwise, its command on the tools PATH where it names one, and its road's version read where the
 * version is the question the others cannot answer, which is a step that pins a version and a step that says
 * nothing else to read at all. A package a person named by its own package name is the second case: it carries no
 * command and no check, and its road's version read is the whole of what its computer can be asked.
 *
 * The road's read comes first because a check is worded for after an install and a presence read is not the same
 * question: a formula's check is `brew list --versions`, which the prefix's own link answers without running brew
 * at all. Read by the job and by the doctor, on the same planned steps, so a computer cannot read green on one
 * surface and red on the other.
 *
 * One read per step, since a read is about a second and a page of them has the inline exec's bound to answer
 * inside: a formula's check and its version read are the same `brew list` under `su`, and a page of eight rows
 * asked twice each is sixteen of them against twenty seconds, whose exec failing reads nothing present and
 * installs all eight again. */
export function presenceTests(step: ToolInstall): string[] {
  const tests: string[] = [];
  const own = step.present ?? step.check;
  if (own !== undefined) tests.push(`( ${own} ) >/dev/null 2>&1`);
  if (step.bin !== undefined) tests.push(`command -v ${shellQuote(step.bin)} >/dev/null 2>&1`);
  const version = step.pin?.read;
  if (version !== undefined && (step.asks !== undefined || tests.length === 0)) {
    const read = `"$( ( ${version} ) 2>/dev/null | head -n 1 | tr -d '[:space:]' )"`;
    tests.push(step.asks === undefined ? `[ -n ${read} ]` : `[ ${read} = ${shellQuote(step.asks)} ]`);
  }
  return tests;
}

/** What one step's presence read said beyond that the step is there: the path its command answered from, where the
 * read asked for a command at all. Read to tell a row its own road installed from a row of the same name another
 * road put somewhere else. */
export interface PresentRead {
  path?: string;
}

/** The steps the computer already satisfies, by the rule above, a page of reads to an exec by the one paging rule
 * every batched read here takes, each with what its read said about it. The reads run on the job's own PATH and
 * under its managers' knobs: a row's version read is its manager's own command and answers about the folder that
 * manager was told to keep its tools in. A page that could not be made says nothing is present in it, which
 * installs those steps again rather than skipping one that is not there. */
export async function presentSteps(machine: Machine, steps: readonly ToolInstall[], path: string = TOOLS_PATH, prefix?: string): Promise<Map<string, PresentRead>> {
  const asked = steps.flatMap(step => {
    const tests = presenceTests(step);
    return tests.length === 0 ? [] : [{ step, tests }];
  });
  const present = new Map<string, PresentRead>();
  // The path rides the marker line where the step names a command, since the read has already found it and a
  // second exec for it would be a page of reads again.
  const pages = await pagedReads(
    machine,
    asked,
    (row, at) => `if ${row.tests.join(" && ")}; then printf '${PRESENT} %s %s\\n' ${at} "${row.step.bin === undefined ? "" : `$(command -v ${shellQuote(row.step.bin)} 2>/dev/null)`}"; fi`,
    pathLine(path, prefix),
  );
  for (const { rows, res } of pages) {
    if (res.exitCode !== 0) continue;
    const marked = markersOf(res.stdout, PRESENT);
    for (const [at, row] of rows.entries()) {
      const said = marked.get(String(at));
      if (said === undefined) continue;
      const path = said.trim();
      present.set(row.step.id, path === "" ? {} : { path });
    }
  }
  return present;
}

/** The steps nothing can be asked about that every step waiting on them says are there: an index refresh answers
 * no read of its own, and what it was for is the rows behind it, so a computer that has all of them has nothing for
 * it to do. A step nothing waits on is not present by this rule, since nothing on that computer says it is. */
export function presentByWhatWaits(steps: readonly ToolInstall[], present: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const step of steps) {
    if (presenceTests(step).length > 0) continue;
    const waiting = steps.filter(s => s.after === step.id);
    if (waiting.length > 0 && waiting.every(s => present.has(s.id))) out.add(step.id);
  }
  return out;
}

/** The note a present row carries where the command answered from outside the directories its own road links
 * into: the path is a fact the read already has, and naming the road that did answer would be a guess, since
 * several roads link into /usr/local/bin. A step whose road names no directories, or whose command answered from
 * one of them, says nothing. */
export function presentElsewhere(step: ToolInstall, read: PresentRead | undefined): string | undefined {
  const bins = step.bins ?? [];
  const path = read?.path;
  if (path === undefined || step.bin === undefined || bins.length === 0) return undefined;
  if (bins.some(dir => path.startsWith(`${dir}/`))) return undefined;
  return presentElsewhereLine(step.bin, path, ROAD_MODULES[step.manager].words, bins);
}

/** One step's outcome as a row of the job: a step the computer already had reads present and carries the one note
 * its read has to say, which is a command answering from outside its own road's directories. The landing's own
 * note for such a step says it was already there, which the outcome says, so it is dropped as it always was. */
function rowOf(result: ToolResult, present: ReadonlyMap<string, PresentRead>, step?: ToolInstall): PlaceProvisionRow {
  const read = present.get(result.id);
  const outcome = result.outcome === "installed" && read !== undefined ? "present" : result.outcome;
  const note = outcome === "present" ? (step === undefined ? undefined : presentElsewhere(step, read)) : result.note;
  return {
    id: result.id,
    label: result.label,
    outcome,
    ...(note !== undefined ? { note } : {}),
    ...(result.ms !== undefined ? { ms: result.ms } : {}),
  };
}

/** The line a row's outcome reads as while the job runs. */
const rowLine = (row: PlaceProvisionRow): string => `${row.label}: ${row.outcome}${row.note === undefined ? "" : ` (${row.note})`}`;

/** What the job is on while it lands the person's own files and writes their servers, for the row under way. */
const FILES_LABEL = "your agents' files";
const MCP_LABEL = "MCP servers";

export interface ProvisionOn {
  /** The home of the login the computer's agent runs as: where the agents' own folders are there. */
  home: string;
}

/** Runs the plan on the computer: the floor through installBase, then the steps it does not already satisfy
 * through the one tools loop, with its caches kept since they are the person's own, then the person's own agent
 * files into the agents' homes there, then the recipe's MCP servers into the configs that landed, then the
 * machine context after all of it so it names what did not land. Answers one row per step, per set-aside row, per
 * file landed and per server; throws only when the computer stopped answering, which is the one thing the job
 * cannot report a row for. */
export async function provisionBox(machine: Machine, plan: ProvisionPlan, stage: ProvisionStage, on: ProvisionOn): Promise<PlaceProvisionRow[]> {
  const rows: PlaceProvisionRow[] = [];
  const say = (row: PlaceProvisionRow, at?: { label: string; index: number; of: number }): void => {
    rows.push(row);
    stage(rowLine(row), at, row);
  };
  for (const aside of plan.skipped) say({ id: aside.id, label: aside.label, outcome: "skipped", note: aside.note });
  let done = 0;
  const of = plan.steps.length + (plan.files !== undefined ? 1 : 0) + (plan.mcp !== undefined ? 1 : 0);
  /** The row under way: the step the loop has reached, once it has started; nothing while the floor runs. */
  const at = (): { label: string; index: number; of: number } | undefined => {
    const step = plan.steps[done];
    return step === undefined ? undefined : { label: step.label, index: done + 1, of };
  };
  /** The stage the file and server rounds are on, which are one round each rather than a row apiece. */
  const round = (label: string): { label: string; index: number; of: number } => ({ label, index: Math.min(done + 1, of), of });
  // The floor keeps this computer's caches: npm's and apt's under a person's own home are theirs, and a builder
  // sweeping them is a builder that becomes an image. Its own lines are what a person reads, not the stage id the
  // image build files them under.
  const base = await installBase(machine, (_which, detail) => {
    if (detail !== undefined) stage(detail);
  }, { caches: "keep", path: plan.path, ...(plan.prefix !== undefined ? { prefix: plan.prefix } : {}) });
  stage(base.line);
  const read = await presentSteps(machine, plan.steps, plan.path, plan.prefix);
  // The steps nothing can be asked about carry no read of their own: what says they are there is the rows behind them.
  const present = new Map<string, PresentRead>([...read, ...[...presentByWhatWaits(plan.steps, new Set(read.keys()))].map(id => [id, {}] as [string, PresentRead])]);
  const stepOf = new Map(plan.steps.map(step => [step.id, step]));
  /** What each row read as the loop reached it, by step id, so a row the checks corrected after the loop is said
   * again rather than standing in the log on that computer as it first read. */
  const said = new Map<string, string>();
  const tools = await installTools(
    machine,
    plan.steps,
    (_which, detail) => {
      if (detail !== undefined) stage(detail, at());
    },
    "installing-tools",
    {
      present: new Set(present.keys()),
      caches: "keep",
      path: plan.path,
      ...(plan.prefix !== undefined ? { prefix: plan.prefix } : {}),
      onTool: result => {
        const row = rowOf(result, present, stepOf.get(result.id));
        said.set(result.id, rowLine(row));
        done++;
        stage(rowLine(row), at(), row);
      },
    },
  );
  // The rows the job answers with are read once the loop's own checks have run: a row whose install exited 0 and
  // whose check then failed is failed, and copying it at the moment the loop said it left the answer reading
  // installed while the loop's tally read it failed. The record takes this array whole when the job is done.
  for (const result of tools.tools) {
    const row = rowOf(result, present, stepOf.get(result.id));
    rows.push(row);
    if (said.get(result.id) !== rowLine(row)) stage(rowLine(row));
  }
  let skippedFiles: SkippedPath[] = [];
  /** What this run itself landed in the agents' homes there, so a server already in a file that arrived whole with
   * it reads as a server it put there. Whose each key in those files is comes off the list beside the job. */
  let landedNow: OwnedPaths = new Map();
  if (plan.files !== undefined) {
    const files = plan.files;
    stage(`${FILES_LABEL}: ${plural(files.lands.length, "path")}`, round(FILES_LABEL));
    const landed = await provisionFiles(machine, { home: on.home, lands: files.lands, pack: files.pack, say: line => stage(line, round(FILES_LABEL)) });
    skippedFiles = landed.skipped;
    // The document on that computer names these too, but the person reads the job: a server left out of the copy
    // says why here, as the image's build says it.
    for (const s of landed.skipped) stage(provisionSkippedLine(s.path, s.note), round(FILES_LABEL));
    landedNow = landed.owned;
    for (const row of landed.rows) say(row, round(FILES_LABEL));
    done++;
  }
  if (plan.mcp !== undefined) {
    stage(`${MCP_LABEL}: ${plural(plan.mcp.agents.length, "agent")}`, round(MCP_LABEL));
    const servers = await provisionMcp(machine, plan.mcp, {
      home: on.home,
      landed: landedNow,
      tools: tools.tools,
      path: plan.path,
      stage: (_which, detail) => {
        if (detail !== undefined) stage(detail, round(MCP_LABEL));
      },
    });
    stage(provisionServersLine(servers.filter(r => r.outcome === "installed").length, servers.length), round(MCP_LABEL));
    for (const row of servers) say(row, round(MCP_LABEL));
    done++;
  }
  // What wsp owns in the agents' homes there, written down once the servers are in their configs, so the next run
  // knows its own copy from a file the person has written since and the tree that travelled is gone from the box.
  // Every job closes, whether or not this recipe carries a file of the person's: the close is also where the job's
  // own folder there is swept, and a recipe with no files leaves the list exactly as it was.
  await closeAgentFiles(machine, on.home, oncePathsOf(plan.files?.lands ?? []));
  // After everything, so the document on the computer names what did not land. The floor's rows ride with the
  // tools: what a person reads there is what the recipe asked for and what is missing, floor rows included.
  const result: ImportResult = {
    recipeHash: "",
    base: base.tools,
    tools: tools.tools,
    agents: [],
    ...(plan.files !== undefined ? { files: { bytes: 0, skipped: skippedFiles } } : {}),
  };
  // No shell is opened on a computer somebody owns: its root home is the one every workspace there writes, so a
  // profile or rc file under it is a file a workspace wrote and a login shell would run it as that computer's root.
  const context = await applyMachineContext(machine, { result, path: plan.path, shells: "none" });
  stage(`machine context: ${context.summary}`);
  return rows;
}
