// SPDX-License-Identifier: AGPL-3.0-only
// The browser pane's bar in a real Chromium once an address with a path and a
// query was typed: the bar reads localhost:<port> with the path and the query,
// the frame's src is the minted route with the path before the token, and the
// token itself is nowhere a person reads. Photographed in both themes. Like
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
const TYPED = "localhost:3000/about?x=1";

if (renderSkipped !== undefined) console.info(`browser path render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the browser pane's bar with a path, laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html?ws=ws_a&panel=browser&at=${encodeURIComponent(TYPED)}`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the bar shows the typed address and the frame carries the path with the token", async theme => {
    await page!.goto(`${base}&theme=${theme}`);
    const bar = "[data-browser-surface] [data-surface-subheader]";
    await page!.waitForSelector(`${bar} [data-preview-url-input]`);
    await page!.waitForSelector("[data-browser-surface] iframe", { state: "attached" });

    expect(await page!.locator(`${bar} [data-preview-url-input]`).inputValue()).toBe(TYPED);
    expect(await page!.locator("[data-browser-surface] iframe").getAttribute("src")).toBe("https://m1-3000.preview.example/about?pt_token=e&x=1");
    expect(await page!.locator("[data-browser-surface]").evaluate(el => (el as HTMLElement).innerText)).not.toContain("pt_token");
    expect(await page!.locator("[data-active-tab='true']").innerText()).toContain(":3000/about?x=1");

    const shot = join(SHOTS, `browser-path-${theme}.png`);
    await page!.locator(bar).screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 45_000);
});
