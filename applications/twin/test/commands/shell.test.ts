import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeMachine } from '../../src/backend/fake.ts';
import { main } from '../../src/cli.ts';
import type { CommandContext } from '../../src/commands/context.ts';
import { EXIT_MARKER, SHELL_SCRIPT } from '../../src/shell/guest.ts';
import { fakeHost, fakeIo, fakeLocal } from '../helpers/fakes.ts';

/** A backend with kept machines whose shell script exists unless `unkept` names them. */
async function backendWith(count: number, unkept: number[] = []) {
  const backend = new FakeBackend((spec, machine) => {
    if (spec.argv.join(' ') === `test -x ${SHELL_SCRIPT}`) {
      return { exitCode: unkept.includes(backend.machines.indexOf(machine)) ? 1 : 0 };
    }
    return undefined;
  });
  for (let i = 0; i < count; i++) {
    await backend.create({ labels: { app: 'twin', run: `run${i}` }, idleTimeoutMs: 1 });
  }
  return backend;
}

function context(backend: FakeBackend, withTerminal = true) {
  const { io, stdout, stderr } = fakeIo();
  const user = fakeLocal();
  if (withTerminal) io.terminal = user.local;
  const ctx: CommandContext = {
    io,
    host: fakeHost(),
    cwd: '/',
    version: 't',
    getBackend: async () => backend,
  };
  return { ctx, stdout, stderr, user };
}

describe('twin shell', () => {
  it('attaches to the only running machine until its shell exits', async () => {
    const backend = await backendWith(1);
    const machine = backend.machines[0] as FakeMachine;
    const { ctx, stderr, user } = context(backend);
    machine.onTerminal = (terminal) => {
      terminal.emit('$ ');
      user.type('npm test\r');
      terminal.emit(`FAIL\r\n${EXIT_MARKER}`);
    };
    expect(await main(['shell'], ctx)).toBe(0);
    expect(machine.terminals[0]?.command).toBe(SHELL_SCRIPT);
    expect(machine.terminals[0]?.sizes[0]).toEqual([100, 30]);
    expect(machine.terminals[0]?.written).toEqual(['npm test\r']);
    expect(user.state.shown).toBe('$ FAIL\r\n');
    expect(stderr.text).toContain('connected to sbx_fake0. Ctrl-] detaches.');
    expect(stderr.text).toContain('shell exited. sbx_fake0 keeps running');
    expect(machine.killed).toBe(false);
    expect(machine.detached).toBe(true);
  });

  it('picks a machine by id prefix', async () => {
    const backend = await backendWith(2);
    const target = backend.machines[1] as FakeMachine;
    const { ctx } = context(backend);
    target.onTerminal = (terminal) => terminal.emit(EXIT_MARKER);
    expect(await main(['shell', 'sbx_fake1'], ctx)).toBe(0);
    expect(target.terminals).toHaveLength(1);
    expect(backend.machines[0]?.terminals).toHaveLength(0);
  });

  it('asks for more of the id when several machines match', async () => {
    const { ctx, stderr } = context(await backendWith(2));
    expect(await main(['shell'], ctx)).toBe(2);
    expect(stderr.text).toContain('several twin machines match');
    expect(stderr.text).toContain('sbx_fake0  run run0');
  });

  it('explains when nothing is running or nothing matches', async () => {
    const empty = context(await backendWith(0));
    expect(await main(['shell'], empty.ctx)).toBe(1);
    expect(empty.stderr.text).toContain('keep one with: twin replay <capsule> --keep');
    const other = context(await backendWith(1));
    expect(await main(['shell', 'nope'], other.ctx)).toBe(1);
    expect(other.stderr.text).toContain('no running twin machine starts with "nope"');
  });

  it('refuses machines that replay --keep did not prepare', async () => {
    const { ctx, stderr } = context(await backendWith(1, [0]));
    expect(await main(['shell'], ctx)).toBe(1);
    expect(stderr.text).toContain('was not kept by `twin replay --keep`');
  });

  it('prints a browser terminal link with a fresh password', async () => {
    const backend = await backendWith(1);
    const { ctx, stdout, stderr } = context(backend, false);
    expect(await main(['shell', '--web'], ctx)).toBe(0);
    expect(stdout.text).toBe('https://sbx_fake0-7681.preview.test/?pt_token=secret\n');
    expect(stderr.text).toMatch(/user {6}twin\n {2}password {2}[A-Za-z0-9_-]{16}\n/);
    expect(stderr.text).toContain('root shell on this machine');
    expect(backend.machines[0]?.detached).toBe(true);
    const started = backend.machines[0]?.runs.find((r) => r.argv.join(' ').includes('ttyd'));
    expect(started?.argv.join(' ')).toContain('--credential');
  });

  it('reports a browser terminal that fails to start', async () => {
    const backend = new FakeBackend((spec) =>
      spec.argv.join(' ').includes('ttyd') ? { exitCode: 1, output: 'no curl' } : undefined,
    );
    await backend.create({ labels: { app: 'twin' }, idleTimeoutMs: 1 });
    const { ctx, stderr } = context(backend, false);
    expect(await main(['shell', '--web'], ctx)).toBe(1);
    expect(stderr.text).toContain('could not start the browser terminal:\nno curl');
  });

  it('needs a terminal unless --web is used, and validates arguments', async () => {
    const backend = await backendWith(1);
    const noTty = context(backend, false);
    expect(await main(['shell'], noTty.ctx)).toBe(2);
    expect(noTty.stderr.text).toContain('use --web');
    const extra = context(backend);
    expect(await main(['shell', 'a', 'b'], extra.ctx)).toBe(2);
    expect(await main(['shell', '--help'], extra.ctx)).toBe(0);
    expect(extra.stdout.text).toContain('Usage: twin shell');
  });
});
