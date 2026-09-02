/**
 * Pre-consent tracker evidence — what fires before the visitor agrees to anything.
 *
 * The whole measurement rests on ordering: load, record, and only then interact.
 * Anything clicked before the snapshot makes the phrase "before consent" untrue.
 */
import { Solari } from "@solarisdk/browser"

const target = process.argv[2] ?? "https://example.com"
const country = process.argv[3] // e.g. "es" — omit for the default egress

const TRACKERS = /google-analytics|googletagmanager|doubleclick|facebook|hotjar|clarity\.ms|tiktok|criteo|adnxs/i
const BOT_WALL = /captcha|are you a robot|access denied|just a moment/i

interface Hit { tMs: number; url: string; via?: string; setCookie: string[] }

const siteHost = new URL(target).hostname
const isFirstParty = (host: string): boolean => host === siteHost || host.endsWith(`.${siteHost}`)

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

// A managed proxy requires stealth, and both are paid-plan features: without one
// you get `SolariError.code === "FeatureRequiresPlan"`. The default egress is
// us-west, so a run without a country measures what a US visitor sees — and
// plenty of sites show a different consent banner, or none, outside the EU.
const browser = await solari.launch(country ? { stealth: true, proxy: { country } } : {})

try {
  const context = browser.contexts()[0]!
  const page = await context.newPage()

  // CDP rather than `page.on("request")`. Playwright's event gives you the URL;
  // only CDP carries `Network.responseReceivedExtraInfo`, which holds the raw
  // Set-Cookie headers, and `initiator`, which says what loaded it. A tag
  // manager URL in the initiator field is how "our analytics only fires after
  // consent" gets disproved in one line.
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")

  const hits: Hit[] = []
  const byId = new Map<string, Hit>()
  const t0 = Date.now()

  cdp.on("Network.requestWillBeSent", (e: any) => {
    const url: string = e.request?.url ?? ""
    if (!TRACKERS.test(url)) return
    // The site's own host can match the pattern — hotjar.com loading hotjar.com
    // is not a third-party tracker, it is the page.
    if (!url.startsWith("http") || isFirstParty(new URL(url).hostname)) return
    const hit: Hit = {
      tMs: Date.now() - t0,
      url,
      via: e.initiator?.url ?? e.initiator?.stack?.callFrames?.[0]?.url,
      setCookie: [],
    }
    byId.set(e.requestId, hit)
    hits.push(hit)
  })

  cdp.on("Network.responseReceivedExtraInfo", (e: any) => {
    const hit = byId.get(e.requestId)
    if (!hit) return
    for (const [k, v] of Object.entries(e.headers ?? {})) {
      if (k.toLowerCase() === "set-cookie") hit.setCookie.push(...String(v).split("\n"))
    }
  })

  await page.goto(target, { waitUntil: "domcontentloaded" })

  // Not `networkidle`: analytics beacons and long-polling leave it pending
  // forever on exactly the sites worth auditing. Wait a fixed settle window.
  await page.waitForTimeout(4000)

  // Check this before believing any of the output. Large sites answer datacenter
  // IPs with a 403 and a CAPTCHA interstitial that has its own scripts and its
  // own cookies. Measure that and you produce a confident report about the bot
  // wall instead of about the site.
  const title = await page.title()
  if (BOT_WALL.test(title)) {
    console.log(`\nBlocked before reaching the site — page title is "${title}".`)
    console.log("Retry with a country argument to route through a residential proxy.\n")
  } else {
    console.log(`\n${target}${country ? `  (egress ${browser.proxy?.country}, tz ${browser.proxy?.timezoneId})` : "  (default egress: us-west)"}`)
    console.log(`${hits.length} tracker request(s) before any interaction:\n`)
    for (const h of hits.slice(0, 15)) {
      console.log(`  t=${String(h.tMs).padStart(5)}ms  ${new URL(h.url).hostname}`)
      if (h.via) console.log(`             loaded by ${h.via.slice(0, 90)}`)
      for (const c of h.setCookie.slice(0, 2)) console.log(`             Set-Cookie: ${c.slice(0, 80)}`)
    }

    // The whole jar. `context.cookies()` only returns what matches the URLs you
    // pass it — the wrong shape when the point is finding cookies you did not
    // expect to be there.
    const { cookies } = (await cdp.send("Network.getAllCookies")) as any
    const host = new URL(target).hostname
    const thirdParty = cookies.filter((c: any) => !host.endsWith(String(c.domain).replace(/^\./, "")))
    console.log(`\n${thirdParty.length} third-party cookie(s) in the jar before consent.`)
  }
} finally {
  // close() ends the browser AND releases the session.
  await browser.close()
  // REQUIRED: the client holds a loopback proxy open for the connection-retry
  // path, and that handle keeps the event loop alive. Skip this and the script
  // prints its output and then hangs forever.
  await solari.close()
}
