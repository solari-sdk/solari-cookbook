import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backend/fake.ts';
import type { RunSpec } from '../../src/backend/types.ts';
import { type BisectEvent, bisect } from '../../src/bisect/bisect.ts';
import type { Capsule } from '../../src/capsule/schema.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import { makeCapsule } from '../helpers/capsule.ts';

const FAILURE = 'AssertionError: expected 1 to be 2';

/** Good passes; bad differs in TZ, NODE_ENV, CI, node version and working tree diff. */
function capsules(): { good: Capsule; bad: Capsule } {
  const base = makeCapsule();
  const repo = base.repo as NonNullable<Capsule['repo']>;
  const good = makeCapsule({
    command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
    runtimes: { node: '20.17.0' },
    env: { NODE_ENV: { state: 'set', value: 'test' }, CI: { state: 'set', value: 'true' } },
    locale: { timeZone: 'UTC', locale: 'en-IN' },
  });
  const bad = makeCapsule({
    command: {
      ...base.command,
      failure: { ...failureIdentity({ exitCode: 1, signal: null }, FAILURE), outputTail: FAILURE },
    },
    runtimes: { node: '22.3.0' },
    env: { NODE_ENV: { state: 'set', value: 'development' }, CI: { state: 'absent' } },
    locale: { timeZone: 'Asia/Kolkata', locale: 'en-IN' },
    repo: { ...repo, diff: '+changed\n', dirty: true },
    resolved: { node: { 'left-pad': ['1.4.0'] } },
  });
  return { good, bad };
}

interface World {
  tz: string | undefined;
  node22: boolean;
  diff: boolean;
  dependency: boolean;
  unsetCi: boolean;
}

const isCommand = (spec: RunSpec) => spec.argv.includes('exec "$@"');

/**
 * A fake machine whose command outcome is a function of the applied differences. Disk state (the
 * diff) persists across runs until the machine is reverted, like a real machine.
 */
function simulatedBackend(
  fails: (world: World) => boolean,
  overrides: (spec: RunSpec) => { exitCode: number; output?: string } | undefined = () => undefined,
) {
  let diffApplied = false;
  let dependencyInstalled = false;
  const backend = new FakeBackend((spec) => {
    const override = overrides(spec);
    if (override) return override;
    const text = spec.argv.join(' ');
    if (text.includes('git apply -R --whitespace=nowarn /tmp/twin/failing.diff'))
      diffApplied = false;
    else if (text.includes('git apply --whitespace=nowarn /tmp/twin/failing.diff'))
      diffApplied = true;
    if (text.includes('npm install --no-save')) dependencyInstalled = true;
    if (spec.argv.at(-1) === 'npm ci') dependencyInstalled = false;
    if (!isCommand(spec)) return undefined;
    const world: World = {
      tz: spec.env?.TZ,
      node22: spec.env?.PATH?.includes('node-22.3.0') ?? false,
      diff: diffApplied,
      dependency: dependencyInstalled,
      unsetCi: spec.argv[0] === 'env' && spec.argv.includes('CI'),
    };
    return fails(world) ? { exitCode: 1, output: FAILURE } : { exitCode: 0 };
  });
  return backend;
}

