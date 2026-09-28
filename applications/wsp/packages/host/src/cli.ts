// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { isCancel } from "@clack/prompts";
import { collect, computeRecipe, expand, nodeHost, scanProject, seedMenu, type Manifest, type Platform, type Rung } from "@wsp/collect";
import {
  HARNESS_ADAPTERS,
  createRuntime,
  goldenHead,
  hostIdentity,
  jsonFileStore,
  localExecStream,
  type GoldenRecipe,
  type GoldenVersion,
  type HarnessAdapterFactory,
  type LocalWiring,
  type Machine,
  type PlaceWiring,
  type RestartDoor,
  type Runtime,
  type SeedWiring,
  type SshWiring,
  type Store,
} from "@wsp/runtime";
import { writeOwn } from "@wsp/own-file";
import { GOLDEN_SETUP, GOLDEN_SMOKE, GUEST_HOME, MCP_AGENT_IDS, THREAD_AGENTS, serverValuesOf } from "@wsp/catalog";
import { authRefusal, FORWARD_ENV, hostFromEnv, jsonLine, SCOPED_MCP_ARG, scopedNoPairLine, imageHomeKeptLine, isJoinedComputer, PLACE_LEAVE_LINE, PLACE_LEAVE_VERB, DEFAULT_PORT, DEFAULT_WS_PORT, EXIT_CODES, EXIT_WORDS, ExitClass, FIRST_WORKSPACE, fmtDuration, forksNoMachines, initJobOver, InitSetup, NO_BUILD_PLACE_LINE, isLocalWorkspace, isLoopback, type ListenAsked, listenBeyondLoopbackLine, loopbackThreadsLine, LOOPBACK, PERSON_HOME_ENV, portInsteadLine, PORT_TAKEN_REFUSAL, portsAsked, portsPickedLine, portTakenLine, runForTheList, type SealedImage, shellQuote, THIS_COMPUTER, thisComputerLine, TURN_END_WORDS, namesPlace, noSuchPlaceRefusal, type PlaceView, unknownWordLine, usageRefusal, verbFailure, foreignFlagLine, WS_PORT_OFFSET } from "@wsp/protocol";
import { agentHome, agentHomes, checkProviderKey, type Copier, keyCheckLine, type KeyCheck, LocalBackend, type MachineBackend, providerSlot, type ProviderSlot, SshBackend, verbCopier } from "@wsp/engine";
import { providerBackendFor, providerEnvWith, providerEnvWithKey, providerKeyRow, providerKeyRows, providerKeySet, providerModule, providerPlaces, wiredPlaceRow, wiredProviderId, type ProviderEnv } from "./providers.js";
import { daemonBinaryHere, webDirFor } from "./assets.js";
import { DAEMON_DEPLOYED_LINE, cappedLine, claudeEnvs, deployDaemon, doctor, doctorOverHost, hostDoctor, missingBundleFile, removeDaemon, sshDaemonPlace } from "./doctor.js";
import { daemonFixLine, releaseUpdateLine } from "./daemon-fix.js";
import { agentsHere } from "./agents-here.js";
import { InitJobs } from "./init-job.js";
import { ANTHROPIC_KEY, KEY_LAYER_WORDS, envFileFor, keyIn, parseEnvFile, savedEnv, serverEnvFileFor, serverVault, vaultOf, writeEnvFile, type Keys } from "./env-keys.js";
// The writer of a host's own .env now sits beside its reader; the name stays exported here for every caller
// that already had it from this module.
export { writeEnvFile } from "./env-keys.js";
import { keychainReader } from "./init-import.js";
import { adoptLoginPath, loginEnv } from "./login-path.js";
import { CACHE_RULE } from "./project-bundle.js";
import { packSeed } from "./project-seed.js";
import { readBrewTable } from "./init-brew.js";
import { copyGoldenRecipe } from "./image-recipe.js";
import { exitCodeOf, runInit, type InitIO, type InitPricing, type InitResult } from "./init.js";
import { runMintHere } from "./init-vault.js";
import { recipePath } from "./init-recipe.js";
import { historyCache } from "./recipe-file.js";
import { alsoHere } from "./scan.js";
import { colourDepth, confirmPrompt, isTTY, muted, passwordPrompt, widthOf, wrap, type PromptOptions } from "./init-layout.js";
import { TAGLINE, builtOn, opening } from "./init-opening.js";
import { runLocalInit } from "./init-local.js";
import type { ServedAt } from "./init-serve.js";
import { askFirst } from "./init-first.js";
import { buildBesideHost } from "./init-beside.js";
import { hereAnswering, hereLines, openHere, type HereWatch } from "./place-here.js";
import { watchBlock, watchOn, type Redraw, type WatchSignals } from "./watch.js";
import { startCallbackRelay, systemOpener, type UrlOpener } from "./relay.js";
import { addressLines, hostInboxDir, hostLogPath, hostRootsPath, hostRunDir, hostTokenPath, lockPathFor, refuseIfServed, servingHost, startedByEnv, STARTED_BY_ENV, takeLock, type HostLock, type HostStarted } from "./host-lock.js";
import type { LocalDaemon, LocalDaemonOptions } from "./local-daemon.js";
import { startOnce } from "./start-once.js";
import {
  hostThereLines,
  httpProbe,
  installService,
  logTail,
  noManagerLine,
  registeredService,
  runFailureLine,
  serviceAddressHere,
  serviceEnv,
  serviceManagerFor,
  SERVICE_WAIT_MS,
  serviceReading,
  statusLines,
  stopService,
  systemRunner,
  untilLock,
  untilServing,
  type HostProbe,
  type ServiceManager,
  type ServiceRunner,
} from "./service.js";
import { serviceServesState, starterFor, type HostStarter } from "./host-start.js";
import { restartRoads, type RestartingHost, type RestartRoad } from "./restart.js";
import { stopRecordedConnector } from "./connector.js";
import { admittedDevices, hostsCommand, loginCommand, logoutCommand, publicHostname, readRelayRecord, relayCommand, relayOnLoopbackLine, startRelay } from "./relay-link.js";
import { aimAddress, aimedHost, aimName, DEFAULT_HOME, type HostPick, namedHost, stateIgnoredLine, wspHome } from "./hosts.js";
import { defaultHomeIn, homeNamed, realState, servingHome } from "./serving-home.js";
import { advertiseWord, devicesCommand, hereUrl, hostReach, pairCommand, type HereAt } from "./pairing.js";
import { addCommand, addFlags, dialHere, joinCommand, leaveCommand, placeWiring, removeCommand } from "./places.js";
import { agentsReader } from "./agents-reader.js";
import { skillsActs } from "./skills-acts.js";
import { serverIcons } from "./server-icons.js";
import { agentLatest } from "./agent-latest.js";
import { serversActs } from "./servers-acts.js";
import { hostActs } from "./agents-signin.js";
import { startHost, workspaceRoads, type HostDoctorReaders, type HostHandle } from "./server.js";
import { choosePorts, type PortProbes, type PortsPicked } from "./ports.js";
import { serveMcp } from "./mcp.js";
import { agentsOnPath, installEach, installLines, mcpServerCommand, mcpServerSpec, nextLine, refreshSkills, registeredLine, removeEach, removeLines, runningWsp, skillsRefreshedLine, type RunningWsp } from "./mcp-install.js";
import { CLI_VERBS, COMMON, COMMON_FLAG_WORDS, hostPlatform, NO_PROJECT_YET, type DialOpts, dialHost, failed, findVerb, HELP_WIDTH, hereDoor, helpPage, type HostClient, jsonAsked, type Page, runVerb, takeCommon, toolName, usageLines, verbUsage, type VerbDeps } from "./verbs.js";
import { installedVersion, stateWriterHere, VERSION } from "./version.js";
import { latestWords, releaseReading, releaseWatch } from "./release.js";

/** The one claim about the host a person reads twice, on the front page and on wsp up's own page: which is why up
 * is for a host somebody wants to watch and not the switch that turns wsp on. Said once here, so the page and the
 * line cannot promise different things; the words that need a host and start one are the verbs, wsp add and wsp
 * remove, and wsp status and wsp down deliberately start none, which is why this says a line that needs one. */
export const HOST_STARTS_ITSELF = "A line that needs a host starts one when none serves.";

/** One line per exit class, the code first, wrapped to the help's width. */
const exitCodeHelp = (): string => ExitClass.options.map(cls => wrap(`  ${EXIT_CODES[cls]} ${cls.padEnd(8)}  ${EXIT_WORDS[cls]}`, 80, " ".repeat(14)).join("\n")).join("\n");

/** The front page, word for word: sixteen words on five nouns, the three rules, and the two pages and the flag
 * help behind them. It is a literal rather than a table of usages because the whole of it is what a person meets
 * first, and its right hand column is written for that reading; the parity test holds its sixteen words to the
 * entries that declare the front page, so a verb cannot be added to one and not the other. */
export const HELP = `wsp - ${TAGLINE}

usage: wsp <verb> ...

  wsp init                        set this computer up: your tools and sign-ins,
                                  copied so a workspace starts ready
  wsp add <user@host|folder|url>  a computer over ssh (user@host or ssh alias);
                                  or a project: a folder here or a repo cloned
                                  with --on <computer>
  wsp computers                   your computers: this one, each box you added,
                                  each cloud account
  wsp remove <computer>           take a computer out; the box is left as
                                  wsp found it
  wsp projects                    your projects, each on its computer
  wsp new [<project>] "<work>"    a workspace: a copy of the project's computer
                                  with the project inside, named by the work
  wsp workspaces                  what you have, its project and its computer
  wsp threads [<workspace>]       who is working, in which workspace, on which
                                  computer
  wsp run <workspace> "<task>"    an agent works in it and you read its reply
  wsp send <thread> "<message>"   the thread's next message
  wsp stop <thread>               end the thread's running turn
  wsp pause <workspace>           sleep it now; an idle one sleeps by itself
  wsp wake <workspace>            wake it now; run and send wake it anyway
  wsp delete <workspace>          gone; the project and the computer stay
  wsp status                      whether a host serves, and where
  wsp mcp                         the verbs as tools for agents on this computer

A workspace or a thread comes right after the verb. new takes the project when
you have more than one; run and send take the agent's own flags, run --help
lists them. wsp thread read <thread> prints what a thread said.
Sleeping is automatic. ${HOST_STARTS_ITSELF}

wsp up                 serve a host in this terminal, to watch it
wsp down               stop it
wsp login              sign this computer in to your account
wsp logout             sign it out; wsp logout <id> signs another out
wsp hosts              the hosts you can reach, the one lines take marked
wsp <verb> --help      the verb's own flags
wsp --help agent       the verbs your agents use
wsp host --help        a host outside your account: pair, connect, link
wsp --version
`;


export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  /** Raw text on stderr, no newline added: a reply as it streams in. */
  stream?(text: string): void;
  /** Where a list that refreshes where it stands redraws: raw writes to stdout and the width to count wrapped rows
   * at, both off that one stream. Present only where stdout is a terminal, so a line that takes --watch reads its
   * absence as there being nothing to redraw on. */
  redraw?: Redraw;
  /** The same text, standing back from the reply it sits beside, as far as the stream's colours go; absent leaves it plain. */
  muted?(text: string): string;
  /** A yes-or-no question; resolves to "yes" or "no". */
  ask(question: string): Promise<string>;
  /** A person is at the keyboard (stdin and stdout are terminals); absent means an agent or a pipe, and nothing is asked. */
  isTTY?: boolean;
  /** What the stream writes and what log prints land in front of the same eyes (stdout and stderr are both
   * terminals), so text the stream has already shown is not printed a second time under it. Absent, the two part:
   * stdout carries the answer whole and the stream is somebody else's view of the work. */
  sameScreen?: boolean;
  /** A key, typed without echo. Lines after the first are shown under the question. `variable` is what a caller
   * with no terminal is told to set instead, so a refusal in a service log names the key to put in a file rather
   * than saying it. */
  askSecret(question: string, variable?: string): Promise<string>;
  /** One of a set of answers, typed while something else is running: the answer, or nothing when `until` settles
   * first, which is the question being answered somewhere else or going with what asked it. Absent where nobody is
   * at the keyboard, and a caller that reads it absent says the other road to answer on instead. */
  answerKey?(accept: readonly string[], until: Promise<unknown>): Promise<string | undefined>;
}

export type { Keys } from "./env-keys.js";

export interface KeySources {
  env: Record<string, string | undefined>;
  cwd: string;
  /** The state file this run serves. The third layer is the .env beside it, so a host on another state file reads
   * no key of the wsp home's and makes no request with one it was never given. */
  statePath: string;
  /** Whether the provider takes a key, the one check the app's keys step also runs. Absent means this computer can
   * answer nothing about a key, so nothing is checked and nothing is refused for it; `keySources` always carries it,
   * and a test hands over its own answer through the same field. */
  checkKey?(key: string): Promise<KeyCheck>;
}

// The hosts file sits under the same home, so where that home is lives beside it and is re-exported here for every
// reader that already had it from the command line.
export { wspHome };

type Stream<T> = T & { isTTY?: boolean };

/** Questions are clack prompts on the terminal; off a terminal there is nobody to answer them. */
export function terminalIO(input: Stream<Readable> = process.stdin, output: Stream<Writable> = process.stdout): CliIO {
  const screen = input.isTTY === true && output.isTTY === true;
  const nobodyLine = (q: string, variable?: string): string => `${q.split("\n")[0]}: no terminal to ask on; set ${variable ?? "it"} in ${KEY_LAYER_WORDS}.`;
  const nobody = (q: string): Promise<never> => Promise.reject(new Error(nobodyLine(q)));
  // A secret nobody can type is a missing key, the contract's auth class; a yes-or-no nobody can answer is not.
  const noKey = (q: string, variable?: string): Promise<never> => Promise.reject(authRefusal(nobodyLine(q, variable)));
  // The first line of a question is the question; the lines under it are its hint.
  const split = (q: string): PromptOptions => {
    const nl = q.indexOf("\n");
    return nl < 0 ? { message: q, input, output } : { message: q.slice(0, nl), hint: q.slice(nl + 1), input, output };
  };
  const answered = async <T>(prompt: Promise<T | symbol>): Promise<T> => {
    const value = await prompt;
    if (isCancel(value)) throw new Error("Nothing was changed.");
    return value as T;
  };
  return {
    log: line => console.log(line),
    error: line => console.error(line),
    stream: text => process.stderr.write(text),
    ...(isTTY(output) ? { redraw: { write: (text: string) => void output.write(text), columns: () => widthOf(output, Infinity) } } : {}),
    muted: text => muted(text, colourDepth(isTTY(process.stderr))),
    isTTY: screen,
    sameScreen: isTTY(output) && isTTY(process.stderr),
    ask: q => (screen ? answered(confirmPrompt(split(q))).then(yes => (yes ? "yes" : "no")) : nobody(q)),
    askSecret: (q, variable) => (screen ? answered(passwordPrompt(split(q))) : noKey(q, variable)),
    ...(screen ? { answerKey: (accept: readonly string[], until: Promise<unknown>) => readAnswerKey(input, accept, until) } : {}),
  };
}

/** One of a set of answers typed at the terminal while a turn streams beside it. The line is read as the terminal
 * gives it, never in raw mode: a turn a person may be watching for an hour must keep the ctrl-c the terminal itself
 * turns into a signal, and a raw read swallows it. A word outside the set is ignored and the question stands. */
function readAnswerKey(input: Stream<Readable>, accept: readonly string[], until: Promise<unknown>): Promise<string | undefined> {
  return new Promise(resolve => {
    const done = (value: string | undefined): void => {
      input.off("data", onData);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const typed = String(chunk).trim().toLowerCase();
      if (accept.includes(typed)) done(typed);
    };
    input.on("data", onData);
    input.resume();
    void until.then(() => done(undefined));
  });
}

/** What an init under --json speaks through: stdout carries the objects alone, so every line the run says goes to
 * stderr beside them, and a key that is not in the environment or a .env file is an error rather than a prompt on a
 * stream nobody is reading. */
export function jsonCliIO(err: Writable = process.stderr): CliIO {
  const say = (line: string): void => void err.write(`${line}\n`);
  const nobodyLine = (q: string, variable?: string): string => `${q.split("\n")[0]}: --json asks nothing; set ${variable ?? "it"} in ${KEY_LAYER_WORDS}.`;
  const nobody = (q: string): Promise<never> => Promise.reject(new Error(nobodyLine(q)));
  const noKey = (q: string, variable?: string): Promise<never> => Promise.reject(authRefusal(nobodyLine(q, variable)));
  return { log: say, error: say, stream: text => void err.write(text), ask: nobody, askSecret: noKey };
}

/** Where a key is read from, in the order they win: this process's environment, then ./.env, then the .env beside
 * the state file this run serves. The first two are the shell's and the checkout's, named by whoever typed the
 * line; the third is the host's own, which moves with --state as everything else a host writes for itself does. */
function keyLayers(sources: KeySources): Array<Record<string, string | undefined>> {
  return [sources.env, parseEnvFile(join(sources.cwd, ".env")), parseEnvFile(envFileFor(sources.statePath))];
}

/** Where a key is read from on this computer: the environment the run picks its provider out of, the folder it runs
 * in, and the state file it serves. One answer, so a test can hand a different one through the same field rather
 * than move the process. */
export function keySources(env: ProviderEnv, statePath: string): KeySources {
  // The key is put to the provider this run is wired to, under that row's own variable: a person who named a
  // provider is typing that provider's key, whatever another row would have been taken by.
  return { env, cwd: process.cwd(), statePath, checkKey: key => checkProviderKey(providerBackendFor(providerEnvWithKey(env, key))) };
}

/** The environment a run picks its provider out of, as this computer stands now: the run's own with the command
 * line's words already in it, and every registered row's key variable taken from the three layers. */
function providerEnvNow(env: ProviderEnv, statePath: string, cwd: string = process.cwd()): ProviderEnv {
  return providerEnvWith({}, env, keyLayers({ env, cwd, statePath }));
}

/** How many keys one run takes before it stops asking: a mistyped key is worth another go, an endless prompt is not. */
const KEY_TRIES = 3;

/** What no provider key means for the command that asked. `refuse` is the road every command that needs a machine
 * takes: nothing it does has any meaning without one. `offer` is wsp init's: at a terminal the key is asked for with
 * the way to skip it, and an empty answer takes the local road, since this computer is a workspace of its own. `local`
 * is the road of up, up --service and doctor --local: init already answered, so nothing is asked and
 * the run goes on with no provider. */
export type NoProviderKey = "refuse" | "offer" | "local";

/** What a run reads its keys as: the agents' keys, and the environment its provider is picked out of, carrying
 * every registered row's key variable as the layers hold it and whatever this run was told to type. */
export interface LoadedKeys {
  keys: Keys;
  env: ProviderEnv;
}

