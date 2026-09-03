import assert from "node:assert/strict"
import test from "node:test"
import { evaluateButtonAudit, validateJobSpec } from "../src/job-spec.js"

const validJob = {
  version: 1,
  name: "buddy-a11y",
  source: { repository: "https://github.com/example/repo.git", ref: "a".repeat(40), issue: 42 },
  bootstrapCommands: ["npm install"],
  agent: {
    endpoint: "https://example.com/v1/chat/completions",
    model: "model",
    secretEnv: "TEST_AGENT_KEY",
    allowlist: ["src/a.ts"],
    systemPrompt: "system",
    taskPrompt: "task",
    maxTokens: 2000,
    maxAttempts: 2,
  },
  verificationCommands: ["npm test"],
  preview: {
    port: 3000,
    baselineCommand: "npm run dev",
    finalCommand: "npm run preview",
  },
  browser: {
    kind: "button-accessibility" as const,
    route: "/scale",
    waitForSelector: "#scale-page",
    baseline: { buttonCount: 6, unnamedButtonCount: 4, mustIncludeNames: ["Key", "Scale"] },
    final: { unnamedButtonCount: 0, preserveButtonCount: true, preserveNames: ["Key", "Scale"] },
  },
  artifactsDir: "artifacts-buddy",
}

test("accepts a bounded immutable job spec", () => {
  assert.equal(validateJobSpec(validJob).name, "buddy-a11y")
})

test("rejects mutable refs and unsafe allowlist paths", () => {
  assert.throws(() => validateJobSpec({ ...validJob, source: { ...validJob.source, ref: "main" } }), /40-character/)
  assert.throws(() => validateJobSpec({ ...validJob, agent: { ...validJob.agent, allowlist: ["../secret"] } }), /relative/)
  assert.throws(() => validateJobSpec({ ...validJob, agent: { ...validJob.agent, allowlist: ["src/./a.ts"] } }), /canonical/)
  assert.throws(() => validateJobSpec({ ...validJob, agent: { ...validJob.agent, allowlist: ["src\\a.ts"] } }), /canonical/)
})

test("turns browser expectations into explicit gate failures", () => {
  const result = evaluateButtonAudit(
    { kind: "button-accessibility" as const, buttonCount: 6, unnamedButtonCount: 4, buttonNames: ["", "", "", "", "Key", "Scale"], screenshotPath: "x.png", screenshotSha256: "abc", title: "x" },
    { buttonCount: 6, unnamedButtonCount: 4, mustIncludeNames: ["Key", "Scale"] },
  )
  assert.deepEqual(result, [])
  assert.match(evaluateButtonAudit({ ...resultFixture(), unnamedButtonCount: 3 }, { unnamedButtonCount: 4 })[0] ?? "", /unnamed/)
})

function resultFixture() {
  return { kind: "button-accessibility" as const, buttonCount: 6, unnamedButtonCount: 4, buttonNames: ["", "", "", "", "Key", "Scale"], screenshotPath: "x.png", screenshotSha256: "abc", title: "x" }
}


test("rejects coercive booleans, unsafe artifact paths, and cross-origin browser routes", () => {
  const coercive = structuredClone(validJob) as any
  coercive.browser.final.preserveButtonCount = "false"
  assert.throws(() => validateJobSpec(coercive), /preserveButtonCount must be a boolean/)

  const unsafeArtifacts = structuredClone(validJob) as any
  unsafeArtifacts.artifactsDir = "../../outside"
  assert.throws(() => validateJobSpec(unsafeArtifacts), /artifactsDir must be a canonical safe relative path/)
  unsafeArtifacts.artifactsDir = "."
  assert.throws(() => validateJobSpec(unsafeArtifacts), /artifactsDir must be a canonical safe relative path/)

  const crossOrigin = structuredClone(validJob) as any
  crossOrigin.browser.route = "https://example.com/scale"
  assert.throws(() => validateJobSpec(crossOrigin), /browser.route must be a same-origin absolute path/)
})

test("supports text browser verification as a typed verifier kind", () => {
  const textJob = structuredClone(validJob) as any
  textJob.browser = {
    kind: "text",
    route: "/",
    waitForSelector: "body",
    baseline: { mustExcludeText: "repaired" },
    final: { mustIncludeText: "repaired" },
  }
  assert.equal(validateJobSpec(textJob).browser.kind, "text")
})

test("issue snapshots require a canonical path/hash pair and issue number", () => {
  const paired = structuredClone(validJob) as any
  paired.source.issueSnapshotPath = "jobs/issue.snapshot.json"
  paired.source.issueSnapshotSha256 = "a".repeat(64)
  assert.equal(validateJobSpec(paired).source.issueSnapshotPath, "jobs/issue.snapshot.json")

  const missingPath = structuredClone(paired) as any
  delete missingPath.source.issueSnapshotPath
  assert.throws(() => validateJobSpec(missingPath), /issue snapshot path and SHA-256 must be provided together/)

  const missingIssue = structuredClone(paired) as any
  delete missingIssue.source.issue
  assert.throws(() => validateJobSpec(missingIssue), /issue snapshot requires source.issue/)
})

test("browser localStorage seed is typed and deterministic job policy", () => {
  const seeded = structuredClone(validJob) as any
  seeded.browser.localStorage = { i18nextLng: "en-US" }
  const parsed = validateJobSpec(seeded)
  assert.deepEqual(parsed.browser.localStorage, { i18nextLng: "en-US" })

  const invalid = structuredClone(seeded) as any
  invalid.browser.localStorage = { i18nextLng: false }
  assert.throws(() => validateJobSpec(invalid), /browser.localStorage/)
})
