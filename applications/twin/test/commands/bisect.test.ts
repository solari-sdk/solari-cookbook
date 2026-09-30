import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backend/fake.ts';
import type { BisectReport } from '../../src/bisect/bisect.ts';
import { writeCapsule } from '../../src/capsule/file.ts';
import type { Capsule } from '../../src/capsule/schema.ts';
import { main } from '../../src/cli.ts';
import { renderBisect } from '../../src/report/bisect.ts';
import { createStyle } from '../../src/report/style.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { fakeHost, fakeIo, useTempDirs } from '../helpers/fakes.ts';

const FAILURE = 'AssertionError: expected -330 to be 0';

function pair(): { good: Capsule; bad: Capsule } {
  const base = makeCapsule();
  return {
    good: makeCapsule({
      command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
      locale: { timeZone: 'UTC', locale: 'en-IN' },
      env: { ...base.env, NODE_ENV: { state: 'set', value: 'production' } },
    }),
    bad: makeCapsule({
      command: {
        ...base.command,
        failure: {
          ...failureIdentity({ exitCode: 1, signal: null }, FAILURE),
          outputTail: FAILURE,
        },
      },
    }),
  };
}

const tzBackend = () =>
  new FakeBackend((spec) =>
    spec.argv.includes('exec "$@"')
      ? spec.env?.TZ === 'Asia/Kolkata'
        ? { exitCode: 1, output: FAILURE }
        : { exitCode: 0, output: 'ok\n' }
      : undefined,
  );

describe('twin bisect', () => {
  const tempDir = useTempDirs();

  async function setup(backend: FakeBackend) {
    const dir = await tempDir();
    const { good, bad } = pair();
    await writeCapsule(join(dir, 'good.json'), good);
    await writeCapsule(join(dir, 'bad.json'), bad);
    const { io, stdout, stderr } = fakeIo();
    const context = {
      io,
      host: fakeHost(),
      cwd: dir,
      version: 't',
      getBackend: async () => backend,
    };
    return { context, stdout, stderr };
  }

  it('reports the minimal difference and exits 0', async () => {
    const { context, stdout, stderr } = await setup(tzBackend());
    expect(await main(['bisect', 'bad.json', '--good', 'good.json'], context)).toBe(0);
    expect(stdout.text).toContain('Minimal failing difference:\n  TZ=Asia/Kolkata');
    expect(stderr.text).toContain('twin: trial 1: good environment');
    expect(stderr.text).toContain('  -> fail');
  });

  it('prints JSON and streams output when asked', async () => {
    const { context, stdout, stderr } = await setup(tzBackend());
    const code = await main(
      [
        'bisect',
        'bad.json',
        '--good',
        'good.json',
        '--json',
        '-v',
        '--attempts',
        '2',
        '--timeout',
        '1',
        '--env',
        'API_TOKEN=x',
      ],
      context,
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout.text) as BisectReport;
    expect(report).toMatchObject({ verdict: 'found', minimal: ['TZ=Asia/Kolkata'] });
    expect(report.trials[0]?.attempts).toHaveLength(2);
    expect(stderr.text).toContain('ok');
  });

  it('exits 1 when nothing is found', async () => {
    const backend = new FakeBackend(() => ({ exitCode: 0 }));
    const { context, stdout } = await setup(backend);
    expect(await main(['bisect', 'bad.json', '--good', 'good.json'], context)).toBe(1);
    expect(stdout.text).toContain('NOT REPRODUCED');
  });

  it.each([
    [['bisect', 'bad.json'], 'expected one failing capsule and --good'],
    [['bisect', '--good', 'good.json'], 'expected one failing capsule and --good'],
    [['bisect', 'bad.json', '--good', 'good.json', '--attempts', 'x'], '--attempts expects'],
  ])('rejects %j', async (argv, message) => {
    const { context, stderr } = await setup(tzBackend());
    expect(await main(argv, context)).toBe(2);
    expect(stderr.text).toContain(message);
  });

  it('prints help', async () => {
    const { context, stdout } = await setup(tzBackend());
    expect(await main(['bisect', '-h'], context)).toBe(0);
    expect(stdout.text).toContain('Usage: twin bisect');
  });
});

