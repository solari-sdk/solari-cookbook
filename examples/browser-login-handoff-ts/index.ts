/**
 * Login handoff — let a human sign in, then never ask again.
 *
 * An agent hits a login wall. Rather than trying to automate a password, a 2FA
 * code and a bot check, hand the live session to a person: they get a URL, they
 * see the actual browser, they sign in, and control comes straight back. Save
 * the result to a profile and the next run starts already logged in.
 *
 * The relay is first-party — the human drives the real session over a scoped,
 * short-lived link, and never sees the signed CDP endpoint. There is no SDK
 * method for it yet, so these three calls are plain HTTP.
 */
import { Solari } from "@solarisdk/browser"

const API = "https://api.getsolari.com"
const apiKey = requireEnv("SOLARI_API_KEY")
const TARGET = process.argv[2] ?? "https://github.com/login"
const PROFILE_NAME = "handoff-demo"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** These three endpoints have no SDK wrapper yet, so call them directly. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

const solari = new Solari({ apiKey })

// Reuse the profile across runs; create it the first time only.
const existing = (await solari.profiles.list()).find((p) => p.name === PROFILE_NAME)
const profile = existing ?? (await solari.profiles.create({ name: PROFILE_NAME }))

const browser = await solari.launch({ profileId: profile.id })
try {
  // Attaching a profile does not seed the browser — the stored state arrives on
  // `session.storageState` and has to reach the context you create. Run this a
  // second time and the site should already know you.
  const storageState = browser.session.storageState as
    | NonNullable<Parameters<typeof browser.newContext>[0]>["storageState"]
    | undefined
  const context = await browser.newContext({ storageState })
  const page = await context.newPage()
  await page.goto(TARGET, { waitUntil: "domcontentloaded" })

  if (await isSignedIn(page)) {
    console.log("already signed in — the saved profile did its job")
  } else {
    // `reason` is required, and it is not paperwork: it is the sentence the
    // human reads before deciding whether to trust the link you just sent them.
    const handoff = await api<{ url: string; shortUrl: string; expiresAt: string }>(
      "POST",
      `/sessions/${encodeURIComponent(browser.id)}/handoff`,
      { reason: `Sign in to ${new URL(TARGET).hostname} so the agent can continue.` },
    )

    console.log("\n  send this to a human:")
    console.log(`  ${handoff.shortUrl}`)
    console.log(`  expires ${handoff.expiresAt}\n`)

    const outcome = await waitForHuman(browser.id)
    if (outcome !== "completed") {
      console.log(`handoff ${outcome} — nothing saved`)
      process.exitCode = 1
    } else {
      // Persist what the human just did, so the next run skips all of this.
      // Save through the gateway rather than profiles.save(): it reads the state
      // out of the live session, including anything set after the handoff.
      const saved = await api<{ cookies: number; origins: string[] }>(
        "POST",
        `/sessions/${encodeURIComponent(browser.id)}/save-profile`,
        { profileId: profile.id },
      )
      console.log(`saved ${saved.cookies} cookies across ${saved.origins.length} origin(s)`)
      console.log("run this again — it should not ask twice")
    }
  }
} finally {
  await browser.close()
}

/** Poll until the person finishes, gives up, or the link expires. */
async function waitForHuman(sessionId: string): Promise<string> {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const { status } = await api<{ status: string }>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/handoff`,
    )
    // "pending" while the tab is open, then completed / cancelled / expired.
    if (status !== "pending" && status !== "none") return status
  }
  return "timed out"
}

/** Replace this with whatever "logged in" means on your site. */
async function isSignedIn(page: { url: () => string }): Promise<boolean> {
  return !/\/login|\/signin|\/sessions\/new/.test(page.url())
}
