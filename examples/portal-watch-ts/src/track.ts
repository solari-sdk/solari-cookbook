/**
 * Visit one tracked portal and return its visible status text.
 *
 * Uses a named Solari profile per portal so login only happens once — see
 * examples/browser-profiles-ts. The mock portal here fakes a login form; for
 * a real ATS, swap the block below for that site's actual login flow (and if
 * it's SSO/magic-link/2FA, you'll want a one-time interactive setup instead
 * of scripted credentials — see the README).
 */
import { Solari } from "@solarisdk/browser"
import type { TrackedPortal } from "./types.js"

export async function fetchPortalText(portal: TrackedPortal): Promise<string> {
  const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
  try {
    const existing = (await solari.profiles.list()).find((p) => p.name === portal.profileName)
    const profile = existing ?? (await solari.profiles.create({ name: portal.profileName }))

    const browser = await solari.launch({ profileId: profile.id })
    try {
      const page = await browser.newPage()
      await page.goto(portal.url)

      const loginForm = page.locator("#login-form")
      if (await loginForm.isVisible().catch(() => false)) {
        await page.locator("#username").fill(process.env.PORTAL_DEMO_USER ?? "demo")
        await page.locator("#password").fill(process.env.PORTAL_DEMO_PASS ?? "demo")
        await page.locator("#login-submit").click()
      }

      await page.waitForSelector("#status", { state: "visible" })
      const text = await page.locator("#status").innerText()

      // Persist whatever the login left in cookies/localStorage — without
      // this, the next run starts logged out again. See browser-profiles-ts.
      const state = await page.context().storageState()
      await solari.profiles.save(profile.id, state)

      return text
    } finally {
      await browser.close()
    }
  } finally {
    await solari.close()
  }
}
