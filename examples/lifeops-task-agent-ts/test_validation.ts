import assert from "node:assert/strict";
import { parseCurrencyAmount, validateAndNormalizeStatement, computeStatementHash } from "./browser.js";
import { executeDiscrepancyAudit, computeAuditHash, buildVerificationManifest } from "./sandbox.js";
import { generateDashboardHtml, deriveComparisonRows, escapeHtml } from "./dashboard.js";
import { getDemoBaselineStatement } from "./fixtures.js";
import type { StatementPayload, VerificationManifest } from "./types.js";

console.log("=== Running LifeOps Offline Validation & Mathematics Tests ===\n");

// ============================================================================
// 1. Browser Extraction & Normalization Tests
// ============================================================================

console.log("[Test Suite 1: Browser Normalization]");
assert.equal(parseCurrencyAmount("$148.80"), 148.80);
assert.equal(parseCurrencyAmount("25.00 USD"), 25.00);
assert.equal(parseCurrencyAmount("  $356.60  "), 356.60);
assert.throws(() => parseCurrencyAmount(""), /Invalid monetary amount/);
assert.throws(() => parseCurrencyAmount("invalid_amount"), /Cannot parse numeric monetary amount/);
console.log("  ✓ Currency parsing validated.");

const sampleStatement: Omit<StatementPayload, "rawHash"> = {
  statementId: "INV-2026-08-4912",
  accountId: "ACC-78921-X",
  billingPeriod: "2026-08-01 to 2026-08-31",
  issueDate: "2026-09-01",
  currency: "USD",
  totalAmount: 173.80,
  lineItems: [
    { id: "1", description: "Compute", category: "Compute", amount: 148.80 },
    { id: "2", description: "Storage", category: "Storage", amount: 25.00 },
  ],
};
const hash1 = computeStatementHash(sampleStatement);
const hash2 = computeStatementHash(sampleStatement);
assert.equal(hash1, hash2);
assert.equal(typeof hash1, "string");
assert.equal(hash1.length, 64);

// Sensitivity: any changed field must alter the resulting SHA-256 fingerprint
const changedStatement = {
  ...sampleStatement,
  totalAmount: 173.81,
};
const changedHash = computeStatementHash(changedStatement);
assert.notEqual(hash1, changedHash);

const changedItemDesc = {
  ...sampleStatement,
  lineItems: [
    { id: "1", description: "Compute Mod", category: "Compute", amount: 148.80 },
    { id: "2", description: "Storage", category: "Storage", amount: 25.00 },
  ],
};
assert.notEqual(hash1, computeStatementHash(changedItemDesc));
console.log("  ✓ Statement hash determinism and sensitivity confirmed (SHA-256 length 64).");

assert.throws(() => {
  validateAndNormalizeStatement({
    statementId: "INV-1",
    accountId: "ACC-1",
    billingPeriod: "2026-08",
    issueDate: "2026-09-01",
    currency: "USD",
    rawTotal: "$999.00",
    rawItems: [{ id: "item_1", description: "Test", category: "Test", rawAmount: "$100.00" }],
  });
}, /Statement integrity violation/);
console.log("  ✓ Total mismatch boundary rejection confirmed.");

assert.throws(() => {
  validateAndNormalizeStatement({
    statementId: "",
    accountId: "ACC-1",
    billingPeriod: "2026-08",
    issueDate: "2026-09-01",
    currency: "USD",
    rawTotal: "$100.00",
    rawItems: [{ id: "item_1", description: "Test", category: "Test", rawAmount: "$100.00" }],
  });
}, /Missing required Statement ID/);
console.log("  ✓ Missing required metadata rejection confirmed.");

// ============================================================================
// 2. Sandbox Discrepancy Audit Algorithm Tests
// ============================================================================

console.log("\n[Test Suite 2: Sandbox Discrepancy Mathematics]");

