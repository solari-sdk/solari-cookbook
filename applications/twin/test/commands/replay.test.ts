import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backend/fake.ts';
import { writeCapsule } from '../../src/capsule/file.ts';
import { main } from '../../src/cli.ts';
import { parseEnvAssignments } from '../../src/commands/options.ts';
import type { ReplayReport } from '../../src/replay/replay.ts';
import { renderReplay, shortId } from '../../src/report/replay.ts';
import { createStyle } from '../../src/report/style.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { fakeHost, fakeIo, useTempDirs } from '../helpers/fakes.ts';

const OUTPUT = 'AssertionError: expected 1 to be 2';

async function setup(backend: FakeBackend) {
  const dir = await useTempDir();
  const base = makeCapsule();
  await writeCapsule(
    join(dir, 'bug.json'),
    makeCapsule({
      command: {
        ...base.command,
        failure: { ...failureIdentity({ exitCode: 1, signal: null }, OUTPUT), outputTail: OUTPUT },
      },
    }),
  );
  const { io, stdout, stderr } = fakeIo();
  const context = { io, host: fakeHost(), cwd: dir, version: 't', getBackend: async () => backend };
  return { context, stdout, stderr, dir };
}

let useTempDir: () => Promise<string>;

describe('twin replay', () => {
  useTempDir = useTempDirs();
  const failing = () =>
    new FakeBackend((spec) =>
      spec.argv[2] === 'exec "$@"' ? { exitCode: 1, output: OUTPUT } : undefined,
    );

  it('exits 0 and prints the report when the failure reproduces', async () => {
    const { context, stdout, stderr } = await setup(failing());
    expect(await main(['replay', 'bug.json', '--attempts', '2'], context)).toBe(0);
    expect(stdout.text).toContain('REPRODUCED');
    expect(stdout.text).toContain('Replay on fake');
    expect(stderr.text).toContain('twin: attempt 2/2');
    expect(stderr.text).toContain('twin: install node 22.3.0');
  });

  it('exits 1 when it does not reproduce, and streams output with --verbose', async () => {
    const backend = new FakeBackend(() => ({ exitCode: 0, output: 'guest says hi\n' }));
    const { context, stdout, stderr } = await setup(backend);
    expect(await main(['replay', 'bug.json', '-v', '--attempts', '1'], context)).toBe(1);
    expect(stdout.text).toContain('NOT REPRODUCED');
    expect(stderr.text).toContain('guest says hi');
  });

  it('prints JSON and passes options through', async () => {
    const backend = failing();
    const { context, stdout } = await setup(backend);
    const code = await main(
      [
        'replay',
        'bug.json',
        '--json',
        '--attempts',
        '1',
        '--keep',
        '--env',
        'API_TOKEN=x',
        '--repo',
        'https://e.com/f.git',
        '--timeout',
        '2',
      ],
      context,
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout.text) as ReplayReport;
    expect(report).toMatchObject({ verdict: 'reproduced', kept: true, backend: 'fake' });
    const runs = backend.machines[0]?.runs ?? [];
    expect(runs.find((run) => run.argv[2] === 'exec "$@"')).toMatchObject({
      timeoutMs: 120_000,
      env: { API_TOKEN: 'x' },
    });
    expect(runs.some((run) => run.argv.join(' ').includes('https://e.com/f.git'))).toBe(true);
  });

  it.each([
    [['replay'], 'expected one capsule path'],
    [['replay', 'bug.json', '--attempts', '0'], '--attempts expects a positive whole number'],
    [['replay', 'bug.json', '--timeout', 'soon'], '--timeout expects a positive whole number'],
    [['replay', 'bug.json', '--env', 'NOPE'], '--env expects NAME=value'],
  ])('rejects %j', async (argv, message) => {
    const { context, stderr } = await setup(failing());
    expect(await main(argv, context)).toBe(2);
    expect(stderr.text).toContain(message);
  });

  it('prints help', async () => {
    const { context, stdout } = await setup(failing());
    expect(await main(['replay', '--help'], context)).toBe(0);
    expect(stdout.text).toContain('Usage: twin replay');
  });
});

