import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { TwinError } from '../errors.ts';
import type { Output } from '../io.ts';
import { toWindowsCommandLine } from '../util/exec.ts';
import { TailBuffer } from './tail-buffer.ts';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Live passthrough so the reporter sees the command run as usual. */
  stdout: Output;
  stderr: Output;
  now?: () => number;
  tailLines?: number;
  tailChars?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Interleaved stdout and stderr, last lines only. */
  outputTail: string;
}

/** Lines of output capture fingerprints; replay must fingerprint the same window. */
export const DEFAULT_TAIL_LINES = 200;
const DEFAULT_TAIL_CHARS = 64_000;

/**
 * Runs the reporter's command exactly as given (no extra env, stdin inherited) while recording
 * the tail of its output. Ctrl-C reaches the child through the process group; twin keeps running
 * long enough to report that the capture was interrupted.
 */
export function runCommand(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const [file, ...args] = argv;
  if (file === undefined) throw new TwinError('no command given');
  const now = options.now ?? Date.now;
  const tail = new TailBuffer(options.tailChars ?? DEFAULT_TAIL_CHARS);
  const started = now();
  const onWindows = process.platform === 'win32';

  return new Promise((resolve, reject) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows needs a shell to run .cmd shims; argv is quoted by toWindowsCommandLine
    const child = spawn(onWindows ? toWindowsCommandLine(argv) : file, onWindows ? [] : args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: onWindows,
    });
    const ignoreInterrupt = () => {};
    process.on('SIGINT', ignoreInterrupt);

    const pipe = (stream: NodeJS.ReadableStream, output: Output) => {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => {
        output.write(chunk);
        tail.append(decoder.write(chunk));
      });
      stream.on('end', () => tail.append(decoder.end()));
    };
    pipe(child.stdout, options.stdout);
    pipe(child.stderr, options.stderr);

    child.on('error', (error: NodeJS.ErrnoException) => {
      process.off('SIGINT', ignoreInterrupt);
      reject(
        error.code === 'ENOENT'
          ? new TwinError(`command not found: ${file}`, { exitCode: 127, cause: error })
          : error,
      );
    });
    child.on('close', (exitCode, signal) => {
      process.off('SIGINT', ignoreInterrupt);
      resolve({
        exitCode,
        signal,
        durationMs: Math.round(now() - started),
        outputTail: tail.tail(options.tailLines ?? DEFAULT_TAIL_LINES),
      });
    });
  });
}
