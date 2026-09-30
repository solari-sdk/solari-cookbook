import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCapsule } from '../../src/capsule/file.ts';
import { decodeCapsule } from '../../src/capsule/schema.ts';
import { main } from '../../src/cli.ts';
import type { CommandContext } from '../../src/commands/context.ts';
import { realHost } from '../../src/host.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { fakeIo, noBackend, useTempDirs, writeTree } from '../helpers/fakes.ts';

const FAILING = [
  process.execPath,
  '-e',
  'console.error("Error: expected 1 to be 2"); process.exit(1)',
];

describe('twin capture (end to end on the real host)', () => {
  const tempDir = useTempDirs();

  async function repo() {
    const dir = await tempDir();
    await writeTree(dir, { 'package.json': '{"name":"demo"}' });
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {
          cwd: dir,
          stdio: 'ignore',
        },
      );
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
  }

  function context(cwd: string, io: ReturnType<typeof fakeIo>['io']): CommandContext {
    return {
      io,
      host: { ...realHost(), env: { ...process.env, NO_COLOR: '1' } },
      cwd,
      version: '0.0.0-test',
      getBackend: noBackend,
    };
  }

  it('writes a valid capsule with --yes', async () => {
    const dir = await repo();
    const { io, stdout, stderr } = fakeIo();
    const code = await main(
      ['capture', '--yes', '--out', 'bug.json', '--', ...FAILING],
      context(dir, io),
    );
    expect(code).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('Error: expected 1 to be 2');
    expect(stderr.text).toContain('FAIL (exit 1)');
    expect(stderr.text).toContain('Wrote bug.json');
    const capsule = decodeCapsule(JSON.parse(await readFile(join(dir, 'bug.json'), 'utf8')));
    expect(capsule.command).toMatchObject({ outcome: 'fail', exitCode: 1, cwd: '.' });
    expect(capsule.command.failure?.keyLines).toEqual(['Error: expected 1 to be 2']);
    expect(capsule.repo?.branch).toBe('main');
    expect(capsule.runtimes.node).toBe(process.versions.node);
  });

  it('asks before writing and honors "no"', async () => {
    const dir = await repo();
    const { io, stderr, prompts } = fakeIo({ interactive: true, answers: ['v', 'n'] });
    const code = await main(['capture', '--', ...FAILING], context(dir, io));
    expect(code).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(stderr.text).toContain('"twin": 1');
    expect(stderr.text).toContain('No capsule written.');
    await expect(readFile(join(dir, 'twin-capsule.json'))).rejects.toThrow();
  });

  it('writes after "yes" and notes a passing command', async () => {
    const dir = await repo();
    const { io, stderr } = fakeIo({ interactive: true, answers: ['y'] });
    const code = await main(['capture', '--', process.execPath, '-e', ''], context(dir, io));
    expect(code).toBe(0);
    expect(stderr.text).toContain('The command passed');
    expect(JSON.parse(await readFile(join(dir, 'twin-capsule.json'), 'utf8')).command.outcome).toBe(
      'pass',
    );
  });

  it('refuses to prompt without a terminal', async () => {
    const { io, stderr } = fakeIo({ interactive: false });
    expect(await main(['capture', '--', 'true'], context(await tempDir(), io))).toBe(2);
    expect(stderr.text).toContain('pass --yes');
  });

  it('requires a command', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['capture', '--yes'], context(await tempDir(), io))).toBe(2);
    expect(stderr.text).toContain('missing command to run');
  });

  it('reports a missing executable', async () => {
    const { io, stderr } = fakeIo();
    const code = await main(
      ['capture', '-y', '--', 'definitely-not-a-real-command-xyz'],
      context(await tempDir(), io),
    );
    expect(code).toBe(127);
    expect(stderr.text).toContain('command not found: definitely-not-a-real-command-xyz');
  });

  it('prints help', async () => {
    const { io, stdout } = fakeIo();
    expect(await main(['capture', '--help'], context(await tempDir(), io))).toBe(0);
    expect(stdout.text).toContain('Usage: twin capture');
  });
});

describe('twin inspect', () => {
  const tempDir = useTempDirs();

  async function files() {
    const dir = await tempDir();
    const bad = makeCapsule();
    await writeCapsule(join(dir, 'bad.json'), bad);
    await writeCapsule(join(dir, 'good.json'), makeCapsule({ runtimes: { node: '20.17.0' } }));
    return dir;
  }

  const context = (cwd: string, io: ReturnType<typeof fakeIo>['io']): CommandContext => ({
    io,
    host: { ...realHost(), env: {} },
    cwd,
    version: '0.0.0-test',
    getBackend: noBackend,
  });

  it('summarizes one capsule', async () => {
    const { io, stdout } = fakeIo();
    expect(await main(['inspect', 'bad.json'], context(await files(), io))).toBe(0);
    expect(stdout.text).toContain('signature  exit1:0123456789abcdef');
  });

  it('prints one capsule as JSON', async () => {
    const { io, stdout } = fakeIo();
    expect(await main(['inspect', 'bad.json', '--json'], context(await files(), io))).toBe(0);
    expect(decodeCapsule(JSON.parse(stdout.text))).toEqual(makeCapsule());
  });

  it.each(['diff', 'inspect'])('diffs two capsules with %s', async (command) => {
    const { io, stdout } = fakeIo();
    expect(await main([command, 'good.json', 'bad.json'], context(await files(), io))).toBe(0);
    expect(stdout.text).toContain('1 difference: - good.json  + bad.json');
    expect(stdout.text).toMatch(/node\s+- 20\.17\.0\s+\+ 22\.3\.0/);
  });

  it('diffs two capsules as JSON', async () => {
    const { io, stdout } = fakeIo();
    await main(['diff', 'good.json', 'bad.json', '--json'], context(await files(), io));
    expect(JSON.parse(stdout.text)).toEqual([
      { category: 'runtime', key: 'node', a: '20.17.0', b: '22.3.0' },
    ]);
  });

  it('explains unreadable capsules', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['inspect', 'nope.json'], context(await files(), io))).toBe(1);
    expect(stderr.text).toMatch(/twin: cannot read .*nope\.json: ENOENT/);
  });

  it('validates argument count', async () => {
    const { io, stderr } = fakeIo();
    expect(await main(['inspect'], context(await files(), io))).toBe(2);
    expect(await main(['inspect', 'a', 'b', 'c'], context(await files(), io))).toBe(2);
    expect(stderr.text).toContain('expected one capsule');
    expect(await main(['diff', 'a'], context(await files(), io))).toBe(2);
    expect(stderr.text).toContain('expected two capsules');
  });
});
