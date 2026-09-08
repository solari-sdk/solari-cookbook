import type {
  AuditResult,
  StatementPayload,
  VerificationManifest,
} from "./types.js";

function escapeHtml(str: string | number | undefined | null): string {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function generateDashboardHtml(
  current: StatementPayload,
  baseline: StatementPayload,
  audit: AuditResult,
  manifest: VerificationManifest
): string {
  const isFlagged = audit.status === "ANOMALIES_FLAGGED";
  const badgeClass = isFlagged ? "badge-flagged" : "badge-ok";
  const badgeText = isFlagged ? "ANOMALIES_FLAGGED" : "VERIFIED_OK";

  const baselineMap = new Map<string, (typeof baseline.lineItems)[0]>();
  for (const item of baseline.lineItems) {
    baselineMap.set(item.id, item);
  }

  const allItemIds = new Set<string>();
  for (const item of current.lineItems) allItemIds.add(item.id);
  for (const item of baseline.lineItems) allItemIds.add(item.id);

  const tableRows: string[] = [];
  for (const id of allItemIds) {
    const cur = current.lineItems.find((i) => i.id === id);
    const base = baselineMap.get(id);

    const desc = cur?.description ?? base?.description ?? id;
    const cat = cur?.category ?? base?.category ?? "General";
    const prevAmt = base ? `$${base.amount.toFixed(2)}` : "—";
    const curAmt = cur ? `$${cur.amount.toFixed(2)}` : "—";

    let changeText = "—";
    let statusBadge = `<span class="badge-tag tag-ok">OK</span>`;

    if (base && cur) {
      if (base.amount > 0) {
        const diff = (((cur.amount - base.amount) / base.amount) * 100).toFixed(2);
        const sign = Number(diff) > 0 ? "+" : "";
        changeText = `${sign}${diff}%`;
      } else if (cur.amount > 0) {
        changeText = "+100.00%";
      } else {
        changeText = "+0.00%";
      }
    } else if (!base && cur) {
      changeText = "+100.00%";
      statusBadge = `<span class="badge-tag tag-new">NEW</span>`;
    } else if (base && !cur) {
      changeText = "-100.00%";
      statusBadge = `<span class="badge-tag tag-removed">REMOVED</span>`;
    }

    const isAnomaly = audit.anomalies.some((a) => a.lineItemId === id);
    if (isAnomaly) {
      statusBadge = `<span class="badge-tag tag-flagged">FLAGGED</span>`;
    }

    tableRows.push(`
      <tr class="${isAnomaly ? "row-flagged" : ""}">
        <td>
          <strong>${escapeHtml(desc)}</strong>
          <div class="code-sub">${escapeHtml(id)}</div>
        </td>
        <td>${escapeHtml(cat)}</td>
        <td class="num">${escapeHtml(prevAmt)}</td>
        <td class="num">${escapeHtml(curAmt)}</td>
        <td class="num ${isAnomaly ? "text-amber" : ""}">${escapeHtml(changeText)}</td>
        <td>${statusBadge}</td>
      </tr>
    `);
  }

  const anomalyCards = audit.anomalies.map(
    (a) => `
    <div class="anomaly-card">
      <div class="a-header">
        <span class="a-title">${escapeHtml(a.description)}</span>
        <span class="a-diff text-amber">${a.diffPercent >= 0 ? "+" : ""}${escapeHtml(a.diffPercent.toFixed(2))}%</span>
      </div>
      <div class="a-meta">
        Item ID: <code>${escapeHtml(a.lineItemId)}</code> &bull;
        Baseline: <strong>$${escapeHtml(a.baselineAmount.toFixed(2))}</strong> &rarr; Current: <strong>$${escapeHtml(a.currentAmount.toFixed(2))}</strong>
      </div>
      <div class="a-reason">${escapeHtml(a.reason)}</div>
    </div>
  `
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LifeOps — Verified Billing Audit</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --amber: #f59e0b;
      --green: #10b981;
      --red: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 32px 16px;
      line-height: 1.5;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }
    h1 { font-size: 24px; font-weight: 700; color: var(--accent); }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-top: 4px; }
    .badge {
      font-size: 12px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-flagged { background: rgba(245, 158, 11, 0.15); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-ok { background: rgba(16, 185, 129, 0.15); color: var(--green); border: 1px solid rgba(16, 185, 129, 0.4); }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .m-label { font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; letter-spacing: 0.05em; }
    .m-value { font-size: 22px; font-weight: 700; margin-top: 6px; }
    .text-amber { color: var(--amber); }
    .text-green { color: var(--green); }
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .section-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: #e2e8f0; }
    .anomaly-card {
      background: rgba(245, 158, 11, 0.05);
      border-left: 3px solid var(--amber);
      padding: 12px 16px;
      border-radius: 0 6px 6px 0;
      margin-bottom: 12px;
    }
    .a-header { display: flex; justify-content: space-between; font-weight: 600; }
    .a-meta { font-size: 13px; color: var(--text-muted); margin: 4px 0; }
    .a-reason { font-size: 13px; color: #cbd5e1; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
    th { text-align: left; padding: 10px 12px; color: var(--text-muted); font-size: 12px; border-bottom: 1px solid var(--border); text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid rgba(31, 41, 55, 0.6); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .code-sub { font-size: 12px; color: var(--text-muted); font-family: monospace; }
    .badge-tag { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .tag-ok { background: #064e3b; color: #6ee7b7; }
    .tag-flagged { background: #78350f; color: #fde68a; }
    .tag-new { background: #1e3a8a; color: #bfdbfe; }
    .tag-removed { background: #4c1d95; color: #ddd6fe; }
    .provenance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; font-size: 13px; }
    .p-item { background: #0b1120; padding: 10px 14px; border-radius: 6px; border: 1px solid #1e293b; }
    .p-label { font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .p-val { font-family: monospace; font-size: 12px; margin-top: 4px; word-break: break-all; }
    .disclaimer {
      margin-top: 16px;
      padding: 12px 16px;
      background: rgba(56, 189, 248, 0.05);
      border-left: 3px solid var(--accent);
      border-radius: 0 6px 6px 0;
      font-size: 13px;
      color: #94a3b8;
    }
    footer { text-align: center; color: var(--text-muted); font-size: 12px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div>
        <h1>LifeOps — Verified Billing Audit</h1>
        <div class="subtitle">Independent discrepancy analysis inside isolated Solari Sandbox microVM</div>
      </div>
      <div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
    </header>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="m-label">Current Total</div>
        <div class="m-value text-accent">$${escapeHtml(current.totalAmount.toFixed(2))}</div>
      </div>
      <div class="metric-card">
        <div class="m-label">Baseline Total</div>
        <div class="m-value">$${escapeHtml(baseline.totalAmount.toFixed(2))}</div>
      </div>
      <div class="metric-card">
        <div class="m-label">Net Variance</div>
        <div class="m-value ${audit.varianceAmount >= 0 ? "text-amber" : "text-green"}">${audit.varianceAmount >= 0 ? "+" : ""}$${escapeHtml(audit.varianceAmount.toFixed(2))}</div>
      </div>
      <div class="metric-card">
        <div class="m-label">Variance %</div>
        <div class="m-value ${audit.variancePercent >= 0 ? "text-amber" : "text-green"}">${audit.variancePercent >= 0 ? "+" : ""}${escapeHtml(audit.variancePercent.toFixed(2))}%</div>
      </div>
      <div class="metric-card">
        <div class="m-label">Anomalies</div>
        <div class="m-value ${audit.anomalies.length > 0 ? "text-amber" : "text-green"}">${audit.anomalies.length}</div>
      </div>
    </div>

    ${
      audit.anomalies.length > 0
        ? `
    <section class="section-card">
      <div class="section-title">Flagged Line-Item Discrepancies</div>
      ${anomalyCards.join("")}
    </section>`
        : ""
    }

    <section class="section-card">
      <div class="section-title">Itemized Comparison (${escapeHtml(baseline.billingPeriod)} &rarr; ${escapeHtml(current.billingPeriod)})</div>
      <table>
        <thead>
          <tr>
            <th>Item &amp; ID</th>
            <th>Category</th>
            <th class="num">Previous</th>
            <th class="num">Current</th>
            <th class="num">Change</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows.join("")}
        </tbody>
      </table>
    </section>

    <section class="section-card">
      <div class="section-title">Cryptographic Provenance &amp; Execution Integrity</div>
      <div class="provenance-grid">
        <div class="p-item">
          <div class="p-label">Task ID</div>
          <div class="p-val">${escapeHtml(manifest.taskId)}</div>
        </div>
        <div class="p-item">
          <div class="p-label">Audit Timestamp</div>
          <div class="p-val">${escapeHtml(manifest.timestamp)}</div>
        </div>
        <div class="p-item" style="grid-column: 1 / -1;">
          <div class="p-label">Statement SHA-256 Fingerprint</div>
          <div class="p-val">${escapeHtml(manifest.statementHash)}</div>
        </div>
        <div class="p-item" style="grid-column: 1 / -1;">
          <div class="p-label">Audit Result SHA-256 Fingerprint</div>
          <div class="p-val">${escapeHtml(manifest.auditHash)}</div>
        </div>
        ${
          manifest.previewUrl
            ? `
        <div class="p-item" style="grid-column: 1 / -1;">
          <div class="p-label">Live Verification Port Preview</div>
          <div class="p-val"><a href="${escapeHtml(manifest.previewUrl)}" style="color: var(--accent); text-decoration: none;" target="_blank" rel="noopener noreferrer">${escapeHtml(manifest.previewUrl)}</a></div>
        </div>`
            : ""
        }
      </div>
      <div class="disclaimer">
        <strong>Cryptographic Integrity Notice:</strong> The SHA-256 fingerprint makes changes to the represented data detectable across pipeline stages. It does not prove that the originating billing provider's data is economically correct.
      </div>
    </section>

    <footer>
      Generated automatically by Solari LifeOps &bull; Served inside isolated Solari Sandbox MicroVM
    </footer>
  </div>
</body>
</html>`;
}
