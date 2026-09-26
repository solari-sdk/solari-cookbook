// SPDX-License-Identifier: AGPL-3.0-only
// The host as a service of this computer's own manager: a launchd agent on a
// Mac, a systemd unit on Linux. One module per manager, and adding one is
// its entry in SERVICE_MANAGERS and its module here; nothing outside this file
// decides by a manager's name. The unit file holds no key: a service reads the
// same .env a terminal run reads, so nothing secret lands in ~/Library.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { authority, fmtDuration, LABS_ENV, shellQuote, UPDATE_CHECK_ENV } from "@wsp/protocol";
import { addressLines, dialAddress, servingHost, stateLine, type HostLock } from "./host-lock.js";
import { providerEnvNames } from "./providers.js";
import { publicHostname } from "./relay-link.js";
import { homeNamed } from "./serving-home.js";

export type ServiceKind = "launchd" | "systemd";

/** What a wsp service on a computer is: the host serving a state file, or the agent holding a place's link open. */
export type ServiceRole = "host" | "place";

/** The word the managers' names and the unit's own description carry. One reading, so a manager cannot name a
 * service by one word and describe it by another. */
const roleWord = (at: { role?: ServiceRole }): ServiceRole => at.role ?? "host";

/** Which service this is, for every manager that only has to name it: one service per state file. */
export interface ServiceAddress {
  /** Which of the two services this is: the host serving a state file, or the agent on a computer joined to one as
   * a place. It is the one word the manager's names turn on, so one computer can hold both at once. Absent is the
   * host, which is what every caller that names none means. */
  role?: ServiceRole;
  /** The state file the service's host serves, absolute; on a place, its own place file, since that is the one
   * thing there is one of per service. */
  statePath: string;
  /** The person's home folder, where the manager reads unit files from. */
  home: string;
  /** The user the service runs as, which launchd names its domain by. */
  uid: number;
}

/** What the service runs, for a manager writing its unit file. */
export interface ServicePlan extends ServiceAddress {
  /** The line it runs, word by word: this node, this wsp, and the words that serve. */
  argv: readonly string[];
  /** The folder it runs in, so a `.env` beside a dev checkout stays the one the host reads. */
  cwd: string;
  /** The envs it starts with; a key is never one of them. */
  env: Readonly<Record<string, string>>;
  /** Where its output goes, since nobody is watching a terminal. */
  logPath: string;
}

export interface ServiceUnit {
  /** What the manager calls it. */
  name: string;
  /** The file the manager reads it from. */
  path: string;
}

/** One unit a manager may be holding for a service: the file, the words a line naming it uses, and the three sets
 * of commands that take it away, in the order the file's own removal sits among them. A manager with more than one
 * place to put a unit answers one of these per place, and the words name which, since a person reading what a
 * leave took needs to know which of them it came out of. */
export interface HeldUnit {
  unit: ServiceUnit;
  words: string;
  /** Run in order to stop what is running, while the unit file is still there: a manager asked to stop a unit
   * whose file has already gone stops nothing, and the process it started keeps running with the files it serves
   * removed under it. */
  stop: ReadonlyArray<readonly string[]>;
  /** Run in order to make the manager forget it at the next login, while the file it reads that off is still
   * there. */
  forget: ReadonlyArray<readonly string[]>;
  /** Run in order once the file has gone, so the manager no longer holds a unit no file names. */
  reload: ReadonlyArray<readonly string[]>;
}

/** What a manager's command answered: its exit code, and whatever it said on either stream. */
export interface RunResult {
  code: number;
  output: string;
}

