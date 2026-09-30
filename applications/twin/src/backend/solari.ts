import type { Sandbox, SandboxClient } from '@solarisdk/sdk';
import { TailBuffer } from '../capture/tail-buffer.ts';
import { TwinError } from '../errors.ts';
import type { SolariEnv } from './credentials.ts';
import type {
  Backend,
  CreateMachineOptions,
  Machine,
  MachineInfo,
  RunOutcome,
  RunSpec,
  Terminal,
} from './types.ts';

/** The SDK surface twin uses, narrowed so tests can pass a structural fake. */
export type SandboxApi = Pick<SandboxClient, 'create' | 'connect' | 'get' | 'listAll' | 'kill'>;
export type SandboxHandle = Pick<
  Sandbox,
  'id' | 'connect' | 'reconnect' | 'commands' | 'files' | 'kill' | 'close' | 'pty' | 'previewUrl'
>;

const TEMPLATE = 'base';
const OUTPUT_TAIL_CHARS = 64_000;
const SIGKILL = 9;
const START_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Matched by name so this module does not have to load the SDK eagerly. */
function isConnectionError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConnectionError';
}

/**
 * A dropped control channel mid-command is not an idle timeout (a 100 s silent command is fine). The
 * measured cause (2026-09-29, mantine yarn install) was the guest's OOM killer ending the agent:
 * sandboxes have about 2 GB of RAM, no swap and a 3.9 GB disk.
 */
function connectionLost(command: string): TwinError {
  return new TwinError(
    `lost the connection to the sandbox while running "${command}". A large install or test run can exhaust the sandbox (about 2 GB RAM, no swap, 3.9 GB disk) and kill its agent; the machine is released. Try a smaller workspace, or replay just the failing package.`,
  );
}

export interface ReleaseTiming {
  attempts: number;
  intervalMs: number;
}

/**
 * Measured on 2026-09-28: two sandboxes stayed `running` and kept billing for over two hours after
 * `kill()` (and later `DELETE`s) returned successfully; a later kill removed them in seconds. So a
 * kill is only trusted once `get()` stops reporting the sandbox as live.
 */
const RELEASE_TIMING: ReleaseTiming = { attempts: 8, intervalMs: 5_000 };

async function liveState(api: Pick<SandboxApi, 'get'>, id: string): Promise<string | null> {
  try {
    const { state } = await api.get(id);
    return state === 'gone' ? null : state;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

/** Kills a sandbox and waits until the gateway confirms it is gone, re-killing while it is not. */
export async function killAndConfirm(
  api: Pick<SandboxApi, 'get' | 'kill'>,
  id: string,
  timing: ReleaseTiming = RELEASE_TIMING,
): Promise<void> {
  await api.kill(id);
  for (let attempt = 1; attempt <= timing.attempts; attempt++) {
    await sleep(timing.intervalMs);
    const state = await liveState(api, id);
    if (state === null) return;
    if (state !== 'releasing') await api.kill(id);
  }
  throw new Error(
    `sandbox ${id.slice(0, 16)}… still reports running after ${timing.attempts + 1} kills; it is billed until it stops, check the Solari console`,
  );
}

export class SolariMachine implements Machine {
  readonly #sandbox: SandboxHandle;
  readonly #now: () => number;

  readonly #retryBaseMs: number;
  readonly #release: () => Promise<void>;

  constructor(
    sandbox: SandboxHandle,
    now: () => number = Date.now,
    retryBaseMs = RETRY_BASE_MS,
    /** How to release the machine; the backend supplies a verified kill. */
    release?: () => Promise<void>,
  ) {
    this.#sandbox = sandbox;
    this.#now = now;
    this.#retryBaseMs = retryBaseMs;
    this.#release = release ?? (() => sandbox.kill());
  }

  /**
   * Starting a command fails with ConnectionError when the control channel dropped (it does after
   * a revert, once the gateway notices the restored guest). The command never reached the guest in
   * that case, so reconnecting and starting again cannot run it twice.
   */
  async #start(cmd: string, options: Parameters<SandboxHandle['commands']['start']>[1]) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#sandbox.commands.start(cmd, options);
      } catch (error) {
        if (!isConnectionError(error) || attempt >= START_ATTEMPTS) throw error;
        await sleep(this.#retryBaseMs * attempt);
        await this.#sandbox.reconnect().catch(() => {});
      }
    }
  }

  get id(): string {
    return this.#sandbox.id;
  }

  /**
   * Uses commands.start rather than commands.run: the streaming path has no server-side timeout,
   * so twin enforces one itself and kills the guest process when it fires.
   */
  async run(spec: RunSpec): Promise<RunOutcome> {
    const [cmd, ...args] = spec.argv;
    if (cmd === undefined) throw new Error('SolariMachine.run: empty argv');
    const started = this.#now();
    const tail = new TailBuffer(OUTPUT_TAIL_CHARS);
    const handle = await this.#start(cmd, {
      args,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
    });
    handle.onData(({ stream, data }) => {
      tail.append(data);
      spec.onOutput?.(data, stream);
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), spec.timeoutMs);
    });
    try {
      const result = await Promise.race([handle.wait(), timeout]).catch((error: unknown) => {
        throw isConnectionError(error) ? connectionLost(cmd) : error;
      });
      if (result === 'timeout') {
        await handle.kill(SIGKILL).catch(() => {});
        return {
          exitCode: null,
          timedOut: true,
          output: tail.tail(Infinity),
          durationMs: this.#now() - started,
        };
      }
      return {
        exitCode: result,
        timedOut: false,
        output: tail.tail(Infinity),
        durationMs: this.#now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#sandbox.files.write(path, content);
  }

  kill(): Promise<void> {
    return this.#release();
  }

  /**
   * The open control channel would otherwise keep the process alive. The SDK warns on close()
   * that the machine keeps running and billing; twin has already said exactly that, with how to
   * release it, so the duplicate warning is suppressed for this one call.
   */
  async detach(): Promise<void> {
    const warn = console.warn;
    console.warn = () => {};
    try {
      this.#sandbox.close();
    } finally {
      console.warn = warn;
    }
  }

  async openTerminal(options: { cols: number; rows: number; command: string }): Promise<Terminal> {
    const pty = await this.#sandbox.pty.create({
      cols: options.cols,
      rows: options.rows,
      cmd: options.command,
    });
    return {
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      onData: (listener) => pty.onData(listener),
      close: () => pty.kill(),
    };
  }

  async previewUrl(port: number): Promise<string> {
    return (await this.#sandbox.previewUrl(port)).url;
  }
}

