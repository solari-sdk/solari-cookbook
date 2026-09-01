/**
 * Persistent profiles — log in once, reuse the session forever.
 *
 * A profile stores cookies + localStorage server-side. Attach it with
 * `profileId` and pass the returned state to your context, and the browser
 * starts already logged in, so you stop paying the login (and the 2FA, and the
 * bot check) on every run.
 *
 * Run this file twice: the first run logs in and saves, the second reuses it.
 */
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const PROFILE_NAME = "cookbook-demo"

// Reuse the profile across runs; create it the first time only.
const existing = (await solari.profiles.list()).find((p) => p.name === PROFILE_NAME)
const profile = existing ?? (await solari.profiles.create({ name: PROFILE_NAME }))
console.log(existing ? `reusing profile ${profile.id}` : `created profile ${profile.id}`)

const browser = await solari.launch({ profileId: profile.id })
try {
  // Attaching a profile hands its state to `session.storageState`. It does not
  // seed the browser, so the state has to go to the context you create. A page
  // from `browser.newPage()` starts anonymous and the counter below never
  // leaves 1, however many times you run this.
  const context = await browser.newContext({
    storageState: browser.session.storageState ?? undefined,
  })
  const page = await context.newPage()

  // This demo site echoes whatever is in localStorage/cookies back to you, so
  // you can see state survive between runs. Swap it for your real login flow.
  await page.goto("https://example.com")

  const seen = await page.evaluate(() => {
    const n = Number(localStorage.getItem("visits") ?? "0") + 1
    localStorage.setItem("visits", String(n))
    return n
  })
  console.log(`visit #${seen} for this profile`)

  // Persist whatever the browser accumulated. Without this the session's state
  // is discarded on release — attaching a profile does not auto-save it.
  const state = await context.storageState()
  const { version, sizeBytes } = await solari.profiles.save(profile.id, state)
  console.log(`saved profile v${version} (${sizeBytes} bytes)`)
} finally {
  await browser.close()
  // Required, or the process never exits — see browser-quickstart-ts.
  await solari.close()
}