const baseStatement: StatementPayload = {
  statementId: "INV-2026-07-3801",
  accountId: "ACC-78921-X",
  billingPeriod: "2026-07-01 to 2026-07-31",
  issueDate: "2026-08-01",
  currency: "USD",
  totalAmount: 100.00,
  lineItems: [
    { id: "compute", description: "Compute VM", category: "Compute", amount: 70.00 },
    { id: "storage", description: "Disk Storage", category: "Storage", amount: 30.00 },
  ],
  rawHash: "basehash",
};

// Case A: Identical statements (Zero anomalies, status VERIFIED_OK)
const auditIdentical = executeDiscrepancyAudit(baseStatement, baseStatement, 15.0);
assert.equal(auditIdentical.status, "VERIFIED_OK");
assert.equal(auditIdentical.anomalies.length, 0);
assert.equal(auditIdentical.varianceAmount, 0.0);
assert.equal(auditIdentical.variancePercent, 0.0);
console.log("  ✓ Case A: Identical statement baseline audit passed (VERIFIED_OK).");

// Case B: Above-threshold cost increase (+50%)
const currentIncrease: StatementPayload = {
  ...baseStatement,
  statementId: "INV-2026-08-0002",
  totalAmount: 135.00,
  lineItems: [
    { id: "compute", description: "Compute VM", category: "Compute", amount: 105.00 }, // +50% surge
    { id: "storage", description: "Disk Storage", category: "Storage", amount: 30.00 },
  ],
};
const auditIncrease = executeDiscrepancyAudit(currentIncrease, baseStatement, 15.0);
assert.equal(auditIncrease.status, "ANOMALIES_FLAGGED");
assert.equal(auditIncrease.anomalies.length, 1);
assert.equal(auditIncrease.anomalies[0].lineItemId, "compute");
assert.equal(auditIncrease.anomalies[0].diffPercent, 50.0);
assert.match(auditIncrease.anomalies[0].reason, /increased by 50.00%/);
console.log("  ✓ Case B: Above-threshold cost surge (+50%) correctly flagged.");

// Case C: Above-threshold cost decrease (-50%)
const currentDecrease: StatementPayload = {
  ...baseStatement,
  statementId: "INV-2026-08-0003",
  totalAmount: 65.00,
  lineItems: [
    { id: "compute", description: "Compute VM", category: "Compute", amount: 35.00 }, // -50% reduction
    { id: "storage", description: "Disk Storage", category: "Storage", amount: 30.00 },
  ],
};
const auditDecrease = executeDiscrepancyAudit(currentDecrease, baseStatement, 15.0);
assert.equal(auditDecrease.status, "ANOMALIES_FLAGGED");
assert.equal(auditDecrease.anomalies.length, 1);
assert.equal(auditDecrease.anomalies[0].lineItemId, "compute");
assert.equal(auditDecrease.anomalies[0].diffPercent, -50.0);
assert.match(auditDecrease.anomalies[0].reason, /decreased by 50.00%/);
console.log("  ✓ Case C: Above-threshold cost drop (-50%) correctly flagged.");

// Case D: New line item (present in current, missing in baseline)
const currentWithNewItem: StatementPayload = {
  ...baseStatement,
  statementId: "INV-2026-08-0004",
  totalAmount: 150.00,
  lineItems: [
    { id: "compute", description: "Compute VM", category: "Compute", amount: 70.00 },
    { id: "storage", description: "Disk Storage", category: "Storage", amount: 30.00 },
    { id: "security", description: "DDoS Shield", category: "Security", amount: 50.00 }, // New item
  ],
};
const auditNewItem = executeDiscrepancyAudit(currentWithNewItem, baseStatement, 15.0);
assert.equal(auditNewItem.status, "ANOMALIES_FLAGGED");
assert.equal(auditNewItem.anomalies.length, 1);
assert.equal(auditNewItem.anomalies[0].lineItemId, "security");
assert.equal(auditNewItem.anomalies[0].baselineAmount, 0.0);
assert.equal(auditNewItem.anomalies[0].currentAmount, 50.00);
assert.match(auditNewItem.anomalies[0].reason, /New line item not present in baseline/);
console.log("  ✓ Case D: New line item correctly flagged with 0.0 baseline.");

