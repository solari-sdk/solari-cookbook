// SPDX-License-Identifier: AGPL-3.0-only
// The MCP stage on the builder. The definitions themselves arrive inside each
// agent's config file with that agent's row, secrets included, so nothing here
// carries a definition: the plan names which servers stay, which come out and
// why, and the prefixes that read differently on the machine. The files are
// read off the machine, edited here by the catalog format's own module, and the
// bytes land back; the machine runs nothing of its own for it.
import { randomBytes } from "node:crypto";
import { BREW_PREFIX, GUEST_HOME, MAC_BIN_DIRS, MAC_BREW, configLanding, configRefusal, configSum, configWriteLine } from "@wsp/catalog";
import type { McpEditLib, McpEditResult, McpFormat, McpMergeResult } from "@wsp/catalog";
import { MCP_ID_PREFIX, shellQuote } from "@wsp/protocol";
import { TOOLS_PATH, UV_INSTALL, WITHHELD_NOTE, withheld, type RecipeEntry } from "./golden-import.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { landBytes } from "./land-bytes.js";
import { type ToolResult, closing, freeNote, guardDeadlineMs, guardedRoad, reasonOf, roadLimitS } from "./golden-tools.js";
import type { ExecResult, Machine } from "./machine.js";
import type { StageListener } from "./golden.js";

const MCP_REMOTE_ID = `${MCP_ID_PREFIX}mcp-remote`;

export interface McpAgentSource {
  label: string;
  format: McpFormat;
  /** Absolute paths on the guest; the first that exists is the config. */
  files: string[];
}

export interface McpScope {
  files: string[];
  format: McpFormat;
  /** Claude Code's servers local to the laptop's home folder move under the machine's home. */
  project?: { from: string; to: string };
  keep: string[];
  drop: { name: string; reason: string }[];
}

export interface McpAgentPlan {
  id: string;
  label: string;
  scopes: McpScope[];
  /** Rows that never reach the machine: the agent itself is not ticked, so its config did not travel. */
  aside: { id: string; name: string; reason: string }[];
}

export interface McpPlan {
  agents: McpAgentPlan[];
  guestHome: string;
  /** Laptop prefixes and what they read as on the machine, tried in order on every string of a kept definition. */
  rewrites: [string, string][];
  /** Directories whose binaries the machine finds on PATH by name; a command right under one becomes its name. */
  binDirs: string[];
  /** The recipe's tool rows that install one binary each, with their tick: a server whose command is not on the machine names the row that would have brought it. */
  tools: McpToolRow[];
}

export interface McpToolRow {
  id: string;
  ticked: boolean;
  reason?: string;
}

export interface McpPlanOptions {
  home: string;
  guestHome?: string;
  agents: Record<string, McpAgentSource>;
  /** Absolute bin directories the machine's PATH covers by name, the collector's list; ~/.local/bin is added here. */
  binDirs?: readonly string[];
}

/** `fetched-on-first-use`: the definition is in place, but its package comes down when the agent first starts it (npx, uv). */
export interface McpResult {
  id: string;
  agent: string;
  name: string;
  outcome: "installed" | "fetched-on-first-use" | "skipped";
  note?: string;
}

/** Rows whose last id segment is the binary they put on PATH; taps, casks and the toolchain install none. */
const BINARY_ROW = /^tools\/(brew|go|cargo|npm|pnpm|bun|pipx|uv|hand)\//;

/** One server's row id: the agent it belongs to, whether its scope is the person's home folder, and its name. The
 * one spelling, read by the plan that edits the configs and by every caller that sets a server aside without one. */
export const mcpRowId = (agent: string, home: boolean, name: string): string => `${MCP_ID_PREFIX}${agent}/${home ? "home/" : ""}${name}`;

/** A row's agent, scope and server name from its id: `agents/mcp/<agent>/<name>`, or `agents/mcp/<agent>/home/<name>`;
 * nothing for a row that is not a server, the mcp-remote row included. */
export function parseMcpId(id: string): { agent: string; home: boolean; name: string } | undefined {
  if (!id.startsWith(MCP_ID_PREFIX) || id === MCP_REMOTE_ID) return undefined;
  const rest = id.slice(MCP_ID_PREFIX.length).split("/");
  const agent = rest[0];
  if (agent === undefined || rest.length < 2) return undefined;
  const home = rest.length === 3 && rest[1] === "home";
  return { agent, home, name: home ? rest[2]! : rest.slice(1).join("/") };
}

