// SPDX-License-Identifier: AGPL-3.0-only
// The right panel store's persisted shape is read on every render; a value
// stored at the current version with a shape this build cannot render must
// hydrate to something usable, since zustand runs migrate only on a version
// change.
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/protocol/store.js";
import { selectActiveRightPanel, selectPanelTerminalIds, selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { clearNotices } from "./notice-text.js";

const KEY = "wsp:right-panel-state:v1";
const WS = "ws_panel_store";

const view: WorkspaceView = { id: WS, name: "panel", machineId: "m_panel", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

beforeEach(() => {
  window.localStorage.clear();
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(cleanup);

/** Seeds the store's key at the current version and hydrates it. */
async function hydrate(surfaces: unknown[], activeSurfaceId: string | null = null): Promise<void> {
  window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: { [WS]: { isOpen: true, activeSurfaceId, surfaces } } }, version: 1 }));
  await useRightPanelStore.persist.rehydrate();
}

describe("rightPanelStore hydrate", () => {
  it("keeps a stored Agents surface, and keeps it active", async () => {
    await hydrate([{ id: "diff", kind: "diff" }, { id: "agents", kind: "agents" }], "agents");
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state.surfaces).toEqual([{ id: "diff", kind: "diff" }, { id: "agents", kind: "agents" }]);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byWorkspaceId, WS)).toBe("agents");
  });

  it("opens Agents as one surface however often it is asked for", () => {
    useRightPanelStore.getState().open(WS, "agents");
    useRightPanelStore.getState().open(WS, "agents");
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces).toEqual([{ id: "agents", kind: "agents" }]);
  });

  it("a stored value with a bad shape at the current version hydrates to a usable state", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: { [WS]: { isOpen: true, activeSurfaceId: "diff" } } }, version: 1 }));
    await useRightPanelStore.persist.rehydrate();
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state).toEqual({ isOpen: true, activeSurfaceId: null, surfaces: [] });
    expect(selectActiveRightPanel(useRightPanelStore.getState().byWorkspaceId, WS)).toBeNull();
  });

  it("drops surfaces of an unknown kind and terminal surfaces without pty ids; the active id follows what is left", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          byWorkspaceId: {
            [WS]: {
              isOpen: true,
              activeSurfaceId: "terminal:t_bad",
              surfaces: [
                { id: "plan", kind: "plan" },
                { id: "terminal:t_bad", kind: "terminal", resourceId: "t_bad" },
                { id: "terminal:p1", kind: "terminal", resourceId: "p1", terminalIds: ["p1", "p2"], activeTerminalId: "p9" },
                { id: "diff", kind: "diff" },
              ],
            },
          },
        },
        version: 1,
      }),
    );
    await useRightPanelStore.persist.rehydrate();
    const byWorkspaceId = useRightPanelStore.getState().byWorkspaceId;
    const state = selectWorkspaceRightPanelState(byWorkspaceId, WS);
    expect(state.surfaces.map(s => s.id)).toEqual(["terminal:p1", "diff"]);
    expect(state.activeSurfaceId).toBe("terminal:p1");
    expect(state.surfaces[0]).toMatchObject({ terminalIds: ["p1", "p2"], activeTerminalId: "p1" });
    expect(selectPanelTerminalIds(byWorkspaceId, WS)).toEqual(["p1", "p2"]);
  });

  it("drops a surface of a kind this build no longer has and a preview without a tab id; keeps the placeholder preview", async () => {
    await hydrate(
      [
        { id: "file:x", kind: "file" },
        { id: "browser:t9", kind: "preview" },
        { id: "browser:new", kind: "preview", resourceId: null },
        { id: "screen", kind: "screen" },
        { id: "browser:t1", kind: "preview", resourceId: "t1" },
      ],
      "file:x",
    );
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state.surfaces).toEqual([
      { id: "browser:new", kind: "preview", resourceId: null },
      { id: "browser:t1", kind: "preview", resourceId: "t1" },
    ]);
    expect(state.activeSurfaceId).toBe("browser:new");
  });

  it("the tab strip renders after hydrating a surface of a kind this build no longer has", async () => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, selectedId: WS, sessions: {}, ready: true });
    clearNotices();
    await hydrate([{ id: "file:x", kind: "file" }, { id: "diff", kind: "diff" }], "diff");
    const Panel = () => {
      const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, WS));
      return <RightPanel workspaceId={WS} state={state} mode="inline" />;
    };
    render(<Panel />);
    expect(screen.getAllByText(/diff/i).length).toBeGreaterThan(0);
  });

  it("a stored value that is not an object hydrates to the empty map", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: 7 }, version: 1 }));
    await useRightPanelStore.persist.rehydrate();
    expect(useRightPanelStore.getState().byWorkspaceId).toEqual({});
  });
});
