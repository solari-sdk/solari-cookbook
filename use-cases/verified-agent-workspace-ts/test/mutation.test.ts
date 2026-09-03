import assert from "node:assert/strict"
import test from "node:test"
import { sha256Text } from "../src/evidence.js"

test("hashes mutation material deterministically without storing it", () => {
  assert.equal(
    sha256Text("diff --git a/a b/a\n-old\n+new\n"),
    "9b3d90f73504e1fae2399abb01fb61e86be40f3f556cfb700356ab399804c547",
  )
})
