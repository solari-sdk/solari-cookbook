import { describe, it, expect } from "vitest";
import { classifyOutcome, findCrossPrRegressions, recommendMergeOrder } from "../src/analyze.js";
import type { CandidateResult, CommandResult, PullRequestRef } from "../src/types.js";

function cmd(name: string, status: CommandResult["status"]): CommandResult {
  return {
    name,
    command: name,
    status,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 100,
    stdout: "",
    stderr: "",
  };
}

function result(prs: number[], outcome: CandidateResult["outcome"], commands: CommandResult[]): CandidateResult {
  return {
    candidate: { id: prs.join("+"), prs, applicationOrder: prs },
    sandboxId: "sandbox",
    outcome,
    mergeConflicts: [],
    commands,
    artifacts: [],
    cleanupStatus: "complete",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

describe("classifyOutcome", () => {
  it("returns compatible when all checks pass", () => {
    expect(
      classifyOutcome([], cmd("install", "passed"), [cmd("tests", "passed")], { status: "passed" }),
    ).toBe("compatible");
  });

  it("detects install failure", () => {
    expect(classifyOutcome([], cmd("install", "failed"), [], undefined)).toBe("install_failure");
  });

  it("detects test failure", () => {
    expect(classifyOutcome([], cmd("install", "passed"), [cmd("tests", "failed")], undefined)).toBe("test_failure");
  });

  it("detects browser failure", () => {
    expect(
      classifyOutcome([], cmd("install", "passed"), [cmd("tests", "passed")], { status: "failed" }),
    ).toBe("browser_failure");
  });
});

describe("findCrossPrRegressions", () => {
  it("flags cross-PR regression when combined fails and individuals pass", () => {
    const individual = [
      result([21], "compatible", [cmd("install", "passed"), cmd("tests", "passed")]),
      result([22], "compatible", [cmd("install", "passed"), cmd("tests", "passed")]),
    ];
    const combined = [result([21, 22], "browser_failure", [cmd("install", "passed"), cmd("tests", "passed")])];
    const findings = findCrossPrRegressions(individual, combined);
    expect(findings[0].type).toBe("cross_pr_regression");
  });

  it("flags pre-existing failure when a constituent fails alone", () => {
    const individual = [
      result([21], "test_failure", [cmd("install", "passed"), cmd("tests", "failed")]),
      result([22], "compatible", [cmd("install", "passed"), cmd("tests", "passed")]),
    ];
    const combined = [result([21, 22], "test_failure", [cmd("install", "passed"), cmd("tests", "failed")])];
    const findings = findCrossPrRegressions(individual, combined);
    expect(findings[0].type).toBe("pre_existing_pr_failure");
  });
});

describe("recommendMergeOrder", () => {
  it("puts risky PRs last", () => {
    const prs: PullRequestRef[] = [
      { number: 21, title: "A", url: "", baseBranch: "main", baseSha: "a", headSha: "a1", changedFiles: [] },
      { number: 22, title: "B", url: "", baseBranch: "main", baseSha: "a", headSha: "b1", changedFiles: [] },
      { number: 23, title: "C", url: "", baseBranch: "main", baseSha: "a", headSha: "c1", changedFiles: [] },
    ];
    const findings = [{ type: "cross_pr_regression" as const, prs: [21, 22], failingStage: "browser", evidenceIds: [] }];
    expect(recommendMergeOrder(prs, findings)).toEqual([23, 21, 22]);
  });
});
