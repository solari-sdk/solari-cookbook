// SPDX-License-Identifier: AGPL-3.0-only
// The backend for a workspace on a machine reached over ssh: a machine that
// already exists, the person's own, dialled with their own key. It sits behind
// the same MachineBackend seam the Solari and local backends do, so the runtime
// never learns which kind it holds. Nothing here creates, forks, pauses or
// snapshots: every capability behind those is false, so each road refuses by
// capability before it reaches this file. exec and run carry one script over
// the ssh client, which is the only thing here that knows the machine is not
// in this process.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { LOOPBACK, isPlainPath, shellQuote } from "@wsp/protocol";
import type { Capabilities, MachineFacts } from "@wsp/protocol";
import { lineFeed, runChild } from "./child-exec.js";
import { keyFingerprint } from "./key-fingerprint.js";
import { ARCH_READ, HOME_READ, MEM_READ, OS_READ, SHELL_READ, SYSTEM_READ, UPTIME_READ, archOf, memMbOf, osNameOf, readLists, readValues, systemOf, uptimeMsOf } from "./machine-facts.js";
import type { BackendPricing, ExecResult, Machine, MachineBackend, MachineShape, MachineState, RunOptions, SnapshotStoragePricing } from "./machine.js";

/** How the ssh client is dialled: who to log in as, where, on which port, and the person's own key when they named
 * one (absent leaves ssh its own config and agent, which is how most people already reach their machines). */
export interface SshReach {
  user: string;
  host: string;
  port: number;
  keyPath?: string;
}

/** The machine's login environment, read on the one call that recorded the workspace: where its home is, who a turn
 * runs as, and the PATH a login shell there gets, which is the only way a tool the person installed under their own
 * home is found by a turn (a non-interactive ssh command gets a bare one). Read once and recorded, the way a
 * golden's PATH is, rather than probed on every launch. */
export type SshLogin = Readonly<Record<string, string>> & { HOME: string; USER: string; PATH: string };

/** The port ssh uses when the person named none. */
export const SSH_DEFAULT_PORT = 22;

const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

/** The one written form of an ssh machine: its id on the record, which is also the dial. Everything a later host
 * process needs to reach it again is in here, so a record rehydrates with no second store to read and nothing but
 * this module ever looks inside it. */
export function sshMachineId(reach: SshReach): string {
  const url = new URL(`ssh://${encodeURIComponent(reach.user)}@${reach.host}:${reach.port}`);
  if (reach.keyPath !== undefined) url.searchParams.set("key", reach.keyPath);
  return url.toString();
}

/** The target an id names, or nothing when the id is not one of ours: a record from another backend, or a string
 * that was never an ssh address. */
export function parseSshMachineId(id: string): SshReach | undefined {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ssh:") return undefined;
  const user = decodeURIComponent(url.username);
  const key = url.searchParams.get("key");
  if (user === "" || url.hostname === "") return undefined;
  return { user, host: url.hostname, port: Number(url.port) || SSH_DEFAULT_PORT, ...(key !== null ? { keyPath: key } : {}) };
}

/** The dial a person's `user@host` word names, with the port they gave or ssh's own, and their key when they named
 * one. A word with no user is refused rather than guessed at: who a turn runs as on their machine is theirs to say. */
export function parseSshAddress(address: string, opts: { port?: number; keyPath?: string } = {}): SshReach {
  const at = address.lastIndexOf("@");
  const user = at === -1 ? "" : address.slice(0, at);
  const rest = address.slice(at + 1);
  const colon = rest.lastIndexOf(":");
  const host = colon === -1 ? rest : rest.slice(0, colon);
  const named = colon === -1 ? undefined : Number(rest.slice(colon + 1));
  if (user === "" || host === "") throw new Error(`${address} is not an ssh address; name the machine as user@host`);
  const port = opts.port ?? named ?? SSH_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${address} names no port ssh can dial`);
  return { user, host, port, ...(opts.keyPath !== undefined ? { keyPath: opts.keyPath } : {}) };
}

/** One written form of an ssh dial for a person to read on a row and type back into a terminal: the login, and the
 * port only where it is not ssh's own. parseSshAddress reads it back, so the word a row shows is the word a later
 * dial of that machine is built from. */
export function sshLoginWord(reach: SshReach): string {
  return reach.port === SSH_DEFAULT_PORT ? `${reach.user}@${reach.host}` : `${reach.user}@${reach.host}:${reach.port}`;
}

/** What a machine reached over ssh is called when the person named no name: the host's own first label, and the
 * whole address where cutting at a dot would leave a number (an IPv4 address) or there is nothing to cut. */
export function sshMachineName(reach: SshReach): string {
  const dot = reach.host.indexOf(".");
  return dot === -1 || /^[\d.]+$/.test(reach.host) ? reach.host : reach.host.slice(0, dot);
}

/** How a script reaches the machine. The client below is the only implementation that leaves this computer; a test
 * hands its own and reads what the machine was asked to run. */
export type SshTransport = (reach: SshReach, script: string, opts: { timeoutMs?: number; onLine?: (line: string) => void; stdin?: Uint8Array }) => Promise<ExecResult>;

/** How long the ssh client waits for the machine to answer the dial itself, before the script's own deadline starts
 * mattering: a machine that is off must fail rather than hang a turn. */
export const SSH_CONNECT_TIMEOUT_S = 10;

/** The most of ssh's words any message here keeps: they land in a slot two lines high. */
export const SSH_LINE_CAP = 300;

/** Words a box wrote, going into a sentence or a log of ours: nothing left that would move a terminal, and short
 * enough to leave the sentence's fix room. */
export const boxWord = (said: string, cap = 48): string => said.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, cap);

/** How long an idle master connection is kept after the last command through it. A turn polls its log every second
 * and a half, so without one every poll is a key exchange and a line in the machine's auth log (measured: seven
 * logins for one 2.4 second turn); with one, a turn is one login and the master goes when the work stops. */
export const SSH_CONTROL_PERSIST_S = 60;

/** The folder the master connections listen in: wsp's own under the person's home, never a folder every login on
 * this computer shares. Whoever holds a control socket holds every command that rides it, and a shared temp folder
 * is world writable on Linux with a name anyone can work out, so another account could sit on the path first. */
export function sshControlDir(home: string = homedir()): string {
  return join(home, ".wsp", "ssh");
}

/** The mode that folder is made and kept at: the person's own and nobody else's. */
export const SSH_CONTROL_DIR_MODE = 0o700;

/** Makes it before a dial can need it, and tightens one that was left looser, since a folder already there at other
 * modes would hand the sockets to whoever made it. */
export function makeSshControlDir(home?: string): string {
  const dir = sshControlDir(home);
  mkdirSync(dir, { recursive: true, mode: SSH_CONTROL_DIR_MODE });
  chmodSync(dir, SSH_CONTROL_DIR_MODE);
  return dir;
}

/** The socket the master connection for one machine listens on. Named by a hash of the dial rather than by the
 * address, since a unix socket path is capped near 104 characters and a host name is not; one per user, host and
 * port, so two records of one machine share the master and two machines never do. */
export function sshControlPath(reach: SshReach, dir: string = sshControlDir()): string {
  return join(dir, `wsp-ssh-${createHash("sha256").update(`${reach.user}@${reach.host}:${reach.port}`).digest("hex").slice(0, 16)}.sock`);
}

/** The ssh client's argv for one script. The script runs under `bash -c` as it does on a guest, never a login
 * shell, which would reset PATH. Every command rides one master connection per machine, so a turn's polls are one
 * login rather than one each. */
export function sshArgs(reach: SshReach, script: string, opts: { controlDir?: string; stdin?: boolean } = {}): string[] {
  return [
    // -n hands the script /dev/null for stdin; the one road that carries a file's bytes writes them there instead.
    ...(opts.stdin === true ? [] : ["-n"]),
    "-T",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${sshControlPath(reach, opts.controlDir)}`,
    "-o",
    `ControlPersist=${SSH_CONTROL_PERSIST_S}`,
    ...sshDialArgs(reach),
    `${reach.user}@${reach.host}`,
    "bash",
    "-c",
    shellQuote(script),
  ];
}

