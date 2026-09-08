import type { PageLike } from "./agent.js"
import type { Page } from "./browser.js"

/**
 * The narrow `PageLike` the agent sees, over a real Solari page.
 *
 * `actionable` is the interesting one. It answers the question a browser agent
 * most often gets wrong: is this control really clickable, or is something
 * sitting on top of it? Asking the document via `elementFromPoint` is how you
 * find out honestly — a visibility check alone says yes for a button underneath
 * a consent banner, which is precisely the failure the `cookie_banner`
 * perturbation exists to produce.
 */
export function adaptPage(page: Page): PageLike {
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded" })
    },
    click: async (selector) => {
      await page.click(selector, { timeout: 10_000 })
    },
    fill: async (selector, value) => {
      await page.fill(selector, value, { timeout: 10_000 })
    },
    waitMs: async (ms) => {
      await page.waitForTimeout(ms)
    },
    actionable: async (selector) => (await topmostAt(page, selector)) === "self",
  }
}

/**
 * What the document says is on top at this element's centre point.
 *
 * Returns "self" when the element (or a descendant of it) would receive the
 * click, the blocking element's description when something else would, and null
 * when the element is missing or not rendered.
 */
async function topmostAt(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel: string) => {
    const element = document.querySelector(sel)
    if (!(element instanceof HTMLElement)) return null

    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null

    const style = getComputedStyle(element)
    if (style.visibility === "hidden" || style.display === "none") return null
    if (element.closest("[hidden]")) return null

    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    if (!top) return null
    if (element === top || element.contains(top) || top.contains(element)) return "self"

    const blocker = top.closest("[id]")
    return blocker?.id ? `#${blocker.id}` : top.tagName.toLowerCase()
  }, selector)
}
