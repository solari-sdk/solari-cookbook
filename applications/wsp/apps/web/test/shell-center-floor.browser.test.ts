// SPDX-License-Identifier: AGPL-3.0-only
// The shell's three columns in a real Chromium with the sidebar at its widest
// and the right panel open inline: at every width the panel is inline the
// centre column keeps its floor, the sidebar is what gives way and never
// below its own minimum, the panel keeps its own minimum and ends at the
// window's edge, the composer's picker row reads whole with every trigger
// inside it, nothing on the shell scrolls, closing the panel gives the
// sidebar its width back with the header and the column in the same place,
// and one width under the breakpoint the panel is a sheet over a centre
// column the sidebar leaves whole. While the cap holds the sidebar under the
// kept width, a press on the rail with no travel keeps the record as it was
// and a drag past the cap writes the width the pointer asked for inside the
// record's own bounds, so the sidebar comes back to it once the panel closes.
// Both themes draw the same boxes. Runs only when asked for (WSP_RENDER=1)
// and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CENTER_COLUMN_MIN_WIDTH, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_SHEET_MAX_VIEWPORT, sidebarMaxWidthBeside } from "../src/rightPanelLayout";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../src/shell/sidebarWidth";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");

interface Rect {
  left: number;
  right: number;
  top: number;
  width: number;
  height: number;
}

interface Trigger {
  picker: string;
  text: string;
  cut: boolean;
  left: number;
  right: number;
  top: number;
  height: number;
}

interface Shell {
  sidebar: Rect;
  center: Rect;
  header: Rect;
  panel: Rect | null;
  sheet: boolean;
  /** scrollWidth past clientWidth on the inset, its row and the page: a scrollbar or a column past the window. */
  overflow: { inset: number; row: number; page: number };
  group: { left: number; right: number; width: number; overflow: number };
  triggers: Trigger[];
}

