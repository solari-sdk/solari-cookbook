/**
 * Solari cloud browsers, one server-side profile per user class.
 *
 * Three traps, all of them why the profiles example has been fixed twice:
 *   1. `profileId` does NOT seed the browser. The state arrives on
 *      `session.storageState` and must be handed to `newContext`; a page from
 *      `browser.newPage()` starts anonymous.
 *   2. State is discarded on release unless `profiles.save()` is called.
 *   3. A context you build yourself does not inherit the pool's timezone pin,
 *      so `timezoneId` has to be forwarded or Intl disagrees with the egress IP.
 */
import { Solari, SolariError } from "@solarisdk/browser"
import { EXTRACT, type Backend, type PageProbe } from "./backend.js"

export type SolariOpts = {
  apiKey: string
  profilePrefix?: string
  /**
   * Overwrite each profile's stored state with the class's cookies before
   * every probe. This is how the bundled demo runs without anyone owning an
   * account on the target app, and it MUST stay opt-in: against a real target
   * the profiles hold sessions a human enrolled by hand in the console, and
   * seeding would destroy them -- the exact thing this application claims you
   * never have to do.
   */
  seed?: boolean
}

export async function solariBackend(opts: SolariOpts): Promise<Backend> {
  const solari = new Solari({ apiKey: opts.apiKey })
  const prefix = opts.profilePrefix ?? "prism"
  const seed = opts.seed === true

  return {
    name: "solari",
    isBackpressure,
    async probe(url, cookies, label): Promise<PageProbe> {
      const name = `${prefix}-${label}`
      const existing = (await solari.profiles.list()).find((p) => p.name === name)

      if (!seed && !existing) {
        throw new Error(
          `no Solari profile named "${name}". Enrol it once in the console's live ` +
            `browser (console.getsolari.com), or pass --seed to have Prism write ` +
            `demo cookies into it. Prism will not create or overwrite a profile ` +
            `you did not ask it to.`,
        )
      }

      const profile = existing ?? (await solari.profiles.create({ name }))

      if (seed) {
        const origin = new URL(url).origin
        await solari.profiles.save(profile.id, {
          cookies: cookies.map((c) => ({ ...c, domain: new URL(origin).hostname, path: "/" })),
        })
      }

      const browser = await solari.launch({ profileId: profile.id })
      try {
        const storageState = browser.session.storageState as
          | NonNullable<Parameters<typeof browser.newContext>[0]>["storageState"]
          | undefined
        const ctx = await browser.newContext({ storageState, timezoneId: browser.proxy?.timezoneId })
        const page = await ctx.newPage()
        await page.goto(url, { waitUntil: "load" })
        return { testids: await page.evaluate(EXTRACT), title: await page.title(), url: page.url() }
      } finally {
        await browser.close()
      }
    },
    async close() { await solari.close() },
  }
}

/**
 * True when the API refused because the account is at its concurrency cap.
 * Measured: `429 {"code":"ConcurrencyLimitExceeded","cap":20}` -- retryable
 * once a slot frees, unlike every other 4xx.
 */
export function isBackpressure(err: unknown): boolean {
  return err instanceof SolariError && err.status === 429
}
