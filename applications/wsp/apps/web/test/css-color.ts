// SPDX-License-Identifier: AGPL-3.0-only
// The colour values a stylesheet declares, resolved in the test itself so a theme's floors are measured from what
// its file says rather than read back from a browser: hex, rgb(), oklch(), the three keywords, var() against the
// declarations beside it, and color-mix() in srgb or oklab with the spec's premultiplied alpha.

/** Red, green and blue from 0 to 1 in sRGB, and alpha from 0 to 1. */
export type Rgba = readonly [number, number, number, number];

const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklab([r, g, b]: Rgba): [number, number, number] {
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab(L: number, A: number, B: number, alpha: number): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = (v: number): number => Math.min(1, Math.max(0, gam(v)));
  return [clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), alpha];
}

/** The chroma of a colour in oklch. */
export const chroma = (c: Rgba): number => {
  const [, a, b] = toOklab(c);
  return Math.hypot(a, b);
};

/** Splits at the commas that are not inside parentheses. */
function topLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(from, i).trim());
      from = i + sep.length;
    }
  }
  out.push(text.slice(from).trim());
  return out;
}

const num = (v: string, scale = 1): number => (v === "none" ? 0 : v.endsWith("%") ? (Number.parseFloat(v) / 100) * scale : Number.parseFloat(v));

/** A colour value as its declarations name it; `vars` answers var() with the raw text of another declaration. */
export function resolveColor(value: string, vars: (name: string) => string | undefined): Rgba {
  const v = value.trim();
  const call = /^([a-z-]+)\((.*)\)$/s.exec(v);
  if (v === "transparent") return [0, 0, 0, 0];
  if (v === "white") return [1, 1, 1, 1];
  if (v === "black") return [0, 0, 0, 1];
  if (v.startsWith("#")) {
    const h = v.length === 4 ? [...v.slice(1)].map(c => c + c).join("") : v.slice(1);
    return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16) / 255).concat(1) as unknown as Rgba;
  }
  if (call === null) throw new Error(`not a colour: ${v}`);
  const [, fn, body] = call as unknown as [string, string, string];
  if (fn === "var") {
    const [name, fallback] = topLevel(body, ",");
    const raw = vars(name!) ?? fallback;
    if (raw === undefined) throw new Error(`no value for ${name}`);
    return resolveColor(raw, vars);
  }
  if (fn === "rgb" || fn === "oklch") {
    const [channels, alphaText] = body.split("/").map(s => s.trim());
    const parts = channels!.split(/\s+/);
    const alpha = alphaText === undefined ? 1 : num(alphaText);
    if (fn === "rgb") return [num(parts[0]!, 255) / 255, num(parts[1]!, 255) / 255, num(parts[2]!, 255) / 255, alpha];
    const L = num(parts[0]!);
    const C = num(parts[1]!, 0.4);
    const H = (num(parts[2]!) * Math.PI) / 180;
    return fromOklab(L, C * Math.cos(H), C * Math.sin(H), alpha);
  }
  if (fn === "color-mix") {
    const [space, first, second] = topLevel(body, ",");
    const arg = (text: string): { color: Rgba; pct: number | undefined } => {
      const m = /^(.*?)\s+(-?[\d.]+%)$/s.exec(text);
      return m === null ? { color: resolveColor(text, vars), pct: undefined } : { color: resolveColor(m[1]!, vars), pct: Number.parseFloat(m[2]!) / 100 };
    };
    const a = arg(first!);
    const b = arg(second!);
    let p1 = a.pct ?? (b.pct === undefined ? 0.5 : 1 - b.pct);
    let p2 = b.pct ?? 1 - p1;
    const sum = p1 + p2;
    p1 /= sum;
    p2 /= sum;
    const scale = Math.min(1, sum);
    const alpha = a.color[3] * p1 + b.color[3] * p2;
    if (alpha === 0) return [0, 0, 0, 0];
    const into = space === "in oklab" ? (c: Rgba) => toOklab(c) : (c: Rgba) => [c[0], c[1], c[2]] as [number, number, number];
    if (space !== "in oklab" && space !== "in srgb") throw new Error(`mix space not read: ${space}`);
    const ca = into(a.color);
    const cb = into(b.color);
    const mixed = [0, 1, 2].map(i => (ca[i]! * a.color[3] * p1 + cb[i]! * b.color[3] * p2) / alpha) as [number, number, number];
    return space === "in oklab" ? fromOklab(mixed[0], mixed[1], mixed[2], alpha * scale) : [mixed[0], mixed[1], mixed[2], alpha * scale];
  }
  throw new Error(`colour function not read: ${fn}`);
}

/** A translucent colour laid over an opaque one. */
export const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map(i => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as unknown as Rgba;

const luminance = ([r, g, b]: Rgba): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG 2 contrast between an ink and the opaque ground it is laid on. */
export function contrast(ink: Rgba, ground: Rgba): number {
  const [hi, lo] = [luminance(over(ink, ground)), luminance(ground)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The custom properties a block declares, in order, nested blocks skipped. */
export function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let flat = "";
  for (const ch of body) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0) flat += ch;
  }
  for (const part of flat.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const m = /^\s*(--[\w-]+|color-scheme)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m !== null) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** The body of the first block whose header matches, braces balanced. */
export function blockBody(css: string, header: RegExp): string | undefined {
  const m = header.exec(css);
  if (m === null) return undefined;
  const brace = m[0].lastIndexOf("{");
  let i = brace === -1 ? css.indexOf("{", m.index + m[0].length) : m.index + brace;
  const start = i + 1;
  let depth = 1;
  while (depth > 0 && ++i < css.length) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return css.slice(start, i);
}
