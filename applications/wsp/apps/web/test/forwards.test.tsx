// SPDX-License-Identifier: AGPL-3.0-only
// The forwarded-ports list: the store takes the host's list on bind and its
// forward events after, the rows carry port, workspace and age with a stop,
// and the row is the link a person clicks.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortForward, WorkspaceView } from "@wsp/protocol";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { RequestError, type Api, type ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ForwardsList } from "../src/sidebar/ForwardsList.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const view = (id: string, name: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" });
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const CAPS = caps();

function fakeApi(workspaces: WorkspaceView[], forwards: PortForward[], opts: { listFails?: string } = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const stops: [string, number][] = [];
  let refuse: string | null = null;
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => workspaces.map(w => ({ ...w, machineState: "running" as const, reach: { state: "reachable" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0 })),
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
    listSessions: async () => [],
    getGolden: async () => undefined,
    listForwards: async () => {
      if (opts.listFails !== undefined) throw new RequestError(opts.listFails);
      return forwards;
    },
    stopForward: async (workspaceId, port) => {
      stops.push([workspaceId, port]);
      if (refuse !== null) throw new RequestError(refuse);
    },
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: ProtocolEvent) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit, stops, setRefusal: (why: string | null) => (refuse = why) };
}

const WS_A = view("ws_a", "api");
const WS_B = view("ws_b", "web");
const THREE_MIN_AGO = iso(-3 * 60_000);
const fwd = (workspaceId: string, port: number, startedAt = THREE_MIN_AGO, name = workspaceId === "ws_a" ? "api" : "web", kind: PortForward["kind"] = "url"): PortForward => ({ workspaceId, port, startedAt, name, kind });

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "connecting", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, forwards: [], selectedId: null, sessions: {}, ready: false });
  clearNotices();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("forwards in the store", () => {
  it("bind pulls the host's list; forward.open adds or replaces, forward.close and workspace.deleted remove", async () => {
    const { api, emit } = fakeApi([WS_A, WS_B], [fwd("ws_a", 8123)]);
    await act(async () => useStore.getState().bind(api));
    await waitFor(() => expect(useStore.getState().forwards).toEqual([fwd("ws_a", 8123)]));

    emit({ type: "forward.open", forward: fwd("ws_b", 5173, "2026-09-04T10:00:00.000Z") });
    emit({ type: "forward.open", forward: fwd("ws_a", 8123, "2026-09-04T10:01:00.000Z") });
    expect(useStore.getState().forwards).toEqual([fwd("ws_b", 5173, "2026-09-04T10:00:00.000Z"), fwd("ws_a", 8123, "2026-09-04T10:01:00.000Z")]);

    emit({ type: "forward.close", workspaceId: "ws_b", port: 5173 });
    expect(useStore.getState().forwards).toEqual([fwd("ws_a", 8123, "2026-09-04T10:01:00.000Z")]);

    emit({ type: "forward.open", forward: fwd("ws_a", 3000) });
    emit({ type: "workspace.deleted", workspaceId: "ws_a" });
    expect(useStore.getState().forwards).toEqual([]);
  });

  it("a refused list clears the rows and toasts, so nothing closed while the socket was down stays listed", async () => {
    useStore.setState({ forwards: [fwd("ws_a", 8123)] });
    const { api } = fakeApi([WS_A], [], { listFails: "no host holds forwards" });
    await act(async () => useStore.getState().bind(api));
    await waitFor(() => expect(useStore.getState().forwards).toEqual([]));
    expect(lastNotice()).toBe("Forwards not read: no host holds forwards");
  });

  it("stopForward asks the host; a refusal is a toast naming the port", async () => {
    const { api, stops, setRefusal } = fakeApi([WS_A], [fwd("ws_a", 8123)]);
    await act(async () => useStore.getState().bind(api));
    await useStore.getState().stopForward("ws_a", 8123);
    expect(stops).toEqual([["ws_a", 8123]]);
    expect(lastNotice()).toBeNull();
    setRefusal("nothing is forwarding localhost:8123 for that workspace");
    await useStore.getState().stopForward("ws_a", 8123);
    expect(lastNotice()).toBe("localhost:8123: nothing is forwarding localhost:8123 for that workspace");
  });
});

