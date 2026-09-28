// SPDX-License-Identifier: AGPL-3.0-only
// Signing an agent, or one MCP server in its config, in from the app, on the
// computer or workspace it stands on. The line is the catalog row's own: its
// no-browser flow, run as the owner of the home where the daemon runs as
// root, with a shared login's store pointed at the computer's logins folder,
// and never with a DISPLAY, so a tool with a paste road takes it. A server's
// sign-in runs its harness's browser flow wherever the page's return reaches
// it: this computer's browser here, the relay's forward for a workspace or a
// computer you joined. The watched pty reports each page the tool prints or
// hands its own opener and the code beside it, arms the relay's forward for
// that page's callback port, types what a page hands back, and asks the
// tool's own status until it says signed in. The vault and the wsp tools are
// the two writes that sit beside it.
import { CATALOG_AGENTS, MCP_AGENTS, asksThePerson, hasLogin, keyEnvOf, loginHomeIn, mintsToken, questionsOf, serverSignInRoad, sharedLoginOf, signInRoadOf, tokenIn, type Question, type StatusCheck } from "@wsp/catalog";
import { asLogin, targetLogin, type TargetLogin } from "@wsp/engine";
import {
  addToolsHereRefusal,
  controlSignInRefusal,
  hasControlChar,
  callbackPortOf,
  lastLine,
  noVaultKeyRefusal,
  notTokenRefusal,
  placeDaemonPaths,
  redirectsToMachine,
  serverSignInCopyRefusal,
  shellQuote,
  signInTerminalRefusal,
  signInVaultRefusal,
  type McpServerSpec,
  type SignInLine,
} from "@wsp/protocol";
import { pageReachOf, type AgentsActs, type AgentsOn, type SignInAsk, type SignInRun } from "@wsp/runtime";
import { writeEnvFile } from "./env-keys.js";
import { STOPPED_NOTE, cadence, codeIn, signInEnv } from "./init-handoff.js";
import { installMcp } from "./mcp-install.js";
import { BOX_SIGN_IN_MS } from "./place-signin.js";
import { openerCommand } from "./relay.js";
import { runQuiet, watchPty, type WatchOutcome } from "./signin-relay.js";

/** One sign-in as the watched pty runs it: the line, the questions the row answers, the shape of the code it prints,
 * whether what its page hands back is typed into it, and the tool's own status check. */
export interface SignInPlan {
  line: SignInLine;
  questions: readonly Question[];
  code?: RegExp;
  paste(url: string): boolean;
  status?: StatusCheck;
}

const STATUS_MS = 60_000;
const POLL_MS = 5_000;
const GRACE_MS = 2_000;
/** What is kept of the tool's output: its first part for the code, its last for its last words. */
const TEXT_CAP = 16 * 1024;

function agentOf(id: string): (typeof CATALOG_AGENTS)[number] {
  const entry = CATALOG_AGENTS.find(a => a.id === id);
  if (entry === undefined) throw new Error(`no agent ${id} in the catalog`);
  return entry;
}

/** How each line reaches the target: as the owner of the home where a box's daemon runs as root, as it is elsewhere. */
async function wrapFor(on: AgentsOn): Promise<(line: string) => string> {
  const login = await loginOf(on);
  return login === undefined ? line => line : line => asLogin(login, line);
}

const loginOf = async (on: AgentsOn): Promise<TargetLogin | undefined> => (on.kind === "box" ? targetLogin(on.machine, on.login) : undefined);

/** The opener a harness is handed for a sign-in: it writes the page onto the sign-in's own terminal, then hands it to
 * the browser the terminal had. A tool may open its page with no terminal of its own, so the write goes to the device. */
const PAGE_OPENER = ["#!/bin/sh", '[ -n "$WSP_SIGNIN_TTY" ] && printf "%s" "$1" | tr -d "\\000-\\037\\177" > "$WSP_SIGNIN_TTY" && printf "\\n" > "$WSP_SIGNIN_TTY"', 'exec "$WSP_SIGNIN_OPENER" "$@"'];

/** The line run with the sign-in's own opener as BROWSER, so the pty is the one place its page is read from and a
 * browser.open from anything else on the workspace never becomes the row's page. */
export const pagesOnPty = (command: string): string =>
  [
    'WSP_SIGNIN_TTY=$(tty) || WSP_SIGNIN_TTY=; WSP_SIGNIN_OPENER=${BROWSER:-xdg-open}; export WSP_SIGNIN_TTY WSP_SIGNIN_OPENER',
    'd=$(mktemp -d) || exit 1',
    "trap 'rm -rf \"$d\"' EXIT",
    `printf '%s\\n' ${PAGE_OPENER.map(shellQuote).join(" ")} > "$d/open" && chmod 700 "$d/open" || exit 1`,
    'export BROWSER="$d/open"',
    command,
  ].join("; ");