export async function loadKeys(
  io: CliIO,
  sources: KeySources,
  ask: { anthropic: boolean; noSolari?: NoProviderKey; checkSaved?: boolean } = { anthropic: true },
): Promise<LoadedKeys> {
  const ownEnv = envFileFor(sources.statePath);
  const layers = keyLayers(sources);
  const env = providerEnvWith({}, sources.env, layers);
  // The row this run is wired to, which is the only one it is asked about: the variable it reads its key from is
  // the one named on the screen, written to the file and put to the provider.
  const row = providerKeyRow(env);
  const keyEnv = row?.keyEnv;
  const held = keyEnv === undefined ? undefined : keyIn(env, keyEnv);
  let anthropic = keysFound(sources, layers).anthropic;
  const loaded = (key: string | undefined): LoadedKeys => ({
    keys: anthropic !== undefined ? { anthropic } : {},
    env: keyEnv === undefined ? env : { ...env, [keyEnv]: key },
  });
  /** The provider's refusal of a key, in the words the app's keys step uses, or nothing. Only a refusal counts: a
   * check nothing answered says nothing about the key, so it is taken and the build says its own piece if it must. */
  const refusalOf = async (key: string, saved: boolean): Promise<string | undefined> => {
    if (sources.checkKey === undefined || row === undefined) return undefined;
    const check = await sources.checkKey(key);
    return check.state === "refused" ? keyCheckLine(check, row.id, saved) : undefined;
  };
  // The key a run is about to build with is put to the provider here, so a key it refuses is typed again on this run
  // rather than stopping the build on the far side of the confirm. Every other verb takes a saved key as it stands:
  // one of them on a computer with no road out would otherwise refuse to do work that needs no provider at all.
  let refusedSaved: string | undefined;
  if (held !== undefined) {
    refusedSaved = ask.checkSaved === true ? await refusalOf(held, true) : undefined;
    if (refusedSaved === undefined) return loaded(held);
  }
  // No key on this computer and either a road init already answered, nobody at a keyboard to type one, or a
  // provider that reads no key at all: the local road is taken without a question. Every other command still
  // refuses through its IO's own words below. The Claude key rides on either way: it is the agents' key, not the
  // provider's, and a local thread uses it as a fork would.
  // A refused key is never quietly dropped for the local road: nobody asked for this computer, the provider did.
  if (refusedSaved !== undefined && io.isTTY !== true) throw authRefusal(refusedSaved);
  if (keyEnv === undefined || ask.noSolari === "local" || (ask.noSolari === "offer" && io.isTTY !== true)) return loaded(undefined);

  // Not wrapped: the CLI's IOs already refuse a secret as the contract's auth class, so a caller with no terminal
  // to type one on exits on that code rather than on a generic failure.
  const where = row?.keyConsole !== undefined ? `\n${row.keyConsole}` : "";
  const skip = ask.noSolari === "offer" ? `\nEnter with nothing skips the cloud: ${THIS_COMPUTER} alone becomes your workspace, and nothing is sealed.` : "";
  // The variable is said once, on the line that says where a key goes so this screen is not drawn again.
  let why = refusedSaved ?? `No ${keyEnv} in ${KEY_LAYER_WORDS}.`;
  let key: string;
  for (let attempt = 1; ; attempt++) {
    const typed = (await io.askSecret(`${row?.keyName ?? keyEnv}\n${why}${where}${skip}`, keyEnv)).trim();
    if (!typed) {
      if (ask.noSolari === "offer") return loaded(undefined);
      throw authRefusal(`${keyEnv} is needed to start.`);
    }
    // Checked before it is written, so a key the provider refuses never reaches the file the whole setup reads.
    const refused = await refusalOf(typed, false);
    if (refused === undefined) {
      key = typed;
      break;
    }
    if (attempt >= KEY_TRIES) throw authRefusal(refused);
    why = refused;
  }
  const set: Record<string, string> = { [keyEnv]: key };

  if (anthropic === undefined && ask.anthropic) {
    const typed = (
      await io.askSecret("Anthropic API key\noptional, enter skips\nOn a Claude subscription, skip this and sign in with /login on the machine instead.", ANTHROPIC_KEY)
    ).trim();
    if (typed) {
      anthropic = typed;
      set[ANTHROPIC_KEY] = typed;
    }
  }

  if ((await io.ask(saveQuestion(dirname(sources.statePath), Object.keys(set).length))) === "yes") writeEnvFile(ownEnv, set);
  return loaded(key);
}

/** The agents' keys as the environment and the files hold them now, asking nothing: what a serving host reads when
 * the init job asks, and where loadKeys starts before it asks. */
export function keysFound(sources: KeySources, layers: Array<Record<string, string | undefined>> = keyLayers(sources)): Keys {
  const anthropic = layers.map(l => keyIn(l, ANTHROPIC_KEY)).find(v => v !== undefined);
  return anthropic !== undefined ? { anthropic } : {};
}

/** What the vault hands every turn, read at each launch off the .env beside the state file this host serves and
 * nothing else. Not this shell: a host serving under launchd, and the app, start without it, so a key only in a
 * shell would reach the turns one road launched and none of the others. Not a folder's .env either: the folder a
 * host happened to start in is nobody's vault. The one file is what wsp init writes and what the person can read,
 * and a token saved there while the host runs is in the next turn, since nothing of this is cached. The servers'
 * values beside it come too, under the names their definitions on other computers read. */
export function vaultNow(statePath: string): Record<string, string> {
  return { ...serverValuesOf(parseEnvFile(serverEnvFileFor(statePath))), ...vaultOf(savedEnv(statePath)) };
}

/** Names the file only when the state file this run serves is not the default home's. */
export function saveQuestion(folder: string, keys: number): string {
  const what = keys > 1 ? "keys" : "key";
  return folder === DEFAULT_HOME ? `Save the ${what} so wsp stops asking?` : `Save the ${what} to ${join(folder, ".env")} so wsp stops asking?`;
}

/** What every golden wsp init seals is made of: the harness install and its smoke from the doctor, the daemon
 * bundle deploy, and the guest's own variables. No sign-in is among them. */
export function goldenRecipe(hooks: { deployDaemon?: (machine: Machine) => Promise<void | string> } = {}): GoldenRecipe {
  return {
    setup: GOLDEN_SETUP,
    smoke: GOLDEN_SMOKE,
    envs: claudeEnvs(),
    deployDaemon: hooks.deployDaemon ?? (async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE)),
  };
}

/** The name this repository's own root package.json carries. The marker has to be something only a checkout has:
 * a `.env` is not, since wsp writes the person's provider keys into their own wsp home, and that home then read as
 * a checkout whose state nothing had ever written. */
const CHECKOUT_PACKAGE = "wsp";

/** Whether this folder is a checkout of wsp: its own root package.json names the workspace. A worktree of the
 * repository carries the same file and is one too. */
function isDevCheckout(cwd: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return (parsed as { name?: unknown } | null)?.name === CHECKOUT_PACKAGE;
  } catch {
    return false;
  }
}

/** The state a checkout of wsp marks: it shares its `.wsp` state with wspx. One spelling of the rule, since the bin
 * and the desktop both apply it. */
export function devCheckoutState(cwd: string): string | undefined {
  return isDevCheckout(cwd) ? join(cwd, ".wsp", "state.json") : undefined;
}

/** Which state a line runs against, and what a person should be told about the choice. */
export interface StatePick {
  path: string;
  /** The one line stderr gets when a state the person named passed over a .env beside the code. */
  note?: string;
}

const passedOverLine = (chosen: string, by: string, cwd: string, dev: string): string =>
  `this runs against ${chosen}, named by ${by}; the checkout in ${cwd} marks ${dev}, which this run does not use.`;

/** The state file a run works on. A state the person chose wins: --state first, then WSP_HOME, since a state
 * somebody named is never taken off them by a file they did not name, and the choice is said out loud when a
 * checkout named another. A checkout marks its own state only when nothing else names one, and anywhere
 * else it is the home whose host is serving, so a line typed with no flags on a computer whose host runs under a
 * moved home reaches that host rather than a state file nothing serves. */
export function statePick(flag?: string, cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): StatePick {
  const dev = devCheckoutState(cwd);
  const home = homeNamed(env["WSP_HOME"]);
  const named = flag !== undefined ? { path: flag, by: "--state" } : home !== undefined ? { path: join(home, "state.json"), by: "WSP_HOME" } : undefined;
  if (named === undefined) return { path: dev ?? join(servingHome(env), "state.json") };
  if (dev === undefined || realState(resolve(cwd, dev)) === realState(resolve(cwd, named.path))) return { path: named.path };
  return { path: named.path, note: passedOverLine(resolve(cwd, named.path), named.by, cwd, dev) };
}

/** The state file a run that names none works on. */
export function defaultStatePath(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  return statePick(undefined, cwd, env).path;
}

/** The state file a command works on, absolute so the lock, the token and the recipe beside it name one path
 * whatever the cwd is; a caller with somewhere to say it hears which state won where two readings disagreed. */
function statePathFrom(flag?: string, env: Readonly<Record<string, string | undefined>> = process.env, note: (line: string) => void = () => {}): string {
  const pick = statePick(flag, process.cwd(), env);
  if (pick.note !== undefined) note(pick.note);
  return resolve(pick.path);
}

/** The folder every turn and every exec on this computer starts in, made when it is first used. Not the person's
 * home: a turn that starts there is one `cd` from the checkouts they work in themselves, and the first build thread
 * run on a local workspace committed inside the person's own repo from there (measured 2026-09-08). Their own
 * folders stay reachable, as they are to any shell they open, but nothing starts a turn in one. */
export const localWorkFolder = (home: string): string => join(home, "wsp-work");

/** How this host starts the daemon for its local workspace. Behind a parameter so a test can hand one that refuses
 * to start; the default loads the daemon module on the first dial, so a host nobody opens a pane on loads none of it. */
export type LocalDaemonStart = (opts: LocalDaemonOptions) => Promise<LocalDaemon>;

/** This computer as a workspace: the local backend, a real child process per turn under the turn's limits, each
 * harness's own store (the one their store variable names, else the default under the person's home), and the
 * person's own login environment for every turn, the same one wsp exec runs under, so the keys and tools a terminal
 * gives an agent reach it here too. The adapters strip their own agent-session variables from it, as they do on a
 * fork. The person's home and the folder work starts in are two facts: the stores are theirs, so a sign-in they
 * made is the one a turn uses, and the work folder is the workspace's own. */
/** The copy road this command has: the daemon binary staged beside it. A build or an install that left the daemon
 * asset out leaves this host with one workspace per project and the sentence that says so, rather than failing to
 * start. */
function copierHere(): Copier | undefined {
  try {
    return verbCopier(daemonBinaryHere());
  } catch {
    return undefined;
  }
}

export function localWiring(
  home = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  startDaemon: LocalDaemonStart = opts => import("./local-daemon.js").then(m => m.LocalDaemon.start(opts)),
  /** The state file the host this wiring belongs to serves. Every file it writes for itself sits in that file's
   * own folder, the runs, the roots file and the inbox alike, so a host on a home somebody named writes nothing
   * under the home a bare line picks. */
  statePath: string = join(defaultHomeIn(home), "state.json"),
  copier: Copier | undefined = copierHere(),
  /** Where the daemon's own stderr goes as it starts. A serving host's stderr is its log, which is where those
   * lines belong; a line at a terminal asked a question of its own and hands a sink that keeps none. */
  say: (line: string) => void = line => void process.stderr.write(`${line}\n`),
): LocalWiring {
  const root = localWorkFolder(home);
  const runDir = hostRunDir(statePath);
  const rootsPath = hostRootsPath(statePath);
  /** Every run this wiring is reading, as the call that lets go of each. A poll on a turn left running holds the
   * process after its last line, and a turn is not this wiring's to end: closing lets go and leaves them running. */
  const reading = new Set<() => void>();
  // The person whose sign-ins a turn here reads. Their login home, except under a harness serving a fixture out of
  // a home of its own: that home holds this host's files, and a turn started under it finds no sign-in at all.
  const person = homeNamed(env[PERSON_HOME_ENV]) ?? home;
  let shutting = false;
  const backend = new LocalBackend({ root, env });
  // Started on the first dial and kept: a host nobody opens a pane on starts no process, binds no port on this
  // computer and writes none of the daemon's own files under the person's home.
  const daemon = startOnce(
    () => startDaemon({ root: home, workFolder: backend.workFolder(), rootsPath, inboxDir: hostInboxDir(statePath), say }),
    why => {
      const last = why.split("\n").map(l => l.trim()).filter(l => l !== "").at(-1) ?? why;
      return cappedLine(`the daemon for this computer's workspace did not start, so its terminal, files and processes have nothing to dial: ${last}`);
    },
  );
  return {
    backend,
    execStream: (o, waiting) => localExecStream({ root: backend.workFolder(), runDir, reading, ...o }, waiting),
    home: id => agentHome(person, id, env),
    homeDir: home,
    rootsPath,
    ...(copier !== undefined ? { copier } : {}),
    // The binary the copy road runs, read off the daemon this host starts for its own workspace: a host rebuilt
    // without its binary runs beside an older one, which knows none of this wsp's verbs.
    hereDaemon: { version: async () => (await daemon.get()).version, fix: daemonFixLine(runningWsp()) },
    platform: hostPlatform(),
    env: () => ({ ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)), HOME: person }),
    sysSamples: async fn => (await daemon.get()).sysSamples(fn),
    daemonRoad: async () => {
      // The panes stay on the person's home: the files and terminal tabs are theirs to look around in, where a
      // turn's own folder is the workspace's.
      const started = await daemon.get();
      // A dial that lands while the host is closing must leave no socket behind: a listening one keeps this process up.
      if (shutting) {
        await started.close().catch(() => {});
        throw new Error("this host is closing; its local workspace has no daemon to dial");
      }
      return started.road;
    },
    // The daemon is a child of this process, so nothing but this host can put one back. The one it is holding is
    // let go of and closed first, whether it died or is merely wedged, so the next dial cannot be answered with
    // the port of a daemon that is gone.
    restartDaemon: async () => {
      const held = daemon.held();
      daemon.forget();
      await held?.then(d => d.close(), () => {});
      await daemon.get();
    },
    close: async () => {
      shutting = true;
      // The turns running here are not ended: each leads a process group of its own and reads its own log off this
      // computer, so the host that comes next re-opens them and their replies still land. What this host holds open
      // is the reading of those runs and the daemon, and that is what closing it frees.
      for (const stop of [...reading]) stop();
      reading.clear();
      const started = daemon.held();
      daemon.forget();
      await started?.then(d => d.close(), () => {});
    },
  };
}

/** The machines this computer reaches over ssh: the ssh client here dials them with the person's own key, and one
 * dial both proves a machine answers and reads what its record stands on. A record's id is the whole address, so
 * nothing at all is kept between dials.
 *
 * The daemon on such a machine is put under the login it answered with and binds that machine's own loopback, so
 * nothing there listens where the network can reach it, and this host wires no road to it. */
export function sshWiring(): SshWiring {
  return {
    backend: new SshBackend(),
    removeDaemon: (machine, login) => removeDaemon(machine, sshDaemonPlace(login)),
  };
}

/** Everything a person asked a host to serve with: the port pair and the address the one rule read off the flags,
 * the state file, and the words that only a serving host reads. `wsp up --service` writes its unit out of this, so
 * what the service starts is the line that was typed. */
export interface ServeAsked extends ListenAsked {
  statePath: string;
  /** The address the person named with --advertise, as they named it: the address every machine dials this host
   * at, whatever kind it is. Absent leaves each kind to answer for its own machines, which is the default, so only
   * a word the person typed is spelled back into a service's unit. */
  advertise?: string;
  /** The machine provider this host forks on, as `--provider` named it. */
  provider?: string;
  /** Whether a box linked to a relay runs its connector; false is `--no-relay`. */
  relay?: boolean;
}

/** A flag of the line a host serves on: how the shared parse reads it, and the words it is spelled back as. The
 * parse and the service's unit both come out of this one table, so a flag that shapes a serving host cannot reach a
 * terminal run and be dropped by the service that was asked for the same line. */
interface ServeFlag {
  /** The flag's word, which is a key of the shared parse: a row cannot name one the parse would not read. */
  name: Extract<keyof SharedFlags, string>;
  option: Options[string];
  words(asked: ServeAsked): string[];
}

export const SERVE_FLAGS: readonly ServeFlag[] = [
  { name: "state", option: { type: "string" }, words: a => ["--state", a.statePath] },
  { name: "port", option: { type: "string" }, words: a => ["--port", String(a.port)] },
  { name: "ws-port", option: { type: "string" }, words: a => ["--ws-port", String(a.wsPort)] },
  { name: "listen", option: { type: "string" }, words: a => ["--listen", a.address] },
  { name: "advertise", option: { type: "string" }, words: a => (a.advertise === undefined ? [] : ["--advertise", a.advertise]) },
  { name: "provider", option: { type: "string" }, words: a => (a.provider === undefined ? [] : ["--provider", a.provider]) },
  { name: "no-relay", option: { type: "boolean" }, words: a => (a.relay === false ? ["--no-relay"] : []) },
];

/** The serving flags as the parser takes them. */
const SERVE_OPTIONS: Options = Object.fromEntries(SERVE_FLAGS.map(flag => [flag.name, flag.option]));

/** What every command of the shared parse works on: what was asked of a serving host, the home the hosts file sits
 * under, and the environment the run was made in. wsp up and wsp init take theirs from this one call. */
export interface SharedOpts extends ServeAsked {
  home: string;
  /** The environment this run picks its machine provider out of: the one the caller runs in, with the provider
   * words the command line was given in front of it. */
  providerEnv: ProviderEnv;
  /** The environment the caller runs in, as given: what reads WSP_HOST and the pair a turn's launch left, so a
   * command decides where a line is aimed from the run's own environment rather than this process's. */
  env: Readonly<Record<string, string | undefined>>;
  /** What brings a host up when none serves this state file, as the verbs are handed one. Set by the run, not by
   * the flags, and read only by the words whose work is the host's; absent leaves a line to read the refusal. */
  start?: HostStarter;
}

/** The environment the caller runs in decides the home, the same reading the verbs take, so a run with its own
 * environment cannot send wsp hosts to one folder and --host to another. It is also what the provider words
 * stand in front of, so one run picks its folder and its provider out of the same environment. */
export function optsFor(
  values: Pick<SharedFlags, "port" | "ws-port" | "listen" | "advertise" | "state" | "provider" | "no-relay">,
  env: Readonly<Record<string, string | undefined>> = process.env,
  note: (line: string) => void = () => {},
): SharedOpts {
  const asked = portsAsked({ port: values.port, wsPort: values["ws-port"], listen: values.listen });
  const advertise = advertiseWord(values.advertise);
  const provider = values.provider !== undefined ? { provider: values.provider } : {};
  // The state file first: every verb's environment is built off the .env beside it, so a run under --state carries
  // no key and no pick of the live home's.
  const statePath = statePathFrom(values.state, env, note);
  return {
    ...asked,
    ...(advertise !== undefined ? { advertise } : {}),
    ...provider,
    ...(values["no-relay"] === true ? { relay: false } : {}),
    statePath,
    home: wspHome(env),
    env,
    providerEnv: providerEnvWith(provider, env, keyLayers({ env, cwd: process.cwd(), statePath })),
  };
}

