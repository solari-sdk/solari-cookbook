import { describe, expect, it } from 'vitest';
import {
  firstVersion,
  lastVersionOnFirstLine,
  PROBES,
  runProbes,
  type VersionProbe,
} from '../../../src/capture/facts/probes.ts';
import { failed, fakeExec, ok } from '../../helpers/fakes.ts';

const probe = (name: string) => {
  const found = PROBES.find((p) => p.name === name);
  if (!found) throw new Error(`no probe ${name}`);
  return found;
};

const parse = (p: VersionProbe, output: string) => (p.parse ?? firstVersion)(output);

describe('version parsing', () => {
  it.each([
    ['node', 'v22.3.0', '22.3.0'],
    ['python', 'Python 3.12.4', '3.12.4'],
    ['go', 'go version go1.23.1 linux/amd64', '1.23.1'],
    ['rustc', 'rustc 1.81.0 (eeb90cda1 2024-09-04)', '1.81.0'],
    ['java', 'openjdk version "21.0.4" 2024-07-16', '21.0.4'],
    ['gcc', 'gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0\nCopyright', '13.2.0'],
    ['clang', 'Apple clang version 16.0.0 (clang-1600.0.26.3)', '16.0.0'],
    ['deno', 'deno 2.1.4 (stable, release, x86_64)\nv8 13.0', '2.1.4'],
    ['pip', 'pip 24.2 from /usr/lib/python3/dist-packages/pip (python 3.12)', '24.2'],
    ['poetry', 'Poetry (version 1.8.3)', '1.8.3'],
    ['yarn', '4.5.0-rc.1', '4.5.0-rc.1'],
  ])('%s: %j -> %s', (name, output, expected) => {
    expect(parse(probe(name), output)).toBe(expected);
  });

  it('returns null when there is no version', () => {
    expect(firstVersion('command not found')).toBeNull();
    expect(lastVersionOnFirstLine('')).toBeNull();
  });
});

describe('runProbes', () => {
  it('groups found versions by kind and skips missing tools', async () => {
    const { exec } = fakeExec({
      'node --version': ok('v22.3.0\n'),
      'git --version': ok('git version 2.46.0\n'),
    });
    const results = await runProbes(exec, { cwd: '/p', env: {} });
    expect(results).toEqual({ runtimes: { node: '22.3.0' }, tools: { git: '2.46.0' } });
  });

  it('tries alternatives in order and reads stderr', async () => {
    const { exec, calls } = fakeExec({
      'python3 --version': failed('not here'),
      'python --version': ok('', 'Python 3.11.9\n'),
    });
    const results = await runProbes(exec, { cwd: '/p', env: {} }, [probe('python')]);
    expect(results.runtimes).toEqual({ python: '3.11.9' });
    expect(calls).toEqual([
      ['python3', '--version'],
      ['python', '--version'],
    ]);
  });

  it('keeps corepack offline and non-interactive', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    await runProbes(
      async (_argv, options) => {
        seen.push(options?.env ?? {});
        return ok('9.0.0');
      },
      { cwd: '/p', env: { KEEP: '1' } },
      [probe('pnpm')],
    );
    expect(seen[0]).toMatchObject({
      KEEP: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_NETWORK: '0',
    });
  });
});
