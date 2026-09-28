export type Sufficiency = "SUFFICIENT" | "INSUFFICIENT" | "CONFLICTING" | "OUT_OF_SCOPE"

export interface Claim {
  claim: string
  essential: boolean
  supported: boolean
}

export interface ScoreInput {
  sufficiency: Sufficiency
  claims: Claim[]
}

export interface ScoreResult {
  abstained: boolean
  /** supported / total. Null when there are no claims — absence of evidence, not a zero. */
  trustScore: number | null
}

export function score(input: ScoreInput): ScoreResult {
  const unsupportedEssential = input.claims.filter((c) => c.essential && !c.supported)
  // The sufficiency arm is unreachable via `answerQuestion`: DraftSchema forbids
  // a non-null answer unless sufficiency is SUFFICIENT, and the pipeline returns
  // early on a null answer. Kept as defence in depth for direct callers — and
  // covered by unit tests rather than by the replayed questionnaire, which is
  // why a mutation here does not fail the acceptance suite.
  const abstained = input.sufficiency !== "SUFFICIENT" || unsupportedEssential.length > 0
  const trustScore = input.claims.length
    ? input.claims.filter((c) => c.supported).length / input.claims.length
    : null
  return { abstained, trustScore }
}
