import { describe, expect, it } from 'vitest';
import type { Capsule, PackageManagerFact } from '../../src/capsule/schema.ts';
import { planReplay, type Step } from '../../src/replay/plan.ts';
import { nodeManagerCommands } from '../../src/replay/runtimes.ts';
import { execArgv, script, shellQuote } from '../../src/replay/shell.ts';
import { makeCapsule } from '../helpers/capsule.ts';

const ids = (steps: Step[]) => steps.map((step) => step.id);
const find = (steps: Step[], id: string) => {
  const step = steps.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step;
};
const argvText = (step: Step) => (step.kind === 'run' ? step.argv.join(' ') : '');

describe('shell helpers', () => {
  it('quotes only when needed and survives single quotes', () => {
    expect(shellQuote('abc-1.2/x')).toBe('abc-1.2/x');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('builds strict scripts and exact exec argv', () => {
    expect(script(['a', 'b'])).toEqual(['sh', '-euc', 'a\nb']);
    expect(execArgv(['npm', 'test', '--', 'a b'])).toEqual([
      'sh',
      '-c',
      'exec "$@"',
      'twin',
      'npm',
      'test',
      '--',
      'a b',
    ]);
  });
});

describe('planReplay', () => {
  it('rebuilds a node project step by step', () => {
    const plan = planReplay(makeCapsule());
    expect(ids(plan.setup)).toEqual([
      'workspace',
      'node',
      'checkout',
      'package-manager',
      'dependencies',
    ]);
    expect(argvText(find(plan.setup, 'node'))).toContain(
      'https://nodejs.org/dist/v22.3.0/node-v22.3.0-linux-$arch.tar.gz',
    );
    expect(argvText(find(plan.setup, 'checkout'))).toContain(
      'git fetch -q --depth 1 origin abc123',
    );
    expect(argvText(find(plan.setup, 'checkout'))).toContain(
      'git remote add origin https://github.com/o/r',
    );
    expect(find(plan.setup, 'package-manager')).toMatchObject({
      argv: script(['npm install -g npm@10.8.1']),
    });
    expect(find(plan.setup, 'dependencies')).toMatchObject({
      argv: script(['npm ci']),
      cwd: '/tmp/twin/repo',
    });
    expect(plan.command).toMatchObject({
      argv: ['sh', '-c', 'exec "$@"', 'twin', 'npm', 'test'],
      cwd: '/tmp/twin/repo',
      timeoutMs: 15 * 60_000,
    });
  });

  it('puts the installed runtime first on PATH and copies known env values and the time zone', () => {
    const { env, notes } = planReplay(makeCapsule());
    expect(env.PATH).toBe(
      '/tmp/twin/tools/node-22.3.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
    expect(env.NODE_ENV).toBe('test');
    expect(env.TZ).toBe('Asia/Kolkata');
    expect(env).not.toHaveProperty('CI');
    expect(env).not.toHaveProperty('API_TOKEN');
    expect(notes).toContain(
      "1 variable was set on the reporter's machine but only by name, so left unset here (API_TOKEN). Usually harmless; if the command needs one, pass --env NAME=value (or have the reporter capture with --include-env NAME).",
    );
  });

  it('lists at most five unknown variable names', () => {
    const env = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`V${i}`, { state: 'set' as const }]),
    );
    const { notes } = planReplay(makeCapsule({ env }));
    expect(notes.join('\n')).toContain('(V0, V1, V2, V3, V4 and 5 more)');
  });

  it('uses provided values for name-only variables and never copies host paths', () => {
    const base = makeCapsule();
    const capsule = makeCapsule({
      env: {
        ...base.env,
        PATH: { state: 'set' },
        JAVA_HOME: { state: 'set' },
        TZ: { state: 'set', value: 'UTC' },
      },
    });
    const { env, notes } = planReplay(capsule, { env: { API_TOKEN: 'fake' } });
    expect(env.API_TOKEN).toBe('fake');
    expect(notes).toContain(
      'Overridden with --env, so this replay differs from the capsule in: API_TOKEN.',
    );
    expect(env.TZ).toBe('UTC');
    expect(notes.join('\n')).not.toContain('unknown values');
  });

  it('uploads and applies the working-tree diff, noting when it was scrubbed', () => {
    const base = makeCapsule();
    const repo = {
      ...(base.repo as NonNullable<Capsule['repo']>),
      diff: '+x\n',
      diffRedacted: true,
      diffTruncated: true,
      untracked: ['a', 'b'],
    };
    const plan = planReplay(makeCapsule({ repo }));
    expect(find(plan.setup, 'diff-file')).toMatchObject({
      kind: 'write',
      path: '/tmp/twin/capsule.diff',
      content: '+x\n',
    });
    expect(find(plan.setup, 'diff')).toMatchObject({ optional: true, cwd: '/tmp/twin/repo' });
    expect(plan.notes.join('\n')).toMatch(/scrubbed.*\n.*truncated.*\n.*2 untracked files/s);
  });

  it('skips the diff when checking out a different ref', () => {
    const base = makeCapsule();
    const repo = { ...(base.repo as NonNullable<Capsule['repo']>), diff: '+x\n' };
    const plan = planReplay(makeCapsule({ repo }), {
      ref: 'fix123',
      repoUrl: 'https://example.com/fork.git',
    });
    expect(ids(plan.setup)).not.toContain('diff');
    expect(argvText(find(plan.setup, 'checkout'))).toContain('origin fix123');
    expect(argvText(find(plan.setup, 'checkout'))).toContain('https://example.com/fork.git');
  });

  it('installs from the lockfile directory in monorepos and runs in the captured cwd', () => {
    const base = makeCapsule();
    const plan = planReplay(
      makeCapsule({
        packageManagers: [
          {
            name: 'pnpm',
            ecosystem: 'node',
            version: null,
            declared: '9.12.0',
            lockfile: 'pnpm-lock.yaml',
            lockfileSha256: 'x',
          },
        ],
        command: { ...base.command, cwd: 'packages/api' },
      }),
    );
    expect(find(plan.setup, 'dependencies')).toMatchObject({
      argv: script(['pnpm install --frozen-lockfile']),
      cwd: '/tmp/twin/repo',
    });
    expect(find(plan.setup, 'package-manager')).toMatchObject({
      argv: script(['npm install -g pnpm@9.12.0']),
    });
    expect(plan.command.cwd).toBe('/tmp/twin/repo/packages/api');
  });

  it('installs node only when the project or command uses it', () => {
    const base = makeCapsule();
    const python = makeCapsule({
      runtimes: { node: '26.7.0', python: '3.13.12' },
      packageManagers: [
        {
          name: 'uv',
          ecosystem: 'python',
          version: '0.11.3',
          declared: null,
          lockfile: 'uv.lock',
          lockfileSha256: 'x',
        },
      ],
      resolved: { python: { click: '8.3.0' } },
      command: { ...base.command, argv: ['uv', 'run', 'pytest'] },
    });
    expect(ids(planReplay(python).setup)).not.toContain('node');
    const script = makeCapsule({
      runtimes: { node: '22.3.0' },
      packageManagers: [],
      resolved: {},
      command: { ...base.command, argv: ['/usr/local/bin/node', 'check.js'] },
    });
    expect(ids(planReplay(script).setup)).toContain('node');
  });

  it('sets up python through uv for python projects', () => {
    const plan = planReplay(
      makeCapsule({
        runtimes: { python: '3.12.4' },
        packageManagers: [
          {
            name: 'uv',
            ecosystem: 'python',
            version: '0.4.20',
            declared: null,
            lockfile: 'uv.lock',
            lockfileSha256: 'x',
          },
        ],
        resolved: { python: { requests: '2.32.3' } },
      }),
    );
    expect(ids(plan.setup)).toEqual(['workspace', 'python', 'checkout', 'python-dependencies']);
    expect(argvText(find(plan.setup, 'python'))).toContain(
      'uv venv --python 3.12.4 /tmp/twin/venv',
    );
    expect(plan.env).toMatchObject({
      VIRTUAL_ENV: '/tmp/twin/venv',
      UV_PROJECT_ENVIRONMENT: '/tmp/twin/venv',
    });
    expect(plan.env.PATH?.startsWith('/tmp/twin/venv/bin:/tmp/twin/tools/uv:')).toBe(true);
  });

  it('notes platform differences replay cannot recreate', () => {
    const base = makeCapsule();
    expect(
      planReplay(makeCapsule({ os: { ...base.os, platform: 'darwin', distro: 'macos' } })).notes,
    ).toContain('Captured on darwin (macos); replayed on Linux with the same versions.');
    expect(planReplay(makeCapsule({ os: { ...base.os, libc: 'musl' } })).notes).toContain(
      'Captured on musl libc; the replay machine uses glibc.',
    );
  });

  it('notes unsupported package managers', () => {
    const plan = planReplay(
      makeCapsule({
        packageManagers: [
          {
            name: 'deno',
            ecosystem: 'node',
            version: '2',
            declared: null,
            lockfile: null,
            lockfileSha256: null,
          },
        ],
      }),
    );
    expect(ids(plan.setup)).not.toContain('dependencies');
    expect(plan.notes).toContain(
      'Package manager deno is not supported for replay yet; dependencies were not installed.',
    );
  });

  it('refuses capsules it cannot check out', () => {
    expect(() => planReplay(makeCapsule({ repo: null }))).toThrow(/pass --repo/);
    const base = makeCapsule();
    const repo = { ...(base.repo as NonNullable<Capsule['repo']>), commit: null };
    expect(() => planReplay(makeCapsule({ repo }))).toThrow(/pass --ref/);
  });
});

