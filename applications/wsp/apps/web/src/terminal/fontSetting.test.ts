// SPDX-License-Identifier: AGPL-3.0-only
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { useStore } from "../protocol/store";
import { TERMINAL_FONT_KEY, effectiveTerminalFont, readTerminalFont, resetTerminalZoom, stepTerminalZoom, useTerminalFont, useTerminalViewportConfig, writeTerminalFont } from "./fontSetting";
import { appTerminalFontSize } from "./ghostty/surface";
import { rememberTerminalFile } from "./terminalFile";

const zoomOf = (workspaceId: string): number | undefined => useStore.getState().preferences.terminalZoom[workspaceId];

const boot = (terminalFont?: string) => {
  (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, token: "", ...(terminalFont !== undefined ? { terminalFont } : {}) };
};

describe("terminal font setting", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete (window as unknown as { __WSP__?: unknown }).__WSP__;
    useStore.setState({ api: null, preferences: DEFAULT_PREFERENCES });
    rememberTerminalFile(null);
    vi.restoreAllMocks();
  });

  it("round-trips the chosen family through localStorage and clears it on an empty choice", () => {
    expect(readTerminalFont()).toBeUndefined();
    writeTerminalFont("  JetBrains Mono ");
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe("JetBrains Mono");
    expect(readTerminalFont()).toBe("JetBrains Mono");
    writeTerminalFont("   ");
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
    expect(readTerminalFont()).toBeUndefined();
  });

  it("the effective family is the choice, else the one the collector found, else none", () => {
    expect(effectiveTerminalFont()).toBeUndefined();
    boot("Hack");
    expect(effectiveTerminalFont()).toBe("Hack");
    writeTerminalFont("Iosevka");
    expect(effectiveTerminalFont()).toBe("Iosevka");
    boot("");
    writeTerminalFont("");
    expect(effectiveTerminalFont()).toBeUndefined();
  });

  it("a storage that throws reads as no choice and swallows the write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(readTerminalFont()).toBeUndefined();
    expect(() => writeTerminalFont("Hack")).not.toThrow();
  });

  it("the hooks follow a change from anywhere on the page and keep the config's identity until the family changes", () => {
    boot("Hack");
    const font = renderHook(() => useTerminalFont());
    const config = renderHook(() => useTerminalViewportConfig("ws_a"));
    expect(font.result.current).toMatchObject({ family: "", detected: "Hack" });
    const first = config.result.current;
    expect(first).toEqual({ font: { family: "Hack" }, chosenFont: false, sizing: { source: "app", zoom: 0 } });
    config.rerender();
    expect(config.result.current).toBe(first);
    act(() => font.result.current.setFamily("Iosevka"));
    expect(font.result.current.family).toBe("Iosevka");
    expect(config.result.current).toEqual({ font: { family: "Iosevka" }, chosenFont: true, sizing: { source: "app", zoom: 0 } });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_FONT_KEY, newValue: null })));
    window.localStorage.removeItem(TERMINAL_FONT_KEY);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_FONT_KEY, newValue: null })));
    expect(config.result.current).toEqual({ font: { family: "Hack" }, chosenFont: false, sizing: { source: "app", zoom: 0 } });
    // The sizing follows the host's record: the source for every workspace, the zoom for this one.
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, terminalSize: "file", terminalZoom: { ws_a: 2, ws_b: -1 } } }));
    expect(config.result.current).toEqual({ font: { family: "Hack" }, chosenFont: false, sizing: { source: "file", zoom: 2 } });
  });

  it("the zoom is one workspace's own on the record, steps by a pixel, stops where the surface's sizes end over the app's base, and a reset drops the workspace's entry", () => {
    expect(zoomOf("ws_a")).toBeUndefined();
    stepTerminalZoom("ws_a", 1);
    expect(zoomOf("ws_a")).toBe(1);
    expect(zoomOf("ws_b")).toBeUndefined();
    stepTerminalZoom("ws_a", -40);
    expect(zoomOf("ws_a")).toBe(6 - appTerminalFontSize());
    stepTerminalZoom("ws_a", 100);
    expect(zoomOf("ws_a")).toBe(32 - appTerminalFontSize());
    stepTerminalZoom("ws_b", -1);
    expect(useStore.getState().preferences.terminalZoom).toEqual({ ws_a: 32 - appTerminalFontSize(), ws_b: -1 });
    resetTerminalZoom("ws_a");
    expect(useStore.getState().preferences.terminalZoom).toEqual({ ws_b: -1 });
    // Each patch names its own workspace alone, so two clients zooming different workspaces at once both keep theirs; a
    // reset of a workspace with no zoom sends nothing.
    const sets: unknown[] = [];
    useStore.setState({ api: { setPreferences: async (patch: unknown) => { sets.push(patch); return useStore.getState().preferences; } } as never });
    stepTerminalZoom("ws_a", 1);
    resetTerminalZoom("ws_a");
    resetTerminalZoom("ws_a");
    expect(sets).toEqual([{ terminalZoom: { ws_a: 1 } }, { terminalZoom: { ws_a: null } }]);
  });

  it("the zoom stops where the surface's sizes end over the base the pane draws from: the file's size once the record says the size comes from the file", () => {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, terminalSize: "file" } });
    rememberTerminalFile({ files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], fontSize: 16, palette: Array<null>(16).fill(null) });
    stepTerminalZoom("ws_a", 100);
    expect(zoomOf("ws_a")).toBe(32 - 16);
    stepTerminalZoom("ws_a", -1);
    expect(zoomOf("ws_a")).toBe(32 - 16 - 1);
    stepTerminalZoom("ws_a", -100);
    expect(zoomOf("ws_a")).toBe(6 - 16);
    // A file naming no size, or none read yet, leaves the app's base.
    rememberTerminalFile(null);
    stepTerminalZoom("ws_b", 100);
    expect(zoomOf("ws_b")).toBe(32 - appTerminalFontSize());
  });
});
