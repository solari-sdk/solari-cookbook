/**
 * Watchdog + fixer — a self-healing web app.
 *
 *  1. Serve a small (deliberately buggy) todo app from inside a Solari sandbox.
 *  2. Watchdog: an LLM drives a Solari cloud browser against a plain-English
 *     spec and reports exactly how the app broke.
 *  3. Fixer: a second LLM patches the app's source live inside that same
 *     sandbox, using only the watchdog's report as context.
 *  4. Watchdog runs again against the same URL to confirm the fix holds.
 *
 * Two agents, two Solari products, one bug fixed without a human reading a
 * stack trace.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"
import { SolariClient } from "@solarisdk/sdk"
import { runWatchdog } from "./src/watchdog.js"
import { runFixer } from "./src/fixer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = "/app"
const PORT = 8000
const SPEC =
  "Type 'Buy milk' into the input box, click Add, and confirm 'Buy milk' " +
  "appears as an item in the todo list below it."

async function main() {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    // Only needed for an identity-linked key (one tied to your account across
    // multiple workspaces, not scoped to one) — the API 400s asking for this
    // header if you're using one. A workspace-scoped key doesn't need it.
    defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
      ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
      : undefined,
  })
  const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
  const outDir = path.join(__dirname, "out")

  const sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 })
  console.log("sandbox:", sandbox.sandboxId)

  try {
    await sandbox.connect()

    for (const file of ["index.html", "app.js"]) {
      const contents = await fs.readFile(path.join(__dirname, "app", file), "utf8")
      await sandbox.files.write(`${APP_DIR}/${file}`, contents)
    }

    // Background it with a shell — commands.run waits for the process to
    // exit, so running the server in the foreground would block forever.
    await sandbox.commands.run("sh", {
      args: ["-c", `cd ${APP_DIR} && nohup python3 -m http.server ${PORT} >/dev/null 2>&1 &`],
    })
    const { url } = await sandbox.previewUrl(PORT)
    console.log("app live:", url)

    console.log("\n--- watchdog: first pass ---")
    const first = await runWatchdog({ anthropic, url, spec: SPEC, outDir })

    if (first.passed) {
      console.log("no bug found:", first.summary)
      return
    }

    console.log("bug found:", first.summary)
    console.log("console errors:", first.consoleErrors)
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(path.join(outDir, "bug-report.json"), JSON.stringify(first, null, 2))
    console.log("evidence saved to", outDir)

    console.log("\n--- fixer: patching inside the sandbox ---")
    const fix = await runFixer({ anthropic, sandbox, appDir: APP_DIR, bug: first })
    console.log("fix applied:", fix.summary, fix.filesChanged)

    console.log("\n--- watchdog: confirming the fix ---")
    const second = await runWatchdog({ anthropic, url, spec: SPEC, outDir })
    console.log(second.passed ? `PASS: ${second.summary}` : `STILL FAILING: ${second.summary}`)
  } finally {
    // Destroys the VM. close() alone would only drop the local control
    // channel and leave it running until the idle timeout.
    await sandbox.kill()
  }
}

main()
