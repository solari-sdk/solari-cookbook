// Starts the production server: the API, the clocks, and the built web app.
import { serve } from "@hono/node-server"
import { flow, store } from "./app.ts"
import { config } from "./config.ts"
import { createApp } from "./server.ts"
import { listTasks, loadTask } from "./tasks.ts"

const app = createApp({
  flow,
  store,
  loadTask,
  listTasks,
  adminToken: config.adminToken,
  demo: {
    enabled: config.demoEnabled,
    workMinutes: config.limits.demo.workMinutes,
    setupMinutes: config.limits.demo.setupMinutes,
  },
})

// Re-arm clocks and settle Interviews that a restart left halfway.
flow.resume()

serve({ fetch: app.fetch, port: config.port }, () => console.log(`takehome-room on http://localhost:${config.port}`))
