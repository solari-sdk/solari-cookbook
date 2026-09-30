/** Single-quotes a string for POSIX sh. Safe for any content, including quotes and newlines. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** argv for running a multi-line script under `sh -eu`, so any failing line fails the step. */
export function script(lines: readonly string[]): string[] {
  return ['sh', '-euc', lines.join('\n')];
}

/**
 * Runs argv exactly as captured, but resolves the program through the PATH given in the command's
 * env (so the twin-installed runtime wins) without letting a shell re-parse the arguments.
 */
export function execArgv(argv: readonly string[]): string[] {
  return ['sh', '-c', 'exec "$@"', 'twin', ...argv];
}
