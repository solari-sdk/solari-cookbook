/**
 * Two primitives, one API key, running at the same time.
 *
 * Reviewing a vendor's security posture needs two unrelated things: a real
 * browser to read what the company publishes about itself, and a machine to run
 * network checks against the same host. Solari gives you both behind one key, so
 * this launches a cloud browser and a sandbox concurrently and joins the results.
 * Public data only: one GET to a published page, one GET for response headers.
 *
 * The two primitive pattern behind Sentinel, which scores a full posture report
 * from it: https://github.com/TanmayKallakuri/sentinel
 *
 * Usage: npm start -- acme.com
 */
import { Solari } from "@solarisdk/browser"
import { SandboxClient } from "@solarisdk/sandbox"
import { mkdirSync, writeFileSync } from "node:fs"

const domain = process.argv[2]
if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(domain)) {
  throw new Error("usage: npm start -- <domain>")
}

// Read through a helper so `apiKey` is `string`, not `string | undefined`. A
// bare `if (!apiKey) throw` narrows only at module scope: the hoisted function
// declarations below could in principle run before that check, so TypeScript
// refuses to carry the narrowing into them.
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const apiKey = requireEnv("SOLARI_API_KEY")

const userAgent = "PostureReviewBot/0.1 (passive posture review; public data only)"

const TRACKED_HEADERS = [
  "strict-transport-security", "content-security-policy", "x-frame-options",
  "x-content-type-options", "referrer-policy", "permissions-policy",
]

/** Reads the vendor's published security page in a real browser. */
async function readTrustPage() {
  const solari = new Solari({ apiKey })
  // Stealth on because trust pages often sit behind bot protection. No proxy:
  // this only visits the vendor's own public pages, and proxied egress bills per
  // gigabyte for no benefit. Captcha solving stays on as a fallback.
  const browser = await solari.launch({ stealth: true, captcha: true })
  try {
    const page = await browser.newPage()
    // No user-agent override here, deliberately. Under `stealth: true` the pool
    // presents full headed Chromium, whose wire User-Agent, Sec-CH-UA brand list
    // and header order already match real Chrome exactly. Setting a custom UA as
    // an extra HTTP header changes only the wire header: `navigator.userAgent`
    // and Sec-CH-UA still say Chrome, so the request announces a bot while the
    // browser claims to be a person. That contradiction is far easier to spot
    // than either choice made cleanly, and it wastes the stealth and captcha
    // this session is paying for. The honest bot UA goes on the sandbox leg
    // below, where there is no stealth for it to contradict.
    const url = `https://${domain}/security`
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 })

    // goto follows redirects, so the host that was asked is not always the host
    // that answered: status.github.com lands on githubstatus.com. Read nothing
    // until the landed host is confirmed, or another company's page ends up
    // quoted as this vendor's evidence. A bare endsWith is not enough either,
    // since notacme.com also ends with acme.com.
    const landed = new URL(page.url()).hostname
    if (landed !== domain && !landed.endsWith(`.${domain}`)) {
      return { url: page.url(), redirectedOffSiteTo: landed, read: false }
    }

    mkdirSync("screenshots", { recursive: true })
    const screenshot = `screenshots/${domain}-security.jpg`
    writeFileSync(screenshot, await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 }))

    // page.evaluate is Playwright running this function inside the page, not
    // JavaScript eval. Nothing from the page is evaluated back here.
    const text: string = await page.evaluate(() => document.body?.innerText ?? "")
    const httpStatus = response?.status() ?? null
    return { url: page.url(), httpStatus, title: await page.title(), textLength: text.length, screenshot, read: true }
  } finally {
    // browser.close() releases the session. solari.close() is separate and
    // required in Node: the client holds a loopback proxy open for its retry
    // path, and that handle keeps the event loop alive, so a script that skips
    // it prints its output and then hangs forever instead of exiting.
    await browser.close().catch(() => undefined)
    await solari.close().catch(() => undefined)
  }
}

/** Runs one passive check, the site's HTTPS response headers, in a sandbox. */
async function readSecurityHeaders() {
  // The standalone SandboxClient needs baseUrl explicitly, where the unified
  // @solarisdk/sdk client defaults it.
  const sandboxes = new SandboxClient({ apiKey, baseUrl: "https://api.getsolari.com" })
  // timeoutMs is a rolling idle window that resets on every use, not a deadline.
  // Killing on timeout means a crashed caller cannot leave a VM billing.
  const sbx = await sandboxes.create({ template: "base", timeoutMs: 5 * 60_000, lifecycle: { onTimeout: "kill" } })
  try {
    await sbx.connect()
    // cmd is not shell interpreted, so argv goes in args. Running sh explicitly
    // is what gets redirection, and it keeps the domain an argument rather than
    // pasting it into the script text.
    const curl = 'curl -sS -o /dev/null -D - -L --max-redirs 3 --max-time 15 -A "$2" "https://$1/"'
    const out = await sbx.commands.run("sh", { args: ["-c", curl, "posture-review", domain, userAgent] })
    return parseHeaders(out.stdout)
  } finally {
    // kill() destroys the VM. close() alone would drop only the local control
    // channel and leave it running until the idle timeout expires.
    await sbx.kill().catch(() => undefined)
  }
}

/** Keeps the last response block, so a redirect chain reports where it ended. */
function parseHeaders(dump: string) {
  const last = dump.split(/\r?\n\r?\n/).filter((block) => /^HTTP\//m.test(block)).at(-1) ?? ""
  const headers: Record<string, string | null> = Object.fromEntries(TRACKED_HEADERS.map((n) => [n, null]))
  let httpStatus: number | null = null
  for (const line of last.split(/\r?\n/)) {
    const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line)
    if (status?.[1]) {
      httpStatus = Number(status[1])
      continue
    }
    const at = line.indexOf(":")
    const name = at === -1 ? "" : line.slice(0, at).trim().toLowerCase()
    // Trimmed for display: a real Content-Security-Policy runs to kilobytes and
    // would bury everything else in the output.
    const value = line.slice(at + 1).trim()
    if (name in headers) headers[name] = value.length > 120 ? `${value.slice(0, 120)}...` : value
  }
  return { httpStatus, headers, present: TRACKED_HEADERS.filter((n) => headers[n] !== null).length }
}

async function timed<T>(work: () => Promise<T>) {
  const startedAt = Date.now()
  return { value: await work(), elapsedMs: Date.now() - startedAt }
}

function settled<T>(r: PromiseSettledResult<{ value: T; elapsedMs: number }>) {
  return r.status === "fulfilled"
    ? { elapsedMs: r.value.elapsedMs, ...r.value.value }
    : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
}

async function main() {
  const startedAt = Date.now()
  // allSettled rather than all: the two primitives are independent, so one
  // failing should still report what the other found instead of losing both.
  const [browserPass, sandboxPass] = await Promise.allSettled([
    timed(readTrustPage),
    timed(readSecurityHeaders),
  ])

  const report = {
    domain,
    trustPage: settled(browserPass),
    securityHeaders: settled(sandboxPass),
    totalMs: Date.now() - startedAt,
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