export interface ServiceManager {
  /** How a person names it in a line: "launchd agent", "systemd user unit". */
  words: string;
  unit(at: ServiceAddress): ServiceUnit;
  /** The unit file's whole text. */
  text(plan: ServicePlan): string;
  /** Run in order once the file is written, so it serves now and again at login. */
  load(at: ServiceAddress): ReadonlyArray<readonly string[]>;
  /** Run in order to stop it and leave the manager holding nothing. */
  unload(at: ServiceAddress): ReadonlyArray<readonly string[]>;
  /** Every unit this manager could be holding for the address: the one it writes now first, then any a road wsp
   * took before wrote somewhere else of this manager's. Its caller is the sweep on a computer joined as a place,
   * which takes them all, so a computer joined before a unit moved is left as clean as one joined today. The stop
   * and the forget on each run while its file is still there: a manager asked to stop a unit whose file has gone
   * stops nothing, and one that keeps a link of its own beside that file would be left holding one that points at
   * nothing. */
  held(at: ServiceAddress): readonly HeldUnit[];
  /** Exits 0 when the manager holds it, non-zero when it does not. */
  holds(at: ServiceAddress): readonly string[];
  /** Whether a non-zero `holds` answer is this manager saying it does not have the unit. A manager that is not on
   * PATH, or one that never reached the thing it asks, answers non-zero too and that is not the same sentence: wsp
   * leaves a service it cannot read alone rather than throwing away the file that names it. */
  absent(answer: RunResult): boolean;
  /** One line a person still has to act on after the load, for what this manager alone asks; nothing where this
   * manager leaves them none. */
  afterLoad?(at: ServiceAddress): string | undefined;
  /** Whether this service must be installed by root, which is a fact of where this manager puts the unit. A
   * manager that writes every unit under the person's own home answers false and needs no entry. */
  needsRoot?(at: ServiceAddress): boolean;
}

/** One service per state file: the manager's names carry the first eight hex of that path's digest, so two state
 * files never write the same unit into one home folder. */
export function serviceTag(statePath: string): string {
  return createHash("sha256").update(statePath).digest("hex").slice(0, 8);
}

/** A service inherits almost no environment, so a PATH the install never saw is the one it would get. */
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** The envs the service starts with: the PATH the install ran with, WSP_HOME when it moved the state folder, and
 * whichever provider variables the installing shell held, since a host that picks its provider out of an
 * environment naming none forks nothing. The keys stay out: the host reads them off the `.env` it would read at a
 * terminal, so a rotated key needs no new unit file and nothing secret is copied into the manager's own folder. */
export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const home = homeNamed(env["WSP_HOME"]);
  // Every variable the installing shell holds that the service would be without: the provider ones, since a host
  // that picks its provider out of an environment naming none forks nothing, labs, since a service installed
  // from a shell holding it would come up without the rows that shell was using, and the release check's switch,
  // which that shell turned off. One list, copied by one rule.
  const carried = [LABS_ENV, UPDATE_CHECK_ENV, ...providerEnvNames()];
  return {
    PATH: env["PATH"] ?? FALLBACK_PATH,
    ...(home !== undefined ? { WSP_HOME: home } : {}),
    ...Object.fromEntries(carried.flatMap(name => ((env[name] ?? "") === "" ? [] : [[name, env[name]!]]))),
  };
}

const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const launchdName = (at: ServiceAddress): string => `com.wsp.${roleWord(at)}.${serviceTag(at.statePath)}`;
const launchdUnit = (at: ServiceAddress): ServiceUnit => ({ name: launchdName(at), path: join(at.home, "Library", "LaunchAgents", `${launchdName(at)}.plist`) });
const launchdUnload = (at: ServiceAddress): ReadonlyArray<readonly string[]> => [["launchctl", "bootout", `gui/${at.uid}/${launchdName(at)}`]];

