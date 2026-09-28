// SPDX-License-Identifier: AGPL-3.0-only
// The store's session folding: rows come from the sessions.list op, the
// session.* events decide when to refetch and what to patch in between.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS, DEFAULT_THEME, HOSTNAME_KEPT, type GoldenManifest, type InitJob, type PlaceView, type ProjectView, type ReleaseView, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { readProjectHome } from "../src/protocol/address.js";
import { DisconnectedError, RequestError, type Api, type ProtocolEvent } from "../src/protocol/client.js";
import { LAST_WORKSPACE_KEY } from "../src/protocol/lastWorkspace.js";
import { GOLDEN_FRAMES_KEPT, useStore } from "../src/protocol/store.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";
import { clearNotices, lastNotice } from "./notice-text.js";
import { useNotices } from "../src/notices/store.js";

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 } }],
};

const CAPS = caps();

function fakeApi(workspaces: WorkspaceView[], sessions: SessionView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const listCalls: (string | undefined)[] = [];
  const pulls = { workspaces: 0, statuses: 0 };
  const api: Api = {
    listWorkspaces: async () => {
      pulls.workspaces++;
      return workspaces;
    },
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => {
      pulls.statuses++;
      return workspaces.map(w => ({ ...w, machineState: "running" as const, reach: { state: "reachable" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0 }));
    },
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s_new", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async id => {
      listCalls.push(id);
      return id === undefined ? sessions : sessions.filter(s => s.workspaceId === id);
    },
    // Sealed, since these are the forks of its head: a computer with no image forks nothing at all.
    getGolden: async () => GOLDEN,
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: ProtocolEvent) => {
    for (const fn of [...listeners]) fn(e);
  };
  return { api, emit, listCalls, pulls };
}

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  useStore.setState({ api: null, conn: "connecting", capabilities: null, workspaces: [], projects: [], places: [], placesRead: false, projectsRead: false, placesRefused: null, projectsRefused: null, statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, freshThread: false, projectHome: null, creations: [], sessions: {}, launches: {}, ready: false, gaps: 0 });
  clearNotices();
});

// The address is a global the store reads: a #w/<id> left behind would pick the workspace for every test after it.
afterEach(() => {
  window.location.hash = "";
  window.localStorage.removeItem(LAST_WORKSPACE_KEY);
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
});

describe("store selection", () => {
  it("select takes a thread of the workspace; selecting without one shows the latest thread again", () => {
    useStore.getState().select("ws_a", "thr_1");
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: "thr_1" });
    useStore.getState().select("ws_a");
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: null });
    useStore.getState().select("ws_b", "thr_2");
    useStore.getState().select(null);
    expect(useStore.getState()).toMatchObject({ selectedId: null, selectedThreadId: null });
  });
});

describe("the workspace the address opens on", () => {
  const hash = (h: string) => {
    window.location.hash = h;
  };
  const refreshed = async (workspaces: WorkspaceView[]) => {
    const { api } = fakeApi(workspaces, []);
    useStore.setState({ api });
    await useStore.getState().refresh();
    return useStore.getState().selectedId;
  };

  it("selects the workspace wsp init's address names, not the first row", async () => {
    hash("#w/ws_b");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_b");
  });

  it("falls back to the first row when the address names no workspace, or one that is gone", async () => {
    hash("");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
    useStore.setState({ selectedId: null });
    hash("#gallery");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
    useStore.setState({ selectedId: null });
    hash("#w/ws_gone");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
  });

  it("a project's home writes #p/<id>, which a reload reads back, and a refresh while a home is open fills no selection", async () => {
    useStore.getState().openProjectHome("pr_1");
    expect(window.location.hash).toBe("#p/pr_1");
    expect(readProjectHome()).toBe("pr_1");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBeNull();
    expect(useStore.getState().projectHome).toBe("pr_1");
    // A pick of a workspace leaves the home, and the address says the workspace again.
    useStore.getState().select("ws_b");
    expect(useStore.getState().projectHome).toBeNull();
    expect(window.location.hash).toBe("#w/ws_b");
    expect(readProjectHome()).toBeNull();
  });

  it("never moves a selection the person already made", async () => {
    hash("#w/ws_b");
    useStore.setState({ selectedId: "ws_a" });
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
  });

  // The rows the sidebar draws: two workspaces, the older one on top, which is not the order the runtime lists them in.
  const rows = () => [{ ...view("ws_a"), createdAt: "2026-09-02T00:00:00Z" }, view("ws_b")];

  it("with no address it opens on the first row in sidebar order, not the first of the runtime's list", async () => {
    hash("");
    expect(await refreshed(rows())).toBe("ws_b");
  });

  it("opens on the workspace the person had open last, remembered under the host's state file; one the list lost falls through to the first row", async () => {
    hash("");
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ "/Users/dev/.wsp/state.json": "ws_a", "": "ws_a" }));
    expect(await refreshed(rows())).toBe("ws_a");
    // Each step is its own load: the refresh before it wrote where it landed into the address, which a new page has not got.
    useStore.setState({ selectedId: null });
    hash("");
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ "": "ws_gone" }));
    expect(await refreshed(rows())).toBe("ws_b");
    useStore.setState({ selectedId: null });
    hash("");
    window.localStorage.setItem(LAST_WORKSPACE_KEY, "not json");
    expect(await refreshed(rows())).toBe("ws_b");
  });

  it("a memory written under another state file is not this host's", async () => {
    hash("");
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ "/Users/dev/other/state.json": "ws_a" }));
    expect(await refreshed(rows())).toBe("ws_b");
  });

  it("remembers each workspace the person selects, under the state file the boot object names, and never a creation row", async () => {
    hash("");
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, wsPath: "/ws", paired: true, version: "0.0.0", statePath: "/Users/dev/.wsp/state.json" };
    await refreshed(rows());
    expect(JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({ "/Users/dev/.wsp/state.json": "ws_b" });
    useStore.getState().select("ws_a", "thr_1");
    expect(JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({ "/Users/dev/.wsp/state.json": "ws_a" });
    useStore.setState({ creations: [{ key: "c1", name: "new", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }], selectedId: "c1" });
    expect(JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({ "/Users/dev/.wsp/state.json": "ws_a" });
    useStore.setState({ selectedId: null });
    expect(await refreshed(rows())).toBe("ws_a");
  });

  it("a thread link opens that thread when the list carries it; a thread the list does not carry falls back to the workspace with a word", async () => {
    const thread: SessionView = { id: "s1", workspaceId: "ws_b", harness: "claude", status: "completed", threadId: "thr_1", prompt: "hello" };
    hash("#w/ws_b/t/thr_1");
    const { api } = fakeApi([view("ws_a"), view("ws_b")], [thread]);
    useStore.setState({ api });
    await useStore.getState().refresh();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId, lastNotice()]).toEqual(["ws_b", "thr_1", null]);

    useStore.setState({ selectedId: null, selectedThreadId: null });
    hash("#w/ws_b/t/thr_nope");
    await useStore.getState().refresh();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_b", null]);
    expect(lastNotice()).toBe("That thread is not in this task; opened the task instead");
    expect(useNotices.getState().notices[0]?.kind).toBe("error");
  });
});

