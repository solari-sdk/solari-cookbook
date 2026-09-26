// SPDX-License-Identifier: AGPL-3.0-only
// Which threads were opened last, most recent first, so the switch chord in
// Spaces walks the threads a person was just in rather than the sidebar's
// order. Recorded off the store's own selection, whatever raised it, and
// held here alone: the sidebar keeps drawing its order and never re-sorts
// under a hand.
import { create } from "zustand";
import { useStore } from "../protocol/store.js";
import type { WalkableThread } from "./shellCommands.js";

export interface ThreadVisit {
  readonly workspaceId: string;
  readonly threadId: string;
}

/** How many visits are kept; more than the switcher ever shows, so a thread that left the top five comes back. */
export const THREAD_HISTORY_CAP = 20;
/** How many threads the switcher walks: the last five opened. */
export const SWITCHER_THREADS = 5;

interface ThreadHistoryState {
  recent: ReadonlyArray<ThreadVisit>;
  touch: (visit: ThreadVisit) => void;
}

export const useThreadHistory = create<ThreadHistoryState>(set => ({
  recent: [],
  touch: visit => set(s => ({ recent: [visit, ...s.recent.filter(v => v.workspaceId !== visit.workspaceId || v.threadId !== visit.threadId)].slice(0, THREAD_HISTORY_CAP) })),
}));

/** Records every thread the store selects; the shell mounts it once. */
export function trackThreadHistory(): () => void {
  return useStore.subscribe((s, prev) => {
    if (s.selectedId === null || s.selectedThreadId === null) return;
    if (s.selectedThreadId === prev.selectedThreadId && s.selectedId === prev.selectedId) return;
    useThreadHistory.getState().touch({ workspaceId: s.selectedId, threadId: s.selectedThreadId });
  });
}

/** The threads the switcher walks, out of the ones the space on screen can land on: the open one first, then the
 * rest in the order they were last opened, then the ones never opened in the sidebar's order, cut at five. */
export function recentThreads(walk: ReadonlyArray<WalkableThread>, recent: ReadonlyArray<ThreadVisit>, selectedThreadId: string | null): WalkableThread[] {
  const ids = walk.map(thread => thread.threadId);
  const order = [...new Set([...(selectedThreadId !== null && ids.includes(selectedThreadId) ? [selectedThreadId] : []), ...recent.map(visit => visit.threadId).filter(id => ids.includes(id)), ...ids])];
  return order.slice(0, SWITCHER_THREADS).map(id => walk.find(thread => thread.threadId === id)!);
}
