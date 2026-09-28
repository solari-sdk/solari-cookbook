// SPDX-License-Identifier: AGPL-3.0-only
// The terminal drawer over the workspace's daemon link, on a fake wire: the
// first open spawns a pty and mounts a libghostty surface, bytes fed to the
// link reach that surface (its cursor report comes back out as a pty.write),
// new and split open more ptys and lay them out, close kills them. The same
// drawer mounts in panel mode as the right panel's terminal surface, and each
// pty has one owner: the panel keeps what it opened, the drawer the rest.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTerminalDrawer } from "../src/components/WorkspaceTerminalDrawer.js";
import { getLive, resetLive } from "../src/machine/live.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { openDrawerTerminal, openPanelTerminal, splitActivePanelTerminal, splitDrawerTerminal } from "../src/shell/shellCommands.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { caps } from "./caps.js";
import { clearNotices, lastNotice } from "./notice-text.js";

// The toolbar buttons are Base UI popover triggers (tooltip on hover). Under
// jsdom a click on one opens the popup, whose positioning against zero-size
// rects pegged the main thread for 12 s per click (measured); the popover has
// its own kit tests, so here the trigger is the bare button.
vi.mock("../src/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render, children }: { render: ReactElement<{ children?: ReactNode }>; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: () => null,
}));

const WS = "ws_drawer_test";

// The daemon side of the wire: the ptys it holds outlive any WorkspaceTerminals
// over it, so relink() is a reload (a fresh model over the same daemon).
function fakeLink({ refuseCreate = false, ptys = [], holdList = false }: { refuseCreate?: boolean; ptys?: string[]; holdList?: boolean } = {}) {
  let next = ptys.length + 1;
  const held = new Set(ptys);
  const ops: { op: string; params: Record<string, unknown> }[] = [];
  // With holdList the daemon answers pty.list only when the test says so, to see what renders before adoption.
  let releaseList = (): void => {};
  const listGate = holdList ? new Promise<void>(resolve => (releaseList = resolve)) : Promise.resolve();
  const wire: TerminalWire = {
    request: async (op, params = {}) => {
      ops.push({ op, params });
      if (op === "pty.create") {
        if (refuseCreate) throw new Error("daemon unreachable");
        const ptyId = `p${next++}`;
        held.add(ptyId);
        return { ok: true, ptyId };
      }
      if (op === "pty.kill") held.delete(String(params["ptyId"]));
      if (op === "pty.list") {
        await listGate;
        return { ok: true, ptys: [...held].map(id => ({ id, pid: 1, cols: 80, rows: 24, exited: false })) };
      }
      return { ok: true };
    },
  };
  const relink = () => {
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    provideTerminals(WS, wt);
    return wt;
  };
  const wt = relink();
  const writes = () => ops.filter(o => o.op === "pty.write").map(o => String(o.params["data"]));
  const count = (op: string) => ops.filter(o => o.op === op).length;
  return { wt, ops, writes, count, relink, releaseList: () => releaseList() };
}

// Surfaces size their grid from the mount; jsdom lays nothing out, so give every viewport a box.
function sizeViewports(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-terminal-viewport]")) {
    if (el.clientWidth === 0) {
      Object.defineProperty(el, "clientWidth", { value: 600 });
      Object.defineProperty(el, "clientHeight", { value: 300 });
    }
  }
}

const canvases = (owner: string) => document.querySelectorAll(`[data-terminal-owner="${owner}"] canvas`);
const inputs = (owner: string) => document.querySelectorAll(`[data-terminal-owner="${owner}"] .ghostty-input`);

beforeEach(() => {
  window.localStorage.clear();
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  cleanup();
  provideTerminals(WS, null);
  clearNotices();
});

