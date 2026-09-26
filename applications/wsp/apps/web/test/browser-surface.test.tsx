// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's browser surface against a fake api: fixture ports arrive
// as protocol events, routes come from a fake portReach. No daemon, no cloud.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kindWords, noPreviewRouteLine, type EventUnion, type WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { MOVED_WINDOW_MS } from "../src/adapt/ports.js";
import { resetBrowsers } from "../src/browser/model.js";
import { REACH_REASK_FLOOR_MS, REACH_REFRESH_WITH_MS_LEFT } from "../src/browser/reach.js";
import { resetBrowserTabs, useBrowserTabs } from "../src/browser/tabs.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const WS = "ws_browser01";
const OTHER = "ws_other0002";

const workspace = (id: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const PUBLIC = (port: number, token = "e") => `https://m1-${port}.preview.example/?pt_token=${token}`;
const SHOWN = (port: number, path = "") => `localhost:${port}${path}`;
const mint: Api["portReach"] = async (_id, port) => ({ url: PUBLIC(port), expiresAt: Date.now() + 3_600_000 });

function fakeApi(workspaces: WorkspaceView[], portReach: Api["portReach"] = mint, portProbe?: Api["portProbe"]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    ...(portProbe !== undefined ? { portProbe } : {}),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    portReach,
    daemon: noDaemonApi,
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

const open = (workspaceId: string, port: number, pid?: number, process?: string): EventUnion =>
  ({ type: "port.open", workspaceId, port, ...(pid !== undefined ? { pid } : {}), ...(process !== undefined ? { process } : {}) });
const close = (workspaceId: string, port: number, detail: Partial<Extract<EventUnion, { type: "port.close" }>> = {}): EventUnion => ({ type: "port.close", workspaceId, port, ...detail });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Harness({ workspaceId }: { workspaceId: string }) {
  const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, workspaceId));
  return <RightPanel workspaceId={workspaceId} state={state} mode="inline" />;
}

async function setup(opts: { portReach?: Api["portReach"]; portProbe?: Api["portProbe"]; workspaces?: WorkspaceView[]; openBrowser?: boolean } = {}) {
  const { api, emit } = fakeApi(opts.workspaces ?? [workspace(WS)], opts.portReach, opts.portProbe);
  await act(async () => { useStore.getState().bind(api); });
  if (opts.openBrowser !== false) act(() => useRightPanelStore.getState().open(WS, "preview"));
  const view = render(<Harness workspaceId={WS} />);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  return { emit, view, api };
}

const address = () => screen.getByPlaceholderText("Search or enter URL") as HTMLInputElement;
const frame = (port: number) => screen.getByTitle(`:${port}`);
const serverCard = (port: number) => screen.getByRole("button", { name: new RegExp(`^\\S+ localhost:${port}$`) });

beforeEach(() => {
  window.localStorage.clear();
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  cleanup();
  resetBrowsers();
  resetBrowserTabs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("availability", () => {
  it("the picker offers the browser while the workspace runs and greys it out otherwise", async () => {
    await setup({ openBrowser: false });
    expect(screen.getByRole("button", { name: /Browser/ })).toBeDefined();
    cleanup();
    resetBrowsers();
    await setup({ openBrowser: false, workspaces: [workspace(WS, "napping")] });
    expect(screen.queryByRole("button", { name: /Browser/ })).toBeNull();
    // The terminal card carries the same hint once the workspace naps, so match by count.
    expect(screen.getAllByText("Available while the task is running.").length).toBeGreaterThan(0);
  });
});

describe("servers list", () => {
  it("starts on the empty state and says so", async () => {
    await setup();
    expect(screen.getByText("No preview yet")).toBeDefined();
    expect(address().value).toBe("");
  });

  it("lists each listening port with its process and host:port, and no dot; port.close removes it", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173, 4182, "node"));
    emit(open(WS, 8080));
    const card = serverCard(5173);
    expect(card.textContent).toContain("node");
    expect(card.textContent).toContain("localhost:5173");
    // Every row here is a port that is listening, so a dot on each says nothing the row does not.
    expect(card.querySelector('[data-slot="live-dot"]')).toBeNull();
    expect(serverCard(8080).textContent).toContain("Listening");
    emit(close(WS, 8080));
    expect(screen.queryByRole("button", { name: /localhost:8080/ })).toBeNull();
    expect(screen.queryByText("No preview yet")).toBeNull();
  });

  it("a repeated port.open does not duplicate the card, and another workspace's ports never show", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    emit(open(WS, 5173));
    emit(open(OTHER, 9999));
    expect(screen.getAllByRole("button", { name: /localhost:5173/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /localhost:9999/ })).toBeNull();
  });
});

