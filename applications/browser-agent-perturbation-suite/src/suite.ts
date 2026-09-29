import { readFile } from "node:fs/promises"
import { requirePerturbation } from "./perturbations.js"

/**
 * What the agent has to do, and what counts as having done it.
 *
 * `description` is the only part the agent sees. `expect` is the only part the
 * verdict uses, and `AgentContext` narrows this type so an agent cannot reach it
 * — "the agent knew the answer" should not be available as an explanation for a
 * pass, and a comment saying so would not be enough.
 */
export interface TaskSpec {
  description: string
  maxSteps: number
  timeoutMs: number
  expect: Expectation
}

export interface Expectation {
  productSku: string
  quantity: number
  coupon: string | null
  discountApplied: boolean
  checkoutName: string | null
  checkoutCity: string | null
  stage: string
  purchaseSubmitted: boolean
}

export interface Thresholds {
  /** Pass rate across every scorable trial. */
  reliability?: number
  /** The control must hold. See `evaluateThresholds`. */
  baseline?: number
}

export interface SuiteSpec {
  task: TaskSpec
  variants: string[]
  repetitions: number
  concurrency: number
  thresholds: Thresholds
}

export async function loadSuite(path: string): Promise<SuiteSpec> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`cannot read suite file: ${path}`)
  }
  return parseSuite(raw, path)
}

/** Split out from `loadSuite` so the validation rules are testable without a file. */
export function parseSuite(raw: string, source = "suite"): SuiteSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`)
  }
  const input = parsed as Partial<SuiteSpec>

  const task = input.task
  if (!task?.description) throw new Error(`${source}: task.description is required`)
  if (!task.expect) throw new Error(`${source}: task.expect is required`)

  const variants = input.variants ?? []
  if (variants.length === 0) throw new Error(`${source}: at least one variant is required`)
  // Fail here rather than three minutes into a paid run.
  for (const id of variants) requirePerturbation(id)

  const repetitions = input.repetitions ?? 1
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(`${source}: repetitions must be a positive integer`)
  }

  return {
    task: {
      description: task.description,
      maxSteps: task.maxSteps ?? 25,
      timeoutMs: task.timeoutMs ?? 90_000,
      expect: task.expect,
    },
    variants: [...variants],
    repetitions,
    concurrency: input.concurrency ?? 2,
    thresholds: input.thresholds ?? {},
  }
}
