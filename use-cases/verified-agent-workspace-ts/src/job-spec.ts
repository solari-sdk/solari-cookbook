import { readFile } from "node:fs/promises"

interface ScreenshotEvidence {
  screenshotPath: string
  screenshotSha256: string
  title: string
}

export interface ButtonAuditEvidence extends ScreenshotEvidence {
  kind: "button-accessibility"
  buttonCount: number
  unnamedButtonCount: number
  buttonNames: string[]
}

export interface TextAuditEvidence extends ScreenshotEvidence {
  kind: "text"
  bodyTextSha256: string
  checks: Array<{ type: "include" | "exclude"; text: string; passed: boolean }>
}

export type BrowserAuditEvidence = ButtonAuditEvidence | TextAuditEvidence

export interface BaselineButtonExpectation {
  buttonCount?: number
  unnamedButtonCount: number
  mustIncludeNames?: string[]
}

export interface FinalButtonExpectation {
  unnamedButtonCount: number
  preserveButtonCount?: boolean
  preserveNames?: string[]
}

export interface TextExpectation {
  mustIncludeText?: string
  mustExcludeText?: string
}

export type BrowserVerifier =
  | {
      kind: "button-accessibility"
      route: string
      waitForSelector: string
      localStorage?: Record<string, string>
      baseline: BaselineButtonExpectation
      final: FinalButtonExpectation
    }
  | {
      kind: "text"
      route: string
      waitForSelector: string
      localStorage?: Record<string, string>
      baseline: TextExpectation
      final: TextExpectation
    }

export interface VerifiedAgentJob {
  version: 1
  name: string
  source: { repository: string; ref: string; issue?: number; issueSnapshotPath?: string; issueSnapshotSha256?: string }
  bootstrapCommands: string[]
  agent: {
    endpoint: string
    model: string
    secretEnv: string
    allowlist: string[]
    systemPrompt: string
    taskPrompt: string
    maxTokens: number
    maxAttempts: number
    reasoningMode?: "provider-default" | "disabled"
  }
  verificationCommands: string[]
  preview: {
    port: number
    baselineCommand: string
    finalCommand: string
  }
  browser: BrowserVerifier
  analysis?: { method: string; hypothesis: string; safetyInvariant: string }
  artifactsDir: string
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value as number
}

