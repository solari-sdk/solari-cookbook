/**
 * Deterministic Demo Fixture for LifeOps Task Agent.
 *
 * Provides a 100% reproducible, self-contained billing portal for open-source evaluation.
 * Rendered directly inside the remote Solari Cloud Browser via a data URL, eliminating
 * the need for external network dependencies, test servers, or private financial credentials.
 */

export const DEMO_PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ApexCloud Infrastructure — Monthly Billing Statement</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 40px;
      background: #0f172a;
      color: #f8fafc;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 32px;
      max-width: 840px;
      margin: 0 auto;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      border: 1px solid #334155;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #334155;
      padding-bottom: 20px;
    }
    .badge {
      background: #0284c7;
      color: #ffffff;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin: 24px 0;
      padding: 16px;
      background: #0f172a;
      border-radius: 8px;
    }
    .meta-item label {
      color: #94a3b8;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: block;
      margin-bottom: 4px;
    }
    .meta-item span {
      font-size: 15px;
      font-weight: 600;
      color: #f1f5f9;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    th {
      text-align: left;
      padding: 12px;
      background: #334155;
      color: #cbd5e1;
      font-size: 12px;
      text-transform: uppercase;
    }
    td {
      padding: 14px 12px;
      border-bottom: 1px solid #334155;
      font-size: 14px;
    }
    .text-right {
      text-align: right;
    }
    .total-row td {
      font-weight: 700;
      font-size: 16px;
      color: #38bdf8;
      border-top: 2px solid #38bdf8;
      border-bottom: none;
      padding-top: 18px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div>
        <h1 style="margin:0;font-size:22px;color:#38bdf8;">ApexCloud Platform</h1>
        <p style="margin:4px 0 0 0;color:#94a3b8;font-size:13px;">Enterprise Cloud Infrastructure Services</p>
      </div>
      <div>
        <span class="badge">PAID / SETTLED</span>
      </div>
    </div>

    <div class="meta-grid" id="statement-metadata">
      <div class="meta-item">
        <label>Statement ID</label>
        <span data-field="statement-id">INV-2026-08-4912</span>
      </div>
      <div class="meta-item">
        <label>Account ID</label>
        <span data-field="account-id">ACC-78921-X</span>
      </div>
      <div class="meta-item">
        <label>Billing Period</label>
        <span data-field="billing-period">2026-08-01 to 2026-08-31</span>
      </div>
      <div class="meta-item">
        <label>Issue Date</label>
        <span data-field="issue-date">2026-09-01</span>
      </div>
    </div>

    <table id="billing-statement-table">
      <thead>
        <tr>
          <th>Item ID</th>
          <th>Description</th>
          <th>Category</th>
          <th class="text-right">Qty</th>
          <th>Unit</th>
          <th class="text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr data-line-item-id="item_compute_01">
          <td class="line-id">item_compute_01</td>
          <td class="line-desc">High-Memory MicroVM Compute (4 vCPU, 16GB)</td>
          <td class="line-cat">Compute</td>
          <td class="line-qty text-right">744</td>
          <td class="line-unit">hours</td>
          <td class="line-amount text-right">$148.80</td>
        </tr>
        <tr data-line-item-id="item_storage_02">
          <td class="line-id">item_storage_02</td>
          <td class="line-desc">NVMe Block Storage Allocation</td>
          <td class="line-cat">Storage</td>
          <td class="line-qty text-right">250</td>
          <td class="line-unit">GB-month</td>
          <td class="line-amount text-right">$25.00</td>
        </tr>
        <tr data-line-item-id="item_egress_03">
          <td class="line-id">item_egress_03</td>
          <td class="line-desc">Global Edge Network Data Egress</td>
          <td class="line-cat">Networking</td>
          <td class="line-qty text-right">420</td>
          <td class="line-unit">GB</td>
          <td class="line-amount text-right">$37.80</td>
        </tr>
        <tr data-line-item-id="item_browser_04">
          <td class="line-id">item_browser_04</td>
          <td class="line-desc">Stealth Residential Proxy Sessions (Burst)</td>
          <td class="line-cat">Automation</td>
          <td class="line-qty text-right">150</td>
          <td class="line-unit">sessions</td>
          <td class="line-amount text-right">$45.00</td>
        </tr>
        <tr data-line-item-id="item_support_05">
          <td class="line-id">item_support_05</td>
          <td class="line-desc">Enterprise Premium Support Plan</td>
          <td class="line-cat">Support</td>
          <td class="line-qty text-right">1</td>
          <td class="line-unit">month</td>
          <td class="line-amount text-right">$100.00</td>
        </tr>
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td colspan="5">Total Billed Amount (<span data-field="currency">USD</span>)</td>
          <td class="text-right" data-field="total-amount">$356.60</td>
        </tr>
      </tfoot>
    </table>
  </div>
</body>
</html>`;

/**
 * Returns a data URL that can be navigated to by the remote Solari Cloud Browser.
 */
export function getDemoPortalDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(DEMO_PORTAL_HTML)}`;
}

import crypto from "node:crypto";
import type { StatementPayload } from "./types.js";

/**
 * Returns the deterministic historical baseline statement (July 2026).
 * Represents prior period billing against which the August statement is audited.
 * Contains identical baseline costs for compute/storage/support, slight egress growth,
 * and a lower proxy burst baseline ($20 vs $45) that reliably triggers a +125% anomaly.
 */
export function getDemoBaselineStatement(): StatementPayload {
  const statement: Omit<StatementPayload, "rawHash"> = {
    statementId: "INV-2026-07-3801",
    accountId: "ACC-78921-X",
    billingPeriod: "2026-07-01 to 2026-07-31",
    issueDate: "2026-08-01",
    currency: "USD",
    totalAmount: 329.80,
    lineItems: [
      {
        id: "item_compute_01",
        description: "High-Memory MicroVM Compute (4 vCPU, 16GB)",
        category: "Compute",
        amount: 148.80,
        unit: "hours",
        quantity: 744,
      },
      {
        id: "item_storage_02",
        description: "NVMe Block Storage Allocation",
        category: "Storage",
        amount: 25.00,
        unit: "GB-month",
        quantity: 250,
      },
      {
        id: "item_egress_03",
        description: "Global Edge Network Data Egress",
        category: "Networking",
        amount: 36.00,
        unit: "GB",
        quantity: 400,
      },
      {
        id: "item_browser_04",
        description: "Stealth Residential Proxy Sessions (Burst)",
        category: "Automation",
        amount: 20.00,
        unit: "sessions",
        quantity: 65,
      },
      {
        id: "item_support_05",
        description: "Enterprise Premium Support Plan",
        category: "Support",
        amount: 100.00,
        unit: "month",
        quantity: 1,
      },
    ],
  };

  const canonical = {
    statementId: statement.statementId,
    accountId: statement.accountId,
    billingPeriod: statement.billingPeriod,
    issueDate: statement.issueDate,
    currency: statement.currency,
    totalAmount: statement.totalAmount.toFixed(2),
    lineItems: statement.lineItems.map((item) => ({
      id: item.id,
      description: item.description,
      category: item.category,
      amount: item.amount.toFixed(2),
      unit: item.unit ?? null,
      quantity: item.quantity !== undefined ? item.quantity : null,
    })),
  };

  const rawHash = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");

  return {
    ...statement,
    rawHash,
  };
}

export const DEMO_BASELINE_STATEMENT = getDemoBaselineStatement();
