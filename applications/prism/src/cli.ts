/**
 * prism check [--backend local|solari] [--url URL] [--fix]
 *
 * With no --url, Prism starts its own demo site, which ships two deliberate
 * bugs: `free` sees the paid export button, and a visitor who refused consent
 * still gets the tracker. `--fix` serves the corrected app instead, so you can
 * see the same run go green.
 *
 * --backend local needs no credentials at all.
 */
import { serve } from "../demo-site/serve.js"
import { hostInSandbox } from "./host.js"
import { localBackend } from "./backends-local.js"
import { solariBackend } from "./backends-solari.js"
import { check } from "./check.js"
import { explain, table } from "./report.js"
import { CLASSES } from "./classes.js"
import { writeFileSync, mkdirSync } from "node:fs"
import type { Backend } from "./backend.js"

/**
 * A cloud browser cannot reach this machine. Match on the parsed hostname, not
 * a substring: "https://localhost-tools.example.com" is public and must be
 * allowed, while 0.0.0.0 and [::1] are not and a substring test misses both.
 */
function isLoopback(u: string): boolean {
  let host: string
  try { host = new URL(u).hostname.toLowerCase() } catch { return false }
  const bare = host.replace(/^\[|\]$/g, "")
  return bare === "localhost" || bare.endsWith(".localhost") ||
    bare === "0.0.0.0" || bare === "::1" || bare === "::" ||
    /^127\./.test(bare)
}

const argv = process.argv.slice(2)
const cmd = argv[0] ?? "check"
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? (argv[i + 1] ?? "") : d
}
const has = (n: string) => argv.includes(`--${n}`)
const backendNameEarly = () => flag("backend", "local")!

if (backendNameEarly() !== "local" && backendNameEarly() !== "solari") {
  console.error(`unknown --backend "${backendNameEarly()}". Use "local" or "solari".`)
  process.exit(2)
}

if (cmd !== "check") {
  console.error(`usage: prism check [--backend local|solari] [--url URL] [--fix]`)
  process.exit(2)
}

const backendName = backendNameEarly()
const bugs = has("fix")
  ? { leakExportToFree: false, trackerBeforeConsent: false }
  : { leakExportToFree: true, trackerBeforeConsent: true }

let site: { url: string; close: () => Promise<void> } | null = null
let url = flag("url")
let backend: Backend

if (backendName === "solari") {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    console.error("SOLARI_API_KEY is not set. `--backend local` needs no credentials.")
    process.exit(2)
  }
  if (url && isLoopback(url)) {
    console.error(
      "A cloud browser cannot reach a URL on this machine.\n" +
      "Drop --url to have Prism host the demo site in a Solari sandbox, or point\n" +
      "--url at a publicly reachable address.",
    )
    process.exit(2)
  }
  if (!url) {
    // Browser and sandbox on the same key: the sandbox serves the demo site on
    // a public preview URL, which is the only way the cloud browser can see it.
    console.error("hosting the demo site in a Solari sandbox...")
    const hosted = await hostInSandbox(apiKey, { fix: has("fix") })
    site = hosted
    url = hosted.url
    console.error(`demo site: ${url} (guest node ${hosted.nodeVersion})`)
  }
  // Seed only the profiles Prism itself created for its own demo site. Against
  // a real target the profiles were enrolled by a human and must not be touched.
  backend = await solariBackend({ apiKey, seed: site !== null || has("seed") })
} else {
  if (!url) {
    site = await serve(0, bugs)
    url = site.url
    console.error(`demo site: ${url}${has("fix") ? " (bugs fixed)" : " (with the two planted bugs)"}`)
  }
  backend = await localBackend()
}

console.error(`backend: ${backend.name}  classes: ${CLASSES.length}\n`)

try {
  const backpressure: number[] = []
  const results = await check(backend, url, CLASSES, (e) => {
    backpressure.push(e.concurrency)
    console.error(`  backpressure: concurrency now ${e.concurrency}`)
  })

  // `--proof FILE` writes the run as evidence. A table in a README is a claim;
  // a committed run with every class's actual testids is something a reader can
  // check against the code.
  const proof = flag("proof")
  if (proof) {
    mkdirSync(new URL(".", `file://${process.cwd()}/${proof}`).pathname, { recursive: true })
    writeFileSync(proof, JSON.stringify({
      backend: backend.name,
      classes: CLASSES.length,
      bugsPlanted: !has("fix"),
      // The signed pt_token is a live credential for the sandbox; record only
      // the origin so the evidence can be committed.
      target: url.startsWith("http") ? new URL(url).origin : url,
      backpressureEvents: backpressure,
      results: results.map((r) => ({
        name: r.name, ok: r.ok, saw: r.saw, findings: r.findings, ms: r.ms,
        ...(r.error ? { error: r.error } : {}),
      })),
    }, null, 2) + "\n")
    console.error(`proof written to ${proof}`)
  }
  console.log(table(results))
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.log(`\n${failed.length} of ${results.length} user classes saw the wrong page:\n`)
    console.log(explain(results))
  } else {
    console.log(`\nall ${results.length} user classes saw exactly what they should.`)
  }
  // Exit code: a real check must fail CI when a user class sees the wrong
  // page. But the DEMO is supposed to find its own planted bugs, and exiting
  // non-zero there reads as "the example is broken" rather than "it worked".
  // So the demo reports success for finding exactly what it planted.
  const isDemo = site !== null && !has("fix")
  if (isDemo) {
    // Assert WHAT was found, not merely which classes went red. A class can
    // fail for the wrong reason and still land in the right bucket.
    const expected: Record<string, string[]> = {
      anon: ["tracker"],
      free: ["export"],
      "eu-consent-rejected": ["export", "tracker"],
    }
    const found = Object.fromEntries(
      failed.map((r) => [r.name, r.findings.map((f) => f.testid).sort()]),
    )
    const asPlanned = JSON.stringify(found, Object.keys(found).sort()) ===
      JSON.stringify(expected, Object.keys(expected).sort())
    console.log(asPlanned
      ? `\nThis is the expected result: the demo site ships those two bugs on purpose,\n` +
        `and Prism found every class they touch. Run with --fix to serve the\n` +
        `corrected app and see the same six classes go green.`
      : `\nUnexpected. Expected ${JSON.stringify(expected)}\n     but found ${JSON.stringify(found)}.`)
    process.exitCode = asPlanned ? 0 : 1
  } else {
    process.exitCode = failed.length ? 1 : 0
  }
} finally {
  await backend.close()
  await site?.close()
}
