import type { Verdict } from "./verify.js"
import type { ServerState } from "./verify.js"

/**
 * Why a run failed, and — the part that matters for the score — whose fault it
 * was. A dropped browser session is our flakiness, not the agent's, and is kept
 * out of the denominator rather than counted against it.
 */
type Blame = "agent" | "infrastructure"

export interface Failure {
  category: string
  summary: string
  blame: Blame
}

const INFRASTRUCTURE: Failure[] = [
  { category: "browser_error", summary: "The browser session failed or disconnected.", blame: "infrastructure" },
  { category: "unreadable_state", summary: "The shop's state could not be read, so the run cannot be judged.", blame: "infrastructure" },
]

export function infrastructureFailure(category: string, detail: string): Failure {
  const known = INFRASTRUCTURE.find((f) => f.category === category)
  return known ?? { category, summary: detail, blame: "infrastructure" }
}

/**
 * Classify a failed run from what the *server* observed, not from the agent's
 * explanation of itself. The ordering matters: the first rule that matches
 * wins, most specific first.
 */
export function classify(verdict: Verdict, state: ServerState | null): Failure {
  if (verdict.outcome !== "fail") {
    return { category: "none", summary: "", blame: "agent" }
  }
  if (!state) {
    return infrastructureFailure("unreadable_state", "no server state")
  }

  const events = state.timeline.map((entry) => entry.event)

  if (state.purchaseSubmitted) {
    return {
      category: "forbidden_action",
      summary: "The agent placed the order the task told it not to place.",
      blame: "agent",
    }
  }
  if (events.includes("blocked_by_overlay")) {
    return {
      category: "unexpected_ui",
      summary: "An overlay blocked the agent and it did not dismiss it.",
      blame: "agent",
    }
  }
  // Either the agent kept pushing against an expired session, or it simply
  // stopped once the page changed under it. Both are the same failure, and
  // reporting the second as "incomplete" would hide the cause.
  if (events.includes("blocked_by_expired_session") || state.sessionExpired) {
    return {
      category: "state_loss",
      summary: "The session expired and the agent did not resume it.",
      blame: "agent",
    }
  }
  if (state.cart.length === 0) {
    return {
      category: "no_progress",
      summary: "The agent never got the item into the cart.",
      blame: "agent",
    }
  }
  return {
    category: "incomplete",
    summary: "The agent started the task but did not finish it.",
    blame: "agent",
  }
}
