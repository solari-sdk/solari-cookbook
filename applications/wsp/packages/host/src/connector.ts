// SPDX-License-Identifier: AGPL-3.0-only
// The tunnel connector: the release this version of wsp runs, pinned by
// sha256 in a table beside this file, fetched into the state folder and
// verified before a byte of it is written anywhere runnable. Nothing here
// pipes a download into a shell. The child is started by this process, its pid
// is written down, and that pid is the only one anything here ever kills.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch as thisArch, platform as thisPlatform, uptime } from "node:os";
import { join } from "node:path";
import { LOOPBACK } from "@wsp/protocol";
import table from "../assets/cloudflared.json" with { type: "json" };

/** One release for one kind of computer: where it comes from and the sha256 the bytes must have. */
export interface PinnedBinary {
  version: string;
  url: string;
  sha256: string;
  /** The mac releases ship as a gzipped tar holding one file; the linux ones are the binary itself. */
  archive?: "tgz";
}

export interface CloudflaredTable {
  version: string;
  assets: Record<string, { url: string; sha256: string; archive?: string }>;
}

/** The pinned releases, read from the file in the repo so the table and the code cannot drift apart. */
export const CLOUDFLARED = table as CloudflaredTable;

/** What a connector child is started with: a managed tunnel, whose credential rides the environment rather than
 * this line, since anybody on the box can read another user's arguments; or a quick one against the loopback port. */
export function connectorArgs(opts: { token?: string; port: number }): string[] {
  return opts.token !== undefined ? ["tunnel", "--no-autoupdate", "run"] : ["tunnel", "--no-autoupdate", "--url", `http://${LOOPBACK}:${opts.port}`];
}

/** The release for this computer, or a refusal naming the computers the table does hold one for. */
export function pinnedCloudflared(platform: NodeJS.Platform | string = thisPlatform(), arch: string = thisArch()): PinnedBinary {
  const key = `${platform}-${arch}`;
  const asset = CLOUDFLARED.assets[key];
  if (asset === undefined) {
    throw new Error(`wsp has no pinned cloudflared for ${key}; it has ${Object.keys(CLOUDFLARED.assets).sort().join(", ")}. Install cloudflared yourself and reach this host another way.`);
  }
  return { version: CLOUDFLARED.version, url: asset.url, sha256: asset.sha256, ...(asset.archive === "tgz" ? { archive: "tgz" as const } : {}) };
}

export type FetchBytes = (url: string) => Promise<Uint8Array>;

/** Follows the release host's redirects and holds the whole file in memory, which is how it is hashed before anything lands on disk. */
export const httpBytes: FetchBytes = async url => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The pinned binary in this folder, fetched and verified if it is not there yet. The sha is checked before the
 * bytes are given a name anything would run, and a mismatch leaves the folder as it was. */
export async function fetchPinned(dir: string, pin: PinnedBinary, fetchBytes: FetchBytes = httpBytes): Promise<string> {
  const bin = join(dir, `cloudflared-${pin.version}`);
  if (existsSync(bin)) return bin;
  const bytes = await fetchBytes(pin.url);
  const got = sha256(bytes);
  if (got !== pin.sha256) throw new Error(`refusing that download: ${pin.url} should have sha256 ${pin.sha256} and has ${got}`);
  mkdirSync(dir, { recursive: true });
  const staged = `${bin}.part`;
  try {
    if (pin.archive === "tgz") {
      const tgz = `${bin}.tgz`;
      writeFileSync(tgz, bytes, { mode: 0o600 });
      try {
        const unpacked = spawnSync("tar", ["-xzf", tgz, "-C", dir, "cloudflared"], { encoding: "utf8" });
        if (unpacked.status !== 0) throw new Error(`could not unpack ${pin.url}: ${unpacked.stderr.trim() || `tar exited ${String(unpacked.status)}`}`);
        renameSync(join(dir, "cloudflared"), staged);
      } finally {
        rmSync(tgz, { force: true });
      }
    } else {
      writeFileSync(staged, bytes);
    }
    chmodSync(staged, 0o755);
    renameSync(staged, bin);
  } catch (e) {
    rmSync(staged, { force: true });
    throw e;
  }
  return bin;
}

export interface CloudflaredDeps {
  platform?: NodeJS.Platform | string;
  arch?: string;
  fetchBytes?: FetchBytes;
}

/** The connector binary for whoever is running, in this state folder. */
export async function ensureCloudflared(dir: string, deps: CloudflaredDeps = {}): Promise<string> {
  return fetchPinned(dir, pinnedCloudflared(deps.platform ?? thisPlatform(), deps.arch ?? thisArch()), deps.fetchBytes ?? httpBytes);
}

/** The hostname a quick tunnel printed, out of one line of the connector's output. The relay holds the same shape
 * a second time (isQuickTunnel in infra/relay/src/env.ts), where it is the only name a heartbeat may report; a
 * Worker and a command line share no module, so a change to one of these is a change to both. */
export function quickHostname(line: string): string | undefined {
  return /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(line)?.[1];
}

export interface ConnectorOptions {
  bin: string;
  /** Where the pid is written, beside the state file the host serves. */
  stateDir: string;
  /** The loopback port the tunnel carries to. */
  port: number;
  /** A managed tunnel's token; without one the connector asks for a quick tunnel and prints the name it got. */
  token?: string;
  log(line: string): void;
  /** First pause before a connector that exited is started again; it doubles up to half a minute. Default 2 s. */
  restartMs?: number;
  /** Asked before a connector that exited is started again: a box that was unlinked while its host runs has no
   * tunnel left to carry, so nothing is started for it. Absent, an exited connector is always started again. */
  keepRunning?(): boolean;
  /** Told the name a start of a quick tunnel printed, whenever it is not the name last told: cloudflared hands out
   * a fresh one every time the child runs, and only the caller knows where that name is written down and reported. */
  onHostname?(hostname: string): void;
  spawnChild?: typeof spawn;
}

