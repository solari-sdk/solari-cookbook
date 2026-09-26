// SPDX-License-Identifier: AGPL-3.0-only
// A provider that answers out of memory: every call lands here and nothing
// leaves the computer. It exists so a harness can serve a fixture state whose
// workspaces are forks, which no other module can do without a key and a
// network: a host with no provider refuses get() and every cloud record in the
// file fails to load. It sits behind the same MachineBackend seam the Solari
// module does, so nothing above the registry learns which one it holds.
//
// get() answers for an id it never minted, which is the one thing a fixture
// needs: a state file naming fk_c0ffee gets a running machine rather than a
// refusal. What state that machine comes up in is the records file's to say,
// and a harness seeds it before the host reads the state file; a machine no
// records name is running, since a stand-in nobody seeded holds nothing asleep.
//
// Two things a caller may wire. A file it keeps its machines and its snapshots
// in, so a second process on the same state file reads the fleet the first one
// holds rather than an empty one, and so a harness can seed the state each
// machine comes up in and the snapshots a fixture's image says the account is
// paying for. And a guest: a folder on the caller's own computer
// standing in for each machine's disk, with a daemon rooted there, which is
// what gives a fixture's fork a terminal, a process list and live readings.
// Without a guest the machine lands no bytes, the daemon deploy never starts
// and every road that needs one refuses by capability the way it does on a
// provider that has none, and a road that runs a command anyway is refused with
// a sentence naming this stand-in. Exit 0 with nothing was worse than a
// refusal: a tester driving a fixture met "remote launch failed: exit 0: " and
// read the empty guest as the product losing their thread.

import type { Capabilities, MachineFacts, PreviewReach } from "@wsp/protocol";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runChild } from "./child-exec.js";
import type {
  BackendPricing,
  ExecResult,
  Lifecycle,
  Machine,
  MachineBackend,
  MachineShape,
  MachineSpec,
  MachineState,
  RunOptions,
  SnapshotRow,
  SnapshotStoragePricing,
} from "./machine.js";

/** The sizes this provider offers, small enough that no fixture reads as a machine nobody would buy. */
const SIZES = [
  { cpu: 2, memMb: 4096 },
  { cpu: 4, memMb: 8192 },
  { cpu: 8, memMb: 16_384 },
] as const;

/** A made-up price with the shape of a real one: it rises with the size, so a row that shows a rate shows a number
 * that moves when the size does. */
const rateUsdPerHour = (size: { cpu: number; memMb: number }): number => Number((size.cpu * 0.02 + (size.memMb / 1024) * 0.01).toFixed(4));

const SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 10, usdPerGbMonth: 0.15, billedFrom: "2026-01-01" };

const PRICING: BackendPricing = {
  rateUsdPerHour,
  defaultSize: { cpu: 4, memMb: 8192 },
  snapshotStorage: SNAPSHOT_STORAGE,
  builderDiskGb: 20,
};

/** Instant everywhere: a wake that never has to ask twice and a daemon that is never waited for. */
const LIFECYCLE: Lifecycle = { budgets: { wakeAttempts: 1, daemonAnswersMs: 1_000 } };

/** What a road that reaches for the guest is told. Plain words a person who has never read this code can act on:
 * every cloud persona in a lab round met the older sentence ("answers out of memory and holds no guest") and read
 * it as the product's own word salad rather than as a harness saying the machine is not real. It names what this
 * stand-in is, what it will not do, and that the screen around it is still worth reading. */
export const FAKE_NO_GUEST = "this is a stand-in provider for testing: its machines are records in memory, so nothing runs on them and nothing can be opened inside them";

const id = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

/** A folder on the caller's own computer standing in for a machine's disk, and the road to a port on it. The
 * caller wires this because the daemon that serves those ports is not the engine's to start: nothing here knows
 * how to run one, and a stand-in that started one would be a provider with a guest on the person's computer
 * whether or not anybody asked. */
export interface FakeGuest {
  /** Where this machine's commands run and its daemon is rooted. */
  folder(machineId: string): string;
  /** The file this machine's daemon reads its token from, which the runtime's rotation writes through exec. */
  tokenPath(machineId: string): string;
  /** The route to one port on this machine, with whatever serves it running by the time this answers. */
  reach(machineId: string, port: number): Promise<PreviewReach>;
  /** Optional: how a command written for a Linux guest runs on the computer holding this folder, after the guest
   * has answered for the folders and the commands that guest has and this computer does not. Without one the line
   * runs as it was written, in the machine's own folder, which is what printed "sethostname: Operation not
   * permitted" at every tester who forked a machine and "ls: /root" at every one who paused it. */
  shell?(machineId: string, cmd: string): { cmd: string; cwd: string; env: Record<string, string> };
  /** Optional: one file's bytes at a path of the guest's. A guest with one makes this a machine bytes can land on,
   * which is what writes a fork's own context onto it instead of the line saying no signed URL was minted. */
  putBytes?(machineId: string, path: string, bytes: Uint8Array): Promise<void>;
}

