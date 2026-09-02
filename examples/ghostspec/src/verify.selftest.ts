/**
 * The claim, end to end, against real infrastructure: a hand-written trace goes
 * through the model, and the spec that comes out is run by the real Playwright
 * runner on a real Solari cloud browser. Costs one session, ~15 s of browser.
 *
 *   npx tsx src/verify.selftest.ts
 */
import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateSpec } from "./generate.js"
import { verifySpec } from "./verify.js"
import type { Trace } from "./types.js"

// Every locator here was read off a live example.com via ariaSnapshot — which is
// how a real trace is built. Note the link's accessible name is "Learn more",
// not the "More information..." everyone remembers; that is exactly the kind of
// detail a model guesses wrong and an observed trace gets right.
const trace: Trace = {
  url: "https://example.com",
  goal: "open example.com and follow its only link",
  steps: [
    { action: "goto", value: "https://example.com", note: "Start on the page under test." },
    {
      action: "expect",
      locator: "getByRole('heading', { name: 'Example Domain' })",
      value: "Example Domain",
      note: "The h1 is what tells us the page actually loaded.",
    },
    {
      action: "click",
      locator: "getByRole('link', { name: 'Learn more' })",
      note: "Follow the only link on the page.",
    },
  ],
  screenshots: [],
}

const spec = await generateSpec(trace)
console.log("─── generated spec ───────────────────────────────────────────\n")
console.log(spec)

// The product claim, asserted: delete every locator the trace vouches for and
// nothing locator-shaped may be left over.
let residue = spec
for (const s of trace.steps) if (s.locator) residue = residue.split(s.locator).join("")
assert.ok(!/getBy[A-Z]|\.locator\(/.test(residue), "spec used a locator that is not in the trace")
assert.ok(!/waitForTimeout/.test(spec), "spec used waitForTimeout")

const dir = mkdtempSync(join(tmpdir(), "ghostspec-selftest-"))
console.log(`─── running it for real (${dir}) ─────────────────────────────\n`)
const run = await verifySpec(spec, dir)
console.log(run.output)
console.log(`\npassed=${run.passed} failed=${run.failed}`)

assert.equal(run.failed, 0, "the generated spec did not pass on a real browser")
assert.ok(run.passed >= 1, "no test actually ran")
console.log("\nverify.selftest: ok")
