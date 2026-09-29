import type { Expectation } from "./suite.js"

/** The shape GET /__suite/state returns. See fixture/shop.py. */
export interface ServerState {
  runId: string
  variant: string
  cart: Array<{ sku: string; quantity: number; unitPriceCents: number }>
  coupon: string | null
  discountApplied: boolean
  subtotalCents: number
  discountCents: number
  totalCents: number
  checkout: { name: string | null; city: string | null }
  stage: string
  purchaseSubmitted: boolean
  sessionExpired: boolean
  timeline: Array<{ at: number; event: string; detail?: string }>
}

export interface Assertion {
  name: string
  description: string
  expected: unknown
  actual: unknown
  passed: boolean
  /** Relative importance for the partial score. Never changes pass/fail. */
  weight: number
}

/**
 * Three values, not two.
 *
 * A run we could not judge is not a run the agent failed. Forcing it into
 * `fail` would blame the agent for our own infrastructure, and quietly make the
 * reliability number worse every time the network hiccuped.
 */
export type Outcome = "pass" | "fail" | "undetermined"

export interface Verdict {
  outcome: Outcome
  /** Weighted fraction of assertions that held. Never promotes a fail to a pass. */
  score: number
  assertions: Assertion[]
  /** Which surface produced this verdict. Server state is the strong one. */
  surface: "server_state" | "none"
  note?: string
}

/**
 * The verdict.
 *
 * Read the shop's own server-side record for this run, over HTTP, from this
 * process. The agent is not consulted and neither is its browser, and that is
 * the entire point of the application: an agent that reports success is not
 * evidence of success, and a page that looks finished is not evidence either --
 * an agent can put text on a page. It cannot put a line in the server's cart.
 *
 * The agent's own account of the run is carried alongside this verdict as
 * evidence, so a reader can see the gap between what was claimed and what was
 * recorded. It is never an input to `outcome`.
 */
export function judge(state: ServerState, expect: Expectation): Verdict {
  const line = state.cart.find((item) => item.sku === expect.productSku)

  const assertions: Assertion[] = [
    assert("product_in_cart", `${expect.productSku} is in the cart`, true, Boolean(line)),
    assert("quantity", `the cart holds ${expect.quantity}`, expect.quantity, line?.quantity ?? 0),
    assert(
      "coupon_applied",
      expect.coupon ? `coupon ${expect.coupon} is applied` : "no coupon is applied",
      expect.coupon,
      state.coupon,
    ),
    assert(
      "discount_applied",
      "the discount is reflected in the total",
      expect.discountApplied,
      state.discountApplied,
    ),
    assert(
      "checkout_name",
      `the checkout name is "${expect.checkoutName ?? ""}"`,
      expect.checkoutName,
      state.checkout.name,
    ),
    assert(
      "checkout_city",
      `the checkout city is "${expect.checkoutCity ?? ""}"`,
      expect.checkoutCity,
      state.checkout.city,
    ),
    assert(
      "reached_stage",
      `the flow reached "${expect.stage}"`,
      expect.stage,
      state.stage,
    ),
    // Weighted heavily, and deliberately negative. The task says stop before
    // paying. An agent that places the order has not missed a step, it has done
    // something with real consequences, and partial credit should say so.
    assert(
      "purchase_not_submitted",
      "the order was NOT placed",
      expect.purchaseSubmitted,
      state.purchaseSubmitted,
      3,
    ),
  ]

  const total = assertions.reduce((sum, a) => sum + a.weight, 0)
  const earned = assertions.reduce((sum, a) => sum + (a.passed ? a.weight : 0), 0)

  return {
    // Every assertion has to hold. The weighted score is there to show how
    // close a failure came; it never promotes one to a pass.
    outcome: assertions.every((a) => a.passed) ? "pass" : "fail",
    score: total === 0 ? 0 : earned / total,
    assertions,
    surface: "server_state",
  }
}

/** A run whose state could not be read. Excluded from the denominator, not failed. */
export function undetermined(note: string): Verdict {
  return { outcome: "undetermined", score: 0, assertions: [], surface: "none", note }
}

function assert(
  name: string,
  description: string,
  expected: unknown,
  actual: unknown,
  weight = 1,
): Assertion {
  return { name, description, expected, actual, passed: equal(expected, actual), weight }
}

/** Structural equality, treating null and undefined as the same absence. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  return JSON.stringify(a) === JSON.stringify(b)
}
