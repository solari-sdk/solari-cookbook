// SPDX-License-Identifier: AGPL-3.0-only
// What every settings test mounts: the shell with Settings open, so the
// settings sidebar stands in the app sidebar's place and the page in the
// centre, over a fake api that answers only what a case names. The settings
// store starts fresh on every mount, the way a first window opens.
import { act, render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEFAULT_PREFERENCES, applyPreferencesPatch, type EventUnion, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useAdds } from "../src/settings/adds.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";
import { FIRST_PAGE, NO_READS, useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { forgetAgentsReports } from "../src/components/agents/useAgentsReport.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

/** A fake api that answers the reads the pages make, records the patches the picks write, and pushes events. */
export function settingsApi(over: Partial<Api> = {}, record: Preferences = { ...DEFAULT_PREFERENCES, labs: false }): { api: Api; sets: PreferencesPatch[]; push(event: EventUnion): void } {
  const listeners: ((e: EventUnion) => void)[] = [];
  const sets: PreferencesPatch[] = [];
  let held = record;
  const api = {
    subscribe: (fn: (e: EventUnion) => void) => {
      listeners.push(fn);
      return () => {};
    },
    preferences: async () => held,
    setPreferences: async (patch: PreferencesPatch) => {
      sets.push(patch);
      held = applyPreferencesPatch(held, patch);
      return held;
    },
    ...over,
  } as unknown as Api;
  return {
    api,
    sets,
    push: event => {
      for (const fn of listeners) fn(event);
    },
  };
}

/** The reads the page makes after it is drawn, let through. */
export const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  });
};

/** Every store back to a first window: nothing remembered, Settings shut, the record at its defaults. */
export function resetSettings(): void {
  window.localStorage.clear();
  forgetAgentsReports();
  useSettingsStore.setState({ at: FIRST_PAGE, search: "", reads: NO_READS, addProjectAt: null, devicesAsked: 0, buildShown: null, recipeAsked: null });
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useNotices.getState().clear();
  useAdds.setState({ jobs: {}, putAway: null });
  useStore.setState({ api: null, conn: "live", places: [], projects: [], placesRefused: null, projectsRefused: null, landings: {}, workspaces: [], statuses: {}, sessions: {}, addComputerOpen: false, settingsOpen: false, selectedId: null, selectedThreadId: null, ready: true, projectsRead: true, release: null, preferences: { ...DEFAULT_PREFERENCES, labs: false } });
}

/** Mounts the shell with Settings open on a page, the store already holding what the case named. */
export function mountSettings({ api, at, children }: { api?: Api; at?: SettingsAt; children?: ReactNode } = {}): RenderResult {
  if (api !== undefined) useStore.setState({ api });
  if (at !== undefined) useSettingsStore.getState().go(at);
  useStore.setState({ settingsOpen: true });
  return render(
    <TooltipProvider>
      {children}
      <AppShell>
        <SettingsPage />
      </AppShell>
    </TooltipProvider>,
  );
}

export const sidebarRowIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row]")].map(row => row.dataset["rowId"] ?? "");
export const liftedRowIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row][data-active=true]")].map(row => row.dataset["rowId"] ?? "");
export const pageAt = (): string | null => document.querySelector<HTMLElement>("[data-settings-page]")?.dataset["settingsAt"] ?? null;
export const crumb = (): string => document.querySelector("[data-thread-breadcrumb]")?.textContent ?? "";
export const rowTitles = (): string[] => [...document.querySelectorAll("[data-settings-page] [data-settings-row] [data-settings-title]")].map(el => el.textContent ?? "");
export const lineLabels = (): string[] => [...document.querySelectorAll("[data-settings-page] [data-settings-line] [data-settings-label]")].map(el => el.textContent ?? "");
export const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] [data-settings-row="${id}"]`);
export const lineOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] [data-settings-line="${id}"]`);
export const descriptionOf = (id: string): string | undefined => rowOf(id)?.querySelector("[data-settings-description]")?.textContent ?? undefined;
export const wordOf = (id: string): string | undefined => (rowOf(id) ?? lineOf(id))?.querySelector("[data-settings-word]")?.textContent ?? undefined;
