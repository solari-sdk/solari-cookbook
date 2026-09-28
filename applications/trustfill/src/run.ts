import { answerQuestion, type Answer, type Model } from "./pipeline.js"

export interface QuestionSpec {
  id: string
  text: string
}

export interface RunRequest {
  questions: QuestionSpec[]
  corpus: string
  /** A model per question — lets capture wrap each one in its own recorder. */
  modelFor: (q: QuestionSpec) => Model
  concurrency?: number
}

export interface QuestionResult {
  id: string
  answer: Answer | null
  error: string | null
}

export async function runQuestionnaire({
  questions,
  corpus,
  modelFor,
  concurrency = 8,
}: RunRequest): Promise<QuestionResult[]> {
  const results: QuestionResult[] = new Array(questions.length)
  let next = 0

  // A worker pool rather than Promise.all: 30 simultaneous calls will trip
  // provider rate limits, and a 429 storm looks exactly like a broken product.
  const worker = async () => {
    for (;;) {
      const i = next++
      const q = questions[i]
      if (!q) return
      try {
        results[i] = { id: q.id, answer: await answerQuestion({ question: q.text, corpus, model: modelFor(q) }), error: null }
      } catch (err) {
        // One bad question must not lose the rest — the run's value is the whole
        // 26/4 split, not the first failure.
        results[i] = { id: q.id, answer: null, error: (err as Error).message }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, worker))
  return results
}
