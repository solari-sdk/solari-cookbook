import assert from "node:assert/strict"
import test from "node:test"
import { relative } from "node:path"

test("public screenshot evidence uses a relative path", () => {
  const absolute = `${process.cwd()}/artifacts/preview.png`
  assert.equal(relative(process.cwd(), absolute), "artifacts/preview.png")
})