/** What this stand-in holds: every machine it has been asked for, and every snapshot the account carries. A
 * harness seeds the snapshots its fixture's image names, so a screen that prices what is stored is not reading
 * zero beside a list of two versions. */
interface Held {
  machines: Record<string, { state: MachineState; shape: MachineShape; labels: Record<string, string> }>;
  snapshots: SnapshotRow[];
}

const EMPTY: Held = { machines: {}, snapshots: [] };

/** Where this stand-in's records live: a file both processes read, or this process alone. Read at every call and
 * written at every change, since two hosts on one state file are two processes, and a machine one of them made is
 * one the other has to find. */
interface Records {
  read(): Held;
  write(held: Held): void;
}

const inMemory = (): Records => {
  let held: Held = EMPTY;
  return { read: () => held, write: next => (held = next) };
};

/** What a reader is told when the file is there and is not records. It is never taken for an empty fleet: a reader
 * that answered empty wrote that emptiness back at its next change, so a tester's seeded snapshots and a fork they
 * had paused went at the next verb they typed. */
export const standInRecordsUnreadable = (path: string, why: string): string => `${path} is not this stand-in provider's records: ${why}`;

const inFile = (path: string): Records => ({
  read: () => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // Nothing written yet: a folder a caller named and nobody seeded is an empty fleet, which is not the same
      // as a file that is there and cannot be read.
      return EMPTY;
    }
    try {
      return { ...EMPTY, ...(JSON.parse(text) as Partial<Held>) };
    } catch (e) {
      throw new Error(standInRecordsUnreadable(path, e instanceof Error ? e.message : String(e)));
    }
  },
  // Written beside and renamed over, the shape the daemon's own token rotation uses: a rename is one step, so a
  // reader in another process sees the records before the change or after it and never half of them.
  write: held => {
    mkdirSync(dirname(path), { recursive: true });
    const next = `${path}.next`;
    writeFileSync(next, `${JSON.stringify(held, null, 2)}\n`);
    renameSync(next, path);
  },
});

/** One machine this provider holds: its state, its shape and its labels live in the records, so a second process
 * reading the same file finds the same machine in the same state. */
class FakeMachine implements Machine {
  readonly kind = "sandbox" as const;
  readonly streamUrl = undefined;
  readonly previewUrl?: (port: number) => Promise<PreviewReach>;
  readonly daemonTokenPath?: string;
  readonly putBytes?: (path: string, bytes: Uint8Array) => Promise<void>;

  constructor(
    readonly id: string,
    readonly labels: Record<string, string>,
    private readonly shape: MachineShape,
    private readonly records: Records,
    private readonly seenState: MachineState,
    private readonly guest?: FakeGuest,
  ) {
    if (guest !== undefined) {
      this.previewUrl = port => guest.reach(id, port);
      this.daemonTokenPath = guest.tokenPath(id);
      if (guest.putBytes !== undefined) this.putBytes = (path, bytes) => guest.putBytes!(id, path, bytes);
    }
  }

  get seen(): { state: MachineState; createdAt?: string } {
    return { state: this.seenState, ...(this.shape.createdAt !== undefined ? { createdAt: this.shape.createdAt } : {}) };
  }

  /** One command where a guest is wired, on the caller's own computer in this machine's folder; a refusal that
   * names this stand-in where none is. */
  private shell(cmd: string, opts: { timeoutMs?: number; onLine?: (line: string) => void }): Promise<ExecResult> {
    if (this.guest === undefined) throw new Error(FAKE_NO_GUEST);
    const at = this.guest.folder(this.id);
    // The guest's own answer where it has one, so a line written for a Linux machine runs against that machine's
    // stand-in folder rather than against the root of the computer holding it. Without one the folder is the home
    // and the line runs as it was written.
    const run = this.guest.shell?.(this.id, cmd) ?? { cmd, cwd: at, env: { HOME: at } };
    mkdirSync(run.cwd, { recursive: true });
    return runChild("bash", ["-c", run.cmd], { cwd: run.cwd, env: { ...process.env, ...run.env }, ...opts });
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.shell(cmd, { ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  }

  async run(script: string, opts: RunOptions): Promise<ExecResult> {
    return this.shell(script, { timeoutMs: opts.deadlineMs, ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}) });
  }