describe("WorkspaceTerminalDrawer", () => {
  it("renders nothing while the drawer is closed, then opens a pty and a surface when opened", async () => {
    const { wt, count } = fakeLink();
    const { container } = render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    expect(container.firstChild).toBeNull();
    expect(count("pty.create")).toBe(0);

    act(() => useTerminalDrawerStore.getState().setOpen(WS, true));
    await waitFor(() => expect(count("pty.create")).toBe(1));
    await waitFor(() => expect(canvases("drawer")).toHaveLength(1));
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
  }, 20_000);

  it("bytes from the daemon link reach the surface: a cursor query is answered through pty.write", async () => {
    const { wt, writes } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    act(() => wt.feedEvent({ type: "pty.data", ptyId: "p1", data: "\x1b[6n" }));
    await waitFor(() => expect(writes().join("")).toContain("\x1b[1;1R"));
  }, 20_000);

  it("new opens another pty as its own tab; split opens one into the active group; close kills", async () => {
    const { wt, count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    fireEvent.click(screen.getByLabelText(/^New Terminal/));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1", "p2"]));
    const ui = useTerminalDrawerStore.getState().byWorkspaceId[WS]!;
    expect(ui.activeTerminalId).toBe("p2");
    expect(ui.terminalGroups.map(g => g.terminalIds)).toEqual([["p1"], ["p2"]]);
    // Two terminals: the tab list appears with the link's titles, one surface shown.
    expect(screen.getAllByText("shell")).toHaveLength(2);
    await waitFor(() => expect(canvases("drawer")).toHaveLength(1));
    fireEvent.click(screen.getByLabelText(/^Split Terminal Horizontally/));
    await waitFor(() => expect(count("pty.create")).toBe(3));
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalGroups.map(g => g.terminalIds)).toEqual([["p1"], ["p2", "p3"]]));
    await waitFor(() => expect(canvases("drawer")).toHaveLength(2));
    sizeViewports();
    await waitFor(() => expect(inputs("drawer")).toHaveLength(2), { timeout: 15_000 });

    fireEvent.click(screen.getByLabelText(/^Close Terminal/));
    await waitFor(() => expect(count("pty.kill")).toBe(1));
    await waitFor(() => expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1", "p2"]));
    await waitFor(() => expect(canvases("drawer")).toHaveLength(1));
  }, 30_000);

  it("closing the last terminal closes the drawer; reopening shows the empty state and never respawns", async () => {
    const { count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const { container } = render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    fireEvent.click(screen.getByLabelText(/^Close Terminal/));
    await waitFor(() => expect(count("pty.kill")).toBe(1));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalOpen ?? false).toBe(false);

    act(() => useTerminalDrawerStore.getState().setOpen(WS, true));
    await screen.findByText(/No terminals open/);
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /^New Terminal/ }));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
  }, 20_000);
});

const view: WorkspaceView = { id: WS, name: "drawer", machineId: "m_drawer", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

function Panel() {
  const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, WS));
  return <RightPanel workspaceId={WS} state={state} mode="inline" />;
}

