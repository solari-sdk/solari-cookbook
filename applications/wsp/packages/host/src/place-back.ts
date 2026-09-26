// SPDX-License-Identifier: AGPL-3.0-only
// The forwards over ssh a host holds for computers that cannot reach it: one
// ssh child per login, from a port on that computer's own loopback to this
// host's door, made again whenever it ends for as long as it is held.

import { randomInt } from "node:crypto";
import { PLACE_FILE_MODE, backUrl, isLoopback, parsePlaceFile, placeDaemonPaths, placeFileText, shellQuote, type PlaceBack } from "@wsp/protocol";
import { MissingKnownHostsError, SSH_DIAL_MS, SSH_LINE_CAP, boxWord, carriedSshValues, holdBackForward, keyFingerprint, parseSshAddress, sshClient, type BackForward, type SshCarried, type SshReach, type SshSpawn, type SshTransport } from "@wsp/engine";
import type { PlaceBackHolder, PlaceLogin } from "@wsp/runtime";

/** How much of the box's place file is read: a real one is well under a kilobyte, and the box is the untrusted side. */
const HELD_PLACE_READ_BYTES = 65_536;

/** The place file on the box, read before anything of wsp's lands and before a forward's new port is written into
 * it: empty where it holds none. */
export const heldPlaceScript = (home: string): string => `head -c ${HELD_PLACE_READ_BYTES} ${shellQuote(placeDaemonPaths(home).placeFile)} 2>/dev/null || true`;

/** How long the child gets to stand the forward: the dial, the login and sshd's answer to the forward. */
const BACK_UP_MS = 20_000;

/** A forward that stood this long was a working one, so the next remake starts from the bottom of the waits. */
const BACK_SETTLED_MS = 60_000;

/** The wait before remake n, the shape the box's own link waits in: two seconds doubling to thirty. */
export const backWaitMs = (attempt: number): number => Math.min(30_000, 2_000 << Math.min(4, Math.max(0, attempt - 1)));

/** Where a port is picked when the one asked for is taken on the box: below Linux's own range for outbound
 * connections, so the pick does not meet a port the box hands out itself. */
const pickBoxPort = (): number => randomInt(10_000, 32_768);

/** What ssh says under ExitOnForwardFailure when sshd would not bind the port or would not take the forward at all
 * (AllowTcpForwarding); the two read the same. */
const FORWARD_REFUSED = "remote port forwarding failed for listen port";

/** Every listener on the port asked about, one line each with its owner where ss names one, off ss where the box
 * has it and /proc where it does not. */
export function backBindScript(port: number): string {
  return [
    "{",
    "if command -v ss >/dev/null 2>&1; then",
    `  ss -ltnpH ${shellQuote(`sport = :${port}`)} | while read -r _ _ _ at _ owner; do echo "WSP_BIND $at $owner"; done`,
    "else",
    '  for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] && while read -r _ at _ st _; do [ "$st" = 0A ] && echo "WSP_BINDHEX $at"; done < "$f"; done',
    "fi",
    "} | head -n 256",
    "true",
  ].join("\n");
}

/** A local address as /proc/net/tcp writes it: IPv4 as one little-endian word, IPv6 as four. */
function hexAddress(hex: string): string {
  const word = (w: string): string[] => (w.match(/../g) ?? []).reverse();
  if (hex.length === 8) return word(hex).map(b => parseInt(b, 16)).join(".");
  const bytes = (hex.match(/.{8}/g) ?? []).flatMap(word);
  if (bytes.slice(0, 10).every(b => b === "00") && bytes[10] === "FF" && bytes[11] === "FF") return bytes.slice(12).map(b => parseInt(b, 16)).join(".");
  if (bytes.slice(0, 15).every(b => b === "00") && bytes[15] === "01") return "::1";
  return (bytes.join("").match(/.{4}/g) ?? []).join(":").toLowerCase();
}

/** One listener the box named: where, and whether ss says sshd owns it. The comm is sshd, or sshd-session from
 * OpenSSH 9.8 on; undefined off /proc, which names no owner. */
export interface BackBind {
  at: string;
  sshd: boolean | undefined;
}

