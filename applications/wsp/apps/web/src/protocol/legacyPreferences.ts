// SPDX-License-Identifier: AGPL-3.0-only
// The picks the page once kept in this browser's localStorage, read once so a
// person's own survive the move onto the host's record, and dropped once the
// host has them. A browser that never held them reads as nothing to move. The
// three view preferences were the first; the composer's access pick is the
// fourth, and it shares that key with the picks that stay in this browser, so
// only its own field is read and cleared.
import { SidebarMode, type PreferencesPatch } from "@wsp/protocol";
import { appTerminalFontSize } from "../terminal/ghostty/surface.js";

const SIDEBAR_WIDTH_KEY = "wsp:sidebar-width";
const SIDEBAR_MODE_KEY = "wsp:sidebar-mode";
const TERMINAL_SIZE_PREFIX = "wsp:terminal-font-size:";
const COMPOSER_OPTIONS_KEY = "wsp:composer-options:v1";

const keysOf = (storage: Storage): string[] => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null);

/** The old width was JSON; anything else under the key reads as none. */
function widthOf(raw: string | null): number | undefined {
  try {
    const width = Number(JSON.parse(raw ?? "null"));
    return Number.isFinite(width) && width > 0 ? Math.round(width) : undefined;
  } catch {
    return undefined;
  }
}

/** The workspaces the composer's own key holds an access pick for, as zustand persisted that store. Its other picks
 * are this browser's and stay; a key that is not the shape this reads holds nothing to move. */
function composerAccess(storage: Storage): Record<string, string> {
  const picks: Record<string, string> = {};
  try {
    const rows = (JSON.parse(storage.getItem(COMPOSER_OPTIONS_KEY) ?? "null") as { state?: { byWorkspaceId?: Record<string, { permissionMode?: unknown }> } } | null)?.state
      ?.byWorkspaceId;
    for (const [workspaceId, options] of Object.entries(rows ?? {})) {
      const mode = options?.permissionMode;
      if (typeof mode === "string" && mode !== "") picks[workspaceId] = mode;
    }
  } catch {
    return {};
  }
  return picks;
}

/** What the old keys hold, as a patch for the host's record, or null when this browser kept none of them. A storage that
 * throws reads as none. The old per-workspace size was absolute; the record keeps the pixels added to the app's size. */
export function legacyPreferences(storage: Storage): PreferencesPatch | null {
  const patch: PreferencesPatch = {};
  try {
    const width = widthOf(storage.getItem(SIDEBAR_WIDTH_KEY));
    if (width !== undefined) patch.sidebarWidth = width;
    const mode = SidebarMode.safeParse(storage.getItem(SIDEBAR_MODE_KEY));
    if (mode.success) patch.sidebarMode = mode.data;
    const zoom: Record<string, number> = {};
    for (const key of keysOf(storage)) {
      if (!key.startsWith(TERMINAL_SIZE_PREFIX)) continue;
      const size = Number(storage.getItem(key));
      if (Number.isFinite(size)) zoom[key.slice(TERMINAL_SIZE_PREFIX.length)] = Math.round(size) - appTerminalFontSize();
    }
    if (Object.keys(zoom).length > 0) patch.terminalZoom = zoom;
    const access = composerAccess(storage);
    if (Object.keys(access).length > 0) patch.access = access;
  } catch {
    return null;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Drops the old keys; called once the host answered with them on its record. The composer's key is not dropped,
 * only the access field inside it: the harness, model, effort and window picks under it are still this browser's. */
export function clearLegacyPreferences(storage: Storage): void {
  try {
    for (const key of keysOf(storage)) if (key === SIDEBAR_WIDTH_KEY || key === SIDEBAR_MODE_KEY || key.startsWith(TERMINAL_SIZE_PREFIX)) storage.removeItem(key);
    const held = JSON.parse(storage.getItem(COMPOSER_OPTIONS_KEY) ?? "null") as { state?: { byWorkspaceId?: Record<string, Record<string, unknown>> } } | null;
    const rows = held?.state?.byWorkspaceId;
    if (rows === undefined || rows === null) return;
    for (const options of Object.values(rows)) delete options["permissionMode"];
    storage.setItem(COMPOSER_OPTIONS_KEY, JSON.stringify(held));
  } catch {
    return;
  }
}
