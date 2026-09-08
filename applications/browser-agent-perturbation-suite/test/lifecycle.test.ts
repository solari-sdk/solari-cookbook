import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe as group, expect, it } from "vitest"
import { ResourceStack, describe, withResources } from "../src/lifecycle.js"

/**
 * These are the tests that keep the bug out.
 *
 * The submission this application replaces released its browser inside `try`
 * rather than `finally`, so a throw from a click left a paid session running
 * until it idled out. Every case below is that bug, or a way it comes back.
 */
group("ResourceStack", () => {
  it("releases in LIFO order, so nothing outlives what depends on it", async () => {
    const released: string[] = []
    const stack = new ResourceStack()
    stack.add("sandbox", "sandbox", async (r) => void released.push(r))
    stack.add("session", "session", async (r) => void released.push(r))
    stack.add("context", "context", async (r) => void released.push(r))

    await stack.dispose()

    expect(released).toEqual(["context", "session", "sandbox"])
  })

  it("releases the resource when the code after acquisition throws", async () => {
    // This is PR-review-comment-shaped: acquisition succeeds, the next
    // statement fails, and the resource must still come back.
    let closed = false
    await expect(
      withResources(async (stack) => {
        stack.add("browser session", {}, async () => void (closed = true))
        throw new Error("fill() failed")
      }),
    ).rejects.toThrow("fill() failed")

    expect(closed).toBe(true)
  })

  it("runs every disposer exactly once, even when disposed twice", async () => {
    let count = 0
    const stack = new ResourceStack()
    stack.add("session", null, async () => void count++)

    await stack.dispose()
    await stack.dispose()

    expect(count).toBe(1)
  })

  it("makes a second caller wait for the first run rather than returning early", async () => {
    // A second caller that returned immediately would let the process exit
    // while a release was still in flight — the same leak, wearing a hat.
    const order: string[] = []
    const stack = new ResourceStack()
    stack.add("slow session", null, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push("released")
    })

    const first = stack.dispose()
    const second = stack.dispose()
    await Promise.all([first, second])
    order.push("both returned")

    expect(order).toEqual(["released", "both returned"])
  })

  it("keeps releasing after a disposer throws, and reports every failure", async () => {
    const released: string[] = []
    const stack = new ResourceStack()
    stack.add("sandbox", "sandbox", async (r) => void released.push(r))
    stack.add("wedged", null, async () => {
      throw new Error("release refused")
    })
    stack.add("context", "context", async (r) => void released.push(r))

    await expect(stack.dispose()).rejects.toThrow("failed to release wedged")

    // The important assertion: the failure did not cost us the other two.
    expect(released).toEqual(["context", "sandbox"])
  })

  it("aggregates multiple failures instead of letting the first one hide the rest", async () => {
    const stack = new ResourceStack()
    stack.add("first", null, async () => {
      throw new Error("boom one")
    })
    stack.add("second", null, async () => {
      throw new Error("boom two")
    })

    const error = await stack.dispose().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AggregateError)
    expect(describe(error)).toContain("boom one")
    expect(describe(error)).toContain("boom two")
  })

  it("abandons a release that hangs so the rest of the stack still runs", async () => {
    let released = false
    const stack = new ResourceStack(50)
    stack.add("sandbox", null, async () => void (released = true))
    stack.add("hung session", null, () => new Promise<void>(() => {}))

    const error = await stack.dispose().catch((e: unknown) => e)

    expect(describe(error)).toMatch(/hung session.*timed out/)
    // The point of the timeout: the sandbox below it still came back.
    expect(released).toBe(true)
  })

  it("releases a resource that arrives while teardown is already running", async () => {
    // Not hypothetical: `sandboxes.create()` is awaited *before* `add` is
    // called, so a signal can land while a VM is being born. Refusing the
    // registration would leave something already billing with nobody holding a
    // reference to it.
    let released = false
    const stack = new ResourceStack()
    stack.add("slow session", null, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const disposing = stack.dispose()
    stack.add("late sandbox", null, async () => void (released = true))
    await disposing

    expect(released).toBe(true)
  })

  it("releases a child stack's resources as part of the parent, child first", async () => {
    // The shape `runTrial` uses. A trial that owned a free-standing stack would
    // be released by its own `finally` and by nothing at all on the signal path.
    const released: string[] = []
    const stack = new ResourceStack()
    stack.add("sandbox", "sandbox", async (r) => void released.push(r))
    const trial = stack.child("trial t-01")
    trial.add("session", "session", async (r) => void released.push(r))

    await stack.dispose()

    expect(released).toEqual(["session", "sandbox"])
  })

  it("stops a detached child from being disposed twice by the parent", async () => {
    // A finished trial detaches, so a long grid does not accumulate one spent
    // entry per trial — and the disposer must not run a second time.
    let count = 0
    const stack = new ResourceStack()
    const trial = stack.child("trial t-01")
    trial.add("session", null, async () => void count++)

    await trial.dispose()
    trial.detach()
    await stack.dispose()

    expect(count).toBe(1)
  })

  it("does not let a cleanup failure mask the error that caused it", async () => {
    // Losing the real cause to a secondary cleanup error makes a run much
    // harder to debug than the leak would have been.
    await expect(
      withResources(async (stack) => {
        stack.add("wedged", null, async () => {
          throw new Error("release refused")
        })
        throw new Error("the actual problem")
      }),
    ).rejects.toThrow("the actual problem")
  })

  it("releases everything when the terminal interrupts the run", async () => {
    // The second way to leak a paid session, and the one a `finally` alone
    // does not cover: the default SIGINT action ends the process without
    // unwinding. Run it for real in a child, because a signal raised inside
    // the test runner would take the runner down with it.
    const child = fileURLToPath(new URL("./sigint-child.ts", import.meta.url))
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))

    const result = await promisify(execFile)(tsx, [child]).catch(
      (error: { code?: number; signal?: string; stdout?: string }) => error,
    )

    const stdout = result.stdout ?? ""
    expect(stdout).toContain("READY")
    expect(stdout).toContain("RELEASED session")
    expect(stdout).toContain("RELEASED sandbox")
    // LIFO holds under a signal too.
    expect(stdout.indexOf("RELEASED session")).toBeLessThan(stdout.indexOf("RELEASED sandbox"))
    // 130 = 128 + SIGINT: the signal is re-raised once teardown is done, so
    // the exit status still reads as an interrupt rather than a clean exit.
    expect((result as { code?: number }).code).toBe(130)
  }, 30_000)
})