/** How every ssh child this host starts is dialled, whatever it then does on the connection. BatchMode keeps a
 * machine that wants a passphrase from stopping a background host at a prompt nobody can see. Nobody can answer a
 * host key prompt there either, and a key that changed is still refused; accept-new writes the key the machine was
 * first seen with, which is where the identity of a machine over ssh is read from afterwards. The command road and
 * the forward road both build on this, so how wsp dials a machine is one rule and not two. */
export function sshDialArgs(reach: SshReach): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    "-p",
    String(reach.port),
    ...(reach.keyPath !== undefined ? ["-i", reach.keyPath, "-o", "IdentitiesOnly=yes"] : []),
  ];
}

/** The keys of the person's config a forward child carries, by the name `ssh -G` prints and the option that sets it:
 * who it logs in as and with what, how it gets there, and where and under what name the machine's key is checked. */
const CARRIED_SSH_OPTIONS: readonly (readonly [string, string, "one" | "rest"])[] = [
  ["identityfile", "IdentityFile", "one"],
  ["identitiesonly", "IdentitiesOnly", "one"],
  ["certificatefile", "CertificateFile", "one"],
  ["proxycommand", "ProxyCommand", "rest"],
  ["userknownhostsfile", "UserKnownHostsFile", "rest"],
  ["globalknownhostsfile", "GlobalKnownHostsFile", "rest"],
  ["hostkeyalias", "HostKeyAlias", "one"],
  ["checkhostip", "CheckHostIP", "one"],
  ["hostkeyalgorithms", "HostKeyAlgorithms", "one"],
  ["pubkeyacceptedalgorithms", "PubkeyAcceptedAlgorithms", "one"],
  ["identityagent", "IdentityAgent", "one"],
  ["addkeystoagent", "AddKeysToAgent", "one"],
  ["usekeychain", "UseKeychain", "one"],
];

/** A value ssh re-reads as one word: a space, a quote or a backslash in it would split it or be eaten, so it goes in
 * double quotes with ssh's own escapes. A `rest` value (a command, a list of files) is taken as ssh printed it. */
