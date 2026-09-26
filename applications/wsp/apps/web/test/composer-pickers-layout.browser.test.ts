// SPDX-License-Identifier: AGPL-3.0-only
// The composer's picker row in a real Chromium, on a kept machine that holds
// projects and whose harness takes an effort, so the row carries every
// trigger it has: model, reasoning, access and project. At the 1200 px viewport
// with the right panel open, as it opens by default, and at the narrowest
// centre the shell hands the row (an 1100 px viewport with the sidebar at its
// widest and the right panel open inline, where the sidebar gives way and the
// column sits at the shell's floor), every trigger reads
// whole, none is cut by its own box or by the row's, and a pick of the access
// mode whose label names the machine moves no other trigger: the access
// trigger wears the mode's short form, and its menu row the long one. A project
// name, the one label a person writes and no width bounds, is cut on its
// button inside the row rather than running under the send button, and
// reads whole in its menu row. Photographed in both themes. Runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THIS_COMPUTER } from "@wsp/protocol";
import { accessLabel } from "../src/components/chat/format";
import { SIDEBAR_MAX_WIDTH } from "../src/shell/sidebarWidth";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");

interface Trigger {
  picker: string;
  text: string;
  /** The label span is wider than the room the trigger gives it: what a truncate cut looks like. */
  cut: boolean;
  left: number;
  right: number;
  /** From the footer's top edge, so a composer the empty view settles into place does not read as the pick moving it. */
  top: number;
  height: number;
}

interface Row {
  /** The visible edges of the footer, whose own children are the triggers and which they must sit inside. */
  group: { left: number; right: number; width: number; height: number; overflow: number };
  footer: { height: number; width: number };
  triggers: Trigger[];
}

