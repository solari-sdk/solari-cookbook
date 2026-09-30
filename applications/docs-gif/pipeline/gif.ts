import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;

export type Frame = { png: Uint8Array; at?: { x: number; y: number } | null };

export const CURSOR = {
  w: 36,
  h: 40,
  hot: { x: 9.5, y: 7.2 },
  svg:
    `<svg width="36" height="40" viewBox="0 0 36 40" xmlns="http://www.w3.org/2000/svg">` +
    `<g transform="translate(4,4)" style="filter:drop-shadow(0 1.5px 2px rgba(0,0,0,.45))">` +
    `<path d="M5.5 3.2 L5.5 25.6 L11.2 20.1 L15 29.2 L19.6 27.2 L15.8 18.3 L23.7 18.3 Z" ` +
    `fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></g></svg>`,
};

export function toGif(frames: Frame[], cursorPng?: Uint8Array, delayMs = 1700) {
  const cursor = cursorPng && PNG.sync.read(Buffer.from(cursorPng));
  const gif = GIFEncoder();
  frames.forEach(({ png, at }, i) => {
    const { data, width, height } = PNG.sync.read(Buffer.from(png));
    if (at) {
      spotlight(data, width, height, at.x, at.y);
      if (cursor) blit(data, width, height, cursor, at.x - CURSOR.hot.x, at.y - CURSOR.hot.y);
    }
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, {
      palette,
      delay: i === frames.length - 1 ? delayMs * 3 : delayMs,
    });
  });
  gif.finish();
  return gif.bytes();
}

// assumes deviceScaleFactor 1; multiply x,y by the DPR if a context sets one.

export function spotlight(
  data: Uint8Array, width: number, height: number, cx: number, cy: number,
  inner = 26, outer = 42, dim = 0.38,
) {
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= inner) continue;
      const k = 1 - dim * (d >= outer ? 1 : (d - inner) / (outer - inner));
      const i = (y * width + x) * 4;
      data[i]! *= k; data[i + 1]! *= k; data[i + 2]! *= k;
    }
}

export function blit(
  data: Uint8Array, width: number, height: number,
  s: { data: Uint8Array; width: number; height: number }, ox: number, oy: number,
) {
  const x0 = Math.round(ox), y0 = Math.round(oy);
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const px = x0 + x, py = y0 + y;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const si = (y * s.width + x) * 4, a = s.data[si + 3]! / 255;
      if (!a) continue;
      const di = (py * width + px) * 4;
      for (let c = 0; c < 3; c++) data[di + c] = data[di + c]! * (1 - a) + s.data[si + c]! * a;
    }
}
