// SPDX-License-Identifier: AGPL-3.0-only
// One state file, one host: the lock names the process serving it and the
// ports it bound, so a second host refuses and other local tools find it.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authority, isWildcard, LOOPBACK, relayUrlOf, type HostShape } from "@wsp/protocol";
import { ownFolder } from "@wsp/own-file";

export interface HostLock {
  pid: number;
  port: number;
  wsPort: number;
  /** The address the host bound, absent on a lock a host of an earlier build wrote, which bound this computer alone. */
  address?: string;
  startedAt: string;
  /** What brought this host up, where wsp brought it up itself: a verb that needed one, the wsp up a person typed,
   * or this computer's own manager holding the unit for the state file. wsp down stops any of them, and a second
   * wsp up is told so. Absent is a host wsp did not start from the command line, which is the app's own, and
   * nothing here may stop that one. */
  startedBy?: HostStarted;
}

/** The three roads a host is started by, as the lock records them: two a person's command line takes, and the
 * service this computer's own manager holds. */
export type HostStarted = Exclude<HostShape, "app">;

/** The variable a host something else started carries. A verb's own child and the service's unit each mark the
 * host they start, so wsp down tells them from a host a person is holding open in a terminal, and a client tells
 * the service's own host from one it would be starting beside it. */
export const STARTED_BY_ENV = "WSP_STARTED_BY";

/** The roads that mark the host they start; the wsp up a person typed is read off the line, not the environment. */
const MARKS: readonly HostStarted[] = ["verb", "service"];

/** What the environment says started this process, and nothing where nothing did. */
export const startedByEnv = (env: Readonly<Record<string, string | undefined>>): HostStarted | undefined => MARKS.find(word => word === env[STARTED_BY_ENV]);

