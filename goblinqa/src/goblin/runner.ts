import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  BrowserSession,
  Solari,
  SolariError,
} from "@solarisdk/browser"
import {
  GeminiGoblinBrain,
  type BrainObservation,
  type BrainStep,
  type FindingCategory,
  type GoblinDecision,
  type GoblinFinding,
} from "./brain.js"
import type { GoblinPersona } from "./personas.js"
import { planTypeOperations } from "./secure-input.js"

type GoblinPage = Awaited<ReturnType<BrowserSession["newPage"]>>

const DEFAULT_MODEL = "gemini-3.7-flash"
const DEFAULT_MAX_STEPS = 8
const MAX_ALLOWED_STEPS = 20
const MAX_PAGE_TEXT_LENGTH = 6_000
const MAX_INTERACTIVE_ELEMENTS = 24
const RECORDING_FLUSH_DELAY_MS = 2_000
const REPLAY_ATTEMPTS = 10
const REPLAY_RETRY_DELAY_MS = 3_000
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, [role="button"], [role="link"]'
const ALLOWED_SECRET_NAMES = ["SMTR_TEST_PASSWORD"] as const

type InteractiveElement = {
  ref: string
  selectorIndex: number
  description: string
}

type Observation = {
  url: string
  title: string
  text: string
  elements: InteractiveElement[]
}

export type StepRecord = {
  step: number
  observation: BrainObservation
  decision?: GoblinDecision
  error?: string
}

export type EvidenceRecord = {
  id: string
  capturedAt: string
  step: number
  url: string
  title: string
  observationExcerpt: string
  screenshot: {
    path: string
    saved: boolean
    error: string | null
  }
  action: {
    type: GoblinDecision["action"]
    target: string
    text: string
    reason: string
  } | null
  finding: GoblinFinding | null
}

export type RuntimeFailureType =
  | "model_provider"
  | "browser_runtime"

export type GoblinFailureType =
  | RuntimeFailureType
  | "product_failure"
  | "inconclusive"
  | "safety_blocked"
  | "step_limit"
  | null

export type GoblinResult = {
  runId: string
  persona: GoblinPersona
  goal: string
  goalReached: boolean
  targetUrl: string
  finalUrl: string
  model: string
  summary: string
  failureType: GoblinFailureType
  steps: StepRecord[]
  actions: Array<{
    step: number
    action: GoblinDecision["action"]
    target: string
    text: string
    reason: string
  }>
  observations: BrainObservation[]
  evidence: EvidenceRecord[]
  findings: GoblinFinding[]
  uxFriction: GoblinFinding[]
  validationFailures: GoblinFinding[]
  brokenNavigation: GoblinFinding[]
  functionalErrors: GoblinFinding[]
  sessionId: string | null
  replay: {
    url: string | null
    path: string | null
    saved: boolean
    error: string | null
  }
  video: { path: string; saved: boolean; error: string | null }
  cleanup: {
    browserClosed: boolean
    clientClosed: boolean
    errors: string[]
  }
  runtimeError: string | null
  durationMs: number
}

export type RunGoblinInput = {
  url: string
  goal: string
  persona: GoblinPersona
  runId?: string
  videoPath?: string
  maxSteps?: number
  model?: string
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown runtime error."
  return ALLOWED_SECRET_NAMES.reduce((redacted, name) => {
    const secret = process.env[name]
    return secret ? redacted.replaceAll(secret, "[redacted]") : redacted
  }, message)
}

function classifyRuntimeFailure(error: unknown): RuntimeFailureType {
  const candidate = error as { status?: unknown; code?: unknown }
  const status = typeof candidate?.status === "number" ? candidate.status : null
  const code = typeof candidate?.code === "number" ? candidate.code : null
  const message = describeError(error).toLowerCase()
  if (
    status === 429 ||
    status === 503 ||
    code === 429 ||
    code === 503 ||
    /gemini|google generative|generatecontent|resource exhausted|quota|too many requests|service unavailable/.test(
      message,
    )
  ) {
    return "model_provider"
  }
  return "browser_runtime"
}

function redactDecision(decision: GoblinDecision): GoblinDecision {
  return {
    ...decision,
    text: decision.action === "type" ? "[redacted]" : decision.text,
  }
}

