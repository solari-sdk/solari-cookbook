import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import type { Command, CommandContext } from '../src/commands/context.ts';
import { TwinError } from '../src/errors.ts';
import { fakeHost, fakeIo, noBackend } from './helpers/fakes.ts';

function context(io: ReturnType<typeof fakeIo>['io']): CommandContext {
  return { io, host: fakeHost(), cwd: '/tmp', version: '1.2.3', getBackend: noBackend };
}

describe('main', () => {
  it('prints usage with exit 2 when no command is given', async () => {
    const { io, stdout } = fakeIo();
    expect(await main([], context(io))).toBe(2);
    expect(stdout.text).toContain('Usage: twin <command>');
    expect(stdout.text).toContain('capture');
    expect(stdout.text).toContain('inspect');
  });

  it.each(['--help', '-h', 'help'])('prints usage for %s', async (flag) => {
    const { io, stdout } = fakeIo();
    expect(await main([flag], context(io))).toBe(0);
    expect(stdout.text).toContain('Report a bug');
  });

  it.each(['--version', '-v'])('prints the version for %s', async (flag) => {
    const { io, stdout } = fakeIo();
    expect(await main([flag], context(io))).toBe(0);
    expect(stdout.text).toBe('1.2.3\n');
  });

  it('rejects unknown commands', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['frobnicate'], context(io))).toBe(2);
    expect(stderr.text).toContain('unknown command "frobnicate"');
  });

  it('suggests the closest command for a typo', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['repaly'], context(io))).toBe(2);
    expect(stderr.text).toBe('twin: unknown command "repaly". Did you mean: twin replay?\n');
    expect(await main(['sotp'], context(io))).toBe(2);
    expect(stderr.text).toContain('Did you mean: twin stop?');
    expect(await main(['zzz'], context(io))).toBe(2);
    expect(stderr.text).toContain('unknown command "zzz". See: twin --help');
  });

  it('prints command help for twin help <command>', async () => {
    const { io, stdout } = fakeIo();
    expect(await main(['help', 'replay'], context(io))).toBe(0);
    expect(stdout.text).toContain('Usage: twin replay');
  });

  it('groups commands and hides aliases', async () => {
    const { io, stdout } = fakeIo();
    await main(['--help'], context(io));
    expect(stdout.text).toMatch(/Machines[^\n]*\n {2}list +show machines/);
    expect(stdout.text).toContain('  stop ');
    expect(stdout.text).not.toContain('  gc ');
    expect(stdout.text).not.toContain('●');
  });

  it('draws the wordmark on a terminal', async () => {
    const { io, stdout } = fakeIo();
    Object.defineProperty(io.stdout, 'isTTY', { value: true });
    await main(['--help'], context(io));
    expect(stdout.text).toContain('●');
    expect(stdout.text).toContain('twin 1.2.3');
  });

  it('turns unknown options into a usage error', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['inspect', '--wat'], context(io))).toBe(2);
    expect(stderr.text).toContain("Unknown option '--wat'");
    expect(stderr.text).toContain('Usage: twin inspect');
  });
});

describe('error mapping', () => {
  const failing = (error: unknown): Command => ({
    name: 'boom',
    summary: 'fails',
    usage: 'Usage: twin boom',
    run: async () => {
      throw error;
    },
  });

  it('prints TwinError messages without a stack and uses their exit code', async () => {
    const { io, stderr } = fakeIo();
    const commands = [failing(new TwinError('nice message', { exitCode: 7 }))];
    expect(await main(['boom'], context(io), commands)).toBe(7);
    expect(stderr.text).toBe('twin: nice message\n');
  });

  it('prints Solari account errors as one line', async () => {
    const { io, stderr } = fakeIo();
    const credit = Object.assign(new Error('Insufficient credit balance.'), { name: 'PlanError' });
    expect(await main(['boom'], context(io), [failing(credit)])).toBe(1);
    expect(stderr.text).toBe('twin: Solari refused the request: Insufficient credit balance.\n');
  });

  it('prints the stack for unexpected errors', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['boom'], context(io), [failing(new Error('kaboom'))])).toBe(1);
    expect(stderr.text).toContain('twin: unexpected error\nError: kaboom');
  });
});
