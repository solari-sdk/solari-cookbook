// SPDX-License-Identifier: AGPL-3.0-only
// The agents report off one target, read through the collector's Host: this
// computer's own, or machineHost over a computer's link, a workspace or a fork,
// every line as the login the computer was added with. Everything is read off
// config and presence: no MCP server is asked, started or knocked on and no
// login file is opened, so a read costs a handful of round trips. A server's
// state is what its tools connect answers, asked apart from the read.
import { userInfo } from "node:os";
import { posix } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS, TOOL_PREFIX, signInRoadOf, versionOf, type AgentEntry, type McpAgent, type McpServer } from "@wsp/catalog";
import { detectSkills, expand, nodeHost, skillRoots, stdioLine, tilde, type Host } from "@wsp/collect";
import { landedServersScript, mcpRowId, NO_DIGEST, parseLandedServers, targetLogin } from "@wsp/engine";
import { MCP_SERVER_NAME, agentVersionWord, controlNameRefusal, hasControlChar, shellQuote, strictVersion, type AgentRow, type AgentSignInState, type AgentsProject, type McpRow } from "@wsp/protocol";
import { projectOf, vaultSignIn, type AgentsOn, type AgentsRead, type AgentsReader } from "@wsp/runtime";
import { machineHost, type MachineHost } from "./machine-host.js";
import { serverTools } from "./server-tools.js";

const READ_MS = 20_000;
/** How long one agent's own version or status command is given where the computer has a timeout command. */
const COMMAND_S = 15;

/** Every place each agent's command answers from on the login PATH, in PATH order and tab-separated, one line per
 * agent; empty where it is not there. */
const WHERE = 'for b; do (IFS=:; for d in $PATH; do [ -f "$d/$b" ] && [ -x "$d/$b" ] && printf "%s\\t" "$d/$b"; done); echo; done';

/** The app a wrapper folder on PATH belongs to, off the folder's name (`cmux-cli-shims`, `mise/shims`); nothing
 * for a folder that is no wrapper's. */
function wrapperApp(path: string): string | undefined {
  const dirs = posix.dirname(path).split("/");
  const dir = dirs.at(-1) ?? "";
  if (!/shims$/.test(dir)) return undefined;
  const app = dir.replace(/-?(cli-)?shims$/, "");
  return (app !== "" ? app : dirs.at(-2))?.replace(/^\./, "");
}

/** Where an agent is installed off every match on PATH: the first that is no wrapper's, and the app whose wrapper
 * answers before it. A wrapper alone leaves no path, since its folder is often a temporary one. */
function installedAt(matches: readonly string[]): { found: boolean; path?: string; via?: string } {
  const real = matches.find(m => wrapperApp(m) === undefined);
  const via = matches[0] === undefined ? undefined : wrapperApp(matches[0]);
  return { found: matches.length > 0, ...(real !== undefined ? { path: real } : {}), ...(via !== undefined ? { via } : {}) };
}
/** Each command run side by side under its own bound, then each one's exit code and output in the order asked. */
const EACH = [
  'd=$(mktemp -d) || exit 1',
  `T=; command -v timeout >/dev/null 2>&1 && T="timeout ${COMMAND_S}"`,
  "i=0",
  'for c; do ( $T sh -c "$c" > "$d/$i" 2>&1 < /dev/null; echo $? > "$d/$i.x" ) & i=$((i+1)); done',
  "wait",
  "i=0",
  "for c; do printf '\\036%s\\037' \"$(cat \"$d/$i.x\" 2>/dev/null)\"; head -c 16384 \"$d/$i\" 2>/dev/null; i=$((i+1)); done",
  'rm -rf "$d"',
  "printf '\\036END\\n'",
].join("\n");

interface Said {
  code: number;
  output: string;
}

