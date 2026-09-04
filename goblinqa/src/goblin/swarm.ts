import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { GoblinFinding } from "./brain.js"
import { clusterIssues, type IssueCluster } from "./clusters.js"
import { PERSONAS, FIVE_PERSONAS, ALL_PERSONAS, type GoblinPersona } from "./personas.js"
import { runGoblin, type GoblinResult, type RunGoblinInput } from "./runner.js"

export type FindingEvidence = {
  persona: string
  sessionId: string | null
  replayUrl: string | null
  replayPath: string | null
  videoPath: string
  steps: number[]
  screenshotPaths: string[]
}

export type AggregatedFinding = {
  category: GoblinFinding["category"]
  title: string
  descriptions: string[]
  personas: string[]
  evidence: FindingEvidence[]
}

export type AggregateReport = {
  milestone: 2 | 3 | 4 | 5 | 6
  issueClusters?: IssueCluster[]
  swarmRunId: string
  targetUrl: string
  goal: string
  startedAt: string
  completedAt: string
  successByPersona: Array<{
    persona: string
    goalReached: boolean
    failureType: GoblinResult["failureType"]
    summary: string
  }>
  sharedFindings: AggregatedFinding[]
  personaUniqueFindings: AggregatedFinding[]
  productFindings: AggregatedFinding[]
  runtimeFailures: Array<{
    persona: string
    stage: "run" | "screenshot" | "replay" | "video" | "cleanup"
    failureType: GoblinResult["failureType"] | "evidence_runtime" | "cleanup_runtime"
    error: string
  }>
  evidenceByPersona: Array<{
    persona: string
    sessionId: string | null
    replayUrl: string | null
    replayPath: string | null
    replaySaved: boolean
    replayError: string | null
    videoPath: string
    videoSaved: boolean
    videoError: string | null
    cleanup: GoblinResult["cleanup"]
  }>
  individualResults: GoblinResult[]
}

type RunGoblinFunction = (input: RunGoblinInput) => Promise<GoblinResult>

export type RunSwarmInput = {
  url: string
  goal: string
  milestone?: 2 | 3 | 4 | 5 | 6
  goblinCount?: number
  allowLargeRun?: boolean
  outputDirectory?: string
  runId?: string
  runOne?: RunGoblinFunction
  now?: () => Date
}

