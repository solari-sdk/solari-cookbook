// SPDX-License-Identifier: AGPL-3.0-only
// The header's terminal button and its shortcut are the same action: both
// flip the drawer store for the selected workspace, and the button's tooltip
// names the shortcut. The tooltip popup is rendered inline here: Base UI's
// positioning against jsdom's zero-size rects takes seconds per open.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

vi.mock("../src/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <span data-tooltip>{children}</span>,
}));

const view: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const CAPS = caps();

function fakeApi(): Api {
  return {
    listWorkspaces: async () => [view],
    getWorkspace: async () => view,
    createWorkspace: async () => view,
    watchStatuses: async () => [],
    nap: async () => view,
    wake: async () => view,
    capabilities: async () => CAPS,
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
  };
}

const drawerOpen = () => useTerminalDrawerStore.getState().byWorkspaceId["ws_a"]?.terminalOpen ?? false;

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, sessions: {}, ready: false });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terminal drawer controls", () => {
  it("the header button names the shortcut and toggles the same drawer the shortcut does", async () => {
    useStore.getState().bind(fakeApi());
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
    // The label is resolved once at module load, before this test pins the platform.
    expect(screen.getByText(/^Toggle terminal drawer \((⌘J|Ctrl\+J)\)$/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Toggle terminal drawer" }));
    await waitFor(() => expect(drawerOpen()).toBe(true));
    fireEvent.keyDown(window, { key: "j", code: "KeyJ", metaKey: true });
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(useRightPanelStore.getState().byWorkspaceId["ws_a"]?.surfaces ?? []).toEqual([]);
  });
});
