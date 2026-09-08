import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe as group, expect, it, vi } from "vitest"
import { PERTURBATIONS, requirePerturbation, resolveEnvironment } from "../src/perturbations.js"
import { deriveSeed } from "../src/random.js"

const SHOP = readFileSync(fileURLToPath(new URL("../fixture/shop.py", import.meta.url)), "utf8")

group("the registry", () => {
  afterEach(() => vi.restoreAllMocks())

  it("gives every perturbation a unique id and a description", () => {
    const ids = PERTURBATIONS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PERTURBATIONS) expect(p.description.length).toBeGreaterThan(10)
  })

  it("names the unknown variant and the known ones when asked for a typo", () => {
    expect(() => requirePerturbation("cookie_popup")).toThrow(/unknown variant "cookie_popup"/)
    expect(() => requirePerturbation("cookie_popup")).toThrow(/cookie_banner/)
  })

  it("leaves baseline completely unperturbed", () => {
    const environment = resolveEnvironment(requirePerturbation("baseline"), 1)
    expect(environment.site).toEqual({})
    expect(environment.browser).toEqual({})
  })

  it("resolves the same seed to the same environment, every time", () => {
    const seed = deriveSeed("run-1", "unexpected_modal", 1)
    const once = resolveEnvironment(requirePerturbation("unexpected_modal"), seed)
    const twice = resolveEnvironment(requirePerturbation("unexpected_modal"), seed)
    expect(once).toEqual(twice)
  })

  it("gives different repetitions genuinely different environments", () => {
    // If this stops holding, repeating a variant re-runs an identical world and
    // the flip rate has nothing left to measure.
    const first = resolveEnvironment(
      requirePerturbation("unexpected_modal"),
      deriveSeed("run-1", "unexpected_modal", 1),
    )
    const second = resolveEnvironment(
      requirePerturbation("unexpected_modal"),
      deriveSeed("run-1", "unexpected_modal", 2),
    )
    expect(first.site.unexpectedModal?.afterMs).not.toBe(second.site.unexpectedModal?.afterMs)
  })

  it("never reads the clock or Math.random", () => {
    // The reproducibility claim rests entirely on this. Make both sources
    // explode and resolve the whole registry.
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random is not allowed in a perturbation")
    })
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("the clock is not allowed in a perturbation")
    })

    for (const perturbation of PERTURBATIONS) {
      expect(() => resolveEnvironment(perturbation, 42)).not.toThrow()
    }
  })

  it("keeps its site knobs in step with the fixture that implements them", () => {
    // The real product enforces this with a compile-time type guard across two
    // packages. Here the fixture is Python, so the equivalent check is that
    // every knob the registry can emit is actually read by shop.py. Without it,
    // renaming a knob silently disables a perturbation while the results table
    // still prints a row for it.
    const knobs = new Set<string>()
    for (const perturbation of PERTURBATIONS) {
      for (let seed = 1; seed <= 8; seed++) {
        for (const key of Object.keys(resolveEnvironment(perturbation, seed).site)) {
          knobs.add(key)
        }
      }
    }

    expect(knobs.size).toBeGreaterThan(0)
    for (const knob of knobs) {
      expect(SHOP, `shop.py never reads the "${knob}" knob`).toContain(`"${knob}"`)
    }
  })
})
