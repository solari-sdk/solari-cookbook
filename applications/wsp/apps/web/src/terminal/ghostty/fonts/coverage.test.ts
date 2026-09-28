// SPDX-License-Identifier: AGPL-3.0-only
// The bundled symbols face is the last fallback for every icon a prompt or a
// file lister draws; this pins that its cmap still covers the Nerd Font
// ranges yazi, starship and eza use.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// jsdom's URL resolves relative references against the page origin, so the path is built with node:path.
const WOFF2 = resolve(dirname(fileURLToPath(import.meta.url)), "SymbolsNerdFontMono-Regular.woff2");

/** The WOFF2 known-tag table, by the index the directory's flag byte carries. */
const KNOWN_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

function base128(view: DataView, at: { pos: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = view.getUint8(at.pos);
    at.pos += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error("UIntBase128 too long");
}

/** The decompressed cmap table of a WOFF2 file: the only table the check needs and one WOFF2 never transforms. */
function cmapOf(file: Buffer): DataView {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(file.toString("latin1", 0, 4)).toBe("wOF2");
  const numTables = view.getUint16(12);
  const compressedLength = view.getUint32(20);
  const at = { pos: 48 };
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = view.getUint8(at.pos);
    at.pos += 1;
    let tag: string;
    if ((flags & 0x3f) === 63) {
      tag = file.toString("latin1", at.pos, at.pos + 4);
      at.pos += 4;
    } else tag = KNOWN_TAGS[flags & 0x3f]!;
    const origLength = base128(view, at);
    const transform = (flags >> 6) & 3;
    const transformed = tag === "glyf" || tag === "loca" ? transform === 0 : transform !== 0;
    const length = transformed ? base128(view, at) : origLength;
    tables.push({ tag, length });
  }
  const data = brotliDecompressSync(file.subarray(at.pos, at.pos + compressedLength));
  let offset = 0;
  for (const t of tables) {
    if (t.tag === "cmap") return new DataView(data.buffer, data.byteOffset + offset, t.length);
    offset += t.length;
  }
  throw new Error("no cmap table");
}

/** Every codepoint the cmap maps, from its format 12 subtable, else its format 4 one. */
function codepoints(cmap: DataView): Set<number> {
  const out = new Set<number>();
  const count = cmap.getUint16(2);
  let format12: number | undefined;
  let format4: number | undefined;
  for (let i = 0; i < count; i += 1) {
    const offset = cmap.getUint32(4 + 8 * i + 4);
    const format = cmap.getUint16(offset);
    if (format === 12) format12 ??= offset;
    if (format === 4) format4 ??= offset;
  }
  if (format12 !== undefined) {
    const groups = cmap.getUint32(format12 + 12);
    for (let g = 0; g < groups; g += 1) {
      const at = format12 + 16 + 12 * g;
      const start = cmap.getUint32(at);
      const end = cmap.getUint32(at + 4);
      for (let cp = start; cp <= end; cp += 1) out.add(cp);
    }
    return out;
  }
  if (format4 === undefined) throw new Error("no usable cmap subtable");
  const segCount = cmap.getUint16(format4 + 6) / 2;
  for (let s = 0; s < segCount; s += 1) {
    const end = cmap.getUint16(format4 + 14 + 2 * s);
    const start = cmap.getUint16(format4 + 16 + 2 * segCount + 2 * s);
    if (start === 0xffff) continue;
    for (let cp = start; cp <= end; cp += 1) out.add(cp);
  }
  return out;
}

describe("the bundled Symbols Nerd Font Mono", () => {
  const covered = codepoints(cmapOf(readFileSync(WOFF2)));

  it.each([
    ["nf-fa folder (yazi, eza)", 0xf07b],
    ["nf-fa home (starship)", 0xf015],
    ["nf-fa file-text (eza)", 0xf15c],
    ["nf-dev git (starship)", 0xe702],
    ["nf-dev react (eza)", 0xe7ba],
    ["nf-dev nodejs (eza)", 0xe718],
    ["nf-md file (yazi)", 0xf0219],
    ["nf-md folder (yazi)", 0xf024b],
    ["nf-md language-typescript (yazi)", 0xf06e6],
    ["nf-oct git-branch (starship)", 0xf418],
    ["nf-oct repo (starship)", 0xf401],
    ["nf-oct file-directory (eza)", 0xf413],
    ["nf-pl left hard divider (prompts)", 0xe0b0],
    ["nf-pl right hard divider (prompts)", 0xe0b2],
    ["nf-custom folder (yazi)", 0xe5ff],
    ["nf-seti typescript (eza)", 0xe628],
    ["nf-linux apple (starship)", 0xf302],
  ])("covers %s", (_name, codepoint) => {
    expect(covered.has(codepoint)).toBe(true);
  });

  it("carries the whole nf-md and nf-fa ranges, and no letters, so it never changes the text face's metrics", () => {
    const within = (from: number, to: number) => { let n = 0; for (let cp = from; cp <= to; cp += 1) if (covered.has(cp)) n += 1; return n; };
    expect(within(0xf0001, 0xf1af0)).toBeGreaterThan(6000);
    expect(within(0xf000, 0xf2e0)).toBeGreaterThan(600);
    expect(within(0x41, 0x7a)).toBe(0);
    expect(covered.has(0x10fffd)).toBe(false);
  });
});
