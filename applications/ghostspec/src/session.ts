/**
 * A Solari browser session, over raw HTTP.
 *
 * We deliberately do not use `@solarisdk/browser`'s `sessions.create()`: it runs an
 * in-process relay and hands back `ws://127.0.0.1:<ephemeral>/…`, which dies with the
 * Node process and cannot be given to a spawned test runner. `POST /sessions` returns
 * the real `wss://api.getsolari.com/…` and is one fetch, so that is what we do.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { chromium, type Page } from "playwright-core"

const BASE = "https://api.getsolari.com"

export type SolariSession = {
  sessionId: string
  cdpEndpoint: string
  wsEndpoint: string
  expiresAt: string
}

const cache = new Map<string, string>()

/**
 * A variable from the environment, or from the nearest `.env` above the cwd —
 * the key usually lives at the repo root while you run commands from a package
 * directory inside it. Every variable ghostspec reads goes through here, so
 * `.env.example` is true for all of them and not just the Solari one.
 */
export function envVar(name: string): string | undefined {
  const hit = cache.get(name)
  if (hit) return hit
  const set = (v: string) => (cache.set(name, v), v)
  const fromEnv = process.env[name]?.trim()
  if (fromEnv) return set(fromEnv)
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = join(dir, ".env")
    const found =
      existsSync(file) &&
      new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m").exec(readFileSync(file, "utf8"))
    if (found) return set(found[1].trim().replace(/^["']|["']$/g, ""))
    if (dirname(dir) === dir) return undefined
  }
}

export function apiKey(): string {
  const key = envVar("SOLARI_API_KEY")
  if (!key) throw new Error("no SOLARI_API_KEY — set it in the environment or in a .env file")
  return key
}

/**
 * Turn a failed response into something that tells you what to do about it.
 * `sent` is the request body so a 402 can name the feature that was refused.
 */
function apiError(status: number, body: string, sent?: Record<string, unknown>): Error {
  let code: string | undefined
  try {
    code = (JSON.parse(body) as { code?: string }).code
  } catch {
    /* the gateway sometimes answers with plain text; the status still tells us enough */
  }
  if (code === "FeatureRequiresPlan") {
    const paid = Object.keys(sent ?? {}).filter((k) => k !== "recording" && k !== "profileId")
    return new Error(
      `Solari refused a paid feature${paid.length ? ` (${paid.join(", ")})` : ""}: this account ` +
        `is on the Free plan — no stealth, proxies or captcha solving. ${body}`,
    )
  }
  if (code === "ConcurrencyLimitExceeded") {
    // Never retried, anywhere. A 429 means slots are genuinely occupied; hammering it
    // just burns the window in which the leaked session would have expired.
    return new Error(
      "Solari concurrency limit: the Free plan allows 3 concurrent browsers. Either another " +
        "ghostspec run is live, or a previous run crashed without releasing its session — " +
        "those expire on their own after 1h. Not retryable. " +
        body,
    )
  }
  return new Error(`Solari ${status}: ${body.slice(0, 400)}`)
}

/** `POST /sessions`. `recording: true` is free and gives us the replay link. */
export async function createSession(opts: { recording?: boolean } = {}): Promise<SolariSession> {
  const body: Record<string, unknown> = { recording: opts.recording ?? false }
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      // Creates are not idempotent by default; if our request is retried at the transport
      // layer this stops us paying for two browsers and only ever seeing one.
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw apiError(res.status, await res.text(), body)
  return (await res.json()) as SolariSession
}

/**
 * `DELETE /sessions/:id`, idempotent. Never throws: this runs in a `finally`, where a
 * throw would both mask the real error and leave a browser we are being billed for.
 */
export async function releaseSession(id: string): Promise<void> {
  await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey()}` },
  }).catch(() => {})
}

/** `GET /sessions/:id/replay-url`. 404 means "not rendered yet", not "no recording". */
export async function getReplayUrl(id: string): Promise<string | undefined> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}/replay-url`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  })
  if (res.status === 404) return undefined
  if (!res.ok) throw apiError(res.status, await res.text())
  return ((await res.json()) as { url: string }).url
}

/**
 * Poll until the replay renders. Measured at ~21s after release (404 the whole time
 * before that), so the default budget is generous. Returns `undefined` on timeout
 * rather than throwing — a missing replay link is a cosmetic loss, not a failed run.
 */
export async function waitForReplay(id: string, timeoutMs = 45_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = await getReplayUrl(id).catch(() => undefined)
    if (url) return url
    await new Promise((r) => setTimeout(r, 3_000))
  }
  return undefined
}

/**
 * Attach to the session and get the page to drive.
 *
 * CDP, not the Playwright wire protocol: the `/ws/` endpoint compares the client's
 * `User-Agent: Playwright/<major>.<minor>` against the pool's 1.59 and answers HTTP 428
 * on anything else. `/cdp/` has no such gate, so we are free to track playwright-core.
 */
export async function connect(cdpEndpoint: string): Promise<Page> {
  const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 30_000 })
  // `contexts()` is empty unless the session asked for a proxy — the pool only creates
  // a context up front for a session that requested one — so on a plain session like
  // ours the `newContext()` branch is the normal path, not the fallback. (A context we
  // make ourselves also skips the pool's timezone pin. That only matters with a proxy
  // attached, which is a paid feature ghostspec does not use.)
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  return ctx.pages()[0] ?? (await ctx.newPage())
}
