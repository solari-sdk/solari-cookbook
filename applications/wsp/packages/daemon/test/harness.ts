// SPDX-License-Identifier: AGPL-3.0-only
// The daemon under test: the wsp-daemon binary, spawned with the flags a test
// names and stopped with it. Every suite that needs a running daemon starts it
// here, so the flags are spelled once and what a test may ask of a daemon is
// what a binary can answer. The binary is this computer's own out of the
// daemon asset (packages/wspx/scripts/daemon-binary.mjs places it there out of
// a cargo build), or the one WSP_DAEMON_BIN names.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonListeningLine } from "@wsp/protocol";
import { daemonBinaryHere } from "../../host/src/assets.js";
import { daemonTokenFor } from "../../runtime/src/daemon-token.js";

/** An agent to look for on the place's PATH at every link, as catalog id and command name. */
export interface AgentBin {
  id: string;
  bin: string;
}

/** Every flag a daemon takes, one per option, so a deploy script and this harness spell a daemon the same way. */
export interface DaemonArgs {
  host?: string;
  port?: number;
  tokenPath?: string;
  root?: string;
  rootsPath?: string;
  /** Any word: the daemon refuses a kind it does not serve at the watch, in the sentence the pane prints, and the
   * words it serves are its own rather than the protocol's workspace kinds (a place is not one of those). */
  kind?: string;
  workFolder?: string;
  inbox?: string;
  inboxQuietMs?: number;
  inboxPollMs?: number;
  manifest?: string;
  runDir?: string;
  logDir?: string;
  openSocket?: string;
  portFile?: string;
  procRoot?: string;
  passwd?: string;
  portsIntervalMs?: number;
  sysIntervalMs?: number;
  procIntervalMs?: number;
  modeIntervalMs?: number;
  authDeadlineMs?: number;
  /** Set, the daemon dials the host this file names instead of only listening: it is a place agent. */
  placeFile?: string;
  /** Where the place keeps its files and what its sweep takes. */
  home?: string;
  /** The line that runs wsp on this computer, one word per flag, reported to the host. */
  wspArgv?: string[];
  /** The agents to look for on this computer's PATH at every link; the report names the ids whose command is there. */
  agents?: AgentBin[];
  linkConnectMs?: number;
  linkQuietMs?: number;
  linkRefusedRetryMs?: number;
  linkBackoffMs?: number;
  /** Where a place's daemon keeps the layers and the workspaces it runs. */
  runtimeRoot?: string;
}

type Flag = { readonly flag: string; readonly key: keyof DaemonArgs; readonly takes: "word" | "int" | "words" | "pairs" };

/** Every flag, in the order daemonArgv writes them. A flag takes one word, one integer, one word per use, or one
 * comma-separated list of id=command pairs. */
const FLAGS: readonly Flag[] = [
  { flag: "--host", key: "host", takes: "word" },
  { flag: "--port", key: "port", takes: "int" },
  { flag: "--token-path", key: "tokenPath", takes: "word" },
  { flag: "--root", key: "root", takes: "word" },
  { flag: "--roots-path", key: "rootsPath", takes: "word" },
  { flag: "--kind", key: "kind", takes: "word" },
  { flag: "--work-folder", key: "workFolder", takes: "word" },
  { flag: "--inbox", key: "inbox", takes: "word" },
  { flag: "--inbox-quiet-ms", key: "inboxQuietMs", takes: "int" },
  { flag: "--inbox-poll-ms", key: "inboxPollMs", takes: "int" },
  { flag: "--manifest", key: "manifest", takes: "word" },
  { flag: "--run-dir", key: "runDir", takes: "word" },
  { flag: "--log-dir", key: "logDir", takes: "word" },
  { flag: "--open-socket", key: "openSocket", takes: "word" },
  { flag: "--port-file", key: "portFile", takes: "word" },
  { flag: "--proc-root", key: "procRoot", takes: "word" },
  { flag: "--passwd", key: "passwd", takes: "word" },
  { flag: "--ports-interval-ms", key: "portsIntervalMs", takes: "int" },
  { flag: "--sys-interval-ms", key: "sysIntervalMs", takes: "int" },
  { flag: "--proc-interval-ms", key: "procIntervalMs", takes: "int" },
  { flag: "--mode-interval-ms", key: "modeIntervalMs", takes: "int" },
  { flag: "--auth-deadline-ms", key: "authDeadlineMs", takes: "int" },
  { flag: "--place-file", key: "placeFile", takes: "word" },
  { flag: "--home", key: "home", takes: "word" },
  { flag: "--wsp-argv", key: "wspArgv", takes: "words" },
  { flag: "--agents", key: "agents", takes: "pairs" },
  { flag: "--link-connect-ms", key: "linkConnectMs", takes: "int" },
  { flag: "--link-quiet-ms", key: "linkQuietMs", takes: "int" },
  { flag: "--link-refused-retry-ms", key: "linkRefusedRetryMs", takes: "int" },
  { flag: "--link-backoff-ms", key: "linkBackoffMs", takes: "int" },
  { flag: "--runtime-root", key: "runtimeRoot", takes: "word" },
];

