// SPDX-License-Identifier: AGPL-3.0-only
// Puts the MCP server into a local agent's config and the wsp skill into its
// skills folder, under the person's home. This file decides the one command
// that runs this same wsp against this state file; the catalog entry's own
// config module says where it goes and in what format.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS, MCP_AGENT_IDS, configSum, skillsDirOf, type AgentEntry, type McpAgent, type Placed } from "@wsp/catalog";
import { writeConfigHere } from "@wsp/engine";
import { tilde } from "@wsp/collect";
import { MCP_SERVER_NAME, mcpServerCommandLine, nextInsideAgentLine, type McpServerSpec } from "@wsp/protocol";
import { placeSections, removeSections } from "./agents-md.js";
import { SKILL_NAME, WSP_SKILL } from "./skill.js";
import { VERSION } from "./version.js";

/** The name the server has in every agent's config; the protocol's, since the runtime builds a launch that carries
 * the same server for a turn on a machine. */
export { MCP_SERVER_NAME };

/** The package `npx` fetches wsp from. */
const NPM_PACKAGE = "@zingzy/wsp";

/** The folder under npm's cache where npx keeps what it ran; a path through it dies with a cache sweep. */
const NPX_CACHE_DIR = "_npx";

/** What the install reads of the process it runs in, to say how an agent starts this same wsp again. */
export interface RunningWsp {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  version: string;
  PATH: string | undefined;
  /** The shim this process runs behind, when it does: the desktop's bundled command sits inside the app bundle,
   * which moves, so an agent's config runs the shim the app wrote instead. */
  shim?: string;
}

export const runningWsp = (): RunningWsp => ({ execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, version: VERSION, PATH: process.env.PATH });

/** This computer's own path, without the folders the caller's launcher made for itself. A harness that starts a
 * process puts wrappers of its own, under a temp folder, first on its path; those wrappers dial back into that
 * harness, and one asked for its version by a stand-in machine's catalog probe never answered (measured 2026-09-13,
 * two of them left running for nine minutes). A command a machine runs is one this computer has, not one this
 * process happened to be handed. */
export function thisComputersPath(PATH: string | undefined = process.env.PATH, temps: readonly string[] = [tmpdir(), "/tmp"]): string {
  return (PATH ?? "")
    .split(delimiter)
    .filter(dir => dir !== "" && !temps.some(temp => dir === temp || dir.startsWith(`${temp}/`)))
    .join(delimiter);
}

/** The command a shell would run from PATH: the first folder that holds one. */
export function onPath(bin: string, PATH: string | undefined): string | undefined {
  return (PATH ?? "")
    .split(delimiter)
    .filter(dir => dir !== "")
    .map(dir => join(dir, bin))
    .find(file => existsSync(file));
}

/** The agents this computer has, in catalog order: the ones whose own command a shell would find on PATH. What an
 * install takes when nobody named one and there is no terminal to ask at. */
