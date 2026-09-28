// SPDX-License-Identifier: AGPL-3.0-only
// The toasts over the centre pane and the list they leave behind: where they
// stand, how many show, and every way one goes.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import { DEFAULT_PREFERENCES, type InitJob, type WorkspaceView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { FIRST_PAGE, useSettingsStore } from "../src/settings/settingsStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { Shell } from "../src/App.js";
import { CLOSE_NOTICE_LABEL } from "../src/notices/Notice.js";
import { addNotice, NOTICE_MS, useNotices } from "../src/notices/store.js";
import { caps } from "./caps.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const view = (id: string, name: string): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

function fakeApi(over: Partial<Api> = {}): Api {
  const workspaces = [view("ws_a", "api")];
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => caps(),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
    ...over,
  };
}

/** The toasts a person can see: not on their way out, not held back past the limit. */
const showing = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-notice]")].filter(el => !el.hasAttribute("data-ending-style") && !el.hasAttribute("data-limited"));
const texts = (): string[] => showing().map(el => el.querySelector("h2")?.textContent ?? "");

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, sessions: {}, ready: false, gaps: 0, settingsOpen: false, places: [], projects: [], placesRead: false, projectsRead: false, placesRefused: null, projectsRefused: null, preferences: DEFAULT_PREFERENCES });
  act(() => useNotices.getState().clear());
  useSettingsStore.setState({ at: FIRST_PAGE });
});

afterEach(() => {
  vi.useRealTimers();
  act(() => useNotices.getState().clear());
});

function mountShell() {
  return render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
}

describe("the toast", () => {
  it("stands inside the centre pane, never in the sidebar", async () => {
    mountShell();
    act(() => void addNotice({ kind: "error", text: "spoo was not paused: the provider refused" }));
    await waitFor(() => expect(showing()).toHaveLength(1));
    const notice = showing()[0]!;
    expect(notice.closest('[data-slot="sidebar-inset"]')).not.toBeNull();
    expect(notice.closest("[data-app-sidebar]")).toBeNull();
    expect(notice.textContent).toContain("spoo was not paused: the provider refused");
    expect(notice.textContent).toContain("error");
  });

  it("shows while Settings is open", async () => {
    useStore.setState({ settingsOpen: true });
    mountShell();
    act(() => void addNotice({ kind: "note", text: "Image sealed" }));
    await waitFor(() => expect(texts()).toEqual(["Image sealed"]));
  });

  it("shows three at once, newest on top, and a fourth sends the oldest to the list only", async () => {
    mountShell();
    act(() => {
      for (const n of ["one", "two", "three", "four"]) addNotice({ kind: "note", text: n });
    });
    await waitFor(() => expect(texts()).toEqual(["four", "three", "two"]));
    expect(useNotices.getState().notices.map(n => n.text)).toEqual(["four", "three", "two", "one"]);
    expect(useNotices.getState().unread).toBe(4);
    // The oldest does not come back when a newer one goes.
    fireEvent.click(showing()[0]!.querySelector(`[aria-label="${CLOSE_NOTICE_LABEL}"]`)!);
    await waitFor(() => expect(texts()).toEqual(["three", "two"]));
  });

  it("runs its action and goes, leaving the row in the list", async () => {
    mountShell();
    const run = vi.fn();
    act(() => void addNotice({ kind: "waiting", text: "wsp needs you to sign in to claude", action: { word: "Open", run } }));
    await waitFor(() => expect(showing()).toHaveLength(1));
    fireEvent.click(showing()[0]!.querySelector("[data-notice-action]")!);
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(showing()).toHaveLength(0));
    expect(useNotices.getState().notices).toHaveLength(1);
  });

  it("goes after its time, and not while the pointer is over it", async () => {
    vi.useFakeTimers();
    mountShell();
    act(() => void addNotice({ kind: "note", text: "held" }));
    expect(showing()).toHaveLength(1);
    fireEvent.mouseEnter(document.querySelector("[data-notices]")!);
    act(() => void vi.advanceTimersByTime(NOTICE_MS * 2));
    expect(showing()).toHaveLength(1);
    fireEvent.mouseLeave(document.querySelector("[data-notices]")!);
    act(() => void vi.advanceTimersByTime(NOTICE_MS + 100));
    expect(showing()).toHaveLength(0);
  });

  it("Escape takes the newest away, and leaves it to a field that has the focus", async () => {
    mountShell();
    act(() => {
      addNotice({ kind: "note", text: "older" });
      addNotice({ kind: "note", text: "newer" });
    });
    await waitFor(() => expect(texts()).toEqual(["newer", "older"]));
    const field = document.createElement("textarea");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(texts()).toEqual(["newer", "older"]);
    field.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(texts()).toEqual(["older"]));
  });

  it("a keyed notice stays until its wait ends, and then leaves the list too", async () => {
    vi.useFakeTimers();
    mountShell();
    act(() => void addNotice({ kind: "waiting", text: "a need", key: "need" }));
    act(() => void vi.advanceTimersByTime(NOTICE_MS * 3));
    expect(texts()).toEqual(["a need"]);
    act(() => useNotices.getState().end("need"));
    expect(showing()).toHaveLength(0);
    expect(useNotices.getState().notices).toHaveLength(0);
  });
});

