/**
 * Two checks, cheap first.
 *
 *   1. The locator parser, against a stub page — no network, no money. This is the part
 *      that has to be right, because it is what stands between a model's output and
 *      arbitrary code execution.
 *   2. One real exploration on a real Solari browser. Trivial 2-3 step flow on
 *      example.com, because every run of this costs credits.
 *
 * Run it with:  npx tsx src/explore.selftest.ts
 */
import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright-core"
import { explore, toLocator } from "./explore.js"

// --- 1. locator parser ------------------------------------------------------

const seen: string[] = []
const chain: Record<string, unknown> = {
  first: () => (seen.push(".first()"), chain),
  last: () => (seen.push(".last()"), chain),
  nth: (n: number) => (seen.push(`.nth(${n})`), chain),
}
const record =
  (name: string) =>
  (...args: unknown[]) => (seen.push(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`), chain)
const stub = {
  getByRole: record("getByRole"),
  getByLabel: record("getByLabel"),
  getByPlaceholder: record("getByPlaceholder"),
  getByText: record("getByText"),
  getByTestId: record("getByTestId"),
  getByTitle: record("getByTitle"),
  getByAltText: record("getByAltText"),
} as unknown as Page

const parses = (expr: string) => {
  seen.length = 0
  toLocator(stub, expr)
  return seen.join("")
}

assert.equal(
  parses("getByRole('button', { name: 'Sign in' })"),
  'getByRole("button", {"name":"Sign in"})',
)
// An apostrophe inside the name is the everyday case that breaks naive comma splitting.
assert.equal(
  parses(`getByRole("link", { name: "Don't have an account?", exact: true })`),
  'getByRole("link", {"name":"Don\'t have an account?","exact":true})',
)
assert.equal(parses("getByRole('heading', { level: 1 })"), 'getByRole("heading", {"level":1})')
assert.equal(parses("getByLabel('Email').first()"), 'getByLabel("Email", {}).first()')
assert.equal(parses("getByText('Total').nth(2)"), 'getByText("Total", {}).nth(2)')
assert.equal(parses("getByTestId('cart')"), 'getByTestId("cart")')
// Escaped quote inside a single-quoted string.
assert.equal(parses("getByText('it\\'s here')"), 'getByText("it\'s here", {})')

// --- and everything we refuse ---
assert.throws(() => parses("page.locator('#login')"), /cannot parse locator expression/)
assert.throws(() => parses("locator('.btn')"), /unsupported locator 'locator/)
assert.throws(() => parses("getByRole('button').click()"), /unsupported locator chain '\.click/)
assert.throws(() => parses("getByRole('button', { onclick: 'x' })"), /unsupported locator option/)
assert.throws(() => parses("getByText(/total/i)"), /expected a quoted string/)
assert.throws(() => parses("getByText(process.env.HOME)"), /expected a quoted string/)
assert.throws(() => parses("getByRole('button'"), /unbalanced brackets/)
assert.throws(() => parses("#id"), /cannot parse locator expression/)
console.log("locator parser: ok")

// --- 2. one real run --------------------------------------------------------

const outDir = mkdtempSync(join(tmpdir(), "ghostspec-selftest-"))
console.log("outDir:", outDir)

const trace = await explore(
  "https://example.com",
  "read the page heading and follow the more-information link",
  { maxSteps: 5, outDir },
)

console.log(JSON.stringify(trace, null, 2))

assert.ok(trace.sessionId, "no session was created")
assert.ok(!trace.failed, `exploration failed: ${trace.failed}`)
assert.ok(trace.steps.length >= 2, `expected at least a goto and a click, got ${trace.steps.length}`)
assert.equal(trace.steps[0].action, "goto")
assert.ok(
  trace.steps.some((s) => s.action === "click"),
  "never clicked anything",
)
assert.equal(trace.screenshots.length, 2, "expected a start and a final screenshot")
assert.ok(
  trace.steps.every((s) => s.value !== ""),
  "an empty-string value would become .click(\"\") in the generated spec",
)
console.log("explore selftest: ok")
