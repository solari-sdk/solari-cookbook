import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { verifyRuntimeEvidence } from "./src/evidence-verifier.js"
import { validateJobSpec } from "./src/job-spec.js"
import type { RuntimeEvidence } from "./src/runtime-evidence.js"

const [jobPath, artifactsArg] = process.argv.slice(2)
if (!jobPath || !artifactsArg) throw new Error("Usage: tsx verify-evidence.ts jobs/<job>.json artifacts-dir")
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const rawJob = await readFile(jobPath, "utf8")
const job = validateJobSpec(JSON.parse(rawJob))
const expectedArtifactsDir = resolve(process.cwd(), job.artifactsDir)
const artifactsDir = resolve(process.cwd(), artifactsArg)
if (artifactsDir !== expectedArtifactsDir) throw new Error(`Artifacts directory differs from job spec: ${artifactsArg}`)

const evidenceBytes = await readFile(join(artifactsDir, "evidence.json"))
const manifestBytes = await readFile(join(artifactsDir, "manifest.json"))
const evidence = JSON.parse(evidenceBytes.toString("utf8")) as RuntimeEvidence
const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"))
const evidenceSha256 = sha256(evidenceBytes)
const jobSpecSha256 = sha256(rawJob)
const hashIfPresent = async (path: string): Promise<string | undefined> => {
  try { return sha256(await readFile(path)) } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}
const screenshots = {
  baseline: await hashIfPresent(join(artifactsDir, "baseline.png")),
  final: await hashIfPresent(join(artifactsDir, "final.png")),
}
const failures = verifyRuntimeEvidence(job, jobSpecSha256, evidence, manifest, evidenceSha256, screenshots)
if (job.source.issueSnapshotPath && job.source.issueSnapshotSha256) {
  const snapshotBytes = await readFile(resolve(process.cwd(), job.source.issueSnapshotPath))
  if (sha256(snapshotBytes) !== job.source.issueSnapshotSha256) failures.push("committed issue snapshot SHA-256 differs from job")
}

const combinedJson = `${evidenceBytes.toString("utf8")}\n${manifestBytes.toString("utf8")}`
for (const [label, pattern] of [
  ["Solari API key", /\bslr_live_[A-Za-z0-9_-]+\b/],
  ["signed preview token", /[?&](?:token|pt_token)=/i],
  ["host path", /\/home\/[^/]+\//],
  ["absolute sandbox path", /\/workspace\/repo/],
] as const) if (pattern.test(combinedJson)) failures.push(`${label} leaked into committed evidence`)

if (failures.length) throw new Error(`Evidence verification failed:\n- ${failures.join("\n- ")}`)
const accepted = evidence.attempts.find((attempt) => attempt.accepted)!
console.log(JSON.stringify({
  status: "PASSED",
  job: job.name,
  jobSpecSha256,
  evidenceSha256,
  acceptedAttempt: accepted.attempt,
  changedFiles: accepted.changedFiles,
  cleanup: evidence.cleanup,
}, null, 2))
