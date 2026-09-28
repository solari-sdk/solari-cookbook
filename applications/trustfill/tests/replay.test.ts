import { describe, expect, test } from "vitest"
import { fetchReplayUrl } from "../src/replay.js"

describe("fetchReplayUrl", () => {
  test("returns the URL once it becomes available", async () => {
    let calls = 0
    const url = await fetchReplayUrl({
      sessionId: "s1",
      getReplayUrl: async () => {
        calls++
        if (calls < 3) throw Object.assign(new Error("not found"), { status: 404 })
        return "https://replay.example/s1"
      },
      attempts: 5,
      delayMs: 0,
    })

    expect(url).toBe("https://replay.example/s1")
    expect(calls).toBe(3)
  })

  // The upload happens asynchronously after release, so the first polls 404 even
  // on a perfectly good recording. That is expected, not an error.
  test("returns null rather than throwing when the replay never appears", async () => {
    const url = await fetchReplayUrl({
      sessionId: "s1",
      getReplayUrl: async () => {
        throw Object.assign(new Error("not found"), { status: 404 })
      },
      attempts: 3,
      delayMs: 0,
    })

    expect(url).toBeNull()
  })

  // Replay is an audit nicety. A broken replay endpoint must not take down a run
  // that already filled the questionnaire correctly.
  test("swallows an unexpected error instead of failing the run", async () => {
    const url = await fetchReplayUrl({
      sessionId: "s1",
      getReplayUrl: async () => {
        throw new Error("gateway exploded")
      },
      attempts: 2,
      delayMs: 0,
    })

    expect(url).toBeNull()
  })

  test("returns null immediately when there is no session id", async () => {
    let calls = 0
    const url = await fetchReplayUrl({
      sessionId: null,
      getReplayUrl: async () => {
        calls++
        return "should not be reached"
      },
      attempts: 3,
      delayMs: 0,
    })

    expect(url).toBeNull()
    expect(calls).toBe(0)
  })
})
