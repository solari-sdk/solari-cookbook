import { describe as group, expect, it } from "vitest"
import { evaluateThresholds, summarise, type TrialResult } from "../src/aggregate.js"
import { renderReport } from "../src/report.js"

function trial(variant: string, outcome: TrialResult["outcome"], repetition = 1): TrialResult {
  return {
    id: `${variant}-${repetition}`, variant, repetition, seed: 1,
    outcome, score: outcome === "pass" ? 1 : 0.4, durationMs: 4100, agent: null,
    verdict: { outcome, score: 0, assertions: [], surface: "server_state" },
    failure:
      outcome === "fail"
        ? { category: "unexpected_ui", summary: "An overlay blocked the agent.", blame: "agent" }
        : null,
  }
}

const result = summarise("naive", [
  trial("baseline", "pass", 1),
  trial("baseline", "pass", 2),
  trial("cookie_banner", "fail", 1),
  trial("cookie_banner", "fail", 2),
])

group("renderReport", () => {
  it("prints the interval and the sample size together, never a bare percentage", () => {
    const output = renderReport(result, [])
    expect(output).toContain("Reliability")
    expect(output).toMatch(/95% CI \d+\.\d%\s*-\s*\d+\.\d%/)
    expect(output).toContain("(2/4)")
  })

  it("says plainly when nothing was gated, rather than printing a green PASS", () => {
    expect(renderReport(result, [])).toContain("nothing to fail against")
    expect(renderReport(result, [])).not.toMatch(/^\s{2}PASS$/m)
  })

  it("fails loudly when a configured threshold was missed", () => {
    const output = renderReport(result, evaluateThresholds(result, { reliability: 0.85 }))
    expect(output).toContain("FAIL  reliability required 85.0%, got 50.0%")
    expect(output).toMatch(/^\s{2}FAIL$/m)
  })

  it("groups the failure explanations instead of repeating them per trial", () => {
    const output = renderReport(result, [])
    expect(output).toContain("Why the failures failed")
    expect(output).toContain("x2  An overlay blocked the agent.")
  })

  it("labels undetermined trials as our failure, not the agent's", () => {
    const withInfra = summarise("naive", [
      trial("baseline", "pass"),
      trial("slow_api", "undetermined"),
    ])
    expect(renderReport(withInfra, [])).toContain("excluded from the denominator")
  })
})