function availableSecretNames(): string[] {
  return ALLOWED_SECRET_NAMES.filter((name) => Boolean(process.env[name]))
}

function resolveSecret(name: string): string {
  if (!ALLOWED_SECRET_NAMES.some((candidate) => candidate === name)) {
    throw new Error("The model requested a secret that is not allowlisted.")
  }
  const value = process.env[name]
  if (!value) {
    throw new Error(`The requested secret ${name} is not configured.`)
  }
  return value
}

function completedBrainSteps(steps: StepRecord[]): BrainStep[] {
  return steps.flatMap((record) => {
    if (!record.decision) return []
    return [{
      step: record.step,
      url: record.observation.url,
      action: record.decision.action,
      target: record.decision.target,
      text: record.decision.text,
      reason: record.decision.reason,
    }]
  })
}

function requireEnvironment(name: "SOLARI_API_KEY" | "GEMINI_API_KEY"): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required to run a Goblin.`)
  return value
}

export function parseMaxSteps(value = process.env.GOBLIN_MAX_STEPS): number {
  const configured = Number(value ?? DEFAULT_MAX_STEPS)
  if (!Number.isInteger(configured) || configured < 1 || configured > MAX_ALLOWED_STEPS) {
    throw new Error(`GOBLIN_MAX_STEPS must be an integer from 1 to ${MAX_ALLOWED_STEPS}.`)
  }
  return configured
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function observe(page: GoblinPage): Promise<Observation> {
  const title = await page.title()
  const text = (await page.locator("body").innerText())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PAGE_TEXT_LENGTH)
  const locator = page.locator(INTERACTIVE_SELECTOR)
  const count = await locator.count()
  const elements: InteractiveElement[] = []

  for (let selectorIndex = 0; selectorIndex < count && elements.length < MAX_INTERACTIVE_ELEMENTS; selectorIndex += 1) {
    const element = locator.nth(selectorIndex)
    if (!(await element.isVisible())) continue
    const details = await element.evaluate((node) => {
      const htmlElement = node as HTMLElement
      return {
        tag: htmlElement.tagName.toLowerCase(),
        text: (htmlElement.innerText || htmlElement.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        ariaLabel: htmlElement.getAttribute("aria-label") ?? "",
        placeholder: htmlElement.getAttribute("placeholder") ?? "",
        inputType: htmlElement.getAttribute("type") ?? "",
        href: htmlElement.getAttribute("href") ?? "",
      }
    })
    const ref = `e${elements.length}`
    const description = [
      `<${details.tag}>`,
      details.text && `text="${details.text}"`,
      details.ariaLabel && `aria-label="${details.ariaLabel}"`,
      details.placeholder && `placeholder="${details.placeholder}"`,
      details.inputType && `type="${details.inputType}"`,
      details.href && `href="${details.href}"`,
    ].filter(Boolean).join(" ")
    elements.push({ ref, selectorIndex, description })
  }
  return { url: page.url(), title, text, elements }
}

function findTarget(observation: Observation, target: string): InteractiveElement {
  const element = observation.elements.find((candidate) => candidate.ref === target)
  if (!element) throw new Error(`Unknown or non-visible element ref: ${target}`)
  return element
}

async function execute(page: GoblinPage, observation: Observation, decision: GoblinDecision): Promise<void> {
  switch (decision.action) {
    case "click": {
      const target = findTarget(observation, decision.target)
      await page.locator(INTERACTIVE_SELECTOR).nth(target.selectorIndex).click()
      break
    }
    case "type": {
      const operations = planTypeOperations(decision.target, decision.text, resolveSecret)
      for (const operation of operations) {
        const target = findTarget(observation, operation.target)
        const locator = page.locator(INTERACTIVE_SELECTOR).nth(target.selectorIndex)
        if (operations.length > 1) {
          const isOneCharacterInput = await locator.evaluate((node) => node instanceof HTMLInputElement && node.maxLength === 1)
          if (!isOneCharacterInput) throw new Error("Segmented secure input requires one-character input targets.")
        }
        await locator.fill(operation.text)
      }
      break
    }
    case "scroll":
      await page.evaluate((pixels) => window.scrollBy(0, pixels), decision.text === "up" ? -700 : 700)
      break
    case "back": await page.goBack({ waitUntil: "domcontentloaded" }); break
    case "forward": await page.goForward({ waitUntil: "domcontentloaded" }); break
    case "refresh": await page.reload({ waitUntil: "domcontentloaded" }); break
    case "wait": await sleep(1_000); break
    case "finish":
    case "fail": return
  }
  await sleep(500)
}

async function getReplayUrl(solari: Solari, sessionId: string): Promise<string> {
  for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt += 1) {
    await sleep(REPLAY_RETRY_DELAY_MS)
    try {
      return (await solari.sessions.getReplayUrl(sessionId)).url
    } catch (error) {
      const stillProcessing = error instanceof SolariError && error.status === 404
      if (!stillProcessing || attempt === REPLAY_ATTEMPTS) throw error
    }
  }
  throw new Error("Replay retry loop completed without a result.")
}

function findingsFor(steps: StepRecord[]): GoblinFinding[] {
  const seen = new Set<string>()
  return steps.flatMap((step) => {
    const finding = step.decision?.finding
    if (!finding) return []
    const key = `${finding.category}:${finding.title.trim().toLowerCase()}`
    if (seen.has(key)) return []
    seen.add(key)
    return [finding]
  })
}

function category(findings: GoblinFinding[], value: FindingCategory): GoblinFinding[] {
  return findings.filter((finding) => finding.category === value)
}

export async function runGoblin(input: RunGoblinInput): Promise<GoblinResult> {
  const startedAt = Date.now()
  const runId = input.runId ?? `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${input.persona.id}`
  const videoPath = input.videoPath ?? resolve(join("artifacts", `${runId}.webm`))
  const replayPath = join(dirname(videoPath), `${input.persona.id}.replay.ndjson`)
  const maxSteps = input.maxSteps ?? parseMaxSteps()
  const model = input.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL
  const steps: StepRecord[] = []
  const evidence: EvidenceRecord[] = []
  const cleanupErrors: string[] = []
  let sessionId: string | null = null
  let finalUrl = input.url
  let goalReached = false
  let summary = `Step limit reached after ${maxSteps} actions.`
  let failureType: GoblinFailureType = "step_limit"
  let runtimeError: string | null = null
  let replayUrl: string | null = null
  let replayError: string | null = null
  let replaySaved = false
  let videoSaved = false
  let videoError: string | null = null
  let browserClosed = false
  let clientClosed = false
  let browser: BrowserSession | null = null
  let solari: Solari | null = null

  try {
    await mkdir(dirname(videoPath), { recursive: true })
    const brain = new GeminiGoblinBrain(requireEnvironment("GEMINI_API_KEY"), model)
    solari = new Solari({ apiKey: requireEnvironment("SOLARI_API_KEY") })
    browser = await solari.launch({ recording: true })
    sessionId = browser.id
    try {
      const context = await browser.newContext({ recordVideo: { size: { width: 1280, height: 720 } } })
      const page = await context.newPage()
      const video = page.video()
      try {
        await page.goto(input.url, { waitUntil: "domcontentloaded" })
        for (let step = 1; step <= maxSteps; step += 1) {
          const observation = await observe(page)
          const brainObservation: BrainObservation = {
            url: observation.url,
            title: observation.title,
            visibleText: observation.text,
            interactiveElements: observation.elements.map(({ ref, description }) => ({ ref, description })),
          }
          const stepRecord: StepRecord = { step, observation: brainObservation }
          steps.push(stepRecord)
          const screenshotPath = join(
            dirname(videoPath),
            "screenshots",
            input.persona.id,
            `step-${String(step).padStart(2, "0")}.png`,
          )
          let screenshotSaved = false
          let screenshotError: string | null = null
          try {
            await mkdir(dirname(screenshotPath), { recursive: true })
            await page.screenshot({ path: screenshotPath, fullPage: true })
            screenshotSaved = true
          } catch (error) {
            screenshotError = describeError(error)
          }
          const evidenceRecord: EvidenceRecord = {
            id: `${runId}-step-${String(step).padStart(2, "0")}`,
            capturedAt: new Date().toISOString(),
            step,
            url: brainObservation.url,
            title: brainObservation.title,
            observationExcerpt: brainObservation.visibleText.slice(0, 1_000),
            screenshot: {
              path: screenshotPath,
              saved: screenshotSaved,
              error: screenshotError,
            },
            action: null,
            finding: null,
          }
          evidence.push(evidenceRecord)
          try {
            const decision = await brain.chooseAction({
              goal: input.goal,
              persona: { name: input.persona.name, instructions: input.persona.instructions },
              step,
              maxSteps,
              availableSecrets: availableSecretNames(),
              observation: brainObservation,
              previousSteps: completedBrainSteps(steps.slice(0, -1)),
            })
            stepRecord.decision = redactDecision(decision)
            evidenceRecord.action = {
              type: decision.action,
              target: decision.target,
              text: decision.action === "type" ? "[redacted]" : decision.text,
              reason: decision.reason,
            }
            evidenceRecord.finding = decision.finding
            if (decision.action === "finish") {
              goalReached = true
              failureType = null
              summary = decision.reason
              break
            }
            if (decision.action === "fail") {
              failureType =
                decision.failureType === "none"
                  ? "inconclusive"
                  : decision.failureType
              summary = decision.reason
              break
            }
            await execute(page, observation, decision)
          } catch (error) {
            stepRecord.error = describeError(error)
            throw error
          }
        }
      } finally {
        finalUrl = page.url()
        try {
          await context.close()
          if (video) {
            await video.saveAs(videoPath)
            videoSaved = true
          } else {
            videoError = "The browser did not expose a video artifact."
          }
        } catch (error) {
          videoError = describeError(error)
        }
      }
    } catch (error) {
      runtimeError = describeError(error)
      failureType = classifyRuntimeFailure(error)
      summary = `Run failed: ${runtimeError}`
    } finally {
      await sleep(RECORDING_FLUSH_DELAY_MS)
      try {
        await browser.close()
        browserClosed = true
      } catch (error) {
        const message = describeError(error)
        cleanupErrors.push(message)
      }
    }
    try {
      replayUrl = await getReplayUrl(solari, sessionId)
      const replayBytes = await solari.sessions.downloadReplay(sessionId)
      await writeFile(replayPath, replayBytes, { mode: 0o600 })
      replaySaved = true
    } catch (error) {
      replayError = describeError(error)
    }
  } catch (error) {
    runtimeError = describeError(error)
    failureType = classifyRuntimeFailure(error)
    summary = `Run failed: ${runtimeError}`
  } finally {
    if (browser && !browserClosed) {
      try {
        // BrowserSession.close() marks itself closed before release succeeds;
        // calling it again can be a no-op. Explicitly retry remote release.
        if (!solari) throw new Error("Cannot confirm release without a Solari client.")
        await solari.sessions.releaseAndWait(browser.id)
        browserClosed = true
      } catch (error) {
        cleanupErrors.push(describeError(error))
      }
    }
    if (solari) {
      try {
        await solari.close()
        clientClosed = true
      } catch (error) {
        cleanupErrors.push(describeError(error))
      }
    }
  }

  const findings = findingsFor(steps)
  return {
    runId,
    persona: input.persona,
    goal: input.goal,
    goalReached,
    targetUrl: input.url,
    finalUrl,
    model,
    summary,
    failureType,
    steps,
    actions: steps.flatMap((step) => step.decision ? [{
      step: step.step,
      action: step.decision.action,
      target: step.decision.target,
      text: step.decision.text,
      reason: step.decision.reason,
    }] : []),
    observations: steps.map((step) => step.observation),
    evidence,
    findings,
    uxFriction: category(findings, "ux_friction"),
    validationFailures: category(findings, "validation_failure"),
    brokenNavigation: category(findings, "broken_navigation"),
    functionalErrors: category(findings, "functional_error"),
    sessionId,
    replay: {
      url: replayUrl,
      path: replaySaved ? replayPath : null,
      saved: replaySaved,
      error: replayError,
    },
    video: { path: videoPath, saved: videoSaved, error: videoError },
    cleanup: { browserClosed, clientClosed, errors: cleanupErrors },
    runtimeError,
    durationMs: Date.now() - startedAt,
  }
}
