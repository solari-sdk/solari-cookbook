import { test } from "node:test"
import assert from "node:assert/strict"
import {
  beginOpening,
  collected,
  createInterview,
  demoGate,
  due,
  FINISH_MS,
  failed,
  graded,
  PhaseError,
  roomGate,
  roomOpened,
  secondsLeft,
  startClock,
  stopClock,
} from "../src/interview.ts"

const MIN = 60_000
const base = () =>
  createInterview({
    id: "iv1",
    task: "lru-cache",
    candidateToken: "c",
    reviewerToken: "r",
    workMinutes: 60,
    setupMinutes: 10,
    now: 0,
  })
const room = { roomId: "room", streamUrl: "wss://example/stream/secret" }

test("walks the happy path from invitation to grade", () => {
  let iv = base()
  iv = beginOpening(iv)
  iv = roomOpened(iv, room, 1 * MIN)
  assert.equal(iv.phase, "setup")
  iv = startClock(iv, 4 * MIN)
  assert.equal(iv.phase, "working")
  iv = stopClock(iv, "submitted", 30 * MIN)
  assert.equal(iv.endReason, "submitted")
  iv = collected(iv, "abc123 first commit")
  assert.equal(iv.streamUrl, undefined, "the dead stream link is dropped")
  iv = graded(iv, { passed: 3, failed: 1, total: 4, output: "" })
  assert.equal(iv.phase, "done")
})

test("Setup time does not count: the clock starts at Start, not at open", () => {
  let iv = roomOpened(beginOpening(base()), room, 0)
  iv = startClock(iv, 7 * MIN)
  assert.equal(secondsLeft(iv, 7 * MIN), 60 * 60)
})

test("Setup time running out starts the clock", () => {
  const iv = roomOpened(beginOpening(base()), room, 0)
  assert.equal(due(iv, 10 * MIN - 1), undefined)
  assert.equal(due(iv, 10 * MIN), "start")
})

test("the Interview clock running out forces a timeout", () => {
  const iv = startClock(roomOpened(beginOpening(base()), room, 0), 5 * MIN)
  assert.equal(due(iv, 65 * MIN - 1), undefined)
  assert.equal(due(iv, 65 * MIN), "timeout")
  assert.equal(secondsLeft(iv, 70 * MIN), 0)
})

test("nothing is due while waiting on a person or on Solari", () => {
  assert.equal(due(base(), 1e12), undefined)
  assert.equal(due(beginOpening(base()), 1e12), undefined)
})

test("rejects moves from the wrong phase", () => {
  assert.throws(() => startClock(base(), 0), PhaseError)
  assert.throws(() => beginOpening(beginOpening(base())), PhaseError)
  const working = startClock(roomOpened(beginOpening(base()), room, 0), 0)
  assert.throws(() => startClock(working, 0), PhaseError, "a second Start is refused")
})

test("a failure drops the stream link too", () => {
  const iv = failed(roomOpened(beginOpening(base()), room, 0), "boom")
  assert.equal(iv.phase, "failed")
  assert.equal(iv.streamUrl, undefined)
})

test("a finished Interview cannot be marked failed", () => {
  let iv = startClock(roomOpened(beginOpening(base()), room, 0), 0)
  iv = graded(collected(stopClock(iv, "submitted", 1), ""), { passed: 1, failed: 0, total: 1, output: "" })
  assert.throws(() => failed(iv, "late error"), PhaseError)
  assert.throws(() => failed(failed(base(), "first"), "second"), PhaseError)
})

test("refuses a non-positive work time", () => {
  assert.throws(() =>
    createInterview({ id: "x", task: "t", candidateToken: "c", reviewerToken: "r", workMinutes: 0, setupMinutes: 5, now: 0 }),
  )
})

// --- the desktop slot ---


const at = (overrides: Partial<ReturnType<typeof base>>) => ({ ...base(), ...overrides })

test("a free slot lets a Room open", () => {
  assert.deepEqual(roomGate([at({ phase: "done" }), at({ phase: "invited" })], 0, 1), { ok: true })
})

test("a busy slot says when it frees: the soonest finish", () => {
  const working = at({ id: "w", phase: "working", startedAt: 0, workMinutes: 10 })
  const gate = roomGate([working], 4 * MIN, 1)
  assert.equal(gate.ok, false)
  if (!gate.ok) assert.equal(gate.retryAfterSeconds, (10 * MIN + FINISH_MS - 4 * MIN) / 1000)
})

test("grading still holds the slot", () => {
  assert.equal(roomGate([at({ phase: "grading" })], 0, 1).ok, false)
  assert.equal(roomGate([at({ phase: "grading" })], 0, 2).ok, true, "a bigger plan has room")
})

test("the demo cap counts demos in the last 24 hours only", () => {
  const DAY = 24 * 60 * MIN
  const now = 10 * DAY
  const demos = [
    at({ id: "old", demo: true, phase: "done", createdAt: now - DAY - 1 }),
    at({ id: "a", demo: true, phase: "done", createdAt: now - 5 * MIN }),
    at({ id: "b", demo: true, phase: "done", createdAt: now - 2 * MIN }),
    at({ id: "real", phase: "done", createdAt: now - MIN }),
  ]
  assert.deepEqual(demoGate(demos, now, { dailyLimit: 3, maxRooms: 1 }), { ok: true })
  const capped = demoGate(demos, now, { dailyLimit: 2, maxRooms: 1 })
  assert.equal(capped.ok, false)
  if (!capped.ok) {
    assert.equal(capped.reason, "cap")
    assert.equal(capped.retryAfterSeconds, (DAY - 5 * MIN) / 1000, "frees when the oldest recent demo ages out")
  }
})
