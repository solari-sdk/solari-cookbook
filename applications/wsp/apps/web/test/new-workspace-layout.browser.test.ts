// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog in a real Chromium, both themes: one question, the
// Project control under it and one line in the muted mono voice saying where
// the work lands, which reads at AA and wraps inside the card; at 1280 by 800
// the card hangs 160 px down with nothing scrolling inside it; and at a
// phone's width the held Create keycap takes the same width and place as the
// live one, so the footer does not move as the question is answered.
// Photographed in each state and theme. Runs only when asked for (WSP_RENDER=1)
// and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`new workspace layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the new-workspace dialog laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/new-workspace/index.html");
    base = `${vite.base}/test/new-workspace/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the dialog asks one question and says where the work lands in one muted mono line", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    const line = page!.locator("[data-k=landing]");
    await line.waitFor();
    expect(await page!.locator("[role=dialog] label").allTextContents()).toEqual(["What are you working on", "Project"]);
    // No size rows, no image caption and no branch field: the rest are defaults the runtime decides.
    expect(await page!.locator("[aria-label=Size]").count()).toBe(0);
    // The project pick's segments carry hidden radio inputs of their own; the one field is the task's.
    expect(await page!.locator("[role=dialog] input:not([aria-hidden=true])").count()).toBe(1);
    expect(await line.textContent()).toBe("This Mac shares this Mac's ports");
    const drawn = await line.evaluate(el => ({ font: getComputedStyle(el).fontFamily, width: Math.round(el.getBoundingClientRect().width) }));
    expect(drawn.font.toLowerCase()).toMatch(/mono/);
    expect(drawn.width).toBeLessThanOrEqual(334);
    expect(await line.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const ratios = await textContrast(page!, "[data-k=landing]");
    console.info(`${theme}: the landing line reads at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `new-workspace-open-${theme}.png`) });
  });

  it.each(["dark", "light"] as const)("in the %s theme picking the other project says that computer's own words on the same line", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.locator("[data-k=landing]").waitFor();
    await page!.locator("[data-segment=pr_2]").click();
    expect(await page!.locator("[data-k=landing]").textContent()).toBe("spoo own network");
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `new-workspace-elsewhere-${theme}.png`) });
  });

  it("at 1280 by 800 the card hangs 160 px from the top and nothing scrolls inside it", async () => {
    const desktop = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await desktop.goto(`${base}?theme=dark`);
      await desktop.locator("[data-k=landing]").waitFor();
      const popup = await desktop.locator("[data-slot=dialog-popup]").evaluate(el => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      });
      console.info(`1280 by 800: the card stands from ${popup.top} to ${popup.bottom}`);
      expect(popup.top).toBe(160);
      expect(popup.bottom).toBeLessThanOrEqual(800);
      await desktop.screenshot({ path: join(SHOTS, "new-workspace-1280.png") });
    } finally {
      await desktop.close();
    }
  });

  it("at a phone's width the held keycap takes the same width and place as the live one", async () => {
    const phone = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await phone.goto(`${base}?theme=dark`);
      const create = phone.locator("[role=dialog] button", { hasText: "Create" });
      await create.waitFor();
      const rect = async (): Promise<{ width: number; left: number }> => create.evaluate(el => ({ width: Math.round(el.getBoundingClientRect().width), left: Math.round(el.getBoundingClientRect().left) }));
      // Held while the one question has no answer, live the moment it has one, and the keycap does not move.
      expect(await create.isDisabled()).toBe(true);
      const held = await rect();
      await phone.locator("#new-workspace-work").fill("pricing page");
      expect(await create.isDisabled()).toBe(false);
      const live = await rect();
      console.info(`390: held Create ${held.width} px at ${held.left}, live ${live.width} px at ${live.left}`);
      expect(held).toEqual(live);
      expect(live.width).toBeGreaterThan(300);
      await phone.screenshot({ path: join(SHOTS, "new-workspace-390.png") });
    } finally {
      await phone.close();
    }
  });
});
