// SPDX-License-Identifier: AGPL-3.0-only
// The hold-to-switch overlay's state: the targets frozen at the moment it
// opened, workspaces in sidebar order or the threads of the space on screen
// in the order they were last opened, and where the highlight sits among
// them. The order is frozen because a turn ending elsewhere re-sorts the
// sidebar, and a card must not move out from under the highlight while a
// person is stepping through them. Nothing is selected until the commit, so
// stepping past a workspace never mounts its threads. The hold is the one the
// chord that opened it was carrying, so a command bound to two chords ends on
// whichever was pressed.
import { create } from "zustand";

/** One card's landing: a workspace, and one of its threads where the walk is over threads. */
export interface SwitchTarget {
  readonly workspaceId: string;
  readonly threadId: string | null;
}

interface WorkspaceSwitcherState {
  /** What the overlay walks, in the order it froze; empty while it is closed. */
  targets: ReadonlyArray<SwitchTarget>;
  /** Where the highlight sits in ids. */
  at: number;
  open: boolean;
  /** The workspace that was selected when it opened, so a card can say which one that is. */
  from: string | null;
  /** The modifier keys the chord that opened it is holding down; letting one of them go commits the walk. */
  hold: ReadonlyArray<string>;
  openAt: (targets: ReadonlyArray<SwitchTarget>, at: number, from: string | null, hold: ReadonlyArray<string>) => void;
  step: (step: 1 | -1) => void;
  close: () => void;
}

export const useWorkspaceSwitcher = create<WorkspaceSwitcherState>(set => ({
  targets: [],
  at: 0,
  open: false,
  from: null,
  hold: [],
  openAt: (targets, at, from, hold) => set({ targets, at, open: true, from, hold }),
  step: step => set(s => (s.open ? { at: stepSwitcherAt(s.targets.length, s.at, step) } : s)),
  close: () => set({ targets: [], at: 0, open: false, from: null, hold: [] }),
}));

/**
 * How long the overlay waits before it paints. The state opens on the first step, so a tap's step and a second tab
 * straight after it both land; only the paint waits, so a tap that lets the hold go inside this window switches
 * without ever dimming the app. The system switchers this follows hold their paint back the same way.
 */
export const SWITCHER_PAINT_DELAY_MS = 150;

/** One step of the highlight around the frozen order. It always moves, unlike the tap's step, which has nowhere to
 * go with one workspace: once the overlay is up the key has to answer. */
export function stepSwitcherAt(length: number, at: number, step: 1 | -1): number {
  if (length === 0) return 0;
  return (at + step + length) % length;
}

/** The target the highlight sits on, or null while the overlay is closed. */
export function highlightedTarget(state: Pick<WorkspaceSwitcherState, "targets" | "at" | "open">): SwitchTarget | null {
  return state.open ? state.targets[state.at] ?? null : null;
}

/** The one key a card goes by: its thread where the walk is over threads, its workspace otherwise. */
export const targetKey = (target: SwitchTarget): string => target.threadId ?? target.workspaceId;

/** Whether letting this key go ends the walk: it is one of the modifiers the chord that opened the overlay was
 * holding. A closed overlay is let go by nothing. */
export function releasesSwitchHold(state: Pick<WorkspaceSwitcherState, "open" | "hold">, key: string): boolean {
  return state.open && state.hold.includes(key);
}
