import assert from "node:assert/strict";
import {
  getDemoBaselineStatement,
  getDemoCurrentStatement,
  computeStatementHash,
} from "./fixtures.js";
import {
  executeDiscrepancyAudit,
  computeAuditHash,
  buildVerificationManifest,
} from "./sandbox.js";
import { generateDashboardHtml } from "./dashboard.js";
import type { StatementPayload } from "./types.js";

console.log("=== Running LifeOps Offline Validation & Discrepancy Tests ===\n");

// ============================================================================
// 1. Discrepancy Mathematics & Boundary Tests
// ============================================================================
console.log("[Test Suite 1: Discrepancy Mathematics]");

const baseline = getDemoBaselineStatement();
const current = getDemoCurrentStatement();

// Case A: Identical baseline vs baseline
const auditIdentical = executeDiscrepancyAudit(baseline, baseline, 15.0);
assert.equal(auditIdentical.status, "VERIFIED_OK");
assert.equal(auditIdentical.anomalies.length, 0);
assert.equal(auditIdentical.varianceAmount, 0.0);
assert.equal(auditIdentical.variancePercent, 0.0);
console.log("  ✓ Case A: Identical statement baseline audit passed (VERIFIED_OK).");

// Case B: Above-threshold cost surge (+125.00% on proxy sessions)
const auditDemo = executeDiscrepancyAudit(current, baseline, 15.0);
assert.equal(auditDemo.status, "ANOMALIES_FLAGGED");
assert.equal(auditDemo.anomalies.length, 1);
assert.equal(auditDemo.anomalies[0].lineItemId, "item_browser_04");
assert.equal(auditDemo.anomalies[0].diffPercent, 125.0);
assert.equal(auditDemo.varianceAmount, 26.8);
assert.equal(auditDemo.variancePercent, 8.13);
console.log("  ✓ Case B: Above-threshold cost surge (+125%) correctly flagged.");

// Case C: Above-threshold cost drop (-50%)
const dropStatement: StatementPayload = {
  ...baseline,
  lineItems: baseline.lineItems.map((item) =>
    item.id === "item_compute_01" ? { ...item, amount: 74.4 } : item
  ),
  totalAmount: 329.8 - 74.4,
};
const auditDrop = executeDiscrepancyAudit(dropStatement, baseline, 15.0);
assert.equal(auditDrop.status, "ANOMALIES_FLAGGED");
assert.equal(auditDrop.anomalies.length, 1);
assert.equal(auditDrop.anomalies[0].lineItemId, "item_compute_01");
assert.equal(auditDrop.anomalies[0].diffPercent, -50.0);
console.log("  ✓ Case C: Above-threshold cost drop (-50%) correctly flagged.");

// Case D: New line item (not in baseline)
const newItemStatement: StatementPayload = {
  ...baseline,
  lineItems: [
    ...baseline.lineItems,
    { id: "item_new_gpu", description: "A100 GPU Instance", amount: 150.0 },
  ],
  totalAmount: baseline.totalAmount + 150.0,
};
const auditNew = executeDiscrepancyAudit(newItemStatement, baseline, 15.0);
assert.equal(auditNew.status, "ANOMALIES_FLAGGED");
const newAnomaly = auditNew.anomalies.find((a) => a.lineItemId === "item_new_gpu");
assert.ok(newAnomaly);
assert.equal(newAnomaly.baselineAmount, 0.0);
assert.equal(newAnomaly.currentAmount, 150.0);
console.log("  ✓ Case D: New line item correctly flagged with 0.0 baseline.");

// Case E: Removed line item
const removedStatement: StatementPayload = {
  ...baseline,
  lineItems: baseline.lineItems.filter((i) => i.id !== "item_storage_02"),
  totalAmount: baseline.totalAmount - 25.0,
};
const auditRemoved = executeDiscrepancyAudit(removedStatement, baseline, 15.0);
assert.equal(auditRemoved.status, "ANOMALIES_FLAGGED");
const remAnomaly = auditRemoved.anomalies.find((a) => a.lineItemId === "item_storage_02");
assert.ok(remAnomaly);
assert.equal(remAnomaly.diffPercent, -100.0);
console.log("  ✓ Case E: Removed line item correctly flagged.");

// Case F: Zero-baseline division-by-zero protection
const zeroBaseline: StatementPayload = {
  ...baseline,
  lineItems: [{ id: "item_zero", description: "Zero Item", amount: 0.0 }],
  totalAmount: 0.0,
};
const curWithZero: StatementPayload = {
  ...baseline,
  lineItems: [{ id: "item_zero", description: "Zero Item", amount: 50.0 }],
  totalAmount: 50.0,
};
const auditZero = executeDiscrepancyAudit(curWithZero, zeroBaseline, 15.0);
assert.equal(auditZero.status, "ANOMALIES_FLAGGED");
assert.equal(auditZero.anomalies[0].diffPercent, 100.0);
console.log("  ✓ Case F: Zero-baseline division-by-zero safely handled.");

// ============================================================================
// 2. Exact Threshold Boundary Conditions
// ============================================================================
console.log("\n[Test Suite 2: Exact Threshold Boundary Conditions]");

