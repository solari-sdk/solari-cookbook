// SPDX-License-Identifier: AGPL-3.0-only
// MCP servers travel with the agent that runs them, credentials included: one
// row per server under its agent. The definition itself rides inside the
// agent's config file (the agent's own row); this file reads that config
// through the catalog entry's format module to say what each server is, what
// it needs on Linux and which secret it carries. Token files are only stat'ed,
// never read.
import { createHash } from "node:crypto";
import { MAC_BIN_DIRS, MAC_ONLY, MCP_AGENTS, type McpAgent, type McpConfig, type McpServer, type McpTransport } from "@wsp/catalog";
import { MCP_ID_PREFIX, fmtBytes } from "@wsp/protocol";
import { type Host, expand, tilde } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { isSecretName } from "./shell-rc.js";

/** The row that carries mcp-remote's saved browser sign-ins for every agent. */
export const MCP_REMOTE_ID = `${MCP_ID_PREFIX}mcp-remote`;
export const MCP_REMOTE_LABEL = "mcp-remote sign-ins";

export type LinuxFit = { ok: true; needs: string } | { ok: false; reason: string };

const MCP_AUTH = "~/.mcp-auth";
/** mcp-remote's store since its versioned folders went away: MCP_REMOTE_CONFIG_DIR or ~/.mcp-auth, then mcp-remote-v1. */
const MCP_REMOTE_STORE = `${MCP_AUTH}/mcp-remote-v1`;

// --- what runs on Linux --------------------------------------------------------

/** Directories whose binaries the machine finds on its own PATH under the same name; the import's plan strips them too. */
export const MCP_BIN_DIRS: readonly string[] = [...MAC_BIN_DIRS, "/usr/local/bin/", "/usr/bin/", "/bin/"];

function isMacOnly(p: string, home: string): boolean {
  const abs = p.startsWith("~/") ? `${home}${p.slice(1)}` : p;
  return abs.startsWith(`${home}/Library/`) || MAC_ONLY.some(prefix => abs.startsWith(prefix));
}

/** `--flag=/path` carries its path after the equals sign. */
const pathOf = (s: string): string => (/^--?[\w-]+=/.test(s) ? s.slice(s.indexOf("=") + 1) : s);

/** The binary a command names: a path under a known bin directory or under ~/.local/bin is found by name on the machine. */
function binaryOf(command: string, home: string): string {
  const abs = command.startsWith("~/") ? `${home}${command.slice(1)}` : command;
  if (!abs.startsWith("/")) return abs;
  if (MCP_BIN_DIRS.some(d => abs.startsWith(d)) || abs.startsWith(`${home}/.local/bin/`)) return abs.slice(abs.lastIndexOf("/") + 1);
  return tilde(home, abs);
}

/** Whether a definition can run on the machine and what it needs there. A path under ~/Library or a macOS
 * install location has no Linux equivalent; home paths and Homebrew's prefix are rewritten on the machine. */
export function linuxFit(server: McpServer, home: string): LinuxFit {
  const t = server.transport;
  if (t.kind === "http") return { ok: true, needs: "nothing to install" };
  if (isMacOnly(t.command, home)) return { ok: false, reason: `command ${tilde(home, t.command)} is macOS-only, will not run` };
  for (const s of [...t.args.map(pathOf), ...(t.cwd !== undefined ? [t.cwd] : []), ...Object.values(t.env)]) {
    if (isMacOnly(s, home)) return { ok: false, reason: `path ${tilde(home, s)} is macOS-only, will not run` };
  }
  const bin = binaryOf(t.command, home);
  if (bin === "npx") return { ok: true, needs: "runs via npx" };
  if (bin === "uvx" || bin === "uv") return { ok: true, needs: "needs uv, installed on the machine when missing" };
  return { ok: true, needs: `needs ${bin} on the machine` };
}

// --- mcp-remote ------------------------------------------------------------------

const isUrl = (s: string): boolean => /^https?:\/\//.test(s);

const sortedJson = (o: Record<string, string>): string[] => (Object.keys(o).length > 0 ? [JSON.stringify(o, Object.keys(o).sort())] : []);

