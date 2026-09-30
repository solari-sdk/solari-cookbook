import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectPythonEnv,
  normalizeDistName,
  parsePipList,
} from '../../../src/capture/facts/python-deps.ts';
import { failed, fakeExec, ok, useTempDirs, writeTree } from '../../helpers/fakes.ts';

const PIP_JSON = JSON.stringify([
  { name: 'Requests', version: '2.32.3' },
  { name: 'typing_extensions', version: '4.12.2' },
]);

describe('pip list parsing', () => {
  it('normalizes names per PEP 503', () => {
    expect(normalizeDistName('Typing_Extensions')).toBe('typing-extensions');
    expect(normalizeDistName('zope.interface')).toBe('zope-interface');
  });

  it('parses and sorts pip JSON', () => {
    expect(parsePipList(PIP_JSON)).toEqual({ requests: '2.32.3', 'typing-extensions': '4.12.2' });
  });

  it('rejects malformed output', () => {
    expect(parsePipList('nope')).toBeNull();
    expect(parsePipList('{}')).toBeNull();
    expect(parsePipList('[{"name":1}]')).toEqual({});
  });
});

describe('collectPythonEnv', () => {
  const tempDir = useTempDirs();
  const options = (root: string, env: NodeJS.ProcessEnv = {}) => ({
    cwd: root,
    root,
    env,
    platform: 'linux' as const,
  });

  it('returns null outside Python projects without running anything', async () => {
    const root = await tempDir();
    const { exec, calls } = fakeExec();
    expect(await collectPythonEnv(exec, options(root))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('reports the project .venv interpreter version, not python3 on PATH', async () => {
    const root = await tempDir();
    await writeTree(root, { 'pyproject.toml': '', '.venv/bin/python': '' });
    const python = join(root, '.venv/bin/python');
    const { exec } = fakeExec({
      [`${python} --version`]: ok('Python 3.13.12\n'),
      'python3 --version': ok('Python 3.14.7\n'),
      [`${python} -m pip list --format=json --disable-pip-version-check`]: ok(PIP_JSON),
    });
    expect(await collectPythonEnv(exec, options(root))).toEqual({
      version: '3.13.12',
      packages: { requests: '2.32.3', 'typing-extensions': '4.12.2' },
    });
  });

  it('falls back to uv when the venv has no pip', async () => {
    const root = await tempDir();
    await writeTree(root, { 'requirements.txt': '' });
    const { exec } = fakeExec({
      'python3 --version': ok('', 'Python 3.11.9\n'),
      'python3 -m pip list --format=json --disable-pip-version-check':
        failed('No module named pip'),
      'uv pip list --format json --python python3': ok(PIP_JSON),
    });
    expect(await collectPythonEnv(exec, options(root))).toMatchObject({
      version: '3.11.9',
      packages: { requests: '2.32.3' },
    });
  });

  it('uses the active virtualenv and tolerates a missing interpreter', async () => {
    const root = await tempDir();
    await writeTree(root, { 'setup.py': '' });
    const { exec, calls } = fakeExec();
    expect(await collectPythonEnv(exec, options(root, { VIRTUAL_ENV: '/venvs/app' }))).toEqual({
      version: null,
      packages: null,
    });
    expect(calls[0]).toEqual(['/venvs/app/bin/python', '--version']);
  });
});
