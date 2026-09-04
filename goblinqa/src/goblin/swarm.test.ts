import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { GoblinFinding } from "./brain.js"
import { PERSONAS, FIVE_PERSONAS, ALL_PERSONAS, type GoblinPersona } from "./personas.js"
import type { GoblinResult, RunGoblinInput } from "./runner.js"
import { aggregateResults, runSwarm, selectSwarmPersonas } from "./swarm.js"
import { clusterIssues } from "./clusters.js"

function resultFor(
  input: RunGoblinInput,
  options: {
    goalReached?: boolean
    finding?: GoblinFinding
    failureType?: GoblinResult["failureType"]
    runtimeError?: string | null
  } = {},
): GoblinResult {
  const finding = options.finding
  return {
    runId: input.runId ?? input.persona.id,
    persona: input.persona,
    goal: input.goal,
    goalReached: options.goalReached ?? true,
    targetUrl: input.url,
    finalUrl: `${input.url}done`,
    model: "test-model",
    summary: options.goalReached === false ? "failed" : "completed",
    failureType: options.failureType ?? null,
    steps: finding ? [{
      step: 1,
      observation: { url: input.url, title: "Test", visibleText: "Observed", interactiveElements: [] },
      decision: {
        action: "finish",
        target: "",
        text: "",
        reason: "Observed outcome",
        finding,
        failureType: "none",
      },
    }] : [],
    actions: [],
    observations: [],
    evidence: finding ? [{
      id: `${input.persona.id}-step-01`,
      capturedAt: "2026-01-01T00:00:00.000Z",
      step: 1,
      url: input.url,
      title: "Test",
      observationExcerpt: "Observed",
      screenshot: {
        path: `/tmp/${input.persona.id}-step-01.png`,
        saved: true,
        error: null,
      },
      action: {
        type: "finish",
        target: "",
        text: "",
        reason: "Observed outcome",
      },
      finding,
    }] : [],
    findings: finding ? [finding] : [],
    uxFriction: finding?.category === "ux_friction" ? [finding] : [],
    validationFailures: finding?.category === "validation_failure" ? [finding] : [],
    brokenNavigation: finding?.category === "broken_navigation" ? [finding] : [],
    functionalErrors: finding?.category === "functional_error" ? [finding] : [],
    sessionId: `session-${input.persona.id}`,
    replay: {
      url: `https://replay.test/${input.persona.id}`,
      path: `/tmp/${input.persona.id}.replay.ndjson`,
      saved: true,
      error: null,
    },
    video: { path: input.videoPath ?? `/tmp/${input.persona.id}.webm`, saved: true, error: null },
    cleanup: { browserClosed: true, clientClosed: true, errors: [] },
    runtimeError: options.runtimeError ?? null,
    durationMs: 10,
  }
}