const baseBound: StatementPayload = {
  statementId: "BASE",
  accountId: "ACC",
  billingPeriod: "Period",
  issueDate: "2026-01-01",
  currency: "USD",
  totalAmount: 100.0,
  lineItems: [{ id: "item_test", description: "Test", amount: 100.0 }],
};

const makeBoundCurrent = (amt: number): StatementPayload => ({
  statementId: "CUR",
  accountId: "ACC",
  billingPeriod: "Period",
  issueDate: "2026-02-01",
  currency: "USD",
  totalAmount: amt,
  lineItems: [{ id: "item_test", description: "Test", amount: amt }],
});

// +14.99% -> Below threshold (VERIFIED_OK)
const resPlus1499 = executeDiscrepancyAudit(makeBoundCurrent(114.99), baseBound, 15.0);
assert.equal(resPlus1499.status, "VERIFIED_OK");
assert.equal(resPlus1499.anomalies.length, 0);

// +15.00% -> Exactly on threshold (VERIFIED_OK)
const resPlus1500 = executeDiscrepancyAudit(makeBoundCurrent(115.00), baseBound, 15.0);
assert.equal(resPlus1500.status, "VERIFIED_OK");
assert.equal(resPlus1500.anomalies.length, 0);

// +15.01% -> Exceeds threshold (ANOMALIES_FLAGGED)
const resPlus1501 = executeDiscrepancyAudit(makeBoundCurrent(115.01), baseBound, 15.0);
assert.equal(resPlus1501.status, "ANOMALIES_FLAGGED");
assert.equal(resPlus1501.anomalies.length, 1);
assert.equal(resPlus1501.anomalies[0].diffPercent, 15.01);

// -14.99% -> Below negative threshold (VERIFIED_OK)
const resMinus1499 = executeDiscrepancyAudit(makeBoundCurrent(85.01), baseBound, 15.0);
assert.equal(resMinus1499.status, "VERIFIED_OK");
assert.equal(resMinus1499.anomalies.length, 0);

// -15.00% -> Exactly on negative threshold (VERIFIED_OK)
const resMinus1500 = executeDiscrepancyAudit(makeBoundCurrent(85.00), baseBound, 15.0);
assert.equal(resMinus1500.status, "VERIFIED_OK");
assert.equal(resMinus1500.anomalies.length, 0);

// -15.01% -> Exceeds negative threshold (ANOMALIES_FLAGGED)
const resMinus1501 = executeDiscrepancyAudit(makeBoundCurrent(84.99), baseBound, 15.0);
assert.equal(resMinus1501.status, "ANOMALIES_FLAGGED");
assert.equal(resMinus1501.anomalies.length, 1);
assert.equal(resMinus1501.anomalies[0].diffPercent, -15.01);

console.log("  ✓ Case H: Threshold boundary conditions (+14.99%, +15.00%, +15.01%, -14.99%, -15.00%, -15.01%) verified.");

// ============================================================================
// 3. Dashboard HTML Generation & Provenance Rendering Tests
// ============================================================================
console.log("\n[Test Suite 3: Dashboard HTML Generation & Provenance]");

const auditHash = computeAuditHash(auditDemo);
const manifest = buildVerificationManifest(
  "monthly-cloud-billing-audit",
  current.rawHash!,
  auditHash,
  {
    sandboxId: "vm_002020",
    previewUrl: "https://demo-3000.preview.getsolari.com?token=test",
    status: "VERIFIED",
  }
);

const html = generateDashboardHtml(current, baseline, auditDemo, manifest);

assert.ok(html.includes("<!DOCTYPE html>"));
assert.ok(html.includes("$356.60"));
assert.ok(html.includes("$329.80"));
assert.ok(html.includes("+125.00%"));
assert.ok(html.includes("Stealth Residential Proxy Sessions (Burst)"));
assert.ok(html.includes("ANOMALIES_FLAGGED"));
assert.ok(html.includes(current.rawHash!));
assert.ok(html.includes(auditHash));
assert.ok(html.includes("https://demo-3000.preview.getsolari.com?token=test"));
assert.ok(html.includes("The SHA-256 fingerprint makes changes to the represented data detectable across pipeline stages"));
console.log("  ✓ Dashboard generation and provenance rendering verified.");

// HTML Sanitization test
const xssStatement: StatementPayload = {
  ...baseline,
  statementId: "<script>alert(1)</script>",
  lineItems: [
    {
      id: "xss_01",
      description: "<img src=x onerror=alert(1)>",
      amount: 100.0,
    },
  ],
  totalAmount: 100.0,
};
const xssAudit = executeDiscrepancyAudit(xssStatement, baseline, 15.0);
const xssHtml = generateDashboardHtml(xssStatement, baseline, xssAudit, manifest);
assert.ok(!xssHtml.includes("<script>alert(1)</script>"));
assert.ok(!xssHtml.includes("<img src=x onerror=alert(1)>"));
assert.ok(xssHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
assert.ok(xssHtml.includes("&lt;img src=x onerror=alert(1)&gt;"));
console.log("  ✓ HTML sanitization and entity escaping verified against XSS vectors.");

console.log("\nAll LifeOps validation unit tests passed cleanly!");
