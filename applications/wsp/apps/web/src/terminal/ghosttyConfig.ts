// SPDX-License-Identifier: AGPL-3.0-only
// The one place the person's Ghostty config meets the terminal surface: each
// key the host read is mapped onto the surface's options, and where the file
// set nothing the app's own value stands. The viewer's typed family beats the
// file's, since the card is the one choice the pane offers.
import type { TerminalConfig, TerminalRgb, TerminalScheme, TerminalSizeSource } from "@wsp/protocol";
import type { GhosttyCursorDefaults, GhosttyTheme } from "./ghostty/core";
import type { TerminalPadding } from "./ghostty/renderer";
import { DEFAULT_TERMINAL_PADDING, appTerminalFontSize, terminalFontSize, type GhosttyTerminalFont } from "./ghostty/surface";

export interface TerminalSurfaceSettings {
  readonly theme: GhosttyTheme;
  readonly font: GhosttyTerminalFont;
  readonly cursor?: GhosttyCursorDefaults;
  readonly padding: TerminalPadding;
  readonly backgroundOpacity: number;
}

const cssRgb = ({ r, g, b }: TerminalRgb): string => `rgb(${r}, ${g}, ${b})`;

/** How a pane's text size comes to be: where the base size is read from, and the pixels this workspace's zoom adds. */
export interface TerminalSizing {
  readonly source: TerminalSizeSource;
  readonly zoom: number;
}

export const DEFAULT_TERMINAL_SIZING: TerminalSizing = { source: "app", zoom: 0 };

/** The base size each source names, one rule per source; a file that names no size leaves the app's own. */
const BASE_SIZE: Record<TerminalSizeSource, (file: TerminalConfig | null) => number | undefined> = {
  app: () => undefined,
  file: file => file?.fontSize,
};

export const terminalBaseSize = (source: TerminalSizeSource, file: TerminalConfig | null): number => BASE_SIZE[source](file) ?? appTerminalFontSize();

/** The scheme the app is showing, which picks the side of a light:...,dark:... theme. */
export const appScheme = (): TerminalScheme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/** Each slot the file names over the app's own for that slot; a slot neither names keeps libghostty's. */
function paletteOver(file: TerminalConfig["palette"], app: GhosttyTheme["palette"]): GhosttyTheme["palette"] {
  const slots = Math.max(file.length, app?.length ?? 0);
  const merged = Array.from({ length: slots }, (_, index) => file[index] ?? app?.[index] ?? null);
  return merged.some(slot => slot !== null) ? merged : undefined;
}

/** The file's colors over the app's theme; a palette with nothing set is left out so libghostty keeps its own. */
export function terminalThemeWith(file: TerminalConfig | null, app: GhosttyTheme): GhosttyTheme {
  if (file === null) return app;
  const palette = paletteOver(file.palette, app.palette);
  return {
    background: file.background ?? app.background,
    foreground: file.foreground ?? app.foreground,
    cursor: file.cursorColor ?? app.cursor,
    ...(file.selectionBackground !== undefined ? { selectionBackground: cssRgb(file.selectionBackground) } : app.selectionBackground !== undefined ? { selectionBackground: app.selectionBackground } : {}),
    ...(palette !== undefined ? { palette } : {}),
  };
}

/** The face the pane draws with: the viewer's choice, else the file's family and fallbacks, else the viewport's own.
 * The size is the base the preference names, the app's own or the file's, plus the workspace's zoom, held to the
 * sizes the surface draws. */
export function terminalFontWith(file: TerminalConfig | null, viewport: GhosttyTerminalFont | undefined, chosen: boolean, sizing: TerminalSizing = DEFAULT_TERMINAL_SIZING): GhosttyTerminalFont {
  const size = terminalFontSize(terminalBaseSize(sizing.source, file) + sizing.zoom);
  const [family, ...fallbacks] = !chosen && file !== null ? file.fontFamily : [];
  const base: GhosttyTerminalFont | undefined = family !== undefined ? { family, ...(fallbacks.length > 0 ? { fallbacks } : {}) } : viewport;
  return { ...base, size };
}

export function terminalSurfaceSettings(file: TerminalConfig | null, app: GhosttyTheme, viewportFont: GhosttyTerminalFont | undefined, chosen: boolean, sizing: TerminalSizing = DEFAULT_TERMINAL_SIZING): TerminalSurfaceSettings {
  const font = terminalFontWith(file, viewportFont, chosen, sizing);
  const cursor: GhosttyCursorDefaults = {
    ...(file?.cursorStyle !== undefined ? { style: file.cursorStyle } : {}),
    ...(file?.cursorStyleBlink !== undefined ? { blink: file.cursorStyleBlink } : {}),
  };
  return {
    theme: terminalThemeWith(file, app),
    font,
    ...(Object.keys(cursor).length > 0 ? { cursor } : {}),
    padding: {
      left: file?.windowPaddingX?.left ?? DEFAULT_TERMINAL_PADDING.left,
      right: file?.windowPaddingX?.right ?? DEFAULT_TERMINAL_PADDING.right,
      top: file?.windowPaddingY?.top ?? DEFAULT_TERMINAL_PADDING.top,
      bottom: file?.windowPaddingY?.bottom ?? DEFAULT_TERMINAL_PADDING.bottom,
    },
    backgroundOpacity: file?.backgroundOpacity ?? 1,
  };
}