/** The state files a host on this computer could be serving: the one this run works on and this computer's default,
 * read so a port one of them holds is named as that host rather than as a bare node process. */
export function statesHere(statePath: string): string[] {
  return [...new Set([statePath, resolve(defaultStatePath())])];
}

/** The provider slot each runtime made here was wired with, so a host can swap the module in when a key is saved. */
const PROVIDER_SLOTS = new WeakMap<Runtime, ProviderSlot>();
/** The provider pick each runtime made here stands on: the module it forks on now, which names the place its copies
 * are filed under, and the environment that module was picked out of, which is also where the other places this
 * host can build at are read from. A swap moves both, so the backend, the place and the table never say different
 * things. */
const PROVIDER_PICKS = new WeakMap<Runtime, ProviderPick>();
interface ProviderPick {
  id: string;
  env: ProviderEnv;
}
export const providerSlotOf = (rt: Runtime): ProviderSlot | undefined => PROVIDER_SLOTS.get(rt);

/** Wires the provider module the keys now on this computer name into a runtime made here, picking out of the same
 * environment that runtime was built from; a runtime made elsewhere has no slot, and a saved key it would do
 * nothing with is refused rather than taken. The saved record stands in front of that environment on purpose: this
 * is the road the app's keys step takes, where the key just written is the answer and the shell the host started in
 * is the older one. Every other road reads the layers, where the environment wins. */
export function swapProvider(rt: Runtime, keys: Readonly<Record<string, string | undefined>>): void {
  const slot = providerSlotOf(rt);
  if (slot === undefined) throw new Error("this runtime has no provider slot; a key saved now would reach no machine road until the host restarts");
  // One environment for all three: the module this host forks on, the place its copies are filed under and the
  // other places it can build at are the same pick, so they cannot drift apart when a key is saved.
  const pick = PROVIDER_PICKS.get(rt);
  const env = { ...(pick?.env ?? process.env), ...keys };
  slot.swap(providerBackendFor(env));
  if (pick !== undefined) {
    pick.id = wiredProviderId(env);
    pick.env = env;
  }
}

/** What a host serving this line tells a turn about where it answers: the address and port it binds, and the
 * address the person named with --advertise. The kind of the machine a turn runs on picks from it. */
const agentsReachOf = (opts: { address?: string; port: number; advertise?: string }): { at: { address: string; port: number }; advertise?: string } => ({
  at: { address: opts.address ?? LOOPBACK, port: opts.port },
  ...(opts.advertise !== undefined ? { advertise: opts.advertise } : {}),
});

export function makeRuntime(
  keys: Keys,
  statePath: string,
  recipe: GoldenRecipe = goldenRecipe(),
  env: ProviderEnv = process.env,
  agents?: { at?: { address: string; port: number }; advertise?: string; run?: RunningWsp; here?: HereAt },
  /** This computer as a workspace, where the caller built the wiring itself and holds a reader off it: the doctor
   * reads the daemon beside this host through the same wiring the copy road runs it from. */
  local: LocalWiring = localWiring(homedir(), process.env, undefined, statePath),
  /** The links this host holds to the computers a person joined, and the one planner the recipe on this computer
   * is read through. Built here for a caller that needs none of it back; handed in by one that reads the recipe
   * off the same planner, so the doctor and the recipe job cannot read this computer two ways. */
  links: PlaceWiring = placeWiring(statePath, agents?.advertise),
  /** The store over the state file, handed in by a caller that has already read it once: a state this build cannot
   * read is refused at every collection read, and a caller that met that refusal has said so already. */
  store: Store = jsonFileStore(statePath, stateWriterHere()),
  /** The agents a turn runs; a test hands in stand-ins so no real agent starts. */
  adapters: Record<string, HarnessAdapterFactory> = HARNESS_ADAPTERS,
): Runtime {
  const slot = providerSlot(providerBackendFor(env));
  // The place this host's copies are filed under is the provider module it forks on, read at each call: a host that
  // starts with no key swaps its module in when one is saved, and its copies belong to the module that made them.
  const pick: ProviderPick = { id: wiredProviderId(env), env };
  const rt = createRuntime({
    places: providerPlaces(
      () => pick.id,
      slot.backend,
      () => pick.env,
    ),
    backend: slot.backend,
    // What a turn's own agent needs to reach back in: what this host knows about where it answers, which each kind
    // reads for its own machines, and the same wsp command an agent's config on this computer is given, so a thread
    // on the local workspace and one on a fork run the same wsp against the same host.
    agents: {
      ...(agents?.at !== undefined ? { reach: hostReach(agents.at, agents.advertise, () => publicHostname(statePath), undefined, agents.here) } : {}),
      wspMcp: mcpServerCommand(agents?.run ?? runningWsp()),
    },
    local,
    ssh: sshWiring(),
    // The provider row off the same pick the slot and the table stand on, so a key saved while this host serves
    // makes its provider a place on every screen at once.
    placeLinks: { ...links, provider: () => wiredPlaceRow(pick.env, slot.current()) },
    // The build this host is, written into the state file at every save, so a host that meets a record it cannot
    // read says which wsp on this computer wrote it.
    store,
    statePath,
    adapters,
    // Read at every launch, never copied: a token minted after this host started is in the next turn, and nothing
    // of it is written to a machine.
    vault: () => vaultNow(statePath),
    // The same vault stands behind the sign-in word of an agent whose own login is not on the computer read.
    // Each agent's newest version is asked of its vendor from this host, never from a machine, and kept a day.
    agentsReader: agentsReader({ vault: () => vaultNow(statePath), loginEnv, latest: agentLatest({ statePath, running: VERSION }).read }),
    // A key pasted in the app lands in the same vault, and the wsp tools an agent's config gets are the entry an
    // install writes: this same wsp against this state file.
    agentsActs: hostActs({ vaultFile: envFileFor(statePath), home: homedir, wspServer: () => mcpServerSpec(statePath, agents?.run ?? runningWsp()) }),
    // skills.sh is asked from this host and never from the page; a skill lands as the login of the computer it is for.
    skillsActs: skillsActs(),
    // A server lands in the agent's own config as the login of the computer it is for: its values in that file on
    // this computer, and on any other the file names a variable for each and the value goes to the vault.
    serversActs: serversActs({ vault: serverVault(statePath) }),
    // A remote server's icon is asked of Google from this host, never from the page or a machine, and kept beside the
    // state file.
    serverIcons: serverIcons({ dir: join(dirname(statePath), "icons") }),
    // How a folder on this computer is read and packed to seed a project elsewhere: the collector's own menu over
    // this computer, and the host's pack of whichever rows the person ticked.
    seed: hostSeed(),
    goldenRecipe: recipe,
    copyRecipe: hostCopyRecipe(statePath),
    hostId: hostIdentity(),
    vaultCaches: CACHE_RULE,
  });
  PROVIDER_SLOTS.set(rt, slot);
  PROVIDER_PICKS.set(rt, pick);
  return rt;
}

/** The seed half of an add on this computer: the menu off git's own listing of what a folder ignores, and the
 * archive of the rows the person ticked. Both read the person's folder and Claude Code's store here, so the state
 * home is read the one way every road on this computer reads it. */
function hostSeed(): SeedWiring {
  const claudeStateHome = (): string => agentHomes(homedir(), process.env)["claude"] ?? join(homedir(), ".claude");
  return {
    plan: folder => seedMenu(nodeHost(), folder, { claudeStateHome: claudeStateHome() }),
    pack: o => packSeed({ ...o, claudeStateHome: claudeStateHome() }),
  };
}

/** How a copy of the image is planned on this computer for a serving host: the same readers wsp init builds from,
 * the keys as they stand at the ask rather than at the start, and the daemon deploy every build made here gets. */
function hostCopyRecipe(statePath: string): (image: SealedImage) => Promise<GoldenRecipe> {
  return image =>
    copyGoldenRecipe(image, {
      collect: () => collectThisComputer(() => {}),
      brew: () => readBrewTable(nodeHost()),
      home: homedir(),
      platform: hostPlatform(),
      vault: serverVault(statePath),
      deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE),
    });
}

/** The init job on this computer for a serving host: wsp init's own readers and build pieces, the keys read off the
 * .env beside the state file this host serves and nothing else at each ask (a key in this process's environment or
 * a checkout's .env is the terminal's and never reads as saved on a screen), the provider module swapped into the
 * runtime once a key is saved, and the wsp tools written by the road wsp mcp install takes, under the command this
 * process runs as. */
function hostInitDoor(rt: Runtime, statePath: string, run: RunningWsp, openUrl: UrlOpener, log: (line: string) => void, providerEnv: ProviderEnv): InitJobs {
  const home = homedir();
  const os = hostPlatform();
  return new InitJobs({
    rt,
    statePath,
    home,
    platform: os,
    saved: () => savedEnv(statePath),
    saveKeys: set => writeEnvFile(envFileFor(statePath), set),
    provider: saved => swapProvider(rt, saved),
    keysHeld: saved => Object.fromEntries(Object.entries(providerKeyRows()).map(([id, name]) => [id, keyIn(saved, name) !== undefined])),
    keySet: (key, provider) => providerKeySet(providerEnv, key, provider),
    keyProvider: () => providerKeyRow(providerEnv)?.id,
    // Read at each ask, as the pricing below is, and out of the same layers: a key saved while this host serves
    // swaps its module in, and a run beside it is told the provider it forks on now.
    forksOn: () => wiredProviderId(providerEnvNow(providerEnv, statePath)),
    checkKey: (key, provider) => checkProviderKey(providerBackendFor(providerEnvWithKey(providerEnv, key, provider))),
    // What this host's own provider charges and gives, not one provider's table: a host that forks containers has
    // no bill and no disk cap, and the screens read both off here.
    pricing: () => providerBackendFor(providerEnvNow(providerEnv, statePath)).pricing,
    agents: () => agentsHere(nodeHost(), { versions: false }),
    installTools: agents => installEach(agents, mcpServerSpec(statePath, run), home),
    mcpServer: () => mcpServerSpec(statePath, run),
    read: {
      collect: collectThisComputer,
      recipe: (onHistory, onProject, onHistoryProgress) => computeRecipe(nodeHost(), { threadAgents: THREAD_AGENTS, onHistory, onProject, onHistoryProgress, cache: historyCache(statePath) }),
      scanProject: async folder => {
        const { path, exists } = projectFolder(folder);
        return exists ? scanProject(nodeHost(), path) : undefined;
      },
      brew: () => readBrewTable(nodeHost()),
      scan: alsoHere,
    },
    build: {
      secrets: keychainReader(),
      relay: async (buildRt, builder, hooks) =>
        startCallbackRelay({
          runtime: buildRt,
          openUrl,
          log: line => {
            if (!hooks.onLine(line)) log(line);
          },
          autoOpen: hooks.autoOpen,
          openLine: hooks.openLine,
          builder,
        }),
      roads: () => workspaceRoads(rt, agentHomes(home), workspaceEnvsFor()),
      recipe: recipe => ({ ...recipe, deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE) }),
      bundleFile: () => missingBundleFile(),
    },
  });
}

/** With --json stdout carries the objects alone, so every line the run says moves to stderr beside it. */
export function terminalInitIO(json = false): InitIO {
  const os = platform();
  return {
    input: process.stdin,
    output: json ? process.stderr : process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
    open: systemOpener(os),
    signals: process,
    exit: code => process.exit(code),
    atExit: fn => void process.once("exit", fn),
    ...(json ? { json: (record: Record<string, unknown>) => void process.stdout.write(`${jsonLine(record)}\n`) } : {}),
  };
}

/** The collector's ladder over this laptop; onRung lets the terminal count rows as each rung lands. */
function collectThisComputer(onRung: (rung: Rung, rows: number) => void): Promise<Manifest> {
  return collect(nodeHost(), { onRung });
}

/** The signals a serving host stops on. It is the only owner of them: nothing under it registers a handler of its
 * own, so no other listener can end this process while a close runs. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** What a stop needs of the process it is ending: where signals arrive and how it exits. The default is this
 * process; a test hands in its own, since a real signal would take the test runner with it. */
export interface StopProcess {
  on(signal: (typeof STOP_SIGNALS)[number], listener: () => void): unknown;
  exit(code: number): void;
}

/** Every way a host is told to go ends the same: the lock removed and what this host holds open freed. The turns
 * running on this computer are not among them; each leads a process group of its own, so no signal arriving here
 * reaches one, and the host that comes next re-opens it. A hangup is one of these signals for that reason, and none
 * of them is left to node's default exit, which runs no close at all: a second signal, with a close still in
 * flight, exits at once, so a close that hangs cannot trap the terminal. */
export function stopOnSignals(handle: HostHandle, io: CliIO, self: StopProcess = process): void {
  let stopping: Promise<void> | undefined;
  const stop = (sig: (typeof STOP_SIGNALS)[number]): void => {
    if (stopping !== undefined) {
      self.exit(exitCodeOf(sig));
      return;
    }
    stopping = handle.close().then(
      () => self.exit(0),
      (e: unknown) => {
        io.error(`host close failed: ${e instanceof Error ? e.message : String(e)}`);
        self.exit(1);
      },
    );
  };
  for (const sig of STOP_SIGNALS) self.on(sig, () => stop(sig));
}

/** Where an error nothing caught arrives. The default is this process; a test hands in its own, since either event
 * on the real one would take the test runner with it. */
export interface UncaughtProcess {
  on(event: "unhandledRejection" | "uncaughtException", listener: (e: unknown) => void): unknown;
}

/** A serving host says an error nothing caught in one line and stays. Node's default ends the process on either,
 * and this process is every socket the host holds and every link it keeps to a machine, so a frame in a shape no
 * door read, or a promise a handler let go, would otherwise end all of it with nothing said. Installed only once a
 * host serves: a verb that runs and returns keeps the default, since its exit code has to say it failed. */
export function stayOnUncaught(io: CliIO, self: UncaughtProcess = process): void {
  self.on("unhandledRejection", e => io.error(`unhandled rejection, kept serving: ${verbFailure(e).error}${faultSite(e)}`));
  self.on("uncaughtException", e => io.error(`uncaught exception, kept serving: ${verbFailure(e).error}${faultSite(e)}`));
}

/** Where an error the host kept serving through came from, as the first frame of its stack, so the fault can be
 * found in the log; a thrown value with no stack names nothing. */
function faultSite(e: unknown): string {
  const frame = e instanceof Error ? e.stack?.split("\n").map(line => line.trim()).find(line => line.startsWith("at ")) : undefined;
  return frame === undefined ? "" : `, ${frame}`;
}

/** A folder a `~/`-relative answer or a flag named: where it is, and whether there is one there. The one place both
 * the flag and the wizard's own question resolve a folder. */
export function projectFolder(folder: string): { path: string; exists: boolean } {
  const path = resolve(expand({ home: homedir() }, folder.trim()));
  return { path, exists: existsSync(path) };
}

/** What a --project flag named: the folder, nothing when the flag was not given, or the sentence to print, since a
 * folder that is not there is a typo and not an empty project. */
type ProjectFlag = { ok: true; path?: string } | { ok: false; message: string };

function projectFlag(verb: string, folder: string | undefined): ProjectFlag {
  if (folder === undefined) return { ok: true };
  const { path, exists } = projectFolder(folder);
  return exists ? { ok: true, path } : { ok: false, message: `wsp ${verb}: no folder at ${path}` };
}

/** One state file has one writer, and while a host serves it that writer is the host: a run beside one asks its
 * screens here and builds through the host's init job. This is what is left when that door cannot take the build,
 * and it names the road that needs no pid first, since the host on a box is a service nobody can Ctrl-C. */
function initRefusal(lock: HostLock, statePath: string, why: string): string {
  return `wsp init: the wsp host serving ${statePath} (pid ${lock.pid}) cannot take this build: ${why}. Take it down first (wsp down for a service, Ctrl-C in its terminal or kill ${lock.pid} for one started by hand), run wsp init again and start it again, or point --state at a different file.`;
}

/** A serving host that can start no build: its init job would refuse at the first stage, so the run says so before
 * it reads this computer, in the host's own sentence for why. The places are the host's, not this terminal's: it is
 * the process that builds. */
function noGoldenThroughHost(lock: HostLock, statePath: string, why: string): string {
  return `wsp init: the wsp host serving ${statePath} (pid ${lock.pid}) can build no image: ${why}. Then run wsp init again.`;
}

/** What the run reads off the host serving this state before it asks anything: the door to build through, the place
 * the image is built on and what a builder there costs, and where the app it already serves answers. */
interface BesideHost {
  client: HostClient;
  place: { id: string; name: string };
  pricing: InitPricing;
  /** The provider that host forks on, which no flag of this run's can move; absent on a host of an earlier build,
   * which does not say. */
  forksOn?: string;
  /** Where the app that host already serves answers. */
  at: ServedAt;
}

/** The refusal a provider named on this line meets beside a serving host: that host runs the build, on the provider
 * it forks on, and a word on this line reaches no runtime of this run's. Nothing where it already forks where the
 * line names, which is the build that was asked for, and nothing where the host does not say which provider it is.
 * The word is compared and not the name typed, so a stand-in named for a cloud reads as that cloud on both sides.
 * The way back is this run's own wsp up line, composed where every other one this file hands over is, so it names
 * the state file, the ports and the provider as they were typed rather than the provider alone. */
export function providerBesideRefusal(lock: HostLock, opts: SharedOpts, forksOn: string | undefined, upCommand: string): Error | undefined {
  const given = opts.provider;
  if (given === undefined || forksOn === undefined || forksOn === wiredProviderId(opts.providerEnv)) return undefined;
  return usageRefusal(
    `wsp init: the wsp host serving ${opts.statePath} (pid ${lock.pid}) runs this build and forks on ${forksOn}, not ${given}`,
    `Drop --provider, or take that host down and start it again with ${upCommand}.`,
  );
}

/** Opens the door of the host serving this state, or refuses with the way back that needs no pid. The place, the price
 * and the builder disk come from that host: it owns the places, so a terminal that named none (or another) still
 * asks the person about the machine the build will really boot. `on` is the place --on named; absent, the host's
 * default place. `upCommand` is the wsp up line this run was given, which the provider refusal hands over. */
