// SPDX-License-Identifier: AGPL-3.0-only
// One MCP server's tools and its state, off one connect: a command server is
// started once on the target as the login, with its own command and
// variables, and asked initialize then tools/list over its stdin; an address
// is asked the same over curl from the target, since it may be reachable only
// from there. That one answer is the server's state wherever it is drawn, so
// it is kept a few minutes per target and per definition, shared by every
// agent whose file names the same server, and asked again only on a refresh
// or once a sign-in there forgets it. The deadline stops the server's process
// group and every process of the login still carrying the run's marker in its
// environment, which reaches a child that left the group but not one that
// cleared its environment. No address is refused for being loopback or
// private: a server on localhost in the person's own config is a real setup,
// the ask runs on the computer that holds that config, and the config's
// headers go only to its own URL, with no redirect followed. A server whose
// address wants a sign-in is asked of
// its harness, which keeps the token wsp never reads, two at a time and once
// per server per sign-in or per ten minutes. Values reach the child through
// its environment or a private file, never a command line another login can
// read.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { MCP_AGENTS, MCP_AGENT_IDS, type McpAgent, type McpServer, type McpTransport } from "@wsp/catalog";
import { expand, type Host } from "@wsp/collect";
import type { ServerToolsAsk } from "@wsp/runtime";
import { lastLine, serverToolsLateRefusal, shellQuote, withoutControlChars, type McpAuth, type McpTool, type McpToolParam, type ServerToolsAnswer } from "@wsp/protocol";

export const TOOLS_DEADLINE_MS = 20_000;
/** How long one server's answer stands before it is asked again. */
export const TOOLS_KEPT_MS = 3 * 60_000;
/** Servers asked at once on one host: a list that opens asks every one it checks. */
const ASKS_AT_ONCE = 4;
const HARNESS_KEPT_MS = 10 * 60_000;
const HARNESS_AT_ONCE = 2;
/** How long a harness is given to say whether it holds a server's sign-in. */
const HARNESS_MS = 5_000;
/** The most of a server's tools answer read back; a list past it is refused, never cut. */
const ANSWER_CAP = 1024 * 1024;
/** What of a server's stdout and stderr is kept on the target while it runs; past it the rest is read and dropped.
 * dd a byte at a time, since head holds a small answer in its buffer where the wait for it cannot see it. */
const OUT_CAP = 4 * ANSWER_CAP;
const ERR_CAP = 64 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "wsp", version: "1" } } });
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

/** Starts `"$@"` in `$1` (after the shift) in a process group of its own on a fifo, with a marker in its environment,
 * sends initialize, waits for its answer, then initialized and tools/list, and waits for that answer; stops the group
 * and every process carrying the marker when it came or the time ran out. Prints `\x1e<outcome> <exit>`, the tools
 * answer's line, `\x1e`, then the tail of what it said on stderr. Outcome 0 answered, 1 exited first, 2 late. */
