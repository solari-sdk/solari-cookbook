export function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

export function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

export function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

export function requireSolariKey(): string {
  const key = env("SOLARI_API_KEY");
  if (!key) throw new Error("SOLARI_API_KEY is not set");
  return key;
}

export function openRouterKey(): string | null {
  const key = env("OPENROUTER_API_KEY");
  return key || null;
}
