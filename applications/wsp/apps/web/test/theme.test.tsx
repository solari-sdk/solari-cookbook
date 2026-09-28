// SPDX-License-Identifier: AGPL-3.0-only
// The theme rule: which side each value draws, the html element following the
// record's pick and, under system, the computer's own scheme without a reload,
// and the desktop shell told the picked value so its frame follows.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import { SYSTEM_DARK_QUERY, applyTheme, useThemeEffect } from "../src/settings/theme.js";
import { SIDE_DEFAULT } from "../src/themes/index.js";

const isDark = () => document.documentElement.classList.contains("dark");
const themeId = () => document.documentElement.dataset["theme"];

beforeEach(() => {
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true } });
  document.documentElement.classList.add("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete window.wsp;
  window.localStorage.clear();
  document.documentElement.classList.add("dark");
});

describe("the theme", () => {
  it("light and dark pin a side; system takes the computer's; the side draws that side's pick, and the html carries its id", () => {
    const picks = { lightTheme: "paper", darkTheme: "graphite" };
    const combos = [
      { theme: "light", systemDark: true, dark: false, id: "paper" },
      { theme: "light", systemDark: false, dark: false, id: "paper" },
      { theme: "dark", systemDark: false, dark: true, id: "graphite" },
      { theme: "dark", systemDark: true, dark: true, id: "graphite" },
      { theme: "system", systemDark: false, dark: false, id: "paper" },
      { theme: "system", systemDark: true, dark: true, id: "graphite" },
    ] as const;
    for (const { theme, systemDark, dark, id } of combos) {
      applyTheme({ theme, ...picks }, systemDark);
      expect([theme, systemDark, isDark(), themeId()]).toEqual([theme, systemDark, dark, id]);
    }
  });

  it("a pick this build does not know, or one from the other side, draws that side's default", () => {
    applyTheme({ theme: "dark", lightTheme: "paper", darkTheme: "a-theme-from-a-later-build" }, false);
    expect([isDark(), themeId()]).toEqual([true, SIDE_DEFAULT.dark.id]);
    applyTheme({ theme: "light", lightTheme: SIDE_DEFAULT.dark.id, darkTheme: "graphite" }, false);
    expect([isDark(), themeId()]).toEqual([false, SIDE_DEFAULT.light.id]);
  });

  it("holds transitions off for one frame across a flip, so no paint lands half way between two themes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(cb => frames.push(cb));
    applyTheme({ theme: "light", lightTheme: "paper", darkTheme: "graphite" }, true);
    expect(document.documentElement.classList.contains("no-transitions")).toBe(true);
    for (const cb of frames) cb(0);
    expect(document.documentElement.classList.contains("no-transitions")).toBe(false);
  });

  it("the html element follows the computer's own scheme as it changes under system, and the record's pick pins a side", () => {
    let systemDark = false;
    const listeners = new Set<() => void>();
    vi.spyOn(window, "matchMedia").mockImplementation(query => {
      expect(query).toBe(SYSTEM_DARK_QUERY);
      return { get matches() { return systemDark; }, media: query, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) } as unknown as MediaQueryList;
    });
    renderHook(() => useThemeEffect());
    expect(isDark()).toBe(false);
    act(() => {
      systemDark = true;
      for (const fn of listeners) fn();
    });
    expect(isDark()).toBe(true);
    // The pick is a row in Settings: a side picked draws that side whatever the computer is set to.
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "light" } }));
    expect(isDark()).toBe(false);
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "dark" } }));
    expect(isDark()).toBe(true);
    act(() => {
      systemDark = false;
      for (const fn of listeners) fn();
    });
    expect(isDark()).toBe(true);
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "system" } }));
    expect(isDark()).toBe(false);
    // A side's pick moves the page at once when that side is the one drawn, and waits otherwise.
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "system", darkTheme: "not-registered" } }));
    expect(themeId()).toBe(SIDE_DEFAULT.light.id);
    act(() => {
      systemDark = true;
      for (const fn of listeners) fn();
    });
    expect([isDark(), themeId()]).toEqual([true, SIDE_DEFAULT.dark.id]);
  });

  it("a load keeps the side and the width this browser last held, and nothing the page no longer picks", async () => {
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "light", lightTheme: "linen", darkTheme: "denim", sidebarWidth: 312 }));
    vi.resetModules();
    const { useStore: bootStore } = await import("../src/protocol/store.js");
    expect(bootStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", lightTheme: "linen", darkTheme: "denim", sidebarWidth: 312 });
    act(() => bootStore.getState().applyEvent({ type: "preferences.changed", preferences: { ...DEFAULT_PREFERENCES, theme: "dark", darkTheme: "denim" } }));
    // The sidebar's body and the labs flag are off what this browser keeps: neither is drawn and neither is read.
    expect(JSON.parse(window.localStorage.getItem("wsp:first-paint")!)).toEqual({ theme: "dark", lightTheme: "paper", darkTheme: "denim" });
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "sepia" }));
    vi.resetModules();
    const { useStore: cleanStore } = await import("../src/protocol/store.js");
    expect(cleanStore.getState().preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("the desktop shell hears the picked value, so the window's frame draws the same side as the page", () => {
    const setTheme = vi.fn();
    window.wsp = { setTheme };
    renderHook(() => useThemeEffect());
    expect(setTheme).toHaveBeenLastCalledWith("system");
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "light" } }));
    expect(setTheme).toHaveBeenLastCalledWith("light");
    // A theme pick is the page's own: the shell is told the mode word and nothing else.
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "light", lightTheme: "linen" } }));
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(setTheme.mock.calls.every(([word]) => ["system", "light", "dark"].includes(word as string))).toBe(true);
  });
});
