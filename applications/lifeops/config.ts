import fs from "node:fs";
import path from "node:path";

export interface EnvConfig {
  apiKey: string;
  varianceThresholdPercent: number;
  previewPort: number;
  previewTimeoutSec: number;
  nonInteractive: boolean;
}

function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

export function getEnvConfig(): EnvConfig {
  loadEnvFile();

  const apiKey = process.env.SOLARI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Missing required environment variable: SOLARI_API_KEY.\n" +
      "Provide it in .env or pass it directly:\n" +
      "  export SOLARI_API_KEY=\"slr_live_...\"\n" +
      "Obtain an API key at https://console.getsolari.com"
    );
  }

  const rawThreshold = process.env.VARIANCE_THRESHOLD_PERCENT
    ? Number.parseFloat(process.env.VARIANCE_THRESHOLD_PERCENT)
    : 15.0;
  const varianceThresholdPercent =
    Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 15.0;

  const rawPort = process.env.LIFEOPS_PREVIEW_PORT
    ? Number.parseInt(process.env.LIFEOPS_PREVIEW_PORT, 10)
    : 3000;
  const previewPort = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;

  const rawTimeout = process.env.LIFEOPS_PREVIEW_TIMEOUT_SEC
    ? Number.parseInt(process.env.LIFEOPS_PREVIEW_TIMEOUT_SEC, 10)
    : 10;
  const previewTimeoutSec =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10;

  const nonInteractive =
    process.env.LIFEOPS_NON_INTERACTIVE === "true" ||
    process.env.CI === "true" ||
    process.env.DEBIAN_FRONTEND === "noninteractive";

  return {
    apiKey,
    varianceThresholdPercent,
    previewPort,
    previewTimeoutSec,
    nonInteractive,
  };
}
