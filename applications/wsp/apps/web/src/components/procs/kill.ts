// SPDX-License-Identifier: AGPL-3.0-only
// Killing a process from the table is two presses with no dialog: the first
// arms, the second within two seconds sends TERM. KILL is only offered once
// TERM has done nothing for five seconds, and takes the same two presses.
import type { ProcSignal } from "@wsp/protocol";

export const ARM_MS = 2000;
export const ESCALATE_MS = 5000;

export type KillState =
  | { step: "idle" }
  | { step: "armed"; signal: ProcSignal; at: number }
  | { step: "sent"; signal: ProcSignal; at: number };

export const IDLE: KillState = { step: "idle" };

/** What the row's button says now: the signal it would send, and whether the next press is the confirming one. null hides it. */
export function offered(state: KillState, now: number): { signal: ProcSignal; confirm: boolean } | null {
  switch (state.step) {
    case "idle":
      return { signal: "TERM", confirm: false };
    case "armed":
      return { signal: state.signal, confirm: now - state.at < ARM_MS };
    case "sent":
      return now - state.at >= ESCALATE_MS ? { signal: "KILL", confirm: false } : null;
  }
}

export function press(state: KillState, now: number): { state: KillState; send: ProcSignal | undefined } {
  const offer = offered(state, now);
  if (offer === null) return { state, send: undefined };
  if (offer.confirm) return { state: { step: "sent", signal: offer.signal, at: now }, send: offer.signal };
  return { state: { step: "armed", signal: offer.signal, at: now }, send: undefined };
}

/** Time passing: an unconfirmed arm lapses; everything else keeps its state, the offer reads the clock. */
export function settle(state: KillState, now: number): KillState {
  if (state.step === "armed" && now - state.at >= ARM_MS) return IDLE;
  return state;
}
