import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execProcess, toWindowsCommandLine } from '../../src/util/exec.ts';
import { ancestors, findUp, pathExists, toPosixRelative } from '../../src/util/fs.ts';
import { hmacSha256Hex, sha256Hex } from '../../src/util/hash.ts';
import { useTempDirs, writeTree } from '../helpers/fakes.ts';

describe('fs helpers', () => {
  const tempDir = useTempDirs();

  it('lists ancestors up to and including the stop directory', () => {
    expect(ancestors('/a/b/c', '/a')).toEqual(['/a/b/c', '/a/b', '/a']);
    expect(ancestors('/a/b', '/elsewhere')).toEqual(['/a/b', '/a', '/']);
    expect(ancestors('/a')).toEqual(['/a', '/']);
  });

  it('finds the nearest file upward without passing the stop directory', async () => {
    const root = await tempDir();
    await writeTree(root, { 'marker.txt': '', 'sub/deep/.keep': '' });
    const deep = join(root, 'sub/deep');
    expect(await findUp('marker.txt', deep, root)).toBe(join(root, 'marker.txt'));
    expect(await findUp('marker.txt', deep, join(root, 'sub'))).toBeNull();
  });

  it('checks existence', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'x'));
    expect(await pathExists(join(root, 'x'))).toBe(true);
    expect(await pathExists(join(root, 'y'))).toBe(false);
  });

  it('makes portable relative paths', () => {
    expect(toPosixRelative('/r', '/r')).toBe('.');
    expect(toPosixRelative('/r', '/r/a/b')).toBe('a/b');
  });
});

describe('hash helpers', () => {
  it('produces hex digests', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hmacSha256Hex('k', 'v')).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacSha256Hex('k', 'v')).not.toBe(hmacSha256Hex('other', 'v'));
  });
});

describe('execProcess', () => {
  it('collects output of successful commands', async () => {
    const result = await execProcess([process.execPath, '-e', 'console.log("hi")']);
    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      notFound: false,
      timedOut: false,
    });
  });

  it('reports failures without throwing', async () => {
    const result = await execProcess([
      process.execPath,
      '-e',
      'console.error("bad"); process.exit(4)',
    ]);
    expect(result).toMatchObject({ ok: false, exitCode: 4, stderr: 'bad\n', notFound: false });
  });

  it('reports missing executables', async () => {
    const result = await execProcess(['definitely-not-a-real-command-xyz']);
    expect(result).toMatchObject({ ok: false, notFound: true });
  });

  it('reports timeouts', async () => {
    const result = await execProcess([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], {
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  it('does not hang on commands that read stdin', async () => {
    const result = await execProcess([
      process.execPath,
      '-e',
      'process.stdin.resume().on("end", () => console.log("eof"))',
    ]);
    expect(result.stdout).toBe('eof\n');
  });
});

describe('toWindowsCommandLine', () => {
  it('quotes only arguments that need it', () => {
    expect(toWindowsCommandLine(['npm', 'run', 'test:unit', '--', 'a b', 'say "hi"'])).toBe(
      'npm run test:unit -- "a b" "say \\"hi\\""',
    );
  });
});
