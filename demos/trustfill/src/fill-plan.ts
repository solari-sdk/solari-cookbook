import type { QuestionResult } from "./run.js"

export interface FillEntry {
  questionId: string
  action: "FILL" | "LEAVE_BLANK"
  value: string | null
  reason: string
  trustScore: number | null
}

/** Why a question was left blank — distinct causes, never collapsed into "unknown". */
const BLANK_REASON: Record<string, string> = {
  INSUFFICIENT: "INSUFFICIENT — the evidence does not answer this question",
  CONFLICTING: "CONFLICTING — sources disagree; a human must resolve which is current",
  OUT_OF_SCOPE: "OUT_OF_SCOPE — asks for a commitment, not a fact; needs someone with authority",
}

export function buildFillPlan(results: QuestionResult[]): FillEntry[] {
  return results.map((r) => {
    // A crashed run is not the same as an absence of evidence. Reporting it as
    // an abstention would be a different lie from the one we are preventing.
    if (r.error || !r.answer) {
      return {
        questionId: r.id,
        action: "LEAVE_BLANK",
        value: null,
        reason: `error — the run failed: ${r.error ?? "no result"}`,
        trustScore: null,
      }
    }

    if (r.answer.abstained || r.answer.answer === null) {
      return {
        questionId: r.id,
        action: "LEAVE_BLANK",
        value: null,
        reason: BLANK_REASON[r.answer.sufficiency] ?? r.answer.sufficiency,
        trustScore: null,
      }
    }

    return {
      questionId: r.id,
      action: "FILL",
      value: r.answer.answer,
      reason: `${r.answer.citations.length} citation(s)`,
      trustScore: r.answer.trustScore,
    }
  })
}
