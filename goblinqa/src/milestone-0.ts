import assert from "node:assert/strict"

import { Solari, SolariError } from "@solarisdk/browser"

const TARGET_URL = "https://example.com"
const EXPECTED_TITLE = "Example Domain"
const REPLAY_ATTEMPTS = 10
const REPLAY_RETRY_DELAY_MS = 3_000
const RECORDING_FLUSH_DELAY_MS = 2_000

function requireApiKey(): string {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error(
      "SOLARI_API_KEY is required. Export it in the shell before running Milestone 0.",
    )
  }
  return apiKey
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function getReplayUrl(
  solari: Solari,
  sessionId: string,
): Promise<string> {
  for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt += 1) {
    await sleep(REPLAY_RETRY_DELAY_MS)

    try {
      const replay = await solari.sessions.getReplayUrl(sessionId)
      return replay.url
    } catch (error) {
      const replayIsStillProcessing =
        error instanceof SolariError && error.status === 404
      if (!replayIsStillProcessing || attempt === REPLAY_ATTEMPTS) {
        throw error
      }

      console.error(
        `Replay is still processing (attempt ${attempt}/${REPLAY_ATTEMPTS}).`,
      )
    }
  }

  throw new Error("Replay retry loop completed without a result.")
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const solari = new Solari({ apiKey: requireApiKey() })

  try {
    const browser = await solari.launch({ recording: true })
    const sessionId = browser.id
    let title = ""
    let heading = ""

    try {
      const page = await browser.newPage()
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" })

      title = await page.title()
      heading = await page.locator("h1").innerText()

      assert.equal(title, EXPECTED_TITLE)
      assert.equal(heading, EXPECTED_TITLE)

      // rrweb batches events, so allow its final page events to flush before
      // releasing the recorded session.
      await sleep(RECORDING_FLUSH_DELAY_MS)
    } finally {
      // Solari's Browser wrapper closes the connection and releases its session.
      await browser.close()
    }

    // Replay generation starts after the recorded session is released.
    const replayUrl = await getReplayUrl(solari, sessionId)

    console.log(
      JSON.stringify(
        {
          milestone: 0,
          success: true,
          sessionId,
          targetUrl: TARGET_URL,
          title,
          heading,
          replayUrl,
          durationMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    )
  } finally {
    // Required by the Node SDK so its local retry proxy cannot keep the
    // process alive after the remote browser is released.
    await solari.close()
  }
}

await main()
