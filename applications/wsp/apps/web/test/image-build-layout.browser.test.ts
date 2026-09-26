// SPDX-License-Identifier: AGPL-3.0-only
// The image's build in the Image card of a computer's page, in a real
// Chromium, at 1280 by 800 and 390 by 844, in every build state the wireframe
// stages: the page is the one thing that scrolls, so landing on it and a
// focus change during the build leave the settings scroller where it was, the
// card's head stays on screen, and the list is drawn whole with no stage
// clipped inside a box the wheel cannot scroll. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`image build layout render test skipped: ${renderSkipped}`);

const SCREENS: [string, string][] = [
  ["settings-image-build", ""],
  ["settings-image-build", "&advance=1"],
  ["settings-image-signin", ""],
  ["settings-image-build-sealing", ""],
  ["settings-image-build-stopped", ""],
  ["settings-image-build-failed", ""],
  ["settings-image-build-key", "&computer=solari"],
];
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

interface Layout {
  scrolled: string[];
  headTop: number;
  clipped: string[];
  rows: number;
}

/** Every ancestor of the card that has scrolled, the head's top, and the rows the list shows only in part. */
const measure = (page: Page): Promise<Layout> =>
  page.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-settings-card='image']")!;
    const scrolled: string[] = [];
    for (let el: HTMLElement | null = card; el !== null; el = el.parentElement) if (el.scrollTop !== 0) scrolled.push(`${el.tagName}[${el.getAttribute("data-k") ?? el.getAttribute("data-slot") ?? ""}] ${el.scrollTop}`);
    if (window.scrollY !== 0) scrolled.push(`window ${window.scrollY}`);
    const list = card.querySelector<HTMLElement>("[data-k='build'] [data-k='card']")!;
    for (const el of list.querySelectorAll<HTMLElement>("*")) if (el.scrollTop !== 0) scrolled.push(`list ${el.getAttribute("data-slot") ?? el.tagName} ${el.scrollTop}`);
    if (list.scrollTop !== 0) scrolled.push(`list ${list.scrollTop}`);
    const box = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll<HTMLElement>("li[data-k='row'], li[data-k='signin']")].filter(li => li.parentElement?.closest("li") === null);
    const clipped = rows.filter(li => {
      const r = li.getBoundingClientRect();
      return r.top < box.top - 1 || r.bottom > box.bottom + 1;
    });
    return { scrolled, headTop: card.getBoundingClientRect().top, clipped: clipped.map(li => li.getAttribute("data-row") ?? "?"), rows: rows.length };
  });

describe.skipIf(renderSkipped !== undefined)("the build in the Image card laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    browser = await launchRender();
    page = await browser.newPage({ viewport: { ...VIEWPORTS[0] } });
    await page.addInitScript(() => window.localStorage.clear());
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  for (const viewport of VIEWPORTS) {
    for (const [screen, extra] of SCREENS) {
      it(`${screen}${extra} at ${viewport.width}: nothing scrolls on landing or on a focus change, and every stage is drawn whole`, async () => {
        await page!.setViewportSize(viewport);
        await page!.goto(`${vite!.base}/test/wireframe/index.html?screen=${screen}&theme=dark${extra}`);
        await page!.waitForSelector("[data-settings-card='image'] [data-k='build'] [data-k='card']", { timeout: 15_000 });
        // The staged focus change lands 300 ms in; the page is read after it.
        await page!.waitForTimeout(700);
        if (extra === "&advance=1") expect(await page!.locator("[data-row='stage/installing-mcp']").getAttribute("data-state")).toBe("running");
        const layout = await measure(page!);
        expect(layout.rows).toBeGreaterThan(1);
        expect(layout.scrolled).toEqual([]);
        expect(layout.headTop).toBeGreaterThanOrEqual(0);
        expect(layout.clipped).toEqual([]);
      }, 30_000);
    }
  }
});
