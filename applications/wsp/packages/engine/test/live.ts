import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Live tests run only when explicitly invoked with WSP_LIVE=1; default
// `pnpm test` must stay green with no credentials present.
export const LIVE = process.env.WSP_LIVE === "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface LiveEnv { SOLARI_API_KEY: string; ANTHROPIC_API_KEY: string }

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(join(root, ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export function liveEnv(): LiveEnv {
  const out = readEnv();
  for (const k of ["SOLARI_API_KEY", "ANTHROPIC_API_KEY"] as const) {
    if (!out[k]) throw new Error(`Missing ${k} in .env at repo root`);
  }
  return out as unknown as LiveEnv;
}

/** The Solari key alone, for files that boot machines and never run Claude. */
export function solariKey(): string {
  const key = readEnv().SOLARI_API_KEY;
  if (!key) throw new Error("Missing SOLARI_API_KEY in .env at repo root");
  return key;
}

// Env for any machine that runs Claude Code. Config dir on purpose: carried
// by snapshots, never HOME. bash -c callers rely on PATH carrying .local/bin.
export function claudeEnvs(env: LiveEnv): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    CLAUDE_CONFIG_DIR: "/root/.claude-cfg",
    IS_SANDBOX: "1",
    PATH: "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

/** Sleeping experiments on the account carry a poc label (ttl-test, p1, ...): never touch them. */
export function isReserved(labels: Record<string, string>): boolean {
  return "poc" in labels;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}
