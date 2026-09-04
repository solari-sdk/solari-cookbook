/**
 * Placeholder billing rates. Solari's cookbook doesn't publish per-minute
 * pricing, so these are estimates, not real invoiced numbers — swap them
 * for your actual rate from console.getsolari.com before trusting the
 * admin page's totals.
 */
export const ASSUMED_SANDBOX_CENTS_PER_MIN = 2 // repo mode
export const ASSUMED_BROWSER_CENTS_PER_MIN = 3 // site mode

export function estimateCostCents(mode: "repo" | "site", elapsedMs: number): number {
  const minutes = elapsedMs / 60_000
  const rate = mode === "repo" ? ASSUMED_SANDBOX_CENTS_PER_MIN : ASSUMED_BROWSER_CENTS_PER_MIN
  return Math.round(minutes * rate)
}
