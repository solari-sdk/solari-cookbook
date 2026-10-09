// The flow, tested through its interface with in-memory Rooms and Grader, a
// temporary store, and mocked clocks. No Solari, no credit.
import { afterEach, beforeEach, mock, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFlow, SlotError, type Collected, type Grader, type OpenedRoom, type RoomState, type Rooms } from "../src/flow.ts"
import { PhaseError, type Grade } from "../src/interview.ts"
import { createStore, type Store } from "../src/store.ts"
import { loadTask, type Task } from "../src/tasks.ts"

const MIN = 60_000

class FakeRooms implements Rooms {
  state = new Map<string, RoomState>()
  collected: string[] = []
  killed: string[] = []
  failOpen?: Error
  failCollect?: Error

  async open(_task: Task, interviewId: string): Promise<OpenedRoom> {
    if (this.failOpen) throw this.failOpen
    const roomId = `room-${interviewId}`
    this.state.set(roomId, "alive")
    return { roomId, streamUrl: `wss://fake/stream/${roomId}`, recordingUrl: `https://fake/${roomId}.mp4` }
  }
  async collect(roomId: string): Promise<Collected> {
    if (this.failCollect) throw this.failCollect
    this.collected.push(roomId)
    this.state.set(roomId, "gone")
    return { gitLog: "abc1234 Implement it\n", finalState: new TextEncoder().encode("final state") }
  }
  async kill(roomId: string) {
    this.killed.push(roomId)
    this.state.set(roomId, "gone")
  }
  async wake(roomId: string) {
    return this.state.get(roomId) ?? "gone"
  }
  async saveRecording(_url: string, path: string) {
    writeFileSync(path, "video")
    return true
  }
}

const passing: Grade = { passed: 9, failed: 0, total: 9, output: "Ran 9 tests\n\nOK\n" }
const grader: Grader = { run: async () => passing }
const limits = { maxRooms: 1, demo: { task: "lru-cache", workMinutes: 10, setupMinutes: 3, dailyLimit: 2 } }

let dir: string
let store: Store
let rooms: FakeRooms
const flows: ReturnType<typeof createFlow>[] = []

function makeFlow(overrides: { limits?: typeof limits } = {}) {
  const flow = createFlow({ store, rooms, grader, loadTask, limits: overrides.limits ?? limits, log: () => {} })
  flows.push(flow)
  return flow
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 })
  dir = mkdtempSync(join(tmpdir(), "takehome-room-test-"))
  store = createStore(dir)
  rooms = new FakeRooms()
})

afterEach(() => {
  for (const f of flows.splice(0)) f.close()
  mock.timers.reset()
  rmSync(dir, { recursive: true, force: true })
})

/** An Interview whose Room is open, in setup. */
async function opened(flow = makeFlow(), opts = { workMinutes: 30, setupMinutes: 5 }) {
  const iv = flow.create("lru-cache", opts)
  flow.open(iv.id)
  await flow.settled()
  return { flow, id: iv.id }
}

test("from link to grade: the work, the video and the test output are kept", async () => {
  const { flow, id } = await opened()
  assert.equal(store.load(id)!.phase, "setup")
  flow.start(id)
  flow.end(id, "submitted")
  await flow.settled()

  const done = store.load(id)!
  assert.equal(done.phase, "done")
  assert.deepEqual(done.grade, passing)
  assert.equal(done.gitLog, "abc1234 Implement it\n")
  assert.equal(done.streamUrl, undefined, "the dead stream link is not kept")
  const art = store.artifactDir(id)
  for (const f of ["final-state.tgz", "recording.mp4", "hidden-tests.txt"]) assert.ok(existsSync(join(art, f)), f)
})

test("a second Submit is refused, and the Room is collected once", async () => {
  const { flow, id } = await opened()
  flow.start(id)
  flow.end(id, "submitted")
  assert.throws(() => flow.end(id, "submitted"), PhaseError)
  await flow.settled()
  assert.deepEqual(rooms.collected, [`room-${id}`])
})

