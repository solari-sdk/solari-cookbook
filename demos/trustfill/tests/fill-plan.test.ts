import { describe, expect, test } from "vitest"
import { buildFillPlan } from "../src/fill-plan.js"
import type { QuestionResult } from "../src/run.js"

const answered = (id: string, text: string): QuestionResult => ({
  id,
  error: null,
  answer: {
    question: "q",
    sufficiency: "SUFFICIENT",
    abstained: false,
    answer: text,
    trustScore: 1,
    citations: [{ document: "d.md", quote: "q" }],
    claims: [],
    removed: [],
    reasoning: "r",
  },
})

const abstained = (id: string, sufficiency: "INSUFFICIENT" | "CONFLICTING" | "OUT_OF_SCOPE"): QuestionResult => ({
  id,
  error: null,
  answer: {
    question: "q",
    sufficiency,
    abstained: true,
    answer: null,
    trustScore: null,
    citations: [],
    claims: [],
    removed: [],
    reasoning: "no supporting evidence",
  },
})

describe("buildFillPlan", () => {
  test("fills an answered question with its trimmed text", () => {
    const [entry] = buildFillPlan([answered("Q01", "Encrypted with AES-256.")])

    expect(entry).toMatchObject({ questionId: "Q01", action: "FILL", value: "Encrypted with AES-256." })
  })

  // The whole product is that these stay empty. Filling them with "unknown" or
  // "N/A" would put an unsupported claim in front of a customer's reviewer.
  test("leaves an abstained question blank and records why", () => {
    const [entry] = buildFillPlan([abstained("T2", "INSUFFICIENT")])

    expect(entry).toMatchObject({ questionId: "T2", action: "LEAVE_BLANK", value: null })
    expect(entry?.reason).toMatch(/INSUFFICIENT/)
  })

  test("distinguishes the reason for each kind of abstention", () => {
    const plan = buildFillPlan([
      abstained("T2", "INSUFFICIENT"),
      abstained("T3", "CONFLICTING"),
      abstained("T4", "OUT_OF_SCOPE"),
    ])

    expect(new Set(plan.map((e) => e.reason)).size).toBe(3)
  })

  // A question whose run errored is NOT a question we know the answer to.
  // Treating a crash as "no evidence" would be a lie of a different kind.
  test("leaves an errored question blank and says it failed rather than abstained", () => {
    const [entry] = buildFillPlan([{ id: "Q09", answer: null, error: "provider exploded" }])

    expect(entry).toMatchObject({ questionId: "Q09", action: "LEAVE_BLANK" })
    expect(entry?.reason).toMatch(/error/i)
    expect(entry?.reason).not.toMatch(/INSUFFICIENT/)
  })

  test("covers every question exactly once, in order", () => {
    const plan = buildFillPlan([answered("Q01", "a"), abstained("T1", "INSUFFICIENT"), answered("Q02", "b")])

    expect(plan.map((e) => e.questionId)).toEqual(["Q01", "T1", "Q02"])
  })
})
