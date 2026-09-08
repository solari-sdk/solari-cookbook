import { describe as group, expect, it } from "vitest"
import { redact } from "../src/evidence.js"
import { classify, infrastructureFailure } from "../src/classify.js"
import type { ServerState, Verdict } from "../src/verify.js"

const fail: Verdict = { outcome: "fail", score: 0, assertions: [], surface: "server_state" }

function state(over: Partial<ServerState> = {}): ServerState {
  return {
    runId: "t-01", variant: "baseline", cart: [], coupon: null, discountApplied: false,
    subtotalCents: 0, discountCents: 0, totalCents: 0, checkout: { name: null, city: null },
    stage: "browse", purchaseSubmitted: false, sessionExpired: false, timeline: [], ...over,
  }
}

group("redaction", () => {
  it("strips everything that identifies a session, a VM or a preview URL", () => {
    // An evidence bundle is exactly the thing that ends up attached to a bug
    // report, so nothing that could authorise anything may reach the disk.
    const cleaned = redact({
      key: "slr_live_abc123DEF456",
      endpoint: "wss://gateway.getsolari.com/ws/session-xyz",
      site: "https://abcd1234.preview.getsolari.com/?pt_token=tok_9f8e7d",
      keep: "cookie_banner blocked #add-to-cart",
    })

    const json = JSON.stringify(cleaned)
    expect(json).not.toContain("slr_live_")
    expect(json).not.toContain("wss://")
    expect(json).not.toContain("preview.getsolari.com")
    expect(json).not.toContain("pt_token=tok")
    // and it must not destroy the evidence while it is at it
    expect(cleaned.keep).toBe("cookie_banner blocked #add-to-cart")
  })

  it("strips capability strings out of error text, not just out of our own fields", () => {
    // The shapes that used to get through. Each one reaches disk the same way:
    // a throw becomes `describe(error)`, which becomes a verdict note, which is
    // written to trial.json. A DNS failure has no scheme, a connect failure may
    // be http://, and `@solarisdk/browser` interpolates whole response bodies —
    // presigned links and all — into its messages.
    const cleaned = redact({
      dns: "getaddrinfo ENOTFOUND abcd1234.preview.getsolari.com",
      plain: "fetch failed: http://abcd1234.preview.getsolari.com/x?run=t-01",
      release: "failed to release browser session s9f8e7d3a",
      sdk: 'unexpected session response: {"storageStateUrl":"https://s3.example.com/b/k?X-Amz-Signature=deadbeef"}',
    })

    for (const value of Object.values(cleaned)) {
      expect(value).toContain("[redacted]")
    }
    const json = JSON.stringify(cleaned)
    expect(json).not.toContain("preview.getsolari.com")
    expect(json).not.toContain("s9f8e7d3a")
    expect(json).not.toContain("X-Amz-Signature")
  })

  it("survives a secret embedded in serialized JSON without corrupting the document", () => {
    // Redacting the output of JSON.stringify would eat the backslash escaping
    // the quote that ends the URL, and the reparse would throw. Walking the
    // structure instead is why this holds.
    const note = 'body {"url":"https://a.preview.getsolari.com/x"} and then some'
    const cleaned = redact({ nested: { list: [{ note }] }, count: 3, flag: true, empty: null })

    expect(cleaned.nested.list[0]?.note).toContain("[redacted]")
    expect(cleaned.count).toBe(3)
    expect(cleaned.flag).toBe(true)
    expect(cleaned.empty).toBeNull()
  })

  it("leaves ordinary prose and the console link alone", () => {
    // A redactor that eats the report is not an improvement on one that leaks.
    const cleaned = redact({
      why: "An overlay blocked the agent and it did not dismiss it.",
      help: "check https://console.getsolari.com for sessions still running.",
    })

    expect(cleaned.why).toBe("An overlay blocked the agent and it did not dismiss it.")
    expect(cleaned.help).toContain("console.getsolari.com")
  })
})

group("classify", () => {
  it("blames the agent for an overlay it never dismissed", () => {
    const failure = classify(fail, state({ timeline: [{ at: 0.1, event: "blocked_by_overlay" }] }))
    expect(failure).toMatchObject({ category: "unexpected_ui", blame: "agent" })
  })

  it("blames the agent for an expired session it never resumed", () => {
    const failure = classify(
      fail,
      state({ timeline: [{ at: 0.1, event: "blocked_by_expired_session" }] }),
    )
    expect(failure).toMatchObject({ category: "state_loss", blame: "agent" })
  })

  it("puts the forbidden purchase ahead of every other explanation", () => {
    // Ordering matters: a run that both hit an overlay and still managed to buy
    // the thing should be reported as the second, which is the worse fact.
    const failure = classify(
      fail,
      state({ purchaseSubmitted: true, timeline: [{ at: 0.1, event: "blocked_by_overlay" }] }),
    )
    expect(failure.category).toBe("forbidden_action")
  })

  it("never blames the agent for our own infrastructure", () => {
    expect(infrastructureFailure("browser_error", "socket hang up").blame).toBe("infrastructure")
    expect(classify(fail, null).blame).toBe("infrastructure")
  })

  it("has nothing to explain about a run that passed", () => {
    const passed: Verdict = { ...fail, outcome: "pass" }
    expect(classify(passed, state()).category).toBe("none")
  })
})
