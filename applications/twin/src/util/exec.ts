import { execFile } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The executable does not exist on PATH. */
  notFound: boolean;
  timedOut: boolean;
}

/**
 * Runs a short, non-interactive command and collects its output. Never rejects for process
 * failures; callers inspect `ok`. Injected everywhere so collectors can be tested without a host.
 */
export type Exec = (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export const execProcess: Exec = (argv, options = {}) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (file === undefined) throw new Error('execProcess: empty argv');
    // Windows resolves npm.cmd, pnpm.cmd etc. only through the shell. Passing args separately
    // with shell:true is deprecated (DEP0190), so the command line is built here instead.
    const onWindows = process.platform === 'win32';
    const child = execFile(
      onWindows ? toWindowsCommandLine(argv) : file,
      onWindows ? [] : args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
        shell: onWindows,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, exitCode: 0, stdout, stderr, notFound: false, timedOut: false });
          return;
        }
        resolve({
          ok: false,
          exitCode: typeof error.code === 'number' ? error.code : null,
          stdout,
          stderr,
          notFound: error.code === 'ENOENT',
          timedOut: error.killed === true && error.signal === 'SIGTERM',
        });
      },
    );
    // Close stdin so a command that unexpectedly prompts fails fast instead of hanging.
    child.stdin?.end();
  });

/** Quotes argv for cmd.exe. Only needs to be good enough for fixed probe commands and user argv. */
export function toWindowsCommandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[\w./:=@+-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`))
    .join(' ');
}
