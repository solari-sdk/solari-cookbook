import { createHash } from "node:crypto"

/**
 * Perturbations have to be reproducible, or a reliability number means nothing.
 *
 * If the cookie banner appears at a different moment on every run, a suite that
 * scores 60% today and 80% tomorrow has told you about the weather, not about
 * the agent. So every stochastic decision in this application derives from a
 * seed that is a pure function of (run, variant, repetition) — never from
 * `Math.random`, and never from the clock.
 */
export function deriveSeed(runId: string, variant: string, repetition: number): number {
  const digest = createHash("sha256").update(`${runId}|${variant}|${repetition}`).digest()
  // 31 bits rather than 32 so the value stays a positive signed integer wherever
  // it is printed, stored or round-tripped through JSON.
  return digest.readUInt32BE(0) >>> 1
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  bool(probability?: number): boolean
  /** Deterministic jitter around `base`, within +/- `ratio`. */
  jitter(base: number, ratio?: number): number
}

/** mulberry32 — small, well-distributed, and identical across runs and platforms. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    bool: (probability = 0.5) => next() < probability,
    jitter: (base, ratio = 0.2) => Math.round(base * (1 - ratio + next() * ratio * 2)),
  }
}
