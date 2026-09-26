// Adapted from pingdotgg/t3code apps/web/src/rightPanelStore.ts at 57a66608 (MIT).
/**
 * Workspace-scoped right-panel surface state.
 *
 * This is intentionally a shallow model: it owns an ordered set of surface
 * descriptors and the active surface, while each feature continues to own
 * its durable resource state. Browser surfaces point at preview tab ids,
 * terminal surfaces point at terminal session ids, and the diff, the
 * workspace's own readings, its processes and the agents are singleton surfaces.
 *
 * Keyed by workspace id: a wsp workspace is one machine, and every surface
 * here belongs to the machine, not to one conversation on it.
 */
import { HERE_KEY } from "./terminal/computer.js";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { PANE_KINDS, type RightPanelKind } from "./panes.js";

export type { RightPanelKind } from "./panes.js";

/** A pane of one surface per workspace; the browser and the terminal hold one per tab and pty. */
type SingletonKind = Exclude<RightPanelKind, "preview" | "terminal">;
type OpenableKind = Exclude<RightPanelKind, "terminal">;

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { [K in SingletonKind]: { id: K; kind: K } }[SingletonKind];

const RIGHT_PANEL_STORAGE_KEY = "wsp:right-panel-state:v1";
const RIGHT_PANEL_STORAGE_VERSION = 1;
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "wsp:right-panel-width";

export interface WorkspaceRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

