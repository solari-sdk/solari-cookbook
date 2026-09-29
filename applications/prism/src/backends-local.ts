/** Playwright on this machine. No key, no network beyond the demo site. */
import { chromium, type Browser } from "playwright"
import { EXTRACT, type Backend, type PageProbe } from "./backend.js"

export async function localBackend(): Promise<Backend> {
  // Memoize the PROMISE, not the browser. `browser ??= await launch()` is not
  // atomic across the await: every concurrent probe would see null and launch
  // its own Chromium, and all but the last would leak -- the process then
  // never exits because orphaned children hold the event loop open.
  let launching: Promise<Browser> | null = null
  const get = () => (launching ??= chromium.launch())
  return {
    name: "local",
    async probe(url, cookies): Promise<PageProbe> {
      const b = await get()
      const origin = new URL(url).origin
      const ctx = await b.newContext()
      try {
        await ctx.addCookies(cookies.map((c) => ({ ...c, url: origin })))
        const page = await ctx.newPage()
        await page.goto(url, { waitUntil: "load" })
        return { testids: await page.evaluate(EXTRACT), title: await page.title(), url: page.url() }
      } finally {
        // Without the finally, a probe that throws leaks its context: the
        // browser stays alive holding it and the process never exits.
        await ctx.close()
      }
    },
    async close() {
      // Never re-throw here. close() runs in the caller's `finally`, so a
      // rejection would mask the real error and skip the rest of the cleanup.
      if (!launching) return
      await launching.then((b) => b.close()).catch(() => {})
    },
  }
}