/** The listeners the box says are on that port, off what backBindScript printed. */
export function backBinds(said: string, port: number): BackBind[] {
  const found: BackBind[] = [];
  for (const line of said.split("\n").slice(0, 256)) {
    const ss = /^WSP_BIND (\S+):(\d+)(?:\s+(.*))?$/.exec(line.trim());
    if (ss !== null && Number(ss[2]) === port) found.push({ at: ss[1]!.replace(/^\[|\]$/g, "").replace(/%\S*$/, ""), sshd: /^users:\(\("sshd(?:-session)?",/.test(ss[3] ?? "") });
    const proc = /^WSP_BINDHEX ([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(line.trim());
    if (proc !== null && parseInt(proc[2]!, 16) === port) found.push({ at: hexAddress(proc[1]!.toUpperCase()), sshd: undefined });
  }
  return found;
}

/** Why a forward that stood was cut: sshd put it somewhere other than the box's loopback (GatewayPorts yes), where
 * anything that reaches the box would reach this host's door, or the box would not say where it went. */
export const backBindLine = (login: string, bound: string | undefined): string =>
  bound === undefined
    ? `wsp could not see where ${login.slice(0, 64)}'s sshd put the forward back to this computer, so it cut it; check that ss or /proc/net/tcp answers there`
    : `${login.slice(0, 64)}'s sshd put the forward back to this computer on ${boxWord(bound)}, beyond its own loopback, so wsp cut it; set GatewayPorts to clientspecified or no in its sshd_config, or link this host to your relay`;

/** Why a port was passed over: something other than sshd listens there beyond the box's loopback. */
export const backTakenLine = (login: string, port: number): string => `another program on ${login.slice(0, 64)} listens on port ${port} beyond its loopback, so wsp tries the forward back to this computer at another port`;

/** Why a host holds no forward: it serves beyond its loopback, and a forward into that port would arrive as the
 * owner's own road. */
export const backNoDoorLine = (login: string): string =>
  `this host serves beyond its own loopback, so it holds no forward back from ${login.slice(0, 64)}; start it without --listen, or link it to your relay`;

/** Why a hold was refused on a wsp that serves no host: nothing hands the holder a door, so nothing would stand. */
export const backNoHostLine = (login: string): string =>
  `no wsp host serves on this computer, so nothing holds a forward back from ${login.slice(0, 64)}; start one with wsp up and try again`;

/** The line for a forward whose up line never came. */
const backSlowLine = (login: string): string => `${login} did not stand the forward back to this computer within ${BACK_UP_MS / 1000}s`;

/** What a try answers once the login it ran for was let go. */
const letGoLine = (login: string): string => `the forward back from ${login} was let go`;

/** A refusal that making the forward again would only repeat, said whole since it carries its own fix. */
export class BackCutError extends Error {}

export interface PlaceBackDeps {
  /** The fingerprint of this host's own key: a place file naming any other is another wsp's and is never written. */
  hostKey: string;
  carry?: (reach: SshReach) => Promise<SshCarried>;
  spawn?: SshSpawn;
  transport?: SshTransport;
  pickPort?: () => number;
  waitMs?: (attempt: number) => number;
  upMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** One try's outcome, for whoever holds the login while it runs. */
interface Try {
  done: Promise<PlaceBack>;
  resolve: (back: PlaceBack) => void;
  reject: (e: Error) => void;
}

const freshTry = (): Try => {
  let settle!: Pick<Try, "resolve" | "reject">;
  const done = new Promise<PlaceBack>((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => {});
  return { done, ...settle };
};

/** How many different reasons a forward that keeps dropping is said for before a standing that lasted: a box writes
 * the words, and it is not trusted with this computer's memory. */
const SAID_REASONS = 16;

interface Held {
  login: PlaceLogin;
  back: PlaceBack;
  home: string;
  moved?: (back: PlaceBack) => void;
  child?: BackForward;
  released: boolean;
  /** The try running now, or the next one while the loop waits. */
  now: Try;
  wake?: () => void;
  said: Set<string>;
}

/** The holder a host wires: the installer holds a forward before the deploy, the records keep it held. */
export function placeBackHolder(deps: PlaceBackDeps): PlaceBackHolder {
  const carry = deps.carry ?? (reach => carriedSshValues(reach));
  const transport = deps.transport ?? sshClient;
  const pickPort = deps.pickPort ?? pickBoxPort;
  const waitMs = deps.waitMs ?? backWaitMs;
  const upMs = deps.upMs ?? BACK_UP_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const held = new Map<string, Held>();
  let doorAt: (() => Promise<number | undefined>) | undefined;
  let handed!: () => void;
  const doorHanded = new Promise<void>(resolve => (handed = resolve));

  const reachOf = (login: PlaceLogin): SshReach => parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });

  /** Thrown where a release landed mid-try, so nothing after it acts for a login nobody holds. */
  const stillHeld = (h: Held): void => {
    if (h.released) throw new Error(letGoLine(h.login.ssh));
  };

  /** One child at one port, up or refused within the bound. */
  const stand = async (h: Held, carried: SshCarried, boxPort: number, doorPort: number): Promise<BackForward> => {
    const child = holdBackForward(carried, boxPort, doorPort, deps.spawn);
    h.child = child;
    if (h.released) child.release();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([child.up, new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(backSlowLine(h.login.ssh))), upMs)))]);
      return child;
    } catch (e) {
      child.release();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  /** The box's place file names the new port where it named the old one; a file of another wsp's is left alone. */
  const rewrite = async (reach: SshReach, h: Held, boxPort: number): Promise<void> => {
    const path = placeDaemonPaths(h.home).placeFile;
    const file = parsePlaceFile((await transport(reach, heldPlaceScript(h.home), { timeoutMs: SSH_DIAL_MS })).stdout);
    stillHeld(h);
    if (file === undefined || keyFingerprint(file.hostPublicKey) !== deps.hostKey) return;
    const from = backUrl(h.back.boxPort);
    const hostUrls = file.hostUrls.includes(from) ? file.hostUrls.map(url => (url === from ? backUrl(boxPort) : url)) : [...file.hostUrls, backUrl(boxPort)];
    const next = `${path}.wsp-back`;
    const script = `umask 077 && cat > ${shellQuote(next)} && chmod ${PLACE_FILE_MODE.toString(8)} ${shellQuote(next)} && mv -f ${shellQuote(next)} ${shellQuote(path)}`;
    const landed = await transport(reach, script, { timeoutMs: SSH_DIAL_MS, stdin: new TextEncoder().encode(placeFileText({ ...file, hostUrls })) });
    if (landed.exitCode !== 0) throw new Error(`${h.login.ssh} did not take the forward's new port into its place file: ${landed.stderr.trim().slice(-SSH_LINE_CAP)}`);
  };

  /** One standing of the forward, onto the door as the host holds it now: the port it was asked at, a fresh one
   * where that one is taken, and the read of where sshd put it. A port that moved goes into the box's place file
   * before anyone hears of it. */
  const once = async (h: Held): Promise<BackForward> => {
    while (doorAt === undefined) {
      await new Promise<void>(done => {
        h.wake = done;
        void doorHanded.then(done);
      });
      stillHeld(h);
    }
    const doorPort = await doorAt!();
    stillHeld(h);
    if (doorPort === undefined) throw new BackCutError(backNoDoorLine(h.login.ssh));
    const reach = reachOf(h.login);
    const carried = await carry(reach);
    let taken: Error | undefined;
    for (const boxPort of [h.back.boxPort, undefined]) {
      stillHeld(h);
      const at = boxPort ?? pickPort();
      let child: BackForward;
      try {
        child = await stand(h, carried, at, doorPort);
      } catch (e) {
        // After a sleep sshd can hold the dead session's listener for minutes, so the port is taken, not refused.
        if (!(e instanceof Error && e.message.includes(FORWARD_REFUSED))) throw e;
        taken = e;
        continue;
      }
      try {
        const binds = backBinds((await transport(reach, backBindScript(at), { timeoutMs: SSH_DIAL_MS })).stdout, at);
        stillHeld(h);
        const wide = binds.filter(b => !isLoopback(b.at));
        // A wide bind with no owner named may be sshd's, and each retry would stand the door wide for a moment.
        const sshd = wide.find(b => b.sshd !== false);
        if (binds.length === 0 || sshd !== undefined) throw new BackCutError(backBindLine(h.login.ssh, sshd?.at));
        // Under GatewayPorts yes sshd binds the wildcard and ss names it the owner; anything else ss lists there is
        // another program's, whatever address it holds, and says nothing about sshd.
        if (wide.length > 0) {
          child.release();
          taken = new Error(backTakenLine(h.login.ssh, at));
          continue;
        }
        if (at !== h.back.boxPort) {
          await rewrite(reach, h, at);
          stillHeld(h);
          h.back = { boxPort: at };
          h.moved?.(h.back);
        }
        return child;
      } catch (e) {
        child.release();
        throw e;
      }
    }
    throw taken ?? new Error(letGoLine(h.login.ssh));
  };

  const sleep = (h: Held, ms: number): Promise<void> =>
    new Promise(done => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      h.wake = () => {
        clearTimeout(timer);
        done();
      };
    });

  /** Said once per reason until a standing lasts: a box that is off for a day, or drops every thirty seconds with
   * two reasons in turn, would otherwise fill the log. */
  const sayOnce = (h: Held, line: string): void => {
    if (h.said.has(line) || h.said.size >= SAID_REASONS) return;
    h.said.add(line);
    log(line);
  };

  /** Stands the forward, waits for it to end, and stands it again, until it is released or a refusal says trying
   * again would change nothing. */
  const keep = async (h: Held): Promise<void> => {
    let attempt = 0;
    let firstTry = true;
    try {
      while (!h.released) {
        attempt += 1;
        const started = now();
        try {
          const child = await once(h);
          h.now.resolve(h.back);
          const said = await child.ended;
          if (h.released) return;
          h.now = freshTry();
          if (now() - started > BACK_SETTLED_MS) {
            attempt = 0;
            h.said.clear();
          }
          sayOnce(h, `the forward back from ${h.login.ssh} ended: ${boxWord(said, SSH_LINE_CAP)}; wsp makes it again`);
        } catch (e) {
          const error = e instanceof BackCutError || e instanceof MissingKnownHostsError ? e : new Error(boxWord(e instanceof Error ? e.message : String(e), SSH_LINE_CAP));
          h.now.reject(error);
          if (h.released) return;
          h.now = freshTry();
          if (error instanceof BackCutError) {
            log(error.message);
            held.delete(h.login.ssh);
            h.released = true;
            return;
          }
          if (!firstTry) sayOnce(h, `the forward back from ${h.login.ssh} did not stand: ${error.message}`);
          else h.said.add(`the forward back from ${h.login.ssh} did not stand: ${error.message}`);
        }
        firstTry = false;
        await sleep(h, waitMs(attempt));
      }
    } finally {
      h.now.reject(new Error(letGoLine(h.login.ssh)));
    }
  };

  const release = (login: PlaceLogin): void => {
    const h = held.get(login.ssh);
    if (h === undefined) return;
    held.delete(login.ssh);
    h.released = true;
    h.child?.release();
    h.wake?.();
  };

  /** A hold made before any door was handed refuses at the bound, since a wsp that serves no host never hands one;
   * the loop goes on waiting, so a host that was only slow to hand it still stands the forward. */
  const bounded = (login: PlaceLogin, pending: Promise<PlaceBack>): Promise<PlaceBack> => {
    if (doorAt !== undefined) return pending;
    let timer: NodeJS.Timeout | undefined;
    const refused = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new BackCutError(backNoHostLine(login.ssh))), upMs);
      timer.unref?.();
    });
    void doorHanded.then(() => clearTimeout(timer));
    return Promise.race([pending, refused]).finally(() => clearTimeout(timer));
  };

  return {
    hold(login, back, on, moved) {
      const standing = held.get(login.ssh);
      if (standing !== undefined) {
        if (moved !== undefined) standing.moved = moved;
        // A loop waiting out a failure tries again now, so this caller hears a fresh try rather than the old one.
        standing.wake?.();
        return bounded(login, standing.now.done);
      }
      const h: Held = { login, back, home: on.home, ...(moved !== undefined ? { moved } : {}), released: false, now: freshTry(), said: new Set() };
      held.set(login.ssh, h);
      const first = h.now.done;
      void keep(h);
      return bounded(login, first);
    },
    release,
    door(at) {
      doorAt = at;
      handed();
    },
    close() {
      for (const h of [...held.values()]) release(h.login);
    },
  };
}
