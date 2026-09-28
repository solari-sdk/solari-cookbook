// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the terminal surface opened on a Ghostty
// config the way the drawer opens it, one known theme per app scheme with a
// translucent background over a page that has something behind it to show,
// and a probe that reads the canvas back so a test can check the paint.
import type { TerminalConfig } from "@wsp/protocol";
import "../../src/index.css";
import "../../src/themes/index";
import { terminalThemeFromApp } from "../../src/components/ThreadTerminalDrawer";
import type { GhosttyTheme } from "../../src/terminal/ghostty/core";
import { appTerminalFontSize, GhosttyTerminalSurface } from "../../src/terminal/ghostty/surface";
import { terminalSurfaceSettings } from "../../src/terminal/ghosttyConfig";

const rgb = (hex: string) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) });
const palette = (hexes: string[]) => hexes.map(rgb);

/** Catppuccin Mocha and Catppuccin Latte as Ghostty ships them, at the opacity, cursor and padding a translucent config asks for. */
const FILES: Record<"dark" | "light", TerminalConfig> = {
  dark: {
    files: ["/Users/dev/.config/ghostty/config", "/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha"],
    fontFamily: [],
    fontSize: 14,
    theme: "Catppuccin Mocha",
    background: rgb("1e1e2e"),
    foreground: rgb("cdd6f4"),
    palette: palette(["45475a", "f38ba8", "a6e3a1", "f9e2af", "89b4fa", "f5c2e7", "94e2d5", "a6adc8", "585b70", "f37799", "89d88b", "ebd391", "74a8fc", "f2aede", "6bd7ca", "bac2de"]),
    selectionBackground: rgb("585b70"),
    cursorColor: rgb("f5e0dc"),
    cursorStyle: "underline",
    cursorStyleBlink: false,
    windowPaddingX: { left: 12, right: 12 },
    windowPaddingY: { top: 10, bottom: 10 },
    backgroundOpacity: 0.85,
    backgroundBlur: 20,
  },
  light: {
    files: ["/Users/dev/.config/ghostty/config", "/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Latte"],
    fontFamily: [],
    fontSize: 14,
    theme: "Catppuccin Latte",
    background: rgb("eff1f5"),
    foreground: rgb("4c4f69"),
    palette: palette(["bcc0cc", "d20f39", "40a02b", "df8e1d", "1e66f5", "ea76cb", "179299", "5c5f77", "acb0be", "de293e", "49af3d", "eea02d", "456eff", "fe85d8", "2d9fa8", "6c6f85"]),
    selectionBackground: rgb("acb0be"),
    cursorColor: rgb("dc8a78"),
    cursorStyle: "underline",
    cursorStyleBlink: false,
    windowPaddingX: { left: 12, right: 12 },
    windowPaddingY: { top: 10, bottom: 10 },
    backgroundOpacity: 0.85,
    backgroundBlur: 20,
  },
};

const APP: Record<"dark" | "light", GhosttyTheme> = {
  dark: { background: { r: 14, g: 18, b: 24 }, foreground: { r: 237, g: 241, b: 247 }, cursor: { r: 180, g: 203, b: 255 } },
  light: { background: { r: 255, g: 255, b: 255 }, foreground: { r: 28, g: 33, b: 41 }, cursor: { r: 38, g: 56, b: 78 } },
};

const params = new URLSearchParams(location.search);
const scheme = params.get("theme") === "light" ? "light" : "dark";
// ?palette=app is the person's file naming no colors of its own: the pane opens on the theme the
// stylesheet holds, as the drawer opens it, so the slots the app itself brings can be read back.
const fromApp = params.get("palette") === "app";
document.documentElement.classList.toggle("dark", scheme === "dark");
// Something behind the terminal to show through: the app's column color under stripes, so the blend is visible in a screenshot.
const page = document.getElementById("page")!;
page.style.background = scheme === "dark" ? "repeating-linear-gradient(135deg, #0e1218 0 24px, #2a3550 24px 48px)" : "repeating-linear-gradient(135deg, #ffffff 0 24px, #c9d6ee 24px 48px)";

