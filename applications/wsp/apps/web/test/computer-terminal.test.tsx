// SPDX-License-Identifier: AGPL-3.0-only
// The terminal that belongs to this computer rather than to a workspace: the
// terminal chord with no workspace selected opens the drawer on it, the panel
// chord opens the right panel with its panels held, the drawer names where its
// shells run and opens them in the home folder, and the wiring dials this
// computer's own daemon only once that drawer is opened.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { HERE_PLACE_ID, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/App.js";
import { ComputerTerminalDrawer } from "../src/components/WorkspaceTerminalDrawer.js";
import type { Api, DaemonTarget } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { runShellCommand } from "../src/shell/shellCommands.js";
import { HERE_KEY } from "../src/terminal/computer.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { getTerminals, provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { getProcs, resetProcs } from "../src/machine/procs.js";
import type { DaemonApi } from "../src/protocol/client.js";
import { wireTerminals } from "../src/terminal/wiring.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { installFakeLayout } from "./fake-layout.js";
import { clearNotices } from "./notice-text.js";

vi.mock("../src/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render, children }: { render: ReactElement<{ children?: ReactNode }>; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: () => null,
}));

const WS = "ws_a";
const project: ProjectView = { id: "pr_1", name: "the-project", computer: HERE_PLACE_ID, source: { kind: "folder", path: "/Users/dev/the-project" }, path: "/Users/dev/the-project", remote: "", defaultBranch: "main", memoryKey: "-Users-dev-the-project", memoryDir: "/Users/dev/.claude/projects/-Users-dev-the-project/memory", createdAt: "t" };
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

function fakeApi(workspaces: WorkspaceView[], daemon = noDaemonApi): Api {
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
    daemon,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
  };
}

const target = (workspaceId: string | null) => ({ workspaceId, toggleSidebar: () => {} });
const drawerOpen = (key: string) => useTerminalDrawerStore.getState().byWorkspaceId[key]?.terminalOpen === true;

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, creations: [], sessions: {}, ready: false, gaps: 0, settingsOpen: false });
  clearNotices();
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});
afterEach(() => {
  cleanup();
  provideTerminals(HERE_KEY, null);
});

describe("the terminal chord", () => {
  it("with no workspace selected opens the drawer on this computer's terminal, and a second press closes it", () => {
    runShellCommand("terminal.toggle", target(null), []);
    expect(drawerOpen(HERE_KEY)).toBe(true);
    runShellCommand("terminal.toggle", target(null), []);
    expect(drawerOpen(HERE_KEY)).toBe(false);
  });

  it("with a workspace selected moves that workspace's drawer and never this computer's", () => {
    runShellCommand("terminal.toggle", target(WS), []);
    expect(drawerOpen(WS)).toBe(true);
    expect(drawerOpen(HERE_KEY)).toBe(false);
  });

  it("does nothing behind Settings", () => {
    useStore.setState({ settingsOpen: true });
    runShellCommand("terminal.toggle", target(null), []);
    expect(drawerOpen(HERE_KEY)).toBe(false);
  });
});

describe("the right panel chord with no workspace", () => {
  it("opens this computer's panel: browser, terminal, workspace and processes open here, the diff waits for a project", async () => {
    useStore.getState().bind(fakeApi([]));
    render(<Shell />);
    await waitFor(() => expect(useStore.getState().ready).toBe(true));
    expect(document.querySelector("[data-right-panel-tabbar]")).toBeNull();

    act(() => runShellCommand("rightPanel.toggle", target(null), []));
    await waitFor(() => expect(document.querySelector("[data-right-panel-tabbar]")).not.toBeNull());
    const cards = [...document.querySelectorAll("[data-surface-launch]")];
    expect(cards.map(c => c.getAttribute("data-surface-launch"))).toEqual(["preview", "terminal", "diff", "machine", "processes", "agents"]);
    expect(cards.map(c => c.tagName)).toEqual(["BUTTON", "BUTTON", "DIV", "BUTTON", "BUTTON", "DIV"]);
    screen.getByText("Pick a project to review its changes.");

    act(() => runShellCommand("rightPanel.toggle", target(null), []));
    await waitFor(() => expect(document.querySelector("[data-right-panel-tabbar]")).toBeNull());
  });
});

