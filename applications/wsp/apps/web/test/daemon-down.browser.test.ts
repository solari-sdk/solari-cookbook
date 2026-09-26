// SPDX-License-Identifier: AGPL-3.0-only
// The daemon-down pane in a real Chromium after the host refused a start: the
// host's sentence and Start again sit under the button, wrap inside the pane,
// and the pane is photographed in both themes. Like the other render tests it
// runs only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`daemon-down render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("a refused daemon start laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/daemon-down/index.html");
    base = `${vite.base}/test/daemon-down/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the host's sentence and Start again wrap under the button inside the pane", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.locator("[data-k=start-daemon]").click();
    const line = page!.locator("[data-k=start-daemon-refused]");
    await line.waitFor();
    expect(await line.textContent()).toBe(
      "wsp-daemon at /Users/maya/Library/wsp_daemon_release_builds_2026_09_24_x86_64_unknown_linux_musl_bin/wsp_daemon exited at once: address 127.0.0.1:4640 already in use. Start again.",
    );
    const pane = (await page!.locator("[data-k=pane]").boundingBox())!;
    const button = (await page!.locator("[data-k=start-daemon]").boundingBox())!;
    const box = (await line.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
    expect(box.height).toBeGreaterThan(20);
    const shot = join(SHOTS, `daemon-down-refused-${theme}.png`);
    await page!.locator("[data-k=pane]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 30_000);
});