describe("terminal as a right-panel surface", () => {
  beforeEach(() => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, selectedId: WS, sessions: {}, ready: true });
    clearNotices();
  });

  it("opens its shell in the folder a thread would start in, which is the project's and not the daemon's home", async () => {
    const { ops } = fakeLink();
    render(<Panel />);
    await waitFor(() => expect(document.querySelector("[data-surface-launch='terminal']")).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>("[data-surface-launch='terminal']")!);
    await waitFor(() => expect(ops.some(o => o.op === "pty.create")).toBe(true));
    // The card says a shell in this workspace; the daemon's own home is the machine, not the work.
    expect(ops.find(o => o.op === "pty.create")!.params["cwd"]).toBe("/root");
  }, 20_000);

  it("a computer that is not answering refuses the Terminal panel in the panel itself, and asks for no pty", async () => {
    const onPlace: WorkspaceView = { ...view, kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_oldlaptop" };
    const { count } = fakeLink();
    act(() =>
      useStore.setState({
        workspaces: [onPlace],
        places: [{ id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: false, lastSeenAt: new Date(Date.now() - 38 * 60_000).toISOString() }],
      }),
    );
    render(<Panel />);
    const sentence = "old-laptop is not answering; it connects on its own when it is on";
    // The launcher card carries the sentence where the panel would have opened, rather than a grey line at the
    // foot of the sidebar in the opposite corner from the click.
    const card = (key: string) => document.querySelector<HTMLElement>(`[data-surface-launch="${key}"]`)!;
    await waitFor(() => expect(card("terminal").getAttribute("data-available")).toBe("false"));
    expect(within(card("terminal")).getByText(sentence)).toBeTruthy();
    // The one sentence that says what happened reads at the muted ink's own alpha; the dimming that says the card
    // is held sits on the title and the icon, which the person is not being asked to read.
    for (const key of ["terminal"]) {
      expect(card(key).className).not.toContain("opacity-40");
      expect(within(card(key)).getByText(sentence).className).not.toContain("opacity");
      expect(card(key).querySelector("[data-surface-card-head]")!.className).toContain("opacity-40");
    }
    fireEvent.click(card("terminal"));
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(0);
    expect(lastNotice()).toBeNull();
    expect(document.body.textContent).not.toContain("daemon unreachable");
  });

  it("asks for no pty on an absent computer from the shortcut, the split or the panel's own button either, so nothing toasts", async () => {
    const onPlace: WorkspaceView = { ...view, kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_oldlaptop" };
    const { count } = fakeLink();
    act(() =>
      useStore.setState({
        workspaces: [onPlace],
        places: [{ id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: false, lastSeenAt: new Date(Date.now() - 38 * 60_000).toISOString() }],
      }),
    );
    // The tab click is held by the panel; these three roads reach the link directly, and from a pane that was
    // open before the silence the toast the ticket names was one keypress away.
    await openDrawerTerminal(WS);
    await splitDrawerTerminal(WS);
    await openPanelTerminal(WS);
    await splitActivePanelTerminal(WS);
    expect(count("pty.create")).toBe(0);
    expect(lastNotice()).toBeNull();
  });

  it("mounts the drawer in panel mode for a terminal surface and labels its tab from the link", async () => {
    const { wt, writes } = fakeLink();
    const tab = await wt.open();
    useRightPanelStore.getState().openTerminal(WS, tab.ptyId);
    render(<Panel />);
    await waitFor(() => expect(document.querySelector('[data-terminal-owner="right-panel"]')).not.toBeNull());
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });
    expect(screen.getAllByText("shell").length).toBeGreaterThan(0);
    act(() => wt.feedEvent({ type: "pty.data", ptyId: tab.ptyId, data: "\x1b[6n" }));
    await waitFor(() => expect(writes().join("")).toContain("\x1b[1;1R"));
  }, 20_000);

  it("split in the panel adds the new pty to the surface's group; new opens a second surface", async () => {
    const { wt, count } = fakeLink();
    const tab = await wt.open();
    useRightPanelStore.getState().openTerminal(WS, tab.ptyId);
    render(<Panel />);
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });

    fireEvent.click(screen.getByLabelText(/^Split Terminal Vertically/));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => {
      const s = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces[0];
      expect(s?.kind === "terminal" ? s.terminalIds : []).toEqual(["p1", "p2"]);
    });
    await waitFor(() => expect(canvases("right-panel")).toHaveLength(2));

    fireEvent.click(screen.getByLabelText(/^New Terminal/));
    await waitFor(() => expect(count("pty.create")).toBe(3));
    await waitFor(() => expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p1", "terminal:p3"]));
  }, 30_000);
});

describe("one owner per pty", () => {
  beforeEach(() => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, selectedId: WS, sessions: {}, ready: true });
    clearNotices();
  });

  it("a pty opened from the right panel is the panel's: the drawer never lists it and only the panel mounts it", async () => {
    const { count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    await act(() => openPanelTerminal(WS));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1"]);
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p2"]);
    expect(canvases("drawer")).toHaveLength(1);
    expect(canvases("right-panel")).toHaveLength(1);
  }, 30_000);

  it("a drawer opened after the panel made a pty spawns its own; closing it leaves the panel's surface alone; a surface whose pty the link lacks is dropped", async () => {
    const { wt, count, ops } = fakeLink();
    const theirs = await wt.open();
    useRightPanelStore.getState().openTerminal(WS, theirs.ptyId);
    useRightPanelStore.getState().openTerminal(WS, "p_gone");
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    await waitFor(() => expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p1"]));
    // The panel's pty is not the drawer's, so the drawer's first open spawns its own.
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p2"]);

    fireEvent.click(within(document.querySelector<HTMLElement>('[data-terminal-owner="drawer"]')!).getByLabelText(/^Close Terminal/));
    await waitFor(() => expect(count("pty.kill")).toBe(1));
    expect(ops.find(o => o.op === "pty.kill")?.params["ptyId"]).toBe("p2");
    await waitFor(() => expect(document.querySelector('[data-terminal-owner="drawer"]')).toBeNull());
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p1"]);
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
  }, 30_000);

  it("two mounts racing for a workspace's first pty share one create", async () => {
    const { count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const { unmount } = render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <WorkspaceTerminalDrawer workspaceId={WS} />
      </>,
    );
    await waitFor(() => expect(count("pty.create")).toBe(1));
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);
    unmount();
  });
});