describe("this computer's drawer", () => {
  function fakeWire() {
    const ops: { op: string; params: Record<string, unknown> }[] = [];
    const wire: TerminalWire = {
      request: async (op, params = {}) => {
        ops.push({ op, params });
        if (op === "pty.create") return { ok: true, ptyId: "p1" };
        if (op === "pty.list") return { ok: true, ptys: [] };
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    provideTerminals(HERE_KEY, wt);
    return ops;
  }

  it("opens its first shell with no folder, which is the home folder, and no header over it", async () => {
    const ops = fakeWire();
    useTerminalDrawerStore.getState().setOpen(HERE_KEY, true);
    render(<ComputerTerminalDrawer />);
    await waitFor(() => expect(ops.filter(o => o.op === "pty.create")).toHaveLength(1));
    expect(ops.find(o => o.op === "pty.create")!.params["cwd"]).toBeUndefined();
    expect(document.querySelector("[data-terminal-where]")).toBeNull();
  });

  it.each([
    ["the first run, with no project yet", [] as ProjectView[], "[data-k=\"first-run\"]"],
    ["a project's home, with no workspace", [project], "[data-k=\"project-home\"]"],
  ])("mounts under %s", async (_, projects, centre) => {
    fakeWire();
    useStore.getState().bind({ ...fakeApi([]), projectsList: async () => projects });
    render(<Shell />);
    await waitFor(() => expect(document.querySelector(centre)).not.toBeNull());
    expect(document.querySelector(".thread-terminal-drawer")).toBeNull();
    act(() => runShellCommand("terminal.toggle", target(null), []));
    await waitFor(() => expect(document.querySelector(".thread-terminal-drawer")).not.toBeNull());
  });
});

describe("the wiring", () => {
  it("dials this computer's own daemon by its place once the drawer opens, and not before", async () => {
    const asked: DaemonTarget[] = [];
    const daemon = { ...noDaemonApi, open: async (to: DaemonTarget) => (asked.push(to), noDaemonApi.open(to)) };
    const unwire = wireTerminals(useStore, { backoffMs: () => 60_000 });
    try {
      useStore.getState().bind(fakeApi([], daemon));
      await waitFor(() => expect(getTerminals(HERE_KEY)).not.toBeNull());
      expect(asked).toEqual([]);
      act(() => useTerminalDrawerStore.getState().setOpen(HERE_KEY, true));
      await waitFor(() => expect(asked).toEqual([{ placeId: HERE_PLACE_ID }]));
    } finally {
      unwire();
    }
  });

  it.each(["machine", "processes"] as const)("dials this computer's daemon once its %s pane opens, and files what it pushes under this computer", async kind => {
    resetLive();
    resetProcs();
    const asked: DaemonTarget[] = [];
    const ops: string[] = [];
    let push: ((e: Parameters<Parameters<DaemonApi["onFrame"]>[1]>[0]) => void) | null = null;
    const daemon: DaemonApi = {
      open: async to => (asked.push(to), { channel: "c1" }),
      send: async (_channel, frame) => (ops.push(String((frame as { op: string }).op)), { id: 1, ok: true } as never),
      close: async () => {},
      onFrame: (_channel, fn) => ((push = fn), () => {}),
    };
    const unwire = wireTerminals(useStore, { backoffMs: () => 60_000 });
    try {
      useStore.getState().bind(fakeApi([], daemon));
      await waitFor(() => expect(getTerminals(HERE_KEY)).not.toBeNull());
      expect(asked).toEqual([]);
      act(() => useRightPanelStore.getState().open(HERE_KEY, kind));
      await waitFor(() => expect(asked).toEqual([{ placeId: HERE_PLACE_ID }]));
      await waitFor(() => expect(ops).toContain("sys.watch"));
      expect(ops).not.toContain("proc.watch");
      const release = getProcs(HERE_KEY).watch();
      await waitFor(() => expect(ops).toContain("proc.watch"));
      const event = (e: Record<string, unknown>) => act(() => push!({ type: "daemon.event", channel: "c1", event: e as { type: string } }));
      event({ type: "proc.snapshot", at: 1, daemon: 9, total: 1, procs: [{ pid: 9, ppid: 1, user: "dev", state: "S", comm: "wspd", cmdline: "wspd", cpu: 0, rss: 0, startedAt: 0 }] });
      event({ type: "sys.sample", cpu: 5, load1: 1.5, mem: { used: 1, total: 2 }, disk: { used: 3, total: 4 }, at: 1 });
      await waitFor(() => expect(getProcs(HERE_KEY).snapshot().snapshot?.procs.map(p => p.pid)).toEqual([9]));
      expect(getLive(HERE_KEY).snapshot().samples.map(s => s.load1)).toEqual([1.5]);
      expect(getLive(HERE_KEY).snapshot().reach).toBe("live");
      release();
    } finally {
      unwire();
    }
  });
});
