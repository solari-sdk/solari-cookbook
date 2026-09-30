import type {
  Backend,
  CreateMachineOptions,
  Machine,
  MachineInfo,
  RunOutcome,
  RunSpec,
  Terminal,
} from './types.ts';

/** A scripted terminal: records input and lets tests push output. */
export class FakeTerminal implements Terminal {
  readonly command: string;
  readonly written: string[] = [];
  readonly sizes: [number, number][] = [];
  closed = false;
  readonly #listeners: ((data: Uint8Array) => void)[] = [];

  constructor(command: string, cols: number, rows: number) {
    this.command = command;
    this.sizes.push([cols, rows]);
  }

  async write(data: string | Uint8Array): Promise<void> {
    this.written.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.sizes.push([cols, rows]);
  }

  onData(listener: (data: Uint8Array) => void): void {
    this.#listeners.push(listener);
  }

  /** Simulates guest output. */
  emit(text: string): void {
    for (const listener of this.#listeners) listener(Buffer.from(text, 'utf8'));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeRunResult {
  exitCode: number | null;
  output?: string;
  timedOut?: boolean;
  durationMs?: number;
}

/** Decides what a command "does" on a fake machine. Unmatched commands succeed silently. */
export type FakeResponder = (spec: RunSpec, machine: FakeMachine) => FakeRunResult | undefined;

export class FakeMachine implements Machine {
  readonly id: string;
  readonly options: CreateMachineOptions;
  readonly runs: RunSpec[] = [];
  readonly files = new Map<string, string>();
  readonly terminals: FakeTerminal[] = [];
  /** Called with each new terminal so tests can drive it. */
  onTerminal?: (terminal: FakeTerminal) => void;
  killed = false;
  detached = false;
  readonly #respond: FakeResponder;

  constructor(id: string, options: CreateMachineOptions, respond: FakeResponder) {
    this.id = id;
    this.options = options;
    this.#respond = respond;
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    if (this.killed) throw new Error(`machine ${this.id} was killed`);
    this.runs.push(spec);
    const result = this.#respond(spec, this) ?? { exitCode: 0 };
    const output = result.output ?? '';
    if (output) spec.onOutput?.(output, 'stdout');
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut ?? false,
      output,
      durationMs: result.durationMs ?? 1,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  async detach(): Promise<void> {
    this.detached = true;
  }

  async openTerminal(options: { cols: number; rows: number; command: string }): Promise<Terminal> {
    const terminal = new FakeTerminal(options.command, options.cols, options.rows);
    this.terminals.push(terminal);
    // A macrotask, so the caller can register its listeners before the scripted output arrives.
    setTimeout(() => this.onTerminal?.(terminal), 0);
    return terminal;
  }

  async previewUrl(port: number): Promise<string> {
    return `https://${this.id}-${port}.preview.test/?pt_token=secret`;
  }
}

/** In-memory backend for tests and the offline demo. Records everything it is asked to do. */
export class FakeBackend implements Backend {
  readonly name = 'fake';
  readonly machines: FakeMachine[] = [];
  readonly #respond: FakeResponder;

  constructor(respond: FakeResponder = () => undefined) {
    this.#respond = respond;
  }

  async create(options: CreateMachineOptions): Promise<Machine> {
    const machine = new FakeMachine(`sbx_fake${this.machines.length}`, options, this.#respond);
    this.machines.push(machine);
    return machine;
  }

  async reap(labels: Record<string, string>): Promise<string[]> {
    const matches = this.machines.filter(
      (machine) =>
        !machine.killed &&
        Object.entries(labels).every(([key, value]) => machine.options.labels[key] === value),
    );
    for (const machine of matches) await machine.kill();
    return matches.map((machine) => machine.id);
  }

  async list(labels: Record<string, string>): Promise<MachineInfo[]> {
    return this.machines
      .filter(
        (machine) =>
          !machine.killed &&
          Object.entries(labels).every(([key, value]) => machine.options.labels[key] === value),
      )
      .map((machine) => ({ id: machine.id, state: 'running', labels: machine.options.labels }));
  }

  async connect(id: string): Promise<Machine> {
    const machine = this.machines.find((candidate) => candidate.id === id && !candidate.killed);
    if (!machine) throw new Error(`no running machine ${id}`);
    return machine;
  }
}
