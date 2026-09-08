import { describe as group, expect, it } from "vitest"
import { evaluateThresholds, isScorable, summarise, type TrialResult } from "../src/aggregate.js"
import { planTrials } from "../src/run.js"
import { parseSuite } from "../src/suite.js"

function trial(over: Partial<TrialResult> & Pick<TrialResult, "variant" | "outcome">): TrialResult {
  return {
    id: over.id ?? `t-${over.variant}-${over.repetition ?? 1}`,
    repetition: over.repetition ?? 1,
    seed: 1,
    score: over.outcome === "pass" ? 1 : 0,
    durationMs: 1000,
    agent: null,
    verdict: { outcome: over.outcome, score: 0, assertions: [], surface: "server_state" },
    failure: null,
    ...over,
  }
}

group("the grid", () => {
  it("expands variants x repetitions with a stable, distinct seed each", () => {
    const suite = parseSuite(
      JSON.stringify({
        task: { description: "do the thing", expect: {} },
        variants: ["baseline", "cookie_banner"],
        repetitions: 3,
      }),
    )
    const trials = planTrials(suite, "run-1")

    expect(trials).toHaveLength(6)
    expect(new Set(trials.map((t) => t.id)).size).toBe(6)
    expect(new Set(trials.map((t) => t.seed)).size).toBe(6)
    // Same run id must replay the same grid.
    expect(planTrials(suite, "run-1")).toEqual(trials)
  })
})

group("summarise", () => {
  it("keeps undetermined trials out of the denominator", () => {
    // An undetermined trial is our failure, not the agent's. Counting it as a
    // failure would make the agent look worse whenever our own infrastructure
    // wobbled.
    const result = summarise("naive", [
      trial({ variant: "baseline", outcome: "pass" }),
      trial({ variant: "baseline", outcome: "pass", repetition: 2 }),
      trial({ variant: "slow_api", outcome: "undetermined" }),
    ])

    expect(result.reliability.point).toBe(1)
    expect(result.reliability.n).toBe(2)
    expect(result.undetermined).toBe(1)
  })

  it("separates the control from the perturbed arms", () => {
    const result = summarise("naive", [
      trial({ variant: "baseline", outcome: "pass" }),
      trial({ variant: "cookie_banner", outcome: "fail" }),
    ])

    expect(result.baseline?.point).toBe(1)
    expect(result.perturbed?.point).toBe(0)
    expect(result.reliability.point).toBe(0.5)
  })

  it("reports flips per variant, and null when there is nothing to compare", () => {
    const result = summarise("naive", [
      trial({ variant: "flaky", outcome: "pass", repetition: 1 }),
      trial({ variant: "flaky", outcome: "fail", repetition: 2 }),
      trial({ variant: "single", outcome: "pass", repetition: 1 }),
    ])

    expect(result.byVariant.find((v) => v.variant === "flaky")?.flips).toBe(1)
    expect(result.byVariant.find((v) => v.variant === "single")?.flips).toBeNull()
  })

  it("does not produce NaN for a suite where nothing was scorable", () => {
    const result = summarise("naive", [trial({ variant: "baseline", outcome: "undetermined" })])
    expect(result.reliability).toEqual({ point: 0, low: 0, high: 1, n: 0 })
    expect(result.byVariant[0]?.meanScore).toBe(0)
  })

  it("counts only pass and fail as scorable", () => {
    expect(isScorable("pass")).toBe(true)
    expect(isScorable("fail")).toBe(true)
    expect(isScorable("undetermined")).toBe(false)
  })
})

group("evaluateThresholds", () => {
  const result = summarise("naive", [
    trial({ variant: "baseline", outcome: "pass" }),
    trial({ variant: "cookie_banner", outcome: "fail" }),
  ])

  it("checks nothing when nothing was configured", () => {
    // A threshold nobody set is not a threshold of zero.
    expect(evaluateThresholds(result, {})).toEqual([])
  })

  it("fails a reliability gate that was missed", () => {
    const [check] = evaluateThresholds(result, { reliability: 0.85 })
    expect(check).toMatchObject({ name: "reliability", required: 0.85, actual: 0.5, met: false })
  })

  it("passes a gate that was met", () => {
    const [check] = evaluateThresholds(result, { baseline: 1 })
    expect(check?.met).toBe(true)
  })

  it("cannot satisfy a baseline gate when the control never ran", () => {
    // Reporting "met" here would be the more dangerous answer: it would green-
    // light a suite whose control was never measured.
    const noControl = summarise("naive", [trial({ variant: "cookie_banner", outcome: "pass" })])
    const [check] = evaluateThresholds(noControl, { baseline: 1 })
    expect(check?.met).toBe(false)
  })
})
