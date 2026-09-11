import { describe, expect, test } from "vitest"
import { liveModel, NVIDIA_URL } from "../src/provider.js"

const okBody = (payload: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })

const rateLimited = () => new Response('{"status":429,"title":"Too Many Requests"}', { status: 429 })

const cfg = (fetchImpl: typeof fetch, retryDelayMs = 0) => ({
  url: NVIDIA_URL,
  apiKey: "test",
  model: "test-model",
  fetchImpl,
  retryDelayMs,
})

// The M0 spike had 429 backoff. Porting the provider into src/ dropped it, and
// the first concurrent capture immediately produced 29 rate-limit failures.
describe("liveModel retry", () => {
  test("retries a 429 and succeeds", async () => {
    let calls = 0
    const model = liveModel(
      cfg(async () => {
        calls++
        return calls < 3 ? rateLimited() : okBody({ sufficiency: "SUFFICIENT" })
      }),
    )

    await expect(model.draft("corpus", "q")).resolves.toMatchObject({ sufficiency: "SUFFICIENT" })
    expect(calls).toBe(3)
  })

  test("gives up after the retry budget and surfaces the status", async () => {
    let calls = 0
    const model = liveModel(
      cfg(async () => {
        calls++
        return rateLimited()
      }),
    )

    await expect(model.draft("corpus", "q")).rejects.toThrow(/429/)
    expect(calls).toBeGreaterThan(1)
  })

  // A malformed request will fail identically forever. Retrying it wastes the
  // budget and buries the real error behind a delay.
  test("does not retry a 400", async () => {
    let calls = 0
    const model = liveModel(
      cfg(async () => {
        calls++
        return new Response('{"error":"bad request"}', { status: 400 })
      }),
    )

    await expect(model.draft("corpus", "q")).rejects.toThrow(/400/)
    expect(calls).toBe(1)
  })
})
