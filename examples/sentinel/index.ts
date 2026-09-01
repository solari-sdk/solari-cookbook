/**
 * Sentinel: a passive vendor security posture review that runs one Solari
 * browser and one Solari sandbox against a vendor's public surface, scores what
 * it finds against a fixed rubric, and prints the report.
 *
 * Public data only: a standard HTTPS GET, a standard TLS handshake to port 443,
 * public DNS over HTTPS, and public Certificate Transparency logs. Nothing here
 * authenticates, and nothing here asserts that a vendor is vulnerable.
 *
 * Usage: npm start -- acme.com
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Solari } from "@solarisdk/browser"
import { SandboxClient } from "@solarisdk/sandbox"

// Every tunable in one place so a reader can audit request volume and timeouts
// without reading the rest of the file.
const MAX_TRUST_PAGES = 10
const PAGE_TIMEOUT_MS = 15_000
// These have to agree. Ten pages at a 15 second timeout plus a one second
// throttle is a 160 second worst case, so the total budget has to sit above it.
// A tighter budget aborts the whole pass on a slow vendor, which a fast vendor
// never reveals.
const BROWSER_TOTAL_TIMEOUT_MS = 240_000
const THROTTLE_MS = 1_000

const SANDBOX_CPU = 2
const SANDBOX_MEM_MB = 4096
const SANDBOX_TIMEOUT_MS = 600_000
const CHECK_TIMEOUT_MS = 45_000
const CHECKS_TOTAL_TIMEOUT_MS = 240_000

const MAX_DKIM_SELECTORS = 6
const MAX_CVE_LOOKUPS = 3
const NVD_SPACING_MS = 6_500
const MAX_CT_SUBDOMAINS_SHOWN = 50

const SCREENSHOT_DIR = path.join(process.cwd(), "screenshots")

const DEFAULT_USER_AGENT =
  "SentinelPostureBot/0.1 (passive vendor security posture review; public data only)"

function userAgent(): string {
  return process.env.SENTINEL_USER_AGENT?.trim() || DEFAULT_USER_AGENT
}

function requireApiKey(): string {
  const key = process.env.SOLARI_API_KEY
  if (!key) {
    throw new Error("SOLARI_API_KEY is not set. Copy .env.example and export the key.")
  }
  return key
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * "unavailable" means Sentinel could not run the check. "unverified" means the
 * check ran and reached something Sentinel deliberately refused to read, such as
 * a trust page that redirected to a domain outside the scan target. Both are
 * excluded from scoring, but they are different facts and the report says which.
 */
type CheckStatus = "pass" | "warn" | "fail" | "info" | "unavailable" | "unverified"

interface Evidence {
  url?: string
  excerpt?: string
  raw?: string
}

interface Finding {
  id: string
  label: string
  status: CheckStatus
  /** Neutral statement of what was observed. Never a claim of vulnerability. */
  observation: string
  pointsEarned: number
  pointsAvailable: number
  evidence?: Evidence
}

type CategoryId = "governance" | "transport" | "headers" | "email" | "dns" | "cve"

interface CategoryScore {
  id: CategoryId
  label: string
  weight: number
  pointsEarned: number
  pointsAvailable: number
  /** Points belonging to checks that could not be run. Excluded from the ratio. */
  pointsNotAssessed: number
  /** Absolute points earned, never scaled up to the category weight. */
  score: number
  findings: Finding[]
}

type Grade = "A" | "B" | "C" | "D" | "F"

type GovernanceSignalId =
  | "soc2"
  | "iso27001"
  | "pci_dss"
  | "gdpr"
  | "dpa"
  | "vuln_disclosure"
  | "bug_bounty"
  | "subprocessors"
  | "security_contact"
  | "status_page"

interface GovernanceSignalResult {
  id: GovernanceSignalId
  label: string
  found: boolean
  evidence?: Evidence
}

interface TlsResult {
  status: CheckStatus
  negotiatedProtocol?: string
  tls13Supported?: boolean
  tls12Supported?: boolean
  legacyProtocolsTestable: boolean
  chainValid?: boolean
  verifyMessage?: string
  issuer?: string
  notBefore?: string
  notAfter?: string
  daysToExpiry?: number
  error?: string
}

interface HeadersResult {
  status: CheckStatus
  httpStatus?: number
  headers: Record<string, string | null>
  error?: string
}

interface EmailAuthResult {
  status: CheckStatus
  spf: { present: boolean; record?: string; allQualifier?: "-all" | "~all" | "?all" | "+all" }
  dmarc: { present: boolean; record?: string; policy?: "none" | "quarantine" | "reject" }
  dkim: { selectorsTried: string[]; found: string[] }
  error?: string
}

interface DnsResult {
  status: CheckStatus
  caa: { present: boolean; records: string[] }
  dnssec: { present: boolean; dsRecords: number; authenticatedData: boolean }
  error?: string
}

interface CtResult {
  status: CheckStatus
  /** The log source that answered. Cert Spotter is tried only if crt.sh does not. */
  source: "crt.sh" | "certspotter"
  total: number
  sample: string[]
  error?: string
}

interface ObservedSoftware {
  product: string
  version?: string
  source: string
  cpe?: string
  cveLookup: "performed" | "skipped_no_cpe" | "skipped_no_version" | "unavailable"
  cves: { id: string; cvss?: number; severity?: string; published?: string }[]
}

interface TechResult {
  status: CheckStatus
  software: ObservedSoftware[]
  versionDisclosed: boolean
  error?: string
}

interface CheckResults {
  tls: TlsResult
  headers: HeadersResult
  email: EmailAuthResult
  dns: DnsResult
  ct: CtResult
  tech: TechResult
}

/** Screenshots are files on disk here, so a shot is a path rather than a data URL. */
interface Shot {
  url: string
  path: string
}

interface OffsiteRedirect {
  /** The probed URL, which is on the scan target's own domain. */
  url: string
  /** The host it landed on, outside the scan target. */
  redirectedTo: string
}

interface TrustSurface {
  signals: GovernanceSignalResult[]
  skipped: string[]
  offsite: OffsiteRedirect[]
  shots: Shot[]
}

interface LocalReport {
  domain: string
  scannedAt: string
  overallScore: number
  assessedPoints: number
  grade: Grade
  categories: CategoryScore[]
  shots: Shot[]
  subdomains: CtResult
  notes: string[]
  timings: { browserMs: number; sandboxMs: number; totalMs: number }
}

// ---------------------------------------------------------------------------
// The domain argument
// ---------------------------------------------------------------------------

