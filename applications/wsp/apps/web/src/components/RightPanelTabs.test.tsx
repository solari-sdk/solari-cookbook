// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's launcher and its tab strip: six panes and no others,
// each with its own letter, and a pane the workspace cannot serve yet drawn
// held with the one line that says why.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightPanelTabs } from "./RightPanelTabs";
import type { RightPanelSurface } from "../rightPanelStore";
import { PANE_KINDS, type RightPanelKind } from "../panes";

const NONE: ReadonlySet<string> = new Set();

function draw(over: { surfaces?: RightPanelSurface[]; activeSurfaceId?: string | null; diffAvailable?: boolean; processesAvailable?: boolean; onAdd?: (kind: RightPanelKind) => void } = {}) {
  return render(
    <RightPanelTabs
      mode="inline"
      surfaces={over.surfaces ?? []}
      activeSurfaceId={over.activeSurfaceId ?? null}
      pendingSurfaceIds={NONE}
      previewSessions={{}}
      terminalLabelsById={new Map()}
      onActivate={vi.fn()}
      onCloseSurface={vi.fn()}
      onAdd={over.onAdd ?? vi.fn()}
      available={{ ...Object.fromEntries(PANE_KINDS.map(k => [k, true])), diff: over.diffAvailable ?? true, processes: over.processesAvailable ?? true } as Record<RightPanelKind, boolean>}
    >
      <div data-pane />
    </RightPanelTabs>,
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-surface-launch]")].map(el => el.dataset["surfaceLaunch"]);

afterEach(cleanup);

describe("the right panel's launcher", () => {
  it("offers Browser, Terminal, Diff, Computer, Processes and Agents and nothing else", () => {
    draw();
    expect(cards()).toEqual(["preview", "terminal", "diff", "machine", "processes", "agents"]);
    for (const label of ["Browser", "Terminal", "Diff", "Computer", "Processes", "Agents"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("Files")).toBeNull();
    expect(screen.queryByText("Screen")).toBeNull();
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(document.querySelector("[data-surface-launcher-keys]")?.getAttribute("data-surface-launcher-keys")).toBe("BTDMPA");
  });

  it("says what the Browser pane is for in the person's own words", () => {
    draw();
    expect(screen.getByText("Open your dev server or a URL.")).toBeTruthy();
  });

  it("keeps a pane it cannot open drawn, held, with the one line that says why", () => {
    draw({ diffAvailable: false });
    expect(cards()).toEqual(["preview", "terminal", "diff", "machine", "processes", "agents"]);
    const diff = document.querySelector<HTMLElement>('[data-surface-launch="diff"]')!;
    expect(diff.dataset["available"]).toBe("false");
    expect(diff.textContent).toContain("Review changes once the task is running.");
  });

  it("holds Processes with the line that says why", () => {
    draw({ processesAvailable: false });
    const procs = document.querySelector<HTMLElement>('[data-surface-launch="processes"]')!;
    expect(procs.dataset["available"]).toBe("false");
    expect(procs.textContent).toContain("Available while the task is running.");
  });

  it("names the open panes on the tab strip", () => {
    draw({ surfaces: [{ id: "diff", kind: "diff" }, { id: "machine", kind: "machine" }, { id: "processes", kind: "processes" }], activeSurfaceId: "diff" });
    const strip = document.querySelector("[data-right-panel-tab-list]")?.textContent;
    expect(strip).toContain("Diff");
    expect(strip).toContain("Computer");
    expect(strip).toContain("Processes");
    expect(document.querySelector("[data-pane]")).not.toBeNull();
  });

  it("says what the Agents pane holds, and its letter opens it", () => {
    const onAdd = vi.fn();
    draw({ onAdd });
    const agents = document.querySelector<HTMLElement>('[data-surface-launch="agents"]')!;
    expect(agents.textContent).toContain("Agents");
    expect(agents.textContent).toContain("Agents, skills and servers on this task.");
    expect(agents.querySelector("kbd")?.textContent).toBe("A");
    fireEvent.keyDown(window, { key: "a" });
    expect(onAdd.mock.calls).toEqual([["agents"]]);
  });

  it("names the Agents pane on the tab strip once it is open", () => {
    draw({ surfaces: [{ id: "agents", kind: "agents" }], activeSurfaceId: "agents" });
    expect(document.querySelector("[data-right-panel-tab-list]")?.textContent).toContain("Agents");
  });
});
