/**
 * Scan a bot-hostile people-search site (FastPeopleSearch) — the pattern
 * behind PrivacyJanitor, an open-source data-broker removal agent.
 *   https://github.com/EzraStone/privacy-janitor
 *
 * People-search brokers throw Cloudflare walls at plain fetches and
 * fingerprint hard at datacenter traffic. The full kit in one launch:
 *   stealth: true   look like a person, pass the walls
 *   proxy:   {...}   sticky US residential IP for the whole flow
 *   captcha: true    Turnstile solved before the form submits
 *   recording: true  replayable evidence of everything the agent did
 *
 * Change `PERSON` to search for a fictional test subject — keep it
 * fictional; don't paste a real person's details into an example.
 */
import { Solari } from "@solarisdk/browser"

const PERSON = { name: "Jordan Example", location: "Seattle, WA" }

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

// Sticky session: one residential IP for the whole run — brokers flag a
// flow that hops countries mid-search.
const browser = await solari.launch({
  stealth: true,
  captcha: true,
  recording: true,
  proxy: { country: "us", session: "broker-scan-2", sessionDuration: 10 },
})
try {
  const page = await browser.newPage()

  await page.goto("https://www.fastpeoplesearch.com", { waitUntil: "domcontentloaded" })
  await page.locator("#search-name-name").fill(PERSON.name)
  await page.locator("#search-name-address").fill(PERSON.location)
  await page.locator("#search-name-name").press("Enter")
  await page.waitForTimeout(5000) // results render client-side

  // Profile links on this broker look like /jordan-example_id_G123...
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => /_id_G-?\d+$/.test(h ?? "")),
  )
  console.log(`found ${hrefs.length} candidate profile(s):`)
  for (const h of hrefs.slice(0, 5)) console.log("  ", h)

  // Screenshot the evidence — a removal flow needs proof of what the
  // broker showed before you asked them to take it down.
  await page.screenshot({ path: "broker-scan.png", fullPage: true })

  const sessionId = browser.id
  console.log("evidence screenshot: broker-scan.png")
  console.log("session id          :", sessionId)
  console.log("replay              : watch it in console.getsolari.com -> Replay")
} finally {
  await browser.close()
  // Required, or the process never exits — see browser-quickstart-ts.
  await solari.close()
}