/** The store key mcp-remote derives for a definition that runs it, as its getServerUrlHash does: md5 of the server
 * url, the `--resource`, the sorted `--authorize-param` pairs, the sorted `--header` pairs and the
 * `--client-metadata-url`, joined with `|`. Undefined when the definition does not run mcp-remote. */
export function mcpRemoteHash(args: readonly string[]): string | undefined {
  const at = args.findIndex(a => /^mcp-remote(@[^/]*)?$/.test(a));
  if (at < 0) return undefined;
  const rest = args.slice(at + 1);
  const url = rest.find(isUrl);
  if (url === undefined) return undefined;
  const headers: Record<string, string> = {};
  const params: Record<string, string> = {};
  const after = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1]?.trim() : undefined;
  };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i + 1];
    if (value === undefined) continue;
    if (rest[i] === "--header" || rest[i] === "-H") {
      const colon = value.indexOf(":");
      if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
    } else if (rest[i] === "--authorize-param") {
      const eq = value.indexOf("=");
      if (eq > 0) params[value.slice(0, eq).trim()] = value.slice(eq + 1).trim();
    }
  }
  const resource = after("--resource");
  const metadata = after("--client-metadata-url");
  const parts = [url, ...(resource !== undefined ? [resource] : []), ...sortedJson(params), ...sortedJson(headers), ...(metadata !== undefined ? [metadata] : [])];
  return createHash("md5").update(parts.join("|")).digest("hex");
}

// --- rows ----------------------------------------------------------------------------

/** isSecretName's words plus the ones a file-valued variable tends to carry. */
function secretNamed(name: string): boolean {
  return isSecretName(name) || name.toUpperCase().split("_").some(w => ["CREDENTIAL", "CREDENTIALS", "AUTH", "CERT", "PASSWD"].includes(w));
}

/** Flags whose next argument is a secret whatever its name says: a header line, mcp-remote's OAuth client record with its client_secret. */
const HIDDEN_FLAGS = new Set(["--header", "-H", "--static-oauth-client-info"]);
/** A flag takes the next argument as its value unless that argument is itself a flag. */
const takesValue = (next: string | undefined): next is string => next !== undefined && !next.startsWith("-");

/** The flag an argument names: `--api-key`, `--token=`, `-H`; nothing where the argument is no flag. */
const flagName = (arg: string): string | undefined => /^(--?[A-Za-z][\w-]*)(=|$)/.exec(arg)?.[1];
/** The variable an `API_KEY=...` argument sets. */
const assignName = (arg: string): string | undefined => /^([A-Za-z_]\w*)=/.exec(arg)?.[1];
/** A flag whose value is never shown: one that hides it whatever its name says, or a secret-shaped name. */
const hidesValue = (flag: string): boolean => HIDDEN_FLAGS.has(flag) || secretNamed(flag.replace(/-/g, "_"));

const shownUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

/** The runners a definition names its own program after; every other command is the program itself. */
const RUNNERS = new Set(["npx", "uvx", "uv"]);

/** What one argument of a stdio definition comes to: the words the detail line shows for it, and how the count of
 * what the row carries names it. */
interface ArgRead {
  /** Nothing where the line drops the argument. */
  show?: string;
  /** Nothing where the argument carries no value of the person's. */
  secret?: string;
}

const size = (v: string): string => `(${Buffer.byteLength(v)} B)`;

/** An `API_KEY=value` argument wherever it stands, a bare one or a flag's value: the name is shown and the value
 * hidden and counted, so a variable set behind `-e` reads as the variable it is. Nothing for any other argument. */
const assignRead = (arg: string): ArgRead | undefined => {
  const name = assignName(arg);
  return name === undefined ? undefined : { show: `${name}=…`, secret: `arg ${name} ${size(arg.slice(arg.indexOf("=") + 1))}` };
};

/** The one reading of a definition's arguments, for the line a person reads and for what the row carries alike.
 * npx's own yes switch is dropped and takes no value. A dashed flag's next argument is that flag's value, read
 * like any other argument and shown unless the flag is secret-named or hides its value whatever its name says.
 * `--` ends the flags. Every argument past the program is a value this definition does not name, so it is hidden
 * and counted, and the row takes the copy answer. */
