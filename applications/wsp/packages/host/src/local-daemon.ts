// SPDX-License-Identifier: AGPL-3.0-only
// The daemon for this computer's own workspace: the same static binary every
// machine wsp forks runs, spawned here bound to loopback and reached by the
// same link (connectDaemon), so every caller that dials a workspace's daemon
// dials this one unchanged. It serves the ptys, port watch, inbox, process
// manifest and files a cloud daemon does, rooted at the workspace's folder,
// and told the local kind so it reads this computer's own load and processes
// rather than a guest's /proc.
//
// A caller may name the file it reads its token off. A stand-in provider's
// machine does: the runtime rotates a machine's token by writing it through
// that machine's own exec, which is a shell in that machine's folder, so the
// file has to be one this daemon reads and that shell can write.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
import { ownFolder } from "@wsp/own-file";
// LOOPBACK is the protocol's, which every road that binds or dials this computer reads. Here the reason is also
// that a firewall prompt on macOS or Windows is a wall a local workspace must never hit.
import { LOOPBACK, daemonListeningLine, daemonVersionOf, type DaemonEvent, type DaemonReachView, type SysSample } from "@wsp/protocol";
import { daemonBinaryHere } from "./assets.js";
import { pidAlive } from "./host-lock.js";

/** The loopback token is minted when the daemon starts and lives as long as the process holding it, so the road to
 * it never expires; the view's expiry is a number, so it carries the furthest one. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** How long the binary gets to print its listening line, and how long it gets to leave on SIGTERM before SIGKILL. */
const START_MS = 10_000;
const STOP_MS = 5_000;

/** What every local daemon's own folder is called, and the pid read back off one. The pid in the name is the
 * process whose close removes the folder, so a folder whose process is gone can be named as such by any later
 * start. A folder written before the pid was in the name matches nothing here and is left where it is. */
const OWN_DIR_PREFIX = "wsp-local-daemon-";
const OWN_DIR_PID = new RegExp(`^${OWN_DIR_PREFIX}(\\d+)-`);

/** The token folders of hosts this computer no longer runs, taken away. A host that is killed runs no close, so
 * its folder and the token in it sit under the temp dir until something removes them, and seventeen of them were
 * counted on one Mac. Two starts in the same second sweep the same dead folders and never each other's, whose pids
 * are alive. Best effort throughout: a temp dir this process may not read, and a folder another login left behind
 * on a computer where the temp dir is shared, are stepped over rather than taking the start down with them. */
