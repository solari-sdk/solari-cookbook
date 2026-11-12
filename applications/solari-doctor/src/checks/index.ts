/**
 * Check registry. See design.md §15.
 *
 * The only place that enumerates checks. Nothing downstream may hold a second
 * list or switch on check ids; adding or removing a check is a change to
 * `CHECKS` and nowhere else.
 *
 * Identity and validation only. Execution order, dependency waiting and
 * concurrency belong to the scheduler (design.md §7).
 */

import { authCheck } from "./auth.js";
import { browserLifecycleCheck } from "./browser-lifecycle.js";
import { recordingLifecycleCheck } from "./recording-lifecycle.js";
import { sandboxCleanupCheck } from "./sandbox-cleanup.js";
import { sandboxCommandCheck } from "./sandbox-command.js";
import { sdkVersionCheck } from "./sdk-version.js";
import { sessionLivenessCheck } from "./session-liveness.js";
import type { DoctorCheck } from "../types.js";

export interface CheckRegistry {
  /** Registration order. Frozen. */
  all(): readonly DoctorCheck[];
  /** Registration order. Frozen. */
  ids(): readonly string[];
  /** Used by `--explain <id>`. */
  get(id: string): DoctorCheck | undefined;
  has(id: string): boolean;
}

/**
 * Builds a registry from a check list.
 *
 * Throws on a duplicate id or a `dependsOn` that names an unregistered check.
 * Both are build defects rather than diagnosable environments, so they fail at
 * construction rather than producing a `CheckResult`.
 */
export function createCheckRegistry(
  checks: readonly DoctorCheck[],
): CheckRegistry {
  const byId = new Map<string, DoctorCheck>();

  for (const check of checks) {
    if (byId.has(check.id)) {
      throw new Error(
        `Duplicate check id "${check.id}" in the registry. Each check id must ` +
          `be unique — ids appear in CheckResult.id, in --explain, and in ` +
          `dependsOn, so a duplicate makes all three ambiguous.`,
      );
    }
    byId.set(check.id, check);
  }

  // design.md §5 requires dependsOn to name registered checks. This is the only
  // place with the full id set. Cycle detection needs the graph and belongs to
  // the scheduler.
  for (const check of checks) {
    for (const dependency of check.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Check "${check.id}" depends on "${dependency}", which is not ` +
            `registered. A dangling dependency would make the check skip ` +
            `forever with no explanation.`,
        );
      }
    }
  }

  const ordered = Object.freeze([...checks]);
  const orderedIds = Object.freeze(ordered.map((c) => c.id));

  return {
    all: () => ordered,
    ids: () => orderedIds,
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
  };
}

/**
 * The static check list, in the order design.md §6 defines them.
 *
 * All seven are now registered. design.md §13 caps the list here: an eighth
 * check requires an explicit change to the locked scope.
 */
const CHECKS: readonly DoctorCheck[] = [
  authCheck,
  sdkVersionCheck,
  browserLifecycleCheck,
  sandboxCommandCheck,
  sandboxCleanupCheck,
  sessionLivenessCheck,
  recordingLifecycleCheck,
];

export const registry: CheckRegistry = createCheckRegistry(CHECKS);
