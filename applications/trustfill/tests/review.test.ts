import { describe, expect, test } from "vitest"
import { buildReviewPacket } from "../src/review.js"
import type { FillEntry } from "../src/fill-plan.js"

const questions = [
  { id: "Q01", text: "Is data encrypted at rest?" },
  { id: "T2", text: "How frequently do you commission third-party penetration testing?" },
]

const filled: FillEntry = {
  questionId: "Q01",
  action: "FILL",
  value: "Encrypted with AES-256.",
  reason: "1 citation(s)",
  trustScore: 0.8,
}

const blank: FillEntry = {
  questionId: "T2",
  action: "LEAVE_BLANK",
  value: null,
  reason: "INSUFFICIENT — the evidence does not answer this question",
  trustScore: null,
}

const audit = { portalUrl: "https://portal.example", sessionId: "sess-1", replayUrl: null }

describe("buildReviewPacket", () => {
  test("routes blanks to the review queue with the question text a human needs", () => {
    const packet = buildReviewPacket({ questions, plan: [filled, blank], audit })

    expect(packet.needsReview).toHaveLength(1)
    expect(packet.needsReview[0]).toMatchObject({
      questionId: "T2",
      questionText: "How frequently do you commission third-party penetration testing?",
    })
    expect(packet.needsReview[0]?.reason).toMatch(/INSUFFICIENT/)
  })

  test("counts what was answered and what was not", () => {
    const packet = buildReviewPacket({ questions, plan: [filled, blank], audit })

    expect(packet.summary).toMatchObject({ total: 2, answered: 1, needsReview: 1 })
  })

  // A trust score below 1 means part of the drafted answer was dropped. The
  // reviewer should see which answers were edited, not just that they exist.
  test("flags answers whose trust score is below 1 for a closer look", () => {
    const packet = buildReviewPacket({ questions, plan: [filled, blank], audit })

    expect(packet.answered[0]).toMatchObject({ questionId: "Q01", trustScore: 0.8, edited: true })
  })

  test("does not flag a fully supported answer as edited", () => {
    const packet = buildReviewPacket({
      questions,
      plan: [{ ...filled, trustScore: 1 }, blank],
      audit,
    })

    expect(packet.answered[0]?.edited).toBe(false)
  })

  // Replay is an enhancement. A missing replay URL must never look like a failure
  // or block the packet from being produced.
  test("produces a packet even when no replay URL is available", () => {
    const packet = buildReviewPacket({ questions, plan: [filled, blank], audit })

    expect(packet.audit.replayUrl).toBeNull()
    expect(packet.audit.replayNote).toMatch(/not available/i)
  })

  test("carries the replay URL through when there is one", () => {
    const packet = buildReviewPacket({
      questions,
      plan: [filled, blank],
      audit: { ...audit, replayUrl: "https://replay.example/abc" },
    })

    expect(packet.audit.replayUrl).toBe("https://replay.example/abc")
  })
})
