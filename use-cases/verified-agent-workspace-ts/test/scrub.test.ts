import assert from "node:assert/strict"
import test from "node:test"
import { scrubOutput } from "../src/evidence.js"

test("redacts common credentials from captured logs", () => {
  const output = scrubOutput(
    "slr_live_secret123 ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnop Authorization: Bearer topsecret",
  )
  assert(!output.includes("secret123"))
  assert(!output.includes("abcdefghijklmnopqrstuvwxyz"))
  assert(!output.includes("sk-abcdefghijklmnop"))
  assert(!output.includes("topsecret"))
  assert.match(output, /REDACTED/)
})

test("bounds captured log size", () => {
  const output = scrubOutput("x".repeat(20_000))
  assert(output.length < 20_000)
  assert.match(output, /truncated/)
})
