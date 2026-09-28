// SPDX-License-Identifier: AGPL-3.0-only

/** The timers the idle window, the transcript debounce, the status tickers, the permission prompt's wait and the pause and wake budgets run on; tests inject one they can advance by hand. */
export interface Clock {
  /** Epoch ms. */
  now(): number;
  /** Runs fn once after ms; the returned function cancels it. The timer holds the process open unless unref is set. */
  schedule(fn: () => void, ms: number, o?: ScheduleOptions): () => void;
}

export interface ScheduleOptions {
  /** The timer does not keep the process alive; one still pending at exit is dropped. */
  unref?: boolean;
}

export const realClock: Clock = {
  now: () => Date.now(),
  schedule: (fn, ms, o) => {
    const timer = setTimeout(fn, ms);
    if (o?.unref) timer.unref?.();
    return () => clearTimeout(timer);
  },
};
