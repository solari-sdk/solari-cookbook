// SPDX-License-Identifier: AGPL-3.0-only
// The models starred in the composer's model picker, kept in local storage
// across every workspace: a favourite is a harness and a model slug, and the
// picker lists favourites first.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const STORAGE_KEY = "wsp:composer-favourites:v1";

export const favouriteKey = (harness: string, model: string): string => `${harness}:${model}`;

interface FavouritesState {
  keys: readonly string[];
  toggle: (harness: string, model: string) => void;
}

function normalizePersisted(persisted: unknown): { keys: string[] } {
  const raw = persisted && typeof persisted === "object" ? (persisted as { keys?: unknown }).keys : undefined;
  return { keys: Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string" && k.includes(":")) : [] };
}

export const useComposerFavouritesStore = create<FavouritesState>()(
  persist(
    set => ({
      keys: [],
      toggle: (harness, model) =>
        set(s => {
          const key = favouriteKey(harness, model);
          return { keys: s.keys.includes(key) ? s.keys.filter(k => k !== key) : [...s.keys, key] };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ keys: s.keys }),
      migrate: normalizePersisted,
      // migrate runs only on a version change; a bad shape stored at this version must be caught on every hydrate.
      merge: (persisted, current) => ({ ...current, ...normalizePersisted(persisted) }),
    },
  ),
);
