import { describe, expect, it } from 'vitest';
import type { Atom } from '../../src/bisect/atoms.ts';
import { BAD_DIFF_PATH, planTrial, type TrialBase } from '../../src/bisect/trial.ts';
import { CAPSULE_DIFF_PATH } from '../../src/replay/runtimes.ts';

const base: TrialBase = {
  env: { PATH: '/tmp/twin/tools/node-20.17.0/bin:/usr/bin', NODE_ENV: 'test', CI: 'true' },
  argv: ['npm', 'test'],
  dependencyDir: '/tmp/twin/repo',
  repoDir: '/tmp/twin/repo',
  goodDiff: false,
  reinstall: {
    kind: 'run',
    id: 'dependencies',
    title: 'install dependencies (npm ci)',
    argv: ['npm', 'ci'],
    cwd: '/tmp/twin/repo',
    timeoutMs: 1,
  },
};
const COMMAND = ['sh', '-c', 'exec "$@"', 'twin', 'npm', 'test'];
const GOOD_APPLY = `git apply --whitespace=nowarn ${CAPSULE_DIFF_PATH}`;
const BAD_APPLY = `git apply --whitespace=nowarn ${BAD_DIFF_PATH}`;
const reversed = (command: string) => command.replace('git apply', 'git apply -R');
const ifApplied = (command: string) =>
  `if ${reversed(command)} --check 2>/dev/null; then ${reversed(command)}; fi`;
const ifMissing = (command: string) =>
  `if ! ${reversed(command)} --check 2>/dev/null; then ${command}; fi`;

const env = (name: string, value: string | null): Atom => ({
  kind: 'env',
  id: `env:${name}`,
  label: name,
  name,
  value,
});
const diff = (text: string): Atom => ({ kind: 'diff', id: 'diff', label: 'diff', diff: text });
const dep = (name: string, version: string): Atom => ({
  kind: 'dependency',
  id: `dep:${name}`,
  label: `${name}@${version}`,
  name,
  version,
});

describe('planTrial', () => {
  it('runs the good world unchanged for an empty subset', () => {
    expect(planTrial([], base)).toEqual({
      steps: [],
      env: base.env,
      argv: COMMAND,
      undo: [],
    });
  });

  it('sets and unsets variables without touching disk', () => {
    const trial = planTrial([env('TZ', 'Asia/Kolkata'), env('CI', null)], base);
    expect(trial.env).toEqual({ PATH: base.env.PATH, NODE_ENV: 'test', TZ: 'Asia/Kolkata' });
    expect(trial.argv).toEqual(['env', '-u', 'CI', ...COMMAND]);
    expect(trial.undo).toEqual([]);
  });

  it('switches node by PATH to the pre-installed failing version', () => {
    const node: Atom = {
      kind: 'node',
      id: 'node',
      label: 'node 22.3.0',
      version: '22.3.0',
      goodVersion: '20.17.0',
    };
    expect(planTrial([node], base).env.PATH).toBe('/tmp/twin/tools/node-22.3.0/bin:/usr/bin');
    const noGoodNode: Atom = { ...node, goodVersion: null };
    expect(planTrial([noGoodNode], { ...base, env: { PATH: '/usr/bin' } }).env.PATH).toBe(
      '/tmp/twin/tools/node-22.3.0/bin:/usr/bin',
    );
  });

  it('swaps the good diff for the failing one and undoes it idempotently with git', () => {
    const trial = planTrial([diff('+bug\n')], { ...base, goodDiff: true });
    expect(trial.steps).toEqual([
      {
        kind: 'write',
        id: 'trial-diff-file',
        title: 'upload failing working tree diff',
        path: BAD_DIFF_PATH,
        content: '+bug\n',
      },
      expect.objectContaining({
        id: 'trial-diff',
        argv: ['sh', '-euc', `${reversed(GOOD_APPLY)}\n${BAD_APPLY}`],
        cwd: '/tmp/twin/repo',
      }),
    ]);
    expect(trial.undo).toEqual([
      expect.objectContaining({
        id: 'trial-diff-undo',
        argv: ['sh', '-euc', `${ifApplied(BAD_APPLY)}\n${ifMissing(GOOD_APPLY)}`],
      }),
    ]);
  });

  it('only removes the good diff when the failing side had none', () => {
    const trial = planTrial([diff('')], { ...base, goodDiff: true });
    expect(trial.steps).toEqual([
      expect.objectContaining({ argv: ['sh', '-euc', reversed(GOOD_APPLY)] }),
    ]);
    expect(trial.undo).toMatchObject([{ argv: ['sh', '-euc', ifMissing(GOOD_APPLY)] }]);
  });

  it('only adds the failing diff when the good side had none', () => {
    const trial = planTrial([diff('+x\n')], base);
    expect(trial.steps[1]).toMatchObject({ argv: ['sh', '-euc', BAD_APPLY] });
    expect(trial.undo).toMatchObject([{ argv: ['sh', '-euc', ifApplied(BAD_APPLY)] }]);
  });

  it('installs varied dependencies in one npm call and reinstalls after the diff is undone', () => {
    const trial = planTrial([dep('a', '2.0.0'), dep('@s/b', '1.1.0'), diff('+x\n')], {
      ...base,
      dependencyDir: '/tmp/twin/repo/app',
    });
    expect(trial.steps.at(-1)).toEqual(
      expect.objectContaining({
        id: 'trial-dependencies',
        title: 'install a@2.0.0, @s/b@1.1.0',
        argv: ['npm', 'install', '--no-save', '--no-audit', '--no-fund', 'a@2.0.0', '@s/b@1.1.0'],
        cwd: '/tmp/twin/repo/app',
      }),
    );
    expect(trial.undo.map((step) => step.id)).toEqual(['trial-diff-undo', 'dependencies']);
  });

  it('refuses dependency trials without a good install step to undo them', () => {
    expect(() => planTrial([dep('a', '1.0.0')], { ...base, reinstall: null })).toThrow(
      'install step',
    );
  });
});