// Case E: Discontinued line item (present in baseline, absent in current)
const currentRemovedItem: StatementPayload = {
  ...baseStatement,
  statementId: "INV-2026-08-0005",
  totalAmount: 70.00,
  lineItems: [
    { id: "compute", description: "Compute VM", category: "Compute", amount: 70.00 },
    // "storage" line item discontinued
  ],
};
const auditRemovedItem = executeDiscrepancyAudit(currentRemovedItem, baseStatement, 15.0);
assert.equal(auditRemovedItem.status, "ANOMALIES_FLAGGED");
assert.equal(auditRemovedItem.anomalies.length, 1);
assert.equal(auditRemovedItem.anomalies[0].lineItemId, "storage");
assert.equal(auditRemovedItem.anomalies[0].currentAmount, 0.0);
assert.match(auditRemovedItem.anomalies[0].reason, /Discontinued line item absent in current/);
console.log("  ✓ Case E: Removed line item correctly flagged.");

// Case F: Zero baseline handling (no division by zero or NaN)
const baselineZero: StatementPayload = {
  ...baseStatement,
  lineItems: [{ id: "compute", description: "Compute VM", category: "Compute", amount: 0.00 }],
  totalAmount: 0.00,
};
const currentNonZero: StatementPayload = {
  ...baseStatement,
  lineItems: [{ id: "compute", description: "Compute VM", category: "Compute", amount: 25.00 }],
  totalAmount: 25.00,
};
const auditZero = executeDiscrepancyAudit(currentNonZero, baselineZero, 15.0);
assert.equal(auditZero.status, "ANOMALIES_FLAGGED");
assert.equal(auditZero.anomalies[0].diffPercent, 100.0);
assert.equal(Number.isNaN(auditZero.variancePercent), false);
assert.equal(Number.isFinite(auditZero.variancePercent), true);
console.log("  ✓ Case F: Zero-baseline division-by-zero safely avoided.");

// Case G: Audit Hash determinism
const auditHash1 = computeAuditHash(auditIncrease);
const auditHash2 = computeAuditHash(auditIncrease);
assert.equal(auditHash1, auditHash2);
assert.equal(typeof auditHash1, "string");
assert.equal(auditHash1.length, 64);
console.log("  ✓ Case G: Audit hash determinism verified (SHA-256 length 64).");

// Case H: Exact Threshold Boundary Conditions (+14.99%, +15.00%, +15.01%, -14.99%, -15.00%, -15.01%)
const baseBound: StatementPayload = {
  statementId: "INV-BOUND-BASE",
  accountId: "ACC-1",
  billingPeriod: "2026-07",
  issueDate: "2026-08-01",
  currency: "USD",
  totalAmount: 100.00,
  lineItems: [{ id: "item_a", description: "Item A", category: "Test", amount: 100.00 }],
};

const makeBoundCurrent = (amt: number): StatementPayload => ({
  ...baseBound,
  statementId: "INV-BOUND-CUR",
  totalAmount: amt,
  lineItems: [{ id: "item_a", description: "Item A", category: "Test", amount: amt }],
});

// +14.99% -> Within 15.0% threshold (VERIFIED_OK)
const res1499 = executeDiscrepancyAudit(makeBoundCurrent(114.99), baseBound, 15.0);
assert.equal(res1499.status, "VERIFIED_OK");
assert.equal(res1499.anomalies.length, 0);

// +15.00% -> Exactly on 15.0% threshold (VERIFIED_OK, exclusive boundary: abs(diff) > threshold)
const res1500 = executeDiscrepancyAudit(makeBoundCurrent(115.00), baseBound, 15.0);
assert.equal(res1500.status, "VERIFIED_OK");
assert.equal(res1500.anomalies.length, 0);

// +15.01% -> Exceeds 15.0% threshold (ANOMALIES_FLAGGED)
const res1501 = executeDiscrepancyAudit(makeBoundCurrent(115.01), baseBound, 15.0);
assert.equal(res1501.status, "ANOMALIES_FLAGGED");
assert.equal(res1501.anomalies.length, 1);
assert.equal(res1501.anomalies[0].diffPercent, 15.01);

