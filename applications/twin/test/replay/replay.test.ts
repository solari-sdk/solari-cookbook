import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeRunResult } from '../../src/backend/fake.ts';
import type { RunSpec } from '../../src/backend/types.ts';
import { type ReplayEvent, replay } from '../../src/replay/replay.ts';
import { classify, describeAttempt, matchesSignature } from '../../src/replay/verdict.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import { makeCapsule } from '../helpers/capsule.ts';

const FAILURE_OUTPUT =
  'FAIL /tmp/twin/repo/src/date.test.ts (41ms)\nAssertionError: expected 1 to be 2';
// The reporter saw the same failure at a different path and duration.
const REPORTER_OUTPUT =
  'FAIL ~/code/app/src/date.test.ts (12ms)\nAssertionError: expected 1 to be 2';

function capsuleFailingWith(output: string) {
  const base = makeCapsule();
  return makeCapsule({
    command: {
      ...base.command,
      failure: { ...failureIdentity({ exitCode: 1, signal: null }, output), outputTail: output },
    },
  });
}

const isCommand = (spec: RunSpec) => spec.argv[0] === 'sh' && spec.argv[2] === 'exec "$@"';

function backendWhere(
  command: (attempt: number) => FakeRunResult,
  setup: (spec: RunSpec) => FakeRunResult | undefined = () => undefined,
) {
  let attempt = 0;
  return new FakeBackend((spec) => (isCommand(spec) ? command(attempt++) : setup(spec)));
}

