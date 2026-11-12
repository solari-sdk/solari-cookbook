/**
 * JSON renderer. See design.md §4 and §9.
 *
 * Returns a string; the CLI performs the write. The payload is versioned from
 * v1 so a consumer never has to infer the shape.
 *
 * `schemaVersion` is shared with the `--report` bundle: the same data at
 * different levels of detail, so a single version number covers both.
 */

import type { CheckResult, Diagnosis } from "../types.js";

/** design.md §9. */
export const SCHEMA_VERSION = 1;

export interface JsonReport {
  schemaVersion: number;
  checks: readonly CheckResult[];
  diagnoses: readonly Diagnosis[];
}

export function buildJsonReport(
  results: readonly CheckResult[],
  diagnoses: readonly Diagnosis[],
): JsonReport {
  return { schemaVersion: SCHEMA_VERSION, checks: results, diagnoses };
}

/**
 * Pretty-printed with a trailing newline, so shell redirection produces a
 * well-formed file.
 *
 * `JSON.stringify` omits `undefined`, so an unset optional field is absent from
 * the output rather than serialised as `null`.
 */
export function renderJson(
  results: readonly CheckResult[],
  diagnoses: readonly Diagnosis[],
): string {
  return `${JSON.stringify(buildJsonReport(results, diagnoses), null, 2)}\n`;
}