function sweepDeadOwnDirs(at: string): void {
  let names: readonly string[];
  try {
    names = readdirSync(at);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = OWN_DIR_PID.exec(name)?.[1];
    if (pid === undefined || pidAlive(Number(pid))) continue;
    try {
      rmSync(join(at, name), { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

/** The listening line as a pattern that reads the port off it, whatever address the daemon printed. */
const LISTENING = new RegExp(
  daemonListeningLine("HOST", "PORT")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("HOST", ".*")
    .replace("PORT", "(\\d+)"),
);

export interface LocalDaemonOptions {
  /** The folder the daemon's files and git ops resolve inside, and its ptys start in: the workspace's folder. */
  root: string;
  /** The folder turns write in, whose volume the Machine tab's disk row reads. */
  workFolder: string;
  /** The file this daemon reads the folders it may browse as projects from, named by whatever started it: the host
   * keeps it beside the state file it serves, so two hosts on this computer write two files rather than one. */
  rootsPath: string;
  /** The folder a file handed to a turn lands in for this daemon to see, made here before the watch reads it. */
  inboxDir: string;
  /** The binary to spawn; this computer's own out of the daemon asset when none is named. */
  binary?: string;
  /** The file this daemon reads its token from, for a daemon whose token something else rotates: a stand-in
   * provider's machine, whose token the runtime writes through that machine's own exec. The first token is minted
   * here and written there, and every later frame is checked against the file as it is then. Without one the file
   * is this daemon's own and its token lives as long as it does. */
  tokenPath?: string;
  /** Where the binary's own stderr goes, a line at a time. It belongs in a serving host's log, which is what its
   * stderr is; at a terminal the person asked a question of their own and what the daemon says as it starts is not
   * the answer, so the line that started it there keeps none. The ring behind the start's failure sentence is kept
   * either way. Without one the line goes to this process's stderr. */
  say?: (line: string) => void;
}

/** Which daemon the binary that just listened is, off the hello it sends after the auth frame: one socket, opened
 * with the token this start minted and closed again. The hello is the only word a binary of any age says about its
 * own version, which is why it is read rather than a flag or a verb a stale binary would not have. A binary that
 * listens and answers no hello inside the start bound is no daemon this host can use, and the caller stops it. */
async function helloVersion(url: string, token: string, said: () => string): Promise<number> {
  let link: DaemonReach | undefined;
  try {
    return await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the daemon at ${url} did not answer its version within ${START_MS} ms: ${said()}`)), START_MS);
      link = connectDaemon({
        previewUrl: url,
        token,
        onEvent: e => {
          if (e.type !== "daemon.hello") return;
          clearTimeout(timer);
          done(daemonVersionOf(e));
        },
      });
      link.ready.catch((e: unknown) => {
        clearTimeout(timer);
        fail(e instanceof Error ? e : new Error(String(e)));
      });
    });
  } finally {
    link?.close();
  }
}

/** One watch on this computer's readings, shared by every pane that asks: the link, its listeners, and the watch
 * request the first one waited on. */
interface SharedSamples {
  link: DaemonReach;
  listeners: Set<(s: SysSample) => void>;
  watching: Promise<unknown>;
}

/** The daemon for this computer's workspace: the binary on loopback with a fresh token, handing out the same link a
 * cloud workspace's daemon is reached by. Close it with close(); the links it handed out close with it. */
export class LocalDaemon {
  private samples: SharedSamples | undefined;

  private constructor(
    private readonly child: ChildProcess,
    private readonly exited: Promise<void>,
    /** The folder holding the token file and the manifest, this daemon's alone, gone with it. */
    private readonly ownDir: string,
    private readonly minted: string,
    readonly port: number,
    /** Which daemon this binary is, off the hello it answered the first frame with. Read at the start because the
     * binary is staged beside the command and a host rebuilt without it runs beside an older one, whose verbs are
     * not this wsp's; every road that runs it reads this first. */
    readonly version: number,
    readonly root: string,
    /** The file the token is read back off where a caller named one; this daemon's own otherwise. */
    private readonly tokenPath?: string,
  ) {}

  /** The token this daemon opens on now: the file's contents where a caller named the file, since whatever named it
   * rotates it and this daemon reads it at every auth frame; the minted one otherwise, which nothing rewrites. */
  private get token(): string {
    if (this.tokenPath === undefined) return this.minted;
    try {
      return readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      return this.minted;
    }
  }

  static async start(opts: LocalDaemonOptions): Promise<LocalDaemon> {
    const bin = opts.binary ?? daemonBinaryHere();
    const token = randomBytes(24).toString("hex");
    // The inbox dir must exist before the watcher reads it; a cloud guest ships one, this computer makes its own.
    ownFolder(opts.inboxDir);
    // The daemon reads its token off a file at every auth frame and takes none on its command line, so the file is
    // made in a folder of this daemon's own, never beside the host's files under the person's home. The manifest
    // of what a person started sits beside it: every file the daemon reads or writes is named, and nothing is left
    // to a default under /root this computer has not got.
    sweepDeadOwnDirs(tmpdir());
    const ownDir = mkdtempSync(join(tmpdir(), `${OWN_DIR_PREFIX}${process.pid}-`));
    const tokenPath = opts.tokenPath ?? join(ownDir, "token");
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    // The roots file and the inbox are named by the caller and never defaulted from the root: the root is the
    // person's home, which is one folder however many hosts run on this computer, while these two are each host's
    // own. The binary's own defaults name the guest's, /root, which on a Linux computer is another user's folder
    // and answers EACCES on every op. Loopback only, and port 0: the machine picks, and the listening line says
    // which. The kind is what picks the modules the Live rows and the Processes tab read: this computer answers
    // for itself, with ps, df and the memory road the platform has, where a guest daemon reads the /proc a Mac
    // does not have.
    const argv = ["--kind", "local", "--host", LOOPBACK, "--port", "0", "--token-path", tokenPath, "--root", opts.root, "--roots-path", opts.rootsPath, "--inbox", opts.inboxDir, "--work-folder", opts.workFolder, "--manifest", join(ownDir, "manifest.json")];
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    const said: string[] = [];
    child.stderr!.setEncoding("utf8");
    const say = opts.say ?? ((line: string): void => void process.stderr.write(`${line}\n`));
    // Whole lines to the sink, whatever the pipe hands over: a chunk is however much the binary had written when
    // this process read, and a reader that keeps them is keeping lines and not reads. The ring behind the start's
    // own failure sentence keeps the chunks as they came.
    let rest = "";
    child.stderr!.on("data", (chunk: string) => {
      said.push(chunk);
      if (said.length > 20) said.shift();
      rest += chunk;
      let nl: number;
      while ((nl = rest.indexOf("\n")) !== -1) {
        say(rest.slice(0, nl));
        rest = rest.slice(nl + 1);
      }
    });
    child.stderr!.once("end", () => {
      if (rest !== "") say(rest);
      rest = "";
    });
    let gone = false;
    const exited = new Promise<void>(done => child.once("exit", () => ((gone = true), done())));
    const stop = async (): Promise<void> => {
      if (gone) return;
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
      await exited;
      clearTimeout(hard);
    };
    try {
      const port = await new Promise<number>((done, fail) => {
        let out = "";
        const timer = setTimeout(() => fail(new Error(`${bin} did not print its listening line within ${START_MS} ms: ${said.join("").trim()}`)), START_MS);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          out += chunk;
          const m = LISTENING.exec(out);
          if (m === null) return;
          clearTimeout(timer);
          done(Number(m[1]));
        });
        child.once("exit", code => {
          clearTimeout(timer);
          fail(new Error(`${bin} exited with ${code} before it listened: ${said.join("").trim()}`));
        });
        child.once("error", e => {
          clearTimeout(timer);
          fail(e);
        });
      });
      const version = await helloVersion(`http://${LOOPBACK}:${port}`, token, () => said.join("").trim());
      return new LocalDaemon(child, exited, ownDir, token, port, version, opts.root, opts.tokenPath);
    } catch (e) {
      await stop();
      rmSync(ownDir, { recursive: true, force: true });
      throw e;
    }
  }

  /** The daemon's own process id, for whoever reads its memory. */
  get pid(): number {
    return this.child.pid!;
  }

  /** How anything on this computer dials this daemon: the loopback route and the token that opens it, in the shape a
   * cloud workspace's preview route arrives in, so the browser's link and the status probe read one view. The route
   * is http, which the probe fetches (the socket answers 426 to a plain GET) and every link turns into ws. */
  get road(): DaemonReachView {
    return { url: `http://${LOOPBACK}:${this.port}`, expiresAt: NEVER, daemonToken: this.token };
  }

  /** A link to this daemon, the same one a cloud workspace's daemon is reached by. The caller owns it and closes it;
   * closing the daemon cuts every link it handed out. */
  link(onEvent: (e: DaemonEvent) => void = () => {}): DaemonReach {
    return connectDaemon({ previewUrl: this.road.url, token: this.token, onEvent });
  }

  /** This computer's cpu, memory and disk, pushed to the listener on every sample until the returned detach runs.
   * One watch on one link however many panes listen; it opens with the first and closes with the last, so the
   * daemon's sampler runs only while somebody is reading it. */
  async sysSamples(fn: (s: SysSample) => void): Promise<() => void> {
    if (this.samples === undefined) {
      const listeners = new Set<(s: SysSample) => void>();
      const link = this.link(e => {
        if (e.type !== "sys.sample") return;
        for (const listener of listeners) listener(e);
      });
      const shared: SharedSamples = { link, listeners, watching: link.ready.then(() => link.request("sys.watch")) };
      // A watch that never opened is not kept: the next listener dials again rather than inheriting the refusal.
      shared.watching.catch(() => {
        if (this.samples === shared) this.samples = undefined;
        link.close();
      });
      this.samples = shared;
    }
    const shared = this.samples;
    shared.listeners.add(fn);
    await shared.watching;
    return () => {
      shared.listeners.delete(fn);
      if (shared.listeners.size !== 0 || this.samples !== shared) return;
      this.samples = undefined;
      shared.link.close();
    };
  }

  async close(): Promise<void> {
    this.samples?.link.close();
    this.samples = undefined;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      const hard = setTimeout(() => this.child.kill("SIGKILL"), STOP_MS);
      await this.exited;
      clearTimeout(hard);
    }
    rmSync(this.ownDir, { recursive: true, force: true });
  }
}
