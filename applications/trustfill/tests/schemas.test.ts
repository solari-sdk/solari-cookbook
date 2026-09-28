import { describe, expect, test } from "vitest"
import { DraftSchema, VerificationSchema } from "../src/schemas.js"

const validDraft = {
  sufficiency: "SUFFICIENT",
  answer: "Customer data is encrypted at rest using AES-256.",
  citations: [{ document: "information-security-policy.md", quote: "encrypted using AES-256" }],
  reasoning: "Section 5 states the algorithm directly.",
}

describe("DraftSchema", () => {
  test("accepts a well-formed draft", () => {
    expect(() => DraftSchema.parse(validDraft)).not.toThrow()
  })

  // The core invariant. A model that classifies INSUFFICIENT and then supplies an
  // answer anyway has contradicted itself, and shipping that answer is exactly
  // the failure the whole product exists to prevent.
  test("rejects an answer supplied alongside a non-SUFFICIENT classification", () => {
    expect(() =>
      DraftSchema.parse({ ...validDraft, sufficiency: "INSUFFICIENT" }),
    ).toThrow(/abstain/i)
  })

  test("requires an answer when the classification is SUFFICIENT", () => {
    expect(() => DraftSchema.parse({ ...validDraft, answer: null })).toThrow(/answer/i)
  })
})

describe("VerificationSchema", () => {
  const claim = {
    claim: "Customer data is encrypted at rest using AES-256.",
    essential: true,
    supported: true,
    sourceText: "encrypted at rest using AES-256",
  }

  test("accepts a well-formed verification", () => {
    expect(() => VerificationSchema.parse({ claims: [claim] })).not.toThrow()
  })

  // Trimming locates spans by exact substring match. A blank sourceText would
  // match everywhere and silently corrupt the answer, so reject it at the edge.
  test("rejects a claim with an empty sourceText", () => {
    expect(() => VerificationSchema.parse({ claims: [{ ...claim, sourceText: "" }] })).toThrow()
  })
})
