// The seam every backend sits behind. The data a backend takes and answers is
// the protocol's, since the same shapes travel a link when one computer drives
// another's machines and two copies would drift the day a field is added on
// one side; what stays here is the interfaces with methods, which no wire
// carries.
import type {
  Capabilities,
  DaemonSupervisor,
  ExecResult,
  LifecycleBudgets,
  MachineFacts,
  MachineKind,
  MachineLife,
  MachineListRow,
  MachineShape,
  MachineSpec,
  MachineState,
  PlaceCapacity,
  PreviewReach,
  SnapshotRow,
  SnapshotStoragePricing,
  TemplateRow,
} from "@wsp/protocol";

export type {
  DaemonSupervisor,
  ExecResult,
  LifecycleBudgets,
  MachineKind,
  MachineLife,
  MachineListRow,
  MachineShape,
  MachineSpec,
  MachineState,
  PreviewReach,
  SnapshotRow,
  SnapshotStoragePricing,
  TemplateRow,
};

export interface RunOptions {
  /** Past it the command's session is killed, pid and group, and the result is exit 124 with the output so far. */
  deadlineMs: number;
  /** Each complete line the command writes, stdout and stderr alike, as it is read. */
  onLine?: (line: string) => void;
  /** Between reads of the command's output; the backend's own pace unless a test shortens it. */
  pollMs?: number;
  /** What this command prints is a file of the person's own, secrets and all: whoever watches the run records that
   * it ran and what it exited with, never what it printed. The caller reads the output itself; the backend does
   * nothing differently for it. */
  unlogged?: boolean;
}



/** How far a snapshot has got: the layer's bytes written so far, and what the machine had written since it booted
 * once the backend has counted it. */
export interface SnapshotProgress {
  bytes: number;
  total?: number;
}

export interface SnapshotOptions {
  onProgress?: (progress: SnapshotProgress) => void;
}

/** What a road that cuts the bytes up to get them onto a machine says about the trip: the pieces it sent, each
 * one call of its own. A road that lands them in one call says nothing. */
export interface BytesLanded {
  pieces: number;
}

