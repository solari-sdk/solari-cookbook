// SPDX-License-Identifier: AGPL-3.0-only
// One draft per workspace and one queue of waiting messages per thread, kept
// outside the composer and in local storage so a glance at another tab or a
// reload does not lose what was typed. The prompt editor is controlled from
// here; a queue holds what was entered while its thread's turn ran, oldest
// first, until the composer sends its head at the turn's end. A queue read
// back from storage, or one whose thread has a send in flight that has not
// yet landed its start, is held: its rows stay put until the person's next
// Enter or send-now on this thread.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface ComposerDraft {
  readonly prompt: string;
  readonly cursor: number;
}

export interface QueuedMessage {
  readonly id: string;
  readonly prompt: string;
}

export const EMPTY_DRAFT: ComposerDraft = { prompt: "", cursor: 0 };
const NO_QUEUE: ReadonlyArray<QueuedMessage> = [];
const STORAGE_KEY = "wsp:composer-drafts:v1";

interface DraftState {
  drafts: Record<string, ComposerDraft>;
  /** Keyed by the composer's thread key: the thread's runtime id, or the workspace id before it has one. */
  queues: Record<string, ReadonlyArray<QueuedMessage>>;
  /** Queues whose rows must not go by themselves; not persisted, so every reload holds what it restores. */
  held: Record<string, true>;
  setDraft(workspaceId: string, draft: ComposerDraft): void;
  /** Behind the rows already waiting, or ahead of them when the person's new row must go before held ones. */
  enqueue(threadKey: string, prompt: string, at?: "head" | "tail"): void;
  editQueued(threadKey: string, id: string, prompt: string): void;
  removeQueued(threadKey: string, id: string): void;
  /** Moves one row to the head, so it is the next to send. */
  promoteQueued(threadKey: string, id: string): void;
  hold(threadKey: string): void;
  /** Puts a row the runtime refused back at the head and holds the queue. */
  requeue(threadKey: string, row: QueuedMessage): void;
  /** The person acted on this thread: its rows may go again. */
  release(threadKey: string): void;
  /** Moves every row from one key behind the rows at another, and drops the hold on the key left: a thread's first start gives it the id its rows were waiting under. */
  rekeyQueue(from: string, to: string): void;
}

export const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
}

function normalizePersisted(persisted: unknown): Pick<DraftState, "drafts" | "queues" | "held"> {
  const raw = persisted && typeof persisted === "object" ? (persisted as { drafts?: unknown; queues?: unknown }) : {};
  const drafts: Record<string, ComposerDraft> = {};
  if (raw.drafts && typeof raw.drafts === "object") {
    for (const [workspaceId, draft] of Object.entries(raw.drafts as Record<string, unknown>)) {
      const d = draft as { prompt?: unknown; cursor?: unknown } | null;
      if (d && typeof d.prompt === "string" && d.prompt !== "") drafts[workspaceId] = { prompt: d.prompt, cursor: typeof d.cursor === "number" ? d.cursor : d.prompt.length };
    }
  }
  const queues: Record<string, ReadonlyArray<QueuedMessage>> = {};
  if (raw.queues && typeof raw.queues === "object") {
    for (const [workspaceId, rows] of Object.entries(raw.queues as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      const clean = rows.filter((row): row is QueuedMessage => {
        const r = row as { id?: unknown; prompt?: unknown } | null;
        return r !== null && typeof r === "object" && typeof r.id === "string" && typeof r.prompt === "string";
      });
      if (clean.length > 0) queues[workspaceId] = clean;
    }
  }
  const held: Record<string, true> = {};
  for (const key of Object.keys(queues)) held[key] = true;
  return { drafts, queues, held };
}

export const useComposerDraftStore = create<DraftState>()(
  persist(
    set => {
      const patchQueue = (threadKey: string, fn: (rows: ReadonlyArray<QueuedMessage>) => ReadonlyArray<QueuedMessage>) =>
        set(s => {
          const rows = s.queues[threadKey] ?? NO_QUEUE;
          const next = fn(rows);
          if (next === rows) return s;
          if (next.length === 0) return { queues: without(s.queues, threadKey), held: without(s.held, threadKey) };
          return { queues: { ...s.queues, [threadKey]: next } };
        });
      return {
        drafts: {},
        queues: {},
        held: {},
        setDraft(workspaceId, draft) {
          set(s => {
            const current = s.drafts[workspaceId];
            if (current !== undefined && current.prompt === draft.prompt && current.cursor === draft.cursor) return s;
            return { drafts: { ...s.drafts, [workspaceId]: draft } };
          });
        },
        enqueue(threadKey, prompt, at = "tail") {
          patchQueue(threadKey, rows => (at === "head" ? [{ id: newId(), prompt }, ...rows] : [...rows, { id: newId(), prompt }]));
        },
        editQueued(threadKey, id, prompt) {
          patchQueue(threadKey, rows => {
            const index = rows.findIndex(r => r.id === id);
            if (index === -1 || rows[index]?.prompt === prompt) return rows;
            return rows.map(r => (r.id === id ? { id, prompt } : r));
          });
        },
        removeQueued(threadKey, id) {
          patchQueue(threadKey, rows => (rows.some(r => r.id === id) ? rows.filter(r => r.id !== id) : rows));
        },
        promoteQueued(threadKey, id) {
          patchQueue(threadKey, rows => {
            const row = rows.find(r => r.id === id);
            if (row === undefined || rows[0] === row) return rows;
            return [row, ...rows.filter(r => r !== row)];
          });
        },
        hold(threadKey) {
          set(s => (threadKey in s.held ? s : { held: { ...s.held, [threadKey]: true } }));
        },
        requeue(threadKey, row) {
          set(s => ({ queues: { ...s.queues, [threadKey]: [row, ...(s.queues[threadKey] ?? NO_QUEUE)] }, held: { ...s.held, [threadKey]: true } }));
        },
        release(threadKey) {
          set(s => (threadKey in s.held ? { held: without(s.held, threadKey) } : s));
        },
        rekeyQueue(from, to) {
          set(s => {
            if (from === to) return s;
            const moving = s.queues[from];
            const held = without(s.held, from);
            if (moving === undefined) return held === s.held ? s : { held };
            return { queues: { ...without(s.queues, from), [to]: [...(s.queues[to] ?? NO_QUEUE), ...moving] }, held };
          });
        },
      };
    },
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ drafts: s.drafts, queues: s.queues }),
      migrate: normalizePersisted,
      // migrate runs only on a version change; a bad shape stored at this version must be caught on every hydrate.
      merge: (persisted, current) => ({ ...current, ...normalizePersisted(persisted) }),
    },
  ),
);

export function useComposerDraft(workspaceId: string): ComposerDraft {
  return useComposerDraftStore(s => s.drafts[workspaceId] ?? EMPTY_DRAFT);
}

export function useComposerQueue(threadKey: string): ReadonlyArray<QueuedMessage> {
  return useComposerDraftStore(s => s.queues[threadKey] ?? NO_QUEUE);
}

export function useComposerQueueHeld(threadKey: string): boolean {
  return useComposerDraftStore(s => s.held[threadKey] === true);
}
