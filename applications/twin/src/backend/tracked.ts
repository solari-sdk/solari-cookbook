import { TwinError } from '../errors.ts';
import type {
  Backend,
  CreateMachineOptions,
  Machine,
  MachineInfo,
  RunOutcome,
  RunSpec,
  Terminal,
} from './types.ts';

/** Called when the first machine starts creating and when the last one is released or let go. */
export interface LiveHooks {
  onLive(): void;
  onIdle(): void;
}

const interrupted = () => new TwinError('interrupted', { exitCode: 130 });

/**
 * A backend that knows which machines this process created (or is creating) and has not released
 * yet, so an interrupted command can release them instead of leaving them billing. A machine stops
 * being tracked once it is killed, or detached on purpose (a kept machine the user asked for).
 */
export class TrackedBackend implements Backend {
  readonly #inner: Backend;
  readonly #hooks: LiveHooks;
  readonly #live = new Set<Machine>();
  /** Creations in flight: an interrupt then must wait for the machine to exist to release it. */
  readonly #creating = new Set<Promise<Machine>>();
  #releasing = false;

  constructor(inner: Backend, hooks: LiveHooks) {
    this.#inner = inner;
    this.#hooks = hooks;
  }

  get name(): string {
    return this.#inner.name;
  }

  /** Ids of machines created here and still running. */
  get live(): string[] {
    return [...this.#live].map((machine) => machine.id);
  }

  get #busy(): number {
    return this.#live.size + this.#creating.size;
  }

  async create(options: CreateMachineOptions): Promise<Machine> {
    if (this.#releasing) throw interrupted();
    const pending = this.#inner.create(options);
    this.#creating.add(pending);
    // Live from the moment creation starts: an interrupt during it must not orphan the machine.
    if (this.#busy === 1) this.#hooks.onLive();
    let machine: Machine;
    try {
      machine = await pending;
    } catch (error) {
      this.#creating.delete(pending);
      if (this.#busy === 0) this.#hooks.onIdle();
      throw error;
    }
    this.#creating.delete(pending);
    const tracked = new TrackedMachine(
      machine,
      () => this.#forget(tracked),
      () => this.#releasing,
    );
    this.#live.add(tracked);
    // An interrupt arrived while the machine was being created; releaseAll kills it.
    if (this.#releasing) throw interrupted();
    return tracked;
  }

  /** Kills every live machine once pending creations settle; the inner backend confirms each kill. */
  async releaseAll(): Promise<{ released: string[]; failed: string[] }> {
    this.#releasing = true;
    // create() registered on these first, so settled creations are already in #live.
    if (this.#creating.size > 0) await Promise.allSettled([...this.#creating]);
    const machines = [...this.#live];
    const results = await Promise.allSettled(machines.map((machine) => machine.kill()));
    const released: string[] = [];
    const failed: string[] = [];
    results.forEach((result, index) => {
      const id = (machines[index] as Machine).id;
      (result.status === 'fulfilled' ? released : failed).push(id);
    });
    return { released, failed };
  }

  reap(labels: Record<string, string>): Promise<string[]> {
    return this.#inner.reap(labels);
  }

  list(labels: Record<string, string>): Promise<MachineInfo[]> {
    return this.#inner.list(labels);
  }

  /** Re-attached machines were kept earlier; an interrupt leaves them running. */
  connect(id: string): Promise<Machine> {
    return this.#inner.connect(id);
  }

  #forget(machine: Machine): void {
    if (this.#live.delete(machine) && this.#busy === 0) this.#hooks.onIdle();
  }
}

class TrackedMachine implements Machine {
  readonly #inner: Machine;
  readonly #forget: () => void;
  readonly #releasing: () => boolean;

  constructor(inner: Machine, forget: () => void, releasing: () => boolean) {
    this.#inner = inner;
    this.#forget = forget;
    this.#releasing = releasing;
  }

  get id(): string {
    return this.#inner.id;
  }

  /** A call cut short by an interrupt's release reads as an interrupt, not an unexpected error. */
  async #guard<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (error) {
      if (this.#releasing()) throw interrupted();
      throw error;
    }
  }

  run(spec: RunSpec): Promise<RunOutcome> {
    return this.#guard(this.#inner.run(spec));
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.#guard(this.#inner.writeFile(path, content));
  }

  async kill(): Promise<void> {
    await this.#inner.kill();
    this.#forget();
  }

  async detach(): Promise<void> {
    await this.#inner.detach();
    this.#forget();
  }

  openTerminal(options: { cols: number; rows: number; command: string }): Promise<Terminal> {
    return this.#inner.openTerminal(options);
  }

  previewUrl(port: number): Promise<string> {
    return this.#inner.previewUrl(port);
  }
}