describe("ForwardsList", () => {
  it("renders nothing with no forwards", () => {
    useStore.setState({ workspaces: [WS_A] });
    render(<SidebarProvider defaultOpen><ForwardsList /></SidebarProvider>);
    expect(screen.queryByTestId("forwards-list")).toBeNull();
  });

  it("one row per forward: the link to localhost:<port>, the workspace, the age, and a stop that asks the host", async () => {
    const { api, emit, stops } = fakeApi([WS_A, WS_B], [fwd("ws_a", 8123, iso(-3 * 60_000)), fwd("ws_b", 5173, iso(-2 * 60 * 60_000))]);
    await act(async () => useStore.getState().bind(api));
    render(<SidebarProvider defaultOpen><ForwardsList /></SidebarProvider>);
    const list = await screen.findByTestId("forwards-list");
    expect(within(list).getByText("Forwarded ports")).toBeDefined();
    // The one section row the sidebar has: a caps mono label on a row that shuts its group.
    const header = within(list).getByRole("button", { name: "Forwarded ports" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(within(header).getByText("Forwarded ports").className).toContain("font-mono");
    expect(header.querySelector("svg.lucide-chevron-down")).not.toBeNull();
    fireEvent.click(header);
    expect(within(list).queryByText("localhost:8123")).toBeNull();
    expect(header.textContent).toBe("Forwarded ports2");
    fireEvent.click(header);

    const rowA = within(list).getByText("localhost:8123").closest<HTMLElement>("[data-sidebar-row]")!;
    expect(rowA.tagName).toBe("A");
    expect(rowA.getAttribute("href")).toBe("http://localhost:8123");
    expect(rowA.getAttribute("target")).toBe("_blank");
    expect(rowA.getAttribute("rel")).toBe("noopener noreferrer");
    expect(rowA.textContent).toContain("api");
    expect(rowA.textContent).toContain("3m");

    const rowB = within(list).getByText("localhost:5173").closest<HTMLElement>("[data-sidebar-row]")!;
    expect(rowB.textContent).toContain("web");
    expect(rowB.textContent).toContain("2h");

    fireEvent.click(within(list).getByRole("button", { name: "Stop forwarding localhost:8123" }));
    await waitFor(() => expect(stops).toEqual([["ws_a", 8123]]));
    // The row leaves on the host's word, not on the click.
    expect(within(list).getByText("localhost:8123")).toBeDefined();
    emit({ type: "forward.close", workspaceId: "ws_a", port: 8123 });
    expect(within(list).queryByText("localhost:8123")).toBeNull();
    expect(within(list).getByText("localhost:5173")).toBeDefined();
    emit({ type: "forward.close", workspaceId: "ws_b", port: 5173 });
    expect(screen.queryByTestId("forwards-list")).toBeNull();
  });

  it("a sign-in callback forward is a label with a stop and no link; a url forward keeps its link", async () => {
    const { api, stops } = fakeApi([WS_A], [fwd("ws_a", 8976, THREE_MIN_AGO, "api", "callback"), fwd("ws_a", 5173)]);
    await act(async () => useStore.getState().bind(api));
    render(<SidebarProvider defaultOpen><ForwardsList /></SidebarProvider>);
    const list = await screen.findByTestId("forwards-list");
    const callback = within(list).getByText("sign-in callback for api").closest<HTMLElement>("[data-forward]")!;
    expect(callback.querySelector("a")).toBeNull();
    // A label, not a row that lights up under the pointer: the only button in it is the stop.
    expect(callback.querySelectorAll('[data-sidebar="menu-button"]')).toHaveLength(0);
    expect(callback.querySelectorAll("button")).toHaveLength(1);
    expect(callback.textContent).toContain("localhost:8976");
    fireEvent.click(within(callback).getByRole("button", { name: "Stop forwarding localhost:8976" }));
    await waitFor(() => expect(stops).toEqual([["ws_a", 8976]]));
    const url = within(list).getByText("localhost:5173").closest<HTMLElement>("[data-sidebar-row]")!;
    expect(url.tagName).toBe("A");
    expect(url.getAttribute("href")).toBe("http://localhost:5173");
  });

  it("a builder's row shows the name the host gave it, never the machine id", async () => {
    const id = "ZGVza3RvcC1wb29sLWktMDY5ZTkyOTYyZjdiOGI1NzU6dm1fMDAwMDQ0OmNtdGhxajhsZzAwc3NvMDAxc3Z3Ynh5eGI6MTc4ODQ5MzM2OTQ1MQ";
    useStore.setState({ workspaces: [WS_A], forwards: [fwd(id, 8976, THREE_MIN_AGO, "default (builder)")] });
    render(<SidebarProvider defaultOpen><ForwardsList /></SidebarProvider>);
    const row = screen.getByText("localhost:8976").closest("[data-sidebar-row]")!;
    expect(row.textContent).toContain("default (builder)");
    expect(row.textContent).not.toContain("ZGVza3Rvc");
  });
});

describe("in the sidebar", () => {
  it("the group sits under the workspaces and its rows join keyboard traversal", async () => {
    const { api } = fakeApi([WS_A], [fwd("ws_a", 8123)]);
    await act(async () => useStore.getState().bind(api));
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    await screen.findByText("localhost:8123");
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-row]")).map(r => r.dataset["rowId"]);
    expect(ids).toEqual(["project:pr_1", "ws:ws_a", "fwd:ws_a:8123"]);
  });
});
