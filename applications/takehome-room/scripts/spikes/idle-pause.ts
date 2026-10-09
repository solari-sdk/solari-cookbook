/**
 * Spike, run 2026-10-09 on the free plan:
 *   node --env-file=.env --import tsx scripts/spikes/idle-pause.ts
 *
 * Outcome: the idle pause never fired. The desktop stayed "ready" more than three
 * minutes past expiresAt, and every get() reset the idle clock. Calling pause()
 * directly works; docs/research/solari-and-takehome-room.md section 12 has the
 * resume and kill findings. This script still expects "paused" and fails there.
 *
 * Question: can a Room survive the Candidate going quiet (laptop asleep, network down)?
 *
 * With onTimeout "pause" the desktop is snapshotted instead of killed. Questions:
 *   1. Does an idle desktop actually reach "paused"?
 *   2. With autoResume (undocumented), does opening the stream wake it?
 *   3. After resume: are files, open apps and the old stream URL still good?
 *   4. Does the recording survive, and does it cover time before the pause?
 *
 * Costs about 1-2 cents of credit. Idle window is 1 minute to keep it short.
 */
import { DesktopClient } from "@solarisdk/desktop"

const desktops = new DesktopClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" })
const t0 = Date.now()
const log = (msg: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function probeStream(url: string, timeoutMs: number): Promise<string> {
  const started = Date.now()
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ["binary"])
    ws.binaryType = "arraybuffer"
    const done = (r: string) => {
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(`${r} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
    const timer = setTimeout(() => done("no greeting"), timeoutMs)
    ws.onmessage = (ev) => done(`greeting ${JSON.stringify(new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer).slice(0, 12)))}`)
    ws.onerror = () => done("error")
    ws.onclose = (ev) => done(`closed ${ev.code}`)
  })
}

async function status(id: string) {
  return (await desktops.get(id)).status
}

let id: string | undefined
try {
  const d = await desktops.create({
    template: "code",
    cpu: 2,
    memMb: 2048,
    record: true,
    idleTimeoutMs: 60_000,
    lifecycle: { onTimeout: "pause", autoResume: true },
  })
  id = d.id
  const streamUrl = d.streamUrl
  await d.connect()
  for (let i = 0; i < 30 && !(await d.health().catch(() => undefined))?.ready; i++) await sleep(1000)
  await d.exec("sh", { args: ["-c", "echo before-pause > /home/desktop/marker.txt"] })
  await d.record.start({ fps: 10 })
  await d.open("code", ["/home/desktop"])
  log(`created, recording, status ${await status(id)}`)
  await sleep(15_000) // some screen time before the pause
  // Go quiet: drop the control channel and hold no stream open.
  d.close()
  log("went quiet")

  // No API calls while waiting: a status poll might itself count as activity.
  const created = await desktops.get(id)
  log(`expiresAt right after going quiet: ${created.expiresAt}`)
  await sleep(180_000)
  const after = await desktops.get(id)
  let s = after.status
  log(`after 3 quiet minutes: status ${s}, expiresAt ${after.expiresAt}`)
  for (let i = 0; i < 6 && s !== "paused" && s !== "gone"; i++) {
    await sleep(20_000)
    const g = await desktops.get(id)
    s = g.status
    log(`  status ${s}, expiresAt ${g.expiresAt}`)
  }
  log(`status after waiting: ${s}`)
  if (s !== "paused") throw new Error(`expected paused, got ${s}`)

  log(`stream while paused (autoResume?): ${await probeStream(streamUrl, 60_000)}`)
  log(`status after stream attempt: ${await status(id)}`)

  const back = await desktops.connect(id) // resumes if still paused
  await back.connect()
  log(`connect(): status ${await status(id)}`)
  log(`old stream URL after resume: ${await probeStream(streamUrl, 30_000)}`)
  const marker = await back.exec("sh", { args: ["-c", "cat /home/desktop/marker.txt; pgrep -c -f /usr/share/code/code || true"] })
  log(`marker + VS Code processes: ${marker.stdout.trim().replace(/\n/g, " | ")}`)

  await sleep(10_000) // more screen time after the resume
  const stopped = await back.record.stop().catch((e) => ({ error: String(e) }))
  log(`record.stop: ${JSON.stringify(stopped)}`)
  const url = back.recordingUrl
  if (url) {
    for (let i = 0; i < 12; i++) {
      const res = await fetch(url, { headers: { Range: "bytes=0-15" } })
      if (res.ok) {
        log(`recording: HTTP ${res.status}, ${res.headers.get("content-range")}`)
        break
      }
      await sleep(5000)
    }
  } else log("recording: no URL on the resumed handle")
  await back.kill()
  id = undefined
  log("killed")
} catch (e) {
  console.error("spike failed:", e)
  process.exitCode = 1
} finally {
  if (id) await desktops.destroy(id).catch(() => {})
}