// A DNS label starts and ends alphanumeric and is at most 63 characters, which
// is stricter than "letters, digits and hyphens". Spelling it out here is what
// refuses -acme.com and acme-.com, which a looser character class lets through.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
// The final label is a top level domain, so it is alphabetic. Allowing any label
// there would accept acme.123, the single letter acme.c and the quad-like
// 1.2.3.4.5, none of which are names anyone can actually resolve.
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,63}$`)
// Any scheme is stripped, not just http and https, so that ftp://acme.com and
// acme.com reach the same verdict rather than one failing the shape rule.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

export function parseDomainArgument(raw: string | undefined): string {
  if (!raw) throw new Error("usage: npm start -- <domain>")
  const trimmed = raw.trim()
  if (trimmed.length > 300) {
    throw new Error("That input is too long to be a domain. Try example.com.")
  }
  // Credentials or whitespace survive the host extraction below, so an input
  // like "acme.com/a b" would otherwise be quietly trimmed down to acme.com.
  const withoutScheme = trimmed.replace(SCHEME, "")
  if (/[@\s]/.test(withoutScheme)) {
    throw new Error("Enter a bare domain with no credentials or spaces.")
  }
  // People paste whatever is in their address bar, so a full URL, a trailing
  // path, a query, a fragment, a port and a trailing dot are all accepted and
  // reduced to the host. One extraction path for every input: handing schemed
  // input to new URL instead would punycode it and drop its query string while
  // this path does neither, so the same domain would get two different verdicts
  // depending on whether the user happened to type https:// in front of it.
  const host = withoutScheme
    .toLowerCase()
    .replace(/[/?#].*$/, "")
    .replace(/:.*$/, "")
    .replace(/\.$/, "")
  if (!host || host.length > 253) {
    throw new Error(`"${raw}" does not look like a public domain. Try example.com.`)
  }
  // Refused rather than punycoded, so that one input has exactly one verdict.
  // The xn-- form passes the label rule unchanged.
  if ([...host].some((character) => character.charCodeAt(0) > 127)) {
    throw new Error(
      `"${host}" is an international domain. Enter its punycode form, for example xn--mnchen-3ya.de.`,
    )
  }
  // Checked ahead of the shape rule so an address is told it is an address.
  // Sentinel reviews a vendor's public domain surface, and pointing it at an
  // address is how you end up scanning something private.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new Error(`"${host}" is an IP address. Enter a domain name, for example acme.com.`)
  }
  if (!DOMAIN.test(host)) {
    throw new Error(`"${raw}" does not look like a public domain. Try example.com.`)
  }
  // Reserved and private names are refused because scanning them is neither
  // public nor meaningful, and this tool only ever looks at public data.
  if (/^(localhost|.*\.(local|internal|test|invalid|localhost|example|onion))$/.test(host)) {
    throw new Error(`"${host}" is a reserved or internal name and is out of scope.`)
  }
  return host
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsRules {
  /** Longest match wins, which is the behaviour defined by RFC 9309. */
  rules: { type: "allow" | "disallow"; path: string }[]
  source: "fetched" | "absent" | "error"
}

function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups = new Map<string, { type: "allow" | "disallow"; path: string }[]>()
  let currentAgents: string[] = []
  let inGroupBody = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? ""
    if (!line) continue
    const separator = line.indexOf(":")
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    if (field === "user-agent") {
      // A User-agent line after rules starts a new group rather than extending
      // the previous one.
      if (inGroupBody) {
        currentAgents = []
        inGroupBody = false
      }
      const agent = value.toLowerCase()
      currentAgents.push(agent)
      if (!groups.has(agent)) groups.set(agent, [])
      continue
    }
    if (field !== "allow" && field !== "disallow") continue
    inGroupBody = true
    // An empty Disallow value means allow everything, so it carries no rule.
    if (field === "disallow" && value === "") continue
    for (const agent of currentAgents) {
      groups.get(agent)?.push({ type: field, path: value })
    }
  }

  const token = agentToken.toLowerCase()
  const matched = [...groups.keys()].find((agent) => agent !== "*" && token.startsWith(agent))
  const rules = groups.get(matched ?? "*") ?? []
  return { rules, source: "fetched" }
}

// Every robots.txt captured from a real host uses * inside path patterns, and
// several use a trailing $, so a plain prefix compare would silently ignore
// those rules and visit pages the host asked us not to. RFC 9309 defines both.
function matchesPath(rulePath: string, pathname: string): boolean {
  const anchored = rulePath.endsWith("$")
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath
  if (!pattern.includes("*") && !anchored) return pathname.startsWith(pattern)
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(pathname)
}

function isAllowed(rules: RobotsRules, pathname: string): boolean {
  let best: { type: "allow" | "disallow"; path: string } | null = null
  for (const rule of rules.rules) {
    if (!matchesPath(rule.path, pathname)) continue
    if (!best || rule.path.length > best.path.length) best = rule
  }
  return best ? best.type === "allow" : true
}

async function fetchRobots(domain: string, signal: AbortSignal): Promise<RobotsRules> {
  const agentToken = userAgent().split("/")[0] ?? "SentinelPostureBot"
  try {
    const response = await fetch(`https://${domain}/robots.txt`, {
      signal,
      redirect: "follow",
      headers: { "user-agent": userAgent(), accept: "text/plain" },
    })
    if (!response.ok) return { rules: [], source: "absent" }
    const text = (await response.text()).slice(0, 200_000)
    return parseRobots(text, agentToken)
  } catch {
    return { rules: [], source: "error" }
  }
}

// ---------------------------------------------------------------------------
// The trust surface probe list
// ---------------------------------------------------------------------------

const ROOT_PATHS = [
  "/",
  "/security",
  "/trust",
  "/privacy",
  "/legal",
  "/.well-known/security.txt",
  "/security.txt",
]

const TRUST_SUBDOMAINS = ["trust", "security", "status"]

/** A fixed probe list, not a crawl. */
function buildTargets(domain: string): string[] {
  const urls = [
    ...ROOT_PATHS.map((suffix) => `https://${domain}${suffix}`),
    ...TRUST_SUBDOMAINS.map((sub) => `https://${sub}.${domain}/`),
  ]
  return [...new Set(urls)].slice(0, MAX_TRUST_PAGES)
}

/**
 * A page is in scope only when its host is the target domain itself or a
 * subdomain of it. A bare endsWith would accept notacme.com while scanning
 * acme.com, which anyone can register: that would send a cloud browser to a
 * domain the user never asked about, and let a third party's page supply
 * governance evidence attributed to the vendor.
 */
function isSameSite(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  const root = domain.toLowerCase().replace(/\.$/, "")
  return host === root || host.endsWith(`.${root}`)
}

// ---------------------------------------------------------------------------
// Governance signals
// ---------------------------------------------------------------------------

interface SignalPattern {
  id: GovernanceSignalId
  label: string
  patterns: RegExp[]
}

/**
 * Patterns are deliberately narrow. A false positive here inflates a vendor's
 * governance score, which is the failure mode that would make the report
 * indefensible, so bare acronyms are matched case sensitively.
 */
const SIGNALS: SignalPattern[] = [
  {
    id: "soc2",
    label: "SOC 2 attestation referenced",
    patterns: [/\bSOC\s?-?2\b/i, /\bService Organization Control\b/i],
  },
  {
    id: "iso27001",
    label: "ISO 27001 certification referenced",
    patterns: [/\bISO(?:\/IEC)?[\s-]?27001\b/i],
  },
  {
    id: "pci_dss",
    label: "PCI DSS referenced",
    patterns: [/\bPCI[\s-]?DSS\b/i, /\bPayment Card Industry Data Security Standard\b/i],
  },
  {
    id: "gdpr",
    label: "GDPR referenced",
    patterns: [/\bGDPR\b/, /\bGeneral Data Protection Regulation\b/i],
  },
  {
    id: "dpa",
    label: "Data processing agreement referenced",
    patterns: [/\bdata processing (agreement|addendum)\b/i, /\bDPA\b/],
  },
  {
    id: "vuln_disclosure",
    label: "Vulnerability disclosure policy published",
    patterns: [
      /\b(responsible|coordinated) disclosure\b/i,
      /\bvulnerability disclosure (policy|program|programme)\b/i,
      /\bsecurity\.txt\b/i,
      /\breport a (security )?(vulnerability|issue)\b/i,
    ],
  },
  {
    id: "bug_bounty",
    label: "Bug bounty program published",
    patterns: [/\bbug bount(y|ies)\b/i, /\b(hackerone|bugcrowd|intigriti|yeswehack)\b/i],
  },
  {
    id: "subprocessors",
    label: "Subprocessor list published",
    patterns: [/\bsub-?processors?\b/i],
  },
  {
    id: "security_contact",
    label: "Security contact published",
    patterns: [/security@[a-z0-9.-]+\.[a-z]{2,}/i, /^Contact:\s*mailto:/im],
  },
  {
    id: "status_page",
    label: "Status or uptime page published",
    patterns: [
      /\b(system )?status page\b/i,
      /\bhttps?:\/\/status\.[a-z0-9.-]+/i,
      /\b(statuspage\.io|instatus\.com|status\.io|betteruptime\.com)\b/i,
    ],
  },
]

const EXCERPT_RADIUS = 80

function excerptAround(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(text.length, index + matchLength + EXCERPT_RADIUS)
  return text.slice(start, end).replace(/\s+/g, " ").trim()
}

/** A status surface is status.<domain> or a /status path on the target. */
function isStatusSurface(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.startsWith("status.") || /\/status(\/|$)/.test(parsed.pathname)
  } catch {
    return false
  }
}