async function besideHost(lock: HostLock, opts: SharedOpts, upCommand: string, on?: string): Promise<BesideHost> {
  const statePath = opts.statePath;
  const refuse = (why: string): Error => Object.assign(new Error(initRefusal(lock, statePath, why)), { kind: "conflict" });
  let client: HostClient;
  try {
    // The host holding this state file's lock and no other: WSP_HOST and the account's one host aim a verb at another
    // computer, and the build belongs to the process that writes this file.
    // No starter is handed in: the lock was read before this call, and an init that started a host under itself
    // would be building through a host it is about to replace.
    client = await dialHost(statePath, { aim: { kind: "here" } });
  } catch (e) {
    throw refuse(e instanceof Error ? e.message : String(e));
  }
  try {
    const setup = InitSetup.parse((await client.request<{ setup: unknown }>("init.get", on === undefined ? {} : { on })).setup);
    // Before anything this run judges about that host: a provider this build cannot land on is the person's own to
    // fix, whether or not the host could build at all, so they read the word they typed and not a second round. A
    // place --on named that the host cannot build at is refused by the request above, and is read before this one.
    const refused = providerBesideRefusal(lock, opts, setup.forksOn, upCommand);
    if (refused !== undefined) throw refused;
    const job = setup.job;
    if (job !== null && !initJobOver(job.phase)) throw refuse(`a setup is already running there (${job.phase})`);
    if (setup.pricing === null || setup.place === undefined) throw Object.assign(new Error(noGoldenThroughHost(lock, statePath, setup.buildRefusal ?? NO_BUILD_PLACE_LINE)), { kind: "conflict" });
    const price = setup.pricing;
    return {
      client,
      place: setup.place,
      pricing: { rateUsdPerHour: () => price.rateUsdPerHour, defaultSize: price.size, ...(price.builderDiskGb !== undefined ? { builderDiskGb: price.builderDiskGb } : {}) },
      ...(setup.forksOn !== undefined ? { forksOn: setup.forksOn } : {}),
      at: { port: lock.port, address: lock.address },
    };
  } catch (e) {
    client.close();
    throw e;
  }
}

/** The --state a later command needs to find what this init wrote, only when the init was given one. */
const stateFlag = (opts: { statePath: string }, values: Pick<SharedFlags, "state">): string[] => (values.state !== undefined ? ["--state", shellQuote(opts.statePath)] : []);

/** The wsp up that serves what this init records: the serving flags off the one table the parse and the service's
 * unit are written out of, resolved as this run resolved them and quoted for a shell to take. Only the flags the
 * init was given, so the line names what the person said and defaults stay defaults. */
export function upCommandFor(asked: ServeAsked, values: SharedFlags): string {
  const words = SERVE_FLAGS.filter(flag => values[flag.name] !== undefined).flatMap(flag => {
    const [word, ...given] = flag.words(asked);
    // The flag's own word is wsp's; everything after it is the person's and is quoted for the shell that runs it.
    return word === undefined ? [] : [word, ...given.map(shellQuote)];
  });
  return ["wsp up", ...words].join(" ");
}

/** The wsp new that forks the first workspace from what this init records, against the host wsp up starts. */
export function forkCommandFor(opts: { statePath: string }, values: Pick<SharedFlags, "state">): string {
  return ["wsp new", FIRST_WORKSPACE, ...stateFlag(opts, values)].join(" ");
}

/** The envs a new workspace forks with: Claude Code's config dir and the browser shim of the golden it forks from.
 * No sign-in among them; the vault sets the token and the key on each turn instead. */
const workspaceEnvsFor = (): { workspaceEnvs: (golden: GoldenVersion) => Record<string, string> } => ({ workspaceEnvs: golden => claudeEnvs(golden) });

/** wsp init's flags that only mean something on the golden road, each with how it was given: the local road refuses
 * them rather than take them and do nothing. One row per flag, beside the table that parses them. */
const GOLDEN_FLAGS: readonly [string, (flags: { recipe?: string; project?: string; firstWorkspace?: string; importFolder?: string; on?: string; rebuild?: boolean }) => boolean][] = [
  ["--recipe", f => f.recipe !== undefined],
  ["--project", f => f.project !== undefined],
  ["--first-workspace", f => f.firstWorkspace !== undefined],
  ["--import", f => f.importFolder !== undefined],
  ["--on", f => f.on !== undefined],
  ["--rebuild", f => f.rebuild === true],
];

/** The build handed to the host serving this state: the workspace question is asked here, where the person is, and
 * everything from the first billed machine on happens in that host's job. Its own init job forks no workspace for
 * this computer, so the tick beside the question is not offered; wsp new <name> --on this computer is that road. */
async function handOffTo(beside: BesideHost, statePath: string, screen: InitIO, interactive: boolean, flags: { yes: boolean; rebuild?: boolean; firstWorkspace?: string; importFolder?: string; on?: string }): Promise<number> {
  const step = await askFirst({
    interactive,
    unattended: !interactive,
    ...(flags.firstWorkspace !== undefined ? { name: flags.firstWorkspace } : {}),
    ...(flags.importFolder !== undefined ? { folder: resolve(flags.importFolder) } : {}),
    noLocal: true,
    platform: hostPlatform(),
    input: screen.input,
    output: screen.output,
  });
  const fork = typeof step === "symbol" ? undefined : step.fork;
  return buildBesideHost({ client: beside.client, io: screen, ...(fork !== undefined ? { fork } : {}), ...(flags.yes ? { yes: true } : {}), ...(flags.rebuild === true ? { rebuild: true } : {}), ...(flags.on !== undefined ? { on: flags.on } : {}), app: { at: beside.at, runDir: hostRunDir(statePath), interactive } });
}

/** How a line that says this computer forks nothing offers the way out of it: the variable the row a key typed here
 * would be put to, and nothing at all where no row reads a key. */
function orSetTheKey(env: ProviderEnv): string {
  const name = providerKeyRow(env)?.keyEnv;
  return name === undefined ? "" : `, or set ${name} first`;
}

async function init(
  io: CliIO,
  opts: SharedOpts,
  flags: { yes: boolean; nonInteractive: boolean; json: boolean; noLocal: boolean; rebuild?: boolean; recipe?: string; project?: string; firstWorkspace?: string; importFolder?: string; on?: string; upCommand: string; forkCommand: string },
): Promise<number> {
  if (flags.json && flags.yes) throw usageRefusal("wsp init: --json prints the sign-ins as they are handed to you, and --yes skips the sign-ins, so there would be nothing to print.", "Drop one of them.");
  await adoptLoginPath(line => io.log(line));
  const held = servingHost(opts.statePath);
  // The places are the serving host's: a run with none serving builds on its own provider and knows no other place.
  if (held === undefined && flags.on !== undefined) throw usageRefusal(`wsp init: --on names a place of the host serving ${opts.statePath}, and none is serving it.`, "Start it with wsp up and run wsp init --on again, or drop --on to build on this computer's provider.");
  const flag = projectFlag("init", flags.project);
  if (!flag.ok) throw usageRefusal(flag.message, "Give --project a folder that is already here, or drop the flag and let the run ask.");
  const project = flag.path;
  // Under --json every line this run says, the host's own included, goes to stderr so stdout is the objects' alone.
  const say = flags.json ? jsonCliIO() : io;
  const screen = terminalInitIO(flags.json);
  // The objects --json prints are the build's own, and a build handed over is that host's run: its objects land on
  // its job, where wsp setup reads them, not on this stdout. Refused rather than printing an empty stream.
  if (held !== undefined && flags.json) {
    throw usageRefusal(`wsp init --json prints the build's own objects, and the host serving ${opts.statePath} (pid ${held.pid}) is what runs this build: its sign-ins and stages ride its own setup, which wsp setup --json reads.`, "Drop --json, or take that host down (wsp down) and run this again.");
  }
  // A host already serving this state file is the process that writes it and holds the provider, so this run asks
  // its screens and hands the build to that host. Read before the opening: a refusal here is the whole run, and it
  // reads better without a banner over it. Nothing is asked for a key: the host has the one that builds.
  const beside = held === undefined ? undefined : await besideHost(held, opts, flags.upCommand, flags.on);
  opening(screen, { command: "init", version: VERSION, yes: flags.yes, statePath: opts.statePath });
  const { keys, env: providerEnv } =
    beside !== undefined ? { keys: keysFound(keySources(opts.providerEnv, opts.statePath)), env: opts.providerEnv } : await loadKeys(say, keySources(opts.providerEnv, opts.statePath), { anthropic: false, noSolari: "offer", checkSaved: true });
  // One wiring for every runtime this run builds and for the host it serves at the end: the links and the recipe
  // planner are the same on both roads below.
  const links = placeWiring(opts.statePath, opts.advertise);
  // The first screen names where the image is built: the host's place, or the provider this run itself forks on.
  const builds = beside !== undefined ? beside.place.name : forksNoMachines(providerBackendFor(providerEnv).capabilities) ? undefined : wiredProviderId(providerEnv);
  if (builds !== undefined) builtOn(screen, builds, beside === undefined ? undefined : imageHomeKeptLine(flags.on, beside.place));
  // A provider with no size to boot a builder on has no image to build, so the run makes this computer the workspace
  // and serves the app on it. Every flag about the golden is about a road this run does not take.
  if (beside === undefined && forksNoMachines(providerBackendFor(providerEnv).capabilities)) {
    if (flags.noLocal) throw usageRefusal(`wsp init: with no provider key ${THIS_COMPUTER} is all this run makes, so --no-local would leave it with nothing.`, `Drop it${orSetTheKey(providerEnv)}.`);
    // Every other flag is about a golden: what goes on the image, what forks from it and what lands on that fork.
    // This road builds no image, and the workspace it makes is this computer, whose files are already here.
    const aboutGolden = GOLDEN_FLAGS.filter(([, given]) => given(flags)).map(([name]) => name);
    if (aboutGolden.length > 0) {
      throw usageRefusal(`wsp init: with no provider key there is no image to build and nothing to fork, and ${THIS_COMPUTER} already has your files, so ${aboutGolden.join(", ")} would do nothing here.`, `Drop them${orSetTheKey(providerEnv)}.`);
    }
    const local = await runLocalInit(
      {
        yes: flags.yes,
        nonInteractive: flags.nonInteractive,
        statePath: opts.statePath,
        ports: { port: opts.port, wsPort: opts.wsPort, named: opts.named, states: statesHere(opts.statePath) },
        address: opts.address,
        upCommand: flags.upCommand,
        runtime: () => makeRuntime(keys, opts.statePath, goldenRecipe(), providerEnv, agentsReachOf(opts), undefined, links),
        roads: rt => workspaceRoads(rt, agentHomes(homedir()), workspaceEnvsFor()),
        host: (rt, ports) => hostFor(rt, keys, { ...opts, port: ports.port, wsPort: ports.wsPort, providerEnv, links }, say),
      },
      screen,
    );
    if (local.handle !== undefined) {
      stopOnSignals(local.handle, say);
      stayOnUncaught(say);
    }
    return local.code;
  }
  // The socket the hand-off drives is closed on every road out of the run: node ends this process when the loop
  // drains, and one left open would hold the terminal after the last line.
  let result: InitResult;
  try {
    result = await runInit(
      {
        yes: flags.yes,
        nonInteractive: flags.nonInteractive,
        ...(flags.recipe !== undefined ? { recipeFile: resolve(flags.recipe) } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(flags.firstWorkspace !== undefined ? { firstWorkspace: flags.firstWorkspace } : {}),
        ...(flags.importFolder !== undefined ? { importFolder: resolve(flags.importFolder) } : {}),
        ...(flags.noLocal ? { noLocal: true } : {}),
        ...(flags.rebuild === true ? { rebuild: true } : {}),
        collect: collectThisComputer,
        recipe: (onHistory, onProject, onHistoryProgress) =>
          computeRecipe(nodeHost(), { threadAgents: THREAD_AGENTS, onHistory, onProject, onHistoryProgress, cache: historyCache(opts.statePath), ...(project !== undefined ? { folders: [project] } : {}) }),
        scanProject: async folder => {
          const { path, exists } = projectFolder(folder);
          return exists ? scanProject(nodeHost(), path) : undefined;
        },
        vault: () => vaultNow(opts.statePath),
        mintHere: runMintHere,
        saveKeys: set => writeEnvFile(envFileFor(opts.statePath), set),
        pricing: beside?.pricing ?? providerBackendFor(providerEnv).pricing,
        provider: wiredProviderId(providerEnv),
        statePath: opts.statePath,
        home: homedir(),
        secrets: keychainReader(),
        platform: hostPlatform(),
        brew: () => readBrewTable(nodeHost()),
        scan: alsoHere,
        runtime: recipe => makeRuntime(keys, opts.statePath, { ...recipe, deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE) }, providerEnv, agentsReachOf(opts), undefined, links),
        bundleFile: () => missingBundleFile(),
        ports: { port: opts.port, wsPort: opts.wsPort, named: opts.named, states: statesHere(opts.statePath) },
        address: opts.address,
        upCommand: flags.upCommand,
        forkCommand: flags.forkCommand,
        relay: async (rt, builder, hooks) =>
          startCallbackRelay({
            runtime: rt,
            openUrl: systemOpener(),
            log: line => {
              if (!hooks.onLine(line)) say.log(line);
            },
            autoOpen: hooks.autoOpen,
            openLine: hooks.openLine,
            builder,
          }),
        roads: rt => workspaceRoads(rt, agentHomes(homedir()), workspaceEnvsFor()),
        host: (rt, ports) => hostFor(rt, keys, { ...opts, port: ports.port, wsPort: ports.wsPort, providerEnv, links }, say),
        ...(beside !== undefined ? { handOff: (o: { interactive: boolean }) => handOffTo(beside, opts.statePath, screen, o.interactive, flags) } : {}),
      },
      screen,
    );
  } finally {
    beside?.client.close();
  }
  if (result.handle !== undefined) {
    stopOnSignals(result.handle, say);
    stayOnUncaught(say);
  }
  return result.code;
}

export interface ServeOptions {
  port: number;
  wsPort: number;
  /** The address the host binds; this computer alone when absent. */
  address?: string;
  /** The address the person named with --advertise: every machine dials this host there, whatever kind it is.
   * Absent leaves each kind to answer for its own machines, which is where a turn's address comes from by
   * default, and a host no kind can reach hands its turns no token. */
  advertise?: string;
  statePath: string;
  /** What this host picks its machine provider out of; this process's own environment when the caller names none. */
  providerEnv?: ProviderEnv;
  webDir?: string;
  runtime?: Runtime;
  openUrl?: UrlOpener;
  /** Whether a box linked to a relay runs its connector; false is `wsp up --no-relay`. */
  relay?: boolean;
  /** How this process was started, which the init job's wsp tools install writes into an agent's config; the
   * desktop hands in its shim, the npm command the default reading. */
  running?: RunningWsp;
  /** Which command line road brought this host up, written into its lock so wsp down can stop it. The wsp up road
   * hands in its own word; the app's road hands in none, and nothing stops the app's host from a terminal. */
  startedBy?: HostStarted;
  /** How this host restarts itself where no command line road brought it up: the desktop hands in its relaunch. */
  restart?: RestartRoad;
  /** Filled with the loopback address a turn on this computer dials once the host binds. A caller that hands in its
   * own runtime hands in the cell that runtime's reach reads; absent, the host makes one for the runtime it builds. */
  here?: HereAt;
}

/** The road the desktop window brings a host up on, which is wsp up's: the state file it serves is one wsp init
 * wrote, so a computer with no provider key serves the machines it does have rather than being asked for one by a
 * window that can ask nothing. */
export async function serve(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  await adoptLoginPath(line => io.log(line));
  const { keys, env: providerEnv } = await loadKeys(io, keySources(opts.providerEnv ?? process.env, opts.statePath), { anthropic: false, noSolari: "local" });
  // One wiring for the runtime and for the host over it, so the links this host holds and the recipe its doctor
  // reads come from the same place.
  const links = placeWiring(opts.statePath, opts.advertise);
  const here = opts.here ?? {};
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath, goldenRecipe(), providerEnv, { ...agentsReachOf(opts), here, ...(opts.running !== undefined ? { run: opts.running } : {}) }, undefined, links);
  return hostFor(rt, keys, { ...opts, providerEnv, links, here }, io, opts.running);
}

/** The state file read once, before anything else on this host reads it: a file written in a shape this build does
 * not read is refused at every collection read, and the readers a runtime builds meet that refusal in the middle of
 * their own work, where one of them warns with the whole error and its stack behind a line of its own. It comes
 * before the wiring a runtime is built with, which mints this host's pairing key beside the state file on its own
 * first read: a start refused here leaves the home as it found it. Read here, the refusal is this start's, thrown
 * once and printed once, and the store is handed on so the file is not read twice over. One reading, taken by wsp
 * up and by the app's first launch before either makes a runtime. */
export async function readOnce(statePath: string): Promise<Store> {
  const store = jsonFileStore(statePath, stateWriterHere());
  await store.keys("workspaces");
  return store;
}

/** Whether the state has anything for the app to show: a sealed golden to fork from, or any workspace record, this
 * computer's included. One reading, asked by wsp up and by the desktop's first launch; what each does with the
 * answer is its own, since the app has onboarding screens to open and the command line records this computer and
 * serves at once. */
export async function servesNothing(rt: Runtime): Promise<boolean> {
  return goldenHead(await rt.golden.get()) === undefined && (await rt.workspaces.list()).length === 0;
}

export async function up(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  await adoptLoginPath(line => io.log(line));
  // A state file with nothing but this computer in it is served with no provider key: wsp init's local road is
  // what wrote it, and asking for a key to serve it would take that road away the next morning.
  const { keys, env: providerEnv } = await loadKeys(io, keySources(opts.providerEnv ?? process.env, opts.statePath), { anthropic: false, noSolari: "local" });
  // Read first, for the reason readOnce carries.
  const store = await readOnce(opts.statePath);
  const links = placeWiring(opts.statePath, opts.advertise);
  const here = opts.here ?? {};
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath, goldenRecipe(), providerEnv, { ...agentsReachOf(opts), here, ...(opts.running !== undefined ? { run: opts.running } : {}) }, undefined, links, store);
  try {
    // A state with nothing in it serves as it is: a workspace is one project's copy, so a host with no project has
    // no workspace to record, and wsp add is the road. The host listens for pairing either way.
    if (await servesNothing(rt)) io.log(NO_PROJECT_YET);
    // The road is written into the lock here and nowhere else: this is wsp up, so wsp down stops what it serves.
    return await hostFor(rt, keys, { ...opts, providerEnv, links, here, startedBy: opts.startedBy ?? "up" }, io, opts.running);
  } catch (e) {
    // A refusal thrown past a runtime this start built leaves the daemon that listing the workspaces dialled and
    // the timers behind it running, and the process stays up on them after the sentence is printed. A runtime a
    // caller handed in is that caller's to close.
    if (opts.runtime === undefined) await rt.close().catch(() => {});
    throw e;
  }
}

/** What a host with no Claude key says as it starts. A host that forks machines gives each fork the key as an env,
 * so a missing one is a fork with no credentials; a host that forks none runs its turns under the person's own
 * login and their harness's own store, where the sign-in they already made is the one a turn uses. */
export function noClaudeKeyNote(forksNothing: boolean): string {
  const what = forksNothing ? "a thread on this computer signs in as your own agents do" : "new workspaces fork without claude credentials";
  return `note: no ANTHROPIC_API_KEY found; ${what}`;
}

