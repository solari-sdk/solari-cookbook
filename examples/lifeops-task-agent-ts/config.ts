/**
 * Configuration and environment validation for LifeOps Task Agent.
 *
 * Adheres strictly to repository security standards:
 * - Validates required environment variables before execution begins.
 * - Never prints or logs API keys, tokens, session IDs, or secrets to stdout.
 * - Defaults to fully reproducible synthetic/demo mode without requiring real credentials.
 */

import type { TaskConfig } from "./types.js";

// Native .env file loader for Node.js 20.12+ / 24+ without external dependencies
if (!process.env.SOLARI_API_KEY) {
  try {
    if (typeof process.loadEnvFile === "function") {
      process.loadEnvFile();
    }
  } catch {
    // Ignore error if .env file is not present
  }
}

export interface EnvConfig {
  apiKey: string;
  portalUrl?: string;
  stealth: boolean;
  nonInteractive: boolean;
  previewTimeoutSec: number;
  previewPort: number;
}

/**
 * Validates and extracts Solari credentials from the process environment.
 * Throws a helpful, non-leaking error if SOLARI_API_KEY is not set.
 */
export function getEnvConfig(): EnvConfig {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "Missing required environment variable SOLARI_API_KEY.\n" +
      "Please obtain an API key from https://app.getsolari.com and export it:\n" +
      "  export SOLARI_API_KEY=\"slr_live_...\"\n" +
      "or copy .env.example to .env and configure your key."
    );
  }

  const portalUrl = process.env.PORTAL_URL?.trim() || undefined;
  const stealth = process.env.SOLARI_STEALTH === "true";
  const nonInteractive =
    process.env.LIFEOPS_NON_INTERACTIVE === "true" || process.env.CI === "true";
  const rawTimeout = parseInt(process.env.LIFEOPS_PREVIEW_TIMEOUT_SEC || "10", 10);
  const previewTimeoutSec = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10;
  const rawPort = parseInt(process.env.PORT || "3000", 10);
  const previewPort = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;

  return {
    apiKey,
    portalUrl,
    stealth,
    nonInteractive,
    previewTimeoutSec,
    previewPort,
  };
}

/**
 * Returns default configuration for reproducible execution.
 * In demo mode, uses the deterministic local fixture data URL.
 * In custom mode, accepts an external PORTAL_URL override.
 */
export function getDefaultTaskConfig(portalUrlOverride?: string): TaskConfig {
  const portalUrl = portalUrlOverride || process.env.PORTAL_URL?.trim();
  const rawThreshold = process.env.VARIANCE_THRESHOLD_PERCENT
    ? parseFloat(process.env.VARIANCE_THRESHOLD_PERCENT)
    : 15.0;
  const varianceThresholdPercent =
    Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 15.0;

  return {
    taskName: "monthly-cloud-billing-audit",
    targetMode: portalUrl ? "custom" : "demo",
    portalUrl: portalUrl || undefined,
    varianceThresholdPercent,
  };
}
