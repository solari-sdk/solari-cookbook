import { sha256Hex } from '../util/hash.ts';
import { normalizeOutput } from './normalize.ts';

const ERROR_LINE =
  /\b(?:error|errors|fail|failed|failure|failing|exception|traceback|panic|panicked|assert|assertion|expected|received|cannot|unable|not found|undefined|segmentation fault|fatal|abort(?:ed)?)\b|[✗✕×✖]/i;

const MAX_KEY_LINES = 12;
const FALLBACK_LINES = 8;

export interface FailureIdentity {
  signature: string;
  keyLines: string[];
}

/**
 * Picks the lines that identify a failure: the first error-looking lines (the root cause tends to
 * be reported first), or the last lines of output when nothing looks like an error.
 */
export function selectKeyLines(lines: readonly string[]): string[] {
  const errors = lines.filter((line) => ERROR_LINE.test(line));
  return errors.length > 0 ? errors.slice(0, MAX_KEY_LINES) : lines.slice(-FALLBACK_LINES);
}

/**
 * Computes a failure signature from exit status and output. Two runs with the same signature failed
 * the same way; replay compares signatures so a different failure is not counted as a reproduction.
 * The output must already be scrubbed so both sides normalize identical text.
 */
export function failureIdentity(
  status: { exitCode: number | null; signal: string | null },
  output: string,
): FailureIdentity {
  const keyLines = selectKeyLines(normalizeOutput(output));
  const statusPart = status.signal ?? `exit${status.exitCode ?? '?'}`;
  const digest = sha256Hex(keyLines.join('\n')).slice(0, 16);
  return { signature: `${statusPart}:${digest}`, keyLines };
}