function detectSignals(
  pages: { url: string; text: string }[],
  offsiteRedirects: OffsiteRedirect[] = [],
): GovernanceSignalResult[] {
  const results: GovernanceSignalResult[] = SIGNALS.map((signal) => {
    for (const page of pages) {
      // The URL is searched alongside the text because a page's own address is
      // evidence that text alone does not carry. A live scan loaded
      // status.vercel.com successfully and still reported no status page,
      // because innerText reads "Vercel Status" and the address bar is not part
      // of the document. The same applies to /.well-known/security.txt.
      const haystack = `${page.url}\n${page.text}`
      for (const pattern of signal.patterns) {
        const match = pattern.exec(haystack)
        if (!match) continue
        return {
          id: signal.id,
          label: signal.label,
          found: true,
          evidence: {
            url: page.url,
            excerpt: excerptAround(haystack, match.index, match[0].length),
          },
        }
      }
    }
    return { id: signal.id, label: signal.label, found: false }
  })

  // The status page signal alone is satisfied by a redirect rather than by
  // content. status.<vendor>.com answering 301 to a status provider is the
  // vendor's own DNS and their own redirect, so its existence is the evidence
  // and nobody else's page has to be trusted for it. status.github.com to
  // www.githubstatus.com is the common shape. Every other signal is a claim
  // about content, so reaching one through an off-site redirect leaves it
  // unverified rather than found.
  const status = results.find((result) => result.id === "status_page")
  if (status && !status.found) {
    const redirect = offsiteRedirects.find((entry) => isStatusSurface(entry.url))
    if (redirect) {
      status.found = true
      status.evidence = {
        url: redirect.url,
        raw: `${redirect.url} redirected off-site to ${redirect.redirectedTo}`,
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// The browser pass
// ---------------------------------------------------------------------------

/**
 * One browser session per run. The proxy option is deliberately not set:
 * Sentinel only visits the vendor's own public pages, so proxied egress would
 * add per gigabyte cost with no benefit. Captcha solving stays enabled as a
 * fallback for trust pages behind an interstitial.
 */
async function withBrowser<T>(fn: (browser: any) => Promise<T>): Promise<T> {
  const solari = new Solari({ apiKey: requireApiKey() })
  const browser = await solari.launch({ stealth: true, captcha: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("The browser pass exceeded its total budget")),
      BROWSER_TOTAL_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([fn(browser), deadline])
  } finally {
    clearTimeout(timer)
    // browser.close() releases the session. solari.close() is separately
    // required in Node: the client holds a loopback proxy server open for its
    // connection retry path, and that handle keeps the event loop alive, so a
    // script that skips it prints its output and then hangs forever.
    await browser.close().catch(() => undefined)
    await solari.close().catch(() => undefined)
  }
}

/** Lowercased, hyphenated and bounded, so a file name never carries a path separator. */
function slugForUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

async function collectTrustSurface(domain: string): Promise<TrustSurface> {
  const targets = buildTargets(domain)
  const hosts = [...new Set(targets.map((url) => new URL(url).hostname))]

  const controller = new AbortController()
  const robotsTimer = setTimeout(() => controller.abort(), 8_000)
  const rulesByHost = new Map<string, RobotsRules>()
  try {
    for (const host of hosts) {
      rulesByHost.set(host, await fetchRobots(host, controller.signal))
    }
  } finally {
    clearTimeout(robotsTimer)
  }

  // Rethrown without the path, because the failure message would otherwise put
  // an absolute path from the machine that ran the scan into the printed report.
  await mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => {
    throw new Error("The screenshots directory could not be created in the working directory.")
  })

  const collected: { url: string; text: string }[] = []
  const skipped: string[] = []
  const offsite: OffsiteRedirect[] = []
  const shots: Shot[] = []

  await withBrowser(async (browser) => {
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({ "user-agent": userAgent() })

    for (const url of targets) {
      const parsed = new URL(url)
      const rules = rulesByHost.get(parsed.hostname)
      if (rules && !isAllowed(rules, parsed.pathname)) {
        skipped.push(url)
        continue
      }

      // A fixed probe list of known trust surfaces, throttled, one page at a
      // time. This is not a crawler and must not become one.
      await delay(THROTTLE_MS)
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        })
        const httpStatus: number | undefined = response?.status()
        if (!httpStatus || httpStatus >= 400) continue

        // Every probed URL is on the vendor's own domain, but goto follows
        // redirects, so where we actually landed has to be checked too. This is
        // not hypothetical: status.github.com answers 301 to
        // www.githubstatus.com, and several trust pages redirect to third party
        // portals. Reading that page would let another domain's content supply
        // governance evidence credited to this vendor.
        const landedHost = hostOf(page.url())
        if (!isSameSite(landedHost, domain)) {
          offsite.push({ url, redirectedTo: landedHost || "another host" })
          continue
        }

        // page.evaluate is Playwright's page context API, not JavaScript eval.
        // It serialises this function and runs it in the visited page. Nothing
        // from the page is ever evaluated back here.
        const text: string = await page.evaluate(
          () => document.body?.innerText?.slice(0, 200_000) ?? "",
        )
        collected.push({ url, text })

        const file = path.join(SCREENSHOT_DIR, `${slugForUrl(url)}.jpg`)
        const buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 })
        await writeFile(file, buffer)
        // Recorded relative and with forward slashes, so the report never
        // carries an absolute path off the machine that produced it.
        shots.push({ url, path: `screenshots/${path.basename(file)}` })
      } catch {
        // A trust page that does not exist is the common case, not an error.
        // The absence is what the governance signals report.
      }
    }
  })

  return { signals: detectSignals(collected, offsite), skipped, offsite, shots }
}

// ---------------------------------------------------------------------------
// The sandbox pass
// ---------------------------------------------------------------------------

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface SandboxRunner {
  run(script: string, args: string[], timeoutMs?: number): Promise<CommandResult>
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * One sandbox per run, killed unconditionally. timeoutMs is a rolling idle
 * window that resets on every use rather than a hard deadline, so it is a
 * backstop and not a substitute for the per check timeouts below. The lifecycle
 * is set to kill on that timeout so a crashed run cannot leave a machine going
 * and quietly burn credits. kill() destroys the remote VM; close() alone would
 * only drop the local control channel.
 */
async function withSandbox<T>(fn: (runner: SandboxRunner) => Promise<T>): Promise<T> {
  const sandboxes = new SandboxClient({
    apiKey: requireApiKey(),
    baseUrl: "https://api.getsolari.com",
  })
  const sbx = await sandboxes.create({
    template: "base",
    cpu: SANDBOX_CPU,
    memMb: SANDBOX_MEM_MB,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lifecycle: { onTimeout: "kill" },
  })

  try {
    await sbx.connect()
    const runner: SandboxRunner = {
      async run(script, args, timeoutMs = CHECK_TIMEOUT_MS) {
        // commands.run does not shell interpret its first argument, so the
        // script goes to sh -c and every target value goes in argv. Passing
        // "sentinel" as $0 puts the caller's arguments at $1 onward, which
        // means no domain is ever interpolated into the script text.
        const result = await withTimeout(
          sbx.commands.run("sh", { args: ["-c", script, "sentinel", ...args] }),
          timeoutMs,
          "sandbox command",
        )
        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        }
      },
    }
    return await fn(runner)
  } finally {
    // A failed teardown is the one error worth surfacing here: the VM outlives
    // the run and bills until its idle timeout.
    await sbx.kill().catch(() => {
      console.error("The sandbox could not be killed. Check the Solari console.")
    })
  }
}

// ---------------------------------------------------------------------------
// Check 1: the TLS handshake
// ---------------------------------------------------------------------------

/**
 * A standard handshake to port 443 and nothing else. The legacy section only
 * reports whether this OpenSSL build can even negotiate TLS 1.0, because a
 * failure on a build without legacy support proves nothing about the server.
 */
const TLS_SCRIPT = `
set -u
D="$1"
echo "=== HANDSHAKE ==="
echo | timeout 15 openssl s_client -connect "$D:443" -servername "$D" 2>&1 | tee /tmp/hs.txt
echo "=== CERT ==="
openssl x509 -noout -dates -issuer -subject -in /tmp/hs.txt 2>/dev/null || echo "no certificate parsed"
echo "=== TLS12 ==="
echo | timeout 10 openssl s_client -connect "$D:443" -servername "$D" -tls1_2 2>&1 | grep -E "^New," || echo "not negotiated"
echo "=== TLS13 ==="
echo | timeout 10 openssl s_client -connect "$D:443" -servername "$D" -tls1_3 2>&1 | grep -E "^New," || echo "not negotiated"
echo "=== LEGACY ==="
if openssl s_client -help 2>&1 | grep -q -- "-tls1 "; then echo "supported"; else echo "unsupported"; fi
`

function section(stdout: string, name: string): string {
  // Tolerates CRLF so a transcript captured or checked out on Windows splits
  // the same way as one read straight off the sandbox.
  const pattern = new RegExp(`=== ${name} ===\\r?\\n([\\s\\S]*?)(?:\\r?\\n=== |$)`)
  return pattern.exec(stdout)?.[1] ?? ""
}

