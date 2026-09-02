import type { AnalysisResult, CandidateResult, Finding, PullRequestRef } from "./types.js";

export async function explainFinding(
  finding: Finding,
  results: CandidateResult[],
  prs: PullRequestRef[],
  useAi: boolean,
): Promise<AnalysisResult> {
  // Deterministic engine owns the verdict. This function narrates evidence only.
  const combined = results.find((r) => r.candidate.id === candidateId(finding.prs));
  const individual = finding.prs
    .map((n) => results.find((r) => r.candidate.id === String(n)))
    .filter(Boolean) as CandidateResult[];

  const prByNumber = new Map(prs.map((p) => [p.number, p]));

  if (finding.type === "pre_existing_pr_failure") {
    const failing = individual.find((r) => r.outcome !== "compatible");
    return {
      summary: `PR #${failing?.candidate.prs[0]} already fails independently before combining.`,
      evidenceReferences: [failing?.candidate.id ?? ""],
      likelyIncompatiblePath: "N/A — pre-existing failure",
      confidence: "high",
      recommendedMergeOrder: prs.map((p) => p.number).sort((a, b) => a - b),
      suggestedRemediation: `Fix the failing checks on PR #${failing?.candidate.prs[0]} first.`,
    };
  }

  if (finding.type === "cross_pr_regression") {
    const files = new Set<string>();
    for (const n of finding.prs) {
      const pr = prByNumber.get(n);
      if (pr) {
        for (const f of pr.changedFiles) files.add(f);
      }
    }

    const failingStage = finding.failingStage;
    const contractHint = Array.from(files).some((f) =>
      /api|route|schema|type|interface|contract/i.test(f),
    );

    let likelyPath = "unknown shared code path";
    if (contractHint) {
      likelyPath = "shared API contract or type definition";
    } else if (failingStage === "browser") {
      likelyPath = "browser journey depending on merged frontend + backend state";
    }

    const summary = `PRs ${finding.prs.map((n) => `#${n}`).join(" and ")} pass independently but fail together at ${failingStage}.`;

    if (useAi) {
      // Optional: call external AI here with the same evidence. For V0 we keep it deterministic.
    }

    return {
      summary,
      evidenceReferences: [combined?.candidate.id ?? "", ...individual.map((r) => r.candidate.id)],
      likelyIncompatiblePath: likelyPath,
      confidence: contractHint || failingStage === "browser" ? "high" : "medium",
      recommendedMergeOrder: [...finding.prs].sort((a, b) => a - b),
      suggestedRemediation: `Review the combined changes to ${Array.from(files).slice(0, 5).join(", ")} and add an integration test that exercises both PRs together.`,
    };
  }

  return {
    summary: "Unable to determine a confident explanation from available evidence.",
    evidenceReferences: [],
    likelyIncompatiblePath: "inconclusive",
    confidence: "low",
    recommendedMergeOrder: prs.map((p) => p.number).sort((a, b) => a - b),
    suggestedRemediation: "Inspect the candidate logs and add more granular checks or browser assertions.",
  };
}

function candidateId(prs: number[]): string {
  return prs.sort((a, b) => a - b).join("+");
}
