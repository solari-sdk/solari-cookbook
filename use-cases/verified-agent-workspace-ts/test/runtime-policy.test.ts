import assert from "node:assert/strict"
import test from "node:test"
import { assertAllowedChanges, assertStableDiff, buttonDelta, finalAuditFailures } from "../src/runtime-policy.js"

test("blast radius fails closed outside the allowlist", () => {
  assert.doesNotThrow(() => assertAllowedChanges(["src/a.ts"], ["src/a.ts", "src/b.ts"]))
  assert.throws(() => assertAllowedChanges(["src/a.ts", "package.json"], ["src/a.ts"]), /escaped allowlist/)
})

test("accessibility delta makes invisible repairs reviewable", () => {
  assert.deepEqual(buttonDelta(["", "", "Key"], ["Menu", "Settings", "Key"]), [
    { index: 0, before: "", after: "Menu" },
    { index: 1, before: "", after: "Settings" },
  ])
})

test("final audit preserves button count and pre-existing names", () => {
  const before = { kind: "button-accessibility" as const, buttonCount: 6, unnamedButtonCount: 4, buttonNames: ["", "", "", "", "Key", "Scale"], screenshotPath: "before.png", screenshotSha256: "same", title: "x" }
  const after = { kind: "button-accessibility" as const, buttonCount: 6, unnamedButtonCount: 0, buttonNames: ["Menu", "Language", "Settings", "Print", "Key", "Scale"], screenshotPath: "after.png", screenshotSha256: "same", title: "x" }
  assert.deepEqual(finalAuditFailures(before, after, { unnamedButtonCount: 0, preserveButtonCount: true, preserveNames: ["Key", "Scale"] }), [])
  assert.match(finalAuditFailures(before, { ...after, buttonCount: 5 }, { unnamedButtonCount: 0, preserveButtonCount: true })[0] ?? "", /button count/)
})

test("baseline and bootstrap phases must leave a clean source tree", async () => {
  const { assertCleanTree } = await import("../src/runtime-policy.js")
  assert.doesNotThrow(() => assertCleanTree({ clean: true }, "baseline"))
  assert.throws(() => assertCleanTree({ clean: false, modified: ["src/generated.ts"] }, "baseline"), /baseline dirtied source tree/)
})

test("verification feedback preserves both stdout and stderr", async () => {
  const { commandFailureDetail } = await import("../src/runtime-policy.js")
  const detail = commandFailureDetail({ command: "npm run lint", exitCode: 1, stdout: "src/a.ts: prettier warning", stderr: "too many warnings" })
  assert.match(detail, /src\/a\.ts: prettier warning/)
  assert.match(detail, /too many warnings/)
})


test("static verification cannot mutate the attributed agent diff", () => {
  assert.doesNotThrow(() => assertStableDiff("abc", "abc", "static verification"))
  assert.throws(() => assertStableDiff("abc", "def", "static verification"), /changed the agent diff/)
})
