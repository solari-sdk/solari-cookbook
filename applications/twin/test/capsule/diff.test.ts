import { describe, expect, it } from 'vitest';
import { describeEnv, diffCapsules, envDiffers } from '../../src/capsule/diff.ts';
import { makeCapsule } from '../helpers/capsule.ts';

describe('diffCapsules', () => {
  it('finds nothing between identical capsules', () => {
    expect(diffCapsules(makeCapsule(), makeCapsule())).toEqual([]);
  });

  it('reports each differing fact with its category', () => {
    const good = makeCapsule();
    const bad = makeCapsule({
      runtimes: { node: '20.17.0', python: '3.12.4' },
      resolved: { node: { 'left-pad': ['1.3.0', '1.4.0'], dayjs: ['1.11.0'] } },
      locale: { timeZone: 'UTC', locale: 'en-IN' },
      os: {
        ...good.os,
        platform: 'darwin',
        distro: 'macos',
        distroVersion: '15.1',
        libc: null,
        libcVersion: null,
      },
    });
    expect(diffCapsules(good, bad)).toEqual([
      { category: 'os', key: 'distro', a: 'ubuntu 24.04', b: 'macos 15.1' },
      { category: 'os', key: 'libc', a: 'glibc 2.39', b: null },
      { category: 'os', key: 'platform', a: 'linux', b: 'darwin' },
      { category: 'runtime', key: 'node', a: '22.3.0', b: '20.17.0' },
      { category: 'runtime', key: 'python', a: null, b: '3.12.4' },
      { category: 'nodeDependency', key: 'dayjs', a: null, b: '1.11.0' },
      { category: 'nodeDependency', key: 'left-pad', a: '1.3.0', b: '1.3.0, 1.4.0' },
      { category: 'locale', key: 'timeZone', a: 'Asia/Kolkata', b: 'UTC' },
    ]);
  });

  it('compares package manager versions and lockfile contents', () => {
    const a = makeCapsule();
    const [npm] = a.packageManagers;
    if (!npm) throw new Error('fixture has npm');
    const b = makeCapsule({
      packageManagers: [{ ...npm, version: '9.0.0', lockfileSha256: 'b'.repeat(64) }],
    });
    expect(diffCapsules(a, b)).toEqual([
      { category: 'packageManager', key: 'npm', a: '10.8.1', b: '9.0.0' },
      { category: 'packageManager', key: 'npm lockfile', a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb' },
    ]);
  });

  it('compares the working tree diff by content hash, not by text', () => {
    const a = makeCapsule();
    const b = makeCapsule({
      repo: { ...(a.repo as NonNullable<typeof a.repo>), diff: '+x\n', dirty: true },
    });
    const [diff] = diffCapsules(a, b);
    expect(diff).toMatchObject({ category: 'repo', key: 'working tree diff', a: null });
    expect(diff?.b).toMatch(/^sha256 [0-9a-f]{12}$/);
  });

  it('treats a missing repo as no repo facts', () => {
    const a = makeCapsule();
    const diffs = diffCapsules(a, makeCapsule({ repo: null }));
    expect(diffs.map((d) => d.key)).toEqual(['commit', 'remote']);
  });

  it('includes python dependencies and tools', () => {
    const a = makeCapsule({ resolved: { python: { numpy: '1.26.4' } } });
    const b = makeCapsule({ resolved: { python: { numpy: '2.0.0' } }, tools: { git: '2.46.0' } });
    expect(diffCapsules(a, b)).toEqual([
      { category: 'pythonDependency', key: 'numpy', a: '1.26.4', b: '2.0.0' },
      { category: 'tool', key: 'npm', a: '10.8.1', b: null },
    ]);
  });
});

describe('env comparison', () => {
  it('compares values when both sides have them', () => {
    expect(envDiffers({ state: 'set', value: 'a' }, { state: 'set', value: 'b' })).toBe(true);
    expect(envDiffers({ state: 'set', value: 'a' }, { state: 'set', value: 'a' })).toBe(false);
  });

  it('compares salted hashes when both sides have them', () => {
    expect(envDiffers({ state: 'set', hash: 'h1' }, { state: 'set', hash: 'h2' })).toBe(true);
    expect(envDiffers({ state: 'set', hash: 'h1' }, { state: 'set', hash: 'h1' })).toBe(false);
  });

  it('falls back to state when precision differs', () => {
    expect(envDiffers({ state: 'set', value: 'a' }, { state: 'set' })).toBe(false);
    expect(envDiffers({ state: 'set' }, { state: 'empty' })).toBe(true);
    expect(envDiffers(undefined, { state: 'absent' })).toBe(false);
    expect(envDiffers(undefined, { state: 'set' })).toBe(true);
  });

  it('describes facts for display', () => {
    expect(describeEnv(undefined)).toBeNull();
    expect(describeEnv({ state: 'absent' })).toBeNull();
    expect(describeEnv({ state: 'empty' })).toBe('(empty)');
    expect(describeEnv({ state: 'set', value: 'x' })).toBe('x');
    expect(describeEnv({ state: 'set', hash: '0123456789' })).toBe('(hash 01234567)');
    expect(describeEnv({ state: 'set' })).toBe('(set)');
  });

  it('shows env differences in capsule diffs', () => {
    const a = makeCapsule();
    const b = makeCapsule({
      env: { ...a.env, CI: { state: 'set', value: 'true' }, API_TOKEN: { state: 'absent' } },
    });
    expect(diffCapsules(a, b)).toEqual([
      { category: 'env', key: 'API_TOKEN', a: '(set)', b: null },
      { category: 'env', key: 'CI', a: null, b: 'true' },
    ]);
  });
});