async function hostFor(
  rt: Runtime,
  keys: Keys,
  opts: {
    port: number;
    wsPort: number;
    address?: string;
    statePath: string;
    webDir?: string;
    openUrl?: UrlOpener;
    /** The address the person named with --advertise, which leads the addresses a computer you own is told to dial. */
    advertise?: string;
    /** Whether a linked box runs its connector; false is `wsp up --no-relay`, which serves without a tunnel. */
    relay?: boolean;
    /** Required here, not defaulted: the host's runtime and its init door must pick a provider out of one
     * environment, and two defaults are two places for them to drift apart. */
    providerEnv: ProviderEnv;
    /** Which command line road brought this host up, for the lock; absent is the app's own road. */
    startedBy?: HostStarted;
    /** The place wiring the runtime was built with, so the doctor's road on this host reads the recipe through the
     * planner the recipe job runs and not a second one of its own. Built here for a caller that handed none. */
    links?: PlaceWiring;
    /** The restart road the caller holds, which stands above the one the command line road names. */
    restart?: RestartRoad;
    /** The cell the runtime's reach reads the loopback address from, filled once the host binds. */
    here?: HereAt;
  },
  io: CliIO,
  run: RunningWsp = runningWsp(),
): Promise<HostHandle> {
  const address = opts.address ?? LOOPBACK;
  const links = opts.links ?? placeWiring(opts.statePath, opts.advertise);
  const lockPath = lockPathFor(opts.statePath);
  const started = startedByEnv(process.env) ?? opts.startedBy;
  const lock = takeLock(lockPath, opts.statePath, { port: opts.port, wsPort: opts.wsPort, address, ...(started !== undefined ? { startedBy: started } : {}) });
  // The mark says what started this host and the lock has it now, so it comes off the process here: a thread, the
  // local daemon and every pane's shell start from this environment, and a wsp line typed in one is not the service.
  delete process.env[STARTED_BY_ENV];
  // Read before the host serves a byte, for the line that says what a linked box is open to; the page's token is
  // withheld per request, off what the connector puts on the ones it forwards, so a connector an earlier run left
  // behind changes nothing here.
  const linked = readRelayRecord(opts.statePath) !== undefined;
  // A computer that already joined dials the port its place file names, so the door binds as this host starts
  // rather than waiting for somebody to open the Add a computer sheet again.
  const joined = (await rt.places?.list(Date.now()).catch(() => []))?.some(p => p.kind === "computer" && p.joinedAt !== undefined) === true;
  // The account's own computers, read by the door and written by the beats below: made here because the door is
  // wired as the host starts and the beats only begin once it serves.
  const admitted = admittedDevices(opts.statePath);
  const road =
    opts.restart ??
    (started === undefined
      ? undefined
      : restartRoads({ exit: code => process.exit(code), respawn: ports => starterFor(run)(opts.statePath, line => io.log(line), ports), log: line => io.log(line) })[started]);
  // Handed out before the host serves and read only once a request arrives, which is after it serves.
  let serving: RestartingHost | undefined;
  const restart: RestartDoor | undefined =
    road === undefined
      ? undefined
      : {
          ...(road.refusal !== undefined ? { refusal: road.refusal } : {}),
          restart: () => (serving === undefined ? Promise.reject(new Error("the host is still starting")) : road.restart(serving)),
        };
  try {
    const handle = await startHost({
      runtime: rt,
      port: opts.port,
      wsPort: opts.wsPort,
      listen: address,
      ...(opts.advertise !== undefined ? { advertise: opts.advertise } : {}),
      ...(opts.here !== undefined ? { here: opts.here } : {}),
      door: joined ? "open" : "closed",
      doorLine: line => io.log(line),
      ...(links.back !== undefined ? { back: links.back } : {}),
      webDir: opts.webDir ?? webDirFor(),
      // Read at each fork, not once at start: the init job saves a key while this host serves.
      workspaceEnvs: golden => workspaceEnvsFor().workspaceEnvs(golden),
      ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
      log: line => io.log(line),
      recipePath: recipePath(opts.statePath),
      statePath: opts.statePath,
      init: hostInitDoor(rt, opts.statePath, run, opts.openUrl ?? systemOpener(), line => io.log(line), opts.providerEnv),
      doctor: hostDoctorReaders(links, opts.statePath),
      // The row this host forks on, so a host wired to none asks its account nothing at all.
      provider: wiredProviderId(opts.providerEnv),
      admitted,
      release: releaseWatch({
        statePath: opts.statePath,
        shape: started ?? "app",
        running: VERSION,
        installed: installedVersion,
        ...(road !== undefined ? { restart: road } : {}),
        update: version => releaseUpdateLine(run, version),
        log: line => io.log(line),
      }),
      ...(restart !== undefined ? { restart } : {}),
    });
    writeFileSync(lockPath, JSON.stringify({ ...lock, port: handle.port, wsPort: handle.wsPort, address }));
    // Other local tools read the token from disk; the WS never sees it in a URL.
    const tokenPath = hostTokenPath(opts.statePath);
    writeOwn(dirname(tokenPath), basename(tokenPath), handle.authToken);
    const home = resolve(wspHome());
    // A skill copy an install wrote once falls behind the binary at the next release, and the agent reading it
    // calls verbs that are gone. The copies that are there are brought up to this wsp's, and none is written where
    // there is none. Only for a host serving this wsp home's own state file, which is the person's own wsp: a host
    // on a state file somewhere else writes nothing outside that file's own folder, which is what somebody keeping
    // their whole session inside one folder asked for.
    if (realState(opts.statePath) === realState(join(home, "state.json"))) {
      const refreshed = refreshSkills(homedir());
      if (refreshed.length > 0) io.log(skillsRefreshedLine(refreshed));
    }

    for (const line of addressLines(opts.statePath, { ...handle, address })) io.log(line);
    if (!isLoopback(address)) io.log(listenBeyondLoopbackLine(address));
    else if (linked) io.log(relayOnLoopbackLine());
    if (hereUrl(address, handle.wsPort) === undefined) io.log(loopbackThreadsLine(address));
    if (keys.anthropic === undefined) io.log(noClaudeKeyNote(forksNoMachines(rt.backend.capabilities)));
    // The tunnel carries to this host's own app port, so a box on loopback alone is still reachable through the
    // relay and nothing else about how it binds has to change.
    const relay =
      linked && opts.relay !== false
        ? await startRelay({
            statePath: opts.statePath,
            home: wspHome(),
            port: handle.port,
            log: line => io.log(line),
            admitted,
            // The revoke the reconcile takes is the op's own, so a device the account dropped loses its sockets
            // here exactly as one revoked at this terminal does.
            devices: { list: () => rt.devices.list(), revoke: id => handle.revokeDevice(id) },
          })
        : undefined;
    if (linked && opts.relay === false) await stopRecordedConnector(dirname(opts.statePath));
    const host: HostHandle = {
      ...handle,
      close: async () => {
        await relay?.close();
        await handle.close();
        rmSync(lockPath, { force: true });
      },
    };
    serving = host;
    return host;
  } catch (e) {
    rmSync(lockPath, { force: true });
    throw e;
  }
}

/** What the service commands ask of this computer: which manager writes its units, how a manager's command is run
 * here, and how long a load or a stop is given before wsp stops waiting and says what it sees. Tests hand a fake
 * manager and a fake runner through the same three fields. */
export interface ServiceDeps {
  platform: string;
  manager: ServiceManager | undefined;
  run: ServiceRunner;
  waitMs: number;
  /** The layers a key is read from, so what a service can still read once the installing shell is gone is one
   * answer a test hands over rather than the folder the test runner happens to sit in. The state file is not among
   * them: it is the command's own, and the .env beside it is what the host this unit starts will read. */
  keys: Omit<KeySources, "statePath">;
  /** Whether the host the lock names answers on its port. */
  answers: HostProbe;
  /** The one dial, for the status of a host on another computer: nothing on this computer says whether it is up. */
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  /** Asks the pid the lock recorded to end, for a host a verb started and no terminal holds. */
  stop(pid: number): void;
  /** The link to this computer's own daemon when it is joined to somebody else's wsp, and nothing when it is joined
   * to none: opened off its own place file, with no host anywhere in the road. The caller closes it. */
  here(home: string): Promise<HereWatch | undefined>;
  /** Where a --watch's stop arrives. This process by default; a test hands in its own, since a real signal would
   * take the test runner with it. */
  signals?: WatchSignals;
}

/** Which line brought a host up, in the words every sentence about it uses: a person who typed wsp up reads their
 * own line back, a host a verb started for itself is nobody's line, and the one this computer's manager holds up
 * is the service. */
const HOST_ROAD_WORDS: Readonly<Record<HostStarted, string>> = { up: "wsp up", verb: "a verb", service: "the service" };
export const hostRoadWord = (started: HostStarted): string => HOST_ROAD_WORDS[started];

/** What wsp down says for a host the command line brought up, whichever of its two roads did: the same shape the
 * service's own stop line takes, naming the road. */
export const hostStoppedLine = (started: HostStarted, pid: number, statePath: string): string =>
  `stopped the host ${hostRoadWord(started)} started (pid ${pid}); nothing serves ${statePath} now`;

export function systemService(): ServiceDeps {
  const os = platform();
  return { platform: os, manager: serviceManagerFor(os), run: systemRunner, waitMs: SERVICE_WAIT_MS, keys: { env: process.env, cwd: process.cwd() }, answers: httpProbe, dial: dialHost, stop: pid => process.kill(pid, "SIGTERM"), here: home => openHere(home) };
}

/** The line the service runs: this node and this wsp, serving the state file, the ports, the address and the
 * provider the install was given. Every word is spelled out, since a service has no cwd of the person's to read a
 * default from and no shell of theirs to read a variable from. */
function serviceArgv(asked: ServeAsked): string[] {
  const bin = process.argv[1];
  if (bin === undefined) throw new Error("wsp up --service needs the path wsp was started from, and this process has none");
  return [process.execPath, resolve(bin), "up", ...SERVE_FLAGS.flatMap(flag => flag.words(asked))];
}

/** A host already holds the state file, so the service would only start a second one that refuses the lock. */
function serviceRefusal(lock: HostLock, statePath: string): string {
  return `wsp up --service: a wsp host (pid ${lock.pid}) is already serving ${statePath} on port ${lock.port}. Stop it first (Ctrl-C in its terminal, or kill ${lock.pid}), then run wsp up --service again.`;
}

/** Whether a key is in one of the two `.env` files, which is all a service can still read once the shell that
 * installed it is gone. The environment layer is that shell, so it does not count. */
function keyInAFile(name: string, sources: KeySources): boolean {
  return keyLayers(sources)
    .slice(1)
    .some(layer => (layer[name] ?? "") !== "");
}

/** Whether this shell is the only place a key is: a service starts without that shell, so a key nothing else holds
 * would be gone by then. A key no shell exported is not lost by a service; there is none, and on this computer that
 * is wsp init's local road, which serves with no provider at all. One reading for both keys. */
function onlyInThisShell(name: string, sources: KeySources): boolean {
  return keyIn(sources.env, name) !== undefined && !keyInAFile(name, sources);
}

/** The line saying this provider's key would be gone by the time the service starts, or nothing when a file holds
 * it, no shell does, or the provider this run is wired to reads no key. The variable is the row's own, so a service
 * installed for a provider added tomorrow is refused in that provider's words. */
export function keyOnlyInThisShell(sources: KeySources, env: ProviderEnv = sources.env): string | undefined {
  const name = providerKeyRow(env)?.keyEnv;
  if (name === undefined || !onlyInThisShell(name, sources)) return undefined;
  return `wsp up --service: a service starts without your shell, so it reads its provider key from a file. ${name} is only in this shell's environment; put it in ${envFileFor(sources.statePath)} first.`;
}

/** The Claude key is not needed to serve, so it is a word rather than a refusal; without it every workspace the
 * service forks has no claude credentials, and the installing shell is the one place the reading looks complete. */
export function claudeKeyOnlyInThisShell(sources: KeySources): string | undefined {
  if (!onlyInThisShell("ANTHROPIC_API_KEY", sources)) return undefined;
  return `note: ANTHROPIC_API_KEY is only in this shell's environment, so the service starts without it and the workspaces it forks get no claude credentials. Put it in ${envFileFor(sources.statePath)} to carry it over.`;
}

export async function upServiceCommand(io: CliIO, opts: ServeAsked, deps: ServiceDeps): Promise<number> {
  const manager = deps.manager;
  if (manager === undefined) {
    io.error(noManagerLine(deps.platform));
    return 1;
  }
  const held = servingHost(opts.statePath);
  if (held !== undefined) {
    io.error(serviceRefusal(held, opts.statePath));
    return 1;
  }
  await adoptLoginPath(line => io.log(line));
  // The layers this unit's host will read: the shell installing it, its folder, and the .env beside the state file
  // the unit is being written to serve. The row is picked out of all three, as that host will pick it at its own
  // start: read off the shell alone, this preflight would weigh a key for a provider the host it installs is not
  // wired to, and let the one it is wired to go with the shell.
  const sources: KeySources = { ...deps.keys, statePath: opts.statePath };
  const shellOnly = keyOnlyInThisShell(sources, providerEnvWith(opts, sources.env, keyLayers(sources)));
  if (shellOnly !== undefined) {
    io.error(shellOnly);
    return 1;
  }
  const claudeOnly = claudeKeyOnlyInThisShell(sources);
  if (claudeOnly !== undefined) io.log(claudeOnly);
  const at = serviceAddressHere(opts.statePath);
  const logPath = hostLogPath(opts.statePath);
  // The word the host this unit starts carries: it is the one registered to serve that state file, so it serves
  // where every other client on this computer is told to start the service instead. It is the host's own mark and
  // not a service's, so the agent on a joined computer, whose unit comes out of the same serviceEnv, carries none.
  const env = { ...serviceEnv(process.env), [STARTED_BY_ENV]: "service" };
  const { unit, installed, failure } = await installService(manager, { ...at, argv: serviceArgv(opts), cwd: process.cwd(), env, logPath }, deps.run);
  if (failure !== undefined) {
    io.error(`wsp up --service: ${runFailureLine(failure)}`);
    if (installed) io.error(`the ${manager.words} ${unit.name} is still there at ${unit.path}; wsp down takes it away.`);
    return 1;
  }
  const lock = await untilServing(opts.statePath, deps.waitMs, deps.answers);
  if (lock === undefined) {
    io.error(
      `the ${manager.words} ${unit.name} loaded, but nothing answered on port ${opts.port} for ${opts.statePath} within ${fmtDuration(deps.waitMs)}. Its log is ${logPath}, and wsp down takes the service away.`,
    );
    for (const line of logTail(logPath)) io.error(line);
    return 1;
  }
  io.log(`${manager.words} ${unit.name} is loaded; it serves again at every login`);
  for (const line of addressLines(opts.statePath, lock)) io.log(line);
  if (!isLoopback(opts.address)) io.log(listenBeyondLoopbackLine(opts.address));
  if (hereUrl(opts.address, lock.wsPort) === undefined) io.log(loopbackThreadsLine(opts.address));
  io.log(`log         ${logPath}`);
  const after = manager.afterLoad?.(at);
  if (after !== undefined) io.log(after);
  io.log("Stop it with wsp down.");
  return 0;
}

export async function downCommand(io: CliIO, opts: { statePath: string }, deps: ServiceDeps): Promise<number> {
  const manager = deps.manager;
  if (manager === undefined) {
    io.error(noManagerLine(deps.platform));
    return 1;
  }
  const at = serviceAddressHere(opts.statePath);
  const unit = manager.unit(at);
  // The manager is asked even with no unit file: a file somebody removed, or an install that took the file back,
  // still leaves the manager holding the service, and that is the one thing wsp down is for.
  const installed = existsSync(unit.path);
  const { held, unsure, failure } = await stopService(manager, at, deps.run);
  if (unsure !== undefined) {
    const stands = installed ? `Its unit file is still ${unit.path}; nothing was changed.` : "Nothing was changed.";
    io.error(`wsp down: ${runFailureLine(unsure)}, so wsp cannot tell whether the ${manager.words} ${unit.name} is still loaded. ${stands}`);
    return 1;
  }
  if (failure !== undefined) {
    io.error(`wsp down: ${runFailureLine(failure)}`);
    return 1;
  }
  if (!held && !installed) {
    const serving = servingHost(opts.statePath);
    // A host the command line brought up is wsp down's to stop, whether a verb started it for itself or a person
    // typed wsp up: up and down are a pair. The pid comes off the lock that host wrote, never off a search for a
    // process that looks like it.
    if (serving?.startedBy !== undefined) {
      deps.stop(serving.pid);
      const left = await untilLock(opts.statePath, false, deps.waitMs);
      if (left !== undefined) {
        io.error(`wsp down: the host ${hostRoadWord(serving.startedBy)} started (pid ${left.pid}) is still serving ${opts.statePath}.`);
        return 1;
      }
      io.log(hostStoppedLine(serving.startedBy, serving.pid, opts.statePath));
      return 0;
    }
    io.error(
      serving === undefined
        ? `wsp down: no ${manager.words} for ${opts.statePath}, and no host is serving it.`
        : `wsp down: no ${manager.words} for ${opts.statePath}; the host serving it (pid ${serving.pid}) was started by hand. Stop it with Ctrl-C in its terminal, or kill ${serving.pid}.`,
    );
    return 1;
  }
  const lock = await untilLock(opts.statePath, false, deps.waitMs);
  if (lock !== undefined) {
    io.error(`the ${manager.words} ${unit.name} is gone, but the host it started (pid ${lock.pid}) is still serving ${opts.statePath}.`);
    return 1;
  }
  io.log(`${manager.words} ${unit.name} stopped; nothing serves ${opts.statePath} now`);
  return 0;
}

/** The latest row's words off the file the host keeps, asking no host; nothing where no ask was ever kept. */
function latestHere(statePath: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const reading = releaseReading(statePath, env);
  return reading === undefined ? undefined : latestWords(reading, VERSION, version => releaseUpdateLine(runningWsp(), version));
}

