// SPDX-License-Identifier: AGPL-3.0-only
// A computer's row with its chips, measured in a real Chromium at the 390 px
// sheet in both themes, since jsdom lays nothing out: the name and every chip
// stand wholly inside the row, on the Computers list and under Add a computer
// once a box has joined. Runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`computer row render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("a computer's row at 390", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** Every chip-bearing row under `scope` whose name or a chip reaches past the row's own box, or whose name is cut. */
  const cut = (scope: string) =>
    page!.evaluate(scope => {
      const rows = [...document.querySelectorAll<HTMLElement>(`${scope} [data-place-row]`)].filter(row => row.querySelector("[data-chips]") !== null);
      return {
        rows: rows.length,
        cut: rows.flatMap(row => {
          const box = row.getBoundingClientRect();
          const title = row.querySelector<HTMLElement>("[data-settings-title]")!;
          const parts = [title, ...row.querySelectorAll<HTMLElement>("[data-chips] > *")];
          const out = parts.filter(el => {
            const b = el.getBoundingClientRect();
            return b.top < box.top || b.bottom > box.bottom || b.left < box.left || b.right > box.right;
          });
          const clipped = title.scrollWidth > title.clientWidth ? [title] : [];
          return [...out, ...clipped].map(el => `${row.dataset["placeRow"]}: ${el.textContent}`);
        }),
      };
    }, scope);

  it.each(["dark", "light"] as const)("in the %s theme the joined box's row under Add a computer cuts neither its name nor a chip", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-add-joined&theme=${theme}`);
    await page!.waitForSelector("[data-k='road-ssh'] [data-k='joined'] [data-place-row]");
    const got = await cut("[data-k='joined']");
    expect(got.rows).toBe(1);
    expect(got.cut).toEqual([]);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme no row on the Computers list cuts its name or a chip", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-computers&theme=${theme}`);
    await page!.waitForSelector("[data-settings-card='computers'] [data-place-row]");
    const got = await cut("[data-settings-card='computers']");
    expect(got.rows).toBeGreaterThan(0);
    expect(got.cut).toEqual([]);
  }, 60_000);
});
