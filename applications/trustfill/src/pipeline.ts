import { DraftSchema, VerificationSchema, type Citation } from "./schemas.js"
import { score, type Sufficiency } from "./scoring.js"
import { trim, type LocatedClaim } from "./trim.js"

/**
 * The model seam. Constructor-injected, no framework — tests replay fixtures,
 * production calls a provider. M0 showed a live pass takes ~40 minutes, so a
 * test suite that reaches the network is a test suite nobody runs.
 */
export interface Model {
  draft(corpus: string, question: string): Promise<unknown>
  verify(question: string, answer: string, citations: Citation[]): Promise<unknown>
}

export interface AnswerRequest {
  question: string
  corpus: string
  model: Model
}

export interface Answer {
  question: string
  sufficiency: Sufficiency
  abstained: boolean
  /** Trimmed final text. Null whenever we abstained. */
  answer: string | null
  trustScore: number | null
  citations: Citation[]
  claims: LocatedClaim[]
  removed: string[]
  reasoning: string
}

export async function answerQuestion({ question, corpus, model }: AnswerRequest): Promise<Answer> {
  const draft = DraftSchema.parse(await model.draft(corpus, question))

  const base = {
    question,
    sufficiency: draft.sufficiency,
    citations: draft.citations,
    reasoning: draft.reasoning,
  }

  // The schema guarantees answer is null unless SUFFICIENT, so there is nothing
  // to verify and no reason to spend a second call.
  if (draft.answer === null) {
    return { ...base, abstained: true, answer: null, trustScore: null, claims: [], removed: [] }
  }

  const { claims } = VerificationSchema.parse(
    await model.verify(question, draft.answer, draft.citations),
  )
  const { abstained, trustScore } = score({ sufficiency: draft.sufficiency, claims })
  const { text, removed } = trim(draft.answer, claims)

  return {
    ...base,
    abstained,
    answer: abstained ? null : text,
    trustScore,
    claims,
    removed,
  }
}