function carriedValue(value: string, shape: "one" | "rest"): string {
  return shape === "rest" || !/[\s"'\\]/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/** The refusal for a known hosts file the config names that is not on this computer. `ssh -G` prints the list
 * joined by spaces, so a path with a space in it arrives as two words, and a child under accept-new that read
 * neither would take a changed key for that machine as a new one. */
export const missingKnownHostsLine = (target: string, file: string): string =>
  `${target.slice(0, 48)}: your ssh config names ${file.slice(0, 72)} as a known hosts file and this computer has no file there, so wsp will not dial back over ssh with it; create it, or rename a path that has a space in it`;

/** That refusal as a sentence of its own, which a caller says whole rather than inside one of its own. */
export class MissingKnownHostsError extends Error {}

/** A dial with the person's config already read into it: the machine it lands on and the options that got it there,
 * so a child started under `-F /dev/null` reaches the same machine the same way with none of the config's forwards. */
export interface SshCarried {
  reach: SshReach;
  options: readonly string[];
}

/** A ProxyJump as the ProxyCommand ssh builds for it, less the `-F` it would pass on: under `-F /dev/null` a jump named
 * by an alias would lose its own block, so the jump keeps the person's config and only the last hop is ours. */
function jumpCommand(spec: string): string {
  const hops = spec.split(",");
  const last = hops.pop()!;
  return ["ssh", "-o", "BatchMode=yes", ...(hops.length > 0 ? ["-J", shellQuote(hops.join(","))] : []), "-W", "'[%h]:%p'", shellQuote(`ssh://${last}`)].join(" ");
}

/** The person's config for one dial, read twice by `ssh -G`: with it and without it. A value the config leaves at the
 * client's own default is not carried, since the child gets that default anyway, and a default spelled out changes
 * it: an explicit HostKeyAlgorithms stops the client preferring the key type known_hosts already holds. `%` tokens
 * and `~` pass verbatim for the child to expand at connect. Throws ssh's own line on a config it cannot read. */
export async function carriedSshValues(reach: SshReach, run: SshLocalRun = localRun): Promise<SshCarried> {
  const target = `${reach.user}@${reach.host}`;
  const read = async (bare: boolean): Promise<Map<string, string[]>> => {
    const said = await run("ssh", ["-G", ...(bare ? ["-F", "/dev/null"] : []), ...sshDialArgs(reach), target], SSH_LOCAL_READ_MS);
    if (said.exitCode !== 0) throw new Error(sshRefusalLine(said, reach));
    return readLists(said.stdout);
  };
  const config = await read(false);
  const defaults = await read(true);
  const first = (key: string): string => config.get(key)?.[0] ?? "";
  const options: string[] = [];
  for (const [key, option, shape] of CARRIED_SSH_OPTIONS) {
    const values = config.get(key) ?? [];
    if (values.join("\n") === (defaults.get(key) ?? []).join("\n")) continue;
    if (key.endsWith("knownhostsfile")) {
      const missing = values.flatMap(value => value.split(" ")).find(file => file !== "" && file !== "none" && !(isAbsolute(file) && existsSync(file)));
      if (missing !== undefined) throw new MissingKnownHostsError(missingKnownHostsLine(target, missing));
    }
    // ssh -G prints IdentityAgent with its tokens already expanded, and the child expands it again.
    const said = key === "identityagent" ? values.map(value => value.replace(/%/g, "%%")) : values;
    options.push(...said.filter(value => value !== "").map(value => `${option}=${carriedValue(value, shape)}`));
  }
  const jump = first("proxyjump");
  if (first("proxycommand") === "" && jump !== "" && jump !== "none") options.push(`ProxyCommand=${jumpCommand(jump)}`);
  const port = Number(first("port")) || reach.port;
  return { reach: { ...reach, user: first("user") || reach.user, host: first("hostname") || reach.host, port }, options };
}

/** What the forward child runs on the box. Forwards stand before a session's command runs, so the line is the forward
 * being up; cat holds the session on the host's stdin pipe, so the forward ends when the host does, by any road. */
export const SSH_BACK_UP = "WSP_BACK_UP";
const BACK_COMMAND = `echo ${SSH_BACK_UP}; exec cat`;

/** The forward child's argv: the carried dial under no config, then one remote forward from the box's loopback to
 * this computer's door. No ClearAllForwardings: it clears the command line's -R as well (measured, OpenSSH 10.2p1),
 * and under `-F /dev/null` there is no other forward to clear. */
export function sshBackArgs(carried: SshCarried, boxPort: number, doorPort: number): string[] {
  return [
    "-F",
    "/dev/null",
    ...sshDialArgs(carried.reach),
    ...carried.options.flatMap(option => ["-o", option]),
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ControlPath=none",
    "-R",
    `${LOOPBACK}:${boxPort}:${LOOPBACK}:${doorPort}`,
    `${carried.reach.user}@${carried.reach.host}`,
    BACK_COMMAND,
  ];
}

/** The part of a started child the holder reads; a test hands its own. */
export interface HeldChild {
  stdin: { end(): unknown; on(event: "error", fn: (error: Error) => void): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", fn: (error: Error) => void): unknown;
}

export type SshSpawn = (file: string, args: readonly string[]) => HeldChild;

const spawnSsh: SshSpawn = (file, args) => spawn(file, [...args], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

/** One held forward: up answers once the forward stands and rejects with ssh's line when the child ends first; ended
 * answers that line whenever the child ends; release ends it. */
export interface BackForward {
  up: Promise<void>;
  ended: Promise<string>;
  release(): void;
}

/** The most of a partial line the holder keeps waiting for its newline: room for any line ssh prints. */
const HELD_TAIL = 4096;

/** Each line a stream writes, cut to SSH_LINE_CAP. Once the session stands the box writes on both pipes, and it is
 * not trusted with this computer's memory: a line it never ends is held only by its tail. */
function eachLine(stream: NodeJS.ReadableStream, fn: (line: string) => void): void {
  const lines = lineFeed(line => fn(line.replace(/\r$/, "").slice(0, SSH_LINE_CAP)), HELD_TAIL);
  stream.on("data", (chunk: Buffer | string) => lines.feed(chunk.toString()));
}

/** Starts the forward child and holds it. The host keeps its stdin pipe open and writes nothing to it. */
export function holdBackForward(carried: SshCarried, boxPort: number, doorPort: number, spawnChild: SshSpawn = spawnSsh): BackForward {
  const child = spawnChild("ssh", sshBackArgs(carried, boxPort, doorPort));
  const said: string[] = [];
  let settleUp!: { resolve: () => void; reject: (error: Error) => void };
  const up = new Promise<void>((resolve, reject) => (settleUp = { resolve, reject }));
  // A caller that only waits on ended must not see an unhandled rejection from up.
  up.catch(() => {});
  eachLine(child.stdout, line => {
    if (line.trim() === SSH_BACK_UP) settleUp.resolve();
  });
  eachLine(child.stderr, line => {
    said.push(line);
    if (said.length > 50) said.shift();
  });
  child.stdin.on("error", () => {});
  let released = false;
  const ended = new Promise<string>(resolve => {
    const end = (fallback: string): void => {
      const line = clientWords(said.join("\n")).split("\n").at(-1) ?? "";
      const words = boxWord(line === "" ? fallback : line, SSH_LINE_CAP);
      settleUp.reject(new Error(words));
      resolve(words);
    };
    child.once("exit", (code, signal) => end(code === null && signal !== null ? `ssh ended on ${signal}` : `ssh exited with ${code}`));
    child.once("error", error => end(error.message));
  });
  return {
    up,
    ended,
    release: () => {
      if (released) return;
      released = true;
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/** The ssh client on this computer, carrying one script to the machine. The folder its master socket lives in is
 * made here, on the way out, so no dial can be the first thing to need it. */
export const sshClient: SshTransport = (reach, script, opts) =>
  runChild("ssh", sshArgs(reach, script, { controlDir: makeSshControlDir(), ...(opts.stdin !== undefined ? { stdin: true } : {}) }), {
    env: process.env,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });

/** How the key a machine holds is read: the one road to an identity, so every caller asks the same question the
 * same way. It is not the dial's to answer, since a dial that rides a warm master exchanges no key and the client
 * logs none; absent leaves the record without an identity of the machine's own rather than inventing one. */
export type SshHostKeyReader = (reach: SshReach) => Promise<string | undefined>;

/** One command on this computer, for the reads that ask the ssh client about a machine rather than asking the
 * machine. A test hands its own and reads what was asked. */
export type SshLocalRun = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

const localRun: SshLocalRun = (file, args, timeoutMs) => runChild(file, args, { env: process.env, timeoutMs });

/** How long each of the reads that only ask the client is given. Neither opens a connection, so this only bounds a
 * client sitting on a config it cannot read. */
const SSH_LOCAL_READ_MS = 5_000;

/** The one read that does leave this computer: how long it waits on the machine's ssh port, told to the tool in its
 * own seconds, and the bound the child itself is held to past that. It is asked as a record is made and never on a
 * status tick, so what it costs is paid once by a person who is watching. */
const SSH_KEYSCAN_S = 5;
const SSH_KEYSCAN_MS = 10_000;

/** The name the client writes this machine's key under and looks it up by, out of its own answers for the dial: the
 * alias where the person set one, else the host the address resolves to, with the port in brackets where it is not
 * ssh's own, which is how OpenSSH spells an entry that carries a port. */
export function knownHostTarget(values: Record<string, string>): string | undefined {
  const alias = values["hostkeyalias"];
  if (alias !== undefined && alias !== "") return alias;
  const host = values["hostname"];
  if (host === undefined || host === "") return undefined;
  const port = Number(values["port"]);
  return Number.isInteger(port) && port !== SSH_DEFAULT_PORT ? `[${host}]:${port}` : host;
}

/** The files the client checks a host key against, in its own order, with a leading ~ made the person's home the
 * way the client makes it: the password database entry, which is what ssh expands a tilde from, and not `$HOME`.
 * Measured on OpenSSH 9.6 and 10.2, which both answer `-G` with the tilde already expanded that way, so this
 * branch fires only for an older client, where following `$HOME` instead would read another file and drop the
 * identity in silence. `none` is a person turning a file off rather than a path to read. */
export function knownHostFiles(values: Record<string, string>, home?: string): string[] {
  return [values["userknownhostsfile"], values["globalknownhostsfile"]]
    .flatMap(named => (named ?? "").split(/\s+/))
    .filter(file => file !== "" && file !== "none")
    // The entry is read where a tilde is there to expand and nowhere else, since a computer whose login has no
    // entry in that database has no home to read either and every other path here is already absolute.
    .map(file => (file.startsWith("~/") ? join(home ?? userInfo().homedir, file.slice(2)) : file));
}

/** The key a dial to this machine is checked against, out of every entry the client holds for it. A machine is
 * usually known by one key per type, and the one a connection negotiates is the client's most preferred type it is
 * known by, so that is the one the identity stands on and the answer does not turn on which line was written first.
 * A signature name is no key type (an rsa-sha2 signature is made by an ssh-rsa key). Only a line whose second word
 * is a type this client prefers is read, which is what leaves out the comment lines ssh-keygen prints and the
 * marker lines for an authority or a revoked key: neither has a key type where an entry has one. The authority's
 * key is not the machine's, and standing a record on it would make every machine that authority signed the same
 * machine, so a client that holds only such a line for a machine is asked nothing more here and the machine's own
 * key is read off the machine instead. */
export function hostKeyFound(found: string, algorithms: string): string | undefined {
  const preferred = algorithms.split(",").map(name => name.replace(/^rsa-sha2-\d+$/, "ssh-rsa"));
  let best: { rank: number; key: string } | undefined;
  for (const line of found.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const rank = fields.length < 3 ? -1 : preferred.indexOf(fields[1]!);
    if (rank === -1) continue;
    if (best === undefined || rank < best.rank) best = { rank, key: `${fields[1]!} ${keyFingerprint(fields[2]!)}` };
  }
  return best?.key;
}

/** The word a known_hosts line starts with where its key signs for machines rather than being one machine's own. */
const CERT_AUTHORITY = "@cert-authority";

/** Whether the client knows this machine only through an authority: it holds lines for the machine and every one
 * of them names a signing key, so the machine's own key is nowhere in the client's own files. The machine still
 * has one, and the certificate it answers a dial with is that key signed, which is why the road below asks the
 * machine for it rather than leaving the record with no identity. */
function trustedByAuthority(found: string): boolean {
  const lines = found.split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#"));
  return lines.length > 0 && lines.every(line => line.startsWith(`${CERT_AUTHORITY} `));
}

/** The keys the machine itself offers, in the same `name type key` lines a known_hosts entry carries: one dial of
 * its ssh port with no login and nothing installed. Only the road above calls it, and only for a machine the
 * client trusts through an authority. What comes back stands on no trust of its own: it is read as an identity,
 * which is what tells two records of one machine apart, and never as a key a dial is checked against, which stays
 * the client's own job through the authority it already holds.
 *
 * Nothing is asked where the client would reach the machine through a jump or a command of the person's, since
 * this road dials the resolved name itself and cannot take either: the name would resolve on this network rather
 * than on the far side of the jump, and whatever answered there would be recorded as that machine's identity. */
async function offeredHostKeys(values: Record<string, string>, run: SshLocalRun): Promise<string> {
  const host = values["hostname"] ?? "";
  if (host === "" || (values["proxyjump"] ?? "") !== "" || (values["proxycommand"] ?? "") !== "") return "";
  const port = Number(values["port"]) || SSH_DEFAULT_PORT;
  const read = await run("ssh-keyscan", ["-T", String(SSH_KEYSCAN_S), "-p", String(port), host], SSH_KEYSCAN_MS);
  return read.exitCode === 0 ? read.stdout : "";
}

/** What a machine itself answers with on its ssh port, with nothing authenticated and nothing installed: one scan
 * of the address the client would dial, read as a known_hosts entry is read, and what in the person's own ssh
 * config stopped the scan where one did. This is what a person is shown before the first dial of a computer this
 * one has never met, to check against the computer in front of them; it stands on no trust of its own and is never
 * what a dial is checked against, which stays the client's job.
 *
 * A jump or a command of the person's stops it: the scan dials the resolved name itself and can take neither, so
 * whatever answered on this network would be shown as that machine's key. */
export async function offeredHostKey(reach: SshReach, run: SshLocalRun = localRun): Promise<{ key?: string; stoppedBy?: string }> {
  const config = await run("ssh", ["-G", ...sshDialArgs(reach), `${reach.user}@${reach.host}`], SSH_LOCAL_READ_MS);
  if (config.exitCode !== 0) return {};
  const values = readValues(config.stdout);
  const stoppedBy = proxiedBy(values);
  if (stoppedBy !== undefined) return { stoppedBy };
  const key = hostKeyFound(await offeredHostKeys(values, run), values["hostkeyalgorithms"] ?? "");
  return key === undefined ? {} : { key };
}

/** The option that carries a dial through another computer, off one `ssh -G` reading: ssh prints neither when unset. */
function proxiedBy(values: Record<string, string>): "ProxyJump" | "ProxyCommand" | undefined {
  return (values["proxyjump"] ?? "") !== "" ? "ProxyJump" : (values["proxycommand"] ?? "") !== "" ? "ProxyCommand" : undefined;
}

/** What a word that is neither a login nor an alias is refused with, wherever it was typed. */
export const SSH_WORD_REFUSAL = (word: string): string => `${word} is neither a login like root@host nor an alias your ssh config gives a HostName`;

/** The dial one typed word names: a login is read as parseSshAddress reads it, and a bare word is an alias when the
 * person's ssh config renames it. The alias stays the host, so every later dial still goes through its block; the
 * user comes off that block and the port too unless one was typed, since sshDialArgs always passes -p and a 22 there
 * would override the block's Port. ssh prints the hostname lowercased when nothing renamed it, so a word that comes
 * back only lowercased is none; ssh matches a Host line with its case, so that word never met a block. */
export async function sshWordReach(word: string, opts: { port?: number; keyPath?: string } = {}, run: SshLocalRun = localRun): Promise<SshReach> {
  if (word.includes("@")) return parseSshAddress(word, opts);
  // The word is handed to the client as an argument, so one that reads as an option never gets there.
  if (!/^\w[\w.-]*$/.test(word)) throw new Error(SSH_WORD_REFUSAL(word));
  // The resolver rewrites a numeric word into an address (123 prints 0.0.0.123), which would read as a rename.
  if (/^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+)){0,3}$/i.test(word)) throw new Error(SSH_WORD_REFUSAL(word));
  const config = await run("ssh", ["-G", word], SSH_LOCAL_READ_MS);
  const values = config.exitCode === 0 ? readValues(config.stdout) : {};
  const host = values["hostname"] ?? "";
  const user = values["user"] ?? "";
  if (host === "" || user === "" || host.toLowerCase() === word.toLowerCase()) throw new Error(SSH_WORD_REFUSAL(word));
  return parseSshAddress(`${user}@${word}`, { port: opts.port ?? (Number(values["port"]) || SSH_DEFAULT_PORT), ...(opts.keyPath !== undefined ? { keyPath: opts.keyPath } : {}) });
}

/** The address ssh dials for a login, read off the person's config with nothing dialled: an alias's HostName, and
 * the host as it was given where no block renames it or the client cannot say. Nothing where a jump or a command
 * carries the dial, since the HostName is then resolved on the far side and names no address this computer dials. */
export async function sshHostName(reach: SshReach, run: SshLocalRun = localRun): Promise<string | undefined> {
  const config = await run("ssh", ["-G", ...sshDialArgs(reach), `${reach.user}@${reach.host}`], SSH_LOCAL_READ_MS);
  const values = config.exitCode === 0 ? readValues(config.stdout) : {};
  if (proxiedBy(values) !== undefined) return undefined;
  const host = values["hostname"] ?? "";
  return host === "" ? reach.host : host;
}

/** The key this machine is known by, as one string whoever asks. `ssh -G` answers where the client looks and what
 * it prefers there with the person's own config applied, and `ssh-keygen -F` reads the entry out, hashed or not.
 * That much is read on this computer with nothing dialled, which is the road that survives a warm master: the
 * accept-new policy wrote the entry as the first dial was made, so the answer is there whether this dial exchanged
 * a key or rode an open connection. A machine the client trusts through an authority has no entry of its own to
 * read, and only then is the machine itself asked which key its certificate signs. */
export async function knownHostKey(reach: SshReach, run: SshLocalRun = localRun): Promise<string | undefined> {
  const config = await run("ssh", ["-G", ...sshDialArgs(reach), `${reach.user}@${reach.host}`], SSH_LOCAL_READ_MS);
  if (config.exitCode !== 0) return undefined;
  const values = readValues(config.stdout);
  const target = knownHostTarget(values);
  if (target === undefined) return undefined;
  let found = "";
  for (const file of knownHostFiles(values)) {
    const read = await run("ssh-keygen", ["-F", target, "-f", file], SSH_LOCAL_READ_MS);
    if (read.exitCode === 0) found += read.stdout;
  }
  const algorithms = values["hostkeyalgorithms"] ?? "";
  const held = hostKeyFound(found, algorithms);
  if (held !== undefined || !trustedByAuthority(found)) return held;
  return hostKeyFound(await offeredHostKeys(values, run), algorithms);
}

/** The entry accept-new writes on this computer, both halves off the one `ssh -G` the key is read through: the
 * file, the first the client names, which is the person's own where a config points `UserKnownHostsFile` somewhere
 * other than the default, and the name that entry is written under, which is the client's own reading of the dial
 * and not the word that was typed. Both are wanted by the same screens, and a second reading of either rule would
 * name a file or a line a person cannot act on: under a `Host box` / `HostName 10.0.0.5` config the entry is
 * written under the address, so a line built from the typed word would remove nothing. Empty where the client
 * answers nothing, which leaves a screen to name the default rather than a path this computer did not confirm. */
export async function knownHostsWritten(reach: SshReach, run: SshLocalRun = localRun): Promise<{ file?: string; target?: string }> {
  const config = await run("ssh", ["-G", ...sshDialArgs(reach), `${reach.user}@${reach.host}`], SSH_LOCAL_READ_MS);
  if (config.exitCode !== 0) return {};
  const values = readValues(config.stdout);
  const file = knownHostFiles(values)[0];
  const target = knownHostTarget(values);
  return { ...(file !== undefined ? { file } : {}), ...(target !== undefined ? { target } : {}) };
}

/** What a machine over ssh is, as the machine itself answers: the key it holds and the login a turn runs as. Two
 * records of the same machine under different keys, ports, aliases or addresses answer with this same string, which
 * is what keeps one workspace on one machine. */
export function sshIdentity(hostKey: string, user: string): string {
  return `${hostKey} as ${user}`;
}

/** ssh's own note for the key accept-new wrote on its way in. The road that offers the login names that file before
 * anything is dialled, so the note is not news about the refusal it rides in on and it crowds out the sentence a
 * person can act on in a slot two lines high. */
const WROTE_KNOWN_HOSTS = /^Warning: Permanently added .* to the list of known hosts\.?$/;

/** What ssh says when a LocalForward in the person's own config cannot bind here, which every run through that
 * block prints before the command's own output and which is about this computer's ports, not the box. */
const LOCAL_FORWARD_NOISE = /^(bind \[.*\]:\d+: .*|channel_setup_fwd_listener_tcpip: cannot listen to port: \d+|Could not request local forwarding\.)$/;

/** The client's own words with its debug log, its note about known_hosts and its local forward warnings taken
 * out: what a person can act on when a dial or a command over it fails. */
export function clientWords(text: string): string {
  return text
    .split("\n")
    .filter(line => !/^debug\d+:/.test(line) && !WROTE_KNOWN_HOSTS.test(line) && !LOCAL_FORWARD_NOISE.test(line))
    .join("\n")
    .trim();
}

/** What ssh itself said when a login would not stand: the client's own lines with its debug chatter dropped and
 * nothing of wsp's over them. A person reading why a computer refused them needs ssh's sentence, the one they
 * would have seen in their own terminal; a wrapper naming the reader that asked is the reader talking about
 * itself. */
export function sshRefusalLine(said: { stderr: string; exitCode: number }, reach: SshReach): string {
  const lines = clientWords(said.stderr);
  return lines === "" ? `${reach.user}@${reach.host} refused the login over ssh (exit ${said.exitCode})` : lines.slice(-SSH_LINE_CAP);
}

/** One dial of a machine over ssh and nothing else: a command every unix runs, so what comes back is the
 * connection's own verdict and not a reading of the machine. Answers when the login stands; throws ssh's own line
 * when it does not. Nothing is installed and nothing is left running. */
export async function sshDial(reach: SshReach, transport: SshTransport = sshClient): Promise<void> {
  const said = await transport(reach, "exit 0", { timeoutMs: SSH_DIAL_MS });
  if (said.exitCode === 0) return;
  throw new Error(sshRefusalLine(said, reach));
}

/** How long one dial waits: the client's own connect timeout and a moment for the login, since a person is
 * watching the button they pressed. */
export const SSH_DIAL_MS = 15_000;

/** The store variable each harness reads, by name, as the catalog gives them. The shape rule is what keeps a
 * catalog entry out of the read as shell: the name is interpolated into a printf inside the login shell, so a name
 * that is not a plain variable name is left out rather than carried there. */
export const SSH_STORE_VARS: readonly string[] = CATALOG_AGENTS.map(a => a.stateHomeEnv).filter((name): name is string => name !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(name));

/** What the read asks the machine's own shell for: the PATH a turn runs under, and the store variable each harness
 * reads, so a machine whose person points their harness at another folder is signed in for a turn the way it is for
 * them. It is exported because a computer somebody joined reads its own login by this same rule, in a shell of its
 * own: a turn there runs the tools their own shell finds, and the shell that happened to type wsp join is not that
 * shell. */
export const LOGIN_READ = ["printf \"path %s\\n\" \"$PATH\"", ...SSH_STORE_VARS.map(name => `printf "store:${name} %s\\n" "$${name}"`)].join("; ");

/** What one dial reads off a machine before its record exists: its environment and the size the row shows. Linux
 * answers the first branch of each size pair, macOS the second.
 *
 * The shell the read runs in opens no file of the machine's own. Every adopt on this road is a computer the host
 * then works as that computer's root, whose home is the one every workspace there writes, so a profile or an rc
 * file under it is a file a workspace wrote and a login shell would run it outside every namespace. What that
 * costs is the PATH: it is the machine's non-login one, which is what the deploy exports and the unit is told,
 * and the daemon replaces its own at start anyway. */
export const SSH_READ_SCRIPT = [
  HOME_READ,
  SYSTEM_READ,
  ARCH_READ,
  'printf "user %s\\n" "$(id -un)"',
  // sshd hands every command wsp sends to this login's own shell with -c before the bash -c above it, so which
  // shell that is decides whether a file under the login's home runs first. Read the same way the context probe
  // reads it, off a passwd entry and never by running that shell.
  SHELL_READ,
  'printf "shell %s\\n" "$shell"',
  `env -u BASH_ENV bash --noprofile --norc -c ${shellQuote(LOGIN_READ)} 2>/dev/null`,
  'printf "cpu %s\\n" "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"',
  MEM_READ,
].join("\n");

/** What the machine answers about itself every time a status is built: the system it runs, how long it has been up
 * and the folder a command starts in, which on a machine somebody owns is the home their login lands in. One script
 * for the three, since the round trip is the cost and the uptime is why it is asked again. */
export const SSH_FACTS_SCRIPT = [...OS_READ, ...UPTIME_READ, HOME_READ].join("\n");

/** One dial that both proves the machine answers and records what wsp needs of it. A dial that fails carries the
 * client's own words back, since they are what tells the person whether it was the key, the host or the network. */
export async function readSshMachine(reach: SshReach, transport: SshTransport = sshClient): Promise<{ login: SshLogin; shape: MachineShape; system?: string; arch?: string; shell?: string }> {
  const res = await transport(reach, SSH_READ_SCRIPT, { timeoutMs: 30_000 });
  if (res.exitCode !== 0) throw new Error(`${reach.user}@${reach.host} did not answer over ssh: ${(clientWords(res.stderr) || res.stdout.trim()).slice(-SSH_LINE_CAP)}`);
  const values = readValues(res.stdout);
  const home = values["home"];
  if (home === undefined || !isPlainPath(home)) throw new Error(homeRefusal(reach, home));
  const stores: Record<string, string> = {};
  for (const name of SSH_STORE_VARS) {
    const folder = values[`store:${name}`];
    // A store the person points elsewhere is a path a turn's command carries, so it is held to the same rule the
    // home is: a plain absolute path, or the harness's default under the home stands instead.
    if (folder !== undefined && folder !== "" && isPlainPath(folder)) stores[name] = folder;
  }
  const cpu = Number(values["cpu"] ?? 0);
  const memMb = memMbOf(values) ?? 0;
  const system = systemOf(values);
  const arch = archOf(values);
  // A name and nothing else: which shells a road may work through is that road's rule, not this reading's.
  const shell = values["shell"];
  return {
    login: { ...stores, HOME: home, USER: values["user"] ?? reach.user, PATH: plainPath(values["path"]) },
    shape: { cpu, memMb },
    ...(system !== undefined ? { system } : {}),
    ...(arch !== undefined ? { arch } : {}),
    ...(shell !== undefined && shell !== "" ? { shell } : {}),
  };
}

function homeRefusal(reach: SshReach, home: string | undefined): string {
  const said = home === undefined || home === "" ? "no home folder" : `${JSON.stringify(home)}, which is not a plain path`;
  return `${reach.user}@${reach.host} answered over ssh with ${said} for ${reach.user}`;
}

/** Loopback names and addresses, and the suffix a Mac gives its own name on the local network: what a dial that
 * names the computer wsp runs on looks like. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Whether this dial reaches the computer wsp is running on: the same machine as the local workspace, under another
 * name. A request relayed from a machine may drive a workspace over ssh, and this is the one such workspace it may
 * not, since it is this computer wearing another kind's clothes. `names` is what this computer answers to. */
export function sshDialsThisComputer(reach: SshReach, names: readonly string[]): boolean {
  const host = reach.host.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK_NAMES.has(host) || host.startsWith("127.")) return true;
  const own = names.map(n => n.toLowerCase().replace(/\.$/, "")).filter(n => n !== "");
  return own.some(name => host === name || host === `${name}.local` || `${host}.local` === name);
}

/** What a turn's PATH falls back to when the machine's own login shell printed none: what a POSIX login gives
 * anyway, so a harness the person installed elsewhere is missing rather than every command being. */
export const DEFAULT_REMOTE_PATH = "/usr/local/bin:/usr/bin:/bin";

/** The machine's own login PATH, each folder in it held to the rule the home is held to. It is the last thing the
 * machine answers with that ends up written rather than run: a turn exports it, and the daemon's unit states it,
 * where systemd splits an Environment= line on whitespace and reads a quote as quoting. A folder carrying a quote
 * or a space is dropped rather than escaped at each of those, and a PATH with nothing left in it falls back, so a
 * machine that answers with something unusable leaves a harness missing rather than every command. */
export function plainPath(path: string | undefined): string {
  const kept = (path ?? "").split(":").filter(folder => folder !== "" && isPlainPath(folder) && !/\s/.test(folder));
  return kept.length === 0 ? DEFAULT_REMOTE_PATH : kept.join(":");
}

/** What the write answers with once the bytes are on disk under their own name. */
export const SSH_BYTES_OK = "WSP_BYTES_OK";

/** The script that takes a file's bytes off the connection's stdin. The bytes land beside the target under a name
 * of their own and are moved into place only once the byte count matches, so a connection cut halfway leaves the
 * target as it was rather than a file that looks whole. `wc` pads its count on some systems, so the spaces go.
 * Nothing of the file's content is named in the command, which is the point of this road for a secret: a command
 * sits in /proc/<pid>/cmdline for its own length, and every account on the machine can read it there. */
export function putBytesScript(path: string, size: number, tmp: string): string {
  return [
    "set -e",
    // The file is the writer's alone until something widens it: a machine somebody owns may carry other accounts,
    // and what travels this road is a daemon token as often as it is an archive.
    "umask 077",
    `mkdir -p ${shellQuote(posix.dirname(path))}`,
    `cat > ${shellQuote(tmp)}`,
    `[ "$(wc -c < ${shellQuote(tmp)} | tr -d ' ')" = ${size} ] || { rm -f ${shellQuote(tmp)}; echo WSP_BYTES_SHORT; exit 1; }`,
    `mv -f ${shellQuote(tmp)} ${shellQuote(path)}`,
    `echo ${SSH_BYTES_OK}`,
  ].join("\n");
}

/** A machine reached over ssh: exec and run carry a script to it, and the moves only a machine wsp forks takes
 * throw, since the capability behind each is false and the runtime refuses them first. It carries no preview route,
 * no signed URL and no snapshot, and its own state is running: nothing here may call the person's own machine gone
 * on a dial that failed, since a machine that is off is one they turn on again. */
export class SshMachine implements Machine {
  readonly id: string;
  readonly kind = "sandbox" as const;
  readonly streamUrl = undefined;
  /** The last thing said about this machine failing to say what it is; held so a read that fails every tick is one
   * line in the log rather than four an hour, and a read that fails for a new reason is heard. */
  private quiet: string | undefined;

  constructor(
    readonly reach: SshReach,
    private readonly transport: SshTransport,
  ) {
    this.id = sshMachineId(reach);
  }

  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.transport(this.reach, cmd, { ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return this.transport(this.reach, script, { timeoutMs: opts.deadlineMs, ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}) });
  }

  async snapshot(): Promise<string> {
    throw new Error("a machine reached over ssh cannot be snapshotted");
  }

  async pause(): Promise<void> {
    throw new Error("a machine reached over ssh cannot be paused");
  }

  async resume(): Promise<void> {
    throw new Error("a machine reached over ssh cannot be resumed");
  }

  /** Deleting an ssh workspace drops its record: the machine is the person's own and wsp never made it. */
  async kill(): Promise<void> {}

  async state(): Promise<MachineState> {
    return "running";
  }

  async describe(): Promise<MachineShape> {
    return (await readSshMachine(this.reach, this.transport)).shape;
  }

  /** What this machine says it is, read over the connection on every status: nothing here is remembered, since a
   * machine somebody owns is rebooted and upgraded under wsp rather than by it. A machine that answers with none of
   * it leaves the rows waiting rather than showing this computer's own answers for it. */
  async facts(): Promise<MachineFacts> {
    const res = await this.transport(this.reach, SSH_FACTS_SCRIPT, { timeoutMs: 10_000 });
    const values = res.exitCode === 0 ? readValues(res.stdout) : {};
    const os = osNameOf(values);
    const uptimeMs = uptimeMsOf(values, Date.now());
    const folder = values["home"];
    if (os === undefined || uptimeMs === undefined || folder === undefined || folder === "") {
      // The caller shows pending and swallows this, so the reason lands in the host's own log instead: once for
      // this machine, and again only when what it says changes, since the read runs on every status tick.
      const why = `${this.reach.user}@${this.reach.host} did not say what it is over ssh (exit ${res.exitCode}): ${(clientWords(res.stderr) || res.stdout.trim()).slice(-SSH_LINE_CAP)}`;
      if (this.quiet !== why) console.warn(why);
      this.quiet = why;
      throw new Error(why);
    }
    this.quiet = undefined;
    return { os, uptimeMs, folder };
  }

  async downloadUrl(): Promise<string> {
    throw new Error("a machine reached over ssh serves no signed download URL; its files are read over the connection");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("a machine reached over ssh serves no signed upload URL; its files are written over the connection");
  }

  /** The machine's own road for bytes, which is the connection itself: the file rides stdin under a script that
   * writes it, since nothing here mints a URL anything could PUT to. */
  async putBytes(path: string, bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<void> {
    const tmp = `${path}.wsp-in-${randomBytes(6).toString("hex")}`;
    const res = await this.transport(this.reach, putBytesScript(path, bytes.length, tmp), { stdin: bytes, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (res.exitCode !== 0 || !res.stdout.includes(SSH_BYTES_OK)) {
      throw new Error(`${bytes.length} bytes did not land at ${path} over ssh (exit ${res.exitCode}): ${(clientWords(res.stderr) || res.stdout.trim()).slice(-SSH_LINE_CAP)}`);
    }
  }
}

export interface SshBackendOptions {
  /** How a script reaches a machine; the ssh client on this computer unless a test hands its own. */
  transport?: SshTransport;
  /** How the key a machine holds is read; the one road above unless a test hands its own. */
  hostKey?: SshHostKeyReader;
  /** The file that entry was written into on this computer and the name it was written under; the client's own
   * answer unless a test hands its own. */
  knownHosts?: (reach: SshReach) => Promise<{ file?: string; target?: string }>;
  /** What the machine itself answers a scan with; the read above unless a test hands its own. */
  offeredKey?: (reach: SshReach) => Promise<{ key?: string; stoppedBy?: string }>;
  /** The address the client dials for a login; the person's config unless a test hands its own. */
  hostName?: (reach: SshReach) => Promise<string | undefined>;
}

/** The backend for every ssh machine a host has a record of. It holds no fleet of its own: a machine that already
 * exists is known by the record that names it, so get answers from the id and list answers with nothing. */
export class SshBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false,
    replacesMachine: false, // the machine is the person's own: wsp made it no image and throws it away for nothing
    previewUrls: false,
    signedUrls: false,
    callbackRelay: false,
    diskSnapshots: false,
    images: false, // the machine is the person's own and wsp keeps no copy of its disk
    snapshotsAnyLife: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    // The machine is the person's own: nothing on it was made by wsp and nothing on it is thrown away, so a turn's
    // access starts at what its harness asks for rather than at skip-everything.
    kept: true,
    // wsp reaches this machine and nothing more: a project on it is worked where it sits, and no copy of it is made.
    copies: false,
    ownNetwork: false,
  };

  /** Nothing wsp runs is billed here, and no size is a default on a machine that already exists: every record
   * carries what its own machine answered with. */
  readonly pricing: BackendPricing = {
    rateUsdPerHour: () => 0,
    defaultSize: { cpu: 0, memMb: 0 },
    snapshotStorage: NO_SNAPSHOT_STORAGE,
  };

  private readonly transport: SshTransport;
  private readonly hostKey: SshHostKeyReader;
  private readonly knownHosts: (reach: SshReach) => Promise<{ file?: string; target?: string }>;
  private readonly offered: (reach: SshReach) => Promise<{ key?: string; stoppedBy?: string }>;
  private readonly hostName: (reach: SshReach) => Promise<string | undefined>;

  constructor(opts: SshBackendOptions = {}) {
    this.transport = opts.transport ?? sshClient;
    this.hostKey = opts.hostKey ?? knownHostKey;
    this.knownHosts = opts.knownHosts ?? knownHostsWritten;
    this.offered = opts.offeredKey ?? offeredHostKey;
    this.hostName = opts.hostName ?? sshHostName;
  }

  async create(): Promise<Machine> {
    throw new Error("a machine reached over ssh already exists; wsp records it, it does not make it");
  }

  async get(id: string): Promise<Machine> {
    const reach = parseSshMachineId(id);
    if (reach === undefined) throw new Error(`${id} is not a machine this host reaches over ssh`);
    return new SshMachine(reach, this.transport);
  }

  /** The persisted records are the fleet: nothing on the far side lists the machines a person reaches over ssh. */
  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [];
  }

  async deleteSnapshot(): Promise<void> {
    throw new Error("a machine reached over ssh holds no snapshots");
  }

  /** Reads a machine over ssh and hands back the handle its record stands on, so the one call that records a
   * workspace is also the one that proves the dial works. The key it answers with is read after that dial and not
   * out of it: accept-new wrote the entry as the connection was made, while a dial riding a master the last minute
   * left open exchanges no key at all, and a record with no identity is a machine that can be recorded twice. */
  async adopt(reach: SshReach): Promise<{ machine: SshMachine; login: SshLogin; shape: MachineShape; system?: string; arch?: string; shell?: string; hostKey?: string }> {
    const { login, shape, system, arch, shell } = await readSshMachine(reach, this.transport);
    const hostKey = await this.keyFor(reach);
    return { machine: new SshMachine(reach, this.transport), login, shape, ...(system !== undefined ? { system } : {}), ...(arch !== undefined ? { arch } : {}), ...(shell !== undefined ? { shell } : {}), ...(hostKey !== undefined ? { hostKey } : {}) };
  }

  /** The key this computer's ssh client holds for a machine, read with nothing dialled, or nothing where it holds
   * none. Asked on its own by a road that has to say what a dial wrote here whether or not the login that followed
   * it stood, which is a question `adopt` cannot answer once it has thrown. */
  async keyFor(reach: SshReach): Promise<string | undefined> {
    return this.hostKey(reach);
  }

  /** The entry that key was written into on this computer, as the client itself answers rather than as a default:
   * a config pointing UserKnownHostsFile somewhere else is read out and so is a HostName or a HostKeyAlias, so a
   * screen naming the file and the line that removes the entry names the true ones. Empty where the client
   * answers nothing, which leaves that screen its default to name. */
  async knownHostsEntry(reach: SshReach): Promise<{ file?: string; target?: string }> {
    return this.knownHosts(reach);
  }

  /** What the machine itself answers with, asked of the machine and not of this computer's own files: the one read
   * a road has before the first dial of a computer nobody here has met. */
  async offeredKeyFor(reach: SshReach): Promise<{ key?: string; stoppedBy?: string }> {
    return this.offered(reach);
  }

  /** The address a dial of this login reaches, which is what tells an alias for this computer from a box elsewhere;
   * nothing where the dial goes through another computer. */
  async hostNameFor(reach: SshReach): Promise<string | undefined> {
    return this.hostName(reach);
  }
}
