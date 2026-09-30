import { describe, expect, it, vi } from 'vitest';
import { FakeBackend } from '../../src/backend/fake.ts';
import {
  killAndConfirm,
  type SandboxApi,
  type SandboxHandle,
  SolariBackend,
  SolariMachine,
  solariBackendFromEnv,
} from '../../src/backend/solari.ts';
import { TwinError } from '../../src/errors.ts';

type Chunk = { stream: 'stdout' | 'stderr'; data: string };

/** Structural stand-in for an SDK Sandbox; only the members twin calls. */
function fakeSandbox(
  options: {
    chunks?: Chunk[];
    exitCode?: number;
    hang?: boolean;
    connectFails?: boolean;
    waitFails?: Error;
  } = {},
) {
  const calls: string[] = [];
  const handle = {
    cmdId: 'cmd_1',
    stdin: vi.fn(),
    onData: (cb: (chunk: Chunk) => void) => {
      for (const chunk of options.chunks ?? []) cb(chunk);
    },
    wait: () =>
      options.waitFails
        ? Promise.reject(options.waitFails)
        : options.hang
          ? new Promise<number>(() => {})
          : Promise.resolve(options.exitCode ?? 0),
    kill: vi.fn(async (_signal?: number) => {
      calls.push('handle.kill');
    }),
  };
  const sandbox = {
    id: 'sbx_1',
    connect: vi.fn(async () => {
      calls.push('connect');
      if (options.connectFails) throw new Error('ws refused');
    }),
    commands: {
      start: vi.fn(async (cmd: string, opts?: object) => {
        calls.push(`start ${cmd} ${JSON.stringify(opts)}`);
        return handle;
      }),
    },
    files: {
      write: vi.fn(async (path: string, _data: string) => {
        calls.push(`write ${path}`);
      }),
    },
    pty: {
      create: vi.fn(async (opts: { cols: number; rows: number; cmd?: string }) => {
        calls.push(`pty ${opts.cmd} ${opts.cols}x${opts.rows}`);
        const listeners: ((data: Uint8Array) => void)[] = [];
        return {
          ptyId: 'pty_1',
          write: async (data: string | Uint8Array) => {
            calls.push(`pty write ${String(data)}`);
          },
          resize: async (cols: number, rows: number) => {
            calls.push(`pty resize ${cols}x${rows}`);
          },
          onData: (cb: (data: Uint8Array) => void) => {
            listeners.push(cb);
            cb(Buffer.from('hello'));
          },
          kill: async () => {
            calls.push('pty kill');
          },
        };
      }),
    },
    previewUrl: vi.fn(async (port: number) => ({
      url: `https://x-${port}.preview.getsolari.com/?pt_token=t`,
      token: 't',
    })),
    reconnect: vi.fn(async () => {
      calls.push('reconnect');
    }),
    close: vi.fn(() => {
      console.warn('[solari] close() on session sbx_1 closed the local channel only');
      calls.push('close');
    }),
    kill: vi.fn(async () => {
      calls.push('kill');
    }),
  };
  return { sandbox: sandbox as unknown as SandboxHandle, handle, calls };
}

