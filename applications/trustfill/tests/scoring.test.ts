import { describe, expect, test } from "vitest"
import { score } from "../src/scoring.js"

// The bug M0 found: an answer was rejected wholesale because the model
// volunteered "version 3.1, last reviewed January 2026" without quoting it.
// Every essential claim was supported. Abstaining there is wrong.
describe("score", () => {
  test("does not abstain when only an incidental claim is unsupported", () => {
    const result = score({
      sufficiency: "SUFFICIENT",
      claims: [
        { claim: "Meridian maintains a documented incident response plan.", essential: true, supported: true },
        { claim: "The plan is version 3.1, last reviewed January 2026.", essential: false, supported: false },
      ],
    })

    expect(result.abstained).toBe(false)
  })

  // T3 in the corpus: the IR plan says a 4-hour RTO, the architecture doc says
  // 12. There is nothing to verify because there is no answer — abstention has
  // to come from the classification, not from the claims.
  test("abstains on CONFLICTING even when no claims are unsupported", () => {
    const result = score({ sufficiency: "CONFLICTING", claims: [] })

    expect(result.abstained).toBe(true)
  })

  // Measured from what the citations establish — never from the model's opinion
  // of itself. M0 clocked self-reported confidence at ~0.95 while abstaining.
  test("trustScore is the fraction of claims that are supported", () => {
    const result = score({
      sufficiency: "SUFFICIENT",
      claims: [
        { claim: "a", essential: true, supported: true },
        { claim: "b", essential: true, supported: true },
        { claim: "c", essential: false, supported: true },
        { claim: "d", essential: false, supported: false },
      ],
    })

    expect(result.trustScore).toBe(0.75)
  })

  test("trustScore is null when there are no claims to measure", () => {
    const result = score({ sufficiency: "INSUFFICIENT", claims: [] })

    expect(result.trustScore).toBeNull()
  })
})
