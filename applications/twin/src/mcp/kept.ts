import { posix } from 'node:path';
import { type Backend, type Machine, type RunOutcome, TWIN_LABELS } from '../backend/types.ts';
import { RUN_SCRIPT } from '../shell/guest.ts';
import { ensureKept, resolveMachine } from '../shell/machines.ts';

/**
 * Machines kept by `replay` that an agent works in during one MCP session. Connections are
 * opened once and reused, and machines this session kept are released when it ends, so an agent
 * that forgets `release` costs at most the rest of the session.
 */
export class KeptMachines {
  readonly #getBackend: () => Promise<Backend>;
  readonly #open = new Map<string, Machine>();
  readonly #cwd = new Map<string, string>();
  readonly #ownIds = new Set<string>();

  constructor(getBackend: () => Promise<Backend>) {
    this.#getBackend = getBackend;
  }

  /** Records a machine this session's replay kept, to release when the session ends. */
  adopt(id: string): void {
    this.#ownIds.add(id);
  }

  /** The kept machine whose id starts with `prefix` (any unique prefix, or none when only one). */
  async get(prefix: string | undefined): Promise<Machine> {
    if (prefix) {
      const cached = [...this.#open.values()].filter((m) => m.id.startsWith(prefix));
      if (cached.length === 1) return cached[0] as Machine;
    }
    const backend = await this.#getBackend();
    const info = await resolveMachine(backend, prefix);
    const open = this.#open.get(info.id);
    if (open) return open;
    const machine = await backend.connect(info.id);
    try {
      await ensureKept(machine, RUN_SCRIPT);
    } catch (error) {
      await machine.detach();
      throw error;
    }
    this.#open.set(machine.id, machine);
    return machine;
  }

  /** Runs a command line in the reporter's environment, in the failing command's directory. */
  async run(prefix: string | undefined, command: string, timeoutMs: number): Promise<RunOutcome> {
    const machine = await this.get(prefix);
    return machine.run({ argv: [RUN_SCRIPT, command], timeoutMs });
  }

  /** Writes a file; relative paths resolve against the failing command's directory. */
  async writeFile(prefix: string | undefined, path: string, content: string): Promise<string> {
    const machine = await this.get(prefix);
    const target = posix.isAbsolute(path)
      ? path
      : posix.join(await this.#workingDirectory(machine), path);
    const made = await machine.run({
      argv: ['mkdir', '-p', posix.dirname(target)],
      timeoutMs: 30_000,
    });
    if (made.exitCode !== 0)
      throw new Error(`cannot create ${posix.dirname(target)}: ${made.output}`);
    await machine.writeFile(target, content);
    return target;
  }

  /** Kills one machine (by prefix) or, with no prefix, every twin machine. Returns killed ids. */
  async release(prefix: string | undefined): Promise<string[]> {
    const backend = await this.#getBackend();
    if (!prefix) {
      const killed = await backend.reap({ ...TWIN_LABELS });
      this.#forget(...this.#open.keys(), ...this.#ownIds);
      return killed;
    }
    const info = await resolveMachine(backend, prefix);
    const machine = this.#open.get(info.id) ?? (await backend.connect(info.id));
    await machine.kill();
    this.#forget(info.id);
    return [info.id];
  }

  /** Session end: release machines this session kept, let go of the others. */
  async close(): Promise<void> {
    const backend = this.#ownIds.size ? await this.#getBackend() : null;
    const own = [...this.#ownIds];
    await Promise.allSettled(
      own.map(async (id) => {
        const machine = this.#open.get(id) ?? (await backend?.connect(id));
        await machine?.kill();
      }),
    );
    await Promise.allSettled(
      [...this.#open.values()].filter((m) => !this.#ownIds.has(m.id)).map((m) => m.detach()),
    );
    this.#forget(...this.#open.keys(), ...own);
  }

  async #workingDirectory(machine: Machine): Promise<string> {
    const known = this.#cwd.get(machine.id);
    if (known) return known;
    const probe = await machine.run({ argv: [RUN_SCRIPT, 'pwd'], timeoutMs: 30_000 });
    const cwd = probe.output.trim().split('\n').at(-1);
    if (probe.exitCode !== 0 || !cwd?.startsWith('/')) {
      throw new Error(`cannot find the working directory on ${machine.id}: ${probe.output}`);
    }
    this.#cwd.set(machine.id, cwd);
    return cwd;
  }

  #forget(...ids: string[]): void {
    for (const id of ids) {
      this.#open.delete(id);
      this.#cwd.delete(id);
      this.#ownIds.delete(id);
    }
  }
}
