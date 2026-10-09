// Settings read from the environment. See .env.example for what each one does.
import { join } from "node:path"
import type { Limits } from "./flow.ts"

const int = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got "${raw}"`)
  return n
}

export const config = {
  port: int("PORT", 3000),
  /** Records, recordings and final states. On a host, a persistent volume. */
  dataDir: process.env.DATA_DIR || join(import.meta.dirname, "..", "data"),
  /** Turns on the Reviewer's page at /admin. Unset means the admin API is off. */
  adminToken: process.env.ADMIN_TOKEN || "",
  /** Where `pnpm run new` points its printed links. */
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  demoEnabled: process.env.DEMO === "on",
  limits: {
    maxRooms: int("MAX_ROOMS", 1),
    demo: {
      task: process.env.DEMO_TASK || "lru-cache",
      workMinutes: int("DEMO_WORK_MINUTES", 10),
      setupMinutes: int("DEMO_SETUP_MINUTES", 3),
      dailyLimit: int("DEMO_DAILY_LIMIT", 20),
    },
  } satisfies Limits,
}
