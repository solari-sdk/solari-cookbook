// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { type FontFile, type FontReader, fontDirs, indexFonts, parseFontFile, resolveLocalFonts } from "../src/fonts.js";

/** A minimal sfnt: a name table (Windows English family, subfamily, full and PostScript names) and an OS/2 table. */
function sfnt(names: { family: string; subfamily: string; postscript: string }, os2: { weight: number; italic: boolean }): Buffer {
  const utf16 = (s: string) => Buffer.from(s, "utf16le").swap16();
  const strings = [
    [1, utf16(names.family)],
    [2, utf16(names.subfamily)],
    [4, utf16(`${names.family} ${names.subfamily}`)],
    [6, utf16(names.postscript)],
  ] as const;
  const storage = Buffer.concat(strings.map(([, b]) => b));
  const name = Buffer.alloc(6 + 12 * strings.length + storage.length);
  name.writeUInt16BE(0, 0);
  name.writeUInt16BE(strings.length, 2);
  name.writeUInt16BE(6 + 12 * strings.length, 4);
  let off = 0;
  strings.forEach(([id, bytes], i) => {
    const at = 6 + 12 * i;
    name.writeUInt16BE(3, at);
    name.writeUInt16BE(1, at + 2);
    name.writeUInt16BE(0x409, at + 4);
    name.writeUInt16BE(id, at + 6);
    name.writeUInt16BE(bytes.length, at + 8);
    name.writeUInt16BE(off, at + 10);
    off += bytes.length;
  });
  storage.copy(name, 6 + 12 * strings.length);
  const os2Table = Buffer.alloc(78);
  os2Table.writeUInt16BE(os2.weight, 4);
  os2Table.writeUInt16BE(os2.italic ? 1 : 0, 62);
  const tables: [string, Buffer][] = [["OS/2", os2Table], ["name", name]];
  const header = Buffer.alloc(12 + 16 * tables.length);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(tables.length, 4);
  let dataOff = header.length;
  const parts: Buffer[] = [];
  tables.forEach(([tag, data], i) => {
    const at = 12 + 16 * i;
    header.write(tag, at, "ascii");
    header.writeUInt32BE(dataOff, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    parts.push(padded);
    dataOff += padded.length;
  });
  return Buffer.concat([header, ...parts]);
}

function collection(faces: Buffer[]): Buffer {
  const header = Buffer.alloc(12 + 4 * faces.length);
  header.write("ttcf", 0, "ascii");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(faces.length, 8);
  let off = header.length;
  const shifted = faces.map((face, i) => {
    header.writeUInt32BE(off, 12 + 4 * i);
    // Table offsets inside a face are absolute in the file, so each face's directory is rebased.
    const copy = Buffer.from(face);
    const n = copy.readUInt16BE(4);
    for (let t = 0; t < n; t += 1) copy.writeUInt32BE(copy.readUInt32BE(12 + 16 * t + 8) + off, 12 + 16 * t + 8);
    off += copy.length;
    return copy;
  });
  return Buffer.concat([header, ...shifted]);
}

const file = (path: string, family: string, subfamily: string, postscript: string, weight: number, italic: boolean): FontFile => ({ path, family, subfamily, postscript, fullName: `${family} ${subfamily}`, weight, italic });

describe("parseFontFile", () => {
  it("reads the family, style and PostScript names with the OS/2 weight and italic flag", () => {
    const bytes = sfnt({ family: "JetBrainsMono Nerd Font Mono", subfamily: "Bold Italic", postscript: "JetBrainsMonoNFM-BoldItalic" }, { weight: 700, italic: true });
    expect(parseFontFile(bytes, "/f/JetBrainsMonoNerdFontMono-BoldItalic.ttf")).toEqual([
      file("/f/JetBrainsMonoNerdFontMono-BoldItalic.ttf", "JetBrainsMono Nerd Font Mono", "Bold Italic", "JetBrainsMonoNFM-BoldItalic", 700, true),
    ]);
  });

  it("reads every face of a collection", () => {
    const bytes = collection([
      sfnt({ family: "Menlo", subfamily: "Regular", postscript: "Menlo-Regular" }, { weight: 400, italic: false }),
      sfnt({ family: "Menlo", subfamily: "Bold", postscript: "Menlo-Bold" }, { weight: 700, italic: false }),
    ]);
    expect(parseFontFile(bytes, "/S/Menlo.ttc").map(f => [f.subfamily, f.weight])).toEqual([["Regular", 400], ["Bold", 700]]);
  });

  it("a file that is not a font yields nothing rather than throwing", () => {
    expect(parseFontFile(Buffer.from("not a font at all, just bytes"), "/f/x.ttf")).toEqual([]);
    expect(parseFontFile(Buffer.alloc(3), "/f/short.ttf")).toEqual([]);
  });
});

describe("indexFonts", () => {
  it("walks the font directories, parses ttf, otf and ttc files and skips the rest", async () => {
    const files = new Map<string, Buffer>([
      ["/Users/me/Library/Fonts/Hack-Regular.ttf", sfnt({ family: "Hack", subfamily: "Regular", postscript: "Hack-Regular" }, { weight: 400, italic: false })],
      ["/Users/me/Library/Fonts/nested/Iosevka.otf", sfnt({ family: "Iosevka", subfamily: "Regular", postscript: "Iosevka" }, { weight: 400, italic: false })],
      ["/Users/me/Library/Fonts/README.txt", Buffer.from("hi")],
      ["/Library/Fonts/Menlo.ttc", collection([sfnt({ family: "Menlo", subfamily: "Regular", postscript: "Menlo-Regular" }, { weight: 400, italic: false })])],
      ["/Library/Fonts/Broken.ttf", Buffer.from("nope")],
    ]);
    const reader: FontReader = {
      list: dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)),
      readAt: (path, offset, length) => {
        const b = files.get(path);
        if (b === undefined) throw new Error(`ENOENT ${path}`);
        return b.subarray(offset, offset + length);
      },
    };
    const index = await indexFonts(["/Users/me/Library/Fonts", "/Library/Fonts", "/missing"], reader);
    expect(index.map(f => f.family).sort()).toEqual(["Hack", "Iosevka", "Menlo"]);
  });

  it("names each platform's font directories, the person's own first", () => {
    expect(fontDirs("darwin", "/Users/me", {})).toEqual(["/Users/me/Library/Fonts", "/Library/Fonts", "/System/Library/Fonts", "/System/Library/Fonts/Supplemental"]);
    expect(fontDirs("linux", "/home/me", { XDG_DATA_HOME: "/data" })).toEqual(["/data/fonts", "/home/me/.fonts", "/usr/local/share/fonts", "/usr/share/fonts"]);
    expect(fontDirs("linux", "/home/me", {})).toEqual(["/home/me/.local/share/fonts", "/home/me/.fonts", "/usr/local/share/fonts", "/usr/share/fonts"]);
    expect(fontDirs("win32", "C:/Users/me", { LOCALAPPDATA: "C:/Users/me/AppData/Local", WINDIR: "C:/Windows" })).toEqual(["C:/Users/me/AppData/Local/Microsoft/Windows/Fonts", "C:/Windows/Fonts"]);
  });
});

