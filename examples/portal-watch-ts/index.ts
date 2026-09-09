/**
 * Portal Watch — stop manually re-checking a dozen application portals.
 *
 * Point PORTALS (below) at the career-portal pages you're actually tracking
 * and run this on a schedule — cron, a GitHub Action, whatever. Each portal
 * gets its own Solari profile, so login happens once, ever. Every run reads
 * the page with an LLM instead of a CSS selector — so it survives every
 * ATS's different layout — diffs the result against the last run, and only
 * tells you what actually changed.
 *
 * This file also stands up a small mock portal inside a Solari sandbox and
 * checks it twice, simulating the portal changing between visits, so you can
 * see the whole mechanism work end-to-end without handing anyone a real
 * password. Swap in your own portals and mock-portal/ is no longer needed.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"
import { SolariClient } from "@solarisdk/sdk"
import { fetchPortalText } from "./src/track.js"
import { extractStatus } from "./src/extract.js"
import { loadState, saveState } from "./src/state.js"
import type { PortalStatus, TrackedPortal } from "./src/types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8000
const STATE_PATH = path.join(__dirname, "out", "state.json")

// Real usage: one entry per portal you're tracking, each with its own
// profile name. `url` for the demo entry is filled in once the mock portal
// (served from a sandbox, below) is live.
const PORTAL: TrackedPortal = {
  name: "Acme (SWE Intern)",
  url: "",
  profileName: "portal-watch-acme-demo",
}

async function runCheck(
  anthropic: Anthropic,
  portal: TrackedPortal,
  state: Record<string, PortalStatus>,
): Promise<void> {
  const text = await fetchPortalText(portal)
  const status = await extractStatus(anthropic, text)
  const previous = state[portal.name]
  state[portal.name] = status

  const label = status.detail ? `${status.stage}: ${status.detail}` : status.stage
  if (!previous) {
    console.log(`[${portal.name}] first check — ${label}`)
  } else if (previous.stage !== status.stage || previous.detail !== status.detail) {
    console.log(`[${portal.name}] CHANGED — ${previous.stage} -> ${label}`)
  } else {
    console.log(`[${portal.name}] no change (${label})`)
  }
}

async function main() {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    // Only needed for an identity-linked key — see README.
    defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
      ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
      : undefined,
  })
  const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true })

  const sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 })
  console.log("sandbox:", sandbox.sandboxId)

  try {
    await sandbox.connect()

    const serveStage = async (stage: "stage-1" | "stage-2") => {
      for (const file of ["index.html", "app.js"]) {
        const contents = await fs.readFile(path.join(__dirname, "mock-portal", stage, file), "utf8")
        await sandbox.files.write(`/app/${file}`, contents)
      }
    }

    await serveStage("stage-1")
    // Background it with a shell — commands.run waits for the process to
    // exit, so running the server in the foreground would block forever.
    await sandbox.commands.run("sh", {
      args: ["-c", `cd /app && nohup python3 -m http.server ${PORT} >/dev/null 2>&1 &`],
    })
    const { url } = await sandbox.previewUrl(PORT)
    PORTAL.url = url
    console.log("mock portal live:", url)

    const state = await loadState(STATE_PATH)

    console.log("\n--- check 1 (application just submitted) ---")
    await runCheck(anthropic, PORTAL, state)
    await saveState(STATE_PATH, state)

    console.log("\n--- a week passes: Acme updates the portal ---")
    await serveStage("stage-2")

    console.log("\n--- check 2 (this is what a scheduled run would see) ---")
    await runCheck(anthropic, PORTAL, state)
    await saveState(STATE_PATH, state)
  } finally {
    // Destroys the VM. close() alone would only drop the local control
    // channel and leave it running until the idle timeout.
    await sandbox.kill()
  }
}

main()