describe("reload adopts the daemon's ptys", () => {
  beforeEach(() => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, selectedId: WS, sessions: {}, ready: true });
    clearNotices();
  });

  it("two attaches over one daemon make one pty: the second link adopts the first's and the drawer spawns none", async () => {
    const { count, relink } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const first = render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(count("pty.create")).toBe(1);
    first.unmount();

    const wt = relink();
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]));
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);
    expect(count("pty.list")).toBe(2);
    expect(count("pty.attach")).toBe(2);
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1"]);
  }, 30_000);

  it("a reload with two live ptys shows both in the stored arrangement (a split, p2 active) and spawns none", async () => {
    const { wt, ops, count, releaseList } = fakeLink({ ptys: ["p1", "p2"], holdList: true });
    const drawer = useTerminalDrawerStore.getState();
    drawer.setOpen(WS, true);
    drawer.add(WS, "p1");
    drawer.split(WS, "p2", "vertical");
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    // Until the daemon has answered, the stored ptys are not shown as terminals: no surface binds to a pty the link does not know.
    // Nothing has been open on this link, so the pane says what is being started and never that something is coming back.
    await screen.findByText(/Starting a terminal on drawer/);
    expect(canvases("drawer")).toHaveLength(0);
    releaseList();
    await waitFor(() => expect(canvases("drawer")).toHaveLength(2));
    sizeViewports();
    await waitFor(() => expect(inputs("drawer")).toHaveLength(2), { timeout: 15_000 });
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(0);
    expect(count("pty.attach")).toBe(2);
    const ui = useTerminalDrawerStore.getState().byWorkspaceId[WS]!;
    expect(ui.terminalIds).toEqual(["p1", "p2"]);
    expect(ui.activeTerminalId).toBe("p2");
    expect(ui.terminalGroups.map(g => [g.terminalIds, g.splitDirection])).toEqual([[["p1", "p2"], "vertical"]]);
    // Both surfaces are bound to their adopted ptys: bytes in come back out.
    act(() => wt.feedEvent({ type: "pty.data", ptyId: "p2", data: "\x1b[6n" }));
    await waitFor(() => expect(ops.filter(o => o.op === "pty.write" && o.params["ptyId"] === "p2").map(o => o.params["data"]).join("")).toContain("\x1b[1;1R"));
  }, 20_000);

  it("ownership survives a reload: the panel keeps its pty, the drawer takes its own and any pty no store claims", async () => {
    const { wt, ops, count, releaseList } = fakeLink({ ptys: ["p1", "p2", "p3"], holdList: true });
    useRightPanelStore.getState().openTerminal(WS, "p2");
    useTerminalDrawerStore.getState().setOpen(WS, true);
    useTerminalDrawerStore.getState().add(WS, "p1");
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    // Before the daemon answers, neither side shows a terminal or drops the panel's surface.
    await waitFor(() => expect(screen.getAllByText(/Starting a terminal on drawer/)).toHaveLength(2));
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p2"]);
    releaseList();
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1", "p3"]));
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p2"]);
    expect(count("pty.create")).toBe(0);
    expect(count("pty.attach")).toBe(3);
    act(() => wt.feedEvent({ type: "pty.data", ptyId: "p2", data: "\x1b[6n" }));
    await waitFor(() => expect(ops.filter(o => o.op === "pty.write" && o.params["ptyId"] === "p2").map(o => o.params["data"]).join("")).toContain("\x1b[1;1R"));
  }, 30_000);
});