const stdioScript = (seconds: string): string =>
  [
    'c=$1; shift; [ -n "$c" ] && cd "$c"',
    'd=$(mktemp -d "${TMPDIR:-/tmp}/wsp-tools.XXXXXX") || exit 1',
    "trap 'rm -rf \"$d\"' EXIT",
    "trap '' PIPE",
    'mkfifo "$d/in" "$d/o" "$d/e" || exit 1',
    "m=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')",
    '[ -n "$m" ] || exit 1',
    `printf 'WSP_TOOLS_RUN=%s' "$m" > "$d/m"`,
    // Apple's own binaries show no environment to a Mac's ps, so there only the group kill covers them.
    'sweep() { local l; if [ -d /proc/self ]; then l=$(grep -lzxF -f "$d/m" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); ' +
      'else l=$(ps eww -U "$(id -u)" -o pid=,command= | M="WSP_TOOLS_RUN=$m" awk \'index($0 " ", " " ENVIRON["M"] " ") { print $1 }\'); fi; [ -n "$l" ] && kill "-$1" $l 2>/dev/null; }',
    // The host's bound on the run sends TERM to this shell's group alone, and set -m puts every job in its own.
    'trap \'kill "$t" 2>/dev/null; kill -KILL -- "-$p" "-$ro" "-$re" 2>/dev/null; sweep KILL; exit 143\' TERM',
    "set -m",
    `{ dd bs=1 count=${OUT_CAP} of="$d/out" 2>/dev/null; cat > /dev/null; } < "$d/o" &`,
    "ro=$!",
    `{ dd bs=1 count=${ERR_CAP} of="$d/err" 2>/dev/null; cat > /dev/null; } < "$d/e" &`,
    "re=$!",
    'WSP_TOOLS_RUN=$m "$@" < "$d/in" > "$d/o" 2> "$d/e" &',
    "p=$!",
    'exec 3> "$d/in"',
    `sleep ${seconds} &`,
    "t=$!",
    `seen() { grep -Eq "\\"id\\"[[:space:]]*:[[:space:]]*$1[[:space:]]*[,}]" "$d/out"; }`,
    'upto() { while ! seen "$1"; do kill -0 "$p" 2>/dev/null || return 1; kill -0 "$t" 2>/dev/null || return 2; sleep 0.1; done; }',
    `printf '%s\\n' ${shellQuote(INITIALIZE)} >&3`,
    "upto 1; r=$?",
    `[ "$r" = 0 ] && { printf '%s\\n%s\\n' ${shellQuote(INITIALIZED)} ${shellQuote(TOOLS_LIST)} >&3; upto 2; r=$?; }`,
    "exec 3>&-",
    'kill "$t" 2>/dev/null; kill -TERM -- "-$p" 2>/dev/null; sweep TERM; sleep 0.2; kill -KILL -- "-$p" 2>/dev/null; sweep KILL',
    'wait "$p" 2>/dev/null; x=$?',
    'kill -KILL -- "-$ro" "-$re" 2>/dev/null',
    "printf '\\036%s %s\\n' \"$r\" \"$x\"",
    `grep -E '"id"[[:space:]]*:[[:space:]]*2[[:space:]]*[,}]' "$d/out" | head -c ${ANSWER_CAP + 1}`,
    "printf '\\036'",
    'tail -c 2000 "$d/err"',
  ].join("\n");

/** Writes a curl config off the variables it was handed (the url and each header), so no value is on a command line,
 * then posts initialize, initialized and tools/list with the session the first answer names, keeping each body under
 * the cap on the target; a status is the last one its headers name. Prints
 * `\x1e<status of initialize> <status of tools/list>`, the tools answer, `\x1e`, then curl's own last words. */
const httpScript = (seconds: number): string =>
  [
    "command -v curl >/dev/null 2>&1 || { printf '\\036nocurl\\n'; exit 0; }",
    'd=$(mktemp -d "${TMPDIR:-/tmp}/wsp-tools.XXXXXX") || exit 1',
    "trap 'rm -rf \"$d\"' EXIT",
    `end=$((SECONDS + ${seconds}))`,
    'cq() { local v=${1//\\\\/\\\\\\\\}; v=${v//\\"/\\\\\\"}; v=${v//$\'\\r\'/\\\\r}; v=${v//$\'\\n\'/\\\\n}; printf \'"%s"\' "$v"; }',
    "umask 077",
    '{ printf \'url = %s\\n\' "$(cq "$WSP_MCP_URL")"; i=0; while v="WSP_MCP_H_$i"; [ -n "${!v+x}" ]; do printf \'header = %s\\n\' "$(cq "${!v}")"; i=$((i+1)); done; } > "$d/k"',
    'sid=',
    "post() { local t=$((end - SECONDS)); [ \"$t\" -gt 0 ] || t=1; curl -sS -m \"$t\" -K \"$d/k\" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' " +
      `-H 'MCP-Protocol-Version: ${PROTOCOL_VERSION}' $\{sid:+-H "Mcp-Session-Id: $sid"} -D "$d/$2.h" -o - --data-binary "$1" 2>> "$d/e" | head -c ${ANSWER_CAP + 1} > "$d/$2.b"; ` +
      `c=$(sed -n 's/^HTTP\\/[^ ]* \\([0-9][0-9]*\\).*/\\1/p' "$d/$2.h" 2>/dev/null | tail -n 1); echo "\${c:-000}"; }`,
    `a=$(post ${shellQuote(INITIALIZE)} i)`,
    'if [ "$a" = 200 ]; then',
    "  sid=$(grep -i '^mcp-session-id:' \"$d/i.h\" | head -n 1 | cut -d: -f2- | tr -d ' \\r')",
    `  post ${shellQuote(INITIALIZED)} n > /dev/null`,
    `  b=$(post ${shellQuote(TOOLS_LIST)} l)`,
    "fi",
    "printf '\\036%s %s\\n' \"$a\" \"${b:-}\"",
    `[ -f "$d/l.b" ] && head -c ${ANSWER_CAP + 1} "$d/l.b"`,
    "printf '\\036'",
    'tail -c 2000 "$d/e" 2>/dev/null',
  ].join("\n");

