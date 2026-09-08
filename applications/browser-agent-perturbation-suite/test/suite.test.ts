import { describe as group, expect, it } from "vitest"
import { parseSuite } from "../src/suite.js"

const valid = {
  task: { description: "add the thing", expect: { productSku: "aurora-headphones" } },
  variants: ["baseline"],
  repetitions: 2,
}

group("parseSuite", () => {
  it("fills in the defaults it can and keeps what was given", () => {
    const suite = parseSuite(JSON.stringify(valid))
    expect(suite.repetitions).toBe(2)
    expect(suite.concurrency).toBe(2)
    expect(suite.task.maxSteps).toBe(25)
    expect(suite.thresholds).toEqual({})
  })

  it("rejects an unknown variant up front, not three minutes into a paid run", () => {
    expect(() =>
      parseSuite(JSON.stringify({ ...valid, variants: ["baseline", "nope"] })),
    ).toThrow(/unknown variant "nope"/)
  })

  it("refuses a suite with nothing to run", () => {
    expect(() => parseSuite(JSON.stringify({ ...valid, variants: [] }))).toThrow(/at least one/)
  })

  it("refuses a nonsense repetition count", () => {
    expect(() => parseSuite(JSON.stringify({ ...valid, repetitions: 0 }))).toThrow(/positive/)
  })

  it("names the file when the JSON is broken", () => {
    expect(() => parseSuite("{not json", "suite.json")).toThrow(/suite\.json is not valid JSON/)
  })

  it("insists on the expectation, because without it nothing can be judged", () => {
    expect(() =>
      parseSuite(JSON.stringify({ ...valid, task: { description: "x" } })),
    ).toThrow(/task\.expect is required/)
  })
})
