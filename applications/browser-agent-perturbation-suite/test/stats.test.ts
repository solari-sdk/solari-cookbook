import { describe as group, expect, it } from "vitest"
import { flipRate, wilsonInterval } from "../src/stats.js"

group("wilsonInterval", () => {
  it("reports total ignorance for an empty sample, not zero reliability", () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, low: 0, high: 1, n: 0 })
  })

  it("does not claim certainty from a perfect small sample", () => {
    const interval = wilsonInterval(2, 2)
    expect(interval.point).toBe(1)
    expect(interval.high).toBe(1)
    // The whole reason this is not the normal approximation: two out of two
    // must not render as "100%, +/- 0".
    expect(interval.low).toBeLessThan(0.5)
  })

  it("returns an exact zero rather than float noise at the lower bound", () => {
    // Without normalization this is 5.5e-17, which prints as a non-zero
    // percentage and reads like a bug.
    expect(wilsonInterval(0, 2).low).toBe(0)
  })

  it("narrows as the sample grows", () => {
    const small = wilsonInterval(5, 10)
    const large = wilsonInterval(50, 100)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  it("rejects impossible counts instead of returning a plausible number", () => {
    expect(() => wilsonInterval(3, 2)).toThrow(/invalid counts/)
    expect(() => wilsonInterval(1.5, 3)).toThrow(/integer/)
  })
})

group("flipRate", () => {
  it("is null below two repetitions rather than a misleading zero", () => {
    expect(flipRate([])).toBeNull()
    expect(flipRate([true])).toBeNull()
  })

  it("separates consistency from pass rate", () => {
    // Same reliability, very different trustworthiness.
    expect(flipRate([true, false, true, false])).toBe(1)
    expect(flipRate([true, true, false, false])).toBeCloseTo(1 / 3)
  })

  it("is zero when every repetition agreed", () => {
    expect(flipRate([true, true, true])).toBe(0)
    expect(flipRate([false, false])).toBe(0)
  })
})
