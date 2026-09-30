import { describe, expect, it } from 'vitest';
import { deriveAtoms } from '../../src/bisect/atoms.ts';
import type { Capsule } from '../../src/capsule/schema.ts';
import { makeCapsule } from '../helpers/capsule.ts';

function pair(goodOverrides: Partial<Capsule> = {}, badOverrides: Partial<Capsule> = {}) {
  const base = makeCapsule();
  const good = makeCapsule({
    command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
    ...goodOverrides,
  });
  const bad = makeCapsule(badOverrides);
  return { good, bad };
}

describe('deriveAtoms', () => {
  it('finds nothing between identical environments', () => {
    const { good, bad } = pair();
    expect(deriveAtoms(good, bad)).toEqual({ atoms: [], skipped: [], notes: [] });
  });

  it('turns env value differences into atoms, including unsets and empties', () => {
    const { good, bad } = pair(
      { env: { NODE_ENV: { state: 'set', value: 'test' }, CI: { state: 'set', value: 'true' } } },
      {
        env: {
          NODE_ENV: { state: 'set', value: 'production' },
          CI: { state: 'absent' },
          FORCE_COLOR: { state: 'empty' },
        },
      },
    );
    expect(deriveAtoms(good, bad).atoms).toEqual([
      { kind: 'env', id: 'env:CI', label: 'unset CI', name: 'CI', value: null },
      {
        kind: 'env',
        id: 'env:FORCE_COLOR',
        label: 'FORCE_COLOR=""',
        name: 'FORCE_COLOR',
        value: '',
      },
      {
        kind: 'env',
        id: 'env:NODE_ENV',
        label: 'NODE_ENV=production',
        name: 'NODE_ENV',
        value: 'production',
      },
    ]);
  });

  it('skips env differences whose failing value is unknown or already unset', () => {
    const { good, bad } = pair({ env: { A: { state: 'set' } } }, { env: { B: { state: 'set' } } });
    expect(deriveAtoms(good, bad)).toMatchObject({
      atoms: [],
      skipped: [
        {
          category: 'env',
          key: 'A',
          reason: 'unset in the failing environment and not set in replay',
        },
        { category: 'env', key: 'B', reason: expect.stringContaining('--include-env') },
      ],
    });
  });

  it('varies the time zone through TZ', () => {
    const { good, bad } = pair({ locale: { timeZone: 'UTC', locale: 'en-US' } });
    const { atoms, skipped } = deriveAtoms(good, bad);
    expect(atoms).toEqual([
      { kind: 'env', id: 'env:TZ', label: 'TZ=Asia/Kolkata', name: 'TZ', value: 'Asia/Kolkata' },
    ]);
    expect(skipped).toEqual([
      { category: 'locale', key: 'locale', reason: expect.stringContaining('LANG') },
    ]);
  });

  it('uses the zone, not "unset TZ", when the failing side has no explicit TZ', () => {
    const { good, bad } = pair({
      env: { ...makeCapsule().env, TZ: { state: 'set', value: 'UTC' } },
      locale: { timeZone: 'UTC', locale: 'en-IN' },
    });
    expect(deriveAtoms(good, bad).atoms).toEqual([
      { kind: 'env', id: 'env:TZ', label: 'TZ=Asia/Kolkata', name: 'TZ', value: 'Asia/Kolkata' },
    ]);
  });

  it('ignores an explicit TZ that resolves to the same zone', () => {
    const { good, bad } = pair({
      env: { ...makeCapsule().env, TZ: { state: 'set', value: 'Asia/Kolkata' } },
    });
    expect(deriveAtoms(good, bad)).toMatchObject({
      atoms: [],
      skipped: [{ category: 'env', key: 'TZ', reason: 'same effective time zone' }],
    });
  });

  it('lets an explicit TZ env value cover the zone', () => {
    const { good, bad } = pair(
      { env: { TZ: { state: 'set', value: 'UTC' } }, locale: { timeZone: 'UTC', locale: 'en-IN' } },
      { env: { TZ: { state: 'set', value: 'Asia/Kolkata' } } },
    );
    expect(deriveAtoms(good, bad).atoms.map((a) => a.id)).toEqual(['env:TZ']);
  });

  it('varies the node version and skips other runtimes', () => {
    const { good, bad } = pair(
      { runtimes: { node: '20.17.0', python: '3.11.0' } },
      { runtimes: { node: '22.3.0', python: '3.12.0', go: '1.23' } },
    );
    const { atoms, skipped } = deriveAtoms(good, bad);
    expect(atoms).toEqual([
      { kind: 'node', id: 'node', label: 'node 22.3.0', version: '22.3.0', goodVersion: '20.17.0' },
    ]);
    expect(skipped.map((s) => `${s.key}: ${s.reason}`)).toEqual([
      'go: go versions are not varied yet',
      'python: python versions are not varied yet',
    ]);
  });

  it('varies single-version npm dependencies', () => {
    const { good, bad } = pair(
      { resolved: { node: { a: ['1.0.0'], c: ['1.0.0'] } } },
      { resolved: { node: { a: ['1.1.0'] } } },
    );
    const { atoms, skipped } = deriveAtoms(good, bad);
    expect(atoms).toEqual([
      { kind: 'dependency', id: 'dep:a', label: 'a@1.1.0', name: 'a', version: '1.1.0' },
    ]);
    expect(skipped.map((s) => `${s.key}: ${s.reason}`)).toEqual([
      'c: not installed on the failing machine',
    ]);
  });

  it('varies the one new copy when several versions are installed', () => {
    const { good, bad } = pair(
      { resolved: { node: { lru: ['5.1.1', '7.18.3'], b: ['1.0.0'] } } },
      { resolved: { node: { lru: ['5.1.1', '7.18.3', '11.3.0'], b: ['2.0.0', '3.0.0'] } } },
    );
    const { atoms, skipped } = deriveAtoms(good, bad);
    expect(atoms).toEqual([
      { kind: 'dependency', id: 'dep:lru', label: 'lru@11.3.0', name: 'lru', version: '11.3.0' },
    ]);
    expect(skipped.map((s) => `${s.key}: ${s.reason}`)).toEqual([
      'b: several new versions installed on the failing machine',
    ]);
  });

  it('skips dependency differences outside npm projects', () => {
    const base = makeCapsule();
    const pnpm = [
      { ...(base.packageManagers[0] as Capsule['packageManagers'][number]), name: 'pnpm' },
    ];
    const { good, bad } = pair(
      { resolved: { node: { a: ['1.0.0'] } }, packageManagers: pnpm },
      { resolved: { node: { a: ['2.0.0'] } }, packageManagers: pnpm },
    );
    expect(deriveAtoms(good, bad).skipped).toEqual([
      {
        category: 'nodeDependency',
        key: 'a',
        reason: 'dependency versions are varied only for npm projects so far',
      },
    ]);
  });

  it('turns a working tree difference into a diff atom and notes scrubbing', () => {
    const base = makeCapsule();
    const repo = base.repo as NonNullable<Capsule['repo']>;
    const { good, bad } = pair(
      {},
      { repo: { ...repo, diff: '+bug\n', dirty: true, diffRedacted: true } },
    );
    expect(deriveAtoms(good, bad)).toMatchObject({
      atoms: [{ kind: 'diff', id: 'diff', label: 'working tree diff', diff: '+bug\n' }],
      notes: [expect.stringContaining('scrubbed or truncated')],
    });
  });

  it('notes different remotes and skips what a sandbox cannot vary', () => {
    const base = makeCapsule();
    const repo = base.repo as NonNullable<Capsule['repo']>;
    const { good, bad } = pair(
      {},
      {
        repo: { ...repo, remote: 'https://example.com/fork' },
        os: { ...base.os, platform: 'darwin' },
        tools: { git: '2.0.0' },
      },
    );
    const { notes, skipped } = deriveAtoms(good, bad);
    expect(notes).toEqual([
      "The capsules name different git remotes; the good capsule's remote is used.",
    ]);
    expect(skipped.map((s) => `${s.category}:${s.key}`)).toEqual([
      'os:platform',
      'tool:git',
      'tool:npm',
    ]);
  });

  it('rejects pairs it cannot explain', () => {
    const base = makeCapsule();
    const passing = { ...base.command, exitCode: 0, outcome: 'pass' as const, failure: null };
    expect(() =>
      deriveAtoms(makeCapsule({ command: passing }), makeCapsule({ command: passing })),
    ).toThrow('did not fail');
    expect(() => deriveAtoms(makeCapsule(), makeCapsule())).toThrow('good capsule did not pass');
    const repo = base.repo as NonNullable<Capsule['repo']>;
    const { good, bad } = pair({}, { repo: { ...repo, commit: 'def456' } });
    expect(() => deriveAtoms(good, bad)).toThrow(/different commits .*git bisect/);
  });
});
