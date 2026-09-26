// SPDX-License-Identifier: AGPL-3.0-only
// What every settings page is drawn from, composed once: the host's records
// off the store, the reads the page made, the clock, which shell holds the
// page, and the acts a row can raise. A page is a plain function of this, so
// the search can walk every group's rows with one call each and the sidebar
// can dim a group with no match.
import type { AccountView, PlaceView, Preferences, PreferencesPatch, ProjectView, ReleaseView, SessionView, WorkspaceLanding, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { isDesktopShell } from "../lib/desktopShell.js";
import type { Api } from "../protocol/client.js";
import type { Failure } from "../protocol/failure.js";
import { addNotice, noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { shellVersions } from "../shell/shellVersion.js";
import { resolveAt, useSettingsStore, type SettingsAt, type SettingsReads } from "./settingsStore.js";

export interface SettingsContext {
  readonly preferences: Preferences;
  readonly places: ReadonlyArray<PlaceView>;
  /** Why the host refused the place list, while it does: the Computers page says so rather than drawing it empty. */
  readonly placesRefused: Failure | null;
  /** The same for the project list and the Projects page. */
  readonly projectsRefused: Failure | null;
  readonly projects: ReadonlyArray<ProjectView>;
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly sessions: Readonly<Record<string, SessionView[]>>;
  readonly statuses: Readonly<Record<string, WorkspaceStatus>>;
  readonly landings: Readonly<Record<string, WorkspaceLanding | null>>;
  readonly reads: SettingsReads;
  readonly now: number;
  readonly shell: { readonly inShell: boolean; readonly app: string | undefined; readonly host: string | undefined };
  /** The newest release as the host last read it; null where it gave none. */
  readonly release: ReleaseView | null;
  readonly platform: string;
  readonly desktopShell: boolean;
  readonly api: Api | null;
  readonly go: (at: SettingsAt) => void;
  readonly setPreferences: (patch: PreferencesPatch) => void;
  readonly openAddComputer: () => void;
  readonly openAddProject: () => void;
  readonly rereadDevices: () => void;
  /** A rejection the page's act met, as an error notice in the host's words with its fix; a lost socket says nothing. */
  readonly failed: (e: unknown) => void;
  /** What the host said about an act that went through. */
  readonly done: (line: string) => void;
}

/** The account read as the row reads it: the record, or null before an answer and after a refusal alike. */
export const accountOf = (reads: SettingsReads): AccountView | null => reads.account;

export function useSettingsContext(): SettingsContext {
  const preferences = useStore(s => s.preferences);
  const places = useStore(s => s.places);
  const placesRefused = useStore(s => s.placesRefused);
  const projectsRefused = useStore(s => s.projectsRefused);
  const projects = useStore(s => s.projects);
  const workspaces = useStore(s => s.workspaces);
  const sessions = useStore(s => s.sessions);
  const statuses = useStore(s => s.statuses);
  const landings = useStore(s => s.landings);
  const api = useStore(s => s.api);
  const release = useStore(s => s.release);
  const reads = useSettingsStore(s => s.reads);
  // The minute clock every countdown in the app reads, as a stamp.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  return {
    preferences,
    places,
    placesRefused,
    projectsRefused,
    projects,
    workspaces,
    sessions,
    statuses,
    landings,
    reads,
    now,
    shell: shellVersions(),
    release,
    platform: navigator.platform,
    desktopShell: isDesktopShell(),
    api,
    go: at => useSettingsStore.getState().go(at),
    setPreferences: patch => void useStore.getState().setPreferences(patch),
    openAddComputer: () => useStore.getState().openAddComputer(),
    openAddProject: () => useSettingsStore.getState().openAddProject(),
    rereadDevices: () => useSettingsStore.getState().rereadDevices(),
    failed: e => noticeFailure(e),
    done: line => void addNotice({ kind: "done", text: line }),
  };
}

/** The page Settings is on: a remembered page whose noun is gone falls back to its group. The Add a computer door
 * is a move, not an override: it writes Computers as the page, so the computer it adds is on the list the person is
 * left on. */
export function useSettingsAt(): SettingsAt {
  const stored = useSettingsStore(s => s.at);
  const places = useStore(s => s.places);
  const projects = useStore(s => s.projects);
  return resolveAt(stored, places, projects);
}
