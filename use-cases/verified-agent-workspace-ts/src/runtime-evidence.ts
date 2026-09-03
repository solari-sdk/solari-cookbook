import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CommandEvidence } from "./types.js"
import type { BrowserAuditEvidence, VerifiedAgentJob } from "./job-spec.js"
import type { ButtonNameDelta } from "./runtime-policy.js"

export interface AgentAttemptEvidence {
  attempt: number
  result: string
  changedFiles: string[]
  diffSha256: string
  gates: CommandEvidence[]
  browser?: BrowserAuditEvidence
  failures: string[]
  accepted: boolean
}

export interface PhaseEvent { phase: string; state: "STARTED" | "PASSED" | "FAILED"; at: string; detail?: string }

export interface RuntimeEvidence {
  version: 2
  engine: "verified-agent-runtime"
  startedAt: string
  finishedAt?: string
  job: string
  source: { repository: string; ref: string; issue?: number; issueSnapshotPath?: string; issueSnapshotSha256?: string; headSha?: string }
  methodology?: VerifiedAgentJob["analysis"]
  policy?: { jobSpecSha256: string; agent: { model: string; endpoint: string; allowlist: string[]; maxAttempts: number; reasoningMode?: string }; verificationCommands: string[]; browserKind: VerifiedAgentJob["browser"]["kind"] }
  sandboxFingerprint?: string
  baseline?: BrowserAuditEvidence
  attempts: AgentAttemptEvidence[]
  events: PhaseEvent[]
  final?: BrowserAuditEvidence
  accessibilityDelta?: ButtonNameDelta[]
  visualParity?: boolean
  previewUrl?: string
  cleanup?: { ownedSandboxesAfterCleanup: number }
  status: "RUNNING" | "PASSED" | "FAILED"
  error?: string
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const jsonShape = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function runtimePolicySnapshot(job: VerifiedAgentJob, jobSpecSha256: string): NonNullable<RuntimeEvidence["policy"]> {
  return jsonShape({
    jobSpecSha256,
    agent: {
      model: job.agent.model,
      endpoint: job.agent.endpoint,
      allowlist: job.agent.allowlist,
      maxAttempts: job.agent.maxAttempts,
      reasoningMode: job.agent.reasoningMode,
    },
    verificationCommands: job.verificationCommands,
    browserKind: job.browser.kind,
  })
}

function auditSummary(audit: BrowserAuditEvidence) {
  if (audit.kind === "button-accessibility") return { kind: audit.kind, buttonCount: audit.buttonCount, unnamedButtonCount: audit.unnamedButtonCount, buttonNames: audit.buttonNames, screenshotSha256: audit.screenshotSha256 }
  return { kind: audit.kind, bodyTextSha256: audit.bodyTextSha256, checks: audit.checks, screenshotSha256: audit.screenshotSha256 }
}

export function createRuntimeManifest(evidence: RuntimeEvidence, evidenceSha256: string) {
  const accepted = [...evidence.attempts].reverse().find((attempt) => attempt.accepted)
  return jsonShape({
    version: 1,
    status: evidence.status,
    engine: evidence.engine,
    job: evidence.job,
    source: evidence.source,
    methodology: evidence.methodology,
    policy: evidence.policy,
    phases: evidence.events,
    baseline: evidence.baseline ? auditSummary(evidence.baseline) : undefined,
    mutation: accepted ? { changedFiles: accepted.changedFiles, diffSha256: accepted.diffSha256, attempts: evidence.attempts.length } : undefined,
    verification: accepted ? accepted.gates.map((gate) => ({ command: gate.command, exitCode: gate.exitCode })) : [],
    final: evidence.final ? auditSummary(evidence.final) : undefined,
    accessibilityDelta: evidence.accessibilityDelta,
    visualParity: evidence.visualParity,
    cleanup: evidence.cleanup,
    evidenceSha256,
  })
}

export async function writeRuntimeBundle(dir: string, evidence: RuntimeEvidence): Promise<void> {
  await mkdir(dir, { recursive: true })
  const evidencePath = join(dir, "evidence.json")
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
  const evidenceSha256 = sha256(await readFile(evidencePath))
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(createRuntimeManifest(evidence, evidenceSha256), null, 2)}\n`, "utf8")
}
