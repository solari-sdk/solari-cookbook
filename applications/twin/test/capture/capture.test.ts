import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCapsule } from '../../src/capsule/schema.ts';
import { type CaptureRequest, capture } from '../../src/capture/capture.ts';
import type { RunOptions, RunResult } from '../../src/capture/run-command.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import {
  fakeExec,
  fakeHost,
  MemoryOutput,
  manifest,
  ok,
  useTempDirs,
  writeTree,
} from '../helpers/fakes.ts';

const SECRET = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');

function fakeRun(result: Partial<RunResult>) {
  const calls: { argv: readonly string[]; options: RunOptions }[] = [];
  const run = async (argv: readonly string[], options: RunOptions): Promise<RunResult> => {
    calls.push({ argv, options });
    return { exitCode: 1, signal: null, durationMs: 42, outputTail: '', ...result };
  };
  return { run, calls };
}

describe('capture', () => {
  const tempDir = useTempDirs();

  async function setup(result: Partial<RunResult>, request: Partial<CaptureRequest> = {}) {
    const root = await tempDir();
    await writeTree(root, {
      'package.json': '{}',
      'package-lock.json': '{}',
      'node_modules/left-pad/package.json': manifest('left-pad', '1.3.0'),
      'src/.keep': '',
    });
    const host = fakeHost({
      env: { NODE_ENV: 'test', API_TOKEN: SECRET },
      exec: fakeExec({ 'node --version': ok('v22.3.0'), 'npm --version': ok('10.8.1') }).exec,
    });
    const { run, calls } = fakeRun(result);
    const output = await capture(
      {
        argv: ['npm', 'test'],
        cwd: join(root, 'src'),
        includeEnv: [],
        salt: null,
        generator: 'twin test',
        ...request,
      },
      host,
      { stdout: new MemoryOutput(), stderr: new MemoryOutput(), run },
    );
    return { ...output, calls, root, host };
  }

  it('assembles a valid capsule from all collectors', async () => {
    const { capsule } = await setup({ outputTail: 'AssertionError: expected 1 to be 2' });
    expect(decodeCapsule(JSON.parse(JSON.stringify(capsule)))).toEqual(capsule);
    expect(capsule).toMatchObject({
      twin: 1,
      createdAt: '2026-09-28T10:00:00.000Z',
      generator: 'twin test',
      runtimes: { node: '22.3.0' },
      tools: { npm: '10.8.1' },
      packageManagers: [{ name: 'npm', version: '10.8.1', lockfile: 'package-lock.json' }],
      resolved: { node: { 'left-pad': ['1.3.0'] } },
      repo: null,
      locale: { timeZone: 'Asia/Kolkata', locale: 'en-IN' },
      os: { platform: 'linux', libc: 'glibc' },
    });
  });

  it('records the failure with a signature computed from scrubbed output', async () => {
    const tail = `Error: auth failed for token ${SECRET}`;
    const { capsule } = await setup({ outputTail: tail });
    const scrubbed = 'Error: auth failed for token <redacted:github-token>';
    expect(capsule.command).toEqual({
      argv: ['npm', 'test'],
      cwd: 'src',
      exitCode: 1,
      signal: null,
      durationMs: 42,
      outcome: 'fail',
      failure: {
        ...failureIdentity({ exitCode: 1, signal: null }, scrubbed),
        outputTail: scrubbed,
      },
    });
  });

  it('never writes secret values anywhere in the capsule', async () => {
    const { capsule } = await setup(
      { outputTail: `leak ${SECRET}` },
      { argv: ['curl', '-H', `Authorization: token ${SECRET}`] },
    );
    const json = JSON.stringify(capsule);
    expect(json).not.toContain(SECRET);
    expect(capsule.env.API_TOKEN).toEqual({ state: 'set' });
    expect(capsule.redaction.scrubbed['github-token']).toBe(2);
  });

  it('records a passing run without failure details', async () => {
    const { capsule } = await setup({ exitCode: 0, outputTail: 'all good' });
    expect(capsule.command.outcome).toBe('pass');
    expect(capsule.command.failure).toBeNull();
  });

  it('runs the command in its cwd with the host environment', async () => {
    const { calls, root, host } = await setup({});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(['npm', 'test']);
    // capture resolves symlinks (macOS temp dirs live under /var, a link to /private/var)
    expect(calls[0]?.options.cwd).toBe(join(await realpath(root), 'src'));
    expect(calls[0]?.options.env).toBe(host.env);
  });

  it('records redaction settings', async () => {
    const { capsule } = await setup({}, { includeEnv: ['API_TOKEN'], salt: 's' });
    expect(capsule.redaction).toMatchObject({
      rulesVersion: 2,
      hashedValues: true,
      valuesIncluded: expect.arrayContaining(['API_TOKEN', 'NODE_ENV']),
    });
    expect(capsule.env.API_TOKEN).toEqual({ state: 'set', value: '<redacted:github-token>' });
  });
});