function readArgs(t: { command: string; args: readonly string[] }, home: string): ArgRead[] {
  const out: ArgRead[] = [];
  const shown = (a: string): string => (isUrl(a) ? `(${shownUrl(a)})` : tilde(home, a));
  let program = RUNNERS.has(binaryOf(t.command, home));
  let flags = true;
  for (let i = 0; i < t.args.length; i++) {
    const a = t.args[i]!;
    if (flags && (a === "-y" || a === "--yes")) {
      out.push({});
      continue;
    }
    if (flags && a === "--") {
      flags = false;
      out.push({ show: a });
      continue;
    }
    if (flags && a.startsWith("-")) {
      const flag = flagName(a);
      const hides = flag !== undefined && hidesValue(flag);
      if (a.includes("=")) {
        const value = a.slice(a.indexOf("=") + 1);
        if (hides) {
          out.push({ show: `${flag!}=…`, secret: `flag ${flag!} ${size(value)}` });
          continue;
        }
        // `--env=NAME=value` is the spaced spelling written short: its value is read the same way.
        const assigned = assignRead(value);
        out.push(assigned === undefined ? { show: shown(a) } : { show: `${a.slice(0, a.indexOf("=") + 1)}${assigned.show!}`, secret: assigned.secret });
        continue;
      }
      out.push({ show: a });
      const value = t.args[i + 1];
      if (!takesValue(value)) continue;
      i++;
      out.push(hides ? { show: "…", secret: `flag ${a} ${size(value)}` } : (assignRead(value) ?? { show: shown(value) }));
      continue;
    }
    const assigned = assignRead(a);
    if (assigned !== undefined) {
      out.push(assigned);
      continue;
    }
    if (program) {
      program = false;
      out.push({ show: shown(a) });
      continue;
    }
    out.push({ show: "…", secret: `arg ${i + 1} ${size(a)}` });
  }
  return out;
}

/** The definition in a few words: the command and its arguments as the reading above leaves them, urls shown as
 * host and path, and every value hidden behind a placeholder. */
function transportLine(t: McpTransport, home: string): string {
  return t.kind === "http" ? `http: ${shownUrl(t.url)}` : `stdio: ${stdioLine(t, home)}`;
}

/** A stdio definition's command and its first arguments as a person reads them, every value of theirs hidden. */
export function stdioLine(t: Extract<McpTransport, { kind: "stdio" }>, home: string): string {
  const words = readArgs(t, home).flatMap(r => (r.show === undefined ? [] : [r.show]));
  const cut = words.length > 5 ? [...words.slice(0, 5), "…"] : words;
  return [tilde(home, t.command), ...cut].join(" ");
}

interface Carried {
  secrets: string[];
  notes: string[];
  paths: string[];
  bytes: number;
}

/** Home paths a stdio definition runs against (arguments, cwd, env values), `~`-relative, the command itself and
 * anything under ~/.local/bin left out: what the machine needs beside the definition. */
export function homePaths(server: McpServer, home: string): string[] {
  const t = server.transport;
  if (t.kind === "http") return [];
  const out = new Set<string>();
  for (const s of [...t.args.map(pathOf), ...(t.cwd !== undefined ? [t.cwd] : []), ...Object.values(t.env)]) {
    const abs = s.startsWith("~/") ? `${home}${s.slice(1)}` : s;
    if (!abs.startsWith(`${home}/`) || abs.startsWith(`${home}/.local/bin/`)) continue;
    out.add(tilde(home, abs));
  }
  return [...out];
}

interface HomeDeps {
  notes: string[];
  /** A path the definition runs against is not here: the row starts unticked, and the person decides. */
  gone: boolean;
}

/** Whether each home path a definition runs against is here: one that is here and travels on no row of this
 * server is named as a dependency; one that is not here unticks the row but never locks it, since a server that
 * makes its own file (a memory store, a sqlite db) runs fine without it. */
