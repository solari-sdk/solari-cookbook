// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: mounts the terminal surface and reports,
// per cell, how many pixels the text painted and a hash of where, so a test can
// tell a drawn icon from the notdef box, from nothing, and from another face's.
import type { GhosttyTheme } from "../../src/terminal/ghostty/core";
import { CONTENT_PADDING, GhosttyTerminalSurface } from "../../src/terminal/ghostty/surface";

export interface CellSignature {
  lit: number;
  hash: number;
}

// A black cursor: the cursor cell's own paint must not count as a drawn glyph.
const theme: GhosttyTheme = {
  background: { r: 0, g: 0, b: 0 },
  foreground: { r: 255, g: 255, b: 255 },
  cursor: { r: 0, g: 0, b: 0 },
};

const surface = GhosttyTerminalSurface.create(document.getElementById("mount")!, {
  theme,
  onData: () => {},
  onResize: () => {},
  onSelectionChange: () => {},
  beforeKey: () => true,
  onLinkActivate: () => {},
});

/** The first cell after one glyph is drawn alone: a run's fillText squeezes to its cells' width and a neighbouring
 * row's paint can touch a cell, so each glyph is judged on an otherwise empty screen. */
async function drawGlyph(text: string, family?: string): Promise<CellSignature> {
  const s = await surface;
  if (family !== undefined) await s.setFont({ family });
  s.resetAndWrite(text);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const context = s.canvas.getContext("2d")!;
  const { width, height } = s.canvas;
  const data = context.getImageData(0, 0, width, height).data;
  const dpr = window.devicePixelRatio;
  const padding = CONTENT_PADDING * dpr;
  const cellWidth = (width - 2 * padding) / s.cols;
  const cellHeight = (height - 2 * padding) / s.rows;
  const cell: CellSignature = { lit: 0, hash: 0 };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! <= 40) continue;
    const px = (i >> 2) % width;
    const py = Math.floor((i >> 2) / width);
    if (px - padding >= cellWidth || py - padding >= cellHeight) continue;
    cell.lit += 1;
    cell.hash = (cell.hash * 31 + (py * 4096 + px)) >>> 0;
  }
  return cell;
}

Object.assign(window, { drawGlyph });