describe("the notice itself", () => {
  it("a keyed notice said again replaces the first and counts as one unread", () => {
    addNotice({ kind: "waiting", text: "a prompt", key: "perm" });
    addNotice({ kind: "waiting", text: "the prompt again", key: "perm" });
    expect([useNotices.getState().notices.map(n => n.text), useNotices.getState().unread]).toEqual([["the prompt again"], 1]);
  });

  it("keeps 400 characters of a sentence, since a refusal can echo what it was sent", () => {
    addNotice({ kind: "error", text: "x".repeat(1000) });
    expect(useNotices.getState().notices[0]!.text).toBe(`${"x".repeat(400)}…`);
  });

  it("is named by its sentence", async () => {
    mountShell();
    act(() => void addNotice({ kind: "error", text: "spoo was not woken: no answer" }));
    await waitFor(() => expect(showing()).toHaveLength(1));
    const label = showing()[0]!.getAttribute("aria-labelledby");
    expect(label === null ? null : document.getElementById(label)?.textContent).toBe("spoo was not woken: no answer");
  });

  it("Escape with the focus in an older toast takes that one only", async () => {
    mountShell();
    act(() => {
      addNotice({ kind: "note", text: "older" });
      addNotice({ kind: "note", text: "newer" });
    });
    await waitFor(() => expect(texts()).toEqual(["newer", "older"]));
    const older = showing()[1]!;
    act(() => older.focus());
    fireEvent.keyDown(older, { key: "Escape" });
    await waitFor(() => expect(texts()).toEqual(["newer"]));
  });
});

describe("the centre while projects are refused", () => {
  it("says the refusal in one centred line when no task is picked", async () => {
    useStore.setState({ ready: true, projectsRead: true, projects: [], workspaces: [], selectedId: null, projectHome: null, projectsRefused: { said: "projects.json is not valid JSON", fix: undefined, kind: undefined, disconnected: false } });
    render(<Shell />);
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-shell-center] [data-k='centre-refused']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(line.textContent).toBe("Projects not read: projects.json is not valid JSON");
  });
});

