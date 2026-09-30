import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectPackageManagers,
  parseDeclaredManager,
} from '../../../src/capture/facts/package-managers.ts';
import { sha256Hex } from '../../../src/util/hash.ts';
import { useTempDirs, writeTree } from '../../helpers/fakes.ts';

describe('parseDeclaredManager', () => {
  it.each([
    ['pnpm@9.12.0', { name: 'pnpm', version: '9.12.0' }],
    ['yarn@4.5.0+sha512.abc', { name: 'yarn', version: '4.5.0' }],
    ['npm@10.8.1', { name: 'npm', version: '10.8.1' }],
  ])('%s', (field, expected) => {
    expect(parseDeclaredManager(field)).toEqual(expected);
  });

  it.each([undefined, 42, 'pnpm', 'pnpm@latest'])('rejects %j', (field) => {
    expect(parseDeclaredManager(field)).toBeNull();
  });
});

describe('detectPackageManagers', () => {
  const tempDir = useTempDirs();
  const versions = { npm: '10.8.1', pnpm: '9.12.0', uv: '0.4.20' };

  it('finds lockfiles, hashes them and attaches probed versions', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'package.json': '{}',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'uv.lock': 'version = 1\n',
    });
    expect(await detectPackageManagers({ cwd: root, root, versions })).toEqual([
      {
        name: 'pnpm',
        ecosystem: 'node',
        version: '9.12.0',
        declared: null,
        lockfile: 'pnpm-lock.yaml',
        lockfileSha256: sha256Hex('lockfileVersion: 9.0\n'),
      },
      {
        name: 'uv',
        ecosystem: 'python',
        version: '0.4.20',
        declared: null,
        lockfile: 'uv.lock',
        lockfileSha256: sha256Hex('version = 1\n'),
      },
    ]);
  });

  it('searches up to the repo root for monorepo lockfiles', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'package-lock.json': '{}',
      'packages/api/package.json': '{}',
    });
    const [npm] = await detectPackageManagers({ cwd: join(root, 'packages/api'), root, versions });
    expect(npm).toMatchObject({ name: 'npm', lockfile: 'package-lock.json' });
  });

  it('includes a declared manager even without its lockfile', async () => {
    const root = await tempDir();
    await writeTree(root, { 'package.json': JSON.stringify({ packageManager: 'yarn@4.5.0' }) });
    expect(await detectPackageManagers({ cwd: root, root, versions })).toEqual([
      {
        name: 'yarn',
        ecosystem: 'node',
        version: null,
        declared: '4.5.0',
        lockfile: null,
        lockfileSha256: null,
      },
    ]);
  });

  it('defaults a bare package.json to npm', async () => {
    const root = await tempDir();
    await writeTree(root, { 'package.json': '{broken' });
    expect(await detectPackageManagers({ cwd: root, root, versions })).toEqual([
      {
        name: 'npm',
        ecosystem: 'node',
        version: '10.8.1',
        declared: null,
        lockfile: null,
        lockfileSha256: null,
      },
    ]);
  });

  it('finds nothing in an empty directory', async () => {
    const root = await tempDir();
    expect(await detectPackageManagers({ cwd: root, root, versions })).toEqual([]);
  });
});
