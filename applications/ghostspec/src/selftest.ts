/** `npm test` — the smallest thing that fails if the parsing logic breaks. */
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractJson } from "./llm.js"
import { writeReport } from "./report.js"
import type { Trace } from "./types.js"

// Bare object.
assert.deepEqual(extractJson('{"a":1}'), { a: 1 })

// Fenced, with the apology models like to prepend.
assert.deepEqual(extractJson('Sure! Here you go:\n```json\n{"a":1}\n```'), { a: 1 })

// Nested braces must not terminate early.
assert.deepEqual(extractJson('x {"a":{"b":[1,2]},"c":3} y'), { a: { b: [1, 2] }, c: 3 })

// A brace *inside a string* is not structure. This is the one that bites:
// a locator like getByRole('button', { name: 'x' }) is full of them.
assert.deepEqual(extractJson('{"loc":"getByRole(\'button\', { name: \'Go\' })"}'), {
  loc: "getByRole('button', { name: 'Go' })",
})

// Escaped quote must not flip us out of string mode.
assert.deepEqual(extractJson('{"s":"he said \\"hi\\" }"}'), { s: 'he said "hi" }' })

// Top-level array.
assert.deepEqual(extractJson('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }])

// Prose containing a brace before the real payload — we take the first balanced run.
assert.throws(() => extractJson("no json here"), /no JSON/)
assert.throws(() => extractJson('{"a":1'), /unbalanced/)

// --- report verdict precedence -------------------------------------------
// An unfinished exploration must outrank a green run: a spec that passes while
// covering a third of the flow is the most misleading thing we could display.
const base: Trace = { url: "https://x.test", goal: "g", steps: [], screenshots: [] }
const render = (trace: Trace, run: Parameters<typeof writeReport>[2]) => {
  const f = join(tmpdir(), `ghostspec-report-${Math.random().toString(36).slice(2)}.html`)
  writeReport(f, trace, run)
  return readFileSync(f, "utf8")
}

assert.match(render(base, { spec: "", passed: 1, failed: 0, output: "" }), /verified/)
assert.match(render(base, { spec: "", passed: 0, failed: 2, output: "" }), /2 failing/)
assert.match(render(base, null), /did not run/)
// green run, but the flow never finished -> must NOT say verified
const cut = render({ ...base, failed: "gave up after 3 tries" }, { spec: "", passed: 1, failed: 0, output: "" })
assert.match(cut, /incomplete/)
assert.doesNotMatch(cut, /verified/)

console.log("selftest: ok")
