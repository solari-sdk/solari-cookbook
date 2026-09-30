import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENV_SCRIPT,
  EXIT_MARKER,
  envScript,
  runScript,
  shellScript,
  webTerminalScript,
} from '../../src/shell/guest.ts';
import { useTempDirs } from '../helpers/fakes.ts';

const sh = (...args: string[]) => execFileSync('sh', args, { encoding: 'utf8' });

describe('guest scripts', () => {
  const tempDir = useTempDirs();

  it('exports env values exactly, whatever they contain', async () => {
    const file = join(await tempDir(), 'env.sh');
    const nasty = `it's "quoted" $HOME \`tick\` \\ back`;
    await writeFile(
      file,
      envScript({ NASTY: nasty, PATH: '/opt/node/bin:/usr/bin', TZ: 'Asia/Kolkata' }),
    );
    expect(sh('-c', `. ${file}; printf '%s|%s|%s' "$NASTY" "$TZ" "$PATH"`)).toBe(
      `${nasty}|Asia/Kolkata|/opt/node/bin:/usr/bin`,
    );
  });

  it('writes a shell entry point that sources the env, enters the repo and marks its exit', async () => {
    const text = shellScript({
      cwd: '/tmp/twin/repo/packages/api',
      argv: ['npm', 'test', '--', 'a b'],
      commit: 'abc123def4567890',
    });
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain(`. ${ENV_SCRIPT}`);
    expect(text).toContain('cd /tmp/twin/repo/packages/api');
    const file = join(await tempDir(), 'shell.sh');
    await writeFile(file, text);
    sh('-n', file);
    // With no terminal attached the interactive shell ends at once and the marker is printed last.
    const output = execFileSync('sh', [file], { encoding: 'utf8', input: '', stdio: 'pipe' });
    expect(output.endsWith(EXIT_MARKER)).toBe(true);
    expect(output).toContain("twin: you are in the reporter's environment");
    expect(output).toContain('commit abc123def456');
    expect(output).toContain("rerun the failing command with: npm test -- 'a b'");
  });

  it('runs one command line in the environment and directory of the failing command', async () => {
    const dir = await tempDir();
    const text = runScript({ cwd: dir });
    expect(text).toContain(`. ${ENV_SCRIPT}`);
    const file = join(dir, 'run.sh');
    await writeFile(file, text);
    sh('-n', file);
    expect(sh(file, 'pwd && echo "$((1 + 1))" && exit 0')).toBe(`${dir}\n2\n`);
    expect(() => sh(file, 'exit 3')).toThrow();
  });

  it('starts the web terminal with credentials, a pidfile and a readiness wait', async () => {
    const lines = webTerminalScript({ port: 7681, user: 'twin', password: 'p@ss w' });
    const text = lines.join('\n');
    expect(text).toContain('releases/download/1.7.7/ttyd.$arch');
    expect(text).toContain("--credential 'twin:p@ss w'");
    expect(text).toContain('--writable --port 7681');
    expect(text).toContain('echo $! > /tmp/twin/ttyd.pid');
    expect(text).not.toContain('pkill');
    expect(text).not.toContain('/dev/tcp');
    const file = join(await tempDir(), 'web.sh');
    await writeFile(file, text);
    sh('-n', file);
  });
});
