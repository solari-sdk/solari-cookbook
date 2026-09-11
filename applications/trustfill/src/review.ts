import type { FillEntry } from "./fill-plan.js"

export interface ReviewPacket {
  summary: { total: number; answered: number; needsReview: number }
  needsReview: { questionId: string; questionText: string; reason: string }[]
  answered: { questionId: string; questionText: string; trustScore: number | null; edited: boolean }[]
  audit: { portalUrl: string; sessionId: string | null; replayUrl: string | null; replayNote: string }
}

export interface ReviewInput {
  questions: { id: string; text: string }[]
  plan: FillEntry[]
  audit: { portalUrl: string; sessionId: string | null; replayUrl: string | null }
}

export function buildReviewPacket({ questions, plan, audit }: ReviewInput): ReviewPacket {
  const textOf = new Map(questions.map((q) => [q.id, q.text]))

  const needsReview = plan
    .filter((e) => e.action === "LEAVE_BLANK")
    .map((e) => ({
      questionId: e.questionId,
      questionText: textOf.get(e.questionId) ?? e.questionId,
      reason: e.reason,
    }))

  const answered = plan
    .filter((e) => e.action === "FILL")
    .map((e) => ({
      questionId: e.questionId,
      questionText: textOf.get(e.questionId) ?? e.questionId,
      trustScore: e.trustScore,
      // Below 1 means part of the drafted answer was unsupported and removed.
      // The reviewer should know which answers were edited, not just that they exist.
      edited: e.trustScore !== null && e.trustScore < 1,
    }))

  return {
    summary: { total: plan.length, answered: answered.length, needsReview: needsReview.length },
    needsReview,
    answered,
    audit: {
      ...audit,
      // Replay is an enhancement. Its absence is a note, never a failure.
      replayNote: audit.replayUrl
        ? "Session replay available."
        : "Replay not available — it uploads asynchronously after the session is released.",
    },
  }
}
