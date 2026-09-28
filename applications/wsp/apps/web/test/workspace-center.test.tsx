// SPDX-License-Identifier: AGPL-3.0-only
// The center region under the shell header: the selected workspace's thread
// with its composer and the terminal drawer under it, or a project's home.
// Nothing stands between the header and the thread.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTNAME_KEPT, type EventUnion, type GoldenManifest, type WorkspaceView } from "@wsp/protocol";
import { localZoneLabel } from "../src/lib/timestampFormat.js";
import { Shell } from "../src/App.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals } from "../src/terminal/link.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

const WS = "ws_center";
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }],
};

function fakeApi(workspaces: WorkspaceView[]): Api {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => manifest,
  };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, creations: [], sessions: {}, ready: false, gaps: 0 });
  clearNotices();
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});
afterEach(() => {
  cleanup();
  provideTerminals(WS, null);
});

async function mount(workspaces: WorkspaceView[]) {
  useStore.getState().bind(fakeApi(workspaces));
  render(<Shell />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
}

describe("workspace center", () => {
  it("the selected workspace's center is its thread with the composer, and no tab strip stands in front", async () => {
    await mount([workspace]);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("What should we build in");
    expect(heading.textContent).toContain("api");
    expect(screen.getByTestId("composer-editor")).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "screen" })).toBeNull();
  });

  it("the terminal drawer opens under the thread and says so while the workspace's link is not live", async () => {
    provideTerminals(WS, new WorkspaceTerminals({ request: () => Promise.reject(new Error("no daemon in this test")) }));
    await mount([workspace]);
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector('[data-terminal-owner="drawer"]')).toBeNull();
    act(() => useTerminalDrawerStore.getState().toggle(WS));
    const drawer = document.querySelector('[data-terminal-owner="drawer"]');
    expect(drawer).not.toBeNull();
    // The link here has never been open, so the drawer says what is being started rather than promising a return.
    expect(drawer!.textContent).toContain("Starting a terminal on api; the first one opens when it is ready");
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
  });

  it("with a project recorded and no workspace the center is that project's home instead of a strip or a line that asks for a pick", async () => {
    await mount([]);
    act(() => useStore.setState({ projects: [{ id: "pr_1", name: "the-project", computer: "here", source: { kind: "folder", path: "/root" }, path: "/root", remote: "https://github.com/dev/the-project.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" }] }));
    await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
    expect(screen.queryByText("Pick a workspace to continue")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("workspace creation view", () => {
  const stage = (over: Partial<Extract<EventUnion, { type: "workspace.creating" }>>): EventUnion => ({
    type: "workspace.creating",
    workspaceId: "ws_beta",
    name: "beta",
    stage: "fork-requested",
    message: "starting beta on ascii",
    elapsedMs: 0,
    ...over,
  });
  const emit = (e: EventUnion) => act(() => useStore.getState().applyEvent(e));

  it("creating opens the view in the center with the name, a moving wave and the log growing with timestamps; created swaps in the thread", async () => {
    let finish!: (w: WorkspaceView) => void;
    const api = fakeApi([workspace]);
    api.createWorkspace = () => new Promise<WorkspaceView>(resolve => { finish = resolve; });
    useStore.getState().bind(api);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    void useStore.getState().createWorkspace("pr_1", "beta");
    const view = await screen.findByTestId("workspace-creation");
    expect(view.getAttribute("aria-busy")).toBe("true");
    expect(within(view).getByRole("heading", { level: 1 }).textContent).toBe("beta");
    expect(screen.getByRole("banner").textContent).toContain("beta");
    // The compose glyph stays and is held: a creation is not yet a workspace to open a thread in.
    expect(screen.getByRole("button", { name: "New thread" }).getAttribute("aria-disabled")).toBe("true");
    const wave = within(view).getByRole("progressbar", { name: "Creating" });
    expect(wave.querySelector("svg")!.getAttribute("data-state")).toBe("moving");
    expect(wave.querySelector("pattern path")!.getAttribute("stroke")).toBe("currentColor");
    const log = within(view).getByRole("list", { name: "Creation log" });
    expect(log.textContent).toContain("Asking wsp to start it.");

    emit(stage({}));
    emit(stage({ stage: "preview-route", message: "Preview route to the daemon minted.", elapsedMs: 3_400 }));
    emit(stage({ stage: "hostname-set", message: HOSTNAME_KEPT, elapsedMs: 5_100, detail: "hostname beta on m1 failed: read-only" }));
    const lines = within(log).getAllByRole("listitem");
    expect(lines.map(l => l.textContent)).toEqual([
      expect.stringMatching(/^\d\d:\d\d:\d\dstarting beta on ascii0\.0s$/),
      expect.stringMatching(/^\d\d:\d\d:\d\dPreview route to the daemon minted\.3\.4s$/),
      expect.stringMatching(new RegExp(`^\\d\\d:\\d\\d:\\d\\d${HOSTNAME_KEPT}5\\.1s$`)),
    ]);
    // The guest's own words stand on the line's title and nowhere a person reads a sentence.
    expect(lines[2]!.querySelector("span")!.getAttribute("title")).toBe("hostname beta on m1 failed: read-only");
    expect(view.textContent).not.toContain("read-only");
    // Which clock the log is on, said once, in the zone this window is in.
    expect(within(view).getByTestId("creation-clock").textContent).toBe(`clock in ${localZoneLabel()}`);
    expect(lines.map(l => l.querySelector("time")!.getAttribute("datetime")).every(iso => !Number.isNaN(Date.parse(iso!)))).toBe(true);
    expect(lines[2]!.className).toContain("text-foreground");
    expect(lines[0]!.className).toContain("text-muted-foreground");
    expect(within(view).queryByRole("button", { name: "Retry" })).toBeNull();

    const created: WorkspaceView = { ...workspace, id: "ws_beta", name: "beta" };
    emit({ type: "workspace.created", workspace: created });
    await act(async () => { finish(created); });
    await waitFor(() => expect(screen.queryByTestId("workspace-creation")).toBeNull());
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("What should we build in");
    expect(heading.textContent).toContain("beta");
    expect(screen.getByRole("button", { name: "New thread" })).toBeDefined();
  });

  it("a failure keeps the log with the failing line in red, stops the wave, explains the refusal, and retry runs the create again", async () => {
    const CAP_LINE = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";
    const api = fakeApi([workspace]);
    const create = vi.fn<(name: string) => Promise<WorkspaceView>>();
    create.mockImplementationOnce(async () => {
      useStore.getState().applyEvent(stage({}));
      useStore.getState().applyEvent(stage({ stage: "failed", message: CAP_LINE, elapsedMs: 800 }));
      throw new RequestError(CAP_LINE, "concurrency");
    });
    create.mockImplementation(() => new Promise<WorkspaceView>(() => {}));
    api.createWorkspace = create;
    useStore.getState().bind(api);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    await act(() => useStore.getState().createWorkspace("pr_1", "beta"));
    const view = await screen.findByTestId("workspace-creation");
    expect(view.getAttribute("aria-busy")).toBe("false");
    expect(view.textContent).toContain("Creation failed");
    const wave = within(view).getByRole("progressbar", { name: "Creation stopped" });
    expect(wave.querySelector("svg")!.getAttribute("data-state")).toBe("stopped");
    const lines = within(within(view).getByRole("list", { name: "Creation log" })).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.textContent).toContain(CAP_LINE);
    expect(lines[1]!.className).toContain("text-destructive-foreground");
    expect(lines[0]!.className).not.toContain("text-destructive-foreground");
    // The runtime's words are the refusal: they appear once, on the failing line, and no second wording follows the title.
    const lead = within(view).getByText("The provider refused: no more tasks can run there now");
    expect(lead.nextElementSibling).toBeNull();
    expect(view.textContent!.split(CAP_LINE)).toHaveLength(2);

    fireEvent.click(within(view).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    // The retry goes back to the same project, with the same size: a retry is the create again, not a new one.
    expect(create).toHaveBeenLastCalledWith("pr_1", "beta", {});
    await waitFor(() => expect(screen.getByTestId("workspace-creation").getAttribute("aria-busy")).toBe("true"));
    expect(within(screen.getByTestId("workspace-creation")).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("dismissing a failed creation returns the center to the first workspace", async () => {
    const api = fakeApi([workspace]);
    api.createWorkspace = async () => { throw new Error("no golden image yet"); };
    useStore.getState().bind(api);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    await act(() => useStore.getState().createWorkspace("pr_1", "beta"));
    const view = await screen.findByTestId("workspace-creation");
    expect(view.textContent).toContain("no golden image yet");
    fireEvent.click(within(view).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("workspace-creation")).toBeNull());
    expect(useStore.getState().selectedId).toBe(WS);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("api");
  });
});
