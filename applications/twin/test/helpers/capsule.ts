import type { Capsule } from '../../src/capsule/schema.ts';

/** A complete, valid capsule; tests override only the fields they care about. */
export function makeCapsule(overrides: Partial<Capsule> = {}): Capsule {
  return {
    twin: 1,
    createdAt: '2026-09-28T10:00:00.000Z',
    generator: 'twin 0.1.0',
    command: {
      argv: ['npm', 'test'],
      cwd: '.',
      exitCode: 1,
      signal: null,
      durationMs: 1234,
      outcome: 'fail',
      failure: {
        signature: 'exit1:0123456789abcdef',
        keyLines: ['AssertionError: expected 1 to be 2'],
        outputTail: 'AssertionError: expected 1 to be 2',
      },
    },
    os: {
      platform: 'linux',
      arch: 'x64',
      release: '6.8.0',
      distro: 'ubuntu',
      distroVersion: '24.04',
      libc: 'glibc',
      libcVersion: '2.39',
    },
    runtimes: { node: '22.3.0' },
    tools: { git: '2.46.0', npm: '10.8.1' },
    packageManagers: [
      {
        name: 'npm',
        ecosystem: 'node',
        version: '10.8.1',
        declared: null,
        lockfile: 'package-lock.json',
        lockfileSha256: 'a'.repeat(64),
      },
    ],
    resolved: { node: { 'left-pad': ['1.3.0'] } },
    repo: {
      remote: 'https://github.com/o/r',
      commit: 'abc123',
      branch: 'main',
      dirty: false,
      diff: '',
      diffTruncated: false,
      diffRedacted: false,
      untracked: [],
    },
    env: {
      CI: { state: 'absent' },
      NODE_ENV: { state: 'set', value: 'test' },
      API_TOKEN: { state: 'set' },
    },
    locale: { timeZone: 'Asia/Kolkata', locale: 'en-IN' },
    redaction: { rulesVersion: 1, valuesIncluded: ['NODE_ENV'], hashedValues: false, scrubbed: {} },
    ...overrides,
  };
}
