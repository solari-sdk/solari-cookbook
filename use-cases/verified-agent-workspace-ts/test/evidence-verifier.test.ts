import assert from "node:assert/strict"
import test from "node:test"
import { createRuntimeManifest, runtimePolicySnapshot, type RuntimeEvidence } from "../src/runtime-evidence.js"
import { verifyRuntimeEvidence } from "../src/evidence-verifier.js"
import { validateJobSpec } from "../src/job-spec.js"

const rawJobObject = {
  version: 1,
  name: "proof",
  source: { repository: "https://github.com/example/repo.git", ref: "a".repeat(40), issue: 7, issueSnapshotPath: "jobs/issue.snapshot.json", issueSnapshotSha256: "b".repeat(64) },
  bootstrapCommands: ["npm ci"],
  agent: { endpoint: "https://example.com/v1/chat/completions", model: "model", secretEnv: "MODEL_KEY", allowlist: ["src/a.ts"], systemPrompt: "system", taskPrompt: "task", maxTokens: 1000, maxAttempts: 2, reasoningMode: "disabled" },
  verificationCommands: ["npm test"],
  preview: { port: 3000, baselineCommand: "npm start", finalCommand: "npm start" },
  browser: { kind: "button-accessibility", route: "/", waitForSelector: "body", baseline: { buttonCount: 2, unnamedButtonCount: 1, mustIncludeNames: ["Keep"] }, final: { unnamedButtonCount: 0, preserveButtonCount: true, preserveNames: ["Keep"] } },
  artifactsDir: "artifacts-proof",
} as const
const rawJob = `${JSON.stringify(rawJobObject, null, 2)}\n`
const job = validateJobSpec(rawJobObject)
const jobHash = "c".repeat(64)

function evidence(): RuntimeEvidence {
  const baseline = { kind: "button-accessibility" as const, buttonCount: 2, unnamedButtonCount: 1, buttonNames: ["", "Keep"], title: "x", screenshotPath: "artifacts-proof/baseline.png", screenshotSha256: "d".repeat(64) }
  const final = { kind: "button-accessibility" as const, buttonCount: 2, unnamedButtonCount: 0, buttonNames: ["Fixed", "Keep"], title: "x", screenshotPath: "artifacts-proof/final.png", screenshotSha256: "e".repeat(64) }
  return {
    version: 2, engine: "verified-agent-runtime", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:01:00.000Z", job: job.name,
    source: { ...job.source, headSha: job.source.ref }, methodology: undefined, policy: runtimePolicySnapshot(job, jobHash), sandboxFingerprint: "0123456789abcdef",
    baseline, attempts: [{ attempt: 1, result: "ok", changedFiles: ["src/a.ts"], diffSha256: "f".repeat(64), gates: [{ command: "npm test", exitCode: 0, stdout: "", stderr: "" }], browser: final, failures: [], accepted: true }],
    events: [{ phase: "COMPLETE", state: "PASSED", at: "2026-09-01T00:00:59.000Z" }, { phase: "CLEANUP", state: "PASSED", at: "2026-09-01T00:01:00.000Z", detail: "0 active sandboxes" }],
    final, accessibilityDelta: [{ index: 0, before: "", after: "Fixed" }], visualParity: false, previewUrl: "https://proof.preview.getsolari.com/", cleanup: { ownedSandboxesAfterCleanup: 0 }, status: "PASSED",
  }
}

const hash = "1".repeat(64)
const images = { baseline: "d".repeat(64), final: "e".repeat(64) }

test("independently accepts a canonical runtime evidence bundle", () => {
  const proof = evidence()
  proof.policy = runtimePolicySnapshot(job, jobHash)
  assert.deepEqual(verifyRuntimeEvidence(job, jobHash, proof, createRuntimeManifest(proof, hash), hash, images), [])
})

test("rejects manifest-only tampering", () => {
  const proof = evidence(); proof.policy = runtimePolicySnapshot(job, jobHash)
  const manifest: any = createRuntimeManifest(proof, hash)
  manifest.mutation.diffSha256 = "0".repeat(64)
  assert.match(verifyRuntimeEvidence(job, jobHash, proof, manifest, hash, images).join("\n"), /manifest is not the canonical derivation/)
})

test("rejects gate command and semantic browser tampering even with a regenerated manifest", () => {
  const proof = evidence(); proof.policy = runtimePolicySnapshot(job, jobHash)
  proof.attempts[0]!.gates[0]!.command = "true"
  if (!proof.final || proof.final.kind !== "button-accessibility") throw new Error("expected button proof")
  proof.final = { ...proof.final, unnamedButtonCount: 1 }
  proof.attempts[0]!.browser = proof.final
  const failures = verifyRuntimeEvidence(job, jobHash, proof, createRuntimeManifest(proof, hash), hash, images).join("\n")
  assert.match(failures, /gate commands differ/)
  assert.match(failures, /expected 0 unnamed buttons, got 1/)
})

test("reports a missing final screenshot as evidence failure", () => {
  const proof = evidence(); proof.policy = runtimePolicySnapshot(job, jobHash)
  const failures = verifyRuntimeEvidence(job, jobHash, proof, createRuntimeManifest(proof, hash), hash, { baseline: images.baseline }).join("\n")
  assert.match(failures, /final screenshot missing/)
})


test("rejects impossible attempt history and non-canonical screenshot paths", () => {
  const proof = evidence(); proof.policy = runtimePolicySnapshot(job, jobHash)
  const first = proof.attempts[0]!
  proof.attempts = [
    { ...first, attempt: 1, accepted: false, browser: undefined, failures: ["retry"] },
    { ...first, attempt: 3, accepted: false, browser: undefined, failures: ["retry"] },
    { ...first, attempt: 4, accepted: true },
  ]
  if (!proof.final) throw new Error("expected final evidence")
  proof.final.screenshotPath = "somewhere-else/final.png"
  proof.attempts[2]!.browser = proof.final
  const failures = verifyRuntimeEvidence(job, jobHash, proof, createRuntimeManifest(proof, hash), hash, images).join("\n")
  assert.match(failures, /attempt count exceeds maxAttempts/)
  assert.match(failures, /attempt numbering is not sequential/)
  assert.match(failures, /final screenshot path differs from canonical artifact path/)
})
