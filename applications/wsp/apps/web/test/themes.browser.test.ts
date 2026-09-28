// SPDX-License-Identifier: AGPL-3.0-only
// Every registered theme on the main screens in a real Chromium: a thread, the Computers page, a workspace's
// agents panel and Settings, each on its theme's side and again inside the Mac's window, where a dark theme's
// material stands on its own ground and a light theme's sidebar on its veil. On each, every line of body and muted
// text is measured against what it is drawn on, and the screen is photographed under wsp-render/themes. The Mac's
// glass is the window's and no page shot carries it, so in the Mac's window every line of words in the chat column,
// the right panel and the sidebar is measured over the glass read as mid grey: the dark glass over a white desktop,
// the lightest it shows, and the light glass over a dark desktop, the darkest. A dark region's share is held to the
// theme's ground. The theme picker on either side draws each of its pictures in that
// picture's own theme and keeps one height across its segments, and its tooltip wears the shared skin. Runs only
// when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THEMES, type Theme } from "../src/themes/index";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render", "themes");

/** The screens, each with what to wait for before it is measured; the shell's page is the one that marks the Mac. */
const SCREENS = [
  { name: "thread", page: "shell", query: "ws=ws_a&chat=1", ready: ".chat-markdown .shiki" },
  { name: "computers", page: "wireframe", query: "screen=settings-computers", ready: "[data-settings-page]" },
  { name: "agents-panel", page: "wireframe", query: "screen=panel-agents", ready: "[data-agents-row]" },
  { name: "settings", page: "wireframe", query: "screen=settings-appearance", ready: "[data-k=theme-picker]" },
] as const;

/** Body and muted text: the two inks every screen sets its words in, wherever a line carries words of its own. */
const measureText = (page: Page, selector: string, onGlass: boolean) =>
  page.evaluate(([selector, onGlass]) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const parse = (c: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: number[], under: number[]): number[] => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
    const lum = (rgb: number[]): number => {
      const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
    };
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      for (let n: Element | null = el; n !== null; n = n.parentElement) if (Number(getComputedStyle(n).opacity) < 1) return false;
      return true;
    };
    const ownText = (el: Element): boolean => [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0);
    // The ground a line is read on: its own fill and every translucent one under it, down to the page, which in the
    // Mac's window is the glass read as mid grey.
    const ground = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let n: Element | null = el; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3]! > 0) layers.push(c);
      }
      const page = onGlass ? [128, 128, 128] : [255, 255, 255];
      return layers.reverse().reduce((under, top) => over(top, under), page);
    };
    const out: { ink: "body" | "muted"; text: string; ratio: number }[] = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!ownText(el) || !shown(el)) continue;
      const bg = ground(el);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      out.push({ ink: el.classList.contains("text-muted-foreground") ? "muted" : "body", text: (el.textContent ?? "").trim().slice(0, 40), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 });
    }
    return out;
  }, [selector, onGlass] as const);

const TEXT = ".text-foreground, .text-muted-foreground, .chat-markdown p, [data-settings-page] h1";
/** In the Mac's window: every line of words in the three regions that stand on the glass, bar the code's own syntax
 * inks and the sidebar's counts, whose whisper sits under AA on purpose. */
const MAC_TEXT = ["[data-shell-center]", "[data-slot=sidebar-inner]", "[data-preview-panel-mode=inline]"].map(r => `${r} :not(.shiki, .shiki *, [class*="--top-row-meta"])`).join(", ");

