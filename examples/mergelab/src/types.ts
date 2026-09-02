/**
 * Core data types for MergeLab.
 *
 * These types are the canonical shape used across the engine, the JSON report,
 * and the static HTML viewer. Keep them serialization-friendly.
 */

export type PullRequestRef = {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
};

export type Candidate = {
  id: string;
  prs: number[];
  applicationOrder: number[];
};

export type CommandStatus = "passed" | "failed" | "timed_out" | "skipped";

export type CommandResult = {
  name: string;
  command: string;
  status: CommandStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type BrowserResult = {
  status: CommandStatus;
  durationMs: number;
  stdout: string;
  stderr: string;
  screenshotPaths: string[];
  tracePath?: string;
  consoleErrors: string[];
  pageErrors: string[];
};

export type ArtifactRef = {
  id: string;
  kind: "log" | "screenshot" | "trace" | "diff";
  path: string;
  candidateId: string;
};

export type CandidateOutcome =
  | "compatible"
  | "git_conflict"
  | "install_failure"
  | "static_failure"
  | "test_failure"
  | "build_failure"
  | "runtime_failure"
  | "browser_failure"
  | "timeout"
  | "infrastructure_failure";

export type CandidateResult = {
  candidate: Candidate;
  sandboxId: string;
  treeSha?: string;
  outcome: CandidateOutcome;
  mergeConflicts: string[];
  commands: CommandResult[];
  browser?: BrowserResult;
  artifacts: ArtifactRef[];
  cleanupStatus: "complete" | "incomplete" | "failed";
  startedAt: string;
  completedAt: string;
};

export type FindingType =
  | "cross_pr_regression"
  | "pre_existing_pr_failure"
  | "order_dependent_result"
  | "inconclusive";

export type AnalysisResult = {
  summary: string;
  evidenceReferences: string[];
  likelyIncompatiblePath: string;
  confidence: "high" | "medium" | "low";
  recommendedMergeOrder: number[];
  suggestedRemediation: string;
};

export type Finding = {
  type: FindingType;
  prs: number[];
  failingStage: string;
  evidenceIds: string[];
  explanation?: AnalysisResult;
};

export type MergeLabReport = {
  schemaVersion: 1;
  runId: string;
  repository: string;
  baseSha: string;
  pullRequests: PullRequestRef[];
  candidates: CandidateResult[];
  findings: Finding[];
  recommendedMergeOrder?: number[];
  startedAt: string;
  completedAt: string;
  cleanupComplete: boolean;
};

export type MergeLabConfig = {
  version: number;
  install: {
    command: string;
    timeoutMs: number;
  };
  checks: Array<{
    name: string;
    command: string;
    timeoutMs: number;
    required: boolean;
  }>;
  browser?: {
    enabled: boolean;
    startCommand: string;
    port: number;
    readyPath: string;
    readyTimeoutMs: number;
    testFile: string;
    viewport: { width: number; height: number };
  };
};

export type CliOptions = {
  repo: string;
  prs: number[];
  config: string;
  baseSha?: string;
  mode: "pairwise" | "selected";
  combination?: string;
  concurrency: number;
  output: string;
  keepSandboxes: boolean;
  ai: boolean;
};

export type GitHubRepo = {
  owner: string;
  name: string;
  url: string;
};
