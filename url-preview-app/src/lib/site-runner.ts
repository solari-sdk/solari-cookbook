/**
 * Site mode: load the page in a hosted browser, report what it did. No
 * verdicts — we describe behaviour and let the person reading the log judge.
 */
import { createHash } from "crypto"
import { readFile, unlink, stat } from "fs/promises"
import { newBrowserClient, withCapacityRetry } from "./solari"
import {
  updateSession,
  addLog,
  getSession,
  chargeMinutes,
  HEARTBEAT_INTERVAL_MS,
  MISSED_BEATS_BEFORE_TEARDOWN,
  type Session,
} from "./session-manager"
import { db } from "./db"
import { screenshots, downloads, clipboardEvents } from "./schema"
import { setBrowser, getBrowser, setCapTimer, setHeartbeatTimer, forget } from "./session-registry"

const MIME_BY_EXT: Record<string, string> = {
  exe: "application/x-msdownload",
  dmg: "application/x-apple-diskimage",
  pkg: "application/x-newton-compatible-pkg",
  zip: "application/zip",
  sh: "application/x-sh",
  msi: "application/x-msi",
  apk: "application/vnd.android.package-archive",
  pdf: "application/pdf",
  scr: "application/x-msdownload",
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

function armWallClockCap(session: Session, browser: any, client: any) {
  const msLeft = session.expiresAt.getTime() - Date.now()
  const timer = setTimeout(async () => {
    await addLog(session.id, "warn", "Wall-clock cap reached (2 min) — closing the browser session", "timeout")
    await teardown(session, browser, client, "killed")
  }, Math.max(0, msLeft))
  setCapTimer(session.id, timer)
}

function armHeartbeatWatch(session: Session, browser: any, client: any) {
  const staleAfterMs = HEARTBEAT_INTERVAL_MS * MISSED_BEATS_BEFORE_TEARDOWN
  const timer = setInterval(async () => {
    const fresh = await getSession(session.id)
    if (!fresh || fresh.status !== "running") return
    const lastBeat = fresh.lastHeartbeat ?? fresh.createdAt
    if (Date.now() - lastBeat.getTime() > staleAfterMs) {
      await addLog(session.id, "warn", "No heartbeat from the browser tab — tearing down so a closed tab doesn't keep billing", "heartbeat")
      await teardown(session, browser, client, "killed")
    }
  }, HEARTBEAT_INTERVAL_MS)
  setHeartbeatTimer(session.id, timer)
}

async function teardown(session: Session, browser: any, client: any, finalStatus: "done" | "failed" | "killed", errorSummary?: string) {
  try {
    await browser.close()
  } catch {
    /* already dead */
  }
  try {
    await client.close()
  } catch {
    /* already dead */
  }
  forget(session.id)
  await updateSession(session.id, { status: finalStatus, ...(errorSummary ? { errorSummary } : {}) })
  await chargeMinutes(session)
}

export async function runSiteSession(session: Session) {
  const sessionId = session.id
  const url = session.inputUrl

  const client = newBrowserClient()
  let browser: any
  try {
    await addLog(sessionId, "info", "Requesting a browser session...", "init")
    browser = await withCapacityRetry(
      () => client.launch(),
      (attempt, delayMs) =>
        addLog(sessionId, "warn", `Solari is at capacity, queuing (attempt ${attempt}, retrying in ${Math.round(delayMs / 1000)}s)`, "init"),
    )
  } catch (err: any) {
    await addLog(sessionId, "error", `Could not start a browser session: ${err?.message ?? err}`, "init")
    await updateSession(sessionId, { status: "failed", errorSummary: "Could not start a browser session" })
    try {
      await client.close()
    } catch {
      /* ignore */
    }
    await chargeMinutes(session)
    return
  }

  setBrowser(sessionId, browser, client)
  await updateSession(sessionId, { status: "running", browserId: browser.id, lastHeartbeat: new Date() })
  await addLog(sessionId, "info", `Browser session: ${browser.id}`, "init")

  armWallClockCap(session, browser, client)
  armHeartbeatWatch(session, browser, client)

  try {
    const page = await browser.newPage()

    const redirectChain: { url: string; status: number }[] = []
    page.on("response", (resp: any) => {
      const req = resp.request()
      if (req.isNavigationRequest()) redirectChain.push({ url: resp.url(), status: resp.status() })
    })

    const requestsByDomain = new Map<string, number>()
    page.on("request", (req: any) => {
      try {
        const domain = new URL(req.url()).hostname
        requestsByDomain.set(domain, (requestsByDomain.get(domain) ?? 0) + 1)
      } catch {
        /* ignore unparseable urls */
      }
    })

    page.on("download", async (download: any) => {
      const filename = download.suggestedFilename()
      const sourceUrl = download.url()
      await addLog(sessionId, "warn", `This page started a download you didn't click: ${filename} from ${sourceUrl}`, "download")
      try {
        const path = await download.path()
        if (path) {
          const [stats, buf] = await Promise.all([stat(path), readFile(path)])
          const sha256 = createHash("sha256").update(buf).digest("hex")
          const mimeType = guessMime(filename)
          await db.insert(downloads).values({
            sessionId,
            filename,
            url: sourceUrl,
            mimeType,
            sizeBytes: stats.size,
            sha256,
            seenAt: new Date(),
          })
          await addLog(sessionId, "info", `  ${filename} — ${stats.size} bytes, ${mimeType}, sha256 ${sha256}`, "download")
          // Report on it, don't hand it over.
          await unlink(path).catch(() => {})
        }
      } catch (err: any) {
        await addLog(sessionId, "warn", `Could not inspect the download: ${err?.message ?? err}`, "download")
      }
    })

    await page.addInitScript(() => {
      const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard)
      if (!orig) return
      ;(navigator.clipboard as any).writeText = async (text: string) => {
        ;(window as any).__clipboardWrites = (window as any).__clipboardWrites || []
        ;(window as any).__clipboardWrites.push(text)
        return orig(text)
      }
    })

    await addLog(sessionId, "info", `Navigating to ${url}...`, "navigate")
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(async (err: any) => {
      await addLog(sessionId, "warn", `Navigation did not settle cleanly: ${err?.message ?? err}`, "navigate")
    })

    const finalUrl = page.url()
    const title = await page.title().catch(() => "")
    let finalDomain = finalUrl
    let pastedDomain = url
    try {
      finalDomain = new URL(finalUrl).hostname
    } catch {
      /* keep raw value */
    }
    try {
      pastedDomain = new URL(url).hostname
    } catch {
      /* keep raw value */
    }
    const domainChanged = finalDomain !== pastedDomain

    await addLog(sessionId, "info", `Page title: ${title || "(none)"}`, "info")
    await addLog(sessionId, "info", `Final domain: ${finalDomain}`, "info")
    if (domainChanged) {
      await addLog(sessionId, "warn", `Final domain differs from the one pasted: ${pastedDomain} → ${finalDomain}`, "info")
    }

    await addLog(sessionId, "info", `Redirect chain (${redirectChain.length} responses):`, "redirects")
    for (const r of redirectChain) await addLog(sessionId, "info", `  [${r.status}] ${r.url}`, "redirects")

    const loadShot = await page.screenshot({ fullPage: false }).catch(() => null)
    if (loadShot) {
      await db.insert(screenshots).values({ sessionId, kind: "load", data: Buffer.from(loadShot), takenAt: new Date() })
      await addLog(sessionId, "info", "Captured screenshot at load", "screenshot")
    }

    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {})
    await page.waitForTimeout(2000)

    const settleShot = await page.screenshot({ fullPage: false }).catch(() => null)
    if (settleShot) {
      await db.insert(screenshots).values({ sessionId, kind: "settle", data: Buffer.from(settleShot), takenAt: new Date() })
      await addLog(sessionId, "info", "Captured screenshot after settle", "screenshot")
    }

    const clipWrites: string[] = await page.evaluate(() => (window as any).__clipboardWrites || []).catch(() => [])
    if (clipWrites.length > 0) {
      await addLog(sessionId, "warn", `This page tried to write to the clipboard ${clipWrites.length} time(s) — a common paste-into-your-terminal scam pattern`, "clipboard")
      for (const text of clipWrites) {
        await db.insert(clipboardEvents).values({ sessionId, text, seenAt: new Date() })
        await addLog(sessionId, "warn", `  clipboard write: "${text}"`, "clipboard")
      }
    }

    const sortedDomains = [...requestsByDomain.entries()].sort((a, b) => b[1] - a[1])
    await addLog(sessionId, "info", `Outbound requests across ${sortedDomains.length} domain(s):`, "requests")
    for (const [domain, count] of sortedDomains.slice(0, 25)) {
      await addLog(sessionId, "info", `  ${domain}: ${count} request(s)`, "requests")
    }

    await addLog(sessionId, "info", "Done — page loaded, waited, scrolled once. No forms filled, nothing clicked.", "summary")
    await teardown(session, browser, client, "done")
  } catch (err: any) {
    await addLog(sessionId, "error", err?.message ?? "Unknown error", "fatal")
    await teardown(session, browser, client, "failed", err?.message)
  }
}
