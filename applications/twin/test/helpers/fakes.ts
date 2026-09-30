import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import type { Host } from '../../src/host.ts';
import type { Io, Output } from '../../src/io.ts';
import type { LocalTerminal } from '../../src/shell/session.ts';
import type { Exec, ExecResult } from '../../src/util/exec.ts';

export function ok(stdout: string, stderr = ''): ExecResult {
  return { ok: true, exitCode: 0, stdout, stderr, notFound: false, timedOut: false };
}

export function failed(stderr = '', exitCode = 1): ExecResult {
  return { ok: false, exitCode, stdout: '', stderr, notFound: false, timedOut: false };
}

export const NOT_FOUND: ExecResult = {
  ok: false,
  exitCode: null,
  stdout: '',
  stderr: '',
  notFound: true,
  timedOut: false,
};

/**
 * Exec double keyed by the joined argv. Unknown commands behave like missing executables, and
 * every call is recorded for assertions.
 */
export function fakeExec(responses: Record<string, ExecResult> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    return responses[argv.join(' ')] ?? NOT_FOUND;
  };
  return { exec, calls };
}

export class MemoryOutput implements Output {
  text = '';
  readonly isTTY: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string | Uint8Array): void {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
}

export function fakeIo(options: { interactive?: boolean; answers?: string[] } = {}) {
  const answers = [...(options.answers ?? [])];
  const prompts: string[] = [];
  const stdout = new MemoryOutput();
  const stderr = new MemoryOutput();
  const io: Io = {
    stdout,
    stderr,
    interactive: options.interactive ?? false,
    prompt: async (question) => {
      prompts.push(question);
      return answers.shift() ?? null;
    },
  };
  return { io, stdout, stderr, prompts };
}

export function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    exec: fakeExec().exec,
    env: {},
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.8.0',
    homeDir: '/home/alice',
    now: () => new Date('2026-09-28T10:00:00.000Z'),
    readTextFile: async () => {
      throw new Error('no such file');
    },
    fetch: async () => {
      throw new Error('this test must not use the network');
    },
    glibcVersion: () => '2.39',
    intlDefaults: () => ({ timeZone: 'Asia/Kolkata', locale: 'en-IN' }),
    ...overrides,
  };
}

/** A fresh temp directory per call, removed after the current test. */
export function useTempDirs(): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twin-test-'));
    dirs.push(dir);
    return dir;
  };
}

/** Writes `{ 'a/b.json': 'text' }` under root, creating directories. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export const manifest = (name: string, version: string) => JSON.stringify({ name, version });

/** For contexts whose commands must never reach a backend. */
export const noBackend = async (): Promise<never> => {
  throw new Error('this test must not use a backend');
};

/** A local terminal driven by the test: push keystrokes and resizes, read what was shown. */
export function fakeLocal(cols = 100, rows = 30) {
  let onInput: ((data: Uint8Array) => void) | undefined;
  let onResize: (() => void) | undefined;
  const state = { shown: '', stopped: false, cols, rows };
  const local: LocalTerminal = {
    size: () => ({ cols: state.cols, rows: state.rows }),
    write: (data) => {
      state.shown += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    },
    start: (input, resize) => {
      onInput = input;
      onResize = resize;
      return () => {
        state.stopped = true;
      };
    },
  };
  return {
    local,
    state,
    type: (text: string) => onInput?.(Buffer.from(text, 'utf8')),
    press: (byte: number) => onInput?.(Uint8Array.of(byte)),
    resize: (c: number, r: number) => {
      state.cols = c;
      state.rows = r;
      onResize?.();
    },
  };
}
