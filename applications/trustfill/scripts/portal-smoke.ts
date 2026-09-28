/**
 * M2 smoke test — boot the portal in a Solari sandbox, prove it is reachable on
 * the public preview URL, then kill the VM.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/portal-smoke.ts
 *
 * Pass --keep to leave it running (the URL is printed) for manual poking.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnv } from "../src/env.js"
import { startPortal } from "../src/sandbox.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// Load .env before anything reads process.env.
loadEnv(join(ROOT, ".env"))
const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("\n  SOLARI_API_KEY is not set.\n")
  process.exit(1)
}

const keep = process.argv.includes("--keep")
const started = Date.now()
const portal = await startPortal({ apiKey, root: ROOT })

try {
  console.log(`\n  portal up in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`  ${portal.url}\n`)

  // The preview URL carries ?pt_token=… — appending a path to the string puts it
  // inside the QUERY, not the path. Build with URL so the token survives.
  const at = (path: string) => {
    const u = new URL(portal.url)
    u.pathname = path
    return u.toString()
  }

  // And the gateway sets its own cookie from that token. Overwriting the cookie
  // header instead of adding to it logs you out of the preview, not the portal.
  const jar = new Map<string, string>()
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
  const remember = (res: Response) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";")
      const idx = pair?.indexOf("=") ?? -1
      if (pair && idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1))
    }
    return res
  }

  const login = remember(await fetch(at("/login"), { headers: { cookie: cookieHeader() } }))
  const html = await login.text()
  const testids = [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1])
  console.log(`  GET /login            ${login.status} · testids: ${testids.join(", ")}`)

  const guarded = remember(
    await fetch(at("/questionnaire"), { redirect: "manual", headers: { cookie: cookieHeader() } }),
  )
  console.log(`  GET /questionnaire    ${guarded.status} → ${guarded.headers.get("location")} (unauthenticated)`)

  const auth = remember(
    await fetch(at("/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
      body: "email=vendor@meridian.example&password=trustfill-demo",
      redirect: "manual",
    }),
  )
  console.log(`  POST /login           ${auth.status} · cookie ${jar.has("northwind_session") ? "set" : "MISSING"}`)

  const page = await fetch(at("/questionnaire"), { headers: { cookie: cookieHeader() } })
  const fields = [...(await page.text()).matchAll(/data-testid="answer-([^"]+)"/g)].map((m) => m[1])
  console.log(`  GET /questionnaire    ${page.status} · ${fields.length} answer fields`)
  console.log(`\n  ${fields.length === 30 ? "M2 smoke PASS" : "M2 smoke FAIL — expected 30 fields"}\n`)

  if (keep) {
    console.log("  --keep: leaving the sandbox up. Ctrl-C to release.\n")
    await new Promise(() => {})
  }
} finally {
  if (!keep) {
    await portal.stop()
    console.log("  sandbox killed\n")
  }
}