test("swarm uses one runner sequentially, isolates artifacts, and continues after a failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goblinqa-swarm-"))
  const calls: RunGoblinInput[] = []
  let active = false
  try {
    const report = await runSwarm({
      url: "https://example.com/",
      goal: "Complete the test goal",
      milestone: 3,
      outputDirectory: directory,
      runId: "test-swarm",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      runOne: async (input) => {
        assert.equal(active, false, "runs must not overlap")
        active = true
        calls.push(input)
        active = false
        if (input.persona.id === "confused-user") throw new Error("provider unavailable")
        return resultFor(input)
      },
    })

    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map((call) => call.persona.name), PERSONAS.map((persona) => persona.name))
    assert.equal(new Set(calls.map((call) => call.runId)).size, 3)
    assert.equal(new Set(calls.map((call) => call.videoPath)).size, 3)
    assert.equal(report.individualResults.length, 3)
    assert.equal(report.milestone, 3)
    assert.equal(report.individualResults[1]?.persona.name, "Confused User")
    assert.equal(report.individualResults[1]?.goalReached, false)
    assert.equal(report.individualResults[2]?.persona.name, "Speedrunner")
    assert.equal(report.individualResults[2]?.goalReached, true)
    assert.equal(report.runtimeFailures.length, 1)
    const launchedResults = report.individualResults.filter((result) => result.sessionId)
    assert.equal(new Set(launchedResults.map((result) => result.sessionId)).size, 2)
    assert.equal(new Set(launchedResults.map((result) => result.replay.url)).size, 2)
    assert.equal(new Set(launchedResults.map((result) => result.replay.path)).size, 2)
    assert.equal(new Set(launchedResults.map((result) => result.video.path)).size, 2)

    for (const persona of PERSONAS) {
      const persisted = JSON.parse(await readFile(join(directory, `${persona.id}.json`), "utf8")) as { persona: GoblinPersona }
      assert.equal(persisted.persona.name, persona.name)
    }
    const aggregate = JSON.parse(await readFile(join(directory, "aggregate-report.json"), "utf8")) as { individualResults: unknown[] }
    assert.equal(aggregate.individualResults.length, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("aggregation identifies shared and persona-unique findings without mixing runtime failures", () => {
  const common: GoblinFinding = {
    category: "ux_friction",
    title: "Primary action is unclear",
    description: "The next action is not visually distinguished.",
  }
  const unique: GoblinFinding = {
    category: "validation_failure",
    title: "Required field guidance is missing",
    description: "Validation does not explain how to recover.",
  }
  const inputs = PERSONAS.map((persona) => ({
    url: "https://example.com/",
    goal: "Goal",
    persona,
    runId: persona.id,
    videoPath: `/tmp/${persona.id}.webm`,
  }))
  const results = [
    resultFor(inputs[0]!, { finding: common }),
    resultFor(inputs[1]!, { finding: { ...common, description: "The button hierarchy is ambiguous." } }),
    resultFor(inputs[2]!, { goalReached: false, finding: unique, failureType: "model_provider", runtimeError: "Gemini 503" }),
  ]
  const report = aggregateResults(3, "run", "https://example.com/", "Goal", "start", "end", results)

  assert.equal(report.sharedFindings.length, 1)
  assert.deepEqual(report.sharedFindings[0]?.personas, ["Normal User", "Confused User"])
  assert.deepEqual(report.sharedFindings[0]?.evidence[0]?.screenshotPaths, ["/tmp/normal-user-step-01.png"])
  assert.equal(report.personaUniqueFindings.length, 1)
  assert.deepEqual(report.personaUniqueFindings[0]?.personas, ["Speedrunner"])
  assert.equal(report.productFindings.length, 2)
  assert.deepEqual(report.runtimeFailures, [{ persona: "Speedrunner", stage: "run", failureType: "model_provider", error: "Gemini 503" }])
  assert.equal(report.evidenceByPersona.length, 3)
})

function clusterFixture(index: number, title: string, url = "https://example.com/request") {
  return resultFor({
    url,
    goal: "Create a request",
    persona: PERSONAS[index]!,
    runId: `run-${index}`,
  }, { finding: { category: "ux_friction", title, description: "Observed test symptom." } })
}

test("Milestone 5 runs five sequential independent Goblins and retains clustering after a failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goblinqa-five-"))
  const calls: RunGoblinInput[] = []
  let active = 0
  try {
    const report = await runSwarm({
      url: "https://example.com/",
      goal: "Complete the goal",
      milestone: 5,
      outputDirectory: directory,
      runId: "five-test",
      runOne: async (input) => {
        active += 1
        assert.equal(active, 1)
        calls.push(input)
        await new Promise<void>((resolve) => setImmediate(resolve))
        active -= 1
        return resultFor(input, input.persona.id === "speedrunner"
          ? { goalReached: false, failureType: "model_provider", runtimeError: "Gemini 503" }
          : { finding: { category: "ux_friction", title: "Request label unclear", description: "Observed fixture finding" } })
      },
    })
    assert.equal(report.milestone, 5)
    assert.deepEqual(calls.map((call) => call.persona), [...FIVE_PERSONAS])
    assert.equal(report.individualResults.length, 5)
    assert.equal(report.evidenceByPersona.length, 5)
    assert.equal(report.successByPersona.filter((item) => item.goalReached).length, 4)
    assert.equal(report.runtimeFailures.length, 1)
    assert.equal(report.issueClusters?.[0]?.independentRunCount, 4)
    for (const values of [
      report.individualResults.map((result) => result.runId),
      report.individualResults.map((result) => result.sessionId),
      report.individualResults.map((result) => result.replay.url),
      report.individualResults.map((result) => result.replay.path),
      report.individualResults.map((result) => result.video.path),
    ]) assert.equal(new Set(values).size, 5)
    for (const persona of FIVE_PERSONAS) {
      const persisted = JSON.parse(await readFile(join(directory, `${persona.id}.json`), "utf8")) as GoblinResult
      assert.equal(persisted.persona.id, persona.id)
    }
    const saved = JSON.parse(await readFile(join(directory, "aggregate-report.json"), "utf8")) as { individualResults: unknown[] }
    assert.equal(saved.individualResults.length, 5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Milestone 4 clusters similar titles and preserves every source and evidence link", () => {
  const a = clusterFixture(0, "Request submit button label is unclear")
  const b = clusterFixture(1, "Request submit button label is very unclear")
  const c = resultFor({ url: a.targetUrl, goal: a.goal, persona: PERSONAS[2] }, {
    goalReached: false, failureType: "model_provider", runtimeError: "Gemini 503",
  })
  const report = aggregateResults(4, "swarm", a.targetUrl, a.goal, "start", "end", [a, b, c])
  const clusters = report.issueClusters!
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]?.matchMethod, "similar-title")
  assert.equal(clusters[0]?.independentRunCount, 2)
  assert.equal(clusters[0]?.occurrences.length, 2)
  assert.deepEqual(clusters[0]?.notObservedByPersonas, ["Speedrunner"])
  assert.ok(clusters[0]?.occurrences.every((item) => item.evidence.length === 1 && item.observedPath.length === 1 && item.replay.path && item.video.saved))
  assert.equal(report.runtimeFailures.length, 1)
  assert.deepEqual(clusterIssues([c, b, a]), clusters)
})

