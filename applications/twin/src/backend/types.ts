/**
 * The narrow slice of a cloud machine that replay and bisect need. Solari implements it for real;
 * FakeBackend implements it in memory for tests and the offline demo.
 */

export interface RunSpec {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Enforced by the backend: the command is killed when it runs longer. */
  timeoutMs: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunOutcome {
  /** Null when the command was killed for exceeding its timeout. */
  exitCode: number | null;
  timedOut: boolean;
  /** Interleaved stdout and stderr, bounded to the most recent output. */
  output: string;
  durationMs: number;
}

export interface Machine {
  readonly id: string;
  run(spec: RunSpec): Promise<RunOutcome>;
  writeFile(path: string, content: string): Promise<void>;
  /** Releases the machine. Idempotent. */
  kill(): Promise<void>;
  /** Drops the local connection but leaves the machine running (kept machines). */
  detach(): Promise<void>;
  /** Opens an interactive terminal running `command` (a script path in the guest). */
  openTerminal(options: { cols: number; rows: number; command: string }): Promise<Terminal>;
  /** Public URL for an in-guest port. It carries its own access token: treat it as a secret. */
  previewUrl(port: number): Promise<string>;
}

/** A pseudo-terminal in the guest. */
export interface Terminal {
  write(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  onData(listener: (data: Uint8Array) => void): void;
  close(): Promise<void>;
}

export interface MachineInfo {
  id: string;
  state: string;
  labels: Record<string, string>;
}

export interface CreateMachineOptions {
  /** Attached as provider metadata so leftovers can be found and reaped. */
  labels: Record<string, string>;
  /** Rolling idle window after which the provider releases the machine on its own. */
  idleTimeoutMs: number;
}

export interface Backend {
  readonly name: string;
  create(options: CreateMachineOptions): Promise<Machine>;
  /** Kills every live machine carrying all of `labels`. Returns the killed ids. */
  reap(labels: Record<string, string>): Promise<string[]>;
  /** Live machines carrying all of `labels`, confirmed with the provider (not just listed). */
  list(labels: Record<string, string>): Promise<MachineInfo[]>;
  /** Re-attaches to a running machine by id. */
  connect(id: string): Promise<Machine>;
}

/** Labels every twin machine carries. */
export const TWIN_LABELS = { app: 'twin' } as const;
