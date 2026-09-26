// SPDX-License-Identifier: AGPL-3.0-only
// The terminal's own zoom: with a pane focused the mod chords step that
// workspace's terminal text size by a pixel and never reach the app's zoom,
// with nothing focused they keep whatever meaning they had, and the zoom the
// panes draw with sits on the host's record, so it outlives the mount that
// set it.
import { fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_PREFERENCES, type ShellChord, type WorkspaceView } from "@wsp/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { useTerminalViewportConfig } from "../src/terminal/fontSetting.js";
import { appTerminalFontSize } from "../src/terminal/ghostty/surface.js";
import { clearNotices } from "./notice-text.js";

vi.mock("../src/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <span data-tooltip>{children}</span>,
}));

const view: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

function fakeApi(): Api {
  return {
    listWorkspaces: async () => [view],
    getWorkspace: async () => view,
    watchStatuses: async () => [],
    capabilities: async () => null,
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
  } as unknown as Api;
}

/** A pane the shortcuts count as focused: the surface marks its root the way the drawer's viewport does. */
function focusPane(): HTMLElement {
  const pane = document.createElement("div");
  pane.setAttribute("data-terminal-owner", "drawer");
  pane.tabIndex = 0;
  document.body.append(pane);
  pane.focus();
  return pane;
}

/** The size a pane draws at over the app's base: the base plus the workspace's zoom off the record. */
const sizeOf = (workspaceId: string) => appTerminalFontSize() + (renderHook(() => useTerminalViewportConfig(workspaceId)).result.current.sizing?.zoom ?? 0);
const paneSize = () => sizeOf("ws_a");

/** The chord as a browser delivers it, and whether anything claimed it. */
function press(key: string, code: string, shiftKey = false): boolean {
  return !fireEvent.keyDown(window, { key, code, metaKey: true, shiftKey });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true } });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete window.wsp;
});

async function shell(): Promise<void> {
  useStore.getState().bind(fakeApi());
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
}

describe("the terminal's own zoom", () => {
  it("steps the pane's size by a pixel and claims the chord, so the app's own zoom never sees it", async () => {
    await shell();
    focusPane();
    expect(paneSize()).toBe(appTerminalFontSize());
    expect(press("=", "Equal")).toBe(true);
    expect(paneSize()).toBe(appTerminalFontSize() + 1);
    // The same chord on a layout where the plus needs shift.
    expect(press("+", "Equal", true)).toBe(true);
    expect(paneSize()).toBe(appTerminalFontSize() + 2);
    expect(press("-", "Minus")).toBe(true);
    expect(paneSize()).toBe(appTerminalFontSize() + 1);
  });

  it("puts the pane back on the app's own text size, the 14px the terminal token names", async () => {
    await shell();
    focusPane();
    press("=", "Equal");
    press("=", "Equal");
    expect(paneSize()).toBe(16);
    expect(press("0", "Digit0")).toBe(true);
    expect(paneSize()).toBe(14);
    expect(appTerminalFontSize()).toBe(14);
  });

  it("leaves the chords alone with no pane focused, so they keep the meaning the shell around them gives them", async () => {
    await shell();
    expect(press("=", "Equal")).toBe(false);
    expect(press("-", "Minus")).toBe(false);
    expect(paneSize()).toBe(appTerminalFontSize());
  });

  it("tells the desktop shell when a pane has focus, and answers the chords the shell hands back with the same rules", async () => {
    const focus: boolean[] = [];
    let deliver: ((chord: ShellChord) => void) | undefined;
    window.wsp = {
      setTerminalFocus: focused => focus.push(focused),
      onShellChord: handler => {
        deliver = handler;
        return () => (deliver = undefined);
      },
    };
    await shell();
    expect(focus).toEqual([false]);
    focusPane();
    await waitFor(() => expect(focus).toEqual([false, true]));
    const chord: ShellChord = { key: "=", code: "Equal", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
    deliver!(chord);
    expect(paneSize()).toBe(appTerminalFontSize() + 1);
    // The shell hands the chord back whatever has focus; with no pane focused the rules leave it alone.
    document.body.querySelector<HTMLElement>("[data-terminal-owner]")!.blur();
    await waitFor(() => expect(focus).toEqual([false, true, false]));
    deliver!(chord);
    expect(paneSize()).toBe(appTerminalFontSize() + 1);
  });

  it("remembers the zoom per workspace on the record, and a pane mounted later reads it back", async () => {
    await shell();
    focusPane();
    press("=", "Equal");
    press("=", "Equal");
    press("=", "Equal");
    expect(paneSize()).toBe(appTerminalFontSize() + 3);
    expect(sizeOf("ws_b")).toBe(appTerminalFontSize());
    expect(useStore.getState().preferences.terminalZoom).toEqual({ ws_a: 3 });
    document.body.innerHTML = "";
    expect(paneSize()).toBe(appTerminalFontSize() + 3);
  });
});
