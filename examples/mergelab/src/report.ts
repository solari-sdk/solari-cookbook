import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { MergeLabReport } from "./types.js";

export async function writeResultJson(
  outputDir: string,
  report: MergeLabReport,
): Promise<string> {
  const filePath = path.join(outputDir, "result.json");
  await writeFile(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

export async function writeHtmlReport(
  outputDir: string,
  report: MergeLabReport,
): Promise<string> {
  const filePath = path.join(outputDir, "index.html");
  const html = renderHtml(report);
  await writeFile(filePath, html);
  return filePath;
}

function renderHtml(report: MergeLabReport): string {
  const rows = report.candidates
    .map((c) => {
      const prs = c.candidate.prs.map((n) => `#${n}`).join(" + ");
      const outcomeClass =
        c.outcome === "compatible"
          ? "pass"
          : ["pre_existing_pr_failure", "inconclusive"].includes(c.outcome)
            ? "warn"
            : "fail";
      return `
        <tr class="${outcomeClass}">
          <td>${prs}</td>
          <td>${c.outcome}</td>
          <td>${c.commands.map((cmd) => `${cmd.name}: ${cmd.status}`).join("<br>")}</td>
          <td>${c.browser ? c.browser.status : "skipped"}</td>
          <td>${c.treeSha ? c.treeSha.slice(0, 12) : "N/A"}</td>
        </tr>
      `;
    })
    .join("");

  const findings = report.findings
    .map((f) => {
      const explanation = f.explanation
        ? `
          <p><strong>Summary:</strong> ${escapeHtml(f.explanation.summary)}</p>
          <p><strong>Likely path:</strong> ${escapeHtml(f.explanation.likelyIncompatiblePath)}</p>
          <p><strong>Confidence:</strong> ${f.explanation.confidence}</p>
          <p><strong>Suggested remediation:</strong> ${escapeHtml(f.explanation.suggestedRemediation)}</p>
        `
        : "";
      return `
        <div class="finding">
          <h3>${f.type} — PRs ${f.prs.map((n) => `#${n}`).join(", ")}</h3>
          <p><strong>Failing stage:</strong> ${f.failingStage}</p>
          <p><strong>Evidence:</strong> ${f.evidenceIds.join(", ")}</p>
          ${explanation}
        </div>
      `;
    })
    .join("");

  const prs = report.pullRequests
    .map((p) => {
      return `
        <li>
          <a href="${p.url}" target="_blank">PR #${p.number}</a> — ${escapeHtml(p.title)}<br>
          Head: <code>${p.headSha.slice(0, 12)}</code>, Base: <code>${p.baseSha.slice(0, 12)}</code>
        </li>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MergeLab Report — ${report.repository}</title>
  <style>
    :root { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; }
    body { max-width: 960px; margin: 0 auto; padding: 2rem; color: #1f2937; }
    h1, h2 { border-bottom: 1px solid #e5e7eb; padding-bottom: .5rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { text-align: left; padding: .75rem; border: 1px solid #e5e7eb; }
    th { background: #f9fafb; }
    tr.pass { background: #ecfdf5; }
    tr.fail { background: #fef2f2; }
    tr.warn { background: #fffbeb; }
    .finding { border: 1px solid #e5e7eb; border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
    code { background: #f3f4f6; padding: .125rem .25rem; border-radius: .25rem; }
    .metadata { color: #6b7280; }
  </style>
</head>
<body>
  <h1>MergeLab — Integration Risk Report</h1>
  <p class="metadata">
    Repository: <strong>${report.repository}</strong><br>
    Base SHA: <code>${report.baseSha}</code><br>
    Run ID: <code>${report.runId}</code><br>
    Started: ${report.startedAt}<br>
    Completed: ${report.completedAt}<br>
    Cleanup complete: ${report.cleanupComplete}
  </p>

  <h2>Compatibility Matrix</h2>
  <table>
    <thead>
      <tr>
        <th>Candidate</th>
        <th>Verdict</th>
        <th>Checks</th>
        <th>Browser</th>
        <th>Tree SHA</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <h2>Recommended Merge Order</h2>
  <p>${report.recommendedMergeOrder ? report.recommendedMergeOrder.map((n) => `#${n}`).join(" → ") : "N/A"}</p>

  <h2>Findings</h2>
  ${findings || "<p>No findings.</p>"}

  <h2>Pinned Pull Requests</h2>
  <ul>
    ${prs}
  </ul>

  <h2>Reproduction</h2>
  <pre><code>npm start -- --repo ${report.repository} --prs ${report.pullRequests.map((p) => p.number).join(",")} --config ./mergelab.config.json --base-sha ${report.baseSha}</code></pre>

  <p class="metadata">Report generated from <code>result.json</code>. Works locally without API keys.</p>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
