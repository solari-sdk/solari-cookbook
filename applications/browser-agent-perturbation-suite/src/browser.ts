import { Solari, type BrowserSession } from "@solarisdk/browser"
import type { ResourceStack } from "./lifecycle.js"
import type { BrowserConfig } from "./perturbations.js"

/**
 * Playwright's types reach us through the SDK rather than by naming
 * `patchright-core` as a dependency we never import. Deriving them from the
 * SDK's own signatures keeps the dependency list honest.
 */
type Context = Awaited<ReturnType<BrowserSession["newContext"]>>
export type Page = Awaited<ReturnType<BrowserSession["newPage"]>>

/**
 * A browser session per trial, built to the trial's perturbation.
 *
 * `stack` is a required parameter, not an optional courtesy: you cannot obtain a
 * page from this function without handing in the thing that will release the
 * session, and the release is registered before anything below it can throw. See
 * `lifecycle.ts` for why that matters.
 */
export async function openPage(
  solari: Solari,
  stack: ResourceStack,
  config: BrowserConfig,
): Promise<Page> {
  const session = await solari.launch()
  // Registered on the next line with no suspension point in between, so nothing
  // can interleave and orphan it. The id is in the label because it is the only
  // handle you get for a manual cleanup: the SDK cannot list or query live
  // sessions, so if a release fails, this string is what you take to the console.
  const browser = stack.add(`browser session ${session.id}`, session, (b) => b.close())

  const options = {
    ...(config.viewport ? { viewport: config.viewport } : {}),
    ...(config.isMobile === undefined ? {} : { isMobile: config.isMobile }),
    ...(config.hasTouch === undefined ? {} : { hasTouch: config.hasTouch }),
    ...(config.deviceScaleFactor ? { deviceScaleFactor: config.deviceScaleFactor } : {}),
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
  }

  // A perturbed context has to be the context the page lives in, so when there
  // are options we always build our own. With none, prefer the pool's context:
  // `contexts()` is empty unless a proxy was requested, so the fallback is not
  // optional — indexing into it and calling newPage() would throw on a plain
  // launch.
  const context: Context =
    Object.keys(options).length > 0
      ? await browser.newContext(options)
      : (browser.contexts()[0] ?? (await browser.newContext()))

  if (config.networkDelay) {
    const { pattern, delayMs } = config.networkDelay
    // Route interception rather than CDP throttling. `Network.emulateNetworkConditions`
    // is available and is more faithful to a bad connection, but a bandwidth cap
    // produces a different environment on every run — and then a reliability
    // difference between two suites is no longer attributable to the agent.
    // Reproducibility is worth more here than fidelity.
    await context.route(pattern, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      await route.continue()
    })
  }

  return context.newPage()
}

export function createSolari(apiKey: string, stack: ResourceStack): Solari {
  const solari = new Solari({ apiKey })
  // Registered first, so LIFO releases it last — after every session that was
  // opened through it. Since 0.1.3 `browser.close()` alone lets Node exit, but
  // this releases the client's connection pool immediately and costs nothing.
  stack.add("solari client", solari, (s) => s.close())
  return solari
}