describe('bisect', () => {
  it('isolates a single time zone difference', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend((w) => w.tz === 'Asia/Kolkata');
    const events: BisectEvent['type'][] = [];
    const report = await bisect(good, bad, backend, { onEvent: (e) => events.push(e.type) });

    expect(report.verdict).toBe('found');
    expect(report.minimal).toEqual(['TZ=Asia/Kolkata']);
    expect(report.candidates).toEqual([
      'node 22.3.0',
      'left-pad@1.4.0',
      'unset CI',
      'NODE_ENV=development',
      'TZ=Asia/Kolkata',
      'working tree diff',
    ]);
    expect(report.trials[0]).toMatchObject({ atoms: [], result: 'pass' });
    expect(report.trials[1]).toMatchObject({ result: 'fail' });
    const [machine] = backend.machines;
    expect(machine?.killed).toBe(true);
    expect(events).toContain('trial-end');
  });

  it('needs no undo steps when every candidate is a process setting', async () => {
    const { good, bad } = capsules();
    bad.repo = { ...(bad.repo as NonNullable<Capsule['repo']>), diff: '', dirty: false };
    bad.resolved = good.resolved;
    const backend = simulatedBackend((w) => w.tz === 'Asia/Kolkata' && w.node22);
    const report = await bisect(good, bad, backend);
    expect(report.minimal.sort()).toEqual(['TZ=Asia/Kolkata', 'node 22.3.0']);
    // Only process settings changed, so no trial ran a setup or undo step.
    const setupSteps = (backend.machines[0]?.runs ?? []).filter((r) =>
      r.argv.join(' ').includes('failing.diff'),
    );
    expect(setupSteps).toEqual([]);
  });

  it('pre-installs the failing node version during setup', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend((w) => w.node22);
    const report = await bisect(good, bad, backend);
    expect(report.minimal).toEqual(['node 22.3.0']);
    expect(report.steps.map((s) => s.id)).toContain('stage-node');
  });

  it('finds an interacting pair', async () => {
    const { good, bad } = capsules();
    const report = await bisect(
      good,
      bad,
      simulatedBackend((w) => w.node22 && w.unsetCi),
    );
    expect(report.minimal.sort()).toEqual(['node 22.3.0', 'unset CI']);
  });

  it('undoes working tree trials with git', async () => {
    const { good, bad } = capsules();
    bad.resolved = good.resolved;
    const backend = simulatedBackend((w) => w.diff);
    const report = await bisect(good, bad, backend);
    expect(report.minimal).toEqual(['working tree diff']);
    expect(backend.machines[0]?.files.get('/tmp/twin/failing.diff')).toBe('+changed\n');
    expect(backend.machines[0]?.runs.some((r) => r.argv.join(' ').includes('git apply -R'))).toBe(
      true,
    );
  });

  it('reinstalls the good dependencies after dependency trials', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend((w) => w.dependency);
    const report = await bisect(good, bad, backend);
    expect(report.minimal).toEqual(['left-pad@1.4.0']);
    const installs = backend.machines[0]?.runs.filter((r) => r.argv.at(-1) === 'npm ci') ?? [];
    expect(installs.length).toBeGreaterThan(1);
  });

  it('stops instead of trusting later trials when an undo fails', async () => {
    const { good, bad } = capsules();
    bad.resolved = good.resolved;
    const backend = simulatedBackend(
      (w) => w.tz === 'Asia/Kolkata',
      (spec) => (spec.argv.join(' ').includes('--check') ? { exitCode: 1 } : undefined),
    );
    const report = await bisect(good, bad, backend);
    expect(report.verdict).toBe('reset-failed');
    expect(report.notes.at(-1)).toMatch(/Could not undo a trial \(restore good working tree\)/);
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('rethrows unexpected errors after releasing the machine', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend(() => false);
    const create = backend.create.bind(backend);
    backend.create = async (options) => {
      const machine = await create(options);
      const run = machine.run.bind(machine);
      machine.run = async (spec) => {
        if (spec.argv.includes('exec "$@"')) throw new Error('channel gone');
        return run(spec);
      };
      return machine;
    };
    await expect(bisect(good, bad, backend)).rejects.toThrow('channel gone');
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('reports a good world that fails on its own', async () => {
    const { good, bad } = capsules();
    const report = await bisect(
      good,
      bad,
      simulatedBackend(() => true),
    );
    expect(report.verdict).toBe('baseline-fails');
    expect(report.trials).toHaveLength(1);
  });

  it('reports when applying every difference does not reproduce', async () => {
    const { good, bad } = capsules();
    const report = await bisect(
      good,
      bad,
      simulatedBackend(() => false),
    );
    expect(report.verdict).toBe('not-reproduced');
    expect(report.trials).toHaveLength(2);
  });

  it('treats a different failure as unresolved, not as the bug', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend(
      () => false,
      (spec) =>
        isCommand(spec) && spec.env?.TZ === 'Asia/Kolkata'
          ? { exitCode: 1, output: 'TypeError: other' }
          : undefined,
    );
    const report = await bisect(good, bad, backend);
    expect(report.verdict).toBe('not-reproduced');
    expect(report.trials[1]?.result).toBe('unresolved');
  });

  it('marks a trial unresolved when its setup fails', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend(
      (w) => w.tz === 'Asia/Kolkata',
      (spec) => (spec.argv.join(' ').includes('failing.diff') ? { exitCode: 1 } : undefined),
    );
    const report = await bisect(good, bad, backend);
    expect(report.trials[1]).toMatchObject({ result: 'unresolved', attempts: [] });
    expect(report.verdict).toBe('not-reproduced');
  });

  it('stops when the good world cannot be built', async () => {
    const { good, bad } = capsules();
    const backend = simulatedBackend(
      () => false,
      (spec) => (spec.argv.at(-1) === 'npm ci' ? { exitCode: 1, output: 'npm ERR!' } : undefined),
    );
    const report = await bisect(good, bad, backend);
    expect(report.verdict).toBe('setup-failed');
    expect(report.trials).toEqual([]);
    expect(backend.machines[0]?.killed).toBe(true);
  });

  it('does not start a machine when there is nothing to vary', async () => {
    const base = makeCapsule();
    const good = makeCapsule({
      command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
    });
    const backend = new FakeBackend();
    const report = await bisect(good, makeCapsule(), backend);
    expect(report.verdict).toBe('no-candidates');
    expect(backend.machines).toEqual([]);
  });

  it('requires every attempt of a trial to fail the captured way', async () => {
    const { good, bad } = capsules();
    let runs = 0;
    const backend = simulatedBackend(
      () => false,
      (spec) =>
        isCommand(spec) && spec.env?.TZ === 'Asia/Kolkata'
          ? runs++ % 2 === 0
            ? { exitCode: 1, output: FAILURE }
            : { exitCode: 0 }
          : undefined,
    );
    const report = await bisect(good, bad, backend, { attempts: 2 });
    expect(report.trials[1]).toMatchObject({ result: 'unresolved' });
    expect(report.trials[1]?.attempts).toHaveLength(2);
  });
});