describe('twin stop and twin list', () => {
  async function machines() {
    const backend = new FakeBackend();
    await backend.create({ labels: { app: 'twin', run: 'aaa' }, idleTimeoutMs: 1 });
    await backend.create({ labels: { app: 'twin', run: 'bbb' }, idleTimeoutMs: 1 });
    await backend.create({ labels: { app: 'other' }, idleTimeoutMs: 1 });
    const { io, stdout } = fakeIo();
    const context = {
      io,
      host: fakeHost(),
      cwd: '/',
      version: 't',
      getBackend: async () => backend,
    };
    return { backend, context, stdout };
  }

  it('stops every twin machine, and nothing else', async () => {
    const { backend, context, stdout } = await machines();
    expect(await main(['stop'], context)).toBe(0);
    expect(stdout.text).toBe('Stopped 2 machines\n  sbx_fake0\n  sbx_fake1\n');
    expect(backend.machines[2]?.killed).toBe(false);
    stdout.text = '';
    expect(await main(['stop'], context)).toBe(0);
    expect(stdout.text).toBe('No twin machines running.\n');
  });

  it('stops one machine by id prefix', async () => {
    const { backend, context, stdout } = await machines();
    expect(await main(['stop', 'sbx_fake1'], context)).toBe(0);
    expect(stdout.text).toBe('Stopped 1 machine\n  sbx_fake1\n');
    expect(backend.machines.map((m) => m.killed)).toEqual([false, true, false]);
  });

  it('keeps gc as an alias', async () => {
    const { context, stdout } = await machines();
    expect(await main(['gc'], context)).toBe(0);
    expect(stdout.text).toContain('Stopped 2 machines');
  });

  it('lists running twin machines', async () => {
    const { context, stdout } = await machines();
    expect(await main(['list'], context)).toBe(0);
    expect(stdout.text).toContain(
      'MACHINE    RUN  STATE\nsbx_fake0  aaa  running\nsbx_fake1  bbb  running\n',
    );
    expect(stdout.text).toContain('twin shell <machine>');
    stdout.text = '';
    expect(await main(['ls', '--json'], context)).toBe(0);
    expect(JSON.parse(stdout.text)).toHaveLength(2);
    await main(['stop'], context);
    stdout.text = '';
    expect(await main(['list'], context)).toBe(0);
    expect(stdout.text).toBe('No twin machines running.\n');
  });

  it('prints help', async () => {
    const { context, stdout } = await machines();
    expect(await main(['stop', '-h'], context)).toBe(0);
    expect(await main(['list', '-h'], context)).toBe(0);
    expect(stdout.text).toContain('Usage: twin stop');
    expect(stdout.text).toContain('Usage: twin list');
  });
});

describe('parseEnvAssignments', () => {
  it('splits on the first equals sign', () => {
    expect(parseEnvAssignments(['A=1', 'B=x=y', 'C='])).toEqual({ A: '1', B: 'x=y', C: '' });
  });
});

describe('shortId', () => {
  it('shortens long provider ids only', () => {
    expect(shortId(null)).toBe('-');
    expect(shortId('sbx_1')).toBe('sbx_1');
    expect(shortId('A'.repeat(200))).toBe(`${'A'.repeat(16)}…`);
  });
});