export async function statusCommand(io: CliIO, opts: { statePath: string; state?: string; watch?: boolean } & HostPick, deps: ServiceDeps): Promise<number> {
  // The one line that leaves this computer only when a person named a host: --host or WSP_HOST and nothing else.
  // A verb has a host to speak to whatever the line said, so it follows the fallbacks under those two, the default
  // alias among them; this line is the question whether the host here is serving, and an alias answering for a box
  // would hide the one thing it was run to learn.
  const aim = namedHost(opts);
  // A watch follows the agent on the computer it is typed at. Neither a host aimed at from here nor the host
  // serving here has one, so a --watch on either is refused rather than quietly printing one frame and stopping.
  if (opts.watch === true && aim !== undefined) {
    throw usageRefusal(`wsp status --watch reads the agent on the computer you are sitting at, and this line is aimed at the host on ${aimName(aim)}.`, `Run wsp status --watch in a terminal on that computer.`);
  }
  if (aim !== undefined) {
    // The same note the verbs leave, in the same words: a line that named both a file here and a host over there
    // reads neither one from the other.
    if (opts.state !== undefined) io.error(stateIgnoredLine(aimName(aim)));
    // A host on another computer keeps its own lock and its own service manager, neither of which is a file here:
    // what this computer can say is where it answers and whether it did, which is one dial and nothing else. A road
    // that carried nothing is the reading; anything the host itself said stands as this line's own failure.
    const unreached = await deps.dial(opts.statePath, { aim }).then(
      client => {
        client.close();
        return undefined;
      },
      (e: unknown) => {
        if ((e as { kind?: unknown }).kind !== "unreachable") throw e;
        return e instanceof Error ? e.message : String(e);
      },
    );
    for (const line of hostThereLines(aimName(aim), aimAddress(aim), unreached)) io.log(line);
    return unreached === undefined ? 0 : 1;
  }
  // A computer joined to somebody else's wsp runs no host and never will: what wsp is doing there is the agent it
  // joined with, so that is what this line reads, and nothing about a host it would only ever say was not running.
  // The refusal before the dial: a --watch with nowhere to redraw must not open a link to the daemon to say so.
  const watching = opts.watch === true ? watchOn("wsp status", { json: false, redraw: io.redraw }) : undefined;
  if (watching !== undefined && "refusal" in watching) throw watching.refusal;
  const home = opts.home ?? homedir();
  const joined = await deps.here(home);
  if (joined !== undefined) return hereStatus(io, joined, watching?.redraw, () => deps.here(home), deps.signals);
  if (opts.watch === true) {
    throw usageRefusal("wsp status --watch reads the agent on a computer joined to somebody's wsp, and this computer is joined to none.", "Run wsp status without --watch for the host serving here, or wsp workspaces --watch to follow what it runs.");
  }
  const reading = await serviceReading(deps.manager, serviceAddressHere(opts.statePath), deps.run, deps.platform);
  const lock = servingHost(opts.statePath);
  const host = lock === undefined ? undefined : { lock, answering: await deps.answers(lock) };
  for (const line of statusLines(opts.statePath, host, reading, Date.now(), latestHere(opts.statePath, opts.env ?? process.env))) io.log(line);
  return host?.answering === true ? 0 : 1;
}

/** The rows for a computer joined as a place, printed once or redrawn where they stand until Ctrl-C. The link is
 * the one `here` opened and it is held for every frame: the daemon's samplers stop with their last subscriber, so a
 * watch that dialled again per frame would stop them, wait out the whole of the first sample's interval again and
 * draw at a third of the rate every word about the flag promises. The frames come as the daemon pushes, with the
 * tick under them as the floor. Closed on every road out, the refusal's included. */
async function hereStatus(io: CliIO, first: HereWatch, redraw: Redraw | undefined, again: () => Promise<HereWatch | undefined>, signals?: WatchSignals): Promise<number> {
  let held = first;
  try {
    if (redraw === undefined) {
      const reading = held.reading();
      for (const line of hereLines(reading)) io.log(line);
      return hereAnswering(reading) ? 0 : 1;
    }
    // Nothing to hold means nothing to wait on, so a watch there would draw the same sentence for as long as
    // somebody looked at it. The one thing a person watches for after a join is the agent coming up, so the open is
    // tried again beside the frames rather than in them: a dial that takes its whole wait must not hold the tick.
    let reopening: Promise<void> | undefined;
    await watchBlock(
      async () => {
        if (!held.linked && reopening === undefined) {
          reopening = again()
            .then(next => {
              if (next === undefined) return;
              held.close();
              held = next;
            })
            .catch(() => undefined)
            .finally(() => (reopening = undefined));
        }
        return hereLines(held.reading());
      },
      { ...redraw, until: () => held.next(), ...(signals !== undefined ? { signals } : {}) },
    );
    return hereAnswering(held.reading()) ? 0 : 1;
  } finally {
    held.close();
  }
}

/** The flags the shared parse reads; a command that answers on its own word (mcp, recipe) parses its own. */
interface SharedFlags {
  version?: boolean;
  help?: boolean;
  port?: string;
  "ws-port"?: string;
  listen?: string;
  advertise?: string;
  state?: string;
  yes?: boolean;
  "non-interactive"?: boolean;
  json?: boolean;
  recipe?: string;
  project?: string;
  "first-workspace"?: string;
  import?: string;
  on?: string;
  rebuild?: boolean;
  "no-local"?: boolean;
  local?: boolean;
  service?: boolean;
  code?: string;
  "code-file"?: string;
  "ssh-port"?: string;
  "ssh-key"?: string;
  "host-key"?: string;
  base?: string;
  keep?: string[];
  cut?: string[];
  "no-memory"?: boolean;
  "no-commits"?: boolean;
  remember?: boolean;
  watch?: boolean;
  update?: boolean;
  "sign-in"?: string;
  name?: string;
  host?: string;
  "no-relay"?: boolean;
  provider?: string;
}

/** What a word of the shared parse does with --host. `aimed`: the line runs against the host it names. `refused`:
 * the line reads this computer's own files, so the parse refuses the flag rather than take it and aim nowhere.
 * `hostSide`: the line runs at the host's own terminal, so it takes the flag and answers the one sentence that says
 * so, which is the same answer WSP_HOST and the account's one host already get. */
export type HostFlag = "aimed" | "refused" | "hostSide";

interface Command {
  /** Which page it prints on, as every verb declares one. */
  page: Page;
  /** The shape of the line, as its own help prints it. */
  usage: string;
  /** One phrase on what it does, as every page prints it under the usage. */
  about: string;
  /** Whether stdout is objects under --json; a command without it refuses the flag rather than hand prose to whoever reads them. */
  json: boolean;
  /** What --host means for this word. One parse reads the flag for every word, so this is what keeps the ones that
   * have nothing to do with it from swallowing it, and what sends the two that run over there to their own line. */
  host: HostFlag;
  /** Why the MCP server has no tool for it. */
  cliOnly: string;
  run(io: CliIO, opts: SharedOpts, values: SharedFlags, args: string[], deps: CommandDeps): Promise<number>;
}

/** What a command of the shared parse reaches another host with. One dial, the one every verb takes, so a test
 * hands a fake host client where a real one would be dialled. */
export interface CommandDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
}

/** The dial every command line takes when the caller names no other. */
export const SYSTEM_COMMAND_DEPS: CommandDeps = { dial: dialHost };

/** What a command that reads where a line is aimed works on: the state file this run names, the home holding the
 * hosts folder, the environment the run was made in and the word --host gave. One reading for the three commands
 * that ask, so the flag cannot reach one of them and not another. */
function aimPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick {
  return { statePath: opts.statePath, home: opts.home, env: opts.env, ...(values.host !== undefined ? { host: values.host } : {}) };
}

/** The same pick with the run's starter on it, for wsp add and wsp remove: both do their work through the host, as
 * every verb does, so both start one when none serves and the front page's claim holds for them. wsp status reads
 * whether a host serves and must never start one, and wsp down has nothing to start, so neither takes this. */
function startingPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick & { start?: HostStarter } {
  return { ...aimPick(opts, values), ...(opts.start !== undefined ? { start: opts.start } : {}) };
}

/** The pair wsp up binds: the one asked for when both ports are free, the next free pair with the port it stepped
 * over handed back for the caller to say once it serves, and nothing where a port a person named is held, which is
 * the whole run's refusal. The step is picked in silence because every refusal a start throws is thrown after this,
 * and a refusal is one sentence with nothing above it. The refusals here are the run's end, so they are printed
 * where they are read. The sentences are the protocol's, the same three wsp init's road prints, and a held port
 * never reaches the person as the bind's own error. */
export async function pickUpPorts(io: CliIO, opts: ServeAsked, probes: PortProbes = {}): Promise<PortsPicked | undefined> {
  const asked = { port: opts.port, wsPort: opts.wsPort, named: opts.named };
  const where = { states: statesHere(opts.statePath), ...probes };
  const chosen = await choosePorts(asked, where);
  if (!("taken" in chosen)) return chosen;
  io.error(portTakenLine(chosen.taken.port, chosen.taken.holder));
  // The pair a person could have had, found the same way the unnamed road finds one, so the refusal hands over a
  // line to type rather than a number to guess.
  const free = await choosePorts({ ...asked, named: false }, where);
  io.error("taken" in free ? PORT_TAKEN_REFUSAL : portInsteadLine(free.ports));
  return undefined;
}

/** What the doctor's computer road reads on a serving host beside the runtime: the keys as they stand at the ask,
 * and the recipe off the one planner that host's places wiring already holds. Written here so the recipe job and
 * this road read this computer through one planner and no road can grow a second. */
export function hostDoctorReaders(links: PlaceWiring, statePath: string): HostDoctorReaders {
  const provision = links.provision;
  return { vault: () => vaultNow(statePath), ...(provision !== undefined ? { plan: () => provision.plan({ home: GUEST_HOME }) } : {}) };
}

/** The doctor's own usage line, read by its row and by every refusal that prints it. */
const DOCTOR_USAGE = "wsp doctor [<computer>] [--project <name>] [--local] [--yes]";

/** Set to 1, every road of the doctor prints what the loop still holds once it closed what it opened. A run that
 * does not end after its last line is holding something, and this is what names it. */
export const DOCTOR_HANDLES_ENV = "WSP_DOCTOR_HANDLES";

/** What the doctor's roads that touch no provider load: no key, and no question about one. The local road and the
 * computer road fork nothing and bill nothing, so a person with a computer of their own and no cloud account is
 * never asked for a cloud key; the agents' key rides along from the files either way. */
const NO_CLOUD_KEY = { anthropic: false, noSolari: "local" } as const;

/** Which keys one doctor road needs: a cloud row's road forks a machine at that provider and bills while it runs,
 * so its key is asked for the way every cloud road asks for one; every other road forks nothing and is handed no
 * key at all. Read after the row, since the row is what says which road this is. */
export const doctorKeyAsk = (computer?: Pick<PlaceView, "kind">): { anthropic: boolean; noSolari?: "local" } =>
  computer?.kind === "provider" ? { anthropic: true } : NO_CLOUD_KEY;

/** The row a word names, or the refusal naming the rows this host holds and the line that lists them. The one
 * reading every road that takes a place word makes, and it says nothing about which road the doctor then takes. */
export function doctorRow(places: readonly PlaceView[], word: string): PlaceView {
  const found = places.find(place => namesPlace(place, word));
  if (found === undefined) throw usageRefusal(noSuchPlaceRefusal(word, places.map(place => place.name)), "Run wsp computers to read the ones this host holds.");
  return found;
}

/** The one word a line of the account takes, or the refusal for a second: a word nobody reads is a line that did
 * something other than what was typed. The usage each of them prints is its own row's. */
function oneWord(words: string, usage: string, args: readonly string[]): string | undefined {
  if (args.length > 1) throw usageRefusal(`wsp ${words} takes one word, and got ${args.length}.`, `usage: ${usage}`);
  return args[0];
}

/** The commands the shared parse serves, keyed by the words that select one. A line is matched against the longest
 * key whose words open it, as a verb's words select a verb, so the plumbing folded under `host` needs no second
 * dispatch of its own. */
const COMMANDS: Readonly<Record<string, Command>> = {
  up: {
    page: "agent",
    usage: "wsp up [--port <n>] [--ws-port <n>] [--listen <addr>] [--advertise <url>] [--provider <name>] [--no-relay] [--service]",
    about: `serve the host in this terminal, for a host you want to watch or one that serves beyond this computer; --service hands the same line to this computer's own service manager, which starts it now and again at every login. ${HOST_STARTS_ITSELF}`,
    json: false,
    host: "refused",
    cliOnly: "starts the host on the person's computer; a tool runs against a host that is already up",
    run: async (io, opts, values) => {
      if (values.service === true) return upServiceCommand(io, opts, systemService());
      // The lock is read before a port is stepped, a key is read or a daemon is dialled: each of those writes under
      // the home the other host is serving, and a start that is going to be refused must leave it as it found it.
      refuseIfServed(lockPathFor(opts.statePath), opts.statePath);
      // A state file this computer's own manager is registered to serve is that service's: a host started here
      // would be a second one on it, of whichever build this line came from, which is how a state file was
      // rewritten under the host that owned it. The service's own host carries the word and passes, and a host
      // that is already serving is the lock's refusal below, which names the pid and how to stop it.
      const owned = startedByEnv(process.env) === "service" ? undefined : serviceServesState(opts.statePath, registeredService);
      if (owned !== undefined) {
        io.error(owned);
        return EXIT_CODES.provider;
      }
      // Which ports are free is settled before anything binds: a port another wsp or another program holds is one
      // sentence naming who holds it, and a pair nobody named is stepped over rather than refused.
      const picked = await pickUpPorts(io, opts);
      if (picked === undefined) return EXIT_CODES.provider;
      const handle = await up(io, { ...opts, ...picked.ports });
      // "Serving on 4401" is a claim about a host that serves, so it is said once one does: the state read, the
      // keys, the second lock read and the bind itself all refuse after the ports are picked.
      if (picked.moved !== undefined) io.log(portsPickedLine({ port: handle.port, wsPort: handle.wsPort }, picked.moved.port, picked.moved.holder));
      stopOnSignals(handle, io);
      stayOnUncaught(io);
      return 0;
    },
  },
  down: {
    page: "agent",
    usage: "wsp down",
    about: "stop the host: the service and its unit where one holds it up, and otherwise the host the command line brought up, whether wsp up or a verb that needed one started it",
    json: false,
    host: "refused",
    cliOnly: "stops the service holding the host up on the person's computer, which a tool would be cutting the ground from under",
    run: (io, opts) => downCommand(io, opts, systemService()),
  },
  status: {
    page: "front",
    usage: "wsp status [--watch]",
    about: "whether a host serves this state file, on which ports, what keeps it there and the newest release the host last read, with a non-zero exit code when none does; on a computer joined to somebody's wsp it reads the agent there instead, what that computer is doing and what is running on it, and --watch draws the same rows again every second. --host reads a host on another computer",
    json: false,
    host: "aimed",
    cliOnly: "reads this computer's lock and service manager, the agent on a computer that joined somebody's wsp, or dials the host named beside it; a tool that answers at all is proof a host is up",
    run: (io, opts, values) =>
      statusCommand(io, { ...aimPick(opts, values), ...(values.state !== undefined ? { state: values.state } : {}), ...(values.watch === true ? { watch: true } : {}) }, systemService()),
  },
  "host pair": {
    page: "host",
    usage: "wsp host pair",
    about: "a one time code another computer redeems for a token of its own, when the host listens beyond this computer",
    json: false,
    host: "hostSide",
    cliOnly: "hands out a code that lets another computer drive this host; only a person at the host's own terminal gives that away",
    run: (io, opts, values, args) => pairCommand(io, aimPick(opts, values), args),
  },
  "host devices": {
    page: "host",
    usage: "wsp host devices [revoke <id>]",
    about: "the computers paired with a host and what each token is read as; revoke takes one back out. --host reads a host on your account from another computer signed in to it",
    json: false,
    host: "aimed",
    cliOnly: "lists and takes away the computers that may drive a host, from that host's terminal or from a computer paired with it; which computers hold a token is the person's to read and cut, never a thread's",
    run: (io, opts, values, args) => devicesCommand(io, aimPick(opts, values), args),
  },
  "host link": {
    page: "host",
    usage: "wsp host link [<url>] [--name <name>]",
    about: "put the host on this computer onto your account, so it is reachable from anywhere with no port open to the world; on a computer that is signed in it takes no address and asks nothing, and on one that is not it prints a code and a page to approve it on",
    json: false,
    host: "refused",
    cliOnly: "puts this computer on a person's relay account, which is theirs to give away",
    run: (io, opts, values, args) => relayCommand(io, opts, ["link", ...args], values),
  },
  "host unlink": {
    page: "host",
    usage: "wsp host unlink",
    about: "take this computer off the relay account and stop its tunnel",
    json: false,
    host: "refused",
    cliOnly: "takes this computer off a person's relay account and stops the tunnel, which belongs with the terminal that put it there",
    run: (io, opts, values, args) => relayCommand(io, opts, ["unlink", ...args], values),
  },
  login: {
    page: "front",
    usage: "wsp login [<relay url>|<word>|<id>]",
    about: "sign this computer in to your account, so every host on it is a line away with no code typed. With a word another computer's wsp login printed, or the id of one already signed in, it signs that computer's key for the hosts this one is trusted at; with nothing on a computer already signed in it lists the account's computers",
    json: false,
    host: "refused",
    cliOnly: "signs a person in to their own account and admits their other computers to their hosts, which is theirs to give away and never a thread's",
    run: (io, opts, _values, args) => loginCommand(io, opts, oneWord("login", "wsp login [<relay url>|<word>|<id>]", args)),
  },
  logout: {
    page: "front",
    usage: "wsp logout [<id>]",
    about: "sign this computer out of your account, which drops the hosts it reached through it; with an id it signs another of your computers out, and every host drops what it admitted for that one",
    json: false,
    host: "refused",
    cliOnly: "takes away a token of this person's and the access it bought, which belongs with the person whose account it is",
    run: (io, opts, _values, args) => logoutCommand(io, opts, oneWord("logout", "wsp logout [<id>]", args)),
  },
  hosts: {
    page: "front",
    usage: "wsp hosts",
    about: "every host on your account this computer can reach, with a live beat for each and the one every line takes marked",
    json: false,
    host: "refused",
    cliOnly: "reads which hosts this computer can reach and writes the account's into its own files, which no thread decides for the person",
    run: (io, opts, _values, args) => {
      if (args.length > 0) throw usageRefusal(`wsp hosts takes no words, and got ${args[0]!}.`, "usage: wsp hosts");
      return hostsCommand(io, opts);
    },
  },
  init: {
    page: "front",
    usage: "wsp init [--on <place>] [--recipe <path>] [--project <path>] [--first-workspace <name>] [--import <folder>] [--rebuild] [--no-local] [--yes] [--non-interactive] [--json]",
    about: "seal this computer into your image, one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build. Beside a host already serving this state file the screens are the same and the build runs in that host, on the place --on names or its default place, a computer you joined included. With no host serving and no provider key it seals nothing and makes your first workspace a copy of a folder here instead",
    json: true,
    host: "refused",
    cliOnly: "builds your image and serves for hours; an agent runs it from a shell and relays the sign-ins it prints",
    run: (io, opts, values) =>
      init(io, opts, {
        yes: values.yes === true,
        // --json has nobody to answer the screens: its objects are for whoever is driving the run.
        nonInteractive: values["non-interactive"] === true || values.json === true,
        json: values.json === true,
        noLocal: values["no-local"] === true,
        ...(values.rebuild === true ? { rebuild: true } : {}),
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        ...(values.project !== undefined ? { project: values.project } : {}),
        ...(values["first-workspace"] !== undefined ? { firstWorkspace: values["first-workspace"] } : {}),
        ...(values.import !== undefined ? { importFolder: values.import } : {}),
        ...(values.on !== undefined ? { on: values.on } : {}),
        upCommand: upCommandFor(opts, values),
        forkCommand: forkCommandFor(opts, values),
      }),
  },
  add: {
    page: "front",
    usage:
      "wsp add [<user@host>|<ssh alias>|<folder>|<url>|<owner/repo>|<provider>|<computer> --update|<computer> --sign-in <agent>] [--on <computer>] [--name <name>] [--base <branch>] [--yes] [--keep <path>] [--cut <path>] [--no-memory] [--no-commits] [--remember] [--ssh-port <port>] [--ssh-key <path>] [--host-key <key>]",
    about:
      "a computer of yours over ssh by user@host or by an alias from your ssh config, or a project: a folder on this computer, which every workspace of it is a copy of, or a repo a computer clones with --on <computer>; <provider> takes a provider's key, nothing prints the join line another computer types, a computer with --update puts this wsp's daemon on one already in, and a computer with --sign-in signs that agent in there once, outside every workspace on it",
    json: false,
    host: "hostSide",
    cliOnly: "hands out a code that lets another computer join this wsp, or takes a provider's key into this person's own files; both belong with the terminal the host runs at",
    run: (io, opts, values, args) =>
      addCommand(io, { ...startingPick(opts, values), providerEnv: opts.providerEnv }, args, addFlags(values.name, values["ssh-port"], values["ssh-key"], values.update, values.on, values.base, values["sign-in"], {
        ...(values.yes === true ? { yes: true } : {}),
        ...(values.keep !== undefined ? { keep: values.keep } : {}),
        ...(values.cut !== undefined ? { cut: values.cut } : {}),
        ...(values["no-memory"] === true ? { noMemory: true } : {}),
        ...(values["no-commits"] === true ? { noCommits: true } : {}),
        ...(values.remember === true ? { remember: true } : {}),
      }, values["host-key"])),
  },
  remove: {
    page: "front",
    usage: "wsp remove <computer>",
    about: "take a computer out; the agent and its files go, and the computer is left as wsp found it. Refused while a workspace or a project stands on it, naming them",
    json: false,
    host: "hostSide",
    cliOnly: "takes a computer out of this wsp and sweeps wsp off it, which belongs with the terminal that joined it",
    run: (io, opts, values, args) => removeCommand(io, startingPick(opts, values), args),
  },
  join: {
    page: "agent",
    usage: "wsp join <url>... --code <code> [--code-file <path>] [--name <name>]",
    about: "on the computer you are sitting at: join it to the wsp at that address, then install the daemon as a systemd system unit, which dials again at every boot. A place is a Linux computer; a Mac refuses",
    json: false,
    host: "refused",
    cliOnly: "joins the computer it is typed on to somebody's wsp and keeps the key it proves itself with in this person's own files; where their computer belongs is theirs to say",
    run: (io, _opts, values, args) =>
      joinCommand(io, args, {
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values["code-file"] !== undefined ? { codeFile: values["code-file"] } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
      }),
  },
  [PLACE_LEAVE_VERB]: {
    page: "agent",
    usage: PLACE_LEAVE_LINE,
    about: "on that computer: take wsp off it, for a computer whose host is gone and cannot run wsp remove",
    json: false,
    host: "refused",
    cliOnly: "sweeps wsp off the computer it is typed on, which belongs with the terminal that joined it",
    run: (io, _opts, _values, args) => leaveCommand(io, args),
  },
  doctor: {
    page: "dev",
    usage: DOCTOR_USAGE,
    about:
      "prove a computer end to end. With no word, this computer and then every computer you added, forking nothing and billing nothing. With a computer's name, that one: a joined computer is proved by the host that computer dials, which makes a short-lived workspace there and reads the recipe's tools inside it, and this line prints what the host says; a cloud account gets your image forked, wsp put on the fork, a file coming back and the teardown, which forks a live machine and bills while it runs. --local proves this computer alone: a thread here and its reply, no machine, no key. --project names the project the workspace is made of, by name, on the computer named",
    json: false,
    host: "refused",
    cliOnly: "runs for minutes, makes and deletes a workspace on the computer you named, and on a cloud account forks a live machine that bills while it runs; a person decides that at a terminal",
    run: async (io, opts, values, args, deps) => {
      await adoptLoginPath(line => io.log(line));
      // One wiring for this computer, so the daemon the copy road would run and the one the doctor reads the
      // version off are the same process. Its sink keeps nothing: this is a person's screen, and what the daemon
      // says on its own stderr as it starts is not the answer they asked for.
      const local = localWiring(homedir(), process.env, undefined, opts.statePath, undefined, () => {});
      const hereDaemon = local.hereDaemon;
      const word = args[0];
      if (args.length > 1) throw usageRefusal(`wsp doctor proves one computer, and it was given ${args.length} words: ${args.map(w => JSON.stringify(w)).join(" ")}.`, DOCTOR_USAGE);
      // Read once, and printed at the end of every road: what is still open after a road closed what it opened is
      // what would hold this process after its last line.
      const showHandles = opts.env[DOCTOR_HANDLES_ENV] === "1";
      const latest = latestHere(opts.statePath, opts.env);
      const handles = (road: string): void => {
        if (showHandles) io.error(`${road} left open: ${process.getActiveResourcesInfo().join(", ") || "nothing"}`);
      };
      // The local road touches no provider, so a missing key is not asked for: it is the whole of the doctor for a
      // person whose wsp init took the local road.
      if (values.local === true) {
        if (word !== undefined) throw usageRefusal(`wsp doctor --local proves this computer alone, so there is no computer to name beside it, and it was given ${JSON.stringify(word)}.`, DOCTOR_USAGE);
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv, opts.statePath), NO_CLOUD_KEY);
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(), env, undefined, local);
        try {
          return await doctor(rt, io, { ...(hereDaemon !== undefined ? { hereDaemon } : {}), ...(latest !== undefined ? { latest } : {}) });
        } finally {
          await rt.close();
          handles("the local road");
        }
      }
      // A project is the one a workspace on the computer named is made of, so it means nothing spread over every
      // computer this host holds: a run with no word would hand it to each of them and fail on any without it.
      if (values.project !== undefined && word === undefined) throw usageRefusal("wsp doctor --project names the project the workspace on the computer you named is made of, and no computer was named.", DOCTOR_USAGE);
      const project = values.project === undefined ? {} : { project: values.project };
      /** The roads this terminal walks itself: this computer, whose files and threads are here, and a cloud
       * account, whose fork bills and whose key is asked for where a person is sitting. The runtime is this
       * process's own and is closed on the way out, pass or fail. */
      const terminalRoad = async (computer?: PlaceView): Promise<number> => {
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv, opts.statePath), doctorKeyAsk(computer));
        // One planner for this run: the recipe the tools step reads against is the one the recipe job puts on a
        // computer, read through the wiring this runtime holds its links with.
        const links = placeWiring(opts.statePath);
        const provision = links.provision;
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(), env, undefined, local, links);
        try {
          return await doctor(rt, io, {
            envs: claudeEnvs(),
            ...(values.yes === true ? { yes: true } : {}),
            ...(computer !== undefined ? { computer } : {}),
            ...project,
            ...(hereDaemon !== undefined ? { hereDaemon } : {}),
            ...(latest !== undefined ? { latest } : {}),
            vault: () => vaultNow(opts.statePath),
            ...(provision !== undefined ? { plan: () => provision.plan({ home: GUEST_HOME }) } : {}),
            statePath: opts.statePath,
          });
        } finally {
          // The version read starts the daemon for this computer's workspace where nothing had; a run that left it
          // standing would hold the terminal after its last line.
          await rt.close();
          handles(computer?.kind === "provider" ? "the cloud road" : "the local road");
        }
      };
      // This computer's own host and no other: the word in the environment and the account's one host name hosts that
      // hold no link to the computers this line proves, and --host is refused on this line for the same reason.
      const dialling = dialHere(io, opts);
      // With no word: this computer first, on a runtime of this terminal's own and closed before anything else,
      // then every computer joined to this one, each on the host that holds its link.
      if (word === undefined) {
        const here = await terminalRoad();
        const client = await deps.dial(opts.statePath, dialling);
        try {
          const rows = (await client.request<{ places: PlaceView[] }>("places.list")).places;
          const said = await doctorOverHost(client, io, rows, project);
          return said === 0 ? here : said;
        } finally {
          client.close();
          handles("the computer road");
        }
      }
      // Which row the word names is read off the host that holds the links, since a computer reads present off the
      // map of links the process it dialled is holding and a fresh runtime here holds none. A host is started for
      // it where none serves, the way wsp add --update starts one.
      const client = await deps.dial(opts.statePath, dialling);
      let computer: PlaceView | undefined;
      try {
        computer = doctorRow((await client.request<{ places: PlaceView[] }>("places.list")).places, word);
        // A computer somebody joined is proved on the host holding its link, which prints what that host says.
        if (isJoinedComputer(computer)) return await hostDoctor(client, io, computer, project);
      } finally {
        client.close();
        // Named for the road that was walked: a word that turned out to be this computer's own row or a cloud row
        // read the list over this socket and then took a road of the terminal's own, which says its own line.
        if (computer !== undefined && isJoinedComputer(computer)) handles("the computer road");
      }
      return terminalRoad(computer);
    },
  },
};