/** The argv that names these args, so a deploy script and this harness spell a daemon the same way. */
export function daemonArgv(args: DaemonArgs): string[] {
  const argv: string[] = [];
  for (const f of FLAGS) {
    const value = args[f.key];
    if (value === undefined) continue;
    if (f.takes === "pairs") argv.push(f.flag, (value as AgentBin[]).map(a => `${a.id}=${a.bin}`).join(","));
    else if (Array.isArray(value)) for (const word of value as string[]) argv.push(f.flag, word);
    else argv.push(f.flag, String(value));
  }
  return argv;
}

export interface DaemonUnderTest {
  port: number;
  /** The daemon's own pid and its parent's, the two proc.kill protects beside init. */
  pid: number;
  parentPid: number;
  /** Every line the daemon has logged so far. */
  log(): string[];
  /** Settles when the daemon ended of its own accord: a leave it answered, or the child exiting. */
  exited: Promise<void>;
  close(): Promise<void>;
}

/** The flags, plus a token to write into a file for --token-path, since no daemon takes a token on its command line. */
export type DaemonUnderTestArgs = DaemonArgs & { token?: string };

/** The token a host writes one machine, which is what a daemon standing in for that machine must hold: a machine's
 * token is the seed's answer for that machine's id, and the stub backend names its machines in the order they are
 * forked. */
export const machineDaemonToken = (seed: string, machineId: string): string => daemonTokenFor(seed, machineId);

/** The binary the suite drives: the one WSP_DAEMON_BIN names, else this computer's own out of the daemon asset.
 * A checkout where nobody built it is told how, since no node build makes one. */
export function daemonBin(): string {
  const said = process.env["WSP_DAEMON_BIN"];
  if (said !== undefined && said !== "") return resolve(said);
  try {
    return daemonBinaryHere();
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nbuild it with \`cargo build --release\` in daemon/ and place it with \`node packages/wspx/scripts/daemon-binary.mjs\``);
  }
}

export async function daemonUnderTest(given: DaemonUnderTestArgs): Promise<DaemonUnderTest> {
  const { token, ...args } = given;
  if (token === undefined) return spawnDaemon(daemonBin(), args);
  const tokenDir = mkdtempSync(join(tmpdir(), "wsp-daemon-token-"));
  args.tokenPath = join(tokenDir, "token");
  writeFileSync(args.tokenPath, `${token}\n`);
  const daemon = await spawnDaemon(daemonBin(), args);
  return {
    ...daemon,
    close: async () => {
      await daemon.close();
      rmSync(tokenDir, { recursive: true, force: true });
    },
  };
}

/** How long a binary gets to print its listening line. */
const START_MS = 10_000;

/** The two waits a spawned daemon gets, for a test of the harness itself to shorten. */
export interface SpawnWaits {
  startMs?: number;
  stopMs?: number;
}
/** How long a child gets to leave on SIGTERM before it is killed outright. */
const STOP_MS = 5_000;

/** The listening line as a pattern that reads the port off it, whatever host the daemon printed. */
const LISTENING = new RegExp(
  daemonListeningLine("HOST", "PORT")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("HOST", ".*")
    .replace("PORT", "(\\d+)"),
);

/** The binary as the daemon under test: spawned with the flags, its port read off its listening line, its stderr
 * kept, and nothing of it left running once the test is done with it or gave up on it. */
export async function spawnDaemon(bin: string, args: DaemonArgs, waits: SpawnWaits = {}): Promise<DaemonUnderTest> {
  const startMs = waits.startMs ?? START_MS;
  const stopMs = waits.stopMs ?? STOP_MS;
  const child = spawn(bin, daemonArgv(args), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const lines: string[] = [];
  let rest = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const parts = `${rest}${chunk}`.split("\n");
    rest = parts.pop() ?? "";
    lines.push(...parts);
  });
  let gone = false;
  // exit, not close: a child of the daemon that inherited its stderr (an exec, a probe) would hold close open.
  const exited = new Promise<void>(done =>
    child.once("exit", () => {
      gone = true;
      if (rest !== "") lines.push(rest);
      done();
    }),
  );
  const said = (): string => lines.join("\n");
  // Nothing a test started outlives it: a binary that bound and never printed its line is killed before the wait ends.
  const stop = async (): Promise<void> => {
    if (gone) return;
    child.kill("SIGTERM");
    const hard = setTimeout(() => child.kill("SIGKILL"), stopMs);
    await exited;
    clearTimeout(hard);
  };
  const port = await new Promise<number>((done, fail) => {
    let out = "";
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      void stop().then(() => fail(new Error(`${bin} did not print its listening line within ${startMs} ms:\n${said()}`)));
    }, startMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const m = LISTENING.exec(out);
      if (m === null) return;
      clearTimeout(timer);
      done(Number(m[1]));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      // A child the timeout took down is reported by the timeout, with what it said.
      if (!gaveUp) fail(new Error(`${bin} exited with ${code} before it listened:\n${said()}`));
    });
    child.once("error", e => {
      clearTimeout(timer);
      void stop().then(() => fail(e));
    });
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${bin} started without a pid`);
  return {
    port,
    pid,
    // The child is this process's own, so its parent is this process.
    parentPid: process.pid,
    log: () => [...lines],
    exited,
    close: stop,
  };
}
