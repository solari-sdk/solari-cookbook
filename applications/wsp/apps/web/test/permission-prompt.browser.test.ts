// SPDX-License-Identifier: AGPL-3.0-only
// The relayed permission prompt row in a real Chromium: a uniform chat row
// whose lead is the sentence its kind of call is worded by, whose remaining
// input is the muted mono every tool row wears, whose file body is folded
// away, and whose options are plain buttons while the turn waits on them,
// replaced by one muted line once the prompt is closed. No chip, no badge and
// no colour of its own on either state, in both themes, with the rows
// photographed for review. Like the other render tests it runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

/** The command the fixture's open prompt asks about, long enough that the row has to wrap it to show it whole. */
const COMMAND = "pnpm exec vitest run --minWorkers=1 --maxWorkers=1 packages/api/test/health.test.ts packages/api/test/routes.test.ts";

if (renderSkipped !== undefined) console.info(`permission prompt render test skipped: ${renderSkipped}`);

/** The tokens a chip or a badge would bring: a row that carries none of them is drawn like every other chat row. */
const skinOf = (selector: string) => `(() => {
  const el = document.querySelector('${selector}');
  const s = getComputedStyle(el);
  return { background: s.backgroundColor, border: s.borderTopWidth, radius: s.borderTopLeftRadius, font: s.fontFamily, color: s.color };
})()`;

