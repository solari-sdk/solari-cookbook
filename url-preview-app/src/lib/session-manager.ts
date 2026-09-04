import { db } from "./db"
import { sessions, users, logEntries } from "./schema"
import { eq, and, lt, sql } from "drizzle-orm"
import { getSandboxClient } from "./solari"
import { getSandbox, getBrowser, forget, allSessionIds } from "./session-registry"
import { estimateCostCents } from "./cost"
import { randomUUID } from "crypto"

export const MAX_CONCURRENT_GLOBAL = 10
export const DAILY_MINUTES_LIMIT = 120
export const REPO_CAP_MS = 15 * 60_000
export const SITE_CAP_MS = 2 * 60_000
export const EXTEND_MS = 15 * 60_000
export const REPO_TOTAL_CAP_MS = 45 * 60_000 // 15 min base + up to two 15 min extends
export const HEARTBEAT_INTERVAL_MS = 15_000
export const MISSED_BEATS_BEFORE_TEARDOWN = 2

export type SessionMode = "repo" | "site"
export type SessionStatus =
  | "pending"
  | "detecting"
  | "awaiting_confirm"
  | "running"
  | "done"
  | "failed"
  | "killed"

export type Session = typeof sessions.$inferSelect

export function detectMode(url: string): SessionMode {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const path = u.pathname.toLowerCase()

    if (
      host === "github.com" ||
      host === "gitlab.com" ||
      host.endsWith(".github.com") ||
      host.endsWith(".gitlab.com") ||
      path.endsWith(".git") ||
      path.endsWith(".zip") ||
      path.endsWith(".tar.gz") ||
      path.endsWith(".tgz")
    ) {
      return "repo"
    }
  } catch {
    // invalid URL, treat as site
  }
  return "site"
}

export function isPrivateOrLocalhost(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    ) {
      return true
    }
    const match = host.match(/^172\.(\d+)\./)
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  } catch {
    return true // invalid URL = blocked
  }
  return false
}

export async function createSession(userId: string, url: string, forcedMode?: SessionMode): Promise<string> {
  const active = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), sql`${sessions.status} IN ('pending', 'detecting', 'awaiting_confirm', 'running')`))
  if (active.length > 0) {
    throw new Error("You already have an active session. Wait for it to finish or kill it.")
  }

  const globalActive = await db
    .select()
    .from(sessions)
    .where(sql`${sessions.status} IN ('pending', 'detecting', 'awaiting_confirm', 'running')`)
  if (globalActive.length >= MAX_CONCURRENT_GLOBAL) {
    throw new Error("Server is at capacity. Please try again in a few minutes.")
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).get()
  if (!user) throw new Error("Account not found")

  const now = new Date()
  const resetAt = user.dailyMinutesResetAt
  if (resetAt && resetAt.getTime() > now.getTime() - 24 * 60 * 60_000) {
    if ((user.dailyMinutesUsed ?? 0) >= DAILY_MINUTES_LIMIT) {
      throw new Error(`Daily limit of ${DAILY_MINUTES_LIMIT} minutes reached. Resets tomorrow.`)
    }
  } else {
    await db.update(users).set({ dailyMinutesUsed: 0, dailyMinutesResetAt: now }).where(eq(users.id, userId))
  }

  const mode = forcedMode ?? detectMode(url)
  const id = randomUUID()
  const capMs = mode === "repo" ? REPO_CAP_MS : SITE_CAP_MS

  await db.insert(sessions).values({
    id,
    userId,
    mode,
    inputUrl: url,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + capMs),
  })

  return id
}

export async function addLog(sessionId: string, level: "info" | "warn" | "error" | "debug", message: string, phase?: string) {
  await db.insert(logEntries).values({
    sessionId,
    timestamp: new Date(),
    level,
    phase,
    message,
  })
}

type SessionUpdate = Partial<{
  status: SessionStatus
  sandboxId: string
  browserId: string
  previewUrl: string
  detectedFramework: string
  detectedPkgManager: string
  detectedPort: number
  installCmd: string
  buildCmd: string
  startCmd: string
  isStatic: boolean
  serverReady: boolean
  outOfScopeReason: string
  errorSummary: string
  errorPhase: string
  lastHeartbeat: Date
  extendedAt: Date
  extendCount: number
  expiresAt: Date
  costCents: number
}>

export async function updateSession(id: string, updates: SessionUpdate) {
  await db.update(sessions).set(updates).where(eq(sessions.id, id))
}