describe('renderReplay', () => {
  const plain = createStyle(false);
  const report = (overrides: Partial<ReplayReport>): ReplayReport => ({
    verdict: 'reproduced',
    runId: 'r1',
    backend: 'fake',
    machineId: 'sbx_1',
    kept: false,
    expected: { outcome: 'fail', signature: 'exit1:aaaa', keyLines: ['Error: a'] },
    steps: [],
    attempts: [],
    notes: [],
    ...overrides,
  });

  it('shows steps, failed step output, attempts and the verdict', () => {
    const text = renderReplay(
      report({
        verdict: 'different-failure',
        steps: [
          {
            id: 'node',
            title: 'install node 22',
            ok: true,
            optional: false,
            durationMs: 1500,
            exitCode: 0,
            outputTail: null,
          },
          {
            id: 'diff',
            title: 'apply diff',
            ok: false,
            optional: true,
            durationMs: 100,
            exitCode: 1,
            outputTail: 'patch failed',
          },
        ],
        attempts: [
          {
            exitCode: 2,
            timedOut: false,
            durationMs: 900,
            outcome: 'fail',
            signature: 'exit2:bbbb',
            keyLines: ['Error: b'],
          },
          {
            exitCode: null,
            timedOut: true,
            durationMs: 900,
            outcome: 'fail',
            signature: 'exit?:cccc',
            keyLines: [],
          },
        ],
        notes: ['something'],
      }),
      plain,
    );
    expect(text).toContain('Replay on fake (machine sbx_1, run r1)');
    expect(text).toContain('  ✓ install node 22  1.5s');
    expect(text).toContain('  ! apply diff (exit 1)  0.1s\n      patch failed');
    expect(text).toContain('  1  FAIL exit 2  exit2:bbbb  0.9s');
    expect(text).toContain('  2  TIMEOUT  exit?:cccc  0.9s');
    expect(text).toContain('expected  FAIL exit1:aaaa');
    expect(text).toContain('Key lines here\n  Error: b\nKey lines in capsule\n  Error: a');
    expect(text).toContain('DIFFERENT FAILURE');
    expect(text).toContain('Notes\n  - something');
  });

  it('names why a run is inconclusive', () => {
    const step = (title: string) => ({
      id: 's',
      title,
      ok: false,
      optional: false,
      durationMs: 1,
      exitCode: 1,
      outputTail: 'boom',
    });
    const attempt = {
      exitCode: null,
      timedOut: true,
      durationMs: 1,
      outcome: 'fail' as const,
      signature: 'exit?:c',
      keyLines: [],
    };
    const render = (overrides: Partial<ReplayReport>, verify = false) =>
      renderReplay(report({ verdict: 'inconclusive', ...overrides }), plain, { verify });
    expect(render({ steps: [step('npm ci')] })).toContain(
      'INCONCLUSIVE: "npm ci" failed, so the command never ran (output above).',
    );
    expect(render({ attempts: [attempt] })).toContain(
      'INCONCLUSIVE: attempt 1 timed out (raise --timeout).',
    );
    expect(render({}, true)).toContain('INCONCLUSIVE: setup failed (does the fix apply?)');

    const install = {
      ...step('install dependencies (npm ci)'),
      id: 'dependencies',
      outputTail:
        'npm error The `npm ci` command can only install with an existing package-lock.json',
    };
    expect(render({ steps: [install] })).toContain(
      'The repository has no committed lockfile, and replay installs from the committed one.',
    );
    expect(render({ steps: [{ ...install, outputTail: 'ENOSPC' }] })).not.toContain(
      'committed lockfile',
    );
  });

  it('explains kept machines and passing attempts', () => {
    const text = renderReplay(
      report({
        kept: true,
        expected: { outcome: 'pass', signature: null, keyLines: [] },
        attempts: [
          {
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            outcome: 'pass',
            signature: null,
            keyLines: [],
          },
        ],
        steps: [
          {
            id: 'x',
            title: 'setup',
            ok: false,
            optional: false,
            durationMs: 1,
            exitCode: null,
            outputTail: null,
          },
        ],
      }),
      plain,
    );
    expect(text).toContain('✗ setup (exit timeout)');
    expect(text).toContain('  1  PASS  0.0s');
    expect(text).toContain('expected  PASS');
    expect(text).toContain("still running at the failure, in the reporter's environment");
    expect(text).toContain('twin shell sbx_1         open a terminal on it');
    expect(text).toContain('twin shell sbx_1 --web');
    expect(text).toContain('It is billed while running');
  });

  it.each(['not-reproduced', 'flaky', 'inconclusive'] as const)('renders %s', (verdict) => {
    expect(renderReplay(report({ verdict, machineId: null }), plain)).toContain('machine -');
  });
});
