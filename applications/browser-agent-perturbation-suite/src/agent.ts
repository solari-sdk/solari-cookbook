import type { TaskSpec } from "./suite.js"

/**
 * The thing under test.
 *
 * `PageLike` is deliberately narrow — six operations, no Playwright types. The
 * harness passes a real Solari page; a test passes a fake. That seam is what
 * makes an agent's behaviour checkable without a browser, and it is where you
 * would plug in your own agent.
 */
export interface PageLike {
  goto(url: string): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  /** Is the selector present, visible, and actually clickable right now? */
  actionable(selector: string): Promise<boolean>
  waitMs(ms: number): Promise<void>
}

export interface AgentContext {
  page: PageLike
  /**
   * What to do — deliberately not the whole `TaskSpec`. `expect` is the answer
   * key, and a type that cannot reach it is worth more than a comment asking an
   * implementer not to look.
   */
  task: Pick<TaskSpec, "description" | "maxSteps">
  startUrl: string
}

/**
 * What the agent says happened.
 *
 * This is recorded next to the verdict and never inside it. An agent saying
 * "finished" is a claim; the shop's server-side record is the evidence. Keeping
 * the two visibly side by side is the point of the whole application.
 */
export interface AgentReport {
  finishReason: "finished" | "max_steps" | "stuck" | "error" | "timeout"
  steps: number
  message: string
}

export interface Agent {
  readonly name: string
  run(context: AgentContext): Promise<AgentReport>
}

export type Preset = "naive" | "resilient"

/**
 * A scripted driver. There is no model here and no reasoning — it follows a
 * fixed plan, and the two presets differ by exactly one capability:
 *
 *   naive      acts immediately. Never asks whether anything is in the way.
 *   resilient  clears blocking overlays, waits for controls that arrive late,
 *              and resumes an expired session before carrying on.
 *
 * Running the same grid under both is the most useful thing this program
 * prints, because the difference between the two numbers is the measured worth
 * of one capability rather than an opinion about it.
 *
 * Selectors are stable ids the fixture emits, and the plan is fixed. A real
 * agent would read the page and decide; swapping one in means implementing
 * `Agent` and changing nothing else.
 */
export function createAgent(preset: Preset): Agent {
  const resilient = preset === "resilient"

  return {
    name: preset,
    async run({ page, task, startUrl }): Promise<AgentReport> {
      let steps = 0

      const act = async (
        selector: string,
        perform: () => Promise<void>,
      ): Promise<void> => {
        if (steps >= task.maxSteps) throw new StepBudgetExhausted()

        if (resilient) {
          await clearObstacles(page)
          // The control may still be hydrating. Wait for it rather than
          // clicking into the space where it is about to be.
          for (let attempt = 0; attempt < 12; attempt++) {
            if (await page.actionable(selector)) break
            await page.waitMs(250)
          }
        }

        steps++
        await perform()
      }

      try {
        await page.goto(startUrl)

        await act("#add-to-cart", () => page.click("#add-to-cart"))
        await act("#coupon", () => page.fill("#coupon", "SAVE20"))
        await act("#apply-coupon", () => page.click("#apply-coupon"))
        await act("#to-checkout", () => page.click("#to-checkout"))
        await act("#name", () => page.fill("#name", "Ada Lovelace"))
        await act("#city", () => page.fill("#city", "London"))
        await act("#to-review", () => page.click("#to-review"))

        // The task says stop here. Nothing below clicks #place-order, and the
        // verdict checks that the order was not placed.
        return { finishReason: "finished", steps, message: "Reached the review page" }
      } catch (error) {
        if (error instanceof StepBudgetExhausted) {
          return { finishReason: "max_steps", steps, message: "Ran out of steps" }
        }
        return {
          finishReason: "error",
          steps,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/**
 * Clear whatever is in the way. Only the resilient preset calls this, and the
 * asymmetry is the experiment: the naive agent is not broken, it is simply an
 * agent nobody taught to look up.
 */
async function clearObstacles(page: PageLike): Promise<void> {
  if (await page.actionable("#resume")) {
    await page.click("#resume")
  }
  for (const dismiss of ["#accept-cookies", "#dismiss-modal"]) {
    if (await page.actionable(dismiss)) await page.click(dismiss)
  }
}

class StepBudgetExhausted extends Error {}