export async function getSession(id: string): Promise<Session | undefined> {
  return db.select().from(sessions).where(eq(sessions.id, id)).get()
}

export async function getUserSessions(userId: string) {
  return db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(sessions.createdAt)
}

// Charges the minutes a finished session actually used against its owner's
// daily quota. Called once, from a terminal state.
export async function chargeMinutes(session: Session) {
  const ms = Date.now() - session.createdAt.getTime()
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  await db
    .update(users)
    .set({ dailyMinutesUsed: sql`coalesce(${users.dailyMinutesUsed}, 0) + ${minutes}` })
    .where(eq(users.id, session.userId))
  // Billed in whole minutes, so estimate cost off the same rounded-up
  // figure rather than raw elapsed ms (which would round sub-minute
  // sessions down to zero).
  await updateSession(session.id, { costCents: estimateCostCents(session.mode, minutes * 60_000) })
}

const TERMINAL_STATUSES: SessionStatus[] = ["done", "failed", "killed"]

export async function killSession(id: string) {
  const session = await getSession(id)
  if (!session) return
  if (TERMINAL_STATUSES.includes(session.status)) return // don't clobber a terminal status (e.g. "failed") with "killed"

  const sandbox = getSandbox(id)
  if (sandbox) {
    try {
      await sandbox.kill()
    } catch {
      /* already dead */
    }
  } else if (session.sandboxId) {
    try {
      await getSandboxClient().sandboxes.kill(session.sandboxId)
    } catch {
      /* already dead, or this process never held the handle */
    }
  }

  const browserEntry = getBrowser(id)
  if (browserEntry) {
    try {
      await browserEntry.browser.close()
    } catch {
      /* already dead */
    }
    try {
      await browserEntry.client.close()
    } catch {
      /* already dead */
    }
  }

  forget(id)
  await chargeMinutes(session) // guarded above: only reached for a non-terminal session
  await updateSession(id, { status: "killed" })
}

export async function extendSession(id: string): Promise<Date> {
  const session = await getSession(id)
  if (!session) throw new Error("Session not found")
  if (session.mode !== "repo") throw new Error("Only repo sessions can be extended")
  if (session.status !== "running") throw new Error("Session is not running")

  const maxExpiry = new Date(session.createdAt.getTime() + REPO_TOTAL_CAP_MS)
  if (session.expiresAt.getTime() >= maxExpiry.getTime()) {
    throw new Error("This session is already at its total time cap")
  }

  const newExpiry = new Date(Math.min(session.expiresAt.getTime() + EXTEND_MS, maxExpiry.getTime()))
  await updateSession(id, { expiresAt: newExpiry, extendedAt: new Date(), extendCount: (session.extendCount ?? 0) + 1 })
  return newExpiry
}

// Sweep sessions left running/pending by a crashed process. Their in-memory
// registry entries are gone, so this can only mark them and best-effort
// kill the remote sandbox by id — browser sessions can't be reconnected to
// after a restart and simply age out on Solari's own idle timeout.
export async function sweepOrphans() {
  const stale = await db
    .select()
    .from(sessions)
    .where(sql`${sessions.status} IN ('pending', 'detecting', 'awaiting_confirm', 'running')`)

  for (const s of stale) {
    await addLog(s.id, "warn", "Session was orphaned by a restart and is being cleaned up", "teardown")
    if (s.sandboxId) {
      try {
        await getSandboxClient().sandboxes.kill(s.sandboxId)
      } catch {
        /* already dead */
      }
    }
    await updateSession(s.id, { status: "killed" })
  }

  // Also sweep anything past its expiry that the wall-clock timer somehow
  // missed (e.g. the process was killed at the wrong instant).
  const expired = await db
    .select()
    .from(sessions)
    .where(and(sql`${sessions.status} IN ('running', 'awaiting_confirm')`, lt(sessions.expiresAt, new Date())))
  for (const s of expired) {
    await killSession(s.id)
  }
}

// Best-effort teardown of every session this process is holding a live
// handle for. Wired to process exit signals so a closed process doesn't
// leave sandboxes or browser sessions running and billing.
export async function killAllTracked(reason: string) {
  const ids = allSessionIds()
  await Promise.all(
    ids.map(async (id) => {
      try {
        await addLog(id, "warn", `Tearing down: ${reason}`, "teardown")
        await killSession(id)
      } catch {
        /* best effort */
      }
    }),
  )
}
