// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_TEXT_FACES, TERMINAL_SYMBOLS_FACE, terminalFontChain } from "./fontChain";

describe("terminalFontChain", () => {
  it("with no chosen family: the platform text faces, the bundled symbols face, then generic monospace", () => {
    expect(terminalFontChain(undefined)).toBe(`${DEFAULT_TERMINAL_TEXT_FACES}, "${TERMINAL_SYMBOLS_FACE}", monospace`);
    expect(terminalFontChain("  ")).toBe(terminalFontChain(undefined));
  });

  it("a chosen family leads, the faces the desktop shell registered for it follow, the symbols face stays last", () => {
    expect(terminalFontChain("JetBrains Mono", ["JetBrainsMono Nerd Font Mono"])).toBe(
      '"JetBrains Mono", "JetBrainsMono Nerd Font Mono", "Symbols Nerd Font Mono", monospace',
    );
    expect(terminalFontChain("Hack", ["Hack", "Hack Nerd Font Mono"])).toBe('Hack, "Hack Nerd Font Mono", "Symbols Nerd Font Mono", monospace');
  });

  it("names no Nerd Font the person or their computer did not name", () => {
    const chain = terminalFontChain("Menlo");
    expect(chain).toBe('Menlo, "Symbols Nerd Font Mono", monospace');
    expect(terminalFontChain(undefined)).not.toMatch(/JetBrains|Hack|Fira|Meslo|Caskaydia|Powerline/);
  });

  it("quotes names the canvas font shorthand would reject and keeps a family named twice once", () => {
    expect(terminalFontChain("3270 Nerd Font")).toBe('"3270 Nerd Font", "Symbols Nerd Font Mono", monospace');
    expect(terminalFontChain('"Cascadia Code", Menlo', ["menlo", "Cascadia Code"])).toBe('"Cascadia Code", Menlo, "Symbols Nerd Font Mono", monospace');
    expect(terminalFontChain("Symbols Nerd Font Mono")).toBe('"Symbols Nerd Font Mono", monospace');
  });
});
