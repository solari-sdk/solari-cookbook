import { SolariClient, NoCapacityError, ConcurrencyLimitError } from "@solarisdk/sdk"
import { Solari, SolariError as BrowserSolariError } from "@solarisdk/browser"

let _sandboxClient: SolariClient | null = null
let _browserClient: Solari | null = null

export function getSandboxClient(): SolariClient {
  if (!_sandboxClient) {
    _sandboxClient = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
  }
  return _sandboxClient
}

// Solari bills sandboxes and browser sessions to the same balance and each
// browser session needs its own client so `solari.close()` only tears down
// its own loopback proxy — never share a Solari() instance across sessions.
export function newBrowserClient(): Solari {
  return new Solari({ apiKey: process.env.SOLARI_API_KEY! })
}

function looksLikeCapacityError(err: unknown): boolean {
  // Sandbox side throws typed errors.
  if (err instanceof NoCapacityError || err instanceof ConcurrencyLimitError) return true
  // Browser side throws a single SolariError with a code field.
  if (err instanceof BrowserSolariError && err.code === "ConcurrencyLimitExceeded") return true
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return ["capacity", "no capacity", "concurrency limit"].some((m) => msg.includes(m))
}

// Retries only capacity/availability errors with exponential backoff. Any
// other error (bad template, auth failure, etc.) is rethrown immediately —
// retrying those would just burn the wall-clock cap for no reason.
export async function withCapacityRetry<T>(
  fn: () => Promise<T>,
  onQueue: (attempt: number, delayMs: number) => void,
  maxAttempts = 5,
): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (attempt >= maxAttempts || !looksLikeCapacityError(err)) throw err
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15_000)
      onQueue(attempt, delayMs)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}