function isHostLock(v: unknown): v is HostLock {
  return (
    typeof v === "object" &&
    v !== null &&
    "pid" in v &&
    typeof v.pid === "number" &&
    "port" in v &&
    typeof v.port === "number" &&
    "wsPort" in v &&
    typeof v.wsPort === "number" &&
    "startedAt" in v &&
    typeof v.startedAt === "string"
  );
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** What signal 0 says about a pid, read once here so the two readings below cannot drift: this login's own
 * process, a process of another login (EPERM), or no process at all. */
function signalled(pid: number): "own" | "another" | "gone" {
  try {
    process.kill(pid, 0);
    return "own";
  } catch (e) {
    return errnoCode(e) === "EPERM" ? "another" : "gone";
  }
}

/** Whether a pid is a live process, whoever owns it: a lock another login holds is still a held lock, and a
 * second host on the same state file gives way to it. */
export const pidAlive = (pid: number): boolean => signalled(pid) !== "gone";

/** Whether a pid is a process this login could signal, which is a process of its own. A lock naming a pid that
 * answers EPERM names another login's process on a number a dead host once had, which is the stale lock case. */
export const ownPid = (pid: number): boolean => signalled(pid) === "own";

function readLock(path: string): HostLock | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHostLock(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function heldBy(lock: HostLock, statePath: string): Error {
  return new Error(
    `another wsp host (pid ${lock.pid}) is already serving ${statePath} on port ${lock.port} (ws ${lock.wsPort}). ` +
      (lock.startedBy !== undefined ? "wsp down stops it, or point --state at a different file." : "Stop it first, or point --state at a different file."),
  );
}

export function lockPathFor(statePath: string): string {
  return join(dirname(statePath), "host.lock");
}

/** Where the host writes the token its protocol socket takes, for the other local tools that dial it. */
export function hostTokenPath(statePath: string): string {
  return join(dirname(statePath), "host-token");
}

/** What the host serving this state file presents on its own socket, as every tool on this computer reads it: the
 * token file beside the state, or nothing when no host has written one. */
export function hostTokenFor(statePath: string): string | undefined {
  try {
    return readFileSync(hostTokenPath(statePath), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Where the runs a turn on this computer leaves live, beside the lock and the token: the script, the log, the pid
 * and the exit code of every turn this host launched here. One folder per state file, so a host that comes back
 * finds its own turns still running and two hosts on this computer never sweep each other's. */
export function hostRunDir(statePath: string): string {
  return join(dirname(statePath), "runs");
}

/** Where this host's own workspace keeps the folders its daemon may browse, beside the lock and the runs. The
 * person's home is what that daemon browses from, and this file says which folders under it are a project's; it
 * belongs to the host serving this state file, so two hosts on two state files write two of them rather than
 * rewriting one another's. */
export function hostRootsPath(statePath: string): string {
  return join(dirname(statePath), "roots");
}

/** Where the files handed to a turn on this computer land for its daemon to pick up, beside the lock and the runs,
 * under the same rule: one per state file, made by the host that serves it. */
export function hostInboxDir(statePath: string): string {
  return join(dirname(statePath), "inbox");
}

/** Where a host nobody is watching writes what a terminal run would have shown, beside the lock and the token. */
export function hostLogPath(statePath: string): string {
  return join(dirname(statePath), "host.log");
}

/** Where the host serving this state file is, as it prints them when it starts and as wsp status prints them while
 * it runs: one rule for the lines, so both readings name the same ports, the same address and the same token file.
 * A reading with no address is a host that bound this computer alone. The bound address and the public one stay
 * apart, since they are two roads in and not two spellings of one: the first is the object the lock and the init
 * hand-over both carry, and the second is a name a relay gave this host, which only a caller that read the relay
 * record can know. */
export function addressLines(statePath: string, at: { port: number; wsPort: number; address?: string }, publicHostname?: string): string[] {
  const bound = at.address ?? LOOPBACK;
  return [
    `app         http://${authority(bound, at.port)}`,
    `runtime ws  ws://${authority(bound, at.wsPort)} (token: ${hostTokenPath(statePath)})`,
    stateLine(statePath),
    ...(publicHostname !== undefined ? [publicAddressLine(publicHostname)] : []),
  ];
}

/** The one line naming the state a run works on, wherever a summary names it: the host's own start lines, wsp
 * status and the relay link all read it here, so a person comparing two readings compares the same spelling. */
export function stateLine(statePath: string): string {
  return `state       ${statePath}`;
}

/** The one line naming where this host answers from anywhere: printed at start when the relay already had a name
 * for it, and again by whatever learns the name later, so both readings are the same sentence. */
export function publicAddressLine(hostname: string): string {
  return `public      ${relayUrlOf(hostname)}`;
}

/** Where a tool on this computer dials the host serving this state file: the address the host bound, and loopback
 * only for the wildcard, which is the one address that is not itself a place to dial. Every other spelling is
 * passed through as it was given, since a host on ::1 or on 127.0.0.2 answers there and nowhere else. */
export function dialAddress(lock: { address?: string }): string {
  const at = lock.address ?? LOOPBACK;
  return isWildcard(at) ? LOOPBACK : at;
}

/** The host whose lock names this state file, when that process is still alive. */
export function servingHost(statePath: string): HostLock | undefined {
  const held = readLock(lockPathFor(statePath));
  return held !== undefined && pidAlive(held.pid) ? held : undefined;
}

/** One state file, one host. A lock whose pid is gone is a crash leftover and
 * gives way; a lock this process cannot parse is treated the same. Read twice
 * on the road a start takes: once before it picks ports or builds anything, so
 * a host already serving costs the second start nothing, and again in takeLock
 * as the last read before its write, which is what settles two starts that both
 * passed the first one. */
export function refuseIfServed(lockPath: string, statePath: string): void {
  const held = readLock(lockPath);
  if (held !== undefined && pidAlive(held.pid)) throw heldBy(held, statePath);
}

/** Seeded with the requested ports so a refusal during startup can name them;
 * rewritten with the bound ports once the host is up. */
export function takeLock(lockPath: string, statePath: string, ports: { port: number; wsPort: number; address?: string; startedBy?: HostStarted }): HostLock {
  refuseIfServed(lockPath, statePath);
  const lock: HostLock = { pid: process.pid, ...ports, startedAt: new Date().toISOString() };
  // The state file, its blobs and the host token sit here, so the folder is the owner's before the lock is taken.
  ownFolder(dirname(statePath));
  ownFolder(dirname(lockPath));
  rmSync(lockPath, { force: true });
  try {
    writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx" });
  } catch (e) {
    if (errnoCode(e) !== "EEXIST") throw e;
    const winner = readLock(lockPath);
    throw winner !== undefined ? heldBy(winner, statePath) : new Error(`another wsp host just took ${lockPath}`);
  }
  return lock;
}
