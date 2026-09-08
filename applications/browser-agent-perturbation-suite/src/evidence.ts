import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SuiteResult } from "./aggregate.js"
import type { ServerState } from "./verify.js"

/**
 * Anything that identifies a Solari session, VM or preview URL is stripped
 * before it is written.
 *
 * Those strings are credentials or capability URLs, and an evidence bundle is
 * exactly the sort of thing that gets attached to a bug report. They are printed
 * to the terminal when a release fails and you may need to clean up by hand;
 * they do not go on disk.
 *
 * The patterns have to survive *error text*, not just our own structured fields.
 * A failed `readState` arrives as `getaddrinfo ENOTFOUND <host>` with no scheme,
 * and `@solarisdk/browser` builds messages by interpolating whole response
 * bodies — which carry presigned storage and replay links. Both used to pass
 * straight through, so both are covered below and in test/evidence.test.ts.
 */
const SECRETS = [
  /slr_(?:live|test)_[A-Za-z0-9_-]+/g,
  /wss?:\/\/[^\s"']+/g,
  // Scheme-optional: a DNS or connect failure surfaces the bare hostname.
  /(?:https?:\/\/)?[A-Za-z0-9-]+\.preview\.getsolari\.com[^\s"']*/g,
  /pt_token=[A-Za-z0-9._-]+/g,
  // Presigned links, whatever the storage vendor calls the parameter.
  /https?:\/\/[^\s"'\\]*[?&][^\s"'\\]*(?:signature|credential|token|expires)=[^\s"'\\]*/gi,
  // Our own release-failure label, which carries the session id.
  /browser session [A-Za-z0-9_-]+/g,
]

/**
 * Scrub every string in a structure, leaving its shape alone.
 *
 * Walking the value rather than rewriting `JSON.stringify` output is the whole
 * point: on the serialized form a pattern that stops at `"` also eats the
 * backslash escaping it, which silently corrupts the document — and the payload
 * most likely to trigger that is an SDK error message with a JSON body
 * interpolated into it, which is exactly the text we most need to redact.
 */
export function redact<T>(value: T): T {
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (typeof value === "string") {
    let scrubbed = value
    for (const pattern of SECRETS) scrubbed = scrubbed.replace(pattern, "[redacted]")
    return scrubbed
  }
  if (Array.isArray(value)) return value.map(walk)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]))
  }
  return value
}

export interface Evidence {
  trialId: string
  serverState: ServerState | null
  screenshot: Uint8Array | null
}

/**
 * Write the run to disk: the suite result, and per trial the verdict, the
 * server's own ordered timeline, the agent's claim, and a screenshot.
 *
 * The timeline and the claim sit in the same file on purpose. When they
 * disagree — "Reached the review page" beside a server that recorded one
 * blocked click — that gap is the most informative thing the run produced.
 */
export async function writeEvidence(
  directory: string,
  result: SuiteResult,
  evidence: Evidence[],
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(redact(result), null, 2) + "\n",
  )

  for (const item of evidence) {
    const trialDir = join(directory, item.trialId)
    await mkdir(trialDir, { recursive: true })

    const trial = result.trials.find((t) => t.id === item.trialId)
    await writeFile(
      join(trialDir, "trial.json"),
      JSON.stringify(
        redact({
          trial,
          // The server's record of what actually happened, in order.
          serverTimeline: item.serverState?.timeline ?? null,
          serverState: item.serverState,
          // Recorded, never scored.
          agentClaim: trial?.agent ?? null,
        }),
        null,
        2,
      ) + "\n",
    )

    if (item.screenshot) {
      await writeFile(join(trialDir, "final.png"), item.screenshot)
    }
  }
}
