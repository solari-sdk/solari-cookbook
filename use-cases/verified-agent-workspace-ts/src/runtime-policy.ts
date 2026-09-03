import { evaluateTextAudit, type BrowserAuditEvidence, type BrowserVerifier, type ButtonAuditEvidence, type FinalButtonExpectation } from "./job-spec.js"

export function assertAllowedChanges(changedFiles: string[], allowlist: string[]): void {
  const allowed = new Set(allowlist)
  const forbidden = changedFiles.filter((path) => !allowed.has(path))
  if (forbidden.length) throw new Error(`agent escaped allowlist: ${forbidden.join(", ")}`)
}

export function commandFailureDetail<T extends { stdout: string; stderr: string }>(result: T): string {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(`stdout:
${result.stdout.trim()}`)
  if (result.stderr.trim()) parts.push(`stderr:
${result.stderr.trim()}`)
  return parts.join("\n") || "no command output"
}

export function assertCleanTree<T extends { clean: boolean }>(status: T, phase: string): void {
  if (!status.clean) throw new Error(`${phase} dirtied source tree: ${JSON.stringify(status)}`)
}

export function assertStableDiff(beforeSha256: string, afterSha256: string, phase: string): void {
  if (beforeSha256 !== afterSha256) throw new Error(`${phase} changed the agent diff`)
}

export interface ButtonNameDelta {
  index: number
  before: string
  after: string
}

export function buttonDelta(before: string[], after: string[]): ButtonNameDelta[] {
  const count = Math.max(before.length, after.length)
  const result: ButtonNameDelta[] = []
  for (let index = 0; index < count; index += 1) {
    const previous = before[index] ?? ""
    const next = after[index] ?? ""
    if (previous !== next) result.push({ index, before: previous, after: next })
  }
  return result
}

export function finalAuditFailures(before: ButtonAuditEvidence, after: ButtonAuditEvidence, expected: FinalButtonExpectation): string[] {
  const failures: string[] = []
  if (after.unnamedButtonCount !== expected.unnamedButtonCount) failures.push(`expected ${expected.unnamedButtonCount} unnamed buttons, got ${after.unnamedButtonCount}`)
  if (expected.preserveButtonCount && after.buttonCount !== before.buttonCount) failures.push(`button count changed from ${before.buttonCount} to ${after.buttonCount}`)
  for (const name of expected.preserveNames ?? []) {
    if (!before.buttonNames.includes(name)) failures.push(`baseline did not contain preserved button ${JSON.stringify(name)}`)
    if (!after.buttonNames.includes(name)) failures.push(`final audit lost preserved button ${JSON.stringify(name)}`)
  }
  return failures
}

export function finalBrowserFailures(before: BrowserAuditEvidence, after: BrowserAuditEvidence, verifier: BrowserVerifier): string[] {
  if (before.kind !== verifier.kind || after.kind !== verifier.kind) return [`browser verifier kind changed: ${before.kind} -> ${after.kind}, expected ${verifier.kind}`]
  if (verifier.kind === "button-accessibility" && before.kind === "button-accessibility" && after.kind === "button-accessibility") {
    return finalAuditFailures(before, after, verifier.final)
  }
  if (verifier.kind === "text" && after.kind === "text") return evaluateTextAudit(after)
  return ["unsupported browser verifier state"]
}
