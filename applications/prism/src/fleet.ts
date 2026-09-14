/**
 * Run N probes concurrently without tripping the account's session cap.
 *
 * Measured on Starter 2026-09-08: the documented cap is 20, the API accepts 18
 * and refuses the 19th with
 *   429 {"code":"ConcurrencyLimitExceeded","cap":20}
 * (filed upstream). A released slot is reusable in ~300ms.
 *
 * So the pool starts below the documented number and shrinks on a 429 rather
 * than assuming the published figure is right. Retrying a capacity error
 * immediately is pointless; it needs a slot, not another attempt.
 *
 * Two properties have to hold, and both were broken by an earlier hand-rolled
 * scheduler that counted "admitted" and "running" with one variable:
 *
 *   1. Never more than `limit` probes running at once -- INCLUDING a retry.
 *      A retry that re-enters without re-acquiring pushes straight back over
 *      the cap that just rejected it.
 *   2. Never resolve while a probe is still in flight. Resolving early drops
 *      the retry's result and lets it open a cloud session after the caller
 *      has closed the backend -- leaking the billable slot this pool exists
 *      to protect.
 *
 * A semaphore plus Promise.all gives both by construction: a probe runs only
 * while holding a permit, and every task is awaited to completion.
 */
export type Task<T> = () => Promise<T>
export type FleetResult<T> = { value?: T; error?: unknown; attempts: number }

export type FleetOpts = {
  /** Start here. Default 8: comfortably under the measured 18. */
  concurrency?: number
  maxRetries?: number
  backoffMs?: number
  isBackpressure?: (err: unknown) => boolean
  onEvent?: (e: { type: "backpressure"; concurrency: number }) => void
}

export async function runFleet<T>(tasks: Task<T>[], opts: FleetOpts = {}): Promise<FleetResult<T>[]> {
  let limit = Math.max(1, opts.concurrency ?? 8)
  const maxRetries = opts.maxRetries ?? 3
  const backoffMs = opts.backoffMs ?? 750
  const isBackpressure = opts.isBackpressure ?? (() => false)
  const results: FleetResult<T>[] = tasks.map(() => ({ attempts: 0 }))

  let running = 0
  let waiters: (() => void)[] = []

  const acquire = async () => {
    // Re-check after every wake: `limit` can shrink while we wait, so a permit
    // that was free when we were woken may not be free by the time we run.
    while (running >= limit) await new Promise<void>((r) => waiters.push(r))
    running++
  }
  const release = () => {
    running--
    // Wake everyone and let them re-test. Waking exactly one is wrong here:
    // that one may re-queue (the limit shrank), and then nobody is left to
    // wake the rest. The queue is at most one entry per task, so this is cheap.
    const woken = waiters
    waiters = []
    for (const w of woken) w()
  }

  await Promise.all(
    tasks.map(async (task, i) => {
      const slot = results[i]!
      for (;;) {
        await acquire()
        slot.attempts++
        try {
          slot.value = await task()
          release()
          return
        } catch (err) {
          release()
          if (isBackpressure(err) && slot.attempts <= maxRetries) {
            limit = Math.max(1, limit - 1)
            opts.onEvent?.({ type: "backpressure", concurrency: limit })
            await new Promise((r) => setTimeout(r, backoffMs * slot.attempts))
            continue
          }
          slot.error = err
          return
        }
      }
    }),
  )

  return results
}
