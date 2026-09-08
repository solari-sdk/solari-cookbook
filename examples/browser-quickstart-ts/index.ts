/**
 * Browser quickstart — launch a cloud browser, open a page, read it, close.
 *
 * `launch()` creates a session and connects a Playwright-compatible browser to
 * it in one call. Everything after that is ordinary Playwright: the browser
 * just happens to be running on Solari's infrastructure rather than your laptop.
 */
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

// `browser.close()` also RELEASES the session. Closing the browser alone would
// leave the slot held until the plan deadline, so prefer try/finally (or
// `await using browser = ...` on Node 22+, which disposes it for you).
const browser = await solari.launch()
try {
  const page = await browser.newPage()
  await page.goto("https://example.com")

  console.log("title :", await page.title())
  console.log("h1    :", await page.locator("h1").innerText())
  console.log("session:", browser.id)
} finally {
  await browser.close()
  // Optional as of @solarisdk/browser 0.1.3: the client keeps a loopback proxy
  // server open for the connection-retry path, but 0.1.3 unrefs that listener,
  // so `browser.close()` alone is enough to exit. Calling `solari.close()` is
  // still fine and releases the client's pool immediately. Before 0.1.3 it was
  // required — skip it there and the script printed its output and then hung
  // forever instead of exiting.
  await solari.close()
}
