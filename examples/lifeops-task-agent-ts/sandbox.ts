/**
 * LifeOps Sandbox Compute & Audit Engine.
 *
 * Provisions an ephemeral, isolated Linux microVM (`@solarisdk/sdk` / Solari Sandbox)
 * to perform independent financial discrepancy analysis and cryptographic provenance tracking.
 *
 * Implements a strict zero-trust boundary:
 * 1. Untrusted Browser-derived statement data and deterministic baseline are ingested via `files.write()`.
 * 2. An independent in-guest audit script performs boundary validation and mathematical analysis.
 * 3. Results are retrieved via `files.readText()`, validated on host, and hashed (`auditHash`).
 * 4. MicroVM is unconditionally destroyed via `sandbox.kill()` in a `try/finally` block.
 */

import crypto from "node:crypto";
import type { Sandbox, SolariClient } from "@solarisdk/sdk";
import type {
  AuditAnomaly,
  AuditResult,
  StatementPayload,
  TaskConfig,
  VerificationManifest,
} from "./types.js";

/**
 * Standalone Python audit script executed inside the isolated Solari microVM.
 * Requires only standard library (json, sys, argparse, math).
 */
export const PYTHON_AUDIT_SCRIPT = `#!/usr/bin/env python3
import json
import sys
import argparse
from datetime import datetime, timezone

def parse_args():
    parser = argparse.ArgumentParser(description="LifeOps Isolated Discrepancy Auditor")
    parser.add_argument("--current", default="/workspace/current-statement.json", help="Path to current statement JSON")
    parser.add_argument("--baseline", default="/workspace/baseline-statement.json", help="Path to historical baseline statement JSON")
    parser.add_argument("--threshold", type=float, default=15.0, help="Variance anomaly threshold percentage")
    parser.add_argument("--output", default="/workspace/audit-result.json", help="Output path for AuditResult JSON")
    return parser.parse_args()

def validate_statement(payload, label):
    required = ["statementId", "billingPeriod", "totalAmount", "lineItems"]
    for field in required:
        if field not in payload:
            raise ValueError(f"Boundary validation failed for {label}: missing '{field}'")

    if not isinstance(payload["lineItems"], list) or len(payload["lineItems"]) == 0:
        raise ValueError(f"Boundary validation failed for {label}: lineItems must be a non-empty list")

    calc_sum = 0.0
    for idx, item in enumerate(payload["lineItems"]):
        if "id" not in item or "amount" not in item:
            raise ValueError(f"Line item at index {idx} in {label} missing required 'id' or 'amount'")
        amt = float(item["amount"])
        if amt < 0:
            raise ValueError(f"Line item {item.get('id')} has negative amount: {amt}")
        calc_sum += amt

    declared = float(payload["totalAmount"])
    if abs(calc_sum - declared) > 0.02:
        raise ValueError(f"Arithmetic integrity failed for {label}: declared total ({declared}) != items sum ({calc_sum:.2f})")

def main():
    args = parse_args()

    try:
        with open(args.current, "r", encoding="utf-8") as f:
            current = json.load(f)
        with open(args.baseline, "r", encoding="utf-8") as f:
            baseline = json.load(f)

        validate_statement(current, "current statement")
        validate_statement(baseline, "baseline statement")
    except Exception as e:
        sys.stderr.write(f"In-guest validation error: {str(e)}\\n")
        sys.exit(1)

    threshold = float(args.threshold)
    baseline_map = {item["id"]: item for item in baseline["lineItems"]}
    current_map = {item["id"]: item for item in current["lineItems"]}

    anomalies = []

    # 1. Compare current items against baseline
    for item_id, cur_item in current_map.items():
        cur_amt = round(float(cur_item["amount"]), 2)
        desc = cur_item.get("description", item_id)

        if item_id in baseline_map:
            base_item = baseline_map[item_id]
            base_amt = round(float(base_item["amount"]), 2)

            if base_amt > 0:
                diff_percent = round(((cur_amt - base_amt) / base_amt) * 100.0, 2)
            elif base_amt == 0 and cur_amt > 0:
                diff_percent = 100.0
            else:
                diff_percent = 0.0

            if abs(diff_percent) > threshold:
                direction = "increased" if diff_percent > 0 else "decreased"
                reason = f"Cost {direction} by {abs(diff_percent):.2f}% (from \${base_amt:.2f} to \${cur_amt:.2f}), exceeding {threshold:.1f}% threshold"
                anomalies.append({
                    "lineItemId": item_id,
                    "description": desc,
                    "baselineAmount": base_amt,
                    "currentAmount": cur_amt,
                    "diffPercent": diff_percent,
                    "reason": reason
                })
        else:
            # New line item not present in baseline
            anomalies.append({
                "lineItemId": item_id,
                "description": desc,
                "baselineAmount": 0.0,
                "currentAmount": cur_amt,
                "diffPercent": 100.0,
                "reason": f"New line item not present in baseline statement ({baseline.get('statementId', 'baseline')})"
            })

    # 2. Check for removed line items (present in baseline, absent in current)
    for item_id, base_item in baseline_map.items():
        if item_id not in current_map:
            base_amt = round(float(base_item["amount"]), 2)
            anomalies.append({
                "lineItemId": item_id,
                "description": base_item.get("description", item_id),
                "baselineAmount": base_amt,
                "currentAmount": 0.0,
                "diffPercent": -100.0,
                "reason": f"Discontinued line item absent in current statement ({current.get('statementId', 'current')})"
            })

    base_total = round(float(baseline["totalAmount"]), 2)
    cur_total = round(float(current["totalAmount"]), 2)
    var_amount = round(cur_total - base_total, 2)
    var_percent = round(((cur_total - base_total) / base_total) * 100.0, 2) if base_total > 0 else 0.0

    status = "ANOMALIES_FLAGGED" if len(anomalies) > 0 else "VERIFIED_OK"

    audit_result = {
        "status": status,
        "baselinePeriod": baseline["billingPeriod"],
        "currentPeriod": current["billingPeriod"],
        "baselineTotal": base_total,
        "currentTotal": cur_total,
        "varianceAmount": var_amount,
        "variancePercent": var_percent,
        "anomalies": anomalies,
        "auditedAt": datetime.now(timezone.utc).isoformat()
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(audit_result, f, indent=2)

    print(f"[Guest Audit] Completed. Status: {status}, Anomalies: {len(anomalies)}, Net Variance: \${var_amount:+.2f} ({var_percent:+.2f}%)")

if __name__ == "__main__":
    main()
`;

