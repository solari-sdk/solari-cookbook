// SPDX-License-Identifier: AGPL-3.0-only
// The pane in a real Chromium: Nerd Font codepoints draw as glyphs from the
// bundled symbols face when the chosen text face has none, never as the
// notdef box. Vite serves the surface to Playwright's browser, so like the
// live tests it runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium on the machine.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "../../../test/render-browser";
import { startVite, type ViteChild } from "../../../test/vite-child";
import type { CellSignature } from "../../../test/glyphs/probe";
import { DEFAULT_TERMINAL_TEXT_FACES, TERMINAL_SYMBOLS_FACE } from "./fontChain";

// jsdom's URL resolves relative references against the page origin, so the path is built with node:path.
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const NOTDEF = "\u{10FFFD}";
// nf-fa folder, nf-custom folder, nf-md file, nf-oct git-branch: none of them in any platform text face
// (Menlo and SF Mono carry the powerline arrows themselves, so those would prove nothing here).
const ICONS = ["\uF07B", "\uE5FF", "\u{F0219}", "\uF418"];

// The default reporter prints nothing for a skipped suite but its arrow; this line is what a gate log shows.
if (renderSkipped !== undefined) console.info(`glyph render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("Nerd Font glyphs through the pane in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/glyphs/index.html");
    const url = `${vite.base}/test/glyphs/index.html`;
    browser = await launchRender();
    page = await browser.newPage();
    await page.goto(url);
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  /** Each glyph drawn alone on the one surface, in the given family's chain. */
  async function glyphs(texts: readonly string[], family?: string): Promise<CellSignature[]> {
    const out: CellSignature[] = [];
    for (const text of texts) {
      out.push(
        await page!.evaluate(
          ([t, f]) => (window as unknown as { drawGlyph: (text: string, family?: string) => Promise<CellSignature> }).drawGlyph(t!, f),
          [text, family] as [string, string | undefined],
        ),
      );
    }
    return out;
  }

  /** The icons as the bundled face draws them on the default text metrics: the face first in the list so no other
   * face, installed or fallen back to, can supply them; the text faces after it so the cell grid measures the same. */
  const reference = (): Promise<CellSignature[]> => glyphs([...ICONS, NOTDEF], `${TERMINAL_SYMBOLS_FACE}, ${DEFAULT_TERMINAL_TEXT_FACES}`);

  it("with the default stack every icon draws the bundled face's glyph, neither empty nor the notdef box nor a system fallback's", async () => {
    const cells = await glyphs([...ICONS, NOTDEF, "A"]);
    const bundled = await reference();
    const notdef = cells[ICONS.length]!;
    expect(notdef.lit).toBeGreaterThan(0);
    for (const [i, icon] of ICONS.entries()) {
      const name = `U+${icon.codePointAt(0)!.toString(16)}`;
      expect(cells[i]!.lit, `${name} drew nothing`).toBeGreaterThan(0);
      expect(cells[i]!.hash, `${name} drew the notdef box`).not.toBe(notdef.hash);
      expect(cells[i]!.hash, `${name} did not come from the bundled face`).toBe(bundled[i]!.hash);
    }
    expect(new Set(cells.slice(0, ICONS.length).map((c) => c.hash)).size).toBe(ICONS.length);
  }, 30_000);

  it("a chosen text face without icons still draws them from the bundled face", async () => {
    const chosen = await glyphs([...ICONS, NOTDEF], "Menlo");
    const bundled = await reference();
    for (const i of ICONS.keys()) {
      expect(chosen[i]!.lit).toBeGreaterThan(0);
      expect(chosen[i]!.hash).not.toBe(chosen[ICONS.length]!.hash);
      expect(chosen[i]!.hash).toBe(bundled[i]!.hash);
    }
  }, 30_000);
});