// -14.99% -> Within -15.0% threshold (VERIFIED_OK)
const resMinus1499 = executeDiscrepancyAudit(makeBoundCurrent(85.01), baseBound, 15.0);
assert.equal(resMinus1499.status, "VERIFIED_OK");
assert.equal(resMinus1499.anomalies.length, 0);

// -15.00% -> Exactly on -15.0% threshold (VERIFIED_OK)
const resMinus1500 = executeDiscrepancyAudit(makeBoundCurrent(85.00), baseBound, 15.0);
assert.equal(resMinus1500.status, "VERIFIED_OK");
assert.equal(resMinus1500.anomalies.length, 0);

// -15.01% -> Exceeds -15.0% threshold (ANOMALIES_FLAGGED)
const resMinus1501 = executeDiscrepancyAudit(makeBoundCurrent(84.99), baseBound, 15.0);
assert.equal(resMinus1501.status, "ANOMALIES_FLAGGED");
assert.equal(resMinus1501.anomalies.length, 1);
assert.equal(resMinus1501.anomalies[0].diffPercent, -15.01);

console.log("  ✓ Case H: Threshold boundary conditions (+14.99%, +15.00%, +15.01%, -14.99%, -15.00%, -15.01%) verified.");

// ============================================================================
// 3. Dashboard HTML Generation & Provenance Rendering Tests
// ============================================================================

console.log("\n[Test Suite 3: Dashboard HTML Generation & Provenance Rendering]");

