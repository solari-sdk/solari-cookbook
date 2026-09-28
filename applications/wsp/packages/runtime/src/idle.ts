// SPDX-License-Identifier: AGPL-3.0-only
// The runtime owns when a workspace naps. The provider's idle timer cannot be
// the policy: every GET /sandboxes/:id resets it, so any process that reads
// machine state keeps the machine awake and billing. The provider timer is set
// behind this one as a backstop, at twice the window, so it fires only when
// this process is gone.

import { realClock, type Clock } from "./clock.js";

export const DEFAULT_IDLE_WINDOW_MS = 20 * 60_000;

/** Backstop for a workspace whose auto-nap is off: long enough that the
 * provider never naps a person who chose "never", short enough that a crashed
 * runtime still stops the bill. Six hours is the longest timeoutMs the provider
 * has accepted from us (the golden builder's). */
export const IDLE_OFF_BACKSTOP_MS = 6 * 60 * 60_000;

export function backstopMs(windowMs: number | null): number {
  return windowMs === null ? IDLE_OFF_BACKSTOP_MS : windowMs * 2;
}

export interface IdlePolicyOptions {
  /** The window for a workspace right now; null means auto-nap is off for it. */
  windowOf(id: string): number | null;
  /** Fires when a window runs out. Resolved, the workspace is forgotten until its next touch; rejected, the deadline
   * stands and it fires again every retryMs until one resolves, a touch or a forget. */
  onIdle(id: string, windowMs: number): Promise<void>;
  /** How long after a nap that failed the window is asked again. */
  retryMs: number;
  /** Fires on every arming with the instant this policy's own backstop computes for the workspace, now plus
   * backstopMs of its window, so a window that is off still hands over the six-hour instant. Not fired on forget.
   * Synchronous from arm; whoever hands it on to a provider does so without awaiting. */
  onBackstop?(id: string, until: number): void;
  /** Defaults to the process timers; tests inject one they advance by hand. */
  clock?: Clock;
}

export interface IdlePolicy {
  /** Activity: the window starts over from now. */
  touch(id: string): void;
  /** A running session: the window may not fire while any hold stands; the last release starts it over. */
  hold(id: string): void;
  release(id: string): void;
  /** Napping or deleted: no window. */
  forget(id: string): void;
  /** Epoch ms when the window fires; undefined when off, held, or not counting. */
  idleAt(id: string): number | undefined;
  close(): void;
}

interface Armed {
  at: number;
  cancel: () => void;
}

export function createIdlePolicy(o: IdlePolicyOptions): IdlePolicy {
  const armed = new Map<string, Armed>();
  const holds = new Map<string, number>();
  const clock = o.clock ?? realClock;
  let closed = false;

  const forget = (id: string): void => {
    const a = armed.get(id);
    if (!a) return;
    a.cancel();
    armed.delete(id);
  };

  const arm = (id: string): void => {
    forget(id);
    if (closed) return;
    const windowMs = o.windowOf(id);
    o.onBackstop?.(id, clock.now() + backstopMs(windowMs));
    if (windowMs === null) return;
    const entry: Armed = { at: clock.now() + windowMs, cancel: () => {} };
    const fire = (): void => {
      if ((holds.get(id) ?? 0) > 0) {
        arm(id);
        return;
      }
      // Armed while the nap runs, so a status pushed by a nap that failed still carries the deadline and never reads active.
      entry.cancel = () => {};
      o.onIdle(id, windowMs).then(
        () => {
          if (armed.get(id) === entry) armed.delete(id);
        },
        (e: unknown) => {
          console.warn(`idle nap of ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
          if (armed.get(id) === entry) entry.cancel = clock.schedule(fire, o.retryMs, { unref: true });
        },
      );
    };
    entry.cancel = clock.schedule(fire, windowMs, { unref: true });
    armed.set(id, entry);
  };

  return {
    touch: arm,
    hold: id => holds.set(id, (holds.get(id) ?? 0) + 1),
    release: id => {
      const left = (holds.get(id) ?? 0) - 1;
      if (left > 0) {
        holds.set(id, left);
        return;
      }
      holds.delete(id);
      if (armed.has(id)) arm(id);
    },
    forget: id => {
      forget(id);
      holds.delete(id);
    },
    idleAt: id => ((holds.get(id) ?? 0) > 0 ? undefined : armed.get(id)?.at),
    close: () => {
      closed = true;
      for (const id of [...armed.keys()]) forget(id);
    },
  };
}
