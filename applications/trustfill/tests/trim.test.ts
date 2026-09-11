import { describe, expect, test } from "vitest"
import { trim } from "../src/trim.js"

// M0 produced answers scoring 0.71 because the model volunteered a document
// version number it had not cited. Silently scoring that down is worse than
// removing it and saying so: "we removed this because it wasn't in your evidence".
describe("trim", () => {
  test("removes the span behind an unsupported incidental claim", () => {
    const answer =
      "Meridian maintains a documented incident response plan (version 3.1, last reviewed January 2026). The document owner is the VP Engineering & Security."

    const result = trim(answer, [
      {
        claim: "Meridian maintains a documented incident response plan.",
        essential: true,
        supported: true,
        sourceText: "Meridian maintains a documented incident response plan",
      },
      {
        claim: "The plan is version 3.1, last reviewed January 2026.",
        essential: false,
        supported: false,
        sourceText: " (version 3.1, last reviewed January 2026)",
      },
      {
        claim: "The document owner is the VP Engineering & Security.",
        essential: true,
        supported: true,
        sourceText: "The document owner is the VP Engineering & Security.",
      },
    ])

    expect(result.text).toBe(
      "Meridian maintains a documented incident response plan. The document owner is the VP Engineering & Security.",
    )
  })

  test("reports what it removed so the reason can be shown to a reviewer", () => {
    const result = trim("Coverage is broad and the plan is version 3.1.", [
      {
        claim: "Coverage is broad.",
        essential: true,
        supported: true,
        sourceText: "Coverage is broad",
      },
      {
        claim: "The plan is version 3.1.",
        essential: false,
        supported: false,
        sourceText: " and the plan is version 3.1",
      },
    ])

    expect(result.removed).toEqual(["The plan is version 3.1."])
  })

  // A sourceText the verifier hallucinated must not silently no-op. If we cannot
  // locate the span we cannot honestly claim the answer was cleaned.
  test("flags claims whose span could not be located in the answer", () => {
    const result = trim("Coverage is broad.", [
      {
        claim: "The plan is version 3.1.",
        essential: false,
        supported: false,
        sourceText: "text that is not in the answer",
      },
    ])

    expect(result.unlocatable).toEqual(["The plan is version 3.1."])
    expect(result.text).toBe("Coverage is broad.")
  })
})
