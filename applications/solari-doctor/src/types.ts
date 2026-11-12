/**
 * Core data contracts. See design.md §5.
 *
 * Types only — no logic. Shared vocabulary is declared here and imported;
 * checks must not redeclare it locally (design.md §8.1).
 */

import type { DoctorContext } from "./context.js";

/**
 * Outcome of a single check.
 *
 * `skip` means the check did not run because a dependency failed (design.md
 * §7). An error the check hit itself is `fail`, not `skip`.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/**
 * Scheduling class. Declared on the check so it cannot drift from the code it
 * governs. `expensive` runs only under `--full`.
 */
export type CostTier = "free" | "cheap" | "expensive";

export type Confidence = "low" | "medium" | "high";

/** What one check observed. */
export interface CheckResult {
  /** One of the seven check ids in design.md §6. */
  id: string;
  status: CheckStatus;
  /** One-line summary. For `skip`, names the blocking check. */
  message: string;
  details?: string;
  /** Traceable to documentation or a specific issue (design.md §3). */
  remediation?: string;
  /** Set by the scheduler, not the check. Populated for `skip` too. */
  durationMs: number;
  /** Verified issue references only, e.g. `"solari-cookbook#25"`. */
  issueRef?: string;
  /**
   * Structured facts the check observed. Must contain no secrets; every new
   * key needs a `--report` safety verdict before it ships (design.md §9).
   */
  evidence?: Record<string, unknown>;
}

/** The single abstraction for a check. */
export interface DoctorCheck {
  /** Stable id; also the argument accepted by `--explain`. */
  id: string;
  description: string;
  /** Ids that must pass first. Only `auth` is currently a dependency. */
  dependsOn?: string[];
  costTier: CostTier;
  /**
   * Returns facts. Must not write to stdout or stderr (design.md §4), and must
   * return `status: "fail"` rather than throwing for an expected failure.
   */
  run(ctx: DoctorContext): Promise<CheckResult>;
}

/** A named cause derived from several `CheckResult`s. */
export interface Diagnosis {
  cause: string;
  confidence: Confidence;
  remediation: string;
  /** Non-empty. Every id appeared in the results this was derived from. */
  supportingChecks: string[];
  issueRef?: string;
}
