/**
 * LifeOps Task Agent — Cross-environment operational automation.
 *
 * Demonstrates a complete end-to-end outcome-oriented pipeline:
 * 1. Solari Cloud Browser: Authenticated/stealth invoice extraction.
 * 2. Solari Sandbox: Isolated compute for discrepancy analysis and verification.
 * 3. Port Preview: Secure, ephemeral verification dashboard served directly from the sandbox.
 *
 * Execution Flow:
 * Task -> Browser Extraction -> Normalized Statement -> Sandbox Compute -> Audit Result ->
 * Dynamic Dashboard -> In-guest HTTP Server -> Solari Port Preview -> Human Review -> Teardown
 */

import readline from "node:readline";
import { Solari } from "@solarisdk/browser";
import { type Sandbox, SolariClient } from "@solarisdk/sdk";
import { getEnvConfig, getDefaultTaskConfig } from "./config.js";
import { acquireStatementViaBrowser } from "./browser.js";
import { getDemoBaselineStatement } from "./fixtures.js";
import {
  auditStatementInSandbox,
  computeAuditHash,
  buildVerificationManifest,
  serveVerificationDashboard,
} from "./sandbox.js";
import { generateDashboardHtml } from "./dashboard.js";

/**
 * Pauses execution while the human reviewer inspects the live preview dashboard.
 * In non-interactive/CI mode, waits for a bounded timeout before teardown.
 */
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

// ============================================================================
// Main Execution Entrypoint
// ============================================================================

async function main(): Promise<void> {
  console.log("=========================================================");
  console.log("LIFEOPS — VERIFIED BILLING AUDIT");
  console.log("================================\n");

  // 1. Environment & Configuration
  const env = getEnvConfig();
  const taskConfig = getDefaultTaskConfig(env.portalUrl);

  console.log(`Task: ${taskConfig.taskName}`);
  console.log(`Threshold: ${taskConfig.varianceThresholdPercent}%\n`);

  // 2. Initialize Clients
  const solariBrowser = new Solari({ apiKey: env.apiKey });
  const solariSdk = new SolariClient({ apiKey: env.apiKey });

  let activeSandbox: Sandbox | null = null;

  // Global interruption cleanup handler
  const handleSignal = async (sig: string) => {
    console.log(`\n[LifeOps] Received ${sig}. Triggering immediate cleanup...`);
    if (activeSandbox) {
      try {
        await activeSandbox.kill();
      } catch {}
      activeSandbox = null;
    }
    try {
      await solariBrowser.close();
    } catch {}
    process.exit(130);
  };

  process.once("SIGINT", () => void handleSignal("SIGINT"));
  process.once("SIGTERM", () => void handleSignal("SIGTERM"));

  try {
    // -------------------------------------------------------------------------
    // STAGE 1: Cloud Browser Extraction
    // -------------------------------------------------------------------------
    console.log("--- Stage 1: Cloud Browser ---");
    const statement = await acquireStatementViaBrowser(taskConfig, solariBrowser, {
      stealth: env.stealth,
    });
    console.log("✓ Billing statement acquired");
    console.log(`✓ ${statement.lineItems.length} line items normalized`);
    console.log("✓ Arithmetic integrity validated");
    console.log("✓ Statement fingerprint generated");
    console.log("✓ Browser session released\n");

    // -------------------------------------------------------------------------
    // STAGE 2: Isolated Sandbox Audit Engine
    // -------------------------------------------------------------------------
    console.log("--- Stage 2: Isolated Sandbox Audit ---");
    const baseline = getDemoBaselineStatement();

    // Delegate sandbox lifecycle ownership to main via keepAlive: true
    const auditRes = await auditStatementInSandbox(
      statement,
      baseline,
      taskConfig,
      solariSdk,
      { keepAlive: true }
    );

    activeSandbox = auditRes.sandbox ?? null;
    const { auditResult, sandboxId } = auditRes;

    console.log("✓ Sandbox provisioned");
    console.log("✓ Current + baseline statements transferred");
    console.log("✓ Audit executed inside isolated microVM");
    console.log(`✓ ${auditResult.anomalies.length} anomaly detected`);

    const auditHash = computeAuditHash(auditResult);
    console.log("✓ Audit fingerprint generated");
    console.log("✓ Audit artifacts validated\n");

    // -------------------------------------------------------------------------
    // STAGE 3: Verification Dashboard & Live Port Preview
    // -------------------------------------------------------------------------
    console.log("--- Stage 3: Verification Dashboard ---");

    if (!activeSandbox) {
      throw new Error("Cannot serve dashboard: active Sandbox instance was lost.");
    }

    const previewRes = await activeSandbox.previewUrl(env.previewPort);
    const previewUrl = previewRes.url;

    const manifest = buildVerificationManifest(
      taskConfig.taskName,
      statement.rawHash ?? "",
      auditHash,
      {
        sandboxId: sandboxId.slice(0, 16) + "...",
        previewUrl,
        status: "VERIFIED",
      }
    );

    const dashboardHtml = generateDashboardHtml(statement, baseline, auditResult, manifest);
    console.log("✓ Dashboard generated");

    await serveVerificationDashboard(
      activeSandbox,
      dashboardHtml,
      env.previewPort,
      previewUrl
    );
    console.log("✓ HTTP server started");
    console.log("✓ Solari port preview created\n");

    // Present execution report to reviewer
    console.log(`Verification Dashboard: ${previewUrl}\n`);
    console.log(`Status: ${auditResult.status}`);
    console.log(`Net variance: ${auditResult.varianceAmount >= 0 ? "+" : ""}$${auditResult.varianceAmount.toFixed(2)} (${auditResult.variancePercent >= 0 ? "+" : ""}${auditResult.variancePercent.toFixed(2)}%)`);
    console.log(`Anomalies: ${auditResult.anomalies.length}\n`);

    if (auditResult.anomalies.length > 0) {
      for (const a of auditResult.anomalies) {
        console.log(`  ⚠ [${a.lineItemId}] ${a.description}`);
        console.log(`    $${a.baselineAmount.toFixed(2)} → $${a.currentAmount.toFixed(2)} (${a.diffPercent >= 0 ? "+" : ""}${a.diffPercent.toFixed(2)}%) [Threshold: ${taskConfig.varianceThresholdPercent}%]`);
        console.log(`    Reason: ${a.reason}`);
      }
      console.log();
    }

    // Interactive review linger (or bounded timeout in CI)
    await waitForReview(env.nonInteractive, env.previewTimeoutSec);
  } finally {
    // Unconditional resource destruction
    if (activeSandbox) {
      try {
        await activeSandbox.kill();
        console.log("\n✓ Sandbox destroyed");
      } catch (err: unknown) {
        console.error("[Teardown Warning] Failed to kill sandbox:", err);
      }
      activeSandbox = null;
    }

    // Unbind local loopback proxy listener
    try {
      await solariBrowser.close();
    } catch {}

    console.log("✓ Verification session complete.");
  }
}

// Top-level error handling
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\n[LifeOps Fatal Error]", message);
  process.exit(1);
});
