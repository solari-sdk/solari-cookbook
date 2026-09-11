import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"

export const PROFILE_NAME = "trustfill-northwind"

export interface BrowserRuntime {
  page: Page
  sessionId: string | null
  /**
   * Persist cookies + localStorage back to the profile.
   *
   * Attaching a profile does NOT auto-save it — state is discarded on release
   * unless this is called. That single gotcha is the whole point of the profile
   * demo, and forgetting it makes run 2 look identical to run 1.
   */
  saveProfile: () => Promise<void>
  stop: () => Promise<void>
}

export interface LaunchOptions {
  apiKey: string
  /** Recording is opt-in per session; without it the replay endpoint 404s forever. */
  recording?: boolean
}

export async function launchBrowser({ apiKey, recording = true }: LaunchOptions): Promise<BrowserRuntime & { reusedProfile: boolean }> {
  const solari = new Solari({ apiKey })

  const existing = (await solari.profiles.list()).find((p) => p.name === PROFILE_NAME)
  const profile = existing ?? (await solari.profiles.create({ name: PROFILE_NAME }))

  const browser = await solari.launch({ profileId: profile.id, recording })

  // NOT browser.newPage(). `launch({ profileId })` fetches the saved state into
  // session.storageState but does not seed the browser with it, and a context
  // from newPage() comes up with neither cookies nor localStorage — the profile
  // silently does nothing. Seeding the context explicitly is what restores it.
  // (Same bug as cookbook PR #17 against browser-profiles-ts.)
  const session = (browser as unknown as { session?: { storageState?: unknown } }).session
  const context = await browser.newContext({ storageState: (session?.storageState as never) ?? undefined })
  const page = await context.newPage()

  return {
    page: page as unknown as Page,
    reusedProfile: Boolean(existing),
    sessionId: browser.id ?? null,
    saveProfile: async () => {
      const state = await page.context().storageState()
      await solari.profiles.save(profile.id, state)
    },
    stop: async () => {
      await browser.close().catch(() => {})
      // browser.close() is enough to exit as of @solarisdk/browser 0.1.3, but
      // close() releases the client pool immediately rather than at exit.
      await solari.close().catch(() => {})
    },
  }
}