describe.skipIf(renderSkipped !== undefined)("the relayed permission prompt row laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html?local=1&ws=ws_m&perm=1`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the open prompt offers its options and the closed one states its outcome, neither as a chip", async theme => {
    await page!.goto(`${base}&theme=${theme}`);
    const open = '[data-permission-prompt="ask_open"]';
    const closed = '[data-permission-prompt="ask_done"]';
    await page!.waitForSelector(open);

    // The open prompt: what the call does in words, the command itself beside them, and every option the harness
    // offered as a plain button.
    expect(await page!.locator(open).getAttribute("data-permission-open")).toBe("true");
    expect(await page!.locator(`${open} [data-permission-says]`).textContent()).toBe("Run:");
    expect(await page!.locator(`${open} [data-permission-code]`).textContent()).toBe(COMMAND);
    expect(await page!.locator(`${open} [data-permission-option]`).allTextContents()).toEqual(["Allow", "Deny", "Allow, then Accept edits"]);

    // The file write leads on the file, its folder and its size, and its text is behind the fold until it is asked for.
    expect(await page!.locator(`${closed} [data-permission-says]`).textContent()).toBe("Write health.ts in src (44 B)");
    expect(await page!.locator(`${closed} [data-permission-code]`).count()).toBe(0);
    expect(await page!.locator(`${closed} [data-permission-body]`).count()).toBe(0);
    expect(await page!.locator(`${closed} [data-permission-body-trigger]`).textContent()).toBe("show the file");
    await page!.locator(`${closed} [data-permission-body-trigger]`).click();
    expect(await page!.locator(`${closed} [data-permission-body]`).textContent()).toBe("export const health = () => ({ ok: true });\n");

    // The closed one has no option left and says what closed it, in one muted mono line.
    expect(await page!.locator(closed).getAttribute("data-permission-open")).toBe("false");
    expect(await page!.locator(`${closed} [data-permission-option]`).count()).toBe(0);
    expect(await page!.locator(`${closed} [data-permission-outcome]`).textContent()).toBe("Allowed");
    const outcome = await page!.evaluate(skinOf(`${closed} [data-permission-outcome]`));
    expect(outcome).toMatchObject({ background: "rgba(0, 0, 0, 0)", border: "0px", radius: "0px" });
    expect(String((outcome as { font: string }).font).toLowerCase()).toMatch(/mono/);

    // The text the decision rests on is shown whole: every other tool row can afford to truncate, this is the row
    // where consent is given. Read off the element rather than the class: nothing is clipped, nothing is elided,
    // and it took more than one line to say it, so the wrap is what is on screen.
    const input = await page!.evaluate(`(() => {
      const el = document.querySelector('${open} [data-permission-code]');
      const s = getComputedStyle(el);
      return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1, overflow: s.textOverflow, whiteSpace: s.whiteSpace, lines: Math.round(el.getBoundingClientRect().height / parseFloat(s.lineHeight)) };
    })()`);
    const shown = input as { text: string; clipped: boolean; overflow: string; whiteSpace: string; lines: number };
    expect(shown.text).toBe(COMMAND);
    expect(shown.clipped).toBe(false);
    expect(shown.overflow).toBe("clip");
    expect(shown.whiteSpace).toBe("pre-wrap");
    expect(shown.lines).toBeGreaterThan(1);

    // The command is drawn in the mono face, and that is the point of keeping it out of the sentence: in the
    // sentence face two hyphens measure what one long dash measures, so --minWorkers reads as one dash, while in
    // mono the pair is half again as wide as the dash and a person can see there are two of them.
    const hyphens = await page!.evaluate(`(() => {
      const code = document.querySelector('${open} [data-permission-code]');
      const says = document.querySelector('${open} [data-permission-says]');
      const width = (face, text) => {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + getComputedStyle(face).font;
        probe.textContent = text;
        document.body.appendChild(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      };
      const ratio = face => width(face, '--') / width(face, '\u2014');
      return { mono: getComputedStyle(code).fontFamily, sans: getComputedStyle(says).fontFamily, code: ratio(code), says: ratio(says) };
    })()`);
    const pair = hyphens as { mono: string; sans: string; code: number; says: number };
    expect(pair.mono.toLowerCase()).toMatch(/mono/);
    expect(pair.sans.toLowerCase()).not.toMatch(/mono/);
    // In the sentence face the pair and the dash are within a tenth of each other (measured 1.07, which is the
    // 12.91 px against 12.09 px a reviewer read off the shipped row); in mono the pair is clear of the dash.
    expect(Math.abs(pair.says - 1)).toBeLessThan(0.1);
    expect(pair.code).toBeGreaterThan(1.2);

    // Both rows sit in the timeline at the same width and wear the same rule under them as the rows around them.
    const widths = await page!.evaluate(`[document.querySelector('${open}').getBoundingClientRect().width, document.querySelector('${closed}').getBoundingClientRect().width]`);
    expect((widths as number[])[0]).toBe((widths as number[])[1]);
    for (const selector of [open, closed]) {
      const row = await page!.evaluate(skinOf(selector));
      expect(row).toMatchObject({ background: "rgba(0, 0, 0, 0)", radius: "0px" });
    }

    const shot = join(SHOTS, `permission-prompt-${theme}.png`);
    await page!.locator(open).locator("xpath=ancestor::div[@data-timeline-root][1]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 45_000);

  it("never breaks a command inside a token, and keeps the buttons on the screen when the file is opened", async () => {
    const laptop = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await laptop.goto(`${base}&theme=light`);
      const long = '[data-permission-prompt="ask_long"]';
      const file = '[data-permission-prompt="ask_file"]';
      await laptop.waitForSelector(long);

      // A run without a space in it is one string on one line however wide it is, and the line scrolls sideways
      // rather than splitting it at one of its own slashes: a path across five lines is one nobody can check.
      const token = await laptop.evaluate(`(() => {
        const el = document.querySelector('${long} [data-permission-code]');
        const runs = [...el.querySelectorAll('span')];
        const longest = runs.reduce((a, b) => (b.textContent.length > a.textContent.length ? b : a));
        const range = document.createRange();
        range.selectNodeContents(longest);
        const tops = [...range.getClientRects()].map(r => Math.round(r.top));
        return { characters: longest.textContent.length, lines: new Set(tops).size, scrolls: el.scrollWidth > el.clientWidth + 1, wrap: getComputedStyle(longest).whiteSpace, overflowX: getComputedStyle(el).overflowX };
      })()`);
      const run = token as { characters: number; lines: number; scrolls: boolean; wrap: string; overflowX: string };
      expect(run.characters).toBeGreaterThan(180);
      expect(run.lines).toBe(1);
      expect(run.scrolls).toBe(true);
      expect(run.wrap).toBe("pre");
      expect(run.overflowX).toBe("auto");

      // With the file open the body takes a box of its own height, so the lead and every option stay in the window
      // on a laptop: a person who opened the file to read it can still answer without hunting for the buttons.
      await laptop.locator(`${file} [data-permission-body-trigger]`).click();
      await laptop.waitForSelector(`${file} [data-permission-body]`);
      await laptop.locator(file).scrollIntoViewIfNeeded();
      const reach = await laptop.evaluate(`(() => {
        const row = document.querySelector('${file}');
        const body = row.querySelector('[data-permission-body]');
        const options = [...row.querySelectorAll('[data-permission-option], [data-permission-outcome]')];
        const box = el => el.getBoundingClientRect();
        return {
          bodyScrolls: body.scrollHeight > body.clientHeight + 1,
          bodyHeight: Math.round(box(body).height),
          rowHeight: Math.round(box(row).height),
          leadTop: Math.round(box(row.querySelector('[data-permission-lead]')).top),
          lastBottom: Math.round(Math.max(...options.map(el => box(el).bottom))),
          window: window.innerHeight,
        };
      })()`);
      const open2 = reach as { bodyScrolls: boolean; bodyHeight: number; rowHeight: number; leadTop: number; lastBottom: number; window: number };
      expect(open2.bodyScrolls).toBe(true);
      expect(open2.bodyHeight).toBeLessThanOrEqual(320);
      expect(open2.leadTop).toBeGreaterThanOrEqual(0);
      expect(open2.lastBottom).toBeLessThanOrEqual(open2.window);
      expect(open2.rowHeight).toBeLessThan(open2.window);

      const shot = join(SHOTS, "permission-prompt-open-file.png");
      await laptop.screenshot({ path: shot });
      expect(existsSync(shot)).toBe(true);
    } finally {
      await laptop.close();
    }
  }, 45_000);
});