describe("drawer resilience", () => {
  it("a stored value with a bad shape at the current version hydrates to a usable state and renders", async () => {
    window.localStorage.setItem("wsp:terminal-drawer:v1", JSON.stringify({ state: { byWorkspaceId: { [WS]: { terminalOpen: true } } }, version: 1 }));
    await useTerminalDrawerStore.persist.rehydrate();
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]).toMatchObject({ terminalOpen: true, terminalIds: [], terminalGroups: [] });
    const { count } = fakeLink();
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(count("pty.create")).toBe(1));
  });

  it("while the link is down the empty state says so and offers no terminal; going live spawns one", async () => {
    const { wt, count } = fakeLink();
    wt.feedStatus("connecting");
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await screen.findByText(/The daemon link is reconnecting; terminals open when it is back/);
    expect(screen.queryByRole("button", { name: /^New Terminal/ })).toBeNull();
    expect(count("pty.create")).toBe(0);
    act(() => wt.feedStatus("live"));
    await waitFor(() => expect(count("pty.create")).toBe(1));
  });

  it("a pty a live link refused is said as no terminal on that workspace, with the link's own reason", async () => {
    const { count } = fakeLink({ refuseCreate: true });
    act(() => useStore.setState({ workspaces: [PANE_WS], statuses: {} }));
    clearNotices();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await screen.findByText(/No terminals open/);
    await waitFor(() => expect(lastNotice()).toBe("No terminal on api: daemon unreachable"));
    expect(count("pty.create")).toBe(1);

    clearNotices();
    fireEvent.click(screen.getByRole("button", { name: /^New Terminal/ }));
    await waitFor(() => expect(lastNotice()).toBe("No terminal on api: daemon unreachable"));

    clearNotices();
    await act(() => openPanelTerminal(WS));
    await waitFor(() => expect(lastNotice()).toBe("No terminal on api: daemon unreachable"));
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces).toEqual([]);
    act(() => useStore.setState({ workspaces: [] }));
    clearNotices();
  });
});

