// Runs once when the server process boots.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { sweepOrphans, killAllTracked } = await import("@/lib/session-manager")

  // Clean up anything a crashed previous process left running.
  await sweepOrphans().catch((err) => {
    console.error("orphan sweep failed:", err)
  })

  // Teardown must run on every exit path, not just a clean shutdown — a
  // sandbox or browser session left dangling keeps billing.
  let tearingDown = false
  const shutdown = (reason: string) => {
    if (tearingDown) return
    tearingDown = true
    killAllTracked(reason)
      .catch((err) => console.error("shutdown teardown failed:", err))
      .finally(() => process.exit(0))
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("unhandledRejection", (err) => {
    console.error("unhandled rejection:", err)
    shutdown("unhandled rejection")
  })
  process.on("uncaughtException", (err) => {
    console.error("uncaught exception:", err)
    shutdown("uncaught exception")
  })
}
