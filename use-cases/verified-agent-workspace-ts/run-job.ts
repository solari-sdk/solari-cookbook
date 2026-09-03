import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { auditBrowser } from "./src/browser-audit.js"
import { capabilityFingerprint, publicPreviewUrl, scrubOutput, sha256Text } from "./src/evidence.js"
import { evaluateButtonAudit, evaluateTextAudit, validateJobSpec, type BrowserAuditEvidence } from "./src/job-spec.js"
import { assertAllowedChanges, assertCleanTree, assertStableDiff, buttonDelta, commandFailureDetail, finalBrowserFailures } from "./src/runtime-policy.js"
import { runtimePolicySnapshot, writeRuntimeBundle, type AgentAttemptEvidence, type RuntimeEvidence } from "./src/runtime-evidence.js"
import { SolariWorkspaceProvider } from "./src/solari-workspace.js"
import { waitForHttp } from "./src/wait.js"

const jobPath = process.argv[2]
if (!jobPath) throw new Error("Usage: npm run job -- jobs/<job>.json")
const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) throw new Error("Missing SOLARI_API_KEY")

const rawJobSpec = await readFile(jobPath, "utf8")
const job = validateJobSpec(JSON.parse(rawJobSpec))
const agentKey = process.env[job.agent.secretEnv]
if (!agentKey) throw new Error(`Missing required environment variable: ${job.agent.secretEnv}`)
const artifactsDir = resolve(process.cwd(), job.artifactsDir)
const workspace = new SolariWorkspaceProvider(apiKey)
const agentSource = await readFile(new URL("./scripts/bounded-edit-agent.mjs", import.meta.url), "utf8")
const evidence: RuntimeEvidence = {
  version: 2,
  engine: "verified-agent-runtime",
  startedAt: new Date().toISOString(),
  job: job.name,
  source: { ...job.source },
  methodology: job.analysis,
  policy: runtimePolicySnapshot(job, sha256Text(rawJobSpec)),
  attempts: [],
  events: [],
  status: "RUNNING",
}
const mark = (phase: string, state: "STARTED" | "PASSED" | "FAILED", detail?: string) => {
  const event = { phase, state, at: new Date().toISOString(), detail }
  evidence.events.push(event)
  console.log(JSON.stringify({ event: "phase", ...event }))
}
let thrown: unknown

const changedFiles = async () => {
  const status = await workspace.gitStatus()
  return [...new Set([...status.staged, ...status.modified, ...status.untracked])].sort()
}

const stopPreview = async () => { await workspace.stop() }

const baselineAuditFailures = (audit: BrowserAuditEvidence): string[] => {
  if (job.browser.kind === "button-accessibility" && audit.kind === "button-accessibility") return evaluateButtonAudit(audit, job.browser.baseline)
  if (job.browser.kind === "text" && audit.kind === "text") return evaluateTextAudit(audit)
  return [`browser verifier kind mismatch: expected ${job.browser.kind}, got ${audit.kind}`]
}

const auditDetail = (audit: BrowserAuditEvidence): string => audit.kind === "button-accessibility"
  ? `${audit.unnamedButtonCount} unnamed / ${audit.buttonCount} buttons`
  : `${audit.checks.filter((check) => check.passed).length}/${audit.checks.length} text checks passed`

const auditBrief = (audit: BrowserAuditEvidence | undefined) => !audit ? undefined : audit.kind === "button-accessibility"
  ? { kind: audit.kind, unnamed: audit.unnamedButtonCount, names: audit.buttonNames }
  : { kind: audit.kind, checks: audit.checks, bodyTextSha256: audit.bodyTextSha256 }