if (renderSkipped !== undefined) console.info(`composer pickers layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the composer's picker row laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const box = async (selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };

  const readRow = (): Promise<Row> =>
    page!.locator("[data-chat-composer-footer]").evaluate(footer => {
      const group = footer;
      const g = group.getBoundingClientRect();
      const f = footer.getBoundingClientRect();
      const triggers = [...footer.querySelectorAll<HTMLElement>("[data-composer-picker]")].map(el => {
        const label = [...el.querySelectorAll<HTMLElement>("span")].find(s => s.classList.contains("truncate"))!;
        const b = el.getBoundingClientRect();
        return {
          picker: el.getAttribute("data-composer-picker") ?? "",
          text: el.textContent ?? "",
          cut: label.scrollWidth > label.clientWidth,
          left: b.left,
          right: b.right,
          top: b.top - f.top,
          height: b.height,
        };
      });
      return {
        group: { left: g.left, right: g.right, width: g.width, height: g.height, overflow: group.scrollWidth - group.clientWidth },
        footer: { height: f.height, width: f.width },
        triggers,
      };
    });

  /** The pick that names the machine, made from the menu as a person makes it. */
  const pickBypass = async (): Promise<string> => {
    const trigger = "[data-composer-picker='access']";
    await page!.locator(trigger).click();
    await page!.waitForSelector("[data-composer-option='bypassPermissions']");
    const row = (await page!.locator("[data-composer-option='bypassPermissions']").textContent()) ?? "";
    await page!.locator("[data-composer-option='bypassPermissions']").click();
    await page!.waitForSelector(`${trigger}[data-access='bypassPermissions']`);
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[role=menu]", { state: "detached" });
    return row;
  };

  const expectWhole = (row: Row, where: string): void => {
    expect(row.triggers.map(t => t.picker), `the pickers at ${where}`).toEqual(["model", "reasoning", "access", "project"]);
    for (const t of row.triggers) {
      expect(t.cut, `${t.picker} reads "${t.text}" cut at ${where}`).toBe(false);
      expect(t.left, `${t.picker} starts before the row at ${where}`).toBeGreaterThanOrEqual(row.group.left - 0.5);
      expect(t.right, `${t.picker} runs past the row at ${where}`).toBeLessThanOrEqual(row.group.right + 0.5);
    }
    expect(row.group.overflow, `the row scrolls at ${where}`).toBe(0);
  };

  const widths = [
    { name: "1200", viewport: 1200, query: "", label: "the 1200 px viewport with the panel open" },
    { name: "narrowest", viewport: 1100, query: `&sidebar=${SIDEBAR_MAX_WIDTH}&panel=preview`, label: "the narrowest centre the shell hands the row, an 1100 px viewport with the sidebar at its widest and the panel inline" },
  ] as const;

  for (const width of widths) {
    it(`at ${width.label} every trigger reads whole before and after bypass is picked, the access trigger wears the short form and its menu row the long one, and nothing else moves, in both themes`, async () => {
      await page!.setViewportSize({ width: width.viewport, height: 800 });
      for (const theme of ["dark", "light"] as const) {
        await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&projects=1&efforts=1${width.query}`);
        await page!.waitForSelector("[data-composer-picker='project']");
        await page!.waitForSelector("text=loading transcript", { state: "detached" });
        const before = await readRow();
        console.info(`${width.name} ${theme} before: ${JSON.stringify(before)}`);
        const menuRow = await pickBypass();
        const after = await readRow();
        console.info(`${width.name} ${theme} after: ${JSON.stringify(after)} menu row "${menuRow}"`);
        const shot = join(SHOTS_DIR, `composer-pickers-${width.name}-${theme}.png`);
        await page!.locator("[data-chat-composer]").screenshot({ path: shot });
        console.info(`composer pickers screenshot: ${shot}`);

        expectWhole(before, `${width.label} before the pick in ${theme}`);
        expectWhole(after, `${width.label} after the pick in ${theme}`);
        const access = after.triggers.find(t => t.picker === "access")!;
        expect(access.text).toBe(accessLabel({ value: "bypassPermissions", label: `Bypass on ${THIS_COMPUTER}`, short: "Bypass" }));
        expect(menuRow).toContain(`Bypass on ${THIS_COMPUTER}`);
        // The pick moves nothing but the triggers after its own, and those only by the width of the word: every
        // trigger keeps its line and its height, the ones before the access pick keep their boxes, and the footer
        // keeps its height.
        const lines = (row: Row) => row.triggers.map(t => ({ picker: t.picker, top: t.top, height: t.height }));
        expect(lines(after)).toEqual(lines(before));
        const ahead = (row: Row) => row.triggers.slice(0, row.triggers.findIndex(t => t.picker === "access"));
        expect(ahead(after)).toEqual(ahead(before));
        expect(after.footer.height).toBe(before.footer.height);
        expect(new Set(after.triggers.map(t => t.height))).toEqual(new Set([32]));

        // A project name longer than the row: its button is cut inside the row, under nothing, and every other
        // trigger still reads whole.
        const longest = "customer-billing-service-platform";
        await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&projects=1&efforts=1&longproject=1${width.query}`);
        await page!.waitForSelector(`[data-composer-picker='project'][data-value='${longest}']`);
        const long = await readRow();
        console.info(`${width.name} ${theme} long name: ${JSON.stringify(long)}`);
        const longShot = join(SHOTS_DIR, `composer-pickers-long-${width.name}-${theme}.png`);
        await page!.locator("[data-chat-composer]").screenshot({ path: longShot });
        console.info(`composer pickers long name screenshot: ${longShot}`);
        const project = long.triggers.find(t => t.picker === "project")!;
        expect(project.text).toBe(longest);
        for (const t of long.triggers) {
          if (t.picker !== "project") expect(t.cut, `${t.picker} reads "${t.text}" cut beside the long name at ${width.label} in ${theme}`).toBe(false);
          expect(t.left, `${t.picker} starts before the row at ${width.label} in ${theme}`).toBeGreaterThanOrEqual(long.group.left - 0.5);
          expect(t.right, `${t.picker} runs past the row at ${width.label} in ${theme}`).toBeLessThanOrEqual(long.group.right + 0.5);
        }
        expect(long.group.overflow, `the row scrolls with the long name at ${width.label} in ${theme}`).toBe(0);
        const send = await box("[data-chat-composer-actions] button[type=submit]");
        expect(project.right, `the long name runs under the send button at ${width.label} in ${theme}`).toBeLessThanOrEqual(send.x);
      }
    }, 60_000);
  }
});
