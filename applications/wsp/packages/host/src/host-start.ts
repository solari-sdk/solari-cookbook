// SPDX-License-Identifier: AGPL-3.0-only
// The host a verb brings up for itself. A line that needs the host serving
// this state file and finds none starts one detached and waits for its lock,
// so nobody has to type wsp up to get going, and wsp down stops what a verb
// started.
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fmtDuration } from "@wsp/protocol";
import { hostLogPath, servingHost, STARTED_BY_ENV, type HostLock } from "./host-lock.js";
import { runningWsp, wspCommand, type RunningWsp } from "./mcp-install.js";
import { httpProbe, logSince, logSize, logTail, registeredService, SERVICE_WAIT_MS, untilServing, type HostProbe, type RegisteredService } from "./service.js";

/** Starts a host serving this state file on this computer and answers with its lock once it answers on its port.
 * Free ports unless `ports` names the ones a host that is restarting itself held. */
export interface HostStarter {
  (statePath: string, say: (line: string) => void, ports?: { port: number; wsPort: number }): Promise<HostLock>;
}

export interface StartDeps {
  spawn: typeof nodeSpawn;
  /** The line that starts this same wsp again, off the one rule an agent's config is written by. */
  wsp: { command: string; args: readonly string[] };
  env: Readonly<Record<string, string | undefined>>;
  waitMs: number;
  answers: HostProbe;
  /** What this computer's own manager is registered to serve this state file with, and nothing where none is.
   * One reading, in service.ts, so this road and wsp up refuse on the same fact. */
  registered: (statePath: string) => RegisteredService | undefined;
}

/** The one line a verb prints before it waits, on stderr whatever the line prints on stdout. */
export const startingHostLine = (statePath: string, logPath: string): string => `starting the host for ${statePath}; its log is ${logPath}, and wsp down stops it`;

/** A child that took the wait and never served: one refusal naming the file it was started for. */
export const noHostAnsweredLine = (statePath: string, waitMs: number): string => `no host answered for ${statePath} within ${fmtDuration(waitMs)}`;

/** A child that ended before it served and said nothing about why: the person still needs the file it was started
 * for, how it ended and where to read it. A child that did say something is handed those words instead, since a
 * host refusing the state it was given has already written the sentence the person needs. */
export const hostExitedLine = (statePath: string, ended: number | string, logPath: string): string =>
  `the host for ${statePath} exited with ${ended} before it served; its log is ${logPath}`;

/** Why a line starts no host of its own: this computer's own manager is registered to serve that state file, and
 * a host of whatever build happened to be on the line would read those records and write them back in its own
 * shape under the one that owns them. The one line named starts the service whether the manager has the unit
 * loaded or not, so a person reads one road out of either state. */
export const serviceServesStateLine = (statePath: string, service: RegisteredService): string =>
  `${statePath} is served by the ${service.words} ${service.unit.name}, which is not running; wsp up --service --state ${statePath} starts it again`;

/** Why a line brings up no host on this state file, or nothing where it may. One rule for both roads that start
 * one, so the sentence is true in the state it is read in: a host that is already serving is the lock's own
 * refusal to give and not this one, and a file no unit of this computer's names is nobody's but the caller's. */
export function serviceServesState(
  statePath: string,
  registered: (statePath: string) => RegisteredService | undefined,
  serving: (statePath: string) => HostLock | undefined = servingHost,
): string | undefined {
  if (serving(statePath) !== undefined) return undefined;
  const service = registered(statePath);
  return service === undefined ? undefined : serviceServesStateLine(statePath, service);
}

export function hostStarter(deps: StartDeps): HostStarter {
  return async (statePath, say, ports) => {
    // Before anything is spawned: a state file the service owns is served by the service or by nothing.
    const owned = serviceServesState(statePath, deps.registered);
    if (owned !== undefined) throw new Error(owned);
    const logPath = hostLogPath(statePath);
    mkdirSync(dirname(logPath), { recursive: true });
    // Where this child's own lines begin: the log is one file appended to across days, so everything already in it
    // was written for somebody else's start and is no part of this one's answer.
    const wrote = logSize(logPath);
    const log = openSync(logPath, "a");
    let child: ReturnType<typeof nodeSpawn>;
    try {
      // Free ports on purpose: another host, the app's or a service, often holds the default on this computer, and
      // every client dials the address the lock records rather than a number written down anywhere.
      child = deps.spawn(deps.wsp.command, [...deps.wsp.args, "up", "--state", statePath, "--port", String(ports?.port ?? 0), "--ws-port", String(ports?.wsPort ?? 0)], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...deps.env, [STARTED_BY_ENV]: "verb" },
      });
      child.unref();
    } finally {
      closeSync(log);
    }
    // A detached child is still this process's child while this process lives, so its exit lands here.
    let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const gone = new Promise<void>(done =>
      child.once("exit", (code, signal) => {
        ended = { code, signal };
        done();
      }),
    );
    say(startingHostLine(statePath, logPath));
    // Two verbs starting at once need no coordination: the second child's lock is refused and it dies, and this
    // wait sees the first child's lock.
    const lock = await untilServing(statePath, deps.waitMs, deps.answers, undefined, gone);
    if (lock !== undefined) return lock;
    // A host that exited refusing the state it was given is not a host that failed to start: it has said why, and
    // what it said is the answer, read at once and with nothing of the wait or of an older start around it.
    if (ended !== undefined) {
      const said = logSince(logPath, wrote);
      throw new Error(said.length > 0 ? said.join("\n") : hostExitedLine(statePath, ended.code ?? ended.signal ?? "no code", logPath));
    }
    throw new Error([noHostAnsweredLine(statePath, deps.waitMs), ...logTail(logPath)].join("\n"));
  };
}

/** The starter for a process that knows how it was started: the same line an agent's config would be given, with
 * the wait a service load is given. */
export function starterFor(run: RunningWsp = runningWsp(), env: Readonly<Record<string, string | undefined>> = process.env): HostStarter {
  return hostStarter({ spawn: nodeSpawn, wsp: wspCommand(run), env, waitMs: SERVICE_WAIT_MS, answers: httpProbe, registered: registeredService });
}
