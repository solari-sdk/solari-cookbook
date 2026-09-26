// SPDX-License-Identifier: AGPL-3.0-only
// Run by hand and commit the outputs; the disk image's window is drawn from
// them. The look is the app's light theme, and light for one reason: Finder
// draws the icon names dark whatever the appearance, so only a light ground
// lets them read. One glow in the app's primary behind the two icons, an even
// dot grid, one hairline arrow from the app to the folder, one mono line.
// Nothing else.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DMG_ARROW, DMG_ICONS, DMG_LINE, DMG_WINDOW } from "./dmg-layout.mjs";

const out = join(fileURLToPath(new URL("..", import.meta.url)), "build");

const LINE = "your setup, on cloud machines";

/** The app's light side: zinc-25 as the ground, zinc-500 as the one ink for the arrow and the line, its primary as the
 * glow's hue. */
const GROUND = "oklch(99.2% 0 0)";
const INK = "#71717a";
const GLOW = "oklch(0.488 0.217 264 / 16%)";
/** The grid's pitch divides both sides of the window, so the dots meet every edge the same way. */
const PITCH = 20;
const DOT_ALPHA = 0.05;

function page() {
  const { width, height } = DMG_WINDOW;
  const centre = { x: (DMG_ICONS.app.x + DMG_ICONS.applications.x) / 2, y: DMG_ICONS.app.y };
  const { from, to, y, stroke, head } = DMG_ARROW;
  return `<!doctype html><html><body style="margin:0;background:${GROUND}">
<div style="position:relative;width:${width}px;height:${height}px;overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(320px 180px at ${centre.x}px ${centre.y}px, ${GLOW}, transparent 70%)"></div>
  <svg width="${width}" height="${height}" style="position:absolute;inset:0">
    <defs><pattern id="dots" width="${PITCH}" height="${PITCH}" patternUnits="userSpaceOnUse">
      <circle cx="${PITCH / 2}" cy="${PITCH / 2}" r="1" fill="rgba(0,0,0,${DOT_ALPHA})" />
    </pattern></defs>
    <rect width="100%" height="100%" fill="url(#dots)" />
    <path d="M${from} ${y}H${to}M${to - head} ${y - head}L${to} ${y}L${to - head} ${y + head}"
      fill="none" stroke="${INK}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
  <p style="position:absolute;left:0;right:0;top:${DMG_LINE.y}px;margin:0;transform:translateY(-50%);text-align:center;
    color:${INK};font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:${DMG_LINE.size}px;line-height:1;letter-spacing:0.06em">${LINE}</p>
</div></body></html>`;
}

const browser = await chromium.launch();
async function shoot(scale) {
  const tab = await browser.newPage({ viewport: DMG_WINDOW, deviceScaleFactor: scale });
  await tab.setContent(page());
  const png = await tab.screenshot({ type: "png" });
  await tab.close();
  return png;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "dmg-background.png"), await shoot(1));
writeFileSync(join(out, "dmg-background@2x.png"), await shoot(2));
await browser.close();
console.log(`wrote ${join(out, "dmg-background.png")} and ${join(out, "dmg-background@2x.png")}`);
