import { describe, expect, test } from "vitest"
import { answerQuestion } from "../src/pipeline.js"
import type { Model } from "../src/pipeline.js"

const CORPUS = "irrelevant here — the model is injected"

/** A model that replays fixed payloads. Real shapes, no network. */
function fakeModel(draft: unknown, verification: unknown): Model {
  return {
    draft: async () => draft,
    verify: async () => verification,
  }
}

describe("answerQuestion", () => {
  test("returns a cited answer when every essential claim is supported", async () => {
    const model = fakeModel(
      {
        sufficiency: "SUFFICIENT",
        answer: "Customer data is encrypted at rest using AES-256.",
        citations: [{ document: "information-security-policy.md", quote: "encrypted using AES-256" }],
        reasoning: "Stated directly in section 5.",
      },
      {
        claims: [
          {
            claim: "Customer data is encrypted at rest using AES-256.",
            essential: true,
            supported: true,
            sourceText: "Customer data is encrypted at rest using AES-256.",
          },
        ],
      },
    )

    const result = await answerQuestion({ question: "Is data encrypted at rest?", corpus: CORPUS, model })

    expect(result.abstained).toBe(false)
    expect(result.answer).toBe("Customer data is encrypted at rest using AES-256.")
    expect(result.trustScore).toBe(1)
    expect(result.citations).toHaveLength(1)
  })

  test("abstains and returns no answer when an essential claim is unsupported", async () => {
    const model = fakeModel(
      {
        sufficiency: "SUFFICIENT",
        answer: "Penetration testing is conducted annually.",
        citations: [{ document: "soc2-scope-summary.md", quote: "penetration testing performed by an independent external security firm" }],
        reasoning: "Pen testing is described in the SOC 2 summary.",
      },
      {
        claims: [
          {
            claim: "Penetration testing is conducted annually.",
            essential: true,
            supported: false,
            sourceText: "Penetration testing is conducted annually.",
          },
        ],
      },
    )

    const result = await answerQuestion({ question: "How often do you pen test?", corpus: CORPUS, model })

    expect(result.abstained).toBe(true)
    expect(result.answer).toBeNull()
  })

  test("strips an unsupported incidental claim from the returned answer", async () => {
    const model = fakeModel(
      {
        sufficiency: "SUFFICIENT",
        answer: "Meridian maintains a documented incident response plan (version 3.1).",
        citations: [{ document: "incident-response-plan.md", quote: "This plan describes how Meridian Systems detects" }],
        reasoning: "The plan exists and is owned by the VP Engineering & Security.",
      },
      {
        claims: [
          {
            claim: "Meridian maintains a documented incident response plan.",
            essential: true,
            supported: true,
            sourceText: "Meridian maintains a documented incident response plan",
          },
          {
            claim: "The plan is version 3.1.",
            essential: false,
            supported: false,
            sourceText: " (version 3.1)",
          },
        ],
      },
    )

    const result = await answerQuestion({ question: "Do you have an IR plan?", corpus: CORPUS, model })

    expect(result.answer).toBe("Meridian maintains a documented incident response plan.")
    expect(result.removed).toEqual(["The plan is version 3.1."])
    expect(result.trustScore).toBe(0.5)
  })

  // Skipping the second call when the draft already abstained is a cost decision:
  // M0 measured minutes per call, and 4 of 30 questions never need verifying.
  test("does not call verify when the draft abstained", async () => {
    let verifyCalls = 0
    const model: Model = {
      draft: async () => ({
        sufficiency: "INSUFFICIENT",
        answer: null,
        citations: [],
        reasoning: "Cyber insurance is not mentioned anywhere in the corpus.",
      }),
      verify: async () => {
        verifyCalls++
        return { claims: [] }
      },
    }

    const result = await answerQuestion({ question: "Do you carry cyber insurance?", corpus: CORPUS, model })

    expect(result.abstained).toBe(true)
    expect(verifyCalls).toBe(0)
  })
})