// The pane reads the workspace's state from the store; these set it by hand, the way a status push would.
const PANE_WS: WorkspaceView = { id: WS, name: "api", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
function paneStatus(over: Partial<WorkspaceStatus>): WorkspaceStatus {
  return { ...PANE_WS, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, ...over };
}
function setPane(phase: WorkspaceView["phase"], status: Partial<WorkspaceStatus>, wakes: string[] = []): void {
  const api = { subscribe: () => () => {}, wake: async (id: string) => { wakes.push(id); return { ...PANE_WS, phase: "running" as const }; } } as unknown as Api;
  useStore.setState({ api, workspaces: [{ ...PANE_WS, phase }], statuses: { [WS]: paneStatus({ ...status, phase }) } });
}
const overlay = () => document.querySelector<HTMLElement>("[data-terminal-overlay]");
const hints = () => Array.from(overlay()?.querySelectorAll<HTMLElement>("[data-terminal-hint]") ?? []).map(p => p.textContent);

describe("panes on a workspace that is not running", () => {
  afterEach(() => useStore.setState({ api: null, workspaces: [], statuses: {} }));

  it("a paused workspace dims the frozen frame, refuses keys with the reason, and its Wake calls the wake op; on wake the same pty continues", async () => {
    const { wt, writes, count } = fakeLink();
    const wakes: string[] = [];
    setPane("running", {}, wakes);
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(overlay()).toBeNull();

    act(() => setPane("pausing", { machineState: "running", reach: { state: "napping" } }, wakes));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("paused"));
    expect(overlay()!.textContent).toContain("Pausing. The shell is kept; wake the task to continue");
    act(() => {
      setPane("napping", { machineState: "paused", reach: { state: "napping" } }, wakes);
      wt.feedStatus("connecting");
    });
    await waitFor(() => expect(overlay()!.textContent).toContain("Paused. The shell is kept; wake the task to continue"));
    // The frame stays: the surface is still mounted under the overlay, and a key pressed into it is refused, not sent.
    expect(inputs("drawer")).toHaveLength(1);
    fireEvent.keyDown(inputs("drawer")[0]!, { key: "a", code: "KeyA" });
    await waitFor(() => expect(document.querySelector("[data-terminal-refused]")?.textContent).toBe("Typing is refused: the task is paused"));
    expect(writes()).toEqual([]);

    fireEvent.click(within(overlay()!).getByRole("button", { name: "Wake" }));
    await waitFor(() => expect(wakes).toEqual([WS]));
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("waking"));
    act(() => {
      setPane("running", {}, wakes);
      wt.feedStatus("live");
    });
    await waitFor(() => expect(overlay()).toBeNull());
    expect(count("pty.create")).toBe(1);
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
    fireEvent.keyDown(inputs("drawer")[0]!, { key: "a", code: "KeyA" });
    await waitFor(() => expect(writes()).toEqual(["a"]));
  }, 20_000);

  it("a pty refused on a computer that is not answering says nothing in the corner: its pane already says why", async () => {
    fakeLink({ refuseCreate: true });
    const here = { ...PANE_WS, kind: "local" as const, machineId: "local" };
    act(() =>
      useStore.setState({
        workspaces: [here],
        statuses: { [WS]: { ...paneStatus({ reach: { state: "unreachable" } }), kind: "local" as const, machineId: "local" } },
      }),
    );
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await screen.findByText("this Mac's daemon is not running");
    await act(() => openPanelTerminal(WS));
    expect(lastNotice()).toBeNull();
  });

  it("this computer's own daemon down: the pane says the one sentence and its button asks the host for another", async () => {
    const asked: string[] = [];
    const api = { subscribe: () => () => {}, restartDaemon: async (id: string) => void asked.push(id) } as unknown as Api;
    const here = { ...PANE_WS, kind: "local" as const, machineId: "local" };
    fakeLink();
    act(() =>
      useStore.setState({
        api,
        workspaces: [here],
        statuses: { [WS]: { ...paneStatus({ reach: { state: "unreachable" } }), kind: "local" as const, machineId: "local" } },
      }),
    );
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await screen.findByText("this Mac's daemon is not running");
    // One line and one button: no second sentence saying in words what the button already says.
    expect(document.body.textContent).not.toContain("Unreachable");
    expect(document.body.textContent).not.toContain("wake it");
    const start = await screen.findByRole("button", { name: "Start it" });
    await act(async () => void fireEvent.click(start));
    expect(asked).toEqual([WS]);
  }, 20_000);

  it("the overlay takes focus only from the pane itself, and Enter on its Wake button is left to the button", async () => {
    const { wt } = fakeLink();
    const wakes: string[] = [];
    setPane("running", {}, wakes);
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const elsewhere = document.createElement("textarea");
    document.body.appendChild(elsewhere);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    // The surface focuses itself on the frame after it mounts; that frame must land before focus is arranged here.
    await act(() => new Promise<void>(r => requestAnimationFrame(() => r())));
    elsewhere.focus();
    act(() => {
      setPane("napping", { machineState: "paused", reach: { state: "napping" } }, wakes);
      wt.feedStatus("connecting");
    });
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("paused"));
    expect(document.activeElement).toBe(elsewhere);
    // Enter on the Wake button is the button's own activation; only a key on the overlay itself is refused.
    const wake = within(overlay()!).getByRole("button", { name: "Wake" });
    expect(fireEvent.keyDown(wake, { key: "Enter", code: "Enter" })).toBe(true);
    expect(document.querySelector("[data-terminal-refused]")).toBeNull();
    expect(fireEvent.keyDown(overlay()!, { key: "a", code: "KeyA" })).toBe(false);
    expect(document.querySelector("[data-terminal-refused]")?.textContent).toBe("Typing is refused: the task is paused");
    // With the pane holding focus, the next state takes it so keys keep landing on the refusal.
    (inputs("drawer")[0] as HTMLElement).focus();
    act(() => setPane("waking", { machineState: "starting", reach: { state: "napping" } }, wakes));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("waking"));
    await waitFor(() => expect(document.activeElement).toBe(overlay()));
    // The overlay held focus, so when it lifts the surface gets it back instead of the body.
    act(() => {
      setPane("running", {}, wakes);
      wt.feedStatus("live");
    });
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(inputs("drawer")[0]));
    // Lifting while focus was elsewhere leaves it there.
    act(() => setPane("napping", { machineState: "paused", reach: { state: "napping" } }, wakes));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("paused"));
    elsewhere.focus();
    act(() => setPane("running", {}, wakes));
    await waitFor(() => expect(overlay()).toBeNull());
    await act(() => new Promise<void>(r => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  }, 20_000);

  it("a running machine whose daemon stopped answering reconnects with elapsed time, then says it is not answering once the runtime calls it a zombie", async () => {
    const { wt } = fakeLink();
    setPane("running", {});
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    act(() => wt.feedStatus("connecting"));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("reconnecting"));
    expect(overlay()!.textContent).toMatch(/Reconnecting to the task\s*for \d+s/);
    expect(within(overlay()!).queryByRole("button", { name: "Wake" })).toBeNull();
    act(() => setPane("running", { reach: { state: "unreachable" } }));
    expect(overlay()?.dataset["terminalOverlay"]).toBe("reconnecting");
    act(() => setPane("running", { reach: { state: "zombie" }, reason: "silent for 3 min; exec probe failed" }));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("not-answering"));
    expect(overlay()!.textContent).toContain("The task is not answering");
    expect(hints()).toEqual(["Rebuild it from the task's row"]);
    act(() => {
      setPane("running", {});
      wt.feedStatus("live");
    });
    await waitFor(() => expect(overlay()).toBeNull());
  }, 20_000);

  it("a link that drops after the daemon read memory near full says what took the machine and names the next size up ahead of any rebuild", async () => {
    const GiB = 1024 ** 3;
    const { wt } = fakeLink();
    resetLive();
    setPane("running", {});
    useStore.setState({ capabilities: caps({ sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }] }) });
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    // The same daemon link feeds both: the pane's socket and the live rows' samples.
    act(() => {
      getLive(WS).feedStatus("live");
      getLive(WS).feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
    });
    expect(overlay()).toBeNull();
    act(() => {
      wt.feedStatus("connecting");
      getLive(WS).feedStatus("connecting");
    });
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("reconnecting"));
    expect(overlay()!.textContent).toMatch(/Reconnecting to the task\s*for \d+s/);
    expect(hints()).toEqual([
      "Out of memory (3.6 GB of 3.9 GB used, load 6.4) when the task last answered; the work on it took the memory, not a fault of the computer it runs on",
      "A task on 2 vCPU, 8 GB ($0.15/hr) fits more; pick it when you make the next one",
    ]);
    act(() => setPane("running", { reach: { state: "zombie" }, reason: "silent for 3 min; exec probe failed" }));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("not-answering"));
    expect(overlay()!.textContent).not.toContain("The task is not answering");
    expect(overlay()!.textContent).toContain("Out of memory (3.6 GB of 3.9 GB used, load 6.4)");
    expect(hints()).toEqual([
      "A task on 2 vCPU, 8 GB ($0.15/hr) fits more; pick it when you make the next one",
      "Rebuild it from the task's row",
    ]);
    act(() => {
      setPane("running", {});
      wt.feedStatus("live");
      getLive(WS).feedStatus("live");
    });
    await waitFor(() => expect(overlay()).toBeNull());
    useStore.setState({ capabilities: null });
  }, 20_000);

  it("with no terminal open a paused workspace says so and offers the wake; the panel says the same", async () => {
    const { wt } = fakeLink();
    const wakes: string[] = [];
    wt.feedStatus("connecting");
    setPane("napping", { machineState: "paused", reach: { state: "napping" } }, wakes);
    useTerminalDrawerStore.getState().setOpen(WS, true);
    useRightPanelStore.getState().openTerminal(WS, "p9");
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("Task is paused; wake it to open a terminal")).toHaveLength(2));
    expect(document.querySelectorAll("[data-terminal-empty='paused']")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Wake" })[0]!);
    await waitFor(() => expect(wakes).toEqual([WS]));
  });

  it("a pty the daemon no longer holds says the shell ended when the machine was replaced and offers a new one", async () => {
    let replaced = false;
    const held = new Set(["p1"]);
    let next = 2;
    const ops: string[] = [];
    const wire: TerminalWire = {
      request: async (op, params = {}) => {
        ops.push(op);
        if (op === "pty.create") {
          const ptyId = `p${next++}`;
          held.add(ptyId);
          return { ok: true, ptyId };
        }
        if (op === "pty.attach" && replaced && params["ptyId"] === "p1") throw new Error("no such pty: p1");
        if (op === "pty.list") return { ok: true, ptys: [...held].filter(id => !(replaced && id === "p1")).map(id => ({ id, pid: 1, cols: 80, rows: 24, exited: false })) };
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    provideTerminals(WS, wt);
    setPane("running", {});
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
    replaced = true;
    act(() => wt.feedStatus("connecting"));
    act(() => wt.feedStatus("live"));
    await waitFor(() => expect(overlay()?.dataset["terminalOverlay"]).toBe("shell-gone"));
    expect(overlay()!.textContent).toContain("This shell ended when the daemon holding it stopped");
    fireEvent.click(within(overlay()!).getByRole("button", { name: /^New Terminal/ }));
    await waitFor(() => expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1", "p2"]));
    await waitFor(() => expect(overlay()).toBeNull());
  }, 20_000);
});
