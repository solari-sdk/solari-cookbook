// SPDX-License-Identifier: AGPL-3.0-only
// A subagent's fold in a real Chromium, measured against its own header: the
// rail under the chevron's centre, every line of the body starting at the
// title's left edge, and a prompt the subagent raised sitting on that same
// edge rather than a gutter to the right of it. The slot beside the title is
// read too, since a background agent whose launch the harness answered with
// its own note is still working and a state word over it would be a lie. Like
// the other render tests it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`subagent fold render test skipped: ${renderSkipped}`);

/** The fold holding a prompt of its own, the one that finished, and the background one still writing. */
const ASKING = '[data-subagent="toolu_a"]';
const DONE = '[data-subagent="toolu_b"]';
const BACKGROUND = '[data-subagent="toolu_c"]';

describe.skipIf(renderSkipped !== undefined)("a subagent's fold laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html?local=1&ws=ws_m&fold=1`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the body hangs from the chevron and starts under the title", async theme => {
    await page!.goto(`${base}&theme=${theme}`);
    await page!.waitForSelector(`${ASKING} [data-subagent-body]`);

    // The fold with a question in it opened itself; the others are the person's to open.
    expect(await page!.locator(`${ASKING} [data-subagent-trigger]`).getAttribute("aria-expanded")).toBe("true");
    expect(await page!.locator(`${DONE} [data-subagent-body]`).count()).toBe(0);

    const geometry = await page!.evaluate(`(() => {
      const fold = document.querySelector('${ASKING}');
      const left = el => el.getBoundingClientRect().left;
      const chevron = fold.querySelector('[data-subagent-trigger] svg').getBoundingClientRect();
      const body = fold.querySelector('[data-subagent-body]');
      const lines = [...body.querySelectorAll('[data-subagent-line] > span')];
      return {
        title: left(fold.querySelector('[data-subagent-title]')),
        rail: body.getBoundingClientRect().left,
        railWidth: parseFloat(getComputedStyle(body).borderLeftWidth),
        chevronCentre: chevron.left + chevron.width / 2,
        edges: [
          ...lines.map(el => [el.textContent.slice(0, 20), left(el)]),
          ['asker', left(body.querySelector('[data-permission-asker]'))],
          ['command', left(body.querySelector('[data-permission-lead]'))],
          ['first button', left(body.querySelector('[data-permission-option]'))],
        ],
      };
    })()`);
    const box = geometry as {
      title: number;
      rail: number;
      railWidth: number;
      chevronCentre: number;
      edges: [string, number][];
    };

    // The rail is a hairline hanging from the middle of the chevron above it, so the fold reads as one shape
    // rather than a header with a rule beside it.
    expect(box.railWidth).toBe(1);
    expect(box.rail).toBeCloseTo(box.chevronCentre, 1);

    // Everything inside the fold starts where the title starts: its lines, the name of the agent asking, the
    // command it wants to run and the first of the buttons that answer it, the rest of which sit in that row
    // beside it. A prompt carrying a gutter of its own sat 4 px right of the lines above it.
    expect(box.edges.length).toBeGreaterThan(3);
    expect(box.edges.map(([label, at]) => [label, Math.round(at - box.title)])).toEqual(box.edges.map(([label]) => [label, 0]));

    const shot = join(SHOTS, `subagent-fold-${theme}.png`);
    await page!.locator(ASKING).screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 45_000);

  it("says nothing in the slot of an agent still writing, and Done only once one really answered", async () => {
    await page!.goto(`${base}&theme=light`);
    await page!.waitForSelector(BACKGROUND);

    // The harness answers a background launch at once with its own note that the agent started. That is not the
    // work finishing: this agent wrote its line after the note, and an empty slot is what running looks like here.
    expect(await page!.locator(`${BACKGROUND}`).getAttribute("data-subagent-state")).toBe("running");
    expect((await page!.locator(`${BACKGROUND} [data-subagent-slot]`).textContent())?.trim()).toBe("");
    await page!.locator(`${BACKGROUND} [data-subagent-trigger]`).click();
    await page!.waitForSelector(`${BACKGROUND} [data-subagent-body]`);
    expect(await page!.locator(`${BACKGROUND} [data-subagent-body]`).textContent()).toContain("Root has 28G free.");

    // The one whose launch answered with the subagent's own words is the one wearing a state word.
    expect(await page!.locator(DONE).getAttribute("data-subagent-state")).toBe("done");
    expect(await page!.locator(`${DONE} [data-subagent-slot]`).textContent()).toContain("Done");

    // Nothing the harness wrote for the model reaches the page.
    const shown = await page!.locator("body").textContent();
    expect(shown).not.toContain("internal metadata");
    expect(shown).not.toContain("agentId");
  }, 45_000);
});