/** Each command's exit code and output, run on the target side by side; nothing for any where the run failed. */
async function each(host: Host, commands: readonly string[]): Promise<(Said | undefined)[]> {
  if (commands.length === 0) return [];
  const out = await host.exec.run("sh", ["-c", EACH, "sh", ...commands], { timeoutMs: READ_MS + 5_000 });
  if (out === undefined) return commands.map(() => undefined);
  const records = out.split("\x1e").slice(1, commands.length + 1);
  return commands.map((_, i) => {
    const [code, ...rest] = (records[i] ?? "").split("\x1f");
    return code === undefined || code === "" || !/^\d+$/.test(code) ? undefined : { code: Number(code), output: rest.join("\x1f") };
  });
}

/** The shown form of how a server is reached: its command with every value hidden, or its url's host. */
function transportOf(server: McpServer, home: string): McpRow["transport"] {
  const t = server.transport;
  if (t.kind === "stdio") return { kind: "stdio", line: stdioLine(t, home) };
  try {
    return { kind: "http", host: new URL(t.url).host };
  } catch {
    return { kind: "http", host: "" };
  }
}

/** A server's sign-in off its config alone: a command or a static header needs none, a token read from the
 * environment is the environment's, anything else is unknown until its tools connect answers. */
const authOf = (server: McpServer): McpRow["auth"] =>
  server.transport.kind === "stdio" ? "open" : server.envRefs.length > 0 ? "env-key" : Object.keys(server.transport.headers).length > 0 ? "open" : "unknown";

/** Names the definition sets or reads, never a value. */
const envNamesOf = (server: McpServer): string[] => [...new Set([...(server.transport.kind === "stdio" ? Object.keys(server.transport.env) : []), ...server.envRefs])].sort();

interface Servers {
  rows: McpRow[];
  wsp: Set<string>;
  refused: string[];
}

/** Every server each agent's own file defines, and each project's the read covers; the first of an agent's files that
 * is there is its config, as the agent itself reads it. */
async function serversOf(host: Host, projects: readonly AgentsProject[]): Promise<Servers> {
  const rows: McpRow[] = [];
  const wsp = new Set<string>();
  const refused: string[] = [];
  const firstOf = async (files: readonly string[]): Promise<{ file: string; text: string } | undefined> => {
    const texts = await Promise.all(files.map(f => host.fs.readText(f)));
    const at = texts.findIndex(t => t !== undefined);
    return at < 0 ? undefined : { file: files[at]!, text: texts[at]! };
  };
  const push = (agent: McpAgent, file: string, servers: readonly McpServer[], project?: AgentsProject): void => {
    for (const s of servers) {
      if (hasControlChar(s.name)) {
        const line = controlNameRefusal(tilde(host.home, file));
        if (!refused.includes(line)) refused.push(line);
        continue;
      }
      if (project === undefined && s.name === MCP_SERVER_NAME) wsp.add(agent.id);
      const row: McpRow = {
        agent: agent.id,
        name: s.name,
        scope: project !== undefined ? "project" : s.scope,
        file: tilde(host.home, file),
        transport: transportOf(s, host.home),
        envNames: envNamesOf(s),
        auth: authOf(s),
        enabled: s.disabled !== true,
        ...(project !== undefined ? { project: { ...project, path: tilde(host.home, project.path) } } : {}),
      };
      rows.push(row);
    }
  };
  await Promise.all(
    MCP_AGENTS.map(async agent => {
      const [mine, theirs] = await Promise.all([firstOf(agent.mcp.files.map(f => expand(host, f))), Promise.all(projects.map(p => firstOf((agent.mcp.projectFiles ?? []).map(f => posix.join(p.path, f)))))]);
      const read = (f: { text: string } | undefined, userOnly: boolean): McpServer[] => (f === undefined ? [] : agent.mcp.format.read(f.text, host.home).filter(s => !userOnly || s.scope === "user"));
      if (mine !== undefined) push(agent, mine.file, read(mine, false));
      theirs.forEach((f, i) => f !== undefined && push(agent, f.file, read(f, true), projects[i]));
    }),
  );
  const order = new Map(MCP_AGENTS.map((a, i) => [a.id, i]));
  return { rows: rows.sort((a, b) => order.get(a.agent)! - order.get(b.agent)! || a.scope.localeCompare(b.scope) || (a.project?.name ?? "").localeCompare(b.project?.name ?? "") || a.name.localeCompare(b.name)), wsp, refused };
}