describe("the address is the one record of what the person is reading", () => {
  const row = (threadId: string, workspaceId = "ws_b"): SessionView => ({ id: `s_${threadId}`, workspaceId, harness: "claude", status: "completed", threadId, prompt: threadId });
  /** The store as a reload leaves it: nothing selected, the runtime's list and rows still to come. */
  const reloaded = (rows: SessionView[]) => {
    const { api } = fakeApi([view("ws_a"), view("ws_b")], rows);
    useStore.setState({ api, selectedId: null, selectedThreadId: null, freshThread: false });
  };

  it("a pick writes the address, and the refresh after a reload reads it back", async () => {
    useStore.getState().select("ws_b", "thr_1");
    expect(window.location.hash).toBe("#w/ws_b/t/thr_1");
    reloaded([row("thr_1"), row("thr_2")]);
    await useStore.getState().refresh();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_b", "thr_1"]);
  });

  it("a thread an agent opened next does not take the centre from the thread the address names", async () => {
    useStore.getState().select("ws_b", "thr_1");
    reloaded([row("thr_1"), { ...row("thr_child"), parentThreadId: "thr_1", startedBy: "agent" }]);
    await useStore.getState().refresh();
    expect(useStore.getState().selectedThreadId).toBe("thr_1");
    // The refresh a reconnect runs reads the address again, not only the first one: the host restarting leaves the
    // workspace selected and the pick to be found again.
    useStore.setState({ selectedThreadId: null });
    await useStore.getState().refresh();
    expect(useStore.getState().selectedThreadId).toBe("thr_1");
  });

  it("a refresh whose session list was refused keeps the pick and the address it was written with", async () => {
    useStore.getState().select("ws_b", "thr_1");
    const { api } = fakeApi([view("ws_a"), view("ws_b")], [row("thr_1")]);
    // A list is best-effort, and a refused one carries no rows: the thread is not gone, it is unread.
    api.listSessions = async () => {
      throw new Error("sessions unavailable");
    };
    useStore.setState({ api });
    await useStore.getState().refresh();
    expect([useStore.getState().selectedThreadId, window.location.hash, lastNotice()]).toEqual(["thr_1", "#w/ws_b/t/thr_1", null]);
  });

  it("the screen a next thread is written on has an address of its own, and a reload opens it again", async () => {
    const asked: string[] = [];
    const off = onNewThreadRequest(d => asked.push(d.workspaceId));
    useStore.getState().newThread("ws_b");
    expect(window.location.hash).toBe("#w/ws_b/new");
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: null, freshThread: true });
    expect(asked).toEqual(["ws_b"]);
    reloaded([row("thr_1")]);
    await useStore.getState().refresh();
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: null, freshThread: true });
    expect(window.location.hash).toBe("#w/ws_b/new");
    expect(asked).toEqual(["ws_b", "ws_b"]);
    off();
  });

  it("what the centre settles on with nothing picked is recorded, and nothing else moves it", () => {
    useStore.setState({ selectedId: "ws_b", selectedThreadId: null });
    useStore.getState().readingThread("ws_b", "thr_2");
    expect([useStore.getState().selectedThreadId, window.location.hash]).toEqual(["thr_2", "#w/ws_b/t/thr_2"]);
    useStore.getState().readingThread("ws_a", "thr_9");
    useStore.getState().readingThread("ws_b", "thr_3");
    expect([useStore.getState().selectedThreadId, window.location.hash]).toEqual(["thr_2", "#w/ws_b/t/thr_2"]);
  });
});

