/**
 * Pins the class list to the app it is checking.
 *
 * A `mustSee`/`mustNotSee` list can be wrong in a way that still passes: name
 * a testid the page never renders in `mustNotSee` and the class is green
 * forever without checking anything. These tests derive what the page actually
 * produces from `render()` and judge the classes against that, so an
 * expectation that has drifted away from the app fails here rather than
 * silently weakening the check.
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_BUGS, NO_BUGS, render } from "../demo-site/app.js"
import { CLASSES } from "../src/classes.js"
import { judge } from "../src/check.js"

/** Everything render() can ever emit, so a typo in a class list is caught. */
const KNOWN = ["heading", "tier", "consent-banner", "signin", "export", "admin", "quota", "tracker"]

const testidsFor = (cookies: { name: string; value: string }[], bugs: typeof DEFAULT_BUGS) => {
  const c = Object.fromEntries(cookies.map((k) => [k.name, k.value]))
  const tier = (["anon", "free", "paid", "admin"].includes(c.tier ?? "") ? c.tier : "anon") as
    "anon" | "free" | "paid" | "admin"
  const html = render(tier, c.consent ?? "", bugs)
  return [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!)
}

describe("class definitions", () => {
  it("gives every class a distinct identity", () => {
    const keys = CLASSES.map((c) =>
      JSON.stringify([...c.cookies].sort((a, b) => a.name.localeCompare(b.name))))
    expect(new Set(keys).size, "two classes share cookies, so one verdict must be wrong").toBe(keys.length)
  })

  it("only names testids the app can actually render", () => {
    for (const c of CLASSES) {
      for (const t of [...c.mustSee, ...c.mustNotSee]) {
        expect(KNOWN, `${c.name} expects unknown testid "${t}"`).toContain(t)
      }
    }
  })

  it("every class passes against the corrected app", () => {
    for (const c of CLASSES) {
      expect(judge(c, testidsFor(c.cookies, NO_BUGS)), `${c.name} should pass when the app is right`)
        .toEqual([])
    }
  })

  it("catches exactly the planted bugs, and names them", () => {
    const failures = Object.fromEntries(
      CLASSES.map((c) => [c.name, judge(c, testidsFor(c.cookies, DEFAULT_BUGS))])
        .filter(([, f]) => (f as unknown[]).length > 0)
        .map(([n, f]) => [n as string, (f as { testid: string }[]).map((x) => x.testid).sort()]),
    )
    // Derived from the two bugs in site.js: the export button leaks to `free`,
    // and the tracker fires without consent. Every identity those touch must
    // report them -- including the ones whose headline concern is the other bug.
    expect(failures).toEqual({
      anon: ["tracker"],
      free: ["export"],
      "eu-consent-rejected": ["export", "tracker"],
    })
  })
})