if (renderSkipped !== undefined) console.info(`themes render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("every theme on the main screens", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = vite.base;
    browser = await launchRender();
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const cases = THEMES.flatMap((theme: Theme) =>
    SCREENS.flatMap(screen => [false, ...(screen.page === "shell" ? [true] : [])].map(mac => ({ id: theme.id, side: theme.side, mac, where: mac ? " in the Mac's window" : "", ...screen }))),
  );

  it.each(cases)("$id on the $name screen$where: body and muted text read at AA", async ({ id, side, mac, name, page: harness, query, ready }) => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: side, reducedMotion: "reduce" });
    try {
      await page.addInitScript(() => window.localStorage.clear());
      await page.goto(`${base}/test/${harness}/index.html?theme=${side}&${side}Theme=${id}&${query}${mac ? "&mac=1" : ""}`);
      await page.waitForSelector(ready);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBe(id);
      const lines = await measureText(page, mac ? MAC_TEXT : TEXT, mac);
      const low = lines.filter(l => l.ratio < 4.5);
      const floor = (ink: "body" | "muted") => Math.min(...lines.filter(l => l.ink === ink).map(l => l.ratio));
      console.info(`${id} ${name}${mac ? " in the Mac's window, over mid grey" : ""}: ${lines.length} lines, body from ${floor("body")}, muted from ${floor("muted")}${low.length > 0 ? `, under AA: ${low.map(l => `${l.text} ${l.ratio}`).join("; ")}` : ""}`);
      expect(lines.filter(l => l.ink === "body").length).toBeGreaterThan(0);
      expect(lines.filter(l => l.ink === "muted").length).toBeGreaterThan(0);
      if (mac && side === "dark") {
        const shares = await page.evaluate(() => {
          const ctx = document.createElement("canvas").getContext("2d")!;
          const rgb = (c: string): string => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = c;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join();
          };
          const ground = rgb(getComputedStyle(document.documentElement).getPropertyValue("--material-ground"));
          const regions = [...document.querySelectorAll("[data-shell-center], [data-slot=sidebar-inner], [data-preview-panel-mode=inline]")];
          const opaque = (c: string): string => rgb(c.replace(/\/\s*[\d.]+%?\s*\)$/, ")").replace(/^rgba\((.*),\s*[\d.]+\)$/, "rgb($1)"));
          return { ground, regions: regions.map(r => opaque(getComputedStyle(r).backgroundColor)) };
        });
        expect(shares.regions.length).toBeGreaterThan(0);
        for (const region of shares.regions) expect(region).toBe(shares.ground);
      }
      // The shot stands on the glass the lines were measured over.
      if (mac) await page.evaluate(() => (document.documentElement.style.background = "rgb(128 128 128)"));
      expect(low, JSON.stringify(low)).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `${id}-${name}${mac ? "-mac" : ""}.png`) });
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each(["light", "dark"] as const)("the picker on the %s side draws each theme's picture in that theme's own tokens and holds its height across the segments", async side => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: side, reducedMotion: "reduce" });
    try {
      await page.goto(`${base}/test/wireframe/index.html?theme=${side}&screen=settings-appearance`);
      await page.waitForSelector("[data-k=theme-picker]");
      const heights: number[] = [];
      for (const segment of ["light", "dark", "system"] as const) {
        await page.click(`[data-k=theme-picker] [data-segment=${segment}]`);
        const shown = segment === "system" ? side : segment;
        const drawn = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-theme-option]")].map(cell => {
            const id = cell.dataset["themeOption"]!;
            const probe = document.createElement("div");
            probe.dataset["theme"] = id;
            probe.style.cssText = "background: var(--background); color: var(--primary); border-color: var(--sidebar)";
            document.body.append(probe);
            const want = getComputedStyle(probe);
            const fill = (part: string): string => getComputedStyle(cell.querySelector(`[data-part=${part}]`)!).fill;
            const out = { id, ground: [fill("ground"), want.backgroundColor], primary: [fill("keycap"), want.color], sidebar: [fill("sidebar"), want.borderTopColor] };
            probe.remove();
            return out;
          }),
        );
        expect(drawn.map(d => d.id)).toEqual(THEMES.filter(t => t.side === shown).map(t => t.id));
        for (const d of drawn) for (const [got, want] of [d.ground, d.primary, d.sidebar]) expect(got, d.id).toBe(want);
        heights.push(await page.evaluate(() => document.querySelector("[data-k=theme-picker]")!.getBoundingClientRect().height));
      }
      expect(new Set(heights).size, JSON.stringify(heights)).toBe(1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.each(["light", "dark"] as const)("in the %s theme a cell's tooltip is 13 px words that fade and slide, never scale, with no arrow", async side => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: side });
    try {
      await page.goto(`${base}/test/wireframe/index.html?theme=${side}&screen=settings-appearance`);
      await page.waitForSelector("[data-k=theme-picker]");
      await page.hover("[data-theme-option]");
      const tip = page.locator("[data-slot=tooltip-popup]");
      await tip.waitFor();
      const skin = await tip.evaluate(el => {
        const s = getComputedStyle(el);
        return { size: s.fontSize, transition: s.transitionProperty.split(", "), arrows: el.querySelectorAll("[data-slot*=arrow], svg").length };
      });
      expect(skin.size).toBe("13px");
      expect(skin.transition).toContain("translate");
      expect(skin.transition).toContain("opacity");
      expect(skin.transition).not.toContain("scale");
      expect(skin.arrows).toBe(0);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `tooltip-${side}.png`) });
    } finally {
      await page.close();
    }
  }, 60_000);
});
