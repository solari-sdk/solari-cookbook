import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRepo, sanitizeRemote } from '../../../src/capture/facts/repo.ts';
import { Redactor } from '../../../src/redact/redactor.ts';
import { execProcess } from '../../../src/util/exec.ts';
import { useTempDirs, writeTree } from '../../helpers/fakes.ts';

// Real git against temp repos: the collector's value is in the exact git invocations.
function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      stdio: 'ignore',
    },
  );
}

async function initRepo(dir: string) {
  git(dir, 'init', '-q', '-b', 'main');
  await writeTree(dir, { 'a.txt': 'one\n' });
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

describe('sanitizeRemote', () => {
  it.each([
    ['https://user:ghp_x@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://github.com/o/r', 'https://github.com/o/r'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
  ])('%s', (input, expected) => {
    expect(sanitizeRemote(input)).toBe(expected);
  });
});

describe('collectRepo', () => {
  const tempDir = useTempDirs();

  it('returns null outside a git work tree', async () => {
    expect(await collectRepo(execProcess, await tempDir(), new Redactor())).toBeNull();
  });

  it('records a clean checkout', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    git(dir, 'remote', 'add', 'origin', 'https://bob:pw@example.com/o/r.git');
    const info = await collectRepo(execProcess, dir, new Redactor());
    expect(info?.root).toBe(await realpath(dir));
    expect(info?.fact).toMatchObject({
      remote: 'https://example.com/o/r.git',
      branch: 'main',
      dirty: false,
      diff: '',
      diffTruncated: false,
      diffRedacted: false,
      untracked: [],
    });
    expect(info?.fact.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('captures tracked changes as a diff and untracked files by name only', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await writeTree(dir, { 'a.txt': 'two\n', 'notes/secret.txt': 'do not read me' });
    const info = await collectRepo(execProcess, join(dir, 'notes'), new Redactor());
    expect(info?.fact.dirty).toBe(true);
    expect(info?.fact.diff).toContain('-one\n+two');
    expect(info?.fact.untracked).toEqual(['notes/secret.txt']);
    expect(JSON.stringify(info)).not.toContain('do not read me');
  });

  it('scrubs secrets in the diff and flags it', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await writeTree(dir, { 'a.txt': 'API_KEY=abcd1234efgh\n' });
    const redactor = new Redactor();
    const info = await collectRepo(execProcess, dir, redactor);
    expect(info?.fact.diff).toContain('API_KEY=<redacted:assignment>');
    expect(info?.fact.diffRedacted).toBe(true);
    expect(redactor.counts()).toEqual({ assignment: 1 });
  });

  it('handles a repo with no commits', async () => {
    const dir = await tempDir();
    git(dir, 'init', '-q', '-b', 'main');
    await writeTree(dir, { 'new.txt': 'x' });
    const info = await collectRepo(execProcess, dir, new Redactor());
    expect(info?.fact).toMatchObject({
      commit: null,
      remote: null,
      dirty: true,
      untracked: ['new.txt'],
    });
  });
});
