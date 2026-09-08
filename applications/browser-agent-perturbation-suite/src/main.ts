import { fileURLToPath } from "node:url"
import { summarise, evaluateThresholds } from "./aggregate.js"
import { createAgent, type Preset } from "./agent.js"
import { createSolari, openPage } from "./browser.js"
import { writeEvidence } from "./evidence.js"
import { startFixture } from "./fixture-host.js"
import { describe, withResources } from "./lifecycle.js"
import { adaptPage } from "./page-adapter.js"
import { PERTURBATIONS, requirePerturbation } from "./perturbations.js"
import { renderReport } from "./report.js"
import { planTrials, runAll } from "./run.js"
import { loadSuite } from "./suite.js"

/**
 * Exit codes are a contract, and the two failure modes must not share one:
 *   0  the suite ran and every configured threshold was met (or none was set)
 *   1  the suite ran and a configured threshold was missed
 *   2  the suite could not run at all — no key, the site never came up, a plan
 *      limit. "The agent is unreliable" and "we measured nothing" are different
 *      facts, and CI cannot act on them if they arrive as the same number.
 */
const EXIT = { ok: 0, thresholdMissed: 1, couldNotRun: 2 } as const

interface Flags {
  variants?: string[]
  repetitions?: number
  concurrency?: number
  agent: Preset
  suite: string
  out: string
  list: boolean
  help: boolean
}

/**
 * Overrides skip `parseSuite`'s validation, so they have to do their own.
 * `Number("abc")` is `NaN`, and an unchecked NaN here buys a sandbox and then
 * runs zero trials — which the threshold check reports as exit 1, "the agent is
 * unreliable", for a run that measured nothing.
 */
function positiveInt(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`)
  }
  return value
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    agent: "naive",
    suite: fileURLToPath(new URL("../suite.json", import.meta.url)),
    out: "runs",
    list: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    switch (arg) {
      case "--variants": flags.variants = value().split(",").map((v) => v.trim()); break
      case "--repetitions": flags.repetitions = positiveInt(value(), arg); break
      case "--concurrency": flags.concurrency = positiveInt(value(), arg); break
      case "--agent": flags.agent = value() as Preset; break
      case "--suite": flags.suite = value(); break
      case "--out": flags.out = value(); break
      case "--list": flags.list = true; break
      case "--help": case "-h": flags.help = true; break
      default: throw new Error(`unknown option ${arg}`)
    }
  }

  if (flags.agent !== "naive" && flags.agent !== "resilient") {
    throw new Error(`--agent must be "naive" or "resilient"`)
  }
  return flags
}

const HELP = `
Run one browser task across a grid of perturbed environments and score it from
the shop's own server-side state.

  npm start -- [options]

  --variants a,b,c     which perturbations to run   (default: from suite.json)
  --repetitions N      runs per variant             (default: from suite.json)
  --concurrency N      sessions open at once        (default: from suite.json)
  --agent naive|resilient                           (default: naive)
  --suite path.json    the suite spec               (default: ./suite.json)
  --out dir            where evidence is written    (default: ./runs)
  --list               print the perturbations and exit (no key, no network)
`

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))

  if (flags.help) {
    console.log(HELP)
    return EXIT.ok
  }

  // Costs nothing and needs nothing, so a reader can see what is on offer
  // before deciding whether to spend anything.
  if (flags.list) {
    for (const p of PERTURBATIONS) {
      console.log(`  ${p.id.padEnd(18)} ${p.category.padEnd(9)} ${p.description}`)
    }
    return EXIT.ok
  }

  const suite = await loadSuite(flags.suite)
  if (flags.variants) {
    for (const id of flags.variants) requirePerturbation(id)
    suite.variants = flags.variants
  }
  if (flags.repetitions !== undefined) suite.repetitions = flags.repetitions
  if (flags.concurrency !== undefined) suite.concurrency = flags.concurrency

  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    console.error("Set SOLARI_API_KEY — get one at https://console.getsolari.com")
    return EXIT.couldNotRun
  }

  const runId = `run-${Date.now().toString(36)}`
  const trials = planTrials(suite, runId)

  // Say what this will cost before spending any of it.
  console.log(
    `\n  ${suite.variants.length} variants x ${suite.repetitions} repetitions = ` +
      `${trials.length} browser sessions, plus 1 sandbox for the site.`,
  )
  console.log(`  agent: ${flags.agent}   up to ${suite.concurrency} sessions at once`)
  console.log(`  Ctrl-C is safe: every session is released before exit.\n`)

  const outcomes = await withResources(async (stack) => {
    const fixture = await startFixture(apiKey, stack, (m) => console.log(`  ${m}`))
    const solari = createSolari(apiKey, stack)
    const agent = createAgent(flags.agent)

    return runAll(
      {
        fixture,
        agent,
        suite,
        stack,
        log: (message) => console.log(message),
        openPage: async (trialStack, environment) => {
          const page = await openPage(solari, trialStack, environment.browser)
          return {
            page: adaptPage(page),
            // Best effort. A missing screenshot is not a reason to lose a run,
            // but it must not hold a paid session open indefinitely either.
            capture: () => page.screenshot({ timeout: 15_000 }).catch(() => null),
          }
        },
      },
      trials,
      suite.concurrency,
    )
  })

  const result = summarise(flags.agent, outcomes.map((o) => o.result))
  const checks = evaluateThresholds(result, suite.thresholds)

  const directory = `${flags.out}/${runId}`
  await writeEvidence(directory, result, outcomes.map((o) => o.evidence))

  console.log(renderReport(result, checks))
  console.log(`  Evidence in ${directory}/ (session ids and preview URLs redacted)\n`)

  return checks.length > 0 && !checks.every((c) => c.met) ? EXIT.thresholdMissed : EXIT.ok
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n  ${describe(error)}\n`)
    process.exit(EXIT.couldNotRun)
  })
