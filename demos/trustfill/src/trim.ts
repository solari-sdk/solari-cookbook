import type { Claim } from "./scoring.js"

/** A claim plus the exact substring of the drafted answer it was taken from. */
export interface LocatedClaim extends Claim {
  sourceText: string
}

export interface TrimResult {
  text: string
  /** Claims actually cut — shown to the reviewer as the reason for the edit. */
  removed: string[]
  /** Claims we meant to cut but whose span wasn't in the answer. Never silent. */
  unlocatable: string[]
}

export function trim(answer: string, claims: LocatedClaim[]): TrimResult {
  const removable = claims.filter((c) => !c.essential && !c.supported)
  const removed: string[] = []
  const unlocatable: string[] = []

  let text = answer
  for (const c of removable) {
    if (!text.includes(c.sourceText)) {
      unlocatable.push(c.claim)
      continue
    }
    text = text.replace(c.sourceText, "")
    removed.push(c.claim)
  }

  return { text, removed, unlocatable }
}
