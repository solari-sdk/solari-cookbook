// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { accountAim, aimedAlias, aimedHost, defaultHomeIn, devCheckoutState, dialAddress, dialHost, homeNamed, hostLogPath, hostTokenFor, lockPathFor, ownPid, readHost, serve, servingHost, severalAccountHostsLine, wspHome, type CliIO, type HereAt, type HostLock, type HostRecord, type RestartRoad, type RunningWsp, type UrlOpener } from "@wsp/host";
import { LOOPBACK, authority, bootLineOf, hereWord, isLoopback, type BootPayload } from "@wsp/protocol";
import { safeEqual, tokenDigest, type Runtime } from "@wsp/runtime";

export interface HostSession {
  url: string;
  port: number;
  /** True when this process started the host and must stop it on quit. */
  owned: boolean;
  /** True for a host on another computer, whose device token the shell holds. */
  remote: boolean;
  /** What the window and the menu call this host. */
  label: string;
  /** The hosts file's name for a host somewhere else; the app's own host has none. */
  alias?: string;
  /** The token this computer holds for that host, handed to the page over the bridge and never written into it. */
  deviceToken?: string;
  close(): Promise<void>;
}

export interface Located {
  /** Where keys and state are read from when no host is serving. */
  home: string;
  /** A host already serving: through the lock, or the port. */
  session?: HostSession;
}

/** How this app was launched, as everything that decides where its state file sits reads it. */
export interface Launch {
  /** app.isPackaged. A packaged app inherits whatever folder the person launched it from, so a checkout it happens
   * to open in says nothing about it; only a development run out of one means the checkout's state. */
  packaged: boolean;
  /** WSP_HOME as launched; a Finder launch has none. It names the home outright, over any launch folder. */
  env?: string;
  cwd: string;
}

