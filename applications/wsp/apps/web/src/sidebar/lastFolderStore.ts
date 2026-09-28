// SPDX-License-Identifier: AGPL-3.0-only
// The folder the last import was read from, kept in local storage so the
// browser tab's folder browser opens near it instead of at the home folder
// every time. Local storage is per origin and a host serves the page from its
// own, so this is already one memory per host with no id to carry. The browser
// opens on the folder above: the next project is usually a sibling of the last.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { parentPath } from "../files/entries.js";

const STORAGE_KEY = "wsp:import-folder:v1";

interface LastFolderState {
  folder: string | null;
  remember: (folder: string) => void;
}

function normalizePersisted(persisted: unknown): { folder: string | null } {
  const raw = persisted && typeof persisted === "object" ? (persisted as { folder?: unknown }).folder : undefined;
  return { folder: typeof raw === "string" && raw.startsWith("/") ? raw : null };
}

export const useLastFolderStore = create<LastFolderState>()(
  persist(
    set => ({
      folder: null,
      remember: folder => set(s => (s.folder === folder || !folder.startsWith("/") ? s : { folder })),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ folder: s.folder }),
      migrate: normalizePersisted,
      // migrate runs only on a version change; a bad shape stored at this version must be caught on every hydrate.
      merge: (persisted, current) => ({ ...current, ...normalizePersisted(persisted) }),
    },
  ),
);

/** Where the browser opens: above the folder last imported, so the next project is one of its siblings. Nothing
 * before the first import, which the host reads as its first root. */
export function openAbove(folder: string | null): string | undefined {
  return (folder === null ? null : parentPath(folder)) ?? undefined;
}

export function useLastFolderParent(): string | undefined {
  return openAbove(useLastFolderStore(s => s.folder));
}
