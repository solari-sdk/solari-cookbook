/**
 * Pass 1 — prove Sandbox → preview URL → recorded Solari Browser → checkout.
 *
 * One successful checkout only. No 20-run hunter, no forced race.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SolariClient } from "@solarisdk/sdk"
import { Solari } from "@solarisdk/browser"
import { FIXTURE_HTML } from "./fixture.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_PY = readFileSync(join(HERE, "..", "fixture", "server.py"), "utf8")

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("Missing SOLARI_API_KEY")
  process.exit(1)
}
if (!apiKey.startsWith("slr_live_")) {
  console.error("SOLARI_API_KEY does not look like a Solari key")
  process.exit(1)
}

const PORT = 3000
const pt = new SolariClient({ apiKey })
const solari = new Solari({ apiKey })

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPreview(url: string) {
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    try {
      const res = await fetch(url)
      if (res.ok) {
        const text = await res.text()
        if (text.includes("Pay") && text.includes("One In Twenty")) {
          console.log("preview_fetch: ok")
          return
        }
      }
      console.log(`  waiting for preview (HTTP ${res.status})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  waiting for preview (${message})`)
    }
  }
  throw new Error("preview URL did not become reachable")
}

async function pollReplay(sessionId: string) {
  const sessions = solari.sessions as {
    getReplayUrl?: (id: string) => Promise<{ url?: string } | string>
    downloadReplay?: (id: string) => Promise<Uint8Array | string>
  }

  for (let attempt = 1; attempt <= 12; attempt++) {
    await sleep(3000)
    try {
      if (typeof sessions.getReplayUrl === "function") {
        const result = await sessions.getReplayUrl(sessionId)
        const url = typeof result === "string" ? result : result?.url
        if (url) {
          console.log("replay:", url.split("?")[0])
          return
        }
      } else if (typeof sessions.downloadReplay === "function") {
        const blob = await sessions.downloadReplay(sessionId)
        const bytes = typeof blob === "string" ? blob.length : blob.byteLength
        console.log("replay_bytes:", bytes)
        return
      } else {
        console.log("replay: SDK has no getReplayUrl/downloadReplay; skipping")
        return
      }
    } catch (err) {
      const anyErr = err as { status?: number; statusCode?: number; message?: string }
      const status = anyErr.status ?? anyErr.statusCode
      console.log(`  replay attempt ${attempt}: ${status ?? anyErr.message ?? "not ready"}`)
    }
  }
  console.log("replay: unavailable after poll")
}

const sandbox = await pt.sandboxes.create({
  template: "base",
  timeoutMs: 5 * 60_000,
})
console.log("sandbox:", sandbox.sandboxId)

try {
  await sandbox.connect()
  await sandbox.files.write("/tmp/site/index.html", FIXTURE_HTML)
  await sandbox.files.write("/tmp/site/server.py", SERVER_PY)
  await sandbox.commands.run("sh", {
    args: ["-c", `cd /tmp/site && nohup python3 server.py >/tmp/site/server.log 2>&1 &`],
  })

  const { url } = await sandbox.previewUrl(PORT)
  const previewHost = url.split("?")[0]
  console.log("preview:", previewHost)
  if (!/getsolari\.com/i.test(url)) {
    throw new Error("preview URL is not a Solari host")
  }
  await waitForPreview(url)

  const browser = await solari.launch({ recording: true })
  const sessionId = browser.id
  console.log("browser_session:", sessionId)
  console.log("recording: true")

  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.locator("#pay").waitFor()
    await page.locator("#shipping").selectOption("express")
    await page.locator('#status[data-state="ready"]').waitFor({ timeout: 8000 })
    await page.locator("#pay").click()
    await page.locator('#status[data-state="paid"]').waitFor({ timeout: 8000 })
    const state = await page.locator("#status").getAttribute("data-state")
    const status = await page.locator("#status").innerText()
    console.log("checkout_state:", state)
    console.log("checkout_status:", status)
    if (state !== "paid") {
      throw new Error(`checkout did not succeed: ${state} ${status}`)
    }
  } finally {
    await browser.close()
    console.log("browser_released: true")
  }

  await pollReplay(sessionId)
} finally {
  await sandbox.kill()
  console.log("sandbox_killed: true")
  await solari.close()
  console.log("solari_closed: true")
}
