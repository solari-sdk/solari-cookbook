import { describe, expect, test } from "vitest"
import { fixtureModel, recordingModel } from "../src/fixtures.js"

describe("fixtureModel", () => {
  test("replays the captured draft and verification", async () => {
    const model = fixtureModel({
      draft: { sufficiency: "SUFFICIENT", answer: "x", citations: [], reasoning: "r" },
      verification: { claims: [] },
    })

    expect(await model.draft("corpus", "q")).toMatchObject({ sufficiency: "SUFFICIENT" })
    expect(await model.verify("q", "x", [])).toMatchObject({ claims: [] })
  })

  // A fixture with no verification means the captured run abstained before the
  // second call. Replaying a verify that never happened would invent evidence —
  // fail loudly instead of returning something plausible.
  test("throws rather than inventing a verification that was never captured", async () => {
    const model = fixtureModel({
      draft: { sufficiency: "INSUFFICIENT", answer: null, citations: [], reasoning: "r" },
      verification: null,
    })

    await expect(model.verify("q", "x", [])).rejects.toThrow(/no captured verification/i)
  })
})

describe("recordingModel", () => {
  test("records verification as null when the inner model never verified", async () => {
    const { model, recorded } = recordingModel({
      draft: async () => ({ sufficiency: "INSUFFICIENT", answer: null, citations: [], reasoning: "r" }),
      verify: async () => ({ claims: [] }),
    })

    await model.draft("corpus", "q")

    expect(recorded().draft).toMatchObject({ sufficiency: "INSUFFICIENT" })
    expect(recorded().verification).toBeNull()
  })

  test("records both payloads when the inner model verified", async () => {
    const { model, recorded } = recordingModel({
      draft: async () => ({ sufficiency: "SUFFICIENT", answer: "x", citations: [], reasoning: "r" }),
      verify: async () => ({ claims: [{ claim: "c", essential: true, supported: true, sourceText: "x" }] }),
    })

    await model.draft("corpus", "q")
    await model.verify("q", "x", [])

    expect(recorded().verification).toMatchObject({ claims: expect.any(Array) })
  })
})