test("clusters do not merge different routes, categories, or negations", () => {
  const title = "Request submit button label is unclear"
  const a = clusterFixture(0, title)
  const b = clusterFixture(1, title, "https://example.com/request?mode=other")
  const c = clusterFixture(2, "Request submit button label is not unclear")
  assert.equal(clusterIssues([a, b, c]).length, 3)
  const differentCategory = clusterFixture(1, title)
  differentCategory.steps[0]!.decision!.finding!.category = "functional_error"
  assert.equal(clusterIssues([a, differentCategory]).length, 2)
})

test("repeated findings in one run retain occurrences without inflating independent run count", () => {
  const a = clusterFixture(0, "Unclear request label")
  a.steps.push({ ...a.steps[0]!, step: 2 })
  const clusters = clusterIssues([a])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]?.occurrences.length, 2)
  assert.equal(clusters[0]?.independentRunCount, 1)
  assert.deepEqual(clusterIssues([]), [])
})

test("Milestone 6 validates counts and large-run consent before launching", async () => {
  const base = { url: "https://example.com", goal: "Goal", milestone: 6 as const }
  assert.equal(selectSwarmPersonas(base).length, 5)
  for (const count of [1, 3, 5, 20]) {
    assert.equal(selectSwarmPersonas({ ...base, goblinCount: count, allowLargeRun: true }).length, count)
  }
  let calls = 0
  for (const count of [0, -1, 21, 1.5, NaN, Infinity]) {
    await assert.rejects(runSwarm({ ...base, goblinCount: count, runOne: async (input) => {
      calls += 1
      return resultFor(input)
    } }), /integer from 1 to 20/)
  }
  await assert.rejects(runSwarm({ ...base, goblinCount: 20 }), /large-run authorization/)
  assert.throws(() => selectSwarmPersonas({ ...base, milestone: 5, goblinCount: 20 }), /require milestone 6/)
  assert.equal(calls, 0)
})

test("twenty simulated runs stay sequential, preserve artifacts, and continue after provider failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goblinqa-twenty-"))
  let active = 0
  const calls: RunGoblinInput[] = []
  try {
    const report = await runSwarm({
      url: "https://example.com", goal: "Goal", milestone: 6,
      goblinCount: 20, allowLargeRun: true, outputDirectory: directory,
      runOne: async (input) => {
        active += 1
        assert.equal(active, 1)
        calls.push(input)
        await new Promise<void>((resolve) => setImmediate(resolve))
        active -= 1
        return resultFor(input, input.persona.id === "bad-data"
          ? { goalReached: false, failureType: "model_provider", runtimeError: "Gemini 429" }
          : { finding: { category: "ux_friction", title: "Request label unclear", description: "Fixture observation" } })
      },
    })
    assert.equal(report.milestone, 6)
    assert.deepEqual(calls.map((call) => call.persona), [...ALL_PERSONAS])
    assert.equal(report.individualResults.length, 20)
    assert.equal(report.runtimeFailures.length, 1)
    assert.equal(report.issueClusters?.[0]?.independentRunCount, 19)
    for (const values of [
      calls.map((call) => call.runId), calls.map((call) => call.videoPath),
      report.evidenceByPersona.map((item) => item.sessionId),
      report.evidenceByPersona.map((item) => item.replayPath),
      report.evidenceByPersona.map((item) => item.replayUrl),
    ]) assert.equal(new Set(values).size, 20)
    for (const persona of ALL_PERSONAS) {
      const saved = JSON.parse(await readFile(join(directory, `${persona.id}.json`), "utf8")) as GoblinResult
      assert.equal(saved.persona.id, persona.id)
    }
    const saved = JSON.parse(await readFile(join(directory, "aggregate-report.json"), "utf8")) as { individualResults: unknown[] }
    assert.equal(saved.individualResults.length, 20)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("unconfirmed session release prevents further launches but preserves remaining result slots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goblinqa-cleanup-"))
  let calls = 0
  try {
    const report = await runSwarm({
      url: "https://example.com", goal: "Goal", milestone: 6,
      goblinCount: 20, allowLargeRun: true, outputDirectory: directory,
      runOne: async (input) => {
        calls += 1
        const result = resultFor(input)
        result.cleanup.browserClosed = false
        result.cleanup.errors.push("Release failed")
        return result
      },
    })
    assert.equal(calls, 1)
    assert.equal(report.individualResults.length, 20)
    for (const result of report.individualResults.slice(1)) {
      assert.equal(result.sessionId, null)
      assert.equal(result.video.saved, false)
      assert.equal(result.goalReached, false)
      assert.match(result.runtimeError!, /Not launched/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
