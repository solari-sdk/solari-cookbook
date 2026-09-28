/**
 * One agent = one Durable Object.
 *
 * Filing a task stores it and sets an alarm; the request returns at once. The
 * alarm is what does the work, so nothing depends on the caller staying
 * connected: close the laptop and the task still runs to a pull request.
 *
 * Tasks run one at a time, each in its own directory of the agent's sandbox,
 * on its own branch. Every phase is timed, and the output is saved as it
 * streams, so a task in progress can be read while it runs.
 */
import { DurableObject } from "cloudflare:workers"
import { ConcurrencyLimitError } from "@solarisdk/sdk"
import { SandboxSlot, solari } from "./sandbox.ts"
import { agentScript, branchFor, CHECKOUT, DIFFSTAT, parseRepo, prBody, prTitle, PUBLISH, TOOLCHAIN, type Task } from "./steps.ts"

export type { Status, Task } from "./steps.ts"

export interface Env {
  AGENT: DurableObjectNamespace<Agent>
  SOLARI_API_KEY: string
  GITHUB_TOKEN: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  ANTHROPIC_API_KEY?: string
  AGENT_TOKEN: string
  /** Replaces Claude Code with any shell command. See steps.ts. */
  AGENT_COMMAND?: string
}

const AGENT_TIMEOUT_S = 10 * 60
const OUTPUT_CAP = 20_000
/** A plan's sandbox slots are all taken: try again this much later. */
const SLOT_RETRY_MS = 60_000

export class Agent extends DurableObject<Env> {
  private slot?: SandboxSlot
  /**
   * True while this instance is executing a task. In memory on purpose: it
   * only resets when the object itself restarts — which is exactly the case
   * where a "running" task really was interrupted.
   */
  private busy = false

  private sandboxSlot(name: string): SandboxSlot {
    this.slot ??= new SandboxSlot(this.ctx.storage, solari(this.env.SOLARI_API_KEY), name)
    return this.slot
  }

  // ---- the API the Worker calls ------------------------------------------

  async file(name: string, input: { repo: string; goal: string; base?: string }): Promise<Task> {
    parseRepo(input.repo) // throw now, not in the middle of the night
    if (!input.goal?.trim()) throw new Error("goal is required")
    await this.ctx.storage.put("name", name)
    const id = crypto.randomUUID().slice(0, 8)
    const task: Task = {
      id,
      repo: input.repo,
      goal: input.goal.trim(),
      base: input.base,
      branch: branchFor(id),
      status: "queued",
      createdAt: new Date().toISOString(),
      phases: {},
      output: "",
    }
    await this.save(task)
    const order = (await this.ctx.storage.get<string[]>("order")) ?? []
    await this.ctx.storage.put("order", [...order, id])
    // Now, unless one is already set: a running task picks up the rest itself.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now())
    return task
  }

  async list(): Promise<Omit<Task, "output">[]> {
    return (await this.tasks()).map(({ output: _, ...rest }) => rest)
  }

  async get(id: string): Promise<Task | null> {
    return (await this.ctx.storage.get<Task>(`task:${id}`)) ?? null
  }

  async releaseSandbox(): Promise<{ killed: string | null }> {
    const name = (await this.ctx.storage.get<string>("name")) ?? "agent"
    return { killed: await this.sandboxSlot(name).release() }
  }

  // ---- the work ----------------------------------------------------------

  async alarm(): Promise<void> {
    // Filing a task while another runs sets a fresh alarm; let this instance
    // finish rather than have that alarm mistake the live task for a dead one.
    if (this.busy) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      return
    }
    const all = await this.tasks()

    // A task still "running" when an alarm starts means the run before this
    // one died partway (an eviction, a deploy). Its branch may already be
    // pushed, so running it again could open a second PR. Mark it and move on.
    for (const t of all.filter((t) => t.status === "running")) {
      await this.save({ ...t, status: "interrupted", error: "the run stopped partway; file it again to retry", finishedAt: new Date().toISOString() })
    }

