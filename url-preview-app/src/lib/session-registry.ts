/**
 * In-memory registry of live Solari handles, keyed by our session id.
 *
 * The database only holds ids and status; the actual sandbox/browser
 * objects (and their wall-clock/heartbeat timers) live here for as long as
 * this process is up. That's enough for a single-instance app — there is no
 * cross-process job queue in scope here.
 */
import type { SolariClient } from "@solarisdk/sdk"
import type { Solari } from "@solarisdk/browser"

type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>
type Browser = Awaited<ReturnType<Solari["launch"]>>

type Entry = {
  sandbox?: Sandbox
  browser?: Browser
  browserClient?: Solari
  capTimer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
}

const registry = new Map<string, Entry>()

function entry(sessionId: string): Entry {
  let e = registry.get(sessionId)
  if (!e) {
    e = {}
    registry.set(sessionId, e)
  }
  return e
}

export function setSandbox(sessionId: string, sandbox: Sandbox) {
  entry(sessionId).sandbox = sandbox
}

export function getSandbox(sessionId: string): Sandbox | undefined {
  return registry.get(sessionId)?.sandbox
}

export function setBrowser(sessionId: string, browser: Browser, client: Solari) {
  const e = entry(sessionId)
  e.browser = browser
  e.browserClient = client
}

export function getBrowser(sessionId: string): { browser: Browser; client: Solari } | undefined {
  const e = registry.get(sessionId)
  if (!e?.browser || !e.browserClient) return undefined
  return { browser: e.browser, client: e.browserClient }
}

export function setCapTimer(sessionId: string, timer: ReturnType<typeof setTimeout>) {
  clearCapTimer(sessionId)
  entry(sessionId).capTimer = timer
}

export function clearCapTimer(sessionId: string) {
  const e = registry.get(sessionId)
  if (e?.capTimer) clearTimeout(e.capTimer)
}

export function setHeartbeatTimer(sessionId: string, timer: ReturnType<typeof setInterval>) {
  entry(sessionId).heartbeatTimer = timer
}

export function clearHeartbeatTimer(sessionId: string) {
  const e = registry.get(sessionId)
  if (e?.heartbeatTimer) clearInterval(e.heartbeatTimer)
}

export function forget(sessionId: string) {
  clearCapTimer(sessionId)
  clearHeartbeatTimer(sessionId)
  registry.delete(sessionId)
}

export function allSessionIds(): string[] {
  return [...registry.keys()]
}