interface RightPanelStoreState {
  byWorkspaceId: Record<string, WorkspaceRightPanelState>;
  open: (workspaceId: string, kind: OpenableKind) => void;
  openBrowser: (workspaceId: string, tabId: string | null) => void;
  openTerminal: (workspaceId: string, terminalId: string) => void;
  splitTerminal: (
    workspaceId: string,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (workspaceId: string, surfaceId: string, terminalId: string) => void;
  closeTerminal: (workspaceId: string, surfaceId: string, terminalId: string) => void;
  activateSurface: (workspaceId: string, surfaceId: string) => void;
  closeSurface: (workspaceId: string, surfaceId: string) => void;
  closeOtherSurfaces: (workspaceId: string, surfaceId: string) => void;
  closeSurfacesToRight: (workspaceId: string, surfaceId: string) => void;
  closeAllSurfaces: (workspaceId: string) => void;
  reconcileBrowserSurfaces: (workspaceId: string, tabIds: readonly string[]) => void;
  reconcileTerminalSurfaces: (workspaceId: string, ptyIds: readonly string[]) => void;
  show: (workspaceId: string) => void;
  close: (workspaceId: string) => void;
  toggleVisibility: (workspaceId: string) => void;
  toggle: (workspaceId: string, kind: OpenableKind) => void;
  removeWorkspace: (workspaceId: string) => void;
}

/**
 * A workspace nobody has touched shows an open, empty panel: the surface
 * picker is how the right panel is discovered until a palette exists.
 */
const EMPTY_WORKSPACE_STATE: WorkspaceRightPanelState = {
  isOpen: true,
  activeSurfaceId: null,
  surfaces: [],
};
// This computer's panel stands behind the default thread and the first run, where nothing asked for it yet.
const EMPTY_HERE_STATE: WorkspaceRightPanelState = { ...EMPTY_WORKSPACE_STATE, isOpen: false };
const emptyFor = (key: string): WorkspaceRightPanelState => (key === HERE_KEY ? EMPTY_HERE_STATE : EMPTY_WORKSPACE_STATE);

const isSingleton = (kind: RightPanelKind): kind is SingletonKind => kind !== "preview" && kind !== "terminal";
/** Whether the store's open takes this kind; a terminal surface opens only onto a pty that exists. */
export const isOpenable = (kind: RightPanelKind): kind is OpenableKind => kind !== "terminal";
const SINGLETONS = new Map(
  PANE_KINDS.filter(isSingleton).map((kind): [SingletonKind, RightPanelSurface] => [kind, { id: kind, kind } as RightPanelSurface]),
);
const singletonSurface = (kind: SingletonKind): RightPanelSurface => SINGLETONS.get(kind)!;

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

const upsertSurface = (
  current: WorkspaceRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): WorkspaceRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const isEmptyState = (key: string, state: WorkspaceRightPanelState): boolean =>
  state.isOpen === emptyFor(key).isOpen &&
  state.activeSurfaceId === null &&
  state.surfaces.length === 0;

const updateWorkspace = (
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string,
  updater: (current: WorkspaceRightPanelState) => WorkspaceRightPanelState,
): Record<string, WorkspaceRightPanelState> => {
  const current = byWorkspaceId[workspaceId] ?? emptyFor(workspaceId);
  const next = updater(current);
  if (isEmptyState(workspaceId, next)) {
    if (!(workspaceId in byWorkspaceId)) return byWorkspaceId;
    const { [workspaceId]: _removed, ...rest } = byWorkspaceId;
    return rest;
  }
  if (next === current) return byWorkspaceId;
  return { ...byWorkspaceId, [workspaceId]: next };
};

const isKnownKind = (kind: unknown): kind is RightPanelKind =>
  typeof kind === "string" && (PANE_KINDS as readonly string[]).includes(kind);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * A persisted surface rebuilt from the fields its kind needs; anything short
 * of them is dropped, since the tab strip and the surfaces read those fields
 * on every render.
 */
function usableSurface(raw: unknown): RightPanelSurface | null {
  if (!raw || typeof raw !== "object") return null;
  const surface = raw as Record<string, unknown>;
  const kind = surface["kind"];
  if (!isKnownKind(kind)) return null;
  if (isSingleton(kind)) return singletonSurface(kind);
  switch (kind) {
    case "preview": {
      const resourceId = surface["resourceId"];
      if (resourceId !== null && typeof resourceId !== "string") return null;
      return browserSurface(resourceId);
    }
    case "terminal": {
      const terminalIds = isStringArray(surface["terminalIds"]) ? surface["terminalIds"] : [];
      const first = terminalIds[0];
      if (first === undefined) return null;
      const active = surface["activeTerminalId"];
      const resourceId = surface["resourceId"];
      return {
        id: `terminal:${typeof resourceId === "string" ? resourceId : first}`,
        kind,
        resourceId: typeof resourceId === "string" ? resourceId : first,
        terminalIds,
        activeTerminalId: typeof active === "string" && terminalIds.includes(active) ? active : first,
        ...(surface["splitDirection"] === "vertical" ? { splitDirection: "vertical" as const } : {}),
      };
    }
  }
}

/** Drops anything persisted under a kind or shape this build does not know. */
export function migratePersistedRightPanelState(persistedState: unknown): {
  byWorkspaceId: Record<string, WorkspaceRightPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byWorkspaceId: {} };
  const raw = (persistedState as { byWorkspaceId?: unknown }).byWorkspaceId;
  if (!raw || typeof raw !== "object") return { byWorkspaceId: {} };
  const byWorkspaceId = Object.fromEntries(
    Object.entries(raw as Record<string, Partial<WorkspaceRightPanelState> | null>).map(
      ([workspaceId, state]) => {
        const surfaces = Array.isArray(state?.surfaces)
          ? state.surfaces.flatMap((surface) => {
              const usable = usableSurface(surface);
              return usable ? [usable] : [];
            })
          : [];
        const activeSurfaceId = surfaces.some((surface) => surface.id === state?.activeSurfaceId)
          ? (state?.activeSurfaceId ?? null)
          : (surfaces[0]?.id ?? null);
        const isOpen = typeof state?.isOpen === "boolean" ? state.isOpen : emptyFor(workspaceId).isOpen;
        return [workspaceId, { isOpen, surfaces, activeSurfaceId }];
      },
    ),
  );
  return { byWorkspaceId };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byWorkspaceId: {},
      open: (workspaceId, kind) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      openBrowser: (workspaceId, tabId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        })),
      openTerminal: (workspaceId, terminalId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      splitTerminal: (workspaceId, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) => {
              if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
              const { splitDirection: _splitDirection, ...baseSurface } = surface;
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            }),
          })),
        })),
      activateTerminal: (workspaceId, surfaceId, terminalId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (workspaceId, surfaceId, terminalId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      activateSurface: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, surfaces };
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...current,
              surfaces,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        })),
      closeOtherSurfaces: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        })),
      closeSurfacesToRight: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, surfaces: [], activeSurfaceId: null },
          ),
        })),
      reconcileBrowserSurfaces: (workspaceId, tabIds) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        })),
      reconcileTerminalSurfaces: (workspaceId, ptyIds) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const live = new Set(ptyIds);
            let changed = false;
            const surfaces: RightPanelSurface[] = [];
            for (const surface of current.surfaces) {
              if (surface.kind !== "terminal") {
                surfaces.push(surface);
                continue;
              }
              const terminalIds = surface.terminalIds.filter((id) => live.has(id));
              if (terminalIds.length === surface.terminalIds.length) {
                surfaces.push(surface);
                continue;
              }
              changed = true;
              if (terminalIds.length === 0) continue;
              surfaces.push({
                ...surface,
                terminalIds,
                activeTerminalId: terminalIds.includes(surface.activeTerminalId)
                  ? surface.activeTerminalId
                  : terminalIds.at(-1)!,
              });
            }
            if (!changed) return current;
            const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : (surfaces[0]?.id ?? null),
            };
          }),
        })),
      show: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        })),
      close: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        })),
      toggleVisibility: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (workspaceId, kind) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      removeWorkspace: (workspaceId) =>
        set((state) => {
          if (!(workspaceId in state.byWorkspaceId)) return state;
          const { [workspaceId]: _removed, ...rest } = state.byWorkspaceId;
          return { byWorkspaceId: rest };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ byWorkspaceId: state.byWorkspaceId }),
      migrate: migratePersistedRightPanelState,
      // migrate runs only on a version change; a bad shape stored at this version must be caught on every hydrate.
      merge: (persisted, current) => ({ ...current, ...migratePersistedRightPanelState(persisted) }),
    },
  ),
);

export function selectWorkspaceRightPanelState(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): WorkspaceRightPanelState {
  if (!workspaceId) return EMPTY_WORKSPACE_STATE;
  return byWorkspaceId[workspaceId] ?? emptyFor(workspaceId);
}

export function selectActiveRightPanel(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): RightPanelKind | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): RightPanelSurface | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byWorkspaceId, workspaceId);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): RightPanelSurface | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

/** Every pty the workspace's right-panel terminal surfaces hold; the drawer arranges the rest. */
export function selectPanelTerminalIds(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): string[] {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  return state.surfaces.flatMap((surface) => (surface.kind === "terminal" ? surface.terminalIds : []));
}
