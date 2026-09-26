// SPDX-License-Identifier: AGPL-3.0-only
// The browser surface's tabs: which port and path each one frames and where
// it has been. The right panel store owns the tab strip (browser:<tabId> surfaces);
// this owns what is behind each id. A cross-origin frame tells us nothing
// about its own navigation, so history is the addresses typed, not the pages
// the frame went on to.
import { create } from "zustand";
import type { KnownPort } from "../adapt/ports.js";
import type { PreviewTabSnapshot } from "../components/RightPanelTabs.js";
import { loopbackUrl, portAndPath, type Address } from "./url.js";

export interface BrowserTabState {
  readonly id: string;
  /** Framed addresses in visit order; null is the servers list. */
  readonly entries: ReadonlyArray<Address | null>;
  readonly index: number;
  /** Keys the frame so a bump remounts it. */
  readonly reloadNonce: number;
  readonly zoom: number;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

type TabsByWorkspace = Record<string, Record<string, BrowserTabState>>;

interface BrowserTabsStore {
  byWorkspaceId: TabsByWorkspace;
  createTab: (workspaceId: string, address: Address | null) => string;
  navigate: (workspaceId: string, tabId: string, address: Address | null) => void;
  back: (workspaceId: string, tabId: string) => void;
  forward: (workspaceId: string, tabId: string) => void;
  reload: (workspaceId: string, tabId: string) => void;
  setZoom: (workspaceId: string, tabId: string, zoom: number) => void;
  /** Drops tabs whose surface is gone. */
  prune: (workspaceId: string, keep: ReadonlyArray<string>) => void;
}

let seq = 0;

const NO_TABS: Record<string, BrowserTabState> = {};

function updateTab(
  byWorkspaceId: TabsByWorkspace,
  workspaceId: string,
  tabId: string,
  updater: (tab: BrowserTabState) => BrowserTabState,
): TabsByWorkspace {
  const tab = byWorkspaceId[workspaceId]?.[tabId];
  if (!tab) return byWorkspaceId;
  const next = updater(tab);
  if (next === tab) return byWorkspaceId;
  return { ...byWorkspaceId, [workspaceId]: { ...byWorkspaceId[workspaceId], [tabId]: next } };
}

export const useBrowserTabs = create<BrowserTabsStore>()(set => ({
  byWorkspaceId: {},
  createTab: (workspaceId, address) => {
    const id = `t${++seq}`;
    // A tab always starts on the servers list so back has somewhere to go.
    const entries: (Address | null)[] = address === null ? [null] : [null, address];
    set(state => ({
      byWorkspaceId: {
        ...state.byWorkspaceId,
        [workspaceId]: {
          ...state.byWorkspaceId[workspaceId],
          [id]: { id, entries, index: entries.length - 1, reloadNonce: 0, zoom: 1 },
        },
      },
    }));
    return id;
  },
  // A surface id the right panel persisted across a reload has no tab here
  // yet; navigating it brings one into being under the same id.
  navigate: (workspaceId, tabId, address) =>
    set(state => {
      const known = state.byWorkspaceId[workspaceId]?.[tabId];
      if (!known) {
        const entries: (Address | null)[] = address === null ? [null] : [null, address];
        return {
          byWorkspaceId: {
            ...state.byWorkspaceId,
            [workspaceId]: {
              ...state.byWorkspaceId[workspaceId],
              [tabId]: { id: tabId, entries, index: entries.length - 1, reloadNonce: 0, zoom: 1 },
            },
          },
        };
      }
      return {
        byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => {
          if (sameAddress(tab.entries[tab.index] ?? null, address)) return tab;
          const entries = [...tab.entries.slice(0, tab.index + 1), address];
          return { ...tab, entries, index: entries.length - 1 };
        }),
      };
    }),
  back: (workspaceId, tabId) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => (tab.index > 0 ? { ...tab, index: tab.index - 1 } : tab)),
    })),
  forward: (workspaceId, tabId) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab =>
        tab.index < tab.entries.length - 1 ? { ...tab, index: tab.index + 1 } : tab,
      ),
    })),
  reload: (workspaceId, tabId) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => ({ ...tab, reloadNonce: tab.reloadNonce + 1 })),
    })),
  setZoom: (workspaceId, tabId, zoom) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => {
        const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
        return clamped === tab.zoom ? tab : { ...tab, zoom: clamped };
      }),
    })),
  prune: (workspaceId, keep) =>
    set(state => {
      const tabs = state.byWorkspaceId[workspaceId];
      if (!tabs) return state;
      const kept = Object.fromEntries(Object.entries(tabs).filter(([id]) => keep.includes(id)));
      if (Object.keys(kept).length === Object.keys(tabs).length) return state;
      const { [workspaceId]: _dropped, ...rest } = state.byWorkspaceId;
      return { byWorkspaceId: Object.keys(kept).length === 0 ? rest : { ...rest, [workspaceId]: kept } };
    }),
}));

/** Test isolation: forget every workspace's tabs. */
export function resetBrowserTabs(): void {
  useBrowserTabs.setState({ byWorkspaceId: {} });
}

export function useBrowserTab(workspaceId: string, tabId: string | null): BrowserTabState | null {
  return useBrowserTabs(s => (tabId === null ? null : (s.byWorkspaceId[workspaceId]?.[tabId] ?? null)));
}

export function useWorkspaceBrowserTabs(workspaceId: string): Record<string, BrowserTabState> {
  return useBrowserTabs(s => s.byWorkspaceId[workspaceId] ?? NO_TABS);
}

export function currentAddress(tab: BrowserTabState | null): Address | null {
  return tab?.entries[tab.index] ?? null;
}

function sameAddress(a: Address | null, b: Address | null): boolean {
  return a === b || (a !== null && b !== null && a.port === b.port && a.path === b.path);
}

/** What each tab's strip entry shows: the process behind the port when the directory knows it, and the path. */
export function previewTabSnapshots(
  tabs: Record<string, BrowserTabState>,
  ports: ReadonlyArray<KnownPort>,
): Record<string, PreviewTabSnapshot> {
  return Object.fromEntries(
    Object.values(tabs).map(tab => {
      const at = currentAddress(tab);
      if (at === null) return [tab.id, { tabId: tab.id, url: null, title: "" }];
      const process = ports.find(p => p.port === at.port)?.process;
      const where = portAndPath(at.port, at.path);
      return [tab.id, { tabId: tab.id, url: loopbackUrl(at.port, at.path), title: process ? `${process} ${where}` : where }];
    }),
  );
}
