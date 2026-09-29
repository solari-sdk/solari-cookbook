import type { Agent, AgentReport, PageLike } from "./agent.js"
import { classify, infrastructureFailure } from "./classify.js"
import type { FixtureHost } from "./fixture-host.js"
import type { ResourceStack } from "./lifecycle.js"
import { describe } from "./lifecycle.js"
import { requirePerturbation, resolveEnvironment, type ResolvedEnvironment } from "./perturbations.js"
import { deriveSeed } from "./random.js"
import type { SuiteSpec } from "./suite.js"
import { judge, undetermined, type ServerState } from "./verify.js"
import type { TrialResult } from "./aggregate.js"
import type { Evidence } from "./evidence.js"

/** A trial before it has been run: what to do, and in which environment. */
export interface PlannedTrial {
  id: string
  variant: string
  repetition: number
  seed: number
}

/** Expand the suite into the grid of trials, deterministically. */
export function planTrials(suite: SuiteSpec, runId: string): PlannedTrial[] {
  const trials: PlannedTrial[] = []
  let index = 0
  for (const variant of suite.variants) {
    for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
      index++
      trials.push({
        id: `t-${String(index).padStart(2, "0")}`,
        variant,
        repetition,
        seed: deriveSeed(runId, variant, repetition),
      })
    }
  }
  return trials
}

export interface TrialDeps {
  fixture: FixtureHost
  agent: Agent
  suite: SuiteSpec
  /**
   * The run's stack. Each trial takes a child of it, so a browser session is
   * reachable from the signal handler and not only from the trial's `finally`.
   */
  stack: ResourceStack
  /** Opens a page under the trial's perturbation, registered on `stack`. */
  openPage(
    stack: ResourceStack,
    environment: ResolvedEnvironment,
  ): Promise<{ page: PageLike; capture(): Promise<Uint8Array | null> }>
  log(message: string): void
}

export interface TrialOutcome {
  result: TrialResult
  evidence: Evidence
}

/**
 * One trial, start to finish.
 *
 * The order below is the whole design. The environment is registered before the
 * browser exists; the agent runs; the verdict is read from the server *after*
 * the agent has finished and regardless of what it claimed. A thrown agent is
 * still judged — an agent that crashed halfway may well have completed the task
 * first, and only the server can say.
 */
export async function runTrial(deps: TrialDeps, trial: PlannedTrial): Promise<TrialOutcome> {
  const started = Date.now()

  // A child of the run's stack, not a free-standing one: on Ctrl-C the handler
  // disposes the parent, and this comes with it.
  const stack = deps.stack.child(`trial ${trial.id}`)
  let agentReport: TrialResult["agent"] = null
  let screenshot: Uint8Array | null = null
  let state: ServerState | null = null

  try {
    // Inside the try: an unknown variant is a trial we could not judge, not a
    // rejection that would leave a hole in `outcomes` for `summarise` to read.
    const environment = resolveEnvironment(requirePerturbation(trial.variant), trial.seed)
    await deps.fixture.register(trial.id, trial.variant, trial.seed, environment.site)

    const { page, capture } = await deps.openPage(stack, environment)

    // Anything the agent throws is a fact about the agent, not a reason to skip
    // the verdict. Infrastructure failures are separated below by their type.
    agentReport = await withDeadline(
      deps.agent.run({
        page,
        task: deps.suite.task,
        startUrl: deps.fixture.urlFor("/", trial.id),
      }),
      deps.suite.task.timeoutMs,
    )

    screenshot = await capture()
  } catch (error) {
    // Reaching here means the browser or the sandbox failed, not the agent —
    // the agent's own errors are caught inside `agent.run`.
    const failure = infrastructureFailure("browser_error", describe(error))
    return {
      result: {
        ...trial,
        outcome: "undetermined",
        score: 0,
        durationMs: Date.now() - started,
        agent: agentReport,
        verdict: undetermined(describe(error)),
        failure,
      },
      evidence: { trialId: trial.id, serverState: null, screenshot: null },
    }
  } finally {
    // Released before the state is read: the verdict comes from the server, so
    // it does not need the browser, and holding a paid session open across an
    // HTTP round trip buys nothing.
    await stack.dispose().catch((error: unknown) => {
      deps.log(`  ${trial.id}: cleanup failed: ${describe(error)}`)
    })
    // Released, so it no longer needs to be reachable from the signal handler.
    stack.detach()
  }

  try {
    state = await deps.fixture.readState(trial.id)
  } catch (error) {
    return {
      result: {
        ...trial,
        outcome: "undetermined",
        score: 0,
        durationMs: Date.now() - started,
        agent: agentReport,
        verdict: undetermined(describe(error)),
        failure: infrastructureFailure("unreadable_state", describe(error)),
      },
      evidence: { trialId: trial.id, serverState: null, screenshot },
    }
  }

  const verdict = judge(state, deps.suite.task.expect)
  const failure = classify(verdict, state)

  return {
    result: {
      ...trial,
      outcome: verdict.outcome,
      score: verdict.score,
      durationMs: Date.now() - started,
      agent: agentReport,
      verdict,
      failure: failure.category === "none" ? null : failure,
    },
    evidence: { trialId: trial.id, serverState: state, screenshot },
  }
}

/**
 * Bound the agent as a whole, not just its individual clicks.
 *
 * Every page call has its own timeout, but a plan that keeps making slow
 * progress has no ceiling — and the browser session bills for all of it. On
 * expiry we record the timeout as the agent's own result and carry on to read
 * the server, because a run that stalled halfway still has a verdict worth
 * having. `Promise.race` keeps a handler attached to the abandoned agent, so a
 * late rejection from it cannot surface as an unhandled one.
 */
function withDeadline(work: Promise<AgentReport>, ms: number): Promise<AgentReport> {
  let timer: NodeJS.Timeout
  const expiry = new Promise<AgentReport>((resolve) => {
    timer = setTimeout(
      () => resolve({ finishReason: "timeout", steps: 0, message: `no result within ${ms}ms` }),
      ms,
    )
    timer.unref?.()
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

/**
 * Run the grid with a bounded number of sessions open at once.
 *
 * Every trial settles: one rejection must not abort its siblings, or a single
 * bad trial would cost the whole suite. Concurrency is capped because a plan
 * has a session limit, and exceeding it returns `ConcurrencyLimitExceeded`
 * rather than queueing.
 */
export async function runAll(
  deps: TrialDeps,
  trials: PlannedTrial[],
  concurrency: number,
): Promise<TrialOutcome[]> {
  const outcomes: TrialOutcome[] = new Array(trials.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < trials.length) {
      const index = next++
      const trial = trials[index] as PlannedTrial
      const outcome = await runTrial(deps, trial)
      outcomes[index] = outcome
      const mark = outcome.result.outcome.toUpperCase().padEnd(12)
      deps.log(
        `  ${mark} ${trial.variant} rep ${trial.repetition}  ` +
          `${(outcome.result.durationMs / 1000).toFixed(1)}s`,
      )
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, trials.length)) }, worker),
  )
  return outcomes
}
