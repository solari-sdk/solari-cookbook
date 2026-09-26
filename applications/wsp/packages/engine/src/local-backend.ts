// SPDX-License-Identifier: AGPL-3.0-only
// The backend for a local workspace: this computer itself, one machine that
// already exists. It sits behind the same MachineBackend seam the Solari
// backend does, so the runtime never learns which kind it holds. Every
// capability a provider fork has and this computer does not is false, so every
// road that reads a capability already refuses; nothing switches on the kind
// outside the backend registry. exec and run spawn a shell on this computer;
// the moves a provider fork takes (create, fork, pause, snapshot) have no
// meaning on a computer and throw, since the runtime refuses them by capability
// before it ever reaches here.

import { mkdirSync } from "node:fs";
import { cpus, release, totalmem, type, uptime } from "node:os";
import { runChild } from "./child-exec.js";
import { readOsName } from "./machine-facts.js";
import type { BackendPricing, ExecResult, Machine, MachineBackend, MachineShape, MachineState, RunOptions, SnapshotStoragePricing } from "./machine.js";
import type { Capabilities, MachineFacts } from "@wsp/protocol";

/** The fixed id of the one machine a host's local backend holds: this computer. A local workspace records it as its
 * machine id and never forks another. */
export const LOCAL_MACHINE_ID = "local";

const GB = 1024 ** 3;

/** This computer's own size, read once: its logical CPUs and its memory in whole GB, so a row can show what a fork's
 * shows. A kernel reports a little under the memory the chips hold, so the bytes round to the GB the person bought.
 * Nothing bills on it, so the rate is zero and the storage pricing is empty. */
export function localShape(cores: number = cpus().length, totalBytes: number = totalmem()): { cpu: number; memMb: number } {
  return { cpu: cores, memMb: Math.round(totalBytes / GB) * 1024 };
}

const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

export interface LocalBackendOptions {
  /** The folder every exec and run on this computer starts in when the caller names no other; the person's home by
   * default. A command that names its own folder cds into it as it does on a fork. */
  root: string;
  /** The environment every exec and run on this computer runs under: the person's own, so a tool on their PATH is
   * found and their own session stores are read. process.env by default. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** One shell command on this computer: bash -c, cwd the backend's root, the person's own environment. The child
 * itself is read by the shared runner, so a timeout, a signal and a streamed line mean here what they mean on a
 * machine reached over ssh. */
async function runShell(root: string, env: Readonly<Record<string, string | undefined>>, cmd: string, opts: { timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<ExecResult> {
  return runChild("bash", ["-c", cmd], { cwd: root, env, ...opts });
}

/** This computer as a Machine: exec and run spawn a shell on it, state is always running while the host is, and the
 * moves only a provider fork takes throw, since the capability behind each is false and the runtime refuses them
 * first. It carries no preview route (no public port URLs), no signed upload or download URL, and no snapshot. */
export class LocalMachine implements Machine {
  readonly id = LOCAL_MACHINE_ID;
  readonly kind = "sandbox" as const;
  readonly streamUrl = undefined;
  /** Read once: the system does not change its name while the host runs. */
  private os: Promise<string> | undefined;

  constructor(
    private readonly root: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return runShell(this.root, this.env, cmd, { ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return runShell(this.root, this.env, script, { timeoutMs: opts.deadlineMs, ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}) });
  }

  async snapshot(): Promise<string> {
    throw new Error("this computer cannot be snapshotted");
  }

  async pause(): Promise<void> {
    throw new Error("this computer cannot be paused");
  }

  async resume(): Promise<void> {
    throw new Error("this computer cannot be resumed");
  }

  /** Deleting a local workspace drops its record and nothing else: this computer is not a machine to stop. */
  async kill(): Promise<void> {}

  async state(): Promise<MachineState> {
    return "running";
  }

  async describe(): Promise<MachineShape> {
    return { ...localShape() };
  }

  async facts(): Promise<MachineFacts> {
    // A computer that answered nothing still has a name for its row: the kernel this process itself runs on.
    this.os ??= readOsName(cmd => this.exec(cmd, { timeoutMs: 5_000 })).then(name => name ?? `${type()} ${release()}`);
    return { os: await this.os, uptimeMs: Math.round(uptime() * 1_000), folder: this.root };
  }

  async downloadUrl(): Promise<string> {
    throw new Error("this computer serves no signed download URL; its files are read on it directly");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("this computer serves no signed upload URL; its files are written on it directly");
  }
}

/** The backend for the one local workspace a host holds: it answers get and list with this computer, and refuses to
 * create another, since there is only ever one of it. Its capabilities are every provider capability turned off. */
export class LocalBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false,
    replacesMachine: false, // there is one of this computer and nothing forks another
    previewUrls: false,
    signedUrls: false,
    callbackRelay: false,
    diskSnapshots: false,
    images: false, // this computer is itself: nothing is forked here and no image is kept
    snapshotsAnyLife: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    // This computer is the person's own: nothing here was made by wsp and nothing here is thrown away, so a turn's
    // access starts at what its harness asks for rather than at skip-everything.
    kept: true,
    // A workspace here is a copy of the project folder at a path of its own, made by the daemon binary's copy verb.
    copies: true,
    // Nothing here gives a copy a network: every copy binds the ports of this one computer, which is why each gets
    // a port base of its own and the row says the ports are shared.
    ownNetwork: false,
  };

  readonly pricing: BackendPricing = {
    rateUsdPerHour: () => 0,
    defaultSize: localShape(),
    snapshotStorage: NO_SNAPSHOT_STORAGE,
  };

  private readonly machine: LocalMachine;

  /** The folder every command on this computer starts in when the caller names none, published so the roads that
   * launch one through the runtime read the same folder this backend's own machine runs in. */
  readonly folder: string;

  constructor(opts: LocalBackendOptions) {
    this.folder = opts.root;
    this.machine = new LocalMachine(opts.root, opts.env ?? process.env);
  }

  async create(): Promise<Machine> {
    throw new Error("this computer already exists; a local workspace is not created, it is the machine wsp already runs on");
  }

  /** The folder a command on this computer starts in, made on the first ask and not at construction: a host builds
   * this backend to answer whether it has anything to serve, and a computer that has never been set up must be left
   * as it was. The one place the folder is made, so a turn launched off the wiring alone and one launched through a
   * loaded workspace record land in the same made folder. */
  workFolder(): string {
    mkdirSync(this.folder, { recursive: true });
    return this.folder;
  }

  /** Taking this computer as a machine is what a recorded local workspace does, and its commands start in the
   * folder, so the folder is made here. */
  async get(): Promise<Machine> {
    this.workFolder();
    return this.machine;
  }

  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [{ id: LOCAL_MACHINE_ID, state: "running", labels: {} }];
  }

  async deleteSnapshot(): Promise<void> {
    throw new Error("this computer holds no snapshots");
  }
}