const observeBrowser = async (capabilityUrl: string, phase: "baseline" | "final", screenshotPath: string): Promise<BrowserAuditEvidence> => {
  let lastError: unknown
  for (let observation = 1; observation <= 2; observation += 1) {
    try {
      return await auditBrowser(apiKey, capabilityUrl, job.browser, phase, screenshotPath)
    } catch (error) {
      lastError = error
      if (observation < 2) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`browser observation failed after 2 attempts: ${scrubOutput(lastError instanceof Error ? lastError.message : String(lastError))}`)
}

try {
  mark("SOURCE", "STARTED", `${job.source.repository}@${job.source.ref.slice(0, 12)}`)
  evidence.sandboxFingerprint = capabilityFingerprint(await workspace.create())
  await workspace.clone(job.source.repository, job.source.ref)
  const headSha = await workspace.headSha()
  evidence.source.headSha = headSha
  if (headSha !== job.source.ref) throw new Error(`immutable checkout mismatch: expected ${job.source.ref}, got ${headSha}`)
  mark("SOURCE", "PASSED", headSha)

  mark("BASELINE", "STARTED")
  for (const command of job.bootstrapCommands) {
    const result = await workspace.exec(command)
    if (result.exitCode !== 0) throw new Error(`bootstrap failed (${result.exitCode}): ${command}\n${result.stderr}`)
  }
  assertCleanTree(await workspace.gitStatus(), "bootstrap")

  await workspace.start(job.preview.baselineCommand)
  const baselineCapability = await workspace.previewUrl(job.preview.port)
  try { await waitForHttp(baselineCapability) } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\npreview log:\n${await workspace.previewLog()}`) }
  evidence.baseline = await observeBrowser(baselineCapability, "baseline", resolve(artifactsDir, "baseline.png"))
  const baselineFailures = baselineAuditFailures(evidence.baseline)
  if (baselineFailures.length) throw new Error(`baseline drift: ${baselineFailures.join("; ")}`)
  await stopPreview()
  assertCleanTree(await workspace.gitStatus(), "baseline")
  mark("BASELINE", "PASSED", auditDetail(evidence.baseline))

  await workspace.assertPathsWithinRepo(job.agent.allowlist)
  await workspace.writeText("/tmp/bounded-edit-agent.mjs", agentSource)
  let feedback = ""

  for (let attemptNumber = 1; attemptNumber <= job.agent.maxAttempts; attemptNumber += 1) {
    mark("MUTATE", "STARTED", `attempt ${attemptNumber}`)
    const policy = {
      endpoint: job.agent.endpoint,
      model: job.agent.model,
      allowlist: job.agent.allowlist,
      systemPrompt: job.agent.systemPrompt,
      taskPrompt: job.agent.taskPrompt,
      maxTokens: job.agent.maxTokens,
      reasoningMode: job.agent.reasoningMode,
      feedback,
    }
    await workspace.writeText("/tmp/verified-agent-policy.json", `${JSON.stringify(policy)}\n`)
    const agentRun = await workspace.exec("node /tmp/bounded-edit-agent.mjs", 4 * 60_000, { AGENT_API_KEY: agentKey })
    const changed = await changedFiles()
    assertAllowedChanges(changed, job.agent.allowlist)
    const diff = await workspace.gitDiff()
    const attempt: AgentAttemptEvidence = {
      attempt: attemptNumber,
      result: agentRun.stdout.trim().slice(-4000),
      changedFiles: changed,
      diffSha256: sha256Text(diff),
      gates: [],
      failures: [],
      accepted: false,
    }
    if (agentRun.exitCode !== 0) {
      attempt.failures.push(`agent execution failed (${agentRun.exitCode}): ${commandFailureDetail(agentRun)}`)
      evidence.attempts.push(attempt)
      feedback = scrubOutput(attempt.failures.join("\n\n")).slice(-8000)
      mark("MUTATE", "FAILED", `attempt ${attemptNumber}: agent transport/protocol failure`)
      continue
    }
    if (!changed.length) attempt.failures.push("agent made no changes")

    if (attempt.failures.length === 0) mark("MUTATE", "PASSED", `attempt ${attemptNumber}: ${changed.length} files`)
    mark("STATIC_VERIFY", "STARTED", `attempt ${attemptNumber}`)
    for (const command of attempt.failures.length === 0 ? job.verificationCommands : []) {
      const gate = await workspace.exec(command)
      attempt.gates.push(gate)
      if (gate.exitCode !== 0) attempt.failures.push(`${command} failed (${gate.exitCode}): ${commandFailureDetail(gate)}`)
    }
    assertAllowedChanges(await changedFiles(), job.agent.allowlist)
    const postGateDiffSha256 = sha256Text(await workspace.gitDiff())
    try {
      assertStableDiff(attempt.diffSha256, postGateDiffSha256, "static verification")
    } catch (error) {
      attempt.failures.push(error instanceof Error ? error.message : String(error))
      evidence.attempts.push(attempt)
      mark("STATIC_VERIFY", "FAILED", `attempt ${attemptNumber}: verification mutated the attributed diff`)
      throw error
    }
    if (attempt.failures.length === 0) mark("STATIC_VERIFY", "PASSED", `attempt ${attemptNumber}: ${attempt.gates.length} gates`)
    else mark("STATIC_VERIFY", "FAILED", `attempt ${attemptNumber}: ${attempt.failures.length} failures`)

    if (attempt.failures.length === 0) {
      mark("RUNTIME_VERIFY", "STARTED", `attempt ${attemptNumber}`)
      await workspace.start(job.preview.finalCommand)
      const finalCapability = await workspace.previewUrl(job.preview.port)
      try { await waitForHttp(finalCapability) } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\npreview log:\n${await workspace.previewLog()}`) }
      let observationError: unknown
      try {
        attempt.browser = await observeBrowser(finalCapability, "final", resolve(artifactsDir, "final.png"))
        attempt.failures.push(...finalBrowserFailures(evidence.baseline, attempt.browser, job.browser))
      } catch (error) {
        observationError = error
        attempt.failures.push(scrubOutput(error instanceof Error ? error.message : String(error)))
      } finally {
        await stopPreview().catch(() => {})
      }
      mark("RUNTIME_VERIFY", attempt.failures.length === 0 ? "PASSED" : "FAILED", `attempt ${attemptNumber}: ${attempt.browser ? auditDetail(attempt.browser) : "browser observation failed"}`)
      if (attempt.failures.length === 0 && attempt.browser) {
        attempt.accepted = true
        evidence.final = attempt.browser
        evidence.previewUrl = publicPreviewUrl(finalCapability)
        if (evidence.baseline.kind === "button-accessibility" && evidence.final.kind === "button-accessibility") evidence.accessibilityDelta = buttonDelta(evidence.baseline.buttonNames, evidence.final.buttonNames)
        evidence.visualParity = evidence.baseline.screenshotSha256 === evidence.final.screenshotSha256
        mark("JUDGE", "PASSED", `attempt ${attemptNumber} accepted`)
      } else {
        mark("JUDGE", "FAILED", `attempt ${attemptNumber}: ${attempt.failures.join("; ").slice(0, 500)}`)
      }
      if (observationError) {
        evidence.attempts.push(attempt)
        throw observationError
      }
    }

    evidence.attempts.push(attempt)
    if (attempt.accepted) break
    feedback = scrubOutput(attempt.failures.join("\n\n")).slice(-8000)
  }

  if (!evidence.final) throw new Error(`verification did not converge after ${job.agent.maxAttempts} attempts`)
  evidence.status = "PASSED"
  mark("COMPLETE", "PASSED", `converged in ${evidence.attempts.length} attempt(s)`)
} catch (error) {
  mark("COMPLETE", "FAILED", scrubOutput(error instanceof Error ? error.message : String(error)).slice(0, 500))
  evidence.status = "FAILED"
  evidence.error = scrubOutput(error instanceof Error ? error.message : String(error))
  thrown = error
} finally {
  mark("CLEANUP", "STARTED")
  await workspace.destroy().catch((error) => {
    evidence.status = "FAILED"
    evidence.error = `${evidence.error ? `${evidence.error}; ` : ""}cleanup failed: ${scrubOutput(String(error))}`
    thrown ??= error
  })
  evidence.cleanup = { ownedSandboxesAfterCleanup: await workspace.ownedSandboxCount().catch(() => -1) }
  mark("CLEANUP", evidence.cleanup.ownedSandboxesAfterCleanup === 0 ? "PASSED" : "FAILED", `${evidence.cleanup.ownedSandboxesAfterCleanup} run-owned sandboxes`)
  if (evidence.status === "PASSED" && evidence.cleanup.ownedSandboxesAfterCleanup !== 0) {
    evidence.status = "FAILED"
    evidence.error = `cleanup invariant failed: ${evidence.cleanup.ownedSandboxesAfterCleanup} run-owned sandboxes remain`
    thrown ??= new Error(evidence.error)
  }
  evidence.finishedAt = new Date().toISOString()
  await writeRuntimeBundle(artifactsDir, evidence)
  console.log(JSON.stringify({
    status: evidence.status,
    job: evidence.job,
    headSha: evidence.source.headSha,
    attempts: evidence.attempts.length,
    changedFiles: evidence.attempts.find((attempt) => attempt.accepted)?.changedFiles,
    diffSha256: evidence.attempts.find((attempt) => attempt.accepted)?.diffSha256,
    baseline: auditBrief(evidence.baseline),
    final: auditBrief(evidence.final),
    visualParity: evidence.visualParity,
    ownedSandboxesAfterCleanup: evidence.cleanup.ownedSandboxesAfterCleanup,
    error: evidence.error,
  }, null, 2))
}

if (thrown) throw thrown
