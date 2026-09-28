// SPDX-License-Identifier: AGPL-3.0-only
// The computer's installed fonts, read by name from their files so the
// terminal pane can draw with the person's own face and its Nerd Font
// variant without a list of names anywhere.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { LocalFontFace } from "@wsp/protocol";

export interface FontFile {
  path: string;
  family: string;
  subfamily: string;
  fullName: string;
  postscript: string;
  /** OS/2 usWeightClass; 400 when the table is missing. */
  weight: number;
  italic: boolean;
}

export interface FontReader {
  /** Every file under dir, any depth; empty when dir is missing. */
  list(dir: string): string[];
  readAt(path: string, offset: number, length: number): Uint8Array;
}

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc"]);
const TTCF = 0x74746366;
const NAME_IDS = { family: 1, subfamily: 2, fullName: 4, postscript: 6, typographicFamily: 16, typographicSubfamily: 17 } as const;

function utf16be(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

interface Table {
  offset: number;
  length: number;
}

/** Bytes of one font file, read by range: a file's name table sits past its glyphs, so the whole file is never read. */
interface Source {
  read(offset: number, length: number): Uint8Array;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tableDirectory(source: Source, faceOffset: number): Map<string, Table> | undefined {
  const head = viewOf(source.read(faceOffset, 12));
  if (head.byteLength < 12) return undefined;
  const numTables = head.getUint16(4);
  const records = source.read(faceOffset + 12, 16 * numTables);
  if (records.byteLength < 16 * numTables) return undefined;
  const view = viewOf(records);
  const tables = new Map<string, Table>();
  for (let i = 0; i < numTables; i += 1) {
    const at = 16 * i;
    tables.set(latin1(records.subarray(at, at + 4)), { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return tables;
}

/** The name table's strings by id: Windows English first, then any Unicode or Mac record. */
function names(bytes: Uint8Array): Map<number, string> {
  const view = viewOf(bytes);
  const out = new Map<number, { text: string; rank: number }>();
  if (view.byteLength < 6) return new Map();
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 12 * i;
    if (at + 12 > view.byteLength) break;
    const platform = view.getUint16(at);
    const language = view.getUint16(at + 4);
    const id = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const start = storage + view.getUint16(at + 10);
    if (start + length > view.byteLength) continue;
    const slice = bytes.subarray(start, start + length);
    const text = platform === 1 ? latin1(slice) : utf16be(slice);
    const rank = platform === 3 && language === 0x409 ? 0 : platform === 3 || platform === 0 ? 1 : 2;
    const have = out.get(id);
    if (text.length > 0 && (have === undefined || rank < have.rank)) out.set(id, { text, rank });
  }
  return new Map([...out].map(([id, v]) => [id, v.text]));
}

function face(source: Source, faceOffset: number, path: string): FontFile | undefined {
  const tables = tableDirectory(source, faceOffset);
  const name = tables?.get("name");
  if (tables === undefined || name === undefined) return undefined;
  const n = names(source.read(name.offset, name.length));
  const family = n.get(NAME_IDS.typographicFamily) ?? n.get(NAME_IDS.family);
  if (family === undefined) return undefined;
  const subfamily = n.get(NAME_IDS.typographicSubfamily) ?? n.get(NAME_IDS.subfamily) ?? "Regular";
  const os2Table = tables.get("OS/2");
  const os2 = os2Table === undefined ? undefined : viewOf(source.read(os2Table.offset, 64));
  const hasOs2 = os2 !== undefined && os2.byteLength >= 64;
  const weight = hasOs2 ? os2.getUint16(4) : /bold/i.test(subfamily) ? 700 : 400;
  const italic = hasOs2 ? (os2.getUint16(62) & 0x201) !== 0 : /italic|oblique/i.test(subfamily);
  return {
    path,
    family,
    subfamily,
    fullName: n.get(NAME_IDS.fullName) ?? `${family} ${subfamily}`,
    postscript: n.get(NAME_IDS.postscript) ?? "",
    weight: weight > 0 ? weight : 400,
    italic,
  };
}

function parseFont(source: Source, path: string): FontFile[] {
  try {
    const head = viewOf(source.read(0, 12));
    if (head.byteLength < 12) return [];
    if (head.getUint32(0) === TTCF) {
      const count = head.getUint32(8);
      const offsets = viewOf(source.read(12, 4 * count));
      const out: FontFile[] = [];
      for (let i = 0; 4 * i + 4 <= offsets.byteLength; i += 1) {
        const f = face(source, offsets.getUint32(4 * i), path);
        if (f !== undefined) out.push(f);
      }
      return out;
    }
    const f = face(source, 0, path);
    return f === undefined ? [] : [f];
  } catch {
    return [];
  }
}

/** Every face a TrueType, OpenType or collection file names; nothing for a file that is not one. */
export function parseFontFile(bytes: Uint8Array, path: string): FontFile[] {
  return parseFont({ read: (offset, length) => bytes.subarray(offset, offset + length) }, path);
}

/** Where each platform keeps fonts, the person's own directory first. */
export function fontDirs(platform: string, home: string, env: Record<string, string | undefined>): string[] {
  if (platform === "darwin") return [join(home, "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts", "/System/Library/Fonts/Supplemental"];
  if (platform === "win32") {
    return [
      ...(env["LOCALAPPDATA"] !== undefined ? [join(env["LOCALAPPDATA"], "Microsoft", "Windows", "Fonts")] : []),
      ...(env["WINDIR"] !== undefined ? [join(env["WINDIR"], "Fonts")] : []),
    ];
  }
  return [join(env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "fonts"), join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
}

function listFiles(dir: string, depth: number, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const s = statSync(path);
      if (s.isDirectory()) {
        if (depth > 0) listFiles(path, depth - 1, out);
      } else if (s.isFile()) out.push(path);
    } catch {
      // A dangling link or an unreadable entry is not a font.
    }
  }
}

export const nodeFontReader: FontReader = {
  list(dir) {
    const out: string[] = [];
    listFiles(dir, 3, out);
    return out;
  },
  readAt(path, offset, length) {
    const fd = openSync(path, "r");
    try {
      const buffer = new Uint8Array(length);
      const read = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  },
};

/** Every face in the font directories, read from each file's directory, name and OS/2 tables only. */
export async function indexFonts(dirs: readonly string[], reader: FontReader = nodeFontReader): Promise<FontFile[]> {
  const out: FontFile[] = [];
  for (const dir of dirs) {
    for (const path of reader.list(dir)) {
      if (!FONT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      out.push(...parseFont({ read: (offset, length) => reader.readAt(path, offset, length) }, path));
    }
  }
  return out;
}

export interface ResolvedFace {
  path: string;
  family: string;
  weight: 400 | 700;
  style: "normal" | "italic";
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");
const NERD_SUFFIX = /(nerdfontmono|nerdfontpropo|nerdfont|nfm|nfp|nf)$/;

type Variant = "mono" | "plain" | "propo";

function nerdVariant(family: string): Variant | undefined {
  const m = NERD_SUFFIX.exec(norm(family));
  if (m === null) return undefined;
  const suffix = m[1];
  if (suffix === "nerdfontmono" || suffix === "nfm") return "mono";
  if (suffix === "nerdfontpropo" || suffix === "nfp") return "propo";
  return "plain";
}

const nerdBase = (family: string): string => norm(family).replace(NERD_SUFFIX, "");

const VARIANT_ORDER: Record<Variant, number> = { mono: 0, plain: 1, propo: 2 };

/** The faces to register for a requested family: the family itself when installed, then one Nerd Font variant
 * (the mono one when it exists, whose icons fit a cell; never the proportional one), each with its regular, bold,
 * italic and bold italic. */
export function resolveLocalFonts(requested: string, files: readonly FontFile[]): ResolvedFace[] {
  const first = requested.split(",")[0]?.trim().replace(/^["']|["']$/g, "").trim() ?? "";
  if (first.length === 0) return [];
  const wanted = norm(first);
  const exact = new Set<string>();
  for (const f of files) {
    if (norm(f.family) === wanted || norm(f.fullName) === wanted || norm(f.postscript) === wanted) exact.add(f.family);
  }
  const base = nerdBase(first);
  const variants = new Map<string, Variant>();
  for (const f of files) {
    if (exact.has(f.family)) continue;
    const variant = nerdVariant(f.family);
    if (variant === undefined || variant === "propo" || nerdBase(f.family) !== base) continue;
    variants.set(f.family, variant);
  }
  const nerd = [...variants].sort((a, b) => VARIANT_ORDER[a[1]] - VARIANT_ORDER[b[1]]).map(([family]) => family)[0];
  const families = [...exact, ...(nerd !== undefined ? [nerd] : [])];
  const out: ResolvedFace[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    const faces = files.filter(f => f.family === family);
    for (const italic of [false, true]) {
      for (const weight of [400, 700] as const) {
        const pick = faces
          .filter(f => f.italic === italic)
          .sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0];
        if (pick === undefined || seen.has(pick.path)) continue;
        seen.add(pick.path);
        out.push({ path: pick.path, family, weight, style: italic ? "italic" : "normal" });
      }
    }
  }
  return out;
}

const MAX_FAMILY_LENGTH = 200;

/** The faces for a family as the page receives them, file bytes included. */
export async function localFontFaces(requested: string, index: () => Promise<FontFile[]>): Promise<LocalFontFace[]> {
  if (typeof requested !== "string" || requested.length === 0 || requested.length > MAX_FAMILY_LENGTH) return [];
  const out: LocalFontFace[] = [];
  for (const face of resolveLocalFonts(requested, await index())) {
    try {
      const bytes = readFileSync(face.path);
      out.push({ family: face.family, weight: face.weight, style: face.style, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    } catch {
      // A file gone since the index was built is left out.
    }
  }
  return out;
}