function normalizedFindingKey(finding: GoblinFinding): string {
  return `${finding.category}:${finding.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
}

export function aggregateResults(
  milestone: 2 | 3 | 4 | 5 | 6,
  swarmRunId: string,
  targetUrl: string,
  goal: string,
  startedAt: string,
  completedAt: string,
  results: GoblinResult[],
): AggregateReport {
  const grouped = new Map<string, AggregatedFinding>()
  for (const result of results) {
    for (const finding of result.findings) {
      const key = normalizedFindingKey(finding)
      const steps = result.steps
        .filter((step) => step.decision?.finding && normalizedFindingKey(step.decision.finding) === key)
        .map((step) => step.step)
      const screenshotPaths = result.evidence
        .filter(
          (record) =>
            record.finding &&
            normalizedFindingKey(record.finding) === key &&
            record.screenshot.saved,
        )
        .map((record) => record.screenshot.path)
      const existing = grouped.get(key)
      if (existing) {
        if (!existing.personas.includes(result.persona.name)) existing.personas.push(result.persona.name)
        if (!existing.descriptions.includes(finding.description)) existing.descriptions.push(finding.description)
        existing.evidence.push({ persona: result.persona.name, sessionId: result.sessionId, replayUrl: result.replay.url, replayPath: result.replay.path, videoPath: result.video.path, steps, screenshotPaths })
      } else {
        grouped.set(key, {
          category: finding.category,
          title: finding.title,
          descriptions: [finding.description],
          personas: [result.persona.name],
          evidence: [{ persona: result.persona.name, sessionId: result.sessionId, replayUrl: result.replay.url, replayPath: result.replay.path, videoPath: result.video.path, steps, screenshotPaths }],
        })
      }
    }
  }
  const productFindings = [...grouped.values()]
  return {
    milestone,
    ...(milestone >= 4 ? { issueClusters: clusterIssues(results) } : {}),
    swarmRunId,
    targetUrl,
    goal,
    startedAt,
    completedAt,
    successByPersona: results.map((result) => ({ persona: result.persona.name, goalReached: result.goalReached, failureType: result.failureType, summary: result.summary })),
    sharedFindings: productFindings.filter((finding) => finding.personas.length > 1),
    personaUniqueFindings: productFindings.filter((finding) => finding.personas.length === 1),
    productFindings,
    runtimeFailures: results.flatMap((result) => {
      const failures: AggregateReport["runtimeFailures"] = []
      if (result.runtimeError) failures.push({ persona: result.persona.name, stage: "run", failureType: result.failureType, error: result.runtimeError })
      for (const record of result.evidence) {
        if (record.screenshot.error) failures.push({ persona: result.persona.name, stage: "screenshot", failureType: "evidence_runtime", error: record.screenshot.error })
      }
      if (result.replay.error) failures.push({ persona: result.persona.name, stage: "replay", failureType: "evidence_runtime", error: result.replay.error })
      if (result.video.error) failures.push({ persona: result.persona.name, stage: "video", failureType: "evidence_runtime", error: result.video.error })
      for (const error of result.cleanup.errors) failures.push({ persona: result.persona.name, stage: "cleanup", failureType: "cleanup_runtime", error })
      return failures
    }),
    evidenceByPersona: results.map((result) => ({
      persona: result.persona.name,
      sessionId: result.sessionId,
      replayUrl: result.replay.url,
      replayPath: result.replay.path,
      replaySaved: result.replay.saved,
      replayError: result.replay.error,
      videoPath: result.video.path,
      videoSaved: result.video.saved,
      videoError: result.video.error,
      cleanup: result.cleanup,
    })),
    individualResults: results,
  }
}

function unexpectedFailure(persona: GoblinPersona, input: RunGoblinInput, error: unknown): GoblinResult {
  const message = error instanceof Error ? error.message : "Unknown swarm runtime error."
  return {
    runId: input.runId ?? `${persona.id}-failed`,
    persona,
    goal: input.goal,
    goalReached: false,
    targetUrl: input.url,
    finalUrl: input.url,
    model: input.model ?? process.env.GEMINI_MODEL ?? "gemini-3.7-flash",
    summary: `Run failed before a structured result was returned: ${message}`,
    failureType: "browser_runtime",
    steps: [], actions: [], observations: [], evidence: [], findings: [], uxFriction: [], validationFailures: [], brokenNavigation: [], functionalErrors: [],
    sessionId: null,
    replay: { url: null, path: null, saved: false, error: null },
    video: { path: input.videoPath ?? "", saved: false, error: null },
    cleanup: { browserClosed: false, clientClosed: false, errors: [] },
    runtimeError: message,
    durationMs: 0,
  }
}

export function selectSwarmPersonas(input: RunSwarmInput): readonly GoblinPersona[] {
  if (input.milestone !== 6) {
    if (input.goblinCount !== undefined) throw new Error("Custom Goblin counts require milestone 6.")
    return input.milestone === 5 ? FIVE_PERSONAS : PERSONAS
  }
  const count = input.goblinCount ?? 5
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("GOBLIN_COUNT must be an integer from 1 to 20.")
  }
  if (count > 5 && input.allowLargeRun !== true) {
    throw new Error("Runs above five Goblins require explicit large-run authorization (GOBLINQA_LARGE_RUN_AUTHORIZED=true).")
  }
  return ALL_PERSONAS.slice(0, count)
}

export async function runSwarm(input: RunSwarmInput): Promise<AggregateReport> {
  // Validate before creating files or acquiring any browser sessions.
  const personas = selectSwarmPersonas(input)
  const now = input.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const milestone = input.milestone ?? 2
  const swarmRunId = input.runId ?? `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(input.outputDirectory ?? join("artifacts", `milestone-${milestone}`, swarmRunId))
  const runOne = input.runOne ?? runGoblin
  await mkdir(outputDirectory, { recursive: true })
  const results: GoblinResult[] = []

  let cleanupBlocked = false
  for (const persona of personas) {
    const runInput: RunGoblinInput = {
      url: input.url,
      goal: input.goal,
      persona,
      runId: `${swarmRunId}-${persona.id}`,
      videoPath: join(outputDirectory, `${persona.id}.webm`),
    }
    let result: GoblinResult
    try {
      if (cleanupBlocked) throw new Error("Not launched: a previous browser session was not confirmed released.")
      result = await runOne(runInput)
    } catch (error) {
      result = unexpectedFailure(persona, runInput, error)
    }
    results.push(result)
    if (result.sessionId && !result.cleanup.browserClosed) cleanupBlocked = true
    await writeFile(join(outputDirectory, `${persona.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  }

  const report = aggregateResults(milestone, swarmRunId, input.url, input.goal, startedAt, now().toISOString(), results)
  await writeFile(join(outputDirectory, "aggregate-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}
