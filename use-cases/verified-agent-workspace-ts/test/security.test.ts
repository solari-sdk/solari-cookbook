import assert from "node:assert/strict"
import test from "node:test"
import { capabilityFingerprint, publicPreviewUrl } from "../src/evidence.js"

test("removes signed capability query data from public preview evidence", () => {
  const result = publicPreviewUrl(
    "https://demo.preview.getsolari.com/path?pt_token=super-secret&other=1",
  )
  assert.equal(result, "https://demo.preview.getsolari.com/path")
})

test("fingerprints opaque sandbox capabilities instead of exposing them", () => {
  const value = capabilityFingerprint("signed-sandbox-capability")
  assert.match(value, /^[a-f0-9]{16}$/)
  assert.notEqual(value, "signed-sandbox-capability")
})