async function homeDeps(host: Host, server: McpServer, carriedPaths: readonly string[]): Promise<HomeDeps> {
  const out: HomeDeps = { notes: [], gone: false };
  for (const p of homePaths(server, host.home)) {
    if (carriedPaths.includes(p)) continue;
    if ((await host.fs.stat(expand(host, p))) === undefined) {
      out.gone = true;
      out.notes.push(`${p} is not on this computer; unticked, tick it if the server creates it on first start`);
    } else out.notes.push(`depends on ${p}, which comes along only if a row carries it`);
  }
  return out;
}

/** What a definition carries: secret-named env values by size, the file such a value points at (which travels on
 * the row), header values, and where its mcp-remote sign-in or, as the agent's entry says, its http sign-in lives. Nothing is read. */
async function carried(host: Host, server: McpServer, agent: McpAgent, remoteTokens: ReadonlyMap<string, number>): Promise<Carried> {
  const out: Carried = { secrets: [], notes: [], paths: [], bytes: 0 };
  const t = server.transport;
  if (t.kind === "http") {
    for (const [k, v] of Object.entries(t.headers)) out.secrets.push(`header ${k} (${Buffer.byteLength(v)} B)`);
    if (agent.mcp.httpAuth !== undefined) out.notes.push(agent.mcp.httpAuth);
    return out;
  }
  for (const [k, v] of Object.entries(t.env)) {
    if (!secretNamed(k)) continue;
    const abs = v.startsWith("~/") ? expand(host, v) : v;
    const st = abs.startsWith("/") ? await host.fs.stat(abs) : undefined;
    if (st?.kind === "file") {
      if (!abs.startsWith(`${host.home}/`)) {
        out.notes.push(`the file ${k} points at is outside your home and is not copied`);
        continue;
      }
      out.secrets.push(`the file ${k} points at (${fmtBytes(st.bytes)})`);
      out.paths.push(`~${abs.slice(host.home.length)}`);
      out.bytes += st.bytes;
      continue;
    }
    out.secrets.push(`env ${k} (${Buffer.byteLength(v)} B)`);
  }
  for (const r of readArgs(t, host.home)) if (r.secret !== undefined) out.secrets.push(r.secret);
  const hash = mcpRemoteHash(t.args);
  if (hash !== undefined) {
    const bytes = remoteTokens.get(hash);
    out.notes.push(bytes === undefined ? "no saved sign-in; the browser sign-in runs again on the machine" : `its saved sign-in (${fmtBytes(bytes)}) travels on the ${MCP_REMOTE_LABEL} row`);
  }
  return out;
}

const mcpGroup = (agent: McpAgent): string => `${agent.name} MCP servers`;

function serverRow(agent: McpAgent, server: McpServer, fit: LinuxFit, deps: HomeDeps, c: Carried, home: string): ManifestEntry {
  const id = `${MCP_ID_PREFIX}${agent.id}/${server.scope === "home" ? "home/" : ""}${server.name}`;
  const reason = fit.ok ? undefined : fit.reason;
  const words = [
    ...(server.scope === "home" ? ["local to ~"] : []),
    transportLine(server.transport, home),
    ...(fit.ok ? [fit.needs, ...deps.notes] : []),
    ...server.envRefs.map(n => `reads ${n} from the environment, set it on the machine`),
    ...(c.secrets.length > 0 ? [`carries ${c.secrets.length === 1 ? "a secret" : "secrets"}: ${c.secrets.join(", ")}`] : c.notes.length === 0 ? ["carries no secret"] : []),
    ...c.notes,
  ];
  return {
    rung: "agents",
    id,
    label: server.name,
    group: mcpGroup(agent),
    paths: c.paths,
    bytes: c.bytes,
    default: reason === undefined && !deps.gone ? "bring" : "skip",
    ...(reason !== undefined ? { reason } : {}),
    // A server that carries a secret travels only on a copy answer, never on a bare tick.
    ...(c.secrets.length > 0 ? { consent: true } : {}),
    detail: words.join("; "),
  };
}

interface RemoteStore {
  /** Token file size by server hash. */
  tokens: Map<string, number>;
  /** Every file that travels: tokens, client registrations and the verifiers beside them. */
  bytes: number;
  excludes: string[];
}

