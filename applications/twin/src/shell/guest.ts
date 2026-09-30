import { REPO_DIR, TOOLS_DIR, WORK_DIR } from '../replay/runtimes.ts';
import { shellQuote } from '../replay/shell.ts';

/**
 * Files a kept machine carries so a later `twin shell` (from any computer) lands in the reporter's
 * environment without needing the capsule again.
 */
export const ENV_SCRIPT = `${WORK_DIR}/env.sh`;
export const SHELL_SCRIPT = `${WORK_DIR}/shell.sh`;
/** Runs one command line in the reporter's environment: `run.sh '<command>'`. Used by agents. */
export const RUN_SCRIPT = `${WORK_DIR}/run.sh`;

/**
 * Printed by the shell script when the interactive shell ends. The SDK's PTY has no exit event,
 * so this OSC sequence (invisible in terminals) is how `twin shell` notices the session is over.
 */
export const EXIT_MARKER = '\u001b]twin;exit\u0007';

export const WEB_TERMINAL_PORT = 7681;
const TTYD_VERSION = '1.7.7';

/** Names `export` accepts. Others (from a crafted capsule or --env) would abort or inject into env.sh. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function envScript(env: Readonly<Record<string, string>>): string {
  const lines = Object.entries(env)
    .filter(([name]) => SHELL_NAME.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  return `${lines.join('\n')}\n`;
}

export interface ShellScriptOptions {
  /** Working directory of the captured command, inside the guest. */
  cwd: string;
  argv: readonly string[];
  commit: string | null;
}

export function shellScript(options: ShellScriptOptions): string {
  const rerun = options.argv.map(shellQuote).join(' ');
  const banner = [
    "twin: you are in the reporter's environment",
    options.commit ? `commit ${options.commit.slice(0, 12)}` : null,
    `rerun the failing command with: ${rerun}`,
  ]
    .filter(Boolean)
    .join('; ');
  return [
    '#!/bin/sh',
    `[ -f ${ENV_SCRIPT} ] && . ${ENV_SCRIPT}`,
    `cd ${shellQuote(options.cwd)} 2>/dev/null || cd ${REPO_DIR} 2>/dev/null`,
    `printf '%s\\n' ${shellQuote(banner)}`,
    'if command -v bash >/dev/null 2>&1; then bash -i; else sh -i; fi',
    `printf ${shellQuote(EXIT_MARKER.replace('\u001b', '\\033').replace('\u0007', '\\007'))}`,
    '',
  ].join('\n');
}

/** Entry point for one-off commands, in the same environment and directory as the shell. */
export function runScript(options: { cwd: string }): string {
  return [
    '#!/bin/sh',
    `[ -f ${ENV_SCRIPT} ] && . ${ENV_SCRIPT}`,
    `cd ${shellQuote(options.cwd)} 2>/dev/null || cd ${REPO_DIR}`,
    'if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; fi',
    'exec sh -c "$1"',
    '',
  ].join('\n');
}

/**
 * Starts ttyd (a single static binary) serving the shell script with HTTP basic auth. The preview
 * URL alone would give anyone who sees it a root shell, so the password is a second factor.
 */
export function webTerminalScript(options: {
  port: number;
  user: string;
  password: string;
}): string[] {
  const binary = `${TOOLS_DIR}/ttyd`;
  const pidFile = `${WORK_DIR}/ttyd.pid`;
  return [
    `if [ ! -x ${binary} ]; then`,
    `  case "$(uname -m)" in x86_64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac`,
    `  mkdir -p ${TOOLS_DIR}`,
    `  curl -fsSL -o ${binary} "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.$arch"`,
    `  chmod +x ${binary}`,
    'fi',
    // Restart cleanly if a previous web terminal is still running (pidfile, not pkill -f, which
    // would also match this script's own command line).
    `[ -f ${pidFile} ] && kill "$(cat ${pidFile})" 2>/dev/null || true`,
    `nohup ${binary} --writable --port ${options.port} --credential ${shellQuote(`${options.user}:${options.password}`)} ${SHELL_SCRIPT} >${WORK_DIR}/ttyd.log 2>&1 &`,
    `echo $! > ${pidFile}`,
    // Wait until it answers (401 without credentials is fine) so the link works when printed.
    `for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:${options.port}/ && exit 0; sleep 0.2; done`,
    `cat ${WORK_DIR}/ttyd.log >&2`,
    'exit 1',
  ];
}