export interface Connector {
  /** The child this process started, while one is running. */
  readonly pid: number | undefined;
  /** The public hostname, once a quick tunnel has printed one; nothing when the connector stopped without one. */
  hostname(): Promise<string | undefined>;
  stop(): Promise<void>;
}

const MAX_RESTART_MS = 30_000;

/** Runs the connector and keeps it running. The pid file is what a later unlink reads, and the only pid anything
 * here signals: a connector found by name or by port could be somebody else's. */
export function startConnector(opts: ConnectorOptions): Connector {
  const pidPath = join(opts.stateDir, "connector.pid");
  const spawnChild = opts.spawnChild ?? spawn;
  const args = connectorArgs({ ...(opts.token !== undefined ? { token: opts.token } : {}), port: opts.port });
  let child: ChildProcess | undefined;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let pause = opts.restartMs ?? 2_000;
  /** The last name told to the caller, so a start that was handed the same name again is not reported as a change. */
  let found: string | undefined;
  let tellHostname: ((hostname: string | undefined) => void) | undefined;
  const hostname = new Promise<string | undefined>(done => (tellHostname = done));

  const run = (): void => {
    mkdirSync(opts.stateDir, { recursive: true });
    // Each start reads its own name, since a quick tunnel is given a new one every time: the reader belongs to this
    // child, so a line the one before it left in the pipe cannot be read as this child's name.
    let printed: string | undefined;
    const read = (chunk: unknown): void => {
      if (printed !== undefined) return;
      const name = String(chunk).split("\n").map(quickHostname).find(seen => seen !== undefined);
      if (name === undefined) return;
      printed = name;
      if (name === found) return;
      found = name;
      // Told before handed over: what the caller does with a name is done by the time anything waiting on the
      // first one reads what the caller wrote down.
      opts.onHostname?.(name);
      tellHostname?.(name);
    };
    const started = spawnChild(opts.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Three things and no more: this process holds the person's provider and model keys, and a connector has no
      // use for any of them.
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        ...(opts.token !== undefined ? { TUNNEL_TOKEN: opts.token } : {}),
      },
    });
    child = started;
    // The pid and when it was written: a pid on its own names another process of this user after a reboot.
    if (started.pid !== undefined) writeFileSync(pidPath, `${JSON.stringify({ pid: started.pid, startedAt: new Date().toISOString() })}\n`);
    started.stdout?.on("data", read);
    started.stderr?.on("data", read);
    started.on("error", e => opts.log(`connector: could not start ${opts.bin}: ${e.message}`));
    started.on("exit", (code, signal) => {
      child = undefined;
      rmSync(pidPath, { force: true });
      if (stopping) return;
      if (opts.keepRunning?.() === false) {
        opts.log(`connector: the tunnel exited (${signal ?? code ?? "no code"}) and this computer is on no relay now, so nothing takes its place`);
        return;
      }
      opts.log(`connector: the tunnel exited (${signal ?? code ?? "no code"}); starting it again in ${Math.round(pause / 1000)}s`);
      timer = setTimeout(run, pause);
      pause = Math.min(pause * 2, MAX_RESTART_MS);
    });
  };
  run();

  return {
    get pid() {
      return child?.pid;
    },
    hostname: () => hostname,
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      tellHostname?.(found);
      const running = child;
      if (running?.pid === undefined) {
        rmSync(pidPath, { force: true });
        return;
      }
      const gone = new Promise<void>(done => running.once("exit", () => done()));
      // Only the pid this process started, read off the handle and never off a name or a port.
      try {
        process.kill(running.pid, "SIGTERM");
      } catch {
        return;
      }
      await gone;
      rmSync(pidPath, { force: true });
    },
  };
}

/** Whether a pid is still there. EPERM means it exists under another user, which counts as alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/** What a run wrote down about the connector it started. */
interface RecordedChild {
  pid: number;
  startedAt: string;
}

function recordedChild(pidPath: string): RecordedChild | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pidPath, "utf8")) as Partial<RecordedChild>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.startedAt === "string" ? (parsed as RecordedChild) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a connector this computer started is running now: the pid a run wrote down, still alive and not from
 * before the last boot. Every line that says where this host answers from anywhere reads it, so a name in the
 * record cannot outlive the tunnel that carried it. */
export function connectorRunning(stateDir: string): boolean {
  const held = recordedChild(join(stateDir, "connector.pid"));
  if (held === undefined) return false;
  return Date.parse(held.startedAt) >= Date.now() - uptime() * 1000 && alive(held.pid);
}

/** Stops a connector an earlier run of the host left behind, by the pid that run wrote down, and waits for it to
 * go: a tunnel whose connector still holds connections cannot be deleted, so the caller has to know it is gone.
 * A record from before this computer last started names a pid the system has since given to somebody else, so it
 * is dropped rather than signalled. */
export async function stopRecordedConnector(stateDir: string, waitMs = 5_000): Promise<void> {
  const pidPath = join(stateDir, "connector.pid");
  if (!existsSync(pidPath)) return;
  const held = recordedChild(pidPath);
  rmSync(pidPath, { force: true });
  if (held === undefined) return;
  const bootedAt = Date.now() - uptime() * 1000;
  if (Date.parse(held.startedAt) < bootedAt) return;
  try {
    process.kill(held.pid, "SIGTERM");
  } catch {
    // The connector is already gone; the file above was the only thing left to clear.
    return;
  }
  const until = Date.now() + waitMs;
  while (alive(held.pid) && Date.now() < until) await new Promise(done => setTimeout(done, 50));
}
