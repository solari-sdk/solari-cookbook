// SPDX-License-Identifier: AGPL-3.0-only
// The chat's message body in a real Chromium, both themes: an answered turn whose reply carries
// every kind of markdown the surface draws. The parts that can go wrong on a light card are the
// ones that bring their own ground, so this measures them rather than reading the stylesheet: the
// fenced block and the inline code chip keep an edge against the card behind them, every syntax
// colour the highlighter paints reads on the block's own ground, the quote keeps its rule, and the
// prose, the table and the link read at AA. Photographed in each theme. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");

if (renderSkipped !== undefined) console.info(`chat layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the chat's message body laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** Both markdown roots on the page, the prompt and the reply; only the reply carries the fenced block. */
  const MARKDOWN = ".chat-markdown";

  it.each(["dark", "light"] as const)("in the %s theme the code block and its chips keep an edge on the card, every syntax colour reads on the block, and the prose reads at AA", async theme => {
    await page!.goto(`${base}?theme=${theme}&ws=ws_a&chat=1`);
    await page!.waitForSelector(`${MARKDOWN} .shiki`);
    // The highlighter loads its grammar asynchronously; the coloured spans arrive with it.
    await page!.waitForFunction(() => document.querySelectorAll(".chat-markdown .shiki span[style*='color']").length > 8);
    expect(await page!.locator(`${MARKDOWN} .chat-markdown-codeblock`).count()).toBe(1);
    expect(await page!.locator(`${MARKDOWN} :not(pre) > code`).count()).toBe(3);
    expect(await page!.locator(`${MARKDOWN} blockquote`).count()).toBe(1);
    expect(await page!.locator(`${MARKDOWN} table`).count()).toBe(1);

    // What each surface sits on, and what edge it brings: a fill of its own, a border, or neither.
    const grounds = await page!.evaluate(() => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const parse = (c: string): number[] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      };
      const over = (t: number[], u: number[]): number[] => [0, 1, 2].map(i => t[i]! * t[3]! + u[i]! * (1 - t[3]!));
      const lum = (rgb: number[]): number => {
        const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
      };
      const bgOf = (el: Element | null): number[] => {
        const layers: number[][] = [];
        for (let n = el; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c[3]! > 0) layers.push(c);
        }
        return layers.reverse().reduce((u, t) => over(t, u), [255, 255, 255]);
      };
      const ratio = (a: number[], b: number[]): number => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      };
      /** How far a box stands off the card behind it: its own fill, and its border if it has one. */
      const edge = (selector: string) => {
        const el = document.querySelector(selector)!;
        const cs = getComputedStyle(el);
        const under = bgOf(el.parentElement);
        const fill = over(parse(cs.backgroundColor), under);
        const width = parseFloat(cs.borderTopWidth) || parseFloat(cs.borderLeftWidth);
        const border = parse(cs.borderTopColor)[3]! > 0 ? parse(cs.borderTopColor) : parse(cs.borderLeftColor);
        return { fill: ratio(fill, under), border: width > 0 && border[3]! > 0 ? ratio(over(border, under), under) : null };
      };
      // Every colour the highlighter painted, against the block's own ground.
      const block = document.querySelector(".chat-markdown .shiki")!;
      const ground = bgOf(block);
      const painted = [...block.querySelectorAll<HTMLElement>("span[style*='color']")]
        .filter(s => (s.textContent ?? "").trim().length > 0)
        .map(s => ({ text: (s.textContent ?? "").trim(), ratio: ratio(over(parse(getComputedStyle(s).color), ground), ground) }));
      const tokens = painted.map(t => t.ratio);
      return {
        // A fenced block wears its fill and border on the wrapper; the pre inside it is bare.
        block: edge(".chat-markdown .chat-markdown-codeblock"),
        inlineCode: edge(".chat-markdown :not(pre) > code"),
        quote: edge(".chat-markdown blockquote"),
        tokens: { count: tokens.length, min: Math.min(...tokens) },
        // The one run of prose inside the block: a comment is a sentence, not punctuation.
        comment: painted.find(t => t.text.startsWith("//"))?.ratio ?? null,
      };
    });
    console.info(`${theme}: block edge fill ${grounds.block.fill} border ${grounds.block.border}, chip fill ${grounds.inlineCode.fill} border ${grounds.inlineCode.border}, quote rule ${grounds.quote.border}, comment ${grounds.comment}, ${grounds.tokens.count} syntax colours from ${grounds.tokens.min} to 1`);

    // Each of these is a box on the message card and each has to stand off it. Which side does the work
    // flips with the theme, which is the whole shape of this ticket: on the dark card the fill carries the
    // block (1.05) and its border is invisible, on the light card the fill lands at 1.02 and the border
    // carries it. So the bar is on whichever side is doing the work, not on the fill alone.
    for (const [name, box] of [["the code block", grounds.block], ["the inline code chip", grounds.inlineCode], ["the quote", grounds.quote]] as const) {
      expect(Math.max(box.fill, box.border ?? 1), `${name} stands off the card by fill ${box.fill} and border ${box.border} in ${theme}`).toBeGreaterThanOrEqual(1.04);
    }
    expect(grounds.tokens.count).toBeGreaterThan(8);
    // Everything inside the block is painted by the vendored pierre-light and pierre-dark themes, which the
    // diff and file-preview surfaces share, so this pass does not own those colours and does not hold them
    // to AA here. Both floors are regression guards a little under what the two themes measure today: the
    // faintest colour is light's operators at 2.05, and the comment, the one run of prose in the block, is
    // dark's at 3.99 against light's 4.54. That neither side clears AA is on the ticket as a finding.
    expect(grounds.comment, `the block's comment in ${theme}`).not.toBeNull();
    expect(grounds.comment!, `the block's comment reads at ${grounds.comment} in ${theme}`).toBeGreaterThanOrEqual(3.9);
    expect(grounds.tokens.min, `the faintest syntax colour reads at ${grounds.tokens.min} in ${theme}`).toBeGreaterThanOrEqual(2);

    for (const [what, selector] of [
      ["the message prose", `${MARKDOWN} p`],
      ["the inline code chips", `${MARKDOWN} :not(pre) > code`],
      ["the quote", `${MARKDOWN} blockquote`],
      ["the table", `${MARKDOWN} td, ${MARKDOWN} th`],
      ["the link", `${MARKDOWN} a`],
    ] as const) {
      const ratios = await textContrast(page!, selector);
      expect(ratios.length, `${what} drew nothing to measure in ${theme}`).toBeGreaterThan(0);
      console.info(`${theme}: ${what} reads at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
      for (const ratio of ratios) expect(ratio, `${what} reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }

    // The turn from its prompt down, not wherever the timeline happened to rest.
    await page!.locator(MARKDOWN).first().scrollIntoViewIfNeeded();
    const path = join(SHOTS, `chat-markdown-${theme}.png`);
    await page!.locator("[data-shell-center]").screenshot({ path });
    console.info(`chat markdown screenshot: ${path}`);
  }, 60_000);
});
