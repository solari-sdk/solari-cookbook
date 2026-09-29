/**
 * The pool's whole job is accounting: never more in flight than the cap allows,
 * and never resolve while a probe is still running. Both failure modes here
 * were real: a retry that left the `active` count let the fleet resolve early
 * (and then fire a probe after the backend had closed), or hang forever.
 */
import { describe, expect, it } from "vitest"
import { runFleet } from "../src/fleet.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
class Cap extends Error {}
const isCap = (e: unknown) => e instanceof Cap

describe("runFleet", () => {
  it("returns results in task order, whatever order they finish in", async () => {
    const r = await runFleet(
      [async () => { await sleep(30); return "slow" }, async () => "fast"],
      { concurrency: 2 },
    )
    expect(r.map((x) => x.value)).toEqual(["slow", "fast"])
  })

  it("never has more than `concurrency` tasks in flight", async () => {
    let inFlight = 0
    let peak = 0
    const task = async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(5); inFlight--; return 1 }
    await runFleet(Array.from({ length: 10 }, () => task), { concurrency: 3 })
    expect(peak).toBe(3)
  })

  it("shrinks the pool on a backpressure error and retries that task", async () => {
    let calls = 0
    const events: number[] = []
    const r = await runFleet(
      [async () => { if (calls++ === 0) throw new Cap("429"); return "ok" }],
      { concurrency: 4, backoffMs: 1, isBackpressure: isCap, onEvent: (e) => events.push(e.concurrency) },
    )
    expect(r[0]).toEqual({ value: "ok", attempts: 2 })
    expect(events).toEqual([3])
  })

  it("after a shrink, no more probes run at once than the new limit allows", async () => {
    let inFlight = 0
    let shrunk = false
    let peakAfterShrink = 0
    let first = true
    const task = (label: number) => async () => {
      if (label === 0 && first) { first = false; throw new Cap("429") }
      inFlight++
      if (shrunk) peakAfterShrink = Math.max(peakAfterShrink, inFlight)
      await sleep(10)
      inFlight--
      return label
    }
    await runFleet([0, 1, 2, 3, 4].map(task), {
      concurrency: 2, backoffMs: 1, isBackpressure: isCap, onEvent: () => { shrunk = true },
    })
    expect(shrunk).toBe(true)
    expect(peakAfterShrink).toBe(1)
  })

  it("does not resolve until a retried task has actually finished", async () => {
    let calls = 0
    let retryFinished = false
    const r = await runFleet(
      [
        async () => { if (calls++ === 0) throw new Cap("429"); await sleep(20); retryFinished = true; return "late" },
        async () => "sibling",
      ],
      { concurrency: 2, backoffMs: 5, isBackpressure: isCap },
    )
    expect(retryFinished).toBe(true)
    expect(r[0]).toEqual({ value: "late", attempts: 2 })
    for (const x of r) expect("value" in x || "error" in x).toBe(true)
  })

  it("resolves when every task is backpressured once (the 429-shrink path)", async () => {
    const seen = new Set<number>()
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      if (!seen.has(i)) { seen.add(i); throw new Cap("429") }
      return i
    })
    const r = await runFleet(tasks, { concurrency: 6, backoffMs: 1, isBackpressure: isCap })
    expect(r.map((x) => x.value)).toEqual([0, 1, 2, 3, 4, 5])
    expect(r.every((x) => x.attempts === 2)).toBe(true)
  })

  it("gives up after maxRetries and reports the error instead of hanging", async () => {
    const r = await runFleet(
      [async () => { throw new Cap("429") }],
      { maxRetries: 2, backoffMs: 1, isBackpressure: isCap },
    )
    expect(r[0]!.attempts).toBe(3)
    expect(r[0]!.error).toBeInstanceOf(Cap)
  })

  it("does not retry an error that is not backpressure", async () => {
    const r = await runFleet([async () => { throw new Error("boom") }], { isBackpressure: isCap })
    expect(r[0]!.attempts).toBe(1)
    expect(String(r[0]!.error)).toContain("boom")
  })
})
