/**
 * LifeOps Verification Dashboard Generator.
 *
 * Renders an independent, self-contained HTML verification report from the real
 * StatementPayload, historical baseline, AuditResult, and VerificationManifest.
 *
 * Design Principles:
 * - Credible engineering evidence: structured for FinOps/Security verification, not marketing.
 * - Zero external dependencies: no CDNs, no external web fonts, no external image assets.
 * - Complete data-driven dynamism: all numbers, tables, hashes, and statuses derive from artifacts.
 * - Explicit boundary disclaimer: clearly states that hashes provide tamper-evident integrity
 *   and do NOT certify the economic truthfulness of the originating third-party portal.
 */

import type {
  AuditResult,
  StatementLineItem,
  StatementPayload,
  VerificationManifest,
} from "./types.js";

/**
 * Escapes unsafe characters for secure HTML interpolation.
 */
export function escapeHtml(unsafe: string | number | undefined | null): string {
  if (unsafe === undefined || unsafe === null) return "";
  const str = String(unsafe);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Line item comparison row for the detailed comparison table.
 */
interface ComparisonRow {
  id: string;
  description: string;
  category: string;
  baselineAmount: number | null;
  currentAmount: number | null;
  diffAmount: number | null;
  diffPercent: number | null;
  status: "OK" | "FLAGGED" | "NEW" | "REMOVED";
}

/**
 * Derives comprehensive item-by-item comparison rows between current and baseline statements.
 */
export function deriveComparisonRows(
  current: StatementPayload,
  baseline: StatementPayload,
  auditResult: AuditResult
): ComparisonRow[] {
  const anomalyMap = new Map(auditResult.anomalies.map((a) => [a.lineItemId, a]));
  const currentMap = new Map(current.lineItems.map((item) => [item.id, item]));
  const baselineMap = new Map(baseline.lineItems.map((item) => [item.id, item]));

  const rows: ComparisonRow[] = [];

  // 1. Current items (matched or new)
  for (const [id, curItem] of currentMap.entries()) {
    const baseItem = baselineMap.get(id);
    const anomaly = anomalyMap.get(id);

    if (baseItem) {
      const diffAmount = Math.round((curItem.amount - baseItem.amount) * 100) / 100;
      const diffPercent =
        baseItem.amount > 0
          ? Math.round(((curItem.amount - baseItem.amount) / baseItem.amount) * 10000) / 100
          : 0.0;

      rows.push({
        id,
        description: curItem.description,
        category: curItem.category,
        baselineAmount: baseItem.amount,
        currentAmount: curItem.amount,
        diffAmount,
        diffPercent,
        status: anomaly ? "FLAGGED" : "OK",
      });
    } else {
      // New line item
      rows.push({
        id,
        description: curItem.description,
        category: curItem.category,
        baselineAmount: null,
        currentAmount: curItem.amount,
        diffAmount: curItem.amount,
        diffPercent: 100.0,
        status: "NEW",
      });
    }
  }

  // 2. Removed baseline items (discontinued in current)
  for (const [id, baseItem] of baselineMap.entries()) {
    if (!currentMap.has(id)) {
      rows.push({
        id,
        description: baseItem.description,
        category: baseItem.category,
        baselineAmount: baseItem.amount,
        currentAmount: null,
        diffAmount: -baseItem.amount,
        diffPercent: -100.0,
        status: "REMOVED",
      });
    }
  }

  return rows;
}

/**
 * Generates the complete, standalone HTML verification report.
 */
export function generateDashboardHtml(
  current: StatementPayload,
  baseline: StatementPayload,
  auditResult: AuditResult,
  manifest: VerificationManifest
): string {
  const isFlagged = auditResult.status === "ANOMALIES_FLAGGED";
  const comparisonRows = deriveComparisonRows(current, baseline, auditResult);

  const statusPillClass = isFlagged ? "pill-flagged" : "pill-ok";
  const statusPillText = isFlagged ? "ANOMALIES_FLAGGED" : "VERIFIED_OK";

  const netVarSign = auditResult.varianceAmount >= 0 ? "+" : "";
  const netPctSign = auditResult.variancePercent >= 0 ? "+" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LifeOps — Verified Billing Audit (${escapeHtml(current.statementId)})</title>
  <style>
    :root {
      --bg-main: #0a0e17;
      --bg-card: #111827;
      --bg-card-hover: #172033;
      --border-color: #1f293d;
      --text-main: #f9fafb;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent-sky: #38bdf8;
      --accent-emerald: #10b981;
      --accent-amber: #f59e0b;
      --accent-rose: #f43f5e;
      --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg-main);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 32px 20px;
    }

    .container {
      max-width: 1040px;
      margin: 0 auto;
    }

    /* Header Section */
    .header-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px;
    }

    .header-title h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-title h1 span.brand {
      color: var(--accent-sky);
    }

    .header-title p {
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 4px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    .pill-flagged {
      background: rgba(245, 158, 11, 0.15);
      color: var(--accent-amber);
      border: 1px solid rgba(245, 158, 11, 0.4);
    }

    .pill-ok {
      background: rgba(16, 185, 129, 0.15);
      color: var(--accent-emerald);
      border: 1px solid rgba(16, 185, 129, 0.4);
    }

    /* Executive Summary Cards */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 20px;
    }

    .metric-card .label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .metric-card .value {
      font-size: 22px;
      font-weight: 700;
      color: var(--text-main);
      font-family: var(--font-mono);
    }

    .metric-card .value.positive { color: var(--accent-amber); }
    .metric-card .value.neutral { color: var(--accent-sky); }
    .metric-card .value.success { color: var(--accent-emerald); }

    /* Flagged Anomalies Section */
    .section-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 24px;
    }

    .section-header {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .anomaly-card {
      background: rgba(245, 158, 11, 0.05);
      border: 1px solid rgba(245, 158, 11, 0.3);
      border-left: 4px solid var(--accent-amber);
      border-radius: 8px;
      padding: 18px 20px;
      margin-bottom: 12px;
    }

    .anomaly-card .anomaly-title {
      font-size: 15px;
      font-weight: 600;
      color: #fbbf24;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .anomaly-card .anomaly-meta {
      display: flex;
      gap: 20px;
      margin: 10px 0;
      font-size: 13px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .anomaly-card .anomaly-reason {
      font-size: 13px;
      color: #cbd5e1;
      background: rgba(0, 0, 0, 0.25);
      padding: 8px 12px;
      border-radius: 6px;
      margin-top: 8px;
    }

    /* Comparison Table */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 14px;
    }

    th {
      text-align: left;
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.02);
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border-color);
    }

    td {
      padding: 14px;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-main);
    }

    tr:hover td {
      background: var(--bg-card-hover);
    }

    .text-right { text-align: right; }
    .mono { font-family: var(--font-mono); }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      font-family: var(--font-mono);
    }

    .tag-flagged { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .tag-ok { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .tag-new { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .tag-removed { background: rgba(244, 63, 94, 0.2); color: #fb7185; }

    /* Verification & Provenance Grid */
    .provenance-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-top: 12px;
    }

    @media (max-width: 768px) {
      .provenance-grid { grid-template-columns: 1fr; }
    }

    .provenance-item {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px 16px;
    }

    .provenance-item .p-label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    .provenance-item .p-value {
      font-size: 12px;
      font-family: var(--font-mono);
      color: #cbd5e1;
      word-break: break-all;
    }

    .disclaimer-box {
      margin-top: 20px;
      padding: 14px 18px;
      background: rgba(56, 189, 248, 0.05);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 8px;
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.6;
    }

    .disclaimer-box strong {
      color: var(--accent-sky);
    }

    .footer {
      text-align: center;
      margin-top: 32px;
      font-size: 12px;
      color: var(--text-dim);
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- Header Card -->
    <header class="header-card">
      <div class="header-title">
        <h1><span class="brand">LifeOps</span> — Verified Billing Audit</h1>
        <p>Independent billing discrepancy analysis</p>
      </div>
      <div>
        <span class="status-badge ${statusPillClass}">${statusPillText}</span>
      </div>
    </header>

    <!-- Executive Summary Grid -->
    <section class="summary-grid">
      <div class="metric-card">
        <div class="label">Current Billing</div>
        <div class="value neutral">$${auditResult.currentTotal.toFixed(2)}</div>
      </div>
      <div class="metric-card">
        <div class="label">Previous Billing</div>
        <div class="value">$${auditResult.baselineTotal.toFixed(2)}</div>
      </div>
      <div class="metric-card">
        <div class="label">Net Variance</div>
        <div class="value ${isFlagged ? "positive" : "success"}">${netVarSign}$${auditResult.varianceAmount.toFixed(2)}</div>
      </div>
      <div class="metric-card">
        <div class="label">Variance %</div>
        <div class="value ${isFlagged ? "positive" : "success"}">${netPctSign}${auditResult.variancePercent.toFixed(2)}%</div>
      </div>
      <div class="metric-card">
        <div class="label">Anomalies</div>
        <div class="value ${auditResult.anomalies.length > 0 ? "positive" : "success"}">${auditResult.anomalies.length}</div>
      </div>
    </section>

    <!-- Flagged Anomalies Section -->
    <section class="section-card">
      <div class="section-header">
        <span>Flagged Discrepancies</span>
        <span style="font-size: 13px; color: var(--text-muted); font-weight: normal;">
          Threshold: <strong>15.00%</strong>
        </span>
      </div>

      ${
        auditResult.anomalies.length > 0
          ? auditResult.anomalies
              .map(
                (a) => `
      <div class="anomaly-card">
        <div class="anomaly-title">
          <span>${escapeHtml(a.description)}</span>
          <span class="mono">${a.diffPercent >= 0 ? "+" : ""}${a.diffPercent.toFixed(2)}%</span>
        </div>
        <div class="anomaly-meta">
          <span>Item ID: <strong>${escapeHtml(a.lineItemId)}</strong></span>
          <span><strong>$${a.baselineAmount.toFixed(2)} &rarr; $${a.currentAmount.toFixed(2)}</strong></span>
          <span>Threshold: <strong>15.00%</strong></span>
        </div>
        <div class="anomaly-reason">${escapeHtml(a.reason)}</div>
      </div>`
              )
              .join("\n")
          : `<p style="color: var(--text-muted); font-size: 14px;">No cost discrepancies exceeded the configured variance threshold.</p>`
      }
    </section>

    <!-- Detailed Line-Item Comparison Table -->
    <section class="section-card">
      <div class="section-header">
        <span>Itemized Statement Comparison</span>
        <span style="font-size: 13px; color: var(--text-muted); font-weight: normal;">
          ${escapeHtml(baseline.billingPeriod)} &rarr; ${escapeHtml(current.billingPeriod)}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Item & Description</th>
            <th>Category</th>
            <th class="text-right">Previous</th>
            <th class="text-right">Current</th>
            <th class="text-right">Change</th>
            <th class="text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          ${comparisonRows
            .map((r) => {
              const baseStr = r.baselineAmount !== null ? `$${r.baselineAmount.toFixed(2)}` : "—";
              const curStr = r.currentAmount !== null ? `$${r.currentAmount.toFixed(2)}` : "—";
              const diffStr =
                r.diffPercent !== null
                  ? `${r.diffPercent >= 0 ? "+" : ""}${r.diffPercent.toFixed(2)}%`
                  : "—";

              const tagClass =
                r.status === "FLAGGED"
                  ? "tag-flagged"
                  : r.status === "NEW"
                  ? "tag-new"
                  : r.status === "REMOVED"
                  ? "tag-removed"
                  : "tag-ok";

              return `
          <tr>
            <td>
              <div style="font-weight: 600;">${escapeHtml(r.description)}</div>
              <div class="mono" style="font-size: 11px; color: var(--text-dim);">${escapeHtml(r.id)}</div>
            </td>
            <td><span style="color: var(--text-muted);">${escapeHtml(r.category)}</span></td>
            <td class="text-right mono">${baseStr}</td>
            <td class="text-right mono" style="font-weight: 600;">${curStr}</td>
            <td class="text-right mono" style="color: ${r.status === "FLAGGED" ? "var(--accent-amber)" : "inherit"};">${diffStr}</td>
            <td class="text-right"><span class="tag ${tagClass}">${r.status}</span></td>
          </tr>`;
            })
            .join("\n")}
        </tbody>
      </table>
    </section>

    <!-- Cryptographic Provenance & Audit Metadata -->
    <section class="section-card">
      <div class="section-header">
        <span>Cryptographic Provenance & Execution Integrity</span>
        <span class="tag tag-ok">${escapeHtml(manifest.status)}</span>
      </div>

      <div class="provenance-grid">
        <div class="provenance-item">
          <div class="p-label">Task ID</div>
          <div class="p-value">${escapeHtml(manifest.taskId)}</div>
        </div>
        <div class="provenance-item">
          <div class="p-label">Audit Timestamp</div>
          <div class="p-value">${escapeHtml(manifest.timestamp)}</div>
        </div>
        <div class="provenance-item">
          <div class="p-label">Current Statement ID</div>
          <div class="p-value">${escapeHtml(current.statementId)} (${escapeHtml(current.billingPeriod)})</div>
        </div>
        <div class="provenance-item">
          <div class="p-label">Historical Baseline ID</div>
          <div class="p-value">${escapeHtml(baseline.statementId)} (${escapeHtml(baseline.billingPeriod)})</div>
        </div>
        <div class="provenance-item" style="grid-column: span 2;">
          <div class="p-label">Statement SHA-256 Fingerprint (Browser Ingestion)</div>
          <div class="p-value">${escapeHtml(manifest.statementHash)}</div>
        </div>
        <div class="provenance-item" style="grid-column: span 2;">
          <div class="p-label">Audit SHA-256 Fingerprint (Isolated MicroVM Computation)</div>
          <div class="p-value">${escapeHtml(manifest.auditHash)}</div>
        </div>
        ${
          manifest.previewUrl
            ? `
        <div class="provenance-item" style="grid-column: span 2;">
          <div class="p-label">Live Verification Port Preview</div>
          <div class="p-value"><a href="${escapeHtml(manifest.previewUrl)}" style="color: var(--accent-sky); text-decoration: none;" target="_blank" rel="noopener noreferrer">${escapeHtml(manifest.previewUrl)}</a></div>
        </div>`
            : ""
        }
      </div>

      <div class="disclaimer-box">
        <strong>Cryptographic Integrity Notice:</strong> The SHA-256 fingerprint makes changes to the represented data detectable across pipeline stages. It does not prove that the originating billing provider's data is economically correct.
      </div>
    </section>

    <footer class="footer">
      Generated automatically by Solari LifeOps Task Agent &bull; Rendered inside isolated Solari Sandbox MicroVM
    </footer>

  </div>
</body>
</html>`;
}
