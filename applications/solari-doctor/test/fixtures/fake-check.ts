/**
 * Fake `DoctorCheck`s for unit tests.
 *
 * design.md §10: the registry and scheduler are tested against fakes, with no
 * live calls. Shared so both suites exercise the same shape.
 */

import type { CheckResult, CostTier, DoctorCheck } from "../../src/types.js";

export interface FakeCheckOptions {
  costTier?: CostTier;
  dependsOn?: string[];
  description?: string;
  /** Overrides merged into the `CheckResult` the fake returns. */
  result?: Partial<CheckResult>;
  /** Called on each `run()`, for observing ordering and concurrency. */
  onRun?: (id: string) => void | Promise<void>;
}

export function fakeCheck(
  id: string,
  options: FakeCheckOptions = {},
): DoctorCheck {
  return {
    id,
    description: options.description ?? `fake check ${id}`,
    costTier: options.costTier ?? "free",
    // Conditional spread: an absent option must stay absent under
    // `exactOptionalPropertyTypes`.
    ...(options.dependsOn !== undefined ? { dependsOn: options.dependsOn } : {}),
    async run(): Promise<CheckResult> {
      await options.onRun?.(id);
      return {
        id,
        status: "pass",
        message: `fake check ${id} ran`,
        durationMs: 0,
        ...options.result,
      };
    },
  };
}
