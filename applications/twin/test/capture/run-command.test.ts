import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/capture/run-command.ts';
import { TailBuffer } from '../../src/capture/tail-buffer.ts';
import { TwinError } from '../../src/errors.ts';
import { MemoryOutput } from '../helpers/fakes.ts';

const node = (script: string) => [process.execPath, '-e', script];

describe('TailBuffer', () => {
  it('returns the last lines', () => {
    const tail = new TailBuffer(1000);
    tail.append('a\nb\n');
    tail.append('c\nd\n');
    expect(tail.tail(2)).toBe('c\nd');
  });

  it('bounds memory and drops the partial line left by the cut', () => {
    const tail = new TailBuffer(10);
    for (let i = 0; i < 50; i++) tail.append(`line-${i}\n`);
    expect(tail.tail(100)).toBe('line-49');
  });

  it('handles output without a trailing newline', () => {
    const tail = new TailBuffer(100);
    tail.append('only');
    expect(tail.tail(5)).toBe('only');
  });
});

describe('runCommand', () => {
  const run = (argv: string[], env: NodeJS.ProcessEnv = process.env) => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const result = runCommand(argv, { cwd: process.cwd(), env, stdout, stderr });
    return { result, stdout, stderr };
  };

  it('passes output through live and records an interleaved tail', async () => {
    const { result, stdout, stderr } = run(
      node('console.log("out"); console.error("err"); process.exit(3)'),
    );
    const { exitCode, signal, outputTail, durationMs } = await result;
    expect(exitCode).toBe(3);
    expect(signal).toBeNull();
    expect(stdout.text).toBe('out\n');
    expect(stderr.text).toBe('err\n');
    expect(outputTail.split('\n').sort()).toEqual(['err', 'out']);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs with exactly the given environment', async () => {
    const { result, stdout } = run(node('console.log(process.env.ONLY_THIS)'), {
      ...process.env,
      ONLY_THIS: 'yes',
    });
    await result;
    expect(stdout.text).toBe('yes\n');
  });

  it('keeps multi-byte characters split across chunks intact', async () => {
    const { result } = run(
      node(
        'process.stdout.write(Buffer.from([0xe2, 0x9c])); setTimeout(() => process.stdout.write(Buffer.from([0x93, 0x0a])), 20)',
      ),
    );
    expect((await result).outputTail).toBe('✓');
  });

  it('reports a signal instead of an exit code when killed', async () => {
    const { result } = run(node('process.kill(process.pid, "SIGTERM")'));
    expect(await result).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
  });

  it('turns a missing executable into a TwinError with exit code 127', async () => {
    const { result } = run(['definitely-not-a-real-command-xyz']);
    await expect(result).rejects.toThrow(TwinError);
    await expect(result).rejects.toMatchObject({ exitCode: 127 });
  });

  it('rejects an empty command', () => {
    expect(() =>
      runCommand([], {
        cwd: '.',
        env: {},
        stdout: new MemoryOutput(),
        stderr: new MemoryOutput(),
      }),
    ).toThrow('no command given');
  });
});
