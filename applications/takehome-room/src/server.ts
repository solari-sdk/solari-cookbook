// The JSON API under /api, and in production the built web app from web/dist.
// In development, Vite serves the web app and proxies /api here.
import { timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Hono, type Context } from "hono"
import type { DemoStatus, NewInterview, TaskSummary } from "../shared/api.ts"
import { PhaseError, type Interview } from "./interview.ts"
import { SlotError, type Flow } from "./flow.ts"
import type { Store } from "./store.ts"
import type { Task } from "./tasks.ts"
import { candidateView, interviewSummary, reviewerView } from "./views.ts"
import { fileResponse, webApp } from "./static.ts"

class NotFound extends Error {}
class BadRequest extends Error {}

export interface AppDeps {
  flow: Flow
  store: Store
  loadTask: (name: string) => Task
  listTasks: () => string[]
  adminToken: string
  demo: { enabled: boolean; workMinutes: number; setupMinutes: number }
}

export function createApp({ flow, store, loadTask, listTasks, adminToken, demo }: AppDeps): Hono {
  const app = new Hono()

  // Hono hands errors thrown in handlers to onError, so the expected cases live here.
  app.onError((err, c) => {
    if (err instanceof NotFound) return c.json({ error: "Not found" }, 404)
    if (err instanceof PhaseError) return c.json({ error: err.message }, 409)
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400)
    if (err instanceof SlotError) {
      c.header("Retry-After", String(err.retryAfterSeconds))
      return c.json({ error: err.message, reason: err.reason, retryAfterSeconds: err.retryAfterSeconds }, 429)
    }
    console.error(err)
    return c.json({ error: "Internal error" }, 500)
  })

  const candidate = (c: Context): Interview => store.byCandidateToken(c.req.param("token") ?? "") ?? notFound()
  const reviewer = (c: Context): Interview => store.byReviewerToken(c.req.param("token") ?? "") ?? notFound()
  const forCandidate = (iv: Interview) => candidateView(iv, loadTask(iv.task), Date.now())

  // --- Candidate ---

  app.get("/api/c/:token", (c) => {
    const iv = candidate(c)
    // The page checks in every 10 s while the Room is open. Use that to resume a
    // Room that paused while the Candidate was away.
    if (iv.phase === "setup" || iv.phase === "working") flow.wake(iv.id)
    return c.json(forCandidate(iv))
  })
  app.post("/api/c/:token/open", (c) => c.json(forCandidate(flow.open(candidate(c).id))))
  app.post("/api/c/:token/start", (c) => c.json(forCandidate(flow.start(candidate(c).id))))
  app.post("/api/c/:token/submit", (c) => c.json(forCandidate(flow.end(candidate(c).id, "submitted"))))

  // --- Demo ---

  app.get("/api/demo", (c) => {
    if (!demo.enabled) return c.json({ enabled: false } satisfies DemoStatus)
    const gate = flow.demoStatus()
    return c.json({
      enabled: true,
      available: gate.ok,
      reason: gate.ok ? undefined : gate.reason,
      retryAfterSeconds: gate.ok ? undefined : gate.retryAfterSeconds,
      workMinutes: demo.workMinutes,
      setupMinutes: demo.setupMinutes,
    } satisfies DemoStatus)
  })
  app.post("/api/demo", (c) => {
    if (!demo.enabled) notFound()
    const iv = flow.createDemo()
    return c.json({ candidatePath: `/c/${iv.candidateToken}` }, 201)
  })

  // --- Reviewer ---

  app.get("/api/r/:token", (c) => {
    const iv = reviewer(c)
    const dir = store.artifactDir(iv.id)
    return c.json(
      reviewerView(iv, loadTask(iv.task), {
        hasRecording: existsSync(join(dir, "recording.mp4")),
        hasFinalState: existsSync(join(dir, "final-state.tgz")),
      }),
    )
  })
  const artifact = (c: Context, name: string, type: string) => {
    const path = join(store.artifactDir(reviewer(c).id), name)
    return existsSync(path) ? fileResponse(path, type, c.req.header("range")) : notFound()
  }
  app.get("/api/r/:token/recording.mp4", (c) => artifact(c, "recording.mp4", "video/mp4"))
  app.get("/api/r/:token/final-state.tgz", (c) => artifact(c, "final-state.tgz", "application/gzip"))

  // --- The Reviewer's page (/admin) ---
  //
  // Creating an Interview spends Solari credit and the list holds every Reviewer
  // link, so these routes need ADMIN_TOKEN. Without it set, they stay off.

  app.use("/api/admin/*", async (c, next) => {
    if (!adminToken) return c.json({ error: "Set ADMIN_TOKEN in .env to turn on the reviewer page." }, 503)
    const given = Buffer.from(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "")
    const expected = Buffer.from(adminToken)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "Wrong admin token." }, 401)
    }
    await next()
  })

  app.get("/api/admin/tasks", (c) =>
    c.json(
      listTasks().map((name): TaskSummary => {
        const t = loadTask(name)
        return { name, title: t.title, workMinutes: t.workMinutes, setupMinutes: t.setupMinutes }
      }),
    ),
  )
  app.get("/api/admin/interviews", (c) =>
    c.json(
      store
        .all()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((iv) => interviewSummary(iv, loadTask(iv.task))),
    ),
  )
  app.post("/api/admin/interviews", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<NewInterview>
    if (typeof body.task !== "string" || !listTasks().includes(body.task)) throw new BadRequest("Pick a task from the list.")
    const iv = flow.create(body.task, {
      workMinutes: minutes(body.workMinutes, "Work time", 1),
      setupMinutes: minutes(body.setupMinutes, "Setup time", 0),
    })
    return c.json(interviewSummary(iv, loadTask(iv.task)), 201)
  })

  // Anything else under /api is a mistake, not a page.
  app.all("/api/*", () => notFound())

  // --- The built web app ---
  app.get("*", (c) => webApp(c.req.path))

  return app
}

function notFound(): never {
  throw new NotFound()
}

function minutes(v: unknown, name: string, min: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > 300) throw new BadRequest(`${name} must be a whole number from ${min} to 300.`)
  return n
}