/** curl's last words, with any URL's user, password and query string cut off, since a token can ride in each. */
const curlSaid = (err: string): string | undefined =>
  lastLine(err)
    ?.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1");

/** A server's own words with every control character gone, each line kept, so no escape of theirs reaches a terminal. */
const clean = (v: string): string => v.split("\n").map(withoutControlChars).join("\n");

const trimmed = (v: unknown): string | undefined => (typeof v === "string" && clean(v).trim() !== "" ? clean(v).trim() : undefined);

/** A tool's parameters off its input schema: each property with the type the schema names (several joined, or none
 * where it names a union another way) and whether `required` lists it. Nothing where the schema has no properties. */
function paramsOf(schema: unknown): McpToolParam[] | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return undefined;
  const needed = new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : []);
  const params = Object.entries(properties as Record<string, unknown>).map(([name, p]): McpToolParam => {
    const prop = typeof p === "object" && p !== null ? (p as { type?: unknown; description?: unknown }) : {};
    const types = typeof prop.type === "string" ? [prop.type] : Array.isArray(prop.type) ? prop.type.filter((t): t is string => typeof t === "string") : [];
    const description = trimmed(prop.description);
    return { name: withoutControlChars(name), ...(types.length > 0 ? { type: types.join(" or ") } : {}), required: needed.has(name), ...(description !== undefined ? { description } : {}) };
  });
  return params.length > 0 ? params : undefined;
}

/** The tools off a JSON-RPC answer to tools/list, or why there are none: the server's own error, or a list past the
 * cap. An SSE body carries the answer on its `data:` lines. A server's error message may carry its own key, so the
 * page is told its code and the message is only `said`, for the host's log. */
function toolsOf(body: string): { tools: McpTool[] } | { refused: string; said?: string } {
  if (body.length > ANSWER_CAP) return { refused: `its tools answer is over ${ANSWER_CAP / 1024 / 1024} MB and was not read` };
  const candidates = body.split("\n").map(l => (l.startsWith("data:") ? l.slice(5).trim() : l.trim()));
  for (const line of candidates) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg !== "object" || msg === null || (msg as { id?: unknown }).id !== 2) continue;
    const { result, error } = msg as { result?: { tools?: unknown }; error?: { code?: unknown; message?: unknown } };
    if (error !== undefined) {
      const refused = `it answered tools/list with ${typeof error.code === "number" ? `error ${error.code}` : "an error"}`;
      return { refused, ...(typeof error.message === "string" ? { said: `${refused}: ${error.message}` } : {}) };
    }
    if (!Array.isArray(result?.tools)) break;
    return {
      tools: result.tools.flatMap((t: unknown) => {
        if (typeof t !== "object" || t === null || typeof (t as { name?: unknown }).name !== "string") return [];
        const { name, description, inputSchema } = t as { name: string; description?: unknown; inputSchema?: unknown };
        const about = trimmed(description);
        const params = paramsOf(inputSchema);
        return [{ name: withoutControlChars(name), ...(about !== undefined ? { description: about } : {}), ...(params !== undefined ? { params } : {}) }];
      }),
    };
  }
  return { refused: "its answer to tools/list could not be read" };
}

