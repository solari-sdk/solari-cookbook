/**
 * Exception-safe teardown for remote resources.
 *
 * Every resource in this program costs money for as long as it is alive: a
 * sandbox bills until it is killed, a browser session bills until it is
 * released. A `finally` releases one resource in one scope. It does not cover
 * four resources acquired at different depths, a disposer that itself throws, a
 * disposer that hangs, or a Ctrl-C that ends the process without unwinding at
 * all. That is what this stack is for.
 *
 * Guarantees, all pinned by test/lifecycle.test.ts with fake resources:
 *
 *   - teardown runs in LIFO order, so a resource is never released before
 *     something that depends on it;
 *   - `dispose()` is idempotent *and joinable* — a second caller awaits the
 *     first run rather than returning early, which matters because both the
 *     `finally` and the signal handler call it;
 *   - a release that hangs is abandoned after a timeout so it cannot hold the
 *     rest of the stack hostage;
 *   - a throwing disposer never prevents the remaining disposers from running;
 *   - a resource that arrives *during* teardown is still released rather than
 *     orphaned;
 *   - every failure is collected and surfaced as an AggregateError rather than
 *     the first one winning and hiding the others.
 *
 * For a single resource in a single scope, `await using browser = await
 * solari.launch()` does the same job in one line (Node 22+; BrowserSession
 * implements Symbol.asyncDispose). This stack exists because a run holds
 * several resources across several scopes, and because the ordering and
 * error-aggregation rules above are then testable without touching the network.
 */
interface Disposable {
  readonly label: string
  dispose(): Promise<void>
}

export class ResourceStack {
  private readonly entries: Disposable[] = []
  private inFlight: Promise<void> | null = null
  private detachFromParent: () => void = () => {}

  constructor(private readonly teardownTimeoutMs = 20_000) {}

  /**
   * Register a resource and get it straight back, so acquisition and
   * registration are a single expression and cannot drift apart:
   *
   *     const browser = stack.add("browser session", await solari.launch(), b => b.close())
   */
  add<T>(label: string, resource: T, dispose: (resource: T) => Promise<void>): T {
    this.entries.push({ label, dispose: () => dispose(resource) })
    this.drainIfDisposing()
    return resource
  }

  /**
   * A nested stack that unwinds as part of this one.
   *
   * This is what makes a trial's browser session reachable from the signal
   * handler. A trial that owned a free-standing `new ResourceStack()` would be
   * released by its own `finally` on the normal path and by nothing at all on
   * the Ctrl-C path, because the handler only ever sees the stack it was given.
   * Registering the child on the parent means one teardown releases both, still
   * in LIFO order: every live trial first, then the client and the sandbox.
   */
  child(label: string): ResourceStack {
    const child = new ResourceStack(this.teardownTimeoutMs)
    const entry: Disposable = { label, dispose: () => child.dispose() }
    this.entries.push(entry)
    this.drainIfDisposing()

    child.detachFromParent = () => {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    }
    return child
  }

  /**
   * Drop an emptied child from its parent.
   *
   * Called once a trial has released its own resources, so a long grid does not
   * accumulate one spent entry per trial.
   */
  detach(): void {
    this.detachFromParent()
    this.detachFromParent = () => {}
  }

  /**
   * Release everything, most recent first. Safe to call more than once and safe
   * to call from a signal handler.
   *
   * A second caller *joins* the first run rather than returning immediately.
   * That distinction matters: the `finally` and the SIGINT handler can both
   * fire, and a second caller that returned early would let the process exit
   * while a release was still in flight — the same leak wearing a new hat.
   */
  dispose(): Promise<void> {
    return (this.inFlight ??= this.run())
  }

  /**
   * A resource can arrive after teardown has started: `sandboxes.create()` is
   * awaited *before* `add` is called, so a signal can land while a VM is being
   * born. Refusing it would leave something already billing with nobody holding
   * a reference. `run()` drains until the stack is empty, so an entry pushed
   * mid-drain is picked up by the run already going; if that run has already
   * finished, chain a fresh one.
   */
  private drainIfDisposing(): void {
    if (!this.inFlight) return
    this.inFlight = this.inFlight.catch(() => {}).then(() => this.run())
  }

  private async run(): Promise<void> {
    const failures: Error[] = []
    while (this.entries.length > 0) {
      const entry = this.entries.pop() as Disposable
      try {
        // A release that hangs must not hold the rest of the stack hostage.
        // Without this bound, one wedged call turns "we leaked one session"
        // into "we leaked the sandbox and every session under it".
        await withTimeout(entry.dispose(), this.teardownTimeoutMs, entry.label)
      } catch (error) {
        failures.push(
          new Error(`failed to release ${entry.label}`, {
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
        )
      }
    }

    if (failures.length === 1) throw failures[0] as Error
    if (failures.length > 1) {
      throw new AggregateError(failures, `${failures.length} resources failed to release`)
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`releasing ${label} timed out after ${ms}ms`)), ms)
    // Do not hold the event loop open just to police a teardown.
    timer.unref?.()
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * Run `body` with a stack that is always torn down.
 *
 * The stack is disposed before the body's own error propagates, and a teardown
 * failure never masks the original failure — losing the real cause to a
 * secondary cleanup error makes the run much harder to debug than the leak.
 */
export async function withResources<T>(body: (stack: ResourceStack) => Promise<T>): Promise<T> {
  const stack = new ResourceStack()
  const detach = onTermination(() => stack.dispose())
  try {
    return await body(stack)
  } finally {
    detach()
    await stack.dispose().catch((error: unknown) => {
      console.error(`\ncleanup failed: ${describe(error)}`)
      console.error("check https://console.getsolari.com for sessions still running.")
    })
  }
}

/**
 * Release remote resources when the terminal kills us.
 *
 * Ctrl-C during a run is the second way to leak a paid session, and it is the
 * one a `finally` alone does not cover: the default SIGINT action terminates
 * the process without unwinding. We dispose, then re-raise with the default
 * handler so the exit status still reads as a signal rather than a clean exit.
 *
 * The handler stays installed across that window on purpose. With `once`, a
 * second Ctrl-C during a teardown that can take up to the stack's timeout per
 * resource would hit the default action and kill the process mid-release —
 * causing the exact leak we are in the middle of preventing.
 */
function onTermination(dispose: () => Promise<void>): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const
  let releasing = false

  const handlers = signals.map((signal) => {
    const handler = () => {
      if (releasing) {
        console.error("still releasing — resources will leak if you kill this now.")
        return
      }
      releasing = true
      console.error(`\n${signal} — releasing remote resources before exiting.`)
      void dispose()
        .catch((error: unknown) => console.error(`cleanup failed: ${describe(error)}`))
        .finally(() => {
          for (const [registered, fn] of handlers) process.removeListener(registered, fn)
          process.kill(process.pid, signal)
        })
    }
    process.on(signal, handler)
    return [signal, handler] as const
  })

  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}

export function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((inner: unknown) => describe(inner)).join("; ")
  }
  if (error instanceof Error) {
    return error.cause ? `${error.message}: ${describe(error.cause)}` : error.message
  }
  return String(error)
}