export class SolariBackend implements Backend {
  readonly name = 'solari';
  readonly #sandboxes: SandboxApi;
  readonly #timing: ReleaseTiming;

  constructor(sandboxes: SandboxApi, timing: ReleaseTiming = RELEASE_TIMING) {
    this.#sandboxes = sandboxes;
    this.#timing = timing;
  }

  async create(options: CreateMachineOptions): Promise<Machine> {
    const sandbox = await this.#sandboxes.create({
      template: TEMPLATE,
      metadata: options.labels,
      idleTimeoutMs: options.idleTimeoutMs,
    });
    try {
      // The control channel is not opened by create(); streaming commands need it.
      await sandbox.connect();
    } catch (error) {
      // An unconfirmed kill can leave the sandbox billing (see RELEASE_TIMING), so verify it.
      await sandbox.kill().catch(() => {});
      await killAndConfirm(this.#sandboxes, sandbox.id, this.#timing).catch(() => {});
      throw error;
    }
    return this.#machine(sandbox);
  }

  #machine(sandbox: SandboxHandle): SolariMachine {
    return new SolariMachine(sandbox, Date.now, RETRY_BASE_MS, async () => {
      // Closes the local channel and marks the handle killed; the verified kill does the rest.
      await sandbox.kill();
      await killAndConfirm(this.#sandboxes, sandbox.id, this.#timing);
    });
  }

  async connect(id: string): Promise<Machine> {
    const sandbox = await this.#sandboxes.connect(id);
    await sandbox.connect();
    return this.#machine(sandbox);
  }

  async list(labels: Record<string, string>): Promise<MachineInfo[]> {
    const machines: MachineInfo[] = [];
    for await (const view of this.#sandboxes.listAll({ metadata: labels })) {
      const state = await liveState(this.#sandboxes, view.sandboxId);
      if (state !== null && state !== 'releasing') {
        machines.push({ id: view.sandboxId, state, labels: view.metadata });
      }
    }
    return machines;
  }

  /** Tries every sandbox even when one fails, so one stuck kill does not leave the rest billing. */
  async reap(labels: Record<string, string>): Promise<string[]> {
    const killed: string[] = [];
    const failures: string[] = [];
    for await (const view of this.#sandboxes.listAll({ metadata: labels })) {
      try {
        // The listing lags; ask for the sandbox itself before counting it as live.
        const state = await liveState(this.#sandboxes, view.sandboxId);
        if (state === null || state === 'releasing') continue;
        await killAndConfirm(this.#sandboxes, view.sandboxId, this.#timing);
        killed.push(view.sandboxId);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      const done = killed.length > 0 ? ` (stopped ${killed.join(', ')})` : '';
      throw new Error(`${failures.join('; ')}${done}`);
    }
    return killed;
  }
}

/** Builds the real backend. The SDK is imported lazily so offline commands never load it. */
export async function solariBackendFromEnv(env: SolariEnv): Promise<SolariBackend> {
  const apiKey = env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new TwinError(
      'SOLARI_API_KEY is not set. Get a key at https://console.getsolari.com, then export SOLARI_API_KEY=... or add SOLARI_API_KEY=... to a .env file in this project.',
      {
        exitCode: 2,
      },
    );
  }
  const { SolariClient } = await import('@solarisdk/sdk');
  const client = new SolariClient({
    apiKey,
    ...(env.SOLARI_BASE_URL ? { baseUrl: env.SOLARI_BASE_URL } : {}),
  });
  return new SolariBackend(client.sandboxes);
}
