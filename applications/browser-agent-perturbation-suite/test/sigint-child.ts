/**
 * Helper for the SIGINT case in lifecycle.test.ts — not a test itself.
 *
 * The topology is the point. The sandbox sits on the run's own stack and the
 * browser session sits on a *child* of it, which is exactly how `runTrial`
 * arranges them. An earlier version of this file added both directly to the run
 * stack; it passed against an implementation that abandoned every in-flight
 * trial on Ctrl-C, because the shape it tested was not the shape production
 * used. Keep the child here or this stops testing anything.
 */
import { withResources } from "../src/lifecycle.js"

function main(): Promise<void> {
  return withResources(async (stack) => {
    stack.add("fixture sandbox", null, async () => console.log("RELEASED sandbox"))

    const trial = stack.child("trial t-01")
    trial.add("browser session", null, async () => console.log("RELEASED session"))

    console.log("READY")
    setTimeout(() => process.kill(process.pid, "SIGINT"), 50)
    await new Promise((resolve) => setTimeout(resolve, 5000))
  })
}

void main()