function strings(value: unknown, name: string, nonEmpty = true): string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be ${nonEmpty ? "a non-empty" : "an"} array of strings`)
  }
  return value as string[]
}

function safeRelativePath(value: unknown, name: string): string {
  const path = string(value, name)
  const segments = path.split("/")
  const nonCanonical = path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")
  if (nonCanonical) throw new Error(`${name} must be a canonical safe relative path`)
  return path
}

function safeRelativePaths(value: unknown, name: string): string[] {
  const paths = strings(value, name)
  if (new Set(paths).size !== paths.length) throw new Error(`${name} must not contain duplicates`)
  return paths.map((path, index) => safeRelativePath(path, `${name}[${index}]`))
}

function url(value: unknown, name: string): string {
  const result = string(value, name)
  try { new URL(result) } catch { throw new Error(`${name} must be an absolute URL`) }
  return result
}

function sameOriginPath(value: unknown, name: string): string {
  const path = string(value, name)
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`${name} must be a same-origin absolute path`)
  return path
}

function optionalStrings(value: unknown, name: string): string[] | undefined {
  return value === undefined ? undefined : strings(value, name, false)
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : string(value, name)
}

function optionalStringRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const record = object(value, name)
  for (const [key, entry] of Object.entries(record)) {
    if (!key.trim() || typeof entry !== "string") throw new Error(`${name} must map non-empty string keys to string values`)
  }
  return record as Record<string, string>
}

function optionalSha256(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  const hash = string(value, name)
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`${name} must be a 64-character SHA-256`)
  return hash.toLowerCase()
}

function parseBrowser(browser: Record<string, unknown>): BrowserVerifier {
  const kind = string(browser.kind, "browser.kind")
  const route = sameOriginPath(browser.route, "browser.route")
  const waitForSelector = string(browser.waitForSelector, "browser.waitForSelector")
  const localStorage = optionalStringRecord(browser.localStorage, "browser.localStorage")
  const baseline = object(browser.baseline, "browser.baseline")
  const final = object(browser.final, "browser.final")
  if (kind === "button-accessibility") {
    return {
      kind,
      route,
      waitForSelector,
      localStorage,
      baseline: {
        buttonCount: baseline.buttonCount === undefined ? undefined : integer(baseline.buttonCount, "browser.baseline.buttonCount"),
        unnamedButtonCount: integer(baseline.unnamedButtonCount, "browser.baseline.unnamedButtonCount"),
        mustIncludeNames: optionalStrings(baseline.mustIncludeNames, "browser.baseline.mustIncludeNames"),
      },
      final: {
        unnamedButtonCount: integer(final.unnamedButtonCount, "browser.final.unnamedButtonCount"),
        preserveButtonCount: final.preserveButtonCount === undefined ? undefined : boolean(final.preserveButtonCount, "browser.final.preserveButtonCount"),
        preserveNames: optionalStrings(final.preserveNames, "browser.final.preserveNames"),
      },
    }
  }
  if (kind === "text") {
    const baselineExpectation = {
      mustIncludeText: optionalString(baseline.mustIncludeText, "browser.baseline.mustIncludeText"),
      mustExcludeText: optionalString(baseline.mustExcludeText, "browser.baseline.mustExcludeText"),
    }
    const finalExpectation = {
      mustIncludeText: optionalString(final.mustIncludeText, "browser.final.mustIncludeText"),
      mustExcludeText: optionalString(final.mustExcludeText, "browser.final.mustExcludeText"),
    }
    if (!baselineExpectation.mustIncludeText && !baselineExpectation.mustExcludeText) throw new Error("browser.baseline must define a text expectation")
    if (!finalExpectation.mustIncludeText && !finalExpectation.mustExcludeText) throw new Error("browser.final must define a text expectation")
    return { kind, route, waitForSelector, localStorage, baseline: baselineExpectation, final: finalExpectation }
  }
  throw new Error("browser.kind must be button-accessibility or text")
}

export function validateJobSpec(raw: unknown): VerifiedAgentJob {
  const root = object(raw, "job")
  if (root.version !== 1) throw new Error("job.version must be 1")
  const source = object(root.source, "source")
  const ref = string(source.ref, "source.ref")
  if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error("source.ref must be an immutable 40-character git SHA")
  const agent = object(root.agent, "agent")
  const preview = object(root.preview, "preview")
  const browser = object(root.browser, "browser")
  const analysis = root.analysis === undefined ? undefined : object(root.analysis, "analysis")
  const issue = source.issue === undefined ? undefined : integer(source.issue, "source.issue", 1)
  const issueSnapshotPath = source.issueSnapshotPath === undefined ? undefined : safeRelativePath(source.issueSnapshotPath, "source.issueSnapshotPath")
  const issueSnapshotSha256 = optionalSha256(source.issueSnapshotSha256, "source.issueSnapshotSha256")
  if (Boolean(issueSnapshotPath) !== Boolean(issueSnapshotSha256)) throw new Error("issue snapshot path and SHA-256 must be provided together")
  if (issueSnapshotPath && issue === undefined) throw new Error("issue snapshot requires source.issue")
  return {
    version: 1,
    name: string(root.name, "name"),
    source: {
      repository: url(source.repository, "source.repository"),
      ref,
      issue,
      issueSnapshotPath,
      issueSnapshotSha256,
    },
    bootstrapCommands: strings(root.bootstrapCommands, "bootstrapCommands"),
    agent: {
      endpoint: url(agent.endpoint, "agent.endpoint"),
      model: string(agent.model, "agent.model"),
      secretEnv: string(agent.secretEnv, "agent.secretEnv"),
      allowlist: safeRelativePaths(agent.allowlist, "agent.allowlist"),
      systemPrompt: string(agent.systemPrompt, "agent.systemPrompt"),
      taskPrompt: string(agent.taskPrompt, "agent.taskPrompt"),
      maxTokens: integer(agent.maxTokens, "agent.maxTokens", 1, 100_000),
      maxAttempts: integer(agent.maxAttempts, "agent.maxAttempts", 1, 3),
      reasoningMode: agent.reasoningMode === undefined ? undefined : (() => {
        const mode = string(agent.reasoningMode, "agent.reasoningMode")
        if (mode !== "provider-default" && mode !== "disabled") throw new Error("agent.reasoningMode must be provider-default or disabled")
        return mode
      })(),
    },
    verificationCommands: strings(root.verificationCommands, "verificationCommands"),
    preview: {
      port: integer(preview.port, "preview.port", 1, 65535),
      baselineCommand: string(preview.baselineCommand, "preview.baselineCommand"),
      finalCommand: string(preview.finalCommand, "preview.finalCommand"),
    },
    browser: parseBrowser(browser),
    analysis: analysis === undefined ? undefined : {
      method: string(analysis.method, "analysis.method"),
      hypothesis: string(analysis.hypothesis, "analysis.hypothesis"),
      safetyInvariant: string(analysis.safetyInvariant, "analysis.safetyInvariant"),
    },
    artifactsDir: safeRelativePath(root.artifactsDir, "artifactsDir"),
  }
}

export async function loadJobSpec(path: string): Promise<VerifiedAgentJob> {
  return validateJobSpec(JSON.parse(await readFile(path, "utf8")))
}

export function evaluateButtonAudit(actual: ButtonAuditEvidence, expected: BaselineButtonExpectation): string[] {
  const failures: string[] = []
  if (expected.buttonCount !== undefined && actual.buttonCount !== expected.buttonCount) failures.push(`expected ${expected.buttonCount} buttons, got ${actual.buttonCount}`)
  if (actual.unnamedButtonCount !== expected.unnamedButtonCount) failures.push(`expected ${expected.unnamedButtonCount} unnamed buttons, got ${actual.unnamedButtonCount}`)
  for (const name of expected.mustIncludeNames ?? []) if (!actual.buttonNames.includes(name)) failures.push(`expected named button ${JSON.stringify(name)} to exist`)
  return failures
}

export function evaluateTextAudit(actual: TextAuditEvidence): string[] {
  return actual.checks.filter((check) => !check.passed).map((check) => `${check.type} text check failed: ${JSON.stringify(check.text)}`)
}