describe('SolariMachine', () => {
  it('starts the program with args, cwd and env, streams output and returns the exit code', async () => {
    const { sandbox, calls } = fakeSandbox({
      chunks: [
        { stream: 'stdout', data: 'hello\n' },
        { stream: 'stderr', data: 'oops\n' },
      ],
      exitCode: 3,
    });
    const seen: string[] = [];
    const machine = new SolariMachine(sandbox, () => 1000);
    const outcome = await machine.run({
      argv: ['npm', 'test'],
      cwd: '/w',
      env: { A: '1' },
      timeoutMs: 1000,
      onOutput: (chunk, stream) => seen.push(`${stream}:${chunk}`),
    });
    expect(calls[0]).toBe('start npm {"args":["test"],"cwd":"/w","env":{"A":"1"}}');
    expect(outcome).toEqual({ exitCode: 3, timedOut: false, output: 'hello\noops', durationMs: 0 });
    expect(seen).toEqual(['stdout:hello\n', 'stderr:oops\n']);
  });

  it('omits unset cwd and env', async () => {
    const { sandbox, calls } = fakeSandbox();
    await new SolariMachine(sandbox).run({ argv: ['true'], timeoutMs: 1000 });
    expect(calls[0]).toBe('start true {"args":[]}');
  });

  it('kills the guest process when the timeout fires', async () => {
    const { sandbox, handle } = fakeSandbox({ hang: true });
    const outcome = await new SolariMachine(sandbox).run({ argv: ['sleep', '999'], timeoutMs: 10 });
    expect(outcome).toMatchObject({ exitCode: null, timedOut: true });
    expect(handle.kill).toHaveBeenCalledWith(9);
  });

  it('delegates files and kill to the sandbox', async () => {
    const { sandbox, calls } = fakeSandbox();
    const machine = new SolariMachine(sandbox);
    expect(machine.id).toBe('sbx_1');
    await machine.writeFile('/tmp/x', 'data');
    await machine.kill();
    expect(calls).toEqual(['write /tmp/x', 'kill']);
  });

  it('reconnects and retries when the channel dropped before the command started', async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0 });
    const dropped = Object.assign(new Error('Not connected'), { name: 'ConnectionError' });
    const start = sandbox.commands.start as unknown as ReturnType<typeof vi.fn>;
    const real = start.getMockImplementation();
    start.mockImplementationOnce(async () => {
      calls.push('start dropped');
      throw dropped;
    });
    if (real) start.mockImplementation(real);
    const outcome = await new SolariMachine(sandbox, Date.now, 0).run({
      argv: ['true'],
      timeoutMs: 1000,
    });
    expect(outcome.exitCode).toBe(0);
    expect(calls).toEqual(['start dropped', 'reconnect', 'start true {"args":[]}']);
  });

  it('gives up after repeated connection errors and never retries other errors', async () => {
    const { sandbox } = fakeSandbox();
    const start = sandbox.commands.start as unknown as ReturnType<typeof vi.fn>;
    start.mockRejectedValue(Object.assign(new Error('Not connected'), { name: 'ConnectionError' }));
    await expect(
      new SolariMachine(sandbox, Date.now, 0).run({ argv: ['x'], timeoutMs: 1 }),
    ).rejects.toThrow('Not connected');
    expect(start).toHaveBeenCalledTimes(4);

    start.mockReset();
    start.mockRejectedValue(new Error('ENOENT'));
    await expect(
      new SolariMachine(sandbox, Date.now, 0).run({ argv: ['x'], timeoutMs: 1 }),
    ).rejects.toThrow('ENOENT');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('explains a channel lost while a command runs, and passes other errors through', async () => {
    const lost = Object.assign(new Error('Control channel closed (1005)'), {
      name: 'ConnectionError',
    });
    const { sandbox } = fakeSandbox({ waitFails: lost });
    const error = await new SolariMachine(sandbox)
      .run({ argv: ['yarn', 'install'], timeoutMs: 1000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwinError);
    expect((error as Error).message).toMatch(/lost the connection .* "yarn".* 2 GB/);

    const other = fakeSandbox({ waitFails: new Error('boom') }).sandbox;
    await expect(new SolariMachine(other).run({ argv: ['x'], timeoutMs: 1000 })).rejects.toThrow(
      'boom',
    );
  });

  it('detaches by closing the channel without the SDK warning, and restores console.warn', async () => {
    const { sandbox, calls } = fakeSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = console.warn;
    await new SolariMachine(sandbox).detach();
    expect(calls).toEqual(['close']);
    expect(warn).not.toHaveBeenCalled();
    expect(console.warn).toBe(original);
    warn.mockRestore();
  });

  it('rejects an empty argv', async () => {
    const { sandbox } = fakeSandbox();
    await expect(new SolariMachine(sandbox).run({ argv: [], timeoutMs: 1 })).rejects.toThrow(
      'empty argv',
    );
  });
});

describe('SolariBackend', () => {
  const FAST = { attempts: 3, intervalMs: 0 };

  /**
   * `views` is what the (lagging) listing returns; `server` is what `get` reports. A sandbox dies
   * after `killsToDie` kills (1 unless set), which models the kills that were ignored live.
   */
  function api(
    sandbox: SandboxHandle,
    views: { sandboxId: string; state: string }[] = [],
    server: Record<string, { state: string; killsToDie?: number }> = Object.fromEntries(
      views.map((v) => [v.sandboxId, { state: v.state }]),
    ),
  ) {
    const live = new Map(Object.entries(server).map(([id, s]) => [id, { ...s }]));
    const create = vi.fn(async (_opts: object) => sandbox);
    const connect = vi.fn(async (_id: string) => sandbox);
    const get = vi.fn(async (id: string) => {
      const entry = live.get(id);
      if (!entry) throw Object.assign(new Error('Not found'), { status: 404 });
      return { sandboxId: id, state: entry.state };
    });
    const kill = vi.fn(async (id: string) => {
      const entry = live.get(id);
      if (!entry) return;
      entry.killsToDie = (entry.killsToDie ?? 1) - 1;
      if (entry.killsToDie <= 0) live.delete(id);
    });
    const listAll = vi.fn(async function* (_opts: object) {
      yield* views;
    });
    return {
      sandboxes: {
        create,
        connect,
        get,
        kill,
        listAll,
      } as unknown as SandboxApi,
      create,
      get,
      kill,
      listAll,
    };
  }

  it('creates a labeled base sandbox with an idle timeout and opens its control channel', async () => {
    const { sandbox, calls } = fakeSandbox();
    const { sandboxes, create } = api(sandbox);
    const machine = await new SolariBackend(sandboxes).create({
      labels: { app: 'twin', run: 'r1' },
      idleTimeoutMs: 900_000,
    });
    expect(create).toHaveBeenCalledWith({
      template: 'base',
      metadata: { app: 'twin', run: 'r1' },
      idleTimeoutMs: 900_000,
    });
    expect(calls).toEqual(['connect']);
    expect(machine.id).toBe('sbx_1');
  });

  it('kills the sandbox if the control channel cannot be opened', async () => {
    const { sandbox, calls } = fakeSandbox({ connectFails: true });
    const { sandboxes, kill } = api(sandbox, [], { [sandbox.id]: { state: 'running' } });
    await expect(
      new SolariBackend(sandboxes, FAST).create({ labels: {}, idleTimeoutMs: 1 }),
    ).rejects.toThrow('ws refused');
    expect(calls).toEqual(['connect', 'kill']);
    expect(kill).toHaveBeenCalledWith(sandbox.id);
  });

  it('keeps reaping past a sandbox whose kill never takes effect', async () => {
    const { sandbox } = fakeSandbox();
    const { sandboxes, kill } = api(
      sandbox,
      [
        { sandboxId: 'zombie', state: 'running' },
        { sandboxId: 'b', state: 'running' },
      ],
      { zombie: { state: 'running', killsToDie: 99 }, b: { state: 'running' } },
    );
    await expect(new SolariBackend(sandboxes, FAST).reap({ app: 'twin' })).rejects.toThrow(
      /zombie.*stopped b/,
    );
    expect(kill).toHaveBeenCalledWith('b');
  });

  it('reaps live sandboxes, skipping ghosts the listing still shows', async () => {
    const { sandbox } = fakeSandbox();
    const { sandboxes, kill, listAll } = api(
      sandbox,
      [
        { sandboxId: 'a', state: 'running' },
        { sandboxId: 'ghost', state: 'running' },
        { sandboxId: 'c', state: 'paused' },
        { sandboxId: 'd', state: 'releasing' },
      ],
      { a: { state: 'running' }, c: { state: 'paused' }, d: { state: 'releasing' } },
    );
    expect(await new SolariBackend(sandboxes, FAST).reap({ app: 'twin' })).toEqual(['a', 'c']);
    expect(listAll).toHaveBeenCalledWith({ metadata: { app: 'twin' } });
    expect(kill.mock.calls).toEqual([['a'], ['c']]);
  });

  it('reconnects to a running sandbox by id and opens its control channel', async () => {
    const { sandbox, calls } = fakeSandbox();
    const { sandboxes } = api(sandbox);
    const machine = await new SolariBackend(sandboxes, FAST).connect('sbx_1');
    expect(machine.id).toBe('sbx_1');
    expect(calls).toEqual(['connect']);
  });

  it('lists only machines the gateway confirms as live', async () => {
    const { sandbox } = fakeSandbox();
    const views = [
      { sandboxId: 'a', state: 'running', metadata: { app: 'twin', run: '1' } },
      { sandboxId: 'ghost', state: 'running', metadata: { app: 'twin', run: '2' } },
      { sandboxId: 'c', state: 'running', metadata: { app: 'twin', run: '3' } },
    ];
    const { sandboxes } = api(sandbox, views, {
      a: { state: 'running' },
      c: { state: 'releasing' },
    });
    expect(await new SolariBackend(sandboxes, FAST).list({ app: 'twin' })).toEqual([
      { id: 'a', state: 'running', labels: { app: 'twin', run: '1' } },
    ]);
  });

  it('opens terminals over the PTY and returns preview URLs', async () => {
    const { sandbox, calls } = fakeSandbox();
    const machine = new SolariMachine(sandbox);
    const terminal = await machine.openTerminal({
      cols: 90,
      rows: 20,
      command: '/tmp/twin/shell.sh',
    });
    const seen: string[] = [];
    terminal.onData((data) => seen.push(Buffer.from(data).toString('utf8')));
    await terminal.write('ls\r');
    await terminal.resize(100, 30);
    await terminal.close();
    expect(seen).toEqual(['hello']);
    expect(calls).toEqual([
      'pty /tmp/twin/shell.sh 90x20',
      'pty write ls\r',
      'pty resize 100x30',
      'pty kill',
    ]);
    expect(await machine.previewUrl(7681)).toBe('https://x-7681.preview.getsolari.com/?pt_token=t');
  });

  it('keeps killing until the sandbox is confirmed gone', async () => {
    const { sandbox } = fakeSandbox();
    const { sandboxes, kill } = api(sandbox, [], { z: { state: 'running', killsToDie: 3 } });
    await killAndConfirm(sandboxes, 'z', FAST);
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it('waits without re-killing while the sandbox is releasing', async () => {
    const { sandbox } = fakeSandbox();
    const { sandboxes, kill, get } = api(sandbox, [], { r: { state: 'running', killsToDie: 99 } });
    get.mockResolvedValueOnce({ sandboxId: 'r', state: 'releasing' } as never);
    get.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    await killAndConfirm(sandboxes, 'r', FAST);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when a kill never takes effect, and passes other errors through', async () => {
    const { sandbox } = fakeSandbox();
    const { sandboxes, get } = api(sandbox, [], { zombie: { state: 'running', killsToDie: 99 } });
    await expect(killAndConfirm(sandboxes, 'zombie', FAST)).rejects.toThrow(
      /still reports running after 4 kills; it is billed/,
    );
    get.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(killAndConfirm(sandboxes, 'zombie', FAST)).rejects.toThrow('boom');
  });

  it('releases created machines with a verified kill', async () => {
    const { sandbox, calls } = fakeSandbox();
    const { sandboxes, kill } = api(sandbox, [], { sbx_1: { state: 'running' } });
    const machine = await new SolariBackend(sandboxes, FAST).create({
      labels: {},
      idleTimeoutMs: 1,
    });
    await machine.kill();
    expect(calls).toContain('kill');
    expect(kill).toHaveBeenCalledWith('sbx_1');
  });
});

describe('solariBackendFromEnv', () => {
  it('explains a missing key', async () => {
    await expect(solariBackendFromEnv({})).rejects.toThrow(TwinError);
    await expect(solariBackendFromEnv({})).rejects.toThrow(/SOLARI_API_KEY is not set/);
  });

  it('builds a backend from the real SDK without network access', async () => {
    const backend = await solariBackendFromEnv({
      SOLARI_API_KEY: 'slr_test_x',
      SOLARI_BASE_URL: 'http://127.0.0.1:9',
    });
    expect(backend.name).toBe('solari');
  });
});

describe('FakeBackend', () => {
  it('reaps only live machines with matching labels', async () => {
    const backend = new FakeBackend();
    const a = await backend.create({ labels: { app: 'twin', run: '1' }, idleTimeoutMs: 1 });
    await backend.create({ labels: { app: 'other' }, idleTimeoutMs: 1 });
    expect(await backend.reap({ app: 'twin' })).toEqual([a.id]);
    expect(await backend.reap({ app: 'twin' })).toEqual([]);
  });

  it('refuses to run on a killed machine', async () => {
    const machine = await new FakeBackend().create({ labels: {}, idleTimeoutMs: 1 });
    await machine.kill();
    await expect(machine.run({ argv: ['x'], timeoutMs: 1 })).rejects.toThrow('was killed');
  });
});
