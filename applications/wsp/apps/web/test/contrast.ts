// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from "playwright";

/** WCAG contrast between two opaque colours, for pairs a test already holds rather than reads off an element. */
export const wcagContrast = (a: readonly number[], b: readonly number[]): number => {
  const lum = (rgb: readonly number[]): number => {
    const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

/** WCAG contrast of each element's text over what it sits on, translucent layers composited up to the first opaque one. */
export const textContrast = (page: Page, selector: string): Promise<number[]> =>
  page.locator(selector).evaluateAll(els =>
    els.map(el => {
      // Chromium reports colours mixed in oklch as color(srgb ...); a canvas pixel reads any of them as 8-bit rgba.
      const ctx = document.createElement("canvas").getContext("2d")!;
      const parse = (c: string): number[] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r!, g!, b!, a! / 255];
      };
      const over = (top: number[], under: number[]): number[] => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
      const layers: number[][] = [];
      for (let n: Element | null = el; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3]! > 0) layers.push(c);
      }
      const bg = layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const lum = (rgb: number[]): number => {
        const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
      };
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    }),
  );

/** The oklch hue of each element's text colour, in degrees to a tenth: what tells two tones apart to the eye once
 * they share a lightness. */
export const textHue = (page: Page, selector: string): Promise<number[]> =>
  page.locator(selector).evaluateAll(els =>
    els.map(el => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = getComputedStyle(el).color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      const lin = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      const [R, G, B] = [lin(r!), lin(g!), lin(b!)];
      const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
      const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
      const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
      const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
      const bq = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      return Math.round((((Math.atan2(bq, a) * 180) / Math.PI + 360) % 360) * 10) / 10;
    }),
  );
