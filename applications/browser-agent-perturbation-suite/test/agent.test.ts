import { describe as group, expect, it } from "vitest"
import { createAgent, type PageLike } from "../src/agent.js"
import type { TaskSpec } from "../src/suite.js"

const TASK: TaskSpec = {
  description: "d", maxSteps: 25, timeoutMs: 90_000,
  expect: {
    productSku: "aurora-headphones", quantity: 1, coupon: "SAVE20", discountApplied: true,
    checkoutName: "Ada Lovelace", checkoutCity: "London", stage: "review", purchaseSubmitted: false,
  },
}

/**
 * A page with an overlay on it. `actionable` answers the way a real document
 * would: the button underneath is present and visible, and still not clickable.
 */
function fakePage(options: { overlay?: string } = {}): PageLike & { log: string[] } {
  const log: string[] = []
  let overlay = options.overlay ?? null

  return {
    log,
    goto: async (url) => void log.push(`goto ${url}`),
    click: async (selector) => {
      if (selector === overlay) {
        overlay = null
        log.push(`dismissed ${selector}`)
        return
      }
      log.push(overlay ? `blocked ${selector}` : `click ${selector}`)
    },
    fill: async (selector, value) => void log.push(`fill ${selector}=${value}`),
    waitMs: async () => {},
    actionable: async (selector) => (overlay === null ? true : selector === overlay),
  }
}

group("the scripted agent", () => {
  it("walks the task and stops before placing the order", async () => {
    const page = fakePage()
    const report = await createAgent("naive").run({ page, task: TASK, startUrl: "https://x/" })

    expect(report.finishReason).toBe("finished")
    // The task forbids paying, and nothing in the plan clicks it.
    expect(page.log.some((line) => line.includes("place-order"))).toBe(false)
    expect(page.log).toContain("fill #coupon=SAVE20")
  })

  it("naive: walks straight into an overlay without ever looking", async () => {
    const page = fakePage({ overlay: "#accept-cookies" })
    await createAgent("naive").run({ page, task: TASK, startUrl: "https://x/" })

    expect(page.log).toContain("blocked #add-to-cart")
    expect(page.log.some((line) => line.startsWith("dismissed"))).toBe(false)
  })

  it("resilient: clears the overlay first, then acts", async () => {
    const page = fakePage({ overlay: "#accept-cookies" })
    await createAgent("resilient").run({ page, task: TASK, startUrl: "https://x/" })

    expect(page.log).toContain("dismissed #accept-cookies")
    expect(page.log).toContain("click #add-to-cart")
    expect(page.log.some((line) => line.startsWith("blocked"))).toBe(false)
  })

  it("gives up on the step budget instead of running forever", async () => {
    const page = fakePage()
    const report = await createAgent("naive").run({
      page, task: { ...TASK, maxSteps: 3 }, startUrl: "https://x/",
    })

    expect(report.finishReason).toBe("max_steps")
    expect(report.steps).toBe(3)
  })

  it("reports an error as a claim rather than throwing out of the run", async () => {
    const page = fakePage()
    page.click = async () => {
      throw new Error("element not found")
    }
    const report = await createAgent("naive").run({ page, task: TASK, startUrl: "https://x/" })

    expect(report.finishReason).toBe("error")
    expect(report.message).toBe("element not found")
  })
})
