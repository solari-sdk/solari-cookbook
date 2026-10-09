// The Interview and the rules for moving it between phases. Pure: no I/O, and
// every function takes `now` so tests can drive the clock. Words follow CONTEXT.md.

export type Phase =
  | "invited" // link sent, Room not opened yet
  | "opening" // Room is being created
  | "setup" // Room open, Interview clock not started
  | "working" // Interview clock running
  | "collecting" // clock stopped, Final state and Recording being saved
  | "grading" // Hidden tests running
  | "done"
  | "failed"

export type EndReason = "submitted" | "timeout"

export interface Grade {
  passed: number
  failed: number
  total: number
  output: string
}

export interface Interview {
  id: string
  task: string
  /** Secret in the Candidate's link. */
  candidateToken: string
  /** Secret in the Reviewer's link. */
  reviewerToken: string
  workMinutes: number
  setupMinutes: number
  phase: Phase
  createdAt: number
  roomId?: string
  /**
   * The Room's live stream. It ends in the signed session id and grants full
   * control of the desktop, so only the Candidate ever receives it.
   */
  streamUrl?: string
  recordingUrl?: string
  openedAt?: number
  startedAt?: number
  endedAt?: number
  endReason?: EndReason
  grade?: Grade
  gitLog?: string
  error?: string
  /** A public demo: short, and the Candidate may see their own Report. */
  demo?: boolean
}

export function createInterview(input: {
  id: string
  task: string
  candidateToken: string
  reviewerToken: string
  workMinutes: number
  setupMinutes: number
  now: number
  demo?: boolean
}): Interview {
  if (!(input.workMinutes > 0)) throw new Error("workMinutes must be positive")
  if (!(input.setupMinutes >= 0)) throw new Error("setupMinutes must not be negative")
  const { now, ...rest } = input
  return { ...rest, phase: "invited", createdAt: now }
}

function expect(iv: Interview, ...phases: Phase[]) {
  if (!phases.includes(iv.phase)) {
    throw new PhaseError(`Interview ${iv.id} is ${iv.phase}, expected ${phases.join(" or ")}`)
  }
}

export class PhaseError extends Error {}

export function beginOpening(iv: Interview): Interview {
  expect(iv, "invited")
  return { ...iv, phase: "opening" }
}

export function roomOpened(
  iv: Interview,
  room: { roomId: string; streamUrl: string; recordingUrl?: string },
  now: number,
): Interview {
  expect(iv, "opening")
  return { ...iv, ...room, phase: "setup", openedAt: now }
}

/** The Candidate pressed Start, or Setup time ran out. */
export function startClock(iv: Interview, now: number): Interview {
  expect(iv, "setup")
  return { ...iv, phase: "working", startedAt: now }
}

export function stopClock(iv: Interview, reason: EndReason, now: number): Interview {
  expect(iv, "working")
  return { ...iv, phase: "collecting", endedAt: now, endReason: reason }
}

export function collected(iv: Interview, gitLog: string): Interview {
  expect(iv, "collecting")
  // The Room is gone, so its stream link is dead. Drop it from the record.
  return { ...iv, phase: "grading", gitLog, streamUrl: undefined }
}

export function graded(iv: Interview, grade: Grade): Interview {
  expect(iv, "grading")
  return { ...iv, phase: "done", grade }
}

/** Any unfinished Interview can fail. A finished one keeps its result. */
export function failed(iv: Interview, error: string): Interview {
  expect(iv, "invited", "opening", "setup", "working", "collecting", "grading")
  return { ...iv, phase: "failed", error, streamUrl: undefined }
}

/** When the current phase must end on its own, or undefined if it waits for someone. */
export function deadline(iv: Interview): number | undefined {
  if (iv.phase === "setup" && iv.openedAt !== undefined) {
    return iv.openedAt + iv.setupMinutes * 60_000
  }
  if (iv.phase === "working" && iv.startedAt !== undefined) {
    return iv.startedAt + iv.workMinutes * 60_000
  }
  return undefined
}

/** What the clock forces at `now`: nothing, starting the Interview clock, or ending it. */
export function due(iv: Interview, now: number): "start" | "timeout" | undefined {
  const at = deadline(iv)
  if (at === undefined || now < at) return undefined
  return iv.phase === "setup" ? "start" : "timeout"
}

export function secondsLeft(iv: Interview, now: number): number | undefined {
  const at = deadline(iv)
  return at === undefined ? undefined : Math.max(0, Math.ceil((at - now) / 1000))
}

// --- the desktop slot --------------------------------------------------------
//
// A plan allows a fixed number of machines at once (one on the free plan). An
// Interview holds a slot from opening its Room until grading ends, because
// grading starts a sandbox right after the Room is killed.

/** Time to collect the work, kill the Room and run the Hidden tests, with margin. */
export const FINISH_MS = 3 * 60_000

export function holdsSlot(iv: Interview): boolean {
  return ["opening", "setup", "working", "collecting", "grading"].includes(iv.phase)
}

/** Latest moment this Interview could still be holding its slot. */
export function slotFreeBy(iv: Interview, now: number): number {
  const work = iv.workMinutes * 60_000
  const setup = iv.setupMinutes * 60_000
  switch (iv.phase) {
    case "opening":
      return now + 60_000 + setup + work + FINISH_MS
    case "setup":
      return (iv.openedAt ?? now) + setup + work + FINISH_MS
    case "working":
      return (iv.startedAt ?? now) + work + FINISH_MS
    case "collecting":
    case "grading":
      return now + FINISH_MS
    default:
      return now
  }
}

export type Gate = { ok: true } | { ok: false; reason: "busy" | "cap"; retryAfterSeconds: number }

/** Can a new Room open now? Pass every Interview except the one asking. */
export function roomGate(others: Interview[], now: number, maxRooms: number): Gate {
  const busy = others.filter(holdsSlot)
  if (busy.length < maxRooms) return { ok: true }
  // The slot frees when the soonest of the busy Interviews finishes.
  const soonest = Math.min(...busy.map((iv) => slotFreeBy(iv, now)))
  return { ok: false, reason: "busy", retryAfterSeconds: Math.max(1, Math.ceil((soonest - now) / 1000)) }
}

/** Can a visitor start a demo now? Also limits demos per rolling 24 hours. */
export function demoGate(all: Interview[], now: number, opts: { dailyLimit: number; maxRooms: number }): Gate {
  const DAY = 24 * 60 * 60_000
  const recent = all.filter((iv) => iv.demo && iv.createdAt > now - DAY)
  if (recent.length >= opts.dailyLimit) {
    const oldest = Math.min(...recent.map((iv) => iv.createdAt))
    return { ok: false, reason: "cap", retryAfterSeconds: Math.max(1, Math.ceil((oldest + DAY - now) / 1000)) }
  }
  return roomGate(all, now, opts.maxRooms)
}