function parseTls(stdout: string, now: Date): TlsResult {
  const handshake = section(stdout, "HANDSHAKE")
  const cert = section(stdout, "CERT")
  const legacyTestable = section(stdout, "LEGACY").trim() === "supported"

  // Because the script feeds s_client an immediate EOF, openssl exits before it
  // prints its SSL-Session summary, so the "Protocol :" line this once parsed is
  // absent from real output. The "New, TLSv1.3, Cipher is ..." line is what is
  // actually emitted. The SSL-Session form is still tried first, since some
  // builds and invocations do print it.
  const negotiatedProtocol =
    /^\s*Protocol\s*:\s*(\S+)/m.exec(handshake)?.[1]
    ?? /^New,\s*(TLSv[\d.]+)/m.exec(handshake)?.[1]
  const verifyMessage = /Verify return code:\s*(.+)$/m.exec(handshake)?.[1]?.trim()
  const notBefore = /notBefore=(.+)$/m.exec(cert)?.[1]?.trim()
  const notAfter = /notAfter=(.+)$/m.exec(cert)?.[1]?.trim()
  const issuer = /issuer=(.+)$/m.exec(cert)?.[1]?.trim()

  if (!negotiatedProtocol && !notAfter) {
    return {
      status: "unavailable",
      legacyProtocolsTestable: legacyTestable,
      error: "No TLS handshake data was returned.",
    }
  }

  const expiry = notAfter ? new Date(notAfter) : undefined
  const daysToExpiry =
    expiry && !Number.isNaN(expiry.getTime())
      ? Math.floor((expiry.getTime() - now.getTime()) / 86_400_000)
      : undefined

  return {
    status: "info",
    negotiatedProtocol,
    tls12Supported: /^New,\s*TLSv1\.2/m.test(section(stdout, "TLS12")),
    tls13Supported: /^New,\s*TLSv1\.3/m.test(section(stdout, "TLS13")),
    legacyProtocolsTestable: legacyTestable,
    chainValid: verifyMessage?.startsWith("0") ?? undefined,
    verifyMessage,
    issuer,
    notBefore,
    notAfter,
    daysToExpiry,
  }
}

