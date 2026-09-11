import type { Page } from "playwright-core"
import type { FillEntry } from "./fill-plan.js"

export const CREDENTIALS = { email: "vendor@meridian.example", password: "trustfill-demo" }

/** Thrown when the portal is not shaped the way the adapter expects. */
export class PortalChangedError extends Error {}

/**
 * Deterministic. Stable `data-testid` selectors, known navigation — no model
 * decides where to click. AI is for reading documents; this is not that.
 */
export async function ensureSignedIn(page: Page, portalUrl: string): Promise<{ loggedIn: boolean }> {
  const target = new URL(portalUrl)
  target.pathname = "/questionnaire"
  await page.goto(target.toString(), { waitUntil: "domcontentloaded" })

  // A restored profile lands straight on the questionnaire; a cold one is
  // bounced to /login. That difference IS the profile demo.
  if (await page.locator('[data-testid="questionnaire-form"]').count()) return { loggedIn: false }

  const email = page.locator('[data-testid="login-email"]')
  if (!(await email.count())) {
    throw new PortalChangedError(
      `expected either the questionnaire form or the login form at ${page.url()}, found neither`,
    )
  }

  await email.fill(CREDENTIALS.email)
  await page.locator('[data-testid="login-password"]').fill(CREDENTIALS.password)
  await page.locator('[data-testid="login-submit"]').click()
  await page.waitForSelector('[data-testid="questionnaire-form"]', { timeout: 15_000 })
  return { loggedIn: true }
}

export interface FillOutcome {
  filled: number
  leftBlank: number
  missingFields: string[]
}

export async function fillQuestionnaire(page: Page, plan: FillEntry[]): Promise<FillOutcome> {
  let filled = 0
  let leftBlank = 0
  const missingFields: string[] = []

  for (const entry of plan) {
    const field = page.locator(`[data-testid="answer-${entry.questionId}"]`)
    if (!(await field.count())) {
      // Do not silently skip: a missing field means the portal changed shape and
      // a "26 of 30 answered" claim would be false.
      missingFields.push(entry.questionId)
      continue
    }

    if (entry.action === "FILL" && entry.value) {
      await field.fill(entry.value)
      filled++
    } else {
      await field.fill("")
      leftBlank++
    }
  }

  if (missingFields.length) {
    throw new PortalChangedError(`no field for: ${missingFields.join(", ")}`)
  }

  return { filled, leftBlank, missingFields }
}