describe("the store's refusals", () => {
  const bindWith = async (over: Partial<Api>) => {
    useStore.getState().bind(fakeApi(over));
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  };
  const said = () => useNotices.getState().notices.map(n => n.text);

  it("a refused refresh is a notice", async () => {
    await bindWith({ listWorkspaces: async () => { throw new RequestError("the host could not read its workspaces"); } });
    expect(said()).toContain("Workspaces not read: the host could not read its workspaces");
  });

  it("a refused place or project list is a fault, never an empty list", async () => {
    useStore.setState({ places: [{ id: "p_old", kind: "computer", name: "old", default: false, present: true, takesForks: true }], projects: [{ id: "pr_old", name: "old", computer: "here", source: { kind: "folder", path: "/old" }, path: "/old", remote: "", defaultBranch: "main", memoryKey: "-old", memoryDir: "/m", createdAt: "2026-09-01T00:00:00Z" }] });
    await bindWith({
      placesList: async () => { throw new RequestError("places file unreadable"); },
      projectsList: async () => { throw new RequestError("projects file unreadable"); },
    });
    const s = useStore.getState();
    // Rows read before the refusal are not today's list, so they go, as a refused forwards read's do.
    expect([s.places, s.projects]).toEqual([[], []]);
    expect([s.placesRead, s.placesRefused?.said, s.projectsRead, s.projectsRefused?.said]).toEqual([true, "places file unreadable", true, "projects file unreadable"]);
    expect(said()).toEqual(expect.arrayContaining(["Computers not read: places file unreadable", "Projects not read: projects file unreadable"]));
  });

  it("says no notice for a refused place list while Computers, the page that draws it, is on screen", async () => {
    useSettingsStore.setState({ at: { kind: "group", group: "computers" } });
    useStore.setState({ settingsOpen: true });
    await bindWith({
      placesList: async () => { throw new RequestError("places file unreadable"); },
      projectsList: async () => { throw new RequestError("projects file unreadable"); },
    });
    expect(useStore.getState().placesRefused?.said).toBe("places file unreadable");
    expect(said()).not.toContain("Computers not read: places file unreadable");
    expect(said()).toContain("Projects not read: projects file unreadable");
  });

  it("a ticket socket's refusal reads as not yours to see and says nothing", async () => {
    const ticket = () => new RequestError("this device cannot see that", "ticket");
    await bindWith({ placesList: async () => { throw ticket(); }, projectsList: async () => { throw ticket(); }, initGet: async () => { throw ticket(); } });
    const s = useStore.getState();
    expect([s.placesRead, s.placesRefused, s.projectsRead, s.projectsRefused]).toEqual([true, null, true, null]);
    expect(said()).toEqual([]);
  });

  it("a refused capabilities read is said once a bind, however often it is asked", async () => {
    let emit: (e: Parameters<Parameters<Api["subscribe"]>[0]>[0]) => void = () => {};
    await bindWith({
      capabilities: async () => { throw new RequestError("no provider wired"); },
      subscribe: fn => { emit = fn; return () => {}; },
    });
    const done: InitJob = { id: "init_1", road: "manual", phase: "done", keys: {}, step: 0, stoppable: false, screens: [], rows: [], progress: { done: 1, total: 1 }, log: [] };
    act(() => emit({ type: "init.job", job: done }));
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    expect(said()).toEqual(["What the host can do was not read: no provider wired"]);
  });

  it("a refused thread list is said once per workspace, naming it", async () => {
    await bindWith({});
    useStore.setState({ api: fakeApi({ listSessions: async () => { throw new RequestError("sessions.db is locked"); } }), workspaces: [view("ws_a", "api")] });
    await useStore.getState().reloadSessions("ws_a");
    await useStore.getState().reloadSessions("ws_a");
    expect(useNotices.getState().notices.map(n => [n.text, n.where])).toEqual([["Threads not read: sessions.db is locked", "api"]]);
  });

  it("a lost socket says nothing: the banner does", async () => {
    const { DisconnectedError } = await import("../src/protocol/client.js");
    await bindWith({ placesList: async () => { throw new DisconnectedError("lost"); }, preferences: async () => { throw new DisconnectedError("lost"); } });
    expect(said()).toEqual([]);
    expect(useStore.getState().placesRefused).toBeNull();
  });
});

describe("the Computers page", () => {
  it("says a refused place list where the rows stand, the host's fix beside it", async () => {
    resetSettings();
    useStore.setState({ placesRead: true, placesRefused: { said: "places.json is not valid JSON", fix: "Restore it from places.json.bak.", kind: undefined, disconnected: false } });
    mountSettings({ api: settingsApi().api, at: { kind: "group", group: "computers" } });
    await settle();
    const slot = document.querySelector<HTMLElement>("[data-k='places-refused']");
    expect(slot?.textContent).toBe("Computers not read: places.json is not valid JSON Restore it from places.json.bak.");
  });
});
