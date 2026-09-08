import type { SuiteResult, ThresholdCheck } from "./aggregate.js"

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

/** The terminal report. Every proportion carries its sample size and its
 * interval; see `wilsonInterval` for why that is not decoration. */
export function renderReport(result: SuiteResult, checks: ThresholdCheck[]): string {
  const lines: string[] = []
  const pad = Math.max(12, ...result.byVariant.map((v) => v.variant.length))

  lines.push("")
  lines.push(`  ${"variant".padEnd(pad)}  pass   score  flips`)
  for (const v of result.byVariant) {
    const flips = v.flips === null ? "   -" : v.flips.toFixed(2)
    const undetermined = v.undetermined > 0 ? `  (${v.undetermined} undetermined)` : ""
    lines.push(
      `  ${v.variant.padEnd(pad)}  ${`${v.passed}/${v.scorable}`.padStart(4)}   ` +
        `${v.meanScore.toFixed(2)}   ${flips}${undetermined}`,
    )
  }

  const r = result.reliability
  lines.push("")
  lines.push(
    `  Reliability  ${pct(r.point).padStart(6)}  (${r.n === 0 ? "no scorable trials" : `${Math.round(r.point * r.n)}/${r.n}`})` +
      `${r.n > 0 ? `    95% CI ${pct(r.low)} - ${pct(r.high)}` : ""}`,
  )
  if (result.baseline) {
    lines.push(`  Baseline     ${pct(result.baseline.point).padStart(6)}  (n=${result.baseline.n})`)
  }
  if (result.perturbed) {
    lines.push(`  Perturbed    ${pct(result.perturbed.point).padStart(6)}  (n=${result.perturbed.n})`)
  }
  if (result.undetermined > 0) {
    lines.push(
      `  Undetermined ${String(result.undetermined).padStart(6)}  ` +
        `(our failure, not the agent's — excluded from the denominator)`,
    )
  }

  const failures = result.byVariant.flatMap((v) =>
    v.failures.map((f) => ({ variant: v.variant, failure: f })),
  )
  if (failures.length > 0) {
    lines.push("")
    lines.push("  Why the failures failed")
    const counted = new Map<string, { variant: string; summary: string; count: number }>()
    for (const { variant, failure } of failures) {
      const key = `${variant}:${failure.category}`
      const seen = counted.get(key)
      if (seen) seen.count++
      else counted.set(key, { variant, summary: failure.summary, count: 1 })
    }
    for (const entry of counted.values()) {
      lines.push(`    ${entry.variant.padEnd(pad)}  x${entry.count}  ${entry.summary}`)
    }
  }

  lines.push("")
  if (checks.length === 0) {
    // Not a pass and not a failure — nothing was gated. Saying so beats
    // printing a green PASS the author never asked for.
    lines.push("  No thresholds configured, so there is nothing to fail against.")
  } else {
    for (const check of checks) {
      lines.push(
        `  ${check.met ? "PASS" : "FAIL"}  ${check.name} required ${pct(check.required)}, got ${pct(check.actual)}`,
      )
    }
    lines.push("")
    lines.push(`  ${checks.every((c) => c.met) ? "PASS" : "FAIL"}`)
  }
  lines.push("")

  return lines.join("\n")
}
