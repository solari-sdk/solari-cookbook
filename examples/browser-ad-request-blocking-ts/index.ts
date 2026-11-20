/**
 * Ad request blocking — load an ad-heavy page with and without a blocklist and compare the network.
 *
 * Each run gets its own cloud browser, so the second one starts with a cold
 * cache like the first. The baseline only counts: every request whose host is
 * on a list of ad-serving domains. The blocked run routes every request
 * through `page.route()` and aborts the ad ones before they leave the browser.
 *
 * The blocked run usually shows far fewer ad requests *attempted*, not just
 * the same number refused: most ad traffic is fetched by ad scripts, and a
 * script that never loads never asks for the next creative, tracker or bid.
 *
 *   npm start -- https://www.theguardian.com
 */
import { Solari } from "@solarisdk/browser"

const URL_TO_TEST = process.argv[2] ?? "https://www.theguardian.com"
const SETTLE_MS = 8_000 // ads load lazily after `load`; give them time to show up

const AD_DOMAINS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "googletagservices.com", "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net",
  "taboola.com", "outbrain.com", "rubiconproject.com", "pubmatic.com", "openx.net",
  "casalemedia.com", "indexww.com", "adsrvr.org", "smartadserver.com", "3lift.com",
  "sharethrough.com", "media.net", "yieldmo.com", "moatads.com", "adform.net", "teads.tv",
]

function isAd(url: string) {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return AD_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

type Result = { run: string; requests: number; adAttempted: number; adBlocked: number; loadMs: number }

async function measure(solari: Solari, run: string, block: boolean): Promise<Result> {
  const browser = await solari.launch()
  try {
    const page = await browser.newPage()
    const result: Result = { run, requests: 0, adAttempted: 0, adBlocked: 0, loadMs: 0 }

    page.on("request", (req) => {
      result.requests++
      if (isAd(req.url())) result.adAttempted++
    })
    if (block) {
      await page.route("**/*", (route) => {
        if (!isAd(route.request().url())) return route.continue()
        result.adBlocked++
        return route.abort("blockedbyclient")
      })
    }

    const started = Date.now()
    await page.goto(URL_TO_TEST, { waitUntil: "load", timeout: 60_000 })
    result.loadMs = Date.now() - started
    await page.waitForTimeout(SETTLE_MS)
    return result
  } finally {
    await browser.close()
  }
}

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
try {
  const rows = [await measure(solari, "baseline", false), await measure(solari, "blocklist", true)]

  console.log(`${URL_TO_TEST}  (counted for ${SETTLE_MS / 1000}s after load)\n`)
  console.log("run        requests  ad attempted  ad blocked  load ms")
  for (const r of rows) {
    console.log(
      `${r.run.padEnd(10)} ${String(r.requests).padStart(8)}  ${String(r.adAttempted).padStart(12)}  ` +
        `${String(r.adBlocked).padStart(10)}  ${String(r.loadMs).padStart(7)}`,
    )
  }
  const [base, blocked] = rows
  const sent = blocked.adAttempted - blocked.adBlocked
  console.log(`\nad requests that reached the network: ${base.adAttempted} -> ${sent}`)
  // A baseline with no ad requests proves nothing: the page served no ads (some sites hide them from
  // cloud browsers, or sit behind a bot wall), so there was nothing to block.
  if (!base.adAttempted) {
    console.error("the baseline made no ad requests, so the blocklist had nothing to block; try another URL")
    process.exitCode = 1
  }
} finally {
  await solari.close()
}
