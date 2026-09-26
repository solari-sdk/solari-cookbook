// SPDX-License-Identifier: AGPL-3.0-only
// The composer's project pick in a real Chromium: the pick sits in the footer
// right after the access pick at the same height, reads the workspace's one
// project in muted mono, its menu lists that project and other folder, and the
// line under the box names the folder the project lands in; photographed in
// both themes. Vite serves test/shell to Playwright's browser, so like the
// shell layout test it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");

if (renderSkipped !== undefined) console.info(`projects layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the project pick laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    // Wide enough for the footer to hold every pick on one line beside the open panel; narrower, the row wraps.
    page = await browser.newPage({ viewport: { width: 1600, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it("the pick sits beside the access pick at one height, reads the workspace's project in muted mono, its menu lists it and other folder, and the line under the box names its folder, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&projects=1&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='project']");
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      // Both read in one frame: the empty view's composer glides into place as it mounts.
      const [pick, access] = await page!.evaluate(() =>
        ["project", "access"].map(name => {
          const b = document.querySelector(`[data-composer-picker='${name}']`)!.getBoundingClientRect();
          return { y: b.y, height: b.height };
        }),
      );
      expect(Math.abs(pick!.height - access!.height)).toBeLessThan(1);
      expect(Math.abs(pick!.y - access!.y)).toBeLessThan(1);
      // The pick follows the access pick in the footer: model, effort, access, project.
      const order = await page!.locator("[data-chat-composer-footer]").evaluate(el => [...el.querySelectorAll("[data-composer-picker]")].map(b => b.getAttribute("data-composer-picker")));
      expect(order.indexOf("project")).toBe(order.indexOf("access") + 1);
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const trigger = el.querySelector<HTMLElement>("[data-composer-picker='project']")!;
        const name = trigger.querySelector<HTMLElement>("[data-composer-project-name]")!;
        const access = el.querySelector<HTMLElement>("[data-composer-picker='access']")!;
        const folder = el.querySelector<HTMLElement>("[data-composer-folder]")!;
        const n = getComputedStyle(name);
        const t = getComputedStyle(trigger);
        const a = getComputedStyle(access);
        const skin = (s: CSSStyleDeclaration) => ({ color: s.color, background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopColor}`, font: s.fontSize, height: s.height });
        return {
          value: trigger.getAttribute("data-value"),
          name: name.textContent,
          mono: /mono/i.test(n.fontFamily),
          skin: skin(t),
          accessSkin: skin(a),
          nameBackground: n.backgroundColor,
          folder: folder.getAttribute("data-composer-folder"),
          folderMono: /mono/i.test(getComputedStyle(folder.querySelector(".font-mono") ?? folder).fontFamily),
        };
      });
      expect(read.value).toBe("the-project");
      expect(read.name).toBe("the-project");
      expect(read.mono).toBe(true);
      // The same skin as the access pick, on nothing: one muted label, no fill, no chip around the name.
      expect(read.skin).toEqual(read.accessSkin);
      expect(read.skin.background).toBe("rgba(0, 0, 0, 0)");
      expect(read.nameBackground).toBe("rgba(0, 0, 0, 0)");
      expect(read.folder).toBe("/root");
      expect(read.folderMono).toBe(true);
      const closed = join(SHOTS_DIR, `composer-project-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path: closed });
      console.info(`composer project pick screenshot: ${closed}`);

      await page!.locator("[data-composer-picker='project']").click();
      await page!.waitForSelector("[data-composer-project='the-project']");
      const rows = await page!.locator("[role=menu]").first().evaluate(menu => ({
        projects: [...menu.querySelectorAll<HTMLElement>("[data-composer-project]")].map(el => el.getAttribute("data-composer-project")),
        other: menu.querySelector<HTMLElement>("[data-composer-project-other]")?.textContent ?? null,
        heights: [...menu.querySelectorAll<HTMLElement>("[data-composer-project], [data-composer-project-other]")].map(el => el.getBoundingClientRect().height),
      }));
      expect(rows.projects).toEqual(["the-project"]);
      expect(rows.other).toBe("other folder");
      expect(new Set(rows.heights.map(h => Math.round(h))).size).toBe(1);
      const menu = join(SHOTS_DIR, `composer-project-menu-${theme}.png`);
      await page!.locator("[role=menu]").first().screenshot({ path: menu });
      console.info(`composer project menu screenshot: ${menu}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[role=menu]", { state: "detached" });
    }
  }, 60_000);
});
