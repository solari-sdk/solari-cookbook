import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  dailyMinutesUsed: integer("daily_minutes_used").default(0),
  dailyMinutesResetAt: integer("daily_minutes_reset_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  mode: text("mode", { enum: ["repo", "site"] }).notNull(),
  inputUrl: text("input_url").notNull(),
  status: text("status", {
    enum: ["pending", "detecting", "awaiting_confirm", "running", "done", "failed", "killed"],
  })
    .notNull()
    .default("pending"),
  sandboxId: text("sandbox_id"),
  browserId: text("browser_id"),
  previewUrl: text("preview_url"),
  detectedFramework: text("detected_framework"),
  detectedPkgManager: text("detected_pkg_manager"),
  detectedPort: integer("detected_port"),
  installCmd: text("install_cmd"),
  buildCmd: text("build_cmd"),
  startCmd: text("start_cmd"),
  isStatic: integer("is_static", { mode: "boolean" }).default(false),
  serverReady: integer("server_ready", { mode: "boolean" }).default(false),
  outOfScopeReason: text("out_of_scope_reason"),
  errorSummary: text("error_summary"),
  errorPhase: text("error_phase"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  extendedAt: integer("extended_at", { mode: "timestamp" }),
  extendCount: integer("extend_count").default(0),
  lastHeartbeat: integer("last_heartbeat", { mode: "timestamp" }),
  costCents: integer("cost_cents").default(0),
})

export const logEntries = sqliteTable("log_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  level: text("level", { enum: ["info", "warn", "error", "debug"] }).notNull(),
  phase: text("phase"),
  message: text("message").notNull(),
})

// Small PNGs only (load + settle screenshots for site mode). Kept in the
// database so serving them can go through the same session-auth check as
// everything else instead of living at a guessable static path.
export const screenshots = sqliteTable("screenshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  kind: text("kind", { enum: ["load", "settle"] }).notNull(),
  data: blob("data", { mode: "buffer" }).notNull(),
  takenAt: integer("taken_at", { mode: "timestamp" }).notNull(),
})

export const downloads = sqliteTable("downloads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  filename: text("filename").notNull(),
  url: text("url").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  sha256: text("sha256"),
  seenAt: integer("seen_at", { mode: "timestamp" }).notNull(),
})

export const clipboardEvents = sqliteTable("clipboard_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  text: text("text").notNull(),
  seenAt: integer("seen_at", { mode: "timestamp" }).notNull(),
})
