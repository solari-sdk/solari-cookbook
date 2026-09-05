/**
 * Core domain contracts for the LifeOps Task Agent.
 *
 * Intentionally lean and domain-specific to maintain Solari Cookbook
 * simplicity without heavy enterprise domain abstractions.
 */

/**
 * Configuration and operational parameters for a LifeOps task run.
 */
export interface TaskConfig {
  /** Descriptive name of the task (e.g., "monthly-cloud-billing-audit") */
  taskName: string;
  /** Target execution mode: "demo" uses reproducible synthetic data; "custom" targets live portal */
  targetMode: "demo" | "custom";
  /** Optional URL for the target billing portal */
  portalUrl?: string;
  /** Variance percentage threshold to flag as an anomaly (e.g., 15 for 15% increase) */
  varianceThresholdPercent: number;
}

/**
 * Individual item within a normalized billing statement.
 */
export interface StatementLineItem {
  id: string;
  description: string;
  category: string;
  amount: number;
  unit?: string;
  quantity?: number;
}

/**
 * Normalized billing statement or invoice data extracted via Solari Browser.
 * Structured data representation prevents raw HTML/DOM propagation to downstream analysis.
 */
export interface StatementPayload {
  statementId: string;
  accountId: string;
  billingPeriod: string;
  issueDate: string;
  lineItems: StatementLineItem[];
  totalAmount: number;
  currency: string;
  rawHash?: string;
}

/**
 * Individual financial discrepancy flagged during isolated audit comparison.
 */
export interface AuditAnomaly {
  lineItemId: string;
  description: string;
  baselineAmount: number;
  currentAmount: number;
  diffPercent: number;
  reason: string;
}

/**
 * Results of isolated discrepancy analysis performed inside Solari Sandbox.
 */
export interface AuditResult {
  status: "VERIFIED_OK" | "ANOMALIES_FLAGGED";
  baselinePeriod: string;
  currentPeriod: string;
  baselineTotal: number;
  currentTotal: number;
  varianceAmount: number;
  variancePercent: number;
  anomalies: AuditAnomaly[];
  auditedAt: string;
}

/**
 * Execution provenance and cryptographic verification manifest.
 * Binds browser extraction session, sandbox audit VM, data hashes, and verification report.
 */
export interface VerificationManifest {
  taskId: string;
  timestamp: string;
  browserSessionId?: string;
  sandboxId?: string;
  statementHash: string;
  auditHash: string;
  previewUrl?: string;
  status: "PENDING" | "VERIFIED" | "FAILED";
}