async function checkTls(runner: SandboxRunner, domain: string): Promise<TlsResult> {
  try {
    const result = await runner.run(TLS_SCRIPT, [domain])
    return parseTls(result.stdout, new Date())
  } catch (error) {
    return { status: "unavailable", legacyProtocolsTestable: false, error: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// Check 2: HTTP security headers
// ---------------------------------------------------------------------------

const TRACKED_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
] as const

/** A single GET to the site root, following at most three redirects. */
const HEADERS_SCRIPT = `
set -u
D="$1"
UA="$2"
curl -sS -o /dev/null -D - -L --max-redirs 3 --max-time 20 -A "$UA" "https://$D/"
`

function emptyHeaders(): Record<string, string | null> {
  const headers: Record<string, string | null> = {}
  for (const name of TRACKED_HEADERS) headers[name] = null
  return headers
}

function parseHeaders(stdout: string): HeadersResult {
  const blocks = stdout.split(/\r?\n\r?\n/).filter((block) => /^HTTP\//m.test(block))
  const last = blocks[blocks.length - 1]
  const headers = emptyHeaders()

  if (!last) {
    return { status: "unavailable", headers, error: "No HTTP response headers were returned." }
  }

  let httpStatus: number | undefined
  for (const line of last.split(/\r?\n/)) {
    const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line)
    if (statusMatch?.[1]) {
      httpStatus = Number(statusMatch[1])
      continue
    }
    const separator = line.indexOf(":")
    if (separator === -1) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    // Server and X-Powered-By are kept because the fingerprint below reads them.
    if (
      (TRACKED_HEADERS as readonly string[]).includes(name)
      || name === "server"
      || name === "x-powered-by"
    ) {
      headers[name] = value
    }
  }

  return { status: "info", httpStatus, headers }
}

async function checkHeaders(runner: SandboxRunner, domain: string): Promise<HeadersResult> {
  try {
    const result = await runner.run(HEADERS_SCRIPT, [domain, userAgent()])
    return parseHeaders(result.stdout)
  } catch (error) {
    return { status: "unavailable", headers: emptyHeaders(), error: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// DNS over HTTPS, shared by checks 3 and 4
// ---------------------------------------------------------------------------

interface DohQuery {
  name: string
  type: string
}

interface DohAnswer {
  name: string
  type: number
  data: string
}

interface DohSection {
  name: string
  type: string
  status: number
  authenticatedData: boolean
  answers: DohAnswer[]
}

/**
 * The script takes pairs of arguments, name then type, so the caller controls
 * the query list without any string interpolation into the script body.
 */
function buildDohScript(): string {
  return `
set -u
while [ "$#" -gt 1 ]; do
  NAME="$1"
  TYPE="$2"
  shift 2
  echo "=== $NAME $TYPE ==="
  curl -sS --max-time 10 -H 'accept: application/dns-json' \\
    "https://cloudflare-dns.com/dns-query?name=$NAME&type=$TYPE" || echo '{"Status":-1}'
  echo
done
`
}

function isAnswer(value: unknown): value is DohAnswer {
  if (typeof value !== "object" || value === null) return false
  const answer = value as Partial<DohAnswer>
  return typeof answer.type === "number" && typeof answer.data === "string"
}

function parseDohSections(stdout: string): DohSection[] {
  const sections: DohSection[] = []
  const pattern = /=== (\S+) (\S+) ===\r?\n([\s\S]*?)(?=\r?\n=== |$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stdout)) !== null) {
    const [, name = "", type = "", body = ""] = match
    let status = -1
    let authenticatedData = false
    let answers: DohAnswer[] = []
    try {
      const parsed: unknown = JSON.parse(body.trim())
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
        string,
        unknown
      >
      status = typeof record.Status === "number" ? record.Status : -1
      authenticatedData = record.AD === true
      answers = Array.isArray(record.Answer) ? record.Answer.filter(isAnswer) : []
    } catch {
      // A resolver hiccup is reported as unavailable rather than as an absence.
    }
    sections.push({ name, type, status, authenticatedData, answers })
  }
  return sections
}

function txtStrings(section: DohSection | undefined): string[] {
  if (!section) return []
  return section.answers
    .filter((answer) => answer.type === 16)
    .map((answer) => answer.data.replace(/"\s*"/g, "").replace(/^"|"$/g, ""))
}

// ---------------------------------------------------------------------------
// Check 3: SPF, DMARC and DKIM
// ---------------------------------------------------------------------------

/** Common published selectors. Absence of a selector is not absence of DKIM. */
const DKIM_SELECTORS = ["selector1", "selector2", "google", "default", "dkim", "k1"].slice(
  0,
  MAX_DKIM_SELECTORS,
)

function emailQueries(domain: string): DohQuery[] {
  return [
    { name: domain, type: "TXT" },
    { name: `_dmarc.${domain}`, type: "TXT" },
    ...DKIM_SELECTORS.map((selector) => ({
      name: `${selector}._domainkey.${domain}`,
      type: "TXT",
    })),
  ]
}

function emailUnavailable(error: string): EmailAuthResult {
  return {
    status: "unavailable",
    spf: { present: false },
    dmarc: { present: false },
    dkim: { selectorsTried: DKIM_SELECTORS, found: [] },
    error,
  }
}

function parseEmailAuth(sections: DohSection[], domain: string): EmailAuthResult {
  const byName = new Map<string, DohSection>(sections.map((section) => [section.name, section]))
  const everyLookupFailed = sections.length === 0 || sections.every((s) => s.status === -1)
  if (everyLookupFailed) return emailUnavailable("No DNS answers were returned.")

  const spfRecord = txtStrings(byName.get(domain)).find((value) =>
    value.toLowerCase().startsWith("v=spf1"),
  )
  const allQualifier = spfRecord
    ? (/([-~?+])all\b/.exec(spfRecord)?.[0] as EmailAuthResult["spf"]["allQualifier"])
    : undefined

  const dmarcRecord = txtStrings(byName.get(`_dmarc.${domain}`)).find((value) =>
    value.toLowerCase().startsWith("v=dmarc1"),
  )
  const policyMatch = dmarcRecord ? /\bp\s*=\s*(none|quarantine|reject)\b/i.exec(dmarcRecord) : null

  const found = DKIM_SELECTORS.filter((selector) =>
    txtStrings(byName.get(`${selector}._domainkey.${domain}`)).some((value) =>
      /v=DKIM1|k=rsa|(^|;)\s*p=/i.test(value),
    ),
  )

  return {
    status: "info",
    spf: { present: Boolean(spfRecord), record: spfRecord, allQualifier },
    dmarc: {
      present: Boolean(dmarcRecord),
      record: dmarcRecord,
      policy: policyMatch?.[1]?.toLowerCase() as EmailAuthResult["dmarc"]["policy"],
    },
    dkim: { selectorsTried: DKIM_SELECTORS, found },
  }
}

async function checkEmailAuth(runner: SandboxRunner, domain: string): Promise<EmailAuthResult> {
  try {
    const args = emailQueries(domain).flatMap((query) => [query.name, query.type])
    const result = await runner.run(buildDohScript(), args)
    return parseEmailAuth(parseDohSections(result.stdout), domain)
  } catch (error) {
    return emailUnavailable(messageOf(error))
  }
}

// ---------------------------------------------------------------------------
// Check 4: CAA and DNSSEC
// ---------------------------------------------------------------------------

function dnsQueries(domain: string): DohQuery[] {
  return [
    { name: domain, type: "CAA" },
    { name: domain, type: "DS" },
  ]
}

function dnsUnavailable(error: string): DnsResult {
  return {
    status: "unavailable",
    caa: { present: false, records: [] },
    dnssec: { present: false, dsRecords: 0, authenticatedData: false },
    error,
  }
}

function parseDnsHygiene(sections: DohSection[], domain: string): DnsResult {
  const caaSection = sections.find((s) => s.name === domain && s.type === "CAA")
  const dsSection = sections.find((s) => s.name === domain && s.type === "DS")

  if (!caaSection || !dsSection || (caaSection.status === -1 && dsSection.status === -1)) {
    return dnsUnavailable("No DNS answers were returned.")
  }

  // CAA record data is returned in different encodings by different resolvers,
  // so it is recorded verbatim and only its presence is interpreted.
  const caaRecords = caaSection.answers.filter((a) => a.type === 257).map((a) => a.data)
  const dsRecords = dsSection.answers.filter((a) => a.type === 43).length

  return {
    status: "info",
    caa: { present: caaRecords.length > 0, records: caaRecords },
    dnssec: {
      present: dsRecords > 0,
      dsRecords,
      authenticatedData: caaSection.authenticatedData || dsSection.authenticatedData,
    },
  }
}

async function checkDns(runner: SandboxRunner, domain: string): Promise<DnsResult> {
  try {
    const args = dnsQueries(domain).flatMap((query) => [query.name, query.type])
    const result = await runner.run(buildDohScript(), args)
    return parseDnsHygiene(parseDohSections(result.stdout), domain)
  } catch (error) {
    return dnsUnavailable(messageOf(error))
  }
}

// ---------------------------------------------------------------------------
// Check 5: Certificate Transparency
// ---------------------------------------------------------------------------

/**
 * crt.sh retried with backoff, then Cert Spotter once. crt.sh answers 502 for
 * hours at a time, and a single source turns a healthy vendor into an unassessed
 * one. Both are keyless mirrors of the same public logs, so the fallback does not
 * change what the finding means, and the result records which one answered. Three
 * crt.sh attempts at eight seconds with two and four second backoffs plus one ten
 * second fallback stay inside the per check timeout. The script names its source
 * on a marker line so the parser never has to infer it from the JSON shape.
 */
const CT_SCRIPT = `
set -u
D="$1"
UA="$2"
BODY=""
for delay in 0 2 4; do
  if [ "$delay" -gt 0 ]; then sleep "$delay"; fi
  BODY=$(curl -sS --max-time 8 -A "$UA" "https://crt.sh/?q=%25.$D&output=json" 2>/dev/null || true)
  case "$BODY" in
    '['*) printf 'SOURCE crt.sh\\n%s' "$BODY"; exit 0 ;;
  esac
done
BODY=$(curl -sS --max-time 10 -A "$UA" "https://api.certspotter.com/v1/issuances?domain=$D&include_subdomains=true&expand=dns_names" 2>/dev/null || true)
case "$BODY" in
  '['*) printf 'SOURCE certspotter\\n%s' "$BODY"; exit 0 ;;
esac
printf 'SOURCE none\\n'
`

const CT_MARKER = /^SOURCE (crt\.sh|certspotter|none)\r?\n?([\s\S]*)$/

function ctUnavailable(error: string, source: CtResult["source"] = "crt.sh"): CtResult {
  return { status: "unavailable", source, total: 0, sample: [], error }
}

function ctUnusable(answered: string | undefined): CtResult {
  if (answered === "crt.sh") {
    return ctUnavailable("crt.sh answered but the response was not usable JSON.")
  }
  if (answered === "certspotter") {
    return ctUnavailable(
      "Cert Spotter answered but the response was not usable JSON.",
      "certspotter",
    )
  }
  return ctUnavailable(
    "Neither crt.sh nor Cert Spotter returned usable Certificate Transparency data.",
  )
}

/** crt.sh joins the names of one certificate with newlines; Cert Spotter lists them. */
function namesIn(entry: unknown): string[] {
  const record = entry as { name_value?: unknown; dns_names?: unknown } | null | undefined
  const joined = record?.name_value
  if (typeof joined === "string") return joined.split(/\r?\n/)
  const listed = record?.dns_names
  if (Array.isArray(listed)) return listed.filter((name): name is string => typeof name === "string")
  return []
}

function parseCt(stdout: string, domain: string): CtResult {
  const marked = CT_MARKER.exec(stdout.trimStart())
  const answered = marked?.[1]
  const source: CtResult["source"] = answered === "certspotter" ? "certspotter" : "crt.sh"
  const body = marked ? marked[2] ?? "" : stdout

  let parsed: unknown
  try {
    parsed = JSON.parse(body.trim())
  } catch {
    return ctUnusable(answered)
  }
  if (!Array.isArray(parsed)) return ctUnusable(answered)

  const names = new Set<string>()
  for (const entry of parsed) {
    for (const raw of namesIn(entry)) {
      const name = raw.trim().toLowerCase().replace(/^\*\./, "")
      if (!name) continue
      if (name !== domain && !name.endsWith(`.${domain}`)) continue
      names.add(name)
    }
  }

  const sorted = [...names].sort()
  return {
    status: "info",
    source,
    total: sorted.length,
    sample: sorted.slice(0, MAX_CT_SUBDOMAINS_SHOWN),
  }
}

async function checkCt(runner: SandboxRunner, domain: string): Promise<CtResult> {
  try {
    const result = await runner.run(CT_SCRIPT, [domain, userAgent()])
    return parseCt(result.stdout, domain)
  } catch (error) {
    return ctUnavailable(messageOf(error))
  }
}

// ---------------------------------------------------------------------------
// Check 6: observed software and associated public CVEs
// ---------------------------------------------------------------------------

/**
 * Only products with a confident vendor and product pair are mapped. An unmapped
 * product is reported as observed with its CVE lookup skipped, which is honest,
 * rather than guessed at a CPE and reported with someone else's CVEs.
 */
const CPE_MAP: Record<string, string> = {
  nginx: "cpe:2.3:a:nginx:nginx",
  apache: "cpe:2.3:a:apache:http_server",
  openssl: "cpe:2.3:a:openssl:openssl",
  php: "cpe:2.3:a:php:php",
  wordpress: "cpe:2.3:a:wordpress:wordpress",
  express: "cpe:2.3:a:expressjs:express",
  iis: "cpe:2.3:a:microsoft:internet_information_services",
  drupal: "cpe:2.3:a:drupal:drupal",
  tomcat: "cpe:2.3:a:apache:tomcat",
}

const PRODUCT_ALIASES: Record<string, string> = {
  "apache httpd": "apache",
  "microsoft-iis": "iis",
}

function normalizeProduct(raw: string): string {
  const lowered = raw.trim().toLowerCase()
  return PRODUCT_ALIASES[lowered] ?? lowered
}

function observe(raw: string, source: string): ObservedSoftware | null {
  // Servers append a platform comment and sometimes a second product after the
  // version, so "Apache/2.4.41 (Ubuntu)" has to lose its parenthetical before
  // the anchored match can see a clean product and version. The leading token is
  // the observation; the slice bounds the work a hostile header can ask of the
  // matcher.
  const head = raw.trim().slice(0, 200).split(/\s+\(/)[0] ?? ""
  const match = /^([a-z][a-z0-9 _.+-]*?)(?:\/|\s+)?v?(\d+(?:\.\d+)+)?$/i.exec(head.trim())
  if (!match?.[1]) return null
  const product = normalizeProduct(match[1])
  const version = match[2]
  const cpe = CPE_MAP[product]
  const cveLookup: ObservedSoftware["cveLookup"] = !version
    ? "skipped_no_version"
    : !cpe
      ? "skipped_no_cpe"
      : "performed"
  return {
    product,
    version,
    source,
    cpe: version && cpe ? `${cpe}:${version}` : cpe,
    cveLookup,
    cves: [],
  }
}

function fingerprint(headers: HeadersResult, html: string): ObservedSoftware[] {
  const observed: ObservedSoftware[] = []
  const server = headers.headers["server"]
  if (server) {
    const entry = observe(server, "server header")
    if (entry) observed.push(entry)
  }
  const poweredBy = headers.headers["x-powered-by"]
  if (poweredBy) {
    const entry = observe(poweredBy, "x-powered-by header")
    if (entry) observed.push(entry)
  }
  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]
  if (generator) {
    const entry = observe(generator, "generator meta tag")
    if (entry) observed.push(entry)
  }
  return observed
}

/**
 * NVD allows five requests per thirty seconds without an API key, so the lookups
 * are both capped and spaced.
 */
const NVD_SCRIPT = `
set -u
UA="$1"
shift
for CPE in "$@"; do
  echo "=== $CPE ==="
  curl -sS --max-time 25 -A "$UA" \\
    "https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=$CPE&resultsPerPage=20" \\
    || echo '{"vulnerabilities":[]}'
  echo
  sleep ${Math.ceil(NVD_SPACING_MS / 1000)}
done
`

function cveEntries(value: unknown): ObservedSoftware["cves"] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const cve = ((item as { cve?: unknown } | null)?.cve ?? {}) as Record<string, unknown>
    const metric = (cve.metrics as { cvssMetricV31?: unknown[] } | undefined)?.cvssMetricV31?.[0] as
      | { cvssData?: { baseScore?: number }; baseSeverity?: string }
      | undefined
    return {
      id: typeof cve.id === "string" ? cve.id : "unknown",
      cvss: metric?.cvssData?.baseScore,
      severity: metric?.baseSeverity,
      published: typeof cve.published === "string" ? cve.published : undefined,
    }
  })
}

