/**
 * Kill leftover sandboxes.
 *
 *   npm run cleanup
 *
 * The plan here allows ONE concurrent session, so a single orphan blocks every
 * later run with `ConcurrencyLimitExceeded`. Orphans happen when a run is
 * interrupted hard enough that its cleanup never executes — Ctrl-C twice,
 * a killed terminal, a crash.
 *
 * Pass --dry to list without killing.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SolariClient } from "@solarisdk/sdk"

import { loadEnv } from "../src/env.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
loadEnv(join(ROOT, ".env"))

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("\n  SOLARI_API_KEY is not set.\n")
  process.exit(1)
}

const dry = process.argv.includes("--dry")
const client = new SolariClient({ apiKey })

// The list returns `sandboxId`, not `id`.
const found: { sandboxId: string; state?: string; template?: string }[] = []
for await (const s of client.sandboxes.listAll()) {
  const view = s as unknown as { sandboxId: string; state?: string; template?: string }
  if (view.state && !["running", "paused", "starting"].includes(view.state)) continue
  found.push(view)
}

if (!found.length) {
  console.log("\n  no live sandboxes\n")
  process.exit(0)
}

console.log(`\n  ${found.length} live sandbox(es)`)
for (const s of found) {
  if (dry) {
    console.log(`    ${s.state ?? "?"}  ${s.template ?? ""}  ${s.sandboxId.slice(0, 24)}…  (dry run)`)
    continue
  }
  await client.sandboxes.kill(s.sandboxId).then(
    () => console.log(`    killed ${s.state ?? "?"} ${s.sandboxId.slice(0, 24)}…`),
    (err: Error) => console.log(`    failed ${s.sandboxId.slice(0, 24)}…: ${err.message}`),
  )
}
console.log()