describe("framing a port", () => {
  it("opening a server frames its public route, elides the token in the bar and copies the real url", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { emit } = await setup();
    emit(open(WS, 5173, 4182, "node"));
    fireEvent.click(serverCard(5173));

    const f = await screen.findByTitle(":5173");
    expect(f.tagName).toBe("IFRAME");
    expect(f.getAttribute("src")).toBe(PUBLIC(5173));
    expect(f.hasAttribute("sandbox")).toBe(false);
    expect(address().value).toBe(SHOWN(5173));
    expect(address().value).not.toContain("pt_token");

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PUBLIC(5173)));

    expect(screen.getByRole("button", { name: "Close node :5173" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Capture screenshot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Annotate preview" })).toBeNull();
  });

  it("typing a loopback address or a bare port in the bar frames that port", async () => {
    await setup();
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "localhost:3000" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":3000");
    expect(address().value).toBe(SHOWN(3000));

    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "4000" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":4000");
    expect(screen.queryByTitle(":3000")).toBeNull();
  });

  it("a typed path rides on the port's route with the token beside its query; the bar, the tab and the recent carry it", async () => {
    await setup();
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "localhost:3000/about?x=1" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    const f = await screen.findByTitle(":3000");
    expect(f.getAttribute("src")).toBe("https://m1-3000.preview.example/about?pt_token=e&x=1");
    expect(address().value).toBe(SHOWN(3000, "/about?x=1"));
    expect(address().value).not.toContain("pt_token");
    expect(screen.getByRole("button", { name: "Close :3000/about?x=1" })).toBeDefined();

    // A new path on the same port mounts a fresh frame rather than moving a mounted one, which would push a history entry.
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "3000/docs" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await waitFor(() => expect(screen.getByTitle(":3000").getAttribute("src")).toBe("https://m1-3000.preview.example/docs?pt_token=e"));
    expect(screen.getByTitle(":3000")).not.toBe(f);
    expect(address().value).toBe(SHOWN(3000, "/docs"));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /^localhost:3000\/about\?x=1/ }));
    await waitFor(() => expect(screen.getByTitle(":3000").getAttribute("src")).toBe("https://m1-3000.preview.example/about?pt_token=e&x=1"));
  });

  it("back returns to the servers list and forward re-frames the port", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTitle(":5173")).toBeNull();
    expect(serverCard(5173)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await screen.findByTitle(":5173");
  });

  it("asks for a fresh route before the current one expires and swaps the frame onto it", async () => {
    let calls = 0;
    const { emit } = await setup({
      portReach: async (_id, port) => {
        calls++;
        return { url: PUBLIC(port, `t${calls}`), expiresAt: Date.now() + 3_600_000 };
      },
    });
    vi.useFakeTimers();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await act(async () => {});
    const f = frame(5173);
    expect(f.getAttribute("src")).toBe(PUBLIC(5173, "t1"));

    await act(() => vi.advanceTimersByTimeAsync(3_600_000 - REACH_REFRESH_WITH_MS_LEFT - 1));
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(2);
    expect(frame(5173)).toBe(f);
    expect(f.getAttribute("src")).toBe(PUBLIC(5173, "t2"));
  });

  it("a route handed back with under nine minutes left is re-asked no sooner than the floor", async () => {
    let calls = 0;
    const { emit } = await setup({
      portReach: async (_id, port) => {
        calls++;
        return { url: PUBLIC(port, `t${calls}`), expiresAt: Date.now() + 60_000 };
      },
    });
    vi.useFakeTimers();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await act(async () => {});
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(REACH_REASK_FLOOR_MS - 1));
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(2);
  });

  it("keeps the frame when the port stops listening and says so above it", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    emit(close(WS, 5173));
    expect(screen.getByText(":5173 stopped listening")).toBeDefined();
    expect(frame(5173).getAttribute("src")).toBe(PUBLIC(5173));
  });

  it("says when the port stopped and who held it, in the slot above a frame that does not move", async () => {
    const { emit } = await setup();
    emit(open(WS, 8412, 53479, "python3"));
    fireEvent.click(serverCard(8412));
    const first = await screen.findByTitle(":8412");
    const at = "2026-09-05T12:04:00.000Z";
    emit(close(WS, 8412, { pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at }));
    const slot = screen.getByText(/^:8412 stopped listening/);
    expect(slot.textContent).toBe(`:8412 stopped listening at ${clock(at)}, held by python3 -m http.server 8412 (pid 53479), which exited`);
    expect(slot.nextElementSibling).toBe(first);
    expect(frame(8412)).toBe(first);
  });

  it("a long argv is cut to one line in the slot, the full sentence in its title, and the frame stays put", async () => {
    const { emit } = await setup();
    emit(open(WS, 8412, 53479, "node"));
    fireEvent.click(serverCard(8412));
    const first = await screen.findByTitle(":8412");
    const command = `node -e ${"x".repeat(4096)}`;
    emit(close(WS, 8412, { pid: 53479, process: "node", command, exited: true, at: "2026-09-05T12:04:00.000Z" }));
    const slot = screen.getByText(/^:8412 stopped listening/);
    expect(slot.classList.contains("truncate")).toBe(true);
    expect(slot.title).toBe(slot.textContent);
    expect(slot.title).toContain(command);
    expect(slot.nextElementSibling).toBe(first);
    expect(frame(8412)).toBe(first);
  });

  it("adds where the same process came back when it opens another port within a minute, and not after it", async () => {
    const { emit } = await setup();
    emit(open(WS, 8412, 53479, "python3"));
    emit(open(WS, 9000, 700, "ruby"));
    fireEvent.click(serverCard(8412));
    await screen.findByTitle(":8412");
    vi.useFakeTimers();
    emit(close(WS, 8412, { pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: "2026-09-05T12:04:00.000Z" }));
    vi.advanceTimersByTime(30_000);
    emit(open(WS, 8413, 60000, "python3"));
    expect(screen.getByText(/^:8412 stopped listening/).textContent).toMatch(/, which exited, now on :8413$/);
    expect(frame(8412).getAttribute("src")).toBe(PUBLIC(8412));

    // The window is measured on the model's clock, which the fake timers drive.
    emit(close(WS, 9000, { pid: 700, process: "ruby", exited: true, at: "2026-09-05T12:05:00.000Z" }));
    vi.advanceTimersByTime(MOVED_WINDOW_MS + 1);
    emit(open(WS, 9001, 701, "ruby"));
    act(() => useRightPanelStore.getState().openBrowser(WS, null));
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "9000" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    expect(screen.getByText(/^:9000 stopped listening/).textContent).toMatch(/, which exited$/);
  });

  it("when the port listens again after a close, the banner goes, the frame remounts and the route is probed anew", async () => {
    const probed: number[] = [];
    const { emit } = await setup({
      portProbe: async (_id, port) => {
        probed.push(port);
        return { status: 200, body: "<!doctype html>" };
      },
    });
    emit(open(WS, 8412, 100, "node"));
    fireEvent.click(serverCard(8412));
    const first = await screen.findByTitle(":8412");
    await waitFor(() => expect(probed).toEqual([8412]));

    emit(close(WS, 8412));
    expect(screen.getByText(":8412 stopped listening")).toBeDefined();
    expect(frame(8412)).toBe(first);

    emit(open(WS, 8412, 200, "node"));
    expect(screen.queryByText(":8412 stopped listening")).toBeNull();
    await waitFor(() => expect(frame(8412)).not.toBe(first));
    expect(frame(8412).getAttribute("src")).toBe(PUBLIC(8412));
    await waitFor(() => expect(probed).toEqual([8412, 8412]));
    await act(() => new Promise(r => setTimeout(r, 50)));
    expect(probed).toEqual([8412, 8412]);
    expect(Object.values(useBrowserTabs.getState().byWorkspaceId[WS]!).map(t => t.reloadNonce)).toEqual([1]);
  });

  it("a port that came back behind a full-page refusal card is probed again too, and the card goes when the new server allows the host", async () => {
    const probed: number[] = [];
    let blocked = true;
    const { emit } = await setup({
      portProbe: async (_id, port) => {
        probed.push(port);
        return blocked
          ? { status: 403, body: "Blocked request. This host (\"m1-8412.preview.example\") is not allowed." }
          : { status: 200, body: "<!doctype html>" };
      },
    });
    emit(open(WS, 8412, 100, "node"));
    fireEvent.click(serverCard(8412));
    await screen.findByText(":8412 refused the preview host");
    expect(screen.queryByTitle(":8412")).toBeNull();
    expect(probed).toEqual([8412]);

    emit(close(WS, 8412));
    blocked = false;
    emit(open(WS, 8412, 200, "node"));
    await waitFor(() => expect(probed).toEqual([8412, 8412]));
    await screen.findByTitle(":8412");
    expect(screen.queryByText(":8412 refused the preview host")).toBeNull();
  });

  it("says nothing about listening until the daemon has answered; the first word without the port shows the banner", async () => {
    const { emit } = await setup();
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "3000" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":3000");
    expect(screen.queryByText(":3000 stopped listening")).toBeNull();
    emit(open(WS, 4000));
    expect(screen.getByText(":3000 stopped listening")).toBeDefined();
  });

  it("a new tab typed onto a port that is listening frames it with no banner", async () => {
    const { emit } = await setup();
    emit(open(WS, 8412, 200, "node"));
    fireEvent.click(serverCard(8412));
    await screen.findByTitle(":8412");
    act(() => useRightPanelStore.getState().openBrowser(WS, null));
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "8412" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":8412");
    expect(screen.queryByText(":8412 stopped listening")).toBeNull();
  });

  it("a computer that mints no route says so in the person's words, and never in the engine's", async () => {
    const thrown = "machine m1 is on a backend without preview URLs";
    const { emit } = await setup({ portReach: async () => { throw new Error(thrown); } });
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    // The card names the computer and the address that does answer; what the engine threw is about its backends.
    // The computer is named as every other surface names it: this fixture's fork runs at a provider.
    await screen.findByText(noPreviewRouteLine(5173, kindWords("cloud").where!));
    expect(document.body.textContent).not.toContain(thrown);
    expect(document.body.textContent).not.toContain("backend");
    expect(document.body.textContent).not.toMatch(/machine/i);
    expect(screen.queryByTitle(":5173")).toBeNull();
  });

  it("a workspace of this computer is framed on this computer's own address, with no route minted and no card", async () => {
    const asked: number[] = [];
    const { emit, view } = await setup({
      workspaces: [{ ...workspace(WS), kind: "local" }],
      portReach: async (_id, port) => {
        asked.push(port);
        throw new Error("machine m1 is on a backend without preview URLs");
      },
    });
    emit(open(WS, 3111));
    fireEvent.click(serverCard(3111));
    await waitFor(() => expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3111"));
    expect(asked).toEqual([]);
    expect(document.body.textContent).not.toContain("no address this pane can reach");
  });
});

