// SPDX-License-Identifier: AGPL-3.0-only
// The drawer's arrangement per workspace: open or closed, height, and how the
// link's ptys are grouped into tabs and splits. The ptys themselves live in
// WorkspaceTerminals; reconcile keeps this in step with that list.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  closeTerminal,
  DEFAULT_TERMINAL_UI_STATE,
  isDefaultTerminalUiState,
  newTerminal,
  normalizeTerminalUiState,
  reconcileTerminalIds,
  setActiveTerminal,
  setTerminalHeight,
  setTerminalOpen,
  splitTerminal,
  type TerminalUiState,
} from "./groups.js";

const STORAGE_KEY = "wsp:terminal-drawer:v1";

interface TerminalDrawerStoreState {
  byWorkspaceId: Record<string, TerminalUiState>;
  setOpen: (workspaceId: string, open: boolean) => void;
  toggle: (workspaceId: string) => void;
  setHeight: (workspaceId: string, height: number) => void;
  add: (workspaceId: string, terminalId: string) => void;
  split: (workspaceId: string, terminalId: string, direction?: "horizontal" | "vertical") => void;
  activate: (workspaceId: string, terminalId: string) => void;
  remove: (workspaceId: string, terminalId: string) => void;
  reconcile: (workspaceId: string, terminalIds: string[]) => void;
  removeWorkspace: (workspaceId: string) => void;
}

export function selectTerminalUiState(
  byWorkspaceId: Record<string, TerminalUiState>,
  workspaceId: string | null | undefined,
): TerminalUiState {
  if (!workspaceId) return DEFAULT_TERMINAL_UI_STATE;
  return byWorkspaceId[workspaceId] ?? DEFAULT_TERMINAL_UI_STATE;
}

const update = (
  byWorkspaceId: Record<string, TerminalUiState>,
  workspaceId: string,
  fn: (current: TerminalUiState) => TerminalUiState,
): Record<string, TerminalUiState> => {
  const current = byWorkspaceId[workspaceId] ?? DEFAULT_TERMINAL_UI_STATE;
  const next = fn(current);
  if (isDefaultTerminalUiState(next)) {
    if (!(workspaceId in byWorkspaceId)) return byWorkspaceId;
    const { [workspaceId]: _removed, ...rest } = byWorkspaceId;
    return rest;
  }
  if (next === current) return byWorkspaceId;
  return { ...byWorkspaceId, [workspaceId]: next };
};

function normalizePersisted(persisted: unknown): { byWorkspaceId: Record<string, TerminalUiState> } {
  if (!persisted || typeof persisted !== "object") return { byWorkspaceId: {} };
  const raw = (persisted as { byWorkspaceId?: unknown }).byWorkspaceId;
  if (!raw || typeof raw !== "object") return { byWorkspaceId: {} };
  const byWorkspaceId: Record<string, TerminalUiState> = {};
  for (const [workspaceId, state] of Object.entries(raw as Record<string, Partial<TerminalUiState> | null>)) {
    byWorkspaceId[workspaceId] = normalizeTerminalUiState({
      terminalOpen: state?.terminalOpen === true,
      terminalHeight: typeof state?.terminalHeight === "number" ? state.terminalHeight : DEFAULT_TERMINAL_UI_STATE.terminalHeight,
      terminalIds: Array.isArray(state?.terminalIds) ? state.terminalIds.filter((id): id is string => typeof id === "string") : [],
      activeTerminalId: typeof state?.activeTerminalId === "string" ? state.activeTerminalId : "",
      terminalGroups: Array.isArray(state?.terminalGroups) ? state.terminalGroups : [],
      activeTerminalGroupId: typeof state?.activeTerminalGroupId === "string" ? state.activeTerminalGroupId : "",
    });
  }
  return { byWorkspaceId };
}

export const useTerminalDrawerStore = create<TerminalDrawerStoreState>()(
  persist(
    set => ({
      byWorkspaceId: {},
      setOpen: (workspaceId, open) =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => setTerminalOpen(c, open)) })),
      toggle: workspaceId =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => setTerminalOpen(c, !c.terminalOpen)) })),
      setHeight: (workspaceId, height) =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => setTerminalHeight(c, height)) })),
      add: (workspaceId, terminalId) =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => newTerminal(c, terminalId)) })),
      split: (workspaceId, terminalId, direction = "horizontal") =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => splitTerminal(c, terminalId, direction)) })),
      activate: (workspaceId, terminalId) =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => setActiveTerminal(c, terminalId)) })),
      remove: (workspaceId, terminalId) =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => closeTerminal(c, terminalId)) })),
      reconcile: (workspaceId, terminalIds) =>
        set(s => ({ byWorkspaceId: update(s.byWorkspaceId, workspaceId, c => reconcileTerminalIds(c, terminalIds)) })),
      removeWorkspace: workspaceId =>
        set(s => {
          if (!(workspaceId in s.byWorkspaceId)) return s;
          const { [workspaceId]: _removed, ...rest } = s.byWorkspaceId;
          return { byWorkspaceId: rest };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ byWorkspaceId: s.byWorkspaceId }),
      migrate: normalizePersisted,
      // migrate runs only on a version change; a bad shape stored at this version must be caught on every hydrate.
      merge: (persisted, current) => ({ ...current, ...normalizePersisted(persisted) }),
    },
  ),
);
