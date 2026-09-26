// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's pane kinds live in one table: the launcher, the add menu,
// the tab strip and the store's persistence all read it, and each kind says
// for itself when it can open and why not.
import { absentComputer, type AbsentComputer } from "@wsp/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RightPanelTabs } from "../src/components/RightPanelTabs.js";
import { PANE_KINDS, PANES, type PaneContext, type RightPanelKind } from "../src/panes.js";
import { useRightPanelStore, type RightPanelSurface } from "../src/rightPanelStore.js";
import { view } from "./surface-harness.js";

const ALL = Object.fromEntries(PANE_KINDS.map(k => [k, true])) as Record<RightPanelKind, boolean>;
const SURFACES: RightPanelSurface[] = [
  { id: "browser:new", kind: "preview", resourceId: null },
  { id: "terminal:p1", kind: "terminal", resourceId: "p1", terminalIds: ["p1"], activeTerminalId: "p1" },
  { id: "diff", kind: "diff" },
  { id: "machine", kind: "machine" },
  { id: "processes", kind: "processes" },
  { id: "agents", kind: "agents" },
];

function tabs(surfaces: RightPanelSurface[], onAdd = vi.fn()) {
  render(
    <RightPanelTabs mode="inline" surfaces={surfaces} activeSurfaceId={surfaces[0]?.id ?? null} pendingSurfaceIds={new Set()} previewSessions={{}} terminalLabelsById={new Map()} onActivate={vi.fn()} onCloseSurface={vi.fn()} onAdd={onAdd} available={ALL}>
      <div />
    </RightPanelTabs>,
  );
  return onAdd;
}

beforeEach(() => useRightPanelStore.setState({ byWorkspaceId: {} }));
afterEach(cleanup);

describe("the pane registry", () => {
  it("is the launcher's cards, in its order, each with its label, line and letter, and each letter opens its own kind", () => {
    const onAdd = tabs([]);
    const cards = [...document.querySelectorAll<HTMLElement>("[data-surface-launch]")];
    expect(cards.map(c => c.dataset["surfaceLaunch"])).toEqual(PANE_KINDS);
    PANE_KINDS.forEach((kind, i) => {
      expect(cards[i]!.textContent).toContain(PANES[kind].label);
      expect(cards[i]!.textContent).toContain(PANES[kind].description);
      expect(cards[i]!.querySelector("kbd")?.textContent).toBe(PANES[kind].shortcut);
    });
    for (const kind of PANE_KINDS) fireEvent.keyDown(window, { key: PANES[kind].shortcut.toLowerCase() });
    expect(onAdd.mock.calls.map(([kind]) => kind)).toEqual(PANE_KINDS);
  });

  it("names every open kind on the tab strip by its label, or by what its tab holds", () => {
    tabs(SURFACES);
    const strip = [...document.querySelectorAll("[data-right-panel-tab-list] [data-active-tab]")].map(t => t.textContent);
    expect(strip).toEqual(["Browser", "Terminal", "Diff", "Computer", "Processes", "Agents"]);
  });

  it("keeps every kind it holds across a reload of the store", () => {
    act(() => {
      for (const surface of SURFACES) {
        if (surface.kind === "terminal") useRightPanelStore.getState().openTerminal("ws", surface.resourceId);
        else useRightPanelStore.getState().open("ws", surface.kind);
      }
    });
    const saved = window.localStorage.getItem("wsp:right-panel-state:v1")!;
    act(() => useRightPanelStore.setState({ byWorkspaceId: {} }));
    window.localStorage.setItem("wsp:right-panel-state:v1", saved);
    act(() => void useRightPanelStore.persist.rehydrate());
    expect(useRightPanelStore.getState().byWorkspaceId["ws"]?.surfaces.map(s => s.kind)).toEqual(PANE_KINDS);
  });

  it("says per kind when it opens and why it is held", () => {
    const away: AbsentComputer = absentComputer("old-macbook", 120_000);
    const startable: AbsentComputer = { ...away, start: "Start" };
    const contexts: Record<string, PaneContext> = {
      here: { here: true, workspace: null, absent: null },
      running: { here: false, workspace: view, absent: null },
      napping: { here: false, workspace: { ...view, phase: "napping" }, absent: null },
      away: { here: false, workspace: view, absent: away },
      startable: { here: false, workspace: view, absent: startable },
      none: { here: false, workspace: null, absent: null },
    };
    const opens = Object.fromEntries(Object.entries(contexts).map(([name, at]) => [name, PANE_KINDS.filter(k => PANES[k].available(at))]));
    expect(opens).toEqual({
      here: ["preview", "terminal", "machine", "processes"],
      running: PANE_KINDS,
      napping: ["machine", "agents"],
      away: ["preview", "diff", "machine", "agents"],
      startable: ["preview", "diff", "machine", "processes", "agents"],
      none: [],
    });
    const reasons = (at: PaneContext) => Object.fromEntries(PANE_KINDS.flatMap(k => (PANES[k].reason?.(at) === undefined ? [] : [[k, PANES[k].reason!(at)]])));
    expect(reasons(contexts["here"]!)).toEqual({ diff: "Pick a project to review its changes." });
    expect(reasons(contexts["running"]!)).toEqual({});
    expect(reasons(contexts["away"]!)).toEqual({ terminal: away.sentence, processes: away.sentence });
  });
});