describe('renderBisect', () => {
  const plain = createStyle(false);
  const report = (overrides: Partial<BisectReport>): BisectReport => ({
    verdict: 'found',
    runId: 'r1',
    backend: 'fake',
    machineId: 'sbx_1',
    minimal: ['TZ=Asia/Kolkata'],
    candidates: ['TZ=Asia/Kolkata', 'node 22.3.0'],
    skipped: [],
    steps: [
      {
        id: 'node',
        title: 'install node',
        ok: true,
        optional: false,
        durationMs: 2000,
        exitCode: 0,
        outputTail: null,
      },
    ],
    trials: [
      { atoms: [], result: 'pass', attempts: [], durationMs: 500 },
      { atoms: ['TZ=Asia/Kolkata', 'node 22.3.0'], result: 'fail', attempts: [], durationMs: 500 },
      { atoms: ['node 22.3.0'], result: 'unresolved', attempts: [], durationMs: 500 },
    ],
    expectedSignature: 'exit1:x',
    notes: [],
    ...overrides,
  });

  it('shows candidates, every trial and the minimal set', () => {
    const text = renderBisect(report({}), plain);
    expect(text).toContain('Bisect on fake (machine sbx_1, run r1)');
    expect(text).toContain('good environment built in 2.0s (1 steps)');
    expect(text).toContain('Candidates (2)\n  TZ=Asia/Kolkata\n  node 22.3.0');
    expect(text).toContain('   1  pass  (good environment)  0.5s');
    expect(text).toContain('   2  FAIL  TZ=Asia/Kolkata + node 22.3.0  0.5s');
    expect(text).toContain('   3  ????  node 22.3.0');
    expect(text).toContain('Minimal failing difference:\n  TZ=Asia/Kolkata\nApplying it');
  });

  it('lists the smallest trials that failed differently', () => {
    const failed = (signature: string) => ({
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      outcome: 'fail' as const,
      signature,
      keyLines: [],
    });
    const text = renderBisect(
      report({
        minimal: ['node 26.7.0', 'TZ=Asia/Kolkata'],
        trials: [
          { atoms: ['a', 'b'], result: 'unresolved', attempts: [failed('exit1:x')], durationMs: 1 },
          {
            atoms: ['TZ=Asia/Kolkata'],
            result: 'unresolved',
            attempts: [failed('exit1:y')],
            durationMs: 1,
          },
          {
            atoms: ['flaky'],
            result: 'unresolved',
            attempts: [failed('exit1:y'), failed('exit1:z')],
            durationMs: 1,
          },
          { atoms: ['broken setup'], result: 'unresolved', attempts: [], durationMs: 1 },
        ],
      }),
      plain,
    );
    expect(text).toContain('Also failing, but not the captured way');
    expect(text).toMatch(/signature, e\.g\.[^\n]*\)\n {2}TZ=Asia\/Kolkata\n {2}a \+ b/);
    const section = text.slice(text.indexOf('Also failing'));
    expect(section).not.toContain('flaky');
    expect(section).not.toContain('broken setup');
  });

  it('explains a multi-item minimal set', () => {
    const text = renderBisect(report({ minimal: ['a', 'b'] }), plain);
    expect(text).toContain('removing any one of them makes it pass');
  });

  it('shows setup failures, skipped differences and notes', () => {
    const text = renderBisect(
      report({
        verdict: 'setup-failed',
        steps: [
          {
            id: 'deps',
            title: 'install dependencies',
            ok: false,
            optional: false,
            durationMs: 1,
            exitCode: 1,
            outputTail: 'npm ERR!',
          },
        ],
        trials: [],
        skipped: [{ category: 'os', key: 'platform', reason: 'cannot vary' }],
        notes: ['a note'],
      }),
      plain,
    );
    expect(text).toContain('✗ install dependencies (exit 1)\n      npm ERR!');
    expect(text).toContain('SETUP FAILED');
    expect(text).toContain('Not varied (1)\n  platform: cannot vary');
    expect(text).toContain('Notes\n  - a note');
  });

  it.each(['no-candidates', 'baseline-fails', 'reset-failed', 'not-reproduced'] as const)(
    'renders %s',
    (verdict) => {
      expect(
        renderBisect(report({ verdict, steps: [], candidates: [], trials: [] }), plain),
      ).toMatch(/^Bisect on fake/);
    },
  );
});
