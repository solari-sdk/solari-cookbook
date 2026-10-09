import { test } from "node:test"
import assert from "node:assert/strict"
import { parseUnittest } from "../src/solari/unittest-result.ts"

const run = (tail: string) => `test_a ... ok\n\n----------------------------------------------------------------------\n${tail}`

test("all passing", () => {
  const g = parseUnittest(run("Ran 9 tests in 0.002s\n\nOK\n"))
  assert.deepEqual([g.passed, g.failed, g.total], [9, 0, 9])
})

test("failures and errors both count as failed", () => {
  const g = parseUnittest(run("Ran 9 tests in 0.010s\n\nFAILED (failures=2, errors=3)\n"))
  assert.deepEqual([g.passed, g.failed, g.total], [4, 5, 9])
})

test("skipped tests are neither passed nor failed", () => {
  const g = parseUnittest(run("Ran 4 tests in 0.001s\n\nOK (skipped=1)\n"))
  assert.deepEqual([g.passed, g.failed, g.total], [3, 0, 4])
})

test("a run that never reached the summary scores zero", () => {
  const g = parseUnittest("ModuleNotFoundError: No module named 'cache'\n")
  assert.deepEqual([g.passed, g.failed, g.total], [0, 0, 0])
})

test("one test", () => {
  const g = parseUnittest(run("Ran 1 test in 0.001s\n\nFAILED (errors=1)\n"))
  assert.deepEqual([g.passed, g.failed, g.total], [0, 1, 1])
})
