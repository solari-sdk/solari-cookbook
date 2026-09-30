import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProjectRoot } from '../../../src/capture/facts/project-root.ts';
import { useTempDirs, writeTree } from '../../helpers/fakes.ts';

describe('findProjectRoot', () => {
  const tempDir = useTempDirs();

  it('walks up to the nearest project manifest', async () => {
    const root = await tempDir();
    await writeTree(root, { 'pyproject.toml': '', 'pkg/sub/.keep': '' });
    expect(await findProjectRoot(join(root, 'pkg/sub'))).toBe(root);
  });

  it('falls back to cwd when no manifest exists', async () => {
    const root = await tempDir();
    await writeTree(root, { 'a/.keep': '' });
    // The temp dir lives under the OS temp root, which has no manifests above it.
    expect(await findProjectRoot(join(root, 'a'))).toBe(join(root, 'a'));
  });
});