type Asked = Omit<ServerToolsAnswer, "readAt">;

const RUN_MARGIN_MS = 10_000;

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const variableNameRefusal = (name: string): string => `its variable ${JSON.stringify(name)} is not a name a shell takes, so it was not started`;

async function askStdio(host: Host, t: Extract<McpTransport, { kind: "stdio" }>, cwd: string, deadlineMs: number, now: () => number, log: (said: string) => void, env: Readonly<Record<string, string>> = {}): Promise<Asked> {
  const bad = Object.keys(t.env).find(k => !SHELL_NAME.test(k));
  if (bad !== undefined) return { auth: "failed", refused: variableNameRefusal(bad) };
  const began = now();
  const bound = deadlineMs + RUN_MARGIN_MS;
  const out = await host.exec.run("bash", ["-c", stdioScript((Math.max(100, deadlineMs) / 1000).toFixed(1)), "bash", cwd, t.command, ...t.args], { env: { ...env, ...t.env }, timeoutMs: bound });
  if (out === undefined && now() - began >= bound) return { auth: "failed", refused: serverToolsLateRefusal(deadlineMs) };
  const [, head = "", err = ""] = (out ?? "").split("\x1e");
  const [status = "", ...rest] = head.split("\n");
  const [outcome, exit] = status.trim().split(" ");
  if (out === undefined || outcome === undefined || outcome === "") return { auth: "failed", refused: "it could not be started there" };
  // What a server says on stderr may carry its own key, so it goes to the host's log and never onto the page.
  if (outcome !== "0" && err.trim() !== "") log(`it said on stderr: ${err.trim()}`);
  if (outcome === "2") return { auth: "failed", refused: serverToolsLateRefusal(deadlineMs) };
  if (outcome === "1") return { auth: "failed", refused: `it exited with ${exit ?? "no code"} before it answered` };
  return read(rest.join("\n"), log);
}

/** The tools answer as the page takes it, with a server's own words sent to the log. */
function read(body: string, log: (said: string) => void): Asked {
  const got = toolsOf(body);
  if ("tools" in got) return { auth: "connected", tools: got.tools };
  if (got.said !== undefined) log(got.said);
  return { auth: "failed", refused: got.refused };
}

type HttpAsked = Asked | { unauthorized: true };

async function askHttp(host: Host, t: Extract<McpTransport, { kind: "http" }>, deadlineMs: number, log: (said: string) => void): Promise<HttpAsked> {
  const env: Record<string, string> = { WSP_MCP_URL: t.url };
  Object.entries(t.headers).forEach(([name, value], i) => (env[`WSP_MCP_H_${i}`] = `${name}: ${value}`));
  const out = await host.exec.run("bash", ["-c", httpScript(Math.max(1, Math.ceil(deadlineMs / 1000))), "bash"], { env, timeoutMs: deadlineMs * 3 + RUN_MARGIN_MS });
  const [, head = "", err = ""] = (out ?? "").split("\x1e");
  const [status = "", ...rest] = head.split("\n");
  if (out === undefined || status === "") return { auth: "failed", refused: "its address could not be asked from there" };
  if (status === "nocurl") return { auth: "unknown", refused: "curl is not there to ask its address with" };
  const [first = "", listed = ""] = status.trim().split(" ");
  if (first === "401" || first === "403") return { unauthorized: true };
  if (first === "000") return { auth: "failed", refused: /timed out/i.test(err) ? serverToolsLateRefusal(deadlineMs) : (curlSaid(err) ?? "its address did not answer") };
  if (first !== "200") return { auth: "failed", refused: `its address answered initialize with ${first}` };
  if (listed === "401" || listed === "403") return { unauthorized: true };
  if (listed !== "200") return { auth: "failed", refused: `its address answered tools/list with ${listed === "" ? "nothing" : listed}` };
  return read(rest.join("\n"), log);
}

