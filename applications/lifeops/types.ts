/**
 * Domain types for LifeOps Verified Billing Audit.
 */

export interface BillingLineItem {
  id: string;
  description: string;
  category?: string;
  amount: number;
  unit?: string;
  quantity?: number;
}

export interface StatementPayload {
  statementId: string;
  accountId: string;
  billingPeriod: string;
  issueDate: string;
  currency: string;
  totalAmount: number;
  lineItems: BillingLineItem[];
  rawHash?: string;
}

export interface LineItemAnomaly {
  lineItemId: string;
  description: string;
  baselineAmount: number;
  currentAmount: number;
  diffPercent: number;
  reason: string;
}

export interface AuditResult {
  status: "VERIFIED_OK" | "ANOMALIES_FLAGGED";
  baselinePeriod: string;
  currentPeriod: string;
  baselineTotal: number;
  currentTotal: number;
  varianceAmount: number;
  variancePercent: number;
  anomalies: LineItemAnomaly[];
  auditedAt: string;
}

export interface VerificationManifest {
  taskId: string;
  timestamp: string;
  statementHash: string;
  auditHash: string;
  sandboxId?: string;
  previewUrl?: string;
  status: "PENDING" | "VERIFIED" | "FAILED";
}