/** What each line of the shared parse does with --host, the one fact the parse, its refusal and the usage table read. */
export const HOST_FLAG: Readonly<Record<string, HostFlag>> = Object.fromEntries(Object.entries(COMMANDS).map(([words, command]) => [words, command.host]));

/** The lines of the shared parse that run against a host somewhere else, the one fact its refusal reads. The two
 * that take the flag only to say they run at that host's own terminal are not among them: a person told to read
 * this list wants the words that answer for a host over there. */
export const HOST_COMMANDS: readonly string[] = Object.keys(HOST_FLAG).filter(w => HOST_FLAG[w] === "aimed");

/** Every line the shared parse serves, by its words: what a flag row names when it is read by all of them. */
export const SHARED_WORDS: readonly string[] = Object.keys(COMMANDS);

/** The table itself, for whatever reads a line's own help without running it. */
export const COMMANDS_FOR_HELP: Readonly<Record<string, Command>> = COMMANDS;

/** The word the plumbing folds under, and the lines it opens: one reading for the dispatch, the help and the
 * refusal that meets somebody who typed the word on its own. */
export const HOST_WORD = "host";
export const HOST_LINES: readonly string[] = Object.keys(COMMANDS).filter(w => w.startsWith(`${HOST_WORD} `));

/** The command a line of positionals selects: the longest key whose words open it, the same rule findVerb reads. */
function findCommand(words: readonly string[]): { words: string; command: Command } | undefined {
  const key = Object.keys(COMMANDS)
    .filter(k => k.split(" ").every((w, i) => words[i] === w))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : { words: key, command: COMMANDS[key]! };
}

/** The words that take --json on the shared parse and those that refuse it, the one fact the refusal and its test read. */
export const JSON_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => COMMANDS[w]!.json);
export const PROSE_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => !COMMANDS[w]!.json);

type Options = NonNullable<ParseArgsConfig["options"]>;

/** The word `mcp` opens the command, as a verb's words open a verb: its flags are its own, so it is dispatched on
 * that word before the shared parse ever sees them. */
const MCP_COMMAND = "mcp";

/** The flags `wsp mcp` and `wsp mcp install` parse. */
export const MCP_OPTIONS: Options = {
  agent: { type: "string", multiple: true },
  host: { type: "string" },
  json: { type: "boolean" },
  remove: { type: "boolean" },
  state: { type: "string" },
  scoped: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const mcpInstallUsage = (): string => `wsp ${MCP_COMMAND} install --agent <id> [--agent <id>] [--host <alias>] [--json] [--remove]   (${MCP_AGENT_IDS})`;
const mcpUsage = (): string => `usage: wsp ${MCP_COMMAND} [--host <alias>] [${SCOPED_MCP_ARG}]\n       ${mcpInstallUsage()}`;

/** The usage of the command a line stopped short of, whether it is a verb, `mcp` or the word the plumbing folds
 * under; none when no command owns the word. `mcp` needs its own answer here because it is not in the verb table
 * and its flags follow the word. */
function commandUsage(word: string): string | undefined {
  if (word === MCP_COMMAND) return mcpUsage();
  if (word === HOST_WORD) return HOST_LINES.map(words => `usage: wsp ${words}`).join("\n");
  return verbUsage(word);
}

/** `wsp mcp` serves until the agent closes its stdin; `wsp mcp install --agent <id>` writes the agent's config,
 * once per `--agent` given, and answers with the lines or, with `--json`, the report as one line. Its flags are
 * parsed here rather than in the table every command shares, so a command that has no JSON to print refuses
 * `--json` instead of taking it and printing prose. */
async function mcp(io: CliIO, argv: string[], statePathOf: (flag?: string) => string, run: RunningWsp, env: Readonly<Record<string, string | undefined>>, starts: { start?: HostStarter }): Promise<number> {
  const usage = mcpUsage();
  let values: { agent?: string[]; host?: string; json?: boolean; remove?: boolean; state?: string; scoped?: boolean; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({ args: argv, options: MCP_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), usage));
  }
  if (values.help === true) {
    io.log(mcpPage(words[0] === "install"));
    return 0;
  }
  // Ahead of every reading of the state: a scoped server missing its pair would otherwise dial this computer's host
  // on the host's own token, which is acting as the person.
  if (values.scoped === true && words.length === 0 && hostFromEnv(env) === undefined) return failed(io, jsonAsked(argv), authRefusal(scopedNoPairLine));
  const statePath = statePathOf(values.state);
  if (words.length === 0) {
    // The agent starts the server in its own folder, which is the folder a thread opened with no workspace is placed by.
    await serveMcp(statePath, { alsoHere, cwd: process.cwd(), env, ...starts, ...(values.host !== undefined ? { host: values.host } : {}) });
    return 0;
  }
  const json = values.json === true;
  if (words[0] !== "install" || words.length !== 1) return failed(io, json, usageRefusal(unknownWordLine(`${MCP_COMMAND} ${words.join(" ")}`), runForTheList(`wsp ${MCP_COMMAND} --help`)));
  // Nobody named an agent: at a terminal that is a line half typed, but an agent running this has no terminal to be
  // asked at, so every agent whose own command is on this computer's PATH takes it.
  const agents = values.agent ?? (io.isTTY === true ? [] : agentsOnPath(run.PATH));
  if (agents.length === 0) {
    const none =
      io.isTTY !== true
        ? "wsp mcp install: no agent of the catalog's is on this computer's PATH."
        : "wsp mcp install writes the config of the agents it is given, and was given none.";
    return failed(io, json, usageRefusal(none, `Name one with --agent.\n\nusage: ${mcpInstallUsage()}`));
  }
  const project = process.cwd();
  if (values.remove === true) {
    const gone = removeEach(agents, project);
    if (json) io.log(jsonLine(gone));
    else {
      for (const agent of gone.removed) for (const line of removeLines(agent)) io.log(line);
      for (const failed of gone.failures) io.error(`wsp mcp install: ${failed.error}`);
    }
    return gone.failures.length > 0 ? 1 : 0;
  }
  const report = installEach(agents, mcpServerSpec(statePath, run, values.host !== undefined ? { host: values.host } : {}), homedir(), project);
  if (json) io.log(jsonLine(report));
  else {
    for (const placed of report.installed) for (const line of installLines(placed)) io.log(line);
    const registered = registeredLine(report);
    if (registered !== undefined) io.log(registered);
    for (const failed of report.failures) io.error(`wsp mcp install: ${failed.error}`);
    const next = nextLine(report);
    if (next !== undefined) io.log(next);
  }
  return report.failures.length > 0 ? 1 : 0;
}

/** What the forwarder asks before it serves `wsp mcp` itself: the host this line would serve against, as one JSON
 * line on stdout, when that is the host on this computer and it is serving, brought up first when the ask says
 * start. Anything else prints nothing and serves nothing: at the start of a session the forwarder runs the same line
 * as a wsp of its own next, which says whatever this one would have. The one thing said is why a host could not be
 * brought up, since the ask to start comes mid-session and nothing runs after it to say so. */
async function forwardDoor(io: CliIO, argv: string[], env: Readonly<Record<string, string | undefined>>, starts: { start?: HostStarter }): Promise<number> {
  // The token is the host's; it goes down a pipe to the forwarder and never onto a terminal.
  if (io.redraw !== undefined) return 0;
  let values: { host?: string; state?: string; scoped?: boolean; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({ args: argv, options: MCP_OPTIONS, allowPositionals: true }));
  } catch {
    return 0;
  }
  // A scoped line is a thread's own tools, which never ride the host's token: the wsp run next serves or refuses it.
  if (values.help === true || values.scoped === true || words.length > 0) return 0;
  const notes: string[] = [];
  try {
    const statePath = statePathFrom(values.state, env, line => notes.push(line));
    const pick = { env, ...(values.host !== undefined ? { host: values.host } : {}) };
    if (starts.start !== undefined && aimedHost(statePath, pick).kind === "here" && servingHost(statePath) === undefined) await starts.start(statePath, line => io.error(line));
    const door = hereDoor(statePath, pick);
    if (door === undefined) return 0;
    for (const note of notes) io.error(note);
    io.log(JSON.stringify(door));
  } catch (e) {
    if (starts.start !== undefined) io.error(e instanceof Error ? e.message : String(e));
  }
  return 0;
}

/** The flags the shared parse reads for up, init and doctor. The ones that shape a serving host come from the table
 * the service's unit is written out of, so neither road can read a flag the other has never heard of. */
export const SHARED_OPTIONS: Options = {
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  ...SERVE_OPTIONS,
  yes: { type: "boolean", short: "y" },
  "non-interactive": { type: "boolean" },
  json: { type: "boolean" },
  recipe: { type: "string" },
  project: { type: "string" },
  "first-workspace": { type: "string" },
  import: { type: "string" },
  on: { type: "string" },
  rebuild: { type: "boolean" },
  "no-local": { type: "boolean" },
  local: { type: "boolean" },
  service: { type: "boolean" },
  code: { type: "string" },
  "code-file": { type: "string" },
  "ssh-port": { type: "string" },
  "ssh-key": { type: "string" },
  "host-key": { type: "string" },
  base: { type: "string" },
  keep: { type: "string", multiple: true },
  cut: { type: "string", multiple: true },
  "no-memory": { type: "boolean" },
  "no-commits": { type: "boolean" },
  remember: { type: "boolean" },
  watch: { type: "boolean" },
  update: { type: "boolean" },
  "sign-in": { type: "string" },
  name: { type: "string" },
  host: { type: "string" },
};

const without = (options: Options, names: readonly string[]): Options => Object.fromEntries(Object.entries(options).filter(([name]) => !names.includes(name)));

/** The flags a line of the shared parse takes, read off the command that runs it: a line of two words or more is
 * selected by its first word, so it advertises exactly what that word's `json` and `host` say and never a list
 * written out beside it, which is how a flag added to the shared parse reached seven lines that refuse it. */
function optionsFor(words: string): Options {
  const found = findCommand(words.split(" "));
  if (found === undefined) throw new Error(`wsp ${words} is in the command lines and no command answers it`);
  const { command } = found;
  return without(SHARED_OPTIONS, [...(command.json ? [] : ["json"]), ...(command.host === "refused" ? ["host"] : [])]);
}

/** A line `wsp` answers: the words after `wsp` that select it, the shape of the line and one phrase on what it
 * does, the page it prints on, every flag it parses (anything else is a usage error), and its other door: the MCP
 * tool it is served as, or why it has none. */
export type CommandLine = { words: string; options: Options; page: Page; usage: string; about: string } & ({ tool: string } | { cliOnly: string });