/** The harness's own word on a server whose address wants a sign-in wsp does not hold. */
async function askHarness(host: Host, agent: McpAgent, name: string, cwd: string, deadlineMs: number): Promise<Asked> {
  const check = agent.mcp.check;
  if (check === undefined) return { auth: "unknown", holder: agent.id };
  const out = await host.exec.run("bash", ["-c", `cd ${shellQuote(cwd)} 2>/dev/null; ${check.line(name)} 2>&1; true`], { timeoutMs: deadlineMs });
  return { auth: (out === undefined ? undefined : check.auth(out)) ?? "unknown", holder: agent.id };
}

/** One server as its agent's file defines it there: the agent's own file first, then the project's. */
interface Found {
  server: McpServer;
  file: string;
  entry: string;
  project: boolean;
}

async function findServer(host: Host, agent: McpAgent, name: string, project: string | undefined): Promise<Found | undefined> {
  const files: { path: string; project: boolean }[] = [
    ...agent.mcp.files.map(f => ({ path: expand(host, f), project: false })),
    ...(project === undefined ? [] : (agent.mcp.projectFiles ?? []).map(f => ({ path: posix.join(project, f), project: true }))),
  ];
  const texts = await Promise.all(files.map(f => host.fs.readText(f.path)));
  // The first file of each kind that is there is the one the agent reads, as the report reads it.
  const own = files.findIndex((f, i) => !f.project && texts[i] !== undefined);
  const theirs = files.findIndex((f, i) => f.project && texts[i] !== undefined);
  for (const at of [own, theirs]) {
    if (at < 0) continue;
    const text = texts[at]!;
    const servers = agent.mcp.format.read(text, host.home).filter(s => !files[at]!.project || s.scope === "user");
    const server = servers.find(s => s.name === name && s.scope === "user") ?? servers.find(s => s.name === name);
    if (server === undefined) continue;
    const entry = agent.mcp.format.entryOf(text, name, server.scope === "home" ? host.home : undefined) ?? JSON.stringify(server.transport);
    return { server, file: files[at]!.path, entry, project: files[at]!.project };
  }
  return undefined;
}

export const noSuchServerRefusal = (name: string, agent: string): string => `no MCP server called ${name} is in ${agent}'s config there; wsp servers lists them`;
export const noMcpAgentRefusal = (agent: string): string => `${agent} is no agent whose MCP config wsp reads; one of ${MCP_AGENT_IDS}`;

/** Whether the harness asked from `cwd` finds the name in two scopes, where it picks one itself and may start a
 * command server of that name. */
async function twiceAt(host: Host, agent: McpAgent, name: string, cwd: string): Promise<boolean> {
  const own = agent.mcp.files.map(f => expand(host, f));
  const first = async (files: readonly string[]): Promise<string | undefined> => (await Promise.all(files.map(f => host.fs.readText(f)))).find(t => t !== undefined);
  const [mine, theirs] = await Promise.all([first(own), first((agent.mcp.projectFiles ?? []).map(f => posix.join(cwd, f)).filter(f => !own.includes(f)))]);
  const scopes = new Set<string>([
    ...(mine === undefined ? [] : agent.mcp.format.read(mine, cwd)).filter(s => s.name === name).map(s => s.scope),
    ...(theirs === undefined ? [] : agent.mcp.format.read(theirs, host.home)).filter(s => s.name === name && s.scope === "user").map(() => "project"),
  ]);
  return scopes.size > 1;
}