describe("store creations", () => {
  const HERE_PLACE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, present: true };
  const HETZNER_PLACE: PlaceView = { id: "p_1", kind: "computer", name: "hetzner", default: true, engine: "docker", present: true, takesForks: true };
  /** The project every create here is made of: a repo on the computer that clones it, so the work goes there. */
  const PROJECT_ON_HETZNER: ProjectView = { id: "pr_1", name: "spoo-landing", computer: "p_1", source: { kind: "git", url: "https://github.com/dev/spoo.git" }, path: "/root/spoo-landing", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-root-spoo-landing", memoryDir: "/var/lib/wsp/projects/pr_1/memory", createdAt: "t" };

  const stage = (over: Partial<Extract<ProtocolEvent, { type: "workspace.creating" }>> = {}): ProtocolEvent => ({
    type: "workspace.creating",
    workspaceId: "ws_new",
    name: "beta",
    stage: "fork-requested",
    message: "starting beta on ascii",
    elapsedMs: 0,
    ...over,
  });

  it("createWorkspace adds a selected row, adopts the runtime's id from the first stage by name, logs each stage, and swaps to the workspace when created", async () => {
    const workspaces = [view("ws_a")];
    const { api, emit } = fakeApi(workspaces, []);
    let finish!: (w: WorkspaceView) => void;
    api.createWorkspace = () => new Promise<WorkspaceView>(resolve => { finish = resolve; });
    useStore.getState().bind(api);
    await flush();
    const done = useStore.getState().createWorkspace("pr_1", "beta");
    const [creation] = useStore.getState().creations;
    expect(creation).toMatchObject({ name: "beta", workspaceId: null, lines: [], failed: null });
    expect(useStore.getState().selectedId).toBe(creation!.key);

    emit(stage());
    emit(stage({ message: "starting beta on ascii again", elapsedMs: 1_500, notice: "Stopped the builder kept from image v1 to make room at the machine cap." }));
    // What the machine answered a step with rides the line as its own field: it is written on the line's title and
    // never drawn as a second sentence, so it cannot be confused with a notice.
    emit(stage({ stage: "hostname-set", message: HOSTNAME_KEPT, elapsedMs: 2_100, detail: "hostname beta on m1 failed: hostname: sethostname: Operation not permitted" }));
    const logged = useStore.getState().creations[0]!;
    expect(logged.workspaceId).toBe("ws_new");
    expect(logged.lines.map(l => [l.stage, l.message, l.elapsedMs, l.notice, l.detail])).toEqual([
      ["fork-requested", "starting beta on ascii", 0, undefined, undefined],
      ["fork-requested", "starting beta on ascii again", 1_500, "Stopped the builder kept from image v1 to make room at the machine cap.", undefined],
      ["hostname-set", HOSTNAME_KEPT, 2_100, undefined, "hostname beta on m1 failed: hostname: sethostname: Operation not permitted"],
    ]);
    expect(logged.lines.every(l => !Number.isNaN(Date.parse(l.at)))).toBe(true);

    emit({ type: "workspace.created", workspace: view("ws_new") });
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_new");
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_new"]);
    finish(view("ws_new"));
    expect(await done).toBe("ws_new");
    expect(useStore.getState().creations).toEqual([]);
  });

  it("the image being built where the create is going reads as the first lines of that create's log", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    api.createWorkspace = () => new Promise<WorkspaceView>(() => {});
    useStore.getState().bind(api);
    await flush();
    useStore.setState({ places: [HERE_PLACE, HETZNER_PLACE] });
    useStore.setState({ projects: [PROJECT_ON_HETZNER] });
    void useStore.getState().createWorkspace("pr_1", "beta");
    // The computer the build's frames are matched by is the project's own, never a pick of its own.
    expect(useStore.getState().creations[0]!.where).toBe("p_1");

    // The build names the place by the word its backend table keys it with, which is the same row.
    emit({ type: "golden.stage", name: "default", stage: "installing-harness", place: "hetzner" });
    emit({ type: "golden.stage", name: "default", stage: "snapshotting", detail: "about 4.2 GB", place: "hetzner" });
    // The image's own build, at no place, belongs to the init screens and never to a create's log.
    emit({ type: "golden.stage", name: "default", stage: "installing-tools" });
    // A build at a computer this create is not going to is another road's.
    emit({ type: "golden.stage", name: "default", stage: "installing-tools", place: "old-macbook" });
    emit(stage({ stage: "ready", message: "ready", elapsedMs: 210_000 }));

    expect(useStore.getState().creations[0]!.lines.map(l => [l.stage, l.message, l.notice])).toEqual([
      ["image", "building your image on hetzner: installing agents", undefined],
      ["image", "building your image on hetzner: taking the snapshot", "about 4.2 GB"],
      ["ready", "ready", undefined],
    ]);
  });

  it("keeps each place's image build frames by the word they name it with, the newest last and capped, the image's own build out of it, and starts a place over once a build there has ended", () => {
    useStore.setState({ goldenFrames: {} });
    const apply = useStore.getState().applyEvent;
    apply({ type: "golden.stage", name: "default", stage: "creating", place: "hetzner" });
    apply({ type: "golden.stage", name: "default", stage: "installing-tools" });
    apply({ type: "golden.stage", name: "default", stage: "installing-harness", place: "box" });
    for (let i = 0; i < GOLDEN_FRAMES_KEPT + 5; i++) apply({ type: "golden.stage", name: "default", stage: "installing-tools", detail: `row ${i}`, place: "hetzner" });
    const frames = useStore.getState().goldenFrames;
    expect(Object.keys(frames).sort()).toEqual(["box", "hetzner"]);
    expect(frames["hetzner"]).toHaveLength(GOLDEN_FRAMES_KEPT);
    expect(frames["hetzner"]!.at(-1)!.detail).toBe(`row ${GOLDEN_FRAMES_KEPT + 4}`);
    apply({ type: "golden.stage", name: "default", stage: "failed", detail: "no room", place: "box" });
    apply({ type: "golden.stage", name: "default", stage: "creating", place: "box" });
    expect(useStore.getState().goldenFrames["box"]!.map(f => f.stage)).toEqual(["creating"]);
  });

  it("drops a removed place's build frames, and every pull starts the frames over, since a host that restarted mid-build holds no build to end them", () => {
    const apply = useStore.getState().applyEvent;
    useStore.setState({ goldenFrames: {} });
    apply({ type: "golden.stage", name: "default", stage: "installing-tools", place: "p_1" });
    apply({ type: "golden.stage", name: "default", stage: "installing-tools", place: "box" });
    apply({ type: "place.removed", placeId: "p_1" });
    expect(Object.keys(useStore.getState().goldenFrames)).toEqual(["box"]);
    useStore.getState().bind(fakeApi([], []).api);
    expect(useStore.getState().goldenFrames).toEqual({});
  });

  it("stamps an image line's elapsed from the moment the create was asked, so the log's right column grows", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-12T09:27:00.000Z"));
      useStore.setState({ places: [HERE_PLACE, HETZNER_PLACE], creations: [], api: null });
      // The row is made by hand: what is measured is the clock, not the road that asked.
      useStore.setState({ creations: [{ key: "c1", name: "spoo-fix", askedAt: Date.now(), where: "p_1", workspaceId: null, lines: [], failed: null }] });
      vi.advanceTimersByTime(4_100);
      useStore.getState().applyEvent({ type: "golden.stage", name: "default", stage: "installing-harness", place: "hetzner" });
      vi.advanceTimersByTime(108_000);
      useStore.getState().applyEvent({ type: "golden.stage", name: "default", stage: "snapshotting", place: "hetzner" });
      expect(useStore.getState().creations[0]!.lines.map(l => l.elapsedMs)).toEqual([4_100, 112_100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply that lands before the created event finishes the row from the reply, and carries its notice as the toast", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    api.createWorkspace = async () => ({ ...view("ws_new"), notice: "Stopped the builder kept from image v1 to make room at the machine cap." });
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("pr_1", "beta")).toBe("ws_new");
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_new");
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_new"]);
    expect(lastNotice()).toBe("Stopped the builder kept from image v1 to make room at the machine cap.");
    emit({ type: "workspace.created", workspace: view("ws_new") });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_new"]);
  });

  it("a refusal keeps the row with the failing line and the explanation; retry starts the same name over under the same key; dismiss drops it", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    const calls: Array<[string, string]> = [];
    api.createWorkspace = async (project, name) => {
      calls.push([project, name]);
      if (calls.length === 1) {
        emit(stage());
        emit(stage({ stage: "failed", message: "Sandbox limit reached (2)", elapsedMs: 900 }));
        throw new RequestError("Sandbox limit reached (2)", "concurrency");
      }
      return view("ws_new");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("pr_1", "beta")).toBeNull();
    const failed = useStore.getState().creations[0]!;
    expect(failed.failed?.title).toBe("The provider refused: no more tasks can run there now");
    expect(failed.lines.map(l => l.stage)).toEqual(["fork-requested", "failed"]);
    expect(useStore.getState().selectedId).toBe(failed.key);

    await useStore.getState().retryCreation(failed.key);
    // The retry asks for the same work on the same project, under the same row.
    expect(calls).toEqual([["pr_1", "beta"], ["pr_1", "beta"]]);
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_new");

    api.createWorkspace = async () => { throw new Error("no golden image yet"); };
    await useStore.getState().createWorkspace("pr_1", "gamma");
    const again = useStore.getState().creations[0]!;
    expect(again.failed).toEqual({ title: "Could not create the task", detail: "no golden image yet" });
    // No failed stage arrived, so the refusal is the failing line.
    expect(again.lines.map(l => [l.stage, l.message])).toEqual([["failed", "no golden image yet"]]);
    useStore.getState().dismissCreation(again.key);
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("createWorkspace with a project image forks that image instead of the computer's head, and a retry keeps it", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    const calls: Array<[string, string, string | undefined]> = [];
    api.createWorkspace = async (project, name, picked) => {
      calls.push([project, name, picked?.golden]);
      if (calls.length === 1) {
        emit(stage({ name: "proj-fork" }));
        emit(stage({ name: "proj-fork", stage: "failed", message: "Sandbox limit reached (2)", elapsedMs: 900 }));
        throw new RequestError("Sandbox limit reached (2)", "concurrency");
      }
      return view("ws_new");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("pr_1", "proj-fork", { golden: "snap_project" })).toBeNull();
    const failed = useStore.getState().creations[0]!;
    await useStore.getState().retryCreation(failed.key);
    expect(calls).toEqual([["pr_1", "proj-fork", "snap_project"], ["pr_1", "proj-fork", "snap_project"]]);
    expect(useStore.getState().selectedId).toBe("ws_new");
  });

  it("a create another client started shows up from its stage events and leaves on created without moving the selection", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().selectedId).toBe("ws_a");
    emit(stage({ workspaceId: "ws_far", name: "far" }));
    emit(stage({ workspaceId: "ws_far", name: "far", stage: "hostname-set", message: "hostname set to far" }));
    expect(useStore.getState().creations).toEqual([expect.objectContaining({ key: "creating:ws_far", name: "far", workspaceId: "ws_far", failed: null })]);
    expect(useStore.getState().creations[0]!.lines).toHaveLength(2);
    emit(stage({ workspaceId: "ws_far", name: "far", stage: "failed", message: "boom" }));
    expect(useStore.getState().creations[0]!.failed).toEqual({ title: "Could not create the task", detail: "boom" });
    emit({ type: "workspace.created", workspace: view("ws_far") });
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("asks the runtime whatever the image says: a project on this computer forks nothing, and a refusal is the runtime's own on the creation view", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    const asked: string[] = [];
    api.getGolden = async () => undefined;
    api.createWorkspace = async (_project: string, name: string) => {
      asked.push(name);
      return view("ws_new");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("pr_1", "beta")).toBe("ws_new");
    expect(asked).toEqual(["beta"]);
    // Nothing is said before the ask: no toast, and no row held back on where an image stands.
    expect(lastNotice()).toBeNull();
  });
});

