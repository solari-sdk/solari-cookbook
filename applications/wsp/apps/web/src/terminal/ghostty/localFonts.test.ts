// SPDX-License-Identifier: AGPL-3.0-only
import type { LocalFontFace } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localFontFamilies, registerLocalFonts } from "./localFonts";

const face = (family: string, weight: 400 | 700, style: "normal" | "italic" = "normal"): LocalFontFace => ({ family, weight, style, data: new ArrayBuffer(8) });

describe("registerLocalFonts", () => {
  const made: { family: string; descriptors: FontFaceDescriptors | undefined }[] = [];
  const added: unknown[] = [];
  class FakeFontFace {
    constructor(family: string, _source: BufferSource | string, descriptors?: FontFaceDescriptors) {
      made.push({ family, descriptors });
    }
    async load(): Promise<this> {
      return this;
    }
  }
  beforeEach(() => {
    vi.stubGlobal("FontFace", FakeFontFace);
    vi.spyOn(document.fonts, "add").mockImplementation((f: FontFace) => {
      added.push(f);
      return document.fonts;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    made.length = 0;
    added.length = 0;
  });

  it("registers every face the shell hands over under the family its file names and answers with the families once each", async () => {
    const localFonts = vi.fn(async () => [face("Hack", 400), face("Hack", 700), face("Hack Nerd Font Mono", 400), face("Hack Nerd Font Mono", 400, "italic")]);
    await expect(registerLocalFonts("Hack", { localFonts })).resolves.toEqual(["Hack", "Hack Nerd Font Mono"]);
    expect(made.map(m => [m.family, m.descriptors?.weight, m.descriptors?.style])).toEqual([
      ["Hack", "400", "normal"],
      ["Hack", "700", "normal"],
      ["Hack Nerd Font Mono", "400", "normal"],
      ["Hack Nerd Font Mono", "400", "italic"],
    ]);
    expect(added).toHaveLength(4);
    expect(localFontFamilies("Hack")).toEqual(["Hack", "Hack Nerd Font Mono"]);
    // The same family is asked of the shell once per page.
    await registerLocalFonts("Hack", { localFonts });
    expect(localFonts).toHaveBeenCalledTimes(1);
  });

  it("a face the browser refuses loses only itself; the Nerd Font variant after it still lands", async () => {
    class RefusingFontFace extends FakeFontFace {
      readonly family: string;
      constructor(family: string, source: BufferSource | string, descriptors?: FontFaceDescriptors) {
        super(family, source, descriptors);
        this.family = family;
      }
      override async load(): Promise<this> {
        if (this.family === "Iosevka") throw new DOMException("refused by the sanitizer", "NetworkError");
        return this;
      }
    }
    vi.stubGlobal("FontFace", RefusingFontFace);
    const localFonts = vi.fn(async () => [face("Iosevka", 400), face("Iosevka", 700), face("Iosevka Nerd Font Mono", 400), face("Iosevka Nerd Font Mono", 700)]);
    await expect(registerLocalFonts("Iosevka", { localFonts })).resolves.toEqual(["Iosevka Nerd Font Mono"]);
    expect(made).toHaveLength(4);
    expect(added).toHaveLength(2);
    expect(localFontFamilies("Iosevka")).toEqual(["Iosevka Nerd Font Mono"]);
  });

  it("a browser tab, an empty family or a shell that fails all register nothing and answer with no families", async () => {
    await expect(registerLocalFonts("Menlo", undefined)).resolves.toEqual([]);
    await expect(registerLocalFonts(undefined, { localFonts: async () => [face("X", 400)] })).resolves.toEqual([]);
    await expect(registerLocalFonts("  ", { localFonts: async () => [face("X", 400)] })).resolves.toEqual([]);
    await expect(registerLocalFonts("Broken", { localFonts: async () => { throw new Error("ipc down"); } })).resolves.toEqual([]);
    expect(localFontFamilies("Broken")).toEqual([]);
    expect(localFontFamilies(undefined)).toEqual([]);
    expect(made).toEqual([]);
  });
});