test("work time running out ends the Interview as a timeout", async () => {
  const { flow, id } = await opened()
  flow.start(id)
  mock.timers.tick(30 * MIN - 1000)
  assert.equal(store.load(id)!.phase, "working")
  mock.timers.tick(2000)
  await flow.settled()
  assert.equal(store.load(id)!.phase, "done")
  assert.equal(store.load(id)!.endReason, "timeout")
})

test("setup time running out starts the clock without a Start", async () => {
  const { id } = await opened()
  mock.timers.tick(5 * MIN + 1000)
  const iv = store.load(id)!
  assert.equal(iv.phase, "working")
  assert.equal(iv.startedAt, iv.openedAt! + 5 * MIN, "the clock starts when setup ended")
})

test("after a restart, setup and work time that both ran out end the Interview", async () => {
  const { flow, id } = await opened()
  flow.close()
  mock.timers.tick(5 * MIN + 30 * MIN + MIN) // down through all of setup and work time

  const restarted = makeFlow()
  restarted.resume()
  mock.timers.tick(1000)
  await restarted.settled()
  const iv = store.load(id)!
  assert.equal(iv.phase, "done", "no fresh work time after the restart")
  assert.equal(iv.startedAt, iv.openedAt! + 5 * MIN)
  assert.equal(iv.endReason, "timeout")
})

test("a Room that fails to open fails the Interview and frees the slot", async () => {
  rooms.failOpen = new Error("capacity")
  const { flow, id } = await opened()
  assert.equal(store.load(id)!.phase, "failed")
  assert.match(store.load(id)!.error!, /capacity/)
  rooms.failOpen = undefined
  const next = flow.create("lru-cache")
  assert.doesNotThrow(() => flow.open(next.id))
})

test("with one machine, a second Room waits and is told for how long", async () => {
  const { flow } = await opened()
  const second = flow.create("lru-cache")
  assert.throws(
    () => flow.open(second.id),
    (e: unknown) => e instanceof SlotError && e.reason === "busy" && e.retryAfterSeconds > 0,
  )
  assert.equal(store.load(second.id)!.phase, "invited", "nothing changed")
})

test("a Room that disappeared fails its Interview when the page checks in", async () => {
  const { flow, id } = await opened()
  rooms.state.set(`room-${id}`, "gone")
  flow.wake(id)
  await flow.settled()
  assert.equal(store.load(id)!.phase, "failed")
  assert.match(store.load(id)!.error!, /desktop stopped/)
})

test("not being able to ask about a Room is not proof that it died", async () => {
  const { flow, id } = await opened()
  rooms.wake = async () => {
    throw new Error("network")
  }
  flow.wake(id)
  await flow.settled()
  assert.equal(store.load(id)!.phase, "setup")
})

test("if collecting fails, the Room is still killed and the Interview fails", async () => {
  const { flow, id } = await opened()
  rooms.failCollect = new Error("control channel closed")
  flow.start(id)
  flow.end(id, "submitted")
  await flow.settled()
  assert.equal(store.load(id)!.phase, "failed")
  assert.deepEqual(rooms.killed, [`room-${id}`])
})

test("after a restart, time that ran out while the server was down ends the Interview", async () => {
  const { flow, id } = await opened()
  flow.start(id)
  flow.close() // the server goes down; its timers die with it
  mock.timers.tick(45 * MIN)
  assert.equal(store.load(id)!.phase, "working", "nobody was there to end it")

  const restarted = makeFlow()
  restarted.resume()
  await restarted.settled()
  assert.equal(store.load(id)!.phase, "done")
  assert.equal(store.load(id)!.endReason, "timeout")
})

test("after a restart, a Room that was still opening is marked failed", async () => {
  const flow = makeFlow()
  const iv = flow.create("lru-cache")
  rooms.open = () => new Promise(() => {}) // never finishes: the process dies mid-open
  flow.open(iv.id)
  flow.close()

  makeFlow().resume()
  assert.equal(store.load(iv.id)!.phase, "failed")
})

test("demos are capped per 24 hours", async () => {
  const flow = makeFlow()
  flow.createDemo()
  flow.createDemo()
  assert.throws(
    () => flow.createDemo(),
    (e: unknown) => e instanceof SlotError && e.reason === "cap",
  )
  mock.timers.tick(24 * 60 * MIN + 1)
  assert.doesNotThrow(() => flow.createDemo())
})