describe("store sessions", () => {
  it("refresh loads every session once and groups rows by workspace", async () => {
    const rows: SessionView[] = [
      { id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed", claudeSessionId: "c1" },
      { id: "s2", workspaceId: "ws_b", harness: "claude", status: "running", claudeSessionId: "c2" },
    ];
    const { api, listCalls } = fakeApi([view("ws_a"), view("ws_b")], rows);
    useStore.getState().bind(api);
    await flush();
    expect(listCalls).toEqual([undefined]);
    expect(useStore.getState().sessions).toEqual({ "ws_a": [rows[0]], "ws_b": [rows[1]] });
    expect(useStore.getState().capabilities).toEqual(CAPS);
  });

  it("session.start remembers the claude session id on the workspace and refetches that workspace's rows", async () => {
    const sessions: SessionView[] = [];
    const { api, emit, listCalls } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    sessions.push({ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" });
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "c1", model: "claude-sonnet-4-5" });
    expect(useStore.getState().workspaces[0]!.claudeSessionId).toBe("c1");
    await flush();
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]).toEqual(sessions);
  });

  it("holds a send the runtime has no row for and drops it only once the rows that replace it are in", async () => {
    const sessions: SessionView[] = [];
    const { api, emit } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();

    useStore.getState().launching("ws_a", { requestId: "r1", title: "read the port list", harness: "claude" });
    expect(useStore.getState().launches["ws_a"]?.title).toBe("read the port list");

    sessions.push({ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" });
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "c1" });
    // The rows land first: dropping the send before them would leave the workspace reading as having no thread at
    // all in the moment between the two.
    expect(useStore.getState().launches["ws_a"]).toBeDefined();
    await flush();
    expect(useStore.getState().sessions["ws_a"]).toEqual(sessions);
    expect(useStore.getState().launches["ws_a"]).toBeUndefined();
  });

  it("a refresh answers which threads there are, so a send the runtime has since written a row for stops standing twice", async () => {
    const sessions: SessionView[] = [];
    const { api } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    useStore.getState().launching("ws_a", { requestId: "r1", title: "read the port list", harness: "claude" });

    // The socket dropped and came back with a gap: the runtime wrote the thread's row while this client was away,
    // and a reconnect that left the send standing would draw the same thread twice.
    sessions.push({ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" });
    await useStore.getState().refresh();
    expect(useStore.getState().sessions["ws_a"]).toHaveLength(1);
    expect(useStore.getState().launches["ws_a"]).toBeUndefined();
  });

  it("keeps the sends in flight when the runtime refused the list, which answered no thread at all", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    useStore.getState().launching("ws_a", { requestId: "r1", title: "read the port list", harness: "claude" });
    api.listSessions = async () => { throw new Error("no"); };
    await useStore.getState().refresh();
    expect(useStore.getState().launches["ws_a"]?.requestId).toBe("r1");
  });

  it("drops a send by its own request id, so a refusal landing late leaves the next send's row standing", () => {
    useStore.getState().launching("ws_a", { requestId: "r2", title: "again", harness: "claude" });
    useStore.getState().launched("ws_a", "r1");
    expect(useStore.getState().launches["ws_a"]?.requestId).toBe("r2");
    useStore.getState().launched("ws_a", "r2");
    expect(useStore.getState().launches["ws_a"]).toBeUndefined();
  });

  it("session.done keeps the row running with no round trip; session.end refetches it to the settled status", async () => {
    const sessions: SessionView[] = [
      { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" },
    ];
    const { api, emit, listCalls } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    // The reply is in, but the row stays running until the process exits; a send that met it would be refused.
    emit({ type: "session.done", workspaceId: "ws_a", sessionId: "c1", result: { status: "completed" } });
    expect(useStore.getState().sessions["ws_a"]![0]!.status).toBe("running");
    expect(listCalls).toEqual([]);

    sessions[0]!.status = "completed";
    emit({ type: "session.end", workspaceId: "ws_a", sessionId: "c1", exitCode: 0, sawResult: true });
    await flush();
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.status).toBe("completed");
  });

  it("a prompt opening or closing refetches that workspace's rows, so a sidebar row that is not the open thread's says what it is waiting on", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" }];
    const { api, emit, listCalls } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    const scope = { workspaceId: "ws_a", sessionId: "c1", turnId: "turn_1", threadId: "thr_1" };
    sessions[0]!.asking = "Permission for Bash: Check wsp version";
    emit({ ...scope, type: "session.permission", askId: "ask_1", toolName: "Bash", detail: "Check wsp version", input: "{}", options: [{ id: "allow", label: "Allow", effect: "allow" }] });
    await flush();
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.asking).toBe("Permission for Bash: Check wsp version");

    delete sessions[0]!.asking;
    emit({ ...scope, type: "session.permission.closed", askId: "ask_1", outcome: "allowed", optionId: "allow" });
    await flush();
    expect(listCalls).toEqual(["ws_a", "ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.asking).toBeUndefined();
  });

  it("renameThread names the session through the runtime and reloads that workspace's rows, so the row shows the new name", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed", claudeSessionId: "c1", prompt: "fix the port list", threadId: "thr_1" }];
    const { api, listCalls } = fakeApi([view("ws_a")], sessions);
    const renames: [string, string][] = [];
    api.renameSession = async (sessionId, title) => {
      renames.push([sessionId, title]);
      sessions[0]!.harnessTitle = title;
      return { outcome: "renamed" };
    };
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name he typed" })).toBe(true);
    expect(renames).toEqual([["s1", "the name he typed"]]);
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.harnessTitle).toBe("the name he typed");
    expect(lastNotice()).toBeNull();
  });

  it("wakes a napping machine before the name goes, as the command line's own rename does, and paints the row from the reply", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }];
    const { api } = fakeApi([{ ...view("ws_a"), phase: "napping" }], sessions);
    const order: string[] = [];
    api.wake = async id => {
      order.push("wake");
      return { ...view(id), phase: "running" };
    };
    api.renameSession = async () => {
      order.push("rename");
      return { outcome: "renamed" };
    };
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(true);
    expect(order).toEqual(["wake", "rename"]);
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(lastNotice()).toBeNull();

    // A machine already up is not woken again.
    order.length = 0;
    await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "another name" });
    expect(order).toEqual(["rename"]);
  });

  it("a wake the runtime refused is a toast and no name sent, so the caller can keep what was typed", async () => {
    const { api } = fakeApi([{ ...view("ws_a"), phase: "napping" }], []);
    const sent: string[] = [];
    api.wake = async () => {
      throw new RequestError("Workspace is pausing; it can be woken once it is paused");
    };
    api.renameSession = async (_id, title) => {
      sent.push(title);
      return { outcome: "renamed" };
    };
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(sent).toEqual([]);
    expect(lastNotice()).toBe("the name: Workspace is pausing; it can be woken once it is paused");
  });

  it("a rename the runtime named nothing for is a toast in the agent's words, and no reload", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }];
    const { api, listCalls } = fakeApi([view("ws_a")], sessions);
    api.renameSession = async () => ({ outcome: "no-session" });
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(lastNotice()).toBe("Claude Code on the task has no session for this thread yet");
    expect(listCalls).toEqual([]);
  });

  it("a write the store refused is a toast in the machine's own line, never a sentence about which sessions it has", async () => {
    const { api } = fakeApi([view("ws_a")], [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }]);
    api.renameSession = async () => ({ outcome: "failed", error: "database is locked" });
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(lastNotice()).toBe("database is locked");
  });

  it("a rename the socket refused is a toast under the name, and a dropped socket says nothing", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.renameSession = async () => {
      throw new RequestError("the runtime refused it");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(lastNotice()).toBe("the name: the runtime refused it");

    api.renameSession = async () => {
      throw new DisconnectedError("lost");
    };
    clearNotices();
    await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" });
    expect(lastNotice()).toBeNull();
  });

  it("workspace.deleted drops the workspace's rows", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }];
    const { api, emit } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.deleted", workspaceId: "ws_a" });
    expect(useStore.getState().sessions).toEqual({});
  });
});

