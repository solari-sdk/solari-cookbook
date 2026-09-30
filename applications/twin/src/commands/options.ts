import { TwinError } from '../errors.ts';

/** Parses repeated --env NAME=value flags. Splits on the first '=' so values may contain '='. */
export function parseEnvAssignments(assignments: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf('=');
    if (eq <= 0)
      throw new TwinError(`--env expects NAME=value, got "${assignment}"`, { exitCode: 2 });
    env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
  }
  return env;
}

export function positiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TwinError(`${flag} expects a positive whole number, got "${value}"`, { exitCode: 2 });
  }
  return parsed;
}