/** What wsp's recipe job put into the agents' files on a computer you own, off the list it keeps beside the job;
 * nothing where the list could not be read, which leaves every row's answer unsaid rather than no. */
async function recipeServers(host: Host): Promise<Set<string> | undefined> {
  const said = await host.exec.run("bash", ["-c", landedServersScript(host.home)], { timeoutMs: READ_MS });
  return said === undefined ? undefined : new Set([...parseLandedServers(said)].filter(([, digest]) => digest !== NO_DIGEST).map(([id]) => id));
}

/** What a box's own report already says, which is read there once per dial and not asked again. */
interface BoxSaid {
  signIns?: Record<string, AgentSignInState>;
  versions?: Record<string, string>;
}

/** The report off one Host. `box` carries what a computer you joined reported, which stands in for the version
 * and sign-in reads; everywhere else each agent's own version flag and status command answer, run side by side. */
export async function readAgents(host: Host, o: { user: string; vault: Readonly<Record<string, string>>; projects?: readonly AgentsProject[]; box?: BoxSaid }): Promise<AgentsRead> {
  const projects = o.projects ?? [];
  const refused: string[] = [];
  const agents: readonly AgentEntry[] = CATALOG_AGENTS;
  const [where, servers, skills, recipe] = await Promise.all([
    host.exec.run("sh", ["-c", WHERE, "sh", ...agents.map(a => a.bin)], { timeoutMs: READ_MS }),
    serversOf(host, projects),
    skillRoots(host, { projects }).then(roots => detectSkills(host, roots)),
    o.box !== undefined ? recipeServers(host) : Promise.resolve(undefined),
  ]);
  if (where === undefined) refused.push("agents: the login PATH could not be read");
  if (o.box !== undefined && recipe === undefined) refused.push("servers: the list of what wsp's recipe put there could not be read");
  const lines = (where ?? "").split("\n");
  const at = new Map(agents.map((a, i) => [a.id, installedAt((lines[i] ?? "").split("\t").filter(m => m !== ""))]));
  const installed = agents.filter(a => at.get(a.id)!.found);
  const box = o.box;
  const [versions, statuses] = await Promise.all([
    box?.versions !== undefined ? Promise.resolve(installed.map(a => box.versions?.[a.id])) : each(host, installed.map(a => `${shellQuote(a.bin)} --version`)).then(r => r.map(s => s?.output.split("\n")[0])),
    box !== undefined ? Promise.resolve([]) : each(host, installed.map(a => a.signIn.status?.typed ?? a.signIn.status?.command ?? "false")),
  ]);
  const rows: AgentRow[] = agents.map(a => {
    const { found, path, via } = at.get(a.id)!;
    const i = installed.indexOf(a);
    const said = i < 0 ? undefined : versions[i];
    const version = said === undefined || said.trim() === "" ? undefined : agentVersionWord(said);
    const status = i < 0 ? undefined : statuses[i];
    const pinned = a.latest === undefined ? undefined : strictVersion(versionOf(a.installRoad) ?? "");
    const signIn: AgentRow["signIn"] =
      box !== undefined
        ? (box.signIns?.[a.id] ?? "unknown")
        : status === undefined
          ? "unknown"
          : a.signIn.status !== undefined && a.signIn.status.signedIn(status.output, status.code)
            ? "signed-in"
            : vaultSignIn(a.id, o.vault);
    return {
      id: a.id,
      name: a.name,
      installed: found,
      ...(version !== undefined ? { version } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      road: !found ? "none" : path === undefined ? "shim" : path.startsWith(`${TOOL_PREFIX}/`) ? "wsp" : "own",
      ...(path !== undefined ? { path: tilde(host.home, path) } : {}),
      ...(via !== undefined ? { via } : {}),
      signIn: !found ? "none" : signIn,
      signInRoad: signInRoadOf(a.signIn),
      wspTools: servers.wsp.has(a.id),
    };
  });
  const serverRows = recipe === undefined ? servers.rows : servers.rows.map(r => (r.scope === "project" ? r : { ...r, inRecipe: recipe.has(mcpRowId(r.agent, r.scope === "home", r.name)) }));
  return {
    home: host.home,
    user: o.user,
    agents: rows,
    skills: skills.skills,
    servers: serverRows,
    refused: [...refused, ...servers.refused, ...skills.refused],
    ...(o.projects !== undefined ? { projects: projects.map(p => ({ ...p, path: tilde(host.home, p.path) })) } : {}),
  };
}

/** The reader the runtime is wired with: this computer's own Host for this computer and a workspace on it, and
 * machineHost for everything else, after one read of who its lines run as. A computer you joined hands a command
 * its stdin, so the variables a started server is given ride there. Each server's tools answer is kept here. */
export function agentsReader(o: {
  vault: () => Readonly<Record<string, string>>;
  here?: () => Host;
  now?: () => number;
  toolsMs?: number;
  log?: (line: string) => void;
  /** The login shell's environment on this computer, which a command server checked here runs with. */
  loginEnv?: () => Promise<Readonly<Record<string, string>>>;
  /** Each agent's newest version by id as this host last read it off its vendor; none leaves every row without one. */
  latest?: () => Promise<Readonly<Record<string, string>>>;
}): AgentsReader & { forget(key: string): void } {
  const kept = serverTools({ now: o.now ?? Date.now, log: o.log ?? (line => console.warn(line)), ...(o.toolsMs !== undefined ? { deadlineMs: o.toolsMs } : {}) });
  const hostOf = async (on: Exclude<AgentsOn, { kind: "here" }>): Promise<{ host: MachineHost; user: string; runAs?: string }> => {
    const login = await targetLogin(on.machine, on.kind === "box" ? on.login : {});
    return { host: machineHost(on.machine, login, on.kind === "box" ? { stdin: true } : { land: on.machine }), user: login.user, ...(login.runAs !== undefined ? { runAs: login.runAs } : {}) };
  };
  const readOn = async (on: AgentsOn): Promise<AgentsRead> => {
    if (on.kind === "here") {
      const host = o.here?.() ?? nodeHost();
      return readAgents(host, { user: userInfo().username, vault: o.vault(), ...(on.projects !== undefined ? { projects: on.projects } : {}) });
    }
    const { host, user, runAs } = await hostOf(on);
    const box = on.kind === "box" ? { ...(on.signIns !== undefined ? { signIns: on.signIns } : {}), ...(on.versions !== undefined ? { versions: on.versions } : {}) } : undefined;
    const read = await readAgents(host, { user, vault: o.vault(), ...(on.projects !== undefined ? { projects: on.projects } : {}), ...(box !== undefined ? { box } : {}) });
    return { ...read, refused: [...read.refused, ...host.refused], ...(runAs !== undefined ? { runAs } : {}) };
  };
  return {
    read: async (on: AgentsOn, ask?: { latest?: boolean }) => {
      // A failed ask costs the newest version alone, and the person's switch off asks nothing.
      const none: Readonly<Record<string, string>> = {};
      const [read, latest] = await Promise.all([readOn(on), ask?.latest === false ? none : (o.latest?.().catch(() => none) ?? none)]);
      return { ...read, agents: read.agents.map(a => (latest[a.id] === undefined ? a : { ...a, latest: latest[a.id] })) };
    },
    tools: async (on, ask) => {
      const host = on.kind === "here" ? (o.here?.() ?? nodeHost()) : (await hostOf(on)).host;
      const project = projectOf(on);
      const env = on.kind === "here" ? await o.loginEnv?.() : undefined;
      return kept.tools(host, ask, { ...(project !== undefined ? { project } : {}), ...(env !== undefined ? { env } : {}) });
    },
    forget: key => kept.forget(key),
  };
}
