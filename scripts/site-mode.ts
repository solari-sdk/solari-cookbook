/**
 * Standalone site mode — load a URL in a Solari browser, capture behavior.
 *
 * Usage: npx tsx site-mode.ts <url>
 *
 * Captures: redirect chain, downloads, outbound requests by domain,
 * clipboard writes, screenshots, page title, final domain.
 */
import { Solari } from "@solarisdk/browser"
import * as fs from "fs"

const TARGET_URL = process.argv[2]
if (!TARGET_URL) {
  console.error("Usage: npx tsx site-mode.ts <url>")
  process.exit(1)
}

const WALL_CLOCK_CAP_MS = 2 * 60_000 // 2 min hard cap for site mode

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

async function main() {
  const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

  log("Launching browser session...")
  const browser = await solari.launch()
  log(`Browser session: ${browser.id}`)

  // Hard wall-clock cap
  const capTimer = setTimeout(async () => {
    log("WALL CLOCK CAP REACHED — closing browser")
    await browser.close()
    await solari.close()
    process.exit(1)
  }, WALL_CLOCK_CAP_MS)

  try {
    const page = await browser.newPage()

    // Collect redirect chain
    const redirectChain: { url: string; status: number }[] = []
    page.on("response", (resp) => {
      const req = resp.request()
      if (req.isNavigationRequest()) {
        redirectChain.push({ url: resp.url(), status: resp.status() })
      }
    })

    // Collect downloads
    const downloads: { filename: string; url: string }[] = []
    page.on("download", (download) => {
      const info = { filename: download.suggestedFilename(), url: download.url() }
      downloads.push(info)
      log(`DOWNLOAD: ${info.filename} from ${info.url}`)
    })

    // Track outbound requests by domain
    const requestsByDomain = new Map<string, number>()
    page.on("request", (req) => {
      try {
        const domain = new URL(req.url()).hostname
        requestsByDomain.set(domain, (requestsByDomain.get(domain) ?? 0) + 1)
      } catch { /* ignore invalid URLs */ }
    })

    // Monitor clipboard writes
    const clipboardAttempts: { text: string; timestamp: string }[] = []
    await page.addInitScript(() => {
      const orig = navigator.clipboard.writeText
      navigator.clipboard.writeText = async function (text: string) {
        ;(window as any).__clipboardWrites = (window as any).__clipboardWrites || []
        ;(window as any).__clipboardWrites.push({ text, timestamp: new Date().toISOString() })
        return orig.call(this, text)
      }
    })

    // Navigate
    log(`Navigating to ${TARGET_URL}...`)
    const response = await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 30000 })
    const finalUrl = page.url()
    const title = await page.title()

    log(`Final URL: ${finalUrl}`)
    log(`Title: ${title}`)

    // Screenshot at load
    const loadScreenshot = await page.screenshot({ fullPage: false })
    fs.writeFileSync("/tmp/site-load-screenshot.png", loadScreenshot)
    log("Screenshot saved: /tmp/site-load-screenshot.png")

    // Wait a bit then scroll
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollBy(0, window.innerHeight))
    await page.waitForTimeout(2000)

    // Screenshot after settle
    const settleScreenshot = await page.screenshot({ fullPage: false })
    fs.writeFileSync("/tmp/site-settle-screenshot.png", settleScreenshot)
    log("Screenshot saved: /tmp/site-settle-screenshot.png")

    // Collect clipboard attempts from page context
    const clipWrites = await page.evaluate(() => (window as any).__clipboardWrites || [])
    clipboardAttempts.push(...clipWrites)

    // Final domain comparison
    let finalDomain: string
    try {
      finalDomain = new URL(finalUrl).hostname
    } catch {
      finalDomain = finalUrl
    }
    let pastedDomain: string
    try {
      pastedDomain = new URL(TARGET_URL).hostname
    } catch {
      pastedDomain = TARGET_URL
    }
    const domainChanged = finalDomain !== pastedDomain

    // Report
    console.log("\n" + "=".repeat(60))
    console.log("BEHAVIOR REPORT")
    console.log("=".repeat(60))

    console.log(`\nPage title: ${title}`)
    console.log(`Pasted domain: ${pastedDomain}`)
    console.log(`Final domain: ${finalDomain}`)
    if (domainChanged) {
      console.log(`  ** Domain changed from ${pastedDomain} to ${finalDomain} **`)
    }

    console.log(`\nRedirect chain (${redirectChain.length} navigation responses):`)
    for (const r of redirectChain) {
      console.log(`  [${r.status}] ${r.url}`)
    }

    console.log(`\nDownloads (${downloads.length}):`)
    if (downloads.length === 0) {
      console.log("  None")
    }
    for (const d of downloads) {
      console.log(`  ${d.filename} — ${d.url}`)
    }

    console.log(`\nOutbound requests by domain:`)
    const sorted = [...requestsByDomain.entries()].sort((a, b) => b[1] - a[1])
    for (const [domain, count] of sorted) {
      console.log(`  ${domain}: ${count} request(s)`)
    }

    console.log(`\nClipboard write attempts (${clipboardAttempts.length}):`)
    if (clipboardAttempts.length === 0) {
      console.log("  None")
    }
    for (const c of clipboardAttempts) {
      console.log(`  [${c.timestamp}] "${c.text}"`)
    }

    console.log("\n" + "=".repeat(60))

  } finally {
    clearTimeout(capTimer)
    log("Closing browser session...")
    await browser.close()
    // REQUIRED — see browser-quickstart-ts
    await solari.close()
    log("Session released")
  }
}

main().catch(async (err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