describe("recents", () => {
  it("a framed port becomes a recent on the servers list, keyed by its loopback url, and survives a remount", async () => {
    const { emit, view } = await setup();
    emit(open(WS, 5173, 1, "node"));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Recently used")).toBeDefined();
    const recent = screen.getByRole("button", { name: /^localhost:5173/ });
    expect(recent.textContent).not.toContain("pt_token");

    view.unmount();
    resetBrowserTabs();
    act(() => useRightPanelStore.getState().open(WS, "preview"));
    render(<Harness workspaceId={WS} />);
    expect(screen.getByText("Recently used")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /^localhost:5173/ }));
    await screen.findByTitle(":5173");
  });

  it("a recent can be removed and another workspace's recents stay apart", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove localhost:5173 from history" }));
    expect(screen.queryByText("Recently used")).toBeNull();
    expect(window.localStorage.getItem(`wsp:browser-recents:v1:${OTHER}`)).toBeNull();
  });
});

describe("open on laptop", () => {
  it("a framed port the host forwards offers Open on laptop, which opens localhost:<port> here; a port it does not forward offers nothing", async () => {
    const opened = vi.fn(() => null);
    vi.stubGlobal("open", opened);
    const { emit } = await setup();
    emit(open(WS, 5173, 4182, "node"));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    expect(screen.queryByRole("button", { name: "Open on laptop" })).toBeNull();

    // A sign-in callback on the framed port is not a page to open here.
    emit({ type: "forward.open", forward: { workspaceId: WS, port: 5173, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "callback" } });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Open on laptop" })).toBeNull();
    emit({ type: "forward.open", forward: { workspaceId: WS, port: 5173, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" } });
    fireEvent.click(await screen.findByRole("button", { name: "Open on laptop" }));
    expect(opened).toHaveBeenCalledWith("http://localhost:5173", "_blank", "noopener,noreferrer");

    // Another workspace's forward on the same port is not this one's.
    emit({ type: "forward.close", workspaceId: WS, port: 5173 });
    emit({ type: "forward.open", forward: { workspaceId: OTHER, port: 5173, startedAt: "2026-09-04T10:00:00.000Z", name: "other", kind: "url" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open on laptop" })).toBeNull());
  });

  it("opens the tab's path on this computer, not the port's root", async () => {
    const opened = vi.fn(() => null);
    vi.stubGlobal("open", opened);
    const { emit } = await setup();
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "localhost:5173/about?x=1" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":5173");
    emit({ type: "forward.open", forward: { workspaceId: WS, port: 5173, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" } });
    fireEvent.click(await screen.findByRole("button", { name: "Open on laptop" }));
    expect(opened).toHaveBeenCalledWith("http://localhost:5173/about?x=1", "_blank", "noopener,noreferrer");
    emit({ type: "forward.close", workspaceId: WS, port: 5173 });
  });
});
