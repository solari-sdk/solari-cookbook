import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

const MAX_LOG_CHARS = 16_000

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function capabilityFingerprint(value: string): string {
  return sha256Text(value).slice(0, 16)
}

export function publicPreviewUrl(value: string): string {
  const url = new URL(value)
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function scrubOutput(value: string, secrets: string[] = []): string {
  let redacted = value
  for (const secret of new Set(secrets.filter(Boolean))) redacted = redacted.split(secret).join("[REDACTED_SECRET]")
  redacted = redacted
    .replace(/\bslr_live_[A-Za-z0-9_-]+\b/g, "[REDACTED_SOLARI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\/workspace\/repo/g, "[workspace]")
    .replace(/\/home\/[^\s/]+/g, "[home]")
  if (redacted.length <= MAX_LOG_CHARS) return redacted
  return `${redacted.slice(0, MAX_LOG_CHARS)}\n...[truncated]`
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash("sha256").update(bytes).digest("hex")
}
