import crypto from "node:crypto";
import type { StatementPayload } from "./types.js";

/**
 * Computes a deterministic SHA-256 fingerprint for a StatementPayload.
 */
export function computeStatementHash(statement: Omit<StatementPayload, "rawHash">): string {
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
      category: item.category ?? null,
      amount: item.amount.toFixed(2),
      unit: item.unit ?? null,
      quantity: item.quantity !== undefined ? item.quantity : null,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Baseline billing statement (July 2026).
 * Total: $329.80 across 5 items.
 */
export function getDemoBaselineStatement(): StatementPayload {
  const base: Omit<StatementPayload, "rawHash"> = {
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

  return {
    ...base,
    rawHash: computeStatementHash(base),
  };
}

/**
 * Current billing statement (August 2026).
 * Total: $356.60 (+8.13% total increase).
 * Contains a hidden +125.00% anomaly in item_browser_04 ($20.00 -> $45.00).
 */
export function getDemoCurrentStatement(): StatementPayload {
  const current: Omit<StatementPayload, "rawHash"> = {
    statementId: "INV-2026-08-4912",
    accountId: "ACC-78921-X",
    billingPeriod: "2026-08-01 to 2026-08-31",
    issueDate: "2026-09-01",
    currency: "USD",
    totalAmount: 356.60,
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
        amount: 37.80,
        unit: "GB",
        quantity: 420,
      },
      {
        id: "item_browser_04",
        description: "Stealth Residential Proxy Sessions (Burst)",
        category: "Automation",
        amount: 45.00,
        unit: "sessions",
        quantity: 150,
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

  return {
    ...current,
    rawHash: computeStatementHash(current),
  };
}
