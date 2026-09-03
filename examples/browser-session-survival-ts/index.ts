/**
 * Session survival — a task that is longer than a Solari browser session.
 *
 * A Solari browser session ends about ten minutes after it starts, whatever
 * you send it. Anything that runs longer dies mid-task, and the sessions API
 * keeps reporting the dead session as active. `outlive()` checkpoints cookies,
 * localStorage and the URL, notices the death on the connection, launches a
 * new browser with that state, and calls your task again.
 *
 * What survives: cookies, localStorage, the URL. What does not: the DOM and
 * anything the page held in JavaScript. So a task is written to be re-entered:
 * `ctx.attempt` says how often it has been called, `ctx.resumedFrom` is set
 * when a checkpoint was restored, and `ctx.checkpoint()` saves right after a
 * step that must not run twice.
 */
import { Solari } from "@solarisdk/browser"
import { outlive } from "outlive"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

// Twelve minutes of polling: longer than one session, by construction.
const POLLS = 36
const EVERY_MS = 20_000

try {
  const titles = await outlive(
    solari,
    async (page, ctx) => {
      if (ctx.attempt > 1) {
        console.log(`re-entered (attempt ${ctx.attempt}), resumed at ${ctx.resumedFrom?.url ?? "no checkpoint"}`)
      }
      if (!ctx.resumedFrom) {
        // The expensive part — sign in, land on the page — happens once.
        await page.goto("https://example.com/")
        await ctx.checkpoint()
      }

      const seen: string[] = []
      for (let i = 0; i < POLLS; i++) {
        await page.reload()
        seen.push(await page.title())
        await new Promise((resolve) => setTimeout(resolve, EVERY_MS))
      }
      return seen
    },
    {
      checkpointEveryMs: 30_000,
      maxRelaunches: 5,
      // One wide event per run: outcome, relaunches, checkpoints, lost work.
      onEvent: (event) => console.log(JSON.stringify(event)),
    },
  )

  console.log(`done: ${titles.length} polls across however many sessions it took`)
} finally {
  await solari.close()
}
