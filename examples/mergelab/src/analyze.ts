import type {
  CandidateOutcome,
  CandidateResult,
  CommandResult,
  Finding,
  PullRequestRef,
} from "./types.js";

export function classifyOutcome(
  mergeConflicts: string[],
  installResult: CommandResult | undefined,
  checkResults: CommandResult[],
  browserResult: { status: string } | undefined,
): CandidateOutcome {
  if (mergeConflicts.length > 0) {
    return "git_conflict";
  }

  if (installResult && installResult.status !== "passed") {
    return installResult.status === "timed_out" ? "timeout" : "install_failure";
  }

  for (const check of checkResults) {
    if (check.status === "passed") continue;

    if (check.status === "timed_out") return "timeout";

    const name = check.name.toLowerCase();
    if (name.includes("type")) return "static_failure";
    if (name.includes("test")) return "test_failure";
    if (name.includes("build")) return "build_failure";
    if (name.includes("lint")) return "static_failure";
    return "runtime_failure";
  }

  if (browserResult && browserResult.status !== "passed" && browserResult.status !== "skipped") {
    return "browser_failure";
  }

  return "compatible";
}

export function determineFailingStage(result: CandidateResult): string {
  if (result.mergeConflicts.length > 0) return "git_merge";
  const install = result.commands.find((c) => c.name === "install");
  if (install && install.status !== "passed") return `install:${install.name}`;
  for (const cmd of result.commands) {
    if (cmd.status !== "passed") return `check:${cmd.name}`;
  }
  if (result.browser && result.browser.status !== "passed" && result.browser.status !== "skipped") {
    return "browser";
  }
  return "none";
}

export function findCrossPrRegressions(
  individualResults: CandidateResult[],
  combinedResults: CandidateResult[],
): Finding[] {
  const findings: Finding[] = [];
  const individualMap = new Map(individualResults.map((r) => [r.candidate.id, r]));

  for (const combined of combinedResults) {
    if (combined.candidate.prs.length < 2) continue;

    const constituents = combined.candidate.prs.map((n) => String(n));
    const individualOutcomes = constituents.map((id) => individualMap.get(id));

    // If any constituent PR fails individually, it is a pre-existing failure.
    const anyPreExisting = individualOutcomes.some(
      (r) => !r || r.outcome !== "compatible",
    );

    if (combined.outcome === "compatible") {
      if (anyPreExisting) {
        findings.push({
          type: "pre_existing_pr_failure",
          prs: combined.candidate.prs,
          failingStage: determineFailingStage(combined),
          evidenceIds: [combined.candidate.id, ...constituents],
        });
      }
      continue;
    }

    if (anyPreExisting) {
      findings.push({
        type: "pre_existing_pr_failure",
        prs: combined.candidate.prs,
        failingStage: determineFailingStage(combined),
        evidenceIds: [combined.candidate.id, ...constituents],
      });
      continue;
    }

    // Combined fails, individuals pass => cross-PR regression.
    findings.push({
      type: "cross_pr_regression",
      prs: combined.candidate.prs,
      failingStage: determineFailingStage(combined),
      evidenceIds: [combined.candidate.id, ...constituents],
    });
  }

  return findings;
}

export function recommendMergeOrder(
  prs: PullRequestRef[],
  findings: Finding[],
): number[] {
  // Prefer ordering compatible PRs first, then PRs involved in cross-PR regressions last.
  const involved = new Set<number>();
  for (const f of findings) {
    if (f.type === "cross_pr_regression") {
      for (const n of f.prs) involved.add(n);
    }
  }

  const safe = prs.filter((p) => !involved.has(p.number)).map((p) => p.number);
  const risky = prs.filter((p) => involved.has(p.number)).map((p) => p.number);

  // For pairwise regressions, sort risky PRs by number to keep deterministic order.
  return [...safe.sort((a, b) => a - b), ...risky.sort((a, b) => a - b)];
}
