/**
 * The differentiator: run the generated spec on a fresh cloud browser and only
 * bless it if the real Playwright runner says it passed.
 *
 * Two things here look odd and both are load-bearing:
 *
 * 1. We mint the session with a raw `fetch` instead of `@solarisdk/browser`.
 *    The SDK rewrites `cdpEndpoint` to a `ws://127.0.0.1:<port>/...` relay that
 *    only exists inside *this* process. The spawned runner is a different
 *    process, so it needs the real `wss://api.getsolari.com/cdp/<id>`, and only
 *    `POST /sessions` hands that out.
 *
 * 2. We connect over CDP from a fixture rather than setting `use.connectOptions`.
 *    `connectOptions` speaks the Playwright wire protocol, which the server
 *    hard-gates on Playwright 1.59.x — every other version gets HTTP 428 before
 *    a single test runs, keyed off Playwright's own User-Agent header. CDP has
 *    no such gate, so our users keep the right to upgrade Playwright.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { apiKey } from "./session.js"
import type { RunResult } from "./types.js"

const API = "https://api.getsolari.com"

/** Longest run output we keep; beyond this we take the head and the tail. */
const MAX_OUTPUT = 8000

// ─── the two files a user can commit ────────────────────────────────────────
// Kept minimal and version-proof on purpose: this pair is what makes the
// generated tests theirs rather than locked to our CLI.

export const SOLARI_CONFIG = `import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  // One Solari session is one browser. A second worker would fight the first
  // over the same remote Chrome, so keep the suite serial per session.
  workers: 1,
  fullyParallel: false,
  globalSetup: './solari.global.ts',
  reporter: 'line',
  timeout: 60_000,
  use: {
    // Deliberately no \`connectOptions\` — see solari.ts. The connection is made
    // in a fixture, over CDP, which is why this config survives a Playwright
    // upgrade instead of 428-ing on anything that isn't 1.59.x.
    actionTimeout: 15_000,
  },
})
`

export const SOLARI_FIXTURE = `/**
 * Runs your Playwright specs on a Solari cloud browser — no local Chromium.
 *
 * In each spec, change
 *   import { test, expect } from '@playwright/test'
 * to
 *   import { test, expect } from './solari'
 * and change nothing else.
 *
 * Then just run \`npx playwright test\`. solari.global.ts mints a session
 * before the suite and releases it after, so the only thing you need in the
 * environment is SOLARI_API_KEY. Install the runner with
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — no browser binary is ever used.
 *
 * Why a fixture and not \`use.connectOptions\` in the config: connectOptions
 * speaks the Playwright wire protocol, and the server gates that on Playwright
 * 1.59.x (HTTP 428 on anything else, matched against Playwright's own
 * User-Agent). CDP has no version gate. This file is the price of never being
 * pinned to one Playwright release.
 *
 * Trade-off: overriding \`context\` means Playwright's own trace/video/
 * screenshot-on-failure are off. Solari's session replay is the artifact instead.
 */
import { test as base, chromium, type Browser } from '@playwright/test'

export { expect } from '@playwright/test'

export const test = base.extend<{}, { solariBrowser: Browser }>({
  // Worker-scoped, so one CDP connection is opened and closed once for the whole
  // file. Per-test would be tidier to read and wrong: closing a CDP-connected
  // browser ends the remote Chrome, which would kill the session mid-suite.
  solariBrowser: [
    async ({}, use) => {
      const endpoint = process.env.SOLARI_CDP_ENDPOINT
      if (!endpoint) throw new Error('SOLARI_CDP_ENDPOINT is not set — mint a session first')
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 })
      await use(browser)
      await browser.close()
    },
    { scope: 'worker' },
  ],

  // Over /cdp/ the session already has a context holding a page (unlike the /ws/
  // path, where contexts() comes back empty). Reuse them rather than stacking
  // new ones on top — a fresh context here would start on about:blank with none
  // of the session's cookies.
  context: async ({ solariBrowser }, use) => {
    await use(solariBrowser.contexts()[0] ?? (await solariBrowser.newContext()))
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()))
  },
})
`

export const SOLARI_GLOBAL = `/**
 * Mints one Solari browser session for the whole suite, and releases it after.
 *
 * Without this you would have to POST /sessions by hand and export
 * SOLARI_CDP_ENDPOINT before every run. Playwright starts its workers after
 * globalSetup returns and they inherit this process's environment, so setting
 * the variable here is enough to reach the fixture in solari.ts.
 *
 * Bring your own session by setting SOLARI_CDP_ENDPOINT yourself — CI that
 * already has one should not mint a second.
 */
const API = 'https://api.getsolari.com'

export default async function globalSetup() {
  if (process.env.SOLARI_CDP_ENDPOINT) return // caller supplied one; leave it alone

  const key = process.env.SOLARI_API_KEY
  if (!key) throw new Error('SOLARI_API_KEY is not set — get one at console.getsolari.com')

  const res = await fetch(API + '/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    throw new Error('could not start a Solari session (' + res.status + '): ' + (await res.text()))
  }

  const session = await res.json()
  process.env.SOLARI_CDP_ENDPOINT = session.cdpEndpoint

  // The returned function runs as global teardown. Releasing matters: an
  // orphaned session bills until its idle timeout and holds one of the
  // concurrency slots your plan allows.
  return async () => {
    await fetch(API + '/sessions/' + session.sessionId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + key },
    }).catch(() => {})
  }
}
`

