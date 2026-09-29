export interface Interval {
  /** The raw proportion the interval is centred on. */
  point: number
  low: number
  high: number
  /** Sample size. Always reported next to the interval; see below. */
  n: number
}

/** Two-sided z for the confidence levels this application offers. */
const Z: Record<number, number> = {
  0.9: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Deliberately not the normal approximation. Samples here are tiny — eight
 * trials by default, two per variant — and they land on 0/n and n/n constantly.
 * At those boundaries the naive interval collapses to zero width, so a suite
 * would report "100% reliable, +/- 0" from two runs. Wilson stays honest there.
 *
 * This is the only inferential statistic in the program, and `n` travels with
 * it everywhere it is printed. Two passes out of two is not a reliability of
 * 100%; it is a reliability somewhere between 34% and 100%, and the reader is
 * entitled to see which.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  confidence: 0.9 | 0.95 | 0.99 = 0.95,
): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(total)) {
    throw new Error("wilsonInterval expects integer counts")
  }
  if (total < 0 || successes < 0 || successes > total) {
    throw new Error(`invalid counts: ${successes}/${total}`)
  }
  // No observations is not zero reliability, it is no information at all.
  if (total === 0) return { point: 0, low: 0, high: 1, n: 0 }

  const z = Z[confidence] as number
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))

  return {
    point: p,
    low: normalize((centre - margin) / denominator),
    high: normalize((centre + margin) / denominator),
    n: total,
  }
}

/**
 * Clamp into [0,1] and drop float noise. Without the rounding `wilsonInterval(0, 2)`
 * reports a lower bound of 5.5e-17, which is arithmetically harmless and renders
 * as a suspicious non-zero percentage.
 */
function normalize(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 1e6) / 1e6))
}

/**
 * How often the outcome flips between repetitions of an *identical* setup.
 * 0 means every repetition agreed; 1 means it alternated every time.
 *
 * This is the second number worth having. An agent that passes three and fails
 * three of the very same environment is not "50% good" — it is unpredictable,
 * which is a different and worse property than being consistently mediocre, and
 * a single pass rate cannot tell the two apart.
 *
 * Undefined for fewer than two repetitions, and `null` says so rather than
 * guessing a zero.
 */
export function flipRate(outcomes: readonly boolean[]): number | null {
  if (outcomes.length < 2) return null
  let flips = 0
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] !== outcomes[i - 1]) flips++
  }
  return flips / (outcomes.length - 1)
}