/** The sign-in as it runs where it stands. `terminal`: the person's own terminal runs it, so a row that asks them to
 * pick is theirs to answer; the app refuses it, since nobody there can. */
export async function planSignIn(on: AgentsOn, ask: SignInAsk, o: { terminal?: boolean } = {}): Promise<SignInPlan> {
  if (hasControlChar(ask.agent) || (ask.server !== undefined && hasControlChar(ask.server))) throw new Error(controlSignInRefusal);
  const entry = agentOf(ask.agent);
  if (ask.server !== undefined) {
    const login = await loginOf(on);
    const reach = pageReachOf(on, login?.runAs);
    const road = serverSignInRoad(entry.id, ask.server, reach);
    if (road === undefined) throw new Error(`${entry.name} has no sign-in for an MCP server that wsp knows`);
    if (road.kind === "copy") throw new Error(serverSignInCopyRefusal(entry.name, road.line, road.why));
    const wrap = login === undefined ? (line: string) => line : (line: string) => asLogin(login, line);
    // The daemon's pty names wsp's own shim as BROWSER, which this computer has none of; a workspace keeps it behind
    // the sign-in's own opener, and its browser.open is what the relay carries here. A joined computer keeps its
    // shim under the login's home.
    const shim: Record<string, string> = login === undefined ? {} : { BROWSER: placeDaemonPaths(login.home).openShim };
    const env: Record<string, string> | undefined = reach === "here" ? { BROWSER: process.env["BROWSER"] || openerCommand() } : road.finish === "callback" ? { ...signInEnv("callback"), ...shim } : undefined;
    const command = reach === "relay" ? pagesOnPty(road.command) : road.command;
    return { line: { command: wrap(command), ...(env !== undefined ? { env } : {}) }, questions: [], paste: () => road.finish === "code" };
  }
  const row = entry.signIn;
  if (!hasLogin(row)) throw new Error(signInVaultRefusal(entry.name));
  if (asksThePerson(row) && o.terminal !== true) throw new Error(signInTerminalRefusal(entry.name, `wsp agents signin ${entry.id}`));
  const command = row.fallback ?? row.login;
  const status = row.status?.typed ?? row.status?.command;
  const shared = sharedLoginOf(row);
  const byCode = signInRoadOf(row) === "code";
  const plan = { questions: questionsOf(row), ...(row.code !== undefined ? { code: row.code } : {}), ...(row.status !== undefined ? { status: row.status } : {}), paste: (url: string) => byCode && !(on.kind === "here" && redirectsToMachine(url)) };
  if (shared !== undefined && on.kind === "box") {
    if (on.logins === undefined) throw new Error("this computer has not said where it keeps the logins its workspaces share, so there is nowhere to sign one in");
    const home = loginHomeIn(on.logins, shared);
    return { ...plan, line: { command, env: { [shared.homeEnv]: home }, prepare: `mkdir -p ${shellQuote(home)}`, ...(status !== undefined ? { status } : {}) } };
  }
  const wrap = await wrapFor(on);
  return { ...plan, line: { command: wrap(command), ...(status !== undefined ? { status: wrap(status) } : {}) } };
}

/** The last thing the tool said, with the terminal's escapes taken out and the tool's echo of a code a page handed
 * back left out, since that is not the tool's words either. */
function lastSaid(text: string, codes: readonly string[]): string | undefined {
  const lines = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n|\r/)
    .filter(l => !codes.some(t => l.includes(t)));
  return lastLine(lines.join("\n"));
}

/** Runs the plan's line in a watched pty over the run's link, reporting each step, until the tool's own status says
 * signed in, the tool ends, the cap passes or the run is stopped. */