/** Write the commit-me files into a directory. */
export function emitRunnerFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "playwright.config.ts"), SOLARI_CONFIG)
  writeFileSync(join(dir, "solari.ts"), SOLARI_FIXTURE)
  // Our own verification run sets SOLARI_CDP_ENDPOINT for the child, so this
  // no-ops there. It exists for the copy the user keeps, where `npx playwright
  // test` has to be the entire command.
  writeFileSync(join(dir, "solari.global.ts"), SOLARI_GLOBAL)
}

// ─── verification ───────────────────────────────────────────────────────────

export async function verifySpec(spec: string, dir: string): Promise<RunResult> {
  mkdirSync(dir, { recursive: true })
  const runnerModules = findRunner(dir)
  const key = apiKey()

  emitRunnerFiles(dir)
  // The spec we hand back imports '@playwright/test' like any ordinary spec.
  // In here it has to pick up the CDP fixture instead, and Playwright gives a
  // config no way to inject fixtures — so rewrite the one import line, and only
  // in this copy.
  writeFileSync(join(dir, "generated.spec.ts"), spec.replace(/(['"])@playwright\/test\1/g, "'./solari'"))

  // Playwright resolves imports from the spec's own directory, and a temp dir has
  // no node_modules. Lend it the tree that actually holds the runner.
  const link = join(dir, "node_modules")
  if (!existsSync(link)) symlinkSync(runnerModules, link, "junction")

  // Nothing in this run may touch a local browser. Pointing Playwright at an
  // empty browsers dir means that if the CDP path ever silently regresses we
  // fail loudly instead of quietly testing against someone's local Chromium.
  const noBrowsers = join(dir, "no-browsers")
  mkdirSync(noBrowsers, { recursive: true })

  const session = await mintSession(key)
  try {
    const { out, code } = await runPlaywright(dir, session.cdpEndpoint, noBrowsers)
    const count = (re: RegExp) => Number(out.match(re)?.[1] ?? 0)
    const passed = count(/(\d+) passed/)
    // A config error, a TypeScript error or a dead endpoint exits non-zero with
    // no "N failed" line anywhere. Scoring that 0/0 would read as a pass.
    const failed = count(/(\d+) failed/) || (code === 0 ? 0 : 1)
    return { spec, passed, failed, output: trim(out) }
  } finally {
    await dropSession(key, session.sessionId)
  }
}

/**
 * The node_modules directory holding @playwright/test. The user's own install
 * wins over ours: it's their Playwright version that has to run these specs
 * after we're gone.
 */
function findRunner(dir: string): string {
  // A path inside `dir` (the file need not exist) makes require() walk up the
  // caller's tree; import.meta.url walks up ours.
  for (const from of [pathToFileURL(join(resolve(dir), "_")).href, import.meta.url]) {
    try {
      // <node_modules>/@playwright/test/package.json → <node_modules>
      return dirname(dirname(dirname(createRequire(from).resolve("@playwright/test/package.json"))))
    } catch {
      // not in this tree; try the next
    }
  }
  throw new Error(
    "ghostspec verifies a spec by running it, and @playwright/test is not installed. Fix:\n" +
      "  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D @playwright/test\n" +
      "The env var matters: your spec runs on a Solari cloud browser, so the ~400 MB of\n" +
      "local browser binaries would be downloaded and never opened.",
  )
}


async function mintSession(key: string): Promise<{ sessionId: string; cdpEndpoint: string }> {
  const r = await fetch(`${API}/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  })
  if (!r.ok) throw new Error(`solari POST /sessions → ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return (await r.json()) as { sessionId: string; cdpEndpoint: string }
}

async function dropSession(key: string, id: string): Promise<void> {
  // Never throws: a release failure must not mask the test failure that is the
  // actual news. An orphan session still auto-releases at expiresAt — an hour
  // of billed browser we would rather not pay for.
  await fetch(`${API}/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  }).catch(() => undefined)
}

function runPlaywright(dir: string, cdpEndpoint: string, noBrowsers: string) {
  return new Promise<{ out: string; code: number }>((done) => {
    const p = spawn("npx", ["playwright", "test", "--reporter=line"], {
      cwd: dir,
      env: {
        ...process.env,
        SOLARI_CDP_ENDPOINT: cdpEndpoint,
        PLAYWRIGHT_BROWSERS_PATH: noBrowsers,
      },
    })
    let out = ""
    // Merged, in arrival order: a Playwright failure puts the diff on stdout and
    // the stack on stderr, and split apart they're much harder to read.
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (out += d))
    p.on("error", (e) => done({ out: `${out}\ncould not spawn npx: ${e.message}`, code: 1 }))
    p.on("close", (code) => done({ out, code: code ?? 1 }))
  })
}

/** Keep the head (what ran) and the tail (the verdict); the middle is noise. */
function trim(out: string): string {
  const s = out.trim()
  if (s.length <= MAX_OUTPUT) return s
  return `${s.slice(0, 2500)}\n\n… ${s.length - 6500} characters trimmed …\n\n${s.slice(-4000)}`
}