describe('replay', () => {
  it('reproduces a failure seen at a different path and releases the machine', async () => {
    const backend = backendWhere(() => ({ exitCode: 1, output: FAILURE_OUTPUT }));
    const events: ReplayEvent['type'][] = [];
    const report = await replay(capsuleFailingWith(REPORTER_OUTPUT), backend, {
      onEvent: (e) => events.push(e.type),
    });

    expect(report.verdict).toBe('reproduced');
    expect(report.attempts).toHaveLength(3);
    expect(report.steps.every((step) => step.ok)).toBe(true);
    const [machine] = backend.machines;
    expect(machine?.killed).toBe(true);
    expect(machine?.options.labels).toEqual({ app: 'twin', run: report.runId });
    expect(machine?.options.idleTimeoutMs).toBe(15 * 60_000);
    expect(events[0]).toBe('machine');
    expect(events).toContain('attempt-end');
  });

  it('runs setup and the command with the planned env and cwd', async () => {
    const backend = backendWhere(() => ({ exitCode: 1, output: FAILURE_OUTPUT }));
    await replay(capsuleFailingWith(REPORTER_OUTPUT), backend, { attempts: 1 });
    const runs = backend.machines[0]?.runs ?? [];
    const command = runs.find(isCommand);
    expect(command?.cwd).toBe('/tmp/twin/repo');
    expect(command?.env?.NODE_ENV).toBe('test');
    expect(runs.every((run) => run.env?.PATH?.startsWith('/tmp/twin/tools/node-22.3.0/bin'))).toBe(
      true,
    );
  });

  it('keeps a reproduced failure running when asked', async () => {
    const backend = backendWhere(() => ({ exitCode: 1, output: FAILURE_OUTPUT }));
    const report = await replay(capsuleFailingWith(REPORTER_OUTPUT), backend, {
      keep: true,
      attempts: 1,
    });
    expect(report.kept).toBe(true);
    const [machine] = backend.machines;
    expect(machine?.killed).toBe(false);
    expect(machine?.detached).toBe(true);
    // The kept machine carries the reporter's env and entry points for `twin shell` and agents.
    expect(machine?.files.get('/tmp/twin/env.sh')).toContain('export NODE_ENV=test');
    expect(machine?.files.get('/tmp/twin/shell.sh')).toContain('. /tmp/twin/env.sh');
    expect(machine?.files.get('/tmp/twin/run.sh')).toContain('cd /tmp/twin/repo');
    expect(machine?.runs.at(-1)?.argv).toEqual([
      'chmod',
      '+x',
      '/tmp/twin/shell.sh',
      '/tmp/twin/run.sh',
    ]);
  });

  it('does not keep machines that did not reproduce', async () => {
    const backend = backendWhere(() => ({ exitCode: 0 }));
    const report = await replay(capsuleFailingWith(REPORTER_OUTPUT), backend, { keep: true });
    expect(report.verdict).toBe('not-reproduced');
    expect(report.kept).toBe(false);
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('stops at a failed required step and reports its output', async () => {
    const backend = backendWhere(
      () => ({ exitCode: 1 }),
      (spec) =>
        spec.argv.at(-1) === 'npm ci'
          ? { exitCode: 1, output: 'npm ERR! lockfile mismatch' }
          : undefined,
    );
    const report = await replay(capsuleFailingWith(REPORTER_OUTPUT), backend);
    expect(report.verdict).toBe('inconclusive');
    expect(report.attempts).toEqual([]);
    expect(report.steps.at(-1)).toMatchObject({
      id: 'dependencies',
      ok: false,
      exitCode: 1,
      outputTail: 'npm ERR! lockfile mismatch',
    });
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('continues past a failed optional step with a note', async () => {
    const base = makeCapsule();
    const capsule = capsuleFailingWith(REPORTER_OUTPUT);
    capsule.repo = { ...(base.repo as NonNullable<typeof base.repo>), diff: '+x\n' };
    const backend = backendWhere(
      () => ({ exitCode: 1, output: FAILURE_OUTPUT }),
      (spec) => (spec.argv[0] === 'git' && spec.argv[1] === 'apply' ? { exitCode: 1 } : undefined),
    );
    const report = await replay(capsule, backend, { attempts: 1 });
    expect(backend.machines[0]?.files.get('/tmp/twin/capsule.diff')).toBe('+x\n');
    expect(report.notes).toContain('Optional step failed: apply working-tree diff.');
    expect(report.verdict).toBe('reproduced');
  });

  it('releases the machine even when a step throws', async () => {
    const backend = new FakeBackend((spec) => {
      if (spec.argv[0] === 'mkdir') throw new Error('control channel dropped');
      return undefined;
    });
    await expect(replay(capsuleFailingWith(REPORTER_OUTPUT), backend)).rejects.toThrow(
      'control channel dropped',
    );
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('notes a release failure instead of hiding the result', async () => {
    const backend = backendWhere(() => ({ exitCode: 0 }));
    const create = backend.create.bind(backend);
    backend.create = async (options) => {
      const machine = await create(options);
      machine.kill = async () => {
        throw new Error('503');
      };
      return machine;
    };
    const report = await replay(capsuleFailingWith(REPORTER_OUTPUT), backend, { attempts: 1 });
    expect(report.notes.at(-1)).toMatch(/Could not release sbx_fake0 .*twin stop/);
  });
});

describe('classify', () => {
  const capsule = capsuleFailingWith(REPORTER_OUTPUT);
  const fail = (output = FAILURE_OUTPUT, exitCode = 1) =>
    describeAttempt({ exitCode, timedOut: false, durationMs: 1, output });
  const pass = () => describeAttempt({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' });

  it.each([
    ['reproduced', [fail(), fail()]],
    ['not-reproduced', [pass(), pass()]],
    ['different-failure', [fail('TypeError: nope'), fail('TypeError: nope')]],
    ['flaky', [fail(), pass()]],
    ['inconclusive', []],
    [
      'inconclusive',
      [describeAttempt({ exitCode: null, timedOut: true, durationMs: 1, output: '' })],
    ],
  ] as const)('%s', (verdict, attempts) => {
    expect(classify(capsule, attempts)).toBe(verdict);
  });

  it('treats a passing capsule reproduced by passing attempts', () => {
    const base = makeCapsule();
    const passing = makeCapsule({
      command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
    });
    expect(classify(passing, [pass()])).toBe('reproduced');
    expect(classify(passing, [fail()])).toBe('different-failure');
  });

  it('fingerprints the same output window capture keeps', () => {
    const noise = Array.from({ length: 300 }, (_, i) => `Error: early noise ${i}`).join('\n');
    const tail = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const whole = fail(`${noise}\n${tail}\n`);
    expect(whole).toEqual(fail(tail));
  });

  it('matches a captured signal death reported by the guest as exit 128+n', () => {
    const digest = 'abcdef0123456789';
    expect(matchesSignature(`SIGSEGV:${digest}`, `exit139:${digest}`)).toBe(true);
    expect(matchesSignature(`SIGSEGV:${digest}`, `exit1:${digest}`)).toBe(false);
    expect(matchesSignature(`exit1:${digest}`, `exit129:${digest}`)).toBe(false);
  });

  it('scrubs guest output before fingerprinting', () => {
    const token = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    expect(fail(`Error: bad token ${token}`).keyLines).toEqual([
      'Error: bad token <redacted:github-token>',
    ]);
  });
});
