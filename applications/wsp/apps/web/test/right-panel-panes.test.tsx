// SPDX-License-Identifier: AGPL-3.0-only
// The right panel routes its Workspace and Processes panes for a workspace
// and for this computer's own panel, and holds Processes with a reason on a
// workspace that is not running.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLive } from "../src/machine/live.js";
import { resetProcs } from "../src/machine/procs.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { HERE_KEY } from "../src/terminal/computer.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";

function Panel({ id }: { id: string }) {
  const state = useRightPanelStore(s => s.byWorkspaceId[id]) ?? { isOpen: true, activeSurfaceId: null, surfaces: [] };
  return <RightPanel workspaceId={id} state={state} mode="inline" />;
}

const card = (key: string) => document.querySelector<HTMLElement>(`[data-surface-launch="${key}"]`)!;

beforeEach(() => {
  resetSurfaces();
  resetLive();
  resetProcs();
});
afterEach(cleanup);

describe("the right panel's Workspace and Processes panes", () => {
  it.each([
    ["processes", "[data-procs]", "Processes"],
    ["machine", "[data-machine]", "Computer"],
  ] as const)("opens the %s pane for a workspace, named on the tab strip", (kind, pane, title) => {
    act(() => useRightPanelStore.getState().open(WS, kind));
    render(<Panel id={WS} />);
    expect(document.querySelector(pane)).not.toBeNull();
    expect(document.querySelector("[data-right-panel-tab-list]")!.textContent).toContain(title);
  });

  it.each([
    ["processes", "[data-procs]"],
    ["machine", "[data-machine]"],
  ] as const)("opens the %s pane on this computer's own panel", (kind, pane) => {
    act(() => useRightPanelStore.getState().open(HERE_KEY, kind));
    render(<Panel id={HERE_KEY} />);
    expect(document.querySelector(pane)).not.toBeNull();
  });

  it("offers both on this computer's panel, where the diff waits for a project", () => {
    act(() => useRightPanelStore.getState().show(HERE_KEY));
    render(<Panel id={HERE_KEY} />);
    expect(card("machine").tagName).toBe("BUTTON");
    expect(card("processes").tagName).toBe("BUTTON");
    expect(card("diff").dataset["available"]).toBe("false");
  });

  it("keeps the Workspace pane on a paused workspace and holds Processes with the reason", () => {
    act(() => useStore.setState({ workspaces: [{ ...view, phase: "napping" }] }));
    render(<Panel id={WS} />);
    expect(card("machine").tagName).toBe("BUTTON");
    expect(card("processes").dataset["available"]).toBe("false");
    expect(card("processes").textContent).toContain("Available while the task is running.");
    expect(screen.queryByText("Files")).toBeNull();
    expect(screen.queryByText("Screen")).toBeNull();
  });

  it("keeps an open pane across a reload", () => {
    act(() => useRightPanelStore.getState().open(WS, "processes"));
    const saved = window.localStorage.getItem("wsp:right-panel-state:v1");
    expect(saved).toContain("processes");
    act(() => useRightPanelStore.setState({ byWorkspaceId: {} }));
    window.localStorage.setItem("wsp:right-panel-state:v1", saved!);
    act(() => void useRightPanelStore.persist.rehydrate());
    expect(useRightPanelStore.getState().byWorkspaceId[WS]?.surfaces.map(s => s.kind)).toEqual(["processes"]);
  });
});