describe("store connection", () => {
  it("starts connecting and mirrors what the client reports", () => {
    expect(useStore.getState().conn).toBe("connecting");
    useStore.getState().setConn("reconnecting");
    expect(useStore.getState().conn).toBe("reconnecting");
  });

  it("live with an api bound pulls the workspace list and the status snapshot again", async () => {
    const workspaces = [view("ws_a")];
    const { api, pulls } = fakeApi(workspaces, []);
    useStore.getState().bind(api);
    await flush();
    expect(pulls).toEqual({ workspaces: 1, statuses: 1 });

    workspaces.push(view("ws_b"));
    useStore.getState().setConn("reconnecting");
    useStore.getState().setConn("live");
    await flush();
    expect(pulls).toEqual({ workspaces: 2, statuses: 2 });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_b"]);
    expect(Object.keys(useStore.getState().statuses)).toEqual(["ws_a", "ws_b"]);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("a setup read that answers after a newer job's view never puts the older job back", async () => {
    const ended = { id: "init_1", road: "manual", phase: "cancelled", keys: {}, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 0, total: 0 }, log: [] } as InitJob;
    const fresh: InitJob = { ...ended, id: "init_2", phase: "reading" };
    const { api, emit } = fakeApi([], []);
    let answer: () => void = () => {};
    api.initGet = () => new Promise(r => (answer = () => r({ keys: {}, home: "/Users/dev", agents: [], pricing: null, job: ended })));
    useStore.getState().bind(api);
    // Start over ended one job and the next one is already reading, so its view lands before the read of the setup.
    emit({ type: "init.job", job: fresh });
    expect(useStore.getState().initJob?.id).toBe("init_2");
    answer();
    await flush();
    expect(useStore.getState().initJob?.id).toBe("init_2");
  });

  it("live before anything is bound pulls nothing", () => {
    useStore.getState().setConn("live");
    expect(useStore.getState().conn).toBe("live");
    expect(useStore.getState().api).toBeNull();
  });

  it("an optimistic toggle cut off by the drop reverts without a toast; the banner already says it", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.nap = async () => {
      throw new DisconnectedError("lost");
    };
    useStore.getState().bind(api);
    await flush();
    const toggling = useStore.getState().toggle("ws_a");
    expect(useStore.getState().workspaces[0]!.phase).toBe("pausing");
    await toggling;
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(lastNotice()).toBeNull();
  });
});