describe("resolveLocalFonts", () => {
  const installed: FontFile[] = [
    file("/f/JetBrainsMonoNerdFont-Regular.ttf", "JetBrainsMono Nerd Font", "Regular", "JetBrainsMonoNF-Regular", 400, false),
    file("/f/JetBrainsMonoNerdFont-Bold.ttf", "JetBrainsMono Nerd Font", "Bold", "JetBrainsMonoNF-Bold", 700, false),
    file("/f/JetBrainsMonoNerdFont-Italic.ttf", "JetBrainsMono Nerd Font", "Italic", "JetBrainsMonoNF-Italic", 400, true),
    file("/f/JetBrainsMonoNerdFont-Medium.ttf", "JetBrainsMono Nerd Font", "Medium", "JetBrainsMonoNF-Medium", 500, false),
    file("/f/JetBrainsMonoNerdFontMono-Regular.ttf", "JetBrainsMono Nerd Font Mono", "Regular", "JetBrainsMonoNFM-Regular", 400, false),
    file("/f/JetBrainsMonoNerdFontMono-Bold.ttf", "JetBrainsMono Nerd Font Mono", "Bold", "JetBrainsMonoNFM-Bold", 700, false),
    file("/f/JetBrainsMonoNerdFontPropo-Regular.ttf", "JetBrainsMono Nerd Font Propo", "Regular", "JetBrainsMonoNFP-Regular", 400, false),
    file("/f/HackNerdFontMono-Regular.ttf", "Hack Nerd Font Mono", "Regular", "HackNFM-Regular", 400, false),
    file("/f/Hack-Regular.ttf", "Hack", "Regular", "Hack-Regular", 400, false),
    file("/f/Hack-Bold.ttf", "Hack", "Bold", "Hack-Bold", 700, false),
    file("/S/Menlo.ttc", "Menlo", "Regular", "Menlo-Regular", 400, false),
    file("/S/Menlo.ttc", "Menlo", "Bold", "Menlo-Bold", 700, false),
  ];

  it("a family that is installed comes first, its Nerd Font variants after it, the mono variant before the plain one", () => {
    expect(resolveLocalFonts("Hack", installed).map(f => [f.family, f.weight, f.style, f.path])).toEqual([
      ["Hack", 400, "normal", "/f/Hack-Regular.ttf"],
      ["Hack", 700, "normal", "/f/Hack-Bold.ttf"],
      ["Hack Nerd Font Mono", 400, "normal", "/f/HackNerdFontMono-Regular.ttf"],
    ]);
  });

  it("a family only installed as a Nerd Font resolves to its mono variant, four styles at most; the plain variant stands in when there is no mono one", () => {
    expect(resolveLocalFonts("JetBrains Mono", installed).map(f => [f.family, f.weight, f.style])).toEqual([
      ["JetBrainsMono Nerd Font Mono", 400, "normal"],
      ["JetBrainsMono Nerd Font Mono", 700, "normal"],
    ]);
    const plainOnly = installed.filter(f => f.family !== "JetBrainsMono Nerd Font Mono");
    expect(resolveLocalFonts("JetBrains Mono", plainOnly).map(f => [f.family, f.weight, f.style])).toEqual([
      ["JetBrainsMono Nerd Font", 400, "normal"],
      ["JetBrainsMono Nerd Font", 700, "normal"],
      ["JetBrainsMono Nerd Font", 400, "italic"],
    ]);
    expect(resolveLocalFonts("JetBrains Mono", installed.filter(f => f.family === "JetBrainsMono Nerd Font Propo"))).toEqual([]);
  });

  it("matches a PostScript or full name the way iTerm2 records fonts, and the first name of a comma list", () => {
    expect(resolveLocalFonts("JetBrainsMonoNF-Regular", installed)[0]).toMatchObject({ family: "JetBrainsMono Nerd Font", weight: 400 });
    expect(resolveLocalFonts("Menlo Bold", installed).map(f => f.path)).toEqual(["/S/Menlo.ttc"]);
    expect(resolveLocalFonts('"Hack", Menlo', installed)[0]).toMatchObject({ family: "Hack" });
  });

  it("asking for the Nerd Font by its own name gives that family first and the mono variant after it", () => {
    expect(resolveLocalFonts("JetBrainsMono Nerd Font", installed).map(f => f.family)).toEqual([
      "JetBrainsMono Nerd Font",
      "JetBrainsMono Nerd Font",
      "JetBrainsMono Nerd Font",
      "JetBrainsMono Nerd Font Mono",
      "JetBrainsMono Nerd Font Mono",
    ]);
  });

  it("a family nothing installed names resolves to nothing", () => {
    expect(resolveLocalFonts("Berkeley Mono", installed)).toEqual([]);
    expect(resolveLocalFonts("", installed)).toEqual([]);
  });
});
