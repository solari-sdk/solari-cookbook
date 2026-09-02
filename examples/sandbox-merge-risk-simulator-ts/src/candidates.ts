import type { Candidate } from "./types.js";

export function candidateId(prs: number[]): string {
  return prs.sort((a, b) => a - b).join("+");
}

export function generateCandidates(
  prNumbers: number[],
  mode: "pairwise" | "selected",
  explicitCombination?: string,
): Candidate[] {
  if (mode === "selected") {
    if (!explicitCombination) {
      throw new Error("--combination is required when --mode=selected");
    }
    const prs = explicitCombination
      .split("+")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    if (prs.length === 0) {
      throw new Error(`Invalid --combination: ${explicitCombination}`);
    }
    return [
      {
        id: candidateId(prs),
        prs,
        applicationOrder: [...prs].sort((a, b) => a - b),
      },
    ];
  }

  const sorted = [...prNumbers].sort((a, b) => a - b);
  const candidates: Candidate[] = sorted.map((n) => ({
    id: String(n),
    prs: [n],
    applicationOrder: [n],
  }));

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const pair = [sorted[i], sorted[j]];
      candidates.push({
        id: candidateId(pair),
        prs: pair,
        applicationOrder: pair,
      });
    }
  }

  return candidates;
}
