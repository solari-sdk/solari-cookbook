import { describe, expect, test } from "vitest"
import { runQuestionnaire } from "../src/run.js"
import type { Model } from "../src/pipeline.js"

const answering: Model = {
  draft: async () => ({
    sufficiency: "SUFFICIENT",
    answer: "yes",
    citations: [{ document: "d.md", quote: "q" }],
    reasoning: "r",
  }),
  verify: async () => ({
    claims: [{ claim: "yes", essential: true, supported: true, sourceText: "yes" }],
  }),
}

const questions = [
  { id: "Q01", text: "one" },
  { id: "Q02", text: "two" },
  { id: "Q03", text: "three" },
]

describe("runQuestionnaire", () => {
  test("returns one result per question, keyed by id", async () => {
    const results = await runQuestionnaire({
      questions,
      corpus: "c",
      modelFor: () => answering,
    })

    expect(results.map((r) => r.id)).toEqual(["Q01", "Q02", "Q03"])
    expect(results.every((r) => r.answer?.abstained === false)).toBe(true)
  })

  // The capture ran serially and took 140 minutes for 30 independent questions.
  // Wall time should track the slowest question, not the sum.
  test("runs questions concurrently up to the limit", async () => {
    let inFlight = 0
    let peak = 0
    const slow: Model = {
      draft: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return { sufficiency: "INSUFFICIENT", answer: null, citations: [], reasoning: "r" }
      },
      verify: async () => ({ claims: [] }),
    }

    await runQuestionnaire({ questions, corpus: "c", modelFor: () => slow, concurrency: 2 })

    expect(peak).toBe(2)
  })

  // One bad question must not lose the other 29. The whole point of a run is the
  // 26/4 split; aborting on the first failure throws away everything.
  test("isolates a failing question instead of aborting the run", async () => {
    const flaky: Model = {
      draft: async (_corpus, question) => {
        if (question === "two") throw new Error("provider exploded")
        return { sufficiency: "SUFFICIENT", answer: "yes", citations: [{ document: "d.md", quote: "q" }], reasoning: "r" }
      },
      verify: async () => ({
        claims: [{ claim: "yes", essential: true, supported: true, sourceText: "yes" }],
      }),
    }

    const results = await runQuestionnaire({ questions, corpus: "c", modelFor: () => flaky })

    expect(results).toHaveLength(3)
    expect(results.find((r) => r.id === "Q02")?.error).toMatch(/provider exploded/)
    expect(results.find((r) => r.id === "Q01")?.answer?.abstained).toBe(false)
    expect(results.find((r) => r.id === "Q03")?.answer?.abstained).toBe(false)
  })
})