describe('nodeManagerCommands', () => {
  const pm = (
    name: string,
    version: string | null,
    lockfile: string | null = 'lock',
  ): PackageManagerFact => ({
    name,
    ecosystem: 'node',
    version,
    declared: null,
    lockfile,
    lockfileSha256: null,
  });

  it.each([
    [pm('npm', null, null), { setup: null, install: ['npm', 'install'] }],
    [
      pm('pnpm', null, null),
      { setup: ['npm', 'install', '-g', 'pnpm'], install: ['pnpm', 'install'] },
    ],
    [
      pm('yarn', '1.22.22'),
      {
        setup: ['npm', 'install', '-g', 'yarn@1.22.22'],
        install: ['yarn', 'install', '--frozen-lockfile'],
      },
    ],
    [
      pm('yarn', '4.5.0'),
      {
        setup: ['npm', 'install', '-g', '@yarnpkg/cli-dist@4.5.0'],
        install: ['yarn', 'install', '--immutable'],
      },
    ],
    [
      pm('yarn', null, null),
      { setup: ['npm', 'install', '-g', 'yarn'], install: ['yarn', 'install'] },
    ],
    [
      pm('bun', '1.1.0'),
      {
        setup: ['npm', 'install', '-g', 'bun@1.1.0'],
        install: ['bun', 'install', '--frozen-lockfile'],
      },
    ],
    [
      pm('bun', null, null),
      { setup: ['npm', 'install', '-g', 'bun'], install: ['bun', 'install'] },
    ],
    [pm('deno', '2.0.0'), null],
  ])('%o', (manager, expected) => {
    expect(nodeManagerCommands(manager)).toEqual(expected);
  });
  it('refuses refs and URLs that git would read as options', () => {
    expect(() => planReplay(makeCapsule(), { ref: '--upload-pack=x' })).toThrow(/must not start/);
    expect(() => planReplay(makeCapsule(), { repoUrl: '-oProxyCommand=x' })).toThrow(
      /must not start/,
    );
  });
  it('sets NO_COLOR unless the reporter had a colour setting, since capture ran piped', () => {
    const base = makeCapsule();
    expect(planReplay(base).env.NO_COLOR).toBe('1');
    const forced = makeCapsule({ env: { ...base.env, FORCE_COLOR: { state: 'set', value: '1' } } });
    expect(planReplay(forced).env).not.toHaveProperty('NO_COLOR');
    expect(planReplay(base, { env: { NO_COLOR: '' } }).env.NO_COLOR).toBe('');
  });
});
