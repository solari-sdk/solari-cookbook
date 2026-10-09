/**
 * Spike, run 2026-10-08 on the free plan:
 *   node --env-file=.env --import tsx scripts/spikes/desktop-recording.ts
 *
 * Outcome: desktops work on the free plan, recording produced a real MP4 that
 * survives kill(), and the stream link stops working after kill(). Typing in
 * VS Code through the console's View tab felt "a little slow but fine".
 *
 * Questions it answered before building takehome-room:
 *
 *   1. Does the free plan allow desktops at all? (A 402 PlanError ends the run for free.)
 *   2. Does desktop recording work? record.start/stop and recordingUrl exist in the
 *      SDK (@solarisdk/core 0.1.4) but not in the docs.
 *   3. Does the stream link stop working once the session is killed?
 *
 * Lag is judged by hand: open this VM in the console's View tab and type in VS Code.
 *
 * Cost on the free plan: a 2 vCPU / 2 GB desktop is about $0.16/hour of the $3
 * monthly credit. Solari does not bill past the balance.
 */
import { DesktopClient, PlanError, type Desktop } from "@solarisdk/desktop"
import { createInterface } from "node:readline/promises"

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("SOLARI_API_KEY is not set. Export it in this shell first.")
  process.exit(1)
}

const desktops = new DesktopClient({ apiKey, baseUrl: "https://api.getsolari.com" })

// The stream URL ends in the signed session id, which grants control of the desktop.
// Hide it so the output can be shared.
const redact = (url: string) => url.replace(/\/stream\/.*/, "/stream/…")

/** Open the RFB stream and report its first bytes. A live VNC server greets with "RFB 003.00x". */
async function probeStream(url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ["binary"])
    ws.binaryType = "arraybuffer"
    const done = (result: string) => {
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => done("no data within 10s"), 10_000)
    ws.onmessage = (ev) => {
      const text = new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer).slice(0, 12))
      done(`greeting ${JSON.stringify(text)}`)
    }
    ws.onerror = () => done("connection error")
    ws.onclose = (ev) => done(`closed (code ${ev.code})`)
  })
}

/** Ask for the first 16 bytes of the recording. An mp4 has "ftyp" at bytes 4..8. */
async function probeRecording(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Range: "bytes=0-15" } })
  if (!res.ok) return `HTTP ${res.status}`
  const head = new Uint8Array(await res.arrayBuffer())
  const box = new TextDecoder().decode(head.slice(4, 8))
  const size = res.headers.get("content-range") ?? res.headers.get("content-length")
  return `HTTP ${res.status}, box "${box}", size ${size}, type ${res.headers.get("content-type")}`
}

let desktop: Desktop | undefined
const startedAt = Date.now()

async function cleanup() {
  if (!desktop) return
  const d = desktop
  desktop = undefined
  // kill(), not close(): close() only drops the control channel and the VM keeps billing.
  await d.kill().catch((e) => console.error("kill failed, check the console:", e))
  console.log(`killed after ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`)
}
process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)) })

try {
  console.log("1. creating a recorded desktop from the 'code' template…")
  try {
    desktop = await desktops.create({
      template: "code",
      resolution: "1600x900",
      cpu: 2,
      memMb: 2048,
      record: true,
      // Rolling idle window, not a deadline. Kill rather than pause so nothing lingers.
      idleTimeoutMs: 15 * 60_000,
      lifecycle: { onTimeout: "kill" },
    })
  } catch (e) {
    if (e instanceof PlanError) {
      console.log("   refused by plan:", e.message)
      console.log("   => desktops need a paid plan. Nothing was billed.")
      process.exit(0)
    }
    throw e
  }
  console.log("   id:           (hidden, it is the stream credential)")
  console.log("   expiresAt:   ", desktop.expiresAt)
  console.log("   streamUrl:   ", redact(desktop.streamUrl))
  console.log("   recordingUrl:", desktop.recordingUrl ? "present" : "MISSING")

  await desktop.connect()
  const health = await desktop.health()
  console.log("   health:      ", JSON.stringify(health))

  console.log("2. probing the stream while the desktop runs…")
  const streamUrl = desktop.streamUrl
  console.log("   ", await probeStream(streamUrl))

  console.log("3. starting the recording…")
  const rec = await desktop.record.start({ fps: 10 })
  console.log("   ", JSON.stringify(rec))
  await desktop.open("code").catch((e) => console.log("   could not open VS Code:", e.message))

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await rl.question(
    "\n   Now open console.getsolari.com, VMs, this VM, View.\n" +
      "   Type in VS Code for about 10 minutes and judge the lag.\n" +
      "   Press Enter here when you are done. ",
  )
  rl.close()

  console.log("4. stopping the recording…")
  const stopped = await desktop.record.stop()
  console.log("   ", JSON.stringify(stopped))

  const recordingUrl = desktop.recordingUrl
  if (recordingUrl) {
    // The guest uploads the mp4 after stop, so poll briefly.
    let result = ""
    for (let i = 0; i < 12; i++) {
      result = await probeRecording(recordingUrl)
      if (result.includes("ftyp")) break
      await new Promise((r) => setTimeout(r, 5_000))
    }
    console.log("    recording before kill:", result)
  }

  console.log("5. killing the desktop, then probing the stream again…")
  await cleanup()
  console.log("    stream after kill:", await probeStream(streamUrl))
  if (recordingUrl) {
    console.log("    recording after kill:", await probeRecording(recordingUrl))
    console.log("\n    Watch it (link expires):", recordingUrl)
  }
} catch (e) {
  console.error("spike failed:", e)
  process.exitCode = 1
} finally {
  await cleanup()
}
