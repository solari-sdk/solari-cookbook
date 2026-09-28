// SPDX-License-Identifier: AGPL-3.0-only
// The terminal font as this viewer chose it, kept in localStorage; with no
// choice the pane draws with the family the collector read from the person's
// terminal config (the boot payload), and with neither its own default stack.
// The size is the other half: a base the preferences record names, the app's
// own text size or the Ghostty file's, and per workspace the pixels a zoom
// chord added, kept on the same record so every client draws the pane alike.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { bootPayload } from "../boot.js";
import type { TerminalViewportConfig } from "../components/ThreadTerminalDrawer.js";
import { useStore } from "../protocol/store.js";
import { terminalFontSize } from "./ghostty/surface.js";
import { terminalBaseSize } from "./ghosttyConfig.js";
import { terminalFile } from "./terminalFile.js";

export const TERMINAL_FONT_KEY = "wsp:terminal-font";
const CHANGE_EVENT = "wsp:terminal-font-change";
/** The step Ghostty's own zoom takes, in css px. */
const FONT_SIZE_STEP = 1;

/** The family this viewer chose, or undefined for none; a storage that throws reads as none. */
export function readTerminalFont(): string | undefined {
  try {
    const raw = window.localStorage.getItem(TERMINAL_FONT_KEY);
    const family = raw?.trim();
    return family === undefined || family.length === 0 ? undefined : family;
  } catch {
    return undefined;
  }
}

/** Saves the choice; an empty family clears it. A storage that throws leaves the page on its current font. */
export function writeTerminalFont(family: string): void {
  try {
    const trimmed = family.trim();
    if (trimmed.length === 0) window.localStorage.removeItem(TERMINAL_FONT_KEY);
    else window.localStorage.setItem(TERMINAL_FONT_KEY, trimmed);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The family the collector read from the person's terminal config, when the recipe ticked it. */
export function detectedTerminalFont(): string | undefined {
  const family = bootPayload()?.terminalFont?.trim();
  return family === undefined || family.length === 0 ? undefined : family;
}

/** The family the pane draws with: the viewer's choice, else the detected one, else undefined for the default stack. */
export function effectiveTerminalFont(): string | undefined {
  return readTerminalFont() ?? detectedTerminalFont();
}

/** The pixels this workspace's panes add to the base size; none until a zoom chord moves it. */
export const terminalZoomOf = (zoom: Readonly<Record<string, number>>, workspaceId: string): number => zoom[workspaceId] ?? 0;

/** One step of the terminal's own zoom, held so the size stays inside what the surface draws over the base the panes
 * draw from; the patch names this workspace alone, so another client's zoom on another workspace is kept. */
export function stepTerminalZoom(workspaceId: string, steps: number): void {
  const { preferences, setPreferences } = useStore.getState();
  const base = terminalBaseSize(preferences.terminalSize, terminalFile());
  const zoom = terminalFontSize(base + terminalZoomOf(preferences.terminalZoom, workspaceId) + steps * FONT_SIZE_STEP) - base;
  void setPreferences({ terminalZoom: { [workspaceId]: zoom } });
}

/** The panes back on the base size, with nothing of this workspace's own left on the record. */
export function resetTerminalZoom(workspaceId: string): void {
  const { preferences, setPreferences } = useStore.getState();
  if (!(workspaceId in preferences.terminalZoom)) return;
  void setPreferences({ terminalZoom: { [workspaceId]: null } });
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TERMINAL_FONT_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const chosen = (): string => readTerminalFont() ?? "";

export function useTerminalFont(): { family: string; detected: string | undefined; setFamily: (family: string) => void } {
  const family = useSyncExternalStore(subscribe, chosen, chosen);
  const setFamily = useCallback((next: string) => writeTerminalFont(next), []);
  return { family, detected: detectedTerminalFont(), setFamily };
}

/** The viewport config for the effective family and this workspace's sizing, saying whether the viewer typed the
 * family, since a typed family beats the one in their terminal config file where a detected one does not; its
 * identity changes only with those, so a chunk of output never rebuilds it. */
export function useTerminalViewportConfig(workspaceId: string): TerminalViewportConfig {
  const family = useSyncExternalStore(subscribe, effectiveTerminalFont, effectiveTerminalFont);
  const chosenFont = useSyncExternalStore(subscribe, chosen, chosen) !== "";
  const source = useStore(s => s.preferences.terminalSize);
  const zoom = useStore(s => terminalZoomOf(s.preferences.terminalZoom, workspaceId));
  return useMemo(() => ({ font: family !== undefined ? { family } : {}, chosenFont, sizing: { source, zoom } }), [family, chosenFont, source, zoom]);
}