/** Every line `wsp` answers, with the flags it takes and the page it prints on: what the pages, the skill's
 * examples and the MCP tools are all held to. */
export const COMMAND_LINES: readonly CommandLine[] = [
  ...CLI_VERBS.map(v => ({ words: v.name, usage: v.usage, about: v.about, page: v.page, options: { ...COMMON, ...v.options }, ...("cliOnly" in v ? { cliOnly: v.cliOnly } : { tool: toolName(v.name) }) })),
  { words: MCP_COMMAND, options: MCP_OPTIONS, page: "front" as const, usage: mcpUsage().replace(/^usage: /, ""), about: "serve the verbs as tools over stdio to an agent on this computer", cliOnly: "is the tool server itself" },
  {
    words: `${MCP_COMMAND} install`,
    options: MCP_OPTIONS,
    page: "agent" as const,
    usage: mcpInstallUsage(),
    about: `put the wsp tools, this skill and wsp's own section of this folder's AGENTS.md into that agent (${MCP_AGENT_IDS}); --agent repeats, --remove takes it back out, and --json prints what each agent took`,
    cliOnly: "writes an agent's own config and skills folder, which is done once from a shell",
  },
  ...Object.entries(COMMANDS).map(([words, command]) => ({ words, usage: command.usage, about: command.about, page: command.page, options: optionsFor(words), cliOnly: command.cliOnly })),
  // The two lines a word of the host page opens: they print inside their parent's usage, so they carry no page of
  // their own to print on, and they are here for the parity table and for the flags they take.
  { words: "host devices revoke", options: optionsFor("host devices revoke"), page: "host" as const, usage: "wsp host devices revoke <id>", about: "take one computer's token away", cliOnly: "takes away a computer's token, from the host's terminal or from a computer paired with it; who may drive a host is the person's to cut, never a thread's" },
];

/** What a caller reads after `wsp --help`: the page it names, or the front page when it names none. */
export const HELP_PAGES = ["agent", "dev"] as const;

/** The verbs an agent reaches for, one page in: every line whose entry says so, then the flags every verb takes,
 * the exit codes and the notes on how a turn ends. */
export function agentPage(): string {
  return [
    "the verbs an agent on this computer reaches for, and the lines you type yourself:",
    "up and down for the host, recipe and image for what a workspace starts from.",
    pageLines("agent"),
    "",
    "  wsp run and wsp send stream the reply as it arrives and print it once: on a",
    "  terminal the streamed copy is the reply, and into a pipe stdout carries it whole",
    "  at the end.",
    wrap(`  ${TURN_END_WORDS}.`, 80).join("\n"),
    "  wsp exec streams the command's output and exits with its code. run, send and",
    "  exec wake a paused workspace first, with one line on stderr saying so.",
    "",
    "every verb takes:",
    ...(["json", "state", "host"] as const).flatMap(name => wrap(`  ${`--${name}`.padEnd(15)}${COMMON_FLAG_WORDS[name]}`, HELP_WIDTH, " ".repeat(17))),
    "",
    "exit codes; every failure is one line on stderr, the failure object with --json:",
    exitCodeHelp(),
  ].join("\n");
}

/** The plumbing for a host on a computer you are not sitting at, and the one paragraph on when a person needs it. */
export function hostPage(): string {
  return [
    pageLines("host"),
    "",
    ...wrap(
      "You need these only for a host on a computer that is not the one you are sitting at: wsp login signs this computer in to your account and wsp hosts lists the hosts on it, which need no code at all. pair hands out the code a browser on another computer types to open a host, and it runs at that host's own terminal; devices lists the computers that hold a token for a host and takes one back out, from that terminal or from any computer signed in to it; link and unlink put the host on this computer onto your account, so it is reachable with no port open to the world.",
      HELP_WIDTH,
      "",
    ),
  ].join("\n");
}

/** The line a builder reaches for and nobody else, so the front page does not carry it. */
export function devPage(): string {
  return pageLines("dev");
}

/** Every line of one page: its usage, then what it does indented under it, so no line runs wide. */
function pageLines(page: Page): string {
  return COMMAND_LINES.filter(line => line.page === page)
    .map(line => [...usageLines(line.usage, "    "), ...wrap(`      ${line.about}`, HELP_WIDTH, "      ")].join("\n"))
    .join("\n");
}

/** A shared flag: the word, the commands that read it, and the sentence its own command's help prints. One parse
 * reads the union of them, and a flag typed on a command whose row does not name it is refused naming the ones
 * that do, so the sentences live beside the rule rather than in a page nobody reads to the end.
 *
 * One word can have a row per command where it means different things there: a flag's readers are every row that
 * names it, and each command's own help prints the row written for it. A single row answering for two commands
 * put both meanings in one paragraph, which is a page teaching rather than reminding. */
export interface SharedFlag {
  name: Extract<keyof SharedFlags, string>;
  /** The words of every command that reads it. */
  on: readonly string[];
  says: string;
}

export const SHARED_FLAGS: readonly SharedFlag[] = [
  { name: "state", on: SHARED_WORDS, says: `the state file: this word first, else WSP_HOME's state.json, else ./.wsp/state.json when the current directory is a checkout of wsp, else state.json in the home the running host serves` },
  { name: "port", on: ["up"], says: `the app port (default ${DEFAULT_PORT}); the runtime websocket port follows ${WS_PORT_OFFSET} above it` },
  { name: "ws-port", on: ["up"], says: `the runtime websocket port on its own (default ${DEFAULT_WS_PORT}); --port alone moves both` },
  { name: "listen", on: ["up"], says: `the address to bind (default ${LOOPBACK}, this computer alone). No page carries the host's token on any address: the desktop attaches by the token file beside the state, the browser wsp init opens is let in by init, and every other browser pairs for a device token of its own` },
  { name: "advertise", on: ["up"], says: "the address every machine dials this host at, whatever kind it is; each kind answers for its own machines without it" },
  { name: "no-relay", on: ["up"], says: "serve without the tunnel, on a computer that is linked to a relay" },
  { name: "service", on: ["up"], says: "install the host as a launchd agent on a Mac or a systemd user unit on Linux, which serves now and again at every login. The keys are not written into it: it reads the same .env a terminal run reads, so they have to be in a file" },
  { name: "provider", on: ["up", "init"], says: "which machine provider this computer forks on; without it, a key saved under a provider's own variable wires that provider" },
  { name: "code", on: ["join"], says: "the code the other computer printed: wsp add on the host" },
  { name: "code-file", on: ["join"], says: "read the code off this file and delete the file before dialing, so a code never sits on a disk" },
  { name: "watch", on: ["status"], says: "draw the same rows again every second where they stand, until Ctrl-C; it needs a terminal to redraw on, and reads nothing but this computer's own agent" },
  { name: "name", on: ["host link", "add", "join"], says: "the name to call the computer by here; what its address calls it without one" },
  { name: "ssh-port", on: ["add"], says: "the port ssh dials that computer on (default 22)" },
  { name: "ssh-key", on: ["add"], says: "the key file ssh logs in with; whatever your own ssh config and agent already use without it" },
  { name: "host-key", on: ["add"], says: "the host key of a computer this one has never dialled, as you read it on that computer; without it the add shows you the key that computer answers with and asks, and off a terminal it refuses rather than trusting whatever answers" },
  { name: "update", on: ["add"], says: "the place named is already in this wsp: put the daemon this wsp deploys on it, over the link it is holding or over the ssh road it was added on, restart its agent and keep the workspaces standing on it" },
  { name: "sign-in", on: ["add"], says: "the agent to sign in on the place named, once, outside every workspace on it: the sign-in runs on that computer and every workspace there shares the one login. Offered by the join itself; this is the same road for a computer already in" },
  { name: "yes", on: ["init"], says: "take every default and ask nothing, which a run off a terminal needs; a login with a browser or device sign-in, or one held in the Keychain, is left to the first time you need it on the workspace unless a saved recipe answered copy, so macOS has nothing to ask either and the build waits on nobody" },
  { name: "yes", on: ["doctor"], says: "also delete the snapshots and templates this host left behind, which is not reversible" },
  { name: "recipe", on: ["init"], says: "tick the agents and tools from this recipe (wsp recipe writes it) and go straight to the sign-ins" },
  { name: "project", on: ["init"], says: "the project folder you are bringing first; its own files say what it needs, and those rows are ticked first" },
  { name: "on", on: ["init"], says: "the computer the image is built on, by the name wsp computers lists, a box you joined included; the default place without it" },
  { name: "on", on: ["add"], says: "the computer a project lives on, by the name wsp computers lists: a repo's url needs one, since this computer copies a folder of yours and never clones" },
  { name: "base", on: ["add"], says: "the branch a workspace of the project starts on; the remote's own default branch at the clone without it" },
  { name: "yes", on: ["add"], says: "send the ticked rows of the seed menu; without it a folder seeding a project on another computer prints the menu and sends nothing, since what git ignores in your folder is yours" },
  { name: "keep", on: ["add"], says: "one more path off the seed menu that travels, however the catalogue ticked it; given once per path" },
  { name: "cut", on: ["add"], says: "one path off the seed menu that does not travel; given once per path" },
  { name: "no-memory", on: ["add"], says: "leave this folder's Claude Code memory here; the project's own memory on that computer then starts empty" },
  { name: "no-commits", on: ["add"], says: "leave the commits the remote does not have here; the computer's clone then starts at the remote's own tip" },
  { name: "remember", on: ["add"], says: "keep these ticks for this folder, so the next add of it starts with them rather than the catalogue's" },
  { name: "first-workspace", on: ["init"], says: "fork the first workspace under this name once the image seals, without asking (default first)" },
  { name: "import", on: ["init"], says: "import this folder's project onto that first workspace, with the consent the app's import starts from" },
  { name: "rebuild", on: ["init"], says: "seal the next version from a fresh machine rather than from your image plus the changes, which is the question a run at a terminal is asked; without it a run that asks nothing takes whichever road the changes call for" },
  { name: "no-local", on: ["init"], says: "leave this computer alone; the workspace step ticks it by default, since a workspace here forks nothing and bills nothing" },
  { name: "non-interactive", on: ["init"], says: "ask nothing, but still run the sign-ins on the machine: each prints the page to open on this computer, the code when the flow shows one, and the command that opens it, then waits for you" },
  { name: "local", on: ["doctor"], says: "prove this computer alone: a thread here and its reply, with no machine, no key, nothing forked and nothing billed" },
  { name: "project", on: ["doctor"], says: "the project the doctor's workspace is made of, by name, on the computer named; the first project there whose checkout stands when absent" },
];

/** Every command that reads one flag, over each of its rows: a word with a row per command is read by all of them,
 * so nothing refuses a flag one of its own rows names. */
export const readers = (name: string): string[] => SHARED_FLAGS.filter(f => f.name === name).flatMap(f => f.on);

/** What one command's own `--help` prints: its usage, what it does, and its own flags, one line each. */
export function commandPage(words: string, command: Command): string {
  return helpPage(command.usage, wrap(`  ${command.about}`, HELP_WIDTH, "  "), [
    ...SHARED_FLAGS.filter(f => f.on.includes(words)).map(f => [`--${f.name}`, f.says] as const),
    ...(command.json ? [["--json", COMMON_FLAG_WORDS.json] as const] : []),
    ...(command.host === "refused" ? [] : [["--host", command.host === "hostSide" ? COMMON_FLAG_WORDS.hostSide : COMMON_FLAG_WORDS.host] as const]),
  ]);
}

/** What each flag the tool server reads says on its own page. Its parse is its own, so its words are too; the page
 * they print on is the one every other line prints on. */
const MCP_FLAG_WORDS: Readonly<Record<string, string>> = {
  agent: `the agent to write the server, this skill and wsp's own section of AGENTS.md into, by catalog id (${MCP_AGENT_IDS}); repeats, and off a terminal every agent whose own command is on this computer's PATH takes it`,
  remove: "take the server, the skill and that section back out of those agents instead",
  json: "print what each agent took as one JSON object",
  state: COMMON_FLAG_WORDS.state,
  host: "write the server against a host on your account, by the name wsp hosts lists it under, so the tools drive that host",
  scoped: "what the host puts on a thread's own tools: without the launch pair in the environment the server refuses rather than dial this computer's host on its own token",
};

/** The tool server's own two pages, each with the flags it reads. `wsp mcp` alone serves; `wsp mcp install` writes
 * an agent's config. Both were two usage lines and no words until a person asked what --agent took. */
function mcpPage(install: boolean): string {
  const line = COMMAND_LINES.find(l => l.words === (install ? `${MCP_COMMAND} install` : MCP_COMMAND))!;
  const flags = install ? ["agent", "remove", "json", "state", "host"] : ["state", "host", "scoped"];
  return helpPage(line.usage, wrap(`  ${line.about}`, HELP_WIDTH, "  "), flags.map(name => [`--${name}`, MCP_FLAG_WORDS[name]!] as const));
}

/** `run` is how this process was started, which the MCP install writes into an agent's config as the way to start it
 * again; the desktop's bundled command hands in its shim, the npm command the default reading. `env` is the
 * environment the verbs run with, this process's for a real command line and its own for a test. `start` is what
 * brings a host up when none serves the state file: the one built from `run` unless a caller says otherwise, and
 * `false` for a caller that wants a line with no host to refuse rather than start one. `caller` is where the line was
 * typed: the folder, which a thread with no workspace is placed by, and whether that place is somewhere other than
 * this computer, which is what every rule that would read a path here reads. This process's own folder and here by
 * default; a line typed inside a machine says both. */
export async function cli(
  argv: string[],
  io: CliIO = terminalIO(),
  run: RunningWsp = runningWsp(),
  given: Readonly<Record<string, string | undefined>> = process.env,
  start?: HostStarter | false,
  caller: { cwd?: string; elsewhere?: boolean } = {},
  deps: CommandDeps = SYSTEM_COMMAND_DEPS,
): Promise<number> {
  // The forwarder's ask is this line's alone: nothing it starts or runs carries it, or the host a line brings up
  // would hand it to every wsp its turns run.
  const forward = given[FORWARD_ENV];
  const env = forward === undefined ? given : Object.fromEntries(Object.entries(given).filter(([name]) => name !== FORWARD_ENV));
  const starter = start ?? starterFor(run, env);
  const starts = starter === false ? {} : { start: starter };
  // One reading for every road out of this process, and the sentence about it said once: a verb, a command and the
  // tool server all pick their state here, so none of them can run against a state another of them named.
  const chooseState = (flag?: string): string => statePathFrom(flag, env, line => io.error(line));
  // The flags every line shares are taken off the whole line here, before the words that select the line are read,
  // so one of them binds wherever it was typed and what is left reaches its own parse in the order it was given.
  const { common, rest } = takeCommon(argv);
  const verb = findVerb(rest);
  if (verb !== undefined) {
    const words = verb.name.split(" ");
    return runVerb(verb, [...words, ...common, ...rest.slice(words.length)], io, chooseState, { alsoHere, cwd: caller.cwd ?? process.cwd(), env, open: systemOpener(), ...starts, ...(caller.elsewhere === true ? { elsewhere: true } : {}) });
  }
  if (rest[0] === MCP_COMMAND) {
    const argv = [...common, ...rest.slice(1)];
    return forward === undefined ? mcp(io, argv, chooseState, run, env, starts) : forwardDoor(io, argv, env, forward === "start" ? starts : {});
  }
  let values: SharedFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...common, ...rest], options: SHARED_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), runForTheList("wsp --help")));
  }
  if (values.version) {
    io.log(`wsp ${VERSION}`);
    return 0;
  }
  // `help` is the word for the flag: a person reaching for it types one as readily as the other, and answering the
  // word with a typo's refusal is the tool arguing about punctuation. A line that opens with it is that same line
  // with the flag on it, so what follows selects a page or a command as it would either way. A line with no word at
  // all asks the same question: typing the program's name asks what it is, and answering by serving made a second
  // host of it.
  const asked = positionals[0] === "help" ? positionals.slice(1) : positionals;
  const wantsHelp = values.help === true || positionals[0] === "help" || asked.length === 0;
  const word = asked[0];
  // The word the plumbing folds under prints its own page, by itself or with the flag every other line answers to.
  if (word === HOST_WORD && asked.length === 1) {
    io.log(hostPage());
    return 0;
  }
  if (wantsHelp && findCommand(asked) === undefined) {
    // A command asking for its own help falls through to the parse below; only a word no command answers to is
    // read as the name of a page.
    if (word === undefined) {
      io.log(HELP);
      return 0;
    }
    const page = HELP_PAGES.find(p => p === word);
    if (page !== undefined) {
      io.log(page === "agent" ? agentPage() : devPage());
      return 0;
    }
    if (word === HOST_WORD) {
      io.log(hostPage());
      return 0;
    }
    // A word that opens lines rather than being one answers with the lines it opens, as it does without the flag.
    const opens = commandUsage(word);
    if (opens !== undefined) {
      io.log(opens);
      return 0;
    }
    return failed(io, values.json === true, usageRefusal(`wsp --help takes a page, and got ${word}.`, `The pages are ${HELP_PAGES.map(p => `wsp --help ${p}`).join(", ")} and wsp host --help.`));
  }
  const opts = { ...optsFor(values, env, line => io.error(line)), ...starts };
  const found = findCommand(asked);
  const json = values.json === true;
  if (found === undefined) {
    // A word that opens a line but is no line of its own gets the lines it opens; one no command answers to gets
    // the pointer, since the help behind it runs to hundreds of rows.
    const usage = commandUsage(word!);
    const refusal = usage === undefined ? usageRefusal(unknownWordLine(word!), runForTheList("wsp --help")) : usageRefusal(`wsp ${word!} opens a line rather than being one.`, usage);
    return failed(io, json, refusal);
  }
  const { words, command } = found;
  // The line's own help, in place of the whole front page: its usage, what it does and its own flags.
  if (wantsHelp) {
    io.log(commandPage(words, command));
    return 0;
  }
  if (json && !command.json) {
    return failed(io, json, usageRefusal(`Unknown option '--json' for wsp ${words}: it answers in prose.`, `That flag belongs to ${JSON_COMMANDS.map(w => `wsp ${w}`).join(", ")}, and to every verb.`));
  }
  if (values.host !== undefined && command.host === "refused") {
    return failed(io, json, usageRefusal(`Unknown option '--host' for wsp ${words}: it runs on this computer.`, `That flag belongs to ${HOST_COMMANDS.map(w => `wsp ${w}`).join(", ")}, and to every verb.`));
  }
  // A flag another command of the shared parse reads: the union is one parse, so the line that does not read it is
  // told which lines do rather than taking it and doing nothing with it.
  const foreign = SHARED_FLAGS.find(f => values[f.name] !== undefined && !readers(f.name).includes(words));
  if (foreign !== undefined) {
    return failed(io, json, usageRefusal(foreignFlagLine(`--${foreign.name}`, readers(foreign.name).map(w => `wsp ${w}`), `wsp ${words}`), `usage: ${command.usage}`));
  }
  try {
    return await command.run(io, opts, values, asked.slice(words.split(" ").length), deps);
  } catch (e) {
    return failed(io, json, e);
  }
}