/**
 * Pure TypeScript implementation of the discrepancy audit algorithm.
 * Used for offline unit verification without consuming Solari API credits.
 */
export function executeDiscrepancyAudit(
  current: StatementPayload,
  baseline: StatementPayload,
  varianceThresholdPercent: number
): AuditResult {
  const baselineMap = new Map(baseline.lineItems.map((item) => [item.id, item]));
  const currentMap = new Map(current.lineItems.map((item) => [item.id, item]));
  const anomalies: AuditAnomaly[] = [];

  // 1. Compare current items against baseline
  for (const [itemId, curItem] of currentMap.entries()) {
    const curAmt = Math.round(curItem.amount * 100) / 100;
    const baseItem = baselineMap.get(itemId);

    if (baseItem) {
      const baseAmt = Math.round(baseItem.amount * 100) / 100;
      let diffPercent = 0.0;

      if (baseAmt > 0) {
        diffPercent = Math.round(((curAmt - baseAmt) / baseAmt) * 10000) / 100;
      } else if (baseAmt === 0 && curAmt > 0) {
        diffPercent = 100.0;
      }

      if (Math.abs(diffPercent) > varianceThresholdPercent) {
        const direction = diffPercent > 0 ? "increased" : "decreased";
        anomalies.push({
          lineItemId: itemId,
          description: curItem.description,
          baselineAmount: baseAmt,
          currentAmount: curAmt,
          diffPercent,
          reason: `Cost ${direction} by ${Math.abs(diffPercent).toFixed(2)}% (from $${baseAmt.toFixed(2)} to $${curAmt.toFixed(2)}), exceeding ${varianceThresholdPercent.toFixed(1)}% threshold`,
        });
      }
    } else {
      // New line item not present in baseline
      anomalies.push({
        lineItemId: itemId,
        description: curItem.description,
        baselineAmount: 0.0,
        currentAmount: curAmt,
        diffPercent: 100.0,
        reason: `New line item not present in baseline statement (${baseline.statementId})`,
      });
    }
  }

  // 2. Check for removed line items (present in baseline, absent in current)
  for (const [itemId, baseItem] of baselineMap.entries()) {
    if (!currentMap.has(itemId)) {
      const baseAmt = Math.round(baseItem.amount * 100) / 100;
      anomalies.push({
        lineItemId: itemId,
        description: baseItem.description,
        baselineAmount: baseAmt,
        currentAmount: 0.0,
        diffPercent: -100.0,
        reason: `Discontinued line item absent in current statement (${current.statementId})`,
      });
    }
  }

  const baselineTotal = Math.round(baseline.totalAmount * 100) / 100;
  const currentTotal = Math.round(current.totalAmount * 100) / 100;
  const varianceAmount = Math.round((currentTotal - baselineTotal) * 100) / 100;
  const variancePercent =
    baselineTotal > 0
      ? Math.round(((currentTotal - baselineTotal) / baselineTotal) * 10000) / 100
      : 0.0;

  const status = anomalies.length > 0 ? "ANOMALIES_FLAGGED" : "VERIFIED_OK";

  return {
    status,
    baselinePeriod: baseline.billingPeriod,
    currentPeriod: current.billingPeriod,
    baselineTotal,
    currentTotal,
    varianceAmount,
    variancePercent,
    anomalies,
    auditedAt: new Date().toISOString(),
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint of the resulting AuditResult.
 *
 * IMPORTANT:
 * This hash provides a cryptographic integrity fingerprint of the audit computation
 * to verify execution provenance and tamper-evident auditing. It does NOT certify
 * that the audited financial items themselves are economically truthful.
 */
export function computeAuditHash(result: AuditResult): string {
  const canonical = {
    status: result.status,
    baselinePeriod: result.baselinePeriod,
    currentPeriod: result.currentPeriod,
    baselineTotal: result.baselineTotal.toFixed(2),
    currentTotal: result.currentTotal.toFixed(2),
    varianceAmount: result.varianceAmount.toFixed(2),
    variancePercent: result.variancePercent.toFixed(2),
    anomalies: result.anomalies.map((a) => ({
      lineItemId: a.lineItemId,
      description: a.description,
      baselineAmount: a.baselineAmount.toFixed(2),
      currentAmount: a.currentAmount.toFixed(2),
      diffPercent: a.diffPercent.toFixed(2),
      reason: a.reason,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Assembles the final VerificationManifest binding execution provenance across stages.
 */
export function buildVerificationManifest(
  taskId: string,
  statementHash: string,
  auditHash: string,
  metadata: {
    browserSessionId?: string;
    sandboxId?: string;
    previewUrl?: string;
    status?: "PENDING" | "VERIFIED" | "FAILED";
  } = {}
): VerificationManifest {
  return {
    taskId,
    timestamp: new Date().toISOString(),
    browserSessionId: metadata.browserSessionId,
    sandboxId: metadata.sandboxId,
    statementHash,
    auditHash,
    previewUrl: metadata.previewUrl,
    status: metadata.status ?? "VERIFIED",
  };
}

/**
 * Validates the raw JSON result returned from the isolated Sandbox microVM.
 */
function validateHostAuditResult(result: unknown): asserts result is AuditResult {
  if (!result || typeof result !== "object") {
    throw new Error("Sandbox audit result validation failed: expected JSON object");
  }
  const r = result as Record<string, unknown>;
  if (r.status !== "VERIFIED_OK" && r.status !== "ANOMALIES_FLAGGED") {
    throw new Error(`Invalid audit status returned from sandbox: "${String(r.status)}"`);
  }
  if (typeof r.baselineTotal !== "number" || typeof r.currentTotal !== "number") {
    throw new Error("Invalid or missing financial totals in sandbox audit result");
  }
  if (!Array.isArray(r.anomalies)) {
    throw new Error("Missing anomalies list in sandbox audit result");
  }
}

export interface AuditOptions {
  /** If true, returns the active Sandbox instance for downstream serving, delegating teardown to caller */
  keepAlive?: boolean;
}

/**
 * Executes Step 2 of the LifeOps pipeline inside an isolated Solari Sandbox microVM.
 *
 * Boots an ephemeral Linux microVM, writes the current and historical statements,
 * runs the isolated audit script, retrieves the result, and optionally keeps the VM alive
 * for Phase 4 port preview dashboard serving.
 */
export async function auditStatementInSandbox(
  statement: StatementPayload,
  baseline: StatementPayload,
  config: TaskConfig,
  client: SolariClient,
  options: AuditOptions = {}
): Promise<{ auditResult: AuditResult; sandboxId: string; sandbox?: Sandbox }> {
  console.log(`[Sandbox Engine] Provisioning isolated Solari Sandbox microVM (template: "base")...`);

  // Create ephemeral hardware-isolated microVM
  const sandbox = await client.sandboxes.create({
    template: "base",
    timeoutMs: 5 * 60_000,
  });

  const redactedId = sandbox.sandboxId.slice(0, 16) + "...";
  console.log(`[Sandbox Engine] MicroVM booted successfully (id: ${redactedId})`);

  let shouldKill = !options.keepAlive;
  try {
    console.log(`[Sandbox Engine] Connecting secure control channel...`);
    await sandbox.connect();

    console.log(`[Sandbox Engine] Initializing guest workspace directory...`);
    await sandbox.commands.run("mkdir", { args: ["-p", "/workspace"] });

    console.log(`[Sandbox Engine] Transferring current statement (${statement.statementId}) and baseline (${baseline.statementId})...`);
    await sandbox.files.write("/workspace/current-statement.json", JSON.stringify(statement, null, 2));
    await sandbox.files.write("/workspace/baseline-statement.json", JSON.stringify(baseline, null, 2));
    await sandbox.files.write("/workspace/audit.py", PYTHON_AUDIT_SCRIPT);

    console.log(`[Sandbox Engine] Executing isolated discrepancy audit (threshold: ${config.varianceThresholdPercent}%)...`);
    const execRes = await sandbox.commands.run("python3", {
      args: ["/workspace/audit.py", "--threshold", String(config.varianceThresholdPercent)],
    });

    if (execRes.exitCode !== 0) {
      const errOut = execRes.stderr.trim() || execRes.stdout.trim();
      throw new Error(`Sandbox in-guest audit failed (exit code ${execRes.exitCode}): ${errOut}`);
    }

    if (execRes.stdout.trim()) {
      console.log(`[Sandbox Engine] In-guest output: ${execRes.stdout.trim()}`);
    }

    console.log(`[Sandbox Engine] Reading verified audit artifacts from guest filesystem...`);
    const auditRaw = await sandbox.files.readText("/workspace/audit-result.json");
    const parsedResult: unknown = JSON.parse(auditRaw);

    validateHostAuditResult(parsedResult);
    console.log(`[Sandbox Engine] Audit result verified on host. Status: ${parsedResult.status}`);

    if (options.keepAlive) {
      shouldKill = false;
      return {
        auditResult: parsedResult,
        sandboxId: sandbox.sandboxId,
        sandbox,
      };
    }

    return {
      auditResult: parsedResult,
      sandboxId: sandbox.sandboxId,
    };
  } finally {
    if (shouldKill) {
      console.log(`[Sandbox Engine] Destroying remote microVM session...`);
      await sandbox.kill();
      console.log(`[Sandbox Engine] Sandbox VM destroyed cleanly.`);
    }
  }
}

/**
 * Starts a minimal in-guest Python HTTP server serving the generated dashboard
 * from /workspace/index.html and activates a public Solari Port Preview URL.
 */
export async function serveVerificationDashboard(
  sandbox: Sandbox,
  dashboardHtml: string,
  port: number = 3000,
  existingUrl?: string
): Promise<string> {
  console.log(`[Sandbox Dashboard] Ingesting verification dashboard into guest filesystem (/workspace/index.html)...`);
  await sandbox.files.write("/workspace/index.html", dashboardHtml);

  console.log(`[Sandbox Dashboard] Launching in-guest HTTP server on port ${port}...`);
  // Background with nohup via sh -c so commands.run returns immediately
  const launchRes = await sandbox.commands.run("sh", {
    args: ["-c", `cd /workspace && nohup python3 -m http.server ${port} >/dev/null 2>&1 &`],
  });

  if (launchRes.exitCode !== 0) {
    throw new Error(`Failed to start in-guest HTTP server on port ${port}: ${launchRes.stderr}`);
  }

  let url = existingUrl;
  if (!url) {
    console.log(`[Sandbox Dashboard] Requesting live Solari preview tunnel for port ${port}...`);
    const previewRes = await sandbox.previewUrl(port);
    url = previewRes.url;
  }

  console.log(`[Sandbox Dashboard] Verifying preview tunnel reachability...`);
  let reachable = false;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const probe = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (probe.ok) {
        reachable = true;
        break;
      }
    } catch {
      // Tunnel warming up, retry
    }
  }

  if (!reachable) {
    console.warn(`[Sandbox Dashboard] Warning: Tunnel did not respond within 12s, but preview URL is active.`);
  } else {
    console.log(`[Sandbox Dashboard] Preview tunnel verified active and reachable.`);
  }

  return url;
}
