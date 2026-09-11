import type { Model } from "./pipeline.js"

export interface Fixture {
  draft: unknown
  /** Null when the captured run abstained and never reached the second call. */
  verification: unknown | null
}

export function fixtureModel(fixture: Fixture): Model {
  return {
    draft: async () => fixture.draft,
    verify: async () => {
      if (fixture.verification === null) {
        throw new Error("no captured verification: the recorded run abstained before verifying")
      }
      return fixture.verification
    },
  }
}

/**
 * Wraps a model and captures what passed through it, so `capture` exercises the
 * exact production path rather than a parallel one that could drift from it.
 */
export function recordingModel(inner: Model): { model: Model; recorded: () => Fixture } {
  let draft: unknown = null
  let verification: unknown | null = null

  return {
    model: {
      draft: async (corpus, question) => (draft = await inner.draft(corpus, question)),
      verify: async (question, answer, citations) =>
        (verification = await inner.verify(question, answer, citations)),
    },
    recorded: () => ({ draft, verification }),
  }
}
