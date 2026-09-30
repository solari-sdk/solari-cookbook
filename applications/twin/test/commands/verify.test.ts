import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/backend/fake.ts';
import { serializeCapsule, writeCapsule } from '../../src/capsule/file.ts';
import { main } from '../../src/cli.ts';
import { planReplay } from '../../src/replay/plan.ts';
import { FIX_PATCH_PATH } from '../../src/replay/runtimes.ts';
import { failureIdentity } from '../../src/signature/signature.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { fakeHost, fakeIo, useTempDirs } from '../helpers/fakes.ts';

const FAILURE = 'AssertionError: expected 1 to be 2';
const FIX = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-bug\n+fix\n';

function failingCapsule() {
  const base = makeCapsule();
  return makeCapsule({
    command: {
      ...base.command,
      failure: { ...failureIdentity({ exitCode: 1, signal: null }, FAILURE), outputTail: FAILURE },
    },
  });
}

/** Fails like the capsule unless the fix patch was applied on the machine. */
function backendWhereFixWorks(fixWorks: boolean) {
  let patched = false;
  return new FakeBackend((spec) => {
    if (spec.argv.join(' ') === `git apply --whitespace=nowarn ${FIX_PATCH_PATH}`) patched = true;
    if (!spec.argv.includes('exec "$@"')) return undefined;
    return patched && fixWorks ? { exitCode: 0 } : { exitCode: 1, output: FAILURE };
  });
}

describe('planReplay with a patch', () => {
  it('uploads and applies the fix after checkout, as a required step', () => {
    const { setup } = planReplay(failingCapsule(), { patch: FIX });
    const ids = setup.map((step) => step.id);
    expect(ids.indexOf('patch')).toBeGreaterThan(ids.indexOf('checkout'));
    expect(setup.find((s) => s.id === 'patch-file')).toMatchObject({
      kind: 'write',
      path: FIX_PATCH_PATH,
      content: FIX,
    });
    expect(setup.find((s) => s.id === 'patch')).toMatchObject({
      argv: ['git', 'apply', '--whitespace=nowarn', FIX_PATCH_PATH],
      cwd: '/tmp/twin/repo',
    });
    expect(setup.find((s) => s.id === 'patch')).not.toHaveProperty('optional');
  });
});

