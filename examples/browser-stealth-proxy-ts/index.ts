/**
 * Stealth mode + managed proxy — reach a site that blocks datacenter traffic.
 *
 * Two independent knobs:
 *   stealth: true   runtime fingerprint patches + a headful browser on real GPU
 *   proxy:   "us"   residential egress in that country
 *
 * `proxy` and `captcha` both REQUIRE `stealth: true` — a proxied request from an
 * obviously-automated browser is the pairing that gets blocked. Shorthands:
 *
 *   proxy: "us"                        residential, United States
 *   proxy: { country: "gb" }           residential, United Kingdom
 *   proxy: { country: "us", tier: "mobile" }
 *   proxy: { country: "us", session: "warm-1" }   sticky IP across sessions
 *   proxy: "smart"                     let Solari pick and rotate on block
 */
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

const browser = await solari.launch({
  stealth: true,
  proxy: "us",
  // captcha: true,   // managed reCAPTCHA / hCaptcha / Turnstile solving

  // Sticky egress — pin one IP for a whole multi-step flow:
  //
  //   proxy: { country: "us", session: "checkout-42", sessionDuration: 15 }
  //
  // Residential egress rotates by default, so a login on one IP and the next
  // page on another looks like a session hijack to anything watching, and you
  // get challenged mid-flow. `session` is any id up to 32 characters and
  // `sessionDuration` is minutes, 1 to 30, default 10 — set it longer than the
  // flow takes, because the pin lapses on the clock, not on completion.
  // Reuse the same id on a later run and you land on the same IP again while
  // it lasts. (Recipe from @EzraStone.)
})
try {
  const page = await browser.newPage()

  // Echoes the egress IP the target site actually sees — i.e. the proxy's,
  // not your machine's and not the pool host's.
  await page.goto("https://api.ipify.org?format=json")
  console.log("egress :", await page.locator("pre").innerText())

  // `browser.proxy` reports what the gateway resolved (country/tier/timezone),
  // never the upstream vendor credentials.
  console.log("proxy  :", JSON.stringify(browser.proxy))
} finally {
  await browser.close()
  // Optional as of 0.1.3, and no longer needed to exit — see browser-quickstart-ts.
  await solari.close()
}