export async function watchSignIn(plan: SignInPlan, run: SignInRun, o: { pollMs?: number; graceMs?: number; capMs?: number; flushMs?: number; now?: () => number } = {}): Promise<void> {
  const now = o.now ?? Date.now;
  const capMs = o.capMs ?? BOX_SIGN_IN_MS;
  const { link } = run;
  const { line } = plan;
  if (line.prepare !== undefined) await link.op("exec", { cmd: line.prepare });
  run.emit({ state: "running" });
  let seen = "";
  let said = "";
  const codes: string[] = [];
  let told: { url: string; code?: string; byAddress: boolean } | undefined;
  /** The page whose callback port this computer could not listen on: the address the browser landed on is taken
   * instead and carried there. */
  let unbound: string | undefined;
  let armed: number | undefined;
  const page = (url: string): void => {
    const code = codeIn(seen, plan.code);
    const byAddress = unbound === url;
    if (told !== undefined && told.url === url && told.code === code && told.byAddress === byAddress) return;
    told = { url, ...(code !== undefined ? { code } : {}), byAddress };
    run.emit({ state: "waiting", url, ...(code !== undefined ? { code } : {}), paste: byAddress || plan.paste(url) });
    const port = callbackPortOf(url);
    const forward = run.forward;
    if (forward === undefined || port === undefined || armed === port) return;
    armed = port;
    void forward
      .arm(url)
      .catch(() => false)
      .then(bound => {
        if (bound) return;
        unbound = url;
        if (told?.url === url) page(url);
      });
  };
  let settle: () => void = () => {};
  const stop = new Promise<void>(r => (settle = r));
  void run.stop.then(() => settle());
  let outcome: WatchOutcome | undefined;
  let failure: string | undefined;
  const watching = watchPty({
    link,
    command: line.command,
    timeoutMs: capMs,
    stop,
    questions: plan.questions,
    ...(line.env !== undefined ? { env: line.env } : {}),
    ...(o.flushMs !== undefined ? { flushMs: o.flushMs } : {}),
    onData: chunk => {
      if (seen.length < TEXT_CAP) seen += chunk;
      said = (said + chunk).slice(-TEXT_CAP);
    },
    onUrl: page,
    onScanned: () => {
      if (told !== undefined && told.code === undefined && plan.code !== undefined) page(told.url);
    },
    onTyping: write =>
      run.typing(
        write === undefined
          ? undefined
          : code => {
              codes.push(code);
              if (unbound !== undefined && run.forward !== undefined) return run.forward.deliver(code);
              return write(`${code}\r`);
            },
      ),
  }).then(
    w => void (outcome = w),
    (e: unknown) => void (failure = e instanceof Error ? e.message : String(e)),
  );
  const asked = async (): Promise<boolean> => {
    if (plan.status === undefined || line.status === undefined) return false;
    const quiet = await runQuiet(link, line.status, STATUS_MS, line.env ?? {}).catch(() => undefined);
    return quiet !== undefined && !quiet.timedOut && plan.status.signedIn(quiet.output, quiet.exitCode);
  };
  const pollMs = o.pollMs ?? POLL_MS;
  const started = now();
  let landed = false;
  while (outcome === undefined && failure === undefined && now() - started < capMs) {
    await Promise.race([watching, new Promise(r => setTimeout(r, cadence(now() - started, pollMs)))]);
    if (outcome !== undefined || failure !== undefined) break;
    if (await asked()) {
      landed = true;
      break;
    }
  }
  if (landed) await Promise.race([watching, new Promise(r => setTimeout(r, o.graceMs ?? GRACE_MS))]);
  settle();
  await watching;
  if (landed) return void run.emit({ state: "signed-in" });
  if (outcome === undefined) return void run.emit({ state: "failed", said: failure ?? "the sign-in command never ran" });
  if (outcome.stopped) return void run.emit({ state: "failed", said: STOPPED_NOTE });
  if (outcome.dropped) return void run.emit({ state: "failed", said: "the computer's terminal link dropped" });
  const through = plan.status === undefined ? outcome.exitCode === 0 : await asked();
  if (through) return void run.emit({ state: "signed-in" });
  run.emit({ state: "failed", said: lastSaid(said, codes) ?? `it ended with exit ${outcome.exitCode}` });
}

export interface HostActsOptions {
  /** The wsp home's .env, the vault every turn reads. */
  vaultFile: string;
  /** This computer's home, where an agent's own config lives. */
  home: () => string;
  /** The server an agent's config gets: the command that runs this same wsp against this host's state. */
  wspServer: () => McpServerSpec;
}

/** The acts the runtime is wired with: the catalog's sign-in roads, the vault and the wsp tools. */
export function hostActs(o: HostActsOptions): AgentsActs {
  return {
    signInLine: async (on, ask) => (await planSignIn(on, ask, { terminal: true })).line,
    signIn: async (on, ask) => {
      const plan = await planSignIn(on, ask);
      return run => watchSignIn(plan, run);
    },
    key: async (agent, key) => {
      const entry = agentOf(agent);
      const row = entry.signIn;
      if (mintsToken(row)) {
        const token = tokenIn(row, key);
        if (token === undefined) throw new Error(notTokenRefusal(entry.name));
        return writeEnvFile(o.vaultFile, { [row.tokenEnv]: token });
      }
      const name = keyEnvOf(row);
      if (name === undefined) throw new Error(noVaultKeyRefusal(entry.name));
      const value = key.trim();
      if (value === "") throw new Error(`The key for ${entry.name} is empty.`);
      writeEnvFile(o.vaultFile, { [name]: value });
    },
    addTools: async (on, agent) => {
      if (on.kind !== "here") throw new Error(addToolsHereRefusal);
      if (!MCP_AGENTS.some(a => a.id === agent)) throw new Error(`${agentOf(agent).name} has no MCP config wsp knows, so the wsp tools were not written`);
      const placed = installMcp(agent, o.wspServer(), o.home());
      return { file: placed.path! };
    },
  };
}