    const next = all.find((t) => t.status === "queued")
    if (!next) return
    this.busy = true
    let outcome: "done" | "no-slot"
    try {
      outcome = await this.execute(next)
    } finally {
      this.busy = false
    }
    if (outcome === "no-slot") {
      await this.ctx.storage.setAlarm(Date.now() + SLOT_RETRY_MS)
      return
    }
    // Re-read: tasks may have been filed while this one ran.
    if ((await this.tasks()).some((t) => t.status === "queued")) await this.ctx.storage.setAlarm(Date.now())
  }

  private async tasks(): Promise<Task[]> {
    const order = (await this.ctx.storage.get<string[]>("order")) ?? []
    const map = await this.ctx.storage.get<Task>(order.map((id) => `task:${id}`))
    return order.map((id) => map.get(`task:${id}`)).filter((t): t is Task => !!t)
  }

  /** Runs one task to a terminal state. Never throws: a thrown alarm is retried. */
  private async execute(task: Task): Promise<"done" | "no-slot"> {
    const name = (await this.ctx.storage.get<string>("name")) ?? "agent"
    const slot = this.sandboxSlot(name)
    const { owner, name: repoName } = parseRepo(task.repo)
    const env = {
      REPO: `${owner}/${repoName}`,
      BASE: task.base ?? "",
      DIR: `/work/${task.id}`,
      BRANCH: task.branch,
    }
    task = { ...task, status: "running", startedAt: new Date().toISOString(), step: "sandbox" }
    await this.save(task)

    const phase = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
      task.step = step
      await this.save(task)
      const t = Date.now()
      try {
        return await fn()
      } finally {
        task.phases[step] = Date.now() - t
      }
    }
    const must = (step: string, r: { exitCode: number; stdout: string; stderr: string }) => {
      if (r.exitCode !== 0) throw new Error(`${step} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-1500)}`)
      return r.stdout.trim()
    }

    try {
      await phase("sandbox", async () => {
        try {
          await slot.attach()
        } catch (err) {
          if (err instanceof ConcurrencyLimitError) throw new NoSlot()
          throw err
        }
      })
      // The only step that stands alone: safe to run again on a fresh sandbox.
      const tools = await phase("toolchain", () => slot.exec(TOOLCHAIN, {}, { timeoutMs: 5 * 60_000, portable: true }))
      must("toolchain", tools)

      const checkout = await phase("checkout", () =>
        slot.exec(CHECKOUT, { ...env, GITHUB_TOKEN: this.env.GITHUB_TOKEN }, { timeoutMs: 5 * 60_000 }),
      )
      const [defaultBranch, start] = must("checkout", checkout).split("\n").slice(-2)
      const withStart = { ...env, START: start }

      // Save streamed output at most every two seconds, not per chunk.
      let lastSave = 0
      const onOutput = (chunk: string) => {
        task.output = (task.output + chunk).slice(-OUTPUT_CAP)
        if (Date.now() - lastSave > 2_000) {
          lastSave = Date.now()
          void this.save(task)
        }
      }
      const run = await phase("agent", () =>
        slot.exec(
          agentScript(AGENT_TIMEOUT_S),
          { ...env, GOAL: task.goal, ...this.agentCredentials() },
          { timeoutMs: (AGENT_TIMEOUT_S + 60) * 1000, onOutput },
        ),
      )
      task.output = (run.stdout + run.stderr).slice(-OUTPUT_CAP) || task.output
      if (run.exitCode === 124) throw new Error(`the agent timed out after ${AGENT_TIMEOUT_S}s`)
      must("agent", run)

      const published = await phase("push", () =>
        slot.exec(PUBLISH, { ...withStart, TITLE: prTitle(task.goal), GITHUB_TOKEN: this.env.GITHUB_TOKEN }, { timeoutMs: 2 * 60_000 }),
      )
      const sha = must("push", published)
      if (!sha) {
        await this.finish(task, { status: "no-changes" })
        return "done"
      }
      task.sha = sha

      // The branch is pushed; from here on nothing may stop the PR opening.
      // The diff stat is decoration, so losing it costs a line of the body.
      const stat = await slot
        .exec(DIFFSTAT, withStart, { timeoutMs: 30_000 })
        .then((r) => (r.exitCode === 0 ? r.stdout : ""), () => "")
      const pr = await phase("pull-request", () =>
        this.openPullRequest(owner, repoName, {
          title: prTitle(task.goal),
          head: task.branch,
          base: task.base || defaultBranch,
          body: prBody(task, stat),
        }),
      )
      await this.finish(task, { status: "pr-opened", pr })
      return "done"
    } catch (err) {
      if (err instanceof NoSlot) {
        // Every sandbox the plan allows is busy (another agent's). Not a
        // failure of this task: put it back and come back in a minute.
        await this.save({ ...task, status: "queued", step: "waiting for a free sandbox slot", startedAt: undefined })
        return "no-slot"
      }
      // A pushed branch with no PR is still work worth having: point at it.
      const pushed = task.sha ? ` The branch ${task.branch} was pushed (${task.sha.slice(0, 7)}); open a PR from it by hand.` : ""
      await this.finish(task, { status: "failed", error: (err as Error).message + pushed })
      return "done"
    }
  }

  private agentCredentials(): Record<string, string> {
    if (this.env.AGENT_COMMAND) return { AGENT_COMMAND: this.env.AGENT_COMMAND }
    if (this.env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: this.env.CLAUDE_CODE_OAUTH_TOKEN }
    if (this.env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY }
    throw new Error("no agent credentials: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
  }

  private async openPullRequest(
    owner: string,
    repo: string,
    pr: { title: string; head: string; base: string; body: string },
  ): Promise<{ url: string; number: number }> {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "solari-agentinstance",
      },
      body: JSON.stringify(pr),
    })
    if (!res.ok) throw new Error(`GitHub refused the pull request: ${res.status} ${(await res.text()).slice(0, 500)}`)
    const body = (await res.json()) as { html_url: string; number: number }
    return { url: body.html_url, number: body.number }
  }

  private async finish(task: Task, patch: Partial<Task>): Promise<void> {
    await this.save({ ...task, ...patch, step: undefined, finishedAt: new Date().toISOString() })
  }

  private save(task: Task): Promise<void> {
    return this.ctx.storage.put(`task:${task.id}`, task)
  }
}

class NoSlot extends Error {}