describe("the projects a workspace is made of", () => {
  const SPOO: ProjectView = { id: "pr_1", name: "spoo-landing", computer: "p_1", source: { kind: "git", url: "https://github.com/dev/spoo.git" }, path: "/root/spoo-landing", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-root-spoo-landing", memoryDir: "/var/lib/wsp/projects/pr_1/memory", createdAt: "t" };
  const WSP: ProjectView = { id: "pr_2", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", remote: "https://github.com/dev/wsp.git", defaultBranch: "main", memoryKey: "-Users-dev-wsp", memoryDir: "/Users/dev/.claude/projects/-Users-dev-wsp/memory", createdAt: "t" };

  it("are read at bind and kept by the two project events: one added shows, one removed goes, and an id nothing holds leaves the list as it was", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.projectsList = async () => [SPOO];
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().projects.map(p => p.id)).toEqual(["pr_1"]);

    // A project recorded anywhere, by this app or by the command line, lands here off the host's own event.
    useStore.getState().applyEvent({ type: "project.added", project: WSP });
    expect(useStore.getState().projects.map(p => p.id)).toEqual(["pr_1", "pr_2"]);
    expect(useStore.getState().projects.find(p => p.id === "pr_2")).toEqual(WSP);
    // The same project again is the record as it now stands, never a second row of it.
    useStore.getState().applyEvent({ type: "project.added", project: { ...WSP, name: "wsp-renamed" } });
    expect(useStore.getState().projects.map(p => p.name)).toEqual(["spoo-landing", "wsp-renamed"]);

    useStore.getState().applyEvent({ type: "project.removed", projectId: "pr_1" });
    expect(useStore.getState().projects.map(p => p.id)).toEqual(["pr_2"]);
    // An id this app holds no record for changes nothing: the list is what the host said, not what an event guessed.
    useStore.getState().applyEvent({ type: "project.removed", projectId: "pr_nobody" });
    expect(useStore.getState().projects.map(p => p.id)).toEqual(["pr_2"]);
  });

  it("a host whose wire carries no project list leaves the list empty rather than waiting on a reply that is never coming", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    delete api.projectsList;
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().projects).toEqual([]);
  });
});