/** Runs at most `n` of what it is handed at once, the rest in the order they came. */
function atMost(n: number): <T>(f: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async f => {
    while (running >= n) await new Promise<void>(r => waiting.push(r));
    running++;
    try {
      return await f();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export interface ServerTools {
  /** One server's tools and state there, off the connect kept for it or a new one. */
  /** `env` is the environment a command server starts with under its config's own: the login shell's, on this computer. */
  tools(host: Host, ask: ServerToolsAsk, o?: { project?: string; env?: Readonly<Record<string, string>> }): Promise<ServerToolsAnswer>;
  /** Drops every answer and harness word kept for the target, which a sign-in there has just changed. */
  forget(key: string): void;
}

export function serverTools(o: { now: () => number; deadlineMs?: number; log: (line: string) => void }): ServerTools {
  const connects = new Map<string, { at: number; asked: Promise<HttpAsked> }>();
  const words = new Map<string, { at: number; auth: Promise<McpAuth | undefined> }>();
  const asking = atMost(ASKS_AT_ONCE);
  const harnessing = atMost(HARNESS_AT_ONCE);
  const deadlineMs = o.deadlineMs ?? TOOLS_DEADLINE_MS;

  /** The word of the agent whose harness keeps the server's sign-in: the address's own needs-sign-in unless it says
   * signed in or failed. */
  const harnessWord = async (host: Host, key: string, agent: McpAgent, name: string, cwd: string, now: number): Promise<Asked> => {
    if (agent.mcp.check === undefined || (await twiceAt(host, agent, name, cwd))) return { auth: "unknown", holder: agent.id };
    const at = `${key}\0${agent.id}\0${name}`;
    let held = words.get(at);
    if (held === undefined || now - held.at >= HARNESS_KEPT_MS) {
      held = { at: now, auth: harnessing(() => askHarness(host, agent, name, cwd, HARNESS_MS)).then(a => a.auth, () => undefined) };
      words.set(at, held);
    }
    const said = await held.auth;
    return { auth: said === "signed-in" || said === "failed" ? said : "needs-sign-in", holder: agent.id };
  };

  return {
    async tools(host, ask, at = {}) {
      const agent = MCP_AGENTS.find(a => a.id === ask.agent);
      if (agent === undefined) throw new Error(noMcpAgentRefusal(ask.agent));
      const found = await findServer(host, agent, ask.name, at.project);
      if (found === undefined) throw new Error(noSuchServerRefusal(ask.name, agent.name));
      const cwd = found.project && at.project !== undefined ? at.project : host.home;
      const t = found.server.transport;
      const now = o.now();
      for (const [k, v] of connects) if (now - v.at >= TOOLS_KEPT_MS) connects.delete(k);
      for (const [k, v] of words) if (now - v.at >= HARNESS_KEPT_MS) words.delete(k);
      const runIn = t.kind === "stdio" ? (t.cwd ?? cwd) : "";
      const key = `${ask.key}\0${createHash("sha256").update(JSON.stringify([t, runIn])).digest("hex")}`;
      let held = connects.get(key);
      if (ask.refresh === true || held === undefined) {
        const log = (said: string): void => o.log(`servers tools: ${agent.id} ${ask.name} on ${ask.key}: ${said}`);
        const mine: { at: number; asked: Promise<HttpAsked> } = { at: now, asked: asking(() => (t.kind === "stdio" ? askStdio(host, t, runIn, deadlineMs, o.now, log, at.env) : askHttp(host, t, deadlineMs, log))) };
        // A connect that threw is not an answer, so the next ask makes its own.
        mine.asked.catch(() => connects.get(key) === mine && connects.delete(key));
        connects.set(key, mine);
        held = mine;
      }
      const asked = await held.asked;
      const answer = "unauthorized" in asked ? await harnessWord(host, ask.key, agent, ask.name, cwd, now) : asked;
      return { ...answer, readAt: new Date(held.at).toISOString() };
    },
    forget(key) {
      for (const map of [connects, words]) for (const k of [...map.keys()]) if (k.startsWith(`${key}\0`)) map.delete(k);
    },
  };
}
