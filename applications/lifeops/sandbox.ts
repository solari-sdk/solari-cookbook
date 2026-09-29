import crypto from "node:crypto";
import { type Sandbox, SolariClient } from "@solarisdk/sdk";
import type {
  AuditResult,
  LineItemAnomaly,
  StatementPayload,
  VerificationManifest,
} from "./types.js";

/**
 * In-guest Python audit script written to /workspace/audit.py inside the microVM.
 * Performs deterministic discrepancy analysis isolated from the host environment.
 */
export const PYTHON_AUDIT_SCRIPT = `import argparse
import json
import sys
from datetime import datetime, timezone

def parse_args():
    parser = argparse.ArgumentParser(description="LifeOps In-Guest Statement Auditor")
    parser.add_argument("--current", default="/workspace/current-statement.json")
    parser.add_argument("--baseline", default="/workspace/baseline-statement.json")
    parser.add_argument("--threshold", type=float, default=15.0)
    parser.add_argument("--output", default="/workspace/audit-result.json")
    return parser.parse_args()

def validate_statement(payload, label):
    required = ["statementId", "billingPeriod", "totalAmount", "lineItems"]
    for field in required:
        if field not in payload:
            raise ValueError(f"Validation failed for {label}: missing '{field}'")

    if not isinstance(payload["lineItems"], list) or len(payload["lineItems"]) == 0:
        raise ValueError(f"Validation failed for {label}: lineItems must be a non-empty list")

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

    # 2. Check for removed line items
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
 * Used for offline unit testing without requiring cloud infrastructure.
 */
export function executeDiscrepancyAudit(
  current: StatementPayload,
  baseline: StatementPayload,
  thresholdPercent: number
): AuditResult {
  const anomalies: LineItemAnomaly[] = [];
  const baselineMap = new Map<string, (typeof baseline.lineItems)[0]>();
  for (const item of baseline.lineItems) {
    baselineMap.set(item.id, item);
  }

  const currentMap = new Map<string, (typeof current.lineItems)[0]>();
  for (const item of current.lineItems) {
    currentMap.set(item.id, item);
  }

  for (const [id, curItem] of currentMap.entries()) {
    const baseItem = baselineMap.get(id);
    if (!baseItem) {
      anomalies.push({
        lineItemId: id,
        description: curItem.description,
        baselineAmount: 0.0,
        currentAmount: curItem.amount,
        diffPercent: 100.0,
        reason: `New line item not present in baseline statement (${baseline.statementId})`,
      });
      continue;
    }

    let diffPercent = 0.0;
    if (baseItem.amount > 0) {
      diffPercent = Number(
        (((curItem.amount - baseItem.amount) / baseItem.amount) * 100.0).toFixed(2)
      );
    } else if (baseItem.amount === 0 && curItem.amount > 0) {
      diffPercent = 100.0;
    }

    if (Math.abs(diffPercent) > thresholdPercent) {
      const direction = diffPercent > 0 ? "increased" : "decreased";
      anomalies.push({
        lineItemId: id,
        description: curItem.description,
        baselineAmount: baseItem.amount,
        currentAmount: curItem.amount,
        diffPercent,
        reason: `Cost ${direction} by ${Math.abs(diffPercent).toFixed(2)}% (from $${baseItem.amount.toFixed(2)} to $${curItem.amount.toFixed(2)}), exceeding ${thresholdPercent.toFixed(1)}% threshold`,
      });
    }
  }

  for (const [id, baseItem] of baselineMap.entries()) {
    if (!currentMap.has(id)) {
      anomalies.push({
        lineItemId: id,
        description: baseItem.description,
        baselineAmount: baseItem.amount,
        currentAmount: 0.0,
        diffPercent: -100.0,
        reason: `Discontinued line item absent in current statement (${current.statementId})`,
      });
    }
  }

  const baselineTotal = Number(baseline.totalAmount.toFixed(2));
  const currentTotal = Number(current.totalAmount.toFixed(2));
  const varianceAmount = Number((currentTotal - baselineTotal).toFixed(2));
  const variancePercent =
    baselineTotal > 0
      ? Number((((currentTotal - baselineTotal) / baselineTotal) * 100.0).toFixed(2))
      : 0.0;

  return {
    status: anomalies.length > 0 ? "ANOMALIES_FLAGGED" : "VERIFIED_OK",
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
 * Computes a deterministic SHA-256 fingerprint of the AuditResult.
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
 * Assembles the VerificationManifest binding execution provenance.
 */
export function buildVerificationManifest(
  taskId: string,
  statementHash: string,
  auditHash: string,
  metadata: {
    sandboxId?: string;
    previewUrl?: string;
    status?: "PENDING" | "VERIFIED" | "FAILED";
  } = {}
): VerificationManifest {
  return {
    taskId,
    timestamp: new Date().toISOString(),
    sandboxId: metadata.sandboxId,
    statementHash,
    auditHash,
    previewUrl: metadata.previewUrl,
    status: metadata.status ?? "VERIFIED",
  };
}

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
  keepAlive?: boolean;
}

/**
 * Executes discrepancy audit inside an isolated Solari Sandbox microVM.
 */
export async function auditStatementInSandbox(
  statement: StatementPayload,
  baseline: StatementPayload,
  varianceThresholdPercent: number,
  client: SolariClient,
  options: AuditOptions = {}
): Promise<{ auditResult: AuditResult; sandboxId: string; sandbox?: Sandbox }> {
  console.log(`[Sandbox Engine] Provisioning isolated Solari Sandbox microVM (template: "base")...`);

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

    console.log(`[Sandbox Engine] Executing isolated discrepancy audit (threshold: ${varianceThresholdPercent}%)...`);
    const execRes = await sandbox.commands.run("python3", {
      args: ["/workspace/audit.py", "--threshold", String(varianceThresholdPercent)],
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
    } catch {}
  }

  if (!reachable) {
    console.warn(`[Sandbox Dashboard] Warning: Tunnel did not respond within 12s, but preview URL is active.`);
  } else {
    console.log(`[Sandbox Dashboard] Preview tunnel verified active and reachable.`);
  }

  return url;
}
