import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeHtmlReport, writeResultJson } from "../src/report.js";
import type { MergeLabReport } from "../src/types.js";

const report: MergeLabReport = {
  schemaVersion: 1,
  runId: "ml_sample001",
  repository: "example/mergelab-fixture",
  baseSha: "d98c10c4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  pullRequests: [
    {
      number: 21,
      title: "Change cart API response shape",
      url: "https://github.com/example/mergelab-fixture/pull/21",
      baseBranch: "main",
      baseSha: "d98c10c4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      headSha: "9cad7c4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      changedFiles: ["server.js", "src/main.js", "tests/server.test.js"],
    },
    {
      number: 22,
      title: "Add checkout UI",
      url: "https://github.com/example/mergelab-fixture/pull/22",
      baseBranch: "main",
      baseSha: "d98c10c4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      headSha: "1c250daa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      changedFiles: ["index.html", "src/checkout.js", "tests/checkout.test.js"],
    },
    {
      number: 23,
      title: "Add product filter",
      url: "https://github.com/example/mergelab-fixture/pull/23",
      baseBranch: "main",
      baseSha: "d98c10c4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      headSha: "4fc8315a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      changedFiles: ["src/filter.js", "tests/filter.test.js"],
    },
  ],
  candidates: [
    makeCandidate([21], "compatible"),
    makeCandidate([22], "compatible"),
    makeCandidate([23], "compatible"),
    makeCandidate([21, 22], "browser_failure", [
      {
        name: "browser",
        status: "failed",
        exitCode: null,
        durationMs: 12400,
        stdout: "",
        stderr: "Expected checkout to show 'Checkout items: 2', got: Checkout items: undefined",
      },
    ]),
    makeCandidate([21, 23], "compatible"),
    makeCandidate([22, 23], "compatible"),
  ],
  findings: [
    {
      type: "cross_pr_regression",
      prs: [21, 22],
      failingStage: "browser",
      evidenceIds: ["21+22", "21", "22"],
      explanation: {
        summary: "PR #21 changes the cart response contract while PR #22 reads the previous count field.",
        evidenceReferences: ["21+22", "21", "22"],
        likelyIncompatiblePath: "shared API contract or type definition",
        confidence: "high",
        recommendedMergeOrder: [21, 22],
        suggestedRemediation: "Update PR #22 to consume cart.itemCount and add an integration test that exercises both PRs together.",
      },
    },
  ],
  recommendedMergeOrder: [23, 21, 22],
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  completedAt: new Date().toISOString(),
  cleanupComplete: true,
};

function makeCandidate(
  prs: number[],
  outcome: MergeLabReport["candidates"][number]["outcome"],
  extraCommands: MergeLabReport["candidates"][number]["commands"] = [],
): MergeLabReport["candidates"][number] {
  const browser: MergeLabReport["candidates"][number]["browser"] =
    outcome === "browser_failure"
      ? {
          status: "failed" as const,
          durationMs: 12400,
          stdout: "",
          stderr: "Expected checkout to show 'Checkout items: 2', got: Checkout items: undefined",
          screenshotPaths: ["./artifacts/21+22/screenshot-21+22-failure.png"],
          consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'count')"],
          pageErrors: [],
        }
      : { status: "passed" as const, durationMs: 8200, stdout: "", stderr: "", screenshotPaths: [], consoleErrors: [], pageErrors: [] };

  return {
    candidate: { id: prs.join("+"), prs, applicationOrder: prs },
    sandboxId: `sandbox-${prs.join("-")}`,
    treeSha: `tree${prs.join("")}abc123`,
    outcome,
    mergeConflicts: [],
    commands: [
      { name: "install", command: "npm ci", status: "passed", exitCode: 0, durationMs: 15000, stdout: "", stderr: "" },
      { name: "typecheck", command: "npm run typecheck", status: "passed", exitCode: 0, durationMs: 3000, stdout: "", stderr: "" },
      { name: "tests", command: "npm test -- --runInBand", status: "passed", exitCode: 0, durationMs: 5000, stdout: "", stderr: "" },
      { name: "build", command: "npm run build", status: "passed", exitCode: 0, durationMs: 4000, stdout: "", stderr: "" },
      ...extraCommands,
    ],
    browser,
    artifacts: [],
    cleanupStatus: "complete",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date().toISOString(),
  };
}

async function main() {
  const outDir = path.resolve(process.cwd(), "proof", "sample-run");
  await mkdir(outDir, { recursive: true });
  await writeResultJson(outDir, report);
  await writeHtmlReport(outDir, report);
  await writeFile(path.join(outDir, "README.md"), "# Sample MergeLab proof\n\nThis is a sanitized, illustrative report generated from the expected fixture matrix. Run MergeLab against a published fixture to produce a real proof.\n");
  console.log(`Sample proof written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
