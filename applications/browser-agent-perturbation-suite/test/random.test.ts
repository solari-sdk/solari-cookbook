import { describe as group, expect, it } from "vitest"
import { createRng, deriveSeed } from "../src/random.js"

group("deriveSeed", () => {
  it("is stable for the same run, variant and repetition", () => {
    expect(deriveSeed("run-1", "cookie_banner", 1)).toBe(deriveSeed("run-1", "cookie_banner", 1))
  })

  it("separates variants and repetitions", () => {
    const a = deriveSeed("run-1", "cookie_banner", 1)
    expect(deriveSeed("run-1", "slow_api", 1)).not.toBe(a)
    // Repetitions must differ, or a perturbation with jitter would produce the
    // identical environment twice and flip rate would measure nothing.
    expect(deriveSeed("run-1", "cookie_banner", 2)).not.toBe(a)
  })

  it("stays a positive 31-bit integer", () => {
    for (let i = 0; i < 200; i++) {
      const seed = deriveSeed("run", "variant", i)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 31)
    }
  })
})

group("createRng", () => {
  it("replays the same sequence from the same seed", () => {
    const draw = () => {
      const rng = createRng(12345)
      return [rng.next(), rng.next(), rng.next()]
    }
    expect(draw()).toEqual(draw())
  })

  it("keeps jitter inside the requested ratio", () => {
    const rng = createRng(7)
    for (let i = 0; i < 500; i++) {
      const value = rng.jitter(1000, 0.3)
      expect(value).toBeGreaterThanOrEqual(700)
      expect(value).toBeLessThanOrEqual(1300)
    }
  })
})
