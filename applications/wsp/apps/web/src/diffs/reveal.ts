// SPDX-License-Identifier: AGPL-3.0-only
// A file another pane asked the Diff surface to show: kept until that surface
// has a diff to look in, then taken. Paths are absolute, as the daemon names
// them; the surface makes them relative to the folder its git runs in.
import { create } from "zustand";

interface DiffRevealState {
  pendingByWorkspaceId: Record<string, string>;
  request: (workspaceId: string, path: string) => void;
  take: (workspaceId: string) => void;
}

export const useDiffRevealStore = create<DiffRevealState>(set => ({
  pendingByWorkspaceId: {},
  request: (workspaceId, path) => set(s => ({ pendingByWorkspaceId: { ...s.pendingByWorkspaceId, [workspaceId]: path } })),
  take: workspaceId => set(s => ({ pendingByWorkspaceId: Object.fromEntries(Object.entries(s.pendingByWorkspaceId).filter(([id]) => id !== workspaceId)) })),
}));
