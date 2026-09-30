import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectNodeDeps } from '../../../src/capture/facts/node-deps.ts';
import { manifest, useTempDirs, writeTree } from '../../helpers/fakes.ts';

describe('collectNodeDeps', () => {
  const tempDir = useTempDirs();

  it('returns null without node_modules', async () => {
    const root = await tempDir();
    expect(await collectNodeDeps(root, root)).toBeNull();
  });

  it('reads npm-style nested and scoped packages, recording duplicates', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'node_modules/left-pad/package.json': manifest('left-pad', '1.3.0'),
      'node_modules/@scope/util/package.json': manifest('@scope/util', '2.0.0'),
      'node_modules/app-lib/package.json': manifest('app-lib', '1.0.0'),
      'node_modules/app-lib/node_modules/left-pad/package.json': manifest('left-pad', '1.1.0'),
      'node_modules/.bin/tool': '',
      'node_modules/broken/package.json': '{not json',
      'node_modules/no-version/package.json': JSON.stringify({ name: 'no-version' }),
    });
    expect(await collectNodeDeps(root, root)).toEqual({
      '@scope/util': ['2.0.0'],
      'app-lib': ['1.0.0'],
      'left-pad': ['1.1.0', '1.3.0'],
    });
  });

  it('reads the pnpm virtual store and counts linked packages once', async () => {
    const root = await tempDir();
    const store = 'node_modules/.pnpm/dayjs@1.11.13/node_modules/dayjs';
    await writeTree(root, {
      [`${store}/package.json`]: manifest('dayjs', '1.11.13'),
      'node_modules/.pnpm/ms@2.1.3/node_modules/ms/package.json': manifest('ms', '2.1.3'),
    });
    await symlink(join(root, store), join(root, 'node_modules/dayjs'), 'dir');
    await symlink(join(root, 'missing'), join(root, 'node_modules/dangling'), 'dir');
    expect(await collectNodeDeps(root, root)).toEqual({ dayjs: ['1.11.13'], ms: ['2.1.3'] });
  });

  it('combines workspace package and root node_modules', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'node_modules/shared/package.json': manifest('shared', '1.0.0'),
      'packages/web/node_modules/react/package.json': manifest('react', '18.3.1'),
    });
    const cwd = join(root, 'packages/web');
    await mkdir(join(root, 'packages/web/src'), { recursive: true });
    expect(await collectNodeDeps(join(cwd, 'src'), root)).toEqual({
      react: ['18.3.1'],
      shared: ['1.0.0'],
    });
  });
});
