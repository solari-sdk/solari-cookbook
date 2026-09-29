/**
 * A fleet of profiles — three identities, three browsers, all at once.
 *
 * One profile is a saved login. Several profiles are a *cast*: the same page
 * rendered as an anonymous visitor, a free account and a paying one, in
 * parallel, and each browser proving it got its own state rather than someone
 * else's.
 *
 * The proof matters more than the parallelism. Asserting "the profile was
 * attached" tells you nothing; this reads the value back off a live page and
 * throws if it is wrong.
 */
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const ORIGIN = "https://example.com"
const CAST = [
  { name: "fleet-anon", tier: "anon" },
  { name: "fleet-free", tier: "free" },
  { name: "fleet-paid", tier: "paid" },
]

const profiles = []
for (const role of CAST) {
  const existing = (await solari.profiles.list()).find((p) => p.name === role.name)
  const profile = existing ?? (await solari.profiles.create({ name: role.name }))
  // Seeding state directly is a shortcut so this runs with no accounts. In
  // real use you populate a profile once in the console's live browser, where
  // a human can clear 2FA and a captcha — and after that no credential ever
  // needs to reach your CI.
  await solari.profiles.save(profile.id, {
    origins: [{ origin: ORIGIN, localStorage: [{ name: "tier", value: role.tier }] }],
  })
  profiles.push({ ...role, id: profile.id })
}

try {
  // Three at once. Starter allows 20 concurrent browsers on paper; measured, it
  // accepts 18 and refuses the 19th, so a real fleet should back off on a 429.
  await Promise.all(profiles.map(async (p) => {
    const browser = await solari.launch({ profileId: p.id })
    try {
      // Attaching a profile does NOT seed the browser: the state arrives on
      // `session.storageState` and has to reach the context you create. A page
      // from `browser.newPage()` starts anonymous and this assert would fail.
      const storageState = browser.session.storageState as
        | NonNullable<Parameters<typeof browser.newContext>[0]>["storageState"]
        | undefined
      const context = await browser.newContext({
        storageState,
        // A context you build yourself does not inherit the pool's timezone pin.
        timezoneId: browser.proxy?.timezoneId,
      })
      const page = await context.newPage()
      await page.goto(ORIGIN)

      const seen = await page.evaluate(() => localStorage.getItem("tier"))
      if (seen !== p.tier) throw new Error(`${p.name}: expected ${p.tier}, page said ${seen}`)
      console.log(`${p.name.padEnd(11)} saw tier=${seen}`)
    } finally {
      await browser.close()
    }
  }))
  console.log(`\n${profiles.length} browsers, ${profiles.length} identities, none of them mixed up.`)
} finally {
  for (const p of profiles) await solari.profiles.delete(p.id)
}
