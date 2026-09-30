import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { solariEnv } from '../../src/backend/credentials.ts';
import { useTempDirs, writeTree } from '../helpers/fakes.ts';

const read = (path: string) => readFile(path, 'utf8');

describe('solariEnv', () => {
  const tempDir = useTempDirs();

  it('reads only the Solari keys from the nearest .env above the working directory', async () => {
    const root = await tempDir();
    await writeTree(root, {
      '.env': ' SOLARI_API_KEY="slr_file"\nexport SOLARI_BASE_URL=https://api.test\nOTHER=x\n',
      'app/src/keep': '',
    });
    expect(await solariEnv({}, join(root, 'app/src'), read)).toEqual({
      SOLARI_API_KEY: 'slr_file',
      SOLARI_BASE_URL: 'https://api.test',
    });
  });

  it('prefers the environment, and uses the file only for what the environment lacks', async () => {
    const root = await tempDir();
    await writeTree(root, { '.env': 'SOLARI_API_KEY=slr_file\nSOLARI_BASE_URL=https://file\n' });
    expect(await solariEnv({ SOLARI_API_KEY: 'slr_env' }, root, read)).toEqual({
      SOLARI_API_KEY: 'slr_env',
    });
    expect(await solariEnv({ SOLARI_BASE_URL: 'https://env' }, root, read)).toEqual({
      SOLARI_API_KEY: 'slr_file',
      SOLARI_BASE_URL: 'https://env',
    });
  });

  it('skips a nearer .env without the key, and never mixes files', async () => {
    const root = await tempDir();
    await writeTree(root, {
      '.env': 'SOLARI_API_KEY=slr_root\n',
      'app/.env': 'PORT=3000\nSOLARI_BASE_URL=https://elsewhere\n',
    });
    expect(await solariEnv({}, join(root, 'app'), read)).toEqual({ SOLARI_API_KEY: 'slr_root' });
  });

  it('returns what the environment has when there is no readable .env', async () => {
    const root = await tempDir();
    expect(await solariEnv({}, root, read)).toEqual({});
    await writeTree(root, { '.env': 'SOLARI_API_KEY=x\n' });
    const unreadable = async () => {
      throw new Error('EACCES');
    };
    expect(await solariEnv({ SOLARI_BASE_URL: 'u' }, root, unreadable)).toEqual({
      SOLARI_BASE_URL: 'u',
    });
  });
});