  async snapshot(name: string): Promise<string> {
    const row = { id: id("fksnap"), name, sizeBytes: 8 * 1024 ** 3, createdAt: new Date().toISOString() };
    const held = this.records.read();
    this.records.write({ ...held, snapshots: [...held.snapshots, row] });
    return row.id;
  }

  private move(to: MachineState): void {
    const held = this.records.read();
    const machine = held.machines[this.id];
    if (machine === undefined) return;
    this.records.write({ ...held, machines: { ...held.machines, [this.id]: { ...machine, state: to } } });
  }

  async pause(): Promise<void> {
    this.move("paused");
  }

  async resume(): Promise<void> {
    this.move("running");
  }

  async kill(): Promise<void> {
    this.move("gone");
  }

  async state(): Promise<MachineState> {
    return this.records.read().machines[this.id]?.state ?? this.seenState;
  }

  async downloadUrl(): Promise<string> {
    throw new Error("this provider mints no signed download URL");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("this provider mints no signed upload URL");
  }

  async describe(): Promise<MachineShape> {
    return this.shape;
  }

  async facts(): Promise<MachineFacts> {
    return { os: "Debian GNU/Linux 12", uptimeMs: 3 * 3_600_000, folder: "/root" };
  }
}

export interface FakeBackendOptions {
  /** The shape every machine takes when a create names none; the pricing's default size otherwise. */
  size?: { cpu: number; memMb: number };
  /** A file this stand-in keeps its machines and snapshots in; this process alone when none is named. */
  records?: string;
  /** A guest for its machines; none, and every road that needs one refuses by the sentence above. */
  guest?: FakeGuest;
}

export class FakeBackend implements MachineBackend {
  readonly capabilities: Capabilities;

  readonly pricing = PRICING;
  readonly lifecycle = LIFECYCLE;

  private readonly records: Records;
  private readonly guest: FakeGuest | undefined;
  private readonly size: { cpu: number; memMb: number };

  constructor(opts: FakeBackendOptions = {}) {
    this.size = opts.size ?? PRICING.defaultSize;
    this.records = opts.records === undefined ? inMemory() : inFile(opts.records);
    this.guest = opts.guest;
    this.capabilities = {
      liveCloneForks: true,
      pauseMode: "memory",
      replacesMachine: true,
      // A machine is reachable at a port only where a guest was wired, which is what puts a terminal, a process
      // list and live readings on a fixture's fork instead of six ways of saying unreachable.
      previewUrls: this.guest !== undefined,
      // No signed URL either way: the daemon a guest carries is the caller's to start, so nothing here tries to
      // put one on a machine by landing bytes on it.
      signedUrls: false,
      callbackRelay: false,
      diskSnapshots: true,
      images: true,
      // The stand-in copies whatever it is asked for: nothing here refuses a machine for having been woken.
      snapshotsAnyLife: true,
      snapshotListing: true,
      templates: false,
      sizes: SIZES.map(size => ({ ...size, rateUsdPerHour: rateUsdPerHour(size) })),
      kept: false,
      copies: true,
      ownNetwork: true,
    };
  }

  private mint(machineId: string, spec: Partial<MachineSpec> = {}): FakeMachine {
    const held = this.records.read();
    const known = held.machines[machineId];
    const machine = known ?? {
      // Running, because the records are where a fixture says one sleeps: an id read for the word was a second
      // place the same fact lived, and it printed in the MACHINE column of the table the fixture's own STATE
      // column sat beside.
      state: "running" as MachineState,
      shape: { cpu: spec.cpu ?? this.size.cpu, memMb: spec.memMb ?? this.size.memMb, diskGb: spec.diskGb ?? 20, createdAt: new Date().toISOString() },
      labels: spec.labels ?? {},
    };
    if (known === undefined) this.records.write({ ...held, machines: { ...held.machines, [machineId]: machine } });
    return new FakeMachine(machineId, machine.labels, machine.shape, this.records, machine.state, this.guest);
  }

  async create(spec: MachineSpec): Promise<Machine> {
    return this.mint(id("fk"), spec);
  }

  /** A machine this backend never minted is minted here in the state its id says: a fixture state names its
   * machines before any process has held them, and a refusal would be every one of its workspaces failing to load. */
  async get(machineId: string): Promise<Machine> {
    return this.mint(machineId);
  }

  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return Object.entries(this.records.read().machines).map(([machineId, m]) => ({ id: machineId, state: m.state, labels: m.labels }));
  }

  async listSnapshots(): Promise<SnapshotRow[]> {
    return [...this.records.read().snapshots];
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const held = this.records.read();
    this.records.write({ ...held, snapshots: held.snapshots.filter(r => r.id !== snapshotId) });
  }
}