const launchd: ServiceManager = {
  words: "launchd agent",
  unit: launchdUnit,
  // KeepAlive brings the host back when it dies; RunAtLoad starts it now and again at every login.
  text: plan =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${xml(launchdName(plan))}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...plan.argv.map(word => `    <string>${xml(word)}</string>`),
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...Object.entries(plan.env).map(([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`),
      "  </dict>",
      `  <key>WorkingDirectory</key><string>${xml(plan.cwd)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      `  <key>StandardOutPath</key><string>${xml(plan.logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(plan.logPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  load: at => [["launchctl", "bootstrap", `gui/${at.uid}`, launchdUnit(at).path]],
  unload: launchdUnload,
  holds: at => ["launchctl", "print", `gui/${at.uid}/${launchdName(at)}`],
  // One domain per login, so one file; launchd reads its units off that file alone and has nothing to forget and
  // nothing to reload once it has gone.
  held: at => [{ unit: launchdUnit(at), words: "launchd agent", stop: launchdUnload(at), forget: [], reload: [] }],
  // launchctl answers 113 and says it could not find the service for a label the domain does not have; every other
  // answer is a domain it would not read or a launchctl that is not there.
  absent: answer => answer.code === 113 || /could not find service/i.test(answer.output),
};

const systemdName = (at: ServiceAddress): string => `wsp-${roleWord(at)}-${serviceTag(at.statePath)}.service`;

/** The two systemds a unit of wsp's can sit in: the machine's own, and the login's. */
const SYSTEMD_SCOPES = ["system", "user"] as const;
type SystemdScope = (typeof SYSTEMD_SCOPES)[number];

/** Which systemd a role's unit belongs to. The agent on a computer joined as a place is the machine's service: a
 * place runs workspaces, which needs root, so its unit sits under /etc/systemd/system and outlives every login.
 * The host is the person's own and stays in their login's systemd. Read once, by every line below that differs. */
const systemdScoped = (at: ServiceAddress): SystemdScope => (roleWord(at) === "place" ? "system" : "user");
const systemctlIn = (scope: SystemdScope): string[] => (scope === "user" ? ["systemctl", "--user"] : ["systemctl"]);
const systemctlArgs = (at: ServiceAddress): string[] => systemctlIn(systemdScoped(at));
const systemdUnitIn = (at: ServiceAddress, scope: SystemdScope): ServiceUnit => ({
  name: systemdName(at),
  path: scope === "user" ? join(at.home, ".config", "systemd", "user", systemdName(at)) : join("/etc/systemd/system", systemdName(at)),
});
const systemdUnit = (at: ServiceAddress): ServiceUnit => systemdUnitIn(at, systemdScoped(at));

/** What takes a unit away in one systemd: the two lines a stop of the host's own service runs while its file is
 * still there, then the three a sweep takes a place's unit away with, in the order the file's removal sits among
 * them. Written once against a scope so the unit a role writes today and the one an older road wrote are torn
 * down by the same lines, told a different systemd. */
const systemdUnload = (at: ServiceAddress, scope: SystemdScope): ReadonlyArray<readonly string[]> => [
  [...systemctlIn(scope), "disable", "--now", systemdName(at)],
  [...systemctlIn(scope), "daemon-reload"],
];
const systemdForget = (at: ServiceAddress, scope: SystemdScope): ReadonlyArray<readonly string[]> => [[...systemctlIn(scope), "disable", systemdName(at)]];
const systemdStop = (at: ServiceAddress, scope: SystemdScope): ReadonlyArray<readonly string[]> => [[...systemctlIn(scope), "stop", systemdName(at)]];
const systemdReload = (scope: SystemdScope): ReadonlyArray<readonly string[]> => [[...systemctlIn(scope), "daemon-reload"]];

const systemd: ServiceManager = {
  words: "systemd unit",
  unit: systemdUnit,
  text: plan =>
    [
      "[Unit]",
      `Description=wsp ${roleWord(plan)} serving ${plan.statePath}`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${plan.argv.map(shellQuote).join(" ")}`,
      // A bare path: systemd reads a quoted WorkingDirectory as not absolute and refuses the whole unit.
      `WorkingDirectory=${plan.cwd}`,
      ...Object.entries(plan.env).map(([name, value]) => `Environment=${shellQuote(`${name}=${value}`)}`),
      "Restart=always",
      "RestartSec=5",
      `StandardOutput=append:${plan.logPath}`,
      `StandardError=append:${plan.logPath}`,
      "",
      "[Install]",
      `WantedBy=${systemdScoped(plan) === "user" ? "default.target" : "multi-user.target"}`,
      "",
    ].join("\n"),
  // A restart rather than a start: an install writes the unit file over whatever was there and puts a new binary
  // beside it, and a unit whose old process is still up would go on running the binary that was replaced. Restart
  // starts a unit that is stopped, so the one line covers both.
  load: at => [
    [...systemctlArgs(at), "daemon-reload"],
    [...systemctlArgs(at), "enable", systemdName(at)],
    [...systemctlArgs(at), "restart", systemdName(at)],
  ],
  unload: at => systemdUnload(at, systemdScoped(at)),
  holds: at => [...systemctlArgs(at), "is-enabled", systemdName(at)],
  // systemd enables a unit by a symlink beside its file, so the file alone is not the whole of what it holds: a
  // stop and a disable while the unit file is still there take the process and that link with them, and the reload
  // after the file has gone leaves systemd holding nothing. Both scopes, the one this role writes today first: a
  // computer joined before the place's unit became the machine's has its file under that login's own systemd, and
  // a sweep that read one scope left it there to flap.
  held: at => {
    const now = systemdScoped(at);
    return [now, ...SYSTEMD_SCOPES.filter(scope => scope !== now)].map(scope => ({
      unit: systemdUnitIn(at, scope),
      words: `systemd ${scope} unit`,
      stop: systemdStop(at, scope),
      forget: systemdForget(at, scope),
      reload: systemdReload(scope),
    }));
  },
  // is-enabled exits 1 both for a unit systemd does not have and for a systemctl that never reached the user bus
  // ("Failed to connect to bus: No medium found" on a box without one), so the word it printed is the answer and
  // the code is not.
  absent: answer => {
    const said = answer.output.trim().split("\n").at(-1)?.trim() ?? "";
    return said === "disabled" || said === "not-found" || /no such file or directory/i.test(said);
  },
  // A user unit runs while the person is logged in and no longer, which is what default.target means; the system
  // unit a place installs is the machine's and has nothing left for the person to do.
  afterLoad: at => (systemdScoped(at) === "user" ? "It comes back at every login; `loginctl enable-linger` keeps it up between them." : undefined),
  needsRoot: at => systemdScoped(at) === "system",
};

export const SERVICE_MANAGERS: { readonly [K in ServiceKind]: ServiceManager } = { launchd, systemd };

/** The manager each platform's own init system is; a platform absent here has none wsp writes units for. */
const BY_PLATFORM: Readonly<Record<string, ServiceKind>> = { darwin: "launchd", linux: "systemd" };

export function serviceManagerFor(platform: string): ServiceManager | undefined {
  const kind = BY_PLATFORM[platform];
  return kind === undefined ? undefined : SERVICE_MANAGERS[kind];
}

/** The one line for a computer wsp writes no unit for, naming what it does write units for. */
export function noManagerLine(platform: string): string {
  const words = Object.entries(BY_PLATFORM).map(([os, kind]) => `a ${SERVICE_MANAGERS[kind].words} on ${os}`);
  return `wsp writes no service on ${platform}; it writes ${words.join(" and ")}. Run wsp up in a terminal that stays open instead.`;
}

/** A unit this computer's manager is registered to serve a state file with: what it is called, and the words a
 * line naming it uses. */
export interface RegisteredService {
  unit: ServiceUnit;
  words: string;
}

/** Which service this is on this computer: one per state file, under this person's home and this user. */
export function serviceAddressHere(statePath: string): ServiceAddress {
  return { statePath, home: homedir(), uid: process.getuid?.() ?? 0 };
}

/** What a manager is registered to serve an address with, and nothing where it holds no unit for it or there is
 * no manager on this platform at all. The unit file standing is the whole of the reading, which is the fact wsp
 * down and the sweep on a joined computer read too: a manager that has booted the unit out still has the file,
 * and the state file is still that service's to serve. */
export function registeredIn(manager: ServiceManager | undefined, at: ServiceAddress): RegisteredService | undefined {
  // The first unit a manager holds is the one it writes for this address today, which is what `unit` answers; it
  // is read off `held` because that reading also carries the words a line naming it uses, and on systemd those
  // words say which of its two scopes the unit sits in.
  const held = manager?.held(at)[0];
  return held !== undefined && existsSync(held.unit.path) ? { unit: held.unit, words: held.words } : undefined;
}

/** The same reading for this computer and this state file, which is what the start road and wsp up ask. */
export const registeredService = (statePath: string): RegisteredService | undefined => registeredIn(serviceManagerFor(platform()), serviceAddressHere(statePath));

export interface ServiceRunner {
  /** The patience is the caller's, since what a manager is being asked for decides it; a caller that names none
   * takes the one a command that only writes or reads gets. */
  (argv: readonly string[], waitMs?: number): Promise<RunResult>;
}

/** What a manager's command gets to answer in: enough for a launchctl or a systemctl under load, short enough
 * that one which never answers does not hold a verb open. */
const MANAGER_WAIT_MS = 15_000;

/** What a stop gets instead. systemd asks a unit to leave and waits its TimeoutStopSec, 90 seconds where nothing
 * names another, before it kills what is left; a daemon writing its last frames is not a stop that failed until
 * systemd itself says so. Killing systemctl at the shorter wait would have a leave report a stop that failed for
 * a unit that was on its way down, and the line a person reads is what actually happened. */
export const STOP_WAIT_MS = 100_000;

/** A manager's command on this computer. A binary that is not there answers 127 with the same shape, so a Mac
 * without launchctl reads as a refusal rather than a thrown error. */
export const systemRunner: ServiceRunner = (argv, waitMs = MANAGER_WAIT_MS) =>
  new Promise(resolve => {
    execFile(argv[0]!, [...argv.slice(1)], { timeout: waitMs }, (error, stdout, stderr) => {
      const said = `${stdout}${stderr}`.trim();
      if (error === null) return resolve({ code: 0, output: said });
      const code = "code" in error && typeof error.code === "number" ? error.code : 127;
      resolve({ code, output: said === "" ? error.message : said });
    });
  });

/** The command that failed and what it said, or nothing when every one of them answered 0. */
export interface RunFailure {
  argv: readonly string[];
  result: RunResult;
}

/** Runs them in order and stops at the first that refuses, which is the answer: the rest of a teardown or a load
 * is told against a manager that has already said no. Exported because the sweep on a computer joined as a place
 * reads the same answers out of the same lines, and a second copy of this loop there would be a second rule about
 * what a refusal is. */
export async function runAll(commands: ReadonlyArray<readonly string[]>, run: ServiceRunner, waitMs?: number): Promise<RunFailure | undefined> {
  for (const argv of commands) {
    const result = await run(argv, waitMs);
    if (result.code !== 0) return { argv, result };
  }
  return undefined;
}

/** The line a failed manager command reads as: what wsp ran, its code and what it said, on one line. A manager
 * answers in as many lines as it likes, and every reader of this puts it inside a line of its own: one that a
 * leave prints among what it took is read back off that computer by the mark in front of it, which only its first
 * line would carry. */
export function runFailureLine(failure: RunFailure): string {
  const words = failure.result.output.replace(/\s+/g, " ").trim();
  const said = words === "" ? "and said nothing" : `and said: ${words}`;
  return `${failure.argv.join(" ")} exited ${failure.result.code} ${said}`;
}

/** Writes the unit file and hands it to the manager. The file is the person's own: it names their paths, and a
 * manager refuses a unit anyone else could rewrite. */
export async function installService(
  manager: ServiceManager,
  plan: ServicePlan,
  run: ServiceRunner,
): Promise<{ unit: ServiceUnit; installed: boolean; failure?: RunFailure }> {
  const unit = manager.unit(plan);
  mkdirSync(dirname(unit.path), { recursive: true });
  // A refused load only takes back a file this call wrote. One that was already there names a service the manager
  // may still hold, and a manager holding a service with no file is one wsp down can no longer take away.
  const wrote = !existsSync(unit.path);
  writeFileSync(unit.path, manager.text(plan), { mode: 0o600 });
  const failure = await runAll(manager.load(plan), run);
  if (failure !== undefined && wrote) rmSync(unit.path, { force: true });
  return { unit, installed: existsSync(unit.path), ...(failure !== undefined ? { failure } : {}) };
}

/** What a stop did: whether the manager had it, the answer wsp could not read, and the command that refused. */
export interface StopReading {
  unit: ServiceUnit;
  /** Whether the manager answered that it holds it, and so was asked to unload it. */
  held: boolean;
  /** The `holds` answer that was neither "I have it" nor "I do not": nothing was unloaded and the file stands. */
  unsure?: RunFailure;
  failure?: RunFailure;
}

/** Stops the service and takes its unit file away, so nothing brings the host back at the next login. A manager
 * that says it no longer holds it is not asked to stop it, since every one of them refuses a service it does not
 * have; the file still goes, so the next install writes a fresh one. An answer that says neither leaves both the
 * service and its file exactly as they were, for the caller to say so. */
export async function stopService(manager: ServiceManager, at: ServiceAddress, run: ServiceRunner): Promise<StopReading> {
  const unit = manager.unit(at);
  const argv = manager.holds(at);
  const answer = await run(argv);
  const held = answer.code === 0;
  if (!held && !manager.absent(answer)) return { unit, held, unsure: { argv, result: answer } };
  const failure = held ? await runAll(manager.unload(at), run) : undefined;
  if (failure === undefined) rmSync(unit.path, { force: true });
  return { unit, held, ...(failure !== undefined ? { failure } : {}) };
}

/** The `service` row of wsp status: what the manager holds, what is installed and it does not, or that none is. */
export async function serviceReading(manager: ServiceManager | undefined, at: ServiceAddress, run: ServiceRunner, platform: string): Promise<string> {
  if (manager === undefined) return `none; wsp writes no service on ${platform}`;
  const unit = manager.unit(at);
  if (!existsSync(unit.path)) return `none; wsp up --service installs a ${manager.words}`;
  const held = (await run(manager.holds(at))).code === 0;
  return `${manager.words} ${unit.name}, ${held ? "loaded" : "installed and not loaded"} (${unit.path})`;
}

const POLL_MS = 200;

/** A load, a stop or a start is a process coming up or going down on this computer, not a network call. One number
 * for every road that waits on one, so a service and a verb's own child are given the same patience. */
export const SERVICE_WAIT_MS = 20_000;

/** A sleep a waiter can cut short: the timer goes with it, so a loop that stopped waiting leaves nothing pending
 * behind it. */
const wait = (ms: number, until?: Promise<unknown>): Promise<void> =>
  new Promise(done => {
    const timer = setTimeout(done, ms);
    void until?.then(() => {
      clearTimeout(timer);
      done();
    });
  });

/** Whether the host a lock names is answering where the lock says it is. The lock is taken before the host binds
 * anything, so the lock alone is a claim and one GET is the proof; any answer at all means something bound it. */
export interface HostProbe {
  (lock: HostLock): Promise<boolean>;
}

const PROBE_MS = 2_000;

export const httpProbe: HostProbe = async lock => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), PROBE_MS);
  try {
    // The lock's address, through the same rule the command line dials by: a host bound to one address answers
    // only there, and probing loopback would report a healthy host as dead.
    await fetch(`http://${authority(dialAddress(lock), lock.port)}/`, { signal: stop.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** Polls until a host holds the lock and answers on the port it names, or the wait runs out. A host that cannot bind
 * takes the lock and dies under KeepAlive or Restart=always, over and over, so a lock that came and went is not a
 * host serving anything.
 *
 * `gone` is the child this wait was started for having exited: a process that is no longer there writes no lock, so
 * waiting out the rest of the patience tells the caller nothing it does not already know. */
export async function untilServing(
  statePath: string,
  waitMs: number,
  answers: HostProbe,
  sleep: (ms: number, until?: Promise<unknown>) => Promise<void> = wait,
  gone?: Promise<unknown>,
): Promise<HostLock | undefined> {
  const deadline = Date.now() + waitMs;
  let stopped = false;
  void gone?.then(() => (stopped = true));
  for (;;) {
    const lock = servingHost(statePath);
    if (lock !== undefined && (await answers(lock))) return lock;
    if (stopped || Date.now() >= deadline) return undefined;
    await sleep(POLL_MS, gone);
  }
}

/** Polls the lock until it says what the caller waited for, or the wait runs out; the lock as it stands either way,
 * so the caller reads whether it got there from the value and not from a timer. */
export async function untilLock(statePath: string, serving: boolean, waitMs: number, sleep: (ms: number) => Promise<void> = wait): Promise<HostLock | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = servingHost(statePath);
    if ((lock !== undefined) === serving) return lock;
    if (Date.now() >= deadline) return lock;
    await sleep(POLL_MS);
  }
}

/** Both managers append to the log for as long as the service lives and nothing rotates it, so only its end is
 * read. A line the window cut in half is not a line and goes. */
const TAIL_BYTES = 64 * 1024;

/** How much of the log is already written, for a caller marking where its own child's lines begin: both managers and
 * every host a verb starts append to one file across days. Nothing written yet reads as nothing. */
export function logSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/** The lines written to the log past a mark, which for a child a line started is everything that child said. */
export function logSince(logPath: string, from: number): string[] {
  if (!existsSync(logPath)) return [];
  const fd = openSync(logPath, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    if (size <= from) return [];
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    text = buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
  return text.split("\n").filter(line => line.trim() !== "");
}

/** The last lines of the service's log, for a start that never took: nothing when there is no log yet. */
export function logTail(logPath: string, lines = 20): string[] {
  if (!existsSync(logPath)) return [];
  const fd = openSync(logPath, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const from = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const read = buffer.toString("utf8");
    text = from === 0 ? read : read.slice(read.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
  return text.split("\n").filter(line => line.trim() !== "").slice(-lines);
}

/** What wsp status prints for a line aimed at a host on another computer: this computer holds that host's address
 * and a token for it and nothing else, so the rows are where it answers and whether it did, and the row for what
 * keeps it up says where to read it. A road that carried nothing names what it was waiting on under the host row. */
export function hostThereLines(name: string, url: string, unreached: string | undefined): string[] {
  return [
    `host        ${name} ${unreached === undefined ? "answering" : "did not answer"}`,
    `app         ${url}`,
    ...(unreached === undefined ? [] : [`            ${unreached}`]),
    "service     what keeps it up is that computer's own; run wsp status in a terminal there",
  ];
}

/** A host that took the lock, and whether it answered on the port the lock names. */
export interface HostReading {
  lock: HostLock;
  answering: boolean;
}

/** What wsp status prints: whether a host serves this state file and where, then what keeps it there. Every row is
 * label and value, so a person reads the same columns wsp up prints when it starts. A host that took the lock and
 * answers nothing is a crash loop rewriting that lock, and the row says which of the two it is. The newest release
 * rides last, off the file the host keeps, where any ask was ever kept. */
export function statusLines(statePath: string, host: HostReading | undefined, service: string, now = Date.now(), latest?: string): string[] {
  const release = latest === undefined ? [] : [`latest      ${latest}`];
  if (host === undefined) return ["host        not running", stateLine(statePath), `service     ${service}`, ...release];
  const { lock } = host;
  const publicAt = publicHostname(statePath);
  const up = `pid ${lock.pid}, up ${fmtDuration(now - Date.parse(lock.startedAt))}`;
  return [
    host.answering ? `host        running (${up})` : `host        not answering on port ${lock.port} (${up})`,
    ...addressLines(statePath, lock, publicAt),
    `service     ${service}`,
    ...release,
  ];
}