export interface OpenHostOptions {
  port: number;
  wsPort: number;
  statePath: string;
  webDir: string;
  io: CliIO;
  runtime?: Runtime;
  /** How a guest tool's sign-in URL reaches this computer's browser; the platform opener when absent. */
  openUrl?: UrlOpener;
  /** How this process is started again, for the wsp tools the init job writes into an agent's config: the shim. */
  running?: RunningWsp;
  /** How a host on the account is dialled, which is the command line's own dial. */
  dial?: typeof dialHost;
  /** How the host this window starts restarts itself: the app relaunching. */
  restart?: RestartRoad;
  /** The loopback cell the runtime's reach reads, filled by the host once it binds. */
  here?: HereAt;
}

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** The boot object of the page served at this authority, or nothing where nothing there answers as a wsp host. */
async function bootAt(at: string): Promise<BootPayload | undefined> {
  try {
    const res = await fetch(`http://${at}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? bootLineOf(await res.text()) : undefined;
  } catch {
    return undefined;
  }
}

/** Which port a url answers on, read by every session built from an address rather than from a port this app
 * bound: a url with no port is the scheme's own. */
export const portOf = (url: string): number => Number(new URL(url).port) || 80;

/** A session on a host on another computer: the address it answers at, what the window and the menu call it, and
 * the device token the shell holds for it and hands the page over the bridge. Written once, since the window reaches
 * such a host by opening on it and by moving to it. */
export function remoteSession(alias: string, record: HostRecord, url: string): HostSession {
  return { url, port: portOf(url), owned: false, remote: true, alias, label: alias, deviceToken: record.deviceToken, close: async () => {} };
}

function attached(port: number, url: string): HostSession {
  return { url, port, owned: false, remote: false, label: hereWord(process.platform === "darwin"), close: async () => {} };
}

/** Whether a digest is the one of the token the host serving this state file holds, compared the one way this repo
 * compares a secret. The page carries the digest and this window holds the file, so the compare sends nothing and
 * a page a squatter serves learns nothing by being read. False where no host has written the file, so nothing
 * matches nothing. It lives here rather than beside the token file's own reader because the host package's MCP
 * server may reach no runtime. */
export function hostTokenMatches(statePath: string, digest: string): boolean {
  const held = hostTokenFor(statePath);
  return held !== undefined && safeEqual(tokenDigest(held), digest);
}

/** One sentence for every live lock this window will not attach to, whichever of the three reasons it is: the
 * owner's token is never sent to that page to settle the question, since a squatter would then have it, and the
 * page's digest of it is what is read instead. */
const wontAttach = (statePath: string, lock: HostLock, why: string): Error =>
  new Error(`a host (pid ${lock.pid}) holds ${lockPathFor(statePath)} on port ${lock.port} but ${why}: stop that process or run wsp down, then open wsp again`);

/** The bin's rule, read from the bin: a checkout of wsp in cwd marks a dev run whose .wsp state is shared with wspx. It
 * holds for a development run and nothing else, since a packaged app is launched from a folder it did not choose,
 * and WSP_HOME names the home over it in every case, which is what the locate doc says. */
export function statePathIn(home: string, launch: Launch): string {
  const dev = launch.packaged || homeNamed(launch.env) !== undefined ? undefined : devCheckoutState(launch.cwd);
  return dev ?? join(home, "state.json");
}

/** The host whose lock sits beside this state file, once this window has proof it is the owner's own. The lock is
 * the whole road in: a page on a port carrying the boot line is anything any login on this computer cares to
 * serve. Its pid is this login's, and then one of two readings by the address it bound. A host on loopback serves
 * its page with the digest of its own token inlined, so the page is held to the digest of the token file beside
 * the state. A host bound beyond this computer serves a page with no digest by design, and the lock alone is the
 * reading for it. Either road is dialled where the lock says that host answers, which for a host on ::1 or on
 * 127.0.0.2 is there and nowhere else. Anything else is a refusal: this window starts no second host on a state
 * file another process holds. */
async function lockedHost(statePath: string): Promise<HostSession | undefined> {
  const held = servingHost(statePath);
  if (held === undefined) return undefined;
  if (!ownPid(held.pid)) throw wontAttach(statePath, held, "that process is not this login's");
  const at = authority(dialAddress(held), held.port);
  if (!isLoopback(held.address ?? LOOPBACK)) return attached(held.port, `http://${at}`);
  const boot = await bootAt(at);
  if (boot === undefined) throw wontAttach(statePath, held, "no wsp host answers there");
  if (boot.tokenHash === undefined || !hostTokenMatches(statePath, boot.tokenHash)) throw wontAttach(statePath, held, "the page it serves carries another token's digest than the file beside this state");
  return attached(held.port, `http://${at}`);
}

/** The wsp home a launch means: WSP_HOME when it is set, else this computer's own. A window that should open on
 * another home is launched with WSP_HOME naming it, which is the one way any road here says which home it means. */
export function homeOf(launch: Launch): string {
  const env = homeNamed(launch.env);
  return env !== undefined ? resolve(env) : defaultHomeIn(homedir());
}

/** Where this app keeps Chromium's own files, its profile, caches and worker registrations: one folder beside the
 * state file the launch serves, so two apps on two homes never share one profile. A shared profile's databases
 * are locked by the first app to open them, and the second launch's page load never came back. */
export function userDataIn(launch: Launch): string {
  return join(dirname(statePathIn(homeOf(launch), launch)), "desktop");
}

/** Runs before the setup gate: a serving host is the proof of setup. The lock beside the launch's home's state file
 * is the one thing read. */
export async function locateHost(opts: Launch): Promise<Located> {
  const home = homeOf(opts);
  const session = await lockedHost(statePathIn(home, opts));
  return { home, ...(session !== undefined ? { session } : {}) };
}

/** How long this window's one dial at the account's host waits. A line at a terminal gives a relayed road fifteen
 * seconds, which is a window with nothing in it for that long; a person who opened the app is watching it, so a
 * host that has not answered is one the window opens without, with the host's own sentence in the log. The floor
 * under it is what that road was measured to hold: an edge whose tunnel has just come up answers a first frame at
 * 5.8 s, so anything shorter calls a box that is alive dead and opens here instead of on that host. */
const ACCOUNT_DIAL_MS = 8_000;

/** The host somewhere else this window opens on when nothing serves here: the alias the rule every line with no
 * name on it takes, which is the one host on the account this computer can reach. It is read through that same
 * rule, so a record holding a token and no key for the host is refused here as every verb refuses it, and dialled
 * once, which admits this computer over there and hands the page a token that opens. Nothing where the rule names
 * no alias, where several hosts on the account stand, or where the one it named refused or did not answer; the
 * window starts a host here as it always did and the sentence is logged, since the screen that would ask which host
 * is the first run's. */
async function accountSession(opts: OpenHostOptions): Promise<HostSession | undefined> {
  const home = wspHome();
  const alias = aimedAlias(opts.statePath, home);
  if (alias === undefined) {
    const aim = accountAim(opts.statePath, home);
    if (aim.kind === "several") opts.io.error(severalAccountHostsLine(aim.aliases));
    return undefined;
  }
  try {
    const aim = aimedHost(opts.statePath, { host: alias, home });
    (await (opts.dial ?? dialHost)(opts.statePath, { aim, home, deadlineMs: ACCOUNT_DIAL_MS })).close();
  } catch (e) {
    opts.io.error(`${e instanceof Error ? e.message : String(e)}; this window is opening on the host here instead`);
    return undefined;
  }
  // What the dial left under that alias: the device token the host answered this computer's key with, which a
  // record off the account's listing held none of until now.
  const record = readHost(home, alias);
  if (record === undefined) return undefined;
  // Nothing is served on this computer, so the runtime the setup gate built goes away rather than lingering
  // behind the window, which is the rule that gate applies when it has nothing to show.
  await opts.runtime?.close();
  return remoteSession(alias, record, record.url);
}

/** The io the host inside the app writes through: every line also lands in the host.log a service host writes, since
 * a packaged app's own stdout and stderr go nowhere a person can read. */
function loggedTo(io: CliIO, logPath: string): CliIO {
  const kept = (line: string): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // A log that cannot be written never stops the host that writes it.
    }
  };
  return {
    ...io,
    log: line => {
      kept(line);
      io.log(line);
    },
    error: line => {
      kept(line);
      io.error(line);
    },
  };
}

/** Attaches to the host already serving this state file, which its lock names
 * and this window has proof of, else opens on the host a line with no name on
 * it takes, else starts one the way the wsp bin does. Defaults held by
 * anything else give way to free ports. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = await lockedHost(opts.statePath);
  if (held !== undefined) return held;
  const away = await accountSession(opts);
  if (away !== undefined) return away;
  const defaultsFree = (opts.port === 0 || (await canListen(opts.port))) && (opts.wsPort === 0 || (await canListen(opts.wsPort)));
  const ports = defaultsFree ? { port: opts.port, wsPort: opts.wsPort } : { port: 0, wsPort: 0 };
  const handle = await serve(loggedTo(opts.io, hostLogPath(opts.statePath)), {
    ...ports,
    statePath: opts.statePath,
    webDir: opts.webDir,
    ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
    ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
    ...(opts.running !== undefined ? { running: opts.running } : {}),
    ...(opts.restart !== undefined ? { restart: opts.restart } : {}),
    ...(opts.here !== undefined ? { here: opts.here } : {}),
  });
  return { url: `http://${authority(LOOPBACK, handle.port)}`, port: handle.port, owned: true, remote: false, label: hereWord(process.platform === "darwin"), close: () => handle.close() };
}
