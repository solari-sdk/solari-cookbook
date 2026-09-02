import { randomBytes } from "node:crypto";
import path from "node:path";
import type {
  Candidate,
  CandidateResult,
  CliOptions,
  MergeLabConfig,
  MergeLabReport,
  PullRequestRef,
} from "./types.js";
import type { GitHubRepo } from "./github.js";
import { classifyOutcome } from "./analyze.js";
import { explainFinding } from "./ai.js";
import {
  cleanupWorker,
  ensureOutputDir,
  makeClient,
  prepareGitState,
  provisionWorker,
  runBrowserVerification,
  runChecks,
  runInstall,
  type Worker,
  type WorkerContext,
  writeArtifact,
} from "./solari.js";

export type OrchestratorContext = {
  repo: GitHubRepo;
  prs: PullRequestRef[];
  baseSha: string;
  baseBranch: string;
  config: MergeLabConfig;
  options: CliOptions;
};

export async function runOrchestrator(ctx: OrchestratorContext): Promise<MergeLabReport> {
  const runId = `ml_${randomBytes(6).toString("hex")}`;
  const outputDir = path.resolve(ctx.options.output, runId);
  await ensureOutputDir(outputDir);

  const candidates = ctx.options.mode === "selected" && ctx.options.combination
    ? [parseCombination(ctx.options.combination)]
    : ctx.options.prs.length === 2
      ? [
          { id: String(ctx.options.prs[0]), prs: [ctx.options.prs[0]], applicationOrder: [ctx.options.prs[0]] },
          { id: String(ctx.options.prs[1]), prs: [ctx.options.prs[1]], applicationOrder: [ctx.options.prs[1]] },
          { id: `${ctx.options.prs[0]}+${ctx.options.prs[1]}`, prs: ctx.options.prs, applicationOrder: ctx.options.prs.sort((a, b) => a - b) },
        ]
      : generatePairwise(ctx.options.prs);

  const startedAt = new Date().toISOString();
  const client = makeClient();

  const results: CandidateResult[] = [];
  let cleanupComplete = true;

  // Simple bounded worker pool.
  const queue = [...candidates];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < ctx.options.concurrency; i++) {
    workers.push(workerLoop(queue, ctx, client, outputDir, runId, results, ctx.options.keepSandboxes));
  }
  await Promise.all(workers);

  // Classify outcomes now that all commands are complete.
  for (const result of results) {
    const install = result.commands.find((c) => c.name === "install");
    const checks = result.commands.filter((c) => c.name !== "install");
    result.outcome = classifyOutcome(result.mergeConflicts, install, checks, result.browser);
  }

  // AI explanation for findings.
  const individualResults = results.filter((r) => r.candidate.prs.length === 1);
  const combinedResults = results.filter((r) => r.candidate.prs.length > 1);

  const { findCrossPrRegressions, recommendMergeOrder } = await import("./analyze.js");
  const findings = findCrossPrRegressions(individualResults, combinedResults);

  for (const finding of findings) {
    if (ctx.options.ai) {
      finding.explanation = await explainFinding(finding, results, ctx.prs, true);
    }
  }

  const recommendedMergeOrder = recommendMergeOrder(ctx.prs, findings);

  cleanupComplete = results.every((r) => r.cleanupStatus === "complete");

  const report: MergeLabReport = {
    schemaVersion: 1,
    runId,
    repository: `${ctx.repo.owner}/${ctx.repo.name}`,
    baseSha: ctx.baseSha,
    pullRequests: ctx.prs,
    candidates: results,
    findings,
    recommendedMergeOrder,
    startedAt,
    completedAt: new Date().toISOString(),
    cleanupComplete,
  };

  return report;
}

function parseCombination(input: string): Candidate {
  const prs = input
    .split("+")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return {
    id: prs.sort((a, b) => a - b).join("+"),
    prs,
    applicationOrder: [...prs].sort((a, b) => a - b),
  };
}

function generatePairwise(prs: number[]): Candidate[] {
  const sorted = [...prs].sort((a, b) => a - b);
  const out: Candidate[] = sorted.map((n) => ({
    id: String(n),
    prs: [n],
    applicationOrder: [n],
  }));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const pair = [sorted[i], sorted[j]];
      out.push({
        id: pair.join("+"),
        prs: pair,
        applicationOrder: pair,
      });
    }
  }
  return out;
}

async function workerLoop(
  queue: Candidate[],
  ctx: OrchestratorContext,
  client: ReturnType<typeof makeClient>,
  outputDir: string,
  runId: string,
  results: CandidateResult[],
  keepSandboxes: boolean,
): Promise<void> {
  while (true) {
    const candidate = queue.shift();
    if (!candidate) return;

    let worker: Worker | undefined;
    const startedAt = new Date().toISOString();
    const candidateResult: CandidateResult = {
      candidate,
      sandboxId: "",
      outcome: "infrastructure_failure",
      mergeConflicts: [],
      commands: [],
      artifacts: [],
      cleanupStatus: "incomplete",
      startedAt,
      completedAt: startedAt,
    };

    try {
      worker = await provisionWorker(client, candidate);
      candidateResult.sandboxId = worker.sandboxId;

      const workerCtx: WorkerContext = {
        repoUrl: ctx.repo.url,
        baseSha: ctx.baseSha,
        prs: ctx.prs,
        config: ctx.config,
        outputDir,
        runId,
        keepSandboxes,
      };

      const { treeSha, mergeConflicts } = await prepareGitState(worker, workerCtx);
      candidateResult.treeSha = treeSha;
      candidateResult.mergeConflicts = mergeConflicts;

      // Install dependencies.
      const installResult = await runInstall(worker, ctx.config);
      candidateResult.commands.push(installResult);

      // Run configured checks if install succeeded.
      if (installResult.status === "passed") {
        const checkResults = await runChecks(worker, ctx.config);
        candidateResult.commands.push(...checkResults);
      }

      // Run browser verification only when install and all required checks passed.
      const installPassed = candidateResult.commands.find((c) => c.name === "install")?.status === "passed";
      const allChecksPassed = candidateResult.commands
        .filter((c) => c.name !== "install")
        .every((c) => c.status === "passed");
      if (installPassed && allChecksPassed && (ctx.config.browser?.enabled ?? false)) {
        candidateResult.browser = await runBrowserVerification(worker, workerCtx);
      }

      // Save candidate logs as artifacts.
      const logContent = candidateResult.commands
        .map((c) => `=== ${c.name} ===\nexit:${c.exitCode} status:${c.status}\nSTDOUT:\n${c.stdout}\nSTDERR:\n${c.stderr}`)
        .join("\n\n");
      const logArtifact = await writeArtifact(outputDir, candidate.id, "log", "validation.log", logContent);
      candidateResult.artifacts.push(logArtifact);
    } catch (err) {
      candidateResult.outcome = "infrastructure_failure";
      candidateResult.commands.push({
        name: "orchestrator",
        command: "",
        status: "failed",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
    } finally {
      candidateResult.completedAt = new Date().toISOString();
      if (worker) {
        candidateResult.cleanupStatus = await cleanupWorker(worker, keepSandboxes);
      }
      results.push(candidateResult);
    }
  }
}
