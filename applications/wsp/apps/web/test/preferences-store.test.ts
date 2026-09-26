// SPDX-License-Identifier: AGPL-3.0-only
// The store's side of the preferences record: read from the host on bind and
// on every reconnect, followed on preferences.changed, a set painted ahead of
// the host's answer and settled by it, a refusal a toast that reads the host's
// record again, the picks this browser kept in localStorage moved onto the
// record once, and the settings page a state a workspace pick leaves.
import { DEFAULT_PREFERENCES, applyPreferencesPatch, type Preferences, type PreferencesPatch, type WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectedError, RequestError, type Api, type ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const view = (id: string): WorkspaceView => ({ id, name: id, machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" });
const CAPS = caps();

function fakeApi(record: Preferences, refuse?: () => Error) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const sets: PreferencesPatch[] = [];
  const reads = { count: 0 };
  let held = record;
  const api: Api = {
    listWorkspaces: async () => [view("ws_a")],
    getWorkspace: async () => view("ws_a"),
    createWorkspace: async () => view("ws_a"),
    watchStatuses: async () => [],
    nap: async () => view("ws_a"),
    wake: async () => view("ws_a"),
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: 0 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    getGolden: async () => undefined,
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    preferences: async () => {
      reads.count++;
      return held;
    },
    setPreferences: async patch => {
      sets.push(patch);
      if (refuse !== undefined) throw refuse();
      held = applyPreferencesPatch(held, patch);
      return held;
    },
  };
  const emit = (e: ProtocolEvent) => {
    for (const fn of [...listeners]) fn(e);
  };
  return { api, emit, sets, reads };
}

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  clearNotices();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the preferences record in the store", () => {
  it("is the defaults until the host answers, then the host's record, read again when the socket comes back live, and follows preferences.changed", async () => {
    const record: Preferences = { ...DEFAULT_PREFERENCES, labs: true, theme: "light", sidebarWidth: 300 };
    const { api, emit, reads } = fakeApi(record);
    expect(useStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().preferences).toEqual(record);
    expect(reads.count).toBe(1);
    useStore.getState().setConn("live");
    await flush();
    expect(reads.count).toBe(2);
    emit({ type: "preferences.changed", preferences: { ...record, sidebarMode: "spaces" } });
    expect(useStore.getState().preferences.sidebarMode).toBe("spaces");
  });

  it("a set paints at once, goes to the host as the patch, and the host's answer settles the record", async () => {
    const { api, sets } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    const done = useStore.getState().setPreferences({ theme: "dark" });
    expect(useStore.getState().preferences.theme).toBe("dark");
    await done;
    expect(sets).toEqual([{ theme: "dark" }]);
    expect(useStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, labs: true, theme: "dark" });
    expect(lastNotice()).toBeNull();
  });

  it("a theme pick paints at once and the host's answer settles it", async () => {
    const { api, sets } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    const done = useStore.getState().setPreferences({ darkTheme: "denim" });
    expect(useStore.getState().preferences.darkTheme).toBe("denim");
    await done;
    expect(sets).toEqual([{ darkTheme: "denim" }]);
    expect(useStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, labs: true, darkTheme: "denim" });
  });

  it("while a set is on its way, an earlier record from the host does not paint over the person's pick", async () => {
    const { api, emit } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    const done = useStore.getState().setPreferences({ terminalZoom: { ws_a: 2 } });
    emit({ type: "preferences.changed", preferences: { ...DEFAULT_PREFERENCES, labs: true, terminalZoom: { ws_a: 1 } } });
    expect(useStore.getState().preferences.terminalZoom).toEqual({ ws_a: 2 });
    await done;
    expect(useStore.getState().preferences.terminalZoom).toEqual({ ws_a: 2 });
  });

  it("a refusal is a toast and the host's record is read again; a dropped socket is neither", async () => {
    const { api, reads } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true, theme: "light" }, () => new RequestError("state file unreadable"));
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().setPreferences({ theme: "dark" });
    await flush();
    expect(lastNotice()).toBe("That setting was not saved: state file unreadable. It shows the host's value again.");
    expect(reads.count).toBe(2);
    expect(useStore.getState().preferences.theme).toBe("light");

    const dropped = fakeApi({ ...DEFAULT_PREFERENCES, labs: true }, () => new DisconnectedError("lost"));
    useStore.setState({ api: dropped.api });
    clearNotices();
    await useStore.getState().setPreferences({ theme: "dark" });
    expect(lastNotice()).toBeNull();
  });

  it("a set the host kept but could not finish says the host's notice, not that the setting was not saved", async () => {
    const said = "Server icons are off, but ~/.wsp/icons could not be deleted: permission denied. Delete it by hand.";
    const { api, reads } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    const kept = api.setPreferences!;
    api.setPreferences = async patch => ({ ...(await kept(patch)), notice: said });
    useStore.getState().bind(api);
    await flush();
    clearNotices();
    await useStore.getState().setPreferences({ serverIcons: false });
    await flush();
    expect(lastNotice()).toBe(said);
    expect(reads.count).toBe(1);
    expect(useStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, labs: true, serverIcons: false });
  });

  it("without the verb on the client the pick still paints and nothing is sent", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    const { preferences: _p, setPreferences: _s, ...bare } = api;
    useStore.getState().bind(bare);
    await flush();
    await useStore.getState().setPreferences({ sidebarMode: "spaces" });
    expect(useStore.getState().preferences.sidebarMode).toBe("spaces");
  });

  it("moves the three picks this browser kept in localStorage onto the record once, the old size as pixels over the app's, and drops the old keys", async () => {
    window.localStorage.setItem("wsp:sidebar-width", "312.4");
    window.localStorage.setItem("wsp:sidebar-mode", "spaces");
    window.localStorage.setItem("wsp:terminal-font-size:ws_a", "16");
    window.localStorage.setItem("wsp:terminal-font-size:ws_b", "12");
    window.localStorage.setItem("wsp:terminal-font", "Hack");
    const { api, sets, reads } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    await flush();
    expect(sets).toEqual([{ sidebarWidth: 312, sidebarMode: "spaces", terminalZoom: { ws_a: 2, ws_b: -2 } }]);
    expect(useStore.getState().preferences).toMatchObject({ sidebarWidth: 312, sidebarMode: "spaces", terminalZoom: { ws_a: 2, ws_b: -2 } });
    expect(window.localStorage.getItem("wsp:sidebar-width")).toBeNull();
    expect(window.localStorage.getItem("wsp:sidebar-mode")).toBeNull();
    expect(window.localStorage.getItem("wsp:terminal-font-size:ws_a")).toBeNull();
    expect(window.localStorage.getItem("wsp:terminal-font")).toBe("Hack");
    // The next read finds nothing to move.
    useStore.getState().setConn("live");
    await flush();
    await flush();
    expect(reads.count).toBe(2);
    expect(sets).toHaveLength(1);
  });

  it("carries the access pick this browser kept in the composer's own key onto the record, and clears that field alone", async () => {
    const composer = (options: Record<string, Record<string, string>>) => JSON.stringify({ state: { byWorkspaceId: options }, version: 1 });
    window.localStorage.setItem("wsp:composer-options:v1", composer({ ws_a: { permissionMode: "bypassPermissions", model: "claude-opus-5" }, ws_b: { effort: "high" } }));
    const { api, sets } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    await flush();
    // The pick the person had standing is on the record, so the first thread after this lands still runs at it.
    expect(sets).toEqual([{ access: { ws_a: "bypassPermissions" } }]);
    expect(useStore.getState().preferences.access).toEqual({ ws_a: "bypassPermissions" });
    // The other picks under that key are this browser's and stay; only the moved field goes.
    const left = JSON.parse(window.localStorage.getItem("wsp:composer-options:v1")!) as { state: { byWorkspaceId: Record<string, Record<string, string>> } };
    expect(left.state.byWorkspaceId).toEqual({ ws_a: { model: "claude-opus-5" }, ws_b: { effort: "high" } });
    // The next read finds nothing to move.
    useStore.getState().setConn("live");
    await flush();
    await flush();
    expect(sets).toHaveLength(1);
  });

  it("a browser with none of the old keys, or one holding nonsense under them, sends nothing; nonsense under one key does not stop the rest", async () => {
    window.localStorage.setItem("wsp:composer-options:v1", "not json");
    window.localStorage.setItem("wsp:sidebar-width", "wide");
    window.localStorage.setItem("wsp:sidebar-mode", "grid");
    const { api, sets } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    await flush();
    expect(sets).toEqual([]);
    window.localStorage.setItem("wsp:sidebar-mode", "spaces");
    useStore.getState().setConn("live");
    await flush();
    await flush();
    expect(sets).toEqual([{ sidebarMode: "spaces" }]);
  });

  it("the settings page opens on its own state, toggles shut, closes on its own, and closes when a workspace or a thread is picked", () => {
    useStore.setState(s => ({ preferences: { ...s.preferences, labs: true } }));
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().select("ws_a");
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().openSettings();
    useStore.getState().select("ws_a", "thr_1");
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().toggleSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().toggleSettings();
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().openSettings();
    useStore.getState().closeSettings();
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("opens with labs off too: the page is where a person finds the computers their agents run on, and the labs flag gates the picks inside it", () => {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false } });
    useStore.getState().toggleSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().toggleSettings();
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("shuts the Add a computer sheet with the page, whichever road shut it", () => {
    useStore.getState().openAddComputer();
    expect(useStore.getState()).toMatchObject({ settingsOpen: true, addComputerOpen: true });
    useStore.getState().closeSettings();
    expect(useStore.getState()).toMatchObject({ settingsOpen: false, addComputerOpen: false });
    useStore.getState().openAddComputer();
    useStore.getState().toggleSettings();
    expect(useStore.getState()).toMatchObject({ settingsOpen: false, addComputerOpen: false });
  });
});
