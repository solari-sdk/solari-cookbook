// Moves Interviews through their phases and enforces the clocks on the server.
// The browser's timer is for display only: the server decides when time is up.
//
// The machines are behind two ports, Rooms and Grader. Production passes the
// Solari adapters (src/solari). Tests pass in-memory fakes and a temporary store.
import { existsSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import * as iv from "./interview.ts"
import type { Grade, Interview } from "./interview.ts"
import type { Store } from "./store.ts"
import type { Task } from "./tasks.ts"

// --- ports -------------------------------------------------------------------

export type RoomState = "alive" | "gone" | "unknown"

export interface OpenedRoom {
  roomId: string
  /** Grants full control of the desktop: only ever shown to the Candidate. */
  streamUrl: string
  recordingUrl?: string
}

export interface Collected {
  gitLog: string
  /** The task folder as a .tar.gz, exactly as the Candidate left it. */
  finalState: Uint8Array
}

/** The machines Interviews run on. */
export interface Rooms {
  /** Creates a recorded Room with the Task's starter files in it. */
  open(task: Task, interviewId: string): Promise<OpenedRoom>
  /** Stops the Recording, takes the Final state out, and kills the Room. */
  collect(roomId: string): Promise<Collected>
  /** Kills the Room and makes sure it stays dead. */
  kill(roomId: string): Promise<void>
  /** Resumes a paused Room, and reports one that no longer exists. */
  wake(roomId: string): Promise<RoomState>
  /** Copies the Recording to `path`. False if it never became available. */
  saveRecording(url: string, path: string): Promise<boolean>
}

/** Runs the Hidden tests against a Final state, away from the Candidate's Room. */
export interface Grader {
  run(task: Task, finalState: Uint8Array): Promise<Grade>
}

export interface Limits {
  /** Machines the plan allows at once. The free Solari plan allows 1. */
  maxRooms: number
  demo: { task: string; workMinutes: number; setupMinutes: number; dailyLimit: number }
}

export interface FlowDeps {
  store: Store
  rooms: Rooms
  grader: Grader
  loadTask: (name: string) => Task
  limits: Limits
  log?: (message: string, error?: unknown) => void
}

/** Refused because the plan's machines are all in use, or the demo cap is reached. */
export class SlotError extends Error {
  readonly reason: "busy" | "cap"
  readonly retryAfterSeconds: number
  constructor(reason: "busy" | "cap", retryAfterSeconds: number) {
    super(reason === "busy" ? "Another interview is using the desktop right now." : "Today's demos are used up.")
    this.reason = reason
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export type Flow = ReturnType<typeof createFlow>

// --- the flow ------------------------------------------------------------------

export function createFlow({ store, rooms, grader, loadTask, limits, log = console.error }: FlowDeps) {
  const token = () => randomBytes(18).toString("base64url")

  // One operation at a time per Interview, so a Submit and a timeout cannot both
  // try to collect the same Room.
  const locks = new Map<string, Promise<unknown>>()
  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
    locks.set(id, next)
    return next
  }

  /** Load, apply a pure change, save, and re-arm the clock. */
  function update(id: string, change: (current: Interview) => Interview): Interview {
    const current = store.load(id)
    if (!current) throw new Error(`No Interview ${id}`)
    const next = change(current)
    store.save(next)
    schedule(next)
    return next
  }

  function create(taskName: string, opts: { workMinutes?: number; setupMinutes?: number; demo?: boolean } = {}) {
    const task = loadTask(taskName)
    const created = iv.createInterview({
      id: randomBytes(6).toString("hex"),
      task: task.name,
      candidateToken: token(),
      reviewerToken: token(),
      workMinutes: opts.workMinutes ?? task.workMinutes,
      setupMinutes: opts.setupMinutes ?? task.setupMinutes,
      now: Date.now(),
      demo: opts.demo,
    })
    store.save(created)
    return created
  }

  /** Whether a visitor could start a demo right now, and if not, for how long. */
  const demoStatus = (): iv.Gate =>
    iv.demoGate(store.all(), Date.now(), { dailyLimit: limits.demo.dailyLimit, maxRooms: limits.maxRooms })

  function createDemo(): Interview {
    const gate = demoStatus()
    if (!gate.ok) throw new SlotError(gate.reason, gate.retryAfterSeconds)
    const { task, workMinutes, setupMinutes } = limits.demo
    return create(task, { workMinutes, setupMinutes, demo: true })
  }

  // Each entry point below changes the phase synchronously, before any I/O. Node
  // runs one handler at a time, so a double click or a Submit racing the timeout
  // gets a PhaseError instead of starting a second operation.

  function open(id: string): Interview {
    // Check the slot first: Solari's own refusal would arrive later as a failed Room.
    const others = store.all().filter((other) => other.id !== id)
    const gate = iv.roomGate(others, Date.now(), limits.maxRooms)
    if (!gate.ok) throw new SlotError(gate.reason, gate.retryAfterSeconds)
    const opening = update(id, iv.beginOpening)
    void serial(id, async () => {
      try {
        const room = await rooms.open(loadTask(opening.task), id)
        update(id, (cur) => iv.roomOpened(cur, room, Date.now()))
      } catch (e) {
        log(`opening the Room for ${id} failed:`, e)
        update(id, (cur) => iv.failed(cur, `Could not open the Room: ${(e as Error).message}`))
      }
    })
    return opening
  }

  const start = (id: string): Interview => update(id, (cur) => iv.startClock(cur, Date.now()))

  function end(id: string, reason: iv.EndReason): Interview {
    const stopped = update(id, (cur) => iv.stopClock(cur, reason, Date.now()))
    // Collecting and grading take a minute or two. Run them after answering.
    void serial(id, () => finish(stopped))
    return stopped
  }

  /**
   * Called whenever the Candidate's page checks in, and on boot. Resumes a Room
   * that paused while the Candidate was away (laptop asleep, network down). A Room
   * that no longer exists (killed, or past the plan's session limit) fails its
   * Interview, which also frees the slot.
   */
  function wake(id: string): void {
    void serial(id, async () => {
      const current = store.load(id)
      if (!current?.roomId || (current.phase !== "setup" && current.phase !== "working")) return
      const state = await rooms.wake(current.roomId).catch((e): RoomState => {
        log(`waking the Room for ${id} failed:`, e)
        return "unknown"
      })
      if (state === "gone") {
        update(id, (cur) => iv.failed(cur, "The desktop stopped before the interview ended, so the work could not be collected."))
      }
    })
  }

  async function finish(from: Interview): Promise<void> {
    const { id } = from
    const dir = store.artifactDir(id)
    const finalPath = join(dir, "final-state.tgz")
    try {
      // A restart can leave an Interview in "grading" with its Final state already saved.
      if (from.phase === "collecting") {
        const { gitLog, finalState } = await rooms.collect(from.roomId!)
        writeFileSync(finalPath, finalState)
        update(id, (cur) => iv.collected(cur, gitLog))
      }
      const finalState = new Uint8Array(await readFile(finalPath))

      // The video uploads after the recording stops, so fetch it while the tests run.
      const recordingPath = join(dir, "recording.mp4")
      const recording =
        from.recordingUrl && !existsSync(recordingPath)
          ? rooms.saveRecording(from.recordingUrl, recordingPath).catch((e) => {
              log(`saving the Recording for ${id} failed:`, e)
              return false
            })
          : Promise.resolve(existsSync(recordingPath))
      const grade = await grader.run(loadTask(from.task), finalState)
      writeFileSync(join(dir, "hidden-tests.txt"), grade.output)
      if (!(await recording)) log(`no Recording saved for ${id}`)
      update(id, (cur) => iv.graded(cur, grade))
    } catch (e) {
      log(`finishing ${id} failed:`, e)
      if (from.phase === "collecting" && from.roomId) await rooms.kill(from.roomId)
      update(id, (cur) => iv.failed(cur, `Could not finish the Interview: ${(e as Error).message}`))
    }
  }

  // --- the server-side clock ---

  const timers = new Map<string, NodeJS.Timeout>()

  function schedule(current: Interview) {
    clearTimeout(timers.get(current.id))
    timers.delete(current.id)
    const at = iv.deadline(current)
    if (at === undefined) return
    // setTimeout cannot wait longer than about 24.8 days, far beyond any Interview.
    timers.set(current.id, setTimeout(() => tick(current.id), Math.max(0, at - Date.now()) + 250))
  }

  function tick(id: string) {
    const current = store.load(id)
    if (!current) return
    const action = iv.due(current, Date.now())
    try {
      // The clock starts when setup time ended, not when this timer happened to
      // fire. After a restart that can be much later, and the Candidate must not
      // get a fresh work time. If work time is also over, the next tick ends it.
      if (action === "start") update(id, (cur) => iv.startClock(cur, iv.deadline(cur)!))
      if (action === "timeout") end(id, "timeout")
    } catch (e) {
      // Someone acted first (Start or Submit). Nothing left to do.
      if (!(e instanceof iv.PhaseError)) log(`clock for ${id} failed:`, e)
    }
  }

  /**
   * On boot: re-arm the clocks, and settle Interviews that a restart left halfway.
   * A Room still being created when the process died is unknown, so it fails.
   */
  function resume(): void {
    for (const current of store.all()) {
      if (current.phase === "opening") {
        update(current.id, (cur) => iv.failed(cur, "The server restarted while the Room was opening"))
      } else if (current.phase === "collecting" || current.phase === "grading") {
        void serial(current.id, () => finish(current))
      } else {
        schedule(current)
        tick(current.id)
        // The process was down: the Room may have died meanwhile.
        if (current.phase === "setup" || current.phase === "working") wake(current.id)
      }
    }
  }

  /** Resolves when every background operation started so far has finished. */
  async function settled(): Promise<void> {
    while (true) {
      const pending = [...locks.values()]
      await Promise.allSettled(pending)
      if ([...locks.values()].every((p) => pending.includes(p))) return
    }
  }

  /** Stops the clocks, for shutdown and tests. Records are untouched. */
  function close(): void {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }

  return { create, createDemo, demoStatus, open, start, end, wake, resume, settled, close }
}