const BARE: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], palette: Array<null>(16).fill(null) };
const file = fromApp ? BARE : FILES[scheme];
const settings = terminalSurfaceSettings(file, fromApp ? terminalThemeFromApp() : APP[scheme], undefined, false);
const surface = GhosttyTerminalSurface.create(document.getElementById("mount")!, {
  ...settings,
  onData: () => {},
  onResize: () => {},
  onSelectionChange: () => {},
  beforeKey: () => true,
  onLinkActivate: () => {},
}).then(s => {
  if (fromApp) {
    // One word per slot, so every one of the sixteen is on the canvas to be read back.
    for (let slot = 0; slot < 8; slot++) s.write(`\x1b[3${slot}mslot-${slot}\x1b[0m `);
    s.write("\r\n");
    for (let slot = 0; slot < 8; slot++) s.write(`\x1b[9${slot}mslot-${slot + 8}\x1b[0m `);
    s.write("\r\n$ ");
    return s;
  }
  s.write("\x1b[1mwsp\x1b[0m on \x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[33myellow\x1b[0m \x1b[34mblue\x1b[0m \x1b[35mpink\x1b[0m \x1b[36mteal\x1b[0m\r\n");
  s.write(`theme ${file.theme}, background-opacity ${file.backgroundOpacity}, cursor ${file.cursorStyle}\r\n$ `);
  return s;
});

export interface Probe {
  /** The canvas pixel in the padding corner, as stored: the theme background with the file's alpha. */
  corner: [number, number, number, number];
  /** Whether some pixel painted the palette's slot one, which the red word asks for. */
  paletteOne: boolean;
  /** The cursor cell's bottom rows carry the cursor color when the style is underline. */
  underline: boolean;
  cols: number;
  rows: number;
  /** The size the text draws at and the cell it fits: the app's own text size, never the file's. */
  textSize: number;
  cellHeight: number;
  /** The cell the meta-label size would fit, which the pane is no longer read at. */
  metaSize: number;
  metaCellHeight: number;
}

async function probe(): Promise<Probe> {
  const s = await surface;
  // An unfocused surface draws a hollow cursor whatever the style; the file's style shows on the focused one.
  s.focus();
  await new Promise(resolve => setTimeout(resolve, 200));
  const context = s.canvas.getContext("2d")!;
  const { width, height } = s.canvas;
  const data = context.getImageData(0, 0, width, height).data;
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
  };
  const near = (a: readonly number[], b: readonly number[], slack = 12) => a.every((v, i) => Math.abs(v - b[i]!) <= slack);
  let paletteOne = false;
  const one = file.palette[1]!;
  const cursor = file.cursorColor!;
  // Where the cursor color was painted: an underline cursor is a strip two device pixels tall, a block fills its cell.
  const box = { left: width, right: -1, top: height, bottom: -1 };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! <= 250) continue;
    const px = [data[i]!, data[i + 1]!, data[i + 2]!];
    if (near(px, [one.r, one.g, one.b], 6)) paletteOne = true;
    if (near(px, [cursor.r, cursor.g, cursor.b], 6)) {
      const x = (i >> 2) % width;
      const y = Math.floor((i >> 2) / width);
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
  }
  const dpr = window.devicePixelRatio;
  const underline = box.right >= 0 && box.bottom - box.top + 1 <= 2 * dpr + 1 && box.right - box.left + 1 >= 4 * dpr;
  const textSize = s.textSize;
  const cellHeight = s.cellHeight;
  // Both sizes come off the stylesheet the app ships; the pane is drawn at the meta one only to measure its cell,
  // then put back, so the shot is of the app's text size again.
  const metaSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-size-mono"));
  await s.setFont({ size: metaSize });
  const metaCellHeight = s.cellHeight;
  await s.setFont({});
  return { corner: at(2, 2), paletteOne, underline, cols: s.cols, rows: s.rows, textSize, cellHeight, metaSize, metaCellHeight };
}

/** What the pane brought of its own: the background it drew and, per slot, whether that slot's word was painted in it. */
export interface PaletteProbe {
  background: [number, number, number];
  /** A slot the theme left for libghostty reports a null colour, so a hole fails the assertion rather than throwing. */
  slots: { slot: number; color: [number, number, number] | null; painted: boolean }[];
}

async function probePalette(): Promise<PaletteProbe> {
  const s = await surface;
  await new Promise(resolve => setTimeout(resolve, 200));
  const { width, height } = s.canvas;
  const data = s.canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const opaque = new Set<string>();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 250) opaque.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  const { background, palette } = settings.theme;
  return {
    background: [background.r, background.g, background.b],
    slots: (palette ?? []).map((color, slot) => ({
      slot,
      color: color === null ? null : ([color.r, color.g, color.b] as [number, number, number]),
      painted: color !== null && opaque.has(`${color.r},${color.g},${color.b}`),
    })),
  };
}

Object.assign(window, { probe, probePalette });
