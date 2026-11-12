/**
 * Diagnosis engine. See design.md §4.
 *
 * A pure function `CheckResult[] -> Diagnosis[]`: no I/O, no network, no
 * filesystem, no SDK. Enforced by a lint import restriction on
 * `src/diagnosis/**`.
 *
 * A check only reports on itself. Correlating results here avoids duplicating
 * cross-check logic — such as version awareness — into every check that would
 * otherwise need it.
 */

import type { CheckResult, CheckStatus, Confidence, Diagnosis } from "../types.js";

/**
 * Read-only view over one run's results.
 *
 * Rules receive this rather than the array so they cannot iterate or
 * accumulate state; determinism depends on rules being pure.
 */
export interface ResultLookup {
  /** The result for a check id, or `undefined` if it did not run. */
  get(id: string): CheckResult | undefined;
  /** The status for a check id, or `undefined` if it did not run. */
  status(id: string): CheckStatus | undefined;
  /** True when the check ran and its status is one of `statuses`. */
  is(id: string, ...statuses: CheckStatus[]): boolean;
  /** A single evidence value, or `undefined`. Never throws on a missing key. */
  evidence(id: string, key: string): unknown;
}

export interface DiagnosisRule {
  /** Stable id for the rule. Not a check id. */
  id: string;
  /**
   * Check ids this rule reads. Becomes `supportingChecks`, filtered to those
   * that produced a result, so a diagnosis never cites a check that did not run.
   */
  reads: readonly string[];
  /** Must be pure and must not close over mutable state. */
  matches(results: ResultLookup): boolean;
  cause: string;
  confidence: Confidence;
  remediation: string;
  issueRef?: string;
}

function createLookup(results: readonly CheckResult[]): ResultLookup {
  const byId = new Map(results.map((r) => [r.id, r]));
  return {
    get: (id) => byId.get(id),
    status: (id) => byId.get(id)?.status,
    is: (id, ...statuses) => {
      const status = byId.get(id)?.status;
      return status !== undefined && statuses.includes(status);
    },
    evidence: (id, key) => byId.get(id)?.evidence?.[key],
  };
}

/**
 * Correlates results into named causes, in rule declaration order.
 *
 * Deterministic. Display ordering is left to the renderer. A rule that throws
 * is skipped rather than failing the run, mirroring the scheduler's handling of
 * a throwing check.
 */
export function diagnose(
  results: readonly CheckResult[],
  rules: readonly DiagnosisRule[],
): Diagnosis[] {
  const lookup = createLookup(results);
  const ran = new Set(results.map((r) => r.id));
  const diagnoses: Diagnosis[] = [];

  for (const rule of rules) {
    let matched: boolean;
    try {
      matched = rule.matches(lookup);
    } catch {
      continue;
    }
    if (!matched) continue;

    diagnoses.push({
      cause: rule.cause,
      confidence: rule.confidence,
      remediation: rule.remediation,
      supportingChecks: rule.reads.filter((id) => ran.has(id)),
      ...(rule.issueRef !== undefined ? { issueRef: rule.issueRef } : {}),
    });
  }

  return diagnoses;
}
