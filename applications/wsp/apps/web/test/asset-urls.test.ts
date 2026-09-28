// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { probeWasmUrl, probeWoff2Url } from "../src/assets/assetUrls.js";
import symbolsFontUrl from "../src/terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2?url";
import ghosttyWasmUrl from "../src/terminal/ghostty/vendor/ghostty-vt.wasm?url";
import ghosttyWritePtyWasmUrl from "../src/terminal/ghostty/vendor/ghostty-write-pty.wasm?url&no-inline";

describe("asset url imports", () => {
  it("resolves a .wasm?url import to a served path", () => {
    expect(probeWasmUrl).toMatch(/^\/.*probe\.wasm$/);
  });
  it("resolves a .woff2?url import to a served path", () => {
    expect(probeWoff2Url).toMatch(/^\/.*probe\.woff2$/);
  });
  it("resolves the libghostty wasm pair and the symbols font the terminal ships", () => {
    expect(ghosttyWasmUrl).toMatch(/ghostty-vt\.wasm/);
    expect(ghosttyWritePtyWasmUrl).toMatch(/ghostty-write-pty\.wasm/);
    expect(symbolsFontUrl).toMatch(/SymbolsNerdFontMono-Regular\.woff2/);
  });
});
