import { readFileSync } from "node:fs"

/**
 * Minimal .env reader, so `npx tsx scripts/fill.ts` works exactly as the README
 * says without a dotenv dependency or the reader having to remember to source
 * the file first. A quickstart that needs an undocumented shell incantation is
 * a broken quickstart.
 */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line
    const eq = withoutExport.indexOf("=")
    if (eq <= 0) continue

    const name = withoutExport.slice(0, eq).trim()
    if (!name) continue

    // Everything after the FIRST '=' is the value. Tokens and URLs contain '=',
    // and splitting on every one silently truncates them into an auth failure
    // that looks like a wrong key.
    let value = withoutExport.slice(eq + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }

    out[name] = value
  }

  return out
}

/**
 * Load a .env into process.env. Never overwrites a variable that is already
 * set, so an explicit `FOO=bar npx tsx …` still wins over the file.
 */
export function loadEnv(path: string): void {
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return // no .env is fine; the caller reports the missing key it needs
  }

  for (const [name, value] of Object.entries(parseEnv(contents))) {
    if (process.env[name] === undefined) process.env[name] = value
  }
}