export function agentsOnPath(PATH: string | undefined): string[] {
  return CATALOG_AGENTS.filter(a => onPath(a.bin, PATH) !== undefined).map(a => a.id);
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The npx that ships beside this node, so the agent's shorter PATH (a GUI launch has less than a shell) never
 * matters; the bare word only when none sits there. */
function npxBeside(execPath: string): string {
  const beside = join(dirname(execPath), "npx");
  return existsSync(beside) ? beside : "npx";
}

/** How this same wsp is started again, the one rule every road that has to say it reads: an agent's own config, and
 * the host a verb brings up for itself. Run out of npx's cache, the command is npx with this version pinned: the
 * cache path goes with a sweep or a version bump, and the pin brings the same wsp back. Run behind the desktop's
 * shim, the command is that shim. Run as the wsp on PATH, the command is that binary. Any other start (a checkout,
 * a bin folder PATH does not hold) is this node with the flags and script it was given. */
export function wspCommand(run: RunningWsp): McpServerSpec {
  if (run.shim !== undefined) return { command: run.shim, args: [] };
  const script = run.argv[1];
  if (script !== undefined && script.split(sep).includes(NPX_CACHE_DIR)) return { command: npxBeside(run.execPath), args: ["-y", `${NPM_PACKAGE}@${run.version}`] };
  const wsp = onPath("wsp", run.PATH);
  if (script !== undefined && wsp !== undefined && sameFile(script, wsp)) return { command: wsp, args: [] };
  return { command: run.execPath, args: [...run.execArgv, script ?? "wsp"] };
}

/** The line that starts this same wsp on its stdio tool server, for an agent's own config. */
export function mcpServerCommand(run: RunningWsp): McpServerSpec {
  const wsp = wspCommand(run);
  return { command: wsp.command, args: [...wsp.args, "mcp"] };
}

/** The server every agent's config gets: the command that runs this same wsp, then `--state <path>`, so the
 * agent's own cwd never picks another state file. Against a host on another computer it is `--host <alias>`
 * instead: that host serves its own state, and a path on this computer would name a file the line never reads. */
export function mcpServerSpec(statePath: string, run: RunningWsp = runningWsp(), opts: { host?: string } = {}): McpServerSpec {
  const wsp = mcpServerCommand(run);
  return { command: wsp.command, args: [...wsp.args, ...(opts.host !== undefined ? ["--host", opts.host] : ["--state", statePath])] };
}

export interface Installed {
  agent: string;
  /** `~/`-relative; absent when the catalog knows no MCP config for the agent yet, and then nothing was written. */
  path?: string;
  /** The skill's file, `~/`-relative. */
  skill: string;
  /** The project's own instruction files the wsp section now sits in, absolute; absent when no project was named. */
  docs?: string[];
}

/** The config the server goes into under `home`: the first of the agent's files that exists, else the first. */
export function mcpConfigFile(agent: McpAgent, home: string): { tilde: string; abs: string } {
  const files = agent.mcp.files.map(f => ({ tilde: f, abs: join(home, f.slice(2)) }));
  return files.find(f => existsSync(f.abs)) ?? files[0]!;
}

/** The skill's file under `home`, in the agent's skills folder. */
export function skillFile(agent: AgentEntry, home: string): { tilde: string; abs: string } {
  const tilde = `${skillsDirOf(agent)}/${SKILL_NAME}/SKILL.md`;
  return { tilde, abs: join(home, tilde.slice(2)) };
}

/** Writes the skill into the agent's skills folder under `home`, replacing an earlier copy. */
function installSkill(agent: AgentEntry, home: string): string {
  const file = skillFile(agent, home);
  mkdirSync(dirname(file.abs), { recursive: true });
  writeFileSync(file.abs, WSP_SKILL);
  return file.tilde;
}

/** Brings every skill copy already on this computer up to this wsp's, and writes none where there is none: a copy
 * an install wrote once falls behind the binary at the next release, and an agent reading the old words calls a
 * verb that is gone. Answers the files it rewrote, `~/`-relative. An agent that never took the skill is left alone,
 * since writing one uninvited puts wsp in a folder nobody asked it into. */
export function refreshSkills(home: string): string[] {
  const written: string[] = [];
  for (const agent of CATALOG_AGENTS) {
    const file = skillFile(agent, home);
    try {
      if (readFileSync(file.abs, "utf8") === WSP_SKILL) continue;
    } catch {
      continue;
    }
    writeFileSync(file.abs, WSP_SKILL);
    written.push(file.tilde);
  }
  return written;
}

/** The one line a refresh says, and only where it rewrote something: the files, so a person reading it knows
 * exactly what changed under their home, said once rather than once per agent. */
export const skillsRefreshedLine = (files: readonly string[]): string => `The wsp skill now matches this wsp in ${files.join(", ")}`;

/** The catalog's agent under this id; an id it does not know is refused with the ids that do have an MCP config. */
function agentEntry(agentId: string): AgentEntry {
  const entry = CATALOG_AGENTS.find(a => a.id === agentId);
  if (entry === undefined) throw new Error(`no agent ${agentId} in the catalog; agents with an MCP config: ${MCP_AGENT_IDS}`);
  return entry;
}

/** Writes the server into the agent's config under `home`, created with its folder when it is not there, the skill
 * into its skills folder, and with a project named, the wsp section into that project's own instruction files. Says
 * which agent and which files. */
export function installMcp(agentId: string, server: McpServerSpec, home: string, project?: string): Installed {
  const entry = agentEntry(agentId);
  const landed = (): Pick<Installed, "skill" | "docs"> => {
    const skill = installSkill(entry, home);
    return { skill, ...(project === undefined ? {} : { docs: placeSections(entry, project) }) };
  };
  const agent = MCP_AGENTS.find(a => a.id === agentId);
  if (agent === undefined) return { agent: entry.name, ...landed() };
  const file = mcpConfigFile(agent, home);
  const was = existsSync(file.abs) ? readFileSync(file.abs) : undefined;
  let placed: Placed;
  try {
    placed = agent.mcp.format.place(was?.toString("utf8"), MCP_SERVER_NAME, { kind: "stdio", command: server.command, args: [...server.args], env: {} });
  } catch (e) {
    throw new Error(`${file.tilde}: ${e instanceof Error ? e.message : String(e)}`);
  }
  writeConfigHere(file.abs, home, was === undefined ? undefined : configSum(was), placed.text, p => tilde(home, p));
  return { agent: entry.name, path: file.tilde, ...landed() };
}

/** One agent as `--remove` leaves it: the project's instruction files the wsp section came out of, absolute, empty
 * when none of them held one. The agent's own config and the skill are not touched. */
export interface Removed {
  agent: string;
  docs: string[];
}

/** Takes the wsp section out of the agent's instruction files under `project`. */
export function removeMcp(agentId: string, project: string): Removed {
  const entry = agentEntry(agentId);
  return { agent: entry.name, docs: removeSections(entry, project) };
}

/** One `wsp mcp install` as a machine reads it: every agent that took the server or the skill under the catalog id
 * it was asked for, and every one that took neither with the reason, so a caller naming several is not left
 * guessing which of them landed. */
export interface InstallReport {
  /** The command every written config now runs. */
  server: McpServerSpec;
  installed: Array<Installed & { id: string }>;
  failures: Array<{ id: string; error: string }>;
}

/** One `wsp mcp install --remove` as a machine reads it. */
export interface RemoveReport {
  removed: Array<Removed & { id: string }>;
  failures: Array<{ id: string; error: string }>;
}

/** Runs one road per agent in turn and keeps going past one that fails: an id the catalog does not know must not
 * cost the agents named beside it. */
function eachAgent<T>(agentIds: Iterable<string>, road: (id: string) => T): { done: Array<T & { id: string }>; failures: Array<{ id: string; error: string }> } {
  const done: Array<T & { id: string }> = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of agentIds) {
    try {
      done.push({ id, ...road(id) });
    } catch (e) {
      failures.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { done, failures };
}

/** Installs for each agent in turn: the server, the skill, and with a project named, the section in its own
 * instruction files. */
export function installEach(agentIds: Iterable<string>, server: McpServerSpec, home: string, project?: string): InstallReport {
  const { done, failures } = eachAgent(agentIds, id => installMcp(id, server, home, project));
  return { server, installed: done, failures };
}

/** Takes the wsp section out of each agent's instruction files under `project`; nothing else of an install goes. */
export function removeEach(agentIds: Iterable<string>, project: string): RemoveReport {
  const { done, failures } = eachAgent(agentIds, id => removeMcp(id, project));
  return { removed: done, failures };
}

/** What an install says, for the command and the wizard alike: the agent and its file, or the by-hand line when the
 * catalog knows no config and the server was not written; last, where the skill went. */
export function installLines(placed: Installed): string[] {
  const lines = placed.path === undefined ? [`${placed.agent}: the catalog has no MCP config for it yet, so the server was not written; add it by hand.`] : [`${placed.agent} now has the wsp tools: ${placed.path}`];
  lines.push(`The wsp skill went to ${placed.skill}`);
  if (placed.docs !== undefined && placed.docs.length > 0) lines.push(`The wsp section is in ${placed.docs.join(" and ")}`);
  return lines;
}

/** What a `--remove` says for one agent: the files the section came out of, or that none of them held one. */
export function removeLines(removed: Removed): string[] {
  return removed.docs.length === 0
    ? [`${removed.agent}: no wsp section in this folder; nothing was changed.`]
    : [`${removed.agent}: the wsp section is out of ${removed.docs.join(" and ")}`];
}

/** The line after every agent's own: the command their configs now run, once; none when no config took the server. */
export function registeredLine(report: InstallReport): string | undefined {
  return report.installed.some(p => p.path !== undefined) ? mcpServerCommandLine(report.server.command, report.server.args) : undefined;
}

/** The last line an install prints: what to do next inside the first agent that took it, which is where the work
 * happens from here. None when no agent took anything. */
export function nextLine(report: InstallReport): string | undefined {
  const first = report.installed[0];
  if (first === undefined) return undefined;
  const entry = agentEntry(first.id);
  return nextInsideAgentLine(entry.bin, entry.firstMove);
}
