/**
 * Runs your Playwright specs on a Solari cloud browser — no local Chromium.
 *
 * In each spec, change
 *   import { test, expect } from '@playwright/test'
 * to
 *   import { test, expect } from './solari'
 * and change nothing else.
 *
 * Then just run `npx playwright test`. solari.global.ts mints a session
 * before the suite and releases it after, so the only thing you need in the
 * environment is SOLARI_API_KEY. Install the runner with
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — no browser binary is ever used.
 *
 * Why a fixture and not `use.connectOptions` in the config: connectOptions
 * speaks the Playwright wire protocol, and the server gates that on Playwright
 * 1.59.x (HTTP 428 on anything else, matched against Playwright's own
 * User-Agent). CDP has no version gate. This file is the price of never being
 * pinned to one Playwright release.
 *
 * Trade-off: overriding `context` means Playwright's own trace/video/
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