/** The store as it is on disk, by listing: token sizes per hash, older bridge versions' folders and lock files
 * set aside. Undefined when there is no store. */
async function remoteStore(host: Host): Promise<RemoteStore | undefined> {
  if ((await host.fs.stat(expand(host, MCP_AUTH)))?.kind !== "dir") return undefined;
  const out: RemoteStore = { tokens: new Map(), bytes: 0, excludes: [] };
  for (const name of await host.fs.list(expand(host, MCP_AUTH))) if (/^mcp-remote-\d/.test(name)) out.excludes.push(`${MCP_AUTH}/${name}`);
  for (const name of await host.fs.list(expand(host, MCP_REMOTE_STORE))) {
    if (/^[0-9a-f]{32}_lock\.json$/.test(name)) {
      out.excludes.push(`${MCP_REMOTE_STORE}/${name}`);
      continue;
    }
    const bytes = (await host.fs.stat(expand(host, `${MCP_REMOTE_STORE}/${name}`)))?.bytes ?? 0;
    out.bytes += bytes;
    const token = /^([0-9a-f]{32})_tokens\.json$/.exec(name);
    if (token !== null) out.tokens.set(token[1]!, bytes);
  }
  return out;
}

function remoteRow(store: RemoteStore, matched: readonly string[]): ManifestEntry {
  const n = store.tokens.size;
  const tokenBytes = [...store.tokens.values()].reduce((a, b) => a + b, 0);
  const older = store.excludes.some(e => !e.startsWith(`${MCP_REMOTE_STORE}/`));
  const base = { rung: "agents" as const, id: MCP_REMOTE_ID, label: MCP_REMOTE_LABEL, group: "MCP sign-ins", paths: [MCP_AUTH], ...(store.excludes.length > 0 ? { excludes: store.excludes } : {}), bytes: store.bytes };
  if (n === 0) return { ...base, default: "skip", reason: `no saved sign-in the current bridge reads${older ? "; older versions' folders are left here" : ""}` };
  const elsewhere = n - matched.length;
  const whom = [...(matched.length > 0 ? [`for ${matched.join(", ")}`] : []), ...(elsewhere > 0 ? [`${elsewhere} for server${elsewhere === 1 ? "" : "s"} configured elsewhere (a repo's .mcp.json)`] : [])];
  return {
    ...base,
    default: "bring",
    consent: true,
    detail: `browser sign-ins saved by mcp-remote for remote servers: ${n} token${n === 1 ? "" : "s"} (${fmtBytes(tokenBytes)})${whom.length > 0 ? `, ${whom.join("; ")}` : ""}${older ? "; older bridge versions' folders stay here" : ""}`,
  };
}

/** The text of the first of an agent's config files that is here. */
async function configText(host: Host, config: McpConfig): Promise<string | undefined> {
  for (const file of config.files) {
    if ((await host.fs.stat(expand(host, file)))?.kind !== "file") continue;
    const text = await host.fs.readText(expand(host, file));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** One row per MCP server under its agent, then the mcp-remote sign-in store when there is one. Each agent's
 * config is read by its entry's format module, so an agent the catalog gains needs nothing here. */
export async function detectMcp(host: Host, agents: readonly McpAgent[] = MCP_AGENTS): Promise<ManifestEntry[]> {
  const store = await remoteStore(host);
  const tokens = store?.tokens ?? new Map<string, number>();
  const rows: ManifestEntry[] = [];
  const matched: string[] = [];
  for (const agent of agents) {
    const text = await configText(host, agent.mcp);
    if (text === undefined) continue;
    for (const server of agent.mcp.format.read(text, host.home)) {
      const fit = linuxFit(server, host.home);
      const c = await carried(host, server, agent, tokens);
      const deps = await homeDeps(host, server, c.paths);
      const hash = server.transport.kind === "stdio" ? mcpRemoteHash(server.transport.args) : undefined;
      if (hash !== undefined && tokens.has(hash)) matched.push(server.name);
      rows.push(serverRow(agent, server, fit, deps, c, host.home));
    }
  }
  if (store !== undefined) rows.push(remoteRow(store, matched));
  return rows;
}

