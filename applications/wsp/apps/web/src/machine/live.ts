// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace utilisation that outlives any mounted pane. Where the samples
// come from is the kind table's to say: a machine reads its own and pushes
// them over the workspace's daemon link (terminal/wiring.ts asks with
// sys.watch on every live transition), and the computer this host runs on is
// read by the host itself and pushed on the page's own socket (hostLive.ts).
// The reach says whether the newest sample is current or the last one before
// whichever road carries them went down.
// A daemon that refuses sys.watch leaves its reason here, so the rows can say
// the stream is unavailable instead of waiting for it.
import { useCallback, useRef, useSyncExternalStore } from "react";
import { memoryNearFull, workspaceState, type AwayWord, type DaemonLinkStatus, type MemoryReading, type SysSample, type WorkspacePhase } from "@wsp/protocol";

/** Two minutes at the daemon's two-second interval. */
export const LIVE_WINDOW = 60;

/** What a reading slot holds in place of a value, when it holds a word instead: the state word the rest of the
 * app shows for the workspace, lowercased for a slot, or the word the one reading of a computer that is not
 * answering puts in a slot beside facts. Read through the protocol's own folds, so a pane that says Paused at the
 * top cannot say napping in the rows under it, and the pane of a computer whose daemon is not running cannot say
 * unreachable in the slot over a sentence that says which part is down. Null while the reading is live and the
 * slot is a value's. One rule, because the Live section and the Processes table both ask it. */
export type StaleWord = "paused" | "unreachable" | AwayWord | null;

export function staleWord(phase: WorkspacePhase, live: boolean): StaleWord {
  const state = workspaceState({ phase });
  if (state === "paused" || state === "pausing") return "paused";
  return live ? null : "unreachable";
}

export interface LiveState {
  samples: SysSample[];
  reach: "live" | "unreachable";
  /** The daemon's refusal of sys.watch, null while it streams or has not been asked. */
  unavailable: string | null;
}

export class WorkspaceLive {
  #state: LiveState = { samples: [], reach: "unreachable", unavailable: null };
  #fns = new Set<() => void>();

  feedSample(s: SysSample): void {
    const samples = [...this.#state.samples, s];
    if (samples.length > LIVE_WINDOW) samples.splice(0, samples.length - LIVE_WINDOW);
    this.#set({ ...this.#state, samples });
  }

  feedStatus(s: DaemonLinkStatus): void {
    this.feedReach(s === "live" ? "live" : "unreachable");
  }

  /** Whether the readings are arriving, for the workspace whose figures take no daemon link: the one this host runs
   * on, whose samples ride the host's own socket. */
  feedReach(reach: LiveState["reach"]): void {
    if (reach !== this.#state.reach) this.#set({ ...this.#state, reach });
  }

  feedUnavailable(reason: string | null): void {
    if (reason !== this.#state.unavailable) this.#set({ ...this.#state, unavailable: reason });
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** The same object until a sample or the reach changes. */
  snapshot(): LiveState {
    return this.#state;
  }

  #set(next: LiveState): void {
    this.#state = next;
    for (const fn of this.#fns) fn();
  }
}

const registry = new Map<string, WorkspaceLive>();

export function getLive(workspaceId: string): WorkspaceLive {
  let live = registry.get(workspaceId);
  if (!live) {
    live = new WorkspaceLive();
    registry.set(workspaceId, live);
  }
  return live;
}

/** Test isolation: forget every workspace's samples. */
export function resetLive(): void {
  registry.clear();
}

export function useWorkspaceLive(workspaceId: string): LiveState {
  return useSyncExternalStore(
    fn => getLive(workspaceId).onChange(fn),
    () => getLive(workspaceId).snapshot(),
  );
}

/** The last reading before the link went, when memory was near full: what the panes and the row say the drop was
 * about instead of a bare not answering. Null while the link is live (the machine answers, whatever the figures),
 * with no sample yet, with room left, or on a workspace that is not running (a nap closes the link too, and the
 * figures from before it say nothing about now). */
export function outOfMemoryReading(state: LiveState, phase: WorkspacePhase): MemoryReading | null {
  const last = state.samples[state.samples.length - 1];
  if (phase !== "running" || state.reach === "live" || last === undefined || !memoryNearFull(last.mem)) return null;
  return { used: last.mem.used, total: last.mem.total, load1: last.load1 };
}

const sameReading = (a: MemoryReading | null, b: MemoryReading | null): boolean =>
  a === b || (a !== null && b !== null && a.used === b.used && a.total === b.total && a.load1 === b.load1);

/** The reading for one workspace, the same object while its figures hold: a two-second sample that changes nothing
 * a pane says is not a render of that pane. */
export function useOutOfMemoryReading(workspaceId: string, phase: WorkspacePhase): MemoryReading | null {
  const last = useRef<MemoryReading | null>(null);
  const subscribe = useCallback((fn: () => void) => getLive(workspaceId).onChange(fn), [workspaceId]);
  const snapshot = useCallback(() => {
    const next = outOfMemoryReading(getLive(workspaceId).snapshot(), phase);
    if (!sameReading(last.current, next)) last.current = next;
    return last.current;
  }, [workspaceId, phase]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** The same over many workspaces, for the sidebar's rows: one subscription, and the same object while every row's
 * figures hold. */
export function useOutOfMemoryReadings(workspaces: ReadonlyArray<{ id: string; phase: WorkspacePhase }>): Readonly<Record<string, MemoryReading>> {
  const last = useRef<Readonly<Record<string, MemoryReading>>>({});
  const subscribe = useCallback(
    (fn: () => void) => {
      const offs = workspaces.map(w => getLive(w.id).onChange(fn));
      return () => offs.forEach(off => off());
    },
    [workspaces],
  );
  const snapshot = useCallback(() => {
    const next: Record<string, MemoryReading> = {};
    for (const w of workspaces) {
      const r = outOfMemoryReading(getLive(w.id).snapshot(), w.phase);
      if (r !== null) next[w.id] = r;
    }
    const prev = last.current;
    const ids = Object.keys(next);
    if (ids.length === Object.keys(prev).length && ids.every(id => sameReading(prev[id] ?? null, next[id]!))) return prev;
    last.current = next;
    return next;
  }, [workspaces]);
  return useSyncExternalStore(subscribe, snapshot);
}
