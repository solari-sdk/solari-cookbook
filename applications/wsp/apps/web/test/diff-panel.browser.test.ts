// SPDX-License-Identifier: AGPL-3.0-only
// The diff pane's code view in a real Chromium at the width the right panel
// gives it, both themes. Two things a stylesheet cannot answer are measured
// here: what a changed word reads at over the tint its row carries, and
// whether a line wider than the panel can be reached at all. Runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";
import { PANEL_WIDTH } from "./diff-panel/width";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");
/** Body text at the size a diff line is drawn in reads at AA or it is not readable. */
const AA = 4.5;

if (renderSkipped !== undefined) console.info(`diff panel render test skipped: ${renderSkipped}`);

/** Every word on a changed row with what it reads at over what is painted behind it, translucent layers composited
 * up to the first opaque one. The rows live in the code view's shadow roots, which is why this walks rather than
 * selects. */
const READ_ROWS = `(() => {
  const surface = document.querySelector(".diff-render-surface");
  if (surface === null) return { words: [], overflowing: [], tallestRow: 0, shortestRow: 0, panelWidth: 0 };
  const all = [];
  const walk = node => { all.push(node); for (const c of node.children ?? []) walk(c); if (node.shadowRoot) for (const c of node.shadowRoot.children) walk(c); };
  walk(surface);
  const ctx = document.createElement("canvas").getContext("2d");
  const parse = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3]));
  const lum = rgb => { const f = v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4); return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
  const up = el => { const layers = []; for (let n = el; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement ?? (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); } return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]); };
  const words = [];
  for (const line of all.filter(e => e.getAttribute?.("data-line-type")?.startsWith("change"))) {
    for (const span of line.querySelectorAll("span")) {
      if (span.children.length > 0 || (span.textContent ?? "").trim().length < 2) continue;
      const bg = up(span);
      const fg = over(parse(getComputedStyle(span).color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      words.push({ word: span.textContent.trim().slice(0, 24), type: line.getAttribute("data-line-type"), ink: getComputedStyle(span).color, marked: span.closest("[data-diff-span]") !== null, contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 });
    }
  }
  const heights = all.filter(e => e.getAttribute?.("data-line-type")).map(e => Math.round(e.getBoundingClientRect().height)).filter(h => h > 0);
  const overflowing = all.filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.getAttributeNames().join(","));
  return { words, overflowing, tallestRow: Math.max(0, ...heights), shortestRow: Math.min(Infinity, ...heights), panelWidth: Math.round(document.querySelector("[data-diff-panel]").getBoundingClientRect().width) };
})()`;

interface Word {
  word: string;
  type: string;
  ink: string;
  marked: boolean;
  contrast: number;
}
interface Read {
  words: Word[];
  overflowing: string[];
  tallestRow: number;
  shortestRow: number;
  panelWidth: number;
}

describe.skipIf(renderSkipped !== undefined)("the diff pane at the right panel's width", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  /** Both files' hunks with the grammar's colours on them. The rows are drawn in one plain ink first and the
   * highlighter's colours arrive after: a read taken before that measures a code line as prose and says nothing
   * about the faint colours a tint can swallow. */
  const COLOURED = `(() => { const w = (${READ_ROWS}).words; return w.filter(x => x.marked).length >= 6 && new Set(w.map(x => x.ink)).size >= 3; })()`;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/diff-panel/index.html");
    base = `${vite.base}/test/diff-panel/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    mkdirSync(SHOTS, { recursive: true });
    // One load before the cases: the first one pays for vite's transform of the app's module graph and for the
    // highlighter's wasm engine and grammars, which on a loaded box runs into minutes. Paid here, where it is
    // setup, rather than inside whichever case happens to go first.
    await page.goto(`${base}?theme=dark`);
    await page.waitForFunction(COLOURED, undefined, { timeout: 240_000 });
  }, 300_000);
  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme every changed word reads at AA over its row's tint, and a line wider than the panel wraps into it", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForFunction(COLOURED, undefined, { timeout: 90_000 });
    const read = (await page!.evaluate(READ_ROWS)) as Read;
    await page!.screenshot({ path: join(SHOTS, `diff-panel-${theme}.png`) });

    // The panel is the width the app gives it, and both sides of the change are on the screen, in prose and in code.
    expect(read.panelWidth).toBe(PANEL_WIDTH);
    expect(read.words.some(w => w.type === "change-deletion")).toBe(true);
    expect(read.words.some(w => w.type === "change-addition")).toBe(true);

    // The words the diff marked as changed are the ones a person is looking for, and they sit on the strongest
    // tint their row carries. Drawn in the grammar's own colour they measured 2.19:1 here.
    const marked = read.words.filter(w => w.marked);
    expect(marked.length).toBeGreaterThan(2);
    const worst = [...marked].sort((a, b) => a.contrast - b.contrast)[0]!;
    expect(worst.contrast, `the faintest changed word was ${JSON.stringify(worst.word)} on a ${worst.type} row`).toBeGreaterThanOrEqual(AA);

    // A line far wider than the panel is wrapped into it rather than cut at the edge: nothing inside the pane
    // holds more than it shows, and the row that carries the long line stands taller than a one-line row.
    expect(read.overflowing).toEqual([]);
    expect(read.tallestRow).toBeGreaterThan(read.shortestRow);
  }, 150_000);
});
