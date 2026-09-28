// SPDX-License-Identifier: AGPL-3.0-only
// The Workspace pane: load, memory and disk as line charts off the live
// store, the facts in two mono lines, the registry's actions for the
// workspace, and on this computer's own panel this computer's facts and no
// actions. No sentence stands anywhere in it.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { HERE_PLACE_ID, fmtSize, type PlaceView, type SysSample, type WorkspaceStatus } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSurface } from "../src/components/machine/MachineSurface.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { useStore } from "../src/protocol/store.js";
import { HERE_KEY } from "../src/terminal/computer.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";

const GIB = 1024 ** 3;
const sample = (load1: number, at: number): SysSample => ({ type: "sys.sample", cpu: 10, load1, mem: { used: 4 * GIB, total: 16 * GIB }, disk: { used: 95 * GIB, total: 100 * GIB }, at });
const status = (over: Partial<WorkspaceStatus> = {}): WorkspaceStatus => ({ ...view, machineState: "running", reach: { state: "ok" }, size: { cpu: 4, memMb: 8192 }, rateUsdPerHour: 0.1, ...over }) as WorkspaceStatus;
const here: PlaceView = { id: HERE_PLACE_ID, kind: "computer", name: "mac", label: "dev's MacBook", default: true, os: "macOS 16.1", shape: { cpu: 10, memMb: 32768 } };

const slot = (k: string) => document.querySelector(`[data-chart="${k}"] [data-k="${k}"]`)!.textContent;
const line = (k: string) => document.querySelector(`[data-chart="${k}"] [data-chart-line]`);
const facts = () => [...document.querySelectorAll("[data-facts] [data-chip]")].map(c => c.textContent);
const path = () => document.querySelector("[data-facts] p")?.textContent ?? null;
const actions = () => [...document.querySelectorAll<HTMLButtonElement>("[data-machine-actions] button")].map(b => b.dataset["action"]);

beforeEach(() => {
  resetSurfaces();
  resetLive();
  useStore.setState({ places: [here] });
});
afterEach(cleanup);

describe("the Workspace pane", () => {
  it("draws load, memory and disk as lines off the live store, pending until the first sample", () => {
    render(<MachineSurface workspaceId={WS} />);
    act(() => getLive(WS).feedStatus("live"));
    expect(["load", "mem", "disk"].map(slot)).toEqual(["pending", "pending", "pending"]);
    expect(line("load")).toBeNull();
    act(() => {
      getLive(WS).feedSample(sample(0.5, 1));
      getLive(WS).feedSample(sample(2, 2));
    });
    expect(slot("load")).toBe("2.00");
    expect(slot("mem")).toBe("4 GB of 16 GB");
    expect(slot("disk")).toBe("95 GB of 100 GB");
    for (const k of ["load", "mem", "disk"]) expect(line(k)!.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    expect(document.querySelector('[data-chart="disk"] [data-k="disk"]')!.className).toContain("text-destructive-foreground");
    expect(document.querySelectorAll("rect")).toHaveLength(0);
  });

  it("keeps the last lines dim under the state word once the workspace pauses", () => {
    render(<MachineSurface workspaceId={WS} />);
    act(() => {
      getLive(WS).feedStatus("live");
      getLive(WS).feedSample(sample(1, 1));
    });
    act(() => useStore.setState({ workspaces: [{ ...view, phase: "napping" }] }));
    expect(slot("load")).toBe("paused");
    expect(line("load")!.closest("div")!.getAttribute("class")).toContain("text-muted-foreground/40");
  });

  it("states the workspace's facts as chips and its folder in one mono line, and nothing else in words", () => {
    act(() => useStore.setState({ statuses: { [WS]: status() } }));
    const { container } = render(<MachineSurface workspaceId={WS} />);
    expect(facts()).toEqual(["Running", "a provider", "4 vCPU", "8 GB"]);
    expect(path()).toBe("/root");
    expect([...container.querySelectorAll("p")].every(p => p.closest("[data-facts]") !== null)).toBe(true);
  });

  it("offers the registry's actions for a running fork and runs the one pressed", () => {
    const toggle = vi.fn(async () => {});
    act(() => useStore.setState({ statuses: { [WS]: status() }, toggle }));
    render(<MachineSurface workspaceId={WS} />);
    expect(actions()).toEqual(["phase", "bring-back", "export-project", "delete"]);
    const phase = document.querySelector<HTMLButtonElement>('[data-action="phase"]')!;
    expect(phase.textContent).toBe("Pause");
    fireEvent.click(phase);
    expect(toggle).toHaveBeenCalledWith(WS);
    const del = document.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
    expect(del.className).not.toContain("bg-destructive ");
    expect(del.className).toContain("[:hover,[data-pressed]]:text-destructive-foreground");
  });

  it("keeps a local workspace's figures live while its daemon is down, since the host reads them", () => {
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local" }], statuses: { [WS]: status({ kind: "local", reach: { state: "no-daemon" } } as Partial<WorkspaceStatus>) } }));
    render(<MachineSurface workspaceId={WS} />);
    act(() => {
      getLive(WS).feedReach("live");
      getLive(WS).feedSample(sample(1.25, 1));
    });
    expect(slot("load")).toBe("1.25");
    expect(document.querySelector('[data-action="start-daemon"]')).not.toBeNull();
  });

  it("offers no pause on a local workspace, which wsp does not drive", () => {
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local" }], statuses: { [WS]: status({ kind: "local" } as Partial<WorkspaceStatus>) } }));
    render(<MachineSurface workspaceId={WS} />);
    expect(actions()).not.toContain("phase");
    expect(actions()).toContain("delete");
  });

  it("on this computer's own panel reads this computer's figures and facts, with nothing to act on", () => {
    render(<MachineSurface workspaceId={HERE_KEY} />);
    act(() => {
      getLive(HERE_KEY).feedStatus("live");
      getLive(HERE_KEY).feedSample(sample(3, 1));
    });
    expect(slot("load")).toBe("3.00");
    expect(facts()).toEqual(["dev's MacBook", "macOS 16.1", "10 cores", "32 GB"]);
    expect(document.querySelector("[data-machine-actions]")).toBeNull();
  });
});
