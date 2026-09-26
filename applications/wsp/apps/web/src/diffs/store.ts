// SPDX-License-Identifier: AGPL-3.0-only
// What the diff surface remembers per workspace: the scope. The folder git
// runs in is the panes' shared root (files/root.ts), not a choice made here.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GitDiffScope } from "@wsp/protocol";

export type DiffRenderMode = "stacked" | "split";

export const DEFAULT_SCOPE: GitDiffScope = "unstaged";

interface DiffStoreState {
  scopeByWorkspaceId: Record<string, GitDiffScope>;
  renderMode: DiffRenderMode;
  setScope: (workspaceId: string, scope: GitDiffScope) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
}

export const useDiffStore = create<DiffStoreState>()(
  persist(
    set => ({
      scopeByWorkspaceId: {},
      renderMode: "stacked",
      setScope: (workspaceId, scope) => set(s => ({ scopeByWorkspaceId: { ...s.scopeByWorkspaceId, [workspaceId]: scope } })),
      setRenderMode: renderMode => set({ renderMode }),
    }),
    {
      name: "wsp:diff-surface:v2",
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ scopeByWorkspaceId: s.scopeByWorkspaceId, renderMode: s.renderMode }),
    },
  ),
);