// 1. Dashboard generation succeeds from valid AuditResult
const demoBaseline = getDemoBaselineStatement();
const demoCurrent: StatementPayload = {
  statementId: "INV-2026-08-4912",
  accountId: "ACC-78921-X",
  billingPeriod: "2026-08-01 to 2026-08-31",
  issueDate: "2026-09-01",
  currency: "USD",
  totalAmount: 356.60,
  lineItems: [
    { id: "item_compute_01", description: "High-Memory MicroVM Compute (4 vCPU, 16GB)", category: "Compute", amount: 148.80 },
    { id: "item_storage_02", description: "NVMe Block Storage Allocation", category: "Storage", amount: 25.00 },
    { id: "item_egress_03", description: "Global Edge Network Data Egress", category: "Networking", amount: 37.80 },
    { id: "item_browser_04", description: "Stealth Residential Proxy Sessions (Burst)", category: "Automation", amount: 45.00 },
    { id: "item_support_05", description: "Enterprise Premium Support Plan", category: "Support", amount: 100.00 },
  ],
  rawHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

const demoAudit = executeDiscrepancyAudit(demoCurrent, demoBaseline, 15.0);
const demoAuditHash = computeAuditHash(demoAudit);

const testManifest: VerificationManifest = {
  taskId: "monthly-cloud-billing-audit",
  timestamp: "2026-09-04T12:00:00.000Z",
  statementHash: demoCurrent.rawHash!,
  auditHash: demoAuditHash,
  previewUrl: "https://demo-preview-3000.preview.getsolari.com?token=test_tok_987",
  status: "VERIFIED",
};

const html = generateDashboardHtml(demoCurrent, demoBaseline, demoAudit, testManifest);
assert.ok(typeof html === "string" && html.length > 500);
console.log("  ✓ Req 1: Dashboard generation succeeds from valid AuditResult.");

// 2. Generated HTML contains correct dynamic current total
assert.ok(html.includes("$356.60"), "HTML must include dynamic current total $356.60");
console.log("  ✓ Req 2: Dynamic current total ($356.60) present.");

// 3. Generated HTML contains baseline total
assert.ok(html.includes("$329.80"), "HTML must include dynamic baseline total $329.80");
console.log("  ✓ Req 3: Dynamic baseline total ($329.80) present.");

// 4. Generated HTML contains the anomaly
assert.ok(html.includes("Stealth Residential Proxy Sessions (Burst)"));
assert.ok(html.includes("$20.00 &rarr; $45.00"));
assert.ok(html.includes("+125.00%"));
console.log("  ✓ Req 4: Anomaly details present in flagged section.");

// 5. Generated HTML contains statement hash
assert.ok(html.includes(demoCurrent.rawHash!));
console.log("  ✓ Req 5: Statement SHA-256 fingerprint rendered accurately.");

// 6. Generated HTML contains audit hash
assert.ok(html.includes(demoAuditHash));
console.log("  ✓ Req 6: Audit SHA-256 fingerprint rendered accurately.");

// 7. ANOMALIES_FLAGGED renders correctly
assert.ok(html.includes("ANOMALIES_FLAGGED"));
assert.ok(html.includes("pill-flagged"));
console.log("  ✓ Req 7: ANOMALIES_FLAGGED badge and styling rendered correctly.");

// 8. VERIFIED_OK renders correctly
const okAudit = executeDiscrepancyAudit(demoBaseline, demoBaseline, 15.0);
const okAuditHash = computeAuditHash(okAudit);
const okManifest: VerificationManifest = {
  ...testManifest,
  auditHash: okAuditHash,
};
const okHtml = generateDashboardHtml(demoBaseline, demoBaseline, okAudit, okManifest);
assert.ok(okHtml.includes("VERIFIED_OK"));
assert.ok(okHtml.includes("pill-ok"));
assert.ok(okHtml.includes("No cost discrepancies exceeded the configured variance threshold"));
console.log("  ✓ Req 8: VERIFIED_OK badge and clean status rendered correctly.");

// 9. Preview URL is inserted dynamically rather than hardcoded
const customPreviewUrl = "https://custom-ephemeral-port-tunnel.getsolari.com/verify?token=xyz999";
const dynamicManifest: VerificationManifest = {
  ...testManifest,
  previewUrl: customPreviewUrl,
};
const dynamicHtml = generateDashboardHtml(demoCurrent, demoBaseline, demoAudit, dynamicManifest);
assert.ok(dynamicHtml.includes(customPreviewUrl));
assert.ok(!okHtml.includes(customPreviewUrl));
console.log("  ✓ Req 9: Preview URL inserted dynamically into provenance section.");

// 10. HTML escaping works for externally sourced text
assert.equal(escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#039;');
assert.equal(escapeHtml('"><script>alert(1)</script>'), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');

const xssPayload: StatementPayload = {
  ...demoCurrent,
  statementId: '"><script>alert(1)</script>',
  lineItems: [
    {
      id: "xss_item",
      description: "Exploit <img src=x onerror=alert(1)> & 'quoted'",
      category: "Security & Penetration",
      amount: 356.60,
    },
  ],
};
const xssAudit = executeDiscrepancyAudit(xssPayload, demoBaseline, 15.0);
const xssHtml = generateDashboardHtml(xssPayload, demoBaseline, xssAudit, testManifest);
assert.ok(!xssHtml.includes("<script>alert(1)</script>"));
assert.ok(!xssHtml.includes("<img src=x onerror=alert(1)>"));
assert.ok(xssHtml.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
assert.ok(xssHtml.includes("&lt;img src=x onerror=alert(1)&gt;"));
assert.ok(xssHtml.includes("Security &amp; Penetration"));
console.log("  ✓ Req 10: HTML sanitization and entity escaping verified against XSS vectors.");

// 11. Integrity notice statement check
assert.ok(
  html.includes(
    "The SHA-256 fingerprint makes changes to the represented data detectable across pipeline stages. It does not prove that the originating billing provider&#039;s data is economically correct."
  ) ||
    html.includes(
      "The SHA-256 fingerprint makes changes to the represented data detectable across pipeline stages. It does not prove that the originating billing provider's data is economically correct."
    )
);
console.log("  ✓ Req 11: Cryptographic integrity notice accurately presented.");

console.log("\nAll LifeOps validation unit tests passed cleanly!");
