import readline from "node:readline";
import { type Sandbox, SolariClient } from "@solarisdk/sdk";
import { getEnvConfig } from "./config.js";
import { getDemoBaselineStatement, getDemoCurrentStatement } from "./fixtures.js";
import {
  auditStatementInSandbox,
  computeAuditHash,
  buildVerificationManifest,
  serveVerificationDashboard,
} from "./sandbox.js";
import { generateDashboardHtml } from "./dashboard.js";

async function waitForReview(nonInteractive: boolean, timeoutSec: number): Promise<void> {
  if (nonInteractive) {
    console.log(`[LifeOps] Non-interactive / CI mode active. Keeping preview live for ${timeoutSec}s...`);
    await new Promise((resolve) => setTimeout(resolve, timeoutSec * 1000));
    return;
  }

  console.log("Open the dashboard to review the evidence.");
  console.log("Press Enter after reviewing the report...");

  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const timer = setTimeout(() => {
      console.log("\n[LifeOps] Review window elapsed (60s). Proceeding to cleanup...");
      rl.close();
      resolve();
    }, 60_000);

    rl.question("", () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  console.log("=========================================================");
  console.log("LIFEOPS — VERIFIED BILLING AUDIT");
  console.log("================================\n");

  const env = getEnvConfig();
  console.log(`Variance Threshold: ${env.varianceThresholdPercent}%\n`);

  const solariSdk = new SolariClient({ apiKey: env.apiKey });
  let activeSandbox: Sandbox | null = null;

  const handleSignal = async (sig: string) => {
    console.log(`\n[LifeOps] Received ${sig}. Triggering immediate cleanup...`);
    if (activeSandbox) {
      try {
        await activeSandbox.kill();
      } catch {}
      activeSandbox = null;
    }
    process.exit(130);
  };

  process.once("SIGINT", () => void handleSignal("SIGINT"));
  process.once("SIGTERM", () => void handleSignal("SIGTERM"));

  try {
    // -------------------------------------------------------------------------
    // STAGE 1: Statement Ingestion & Baselines
    // -------------------------------------------------------------------------
    console.log("--- Stage 1: Statement Ingestion ---");
    const current = getDemoCurrentStatement();
    const baseline = getDemoBaselineStatement();

    console.log(`✓ Current statement loaded: ${current.statementId} (${current.billingPeriod}) - Total: $${current.totalAmount.toFixed(2)}`);
    console.log(`✓ Baseline statement loaded: ${baseline.statementId} (${baseline.billingPeriod}) - Total: $${baseline.totalAmount.toFixed(2)}`);
    console.log(`✓ Statement SHA-256 fingerprint: ${current.rawHash}\n`);

    // -------------------------------------------------------------------------
    // STAGE 2: Isolated Sandbox Audit
    // -------------------------------------------------------------------------
    console.log("--- Stage 2: Isolated Sandbox Audit ---");
    const auditRes = await auditStatementInSandbox(
      current,
      baseline,
      env.varianceThresholdPercent,
      solariSdk,
      { keepAlive: true }
    );

    activeSandbox = auditRes.sandbox ?? null;
    const { auditResult, sandboxId } = auditRes;

    console.log("✓ Sandbox microVM provisioned");
    console.log("✓ Current + baseline statements transferred to guest");
    console.log("✓ Discrepancy audit executed inside isolated microVM");
    console.log(`✓ ${auditResult.anomalies.length} anomaly detected`);

    const auditHash = computeAuditHash(auditResult);
    console.log(`✓ Audit SHA-256 fingerprint: ${auditHash}\n`);

    // -------------------------------------------------------------------------
    // STAGE 3: In-Guest Dashboard & Live Port Preview
    // -------------------------------------------------------------------------
    console.log("--- Stage 3: Verification Dashboard & Port Preview ---");
    if (!activeSandbox) {
      throw new Error("Active Sandbox instance was lost.");
    }

    const previewRes = await activeSandbox.previewUrl(env.previewPort);
    const previewUrl = previewRes.url;

    const manifest = buildVerificationManifest(
      "monthly-cloud-billing-audit",
      current.rawHash ?? "",
      auditHash,
      {
        sandboxId: sandboxId.slice(0, 16) + "...",
        previewUrl,
        status: "VERIFIED",
      }
    );

    const dashboardHtml = generateDashboardHtml(current, baseline, auditResult, manifest);
    console.log("✓ Dashboard HTML generated");

    await serveVerificationDashboard(
      activeSandbox,
      dashboardHtml,
      env.previewPort,
      previewUrl
    );
    console.log("✓ In-guest HTTP server started on port " + env.previewPort);
    console.log("✓ Solari port preview active\n");

    console.log(`Verification Dashboard: ${previewUrl}\n`);
    console.log(`Status: ${auditResult.status}`);
    console.log(`Net variance: ${auditResult.varianceAmount >= 0 ? "+" : ""}$${auditResult.varianceAmount.toFixed(2)} (${auditResult.variancePercent >= 0 ? "+" : ""}${auditResult.variancePercent.toFixed(2)}%)`);
    console.log(`Anomalies: ${auditResult.anomalies.length}\n`);

    if (auditResult.anomalies.length > 0) {
      for (const a of auditResult.anomalies) {
        console.log(`  ⚠ [${a.lineItemId}] ${a.description}`);
        console.log(`    $${a.baselineAmount.toFixed(2)} → $${a.currentAmount.toFixed(2)} (${a.diffPercent >= 0 ? "+" : ""}${a.diffPercent.toFixed(2)}%) [Threshold: ${env.varianceThresholdPercent}%]`);
        console.log(`    Reason: ${a.reason}`);
      }
      console.log();
    }

    await waitForReview(env.nonInteractive, env.previewTimeoutSec);
  } finally {
    if (activeSandbox) {
      try {
        await activeSandbox.kill();
        console.log("\n✓ Sandbox destroyed");
      } catch (err: unknown) {
        console.error("[Teardown Warning] Failed to kill sandbox:", err);
      }
      activeSandbox = null;
    }
    console.log("✓ Verification session complete.");
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\n[LifeOps Fatal Error]", message);
  process.exit(1);
});