describe("store workspaces", () => {
  it("a refused nap reverts the optimistic phase and toasts the reason", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.nap = async () => {
      throw new Error("backend said no");
    };
    useStore.getState().bind(api);
    await flush();
    const toggling = useStore.getState().toggle("ws_a");
    expect(useStore.getState().workspaces[0]!.phase).toBe("pausing");
    await toggling;
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(lastNotice()).toContain("backend said no");
  });

  it("wake paints waking and calls the api; on a running workspace it does nothing; toggle wakes a pausing one after the nap", async () => {
    const { api } = fakeApi([view("ws_a"), { ...view("ws_b"), phase: "napping" }], []);
    const calls: string[] = [];
    api.wake = async id => { calls.push(`wake:${id}`); return view(id); };
    api.nap = async id => { calls.push(`nap:${id}`); return { ...view(id), phase: "napping" }; };
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().wake("ws_a");
    expect(calls).toEqual([]);
    const waking = useStore.getState().wake("ws_b");
    expect(useStore.getState().workspaces[1]!.phase).toBe("waking");
    await waking;
    expect(calls).toEqual(["wake:ws_b"]);
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual(["wake:ws_b", "nap:ws_a"]);
  });

  it("the one slot stops a wake the host is still asking the provider for, and paints the record it hands back", async () => {
    const { api } = fakeApi([{ ...view("ws_a"), phase: "waking" }], []);
    const calls: string[] = [];
    api.stopWake = async id => {
      calls.push(`stopWake:${id}`);
      return { ...view(id), phase: "napping" };
    };
    api.nap = async id => { calls.push(`nap:${id}`); return { ...view(id), phase: "napping" }; };
    api.wake = async id => { calls.push(`wake:${id}`); return view(id); };
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual(["stopWake:ws_a"]);
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    // And that record now offers the wake again, which is the slot's other word.
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual(["stopWake:ws_a", "wake:ws_a"]);
  });

  it("a client with no stop leaves the wake alone rather than napping the machine under it", async () => {
    const { api } = fakeApi([{ ...view("ws_a"), phase: "waking" }], []);
    const calls: string[] = [];
    api.nap = async id => { calls.push(`nap:${id}`); return { ...view(id), phase: "napping" }; };
    api.wake = async id => { calls.push(`wake:${id}`); return view(id); };
    delete api.stopWake;
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual([]);
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
  });

  it("napped carries the phase; woken and upgraded carry the phase and the new machine", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.napped", workspaceId: "ws_a" });
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    expect(useStore.getState().statuses["ws_a"]?.phase).toBe("napping");
    emit({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m2", resurrected: true });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m2" });
    emit({ type: "workspace.upgraded", workspaceId: "ws_a", machineId: "m3" });
    expect(useStore.getState().workspaces[0]!.machineId).toBe("m3");
    expect(useStore.getState().statuses["ws_a"]?.machineId).toBe("m3");
  });

  it("renamed carries the name onto the row and its status, and moves nothing about the machine", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    const was = useStore.getState().statuses["ws_a"]!;
    emit({ type: "workspace.renamed", workspaceId: "ws_a", name: "the name he typed" });
    expect(useStore.getState().workspaces[0]!.name).toBe("the name he typed");
    expect(useStore.getState().statuses["ws_a"]).toMatchObject({ name: "the name he typed", phase: was.phase, machineId: was.machineId, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, machineState: was.machineState });
    // A workspace no row holds is not invented by a name.
    emit({ type: "workspace.renamed", workspaceId: "ws_gone", name: "nobody" });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a"]);
    expect(useStore.getState().statuses["ws_gone"]).toBeUndefined();
  });

  it("the look lands on the row and its status, and a cleared fact leaves rather than lingering under the merge", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.look", workspaceId: "ws_a", theme: DEFAULT_THEME, glyph: "flask" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ theme: DEFAULT_THEME, glyph: "flask" });
    expect(useStore.getState().statuses["ws_a"]).toMatchObject({ theme: DEFAULT_THEME, glyph: "flask" });
    // Clearing one is a null, not a missing key, so the row loses it instead of keeping the old theme.
    emit({ type: "workspace.look", workspaceId: "ws_a", theme: null, glyph: "flask" });
    expect(useStore.getState().workspaces[0]!).not.toHaveProperty("theme");
    expect(useStore.getState().statuses["ws_a"]).not.toHaveProperty("theme");
    expect(useStore.getState().workspaces[0]!.glyph).toBe("flask");
    // A workspace no row holds is not invented by a look.
    emit({ type: "workspace.look", workspaceId: "ws_gone", theme: DEFAULT_THEME, glyph: null });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a"]);
    expect(useStore.getState().statuses["ws_gone"]).toBeUndefined();
  });

  it("setWorkspaceLook sends the one fact a picker changed and puts what the runtime answers with on the row", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    const looked = { ...view("ws_a"), theme: DEFAULT_THEME };
    const calls: unknown[][] = [];
    api.setWorkspaceLook = async (...args) => { calls.push(args); return looked; };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().setWorkspaceLook({ workspaceId: "ws_a", look: { theme: DEFAULT_THEME } })).toBe(true);
    expect(calls).toEqual([["ws_a", { theme: DEFAULT_THEME }]]);
    expect(useStore.getState().workspaces[0]!.theme).toEqual(DEFAULT_THEME);
    // A refusal is a toast and a false, and the row keeps what it had.
    api.setWorkspaceLook = async () => { throw new Error("the host said no"); };
    expect(await useStore.getState().setWorkspaceLook({ workspaceId: "ws_a", look: { theme: null } })).toBe(false);
    expect(lastNotice()).toBe("the host said no");
    expect(useStore.getState().workspaces[0]!.theme).toEqual(DEFAULT_THEME);
    // A client without the verb takes no pick at all.
    delete api.setWorkspaceLook;
    expect(await useStore.getState().setWorkspaceLook({ workspaceId: "ws_a", look: { glyph: "bug" } })).toBe(false);
  });

  it("gone carries the phase and the provider's words onto the view and its status", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.gone", workspaceId: "ws_a", machineId: "m1", reason: "machine m1 is gone at the provider: Not found" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "gone", gone: "machine m1 is gone at the provider: Not found" });
    emit({ type: "workspace.upgraded", workspaceId: "ws_a", machineId: "m2" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m2" });
    expect(useStore.getState().workspaces[0]!.gone).toBeUndefined();
  });

  it("a record that leaves gone drops the words with it, on the view and on its status", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.gone", workspaceId: "ws_a", machineId: "m1", reason: "machine m1 is gone at the provider: Not found" });
    expect(useStore.getState().workspaces[0]!.gone).toBe("machine m1 is gone at the provider: Not found");
    // The verdict did not hold: the machine was there all along, so nothing is left saying it was not.
    emit({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m1", resurrected: false });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m1" });
    expect(useStore.getState().workspaces[0]!.gone).toBeUndefined();
  });

  it("session.start counts spending and workspace.deleted prunes it", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "s1" });
    expect(useStore.getState().spending["ws_a"]).toBe(1);
    emit({ type: "session.end", workspaceId: "ws_a", sessionId: "s1", exitCode: 0, sawResult: true });
    expect(useStore.getState().spending["ws_a"]).toBe(0);
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "s2" });
    emit({ type: "workspace.deleted", workspaceId: "ws_a" });
    expect(useStore.getState().spending["ws_a"]).toBeUndefined();
  });

  it("a failed status subscription becomes a toast instead of silence", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.watchStatuses = async () => {
      throw new Error("runtime unreachable");
    };
    useStore.getState().bind(api);
    await flush();
    expect(lastNotice()).toContain("runtime unreachable");
  });
});

