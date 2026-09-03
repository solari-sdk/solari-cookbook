import { isDeepStrictEqual } from "node:util"
import { evaluateButtonAudit, evaluateTextAudit, type VerifiedAgentJob } from "./job-spec.js"
import { buttonDelta, finalBrowserFailures } from "./runtime-policy.js"
import { createRuntimeManifest, runtimePolicySnapshot, type RuntimeEvidence } from "./runtime-evidence.js"

const EMPTY_DIFF_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const sha256Pattern = /^[0-9a-f]{64}$/

export function verifyRuntimeEvidence(
  job: VerifiedAgentJob,
  jobSpecSha256: string,
  evidence: RuntimeEvidence,
  manifest: unknown,
  evidenceSha256: string,
  screenshots: { baseline?: string; final?: string },
): string[] {
  const failures: string[] = []
  const expect = (condition: boolean, message: string) => { if (!condition) failures.push(message) }

  expect(evidence.version === 2 && evidence.engine === "verified-agent-runtime", "runtime evidence version/engine mismatch")
  expect(evidence.status === "PASSED", `evidence status is ${evidence.status}`)
  expect(!evidence.error, "passed evidence contains an error")
  expect(evidence.job === job.name, "evidence job name differs from job spec")
  expect(evidence.source?.repository === job.source.repository, "evidence repository differs from job")
  expect(evidence.source?.ref === job.source.ref, "evidence source ref differs from job")
  expect(evidence.source?.headSha === job.source.ref, "checked-out HEAD differs from immutable ref")
  expect(evidence.source?.issue === job.source.issue, "evidence issue differs from job")
  expect(evidence.source?.issueSnapshotPath === job.source.issueSnapshotPath, "issue snapshot path differs from job")
  expect(evidence.source?.issueSnapshotSha256 === job.source.issueSnapshotSha256, "issue snapshot SHA-256 differs from job")
  expect(isDeepStrictEqual(evidence.policy, runtimePolicySnapshot(job, jobSpecSha256)), "runtime policy differs from canonical job policy")
  expect(evidence.cleanup?.ownedSandboxesAfterCleanup === 0, "cleanup did not reach zero run-owned sandboxes")
  expect(evidence.events?.some((event) => event.phase === "COMPLETE" && event.state === "PASSED") === true, "COMPLETE/PASSED event missing")
  expect(evidence.events?.some((event) => event.phase === "CLEANUP" && event.state === "PASSED") === true, "CLEANUP/PASSED event missing")

  const attempts = Array.isArray(evidence.attempts) ? evidence.attempts : []
  expect(attempts.length > 0, "passed evidence contains no attempts")
  expect(attempts.length <= job.agent.maxAttempts, `attempt count exceeds maxAttempts: ${attempts.length} > ${job.agent.maxAttempts}`)
  expect(attempts.every((attempt, index) => attempt.attempt === index + 1), "attempt numbering is not sequential")
  for (const attempt of attempts) {
    const forbidden = attempt.changedFiles.filter((path) => !job.agent.allowlist.includes(path))
    expect(forbidden.length === 0, `attempt ${attempt.attempt} escaped allowlist: ${forbidden.join(", ")}`)
  }
  const acceptedAttempts = attempts.filter((attempt) => attempt.accepted)
  expect(acceptedAttempts.length === 1, `expected exactly one accepted attempt, got ${acceptedAttempts.length}`)
  const accepted = acceptedAttempts[0]
  if (accepted) {
    expect(attempts.at(-1) === accepted, "accepted attempt is not the final attempt")
    expect(accepted.changedFiles.length > 0, "accepted attempt changed no files")
    expect(accepted.failures.length === 0, "accepted attempt contains failures")
    expect(new Set(accepted.changedFiles).size === accepted.changedFiles.length, "accepted changed-files list contains duplicates")
    expect(sha256Pattern.test(accepted.diffSha256) && accepted.diffSha256 !== EMPTY_DIFF_SHA256, "accepted diff SHA-256 is empty or invalid")
    expect(isDeepStrictEqual(accepted.gates.map((gate) => gate.command), job.verificationCommands), "accepted gate commands differ from job verification commands")
    expect(accepted.gates.length === job.verificationCommands.length, "accepted attempt gate count differs from job")
    expect(accepted.gates.every((gate) => gate.exitCode === 0), "accepted attempt contains failing gate")
  }

  expect(Boolean(evidence.baseline), "baseline browser evidence missing")
  expect(Boolean(evidence.final), "final browser evidence missing")
  if (evidence.baseline && evidence.final) {
    expect(evidence.baseline.kind === job.browser.kind, "baseline browser verifier kind differs from job")
    expect(evidence.final.kind === job.browser.kind, "final browser verifier kind differs from job")
    if (job.browser.kind === "button-accessibility" && evidence.baseline.kind === "button-accessibility") {
      for (const failure of evaluateButtonAudit(evidence.baseline, job.browser.baseline)) failures.push(`baseline: ${failure}`)
    } else if (job.browser.kind === "text" && evidence.baseline.kind === "text") {
      for (const failure of evaluateTextAudit(evidence.baseline)) failures.push(`baseline: ${failure}`)
    }
    for (const failure of finalBrowserFailures(evidence.baseline, evidence.final, job.browser)) failures.push(`final: ${failure}`)
    expect(Boolean(screenshots.baseline), "baseline screenshot missing")
    expect(Boolean(screenshots.final), "final screenshot missing")
    expect(evidence.baseline.screenshotPath === `${job.artifactsDir}/baseline.png`, "baseline screenshot path differs from canonical artifact path")
    expect(evidence.final.screenshotPath === `${job.artifactsDir}/final.png`, "final screenshot path differs from canonical artifact path")
    if (screenshots.baseline) expect(evidence.baseline.screenshotSha256 === screenshots.baseline, "baseline screenshot SHA-256 mismatch")
    if (screenshots.final) expect(evidence.final.screenshotSha256 === screenshots.final, "final screenshot SHA-256 mismatch")
    if (screenshots.baseline && screenshots.final) expect(evidence.visualParity === (screenshots.baseline === screenshots.final), "visualParity differs from screenshot hashes")
    if (accepted?.browser) expect(isDeepStrictEqual(accepted.browser, evidence.final), "accepted attempt browser evidence differs from final evidence")
    if (evidence.baseline.kind === "button-accessibility" && evidence.final.kind === "button-accessibility") {
      expect(isDeepStrictEqual(evidence.accessibilityDelta, buttonDelta(evidence.baseline.buttonNames, evidence.final.buttonNames)), "accessibility delta is not canonical")
    }
  }

  if (evidence.previewUrl) expect(new URL(evidence.previewUrl).search === "", "public preview evidence contains query capability data")
  expect(isDeepStrictEqual(manifest, createRuntimeManifest(evidence, evidenceSha256)), "manifest is not the canonical derivation of evidence.json")
  return failures
}