if (renderSkipped !== undefined) console.info(`shell centre floor render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the shell's centre column floor laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const readShell = (): Promise<Shell> =>
    page!.evaluate(() => {
      const rect = (el: Element): Rect => {
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height };
      };
      const one = (selector: string): HTMLElement => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) throw new Error(`${selector} is not on the page`);
        return el;
      };
      const inset = one("[data-slot=sidebar-inset]");
      const center = one("[data-shell-center]");
      const row = center.parentElement!;
      const panel = document.querySelector("[data-preview-panel-mode=inline]");
      const footer = one("[data-chat-composer-footer]");
      const group = footer;
      const g = group.getBoundingClientRect();
      return {
        sidebar: rect(one("[data-slot=sidebar-gap]")),
        center: rect(center),
        header: rect(one("[data-shell-center] > header")),
        panel: panel === null ? null : rect(panel),
        sheet: document.querySelector("[data-preview-panel-mode=sheet]") !== null,
        overflow: {
          inset: inset.scrollWidth - inset.clientWidth,
          row: row.scrollWidth - row.clientWidth,
          page: document.documentElement.scrollWidth - window.innerWidth,
        },
        group: { left: g.left, right: g.right, width: g.width, overflow: group.scrollWidth - group.clientWidth },
        triggers: [...footer.querySelectorAll<HTMLElement>("[data-composer-picker]")].map(el => {
          const label = [...el.querySelectorAll<HTMLElement>("span")].find(s => s.classList.contains("truncate"))!;
          const b = el.getBoundingClientRect();
          return { picker: el.getAttribute("data-composer-picker") ?? "", text: el.textContent ?? "", cut: label.scrollWidth > label.clientWidth, left: b.left, right: b.right, top: b.top, height: b.height };
        }),
      };
    });

  /** The sidebar's width animates over 200 ms at half a pixel a millisecond, and the empty view's composer glides into
   * place as it mounts; a reading is taken once both have held still for 120 ms, whatever they read, so a shell that
   * never moves is measured as it stands. The poll is synchronous: Playwright takes a returned Promise as a truthy
   * value and would stop at the first frame. */
  const settle = async (): Promise<void> => {
    await page!.evaluate(() => delete document.documentElement.dataset["gapHeld"]);
    await page!.waitForFunction(() => {
      const width = document.querySelector("[data-slot=sidebar-gap]")!.getBoundingClientRect().width;
      const top = document.querySelector("[data-chat-composer-footer]")?.getBoundingClientRect().top ?? 0;
      const now = performance.now();
      const held = document.documentElement.dataset["gapHeld"]?.split(":").map(Number);
      if (held === undefined || held[0] !== width || held[1] !== top) {
        document.documentElement.dataset["gapHeld"] = `${width}:${top}:${now}`;
        return false;
      }
      return now - held[2]! >= 120;
    });
  };

  const expectRowWhole = (shell: Shell, where: string): void => {
    expect(shell.triggers.map(t => t.picker), `the pickers at ${where}`).toEqual(["model", "reasoning", "access", "project"]);
    for (const t of shell.triggers) {
      expect(t.cut, `${t.picker} reads "${t.text}" cut at ${where}`).toBe(false);
      expect(t.left, `${t.picker} starts before the row at ${where}`).toBeGreaterThanOrEqual(shell.group.left - 0.5);
      expect(t.right, `${t.picker} runs past the row at ${where}`).toBeLessThanOrEqual(shell.group.right + 0.5);
      expect(t.height, `${t.picker} is not one row high at ${where}`).toBe(32);
    }
    expect(shell.group.overflow, `the picker row scrolls at ${where}`).toBe(0);
  };

  const expectNoScroll = (shell: Shell, where: string): void => {
    expect(shell.overflow, `the shell scrolls at ${where}`).toEqual({ inset: 0, row: 0, page: 0 });
  };

  const lines = (shell: Shell): number => new Set(shell.triggers.map(t => t.top)).size;

  const widths = [1100, 1024, RIGHT_PANEL_SHEET_MAX_VIEWPORT + 1] as const;

  for (const viewport of widths) {
    it(`at ${viewport} px with the sidebar at its widest and the panel inline the centre keeps its floor, the sidebar gives way to the rule's width, the panel keeps its minimum at the window's edge, the picker row reads whole, nothing scrolls, and closing the panel puts the sidebar back without moving the header, in both themes`, async () => {
      await page!.setViewportSize({ width: viewport, height: 800 });
      const expectedSidebar = sidebarMaxWidthBeside(viewport, true);
      const byTheme: Record<string, { open: Shell; closed: Shell }> = {};
      for (const theme of ["dark", "light"] as const) {
        await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&projects=1&efforts=1&sidebar=${SIDEBAR_MAX_WIDTH}&panel=preview`);
        await page!.waitForSelector("[data-composer-picker='project']");
        await page!.waitForSelector("text=loading transcript", { state: "detached" });
        await settle();
        const open = await readShell();
        console.info(`${viewport} ${theme} open: ${JSON.stringify(open)} lines ${lines(open)}`);
        const shot = join(SHOTS_DIR, `shell-center-floor-${viewport}-${theme}.png`);
        await page!.screenshot({ path: shot });
        console.info(`shell centre floor screenshot: ${shot}`);

        const where = `${viewport} px in ${theme}`;
        expect(open.sheet, `the panel is a sheet at ${where}`).toBe(false);
        expect(open.panel, `no inline panel at ${where}`).not.toBeNull();
        expect(open.center.width, `the centre column is ${open.center.width} px at ${where}`).toBeGreaterThanOrEqual(CENTER_COLUMN_MIN_WIDTH - 0.5);
        expect(open.sidebar.width, `the sidebar is ${open.sidebar.width} px at ${where}`).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
        expect(Math.abs(open.sidebar.width - expectedSidebar), `the sidebar did not give way to ${expectedSidebar} px at ${where}`).toBeLessThan(0.5);
        expect(open.panel!.width, `the panel is ${open.panel!.width} px at ${where}`).toBeGreaterThanOrEqual(RIGHT_PANEL_MIN_WIDTH - 0.5);
        expect(open.panel!.right, `the panel runs past the window at ${where}`).toBeLessThanOrEqual(viewport + 0.5);
        expect(Math.abs(open.panel!.right - viewport), `the panel stops short of the window's edge at ${where}`).toBeLessThan(0.5);
        expect(Math.abs(open.center.left - open.sidebar.right), `a gap between the sidebar and the centre at ${where}`).toBeLessThan(0.5);
        expect(Math.abs(open.panel!.left - open.center.right), `a gap between the centre and the panel at ${where}`).toBeLessThan(0.5);
        expectNoScroll(open, `${where} with the panel open`);
        expectRowWhole(open, `${where} with the panel open`);

        // Closing the panel hands the sidebar its width back; the header and the column keep their place and height.
        await page!.locator("button[aria-label='Toggle right panel']").click();
        await page!.waitForSelector("[data-preview-panel-mode=inline]", { state: "detached" });
        await settle();
        const closed = await readShell();
        console.info(`${viewport} ${theme} closed: ${JSON.stringify(closed)} lines ${lines(closed)}`);
        expect(closed.panel).toBeNull();
        expect(Math.abs(closed.sidebar.width - SIDEBAR_MAX_WIDTH), `the sidebar did not come back to ${SIDEBAR_MAX_WIDTH} px at ${where}`).toBeLessThan(0.5);
        expect(Math.abs(closed.center.right - viewport), `the centre stops short of the window's edge with the panel closed at ${where}`).toBeLessThan(0.5);
        expect(closed.header.top).toBe(open.header.top);
        expect(closed.header.height).toBe(open.header.height);
        expect(closed.center.top).toBe(open.center.top);
        expect(closed.center.height).toBe(open.center.height);
        expectNoScroll(closed, `${where} with the panel closed`);
        expectRowWhole(closed, `${where} with the panel closed`);

        // Opening it again lands on the same boxes as the first open.
        await page!.locator("button[aria-label='Toggle right panel']").click();
        await page!.waitForSelector("[data-preview-panel-mode=inline]");
        await settle();
        const reopened = await readShell();
        expect(reopened).toEqual(open);
        byTheme[theme] = { open, closed };
      }
      // The theme paints; it moves nothing. The words are the same in both, so the triggers' boxes are too.
      expect(byTheme["light"]).toEqual(byTheme["dark"]);
    }, 90_000);
  }

  it(`at ${RIGHT_PANEL_SHEET_MAX_VIEWPORT + 1} px with the sidebar capped under its kept 480, a press on the rail without travel and a drag past the cap both leave the record at 480, and a drag to a width under 480 records that width, each read once the panel closes`, async () => {
    const viewport = RIGHT_PANEL_SHEET_MAX_VIEWPORT + 1;
    const cap = sidebarMaxWidthBeside(viewport, true);
    await page!.setViewportSize({ width: viewport, height: 800 });
    await page!.goto(`${base}?theme=dark&local=1&ws=ws_m&projects=1&efforts=1&sidebar=${SIDEBAR_MAX_WIDTH}&panel=preview`);
    await page!.waitForSelector("[data-composer-picker='project']");
    await settle();
    const sidebarWidth = (): Promise<number> => page!.evaluate(() => document.querySelector("[data-slot=sidebar-gap]")!.getBoundingClientRect().width);
    const togglePanel = async (open: boolean): Promise<void> => {
      await page!.locator("button[aria-label='Toggle right panel']").click();
      await page!.waitForSelector("[data-preview-panel-mode=inline]", { state: open ? "attached" : "detached" });
      await settle();
    };
    /** The pointer on the rail's middle, pressed, moved by dx, released; the rail is the sidebar's right edge. */
    const rail = async (dx: number): Promise<void> => {
      const b = await page!.locator("[data-slot=sidebar-rail]").boundingBox();
      if (!b) throw new Error("the rail has no box");
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await page!.mouse.move(x, y);
      await page!.mouse.down();
      if (dx !== 0) await page!.mouse.move(x + dx, y, { steps: 8 });
      await page!.mouse.up();
      await settle();
    };
    expect(await sidebarWidth(), "the cap before any press").toBe(cap);

    await rail(0);
    expect(await sidebarWidth(), "a press moved the sidebar").toBe(cap);
    await togglePanel(false);
    expect(await sidebarWidth(), "a press on the rail wrote the cap to the record").toBe(SIDEBAR_MAX_WIDTH);

    await togglePanel(true);
    expect(await sidebarWidth()).toBe(cap);
    await rail(300);
    expect(await sidebarWidth(), "a drag past the cap widened the sidebar past it").toBe(cap);
    await togglePanel(false);
    expect(await sidebarWidth(), "a drag past the cap wrote the cap to the record").toBe(SIDEBAR_MAX_WIDTH);

    await togglePanel(true);
    expect(await sidebarWidth()).toBe(cap);
    await rail(100);
    expect(await sidebarWidth()).toBe(cap);
    await togglePanel(false);
    expect(await sidebarWidth(), "a drag to a width under 480 did not record that width").toBe(cap + 100);
    console.info(`${viewport} rail: cap ${cap}, after a press ${SIDEBAR_MAX_WIDTH}, after a 300 px drag ${SIDEBAR_MAX_WIDTH}, after a 100 px drag ${cap + 100}`);
  }, 90_000);

  it(`at ${RIGHT_PANEL_SHEET_MAX_VIEWPORT} px, one under the breakpoint, the panel is a sheet, the sidebar keeps its widest and the centre column is what is left of the window, over the floor, in both themes`, async () => {
    const viewport = RIGHT_PANEL_SHEET_MAX_VIEWPORT;
    await page!.setViewportSize({ width: viewport, height: 800 });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&projects=1&efforts=1&sidebar=${SIDEBAR_MAX_WIDTH}&panel=preview`);
      await page!.waitForSelector("[data-composer-picker='project']");
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      await page!.waitForSelector("[data-preview-panel-mode=sheet]");
      await settle();
      const shell = await readShell();
      console.info(`${viewport} ${theme} sheet: ${JSON.stringify(shell)} lines ${lines(shell)}`);
      const shot = join(SHOTS_DIR, `shell-center-floor-${viewport}-${theme}.png`);
      await page!.screenshot({ path: shot });
      console.info(`shell centre floor screenshot: ${shot}`);
      const where = `${viewport} px in ${theme}`;
      expect(shell.sheet, `no sheet at ${where}`).toBe(true);
      expect(shell.panel, `an inline panel at ${where}`).toBeNull();
      expect(Math.abs(shell.sidebar.width - SIDEBAR_MAX_WIDTH), `the sidebar is ${shell.sidebar.width} px at ${where}`).toBeLessThan(0.5);
      expect(Math.abs(shell.center.width - (viewport - SIDEBAR_MAX_WIDTH)), `the centre column is ${shell.center.width} px at ${where}`).toBeLessThan(0.5);
      expect(shell.center.width).toBeGreaterThanOrEqual(CENTER_COLUMN_MIN_WIDTH);
      expectNoScroll(shell, where);
      expectRowWhole(shell, where);
    }
  }, 90_000);
});