describe("store replay gaps", () => {
  it("noteGap counts every reconnect the runtime could not replay, so history readers know to reload", () => {
    expect(useStore.getState().gaps).toBe(0);
    useStore.getState().noteGap();
    useStore.getState().noteGap();
    expect(useStore.getState().gaps).toBe(2);
  });
});

// Last in the file on purpose: it runs after every test that set an address, so it fails if one was left behind.
describe("the address never leaks out of the tests that set it", () => {
  it("a refresh with no address of its own still takes the first row", async () => {
    const { api } = fakeApi([view("ws_a"), view("ws_b")], []);
    useStore.setState({ api });
    await useStore.getState().refresh();
    expect(useStore.getState().selectedId).toBe("ws_a");
  });
});

describe("the newest release in the store", () => {
  const view = (version: string): ReleaseView => ({ state: "read", latest: { version, tag: `v${version}`, url: `https://github.com/Zingzy/wsp/releases/tag/v${version}`, publishedAt: "2026-09-24T00:00:00Z" }, shape: "app" });

  it("is read on bind and again on every reconnect, since release.changed is never replayed, and follows the event between", async () => {
    const { api, emit } = fakeApi([], []);
    const answers = [view("0.2.0"), view("0.3.0")];
    let reads = 0;
    useStore.setState({ release: null });
    useStore.getState().bind({ ...api, releaseGet: async () => answers[reads++]! });
    await flush();
    expect(reads).toBe(1);
    expect(useStore.getState().release).toEqual(view("0.2.0"));
    emit({ type: "release.changed", release: view("0.2.1") });
    expect(useStore.getState().release).toEqual(view("0.2.1"));
    useStore.getState().setConn("reconnecting");
    useStore.getState().setConn("live");
    await flush();
    expect(reads).toBe(2);
    expect(useStore.getState().release).toEqual(view("0.3.0"));
  });

  it("stays unread under a host that does not answer the op", async () => {
    const { api } = fakeApi([], []);
    useStore.setState({ release: null });
    useStore.getState().bind({ ...api, releaseGet: async () => Promise.reject(new Error("unknown op release.get")) });
    await flush();
    expect(useStore.getState().release).toBeNull();
  });
});
