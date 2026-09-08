import assert from "node:assert/strict"
import test from "node:test"
import { planTypeOperations } from "./secure-input.js"

const resolveTestSecret = (name: string): string => {
  assert.equal(name, "SMTR_TEST_PASSWORD")
  return "1234"
}

test("distributes a four-character secret across four targets", () => {
  assert.deepEqual(
    planTypeOperations(
      "e1,e2,e3,e4",
      "{{SECRET:SMTR_TEST_PASSWORD}}",
      resolveTestSecret,
    ),
    [
      { target: "e1", text: "1" },
      { target: "e2", text: "2" },
      { target: "e3", text: "3" },
      { target: "e4", text: "4" },
    ],
  )
})

test("keeps ordinary single-field typing unchanged", () => {
  assert.deepEqual(planTypeOperations("e0", "test@example.com", () => ""), [
    { target: "e0", text: "test@example.com" },
  ])
})

test("rejects a secret whose length does not match the segment count", () => {
  assert.throws(
    () =>
      planTypeOperations(
        "e1,e2,e3,e4",
        "{{SECRET:SMTR_TEST_PASSWORD}}",
        () => "123",
      ),
    /length does not match/,
  )
})

test("rejects multiple targets for non-secret text", () => {
  assert.throws(
    () => planTypeOperations("e1,e2", "12", () => ""),
    /require an allowlisted secret/,
  )
})