describe('twin verify', () => {
  const tempDir = useTempDirs();

  async function setup(backend: FakeBackend, capsule = failingCapsule()) {
    const dir = await tempDir();
    await writeCapsule(join(dir, 'bug.json'), capsule);
    await writeFile(join(dir, 'fix.patch'), FIX);
    const { io, stdout, stderr } = fakeIo();
    const context = {
      io,
      host: fakeHost(),
      cwd: dir,
      version: 't',
      getBackend: async () => backend,
    };
    return { context, stdout, stderr };
  }

  it('exits 0 when the fix makes the command pass', async () => {
    const backend = backendWhereFixWorks(true);
    const { context, stdout } = await setup(backend);
    expect(
      await main(['verify', 'bug.json', '--patch', 'fix.patch', '--attempts', '2'], context),
    ).toBe(0);
    expect(stdout.text).toContain("FIXED: the command passes in the reporter's environment");
    expect(stdout.text).toMatch(/^Verify on fake/);
    // One machine runs the command without the fix first, another with it.
    expect(backend.machines).toHaveLength(2);
    expect(backend.machines[0]?.files.has(FIX_PATCH_PATH)).toBe(false);
    expect(backend.machines[1]?.files.get(FIX_PATCH_PATH)).toBe(FIX);
  });

  it('is inconclusive when the failure does not reproduce without the fix', async () => {
    // Replay installs from the lockfile, so a fresh-install failure passes here, fix or not.
    const backend = new FakeBackend((spec) =>
      spec.argv.includes('exec "$@"') ? { exitCode: 0 } : undefined,
    );
    const { context, stdout } = await setup(backend);
    expect(
      await main(['verify', 'bug.json', '--patch', 'fix.patch', '--comment', 'c.md'], context),
    ).toBe(1);
    expect(stdout.text).toContain('INCONCLUSIVE: the failure did not reproduce without the fix');
    expect(stdout.text).toContain('twin bisect');
    expect(stdout.text).not.toContain('FIXED');
    // No second machine and no fix upload: the fix was never tried.
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]?.files.has(FIX_PATCH_PATH)).toBe(false);
    const comment = await readFile(join(context.cwd, 'c.md'), 'utf8');
    expect(comment.startsWith('<!-- twin-verify verdict=inconclusive -->\n')).toBe(true);
    expect(comment).toContain('did not reproduce without the fix');
  });

  it('is inconclusive when the failure without the fix is a different one', async () => {
    const backend = new FakeBackend((spec) =>
      spec.argv.includes('exec "$@"') ? { exitCode: 1, output: 'TypeError: other' } : undefined,
    );
    const { context, stdout } = await setup(backend);
    expect(await main(['verify', 'bug.json', '--patch', 'fix.patch'], context)).toBe(1);
    expect(stdout.text).toContain('it failed differently');
  });

  it('writes a pull request comment when asked', async () => {
    const backend = backendWhereFixWorks(true);
    const { context } = await setup(backend);
    const url = 'https://github.com/user-attachments/files/1/twin-capsule.json';
    context.host = fakeHost({
      fetch: async () => new Response(serializeCapsule(failingCapsule())),
    });
    expect(await main(['verify', url, '--patch', 'fix.patch', '--comment', 'c.md'], context)).toBe(
      0,
    );
    const comment = await readFile(join(context.cwd, 'c.md'), 'utf8');
    expect(comment.startsWith('<!-- twin-verify verdict=fixed -->\n')).toBe(true);
    expect(comment).toContain(`[capsule](${url})`);
  });

  it('exits 1 when the failure is unchanged', async () => {
    const { context, stdout } = await setup(backendWhereFixWorks(false));
    expect(await main(['verify', 'bug.json', '--patch', 'fix.patch'], context)).toBe(1);
    expect(stdout.text).toContain('STILL FAILING');
  });

  it('checks out a fix ref from a fork and prints JSON', async () => {
    let fixed = false;
    const backend = new FakeBackend((spec) => {
      if (spec.argv.join(' ').includes('origin fix123')) fixed = true;
      if (!spec.argv.includes('exec "$@"')) return undefined;
      return fixed ? { exitCode: 0 } : { exitCode: 1, output: FAILURE };
    });
    const { context, stdout } = await setup(backend);
    const code = await main(
      ['verify', 'bug.json', '--ref', 'fix123', '--repo', 'https://e.com/fork.git', '--json'],
      context,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      verdict: 'not-reproduced',
      baseline: { verdict: 'reproduced' },
    });
    const checkout = backend.machines[1]?.runs.find((r) => r.argv.join(' ').includes('git fetch'));
    expect(checkout?.argv.join(' ')).toContain('https://e.com/fork.git');
    expect(checkout?.argv.join(' ')).toContain('origin fix123');
  });

  it('explains a patch that does not apply', async () => {
    const backend = new FakeBackend((spec) => {
      if (spec.argv[1] === 'apply') return { exitCode: 1, output: 'patch does not apply' };
      return spec.argv.includes('exec "$@"') ? { exitCode: 1, output: FAILURE } : undefined;
    });
    const { context, stdout } = await setup(backend);
    expect(await main(['verify', 'bug.json', '--patch', 'fix.patch'], context)).toBe(1);
    expect(stdout.text).toContain('patch does not apply');
    expect(stdout.text).toContain("INCONCLUSIVE: the fix did not apply to the capsule's tree");
  });

  it.each([
    [['verify', 'bug.json'], 'pass exactly one of --patch or --ref'],
    [
      ['verify', 'bug.json', '--patch', 'fix.patch', '--ref', 'x'],
      'pass exactly one of --patch or --ref',
    ],
    [['verify'], 'expected one capsule path'],
    [['verify', 'bug.json', '--patch', 'missing.patch'], 'cannot read'],
  ])('rejects %j', async (argv, message) => {
    const { context, stderr } = await setup(backendWhereFixWorks(true));
    expect(await main(argv, context)).not.toBe(0);
    expect(stderr.text).toContain(message);
  });

  it('refuses a capsule that recorded a passing run', async () => {
    const base = makeCapsule();
    const passing = makeCapsule({
      command: { ...base.command, exitCode: 0, outcome: 'pass', failure: null },
    });
    const { context, stderr } = await setup(backendWhereFixWorks(true), passing);
    expect(await main(['verify', 'bug.json', '--patch', 'fix.patch'], context)).toBe(2);
    expect(stderr.text).toContain('no failure to verify');
  });

  it('prints help', async () => {
    const { context, stdout } = await setup(backendWhereFixWorks(true));
    expect(await main(['verify', '--help'], context)).toBe(0);
    expect(stdout.text).toContain('Usage: twin verify');
  });
});
