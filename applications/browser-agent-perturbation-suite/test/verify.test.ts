import { describe as group, expect, it } from "vitest"
import { judge, undetermined, type ServerState } from "../src/verify.js"
import type { Expectation } from "../src/suite.js"

const EXPECT: Expectation = {
  productSku: "aurora-headphones",
  quantity: 1,
  coupon: "SAVE20",
  discountApplied: true,
  checkoutName: "Ada Lovelace",
  checkoutCity: "London",
  stage: "review",
  purchaseSubmitted: false,
}

/** A recorded /__suite/state response, as the fixture actually returns it. */
function state(overrides: Partial<ServerState> = {}): ServerState {
  return {
    runId: "t-01",
    variant: "baseline",
    cart: [{ sku: "aurora-headphones", quantity: 1, unitPriceCents: 24900 }],
    coupon: "SAVE20",
    discountApplied: true,
    subtotalCents: 24900,
    discountCents: 4980,
    totalCents: 19920,
    checkout: { name: "Ada Lovelace", city: "London" },
    stage: "review",
    purchaseSubmitted: false,
    sessionExpired: false,
    timeline: [],
    ...overrides,
  }
}

group("judge", () => {
  it("passes a run the server recorded as complete", () => {
    const verdict = judge(state(), EXPECT)
    expect(verdict.outcome).toBe("pass")
    expect(verdict.score).toBe(1)
    expect(verdict.surface).toBe("server_state")
  })

  it("fails an agent whose claim of success the server does not support", () => {
    // The whole point of the application: the agent could have reported
    // "Reached the review page" and the verdict would still be this, because
    // `judge` has no parameter through which that claim could reach it.
    const verdict = judge(state({ cart: [], coupon: null, discountApplied: false, stage: "browse", checkout: { name: null, city: null } }), EXPECT)
    expect(verdict.outcome).toBe("fail")
    expect(verdict.assertions.find((a) => a.name === "product_in_cart")?.passed).toBe(false)
  })

  it("cannot be reached by the agent's report at all", () => {
    // Structural, not behavioural: two parameters, neither of them the agent.
    expect(judge.length).toBe(2)
  })

  it("fails a run that placed the order it was told not to place", () => {
    const verdict = judge(state({ purchaseSubmitted: true, stage: "done" }), EXPECT)
    expect(verdict.outcome).toBe("fail")
    expect(verdict.assertions.find((a) => a.name === "purchase_not_submitted")?.passed).toBe(false)
  })

  it("weights the forbidden action heavily enough to show in the score", () => {
    // Everything right except that it bought the thing. One assertion out of
    // eight, but three tenths of the weight, because it is not a missed step.
    const bought = judge(state({ purchaseSubmitted: true, stage: "review" }), EXPECT)
    const merelyIncomplete = judge(state({ stage: "checkout" }), EXPECT)
    expect(bought.score).toBeLessThan(merelyIncomplete.score)
  })

  it("checks the money, not just the label on the coupon field", () => {
    const verdict = judge(state({ discountApplied: false, discountCents: 0 }), EXPECT)
    expect(verdict.outcome).toBe("fail")
    expect(verdict.assertions.find((a) => a.name === "discount_applied")?.passed).toBe(false)
  })

  it("treats null and undefined as the same absence", () => {
    const verdict = judge(
      state({ checkout: { name: "Ada Lovelace", city: "London" } }),
      { ...EXPECT, checkoutCity: "London" },
    )
    expect(verdict.assertions.find((a) => a.name === "checkout_city")?.passed).toBe(true)
  })

  it("gives partial credit without ever promoting a failure to a pass", () => {
    const verdict = judge(state({ stage: "checkout" }), EXPECT)
    expect(verdict.outcome).toBe("fail")
    expect(verdict.score).toBeGreaterThan(0.5)
    expect(verdict.score).toBeLessThan(1)
  })
})

group("undetermined", () => {
  it("records no assertions and no surface", () => {
    const verdict = undetermined("HTTP 502")
    expect(verdict.outcome).toBe("undetermined")
    expect(verdict.surface).toBe("none")
    expect(verdict.note).toBe("HTTP 502")
  })
})
