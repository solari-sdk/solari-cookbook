import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCli } from "./cli.js";
import { fetchPullRequest, parseGitHubUrl, validatePullRequests } from "./github.js";
import { validateConfig } from "./validate.js";
import { runOrchestrator } from "./orchestrator.js";
import { writeHtmlReport, writeResultJson } from "./report.js";
import type { MergeLabConfig } from "./types.js";

async function main(): Promise<void> {
  const options = parseCli(process.argv);

  const rawConfig = await readFile(options.config, "utf-8");
  const config = validateConfig(JSON.parse(rawConfig) as unknown) as MergeLabConfig;

  const repo = parseGitHubUrl(options.repo);
  console.log(`MergeLab — Integration Risk Simulator`);
  console.log(`Repository   ${repo.owner}/${repo.name}`);

  const prs = [];
  for (const number of options.prs) {
    const pr = await fetchPullRequest(repo, number);
    prs.push(pr);
    console.log(`Fetched PR #${pr.number}: ${pr.title}`);
  }

  const { baseBranch, baseSha } = validatePullRequests(prs, options.baseSha);
  console.log(`Base         ${baseSha.slice(0, 12)} (${baseBranch})`);
  console.log(`PRs          ${prs.map((p) => `#${p.number}`).join(", ")}`);
  console.log(`Output       ${options.output}`);

  const report = await runOrchestrator({
    repo,
    prs,
    baseSha,
    baseBranch,
    config,
    options,
  });

  const outputDir = path.resolve(options.output, report.runId);
  await writeResultJson(outputDir, report);
  if (options.html) {
    await writeHtmlReport(outputDir, report);
  }

  console.log("\nResults:");
  for (const c of report.candidates) {
    const symbol = c.outcome === "compatible" ? "✓" : "✗";
    const label = c.candidate.prs.map((n) => `PR #${n}`).join(" + ");
    console.log(`${symbol} ${label.padEnd(20)} ${c.outcome}`);
  }

  if (report.findings.length > 0) {
    console.log("\nFindings:");
    for (const f of report.findings) {
      console.log(`- ${f.type}: PRs ${f.prs.join(", ")} at ${f.failingStage}`);
    }
  }

  if (report.recommendedMergeOrder) {
    console.log(`\nRecommended: ${report.recommendedMergeOrder.map((n) => `#${n}`).join(" → ")}`);
  }

  console.log(`\nReport: ${outputDir}/result.json`);
  if (options.html) {
    console.log(`HTML:   ${outputDir}/index.html`);
  }

  const hasFailure = report.candidates.some((c) => c.outcome !== "compatible");
  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