function parseNvd(stdout: string): Map<string, ObservedSoftware["cves"]> {
  const byCpe = new Map<string, ObservedSoftware["cves"]>()
  const pattern = /=== (\S+) ===\r?\n([\s\S]*?)(?=\r?\n=== |$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stdout)) !== null) {
    const [, cpe = "", body = ""] = match
    try {
      const parsed = JSON.parse(body.trim()) as { vulnerabilities?: unknown }
      byCpe.set(cpe, cveEntries(parsed?.vulnerabilities))
    } catch {
      byCpe.set(cpe, [])
    }
  }
  return byCpe
}

async function checkTech(
  runner: SandboxRunner,
  headers: HeadersResult,
  domain: string,
): Promise<TechResult> {
  try {
    const body = await runner.run(
      `set -u\ncurl -sS --max-time 20 -A "$2" "https://$1/" | head -c 512000`,
      [domain, userAgent()],
    )
    const software = fingerprint(headers, body.stdout)
    const versionDisclosed = software.some((entry) => Boolean(entry.version))

    const lookups = software
      .filter((entry) => entry.cveLookup === "performed")
      .slice(0, MAX_CVE_LOOKUPS)
    for (const entry of software) {
      if (entry.cveLookup === "performed" && !lookups.includes(entry)) {
        entry.cveLookup = "unavailable"
      }
    }

    if (lookups.length > 0) {
      const cpes = lookups.map((entry) => entry.cpe).filter((cpe): cpe is string => Boolean(cpe))
      const nvd = await runner.run(
        NVD_SCRIPT,
        [userAgent(), ...cpes],
        40_000 + cpes.length * NVD_SPACING_MS,
      )
      const byCpe = parseNvd(nvd.stdout)
      for (const entry of lookups) {
        entry.cves = (entry.cpe && byCpe.get(entry.cpe)) || []
        if (entry.cpe && !byCpe.has(entry.cpe)) entry.cveLookup = "unavailable"
      }
    }

    return { status: "info", software, versionDisclosed }
  } catch (error) {
    return { status: "unavailable", software: [], versionDisclosed: false, error: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// The six checks, in one sandbox
// ---------------------------------------------------------------------------

async function runPassiveChecks(domain: string): Promise<CheckResults> {
  return withSandbox(async (runner) => {
    const work = (async (): Promise<CheckResults> => {
      // The header check runs first because the technology fingerprint reads the
      // headers it collected rather than issuing a second request.
      const headers = await checkHeaders(runner, domain)
      // Every check returns an unavailable result rather than throwing, so one
      // failing check cannot lose a sibling's result here.
      const [tls, email, dns, ct, tech] = await Promise.all([
        checkTls(runner, domain),
        checkEmailAuth(runner, domain),
        checkDns(runner, domain),
        checkCt(runner, domain),
        checkTech(runner, headers, domain),
      ])
      return { tls, headers, email, dns, ct, tech }
    })()
    return withTimeout(work, CHECKS_TOTAL_TIMEOUT_MS, "the sandbox pass")
  })
}

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------

/** Weights sum to 100. Change them here and nowhere else. */
const WEIGHTS: Record<CategoryId, number> = {
  governance: 25,
  transport: 20,
  headers: 15,
  email: 15,
  dns: 10,
  cve: 15,
}

const CATEGORY_LABELS: Record<CategoryId, string> = {
  governance: "Governance and compliance",
  transport: "Transport security",
  headers: "Application security headers",
  email: "Email authentication",
  dns: "DNS hygiene",
  cve: "Observed software and public CVEs",
}

/** Points sum to the governance weight of 25. */
const SIGNAL_POINTS: Record<GovernanceSignalId, number> = {
  soc2: 4,
  iso27001: 3,
  pci_dss: 1,
  gdpr: 2,
  dpa: 2,
  vuln_disclosure: 4,
  bug_bounty: 2,
  subprocessors: 3,
  security_contact: 3,
  status_page: 1,
}

const GRADE_BANDS: { grade: Grade; min: number }[] = [
  { grade: "A", min: 90 },
  { grade: "B", min: 80 },
  { grade: "C", min: 70 },
  { grade: "D", min: 50 },
  { grade: "F", min: 0 },
]

function gradeFor(score: number): Grade {
  return GRADE_BANDS.find((band) => score >= band.min)?.grade ?? "F"
}

function finding(
  id: string,
  label: string,
  earned: number,
  available: number,
  observation: string,
  extra: Partial<Finding> = {},
): Finding {
  return {
    id,
    label,
    status:
      available === 0 ? "unavailable" : earned === available ? "pass" : earned > 0 ? "warn" : "fail",
    observation,
    pointsEarned: earned,
    pointsAvailable: available,
    ...extra,
  }
}

function toCategory(id: CategoryId, findings: Finding[]): CategoryScore {
  const pointsEarned = findings.reduce((sum, f) => sum + f.pointsEarned, 0)
  const pointsAvailable = findings.reduce((sum, f) => sum + f.pointsAvailable, 0)
  const weight = WEIGHTS[id]
  return {
    id,
    label: CATEGORY_LABELS[id],
    weight,
    pointsEarned,
    pointsAvailable,
    pointsNotAssessed: weight - pointsAvailable,
    score: pointsEarned,
    findings,
  }
}

function governance(surface: TrustSurface): CategoryScore {
  const signals = surface.signals.map((signal) => {
    const points = SIGNAL_POINTS[signal.id]
    return finding(
      `governance.${signal.id}`,
      signal.label,
      signal.found ? points : 0,
      points,
      signal.found
        ? `Found on ${signal.evidence?.url ?? "a public trust page"}.`
        : "No public page referencing this was found at the probed trust surfaces.",
      signal.evidence ? { evidence: signal.evidence } : {},
    )
  })

  // A page that left the scan target was deliberately not read, so it is
  // recorded at zero points rather than counted as an absence of the signal.
  const offsite = surface.offsite.map((redirect, index) =>
    finding(
      `governance.offsite.${index + 1}`,
      "Trust surface redirected to another domain",
      0,
      0,
      `${redirect.url} redirected to ${redirect.redirectedTo}, which is outside the scan target, so the page content was not read and no governance signal was credited from it.`,
      { status: "unverified", evidence: { url: redirect.url } },
    ),
  )

  return toCategory("governance", [...signals, ...offsite])
}

function transport(results: CheckResults): CategoryScore {
  const tls = results.tls
  if (tls.status === "unavailable") {
    return toCategory("transport", [
      finding(
        "transport.unavailable",
        "TLS handshake",
        0,
        0,
        `TLS could not be assessed. ${tls.error ?? ""}`.trim(),
      ),
    ])
  }
  const days = tls.daysToExpiry ?? -1
  return toCategory("transport", [
    finding(
      "transport.chain",
      "Certificate chain validates",
      tls.chainValid ? 6 : 0,
      6,
      tls.chainValid
        ? `Chain validated with verify return code ${tls.verifyMessage}.`
        : `Chain did not validate: ${tls.verifyMessage ?? "unknown"}.`,
      { evidence: { raw: tls.issuer } },
    ),
    finding(
      "transport.notExpired",
      "Certificate is within its validity window",
      days >= 0 ? 5 : 0,
      5,
      `Certificate notAfter is ${tls.notAfter ?? "unknown"}, ${days} days from the scan.`,
    ),
    finding(
      "transport.renewalHeadroom",
      "At least 30 days before expiry",
      days >= 30 ? 3 : 0,
      3,
      `${days} days of validity remain.`,
    ),
    finding(
      "transport.tls13",
      "TLS 1.3 negotiated",
      tls.tls13Supported ? 4 : 0,
      4,
      tls.tls13Supported ? "TLS 1.3 handshake succeeded." : "TLS 1.3 handshake did not succeed.",
    ),
    finding(
      "transport.tls12",
      "TLS 1.2 negotiated",
      tls.tls12Supported ? 2 : 0,
      2,
      tls.tls12Supported ? "TLS 1.2 handshake succeeded." : "TLS 1.2 handshake did not succeed.",
    ),
    finding(
      "transport.legacy",
      "Legacy TLS 1.0 and 1.1 support",
      0,
      0,
      tls.legacyProtocolsTestable
        ? "The scanner's OpenSSL build can test legacy protocols; results are informational only."
        : "The scanner's OpenSSL build cannot negotiate TLS 1.0 or 1.1, so their status was not assessed.",
    ),
  ])
}

function headers(results: CheckResults): CategoryScore {
  const h = results.headers
  if (h.status === "unavailable") {
    return toCategory("headers", [
      finding(
        "headers.unavailable",
        "Security headers",
        0,
        0,
        `Headers could not be assessed. ${h.error ?? ""}`.trim(),
      ),
    ])
  }
  const hsts = h.headers["strict-transport-security"]
  const maxAge = hsts ? Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0) : 0
  const csp = h.headers["content-security-policy"]
  const frameProtected = Boolean(h.headers["x-frame-options"]) || /frame-ancestors/i.test(csp ?? "")

  return toCategory("headers", [
    finding(
      "headers.hsts",
      "Strict-Transport-Security",
      maxAge >= 31_536_000 ? 4 : hsts ? 2 : 0,
      4,
      hsts ? `Header present with max-age ${maxAge}.` : "Header not present on the root response.",
      { evidence: { raw: hsts ?? undefined } },
    ),
    finding(
      "headers.csp",
      "Content-Security-Policy",
      csp ? 4 : 0,
      4,
      csp ? "Header present on the root response." : "Header not present on the root response.",
      { evidence: { raw: csp ?? undefined } },
    ),
    finding(
      "headers.frame",
      "Framing protection",
      frameProtected ? 2 : 0,
      2,
      frameProtected
        ? "X-Frame-Options or a CSP frame-ancestors directive is present."
        : "Neither X-Frame-Options nor a CSP frame-ancestors directive was present.",
    ),
    finding(
      "headers.nosniff",
      "X-Content-Type-Options",
      h.headers["x-content-type-options"] ? 2 : 0,
      2,
      h.headers["x-content-type-options"] ? "Header present." : "Header not present.",
    ),
    finding(
      "headers.referrer",
      "Referrer-Policy",
      h.headers["referrer-policy"] ? 2 : 0,
      2,
      h.headers["referrer-policy"] ? "Header present." : "Header not present.",
    ),
    finding(
      "headers.permissions",
      "Permissions-Policy",
      h.headers["permissions-policy"] ? 1 : 0,
      1,
      h.headers["permissions-policy"] ? "Header present." : "Header not present.",
    ),
  ])
}

function email(results: CheckResults): CategoryScore {
  const e = results.email
  if (e.status === "unavailable") {
    return toCategory("email", [
      finding(
        "email.unavailable",
        "Email authentication",
        0,
        0,
        `Email authentication could not be assessed. ${e.error ?? ""}`.trim(),
      ),
    ])
  }
  const policyPoints = e.dmarc.policy === "reject" ? 4 : e.dmarc.policy === "quarantine" ? 2 : 0
  const strictSpf = e.spf.allQualifier === "-all" || e.spf.allQualifier === "~all"

  return toCategory("email", [
    finding(
      "email.spf",
      "SPF record published",
      e.spf.present ? 3 : 0,
      3,
      e.spf.present
        ? "An SPF record was published at the root domain."
        : "No SPF record was published at the root domain.",
      { evidence: { raw: e.spf.record } },
    ),
    finding(
      "email.spfStrict",
      "SPF ends in a restrictive all qualifier",
      strictSpf ? 2 : 0,
      2,
      e.spf.allQualifier
        ? `SPF ends in ${e.spf.allQualifier}.`
        : "No all qualifier was observed in the SPF record.",
    ),
    finding(
      "email.dmarc",
      "DMARC record published",
      e.dmarc.present ? 3 : 0,
      3,
      e.dmarc.present
        ? "A DMARC record was published at _dmarc."
        : "No DMARC record was published at _dmarc.",
      { evidence: { raw: e.dmarc.record } },
    ),
    finding(
      "email.dmarcPolicy",
      "DMARC enforcement policy",
      policyPoints,
      4,
      e.dmarc.policy ? `DMARC policy is p=${e.dmarc.policy}.` : "No DMARC policy was observed.",
    ),
    finding(
      "email.dkim",
      "DKIM selector observed",
      e.dkim.found.length > 0 ? 3 : 0,
      3,
      e.dkim.found.length > 0
        ? `Answered for selector or selectors: ${e.dkim.found.join(", ")}.`
        : `None of the ${e.dkim.selectorsTried.length} common selectors answered. Absence here does not prove DKIM is unconfigured.`,
    ),
  ])
}

function dns(results: CheckResults): CategoryScore {
  const d = results.dns
  if (d.status === "unavailable") {
    return toCategory("dns", [
      finding(
        "dns.unavailable",
        "DNS hygiene",
        0,
        0,
        `DNS hygiene could not be assessed. ${d.error ?? ""}`.trim(),
      ),
    ])
  }
  return toCategory("dns", [
    finding(
      "dns.caa",
      "CAA record published",
      d.caa.present ? 5 : 0,
      5,
      d.caa.present
        ? `${d.caa.records.length} CAA record or records published.`
        : "No CAA record was published.",
      { evidence: { raw: d.caa.records.join(" | ") || undefined } },
    ),
    finding(
      "dns.dnssec",
      "DNSSEC delegation present",
      d.dnssec.present ? 5 : 0,
      5,
      d.dnssec.present
        ? `${d.dnssec.dsRecords} DS record or records published; resolver authenticated data flag is ${d.dnssec.authenticatedData}.`
        : "No DS record was published at the parent zone.",
    ),
  ])
}

function cve(results: CheckResults): CategoryScore {
  const t = results.tech
  if (t.status === "unavailable") {
    return toCategory("cve", [
      finding(
        "cve.unavailable",
        "Observed software",
        0,
        0,
        `Software observation could not be completed. ${t.error ?? ""}`.trim(),
      ),
    ])
  }
  const assessed = t.software.filter((s) => s.cveLookup === "performed")
  const allCves = assessed.flatMap((s) => s.cves)
  const maxCvss = allCves.reduce((max, c) => Math.max(max, c.cvss ?? 0), 0)
  const lookupHappened = assessed.length > 0

  const findings: Finding[] = [
    finding(
      "cve.versionDisclosure",
      "No software version disclosed in public responses",
      t.versionDisclosed ? 0 : 5,
      5,
      t.versionDisclosed
        ? `Software observed with a version string: ${t.software
            .filter((s) => s.version)
            .map((s) => `${s.product} ${s.version}`)
            .join(", ")}.`
        : "No versioned software was disclosed in the observed response headers or generator tag.",
    ),
  ]

  if (lookupHappened) {
    findings.push(
      finding(
        "cve.critical",
        "No associated public CVE at CVSS 9.0 or above",
        maxCvss >= 9 ? 0 : 6,
        6,
        maxCvss >= 9
          ? `Observed software has an associated public CVE with a base score of ${maxCvss}. This is an association from the observed version string, not a confirmation that the target is affected.`
          : "No associated public CVE at or above CVSS 9.0 was found for the observed versions.",
      ),
      finding(
        "cve.high",
        "No associated public CVE at CVSS 7.0 or above",
        maxCvss >= 7 ? 0 : 4,
        4,
        maxCvss >= 7
          ? `The highest associated public CVE base score for the observed versions is ${maxCvss}.`
          : "No associated public CVE at or above CVSS 7.0 was found for the observed versions.",
      ),
    )
  } else {
    // Same two ids at zero points, so a target with nothing to look up neither
    // gains nor loses them.
    const noLookup =
      "No observed software carried both a version and a known CPE mapping, so no associated public CVE lookup was possible."
    findings.push(
      finding("cve.critical", "No associated public CVE at CVSS 9.0 or above", 0, 0, noLookup),
      finding("cve.high", "No associated public CVE at CVSS 7.0 or above", 0, 0, noLookup),
    )
  }

  return toCategory("cve", findings)
}

function buildCategories(surface: TrustSurface, results: CheckResults): CategoryScore[] {
  return [
    governance(surface),
    transport(results),
    headers(results),
    email(results),
    dns(results),
    cve(results),
  ]
}

/**
 * Total earned over total available, in absolute points. A check that could not
 * be run leaves both sides of the ratio, so a scanner side outage never presents
 * as a worse vendor posture, and no category is ever scaled up to its weight on
 * the strength of the few points that happened to be assessable.
 */
function overallScore(categories: CategoryScore[]): number {
  const earned = categories.reduce((sum, category) => sum + category.pointsEarned, 0)
  const available = categories.reduce((sum, category) => sum + category.pointsAvailable, 0)
  if (available === 0) return 0
  return (earned / available) * 100
}

function assessedPoints(categories: CategoryScore[]): number {
  return categories.reduce((sum, category) => sum + category.pointsAvailable, 0)
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

// A single observed record can be a two kilobyte Content-Security-Policy, and
// one unwrapped line that long is not a readable report. The full value is still
// what was observed; only this rendering is bounded.
function short(value: string, limit = 300): string {
  return value.length > limit
    ? `${value.slice(0, limit)} ... (${value.length} characters, truncated)`
    : value
}

function printReport(report: LocalReport): void {
  const rule = "-".repeat(72)
  console.log(rule)
  console.log(`Sentinel posture report for ${report.domain}`)
  console.log(`Scanned ${report.scannedAt}`)
  console.log(
    `Grade ${report.grade}    Score ${report.overallScore.toFixed(1)} of 100    Assessed on ${report.assessedPoints} of 100 rubric points`,
  )
  console.log(
    `Browser pass ${report.timings.browserMs}ms    Sandbox pass ${report.timings.sandboxMs}ms    Total ${report.timings.totalMs}ms`,
  )
  console.log(rule)

  for (const category of report.categories) {
    console.log("")
    console.log(`${category.label}  ${category.score.toFixed(1)} / ${category.weight}`)
    if (category.pointsNotAssessed > 0) {
      console.log(
        `  not assessed, ${category.pointsNotAssessed} weighted points excluded from the score`,
      )
    }
    for (const f of category.findings) {
      // "unavailable" is eleven characters, which is why the column pads to eleven.
      console.log(`  [${f.status.padEnd(11)}] ${f.label}  ${f.pointsEarned}/${f.pointsAvailable}`)
      console.log(`     ${f.observation}`)
      if (f.evidence?.url) console.log(`     evidence: ${f.evidence.url}`)
      if (f.evidence?.excerpt) console.log(`     excerpt: ${f.evidence.excerpt}`)
      if (f.evidence?.raw) console.log(`     record: ${short(f.evidence.raw)}`)
    }
  }

  console.log("")
  console.log("Evidence screenshots")
  if (report.shots.length === 0) console.log("  none captured")
  for (const shot of report.shots) console.log(`  ${shot.path}    ${shot.url}`)

  console.log("")
  console.log("Passive attack surface")
  console.log(
    report.subdomains.status === "unavailable"
      ? `  Certificate Transparency lookup was unavailable for this run. ${report.subdomains.error ?? ""}`.trimEnd()
      : `  ${report.subdomains.total} names appear in public Certificate Transparency logs according to ${report.subdomains.source}, informational and not scored`,
  )
  for (const name of report.subdomains.sample.slice(0, MAX_CT_SUBDOMAINS_SHOWN)) {
    console.log(`  ${name}`)
  }

  if (report.notes.length > 0) {
    console.log("")
    console.log("Notes")
    for (const note of report.notes) console.log(`  ${note}`)
  }

  console.log("")
  console.log(rule)
  console.log("Every line above is an observation of public data. Scores are derived from those")
  console.log("observations by the fixed rubric in this file. Nothing here asserts that this")
  console.log("vendor is vulnerable, insecure, or breached.")
  console.log(rule)
}

// ---------------------------------------------------------------------------
// The orchestration spine
// ---------------------------------------------------------------------------

const EMPTY_SURFACE: TrustSurface = { signals: [], skipped: [], offsite: [], shots: [] }

const DID_NOT_RUN = "The sandbox pass did not run."

const EMPTY_CHECKS: CheckResults = {
  tls: { status: "unavailable", legacyProtocolsTestable: false, error: DID_NOT_RUN },
  headers: { status: "unavailable", headers: {}, error: DID_NOT_RUN },
  email: {
    status: "unavailable",
    spf: { present: false },
    dmarc: { present: false },
    dkim: { selectorsTried: [], found: [] },
    error: DID_NOT_RUN,
  },
  dns: {
    status: "unavailable",
    caa: { present: false, records: [] },
    dnssec: { present: false, dsRecords: 0, authenticatedData: false },
    error: DID_NOT_RUN,
  },
  ct: { status: "unavailable", source: "crt.sh", total: 0, sample: [], error: DID_NOT_RUN },
  tech: { status: "unavailable", software: [], versionDisclosed: false, error: DID_NOT_RUN },
}

/** Runs one pass, times it, and turns a failure into a note rather than a crash. */
async function timedPass<T>(
  label: string,
  notes: string[],
  work: () => Promise<T>,
): Promise<{ value: T | null; ms: number }> {
  const began = Date.now()
  try {
    return { value: await work(), ms: Date.now() - began }
  } catch (error) {
    notes.push(`The ${label} pass did not complete: ${messageOf(error)}`)
    return { value: null, ms: Date.now() - began }
  }
}

async function main(): Promise<void> {
  const domain = parseDomainArgument(process.argv[2])
  const startedAt = Date.now()
  const notes: string[] = []

  console.error(`Scanning ${domain} as ${userAgent()}`)

  // The two passes are independent, so they share wall clock time. One failing
  // pass still yields a report built from the other.
  const [browser, sandbox] = await Promise.all([
    timedPass("browser", notes, () => collectTrustSurface(domain)),
    timedPass("sandbox", notes, () => runPassiveChecks(domain)),
  ])

  const surface = browser.value ?? EMPTY_SURFACE
  const results = sandbox.value ?? EMPTY_CHECKS
  const categories = buildCategories(surface, results)
  const score = overallScore(categories)
  const assessed = assessedPoints(categories)

  if (assessed < 100) {
    notes.push(
      `This report was assessed on ${assessed} of 100 points. Checks that could not be run are excluded from both the earned and the available side of the score.`,
    )
  }
  for (const category of categories) {
    if (category.pointsNotAssessed > 0) {
      notes.push(
        `${category.label}: ${category.pointsNotAssessed} of its ${category.weight} points were not assessed and are excluded from the score.`,
      )
    }
  }
  for (const url of surface.skipped) {
    notes.push(`Skipped ${url} because robots.txt disallows it.`)
  }
  if (surface.signals.length > 0) {
    notes.push(
      "Governance signals reflect only the public pages listed in the evidence. Absence of a signal means nothing was found at those locations, not that the control is absent.",
    )
  }

  printReport({
    domain,
    scannedAt: new Date().toISOString(),
    overallScore: Math.round(score * 10) / 10,
    assessedPoints: assessed,
    grade: gradeFor(score),
    categories,
    shots: surface.shots,
    subdomains: results.ct,
    notes,
    timings: { browserMs: browser.ms, sandboxMs: sandbox.ms, totalMs: Date.now() - startedAt },
  })
}

// Only the CLI entry point scans. The validator above is exported so a
// differential test can drive it, and importing this file must never launch a
// browser or a sandbox on someone else's behalf.
//
// There is no process.exit() anywhere in this file, and that is the point. The
// process exiting on its own is the observable proof that solari.close() and
// sbx.kill() both ran.
if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    // A bad argument is a user error, not a crash, so it prints one line and
    // sets an exit code rather than unwinding a stack trace into the terminal.
    console.error(messageOf(error))
    process.exitCode = 1
  }
}
