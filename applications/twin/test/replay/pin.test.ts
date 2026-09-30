import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backend/fake.ts';
import {
  computePins,
  INSTALLED_MARKER,
  parseInstalled,
  patchedPackageNames,
  pinStep,
} from '../../src/replay/pin.ts';
import { replay } from '../../src/replay/replay.ts';
import { makeCapsule } from '../helpers/capsule.ts';

describe('computePins', () => {
  it('pins packages installed at other versions than the capsule recorded', () => {
    const { pins, skipped } = computePins(
      { a: ['2.0.0'], b: ['1.0.0'], c: ['1.0.0'] },
      { a: ['1.0.0'], b: ['1.0.0'] },
    );
    // b is identical, c is not installed at all (a platform or optional difference).
    expect(pins).toEqual([{ name: 'a', version: '2.0.0' }]);
    expect(skipped).toEqual([]);
  });

  it('pins the one new copy of a package installed in several versions', () => {
    const { pins } = computePins(
      { lru: ['5.1.1', '7.18.3', '11.3.0'] },
      { lru: ['5.1.1', '7.18.3', '11.2.0'] },
    );
    expect(pins).toEqual([{ name: 'lru', version: '11.3.0' }]);
  });

  it('skips a package with several new versions and one the fix sets', () => {
    const { pins, skipped } = computePins(
      { a: ['2.0.0', '3.0.0'], b: ['2.0.0'] },
      { a: ['1.0.0'], b: ['1.0.0'] },
      new Set(['b']),
    );
    expect(pins).toEqual([]);
    expect(skipped).toEqual([
      { name: 'a', reason: 'several new versions recorded' },
      { name: 'b', reason: 'the candidate fix sets this package' },
    ]);
  });
});

describe('patchedPackageNames', () => {
  it('collects names added inside package.json only', () => {
    const patch = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,3 +1,6 @@',
      ' {',
      '+  "overrides": {',
      '+    "lru-cache": "^11.3.2"',
      '+  },',
      '   "name": "x"',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '+  "not-a-package": true',
    ].join('\n');
    expect([...patchedPackageNames(patch)].sort()).toEqual(['lru-cache', 'overrides']);
  });
});

describe('parseInstalled and pinStep', () => {
  it('reads the marker line and ignores other output', () => {
    const output = `npm warn something\n${INSTALLED_MARKER}{"a":["1.0.0"]}\n`;
    expect(parseInstalled(output)).toEqual({ a: ['1.0.0'] });
    expect(parseInstalled('nothing here')).toBeNull();
    expect(parseInstalled(`${INSTALLED_MARKER}{oops`)).toBeNull();
  });

  it('plans one npm install with every pin and a readable title', () => {
    const step = pinStep(
      [
        { name: 'a', version: '1.0.0' },
        { name: '@s/b', version: '2.0.0' },
        { name: 'c', version: '3.0.0' },
        { name: 'd', version: '4.0.0' },
      ],
      '/tmp/twin/repo',
    );
    expect(step.title).toBe(
      "pin 4 packages to the capsule's versions (a@1.0.0, @s/b@2.0.0, c@3.0.0, +1 more)",
    );
    expect(step.argv[2]).toBe(
      'npm install --no-save --no-audit --no-fund a@1.0.0 @s/b@2.0.0 c@3.0.0 d@4.0.0',
    );
  });
});

function installedOnMachine(installed: Record<string, string[]>) {
  return new FakeBackend((spec) =>
    spec.argv[0] === 'sh' && spec.argv[2]?.includes('list-installed')
      ? { exitCode: 0, output: `${INSTALLED_MARKER}${JSON.stringify(installed)}\n` }
      : undefined,
  );
}

describe('replay pins dependencies', () => {
  const capsule = makeCapsule({
    resolved: { node: { 'left-pad': ['1.3.0'], dayjs: ['1.11.0'] } },
  });

  it('installs the recorded version of a package the lockfile install holds differently', async () => {
    const backend = installedOnMachine({ 'left-pad': ['1.2.0'], dayjs: ['1.11.0'] });
    const report = await replay(capsule, backend, { attempts: 1 });
    const step = report.steps.find((s) => s.id === 'pin');
    expect(step?.title).toContain('pin 1 package');
    expect(report.pinned).toEqual([{ name: 'left-pad', version: '1.3.0' }]);
    const pinRun = backend.machines[0]?.runs.find((run) => run.argv[2]?.includes('--no-save'));
    expect(pinRun?.argv[2]).toContain('left-pad@1.3.0');
  });

  it('adds no step when nothing differs', async () => {
    const backend = installedOnMachine({ 'left-pad': ['1.3.0'], dayjs: ['1.11.0'] });
    const report = await replay(capsule, backend, { attempts: 1 });
    expect(report.steps.find((s) => s.id === 'pin')).toBeUndefined();
    expect(report.pinned).toBeUndefined();
  });

  it('does nothing with pin off or a different ref', async () => {
    for (const options of [{ pin: false }, { ref: 'deadbeef' }]) {
      const backend = installedOnMachine({ 'left-pad': ['1.2.0'] });
      const report = await replay(capsule, backend, { attempts: 1, ...options });
      expect(report.steps.find((s) => s.id === 'pin')).toBeUndefined();
      expect(backend.machines[0]?.runs.some((r) => r.argv[2]?.includes('list-installed'))).toBe(
        false,
      );
    }
  });

  it('keeps packages a candidate fix sets in package.json', async () => {
    const backend = installedOnMachine({ 'left-pad': ['1.2.0'], dayjs: ['1.10.0'] });
    const patch = [
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1 +1,3 @@',
      '+  "overrides": {',
      '+    "dayjs": "^1.11.5"',
      '+  },',
    ].join('\n');
    const report = await replay(capsule, backend, { attempts: 1, patch });
    expect(report.pinned).toEqual([{ name: 'left-pad', version: '1.3.0' }]);
    expect(report.notes.join('\n')).toContain(
      '1 package version from the capsule was not installed: dayjs (the candidate fix sets this package)',
    );
  });

  it('ends inconclusive when the pin install fails', async () => {
    const backend = new FakeBackend((spec) => {
      if (spec.argv[2]?.includes('list-installed'))
        return { exitCode: 0, output: `${INSTALLED_MARKER}{"left-pad":["1.2.0"]}\n` };
      if (spec.argv[2]?.includes('--no-save')) return { exitCode: 1, output: 'npm error notarget' };
      return undefined;
    });
    const report = await replay(capsule, backend, { attempts: 1 });
    expect(report.verdict).toBe('inconclusive');
    expect(report.attempts).toHaveLength(0);
    expect(report.steps.at(-1)?.ok).toBe(false);
    expect(report.steps.at(-1)?.title).toContain('left-pad@1.3.0');
  });
});
