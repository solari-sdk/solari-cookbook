import type { AgentReport } from "./agent.js"
import type { Failure } from "./classify.js"
import { flipRate, wilsonInterval, type Interval } from "./stats.js"
import type { Thresholds } from "./suite.js"
import type { Outcome, Verdict } from "./verify.js"

export interface TrialResult {
  id: string
  variant: string
  repetition: number
  seed: number
  outcome: Outcome
  score: number
  durationMs: number
  /** The agent's own account. Evidence beside the verdict, never inside it. */
  agent: AgentReport | null
  verdict: Verdict
  failure: Failure | null
}

export interface VariantSummary {
  variant: string
  passed: number
  scorable: number
  undetermined: number
  meanScore: number
  /** null when there are fewer than two scorable repetitions to compare. */
  flips: number | null
  failures: Failure[]
}

export interface SuiteResult {
  agent: string
  trials: TrialResult[]
  byVariant: VariantSummary[]
  reliability: Interval
  baseline: Interval | null
  perturbed: Interval | null
  undetermined: number
}

/** Only `pass` and `fail` count; see `Outcome` for why `undetermined` does not. */
export function isScorable(outcome: Outcome): boolean {
  return outcome === "pass" || outcome === "fail"
}

export function summarise(agent: string, trials: TrialResult[]): SuiteResult {
  const variants = [...new Set(trials.map((t) => t.variant))]

  const byVariant = variants.map((variant): VariantSummary => {
    const own = trials.filter((t) => t.variant === variant)
    const scorable = own.filter((t) => isScorable(t.outcome))
    return {
      variant,
      passed: scorable.filter((t) => t.outcome === "pass").length,
      scorable: scorable.length,
      undetermined: own.length - scorable.length,
      meanScore: scorable.length === 0 ? 0 : mean(scorable.map((t) => t.score)),
      // Repetitions of an identical configuration, in order. Disagreement
      // between them is unpredictability, which a pass rate alone cannot show.
      flips: flipRate(
        [...scorable].sort((a, b) => a.repetition - b.repetition).map((t) => t.outcome === "pass"),
      ),
      failures: own.map((t) => t.failure).filter((f): f is Failure => f !== null),
    }
  })

  const scorable = trials.filter((t) => isScorable(t.outcome))
  const rate = (subset: TrialResult[]): Interval =>
    wilsonInterval(subset.filter((t) => t.outcome === "pass").length, subset.length)

  const baseline = scorable.filter((t) => t.variant === "baseline")
  const perturbed = scorable.filter((t) => t.variant !== "baseline")

  return {
    agent,
    trials,
    byVariant,
    reliability: rate(scorable),
    baseline: baseline.length > 0 ? rate(baseline) : null,
    perturbed: perturbed.length > 0 ? rate(perturbed) : null,
    undetermined: trials.length - scorable.length,
  }
}

export interface ThresholdCheck {
  name: string
  required: number
  actual: number
  met: boolean
}

/**
 * Check only what was configured.
 *
 * A threshold nobody set is not a threshold of zero, and it is not a silent
 * pass either — it simply is not checked, and the report says so. Inventing a
 * default here would fail suites their author never asked to gate.
 *
 * `baseline` deserves its own gate because it is the control. If the agent
 * cannot do the task in the unperturbed environment, the task or the fixture is
 * broken and every perturbed number below it is meaningless.
 */
export function evaluateThresholds(result: SuiteResult, thresholds: Thresholds): ThresholdCheck[] {
  const checks: ThresholdCheck[] = []

  if (thresholds.reliability !== undefined) {
    checks.push({
      name: "reliability",
      required: thresholds.reliability,
      actual: result.reliability.point,
      met: result.reliability.point >= thresholds.reliability,
    })
  }

  if (thresholds.baseline !== undefined) {
    // No baseline trials means the control was never run, so the gate cannot be
    // satisfied. Reporting it as met would be the more dangerous answer.
    const actual = result.baseline?.point ?? 0
    checks.push({
      name: "baseline",
      required: thresholds.baseline,
      actual,
      met: result.baseline !== null && actual >= thresholds.baseline,
    })
  }

  return checks
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
