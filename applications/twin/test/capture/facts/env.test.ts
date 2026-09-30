import { describe, expect, it } from 'vitest';
import { collectEnv, isNoise, isSafeValue } from '../../../src/capture/facts/env.ts';
import { Redactor } from '../../../src/redact/redactor.ts';
import { hmacSha256Hex } from '../../../src/util/hash.ts';

const collect = (
  source: NodeJS.ProcessEnv,
  options: Partial<Parameters<typeof collectEnv>[1]> = {},
) =>
  collectEnv(
    source,
    { include: [], salt: null, ...options },
    new Redactor({ homeDir: '/home/alice' }),
  );

describe('collectEnv', () => {
  it('records names only for variables outside the allowlist', () => {
    const { env } = collect({ API_TOKEN: 'super-secret' });
    expect(env.API_TOKEN).toEqual({ state: 'set' });
    expect(JSON.stringify(env)).not.toContain('super-secret');
  });

  it('keeps allowlisted values, scrubbed', () => {
    const { env, valuesIncluded } = collect({
      NODE_ENV: 'test',
      NODE_OPTIONS: '--require /home/alice/hook.js',
      LC_PAPER: 'en_IN',
    });
    expect(env.NODE_ENV).toEqual({ state: 'set', value: 'test' });
    expect(env.NODE_OPTIONS).toEqual({ state: 'set', value: '--require ~/hook.js' });
    expect(env.LC_PAPER).toEqual({ state: 'set', value: 'en_IN' });
    expect(valuesIncluded).toEqual(['LC_PAPER', 'NODE_ENV', 'NODE_OPTIONS']);
  });

  it('records allowlisted variables as absent when unset, and empty values as empty', () => {
    const { env } = collect({ FOO: '' });
    expect(env.CI).toEqual({ state: 'absent' });
    expect(env.TZ).toEqual({ state: 'absent' });
    expect(env.FOO).toEqual({ state: 'empty' });
  });

  it('includes values the reporter opted into', () => {
    const { env, valuesIncluded } = collect(
      { MY_FLAG: 'on' },
      { include: ['MY_FLAG', 'UNSET_ONE'] },
    );
    expect(env.MY_FLAG).toEqual({ state: 'set', value: 'on' });
    expect(env.UNSET_ONE).toEqual({ state: 'absent' });
    expect(valuesIncluded).toContain('MY_FLAG');
  });

  it('hashes other values under the salt so equal values compare equal', () => {
    const { env } = collect(
      { DATABASE_URL: 'postgres://x', NODE_ENV: 'test' },
      { salt: 'issue-42' },
    );
    expect(env.DATABASE_URL).toEqual({
      state: 'set',
      hash: hmacSha256Hex('issue-42', 'postgres://x').slice(0, 32),
    });
    expect(env.NODE_ENV).toEqual({ state: 'set', value: 'test' });
  });

  it('drops session noise and npx-injected variables', () => {
    const { env } = collect({
      SSH_AUTH_SOCK: '/tmp/x',
      npm_config_cache: '/c',
      PWD: '/p',
      PATH: '/bin',
    });
    expect(Object.keys(env)).toContain('PATH');
    expect(Object.keys(env)).not.toContain('SSH_AUTH_SOCK');
    expect(Object.keys(env)).not.toContain('npm_config_cache');
    expect(Object.keys(env)).not.toContain('PWD');
  });

  it('sorts names for stable output', () => {
    const names = Object.keys(collect({ ZED: '1', ALPHA: '1' }).env);
    expect(names).toEqual([...names].sort());
  });
});

describe('classification', () => {
  it.each(['SSH_AGENT_PID', 'XDG_RUNTIME_DIR', 'npm_lifecycle_event', 'SHLVL', 'INIT_CWD'])(
    '%s is noise',
    (name) => expect(isNoise(name)).toBe(true),
  );

  it.each(['PATH', 'NODE_ENV', 'JAVA_HOME', 'SSH'])('%s is not noise', (name) =>
    expect(isNoise(name)).toBe(false),
  );

  it('treats every LC_ category as safe to share', () => {
    expect(isSafeValue('LC_MONETARY')).toBe(true);
    expect(isSafeValue('PATH')).toBe(false);
  });
});