export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly streamUrl?: string;
  /** The labels the provider reported when this handle was made; absent on backends that carry none. */
  readonly labels?: Record<string, string>;
  /** The provider's view when get() made this handle, so a caller needs no second read; absent on a handle from
   * create(). Its createdAt moves on a running machine nobody touched (+306 s at ten minutes, canary 2026-09-04 UTC)
   * with no lifecycle event behind it, so nothing decides on it; state is the field worth reading. */
  readonly seen?: { state: MachineState; createdAt?: string };
  /** On a handle from create(): the provider answered from an earlier create under the same key instead of booting. */
  readonly replayed?: boolean;
  /** On a handle from create(): one sentence about the machine the computer actually made, where it would not make
   * the one asked for. A computer somebody keeps holds a fork's size down to what leaves the computer itself room,
   * and this is where it says so. Printed once beside the create's own line and read for nothing else. */
  readonly notice?: string;
  /** One short command; a backend's exec has a hard ceiling, so anything that can run longer goes through run().
   * `idempotencyKey` is the caller saying this command lands the same whether it runs once or twice, which is what
   * lets the road under it send the command again after the road itself broke; a backend that runs commands in
   * process has no such gap and ignores it. `stdin` is bytes for the command's own input, honoured by the computer
   * you own, whose frame carries them; every other backend has a byte road of its own and ignores them. */
  exec(cmd: string, opts?: { timeoutMs?: number; idempotencyKey?: string; stdin?: Uint8Array }): Promise<ExecResult>; // always REST path
  /** A command that may run for minutes: started detached on the guest and read until it exits or the deadline
   * kills it; the result is shaped like exec's. */
  run(script: string, opts: RunOptions): Promise<ExecResult>;
  /** Answers when the provider holds the snapshot. A backend that refuses one of a resumed machine throws
   * NotFirstLifeError before any call; one whose snapshot copies the disk from any life ignores `life`. A backend
   * that writes the snapshot as a job tells `onProgress` how far it has got; the rest say nothing until done. */
  snapshot(name: string, life: MachineLife, opts?: SnapshotOptions): Promise<string>;
  pause(): Promise<void>;
  /** `signal` ends the call where the caller has stopped waiting on it, so a resume nobody is waiting on is not left
   * running behind them; the backend's own cap on how long it waits for an answer is its business, not the caller's. */
  resume(signal?: AbortSignal): Promise<void>;
  kill(): Promise<void>;
  state(): Promise<MachineState>;
  downloadUrl(path: string): Promise<string>;
  uploadUrl(path: string): Promise<string>;
  /** Optional: the backends that have a route to a guest port at all. */
  previewUrl?(port: number): Promise<PreviewReach>;
  /** Optional: where this machine keeps its daemon's token, when it is not the guest path a fork boots with. A
   * stand-in machine whose guest is a folder on the computer asking names the file inside it, since nothing there
   * can write the guest's own. Absent leaves the path the road takes for that kind of machine. */
  readonly daemonTokenPath?: string;
  /** Optional: whether the daemon inside the guest is listening, asked over the road this machine's own calls take
   * rather than by dialling a route from here. Present where a route this computer dials is not the truth about
   * the guest: a container's published port lands on the loopback of the box that runs it, which is not always the
   * one asking, and a host that is not that computer reads silence off a live daemon. Absent leaves the reach to
   * previewUrl, which on a backend with a public edge is the same road a client takes. The caller's bound is the
   * whole call's, as it is on exec and putBytes. */
  daemonAnswers?(opts?: { timeoutMs?: number }): Promise<boolean>;
  /** Optional: bytes onto the machine on a backend that mints no signed upload URL. `landBytes` is what reads it,
   * so no caller picks between the two roads itself. */
  putBytes?(path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<BytesLanded | void>;
  /** Optional: what keeps a process running on this machine, read by the daemon deploy. Absent means the guest has
   * a service manager and the deploy registers a unit with it. */
  readonly daemonSupervisor?: DaemonSupervisor;
  /** Optional: one frame of the daemon protocol answered for this machine by the daemon that serves it, where that
   * daemon is the computer's own rather than one inside the machine. A workspace on a computer somebody owns runs
   * no daemon of its own: it is that computer's directories, and its files and its git are answered by the daemon
   * holding it, so the frame travels the road this backend already holds with the machine named on it. A refusal
   * comes back as the reply object it was, `ok: false` with its code, so a caller reads the reason rather than the
   * sentence. Absent on every machine whose daemon is dialled inside it. */
  daemonFrame?(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Optional: backends that expose size and creation time per machine. */
  describe?(): Promise<MachineShape>;
  /** Optional: a machine that already existed before wsp says what it is; the status poll carries the answer. */
  facts?(): Promise<MachineFacts>;
  /** Optional: backends whose host reports live usage per machine. Answers when the host still knows the VM; a
   * missing answer while state() still says running is the host having lost it, ahead of the gateway's own record.
   * The numbers themselves are read nowhere yet, so none are typed. */
  metrics?(): Promise<void>;
}


/** What a size costs on this provider, and the shape a spec gets when it
 * names none. Local arithmetic until provider billing APIs are integrated. */
export interface BackendPricing {
  rateUsdPerHour(size: { cpu: number; memMb: number }): number;
  defaultSize: { cpu: number; memMb: number };
  snapshotStorage: SnapshotStoragePricing;
  /** The root disk every builder and fork asks for on this provider, in GiB; absent where a machine takes no disk
   * request at all (a container's disk is the box's, and a quota on one needs a filesystem most boxes do not run). */
  builderDiskGb?: number;
}


/** What the runtime reads to drive a machine through naps and wakes on this provider. Present exactly when the
 * capabilities carry a pauseMode; a registry test holds the two together. */
export interface Lifecycle {
  budgets: LifecycleBudgets;
  /** Optional: the instant by which the provider may stop this running machine if this host is gone, computed by
   * the runtime's own backstop policy and handed over whenever the idle window is armed, for a provider whose
   * backstop is pushed rather than set once at create. Never called for a machine the runtime has napped or
   * forgotten. Called from the policy's own arming and not awaited: a rejection is logged, and the backend decides
   * whether a given instant is worth a call, since the window is armed on every streamed chunk. */
  backstop?(machine: Machine, until: number): Promise<void>;
  /** Optional: how long the machine has been quiet by what the computer running it can see, bytes on its
   * published ports and commands run in it. Read once before an idle stop, so a dev server somebody is clicking
   * through stays up. Undefined where the backend cannot say, which leaves the stop to the host's own clock. */
  quietForMs?(machine: Machine): Promise<number | undefined>;
}

export interface MachineBackend {
  readonly capabilities: Capabilities;
  readonly pricing: BackendPricing;
  /** Present on every backend whose capabilities carry a pauseMode. */
  readonly lifecycle?: Lifecycle;
  /** Optional: what a machine of each kind boots from on this provider when nothing names a template. Absent leaves
   * the built-in names the engine knows. */
  readonly baseTemplates?: Readonly<Record<MachineKind, string>>;
  /** Whether a machine of this backend boots under the workspace's own name, so nothing above names it again: a
   * computer the person owns writes the name into the machine's specification at every boot, where a provider's
   * fork comes up as localhost. It sits beside the capabilities rather than inside them because that object is the
   * daemon's own wire shape, and this is this host's reading of a kind. Absent is a backend that names none. */
  readonly namesWorkspace?: boolean;
  /** Optional: where the computer holding this backend keeps the logins every workspace on it shares, absolute.
   * Only a computer the person owns answers one; a provider holds no file of theirs. */
  readonly logins?: string;
  /** Optional: where that computer keeps the project checkouts it holds and each project's own memory, absolute.
   * Only a computer whose daemon holds a disk of the person's answers one; on a provider a project lives in an
   * image instead, so there is nothing to clone into or to bind. */
  readonly projects?: string;
  /** Optional, and exactly where `projects` is: one command on the computer holding this backend, outside every
   * workspace on it, for the folders wsp itself keeps there. Only a computer the person owns answers one, since a
   * provider has no computer of theirs to run anything on. Nothing of wsp is installed on the computer by it: the
   * commands are its own folders' making and taking. */
  onComputer?(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  create(spec: MachineSpec): Promise<Machine>;
  /** Optional: only backends the person holds a key for. One cheap authenticated read that boots nothing and touches
   * no machine's idle clock, so a key the provider refuses is known before anything is saved or billed. Rejects with
   * the provider's own WspError; `checkProviderKey` is what reads that answer. */
  checkKey?(): Promise<void>;
  get(id: string): Promise<Machine>;
  /** size comes off the listing itself; a per-machine GET would reset that machine's idle timer. */
  list(labels?: Record<string, string>): Promise<MachineListRow[]>;
  deleteSnapshot(id: string): Promise<void>;
  /** Optional: what the computer holding this backend has left for one more machine. Only a backend on a computer
   * the person owns answers; a provider's room is its own cap and its own refusal. */
  capacity?(): Promise<PlaceCapacity>;
  /** Optional: only backends whose capabilities include snapshotListing have it. Every snapshot on the account, with its size. */
  listSnapshots?(): Promise<SnapshotRow[]>;
  /** Optional, the four together: only backends whose capabilities include templates have them. Promotes a snapshot
   * to a durable template under the name and answers the template's id; the snapshot stays and cannot be deleted
   * while the template exists. */
  promoteSnapshot?(snapshotId: string, name: string): Promise<string>;
  getTemplate?(id: string): Promise<TemplateRow>;
  /** Every template the account can boot from, the provider's built-ins included. */
  listTemplates?(): Promise<TemplateRow[]>;
  deleteTemplate?(id: string): Promise<void>;
}