/** The plan from every row of the recipe with its tick: ticked servers stay, unticked ones come out with the
 * row's own reason, a ticked server whose secret was not answered copy comes out too, and an agent that is not
 * ticked has its servers set aside. Nothing when no row is a server. */
export function mcpPlanFor(rows: readonly RecipeEntry[], opts: McpPlanOptions): McpPlan | undefined {
  const guestHome = opts.guestHome ?? GUEST_HOME;
  const ticked = new Set(rows.filter(e => e.bring === true).map(e => e.id));
  const agents: McpAgentPlan[] = [];
  for (const [agent, source] of Object.entries(opts.agents)) {
    const own = rows.flatMap(e => {
      const p = parseMcpId(e.id);
      return p !== undefined && p.agent === agent ? [{ row: e, home: p.home, name: p.name }] : [];
    });
    if (own.length === 0) continue;
    if (!ticked.has(`agents/${agent}`)) {
      agents.push({ id: agent, label: source.label, scopes: [], aside: own.map(o => ({ id: o.row.id, name: o.name, reason: `${source.label} is not ticked, so its config did not travel` })) });
      continue;
    }
    const scopes: McpScope[] = [];
    for (const home of [false, true]) {
      const rows = own.filter(o => o.home === home);
      if (rows.length === 0) continue;
      scopes.push({
        files: source.files,
        format: source.format,
        ...(home ? { project: { from: opts.home, to: guestHome } } : {}),
        keep: rows.filter(o => ticked.has(o.row.id) && !withheld(o.row)).map(o => o.name),
        drop: rows.filter(o => !ticked.has(o.row.id) || withheld(o.row)).map(o => ({ name: o.name, reason: !ticked.has(o.row.id) ? (o.row.reason ?? "unticked") : WITHHELD_NOTE })),
      });
    }
    agents.push({ id: agent, label: source.label, scopes, aside: [] });
  }
  if (agents.length === 0) return undefined;
  return {
    agents,
    guestHome,
    rewrites: [[`${opts.home}/`, `${guestHome}/`], [`${MAC_BREW}/`, `${BREW_PREFIX}/`]],
    binDirs: [`${opts.home}/.local/bin/`, "~/.local/bin/", ...(opts.binDirs ?? MAC_BIN_DIRS)],
    tools: rows.filter(e => e.rung === "tools" && BINARY_ROW.test(e.id)).map(e => ({ id: e.id, ticked: e.bring === true, ...(e.reason !== undefined ? { reason: e.reason } : {}) })),
  };
}

// --- the files, off the machine and back ------------------------------------------

/** How long the read of every config off the machine may take. */
export const READ_MS = 120_000;
/** What each config's line starts with, so no text of a person's own can be read as the run's own words. */
export const MCP_READ_MARK = "wsp-mcp";

/** A call the machine never ran (refused by the provider, lost while it napped) reads as a failed one with the
 * error's words, so the stage names it on every server and the build goes on. */
export const refused = (e: unknown): ExecResult => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });

/** Why the read did not answer, worded without a line of its output. That output is every config whole, and this
 * sentence is every skipped server's note, the stage line, the run log and the saved result: a read that stopped
 * says so by what it exited with. A machine that refused the call still says its own words, which are on stderr. */
export const readFailed = (res: ExecResult): string => `the config edit did not run (${reasonOf({ ...res, stdout: "" }, READ_MS / 1000)})`;

/** One run reads every scope's config: the first of the scope's files that exists, base64 on one line, under the
 * scope's place in the plan and the file's place in the scope. */
export function readConfigsCmd(scopes: readonly { files: readonly string[] }[]): string {
  return [
    "wsp_mcp_read() {",
    '  i="$1"; shift; n=0',
    '  for f in "$@"; do',
    `    if [ -f "$f" ]; then printf '${MCP_READ_MARK} %s %s ' "$i" "$n"; base64 < "$f" | tr -d '\\n'; printf '\\n'; return 0; fi`,
    "    n=$((n+1))",
    "  done",
    `  printf '${MCP_READ_MARK} %s - -\\n' "$i"`,
    "}",
    ...scopes.map((s, i) => `wsp_mcp_read ${i} ${s.files.map(shellQuote).join(" ")}`),
  ].join("\n");
}

/** The config one scope points at, as it stands on the machine; nothing when none of the scope's files is there. */
export interface ScopeFile {
  path: string;
  text: string;
  /** The file's checksum as read, which the write compares the file with before it goes over it. */
  sum: string;
}

