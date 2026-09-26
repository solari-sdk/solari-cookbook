// SPDX-License-Identifier: AGPL-3.0-only
// Run by hand and commit the outputs; the icns step needs macOS for iconutil.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "..", "web");
const mark = readFileSync(join(web, "src", "brand", "mark.svg"), "utf8");
const favicon = readFileSync(join(web, "public", "favicon.svg"), "utf8");
const out = join(root, "build");
const FAVICON = 32;

const GROUND = "#09090b";
const INK = "#f4f4f5";
// Apple's icon grid: the square is 824 of a 1024 canvas with a 22.5% corner.
const SQUARE = 824 / 1024;
const CORNER = 0.2249;
const MARK = 0.6;

const ICNS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
const ICO = [16, 24, 32, 48, 64, 128, 256];

function page(size) {
  const square = size * SQUARE;
  const svg = mark.replace("<svg ", `<svg style="width:${square * MARK}px;height:${square * MARK}px" `);
  return `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
<div style="width:${square}px;height:${square}px;border-radius:${square * CORNER}px;background:${GROUND};color:${INK};display:flex;align-items:center;justify-content:center">${svg}</div>
</div></body></html>`;
}

function flat(svg, size) {
  return `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`;
}

function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}

const browser = await chromium.launch();
async function shoot(html, size) {
  const tab = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await tab.setContent(html);
  const png = await tab.screenshot({ omitBackground: true, type: "png" });
  await tab.close();
  return png;
}
const rendered = new Map();
async function render(size) {
  if (!rendered.has(size)) rendered.set(size, await shoot(page(size), size));
  return rendered.get(size);
}

mkdirSync(out, { recursive: true });
const iconset = mkdtempSync(join(tmpdir(), "wsp-icon-"));
const set = join(iconset, "icon.iconset");
mkdirSync(set);
for (const [name, size] of ICNS) writeFileSync(join(set, name), await render(size));
execFileSync("iconutil", ["-c", "icns", set, "-o", join(out, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });

const icoImages = [];
for (const size of ICO) icoImages.push([size, await render(size)]);
writeFileSync(join(out, "icon.ico"), ico(icoImages));
writeFileSync(join(web, "public", "favicon.png"), await shoot(flat(favicon, FAVICON), FAVICON));
await browser.close();
console.log(`wrote ${join(out, "icon.icns")}, ${join(out, "icon.ico")} and ${join(web, "public", "favicon.png")}`);
