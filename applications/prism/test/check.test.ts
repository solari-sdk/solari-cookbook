import { describe, expect, it } from "vitest"
import { SolariError } from "@solarisdk/browser"
import type { Backend } from "../src/backend.js"
import type { UserClass } from "../src/classes.js"
import { check, judge } from "../src/check.js"

const cls: UserClass = { name: "x", because: "", cookies: [], mustSee: ["a", "b"], mustNotSee: ["c"] }

describe("judge", () => {
  it("passes when everything required is present and nothing forbidden is", () => {
    expect(judge(cls, ["a", "b", "z"])).toEqual([])
  })
  it("reports what is missing", () => {
    expect(judge(cls, ["a"])).toEqual([{ kind: "missing", testid: "b" }])
  })
  it("reports what leaked", () => {
    expect(judge(cls, ["a", "b", "c"])).toEqual([{ kind: "leaked", testid: "c" }])
  })
  it("reports both, missing before leaked", () => {
    expect(judge(cls, ["c"])).toEqual([
      { kind: "missing", testid: "a" },
      { kind: "missing", testid: "b" },
      { kind: "leaked", testid: "c" },
    ])
  })
})

describe("check", () => {
  // A backend now owns its own backpressure predicate, so check() never has to
  // know which one it got. The fake declares the SDK's real 429 shape.
  const fake = (probe: Backend["probe"], isBackpressure?: Backend["isBackpressure"]): Backend =>
    ({ name: "fake", probe, isBackpressure, close: async () => {} })
  const solari429 = (e: unknown) => e instanceof SolariError && e.status === 429
  const classes: UserClass[] = ["p", "q", "r"].map((name) => ({
    name, because: "", cookies: [], mustSee: ["heading"], mustNotSee: ["admin"],
  }))

  it("survives the SDK's real 429 on every class and still reports each one", async () => {
    // The error shape is the SDK's own, so this exercises isConcurrencyLimit
    // rather than a stand-in predicate. Every class is refused once; each
    // must be retried and end with a verdict, never `error: undefined`.
    const refused = new Set<string>()
    let probes = 0
    const backend = fake(async (_url, _cookies, label) => {
      probes++
      if (!refused.has(label)) {
        refused.add(label)
        throw new SolariError("at cap", 429, undefined, "ConcurrencyLimitExceeded")
      }
      return { testids: ["heading"], title: "", url: "" }
    }, solari429)
    const events: number[] = []
    const results = await check(backend, "http://example.test/", classes, (e) => events.push(e.concurrency))

    expect(probes).toBe(classes.length * 2)
    expect(events).toEqual([7, 6, 5])
    for (const r of results) {
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
      expect(r.saw).toEqual(["heading"])
    }
  })

  it("turns any other error into a failed verdict for that class only", async () => {
    const backend = fake(async (_url, _cookies, label) => {
      if (label === "q") throw new Error("navigation timeout")
      return { testids: ["heading"], title: "", url: "" }
    })
    const results = await check(backend, "http://example.test/", classes)
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    expect(results[1]!.error).toContain("navigation timeout")
  })
})