/** What the read printed, one entry per scope in plan order; nothing when not one line carried the mark, since the
 * read says something about every scope it was given and a run that says nothing did not run. An empty file prints
 * three words and is a file that is there and holds nothing, never a scope with no config on the machine. */
export function parseConfigs(stdout: string, scopes: readonly { files: readonly string[] }[]): (ScopeFile | undefined)[] | undefined {
  const out: (ScopeFile | undefined)[] = scopes.map(() => undefined);
  let answered = false;
  for (const line of stdout.split("\n")) {
    const words = line.trim().split(" ");
    if (words[0] !== MCP_READ_MARK || words.length < 3) continue;
    answered = true;
    const path = scopes[Number(words[1])]?.files[Number(words[2])];
    if (path === undefined) continue;
    const bytes = Buffer.from(words[3] ?? "", "base64");
    out[Number(words[1])] = { path, text: bytes.toString("utf8"), sum: configSum(bytes) };
  }
  return answered ? out : undefined;
}

/** A kept definition's string as the machine reads it: a command right under a bin directory becomes its bare name,
 * and a laptop prefix becomes what it stands for there, a flag's `--name=` left in front of it. */
export function rewriteString(plan: McpPlan, s: string, command: boolean): string {
  if (command) for (const d of plan.binDirs) if (s.startsWith(d) && !s.slice(d.length).includes("/")) return s.slice(d.length);
  const flag = /^--?[\w-]+=/.exec(s);
  const head = flag !== null ? flag[0] : "";
  const body = s.slice(head.length);
  for (const [from, to] of plan.rewrites) if (body.startsWith(from)) return head + to + body.slice(from.length);
  return s;
}

/** A per-name outcome either road answers with, as the rows and the words read it: the one word they read is
 * `missing`, a name the copy that travelled does not define. */
export interface EditedName {
  name: string;
  outcome: McpEditResult["outcome"] | McpMergeResult["outcome"];
  /** The kept server's command as the machine will run it. */
  command?: string;
}

/** What one scope's config came to: the file the edit ran over, why it did not run, and what became of each name. */
export interface ScopeOutcome {
  file: string | null;
  error?: string;
  results: EditedName[];
}

/** Every scope edited in plan order, each on its file's text as the scopes before it left it: two scopes of one
 * agent share a file, and the second reads what the first wrote. The texts are what the machine should end with. */
function editScopes(plan: McpPlan, agents: readonly McpAgentPlan[], read: readonly (ScopeFile | undefined)[]): { outcomes: ScopeOutcome[]; texts: Map<string, string> } {
  const lib: McpEditLib = { rewriteString: (s, command) => rewriteString(plan, s, command) };
  const texts = new Map(read.flatMap(f => (f === undefined ? [] : [[f.path, f.text] as const])));
  const outcomes: ScopeOutcome[] = [];
  let at = 0;
  for (const agent of agents) {
    for (const scope of agent.scopes) {
      const file = read[at++];
      if (file === undefined) {
        outcomes.push({ file: null, results: [] });
        continue;
      }
      try {
        const edited = scope.format.edit(lib, { keep: scope.keep, drop: scope.drop.map(d => d.name), ...(scope.project !== undefined ? { project: scope.project } : {}) }, texts.get(file.path)!);
        texts.set(file.path, edited.text);
        outcomes.push({ file: file.path, results: edited.results });
      } catch (e) {
        outcomes.push({ file: file.path, error: e instanceof Error ? e.message : String(e), results: [] });
      }
    }
  }
  return { outcomes, texts };
}

/** Puts every config the edit changed back on the machine, each by the one config write inside `base`, from a
 * landing beside it; the words when one of them did not land. A landing the write never took is swept: it holds the
 * whole config at the upload road's own mode, and the machine it sits on may be about to be sealed into an image. */
export async function landConfigs(machine: Machine, base: string, read: readonly (ScopeFile | undefined)[], texts: ReadonlyMap<string, string>): Promise<string | undefined> {
  const was = new Map(read.flatMap(f => (f === undefined ? [] : [[f.path, f] as const])));
  const changed = [...texts].filter(([path, text]) => was.get(path)?.text !== text).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text), landing: configLanding(path, randomBytes(6).toString("hex")) }));
  if (changed.length === 0) return undefined;
  const swept = async (why: string): Promise<string> => {
    await machine.exec(`rm -f ${changed.map(c => shellQuote(c.landing)).join(" ")}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => undefined);
    return `the edited config did not land (${why})`;
  };
  try {
    for (const c of changed) await landBytes(machine, c.landing, c.bytes, { timeoutMs: READ_MS });
  } catch (e) {
    return swept(e instanceof Error ? e.message : String(e));
  }
  // Each write in a subshell of its own, so its exit and its trap are its own and the first refusal stops the rest.
  const line = changed.map(c => `(\n${configWriteLine({ file: c.path, base, bytes: c.bytes.length, from: c.landing, ...(was.has(c.path) ? { sum: was.get(c.path)!.sum } : {}) })}\n) || exit $?`).join("\n");
  const res = await machine.exec(line, { timeoutMs: INLINE_EXEC_MS }).catch(refused);
  if (res.exitCode === 0) return undefined;
  return swept(configRefusal(res, changed[0]!.path, p => p) ?? reasonOf(res, INLINE_EXEC_MS / 1000));
}

interface Pending extends McpResult {
  /** The command as the machine will run it; absent for a remote server or a skipped row. */
  command?: string;
  /** Full sentences for the saved result. */
  notes: string[];
  /** The summary's words, one per note. */
  shorts: string[];
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
/** Runners that pull the server's package down when the agent first starts it: the definition is in place, the package is not. */
export const FETCHERS: Record<string, string> = { npx: "npx", uvx: "uv", uv: "uv" };

/** The servers that were already there by name, then the ones installed; then, per distinct wording, the servers
 * whose package is fetched on first use or whose runner was installed or is missing; then each skipped server with
 * its reason. `present` is the rows the round read as already there, and a server in it is said that way and no
 * other, so these words never read installed one line above a row reading present. */
function summarize(rows: readonly Pending[], present: ReadonlySet<string>): string {
  const parts: string[] = [];
  const already = rows.filter(r => present.has(r.id));
  if (already.length > 0) parts.push(`${already.map(r => r.name).join(", ")} already there`);
  const installed = rows.filter(r => r.outcome === "installed" && r.shorts.length === 0 && !present.has(r.id));
  if (installed.length > 0) parts.push(`${installed.map(r => r.name).join(", ")} installed`);
  const byNote = new Map<string, string[]>();
  for (const r of rows) {
    if (r.outcome === "skipped" || r.shorts.length === 0 || present.has(r.id)) continue;
    const key = r.shorts.join(", ");
    (byNote.get(key) ?? byNote.set(key, []).get(key)!).push(r.name);
  }
  for (const [short, names] of byNote) parts.push(`${names.join(", ")}: ${short}`);
  for (const r of rows) if (r.outcome === "skipped") parts.push(`${r.name} skipped (${r.notes[0] ?? "no reason given"})`);
  return parts.length > 0 ? parts.join("; ") : "nothing to do";
}

/** The servers by outcome for the stage's end line, `11 installed, 9 skipped, 2 on first use`, the zero counts left
 * out; nothing when the plan named no server. */
export function mcpTally(rows: readonly McpResult[]): string | undefined {
  const words: [McpResult["outcome"], string][] = [["installed", "installed"], ["skipped", "skipped"], ["fetched-on-first-use", "on first use"]];
  const said = words.flatMap(([outcome, word]) => {
    const n = rows.filter(r => r.outcome === outcome).length;
    return n > 0 ? [`${n} ${word}`] : [];
  });
  return said.length > 0 ? said.join(", ") : undefined;
}

const strip = (r: Pending): McpResult => ({ id: r.id, agent: r.agent, name: r.name, outcome: r.outcome, ...(r.notes.length > 0 ? { note: r.notes.join("; ") } : {}) });

const tail = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/** Why a server whose command the machine does not have is skipped: when the recipe has a tool row for that
 * binary, what became of the row. */
export function absentReason(command: string, plan: McpPlan, tools: readonly ToolResult[]): string {
  const base = "command not on the machine";
  const row = plan.tools.find(t => tail(t.id) === basename(command));
  if (row === undefined) return base;
  if (!row.ticked) return `${base}; ${row.id} was not ticked${row.reason !== undefined ? ` (${row.reason})` : ""}`;
  const result = tools.find(t => t.id === row.id);
  if (result?.outcome === "skipped" || result?.outcome === "failed") return `${base}; ${row.id} ${result.outcome === "failed" ? "failed" : "was skipped"}${result.note !== undefined ? ` (${result.note})` : ""}`;
  return `${base}; ${row.id} was ticked, but nothing by that name is on PATH`;
}

/** A command as the machine will run it: what the person's own home spells as a tilde is the machine's home. */
export const asRun = (plan: McpPlan, command: string): string => (command.startsWith("~/") ? `${plan.guestHome}${command.slice(1)}` : command);

/** Which commands of a plan's kept servers the machine does not have on its tools PATH, asked in one call; none
 * when no kept server names a command, and none when the call itself did not answer. */
export async function absentCommands(machine: Machine, plan: McpPlan, read: readonly ScopeOutcome[], path: string = TOOLS_PATH): Promise<string[]> {
  const commands = [...new Set(read.flatMap(s => s.results.flatMap(r => (r.command !== undefined ? [asRun(plan, r.command)] : []))))];
  if (commands.length === 0) return [];
  const check = await machine
    .exec(`export PATH=${path}\n${commands.map(c => `if command -v ${shellQuote(c)} >/dev/null 2>&1; then echo ${shellQuote(`ok ${c}`)}; else echo ${shellQuote(`no ${c}`)}; fi`).join("\n")}`, { timeoutMs: INLINE_EXEC_MS })
    .catch(refused);
  return check.stdout
    .split("\n")
    .filter(line => line.startsWith("no "))
    .map(line => line.slice(3));
}

/** The agents with every kept server whose command is neither on the machine nor fetched on first use moved to
 * the drops, with its reason. */
export function withoutAbsent(plan: McpPlan, agents: readonly McpAgentPlan[], read: readonly ScopeOutcome[], missing: ReadonlySet<string>, tools: readonly ToolResult[]): McpAgentPlan[] {
  let at = 0;
  return agents.map(agent => ({
    ...agent,
    scopes: agent.scopes.map(scope => {
      const results = read[at++]?.results ?? [];
      const commandOf = (name: string): string | undefined => results.find(r => r.name === name)?.command;
      const absent = scope.keep.filter(name => {
        const command = commandOf(name);
        return command !== undefined && FETCHERS[basename(command)] === undefined && missing.has(asRun(plan, command));
      });
      if (absent.length === 0) return scope;
      return { ...scope, keep: scope.keep.filter(name => !absent.includes(name)), drop: [...scope.drop, ...absent.map(name => ({ name, reason: absentReason(commandOf(name)!, plan, tools) }))] };
    }),
  }));
}

/** The count line a servers round opens with: each agent and how many servers of its the plan names. */
export const mcpOpening = (agents: readonly McpAgentPlan[]): string =>
  agents.map(a => `${a.label} ${a.scopes.reduce((n, s) => n + s.keep.length + s.drop.length, 0) + a.aside.length}`).join(", ");

/** Every server of a plan as a row, and the words a person reads for them, whichever road wrote the configs: one
 * row per kept name, per dropped name and per name set aside, uv installed where a kept server runs through it and
 * is missing, each server whose command the machine does not have named on its row, and the closing line. `report`
 * is what became of each scope, in plan order; `failure` is a sentence every kept server is skipped with, for a
 * round that never got its configs off the machine or back onto it; `present` is the rows the caller reads as
 * already there, which the closing words then say the same way. */
export async function mcpRows(
  machine: Machine,
  plan: McpPlan,
  o: { agents: readonly McpAgentPlan[]; report?: readonly ScopeOutcome[]; failure?: string; missing: ReadonlySet<string>; present?: ReadonlySet<string>; stage: StageListener },
): Promise<McpResult[]> {
  const { agents, report, failure, missing, stage } = o;
  const rows: Pending[] = [];
  let at = 0;
  for (const agent of agents) {
    for (const scope of agent.scopes) {
      const outcome = report?.[at++];
      const id = (name: string): string => mcpRowId(agent.id, scope.project !== undefined, name);
      const skippedKeep =
        failure ?? (outcome === undefined || outcome.file === null ? `${agent.label}'s config is not on the machine` : outcome.error !== undefined ? `${agent.label}'s config on the machine did not parse (${outcome.error})` : undefined);
      for (const name of scope.keep) {
        const r = outcome?.results.find(x => x.name === name);
        if (skippedKeep !== undefined || r === undefined || r.outcome === "missing") {
          rows.push(skipped(id(name), agent.label, name, skippedKeep ?? "not in the config that travelled"));
          continue;
        }
        const fetcher = r.command !== undefined ? FETCHERS[basename(r.command)] : undefined;
        rows.push({
          id: id(name), agent: agent.label, name,
          outcome: fetcher === undefined ? "installed" : "fetched-on-first-use",
          ...(r.command !== undefined ? { command: r.command } : {}),
          notes: fetcher === undefined ? [] : [`${fetcher} fetches the package on first use`],
          shorts: fetcher === undefined ? [] : [`package fetched on first use by ${fetcher}`],
        });
      }
      for (const d of scope.drop) rows.push(skipped(id(d.name), agent.label, d.name, d.reason));
    }
    for (const a of agent.aside) rows.push(skipped(a.id, agent.label, a.name, a.reason));
  }

  const viaUv = rows.filter(r => r.command !== undefined && ["uv", "uvx"].includes(basename(r.command)) && missing.has(asRun(plan, r.command)));
  if (viaUv.length > 0) {
    stage("installing-mcp", `uv for ${viaUv.map(r => r.name).join(", ")}`);
    // uv's catalog row walks the script road, so the road carries the strict shell line and uv's own limit; the stage writes neither.
    const install = await machine.run(guardedRoad("script", UV_INSTALL), { deadlineMs: guardDeadlineMs(roadLimitS("script")), onLine: line => stage("installing-mcp", `uv: ${line}`) }).catch(refused);
    for (const r of viaUv) {
      if (install.exitCode === 0) {
        r.notes.unshift("uv installed for it");
        r.shorts.unshift("uv installed");
      } else {
        const short = `uv did not install (${reasonOf(install, roadLimitS("script"))})`;
        r.shorts.unshift(short);
        r.notes.unshift(`${short}; the server starts once it is installed there`);
      }
    }
  }
  const viaUvNames = new Set(viaUv.map(r => r.id));
  for (const r of rows) {
    if (r.command === undefined || viaUvNames.has(r.id) || !missing.has(asRun(plan, r.command))) continue;
    const short = `${basename(r.command)} is not on the machine`;
    r.shorts.push(short);
    r.notes.push(`${short}; the server starts once it is installed there`);
  }
  stage("installing-mcp", closing(summarize(rows, o.present ?? new Set()), await freeNote(machine).catch(() => undefined)));
  return rows.map(strip);
}

/** Runs the plan on the builder in two edits of the text it read off the machine: the first says each kept server's
 * command as the machine will run it, every command is looked for on the machine's PATH, and the second is what
 * lands, with the servers whose command is neither there nor fetched on first use taken out. uv is installed by its
 * checksummed release when a server runs through it and it is missing. Each server is named on the stage as
 * installed or skipped with its reason; `tools` is what the tools stage did, so a skipped server can name the row
 * that would have brought its command. Nothing here fails the build. */
export async function applyMcp(machine: Machine, plan: McpPlan, stage: StageListener, tools: readonly ToolResult[] = []): Promise<McpResult[]> {
  stage("installing-mcp", mcpOpening(plan.agents));
  const missing = new Set<string>();
  let agents = plan.agents;
  const scopes = plan.agents.flatMap(a => a.scopes);
  // The answer is every config whole, the servers' env and headers with it. No backend the seal runs on carries a
  // byte road out of a machine (a signed download URL is minted by one provider of the several), so the read goes
  // by the road every backend has and says that its output is not a log's.
  const res = await machine.run(readConfigsCmd(scopes), { deadlineMs: READ_MS, unlogged: true }).catch(refused);
  let failure = res.exitCode === 0 ? undefined : readFailed(res);
  let report: ScopeOutcome[] | undefined;
  const files = failure === undefined ? parseConfigs(res.stdout, scopes) : undefined;
  if (files === undefined) failure ??= readFailed(res);
  else {
    const first = editScopes(plan, agents, files);
    for (const command of await absentCommands(machine, plan, first.outcomes)) missing.add(command);
    agents = withoutAbsent(plan, agents, first.outcomes, missing, tools);
    const second = editScopes(plan, agents, files);
    report = second.outcomes;
    failure = await landConfigs(machine, plan.guestHome, files, second.texts);
  }
  return mcpRows(machine, plan, { agents, report, missing, stage, ...(failure !== undefined ? { failure } : {}) });
}

const skipped = (id: string, agent: string, name: string, note: string): Pending => ({ id, agent, name, outcome: "skipped", notes: [note], shorts: [] });
